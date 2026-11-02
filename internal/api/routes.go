package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"

	"zvonochek2/internal/node"
	"zvonochek2/internal/store"
	"zvonochek2/internal/version"
)

func (s *Server) routes(mux *http.ServeMux) {
	get := func(path string, h http.HandlerFunc) {
		mux.HandleFunc(path, s.auth(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				writeErr(w, http.StatusMethodNotAllowed, "GET only")
				return
			}
			h(w, r)
		}))
	}
	post := func(path string, h http.HandlerFunc) {
		mux.HandleFunc(path, s.auth(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				writeErr(w, http.StatusMethodNotAllowed, "POST only")
				return
			}
			h(w, r)
		}))
	}
	get("/api/bootstrap", s.hBootstrap)
	get("/api/messages", s.hMessages)
	get("/api/diagnostics", s.hDiagnostics)
	get("/api/files/content", s.hFileContent)
	post("/api/messages/send", s.hSend)
	post("/api/messages/delete", s.hDeleteMessage)
	post("/api/messages/retry", s.hRetry)
	post("/api/read", s.hRead)
	post("/api/invite", s.hInvite)
	post("/api/contacts/add", s.hAddContact)
	post("/api/contacts/update", s.hUpdateContact)
	post("/api/contacts/remove", s.hRemoveContact)
	post("/api/contacts/clear", s.hClearHistory)
	post("/api/pair/respond", s.hPairRespond)
	post("/api/files/upload", s.hUpload)
	post("/api/files/accept", s.hFileAction)
	post("/api/files/decline", s.hFileAction)
	post("/api/files/cancel", s.hFileAction)
	post("/api/files/reveal", s.hReveal)
	post("/api/files/open", s.hOpenFile)
	post("/api/files/open-folder", s.hOpenFolder)
	post("/api/call/start", s.hCallStart)
	post("/api/call/accept", s.hCallAccept)
	post("/api/call/end", s.hCallEnd)
	post("/api/call/mode", s.hCallMode)
	post("/api/settings", s.hSettings)
	post("/api/reconnect", s.hReconnect)
	post("/api/app/restart", s.hRestart)
	post("/api/app/quit", s.hQuit)
	post("/api/app/autostart", s.hAutostart)
}

type meView struct {
	PeerID       string `json:"peer_id"`
	Nick         string `json:"nick"`
	Version      string `json:"version"`
	Profile      string `json:"profile"`
	DataDir      string `json:"data_dir"`
	LogFile      string `json:"log_file"`
	DownloadsDir string `json:"downloads_dir"`
	OS           string `json:"os"`
	Autostart    bool   `json:"autostart"`
	AutostartOK  bool   `json:"autostart_supported"`
}

type settingsView struct {
	Nickname           string            `json:"nickname"`
	P2PPort            int               `json:"p2p_port"`
	InternetDiscovery  bool              `json:"internet_discovery"`
	LANDiscovery       bool              `json:"lan_discovery"`
	Relays             []string          `json:"relays"`
	PublicSTUN         bool              `json:"public_stun"`
	ICEServers         []store.ICEServer `json:"ice_servers"`
	DownloadsDir       string            `json:"downloads_dir"`
	AutoAcceptImagesMB int               `json:"auto_accept_images_mb"`
	MaxIncomingMB      int               `json:"max_incoming_mb"`
	OpenWindowOnCall   bool              `json:"open_window_on_call"`
	DesktopNotify      bool              `json:"desktop_notify"`
	UI                 map[string]string `json:"ui"`
}

func toSettingsView(st store.Settings) settingsView {
	if st.Relays == nil {
		st.Relays = []string{}
	}
	if st.ICEServers == nil {
		st.ICEServers = []store.ICEServer{}
	}
	return settingsView{Nickname: st.Nickname, P2PPort: st.P2PPort, InternetDiscovery: st.InternetDiscovery,
		LANDiscovery: st.LANDiscovery, Relays: st.Relays, PublicSTUN: st.PublicSTUN, ICEServers: st.ICEServers,
		DownloadsDir: st.DownloadsDir, AutoAcceptImagesMB: st.AutoAcceptImagesMB, MaxIncomingMB: st.MaxIncomingMB,
		OpenWindowOnCall: st.OpenWindowOnCall, DesktopNotify: st.DesktopNotify, UI: st.UI}
}

