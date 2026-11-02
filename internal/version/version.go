// Package version holds build metadata injected via -ldflags.
package version

// Version is the application version. Overridden at build time:
//
//	go build -ldflags "-X zvonochek2/internal/version.Version=3.0.1"
var Version = "3.0.0"

// Commit is the VCS revision (optional, set by the release workflow).
var Commit = "dev"

// ProtocolMajor is bumped only on incompatible wire-protocol changes.
const ProtocolMajor = 3

// UserAgent is announced via libp2p identify.
func UserAgent() string { return "zvonochek/" + Version }
