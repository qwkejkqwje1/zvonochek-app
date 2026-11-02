package node

import (
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/libp2p/go-libp2p/core/peer"

	"zvonochek2/internal/store"
)

func (n *Node) acceptedPeer(id string) (peer.ID, store.Contact, error) {
	pid, err := peer.Decode(id)
	if err != nil {
		return "", store.Contact{}, errors.New("некорректный ID контакта")
	}
	c, ok := n.st.Contact(id)
	if !ok {
		return "", store.Contact{}, errors.New("контакт не найден")
	}
	switch c.State {
	case store.ContactAccepted:
		return pid, c, nil
	case store.ContactOutgoing:
		return "", c, errors.New("контакт ещё не подтвердил ваш запрос")
	case store.ContactIncoming:
		return "", c, errors.New("сначала примите запрос контакта")
	}
	return "", c, errors.New("контакт заблокирован")
}

func sanitizeTS(ts int64) int64 {
	now := time.Now().UnixMilli()
	if ts <= 0 || ts > now+5*60*1000 || ts < now-400*24*3600*1000 {
		return now
	}
	return ts
}

func validID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// SendText stores and delivers a chat message (queued while the peer is offline).
func (n *Node) SendText(peerID, text string) (store.Message, error) {
	text = strings.TrimRight(strings.TrimLeft(clampText(text, maxTextLen), "\r\n"), " \t\r\n")
	if strings.TrimSpace(text) == "" {
		return store.Message{}, errors.New("пустое сообщение")
	}
	pid, _, err := n.acceptedPeer(peerID)
	if err != nil {
		return store.Message{}, err
	}
	m := store.Message{ID: uuid.NewString(), Peer: peerID, Out: true, Kind: store.KindText, Text: text,
		TS: time.Now().UnixMilli(), Status: store.StatusPending}
	n.st.AddMessage(m)
	n.emitNew(m)
	go n.deliverText(pid, m)
	return m, nil
}

func (n *Node) deliverText(pid peer.ID, m store.Message) {
	f, _ := mkFrame(fMsg, m.ID, m.TS, msgPayload{Text: m.Text})
	_, err := n.sendTimeout(pid, 45*time.Second, f, false)
	switch {
	case err == nil:
		n.setStatus(m.Peer, m.ID, store.StatusDelivered)
	case IsRemote(err, errNotContact):
		n.setStatus(m.Peer, m.ID, store.StatusFailed)
	}
}

// emitNew publishes a freshly stored message together with the refreshed
// contact (sidebar preview, ordering and unread counter live in its summary).
func (n *Node) emitNew(m store.Message) {
	n.emit("message", m)
	n.emitContact(m.Peer)
}

func (n *Node) emitContact(peerID string) {
	if c, ok := n.st.Contact(peerID); ok {
		n.emit("contact", n.contactView(c))
	}
}

func (n *Node) setStatus(peerID, id, status string) {
	m, ok := n.st.UpdateMessage(peerID, id, func(m *store.Message) {
		if m.Status == store.StatusRead && status == store.StatusDelivered {
			return
		}
		m.Status = status
	})
	if ok {
		n.emit("message", m)
	}
}

// RetryMessage re-sends a failed or pending message.
func (n *Node) RetryMessage(peerID, id string) error {
	pid, _, err := n.acceptedPeer(peerID)
	if err != nil {
		return err
	}
	m, ok := n.st.UpdateMessage(peerID, id, func(m *store.Message) {
		if m.Out && m.Status == store.StatusFailed {
			m.Status = store.StatusPending
		}
	})
	if !ok || !m.Out {
		return errors.New("сообщение не найдено")
	}
	n.emit("message", m)
	switch m.Kind {
	case store.KindText:
		go n.deliverText(pid, m)
	case store.KindFile:
		go n.deliverFileOffer(pid, m)
	}
	return nil
}

func (n *Node) onChat(pid peer.ID, f Frame) Ack {
	var p msgPayload
	if err := jsonUnmarshal(f.D, &p); err != nil || !validID(f.ID) {
		return Ack{Err: errBadFrame}
	}
	text := clampText(p.Text, maxTextLen)
	if strings.TrimSpace(text) == "" {
		return Ack{OK: true}
	}
	m := store.Message{ID: f.ID, Peer: pid.String(), Kind: store.KindText, Text: text,
		TS: sanitizeTS(f.TS), Status: store.StatusReceived}
	if n.st.AddMessage(m) {
		n.emitNew(m)
		n.notifyMessage(pid, text)
	}
	return Ack{OK: true}
}

func (n *Node) notifyMessage(pid peer.ID, text string) {
	c, _ := n.st.Contact(pid.String())
	if c.Muted {
		return
	}
	if len([]rune(text)) > 120 {
		text = string([]rune(text)[:120]) + "…"
	}
	n.emit("notify", map[string]string{"kind": "message", "peer": pid.String(), "title": c.DisplayName(), "text": text})
}

