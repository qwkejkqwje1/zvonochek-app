package node

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

// InvitePrefix starts every invite code.
const InvitePrefix = "zv3:"

const inviteVersion = 1

// Invite is the decoded content of an invite code. Binary layout (then base64url):
//
//	ver(1) | pidLen(1) pid | secret(16) | expires(u32 unix) | nickLen(1) nick |
//	n(1) { len(2) multiaddr-bytes }* | sha256-prefix(4)
type Invite struct {
	PeerID  peer.ID
	Secret  string // hex, 32 chars
	Expires time.Time
	Nick    string
	Addrs   []ma.Multiaddr
}

// NewSecret returns 16 random bytes as hex.
func NewSecret() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// EncodeInvite serialises an invite to a compact zv3: code.
func EncodeInvite(inv Invite) (string, error) {
	secret, err := hex.DecodeString(inv.Secret)
	if err != nil || len(secret) != 16 {
		return "", errors.New("invalid invite secret")
	}
	pid := []byte(inv.PeerID)
	if len(pid) == 0 || len(pid) > 255 {
		return "", errors.New("invalid peer id")
	}
	nick := []byte(clampText(inv.Nick, maxNickLen))
	var buf bytes.Buffer
	buf.WriteByte(inviteVersion)
	buf.WriteByte(byte(len(pid)))
	buf.Write(pid)
	buf.Write(secret)
	var u32 [4]byte
	binary.BigEndian.PutUint32(u32[:], uint32(inv.Expires.Unix()))
	buf.Write(u32[:])
	buf.WriteByte(byte(len(nick)))
	buf.Write(nick)
	addrs := inv.Addrs
	if len(addrs) > 12 {
		addrs = addrs[:12]
	}
	buf.WriteByte(byte(len(addrs)))
	for _, a := range addrs {
		b := a.Bytes()
		var u16 [2]byte
		binary.BigEndian.PutUint16(u16[:], uint16(len(b)))
		buf.Write(u16[:])
		buf.Write(b)
	}
	sum := sha256.Sum256(buf.Bytes())
	buf.Write(sum[:4])
	return InvitePrefix + base64.RawURLEncoding.EncodeToString(buf.Bytes()), nil
}

// ErrInviteExpired is returned for outdated invites.
var ErrInviteExpired = errors.New("срок действия приглашения истёк — попросите новый код")

// DecodeInvite parses a zv3: code. Whitespace and line breaks are ignored,
// so codes mangled by messengers still work.
func DecodeInvite(code string) (*Invite, error) {
	code = strings.Join(strings.Fields(code), "")
	code = strings.Trim(code, "\"'`<>")
	lower := strings.ToLower(code)
	if !strings.HasPrefix(lower, InvitePrefix) {
		if strings.HasPrefix(lower, "zv2:") {
			return nil, errors.New("это приглашение от старой версии Звоночка 2.x — попросите собеседника обновиться до 3.0")
		}
		return nil, errors.New("код приглашения должен начинаться с zv3:")
	}
	raw, err := base64.RawURLEncoding.DecodeString(code[len(InvitePrefix):])
	if err != nil {
		return nil, errors.New("код приглашения повреждён (скопируйте его целиком)")
	}
	if len(raw) < 1+1+16+4+1+1+4 {
		return nil, errors.New("код приглашения слишком короткий")
	}
	body, check := raw[:len(raw)-4], raw[len(raw)-4:]
	sum := sha256.Sum256(body)
	if !bytes.Equal(sum[:4], check) {
		return nil, errors.New("код приглашения повреждён (контрольная сумма не совпала)")
	}
	r := bytes.NewReader(body)
	ver, _ := r.ReadByte()
	if ver != inviteVersion {
		return nil, errors.New("неподдерживаемая версия приглашения — обновите Звоночек")
	}
	readN := func(n int) ([]byte, error) {
		b := make([]byte, n)
		if _, err := io.ReadFull(r, b); err != nil {
			return nil, errors.New("код приглашения повреждён")
		}
		return b, nil
	}
	pl, err := r.ReadByte()
	if err != nil || pl == 0 {
		return nil, errors.New("код приглашения повреждён")
	}
	pidb, err := readN(int(pl))
	if err != nil {
		return nil, err
	}
	pid, err := peer.IDFromBytes(pidb)
	if err != nil {
		return nil, errors.New("некорректный идентификатор в приглашении")
	}
	secret, err := readN(16)
	if err != nil {
		return nil, err
	}
	expb, err := readN(4)
	if err != nil {
		return nil, err
	}
	inv := &Invite{PeerID: pid, Secret: hex.EncodeToString(secret), Expires: time.Unix(int64(binary.BigEndian.Uint32(expb)), 0)}
	nl, err := r.ReadByte()
	if err != nil {
		return nil, errors.New("код приглашения повреждён")
	}
	if nl > 0 {
		nb, err := readN(int(nl))
		if err != nil {
			return nil, err
		}
		inv.Nick = cleanNick(string(nb))
	}
	count, err := r.ReadByte()
	if err != nil {
		return nil, errors.New("код приглашения повреждён")
	}
	for i := 0; i < int(count); i++ {
		lb, err := readN(2)
		if err != nil {
			return nil, err
		}
		l := int(binary.BigEndian.Uint16(lb))
		if l == 0 || l > 1024 {
			return nil, errors.New("код приглашения повреждён")
		}
		ab, err := readN(l)
		if err != nil {
			return nil, err
		}
		a, err := ma.NewMultiaddrBytes(ab)
		if err != nil {
			continue // unknown transport from a newer version: skip
		}
		inv.Addrs = append(inv.Addrs, a)
	}
	if time.Now().After(inv.Expires) {
		return inv, ErrInviteExpired
	}
	return inv, nil
}
