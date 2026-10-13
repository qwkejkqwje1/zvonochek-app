package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/gorilla/websocket"
	"zvonochek2/internal/p2p"
)

const maxWebSocketClients = 8

// Server coordinates the local web UI, REST API, and WebSocket bridges
type Server struct {
	node        *p2p.P2PNode
	port        int
	apiToken    string
	upgrader    websocket.Upgrader
	clients     map[*websocket.Conn]bool
	voiceConns  map[*websocket.Conn]string
	clientsMu   sync.Mutex
	htmlContent []byte
}

func generateToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NewServer creates a new hardened local daemon server
func NewServer(node *p2p.P2PNode, port int, htmlContent []byte) *Server {
	token := generateToken()
	s := &Server{
		node:        node,
		port:        port,
		apiToken:    token,
		clients:     make(map[*websocket.Conn]bool),
		voiceConns:  make(map[*websocket.Conn]string),
		htmlContent: htmlContent,
	}

	s.upgrader = websocket.Upgrader{
		CheckOrigin: s.isValidOrigin,
	}
	return s
}

// Token returns the session security token
func (s *Server) Token() string {
	return s.apiToken
}

func (s *Server) isValidHost(r *http.Request) bool {
	expected1 := fmt.Sprintf("127.0.0.1:%d", s.port)
	expected2 := fmt.Sprintf("localhost:%d", s.port)
	return r.Host == expected1 || r.Host == expected2
}

func (s *Server) isValidOrigin(r *http.Request) bool {
	if !s.isValidHost(r) {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	expected1 := fmt.Sprintf("http://127.0.0.1:%d", s.port)
	expected2 := fmt.Sprintf("http://localhost:%d", s.port)
	return origin == expected1 || origin == expected2
}

func (s *Server) isAuthenticated(r *http.Request) bool {
	if !s.isValidOrigin(r) {
		return false
	}
	headerToken := r.Header.Get("X-Zvonochek-Token")
	if len(headerToken) == len(s.apiToken) && subtle.ConstantTimeCompare([]byte(headerToken), []byte(s.apiToken)) == 1 {
		return true
	}
	cookie, err := r.Cookie("zvonochek_session")
	if err == nil && len(cookie.Value) == len(s.apiToken) && subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(s.apiToken)) == 1 {
		return true
	}
	return false
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isAuthenticated(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next(w, r)
	}
}

// Start launches the local HTTP listener strictly on 127.0.0.1
func (s *Server) Start() error {
	mux := http.NewServeMux()

	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/api/auth", s.handleAuth)
	mux.HandleFunc("/ws", s.requireAuth(s.handleWS))
	mux.HandleFunc("/ws/voice", s.requireAuth(s.handleVoiceWS))
	mux.HandleFunc("/api/status", s.requireAuth(s.handleStatus))
	mux.HandleFunc("/api/diagnostics", s.requireAuth(s.handleDiagnostics))
	mux.HandleFunc("/api/settings", s.requireAuth(s.handleSettings))
	mux.HandleFunc("/api/invite/refresh", s.requireAuth(s.handleInviteRefresh))
	mux.HandleFunc("/api/connect", s.requireAuth(s.handleConnect))
	mux.HandleFunc("/api/upload", s.requireAuth(s.handleUpload))
	mux.HandleFunc("/api/file/decision", s.requireAuth(s.handleFileDecision))

	addr := fmt.Sprintf("127.0.0.1:%d", s.port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to bind to %s: %w", addr, err)
	}

	go s.p2pEventLoop()
	go s.voiceBroadcastLoop()

	log.Printf("[Server] Local HTTP interface bound strictly to http://%s", addr)
	return http.Serve(ln, mux)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if !s.isValidHost(r) {
		http.Error(w, "Forbidden Host", http.StatusForbidden)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	_, _ = w.Write(s.htmlContent)
}

func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !s.isValidOrigin(r) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	token := r.Header.Get("X-Zvonochek-Token")
	if len(token) != len(s.apiToken) || subtle.ConstantTimeCompare([]byte(token), []byte(s.apiToken)) != 1 {
		if !s.isAuthenticated(r) {
			http.Error(w, "Invalid session token", http.StatusUnauthorized)
			return
		}
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "zvonochek_session",
		Value:    s.apiToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "authenticated"})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	s.clientsMu.Lock()
	if len(s.clients) >= maxWebSocketClients {
		s.clientsMu.Unlock()
		http.Error(w, "Too many local connections", http.StatusTooManyRequests)
		return
	}
	s.clientsMu.Unlock()

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(256 * 1024)

	s.clientsMu.Lock()
	s.clients[conn] = true
	s.clientsMu.Unlock()

	defer func() {
		s.clientsMu.Lock()
		delete(s.clients, conn)
		s.clientsMu.Unlock()
		conn.Close()
	}()

	for {
		var clientMsg struct {
			Action      string                 `json:"action"`
			PeerID      string                 `json:"peer_id"`
			Message     string                 `json:"message"`
			Signal      p2p.SignalPayload      `json:"signal"`
			RouteSwitch p2p.RouteSwitchPayload `json:"route_switch"`
			ForceSwitch bool                   `json:"force_switch"`
			Call        string                 `json:"call"` // "offer", "accept", "reject", "end"
			CallID      string                 `json:"call_id"`
			AttemptID   string                 `json:"attempt_id"`
			VoiceMode   string                 `json:"voice_mode"`
			HasVideo    bool                   `json:"has_video"`
		}

		if err := conn.ReadJSON(&clientMsg); err != nil {
			break
		}

		switch clientMsg.Action {
		case "send_chat":
			_ = s.node.SendMessage(clientMsg.PeerID, clientMsg.Message)
		case "send_signal":
			_ = s.node.SendSignal(clientMsg.PeerID, clientMsg.Signal)
		case "switch_route":
			_ = s.node.SendRouteSwitch(clientMsg.PeerID, clientMsg.RouteSwitch, clientMsg.ForceSwitch)
		case "call_action":
			switch clientMsg.Call {
			case "offer":
				_ = s.node.SendCallAction(clientMsg.PeerID, p2p.TypeCallOffer, clientMsg.CallID, clientMsg.AttemptID, clientMsg.VoiceMode, clientMsg.HasVideo)
			case "accept":
				_ = s.node.SendCallAction(clientMsg.PeerID, p2p.TypeCallAccept, clientMsg.CallID, clientMsg.AttemptID, clientMsg.VoiceMode, clientMsg.HasVideo)
			case "reject":
				_ = s.node.SendCallAction(clientMsg.PeerID, p2p.TypeCallReject, clientMsg.CallID, clientMsg.AttemptID, clientMsg.VoiceMode, clientMsg.HasVideo)
			case "end":
				_ = s.node.SendCallAction(clientMsg.PeerID, p2p.TypeCallEnd, clientMsg.CallID, clientMsg.AttemptID, clientMsg.VoiceMode, clientMsg.HasVideo)
			}
		}
	}
}

