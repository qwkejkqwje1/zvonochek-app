package p2p

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"time"

	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/discovery/mdns"
	"github.com/multiformats/go-multiaddr"
)

const vmBeaconPort = 4009

type mdnsNotifee struct {
	node *P2PNode
}

type beaconInfo struct {
	PeerID     string `json:"peer_id"`
	ListenPort int    `json:"listen_port"`
}

// HandlePeerFound is invoked automatically by mDNS when a Zvonochek node is detected on LAN
func (m *mdnsNotifee) HandlePeerFound(pi peer.AddrInfo) {
	if pi.ID == m.node.Host.ID() {
		return
	}

	var addrs []string
	for _, a := range pi.Addrs {
		addrs = append(addrs, a.String()+"/p2p/"+pi.ID.String())
	}

	log.Printf("[mDNS] Discovered LAN peer: %s (%d addrs)", pi.ID.String(), len(addrs))
	m.node.recordLANPeer(pi)

	m.node.dispatch(Event{
		Type:   EventLANPeerFound,
		PeerID: pi.ID.String(),
		Data: map[string]interface{}{
			"peer_id": pi.ID.String(),
			"addrs":   addrs,
		},
		Timestamp: time.Now().UnixMilli(),
	})
}

// startMDNS initializes zero-configuration local network discovery AND VirtualBox/VM NAT discovery
func startMDNS(h host.Host, node *P2PNode) error {
	// Start VirtualBox / VM NAT helper beacon so Guest (10.0.2.15) <-> Host (10.0.2.2) auto-connects
	go startVMBeaconServer(node)
	go probeVMHostGatewaysLoop(node)

	s := mdns.NewMdnsService(h, MDNSServiceTag, &mdnsNotifee{node: node})
	return s.Start()
}

// startVMBeaconServer listens on TCP port 4009 so a VirtualBox/VMware Guest in NAT mode
// can query the Host PC at 10.0.2.2:4009 and establish a bidirectional libp2p tunnel.
func startVMBeaconServer(node *P2PNode) {
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", vmBeaconPort))
	if err != nil {
		return
	}
	defer ln.Close()

	go func() {
		<-node.ctx.Done()
		ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-node.ctx.Done():
				return
			default:
				continue
			}
		}
		go func(c net.Conn) {
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(3 * time.Second))
			_ = json.NewEncoder(c).Encode(beaconInfo{
				PeerID:     node.Host.ID().String(),
				ListenPort: node.Config.ListenPort,
			})
		}(conn)
	}
}

// probeVMHostGatewaysLoop runs inside a VM (e.g. VirtualBox 10.0.2.15) and probes
// standard hypervisor Host gateways (10.0.2.2 for VirtualBox, 192.168.56.1, etc.).
// When it finds the Host PC, the VM opens an outbound libp2p connection to 10.0.2.2:<port>,
// which makes the connection available in BOTH directions (Host->VM and VM->Host)!
func probeVMHostGatewaysLoop(node *P2PNode) {
	gateways := []string{
		"10.0.2.2",     // VirtualBox NAT Host Gateway (for 10.0.2.15 guests)
		"192.168.56.1", // VirtualBox Host-Only Adapter
	}

	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()

	for {
		for _, gw := range gateways {
			probeSingleGateway(node, gw)
		}
		select {
		case <-node.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func probeSingleGateway(node *P2PNode, gwIP string) {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", gwIP, vmBeaconPort), 800*time.Millisecond)
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))

	var info beaconInfo
	if err := json.NewDecoder(conn).Decode(&info); err != nil {
		return
	}

	pID, err := peer.Decode(info.PeerID)
	if err != nil || pID == node.Host.ID() {
		return
	}

	// Already connected to Host PC?
	if len(node.Host.Network().ConnsToPeer(pID)) > 0 {
		return
	}

	maStr := fmt.Sprintf("/ip4/%s/tcp/%d", gwIP, info.ListenPort)
	ma, err := multiaddr.NewMultiaddr(maStr)
	if err != nil {
		return
	}

	pi := peer.AddrInfo{ID: pID, Addrs: []multiaddr.Multiaddr{ma}}
	node.recordLANPeer(pi)

	ctx, cancel := context.WithTimeout(node.ctx, 5*time.Second)
	defer cancel()

	// VM dials Host PC outbound so VirtualBox NAT opens a bidirectional multiplexed connection!
	if err := node.Host.Connect(ctx, pi); err == nil {
		log.Printf("[VM-NAT Bridge] Установлен обратный туннель из ВМ к Основному ПК (%s/p2p/%s)", maStr, pID.ShortString())
		node.dispatch(Event{
			Type:   EventLANPeerFound,
			PeerID: pID.String(),
			Data: map[string]interface{}{
				"peer_id": pID.String(),
				"addrs":   []string{fmt.Sprintf("%s/p2p/%s", maStr, pID.String())},
			},
			Timestamp: time.Now().UnixMilli(),
		})
	}
}
