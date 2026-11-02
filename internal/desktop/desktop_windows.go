//go:build windows

package desktop

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const createNoWindow = 0x08000000

func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

func findChromium() string {
	var candidates []string
	for _, key := range []string{`SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe`, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`} {
		for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
			if k, err := registry.OpenKey(root, key, registry.QUERY_VALUE); err == nil {
				if v, _, err := k.GetStringValue(""); err == nil && v != "" {
					candidates = append(candidates, strings.Trim(v, `"`))
				}
				k.Close()
			}
		}
	}
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		candidates = append(candidates,
			filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
			filepath.Join(base, "Chromium", "Application", "chrome.exe"))
	}
	for _, c := range candidates {
		if fileExists(c) {
			return c
		}
	}
	return ""
}

func openDefault(url string) error {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	hideConsole(cmd)
	return cmd.Start()
}

// Reveal selects the file in Explorer.
func Reveal(path string) error {
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + path + `"`}
	return cmd.Start()
}

// OpenFile opens a document with its associated application (Explorer
// honours the Mark-of-the-Web, so SmartScreen still warns about risky files).
func OpenFile(path string) error {
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe "` + path + `"`}
	return cmd.Start()
}

// OpenFolder opens a folder in Explorer.
func OpenFolder(path string) error {
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe "` + path + `"`}
	return cmd.Start()
}

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

func autostartName(profile string) string {
	if profile == "" || profile == "default" {
		return "Zvonochek"
	}
	return "Zvonochek-" + SafeName(profile)
}

func autostartCmd(profile string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	cmd := `"` + exe + `" -background`
	if profile != "" && profile != "default" {
		cmd += ` -profile "` + SafeName(profile) + `"`
	}
	return cmd, nil
}

// AutostartEnabled reports whether we start with Windows.
func AutostartEnabled(profile string) (bool, bool) {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false, true
	}
	defer k.Close()
	v, _, err := k.GetStringValue(autostartName(profile))
	if err != nil {
		return false, true
	}
	want, _ := autostartCmd(profile)
	return strings.EqualFold(v, want), true
}

// SetAutostart toggles start with Windows (per user, no admin rights).
func SetAutostart(profile string, on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		err := k.DeleteValue(autostartName(profile))
		if err == registry.ErrNotExist {
			return nil
		}
		return err
	}
	cmd, err := autostartCmd(profile)
	if err != nil {
		return err
	}
	return k.SetStringValue(autostartName(profile), cmd)
}

// notify shows a Windows toast through PowerShell (no extra dependencies).
// Title and text are passed via environment variables, never interpolated.
func notify(title, text string) error {
	script := `$ErrorActionPreference='Stop';` +
		`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;` +
		`$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);` +
		`$t=$x.GetElementsByTagName('text');` +
		`$t.Item(0).AppendChild($x.CreateTextNode($env:ZV_TITLE)) | Out-Null;` +
		`$t.Item(1).AppendChild($x.CreateTextNode($env:ZV_TEXT)) | Out-Null;` +
		`$n=[Windows.UI.Notifications.ToastNotification]::new($x);` +
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($n)`
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[i*2] = byte(c)
		b[i*2+1] = byte(c >> 8)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.Env = append(os.Environ(), "ZV_TITLE="+title, "ZV_TEXT="+text)
	hideConsole(cmd)
	return cmd.Start()
}

// MessageBox shows a native error dialog (used before the UI is available).
func MessageBox(title, text string) {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(text)
	user32 := windows.NewLazySystemDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	_, _, _ = proc.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
}

// Lock is an exclusive per-profile lock.
type Lock struct{ f *os.File }

// TryLock acquires the profile lock without blocking.
func TryLock(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	ol := new(windows.Overlapped)
	err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol)
	if err != nil {
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
	ol := new(windows.Overlapped)
	_ = windows.UnlockFileEx(windows.Handle(l.f.Fd()), 0, 1, 0, ol)
	_ = l.f.Close()
}

// Detach starts a detached copy of ourselves (used for restart).
func Detach(args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP}
	return cmd.Start()
}
