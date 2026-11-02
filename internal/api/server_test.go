package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/gorilla/websocket"

	"zvonochek2/internal/node"
	"zvonochek2/internal/store"
)

type env struct {
	srv    *Server
	base   string
	secret string
	opened atomic.Int32
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.UpdateSettings(func(s *store.Settings) {
		s.Nickname = "Тест"
		s.P2PPort = 0
		s.DownloadsDir = filepath.Join(dir, "dl")
	})
	n, err := node.New(node.Options{Store: st, IdentityPath: filepath.Join(dir, "id.key"), NoInternet: true, NoLAN: true, LoopbackOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	e := &env{secret: "0123456789abcdef0123456789abcdef"}
	static := fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><title>zv</title>")},
		"app.js":     {Data: []byte("console.log(1)")},
	}
	e.srv = New(n, ln, e.secret, static, Hooks{OpenWindow: func() { e.opened.Add(1) }}, Info{Profile: "default", DataDir: dir})
	go func() { _ = e.srv.Serve() }()
	e.base = fmt.Sprintf("http://127.0.0.1:%d", e.srv.Port())
	t.Cleanup(func() { e.srv.Close(); _ = n.Close(); st.Close() })
	return e
}

func (e *env) do(t *testing.T, method, path string, body string, hdr map[string]string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, e.base+path, r)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	cl := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func (e *env) cookie() string { return fmt.Sprintf("zv_session_%d=%s", e.srv.Port(), e.secret) }

func TestRequiresSession(t *testing.T) {
	e := newEnv(t)
	if r := e.do(t, "GET", "/api/bootstrap", "", nil); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", r.StatusCode)
	}
	bad := fmt.Sprintf("zv_session_%d=wrong", e.srv.Port())
	if r := e.do(t, "GET", "/api/bootstrap", "", map[string]string{"Cookie": bad}); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong cookie: %d", r.StatusCode)
	}
	r := e.do(t, "GET", "/api/bootstrap", "", map[string]string{"Cookie": e.cookie()})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("valid cookie: %d", r.StatusCode)
	}
	var b map[string]any
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b["me"] == nil {
		t.Fatalf("bootstrap body: %v %v", err, b)
	}
}

func TestDNSRebindingBlocked(t *testing.T) {
	e := newEnv(t)
	for _, host := range []string{"evil.example", "127.0.0.1", fmt.Sprintf("attacker.com:%d", e.srv.Port())} {
		r := e.do(t, "GET", "/api/bootstrap", "", map[string]string{"Host": host, "Cookie": e.cookie()})
		if r.StatusCode != http.StatusForbidden {
			t.Errorf("host %q: got %d", host, r.StatusCode)
		}
	}
	if r := e.do(t, "GET", "/", "", map[string]string{"Host": fmt.Sprintf("localhost:%d", e.srv.Port())}); r.StatusCode != http.StatusOK {
		t.Fatalf("localhost must be allowed: %d", r.StatusCode)
	}
}

func TestLaunchTokenIsOneTime(t *testing.T) {
	e := newEnv(t)
	u, _ := url.Parse(e.srv.LaunchURL())
	r := e.do(t, "GET", u.RequestURI(), "", nil)
	if r.StatusCode != http.StatusFound {
		t.Fatalf("first use: %d", r.StatusCode)
	}
	var sc *http.Cookie
	for _, c := range r.Cookies() {
		if c.Name == fmt.Sprintf("zv_session_%d", e.srv.Port()) {
			sc = c
		}
	}
	if sc == nil || !sc.HttpOnly || sc.SameSite != http.SameSiteStrictMode || sc.Value != e.secret {
		t.Fatalf("session cookie must be HttpOnly+SameSite=Strict: %+v", sc)
	}
	if r := e.do(t, "GET", u.RequestURI(), "", nil); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("token reuse must fail: %d", r.StatusCode)
	}
}

