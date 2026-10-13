package p2p

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/client"
	"github.com/libp2p/go-libp2p/p2p/protocol/ping"
	"github.com/multiformats/go-multiaddr"

	"zvonochek2/internal/connection"
)

// Optional public libp2p bootstrap nodes (only used if explicitly enabled via -enable-public-bootstrap)
var DefaultBootstrapRelays = []string{
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
	"/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
}

// EventType defines notifications emitted to the UI/websocket
type EventType string

const (
	EventStateSnapshot     EventType = "state_snapshot"
	EventPeerConnected     EventType = "peer_connected"
	EventPeerDisconnected  EventType = "peer_disconnected"
	EventPeerAuthenticated EventType = "peer_authenticated"
	EventLANPeerFound      EventType = "lan_peer_found"
	EventMessageReceived   EventType = "message_received"
	EventSignalReceived    EventType = "signal_received"
	EventSignalAckReceived EventType = "signal_ack_received"
	EventRouteSwitchReq    EventType = "route_switch_req"
	EventRouteSwitchAck    EventType = "route_switch_ack"
	EventBridgeTelemetry   EventType = "bridge_telemetry"
	EventFileOfferReceived EventType = "file_offer_received"
	EventFileReceived      EventType = "file_received"
	EventFileProgress      EventType = "file_progress"
	EventCallReceived      EventType = "call_received"
	EventCallAccepted      EventType = "call_accepted"
	EventCallRejected      EventType = "call_rejected"
	EventCallEnded         EventType = "call_ended"
	EventRouteUpdated      EventType = "route_updated"
)

// Event is dispatched to the local web frontend
type Event struct {
	Type      EventType   `json:"type"`
	PeerID    string      `json:"peer_id,omitempty"`
	Data      interface{} `json:"data,omitempty"`
	Timestamp int64       `json:"timestamp"`
}

// NodeConfig holds configuration for starting the libp2p host
type NodeConfig struct {
	ListenPort            int
	RelayAddr             string
	EnableRelayServer     bool
	EnablePublicBootstrap bool
	ProfileName           string
	DownloadsDir          string
	IdentityKeyPath       string
	Nickname              string
	MaxFileSizeBytes      int64
}

type pendingFileOffer struct {
	TransferID string
	FilePath   string
	FileName   string
	FileSize   int64
	Checksum   string
	TargetPeer peer.ID
}

// P2PNode coordinates libp2p host, Connection Manager, streams, and framed voice bridge
type P2PNode struct {
	Host      host.Host
	Config    NodeConfig
	ConnMgr   *connection.Manager
	Events    chan Event
	VoiceInCh chan []byte // Decoded raw PCM payload for browser playback
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.RWMutex

	controlPipes map[peer.ID]network.Stream
	voiceOutCh   map[peer.ID]chan *VoiceFrame

	// Voice Bridge Telemetry Counters (Stage 4)
	voiceSeqOut        atomic.Uint32
	lastVoiceSeqIn     atomic.Uint32
	framesSent         atomic.Uint64
	framesReceived     atomic.Uint64
	framesDroppedStale atomic.Uint64
	seqGaps            atomic.Uint64
	stallResets        atomic.Uint64
	lastFrameAgeMs     atomic.Int64
	queueDurationMs    atomic.Int64

	// Security & Invites
	currentInviteSecret string
	inviteExpiresAt     int64
	trustedPeers        map[peer.ID]bool
	peerNicknames       map[peer.ID]string
	peerVersions        map[peer.ID]string
	lanPeers            map[peer.ID]peer.AddrInfo
	reservedRelayAddrs  []string
	relayConnected      bool
	relayExpiresAt      time.Time

	// File Consent & Backpressure
	outgoingFiles map[string]*pendingFileOffer
	approvedFiles map[string]FileOfferPayload
	callActive    atomic.Bool

	// Ping service for RTT
	pingService *ping.PingService
	peerRTTMs   map[peer.ID]int64
}

