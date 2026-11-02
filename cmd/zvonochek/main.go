// Command zvonochek is the desktop P2P messenger: it runs the libp2p node,
// serves the UI on 127.0.0.1 and shows it in an app window.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"zvonochek2/internal/api"
	"zvonochek2/internal/desktop"
	"zvonochek2/internal/node"
	"zvonochek2/internal/store"
	"zvonochek2/internal/version"
	"zvonochek2/web"
)

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

type options struct {
	profile    string
	dataDir    string
	port       int
	p2pPort    int
	relays     listFlag
	noWindow   bool
	background bool
	noInternet bool
	noLAN      bool
	loopback   bool
	printURL   bool
	waitLock   time.Duration
	beaconPort int
	webDir     string
	restarted  bool
}

func main() {
	var o options
	flag.StringVar(&o.profile, "profile", "default", "имя профиля (несколько независимых аккаунтов на одном ПК)")
	flag.StringVar(&o.dataDir, "data-dir", "", "папка данных (по умолчанию %APPDATA%\\Zvonochek2\\profiles\\<профиль>)")
	flag.IntVar(&o.port, "port", 0, "порт локального интерфейса (0 — из настроек, по умолчанию 47320)")
	flag.IntVar(&o.p2pPort, "p2p-port", 0, "P2P-порт TCP/UDP (0 — из настроек)")
	flag.Var(&o.relays, "relay", "дополнительный relay-сервер (multiaddr с /p2p/…), можно несколько раз")
	flag.BoolVar(&o.noWindow, "no-window", false, "без окна и трея (сервер/тесты)")
	flag.BoolVar(&o.background, "background", false, "запуск свёрнутым в трей (автозапуск)")
	flag.BoolVar(&o.noInternet, "no-internet", false, "отключить поиск через интернет (DHT, публичные relay)")
	flag.BoolVar(&o.noLAN, "no-lan", false, "отключить поиск в локальной сети")
	flag.BoolVar(&o.loopback, "loopback", false, "слушать только 127.0.0.1 (тесты)")
	flag.BoolVar(&o.printURL, "print-url", false, "вывести одноразовую ссылку входа в интерфейс")
	flag.DurationVar(&o.waitLock, "wait-lock", 0, "ждать освобождения профиля (используется при перезапуске)")
	flag.IntVar(&o.beaconPort, "beacon-port", 0, "TCP-порт маяка для виртуальных машин (0 — 47329)")
	flag.StringVar(&o.webDir, "web-dir", "", "отдавать интерфейс из папки (разработка)")
	flag.BoolVar(&o.restarted, "restarted", false, "служебный: запуск после перезапуска")
	showVersion := flag.Bool("version", false, "показать версию")
	flag.Parse()
	if *showVersion {
		fmt.Println("Звоночек", version.Version, version.Commit)
		return
	}
	if err := run(o); err != nil {
		log.Printf("[fatal] %v", err)
		desktop.MessageBox("Звоночек", err.Error())
		os.Exit(1)
	}
}

// logWriter writes to every sink and ignores failing ones (a GUI build has
// no valid stderr).
type logWriter struct {
	sinks []interface{ Write([]byte) (int, error) }
}

func (w logWriter) Write(p []byte) (int, error) {
	for _, s := range w.sinks {
		_, _ = s.Write(p)
	}
	return len(p), nil
}

