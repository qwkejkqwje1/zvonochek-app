// Package node implements the Zvonochek peer: libp2p host, discovery,
// contacts, chat, file transfer, call signalling and the audio bridge.
package node

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p"
	dht "github.com/libp2p/go-libp2p-kad-dht"
	"github.com/libp2p/go-libp2p/core/event"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/routing"
	drouting "github.com/libp2p/go-libp2p/p2p/discovery/routing"
	"github.com/libp2p/go-libp2p/p2p/host/autorelay"
	"github.com/libp2p/go-libp2p/p2p/net/connmgr"
	"github.com/libp2p/go-libp2p/p2p/protocol/ping"
	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
	"golang.org/x/time/rate"

	"zvonochek2/internal/store"
	"zvonochek2/internal/version"
)

// Options configure a Node.
type Options struct {
	Store        *store.Store
	IdentityPath string
	P2PPort      int      // >0 overrides settings
	ExtraRelays  []string // relays passed on the command line
	NoInternet   bool     // force-disable public DHT / relays (tests)
	NoLAN        bool     // force-disable mDNS / VM beacon (tests)
	LoopbackOnly bool     // listen on 127.0.0.1 only (tests)
	BeaconPort   int      // VM beacon port (0 = default)
}

// NotifyHook shows a desktop notification while no window is open.
var NotifyHook func(kind, title, text string)

// Event is pushed to UI subscribers.
type Event struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

// Node is a running Zvonochek peer.
type Node struct {
	opt   Options
	st    *store.Store
	h     host.Host
	kdht  *dht.IpfsDHT
	disc  *drouting.RoutingDiscovery
	pings *ping.PingService
	ctx   context.Context
	stop  context.CancelFunc

	internet bool
	lan      bool
	p2pPort  int

	busMu  sync.Mutex
	subs   map[int]chan Event
	nextID int

	mu        sync.Mutex
	peers     map[peer.ID]*peerRT
	nearby    map[peer.ID]*nearbyPeer
	pairReqs  map[peer.ID]*PairRequest
	relays    []*relayState
	transfers map[string]*transfer
	call      *callState
	voice     *voiceSession
	net       NetStatus
	strangers *rate.Limiter

	wg sync.WaitGroup
}

type peerRT struct {
	id        peer.ID
	q         chan *outItem
	online    bool
	helloAt   time.Time
	helloBusy bool
	rtt       int64
	nextDial  time.Time
	backoff   time.Duration
	dialing   bool
	limiter   *rate.Limiter
}

type outItem struct {
	f      Frame
	noDial bool
	done   chan sendResult
}

type sendResult struct {
	ack Ack
	err error
}

// NetStatus summarises connectivity for the UI.
type NetStatus struct {
	Reachability string   `json:"reachability"` // unknown|public|private
	NAT          string   `json:"nat,omitempty"`
	PublicAddrs  []string `json:"public_addrs"`
	LocalAddrs   []string `json:"local_addrs"`
	RelayAddrs   []string `json:"relay_addrs"`
	DHTPeers     int      `json:"dht_peers"`
	Internet     bool     `json:"internet"`
	LAN          bool     `json:"lan"`
	Connected    int      `json:"connected"`
	P2PPort      int      `json:"p2p_port"`
}