// NewP2PNode initializes a libp2p host with persistent profile identity, IPv4/IPv6, AutoNAT, DCUtR, and Connection Manager
func NewP2PNode(cfg NodeConfig) (*P2PNode, error) {
	ctx, cancel := context.WithCancel(context.Background())

	if cfg.IdentityKeyPath == "" {
		cfg.IdentityKeyPath = ProfileIdentityPath(cfg.ProfileName)
	}
	privKey, err := LoadOrCreateIdentity(cfg.IdentityKeyPath)
	if err != nil {
		cancel()
		return nil, err
	}

	if cfg.MaxFileSizeBytes <= 0 {
		cfg.MaxFileSizeBytes = 2 * 1024 * 1024 * 1024 // 2 GB default limit
	}

	listenAddrs := []string{
		fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", cfg.ListenPort),
		fmt.Sprintf("/ip4/0.0.0.0/udp/%d/quic-v1", cfg.ListenPort),
		fmt.Sprintf("/ip6/::/tcp/%d", cfg.ListenPort),
		fmt.Sprintf("/ip6/::/udp/%d/quic-v1", cfg.ListenPort),
	}

	opts := []libp2p.Option{
		libp2p.Identity(privKey),
		libp2p.ListenAddrStrings(listenAddrs...),
		libp2p.EnableNATService(),
		libp2p.EnableHolePunching(),
		libp2p.EnableRelay(),
	}

	// Rule 5: Never enable public relay service on user PC unless explicitly requested
	if cfg.EnableRelayServer {
		opts = append(opts, libp2p.EnableRelayService())
	}

	h, err := libp2p.New(opts...)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create libp2p host: %w", err)
	}

	if cfg.DownloadsDir == "" {
		cfg.DownloadsDir = "downloads"
	}
	_ = os.MkdirAll(cfg.DownloadsDir, 0755)

	node := &P2PNode{
		Host:                h,
		Config:              cfg,
		Events:              make(chan Event, 256),
		VoiceInCh:           make(chan []byte, 4), // Strictly bounded (~256ms max)
		ctx:                 ctx,
		cancel:              cancel,
		controlPipes:        make(map[peer.ID]network.Stream),
		voiceOutCh:          make(map[peer.ID]chan *VoiceFrame),
		currentInviteSecret: GenerateRandomSecret(16),
		inviteExpiresAt:     time.Now().Add(24 * time.Hour).Unix(),
		trustedPeers:        make(map[peer.ID]bool),
		peerNicknames:       make(map[peer.ID]string),
		peerVersions:        make(map[peer.ID]string),
		lanPeers:            make(map[peer.ID]peer.AddrInfo),
		outgoingFiles:       make(map[string]*pendingFileOffer),
		approvedFiles:       make(map[string]FileOfferPayload),
		pingService:         ping.NewPingService(h),
		peerRTTMs:           make(map[peer.ID]int64),
	}

	node.ConnMgr = connection.NewManager(AppVersion, func(snap connection.Snapshot) {
		node.dispatch(Event{
			Type:      EventStateSnapshot,
			PeerID:    snap.PeerID,
			Data:      snap,
			Timestamp: time.Now().UnixMilli(),
		})
	})

	// Register stream handlers
	h.SetStreamHandler(ControlProtocolID, node.handleControlStream)
	h.SetStreamHandler(FileProtocolID, node.handleFileStream)
	h.SetStreamHandler(VoiceProtocolID, node.handleVoiceStream)

	// Start mDNS and VM NAT beacon
	if err := startMDNS(h, node); err != nil {
		log.Printf("[mDNS] Warning: could not start LAN mDNS: %v", err)
	}

	// Rule 5: Only connect to public bootstrap nodes if explicitly permitted
	if cfg.EnablePublicBootstrap {
		go node.bootstrapNetwork()
	}

	// Only use explicitly configured relay server
	if cfg.RelayAddr != "" {
		go node.maintainRelayReservation(cfg.RelayAddr)
	}

	go node.monitorRoutesLoop()
	go node.bridgeTelemetryLoop()

	h.Network().Notify(&network.NotifyBundle{
		ConnectedF: func(net network.Network, conn network.Conn) {
			pID := conn.RemotePeer()
			addrStr := conn.RemoteMultiaddr().String()
			if strings.Contains(addrStr, "/ip4/127.0.0.1/") || isPrivateLANAddr(addrStr) {
				node.recordLANPeer(peer.AddrInfo{ID: pID, Addrs: []multiaddr.Multiaddr{conn.RemoteMultiaddr()}})
			}
			isRelay := strings.Contains(addrStr, "/p2p-circuit")
			ctrlRoute := connection.ControlDirect
			routeType := "direct"
			if isRelay {
				ctrlRoute = connection.ControlCircuitRelay
				routeType = "circuit-relay"
			}
			node.ConnMgr.OnPeerDiscovered(pID.String())
			node.ConnMgr.UpdateControlRoute(ctrlRoute, addrStr, -1)

			log.Printf("[P2P] Connected to peer %s via %s (%s)", pID.ShortString(), routeType, addrStr)
			node.dispatch(Event{
				Type:   EventPeerConnected,
				PeerID: pID.String(),
				Data: map[string]interface{}{
					"remote_addr":     addrStr,
					"route_type":      routeType,
					"network_subtype": connection.ClassifyMultiaddrSubtype(addrStr),
					"safety_code":     ShortSafetyCode(node.Host.ID().String(), pID.String()),
				},
				Timestamp: time.Now().UnixMilli(),
			})
		},
		DisconnectedF: func(net network.Network, conn network.Conn) {
			pID := conn.RemotePeer()
			if len(net.ConnsToPeer(pID)) > 0 {
				return
			}
			node.mu.Lock()
			delete(node.controlPipes, pID)
			if ch, ok := node.voiceOutCh[pID]; ok {
				close(ch)
				delete(node.voiceOutCh, pID)
			}
			node.mu.Unlock()

			node.ConnMgr.UpdateControlRoute(connection.ControlUnavailable, "", -1)
			node.ConnMgr.RecordFailure("Служебное соединение libp2p разорвано", false)

			node.dispatch(Event{
				Type:      EventPeerDisconnected,
				PeerID:    pID.String(),
				Timestamp: time.Now().UnixMilli(),
			})
		},
	})

	return node, nil
}

func (n *P2PNode) dispatch(ev Event) {
	select {
	case n.Events <- ev:
	default:
	}
}

func (n *P2PNode) recordLANPeer(pi peer.AddrInfo) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.lanPeers[pi.ID] = pi
	n.trustedPeers[pi.ID] = true
}

func (n *P2PNode) bootstrapNetwork() {
	for _, addrStr := range DefaultBootstrapRelays {
		ma, err := multiaddr.NewMultiaddr(addrStr)
		if err != nil {
			continue
		}
		info, err := peer.AddrInfoFromP2pAddr(ma)
		if err != nil {
			continue
		}
		go func(pi peer.AddrInfo) {
			ctx, cancel := context.WithTimeout(n.ctx, 10*time.Second)
			defer cancel()
			if err := n.Host.Connect(ctx, pi); err == nil {
				log.Printf("[Bootstrap] Connected to public node %s for WAN address discovery", pi.ID)
			}
		}(*info)
	}
}

func (n *P2PNode) maintainRelayReservation(relayMultiaddr string) {
	ma, err := multiaddr.NewMultiaddr(relayMultiaddr)
	if err != nil {
		log.Printf("[Relay] Invalid multiaddr %q: %v", relayMultiaddr, err)
		return
	}
	info, err := peer.AddrInfoFromP2pAddr(ma)
	if err != nil {
		log.Printf("[Relay] Failed to parse relay AddrInfo: %v", err)
		return
	}

	for {
		select {
		case <-n.ctx.Done():
			return
		default:
		}

		ctx, cancel := context.WithTimeout(n.ctx, 15*time.Second)
		err := n.Host.Connect(ctx, *info)
		cancel()
		if err != nil {
			n.mu.Lock()
			n.relayConnected = false
			n.mu.Unlock()
			n.ConnMgr.RecordFailure(fmt.Sprintf("Отказ подключения к Circuit Relay: %v", err), false)
			time.Sleep(15 * time.Second)
			continue
		}

		rsvp, err := client.Reserve(n.ctx, n.Host, *info)
		if err != nil {
			n.mu.Lock()
			n.relayConnected = false
			n.mu.Unlock()
			n.ConnMgr.RecordFailure(fmt.Sprintf("Отказ резервирования слота Circuit Relay: %v", err), false)
			time.Sleep(20 * time.Second)
			continue
		}

		var circuitAddrs []string
		for _, a := range info.Addrs {
			full := fmt.Sprintf("%s/p2p/%s/p2p-circuit/p2p/%s", a.String(), info.ID.String(), n.Host.ID().String())
			circuitAddrs = append(circuitAddrs, full)
		}

		n.mu.Lock()
		n.reservedRelayAddrs = circuitAddrs
		n.relayConnected = true
		n.relayExpiresAt = rsvp.Expiration
		n.mu.Unlock()

		log.Printf("[Relay] Reserved Circuit Relay v2 slot until %v", rsvp.Expiration)

		waitDur := time.Until(rsvp.Expiration) * 7 / 10
		if waitDur < 30*time.Second {
			waitDur = 30 * time.Second
		}
		select {
		case <-n.ctx.Done():
			return
		case <-time.After(waitDur):
		}
	}
}

