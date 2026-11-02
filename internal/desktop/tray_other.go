//go:build !windows

package desktop

// TrayActions are the callbacks of the tray menu.
type TrayActions struct {
	Open         func()
	Quit         func()
	Autostart    func() bool
	SetAutostart func(bool) error
	Tooltip      string
}

// RunTray is a no-op outside Windows (the process runs in the terminal).
func RunTray(TrayActions) {}

// QuitTray is a no-op outside Windows.
func QuitTray() {}

// SetTrayTooltip is a no-op outside Windows.
func SetTrayTooltip(string) {}

// HasTray reports whether a tray implementation exists on this OS.
const HasTray = false