func run(o options) error {
	dir, err := desktop.ProfileDir(o.dataDir, o.profile)
	if err != nil {
		return fmt.Errorf("не удалось создать папку профиля: %w", err)
	}
	logDir := filepath.Join(dir, "logs")
	_ = os.MkdirAll(logDir, 0o700)
	logPath := filepath.Join(logDir, "zvonochek.log")
	if lw, err := desktop.OpenLog(logPath, 4<<20); err == nil {
		log.SetOutput(logWriter{sinks: []interface{ Write([]byte) (int, error) }{lw, os.Stderr}})
		defer lw.Close()
	}
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if cf, err := os.OpenFile(filepath.Join(logDir, "crash.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		_ = debug.SetCrashOutput(cf, debug.CrashOptions{})
	}

	// single instance per profile
	lock, err := acquireLock(dir, o.waitLock)
	if err != nil {
		if errors.Is(err, errRunning) {
			if !o.background && !o.noWindow {
				if askRunningInstance(dir) {
					return nil
				}
				return errors.New("Звоночек с этим профилем уже запущен, но не отвечает. Завершите процесс zvonochek.exe в диспетчере задач и попробуйте снова.")
			}
			return nil
		}
		return err
	}
	defer lock.Release()
	log.Printf("[start] Звоночек %s (%s), profile %q, data %s", version.Version, version.Commit, o.profile, dir)

	secret, err := desktop.LoadSecret(filepath.Join(dir, "session.key"))
	if err != nil {
		return fmt.Errorf("session secret: %w", err)
	}
	st, err := store.Open(dir)
	if err != nil {
		return fmt.Errorf("не удалось открыть данные профиля: %w", err)
	}
	defer st.Close()
	for _, w := range st.Warnings {
		log.Printf("[store] повреждённый файл: %s", w)
	}
	st.UpdateSettings(func(s *store.Settings) {
		if strings.TrimSpace(s.Nickname) == "" {
			s.Nickname = desktop.DefaultNickname()
		}
	})

	identity := filepath.Join(dir, "identity.key")
	if o.dataDir == "" {
		desktop.MigrateLegacyIdentity(dir, o.profile, identity)
	}

	ln, err := listenUI(o.port, st.Settings().HTTPPort)
	if err != nil {
		return fmt.Errorf("не удалось открыть локальный порт интерфейса: %w", err)
	}

	n, err := node.New(node.Options{
		Store:        st,
		IdentityPath: identity,
		P2PPort:      o.p2pPort,
		ExtraRelays:  o.relays,
		NoInternet:   o.noInternet,
		NoLAN:        o.noLAN,
		LoopbackOnly: o.loopback,
		BeaconPort:   o.beaconPort,
	})
	if err != nil {
		ln.Close()
		return fmt.Errorf("не удалось запустить P2P-узел: %w", err)
	}

	var static fs.FS = web.Static()
	if o.webDir != "" {
		static = os.DirFS(o.webDir)
	}

	var (
		quitOnce sync.Once
		quitCh   = make(chan struct{})
		restart  bool
		srv      *api.Server
		win      = &desktop.Window{ProfileDir: filepath.Join(dir, "window")}
	)
	quit := func(again bool) {
		quitOnce.Do(func() {
			restart = again
			close(quitCh)
			if desktop.HasTray && !o.noWindow {
				desktop.QuitTray()
			}
		})
	}
	openWindow := func() {
		if o.noWindow {
			log.Printf("[ui] window requested (headless): %s", srv.LaunchURL())
			return
		}
		if err := win.Open(srv.LaunchURL()); err != nil {
			log.Printf("[ui] open window: %v", err)
		}
	}
	hooks := api.Hooks{
		OpenWindow: openWindow,
		Quit:       func() { quit(false) },
		Restart:    func() { quit(true) },
		Reveal:     desktop.Reveal,
		OpenFile:   desktop.OpenFile,
		OpenFolder: desktop.OpenFolder,
	}
	if _, ok := desktop.AutostartEnabled(o.profile); ok {
		hooks.Autostart = func() (bool, bool) { return desktop.AutostartEnabled(o.profile) }
		hooks.SetAutostart = func(on bool) error { return desktop.SetAutostart(o.profile, on) }
	}
	srv = api.New(n, ln, secret, static, hooks, api.Info{Profile: o.profile, DataDir: dir, LogFile: logPath, Started: time.Now()})

	node.IncomingCallHook = func(node.CallView) {
		if n.Subscribers() == 0 && st.Settings().OpenWindowOnCall {
			openWindow()
		}
	}
	node.NotifyHook = func(kind, title, text string) {
		s := st.Settings()
		if !s.DesktopNotify || o.noWindow {
			return
		}
		if kind == "call" && s.OpenWindowOnCall {
			return // the window pops up instead
		}
		desktop.Notify(title, text)
	}

	go func() {
		if err := srv.Serve(); err != nil {
			log.Printf("[ui] server: %v", err)
			quit(false)
		}
	}()
	_ = desktop.WriteInstance(dir, desktop.InstanceInfo{PID: os.Getpid(), Port: srv.Port()})
	log.Printf("[ui] http://127.0.0.1:%d  peer %s", srv.Port(), n.ID())
	if o.printURL {
		fmt.Printf("ZV_URL=%s\nZV_PEER=%s\nZV_PORT=%d\n", srv.LaunchURL(), n.ID(), srv.Port())
		_ = os.Stdout.Sync()
	}

	switch {
	case o.noWindow || o.background:
	case o.restarted:
		// the old window reconnects by itself; open a new one only if it does not
		go func() {
			time.Sleep(6 * time.Second)
			if n.Subscribers() == 0 {
				openWindow()
			}
		}()
	default:
		go openWindow()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case s := <-sig:
			log.Printf("[stop] signal %v", s)
			quit(false)
		case <-quitCh:
		}
	}()

	if desktop.HasTray && !o.noWindow {
		desktop.RunTray(desktop.TrayActions{
			Open: openWindow,
			Quit: func() { quit(false) },
			Autostart: func() bool {
				on, _ := desktop.AutostartEnabled(o.profile)
				return on
			},
			SetAutostart: func(on bool) error { return desktop.SetAutostart(o.profile, on) },
			Tooltip:      "Звоночек " + version.Version,
		})
		quit(false) // tray loop ended
	}
	<-quitCh

	log.Printf("[stop] shutting down (restart=%v)", restart)
	srv.Close()
	_ = n.Close()
	st.Close()
	_ = os.Remove(filepath.Join(dir, "instance.json"))
	lock.Release()
	if restart {
		if err := desktop.Detach(restartArgs(os.Args[1:])); err != nil {
			log.Printf("[stop] restart failed: %v", err)
		}
	}
	return nil
}

