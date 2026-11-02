package node

import (
	"context"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/client"
)

type relayState struct {
	Addr    string    `json:"addr"`
	State   string    `json:"state"` // connecting|reserved|error
	Error   string    `json:"error,omitempty"`
	Expires time.Time `json:"expires,omitempty"`
	ai      peer.AddrInfo
}

// RelayView is used for diagnostics.
type RelayView struct {
	Addr    string `json:"addr"`
	State   string `json:"state"`
	Error   string `json:"error,omitempty"`
	Expires int64  `json:"expires,omitempty"`
}

func (n *Node) startRelays(list []string) {
	seen := map[string]bool{}
	for _, raw := range list {
		raw = strings.TrimSpace(raw)
		if raw == "" || seen[raw] {
			continue
		}
		seen[raw] = true
		ai, err := peer.AddrInfoFromString(raw)
		if err != nil {
			n.mu.Lock()
			n.relays = append(n.relays, &relayState{Addr: raw, State: "error", Error: "некорректный адрес"})
			n.mu.Unlock()
			continue
		}
		rs := &relayState{Addr: raw, State: "connecting", ai: *ai}
		n.mu.Lock()
		n.relays = append(n.relays, rs)
		n.mu.Unlock()
		n.h.ConnManager().Protect(ai.ID, "relay")
		n.goLoop(func() { n.maintainRelay(rs) })
	}
}

func (n *Node) maintainRelay(rs *relayState) {
	backoff := 10 * time.Second
	for n.ctx.Err() == nil {
		n.mu.Lock()
		needs := rs.State != "reserved" || time.Until(rs.Expires) < 3*time.Minute ||
			n.h.Network().Connectedness(rs.ai.ID) != network.Connected
		n.mu.Unlock()
		if needs {
			ctx, cancel := context.WithTimeout(n.ctx, 30*time.Second)
			err := n.h.Connect(ctx, rs.ai)
			var rsvp *client.Reservation
			if err == nil {
				rsvp, err = client.Reserve(ctx, n.h, rs.ai)
			}
			cancel()
			n.mu.Lock()
			if err != nil {
				rs.State, rs.Error = "error", shortErr(err)
				n.mu.Unlock()
				n.updateNetStatus()
				select {
				case <-n.ctx.Done():
					return
				case <-time.After(backoff):
				}
				backoff = minDur(backoff*2, 3*time.Minute)
				continue
			}
			rs.State, rs.Error, rs.Expires = "reserved", "", rsvp.Expiration
			n.mu.Unlock()
			backoff = 10 * time.Second
			n.updateNetStatus()
			// contacts may now be reachable through this relay
			n.ReconnectNow()
		}
		select {
		case <-n.ctx.Done():
			return
		case <-time.After(20 * time.Second):
		}
	}
}

// ownRelayAddrs returns full multiaddrs (with /p2p/<relay>) of relays where we hold a reservation.
func (n *Node) ownRelayAddrs() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []string
	for _, r := range n.relays {
		if r.State == "reserved" {
			out = append(out, r.Addr)
		}
	}
	return out
}

func (n *Node) configuredRelays() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []string
	for _, r := range n.relays {
		if r.ai.ID != "" {
			out = append(out, r.Addr)
		}
	}
	return out
}

// Relays returns relay diagnostics.
func (n *Node) Relays() []RelayView {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := []RelayView{}
	for _, r := range n.relays {
		v := RelayView{Addr: r.Addr, State: r.State, Error: r.Error}
		if !r.Expires.IsZero() {
			v.Expires = r.Expires.UnixMilli()
		}
		out = append(out, v)
	}
	return out
}
