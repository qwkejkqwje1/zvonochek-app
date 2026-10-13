package p2p

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

// InviteBundle is encoded into a shareable zv2:// invite string
type InviteBundle struct {
	Version   int      `json:"v"`
	PeerID    string   `json:"p"`
	Addrs     []string `json:"a"`
	Secret    string   `json:"s"`
	Nickname  string   `json:"n,omitempty"`
	ExpiresAt int64    `json:"e"`
}

// ProfileIdentityPath returns a persistent path in %APPDATA%/Zvonochek2/profiles/<profile>/identity.key
// bound to the OS Hostname and profile name (NOT the auto-selected port!).
// This guarantees:
// 1) A user's PeerID stays 100% constant even if the HTTP/P2P port changes.
// 2) Different instances launched with -profile user2 have isolated profiles.
// 3) Copying the application directory to a VM or another PC never copies the private key.
func ProfileIdentityPath(profileName string) string {
	cfgDir, err := os.UserConfigDir()
	if err != nil || cfgDir == "" {
		cfgDir = os.TempDir()
	}
	hostName, err := os.Hostname()
	if err != nil || hostName == "" {
		hostName = "node"
	}
	hostName = sanitizeIdentifier(hostName)
	profileName = sanitizeIdentifier(profileName)
	if profileName == "" {
		profileName = "default"
	}

	profileDir := filepath.Join(cfgDir, "Zvonochek2", "profiles", fmt.Sprintf("%s_%s", hostName, profileName))
	_ = os.MkdirAll(profileDir, 0700)
	return filepath.Join(profileDir, "identity.key")
}

func sanitizeIdentifier(s string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, strings.TrimSpace(s))
}

// LoadOrCreateIdentity loads a persistent Ed25519 key from disk or creates a new one
func LoadOrCreateIdentity(keyPath string) (crypto.PrivKey, error) {
	data, err := os.ReadFile(keyPath)
	if err == nil && len(data) > 0 {
		priv, err := crypto.UnmarshalPrivateKey(data)
		if err == nil {
			return priv, nil
		}
	}

	priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("failed to generate identity key: %w", err)
	}

	marshaled, err := crypto.MarshalPrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal identity key: %w", err)
	}

	_ = os.MkdirAll(filepath.Dir(keyPath), 0700)
	if err := os.WriteFile(keyPath, marshaled, 0600); err != nil {
		return nil, fmt.Errorf("failed to save identity key: %w", err)
	}

	return priv, nil
}

// GenerateRandomSecret creates a high-entropy random hex string
func GenerateRandomSecret(bytesLen int) string {
	b := make([]byte, bytesLen)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ShortSafetyCode computes a 6-character safety verification code from two PeerIDs
func ShortSafetyCode(peerA, peerB string) string {
	var combined string
	if peerA < peerB {
		combined = peerA + ":" + peerB
	} else {
		combined = peerB + ":" + peerA
	}
	sum := sha256.Sum256([]byte(combined))
	return strings.ToUpper(hex.EncodeToString(sum[:3]))
}

// EncodeInvite creates a compact zv2:// invite code from an InviteBundle
func EncodeInvite(b InviteBundle) (string, error) {
	raw, err := json.Marshal(b)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	return "zv2://" + encoded, nil
}

// DecodeInvite parses a zv2:// invite string or raw base64 invite
func DecodeInvite(code string) (*InviteBundle, error) {
	code = strings.TrimSpace(code)
	code = strings.TrimPrefix(code, "zv2://")

	raw, err := base64.RawURLEncoding.DecodeString(code)
	if err != nil {
		return nil, errors.New("некорректный формат приглашения (ожидается zv2://...)")
	}

	var b InviteBundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, errors.New("поврежденные данные приглашения")
	}

	if b.ExpiresAt > 0 && time.Now().Unix() > b.ExpiresAt {
		return nil, errors.New("срок действия приглашения истек")
	}

	if _, err := peer.Decode(b.PeerID); err != nil {
		return nil, errors.New("некорректный PeerID в приглашении")
	}

	return &b, nil
}

// FilterAndRankAddrs removes loopback addresses (127.0.0.1 / ::1) and link-local IPv6 (fe80:),
// and ranks LAN, public IPv4/IPv6 WAN, and Circuit Relay addresses.
func FilterAndRankAddrs(fullAddrs []string, preferredInterfaceIP string) []string {
	var preferredAddrs []string
	var lanAddrs []string
	var wanAddrs []string
	var relayAddrs []string

	for _, a := range fullAddrs {
		if strings.Contains(a, "/ip4/127.0.0.1/") ||
			strings.Contains(a, "/ip6/::1/") ||
			strings.Contains(a, "/ip6/fe80:") {
			continue
		}
		if preferredInterfaceIP != "" && strings.Contains(a, "/ip4/"+preferredInterfaceIP+"/") {
			preferredAddrs = append(preferredAddrs, a)
			continue
		}
		if strings.Contains(a, "/p2p-circuit") {
			relayAddrs = append(relayAddrs, a)
			continue
		}
		if isPrivateLANAddr(a) {
			lanAddrs = append(lanAddrs, a)
		} else {
			wanAddrs = append(wanAddrs, a)
		}
	}

	result := make([]string, 0, len(preferredAddrs)+len(lanAddrs)+len(wanAddrs)+len(relayAddrs))
	result = append(result, preferredAddrs...)
	result = append(result, lanAddrs...)
	result = append(result, wanAddrs...)
	result = append(result, relayAddrs...)
	return result
}

func isPrivateLANAddr(ma string) bool {
	return strings.Contains(ma, "/ip4/192.168.") ||
		strings.Contains(ma, "/ip4/10.") ||
		strings.Contains(ma, "/ip4/172.16.") ||
		strings.Contains(ma, "/ip4/172.17.") ||
		strings.Contains(ma, "/ip4/172.18.") ||
		strings.Contains(ma, "/ip4/172.19.") ||
		strings.Contains(ma, "/ip4/172.2") ||
		strings.Contains(ma, "/ip4/172.30.") ||
		strings.Contains(ma, "/ip4/172.31.") ||
		strings.Contains(ma, "/ip4/169.254.")
}