// New starts the node.
func New(opt Options) (*Node, error) {
	if opt.Store == nil {
		return nil, errors.New("store is required")
	}
	priv, err := LoadOrCreateIdentity(opt.IdentityPath)
	if err != nil {
		return nil, err
	}
	st := opt.Store.Settings()
	ctx, cancel := context.WithCancel(context.Background())
	n := &Node{
		opt:       opt,
		st:        opt.Store,
		ctx:       ctx,
		stop:      cancel,
		subs:      map[int]chan Event{},
		peers:     map[peer.ID]*peerRT{},
		nearby:    map[peer.ID]*nearbyPeer{},
		pairReqs:  map[peer.ID]*PairRequest{},
		transfers: map[string]*transfer{},
		strangers: rate.NewLimiter(rate.Every(2*time.Second), 10),
		internet:  st.InternetDiscovery && !opt.NoInternet,
		lan:       st.LANDiscovery && !opt.NoLAN,
	}
	port := st.P2PPort
	if opt.P2PPort > 0 {
		port = opt.P2PPort
	}
	n.p2pPort = pickP2PPort(port, opt.LoopbackOnly)

	ip4, ip6 := "0.0.0.0", "::"
	if opt.LoopbackOnly {
		ip4, ip6 = "127.0.0.1", "::1"
	}
	listenOn := func(port int) []string {
		l := []string{
			fmt.Sprintf("/ip4/%s/tcp/%d", ip4, port),
			fmt.Sprintf("/ip4/%s/udp/%d/quic-v1", ip4, port),
		}
		if !opt.LoopbackOnly {
			l = append(l,
				fmt.Sprintf("/ip6/%s/tcp/%d", ip6, port),
				fmt.Sprintf("/ip6/%s/udp/%d/quic-v1", ip6, port))
		}
		return l
	}
	cm, err := connmgr.NewConnManager(48, 192, connmgr.WithGracePeriod(2*time.Minute))
	if err != nil {
		cancel()
		return nil, err
	}
	opts := []libp2p.Option{
		libp2p.Identity(priv),
		libp2p.ListenAddrStrings(listenOn(n.p2pPort)...),
		libp2p.UserAgent(version.UserAgent()),
		libp2p.ConnectionManager(cm),
		libp2p.EnableRelay(),
		libp2p.EnableHolePunching(),
	}
	if !opt.LoopbackOnly {
		opts = append(opts, libp2p.NATPortMap())
	}
	if n.internet {
		opts = append(opts,
			libp2p.Routing(func(h host.Host) (routing.PeerRouting, error) {
				d, err := dht.New(h,
					dht.Mode(dht.ModeClient),
					dht.BootstrapPeers(dht.GetDefaultBootstrapPeerAddrInfos()...))
				if err != nil {
					return nil, err
				}
				n.kdht = d
				return d, nil
			}),
			libp2p.EnableAutoRelayWithPeerSource(n.relayCandidates,
				autorelay.WithBootDelay(15*time.Second),
				autorelay.WithMinInterval(30*time.Second),
				autorelay.WithNumRelays(2)),
			libp2p.EnableAutoNATv2(),
		)
	}
	h, err := libp2p.New(opts...)
	if err != nil && n.p2pPort != 0 {
		// port race or exotic platform issue: retry on a random port
		log.Printf("[p2p] listen on %d failed (%v), retrying on a random port", n.p2pPort, err)
		n.p2pPort = 0
		opts[1] = libp2p.ListenAddrStrings(listenOn(0)...)
		h, err = libp2p.New(opts...)
	}
	if err != nil {
		cancel()
		return nil, fmt.Errorf("не удалось запустить libp2p: %w", err)
	}
	n.h = h
	if n.p2pPort == 0 { // random port: report the one actually bound
		for _, a := range h.Network().ListenAddresses() {
			if v, err := a.ValueForProtocol(ma.P_TCP); err == nil {
				if p, err := strconv.Atoi(v); err == nil && p > 0 {
					n.p2pPort = p
					break
				}
			}
		}
	}
	n.pings = ping.NewPingService(h)
	if n.kdht != nil {
		n.disc = drouting.NewRoutingDiscovery(n.kdht)
	}
	n.net = NetStatus{Reachability: "unknown", Internet: n.internet, LAN: n.lan, P2PPort: n.p2pPort}

	h.SetStreamHandler(ProtoControl, n.handleControl)
	h.SetStreamHandler(ProtoFile, n.handleFileStream)
	h.SetStreamHandler(ProtoVoice, n.handleVoiceStream)
	h.Network().Notify(&network.NotifyBundle{
		ConnectedF: func(_ network.Network, c network.Conn) {
			go n.onConnected(c.RemotePeer())
		},
		DisconnectedF: func(nw network.Network, c network.Conn) {
			pid := c.RemotePeer()
			go func() {
				time.Sleep(300 * time.Millisecond)
				if nw.Connectedness(pid) != network.Connected {
					n.onDisconnected(pid)
				} else {
					n.refreshPresence(pid)
				}
			}()
		},
	})

	// contacts are protected from connection-manager trimming
	for _, c := range n.st.Contacts() {
		if pid, err := peer.Decode(c.PeerID); err == nil {
			h.ConnManager().Protect(pid, "contact")
			n.rememberAddrs(pid, c.Addrs, c.Relays)
		}
	}

	n.goLoop(n.watchHostEvents)
	n.goLoop(n.connectorLoop)
	n.goLoop(n.presenceLoop)
	n.startRelays(append(append([]string(nil), st.Relays...), opt.ExtraRelays...))
	if n.internet {
		n.goLoop(n.internetLoop)
	}
	if n.lan {
		n.startLAN()
	}
	n.resumeTransfers()
	log.Printf("[p2p] peer %s listening on %v", h.ID(), h.Addrs())
	return n, nil
}