var errRunning = errors.New("already running")

func acquireLock(dir string, wait time.Duration) (*desktop.Lock, error) {
	path := filepath.Join(dir, "zvonochek.lock")
	deadline := time.Now().Add(wait)
	for {
		l, err := desktop.TryLock(path)
		if err == nil {
			return l, nil
		}
		if time.Now().After(deadline) {
			return nil, errRunning
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// askRunningInstance asks the already running process to show its window.
func askRunningInstance(dir string) bool {
	secret, err := os.ReadFile(filepath.Join(dir, "session.key"))
	if err != nil {
		return false
	}
	for attempt := 0; attempt < 10; attempt++ {
		info, err := desktop.ReadInstance(dir)
		if err == nil {
			req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/api/local/open-window", info.Port), nil)
			req.Header.Set("X-ZV-Local", strings.TrimSpace(string(secret)))
			cl := &http.Client{Timeout: 3 * time.Second}
			if resp, err := cl.Do(req); err == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return true
				}
			}
		}
		time.Sleep(500 * time.Millisecond) // the other instance may still be starting
	}
	return false
}

func listenUI(flagPort, settingsPort int) (net.Listener, error) {
	base := flagPort
	if base == 0 {
		base = settingsPort
	}
	if base <= 0 || base > 65535 {
		base = 47320
	}
	var lastErr error
	for p := base; p < base+30 && p <= 65535; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			return ln, nil
		}
		lastErr = err
		if flagPort != 0 {
			break // explicit port: do not wander
		}
	}
	if flagPort != 0 {
		return nil, lastErr
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

func restartArgs(args []string) []string {
	out := []string{}
	for _, a := range args {
		switch strings.TrimLeft(a, "-") {
		case "background", "restarted", "print-url":
			continue
		}
		if strings.HasPrefix(strings.TrimLeft(a, "-"), "wait-lock") {
			continue
		}
		out = append(out, a)
	}
	return append(out, "-restarted", "-wait-lock=30s")
}