func (s *Server) iceServers() []store.ICEServer {
	st := s.st.Settings()
	var out []store.ICEServer
	if st.PublicSTUN {
		out = append(out, store.ICEServer{URLs: []string{"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"}})
	}
	out = append(out, st.ICEServers...)
	if out == nil {
		out = []store.ICEServer{}
	}
	return out
}

func (s *Server) me() meView {
	st := s.st.Settings()
	m := meView{PeerID: s.n.ID().String(), Nick: st.Nickname, Version: version.Version, Profile: s.info.Profile,
		DataDir: s.info.DataDir, LogFile: s.info.LogFile, DownloadsDir: s.n.DownloadsDir(), OS: osName()}
	if s.hooks.Autostart != nil {
		m.Autostart, m.AutostartOK = s.hooks.Autostart()
	}
	return m
}

func (s *Server) hBootstrap(w http.ResponseWriter, r *http.Request) {
	call, hasCall := s.n.CurrentCall()
	resp := map[string]any{
		"me":            s.me(),
		"settings":      toSettingsView(s.st.Settings()),
		"contacts":      s.n.ContactViews(),
		"pair_requests": s.n.PairRequests(),
		"nearby":        s.n.Nearby(),
		"net":           s.n.Net(),
		"relays":        s.n.Relays(),
		"ice":           s.iceServers(),
	}
	if hasCall {
		resp["call"] = call
	}
	writeJSON(w, resp)
}

func (s *Server) hMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	writeJSON(w, map[string]any{"messages": s.n.Messages(q.Get("peer"), before, limit)})
}

type peerReq struct {
	Peer string `json:"peer"`
	ID   string `json:"id"`
	TID  string `json:"tid"`
	Text string `json:"text"`
}

func (s *Server) hSend(w http.ResponseWriter, r *http.Request) {
	var req peerReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	m, err := s.n.SendText(req.Peer, req.Text)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, m)
}

func (s *Server) hDeleteMessage(w http.ResponseWriter, r *http.Request) {
	var req peerReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	writeJSON(w, map[string]bool{"ok": s.n.DeleteMessage(req.Peer, req.ID)})
}

func (s *Server) hRetry(w http.ResponseWriter, r *http.Request) {
	var req peerReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.n.RetryMessage(req.Peer, req.ID); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hRead(w http.ResponseWriter, r *http.Request) {
	var req peerReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	s.n.MarkRead(req.Peer)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hInvite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Renew bool `json:"renew"`
	}
	_ = readJSON(r, &req)
	code, exp, err := s.n.Invite(req.Renew)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]any{"code": code, "expires": exp.UnixMilli(), "peer_id": s.n.ID().String()})
}

func (s *Server) hAddContact(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Input string `json:"input"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	c, err := s.n.AddContact(ctx, req.Input)
	if err != nil {
		if c.PeerID != "" {
			writeJSON(w, map[string]any{"contact": c, "warning": err.Error()})
			return
		}
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, map[string]any{"contact": c})
}

func (s *Server) hUpdateContact(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Peer     string  `json:"peer"`
		Alias    *string `json:"alias"`
		Verified *bool   `json:"verified"`
		Muted    *bool   `json:"muted"`
		Unblock  bool    `json:"unblock"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if req.Unblock {
		s.n.Unblock(req.Peer)
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	c, err := s.n.UpdateContact(req.Peer, req.Alias, req.Verified, req.Muted)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, c)
}

func (s *Server) hRemoveContact(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Peer  string `json:"peer"`
		Purge bool   `json:"purge"`
		Block bool   `json:"block"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.n.RemoveContact(req.Peer, req.Purge, req.Block); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hClearHistory(w http.ResponseWriter, r *http.Request) {
	var req peerReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	s.n.ClearHistory(req.Peer)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hPairRespond(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Peer   string `json:"peer"`
		Accept bool   `json:"accept"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	c, err := s.n.RespondPair(r.Context(), req.Peer, req.Accept)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, map[string]any{"contact": c})
}

func (s *Server) hUpload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name := q.Get("name")
	if name == "" {
		name = "file"
	}
	r.Body = http.MaxBytesReader(w, r.Body, node.MaxOutgoingFile)
	m, err := s.n.OfferFile(q.Get("peer"), name, r.Body)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, m)
}

