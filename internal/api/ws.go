package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type wsClient struct {
	conn   *websocket.Conn
	sendMu sync.Mutex
	opened time.Time
}

func (c *wsClient) write(v any) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteJSON(v)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(512 << 10)
	cl := &wsClient{conn: conn, opened: time.Now()}

	// only one window: the newest one wins, older ones close themselves
	s.winMu.Lock()
	for old := range s.windows {
		go old.write(map[string]string{"type": "superseded"})
	}
	s.windows[cl] = true
	s.winMu.Unlock()

	events, unsubscribe := s.n.Subscribe()
	done := make(chan struct{})
	defer func() {
		close(done)
		unsubscribe()
		s.winMu.Lock()
		delete(s.windows, cl)
		left := len(s.windows)
		s.winMu.Unlock()
		conn.Close()
		if left == 0 {
			s.n.UIGone()
		}
	}()
	_ = cl.write(map[string]string{"type": "ready"})
	go func() {
		ping := time.NewTicker(25 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-done:
				return
			case ev, ok := <-events:
				if !ok {
					return
				}
				if err := cl.write(ev); err != nil {
					conn.Close()
					return
				}
			case <-ping.C:
				cl.sendMu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				err := conn.WriteMessage(websocket.PingMessage, nil)
				cl.sendMu.Unlock()
				if err != nil {
					conn.Close()
					return
				}
			}
		}
	}()
	_ = conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(75 * time.Second)) })
	for {
		var msg struct {
			Type string          `json:"type"`
			Peer string          `json:"peer"`
			CID  string          `json:"cid"`
			Data json.RawMessage `json:"data"`
		}
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		switch msg.Type {
		case "rtc":
			_ = s.n.SendRTC(msg.CID, msg.Data)
		case "typing":
			s.n.SendTyping(msg.Peer)
		case "read":
			s.n.MarkRead(msg.Peer)
		case "ping":
			_ = cl.write(map[string]string{"type": "pong"})
		}
	}
}

func (s *Server) handleVoiceWS(w http.ResponseWriter, r *http.Request) {
	cid := r.URL.Query().Get("cid")
	send, recv, stats, detach, err := s.n.VoiceAttach(cid)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	defer detach()
	conn, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(8 << 10)
	var wmu sync.Mutex
	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case b, ok := <-recv:
				if !ok {
					return
				}
				wmu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				err := conn.WriteMessage(websocket.BinaryMessage, b)
				wmu.Unlock()
				if err != nil {
					conn.Close()
					return
				}
			case <-t.C:
				wmu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
				err := conn.WriteJSON(map[string]any{"type": "stats", "stats": stats()})
				wmu.Unlock()
				if err != nil {
					conn.Close()
					return
				}
			}
		}
	}()
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt == websocket.BinaryMessage {
			send(data)
		}
	}
}