func (s *Server) handleVoiceWS(w http.ResponseWriter, r *http.Request) {
	peerID := r.URL.Query().Get("peer_id")
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(32 * 1024)

	s.clientsMu.Lock()
	s.voiceConns[conn] = peerID
	s.clientsMu.Unlock()

	defer func() {
		s.clientsMu.Lock()
		delete(s.voiceConns, conn)
		s.clientsMu.Unlock()
		conn.Close()
	}()

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if msgType == websocket.BinaryMessage && peerID != "" {
			_ = s.node.SendVoiceFrame(peerID, data)
		}
	}
}

func (s *Server) p2pEventLoop() {
	for ev := range s.node.Events {
		s.clientsMu.Lock()
		for c := range s.clients {
			_ = c.WriteJSON(ev)
		}
		s.clientsMu.Unlock()
	}
}

func (s *Server) voiceBroadcastLoop() {
	for frame := range s.node.VoiceInCh {
		s.clientsMu.Lock()
		for c := range s.voiceConns {
			_ = c.WriteMessage(websocket.BinaryMessage, frame)
		}
		s.clientsMu.Unlock()
	}
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	status := s.node.GetStatus()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

func (s *Server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	bt := s.node.GetBridgeTelemetry()
	btMap := map[string]interface{}{
		"active":               bt.Active,
		"frames_sent":          bt.FramesSent,
		"frames_received":      bt.FramesReceived,
		"frames_dropped_stale": bt.FramesDroppedStale,
		"seq_gaps":             bt.SeqGaps,
		"queue_duration_ms":    bt.QueueDurationMs,
		"last_frame_age_ms":    bt.LastFrameAgeMs,
		"stall_resets":         bt.StallResets,
	}
	report := s.node.ConnMgr.FormatSanitizedReport(btMap)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(report)
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		DirectTimeoutMs    int    `json:"direct_timeout_ms"`
		PreferredInterface string `json:"preferred_interface"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if req.DirectTimeoutMs > 0 {
		s.node.ConnMgr.SetDirectTimeout(req.DirectTimeoutMs)
	}
	s.node.ConnMgr.SetPreferredInterface(req.PreferredInterface)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.node.ConnMgr.GetSnapshot())
}

func (s *Server) handleInviteRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	code, bundle, err := s.node.GenerateInvite(true)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"invite_code": code,
		"expires_at":  bundle.ExpiresAt,
	})
}

func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)

	var req struct {
		Target string `json:"target"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	peerID, err := s.node.ConnectPeer(req.Target)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":  "connected",
		"peer_id": peerID,
	})
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, s.node.Config.MaxFileSizeBytes+1024*1024)
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		http.Error(w, "Файл слишком велик или запрос поврежден", http.StatusBadRequest)
		return
	}

	peerID := r.FormValue("peer_id")
	if peerID == "" {
		http.Error(w, "Missing peer_id", http.StatusBadRequest)
		return
	}

	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	tempDir := filepath.Join(os.TempDir(), "zvonochek_uploads")
	_ = os.MkdirAll(tempDir, 0700)
	safeBase := filepath.Base(handler.Filename)
	tempPath := filepath.Join(tempDir, safeBase)

	dst, err := os.OpenFile(tempPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		http.Error(w, "Failed to save staging file", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(dst, file); err != nil {
		dst.Close()
		http.Error(w, "Failed writing file", http.StatusInternalServerError)
		return
	}
	dst.Close()

	transferID, err := s.node.OfferFile(peerID, tempPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to offer file: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"transfer_id": transferID,
		"file_name":   safeBase,
		"status":      "awaiting_consent",
	})
}

func (s *Server) handleFileDecision(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)

	var req struct {
		PeerID string               `json:"peer_id"`
		Offer  p2p.FileOfferPayload `json:"offer"`
		Accept bool                 `json:"accept"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	if err := s.node.RespondToFileOffer(req.PeerID, req.Offer, req.Accept); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
