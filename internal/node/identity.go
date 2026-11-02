package node

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"

	"github.com/libp2p/go-libp2p/core/crypto"
)

// LoadOrCreateIdentity loads a persistent Ed25519 key or creates one (0600).
func LoadOrCreateIdentity(path string) (crypto.PrivKey, error) {
	if path == "" {
		return nil, fmt.Errorf("identity path is empty")
	}
	if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
		if k, err := crypto.UnmarshalPrivateKey(data); err == nil {
			return k, nil
		}
		// keep the unreadable key for forensics instead of silently overwriting it
		_ = os.Rename(path, path+".broken")
	}
	k, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		return nil, err
	}
	raw, err := crypto.MarshalPrivateKey(k)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	return k, nil
}
