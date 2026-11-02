// Package desktop contains OS integration: profile paths, single-instance
// lock, the app window (Edge/Chrome in --app mode), tray, autostart,
// notifications and "show in folder".
package desktop

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AppDirName is the folder under the user config dir (kept from 2.x so the
// identity of existing users survives the upgrade).
const AppDirName = "Zvonochek2"

// ProfileDir returns (and creates) the data directory of a profile.
func ProfileDir(override, profile string) (string, error) {
	if override != "" {
		abs, err := filepath.Abs(override)
		if err != nil {
			return "", err
		}
		return abs, os.MkdirAll(abs, 0o700)
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".config")
	}
	dir := filepath.Join(base, AppDirName, "profiles", SafeName(profile))
	return dir, os.MkdirAll(dir, 0o700)
}

// SafeName keeps [A-Za-z0-9_-].
func SafeName(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "default"
	}
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, s)
}

// MigrateLegacyIdentity copies the 2.x key (profiles/<host>_<profile>/identity.key)
// so the user keeps the same Peer ID after upgrading.
func MigrateLegacyIdentity(dataDir, profile, target string) {
	if _, err := os.Stat(target); err == nil {
		return
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return
	}
	host, _ := os.Hostname()
	legacy := filepath.Join(base, AppDirName, "profiles", SafeName(host)+"_"+SafeName(profile), "identity.key")
	data, err := os.ReadFile(legacy)
	if err != nil || len(data) == 0 {
		return
	}
	if err := os.WriteFile(target, data, 0o600); err == nil {
		log.Printf("[migrate] imported identity from %s", legacy)
	}
}

// DefaultNickname guesses a friendly name from the OS account.
func DefaultNickname() string {
	if u, err := user.Current(); err == nil {
		name := u.Name
		if name == "" {
			name = u.Username
		}
		if i := strings.LastIndexAny(name, `\/`); i >= 0 {
			name = name[i+1:]
		}
		name = strings.TrimSpace(name)
		if name != "" && !strings.EqualFold(name, "root") {
			return name
		}
	}
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "Я"
}

// LoadSecret reads or creates a random hex secret file (0600).
func LoadSecret(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		s := strings.TrimSpace(string(b))
		if len(s) >= 32 {
			return s, nil
		}
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	s := hex.EncodeToString(b)
	return s, os.WriteFile(path, []byte(s), 0o600)
}

// InstanceInfo is written next to the lock so a second launch can find us.
type InstanceInfo struct {
	PID  int `json:"pid"`
	Port int `json:"port"`
}

// WriteInstance stores instance.json.
func WriteInstance(dir string, info InstanceInfo) error {
	b, _ := json.Marshal(info)
	return os.WriteFile(filepath.Join(dir, "instance.json"), b, 0o600)
}

// ReadInstance loads instance.json.
func ReadInstance(dir string) (InstanceInfo, error) {
	var info InstanceInfo
	b, err := os.ReadFile(filepath.Join(dir, "instance.json"))
	if err != nil {
		return info, err
	}
	err = json.Unmarshal(b, &info)
	if err == nil && info.Port == 0 {
		err = errors.New("no port")
	}
	return info, err
}

// RotatingLog is a tiny size-based log rotator (1 backup).
type RotatingLog struct {
	mu   sync.Mutex
	path string
	f    *os.File
	size int64
	max  int64
}

// OpenLog opens (appends) the log file.
func OpenLog(path string, max int64) (*RotatingLog, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	st, _ := f.Stat()
	var size int64
	if st != nil {
		size = st.Size()
	}
	return &RotatingLog{path: path, f: f, size: size, max: max}, nil
}

// File returns the current file (for crash output).
func (l *RotatingLog) File() *os.File { return l.f }

func (l *RotatingLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.size+int64(len(p)) > l.max {
		l.f.Close()
		_ = os.Remove(l.path + ".1")
		_ = os.Rename(l.path, l.path+".1")
		f, err := os.OpenFile(l.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return 0, err
		}
		l.f, l.size = f, 0
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}

// Close closes the file.
func (l *RotatingLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}

var _ io.Writer = (*RotatingLog)(nil)

// Window opens the UI in a Chromium-based browser in "app" mode with a
// dedicated profile (own taskbar icon, remembered window size and
// camera/microphone permissions); falls back to the default browser.
type Window struct {
	ProfileDir string
	mu         sync.Mutex
	last       time.Time
}

// Open shows a window for url.
func (w *Window) Open(url string) error {
	w.mu.Lock()
	if time.Since(w.last) < 1500*time.Millisecond {
		w.mu.Unlock()
		return nil // debounce double clicks
	}
	w.last = time.Now()
	w.mu.Unlock()
	if bin := findChromium(); bin != "" {
		args := []string{
			"--app=" + url,
			"--user-data-dir=" + w.ProfileDir,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-sync",
			"--window-size=1240,820",
			"--autoplay-policy=no-user-gesture-required",
			"--disable-features=Translate,msEdgeSidebarV2,msHubApps,msUndersideButton,EdgeCollections",
		}
		cmd := exec.Command(bin, args...)
		hideConsole(cmd)
		if err := cmd.Start(); err == nil {
			go func() { _ = cmd.Wait() }()
			return nil
		} else {
			log.Printf("[window] %s failed: %v", bin, err)
		}
	}
	return openDefault(url)
}

// HasAppBrowser reports whether an app-mode capable browser was found.
func HasAppBrowser() bool { return findChromium() != "" }

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// Notify shows a desktop notification (best effort).
func Notify(title, text string) {
	if err := notify(title, text); err != nil {
		log.Printf("[notify] %v", err)
	}
}

func lookAny(names ...string) string {
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
	}
	return ""
}

func errorf(format string, a ...any) error { return fmt.Errorf(format, a...) }
