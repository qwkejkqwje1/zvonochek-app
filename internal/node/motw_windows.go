//go:build windows

package node

import "os"

// markFromInternet adds the Mark-of-the-Web so Windows SmartScreen and Office
// treat received files as downloaded from the Internet.
func markFromInternet(path string) {
	f, err := os.OpenFile(path+":Zone.Identifier", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	_, _ = f.WriteString("[ZoneTransfer]\r\nZoneId=3\r\n")
	_ = f.Close()
}
