package node

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net"
	"sort"
	"time"

	dht "github.com/libp2p/go-libp2p-kad-dht"
	"github.com/libp2p/go-libp2p/core/discovery"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/discovery/mdns"
	dutil "github.com/libp2p/go-libp2p/p2p/discovery/util"
	ma "github.com/multiformats/go-multiaddr"

	"zvonochek2/internal/store"
)

// DefaultBeaconPort is the TCP port of the VirtualBox/VM helper beacon.
const DefaultBeaconPort = 47329

type nearbyPeer struct {
	ID    peer.ID
	Nick  string
	Addrs []ma.Multiaddr
	Seen  time.Time
	Via   string
	query bool
}

// NearbyView is shown in the "Рядом" section.
type NearbyView struct {
	PeerID string `json:"peer_id"`
	Nick   string `json:"nick"`
	Via    string `json:"via"`
	Seen   int64  `json:"seen"`
}

// Nearby lists LAN peers that are not contacts yet.
func (n *Node) Nearby() []NearbyView {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := []NearbyView{}
	for id, p := range n.nearby {
		if time.Since(p.Seen) > 3*time.Minute && n.h.Network().Connectedness(id) != network.Connected {
			delete(n.nearby, id)
			continue
		}
		out = append(out, NearbyView{PeerID: id.String(), Nick: p.Nick, Via: p.Via, Seen: p.Seen.UnixMilli()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PeerID < out[j].PeerID })
	return out
}

type mdnsNotifee struct{ n *Node }

func (m mdnsNotifee) HandlePeerFound(ai peer.AddrInfo) { m.n.lanPeerFound(ai, "mdns") }

func (n *Node) startLAN() {
	svc := mdns.NewMdnsService(n.h, MDNSService, mdnsNotifee{n})
	if err := svc.Start(); err != nil {
		log.Printf("[lan] mDNS unavailable: %v", err)
	} else {
		go func() { <-n.ctx.Done(); _ = svc.Close() }()
	}
	port := n.opt.BeaconPort
	if port == 0 {
		port = DefaultBeaconPort
	}
	n.goLoop(func() { n.beaconServer(port) })
	n.goLoop(func() { n.beaconProber(port) })
	n.goLoop(n.nearbyJanitor)
}

func (n *Node) lanPeerFound(ai peer.AddrInfo, via string) {
	if ai.ID == n.h.ID() || ai.ID == "" {
		return
	}
	n.h.Peerstore().AddAddrs(ai.ID, ai.Addrs, 10*time.Minute)
	c, known := n.st.Contact(ai.ID.String())
	if known {
		if c.State == store.ContactBlocked {
			return
		}
		n.mu.Lock()
		if r := n.peers[ai.ID]; r != nil && !r.online {
			r.nextDial = time.Time{}
			r.backoff = 10 * time.Second
		}
		n.mu.Unlock()
		return
	}
	n.mu.Lock()
	p, ok := n.nearby[ai.ID]
	if !ok {
		p = &nearbyPeer{ID: ai.ID, Via: via}
		n.nearby[ai.ID] = p
	}
	p.Seen = time.Now()
	p.Addrs = ai.Addrs
	needQuery := p.Nick == "" && !p.query
	if needQuery {
		p.query = true
	}
	n.mu.Unlock()
	if !ok {
		n.emit("nearby", n.Nearby())
	}
	if needQuery {
		go n.whois(ai)
	}
}

func (n *Node) whois(ai peer.AddrInfo) {
	defer func() {
		n.mu.Lock()
		if p := n.nearby[ai.ID]; p != nil {
			p.query = false
		}
		n.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(n.ctx, 15*time.Second)
	defer cancel()
	if err := n.h.Connect(ctx, ai); err != nil {
		return
	}
	f, _ := mkFrame(fWhois, NewSecret(), time.Now().UnixMilli(), nil)
	ack, err := n.send(ctx, ai.ID, f, true)
	if err != nil {
		return
	}
	var info struct{ Nick string }
	if json.Unmarshal(ack.D, &info) != nil {
		return
	}
	n.mu.Lock()
	if p := n.nearby[ai.ID]; p != nil {
		p.Nick = cleanNick(info.Nick)
	}
	n.mu.Unlock()
	n.emit("nearby", n.Nearby())
}

// noteStranger records a LAN peer that contacted us first (e.g. a VM guest
// behind NAT that we cannot reach ourselves).
func (n *Node) noteStranger(pid peer.ID, conn network.Conn) {
	if !n.lan || conn == nil || isCircuit(conn.RemoteMultiaddr()) || !isPrivateAddr(conn.RemoteMultiaddr()) {
		return
	}
	if _, known := n.st.Contact(pid.String()); known {
		return
	}
	n.lanPeerFound(peer.AddrInfo{ID: pid, Addrs: []ma.Multiaddr{conn.RemoteMultiaddr()}}, "lan")
}

func (n *Node) nearbyJanitor() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
			before := len(n.Nearby())
			_ = before
			n.emit("nearby", n.Nearby())
		}
	}
}

// PairNearby sends a contact request to a LAN peer.
func (n *Node) PairNearby(ctx context.Context, id string) (ContactView, error) {
	return n.AddContact(ctx, id)
}

// VM beacon: VirtualBox NAT guests cannot be reached by the host, and
// multicast (mDNS) does not cross the NAT. The guest asks the host gateway
// (10.0.2.2) on a fixed TCP port for its peer id and dials it instead.

type beaconInfo struct {
	PeerID string `json:"peer_id"`
	Port   int    `json:"port"`
}