// GenerateInvite creates a zv2:// invite code containing non-loopback addresses
func (n *P2PNode) GenerateInvite(refreshSecret bool) (string, *InviteBundle, error) {
	n.mu.Lock()
	if refreshSecret || time.Now().Unix() > n.inviteExpiresAt {
		n.currentInviteSecret = GenerateRandomSecret(16)
		n.inviteExpiresAt = time.Now().Add(24 * time.Hour).Unix()
	}
	secret := n.currentInviteSecret
	exp := n.inviteExpiresAt
	relayAddrs := append([]string(nil), n.reservedRelayAddrs...)
	n.mu.Unlock()

	prefIface := n.ConnMgr.GetSnapshot().PreferredInterface
	var prefIP string
	if prefIface != "" {
		for _, iface := range connection.ListNetworkInterfaces() {
			if iface.Name == prefIface && len(iface.Addrs) > 0 {
				prefIP = iface.Addrs[0]
				break
			}
		}
	}

	var rawAddrs []string
	for _, a := range n.Host.Addrs() {
		rawAddrs = append(rawAddrs, fmt.Sprintf("%s/p2p/%s", a.String(), n.Host.ID().String()))
	}
	rawAddrs = append(rawAddrs, relayAddrs...)

	ranked := FilterAndRankAddrs(rawAddrs, prefIP)
	bundle := InviteBundle{
		Version:   2,
		PeerID:    n.Host.ID().String(),
		Addrs:     ranked,
		Secret:    secret,
		Nickname:  n.Config.Nickname,
		ExpiresAt: exp,
	}

	code, err := EncodeInvite(bundle)
	return code, &bundle, err
}

// ConnectViaInvite connects to a peer using a zv2:// invite bundle with bounded per-address timeouts
func (n *P2PNode) ConnectViaInvite(inviteStr string) (string, error) {
	bundle, err := DecodeInvite(inviteStr)
	if err != nil {
		return "", err
	}

	targetPID, err := peer.Decode(bundle.PeerID)
	if err != nil {
		return "", fmt.Errorf("invalid peer ID: %w", err)
	}
	if targetPID == n.Host.ID() {
		return "", errors.New("вы вставили собственное приглашение этого же узла (dial to self). Для теста на одном ПК запустите второй экземпляр с флагом -profile user2")
	}

	n.ConnMgr.OnPeerDiscovered(targetPID.String())

	var mAddrs []multiaddr.Multiaddr
	for _, aStr := range bundle.Addrs {
		parts := strings.Split(aStr, "/p2p/"+bundle.PeerID)
		base := parts[0]
		if ma, err := multiaddr.NewMultiaddr(base); err == nil {
			mAddrs = append(mAddrs, ma)
		}
	}

	n.mu.RLock()
	if lanInfo, ok := n.lanPeers[targetPID]; ok {
		mAddrs = append(mAddrs, lanInfo.Addrs...)
	}
	n.mu.RUnlock()

	if len(mAddrs) == 0 && len(n.Host.Network().ConnsToPeer(targetPID)) == 0 {
		return "", errors.New("в приглашении нет доступных сетевых адресов")
	}

	n.mu.Lock()
	n.trustedPeers[targetPID] = true
	if bundle.Nickname != "" {
		n.peerNicknames[targetPID] = bundle.Nickname
	}
	n.mu.Unlock()

	if len(n.Host.Network().ConnsToPeer(targetPID)) == 0 {
		if gwMa, err := multiaddr.NewMultiaddr(fmt.Sprintf("/ip4/10.0.2.2/tcp/%d", n.Config.ListenPort)); err == nil {
			mAddrs = append(mAddrs, gwMa)
		}
		ctx, cancel := context.WithTimeout(n.ctx, 18*time.Second)
		defer cancel()

		addrInfo := peer.AddrInfo{ID: targetPID, Addrs: mAddrs}
		if err := n.Host.Connect(ctx, addrInfo); err != nil {
			n.ConnMgr.RecordFailure(fmt.Sprintf("Ошибка подключения к пиру: %v", err), false)
			return "", fmt.Errorf("не удалось установить соединение с узлом %s: %w", targetPID.ShortString(), err)
		}
	}

	if err := n.initiateHandshake(targetPID, bundle.Secret); err != nil {
		return "", err
	}

	return targetPID.String(), nil
}

// ConnectPeer dials a peer by raw Multiaddr or zv2:// invite
func (n *P2PNode) ConnectPeer(addrStr string) (string, error) {
	addrStr = strings.TrimSpace(addrStr)
	if strings.HasPrefix(addrStr, "zv2://") {
		return n.ConnectViaInvite(addrStr)
	}

	ma, err := multiaddr.NewMultiaddr(addrStr)
	if err != nil {
		return "", fmt.Errorf("некорректный Multiaddr: %w", err)
	}

	info, err := peer.AddrInfoFromP2pAddr(ma)
	if err != nil {
		return "", fmt.Errorf("не удалось извлечь PeerID из адреса: %w", err)
	}
	if info.ID == n.Host.ID() {
		return "", errors.New("вы пытаетесь подключиться к собственному PeerID (dial to self)")
	}

	n.ConnMgr.OnPeerDiscovered(info.ID.String())

	n.mu.Lock()
	n.trustedPeers[info.ID] = true
	n.mu.Unlock()

	if len(n.Host.Network().ConnsToPeer(info.ID)) == 0 {
		ctx, cancel := context.WithTimeout(n.ctx, 15*time.Second)
		defer cancel()
		if err := n.Host.Connect(ctx, *info); err != nil {
			n.ConnMgr.RecordFailure(fmt.Sprintf("Ошибка прямого набора Multiaddr: %v", err), false)
			return "", fmt.Errorf("не удалось подключиться к %s: %w", info.ID.ShortString(), err)
		}
	}

	if err := n.initiateHandshake(info.ID, ""); err != nil {
		return "", err
	}

	return info.ID.String(), nil
}

