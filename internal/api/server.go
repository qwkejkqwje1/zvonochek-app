// Package api serves the local web UI (127.0.0.1 only) and its JSON/WebSocket API.
//
// Security model: the server binds to loopback, validates the Host header
// (DNS-rebinding), requires an HttpOnly SameSite=Strict session cookie that is
// obtained through a one-time launch token, checks Origin on every mutating
// request and WebSocket, and requires a custom header on POST (CSRF).
package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"zvonochek2/internal/node"
	"zvonochek2/internal/store"
)

// Hooks connect the API to the desktop shell.
type Hooks struct {
	OpenWindow   func()
	Quit         func()
	Restart      func()
	Autostart    func() (enabled, supported bool)
	SetAutostart func(bool) error
	Reveal       func(path string) error
	OpenFile     func(path string) error
	OpenFolder   func(path string) error
}

// Info is static information about this process.
type Info struct {
	Profile string
	DataDir string
	LogFile string
	Started time.Time
}

// Server is the local HTTP server.
type Server struct {
	n       *node.Node
	st      *store.Store
	port    int
	secret  string
	static  fs.FS
	hooks   Hooks
	info    Info
	up      websocket.Upgrader
	srv     *http.Server
	ln      net.Listener
	tokMu   sync.Mutex
	tokens  map[string]time.Time
	winMu   sync.Mutex
	windows map[*wsClient]bool
}

// New prepares the server; ln must already be bound to 127.0.0.1.
func New(n *node.Node, ln net.Listener, sessionSecret string, static fs.FS, hooks Hooks, info Info) *Server {
	s := &Server{
		n:       n,
		st:      n.Store(),
		port:    ln.Addr().(*net.TCPAddr).Port,
		secret:  sessionSecret,
		static:  static,
		hooks:   hooks,
		info:    info,
		ln:      ln,
		tokens:  map[string]time.Time{},
		windows: map[*wsClient]bool{},
	}
	s.up = websocket.Upgrader{
		ReadBufferSize:  16 << 10,
		WriteBufferSize: 16 << 10,
		CheckOrigin:     s.originOK,
	}
	return s
}

// Port returns the bound port.
func (s *Server) Port() int { return s.port }

// LaunchURL creates a one-time login URL for a new window.
func (s *Server) LaunchURL() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	tok := hex.EncodeToString(b)
	s.tokMu.Lock()
	now := time.Now()
	for t, exp := range s.tokens {
		if now.After(exp) {
			delete(s.tokens, t)
		}
	}
	s.tokens[tok] = now.Add(2 * time.Minute)
	s.tokMu.Unlock()
	return fmt.Sprintf("http://127.0.0.1:%d/auth?t=%s", s.port, tok)
}

// Serve blocks until the server stops.
func (s *Server) Serve() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/auth", s.handleAuth)
	mux.HandleFunc("/ws", s.auth(s.handleWS))
	mux.HandleFunc("/ws/voice", s.auth(s.handleVoiceWS))
	mux.HandleFunc("/api/local/open-window", s.handleLocalOpen)
	s.routes(mux)
	mux.Handle("/", s.staticHandler())
	s.srv = &http.Server{
		Handler:           s.guard(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          log.New(discard{}, "", 0),
	}
	err := s.srv.Serve(s.ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// Close stops the server.
func (s *Server) Close() {
	if s.srv != nil {
		_ = s.srv.Close()
	}
}

func (s *Server) cookieName() string { return fmt.Sprintf("zv_session_%d", s.port) }

func (s *Server) hostOK(r *http.Request) bool {
	return r.Host == fmt.Sprintf("127.0.0.1:%d", s.port) || r.Host == fmt.Sprintf("localhost:%d", s.port)
}

func (s *Server) originOK(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true // same-origin GET/navigation in Chromium may omit it; the cookie is SameSite=Strict
	}
	return o == fmt.Sprintf("http://127.0.0.1:%d", s.port) || o == fmt.Sprintf("http://localhost:%d", s.port)
}

func (s *Server) authed(r *http.Request) bool {
	c, err := r.Cookie(s.cookieName())
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.secret)) == 1
}

// guard enforces Host checks and security headers for every response.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.hostOK(r) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authed(r) {
			writeErr(w, http.StatusUnauthorized, "session expired")
			return
		}
		if !s.originOK(r) {
			writeErr(w, http.StatusForbidden, "bad origin")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-ZV") != "1" {
			writeErr(w, http.StatusForbidden, "missing csrf header")
			return
		}
		next(w, r)
	}
}

func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("t")
	s.tokMu.Lock()
	exp, ok := s.tokens[tok]
	if ok {
		delete(s.tokens, tok)
	}
	s.tokMu.Unlock()
	if !ok || time.Now().After(exp) {
		if s.authed(r) {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><title>Звоночек</title><body style="font:16px system-ui;background:#0f1218;color:#e8ebf1;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Ссылка устарела</h2><p>Откройте Звоночек ещё раз через ярлык или значок в трее.</p></div>`))
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName(),
		Value:    s.secret,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   400 * 24 * 3600,
	})
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/", http.StatusFound)
}

// handleLocalOpen lets a second process ask us to show a window.
func (s *Server) handleLocalOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("Origin") != "" {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-ZV-Local")), []byte(s.secret)) != 1 {
		writeErr(w, http.StatusForbidden, "forbidden")
		return
	}
	if s.hooks.OpenWindow != nil {
		go s.hooks.OpenWindow()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) staticHandler() http.Handler {
	files := http.FileServer(http.FS(s.static))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		h := w.Header()
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			h.Set("Cache-Control", "no-store")
			h.Set("Content-Security-Policy", fmt.Sprintf("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:%d ws://localhost:%d; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", s.port, s.port))
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 256<<10)
	dec := json.NewDecoder(r.Body)
	return dec.Decode(v)
}

// OSName is used by the UI for platform-specific hints.
func osName() string {
	if os.PathSeparator == '\\' {
		return "windows"
	}
	if _, err := os.Stat("/System/Library"); err == nil {
		return "darwin"
	}
	return "linux"
}

func trimLower(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