func (s *Server) hFileAction(w http.ResponseWriter, r *http.Request) {
	var req peerReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	var err error
	switch {
	case strings.HasSuffix(r.URL.Path, "/accept"):
		err = s.n.AcceptFile(req.Peer, req.TID)
	case strings.HasSuffix(r.URL.Path, "/decline"):
		err = s.n.DeclineFile(req.Peer, req.TID)
	default:
		err = s.n.CancelFile(req.Peer, req.TID)
	}
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hFileContent(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	path, name, ok := s.n.FileForServing(q.Get("peer"), q.Get("tid"))
	if !ok {
		writeErr(w, 404, "not found")
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeErr(w, 404, "not found")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeErr(w, 404, "not found")
		return
	}
	h := w.Header()
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'")
	disp := "attachment"
	ctype := "application/octet-stream"
	if node.IsPreviewable(name) && q.Get("download") == "" {
		disp = "inline"
		ctype = previewType(name)
	}
	h.Set("Content-Type", ctype)
	h.Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disp, url.PathEscape(name)))
	h.Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

func previewType(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".avif":
		return "image/avif"
	case ".mp3":
		return "audio/mpeg"
	case ".ogg", ".opus":
		return "audio/ogg"
	case ".wav":
		return "audio/wav"
	case ".m4a":
		return "audio/mp4"
	case ".flac":
		return "audio/flac"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	}
	return "application/octet-stream"
}