func (n *Node) beaconServer(port int) {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return // another instance owns it; not critical
	}
	go func() { <-n.ctx.Done(); ln.Close() }()
	for {
		c, err := ln.Accept()
		if err != nil {
			if n.ctx.Err() != nil {
				return
			}
			time.Sleep(200 * time.Millisecond)
			continue
		}
		go func(c net.Conn) {
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(3 * time.Second))
			_ = json.NewEncoder(c).Encode(beaconInfo{PeerID: n.h.ID().String(), Port: n.p2pPort})
		}(c)
	}
}

func vmGateways() []string {
	var out []string
	ifaces, _ := net.InterfaceAddrs()
	for _, a := range ifaces {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.To4() == nil {
			continue
		}
		ip := ipn.IP.To4()
		switch {
		case ip[0] == 10 && ip[1] == 0 && ip[2] == 2: // VirtualBox NAT
			out = append(out, "10.0.2.2")
		case ip[0] == 192 && ip[1] == 168 && ip[2] == 56: // VirtualBox host-only
			out = append(out, "192.168.56.1")
		}
	}
	return dedupe(out)
}

func (n *Node) beaconProber(port int) {
	for {
		for _, gw := range vmGateways() {
			n.probeGateway(gw, port)
		}
		select {
		case <-n.ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

func (n *Node) probeGateway(gw string, port int) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", gw, port), time.Second)
	if err != nil {
		return
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	var info beaconInfo
	if err := json.NewDecoder(c).Decode(&info); err != nil || info.Port <= 0 || info.Port > 65535 {
		return
	}
	pid, err := peer.Decode(info.PeerID)
	if err != nil || pid == n.h.ID() {
		return
	}
	var addrs []ma.Multiaddr
	for _, s := range []string{fmt.Sprintf("/ip4/%s/tcp/%d", gw, info.Port), fmt.Sprintf("/ip4/%s/udp/%d/quic-v1", gw, info.Port)} {
		if a, err := ma.NewMultiaddr(s); err == nil {
			addrs = append(addrs, a)
		}
	}
	n.lanPeerFound(peer.AddrInfo{ID: pid, Addrs: addrs}, "vm")
}

// Internet discovery --------------------------------------------------------

func peerNS(pid peer.ID) string { return dhtNSPrefix + pid.String() }

func (n *Node) internetLoop() {
	if n.kdht == nil {
		return
	}
	boot := dht.GetDefaultBootstrapPeerAddrInfos()
	connectBoot := func() int {
		ok := 0
		done := make(chan bool, len(boot))
		for _, ai := range boot {
			go func(ai peer.AddrInfo) {
				ctx, cancel := context.WithTimeout(n.ctx, 15*time.Second)
				defer cancel()
				done <- n.h.Connect(ctx, ai) == nil
			}(ai)
		}
		for range boot {
			if <-done {
				ok++
			}
		}
		return ok
	}
	for attempt := 0; n.ctx.Err() == nil; attempt++ {
		if connectBoot() > 0 {
			break
		}
		select {
		case <-n.ctx.Done():
			return
		case <-time.After(time.Duration(min(attempt+1, 6)) * 10 * time.Second):
		}
	}
	_ = n.kdht.Bootstrap(n.ctx)
	n.updateNetStatus()
	// wait until the routing table has some peers before advertising
	for i := 0; i < 30 && n.kdht.RoutingTable().Size() < 5 && n.ctx.Err() == nil; i++ {
		time.Sleep(2 * time.Second)
	}
	n.updateNetStatus()
	if n.disc != nil {
		go dutil.Advertise(n.ctx, n.disc, peerNS(n.h.ID()), discovery.TTL(3*time.Hour))
	}
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
			if n.kdht.RoutingTable().Size() == 0 {
				connectBoot()
				_ = n.kdht.Bootstrap(n.ctx)
			}
			n.updateNetStatus()
		}
	}
}

// lookupPeer asks the DHT for a contact's current addresses.
func (n *Node) lookupPeer(ctx context.Context, pid peer.ID) (peer.AddrInfo, bool) {
	if n.kdht == nil {
		return peer.AddrInfo{}, false
	}
	fctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	ai, err := n.kdht.FindPeer(fctx, pid)
	cancel()
	if err == nil && len(ai.Addrs) > 0 {
		return ai, true
	}
	if n.disc == nil {
		return peer.AddrInfo{}, false
	}
	pctx, cancel2 := context.WithTimeout(ctx, 25*time.Second)
	defer cancel2()
	ch, err := n.disc.FindPeers(pctx, peerNS(pid), discovery.Limit(5))
	if err != nil {
		return peer.AddrInfo{}, false
	}
	for p := range ch {
		if p.ID == pid && len(p.Addrs) > 0 {
			return p, true
		}
	}
	return peer.AddrInfo{}, false
}

// relayCandidates feeds AutoRelay with public peers that may offer relay v2.
func (n *Node) relayCandidates(ctx context.Context, num int) <-chan peer.AddrInfo {
	ch := make(chan peer.AddrInfo, num)
	go func() {
		defer close(ch)
		var ids []peer.ID
		ids = append(ids, n.h.Network().Peers()...)
		if n.kdht != nil {
			ids = append(ids, n.kdht.RoutingTable().ListPeers()...)
		}
		rand.Shuffle(len(ids), func(i, j int) { ids[i], ids[j] = ids[j], ids[i] })
		seen := map[peer.ID]bool{}
		sent := 0
		for _, id := range ids {
			if sent >= num || seen[id] {
				continue
			}
			seen[id] = true
			if _, isContact := n.st.Contact(id.String()); isContact {
				continue
			}
			addrs := n.h.Peerstore().Addrs(id)
			if len(addrs) == 0 {
				continue
			}
			select {
			case ch <- peer.AddrInfo{ID: id, Addrs: addrs}:
				sent++
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch
}
