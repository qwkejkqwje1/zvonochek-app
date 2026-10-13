package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"zvonochek2/internal/p2p"
	"zvonochek2/internal/server"
	"zvonochek2/web"
)

func openBrowser(url string) {
	var cmd string
	var args []string

	switch runtime.GOOS {
	case "windows":
		cmd = "rundll32"
		args = []string{"url.dll,FileProtocolHandler", url}
	case "darwin":
		cmd = "open"
		args = []string{url}
	default:
		cmd = "xdg-open"
		args = []string{url}
	}
	_ = exec.Command(cmd, args...).Start()
}

func findAvailablePort(host string, preferredPort int) int {
	for p := preferredPort; p < preferredPort+50; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, p))
		if err == nil {
			_ = ln.Close()
			return p
		}
	}
	return preferredPort
}

func main() {
	port := flag.Int("port", 8080, "Local HTTP server port (bound strictly to 127.0.0.1)")
	p2pPort := flag.Int("p2p-port", 4001, "libp2p listen port for TCP and QUIC")
	profile := flag.String("profile", "default", "Profile name for persistent PeerID (independent of port)")
	relayAddr := flag.String("relay", "", "Multiaddress of explicitly permitted Circuit Relay v2 node")
	enableRelayServer := flag.Bool("enable-relay-server", false, "Explicitly allow this node to act as a Circuit Relay v2 server")
	enablePublicBootstrap := flag.Bool("enable-public-bootstrap", false, "Explicitly permit connecting to public IPFS bootstrap nodes for WAN IP Identify")
	nickname := flag.String("nick", "User", "Display nickname")
	keyPath := flag.String("key", "", "Custom path to persistent Ed25519 identity key")
	noBrowser := flag.Bool("no-browser", false, "Disable automatic browser launch on startup")
	flag.Parse()

	// Remove legacy identity.key in working directory if present
	if _, err := os.Stat("identity.key"); err == nil && *keyPath == "" {
		_ = os.Remove("identity.key")
	}

	actualHTTPPort := findAvailablePort("127.0.0.1", *port)
	actualP2PPort := *p2pPort
	activeProfile := *profile

	if actualHTTPPort != *port {
		offset := actualHTTPPort - *port
		actualP2PPort = findAvailablePort("0.0.0.0", *p2pPort+offset)
		if activeProfile == "default" {
			activeProfile = fmt.Sprintf("instance_%d", offset+1)
		}
		log.Printf("[Info] Порт %d занят. Запускаем экземпляр с профилем %q на HTTP=%d, P2P=%d", *port, activeProfile, actualHTTPPort, actualP2PPort)
	} else {
		actualP2PPort = findAvailablePort("0.0.0.0", *p2pPort)
	}

	resolvedKeyPath := *keyPath
	if resolvedKeyPath == "" {
		resolvedKeyPath = p2p.ProfileIdentityPath(activeProfile)
	}

	log.Println("========================================================")
	log.Printf("          🔔 Звоночек %s (Zvonochek %s)          \n", p2p.AppVersion, p2p.AppVersion)
	log.Println("  Connection Manager + 2K Video + Discord Audio Mixer   ")
	log.Println("========================================================")
	log.Printf("[Profile] Профиль: %s (ключ: %s)", activeProfile, resolvedKeyPath)

	cfg := p2p.NodeConfig{
		ListenPort:            actualP2PPort,
		RelayAddr:             *relayAddr,
		EnableRelayServer:     *enableRelayServer,
		EnablePublicBootstrap: *enablePublicBootstrap,
		ProfileName:           activeProfile,
		Nickname:              *nickname,
		IdentityKeyPath:       resolvedKeyPath,
		DownloadsDir:          "downloads",
	}

	node, err := p2p.NewP2PNode(cfg)
	if err != nil {
		log.Fatalf("[FATAL] Не удалось инициализировать узел libp2p: %v", err)
	}
	defer node.Close()

	log.Printf("[P2P] Постоянный Peer ID профиля %q: %s", activeProfile, node.Host.ID().String())
	log.Printf("[Daemon] Локальный интерфейс: http://127.0.0.1:%d (токен передан через #fragment)", actualHTTPPort)

	srv := server.NewServer(node, actualHTTPPort, web.IndexHTML)

	go func() {
		if err := srv.Start(); err != nil {
			log.Fatalf("[FATAL] Остановка HTTP-сервера: %v", err)
		}
	}()

	// Rule 6: Do not write the secret token to logs! Pass it only to the browser process.
	launchURL := fmt.Sprintf("http://127.0.0.1:%d/#token=%s", actualHTTPPort, srv.Token())

	if !*noBrowser {
		time.Sleep(400 * time.Millisecond)
		openBrowser(launchURL)
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	log.Println("[Daemon] Освобождение сетевых потоков и завершение работы...")
}