func (n *P2PNode) initiateHandshake(targetPID peer.ID, secret string) error {
	stream, err := n.Host.NewStream(n.ctx, targetPID, ControlProtocolID)
	if err != nil {
		return fmt.Errorf("ошибка открытия управляющего потока: %w", err)
	}

	n.mu.Lock()
	n.controlPipes[targetPID] = stream
	n.mu.Unlock()

	go n.readControlStream(stream, targetPID)

	return WriteControlMessage(stream, &ControlMessage{
		Type:         TypeHandshake,
		Version:      AppVersion,
		MsgID:        uuid.NewString(),
		SenderID:     n.Host.ID().String(),
		Nickname:     n.Config.Nickname,
		InviteSecret: secret,
		Timestamp:    time.Now().UnixMilli(),
	})
}

func (n *P2PNode) handleControlStream(s network.Stream) {
	remotePID := s.Conn().RemotePeer()
	n.mu.Lock()
	n.controlPipes[remotePID] = s
	n.mu.Unlock()
	go n.readControlStream(s, remotePID)
}

func (n *P2PNode) isPeerAuthorized(pID peer.ID, providedSecret string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.trustedPeers[pID] {
		return true
	}
	if providedSecret != "" && providedSecret == n.currentInviteSecret && time.Now().Unix() <= n.inviteExpiresAt {
		n.trustedPeers[pID] = true
		return true
	}
	return false
}

func (n *P2PNode) readControlStream(s network.Stream, remotePID peer.ID) {
	defer s.Close()
	dec := json.NewDecoder(s)
	seenMsgIDs := make(map[string]bool)

	for {
		msg, err := ReadControlMessage(dec)
		if err != nil {
			if err != io.EOF {
				log.Printf("[Control] Stream closed from %s: %v", remotePID.ShortString(), err)
			}
			return
		}

		if msg.MsgID != "" {
			if seenMsgIDs[msg.MsgID] {
				continue
			}
			seenMsgIDs[msg.MsgID] = true
		}

		if msg.Type == TypeHandshake {
			if !n.isPeerAuthorized(remotePID, msg.InviteSecret) {
				log.Printf("[Security] Rejected unauthorized handshake from %s", remotePID)
				_ = WriteControlMessage(s, &ControlMessage{
					Type:      TypeAuthReject,
					Version:   AppVersion,
					SenderID:  n.Host.ID().String(),
					Timestamp: time.Now().UnixMilli(),
				})
				return
			}
			remoteVer := msg.Version
			if remoteVer == "" {
				remoteVer = "unknown"
			}
			n.mu.Lock()
			if msg.Nickname != "" {
				n.peerNicknames[remotePID] = msg.Nickname
			}
			n.peerVersions[remotePID] = remoteVer
			n.mu.Unlock()

			n.ConnMgr.OnPeerAuthenticated(remotePID.String(), remoteVer)

			_ = WriteControlMessage(s, &ControlMessage{
				Type:      TypeAuthOK,
				Version:   AppVersion,
				SenderID:  n.Host.ID().String(),
				Nickname:  n.Config.Nickname,
				Timestamp: time.Now().UnixMilli(),
			})

			n.dispatch(Event{
				Type:   EventPeerAuthenticated,
				PeerID: remotePID.String(),
				Data: map[string]interface{}{
					"nickname":       msg.Nickname,
					"remote_version": remoteVer,
					"local_version":  AppVersion,
					"safety_code":    ShortSafetyCode(n.Host.ID().String(), remotePID.String()),
				},
				Timestamp: time.Now().UnixMilli(),
			})
			continue
		}

		if msg.Type == TypeAuthOK {
			remoteVer := msg.Version
			if remoteVer == "" {
				remoteVer = "unknown"
			}
			n.mu.Lock()
			n.trustedPeers[remotePID] = true
			if msg.Nickname != "" {
				n.peerNicknames[remotePID] = msg.Nickname
			}
			n.peerVersions[remotePID] = remoteVer
			n.mu.Unlock()

			n.ConnMgr.OnPeerAuthenticated(remotePID.String(), remoteVer)

			n.dispatch(Event{
				Type:   EventPeerAuthenticated,
				PeerID: remotePID.String(),
				Data: map[string]interface{}{
					"nickname":       msg.Nickname,
					"remote_version": remoteVer,
					"local_version":  AppVersion,
					"safety_code":    ShortSafetyCode(n.Host.ID().String(), remotePID.String()),
				},
				Timestamp: time.Now().UnixMilli(),
			})
			continue
		}

		if !n.isPeerAuthorized(remotePID, "") {
			continue
		}

		switch msg.Type {
		case TypeChat:
			var chat ChatPayload
			_ = json.Unmarshal(msg.Payload, &chat)
			n.dispatch(Event{
				Type:      EventMessageReceived,
				PeerID:    remotePID.String(),
				Data:      map[string]interface{}{"text": chat.Text, "sender": msg.Nickname},
				Timestamp: msg.Timestamp,
			})

		case TypeSignal:
			var sig SignalPayload
			_ = json.Unmarshal(msg.Payload, &sig)
			if sig.Type == "offer" || sig.Type == "answer" {
				_ = n.sendOverControlStream(remotePID, &ControlMessage{
					Type:      TypeSignalAck,
					MsgID:     uuid.NewString(),
					CallID:    sig.CallID,
					AttemptID: sig.AttemptID,
					Seq:       sig.Seq,
					SenderID:  n.Host.ID().String(),
					Timestamp: time.Now().UnixMilli(),
				})
			}
			n.dispatch(Event{
				Type:      EventSignalReceived,
				PeerID:    remotePID.String(),
				Data:      sig,
				Timestamp: msg.Timestamp,
			})

		case TypeSignalAck:
			n.dispatch(Event{
				Type:   EventSignalAckReceived,
				PeerID: remotePID.String(),
				Data: map[string]interface{}{
					"call_id":    msg.CallID,
					"attempt_id": msg.AttemptID,
					"seq":        msg.Seq,
				},
				Timestamp: msg.Timestamp,
			})

		case TypeRouteSwitch:
			var rs RouteSwitchPayload
			if err := json.Unmarshal(msg.Payload, &rs); err == nil {
				n.ConnMgr.SwitchMediaRoute(rs.CallID, rs.AttemptID, connection.MediaRoute(rs.MediaRoute), connection.NetworkSubtype(rs.Subtype), rs.Reason, true)
				_ = n.sendOverControlStream(remotePID, &ControlMessage{
					Type:      TypeRouteSwitchAck,
					MsgID:     uuid.NewString(),
					CallID:    rs.CallID,
					AttemptID: rs.AttemptID,
					Payload:   msg.Payload,
					SenderID:  n.Host.ID().String(),
					Timestamp: time.Now().UnixMilli(),
				})
				n.dispatch(Event{
					Type:      EventRouteSwitchReq,
					PeerID:    remotePID.String(),
					Data:      rs,
					Timestamp: msg.Timestamp,
				})
			}

		case TypeRouteSwitchAck:
			var rs RouteSwitchPayload
			if err := json.Unmarshal(msg.Payload, &rs); err == nil {
				n.dispatch(Event{
					Type:      EventRouteSwitchAck,
					PeerID:    remotePID.String(),
					Data:      rs,
					Timestamp: msg.Timestamp,
				})
			}

		case TypeCallOffer:
			var offer CallOfferPayload
			_ = json.Unmarshal(msg.Payload, &offer)
			n.dispatch(Event{
				Type:   EventCallReceived,
				PeerID: remotePID.String(),
				Data: map[string]interface{}{
					"call_id":    offer.CallID,
					"attempt_id": offer.AttemptID,
					"voice_mode": offer.VoiceMode,
					"has_video":  offer.HasVideo,
					"nickname":   offer.Nickname,
					"version":    offer.Version,
					"local_wins_glare": n.ConnMgr.ResolveGlare(n.Host.ID().String(), remotePID.String()),
				},
				Timestamp: msg.Timestamp,
			})

		case TypeCallAccept:
			n.callActive.Store(true)
			n.ConnMgr.BeginCallAttempt(n.ctx, msg.CallID, msg.AttemptID, "Собеседник принял вызов")
			n.dispatch(Event{
				Type:   EventCallAccepted,
				PeerID: remotePID.String(),
				Data: map[string]interface{}{
					"call_id":    msg.CallID,
					"attempt_id": msg.AttemptID,
				},
				Timestamp: msg.Timestamp,
			})

		case TypeCallReject:
			n.callActive.Store(false)
			n.ConnMgr.EndCall("Вызов отклонен собеседником")
			n.dispatch(Event{
				Type:   EventCallRejected,
				PeerID: remotePID.String(),
				Data: map[string]interface{}{
					"call_id": msg.CallID,
				},
				Timestamp: msg.Timestamp,
			})

		case TypeCallEnd:
			n.callActive.Store(false)
			n.ConnMgr.EndCall("Собеседник завершил звонок")
			n.dispatch(Event{
				Type:   EventCallEnded,
				PeerID: remotePID.String(),
				Data: map[string]interface{}{
					"call_id": msg.CallID,
				},
				Timestamp: msg.Timestamp,
			})

		case TypeFileOffer:
			var offer FileOfferPayload
			if err := json.Unmarshal(msg.Payload, &offer); err == nil {
				n.dispatch(Event{
					Type:      EventFileOfferReceived,
					PeerID:    remotePID.String(),
					Data:      offer,
					Timestamp: msg.Timestamp,
				})
			}

		case TypeFileAccept:
			var decPayload FileDecisionPayload
			if err := json.Unmarshal(msg.Payload, &decPayload); err == nil && decPayload.Accepted {
				go n.streamApprovedOutgoingFile(decPayload.TransferID)
			}

		case TypeFileReject:
			var decPayload FileDecisionPayload
			if err := json.Unmarshal(msg.Payload, &decPayload); err == nil {
				n.mu.Lock()
				delete(n.outgoingFiles, decPayload.TransferID)
				n.mu.Unlock()
			}
		}
	}
}

