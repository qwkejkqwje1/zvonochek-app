package p2p

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
)

// AppVersion is negotiated during the P2P control handshake
const AppVersion = "2.2.0"

// Protocol IDs for Zvonochek 2.2 libp2p streams
const (
	ControlProtocolID = "/zvonochek/control/2.1.0"
	FileProtocolID    = "/zvonochek/file/2.1.0"
	VoiceProtocolID   = "/zvonochek/voice/2.1.0"
	MDNSServiceTag    = "zvonochek-p2p-lan-v2"
)

// VoiceBridgeHeaderSize is 16 bytes: Seq(4) + SentAtMs(8) + DurationMs(2) + PayloadLen(2)
const VoiceBridgeHeaderSize = 16

// MessageType represents the category of P2P control message
type MessageType string

const (
	TypeHandshake      MessageType = "handshake"
	TypeAuthOK         MessageType = "auth_ok"
	TypeAuthReject     MessageType = "auth_reject"
	TypePing           MessageType = "ping"
	TypePong           MessageType = "pong"
	TypeChat           MessageType = "chat"
	TypeSignal         MessageType = "signal"           // WebRTC SDP/ICE with callID & attemptID
	TypeSignalAck      MessageType = "signal_ack"       // Explicit ACK for SDP offer/answer
	TypeCallOffer      MessageType = "call_offer"       // Incoming call request
	TypeCallAccept     MessageType = "call_accept"      // Call accepted
	TypeCallReject     MessageType = "call_reject"      // Call rejected
	TypeCallEnd        MessageType = "call_end"         // Call ended
	TypeRouteSwitch    MessageType = "route_switch"     // Coordinated switch of media route
	TypeRouteSwitchAck MessageType = "route_switch_ack" // Confirmation of media route switch
	TypeFileOffer      MessageType = "file_offer"       // Request permission to send file
	TypeFileAccept     MessageType = "file_accept"      // Recipient approved file transfer
	TypeFileReject     MessageType = "file_reject"      // Recipient declined file transfer
)

// ControlMessage is the envelope sent over the libp2p control stream
type ControlMessage struct {
	Type         MessageType     `json:"type"`
	Version      string          `json:"version,omitempty"`
	MsgID        string          `json:"msg_id,omitempty"`
	CallID       string          `json:"call_id,omitempty"`
	AttemptID    string          `json:"attempt_id,omitempty"`
	Seq          uint64          `json:"seq,omitempty"`
	SenderID     string          `json:"sender_id"`
	Nickname     string          `json:"nickname,omitempty"`
	InviteSecret string          `json:"invite_secret,omitempty"`
	Payload      json.RawMessage `json:"payload,omitempty"`
	Timestamp    int64           `json:"timestamp"`
}

// ChatPayload represents a text message
type ChatPayload struct {
	Text string `json:"text"`
}

// CallOfferPayload contains metadata about an incoming call
type CallOfferPayload struct {
	CallID    string `json:"call_id"`
	AttemptID string `json:"attempt_id"`
	VoiceMode string `json:"voice_mode"` // "webrtc" or "go-bridge"
	HasVideo  bool   `json:"has_video"`
	Nickname  string `json:"nickname"`
	Version   string `json:"version"`
}

// RouteSwitchPayload coordinates switching mediaRoute between both peers
type RouteSwitchPayload struct {
	CallID     string `json:"call_id"`
	AttemptID  string `json:"attempt_id"`
	MediaRoute string `json:"media_route"` // "webrtc-direct", "webrtc-turn", "go-bridge"
	Subtype    string `json:"subtype"`
	Reason     string `json:"reason"`
}

// SignalPayload contains deterministic WebRTC SDP offer/answer or ICE candidate
type SignalPayload struct {
	CallID    string      `json:"call_id"`
	AttemptID string      `json:"attempt_id"`
	Seq       uint64      `json:"seq"`
	Type      string      `json:"type"` // "offer", "answer", "candidate", "ice_restart"
	SDP       string      `json:"sdp,omitempty"`
	Candidate interface{} `json:"candidate,omitempty"`
}

