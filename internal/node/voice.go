package node

import (
	"bufio"
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
)

// The audio bridge carries Opus frames (encoded in the browser with
// WebCodecs) over a libp2p stream when WebRTC cannot establish a media
// path (strict firewalls, UDP blocked). Queues are tiny and drop the oldest
// frame, so latency never accumulates behind head-of-line blocking.

const (
	voiceOutQueue = 8  // ~160 ms of 20 ms frames
	voiceInQueue  = 16 // jitter is handled by the browser
)

type voiceSession struct {
	cid  string
	peer peer.ID
	out  chan []byte
	in   chan []byte
	stop context.CancelFunc
	ctx  context.Context

	sent, recv, dropped atomic.Uint64
	attached            atomic.Int32
	once                sync.Once
}

// VoiceStats are shown in the call diagnostics panel.
type VoiceStats struct {
	Sent    uint64 `json:"sent"`
	Recv    uint64 `json:"recv"`
	Dropped uint64 `json:"dropped"`
}

// VoiceAttach connects the UI to the audio bridge of the current call.
func (n *Node) VoiceAttach(cid string) (send func([]byte), recv <-chan []byte, stats func() VoiceStats, detach func(), err error) {
	n.mu.Lock()
	c := n.call
	if c == nil || c.ID != cid || c.State != CallActive {
		n.mu.Unlock()
		return nil, nil, nil, nil, errors.New("нет активного звонка")
	}
	vs := n.voice
	if vs == nil || vs.cid != cid {
		if vs != nil {
			vs.close()
		}
		ctx, cancel := context.WithCancel(n.ctx)
		vs = &voiceSession{cid: cid, peer: c.Peer, out: make(chan []byte, voiceOutQueue), in: make(chan []byte, voiceInQueue), stop: cancel, ctx: ctx}
		n.voice = vs
		go n.voiceWriter(vs)
	}
	n.mu.Unlock()
	vs.attached.Add(1)
	send = func(b []byte) {
		if len(b) == 0 || len(b) > maxVoiceFrame {
			return
		}
		cp := append([]byte(nil), b...)
		pushDropOldest(vs.out, cp, &vs.dropped)
	}
	stats = func() VoiceStats {
		return VoiceStats{Sent: vs.sent.Load(), Recv: vs.recv.Load(), Dropped: vs.dropped.Load()}
	}
	detach = func() { vs.attached.Add(-1) }
	return send, vs.in, stats, detach, nil
}

func pushDropOldest(ch chan []byte, b []byte, dropped *atomic.Uint64) {
	for i := 0; i < 2; i++ {
		select {
		case ch <- b:
			return
		default:
			select {
			case <-ch:
				dropped.Add(1)
			default:
			}
		}
	}
}

func (vs *voiceSession) close() {
	vs.once.Do(func() { vs.stop() })
}

func (n *Node) stopVoice(cid string) {
	n.mu.Lock()
	vs := n.voice
	if vs != nil && (cid == "" || vs.cid == cid) {
		n.voice = nil
	} else {
		vs = nil
	}
	n.mu.Unlock()
	if vs != nil {
		vs.close()
	}
}

func (n *Node) onPeerGoneForVoice(pid peer.ID) {
	// the libp2p connection dropped; the writer will reconnect if it comes back
}

func (n *Node) voiceWriter(vs *voiceSession) {
	var s network.Stream
	var w *bufio.Writer
	defer func() {
		if s != nil {
			s.Close()
		}
	}()
	for {
		var frame []byte
		select {
		case <-vs.ctx.Done():
			return
		case frame = <-vs.out:
		}
		if s == nil {
			ctx, cancel := context.WithTimeout(vs.ctx, 5*time.Second)
			st, err := n.h.NewStream(ctx, vs.peer, ProtoVoice)
			cancel()
			if err != nil {
				vs.dropped.Add(1)
				time.Sleep(300 * time.Millisecond)
				continue
			}
			if err := writeMsg(st, map[string]string{"cid": vs.cid}, 512); err != nil {
				st.Reset()
				continue
			}
			s, w = st, bufio.NewWriterSize(st, 8<<10)
		}
		_ = s.SetWriteDeadline(time.Now().Add(700 * time.Millisecond))
		err := writeBlob(w, frame)
		if err == nil && len(vs.out) == 0 {
			err = w.Flush()
		}
		if err != nil {
			s.Reset()
			s = nil
			vs.dropped.Add(1)
			continue
		}
		vs.sent.Add(1)
	}
}

func (n *Node) handleVoiceStream(s network.Stream) {
	defer s.Close()
	pid := s.Conn().RemotePeer()
	_ = s.SetReadDeadline(time.Now().Add(10 * time.Second))
	rd := bufio.NewReaderSize(s, 16<<10)
	var hdr struct {
		CID string `json:"cid"`
	}
	if err := readMsg(rd, &hdr, 512); err != nil {
		s.Reset()
		return
	}
	n.mu.Lock()
	c := n.call
	ok := c != nil && c.ID == hdr.CID && c.Peer == pid && c.State == CallActive
	n.mu.Unlock()
	if !ok {
		s.Reset()
		return
	}
	// make sure a session exists so frames are buffered until the UI attaches
	n.mu.Lock()
	vs := n.voice
	if vs == nil || vs.cid != hdr.CID {
		ctx, cancel := context.WithCancel(n.ctx)
		vs = &voiceSession{cid: hdr.CID, peer: pid, out: make(chan []byte, voiceOutQueue), in: make(chan []byte, voiceInQueue), stop: cancel, ctx: ctx}
		n.voice = vs
		go n.voiceWriter(vs)
	}
	n.mu.Unlock()
	go func() { <-vs.ctx.Done(); s.Reset() }()
	for {
		_ = s.SetReadDeadline(time.Now().Add(30 * time.Second))
		b, err := readBlob(rd)
		if err != nil {
			return
		}
		vs.recv.Add(1)
		pushDropOldest(vs.in, b, &vs.dropped)
	}
}
