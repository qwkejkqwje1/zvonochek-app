package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	"zvonochek2/internal/p2p"
)

func main() {
	port := flag.Int("port", 4002, "Public TCP/QUIC port for Circuit Relay v2")
	keyPath := flag.String("key", "relay_identity.key", "Persistent key for Relay PeerID")
	flag.Parse()

	privKey, err := p2p.LoadOrCreateIdentity(*keyPath)
	if err != nil {
		log.Fatalf("Failed to load relay identity: %v", err)
	}

	// Custom Relay limits generous enough for P2P voice bridge + signaling
	rc := relay.DefaultResources()
	rc.MaxReservations = 256
	rc.MaxCircuits = 64
	rc.BufferSize = 64 * 1024
	rc.Limit = &relay.RelayLimit{
		Duration: 2 * time.Hour,
		Data:     512 * 1024 * 1024, // 512 MB per circuit reservation
	}

	h, err := libp2p.New(
		libp2p.Identity(privKey),
		libp2p.ListenAddrStrings(
			fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", *port),
			fmt.Sprintf("/ip4/0.0.0.0/udp/%d/quic-v1", *port),
		),
		libp2p.EnableRelayService(relay.WithResources(rc)),
		libp2p.EnableNATService(),
		libp2p.ForceReachabilityPublic(),
	)
	if err != nil {
		log.Fatalf("Failed to start relay host: %v", err)
	}
	defer h.Close()

	log.Println("========================================================")
	log.Println("       🌐 Звоночек 2.1 — Выделенный Relay-сервер        ")
	log.Println("========================================================")
	log.Printf("Relay Peer ID: %s\n", h.ID().String())
	for _, addr := range h.Addrs() {
		log.Printf("Адрес ретранслятора: %s/p2p/%s\n", addr.String(), h.ID().String())
	}
	log.Println("--------------------------------------------------------")
	log.Printf("Запустите клиент Звоночка с флагом:\n")
	log.Printf("  zvonochek.exe -relay \"/ip4/<ПУБЛИЧНЫЙ_IP_СЕРВЕРА>/udp/%d/quic-v1/p2p/%s\"\n", *port, h.ID().String())
	log.Println("========================================================")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh
}