// FileOfferPayload asks the recipient for consent before streaming bytes
type FileOfferPayload struct {
	TransferID string `json:"transfer_id"`
	FileName   string `json:"file_name"`
	FileSize   int64  `json:"file_size"`
	Checksum   string `json:"checksum"` // SHA-256
}

// FileDecisionPayload responds to a FileOfferPayload
type FileDecisionPayload struct {
	TransferID string `json:"transfer_id"`
	Accepted   bool   `json:"accepted"`
	Reason     string `json:"reason,omitempty"`
}

// FileHeader precedes raw bytes on the FileProtocolID stream
type FileHeader struct {
	TransferID string `json:"transfer_id"`
	FileName   string `json:"file_name"`
	FileSize   int64  `json:"file_size"`
	Checksum   string `json:"checksum"`
	Offset     int64  `json:"offset"`
}

// VoiceFrame represents a numbered, timestamped audio frame on /zvonochek/voice/2.1.0
type VoiceFrame struct {
	Seq        uint32
	SentAtMs   int64
	DurationMs uint16
	Payload    []byte
	EnqueuedAt int64 // Local monotonic timestamp (ms) to measure local queue residency
}

// BridgeTelemetry holds dedicated metrics for the Go libp2p Audio Bridge (never mixed with WebRTC getStats)
type BridgeTelemetry struct {
	Active             bool   `json:"active"`
	FramesSent         uint64 `json:"frames_sent"`
	FramesReceived     uint64 `json:"frames_received"`
	FramesDroppedStale uint64 `json:"frames_dropped_stale"`
	SeqGaps            uint64 `json:"seq_gaps"`
	QueueDurationMs    int64  `json:"queue_duration_ms"`
	LastFrameAgeMs     int64  `json:"last_frame_age_ms"`
	StallResets        uint64 `json:"stall_resets"`
}

// WriteVoiceFrame serializes a numbered, timestamped VoiceFrame onto a writer
func WriteVoiceFrame(w io.Writer, f *VoiceFrame) error {
	if len(f.Payload) == 0 || len(f.Payload) > 16384 {
		return errors.New("invalid voice frame payload length")
	}
	var hdr [VoiceBridgeHeaderSize]byte
	binary.BigEndian.PutUint32(hdr[0:4], f.Seq)
	binary.BigEndian.PutUint64(hdr[4:12], uint64(f.SentAtMs))
	binary.BigEndian.PutUint16(hdr[12:14], f.DurationMs)
	binary.BigEndian.PutUint16(hdr[14:16], uint16(len(f.Payload)))

	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(f.Payload)
	return err
}

// ReadVoiceFrame deserializes a VoiceFrame from a reader
func ReadVoiceFrame(r io.Reader) (*VoiceFrame, error) {
	var hdr [VoiceBridgeHeaderSize]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	seq := binary.BigEndian.Uint32(hdr[0:4])
	sentAtMs := int64(binary.BigEndian.Uint64(hdr[4:12]))
	durationMs := binary.BigEndian.Uint16(hdr[12:14])
	payloadLen := binary.BigEndian.Uint16(hdr[14:16])

	if payloadLen == 0 || payloadLen > 16384 {
		return nil, errors.New("invalid voice frame length in stream")
	}
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	return &VoiceFrame{
		Seq:        seq,
		SentAtMs:   sentAtMs,
		DurationMs: durationMs,
		Payload:    payload,
	}, nil
}

// ReadControlMessage decodes a single JSON ControlMessage from the stream
func ReadControlMessage(dec *json.Decoder) (*ControlMessage, error) {
	var msg ControlMessage
	if err := dec.Decode(&msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

// WriteControlMessage writes a JSON-encoded ControlMessage to the stream
func WriteControlMessage(w io.Writer, msg *ControlMessage) error {
	if msg.Version == "" {
		msg.Version = AppVersion
	}
	enc := json.NewEncoder(w)
	return enc.Encode(msg)
}
