//go:build windows

package desktop

import (
	_ "embed"

	"fyne.io/systray"
)

//go:embed icon.ico
var trayIcon []byte

// TrayActions are the callbacks of the tray menu.
type TrayActions struct {
	Open         func()
	Quit         func()
	Autostart    func() bool
	SetAutostart func(bool) error
	Tooltip      string
}

// RunTray blocks the calling (main) goroutine running the tray loop.
func RunTray(a TrayActions) {
	systray.Run(func() {
		systray.SetIcon(trayIcon)
		systray.SetTitle("Звоночек")
		systray.SetTooltip(a.Tooltip)
		systray.SetOnTapped(func() { go a.Open() })
		open := systray.AddMenuItem("Открыть Звоночек", "Показать окно")
		systray.AddSeparator()
		auto := systray.AddMenuItemCheckbox("Запускать вместе с Windows", "", a.Autostart())
		systray.AddSeparator()
		quit := systray.AddMenuItem("Выход", "Закрыть Звоночек полностью")
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					go a.Open()
				case <-auto.ClickedCh:
					want := !auto.Checked()
					if err := a.SetAutostart(want); err == nil {
						if want {
							auto.Check()
						} else {
							auto.Uncheck()
						}
					}
				case <-quit.ClickedCh:
					a.Quit()
					return
				}
			}
		}()
	}, func() {})
}

// QuitTray ends the tray loop.
func QuitTray() { systray.Quit() }

// SetTrayTooltip updates the hover text (e.g. unread counter).
func SetTrayTooltip(s string) { systray.SetTooltip(s) }

// HasTray reports whether a tray implementation exists on this OS.
const HasTray = true
