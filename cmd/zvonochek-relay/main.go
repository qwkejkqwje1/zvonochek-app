// Command zvonochek-relay is an optional self-hosted Circuit Relay v2 server.
//
// It helps two clients that are both behind strict NAT/CGNAT: they reserve a
// slot on the relay, connect through it and then try to upgrade to a direct
// connection (hole punching). Unlike public libp2p relays it does not cap
// circuits at 2 minutes / 128 KiB, so files and the audio bridge keep working
// even when hole punching fails. Run it on any VPS with a public IP.
package main

import (
	"bufio"
	"crypto/rand"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/net/connmgr"
	"github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"

	"zvonochek2/internal/version"
)

func main() {
	port := flag.Int("port", 4002, "TCP и UDP (QUIC) порт")
	keyPath := flag.String("key", "relay_identity.key", "файл ключа (создаётся при первом запуске; от него зависит адрес relay)")
	announce := flag.String("announce", "", "публичный IP или DNS-имя сервера (если провайдер VPS выдаёт приватный адрес)")
	maxRes := flag.Int("max-reservations", 512, "максимум одновременно подключённых клиентов")
	maxCircuits := flag.Int("max-circuits", 32, "максимум одновременных соединений через relay на одного клиента")
	allowFile := flag.String("allow", "", "файл со списком разрешённых Peer ID (по одному в строке); пусто — пускать всех")
	showVersion := flag.Bool("version", false, "показать версию")
	flag.Parse()
	if *showVersion {
		fmt.Println("zvonochek-relay", version.Version)
		return
	}
	log.SetFlags(log.LstdFlags)

	priv, err := loadKey(*keyPath)
	if err != nil {
		log.Fatalf("ключ: %v", err)
	}
	cm, err := connmgr.NewConnManager(512, 2048, connmgr.WithGracePeriod(time.Minute))
	if err != nil {
		log.Fatal(err)
	}
	opts := []libp2p.Option{
		libp2p.Identity(priv),
		libp2p.ListenAddrStrings(
			fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", *port),
			fmt.Sprintf("/ip4/0.0.0.0/udp/%d/quic-v1", *port),
			fmt.Sprintf("/ip6/::/tcp/%d", *port),
			fmt.Sprintf("/ip6/::/udp/%d/quic-v1", *port),
		),
		libp2p.UserAgent("zvonochek-relay/" + version.Version),
		libp2p.ConnectionManager(cm),
		libp2p.ForceReachabilityPublic(),
		libp2p.DisableRelay(),
	}
	if *announce != "" {
		ann, err := announceAddrs(*announce, *port)
		if err != nil {
			log.Fatalf("-announce: %v", err)
		}
		opts = append(opts, libp2p.AddrsFactory(func(addrs []ma.Multiaddr) []ma.Multiaddr {
			return append(ann, addrs...)
		}))
	}
	h, err := libp2p.New(opts...)
	if err != nil {
		log.Fatalf("не удалось запустить: %v", err)
	}
	defer h.Close()

	res := relay.DefaultResources()
	res.Limit = nil // unlimited circuits: calls and files must survive
	res.MaxReservations = *maxRes
	res.MaxCircuits = *maxCircuits
	res.BufferSize = 32 << 10
	res.MaxReservationsPerIP = 16
	res.MaxReservationsPerASN = 256
	ropts := []relay.Option{relay.WithResources(res), relay.WithInfiniteLimits()}
	if *allowFile != "" {
		acl, err := loadACL(*allowFile)
		if err != nil {
			log.Fatalf("-allow: %v", err)
		}
		ropts = append(ropts, relay.WithACL(acl))
		log.Printf("доступ только для %d Peer ID из %s", len(acl.ids), *allowFile)
	}
	rel, err := relay.New(h, ropts...)
	if err != nil {
		log.Fatalf("relay: %v", err)
	}
	defer rel.Close()

	fmt.Printf("Звоночек relay %s запущен. Peer ID: %s\n\n", version.Version, h.ID())
	fmt.Println("Добавьте ОДИН из адресов в Звоночке: Настройки → Сеть → Свои relay-серверы")
	printed := 0
	for _, a := range sortAddrs(h.Addrs()) {
		if manet.IsIPLoopback(a) {
			continue
		}
		pub := manet.IsPublicAddr(a)
		if !pub && *announce == "" {
			continue
		}
		fmt.Printf("  %s/p2p/%s\n", a, h.ID())
		printed++
	}
	if printed == 0 {
		fmt.Println("  (публичный адрес не найден — укажите -announce <IP-или-домен>; локальные адреса:)")
		for _, a := range sortAddrs(h.Addrs()) {
			fmt.Printf("  %s/p2p/%s\n", a, h.ID())
		}
	}
	fmt.Printf("\nОткройте порт %d TCP и UDP во внешнем файрволе/панели VPS.\n", *port)

	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for range t.C {
			log.Printf("подключено узлов: %d", len(h.Network().Peers()))
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Println("остановка")
}

func loadKey(path string) (crypto.PrivKey, error) {
	if b, err := os.ReadFile(path); err == nil {
		return crypto.UnmarshalPrivateKey(b)
	}
	priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		return nil, err
	}
	b, err := crypto.MarshalPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	return priv, os.WriteFile(path, b, 0o600)
}

func announceAddrs(host string, port int) ([]ma.Multiaddr, error) {
	host = strings.TrimSpace(host)
	var out []ma.Multiaddr
	add := func(s string) error {
		a, err := ma.NewMultiaddr(s)
		if err != nil {
			return err
		}
		out = append(out, a)
		return nil
	}
	if ip := net.ParseIP(host); ip != nil {
		proto := "ip4"
		if ip.To4() == nil {
			proto = "ip6"
		}
		if err := add(fmt.Sprintf("/%s/%s/tcp/%d", proto, ip, port)); err != nil {
			return nil, err
		}
		return out, add(fmt.Sprintf("/%s/%s/udp/%d/quic-v1", proto, ip, port))
	}
	if err := add(fmt.Sprintf("/dns/%s/tcp/%d", host, port)); err != nil {
		return nil, err
	}
	return out, add(fmt.Sprintf("/dns/%s/udp/%d/quic-v1", host, port))
}

func sortAddrs(in []ma.Multiaddr) []ma.Multiaddr {
	out := append([]ma.Multiaddr(nil), in...)
	rank := func(a ma.Multiaddr) int {
		s := a.String()
		r := 0
		if strings.Contains(s, "/quic") {
			r += 1
		}
		if strings.HasPrefix(s, "/ip6") {
			r += 2
		}
		return r
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out
}

type allowList struct{ ids map[peer.ID]bool }

func (a *allowList) AllowReserve(p peer.ID, _ ma.Multiaddr) bool { return a.ids[p] }
func (a *allowList) AllowConnect(src peer.ID, _ ma.Multiaddr, dest peer.ID) bool {
	return a.ids[src] || a.ids[dest]
}

func loadACL(path string) (*allowList, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	acl := &allowList{ids: map[peer.ID]bool{}}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		id, err := peer.Decode(strings.Fields(line)[0])
		if err != nil {
			return nil, fmt.Errorf("строка %q: %w", line, err)
		}
		acl.ids[id] = true
	}
	return acl, sc.Err()
}