// SendMessage sends an authenticated chat message
func (n *P2PNode) SendMessage(peerIDStr string, text string) error {
	pID, err := peer.Decode(peerIDStr)
	if err != nil {
		return fmt.Errorf("invalid peer id: %w", err)
	}

	payloadBytes, _ := json.Marshal(ChatPayload{Text: text})
	msg := &ControlMessage{
		Type:      TypeChat,
		Version:   AppVersion,
		MsgID:     uuid.NewString(),
		SenderID:  n.Host.ID().String(),
		Nickname:  n.Config.Nickname,
		Payload:   payloadBytes,
		Timestamp: time.Now().UnixMilli(),
	}

	return n.sendOverControlStream(pID, msg)
}

// SendSignal sends deterministic WebRTC signaling data
func (n *P2PNode) SendSignal(peerIDStr string, sig SignalPayload) error {
	pID, err := peer.Decode(peerIDStr)
	if err != nil {
		return fmt.Errorf("invalid peer id: %w", err)
	}

	payloadBytes, _ := json.Marshal(sig)
	msg := &ControlMessage{
		Type:      TypeSignal,
		Version:   AppVersion,
		MsgID:     uuid.NewString(),
		CallID:    sig.CallID,
		AttemptID: sig.AttemptID,
		Seq:       sig.Seq,
		SenderID:  n.Host.ID().String(),
		Payload:   payloadBytes,
		Timestamp: time.Now().UnixMilli(),
	}

	return n.sendOverControlStream(pID, msg)
}

// SendRouteSwitch coordinates a media route switch with the remote peer
func (n *P2PNode) SendRouteSwitch(peerIDStr string, rs RouteSwitchPayload, force bool) error {
	pID, err := peer.Decode(peerIDStr)
	if err != nil {
		return err
	}
	if !n.ConnMgr.SwitchMediaRoute(rs.CallID, rs.AttemptID, connection.MediaRoute(rs.MediaRoute), connection.NetworkSubtype(rs.Subtype), rs.Reason, force) {
		return nil // Blocked by anti-flapping cooldown
	}
	payloadBytes, _ := json.Marshal(rs)
	msg := &ControlMessage{
		Type:      TypeRouteSwitch,
		Version:   AppVersion,
		MsgID:     uuid.NewString(),
		CallID:    rs.CallID,
		AttemptID: rs.AttemptID,
		SenderID:  n.Host.ID().String(),
		Payload:   payloadBytes,
		Timestamp: time.Now().UnixMilli(),
	}
	return n.sendOverControlStream(pID, msg)
}