func (n *Node) goLoop(fn func()) {
	n.wg.Add(1)
	go func() {
		defer n.wg.Done()
		fn()
	}()
}

// Close stops the node.
func (n *Node) Close() error {
	n.endCallOnShutdown()
	n.stop()
	err := n.h.Close()
	if n.kdht != nil {
		_ = n.kdht.Close()
	}
	done := make(chan struct{})
	go func() { n.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
	return err
}

// ID returns the local peer id.
func (n *Node) ID() peer.ID { return n.h.ID() }

// Host exposes the libp2p host (diagnostics, tests).
func (n *Node) Host() host.Host { return n.h }

// P2PPort is the port actually used.
func (n *Node) P2PPort() int { return n.p2pPort }

// Store returns the backing store.
func (n *Node) Store() *store.Store { return n.st }

// Subscribe registers an event listener.
func (n *Node) Subscribe() (<-chan Event, func()) {
	n.busMu.Lock()
	defer n.busMu.Unlock()
	id := n.nextID
	n.nextID++
	ch := make(chan Event, 1024)
	n.subs[id] = ch
	return ch, func() {
		n.busMu.Lock()
		defer n.busMu.Unlock()
		if c, ok := n.subs[id]; ok {
			delete(n.subs, id)
			close(c)
		}
	}
}

// Subscribers returns the number of UI listeners.
func (n *Node) Subscribers() int {
	n.busMu.Lock()
	defer n.busMu.Unlock()
	return len(n.subs)
}

func (n *Node) emit(typ string, data any) {
	ev := Event{Type: typ, Data: data}
	n.busMu.Lock()
	defer n.busMu.Unlock()
	if typ == "notify" && len(n.subs) == 0 && NotifyHook != nil {
		if m, ok := data.(map[string]string); ok {
			go NotifyHook(m["kind"], m["title"], m["text"])
		}
	}
	for _, ch := range n.subs {
		select {
		case ch <- ev:
		default:
			// slow consumer: drop one event and ask the UI to resync
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- Event{Type: "resync"}:
			default:
			}
		}
	}
}

func (n *Node) rt(pid peer.ID) *peerRT {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.rtLocked(pid)
}

func (n *Node) rtLocked(pid peer.ID) *peerRT {
	r, ok := n.peers[pid]
	if !ok {
		r = &peerRT{
			id:      pid,
			q:       make(chan *outItem, 256),
			backoff: 10 * time.Second,
			limiter: rate.NewLimiter(rate.Limit(60), 300),
		}
		n.peers[pid] = r
		n.goLoop(func() { n.outboxWorker(r) })
	}
	return r
}

// send queues a frame for pid and waits for the peer's acknowledgement.
// Frames to the same peer are delivered strictly in order.
func (n *Node) send(ctx context.Context, pid peer.ID, f Frame, noDial bool) (Ack, error) {
	if pid == n.h.ID() {
		return Ack{}, errors.New("нельзя отправить самому себе")
	}
	r := n.rt(pid)
	it := &outItem{f: f, noDial: noDial, done: make(chan sendResult, 1)}
	select {
	case r.q <- it:
	case <-ctx.Done():
		return Ack{}, ctx.Err()
	case <-n.ctx.Done():
		return Ack{}, n.ctx.Err()
	}
	select {
	case res := <-it.done:
		if res.err == nil && !res.ack.OK {
			return res.ack, &RemoteError{Code: res.ack.Err}
		}
		return res.ack, res.err
	case <-ctx.Done():
		return Ack{}, ctx.Err()
	case <-n.ctx.Done():
		return Ack{}, n.ctx.Err()
	}
}

func (n *Node) sendTimeout(pid peer.ID, d time.Duration, f Frame, noDial bool) (Ack, error) {
	ctx, cancel := context.WithTimeout(n.ctx, d)
	defer cancel()
	return n.send(ctx, pid, f, noDial)
}

