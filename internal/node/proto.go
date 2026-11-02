package node

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// libp2p protocol IDs of Zvonochek 3.
const (
	ProtoControl = "/zvonochek/3/control"
	ProtoFile    = "/zvonochek/3/file"
	ProtoVoice   = "/zvonochek/3/voice"
	MDNSService  = "zvonochek3"
	dhtNSPrefix  = "zvonochek/3/peer/"
)

// Frame limits.
const (
	maxControlFrame = 256 << 10 // SDP blobs are ~10 KB, chat text is capped far below this
	maxVoiceFrame   = 4 << 10
	maxTextLen      = 16000
	maxNickLen      = 64
)

// Control frame types.
const (
	fHello       = "hello"
	fWhois       = "whois"
	fPairReq     = "pair_req"
	fPairOK      = "pair_ok"
	fPairNo      = "pair_no"
	fMsg         = "msg"
	fRead        = "read"
	fTyping      = "typing"
	fFileOffer   = "file_offer"
	fFileDecline = "file_decline"
	fFileCancel  = "file_cancel"
	fFileStatus  = "file_status"
	fCallInvite  = "call_invite"
	fCallAccept  = "call_accept"
	fCallReject  = "call_reject"
	fCallEnd     = "call_end"
	fCallMode    = "call_mode"
	fRTC         = "rtc"
	fCallPing    = "call_ping"
)

// Ack error codes.
const (
	errNotContact = "not_contact"
	errBusy       = "busy"
	errBadFrame   = "bad_frame"
	errRateLimit  = "rate_limited"
	errUnknown    = "unknown_type"
	errNoCall     = "no_call"
	errRejected   = "rejected"
)

// Frame is one control message.
type Frame struct {
	T  string          `json:"t"`
	ID string          `json:"id,omitempty"`
	TS int64           `json:"ts,omitempty"`
	D  json.RawMessage `json:"d,omitempty"`
}

// Ack answers exactly one Frame.
type Ack struct {
	ID  string          `json:"id,omitempty"`
	OK  bool            `json:"ok"`
	Err string          `json:"err,omitempty"`
	D   json.RawMessage `json:"d,omitempty"`
}

// RemoteError is returned when the peer explicitly refused a frame.
type RemoteError struct{ Code string }

func (e *RemoteError) Error() string { return "peer refused: " + e.Code }

// IsRemote reports whether err is a RemoteError with the given code ("" = any).
func IsRemote(err error, code string) bool {
	var re *RemoteError
	if errors.As(err, &re) {
		return code == "" || re.Code == code
	}
	return false
}

func mkFrame(t, id string, ts int64, payload any) (Frame, error) {
	f := Frame{T: t, ID: id, TS: ts}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return f, err
		}
		f.D = raw
	}
	return f, nil
}

// writeMsg writes a uvarint length-prefixed JSON document.
func writeMsg(w io.Writer, v any, limit int) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(raw) > limit {
		return fmt.Errorf("frame too large: %d bytes", len(raw))
	}
	var hdr [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(hdr[:], uint64(len(raw)))
	buf := make([]byte, 0, n+len(raw))
	buf = append(buf, hdr[:n]...)
	buf = append(buf, raw...)
	_, err = w.Write(buf)
	return err
}

// readMsg reads one length-prefixed JSON document with a hard size limit.
func readMsg(r *bufio.Reader, v any, limit int) error {
	size, err := binary.ReadUvarint(r)
	if err != nil {
		return err
	}
	if size == 0 || size > uint64(limit) {
		return fmt.Errorf("invalid frame size %d", size)
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		return err
	}
	return json.Unmarshal(buf, v)
}

// writeBlob writes a uint16 length-prefixed binary blob (voice frames).
func writeBlob(w io.Writer, b []byte) error {
	if len(b) == 0 || len(b) > maxVoiceFrame {
		return errors.New("invalid blob size")
	}
	buf := make([]byte, 2+len(b))
	binary.BigEndian.PutUint16(buf, uint16(len(b)))
	copy(buf[2:], b)
	_, err := w.Write(buf)
	return err
}

func readBlob(r io.Reader) ([]byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(hdr[:]))
	if n == 0 || n > maxVoiceFrame {
		return nil, errors.New("invalid blob size")
	}
	b := make([]byte, n)
	_, err := io.ReadFull(r, b)
	return b, err
}

// Payloads ---------------------------------------------------------------

type helloPayload struct {
	Nick    string   `json:"nick"`
	Ver     string   `json:"ver"`
	Relays  []string `json:"relays,omitempty"`
	Caps    []string `json:"caps,omitempty"`
	Contact bool     `json:"contact"` // sender considers us an accepted contact
}

type pairReqPayload struct {
	Nick   string   `json:"nick"`
	Ver    string   `json:"ver"`
	Secret string   `json:"secret,omitempty"`
	Relays []string `json:"relays,omitempty"`
}

type pairOKPayload struct {
	Nick   string   `json:"nick"`
	Ver    string   `json:"ver"`
	Relays []string `json:"relays,omitempty"`
}

type msgPayload struct {
	Text string `json:"text"`
}

type readPayload struct {
	IDs []string `json:"ids"`
}

type fileOfferPayload struct {
	TID    string `json:"tid"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Mime   string `json:"mime,omitempty"`
}

type fileRefPayload struct {
	TID   string `json:"tid"`
	State string `json:"state,omitempty"`
	Error string `json:"error,omitempty"`
}

type callPayload struct {
	CID    string          `json:"cid"`
	Video  bool            `json:"video,omitempty"`
	Reason string          `json:"reason,omitempty"`
	Mode   string          `json:"mode,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
}

type fileReq struct {
	TID    string `json:"tid"`
	Offset int64  `json:"offset"`
}

type fileResp struct {
	OK    bool   `json:"ok"`
	Err   string `json:"err,omitempty"`
	Size  int64  `json:"size"`
	Start int64  `json:"start"`
}

// SafetyCode derives a symmetric 12-digit verification code from two peer IDs.
// Both sides display the same value; comparing it over a trusted channel
// (voice, in person) rules out a tampered invite.
func SafetyCode(a, b string) string {
	if a > b {
		a, b = b, a
	}
	sum := sha256.Sum256([]byte("zvonochek-safety-v3|" + a + "|" + b))
	var parts []string
	for i := 0; i < 4; i++ {
		v := (uint32(sum[i*3])<<16 | uint32(sum[i*3+1])<<8 | uint32(sum[i*3+2])) % 1000
		parts = append(parts, fmt.Sprintf("%03d", v))
	}
	return strings.Join(parts, " ")
}

func clampText(s string, n int) string {
	s = strings.ToValidUTF8(s, "")
	if len(s) <= n {
		return s
	}
	// cut on rune boundary
	cut := n
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut]
}

func cleanNick(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || r == 0x7f || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(clampText(s, maxNickLen))
}
