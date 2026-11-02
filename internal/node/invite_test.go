package node

import (
	"crypto/rand"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

func testPeerID(t *testing.T) peer.ID {
	t.Helper()
	_, pub, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id, err := peer.IDFromPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func testInvite(t *testing.T, exp time.Time) (Invite, string) {
	t.Helper()
	inv := Invite{
		PeerID:  testPeerID(t),
		Secret:  NewSecret(),
		Expires: exp.Truncate(time.Second),
		Nick:    "Анна",
		Addrs: []ma.Multiaddr{
			ma.StringCast("/ip4/192.168.1.10/tcp/47321"),
			ma.StringCast("/ip4/10.0.2.2/udp/47321/quic-v1"),
		},
	}
	code, err := EncodeInvite(inv)
	if err != nil {
		t.Fatal(err)
	}
	return inv, code
}

func TestInviteRoundTrip(t *testing.T) {
	inv, code := testInvite(t, time.Now().Add(InviteTTL))
	if !strings.HasPrefix(code, InvitePrefix) {
		t.Fatalf("bad prefix: %s", code)
	}
	got, err := DecodeInvite(code)
	if err != nil {
		t.Fatal(err)
	}
	if got.PeerID != inv.PeerID || got.Secret != inv.Secret || got.Nick != inv.Nick || !got.Expires.Equal(inv.Expires) || len(got.Addrs) != 2 {
		t.Fatalf("mismatch: %+v vs %+v", got, inv)
	}
	if !got.Addrs[1].Equal(inv.Addrs[1]) {
		t.Fatal("address mismatch")
	}
}

func TestInviteSurvivesMessengerMangling(t *testing.T) {
	_, code := testInvite(t, time.Now().Add(time.Hour))
	mangled := "  «" + code[:20] + "\n" + code[20:40] + " \r\n" + code[40:] + "»  "
	mangled = strings.NewReplacer("«", "", "»", "").Replace(mangled)
	if _, err := DecodeInvite(mangled); err != nil {
		t.Fatalf("line breaks/spaces must be ignored: %v", err)
	}
	if _, err := DecodeInvite(`"` + strings.ToUpper(code[:4]) + code[4:] + `"`); err != nil {
		t.Fatalf("quotes / prefix case must be tolerated: %v", err)
	}
}

func TestInviteTamperDetected(t *testing.T) {
	_, code := testInvite(t, time.Now().Add(time.Hour))
	b := []byte(code)
	i := len(InvitePrefix) + 10
	if b[i] == 'A' {
		b[i] = 'B'
	} else {
		b[i] = 'A'
	}
	if _, err := DecodeInvite(string(b)); err == nil {
		t.Fatal("tampered code must be rejected")
	}
	if _, err := DecodeInvite(code[:len(code)-6]); err == nil {
		t.Fatal("truncated code must be rejected")
	}
}

func TestInviteExpiredAndLegacy(t *testing.T) {
	_, code := testInvite(t, time.Now().Add(-time.Minute))
	if _, err := DecodeInvite(code); !errors.Is(err, ErrInviteExpired) {
		t.Fatalf("want ErrInviteExpired, got %v", err)
	}
	if _, err := DecodeInvite("zv2:abcdef"); err == nil || !strings.Contains(err.Error(), "2.x") {
		t.Fatalf("legacy codes need a clear message, got %v", err)
	}
	if _, err := DecodeInvite("hello"); err == nil {
		t.Fatal("garbage must be rejected")
	}
}

func TestEncodeInviteValidation(t *testing.T) {
	if _, err := EncodeInvite(Invite{PeerID: testPeerID(t), Secret: "short"}); err == nil {
		t.Fatal("invalid secret must be refused")
	}
	if _, err := EncodeInvite(Invite{Secret: NewSecret()}); err == nil {
		t.Fatal("empty peer id must be refused")
	}
}