func (n *Node) outboxWorker(r *peerRT) {
	for {
		var first *outItem
		select {
		case <-n.ctx.Done():
			return
		case first = <-r.q:
		}
		batch := []*outItem{first}
		noDial := first.noDial
	drain:
		for len(batch) < 32 {
			select {
			case it := <-r.q:
				batch = append(batch, it)
				noDial = noDial && it.noDial
			default:
				break drain
			}
		}
		frames := make([]Frame, len(batch))
		for i, it := range batch {
			frames[i] = it.f
		}
		acks, err := n.exchange(r.id, frames, noDial)
		for i, it := range batch {
			if i < len(acks) {
				it.done <- sendResult{ack: acks[i]}
			} else {
				if err == nil {
					err = io.ErrUnexpectedEOF
				}
				it.done <- sendResult{err: err}
			}
		}
	}
}

func (n *Node) exchange(pid peer.ID, frames []Frame, noDial bool) ([]Ack, error) {
	ctx, cancel := context.WithTimeout(n.ctx, 30*time.Second)
	defer cancel()
	ctx = network.WithAllowLimitedConn(ctx, "zvonochek-control")
	if noDial {
		if n.h.Network().Connectedness(pid) != network.Connected {
			return nil, errOffline
		}
		ctx = network.WithNoDial(ctx, "ephemeral")
	} else if n.h.Network().Connectedness(pid) != network.Connected {
		if err := n.dialPeer(ctx, pid); err != nil {
			return nil, err
		}
	}
	s, err := n.h.NewStream(ctx, pid, ProtoControl)
	if err != nil {
		return nil, err
	}
	defer s.Close()
	_ = s.SetDeadline(time.Now().Add(25 * time.Second))
	w := bufio.NewWriter(s)
	for _, f := range frames {
		if err := writeMsg(w, f, maxControlFrame); err != nil {
			s.Reset()
			return nil, err
		}
	}
	if err := w.Flush(); err != nil {
		s.Reset()
		return nil, err
	}
	_ = s.CloseWrite()
	rd := bufio.NewReader(s)
	acks := make([]Ack, 0, len(frames))
	for range frames {
		var a Ack
		if err := readMsg(rd, &a, maxControlFrame); err != nil {
			return acks, err
		}
		acks = append(acks, a)
	}
	return acks, nil
}

var errOffline = errors.New("собеседник не в сети")

func (n *Node) handleControl(s network.Stream) {
	defer s.Close()
	pid := s.Conn().RemotePeer()
	_ = s.SetDeadline(time.Now().Add(60 * time.Second))
	rd := bufio.NewReader(s)
	w := bufio.NewWriter(s)
	for i := 0; i < 64; i++ {
		var f Frame
		if err := readMsg(rd, &f, maxControlFrame); err != nil {
			if !errors.Is(err, io.EOF) {
				s.Reset()
			}
			return
		}
		ack := n.handleFrame(pid, s.Conn(), f)
		ack.ID = f.ID
		if err := writeMsg(w, ack, maxControlFrame); err != nil {
			s.Reset()
			return
		}
		if rd.Buffered() == 0 {
			if err := w.Flush(); err != nil {
				return
			}
		}
	}
	_ = w.Flush()
}

func (n *Node) handleFrame(pid peer.ID, conn network.Conn, f Frame) Ack {
	c, known := n.st.Contact(pid.String())
	if known && c.State == store.ContactBlocked {
		return Ack{Err: errNotContact}
	}
	accepted := known && c.State == store.ContactAccepted
	if accepted {
		if !n.rt(pid).limiter.Allow() {
			return Ack{Err: errRateLimit}
		}
	} else if !n.strangers.Allow() {
		return Ack{Err: errRateLimit}
	}
	switch f.T {
	case fWhois:
		n.noteStranger(pid, conn)
		return n.onWhois()
	case fPairReq:
		return n.onPairRequest(pid, conn, f)
	case fHello:
		return n.onHello(pid, f, accepted)
	case fPairOK:
		return n.onPairOK(pid, f)
	case fPairNo:
		return n.onPairNo(pid)
	}
	if !accepted {
		return Ack{Err: errNotContact}
	}
	switch f.T {
	case fMsg:
		return n.onChat(pid, f)
	case fRead:
		return n.onRead(pid, f)
	case fTyping:
		n.emit("typing", map[string]string{"peer": pid.String()})
		return Ack{OK: true}
	case fFileOffer:
		return n.onFileOffer(pid, f)
	case fFileDecline, fFileCancel, fFileStatus:
		return n.onFileRef(pid, f)
	case fCallInvite, fCallAccept, fCallReject, fCallEnd, fCallMode, fRTC, fCallPing:
		return n.onCallFrame(pid, f)
	}
	return Ack{Err: errUnknown}
}