// SendCallAction sends deterministic call control commands
func (n *P2PNode) SendCallAction(peerIDStr string, action MessageType, callID, attemptID, voiceMode string, hasVideo bool) error {
	pID, err := peer.Decode(peerIDStr)
	if err != nil {
		return fmt.Errorf("invalid peer id: %w", err)
	}

	switch action {
	case TypeCallOffer:
		n.ConnMgr.BeginCallAttempt(n.ctx, callID, attemptID, "Инициализация вызова")
	case TypeCallAccept:
		n.callActive.Store(true)
		n.ConnMgr.BeginCallAttempt(n.ctx, callID, attemptID, "Вызов принят")
	case TypeCallEnd, TypeCallReject:
		n.callActive.Store(false)
		n.ConnMgr.EndCall("Вызов завершен пользователем")
	}

	var payloadBytes []byte
	if action == TypeCallOffer {
		payloadBytes, _ = json.Marshal(CallOfferPayload{
			CallID:    callID,
			AttemptID: attemptID,
			VoiceMode: voiceMode,
			HasVideo:  hasVideo,
			Nickname:  n.Config.Nickname,
			Version:   AppVersion,
		})
	}

	msg := &ControlMessage{
		Type:      action,
		Version:   AppVersion,
		MsgID:     uuid.NewString(),
		CallID:    callID,
		AttemptID: attemptID,
		SenderID:  n.Host.ID().String(),
		Nickname:  n.Config.Nickname,
		Payload:   payloadBytes,
		Timestamp: time.Now().UnixMilli(),
	}
	return n.sendOverControlStream(pID, msg)
}

func (n *P2PNode) sendOverControlStream(pID peer.ID, msg *ControlMessage) error {
	n.mu.RLock()
	stream, ok := n.controlPipes[pID]
	n.mu.RUnlock()

	var err error
	if !ok || stream == nil {
		stream, err = n.Host.NewStream(n.ctx, pID, ControlProtocolID)
		if err != nil {
			return fmt.Errorf("failed to open control stream to %s: %w", pID, err)
		}
		n.mu.Lock()
		n.controlPipes[pID] = stream
		n.mu.Unlock()
		go n.readControlStream(stream, pID)
	}

	return WriteControlMessage(stream, msg)
}

// ============================================================================
// STAGE 4: FRAMED GO LIBP2P VOICE BRIDGE (Seq, Timestamps, Stale Drop, Telemetry)
// Note: Runs over libp2p stream (/zvonochek/voice/2.1.0). Because underlying TCP/QUIC
// streams are reliable, packet loss causes L4 head-of-line blocking until retransmission.
// To mitigate latency accumulation, we bound queues to 3 frames (~192ms), drop expired
// frames before write and before playback, and reset hung streams after 600ms write timeout.
// ============================================================================

const (
	maxVoiceQueueFrames = 3   // 3 * 64ms = 192ms max audio queue
	maxFrameStaleAgeMs  = 180 // Drop frames queued longer than 180ms
	defaultFrameDurMs   = 64  // 1024 samples @ 16kHz = 64ms
)

// SendVoiceFrame numbers, timestamps, and queues an audio frame with strict duration bounds
func (n *P2PNode) SendVoiceFrame(peerIDStr string, payload []byte) error {
	pID, err := peer.Decode(peerIDStr)
	if err != nil || len(payload) == 0 || len(payload) > 16384 {
		return err
	}

	nowMs := time.Now().UnixMilli()
	seq := n.voiceSeqOut.Add(1)
	vf := &VoiceFrame{
		Seq:        seq,
		SentAtMs:   nowMs,
		DurationMs: defaultFrameDurMs,
		Payload:    payload,
		EnqueuedAt: nowMs,
	}

	n.mu.Lock()
	ch, ok := n.voiceOutCh[pID]
	if !ok {
		ch = make(chan *VoiceFrame, maxVoiceQueueFrames)
		n.voiceOutCh[pID] = ch
		go n.voiceStreamWriterLoop(pID, ch)
	}
	n.mu.Unlock()

	select {
	case ch <- vf:
	default:
		// Queue exceeded 192ms audio duration: drop oldest frame and record metric
		select {
		case <-ch:
			n.framesDroppedStale.Add(1)
		default:
		}
		select {
		case ch <- vf:
		default:
		}
	}
	n.queueDurationMs.Store(int64(len(ch)) * defaultFrameDurMs)
	return nil
}

func (n *P2PNode) voiceStreamWriterLoop(pID peer.ID, ch chan *VoiceFrame) {
	var stream network.Stream
	defer func() {
		if stream != nil {
			_ = stream.Close()
		}
	}()

	for vf := range ch {
		nowMs := time.Now().UnixMilli()
		// Drop frame before sending if it waited in queue longer than maxFrameStaleAgeMs
		if nowMs-vf.EnqueuedAt > maxFrameStaleAgeMs {
			n.framesDroppedStale.Add(1)
			continue
		}

		if stream == nil {
			var err error
			stream, err = n.Host.NewStream(n.ctx, pID, VoiceProtocolID)
			if err != nil {
				time.Sleep(100 * time.Millisecond)
				continue
			}
		}

		// Strict 600ms write deadline to detect hung/stalled reliable stream
		_ = stream.SetWriteDeadline(time.Now().Add(600 * time.Millisecond))
		if err := WriteVoiceFrame(stream, vf); err != nil {
			_ = stream.Reset()
			stream = nil
			n.stallResets.Add(1)
			continue
		}
		n.framesSent.Add(1)
		n.queueDurationMs.Store(int64(len(ch)) * defaultFrameDurMs)
	}
}

func (n *P2PNode) handleVoiceStream(s network.Stream) {
	defer s.Close()
	remotePID := s.Conn().RemotePeer()
	if !n.isPeerAuthorized(remotePID, "") {
		return
	}

	for {
		vf, err := ReadVoiceFrame(s)
		if err != nil {
			return
		}
		n.framesReceived.Add(1)

		// Detect sequence gaps
		prevSeq := n.lastVoiceSeqIn.Swap(vf.Seq)
		if prevSeq > 0 && vf.Seq > prevSeq+1 {
			n.seqGaps.Add(uint64(vf.Seq - prevSeq - 1))
		}

		nowMs := time.Now().UnixMilli()
		ageMs := nowMs - vf.SentAtMs
		if ageMs >= 0 && ageMs < 10000 {
			n.lastFrameAgeMs.Store(ageMs)
		}

		// If local playback queue is full (>256ms), drop oldest frame before enqueueing
		select {
		case n.VoiceInCh <- vf.Payload:
		default:
			select {
			case <-n.VoiceInCh:
				n.framesDroppedStale.Add(1)
			default:
			}
			select {
			case n.VoiceInCh <- vf.Payload:
			default:
			}
		}
	}
}

