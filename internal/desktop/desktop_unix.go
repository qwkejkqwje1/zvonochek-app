//go:build !windows

package desktop

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
)

func hideConsole(*exec.Cmd) {}

func findChromium() string {
	if runtime.GOOS == "darwin" {
		for _, p := range []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		} {
			if fileExists(p) {
				return p
			}
		}
		return ""
	}
	return lookAny("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser")
}

func openDefault(url string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", url).Start()
	}
	return exec.Command("xdg-open", url).Start()
}

// Reveal shows the file in the file manager.
func Reveal(path string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", "-R", path).Start()
	}
	return exec.Command("xdg-open", filepath.Dir(path)).Start()
}

// OpenFile opens a document with the default application.
func OpenFile(path string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", path).Start()
	}
	return exec.Command("xdg-open", path).Start()
}

// OpenFolder opens a folder.
func OpenFolder(path string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", path).Start()
	}
	return exec.Command("xdg-open", path).Start()
}

// AutostartEnabled is only implemented on Windows.
func AutostartEnabled(string) (bool, bool) { return false, false }

// SetAutostart is only implemented on Windows.
func SetAutostart(string, bool) error { return errors.New("not supported") }

func notify(title, text string) error {
	if runtime.GOOS == "darwin" {
		return nil
	}
	if p := lookAny("notify-send"); p != "" {
		return exec.Command(p, "-a", "Звоночек", title, text).Start()
	}
	return nil
}

// MessageBox prints to stderr on non-Windows systems.
func MessageBox(title, text string) { _, _ = os.Stderr.WriteString(title + ": " + text + "\n") }

// Lock is an exclusive per-profile lock.
type Lock struct{ f *os.File }

// TryLock acquires the profile lock without blocking.
func TryLock(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Release frees the lock.
func (l *Lock) Release() {
	if l == nil || l.f == nil {
		return
	}
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	_ = l.f.Close()
}

// Detach starts a detached copy of ourselves (used for restart).
func Detach(args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, args...)
	cmd.Stdout, cmd.Stderr = nil, nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}