// Presence ---------------------------------------------------------------

// Presence describes the live state of a contact.
type Presence struct {
	Online    bool   `json:"online"`
	Conn      string `json:"conn,omitempty"` // direct|relay|limited
	Transport string `json:"transport,omitempty"`
	LAN       bool   `json:"lan,omitempty"`
	RTT       int64  `json:"rtt,omitempty"`
}

func (n *Node) presence(pid peer.ID) Presence {
	n.mu.Lock()
	r := n.peers[pid]
	var p Presence
	if r != nil {
		p.Online = r.online
		p.RTT = r.rtt
	}
	n.mu.Unlock()
	if !p.Online {
		return p
	}
	p.Conn, p.Transport, p.LAN = n.connKind(pid)
	return p
}

func (n *Node) connKind(pid peer.ID) (kind, transport string, lan bool) {
	best := 0
	for _, c := range n.h.Network().ConnsToPeer(pid) {
		addr := c.RemoteMultiaddr()
		score, k := 1, "limited"
		relayed := isCircuit(addr)
		switch {
		case c.Stat().Limited:
			score, k = 1, "limited"
		case relayed:
			score, k = 2, "relay"
		default:
			score, k = 3, "direct"
		}
		if score > best {
			best, kind = score, k
			transport = transportOf(addr)
			lan = !relayed && isPrivateAddr(addr)
		}
	}
	return
}

func isCircuit(a ma.Multiaddr) bool {
	_, err := a.ValueForProtocol(ma.P_CIRCUIT)
	return err == nil
}

func transportOf(a ma.Multiaddr) string {
	s := a.String()
	switch {
	case strings.Contains(s, "/quic"):
		return "quic"
	case strings.Contains(s, "/tcp/"):
		return "tcp"
	}
	return ""
}