// GetBridgeTelemetry returns dedicated Go Audio Bridge metrics
func (n *P2PNode) GetBridgeTelemetry() BridgeTelemetry {
	snap := n.ConnMgr.GetSnapshot()
	return BridgeTelemetry{
		Active:             snap.MediaRoute == connection.MediaGoBridge,
		FramesSent:         n.framesSent.Load(),
		FramesReceived:     n.framesReceived.Load(),
		FramesDroppedStale: n.framesDroppedStale.Load(),
		SeqGaps:            n.seqGaps.Load(),
		QueueDurationMs:    n.queueDurationMs.Load(),
		LastFrameAgeMs:     n.lastFrameAgeMs.Load(),
		StallResets:        n.stallResets.Load(),
	}
}

func (n *P2PNode) bridgeTelemetryLoop() {
	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			bt := n.GetBridgeTelemetry()
			if bt.Active || bt.FramesSent > 0 || bt.FramesReceived > 0 {
				n.dispatch(Event{
					Type:      EventBridgeTelemetry,
					Data:      bt,
					Timestamp: time.Now().UnixMilli(),
				})
			}
		}
	}
}

// ============================================================================
// SECURE FILE TRANSFER (Consent, Sanitization, .part Temp File, Rate Limiting)
// ============================================================================

func (n *P2PNode) OfferFile(peerIDStr string, filePath string) (string, error) {
	pID, err := peer.Decode(peerIDStr)
	if err != nil {
		return "", fmt.Errorf("invalid peer id: %w", err)
	}

	file, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("cannot open file: %w", err)
	}
	defer file.Close()

	fi, err := file.Stat()
	if err != nil {
		return "", err
	}

	if fi.Size() > n.Config.MaxFileSizeBytes {
		return "", fmt.Errorf("размер файла превышает допустимый лимит (%d МБ)", n.Config.MaxFileSizeBytes/(1024*1024))
	}

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	checksum := hex.EncodeToString(hasher.Sum(nil))

	transferID := uuid.NewString()
	cleanName := sanitizeFileName(filepath.Base(filePath))

	offer := FileOfferPayload{
		TransferID: transferID,
		FileName:   cleanName,
		FileSize:   fi.Size(),
		Checksum:   checksum,
	}

	n.mu.Lock()
	n.outgoingFiles[transferID] = &pendingFileOffer{
		TransferID: transferID,
		FilePath:   filePath,
		FileName:   cleanName,
		FileSize:   fi.Size(),
		Checksum:   checksum,
		TargetPeer: pID,
	}
	n.mu.Unlock()

	payloadBytes, _ := json.Marshal(offer)
	err = n.sendOverControlStream(pID, &ControlMessage{
		Type:      TypeFileOffer,
		Version:   AppVersion,
		MsgID:     uuid.NewString(),
		SenderID:  n.Host.ID().String(),
		Nickname:  n.Config.Nickname,
		Payload:   payloadBytes,
		Timestamp: time.Now().UnixMilli(),
	})
	return transferID, err
}

func (n *P2PNode) RespondToFileOffer(peerIDStr string, offer FileOfferPayload, accept bool) error {
	pID, err := peer.Decode(peerIDStr)
	if err != nil {
		return err
	}

	msgType := TypeFileReject
	if accept {
		msgType = TypeFileAccept
		n.mu.Lock()
		n.approvedFiles[offer.TransferID] = offer
		n.mu.Unlock()
	}

	payloadBytes, _ := json.Marshal(FileDecisionPayload{
		TransferID: offer.TransferID,
		Accepted:   accept,
	})

	return n.sendOverControlStream(pID, &ControlMessage{
		Type:      msgType,
		Version:   AppVersion,
		MsgID:     uuid.NewString(),
		SenderID:  n.Host.ID().String(),
		Payload:   payloadBytes,
		Timestamp: time.Now().UnixMilli(),
	})
}

func (n *P2PNode) streamApprovedOutgoingFile(transferID string) {
	n.mu.RLock()
	pending, ok := n.outgoingFiles[transferID]
	n.mu.RUnlock()
	if !ok {
		return
	}

	file, err := os.Open(pending.FilePath)
	if err != nil {
		return
	}
	defer file.Close()

	stream, err := n.Host.NewStream(n.ctx, pending.TargetPeer, FileProtocolID)
	if err != nil {
		return
	}
	defer stream.Close()

	header := FileHeader{
		TransferID: pending.TransferID,
		FileName:   pending.FileName,
		FileSize:   pending.FileSize,
		Checksum:   pending.Checksum,
	}

	if err := json.NewEncoder(stream).Encode(header); err != nil {
		return
	}

	buf := make([]byte, 32*1024)
	var totalSent int64
	for {
		nr, readErr := file.Read(buf)
		if nr > 0 {
			if n.callActive.Load() {
				time.Sleep(120 * time.Millisecond)
			}
			nw, writeErr := stream.Write(buf[:nr])
			if writeErr != nil {
				return
			}
			totalSent += int64(nw)
			n.dispatch(Event{
				Type: EventFileProgress,
				Data: map[string]interface{}{
					"transfer_id": pending.TransferID,
					"direction":   "outgoing",
					"sent_bytes":  totalSent,
					"total_bytes": pending.FileSize,
					"file_name":   pending.FileName,
					"throttled":   n.callActive.Load(),
				},
				Timestamp: time.Now().UnixMilli(),
			})
		}
		if readErr != nil {
			break
		}
	}
}