func TestCSRFAndOrigin(t *testing.T) {
	e := newEnv(t)
	body := `{"nickname":"Новое имя"}`
	if r := e.do(t, "POST", "/api/settings", body, map[string]string{"Cookie": e.cookie(), "Content-Type": "application/json"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("POST without X-ZV must be refused: %d", r.StatusCode)
	}
	if r := e.do(t, "POST", "/api/settings", body, map[string]string{"Cookie": e.cookie(), "X-ZV": "1", "Origin": "http://evil.example"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign origin must be refused: %d", r.StatusCode)
	}
	r := e.do(t, "POST", "/api/settings", body, map[string]string{"Cookie": e.cookie(), "X-ZV": "1", "Origin": e.base})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("valid request: %d", r.StatusCode)
	}
	if e.srv.st.Settings().Nickname != "Новое имя" {
		t.Fatal("setting not applied")
	}
}

func TestSettingsValidation(t *testing.T) {
	e := newEnv(t)
	h := map[string]string{"Cookie": e.cookie(), "X-ZV": "1"}
	for _, body := range []string{
		`{"relays":["not-a-multiaddr"]}`,
		`{"ice_servers":[{"urls":["http://evil"]}]}`,
		`{"p2p_port":70000}`,
	} {
		if r := e.do(t, "POST", "/api/settings", body, h); r.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", body, r.StatusCode)
		}
	}
	big := `{"nickname":"` + strings.Repeat("я", 300<<10) + `"}`
	if r := e.do(t, "POST", "/api/settings", big, h); r.StatusCode == http.StatusOK {
		t.Error("oversized body must be refused")
	}
}

func TestSecurityHeaders(t *testing.T) {
	e := newEnv(t)
	r := e.do(t, "GET", "/", "", nil)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("index: %d", r.StatusCode)
	}
	csp := r.Header.Get("Content-Security-Policy")
	for _, want := range []string{"script-src 'self'", "frame-ancestors 'none'", fmt.Sprintf("ws://127.0.0.1:%d", e.srv.Port())} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP lacks %q: %s", want, csp)
		}
	}
	for k, v := range map[string]string{"X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"} {
		if r.Header.Get(k) != v {
			t.Errorf("%s = %q", k, r.Header.Get(k))
		}
	}
	if r := e.do(t, "GET", "/../../../../etc/passwd", "", nil); r.StatusCode == http.StatusOK {
		b, _ := io.ReadAll(r.Body)
		if strings.Contains(string(b), "root:") {
			t.Fatal("path traversal")
		}
	}
	if r := e.do(t, "POST", "/app.js", "x", nil); r.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST to static: %d", r.StatusCode)
	}
}

func TestLocalOpenWindow(t *testing.T) {
	e := newEnv(t)
	if r := e.do(t, "POST", "/api/local/open-window", "", nil); r.StatusCode != http.StatusForbidden {
		t.Fatalf("no secret: %d", r.StatusCode)
	}
	if r := e.do(t, "POST", "/api/local/open-window", "", map[string]string{"X-ZV-Local": e.secret, "Origin": "http://evil.example"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("browser origin must be refused: %d", r.StatusCode)
	}
	if r := e.do(t, "POST", "/api/local/open-window", "", map[string]string{"X-ZV-Local": e.secret}); r.StatusCode != http.StatusOK {
		t.Fatalf("valid: %d", r.StatusCode)
	}
	deadline := time.Now().Add(2 * time.Second)
	for e.opened.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if e.opened.Load() != 1 {
		t.Fatal("OpenWindow hook not called")
	}
}

func TestWebSocket(t *testing.T) {
	e := newEnv(t)
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/ws", e.srv.Port())
	hdr := http.Header{"Cookie": {e.cookie()}, "Origin": {"http://evil.example"}}
	if _, _, err := websocket.DefaultDialer.Dial(wsURL, hdr); err == nil {
		t.Fatal("cross-origin websocket must be refused")
	}
	if _, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": {e.base}}); err == nil {
		t.Fatal("websocket without session must be refused")
	}
	hdr.Set("Origin", e.base)
	c1, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.Close()
	var ev map[string]any
	_ = c1.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := c1.ReadJSON(&ev); err != nil || ev["type"] != "ready" {
		t.Fatalf("first event: %v %v", ev, err)
	}
	// a second window supersedes the first one
	c2, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	for {
		if err := c1.ReadJSON(&ev); err != nil {
			t.Fatalf("waiting for superseded: %v", err)
		}
		if ev["type"] == "superseded" {
			break
		}
	}
}

func TestFileEndpointsValidate(t *testing.T) {
	e := newEnv(t)
	h := map[string]string{"Cookie": e.cookie()}
	if r := e.do(t, "GET", "/api/files/content?peer=x&tid=../../etc/passwd", "", h); r.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown transfer: %d", r.StatusCode)
	}
	h["X-ZV"] = "1"
	if r := e.do(t, "POST", "/api/files/open", `{"peer":"x","tid":"y"}`, h); r.StatusCode < 400 {
		t.Fatalf("open of unknown file must fail: %d", r.StatusCode)
	}
	if r := e.do(t, "POST", "/api/messages/send", `{"peer":"12D3KooWNotAContact","text":"hi"}`, h); r.StatusCode < 400 {
		t.Fatalf("sending to a non-contact must fail: %d", r.StatusCode)
	}
}