// MarkRead marks the chat as read and sends read receipts.
func (n *Node) MarkRead(peerID string) {
	ids := n.st.MarkRead(peerID)
	if len(ids) == 0 {
		return
	}
	if c, ok := n.st.Contact(peerID); ok {
		n.emit("contact", n.contactView(c))
	}
	pid, err := peer.Decode(peerID)
	if err != nil {
		return
	}
	n.sendReceipts(pid, ids)
}

func (n *Node) sendReceipts(pid peer.ID, ids []string) {
	for len(ids) > 0 {
		chunk := ids
		if len(chunk) > 500 {
			chunk = ids[:500]
		}
		ids = ids[len(chunk):]
		f, _ := mkFrame(fRead, NewSecret(), time.Now().UnixMilli(), readPayload{IDs: chunk})
		n.sendAsync(pid, f, true)
	}
}

// sendAsync enqueues a frame without waiting for the acknowledgement.
func (n *Node) sendAsync(pid peer.ID, f Frame, noDial bool) {
	r := n.rt(pid)
	it := &outItem{f: f, noDial: noDial, done: make(chan sendResult, 1)}
	select {
	case r.q <- it:
	default: // queue full: drop ephemeral frame
	}
}

func (n *Node) onRead(pid peer.ID, f Frame) Ack {
	var p readPayload
	if err := jsonUnmarshal(f.D, &p); err != nil {
		return Ack{Err: errBadFrame}
	}
	if len(p.IDs) > 1000 {
		p.IDs = p.IDs[:1000]
	}
	for _, id := range p.IDs {
		m, ok := n.st.UpdateMessage(pid.String(), id, func(m *store.Message) {
			if m.Out && m.Status != store.StatusFailed {
				m.Status = store.StatusRead
			}
		})
		if ok && m.Out {
			n.emit("message", m)
		}
	}
	return Ack{OK: true}
}

// SendTyping notifies the peer that we are typing (best effort).
func (n *Node) SendTyping(peerID string) {
	pid, _, err := n.acceptedPeer(peerID)
	if err != nil || !n.presence(pid).Online {
		return
	}
	f, _ := mkFrame(fTyping, NewSecret(), time.Now().UnixMilli(), nil)
	n.sendAsync(pid, f, true)
}

// Messages returns chat history.
func (n *Node) Messages(peerID string, before int64, limit int) []store.Message {
	return n.st.Messages(peerID, before, limit)
}

// DeleteMessage removes a message locally.
func (n *Node) DeleteMessage(peerID, id string) bool {
	m, ok := n.st.Message(peerID, id)
	if !ok {
		return false
	}
	if m.Kind == store.KindFile && m.File != nil {
		n.stopTransfer(m.File.TransferID)
		if m.Out && m.File.Path != "" {
			removeQuiet(m.File.Path)
		}
	}
	if n.st.DeleteMessage(peerID, id) {
		n.emit("message_deleted", map[string]string{"peer": peerID, "id": id})
		return true
	}
	return false
}

// ClearHistory removes the whole conversation locally.
func (n *Node) ClearHistory(peerID string) {
	for _, m := range n.st.Messages(peerID, 0, 1000) {
		if m.Kind == store.KindFile && m.File != nil {
			n.stopTransfer(m.File.TransferID)
			if m.Out && m.File.Path != "" {
				removeQuiet(m.File.Path)
			}
		}
	}
	n.st.ClearHistory(peerID)
	n.emit("history_cleared", map[string]string{"peer": peerID})
	if c, ok := n.st.Contact(peerID); ok {
		n.emit("contact", n.contactView(c))
	}
}

// flushOutbox re-sends everything that was queued while the peer was away.
func (n *Node) flushOutbox(pid peer.ID) {
	id := pid.String()
	pending := n.st.Find(func(m *store.Message) bool {
		if m.Peer != id {
			return false
		}
		if m.Out && m.Status == store.StatusPending {
			return true
		}
		// interrupted incoming downloads resume automatically
		return !m.Out && m.File != nil && (m.File.State == store.FileTransferring ||
			(m.File.State == store.FileFailed && m.File.Error == errCodeInterrupted))
	})
	for _, m := range pending {
		switch {
		case m.Kind == store.KindText:
			n.deliverText(pid, m)
		case m.Kind == store.KindFile && m.Out:
			n.deliverFileOffer(pid, m)
		case m.Kind == store.KindFile && !m.Out:
			n.startDownload(pid, m.File.TransferID)
		}
	}
	// re-send recent read receipts (idempotent on the other side)
	var reads []string
	for _, m := range n.st.Messages(id, 0, 60) {
		if !m.Out && m.Status == store.StatusRead {
			reads = append(reads, m.ID)
		}
	}
	if len(reads) > 0 {
		n.sendReceipts(pid, reads)
	}
}