func isPrivateAddr(a ma.Multiaddr) bool {
	ip, err := manet.ToIP(a)
	if err != nil {
		return false
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()
}

func (n *Node) refreshPresence(pid peer.ID) {
	if c, ok := n.st.Contact(pid.String()); ok {
		n.emit("contact", n.contactView(c))
	}
}

func (n *Node) onConnected(pid peer.ID) {
	c, ok := n.st.Contact(pid.String())
	if !ok || c.State == store.ContactBlocked {
		return
	}
	// remember the working address for faster reconnects
	for _, conn := range n.h.Network().ConnsToPeer(pid) {
		if !isCircuit(conn.RemoteMultiaddr()) {
			addr := conn.RemoteMultiaddr().String()
			n.st.UpdateContact(pid.String(), func(c *store.Contact) {
				c.Addrs = mergeAddrs([]string{addr}, c.Addrs, 8)
			})
			break
		}
	}
	if c.State == store.ContactAccepted || c.State == store.ContactOutgoing {
		n.sayHello(pid, false)
	}
}

func (n *Node) onDisconnected(pid peer.ID) {
	n.mu.Lock()
	r := n.peers[pid]
	wasOnline := r != nil && r.online
	if r != nil {
		r.online = false
		r.helloAt = time.Time{}
		r.nextDial = time.Now().Add(3 * time.Second)
		r.backoff = 10 * time.Second
	}
	n.mu.Unlock()
	n.onPeerGoneForVoice(pid)
	if wasOnline {
		c, _ := n.st.UpdateContact(pid.String(), func(c *store.Contact) { c.LastSeen = time.Now().UnixMilli() })
		if c.PeerID != "" {
			n.emit("contact", n.contactView(c))
		}
	}
}

func (n *Node) setOnline(pid peer.ID) {
	n.mu.Lock()
	r := n.rtLocked(pid)
	was := r.online
	r.online = true
	r.helloAt = time.Now()
	r.backoff = 10 * time.Second
	n.mu.Unlock()
	if !was {
		c, _ := n.st.UpdateContact(pid.String(), func(c *store.Contact) { c.LastSeen = time.Now().UnixMilli() })
		n.emit("contact", n.contactView(c))
		go n.flushOutbox(pid)
	}
}

func (n *Node) helloPayload(contact bool) helloPayload {
	return helloPayload{
		Nick:    n.nick(),
		Ver:     version.Version,
		Relays:  n.ownRelayAddrs(),
		Caps:    []string{"files", "calls", "video", "bridge-opus"},
		Contact: contact,
	}
}

// sayHello announces ourselves to a contact (rate limited unless forced).
func (n *Node) sayHello(pid peer.ID, force bool) {
	n.mu.Lock()
	r := n.rtLocked(pid)
	if r.helloBusy || (!force && r.online && time.Since(r.helloAt) < 30*time.Second) {
		n.mu.Unlock()
		return
	}
	r.helloBusy = true
	n.mu.Unlock()
	defer func() {
		n.mu.Lock()
		r.helloBusy = false
		n.mu.Unlock()
	}()
	c, ok := n.st.Contact(pid.String())
	if !ok {
		return
	}
	f, _ := mkFrame(fHello, NewSecret(), time.Now().UnixMilli(), n.helloPayload(c.State == store.ContactAccepted))
	ack, err := n.sendTimeout(pid, 20*time.Second, f, false)
	if err != nil {
		if IsRemote(err, errNotContact) {
			switch c.State {
			case store.ContactOutgoing:
				go n.retryPendingPair(pid)
			case store.ContactAccepted:
				n.mu.Lock()
				r.helloAt = time.Now()
				n.mu.Unlock()
				n.emit("contact_rejected", map[string]string{"peer": pid.String()})
			}
		}
		return
	}
	var hp helloPayload
	if len(ack.D) > 0 && jsonUnmarshal(ack.D, &hp) == nil {
		n.applyHello(pid, hp)
	}
	if c.State == store.ContactOutgoing && hp.Contact {
		// they accepted us while we were offline
		c, _ = n.st.UpdateContact(pid.String(), func(c *store.Contact) { c.State = store.ContactAccepted })
		n.emit("contact", n.contactView(c))
	}
	if c.State == store.ContactAccepted {
		n.setOnline(pid)
	}
}

func (n *Node) onHello(pid peer.ID, f Frame, accepted bool) Ack {
	var hp helloPayload
	if err := jsonUnmarshal(f.D, &hp); err != nil {
		return Ack{Err: errBadFrame}
	}
	c, known := n.st.Contact(pid.String())
	if !known {
		return Ack{Err: errNotContact}
	}
	if c.State == store.ContactOutgoing && hp.Contact {
		c, _ = n.st.UpdateContact(pid.String(), func(c *store.Contact) { c.State = store.ContactAccepted })
		accepted = true
	}
	n.applyHello(pid, hp)
	if !accepted {
		return Ack{Err: errNotContact}
	}
	reply, _ := jsonMarshal(n.helloPayload(true))
	go n.setOnline(pid)
	return Ack{OK: true, D: reply}
}

func (n *Node) applyHello(pid peer.ID, hp helloPayload) {
	nick := cleanNick(hp.Nick)
	relays := sanitizeRelays(hp.Relays)
	c, ok := n.st.UpdateContact(pid.String(), func(c *store.Contact) {
		if nick != "" {
			c.Name = nick
		}
		c.Version = clampText(hp.Ver, 32)
		c.Relays = relays
	})
	if ok {
		n.rememberAddrs(pid, nil, relays)
		n.emit("contact", n.contactView(c))
	}
}

func (n *Node) nick() string {
	nick := cleanNick(n.st.Settings().Nickname)
	if nick == "" {
		nick = "Без имени"
	}
	return nick
}

// Dialing ----------------------------------------------------------------

func (n *Node) rememberAddrs(pid peer.ID, addrs, relays []string) {
	var out []ma.Multiaddr
	for _, s := range addrs {
		if a, err := ma.NewMultiaddr(s); err == nil {
			if _, last := ma.SplitLast(a); last != nil && last.Protocol().Code == ma.P_P2P {
				a, _ = ma.SplitLast(a)
			}
			out = append(out, a)
		}
	}
	out = append(out, n.circuitAddrsFor(pid, relays)...)
	if len(out) > 0 {
		n.h.Peerstore().AddAddrs(pid, out, 6*time.Hour)
	}
}

// circuitAddrsFor builds /p2p-circuit addresses for pid via our own relays
// and the relays announced by the peer.
func (n *Node) circuitAddrsFor(pid peer.ID, extra []string) []ma.Multiaddr {
	var out []ma.Multiaddr
	seen := map[string]bool{}
	for _, r := range append(n.configuredRelays(), extra...) {
		ai, err := peer.AddrInfoFromString(r)
		if err != nil || ai.ID == pid || ai.ID == n.h.ID() {
			continue
		}
		for _, a := range ai.Addrs {
			s := fmt.Sprintf("%s/p2p/%s/p2p-circuit", a, ai.ID)
			if seen[s] {
				continue
			}
			seen[s] = true
			if c, err := ma.NewMultiaddr(s); err == nil {
				out = append(out, c)
			}
		}
	}
	return out
}

func (n *Node) dialPeer(ctx context.Context, pid peer.ID) error {
	if c, ok := n.st.Contact(pid.String()); ok {
		n.rememberAddrs(pid, c.Addrs, c.Relays)
	} else {
		n.rememberAddrs(pid, nil, nil)
	}
	dctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	addrs := n.h.Peerstore().Addrs(pid)
	var err error
	if len(addrs) > 0 {
		err = n.h.Connect(dctx, peer.AddrInfo{ID: pid, Addrs: addrs})
		if err == nil {
			return nil
		}
	}
	if n.internet {
		if ai, ok := n.lookupPeer(ctx, pid); ok {
			n.h.Peerstore().AddAddrs(pid, ai.Addrs, time.Hour)
			cctx, cancel2 := context.WithTimeout(ctx, 20*time.Second)
			defer cancel2()
			if err2 := n.h.Connect(cctx, ai); err2 == nil {
				return nil
			} else {
				err = err2
			}
		}
	}
	if err == nil {
		err = errOffline
	}
	return fmt.Errorf("%w (%v)", errOffline, shortErr(err))
}

func shortErr(err error) string {
	s := err.Error()
	if len(s) > 160 {
		s = s[:160] + "…"
	}
	return s
}

// connectorLoop keeps contacts connected with exponential backoff.
func (n *Node) connectorLoop() {
	t := time.NewTicker(4 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
		}
		now := time.Now()
		for _, c := range n.st.Contacts() {
			if c.State != store.ContactAccepted && c.State != store.ContactOutgoing {
				continue
			}
			pid, err := peer.Decode(c.PeerID)
			if err != nil {
				continue
			}
			connected := n.h.Network().Connectedness(pid) == network.Connected
			n.mu.Lock()
			r := n.rtLocked(pid)
			if connected {
				needHello := !r.online && !r.helloBusy && now.After(r.nextDial)
				if needHello {
					r.nextDial = now.Add(r.backoff)
					r.backoff = minDur(r.backoff*2, 2*time.Minute)
				}
				n.mu.Unlock()
				if needHello {
					go n.sayHello(pid, true)
				}
				continue
			}
			if r.dialing || now.Before(r.nextDial) {
				n.mu.Unlock()
				continue
			}
			r.dialing = true
			r.nextDial = now.Add(r.backoff)
			r.backoff = minDur(r.backoff*2, 5*time.Minute)
			n.mu.Unlock()
			go func(pid peer.ID) {
				defer func() {
					n.mu.Lock()
					r.dialing = false
					n.mu.Unlock()
				}()
				ctx, cancel := context.WithTimeout(n.ctx, 60*time.Second)
				defer cancel()
				if err := n.dialPeer(ctx, pid); err == nil {
					n.sayHello(pid, true)
				}
			}(pid)
		}
	}
}