func (n *P2PNode) handleFileStream(s network.Stream) {
	defer s.Close()
	remotePID := s.Conn().RemotePeer()
	if !n.isPeerAuthorized(remotePID, "") {
		return
	}

	var header FileHeader
	if err := json.NewDecoder(s).Decode(&header); err != nil {
		return
	}

	n.mu.Lock()
	approved, ok := n.approvedFiles[header.TransferID]
	if ok {
		delete(n.approvedFiles, header.TransferID)
	}
	n.mu.Unlock()

	if !ok || header.FileSize > n.Config.MaxFileSizeBytes {
		return
	}

	safeName := sanitizeFileName(approved.FileName)
	finalPath := uniqueFilePath(filepath.Join(n.Config.DownloadsDir, safeName))
	tempPath := finalPath + ".part"

	out, err := os.OpenFile(tempPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return
	}

	hasher := sha256.New()
	w := io.MultiWriter(out, hasher)

	buf := make([]byte, 32*1024)
	var totalRecv int64
	for totalRecv < approved.FileSize {
		nr, readErr := s.Read(buf)
		if nr > 0 {
			nw, writeErr := w.Write(buf[:nr])
			if writeErr != nil {
				out.Close()
				_ = os.Remove(tempPath)
				return
			}
			totalRecv += int64(nw)
			if totalRecv > n.Config.MaxFileSizeBytes {
				out.Close()
				_ = os.Remove(tempPath)
				return
			}
			n.dispatch(Event{
				Type: EventFileProgress,
				Data: map[string]interface{}{
					"transfer_id": header.TransferID,
					"direction":   "incoming",
					"recv_bytes":  totalRecv,
					"total_bytes": approved.FileSize,
					"file_name":   safeName,
				},
				Timestamp: time.Now().UnixMilli(),
			})
		}
		if readErr != nil {
			break
		}
	}
	out.Close()

	calculatedHash := hex.EncodeToString(hasher.Sum(nil))
	if approved.Checksum != "" && calculatedHash != approved.Checksum {
		_ = os.Remove(tempPath)
		return
	}

	if err := os.Rename(tempPath, finalPath); err != nil {
		return
	}

	n.dispatch(Event{
		Type:   EventFileReceived,
		PeerID: remotePID.String(),
		Data: map[string]interface{}{
			"transfer_id": header.TransferID,
			"file_name":   filepath.Base(finalPath),
			"file_size":   totalRecv,
			"path":        finalPath,
			"sha256_ok":   true,
		},
		Timestamp: time.Now().UnixMilli(),
	})
}

func sanitizeFileName(name string) string {
	name = filepath.Base(name)
	name = strings.ReplaceAll(name, "..", "")
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	if name == "" || name == "." || name == "_" {
		name = "received_file.bin"
	}
	return name
}

func uniqueFilePath(basePath string) string {
	if _, err := os.Stat(basePath); os.IsNotExist(err) {
		return basePath
	}
	ext := filepath.Ext(basePath)
	nameWithoutExt := strings.TrimSuffix(basePath, ext)
	for i := 1; i < 1000; i++ {
		candidate := fmt.Sprintf("%s_(%d)%s", nameWithoutExt, i, ext)
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return fmt.Sprintf("%s_%d%s", nameWithoutExt, time.Now().Unix(), ext)
}

func (n *P2PNode) monitorRoutesLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			for _, pID := range n.Host.Network().Peers() {
				n.mu.RLock()
				_, isCtrl := n.controlPipes[pID]
				n.mu.RUnlock()
				if !isCtrl {
					continue
				}

				conns := n.Host.Network().ConnsToPeer(pID)
				ctrlRoute := connection.ControlDirect
				routeType := "direct"
				remoteAddr := ""
				for _, c := range conns {
					ra := c.RemoteMultiaddr().String()
					remoteAddr = ra
					if strings.Contains(ra, "/p2p-circuit") {
						ctrlRoute = connection.ControlCircuitRelay
						routeType = "circuit-relay"
					} else {
						ctrlRoute = connection.ControlDirect
						routeType = "direct"
						break
					}
				}

				pingCtx, cancel := context.WithTimeout(n.ctx, 2*time.Second)
				resCh := n.pingService.Ping(pingCtx, pID)
				var rttMs int64 = -1
				select {
				case res := <-resCh:
					if res.Error == nil {
						rttMs = res.RTT.Milliseconds()
						n.mu.Lock()
						n.peerRTTMs[pID] = rttMs
						n.mu.Unlock()
					}
				case <-pingCtx.Done():
				}
				cancel()

				n.ConnMgr.UpdateControlRoute(ctrlRoute, remoteAddr, rttMs)

				n.dispatch(Event{
					Type:   EventRouteUpdated,
					PeerID: pID.String(),
					Data: map[string]interface{}{
						"route_type":      routeType,
						"network_subtype": connection.ClassifyMultiaddrSubtype(remoteAddr),
						"remote_addr":     remoteAddr,
						"rtt_ms":          rttMs,
						"safety_code":     ShortSafetyCode(n.Host.ID().String(), pID.String()),
					},
					Timestamp: time.Now().UnixMilli(),
				})
			}
		}
	}
}

// GetStatus returns separate channel diagnostics, connection manager snapshot, and invite code
func (n *P2PNode) GetStatus() map[string]interface{} {
	inviteCode, bundle, _ := n.GenerateInvite(false)

	var lanList []map[string]interface{}
	n.mu.RLock()
	for id, pi := range n.lanPeers {
		var addrs []string
		for _, a := range pi.Addrs {
			addrs = append(addrs, fmt.Sprintf("%s/p2p/%s", a.String(), id.String()))
		}
		lanList = append(lanList, map[string]interface{}{
			"peer_id": id.String(),
			"addrs":   addrs,
		})
	}
	relayConn := n.relayConnected
	relayAddrs := append([]string(nil), n.reservedRelayAddrs...)
	n.mu.RUnlock()

	var connectedPeers []string
	for _, p := range n.Host.Network().Peers() {
		n.mu.RLock()
		_, hasCtrl := n.controlPipes[p]
		n.mu.RUnlock()
		if hasCtrl {
			connectedPeers = append(connectedPeers, p.String())
		}
	}

	return map[string]interface{}{
		"peer_id":            n.Host.ID().String(),
		"profile":            n.Config.ProfileName,
		"nickname":           n.Config.Nickname,
		"local_version":      AppVersion,
		"invite_code":        inviteCode,
		"listen_addrs":       bundle.Addrs,
		"relay_connected":    relayConn,
		"relay_addrs":        relayAddrs,
		"lan_peers":          lanList,
		"connected_peers":    connectedPeers,
		"peer_count":         len(connectedPeers),
		"connection_state":   n.ConnMgr.GetSnapshot(),
		"bridge_telemetry":   n.GetBridgeTelemetry(),
		"network_interfaces": connection.ListNetworkInterfaces(),
	}
}

// Close gracefully stops the host and releases resources
func (n *P2PNode) Close() error {
	n.ConnMgr.EndCall("Остановка демона")
	n.cancel()
	return n.Host.Close()
}
