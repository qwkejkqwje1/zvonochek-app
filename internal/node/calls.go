package node

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/libp2p/go-libp2p/core/peer"

	"zvonochek2/internal/store"
)

// Call states.
const (
	CallOutgoing = "outgoing" // ringing at the callee
	CallIncoming = "incoming" // ringing here
	CallActive   = "active"
)

const ringTimeout = 50 * time.Second

type callState struct {
	ID       string
	Peer     peer.ID
	Out      bool
	Video    bool
	State    string
	Mode     string
	Started  time.Time
	Answered time.Time
	timer    *time.Timer
}

// CallView is sent to the UI.
type CallView struct {
	ID       string `json:"id"`
	Peer     string `json:"peer"`
	Display  string `json:"display"`
	Out      bool   `json:"out"`
	Video    bool   `json:"video"`
	State    string `json:"state"`
	Mode     string `json:"mode"`
	Started  int64  `json:"started"`
	Answered int64  `json:"answered,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// IncomingCallHook is invoked (if set) when a call starts ringing; the
// desktop layer uses it to open the window.
var IncomingCallHook func(CallView)

func (n *Node) callView(c *callState, reason string) CallView {
	if c == nil {
		return CallView{}
	}
	cv := CallView{ID: c.ID, Peer: c.Peer.String(), Out: c.Out, Video: c.Video, State: c.State,
		Mode: c.Mode, Started: c.Started.UnixMilli(), Reason: reason}
	if !c.Answered.IsZero() {
		cv.Answered = c.Answered.UnixMilli()
	}
	if ct, ok := n.st.Contact(cv.Peer); ok {
		cv.Display = ct.DisplayName()
	}
	return cv
}

// CurrentCall returns the active call, if any.
func (n *Node) CurrentCall() (CallView, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.call == nil {
		return CallView{}, false
	}
	return n.callView(n.call, ""), true
}

func (n *Node) callActive() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.call != nil && n.call.State == CallActive
}

// StartCall rings a contact.
func (n *Node) StartCall(ctx context.Context, peerID string, video bool) (CallView, error) {
	pid, _, err := n.acceptedPeer(peerID)
	if err != nil {
		return CallView{}, err
	}
	n.mu.Lock()
	if n.call != nil {
		n.mu.Unlock()
		return CallView{}, errors.New("уже идёт другой звонок")
	}
	c := &callState{ID: uuid.NewString(), Peer: pid, Out: true, Video: video, State: CallOutgoing, Mode: "webrtc", Started: time.Now()}
	n.call = c
	n.mu.Unlock()

	f, _ := mkFrame(fCallInvite, NewSecret(), time.Now().UnixMilli(), callPayload{CID: c.ID, Video: video})
	sctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	_, err = n.send(sctx, pid, f, false)
	if err != nil {
		n.mu.Lock()
		if n.call == c {
			n.call = nil
		}
		n.mu.Unlock()
		if IsRemote(err, errBusy) {
			n.addCallLog(pid, true, video, "busy", 0)
			return CallView{}, errors.New("абонент занят — у него идёт другой звонок")
		}
		if IsRemote(err, errNotContact) {
			return CallView{}, errors.New("собеседник не принимает звонки от вас (вы не в его контактах)")
		}
		n.addCallLog(pid, true, video, "failed", 0)
		return CallView{}, errors.New("абонент не в сети или недоступен")
	}
	n.mu.Lock()
	if n.call != c { // ended while we were waiting for the ack
		n.mu.Unlock()
		return CallView{}, errors.New("звонок завершён")
	}
	c.timer = time.AfterFunc(ringTimeout, func() { n.ringTimeout(c.ID) })
	cv := n.callView(c, "")
	n.mu.Unlock()
	n.emit("call", cv)
	return cv, nil
}

func (n *Node) ringTimeout(cid string) {
	n.mu.Lock()
	c := n.call
	if c == nil || c.ID != cid || c.State == CallActive {
		n.mu.Unlock()
		return
	}
	n.call = nil
	n.mu.Unlock()
	if c.Out {
		n.sendCallFrame(c.Peer, fCallEnd, callPayload{CID: cid, Reason: "no_answer"})
		n.addCallLog(c.Peer, true, c.Video, "no_answer", 0)
	} else {
		n.addCallLog(c.Peer, false, c.Video, "missed", 0)
	}
	n.emitCallEnded(c, "timeout")
}

func (n *Node) sendCallFrame(pid peer.ID, typ string, p callPayload) {
	f, _ := mkFrame(typ, NewSecret(), time.Now().UnixMilli(), p)
	go func() { _, _ = n.sendTimeout(pid, 15*time.Second, f, false) }()
}

func (n *Node) emitCallEnded(c *callState, reason string) {
	cv := n.callView(c, reason)
	cv.State = "ended"
	n.emit("call", cv)
	n.stopVoice(c.ID)
}

// AcceptCall answers the ringing call.
func (n *Node) AcceptCall(cid string) (CallView, error) {
	n.mu.Lock()
	c := n.call
	if c == nil || c.ID != cid || c.Out || c.State != CallIncoming {
		n.mu.Unlock()
		return CallView{}, errors.New("вызов уже завершён")
	}
	n.mu.Unlock()
	f, _ := mkFrame(fCallAccept, NewSecret(), time.Now().UnixMilli(), callPayload{CID: cid})
	if _, err := n.sendTimeout(c.Peer, 15*time.Second, f, false); err != nil {
		n.mu.Lock()
		if n.call == c {
			n.call = nil
		}
		n.mu.Unlock()
		n.addCallLog(c.Peer, false, c.Video, "missed", 0)
		n.emitCallEnded(c, "failed")
		if IsRemote(err, errNoCall) {
			return CallView{}, errors.New("собеседник уже положил трубку")
		}
		return CallView{}, errors.New("связь с собеседником потеряна")
	}
	n.mu.Lock()
	if n.call != c {
		n.mu.Unlock()
		return CallView{}, errors.New("вызов уже завершён")
	}
	if c.timer != nil {
		c.timer.Stop()
	}
	c.State = CallActive
	c.Answered = time.Now()
	cv := n.callView(c, "")
	n.mu.Unlock()
	n.emit("call", cv)
	go n.callKeepalive(c)
	return cv, nil
}

// callKeepalive notices a peer that vanished mid-call (crash, restart,
// network gone) and ends the call instead of leaving it hanging forever.
func (n *Node) callKeepalive(c *callState) {
	t := time.NewTicker(8 * time.Second)
	defer t.Stop()
	misses := 0
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
		}
		n.mu.Lock()
		cur := n.call
		n.mu.Unlock()
		if cur != c {
			return
		}
		f, _ := mkFrame(fCallPing, NewSecret(), time.Now().UnixMilli(), callPayload{CID: c.ID})
		_, err := n.sendTimeout(c.Peer, 6*time.Second, f, false)
		switch {
		case err == nil:
			misses = 0
		case IsRemote(err, errNoCall):
			n.dropCall(c, "remote:lost")
			return
		default:
			misses++
			if misses >= 6 {
				n.dropCall(c, "lost")
				return
			}
		}
	}
}

func (n *Node) dropCall(c *callState, reason string) {
	n.mu.Lock()
	if n.call != c {
		n.mu.Unlock()
		return
	}
	n.call = nil
	if c.timer != nil {
		c.timer.Stop()
	}
	n.mu.Unlock()
	n.addCallLog(c.Peer, c.Out, c.Video, "answered", int64(time.Since(c.Answered).Seconds()))
	n.emitCallEnded(c, reason)
}

// RejectCall declines the ringing call (or cancels an outgoing one).
func (n *Node) RejectCall(cid string) error { return n.EndCall(cid, "declined") }

// EndCall hangs up.
func (n *Node) EndCall(cid, reason string) error {
	n.mu.Lock()
	c := n.call
	if c == nil || (cid != "" && c.ID != cid) {
		n.mu.Unlock()
		return nil
	}
	n.call = nil
	if c.timer != nil {
		c.timer.Stop()
	}
	n.mu.Unlock()
	switch {
	case c.State == CallIncoming:
		n.sendCallFrame(c.Peer, fCallReject, callPayload{CID: c.ID, Reason: "declined"})
		n.addCallLog(c.Peer, false, c.Video, "declined", 0)
	case c.State == CallOutgoing:
		n.sendCallFrame(c.Peer, fCallEnd, callPayload{CID: c.ID, Reason: "canceled"})
		n.addCallLog(c.Peer, true, c.Video, "canceled", 0)
	default:
		n.sendCallFrame(c.Peer, fCallEnd, callPayload{CID: c.ID, Reason: reason})
		n.addCallLog(c.Peer, c.Out, c.Video, "answered", int64(time.Since(c.Answered).Seconds()))
	}
	n.emitCallEnded(c, "local")
	return nil
}

func (n *Node) endCallOnShutdown() {
	n.mu.Lock()
	c := n.call
	n.call = nil
	n.mu.Unlock()
	if c == nil {
		return
	}
	f, _ := mkFrame(fCallEnd, NewSecret(), time.Now().UnixMilli(), callPayload{CID: c.ID, Reason: "shutdown"})
	_, _ = n.sendTimeout(c.Peer, 2*time.Second, f, true)
	if c.State == CallActive {
		n.addCallLog(c.Peer, c.Out, c.Video, "answered", int64(time.Since(c.Answered).Seconds()))
	}
}

// SetCallMode switches media transport (webrtc|bridge) on both sides.
func (n *Node) SetCallMode(cid, mode string) error {
	if mode != "webrtc" && mode != "bridge" {
		return errors.New("unknown mode")
	}
	n.mu.Lock()
	c := n.call
	if c == nil || c.ID != cid || c.State != CallActive {
		n.mu.Unlock()
		return errors.New("нет активного звонка")
	}
	c.Mode = mode
	cv := n.callView(c, "")
	n.mu.Unlock()
	f, _ := mkFrame(fCallMode, NewSecret(), time.Now().UnixMilli(), callPayload{CID: cid, Mode: mode})
	if _, err := n.sendTimeout(c.Peer, 10*time.Second, f, true); err != nil {
		return errors.New("не удалось согласовать режим с собеседником")
	}
	n.emit("call", cv)
	return nil
}

// SendRTC forwards an opaque WebRTC signalling blob to the call peer.
func (n *Node) SendRTC(cid string, data json.RawMessage) error {
	if len(data) == 0 || len(data) > maxControlFrame-1024 {
		return errors.New("bad signal")
	}
	n.mu.Lock()
	c := n.call
	n.mu.Unlock()
	if c == nil || c.ID != cid {
		return errors.New("нет активного звонка")
	}
	f, _ := mkFrame(fRTC, NewSecret(), time.Now().UnixMilli(), callPayload{CID: cid, Data: data})
	n.sendAsync(c.Peer, f, true)
	return nil
}

func (n *Node) onCallFrame(pid peer.ID, f Frame) Ack {
	var p callPayload
	if err := jsonUnmarshal(f.D, &p); err != nil || !validID(p.CID) {
		return Ack{Err: errBadFrame}
	}
	n.mu.Lock()
	c := n.call
	if f.T == fCallInvite {
		if c != nil {
			same := c.ID == p.CID
			n.mu.Unlock()
			if same {
				return Ack{OK: true}
			}
			n.addCallLog(pid, false, p.Video, "missed", 0)
			return Ack{Err: errBusy}
		}
		c = &callState{ID: p.CID, Peer: pid, Video: p.Video, State: CallIncoming, Mode: "webrtc", Started: time.Now()}
		n.call = c
		c.timer = time.AfterFunc(ringTimeout, func() { n.ringTimeout(c.ID) })
		cv := n.callView(c, "")
		n.mu.Unlock()
		n.emit("call", cv)
		n.emit("notify", map[string]string{"kind": "call", "peer": pid.String(), "title": cv.Display,
			"text": map[bool]string{true: "Входящий видеозвонок", false: "Входящий звонок"}[p.Video]})
		if hook := IncomingCallHook; hook != nil {
			go hook(cv)
		}
		return Ack{OK: true}
	}
	if c == nil || c.ID != p.CID || c.Peer != pid {
		n.mu.Unlock()
		return Ack{Err: errNoCall}
	}
	switch f.T {
	case fCallAccept:
		if !c.Out || c.State != CallOutgoing {
			n.mu.Unlock()
			return Ack{Err: errNoCall}
		}
		if c.timer != nil {
			c.timer.Stop()
		}
		c.State = CallActive
		c.Answered = time.Now()
		cv := n.callView(c, "")
		n.mu.Unlock()
		n.emit("call", cv)
		go n.callKeepalive(c)
		return Ack{OK: true}
	case fCallPing:
		n.mu.Unlock()
		return Ack{OK: c.State == CallActive, Err: map[bool]string{true: "", false: errNoCall}[c.State == CallActive]}
	case fCallReject, fCallEnd:
		n.call = nil
		if c.timer != nil {
			c.timer.Stop()
		}
		n.mu.Unlock()
		reason := clampText(p.Reason, 32)
		switch {
		case c.State == CallActive:
			n.addCallLog(pid, c.Out, c.Video, "answered", int64(time.Since(c.Answered).Seconds()))
		case c.Out && f.T == fCallReject:
			n.addCallLog(pid, true, c.Video, "declined", 0)
		case c.Out:
			n.addCallLog(pid, true, c.Video, "no_answer", 0)
		default:
			n.addCallLog(pid, false, c.Video, "missed", 0)
		}
		if f.T == fCallReject && reason == "" {
			reason = "declined"
		}
		n.emitCallEnded(c, "remote:"+reason)
		return Ack{OK: true}
	case fCallMode:
		if p.Mode != "webrtc" && p.Mode != "bridge" {
			n.mu.Unlock()
			return Ack{Err: errBadFrame}
		}
		c.Mode = p.Mode
		cv := n.callView(c, "")
		n.mu.Unlock()
		n.emit("call", cv)
		return Ack{OK: true}
	case fRTC:
		n.mu.Unlock()
		n.emit("rtc", map[string]any{"cid": p.CID, "peer": pid.String(), "data": p.Data})
		return Ack{OK: true}
	}
	n.mu.Unlock()
	return Ack{Err: errUnknown}
}

func (n *Node) addCallLog(pid peer.ID, out, video bool, result string, dur int64) {
	status := store.StatusRead
	if !out && result == "missed" {
		status = store.StatusReceived
	}
	m := store.Message{ID: uuid.NewString(), Peer: pid.String(), Out: out, Kind: store.KindCall,
		TS: time.Now().UnixMilli(), Status: status, Call: &store.CallInfo{Video: video, Result: result, Duration: dur}}
	n.st.AddMessage(m)
	n.emitNew(m)
}

// UIGone is called by the API when the last window disconnected.
func (n *Node) UIGone() {
	time.AfterFunc(20*time.Second, func() {
		if n.Subscribers() > 0 {
			return
		}
		n.mu.Lock()
		c := n.call
		n.mu.Unlock()
		if c != nil && c.State != CallIncoming {
			_ = n.EndCall(c.ID, "window_closed")
		}
	})
}