// ReconnectNow resets backoff for all contacts (e.g. after network change).
func (n *Node) ReconnectNow() {
	n.mu.Lock()
	for _, r := range n.peers {
		r.nextDial = time.Time{}
		r.backoff = 10 * time.Second
	}
	n.mu.Unlock()
}

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// presenceLoop measures RTT to online contacts.
func (n *Node) presenceLoop() {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
		}
		n.mu.Lock()
		var online []peer.ID
		for id, r := range n.peers {
			if r.online {
				online = append(online, id)
			}
		}
		n.mu.Unlock()
		for _, pid := range online {
			ctx, cancel := context.WithTimeout(n.ctx, 5*time.Second)
			res := <-n.pings.Ping(network.WithAllowLimitedConn(ctx, "ping"), pid)
			cancel()
			if res.Error == nil {
				n.mu.Lock()
				if r := n.peers[pid]; r != nil {
					r.rtt = res.RTT.Milliseconds()
					if r.rtt == 0 {
						r.rtt = 1
					}
				}
				n.mu.Unlock()
				n.refreshPresence(pid)
			}
		}
		n.updateNetStatus()
	}
}

func (n *Node) watchHostEvents() {
	sub, err := n.h.EventBus().Subscribe([]any{
		new(event.EvtLocalReachabilityChanged),
		new(event.EvtLocalAddressesUpdated),
		new(event.EvtNATDeviceTypeChanged),
	})
	if err != nil {
		return
	}
	defer sub.Close()
	for {
		select {
		case <-n.ctx.Done():
			return
		case e, ok := <-sub.Out():
			if !ok {
				return
			}
			switch ev := e.(type) {
			case event.EvtLocalReachabilityChanged:
				n.mu.Lock()
				switch ev.Reachability {
				case network.ReachabilityPublic:
					n.net.Reachability = "public"
				case network.ReachabilityPrivate:
					n.net.Reachability = "private"
				default:
					n.net.Reachability = "unknown"
				}
				n.mu.Unlock()
			case event.EvtNATDeviceTypeChanged:
				n.mu.Lock()
				if ev.NatDeviceType == network.NATDeviceTypeEndpointDependent {
					n.net.NAT = "symmetric"
				} else if ev.NatDeviceType == network.NATDeviceTypeEndpointIndependent {
					n.net.NAT = "cone"
				}
				n.mu.Unlock()
			case event.EvtLocalAddressesUpdated:
				n.ReconnectNow()
			}
			n.updateNetStatus()
		}
	}
}