func (s *Server) hReveal(w http.ResponseWriter, r *http.Request) {
	var req peerReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	path, _, ok := s.n.FileForServing(req.Peer, req.TID)
	if !ok || s.hooks.Reveal == nil {
		writeErr(w, 404, "файл не найден (возможно, его переместили)")
		return
	}
	if err := s.hooks.Reveal(path); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// riskyExt are never launched from the messenger: the user has to open them
// from Explorer deliberately.
var riskyExt = map[string]bool{
	".exe": true, ".com": true, ".bat": true, ".cmd": true, ".ps1": true, ".psm1": true, ".vbs": true, ".vbe": true,
	".js": true, ".jse": true, ".wsf": true, ".wsh": true, ".msi": true, ".msp": true, ".scr": true, ".pif": true,
	".lnk": true, ".url": true, ".hta": true, ".cpl": true, ".jar": true, ".reg": true, ".dll": true, ".sys": true,
	".appx": true, ".msix": true, ".appinstaller": true, ".application": true, ".gadget": true, ".inf": true,
	".scf": true, ".iso": true, ".img": true, ".vhd": true, ".vhdx": true, ".chm": true, ".sh": true, ".desktop": true,
	".app": true, ".command": true, ".settingcontent-ms": true, ".library-ms": true, ".search-ms": true,
}

func (s *Server) hOpenFile(w http.ResponseWriter, r *http.Request) {
	var req peerReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	path, name, ok := s.n.FileForServing(req.Peer, req.TID)
	if !ok || s.hooks.OpenFile == nil {
		writeErr(w, 404, "файл не найден (возможно, его переместили)")
		return
	}
	if riskyExt[strings.ToLower(filepath.Ext(name))] || riskyExt[strings.ToLower(filepath.Ext(path))] {
		writeErr(w, 400, "Программы и скрипты не запускаются из Звоночка. Откройте папку и запустите файл сами, если доверяете отправителю.")
		return
	}
	if err := s.hooks.OpenFile(path); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hOpenFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Which string `json:"which"`
	}
	_ = readJSON(r, &req)
	dir := s.n.DownloadsDir()
	switch req.Which {
	case "data":
		dir = s.info.DataDir
	case "logs":
		dir = filepath.Dir(s.info.LogFile)
	}
	if s.hooks.OpenFolder == nil {
		writeErr(w, 501, "not supported")
		return
	}
	if err := s.hooks.OpenFolder(dir); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hCallStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Peer  string `json:"peer"`
		Video bool   `json:"video"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	cv, err := s.n.StartCall(r.Context(), req.Peer, req.Video)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, cv)
}

type cidReq struct {
	CID    string `json:"cid"`
	Mode   string `json:"mode"`
	Reason string `json:"reason"`
}

func (s *Server) hCallAccept(w http.ResponseWriter, r *http.Request) {
	var req cidReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	cv, err := s.n.AcceptCall(req.CID)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, cv)
}

func (s *Server) hCallEnd(w http.ResponseWriter, r *http.Request) {
	var req cidReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	reason := req.Reason
	if reason == "" {
		reason = "hangup"
	}
	_ = s.n.EndCall(req.CID, clamp(reason, 32))
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hCallMode(w http.ResponseWriter, r *http.Request) {
	var req cidReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if err := s.n.SetCallMode(req.CID, req.Mode); err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func clamp(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

type settingsPatch struct {
	Nickname           *string            `json:"nickname"`
	P2PPort            *int               `json:"p2p_port"`
	InternetDiscovery  *bool              `json:"internet_discovery"`
	LANDiscovery       *bool              `json:"lan_discovery"`
	Relays             *[]string          `json:"relays"`
	PublicSTUN         *bool              `json:"public_stun"`
	ICEServers         *[]store.ICEServer `json:"ice_servers"`
	DownloadsDir       *string            `json:"downloads_dir"`
	AutoAcceptImagesMB *int               `json:"auto_accept_images_mb"`
	MaxIncomingMB      *int               `json:"max_incoming_mb"`
	OpenWindowOnCall   *bool              `json:"open_window_on_call"`
	DesktopNotify      *bool              `json:"desktop_notify"`
	UI                 map[string]string  `json:"ui"`
}

func (s *Server) hSettings(w http.ResponseWriter, r *http.Request) {
	var p settingsPatch
	if err := readJSON(r, &p); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	// validate first, then apply atomically
	var relays []string
	if p.Relays != nil {
		for _, raw := range *p.Relays {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			if _, err := peer.AddrInfoFromString(raw); err != nil {
				writeErr(w, 400, "некорректный адрес relay: "+clamp(raw, 80)+" (нужен полный multiaddr с /p2p/…)")
				return
			}
			relays = append(relays, raw)
		}
		if len(relays) > 4 {
			writeErr(w, 400, "не больше 4 relay-серверов")
			return
		}
	}
	var ice []store.ICEServer
	if p.ICEServers != nil {
		for _, srv := range *p.ICEServers {
			var urls []string
			for _, u := range srv.URLs {
				u = strings.TrimSpace(u)
				if u == "" {
					continue
				}
				lu := trimLower(u)
				if !(strings.HasPrefix(lu, "stun:") || strings.HasPrefix(lu, "turn:") || strings.HasPrefix(lu, "turns:")) || len(u) > 200 {
					writeErr(w, 400, "адрес ICE-сервера должен начинаться с stun:, turn: или turns:")
					return
				}
				urls = append(urls, u)
			}
			if len(urls) > 0 {
				ice = append(ice, store.ICEServer{URLs: urls, Username: clamp(srv.Username, 200), Credential: clamp(srv.Credential, 200)})
			}
		}
		if len(ice) > 6 {
			writeErr(w, 400, "слишком много ICE-серверов")
			return
		}
	}
	if p.DownloadsDir != nil && strings.TrimSpace(*p.DownloadsDir) != "" {
		d := filepath.Clean(strings.TrimSpace(*p.DownloadsDir))
		if !filepath.IsAbs(d) {
			writeErr(w, 400, "укажите полный путь к папке")
			return
		}
		if err := os.MkdirAll(d, 0o755); err != nil {
			writeErr(w, 400, "не удалось создать папку: "+err.Error())
			return
		}
		*p.DownloadsDir = d
	}
	if p.P2PPort != nil && (*p.P2PPort != 0 && (*p.P2PPort < 1024 || *p.P2PPort > 65535)) {
		writeErr(w, 400, "порт должен быть 1024–65535 (или 0 — случайный)")
		return
	}
	before := s.st.Settings()
	restart := false
	if p.Nickname != nil {
		s.n.SetNickname(*p.Nickname)
	}
	st := s.st.UpdateSettings(func(st *store.Settings) {
		if p.P2PPort != nil && *p.P2PPort != st.P2PPort {
			st.P2PPort = *p.P2PPort
			restart = true
		}
		if p.InternetDiscovery != nil && *p.InternetDiscovery != st.InternetDiscovery {
			st.InternetDiscovery = *p.InternetDiscovery
			restart = true
		}
		if p.LANDiscovery != nil && *p.LANDiscovery != st.LANDiscovery {
			st.LANDiscovery = *p.LANDiscovery
			restart = true
		}
		if p.Relays != nil && strings.Join(relays, "|") != strings.Join(st.Relays, "|") {
			st.Relays = relays
			restart = true
		}
		if p.PublicSTUN != nil {
			st.PublicSTUN = *p.PublicSTUN
		}
		if p.ICEServers != nil {
			st.ICEServers = ice
		}
		if p.DownloadsDir != nil {
			st.DownloadsDir = strings.TrimSpace(*p.DownloadsDir)
		}
		if p.AutoAcceptImagesMB != nil {
			st.AutoAcceptImagesMB = max(0, min(*p.AutoAcceptImagesMB, 200))
		}
		if p.MaxIncomingMB != nil {
			st.MaxIncomingMB = max(1, min(*p.MaxIncomingMB, 1<<16))
		}
		if p.OpenWindowOnCall != nil {
			st.OpenWindowOnCall = *p.OpenWindowOnCall
		}
		if p.DesktopNotify != nil {
			st.DesktopNotify = *p.DesktopNotify
		}
		for k, v := range p.UI {
			if len(st.UI) < 64 && len(k) <= 64 && len(v) <= 512 {
				st.UI[k] = v
			}
		}
	})
	_ = before
	writeJSON(w, map[string]any{"settings": toSettingsView(st), "restart_required": restart, "me": s.me(), "ice": s.iceServers()})
}

func (s *Server) hReconnect(w http.ResponseWriter, r *http.Request) {
	s.n.ReconnectNow()
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) hRestart(w http.ResponseWriter, r *http.Request) {
	if s.hooks.Restart == nil {
		writeErr(w, 501, "not supported")
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
	go func() { time.Sleep(300 * time.Millisecond); s.hooks.Restart() }()
}

func (s *Server) hQuit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"ok": true})
	if s.hooks.Quit != nil {
		go func() { time.Sleep(300 * time.Millisecond); s.hooks.Quit() }()
	}
}

func (s *Server) hAutostart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if s.hooks.SetAutostart == nil {
		writeErr(w, 501, "автозапуск поддерживается только в Windows")
		return
	}
	if err := s.hooks.SetAutostart(req.Enabled); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, s.me())
}

func (s *Server) hDiagnostics(w http.ResponseWriter, r *http.Request) {
	h := s.n.Host()
	type connView struct {
		Peer      string `json:"peer"`
		Addr      string `json:"addr"`
		Direction string `json:"direction"`
		Limited   bool   `json:"limited"`
		Streams   int    `json:"streams"`
		Contact   string `json:"contact,omitempty"`
		Age       int64  `json:"age_s"`
	}
	var conns []connView
	for _, c := range h.Network().Conns() {
		cv := connView{Peer: c.RemotePeer().String(), Addr: c.RemoteMultiaddr().String(),
			Direction: c.Stat().Direction.String(), Limited: c.Stat().Limited, Streams: len(c.GetStreams()),
			Age: int64(time.Since(c.Stat().Opened).Seconds())}
		if ct, ok := s.st.Contact(cv.Peer); ok {
			cv.Contact = ct.DisplayName()
		}
		conns = append(conns, cv)
	}
	var listen []string
	for _, a := range h.Network().ListenAddresses() {
		listen = append(listen, a.String())
	}
	var addrs []string
	for _, a := range h.Addrs() {
		addrs = append(addrs, a.String())
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	writeJSON(w, map[string]any{
		"peer_id":    h.ID().String(),
		"version":    version.Version,
		"commit":     version.Commit,
		"go":         runtime.Version(),
		"os":         runtime.GOOS + "/" + runtime.GOARCH,
		"uptime_s":   int64(time.Since(s.info.Started).Seconds()),
		"listen":     listen,
		"addrs":      addrs,
		"net":        s.n.Net(),
		"relays":     s.n.Relays(),
		"conns":      conns,
		"goroutines": runtime.NumGoroutine(),
		"mem_mb":     ms.Alloc >> 20,
	})
}