func (n *Node) updateNetStatus() {
	var pub, local, relay []string
	for _, a := range n.h.Addrs() {
		s := a.String()
		switch {
		case isCircuit(a):
			relay = append(relay, s)
		case manet.IsPublicAddr(a):
			pub = append(pub, s)
		case !manet.IsIPLoopback(a):
			local = append(local, s)
		}
	}
	for _, s := range n.ownRelayAddrs() {
		relay = append(relay, s+"/p2p-circuit/p2p/"+n.h.ID().String())
	}
	sort.Strings(pub)
	sort.Strings(local)
	n.mu.Lock()
	n.net.PublicAddrs = dedupe(pub)
	n.net.LocalAddrs = dedupe(local)
	n.net.RelayAddrs = dedupe(relay)
	if n.kdht != nil {
		n.net.DHTPeers = n.kdht.RoutingTable().Size()
	}
	n.net.Connected = len(n.h.Network().Peers())
	st := n.net
	n.mu.Unlock()
	n.emit("net", st)
}

// Net returns the current network summary.
func (n *Node) Net() NetStatus {
	n.mu.Lock()
	defer n.mu.Unlock()
	st := n.net
	st.PublicAddrs = append([]string(nil), n.net.PublicAddrs...)
	st.LocalAddrs = append([]string(nil), n.net.LocalAddrs...)
	st.RelayAddrs = append([]string(nil), n.net.RelayAddrs...)
	return st
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func mergeAddrs(first, rest []string, limit int) []string {
	out := dedupe(append(append([]string(nil), first...), rest...))
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// pickP2PPort returns the preferred port if both TCP and UDP are free,
// otherwise the next free one (0 = let the OS choose).
func pickP2PPort(preferred int, loopback bool) int {
	if preferred <= 0 {
		return 0
	}
	host := "0.0.0.0"
	if loopback {
		host = "127.0.0.1"
	}
	for p := preferred; p < preferred+40 && p < 65535; p++ {
		tl, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, p))
		if err != nil {
			continue
		}
		ul, err := net.ListenPacket("udp", fmt.Sprintf("%s:%d", host, p))
		tl.Close()
		if err != nil {
			continue
		}
		ul.Close()
		return p
	}
	return 0
}
