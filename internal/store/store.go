// Package store persists settings, contacts and chat history as small JSON
// files inside the profile directory. All writes are atomic (temp file +
// rename) and debounced, so a crash never leaves a half-written file.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// MaxMessagesPerChat bounds history size per contact (oldest are trimmed).
const MaxMessagesPerChat = 20000

// ICEServer mirrors RTCIceServer from the WebRTC API.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// Settings are user preferences of one profile.
type Settings struct {
	Schema             int               `json:"schema"`
	Nickname           string            `json:"nickname"`
	HTTPPort           int               `json:"http_port"`
	P2PPort            int               `json:"p2p_port"`
	InternetDiscovery  bool              `json:"internet_discovery"`
	LANDiscovery       bool              `json:"lan_discovery"`
	Relays             []string          `json:"relays"`
	PublicSTUN         bool              `json:"public_stun"`
	ICEServers         []ICEServer       `json:"ice_servers"`
	DownloadsDir       string            `json:"downloads_dir"`
	AutoAcceptImagesMB int               `json:"auto_accept_images_mb"`
	MaxIncomingMB      int               `json:"max_incoming_mb"`
	OpenWindowOnCall   bool              `json:"open_window_on_call"`
	DesktopNotify      bool              `json:"desktop_notify"`
	UI                 map[string]string `json:"ui"`
	InviteSecret       string            `json:"invite_secret"`
	InviteExpires      int64             `json:"invite_expires"`
}

// Contact states.
const (
	ContactAccepted = "accepted" // mutual contact
	ContactOutgoing = "outgoing" // we asked, waiting for their approval
	ContactIncoming = "incoming" // they asked, waiting for our approval
	ContactBlocked  = "blocked"
)

// Contact is a known peer.
type Contact struct {
	PeerID   string   `json:"peer_id"`
	Name     string   `json:"name"`
	Alias    string   `json:"alias,omitempty"`
	State    string   `json:"state"`
	AddedAt  int64    `json:"added_at"`
	LastSeen int64    `json:"last_seen,omitempty"`
	Addrs    []string `json:"addrs,omitempty"`
	Relays   []string `json:"relays,omitempty"`
	Version  string   `json:"version,omitempty"`
	Verified bool     `json:"verified,omitempty"`
	Muted    bool     `json:"muted,omitempty"`
}

// DisplayName returns alias, nickname or a short peer id.
func (c Contact) DisplayName() string {
	if strings.TrimSpace(c.Alias) != "" {
		return c.Alias
	}
	if strings.TrimSpace(c.Name) != "" {
		return c.Name
	}
	if len(c.PeerID) > 8 {
		return "…" + c.PeerID[len(c.PeerID)-6:]
	}
	return c.PeerID
}

// Message kinds and statuses.
const (
	KindText   = "text"
	KindFile   = "file"
	KindCall   = "call"
	KindSystem = "system"

	StatusPending   = "pending"   // outgoing, not yet acknowledged by the peer
	StatusDelivered = "delivered" // outgoing, stored by the peer
	StatusRead      = "read"      // outgoing read by peer / incoming read by us
	StatusFailed    = "failed"    // outgoing, rejected permanently
	StatusReceived  = "received"  // incoming, not read yet
)

// File transfer states.
const (
	FileOffered      = "offered"
	FileTransferring = "transferring"
	FileDone         = "done"
	FileDeclined     = "declined"
	FileCanceled     = "canceled"
	FileFailed       = "failed"
)

// FileInfo describes a file message.
type FileInfo struct {
	TransferID string `json:"tid"`
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256"`
	Mime       string `json:"mime,omitempty"`
	State      string `json:"state"`
	Done       int64  `json:"done,omitempty"`
	Path       string `json:"path,omitempty"` // local path (staged copy for outgoing, final file for incoming)
	Error      string `json:"error,omitempty"`
}

// CallInfo describes a call log entry.
type CallInfo struct {
	Video    bool   `json:"video"`
	Result   string `json:"result"` // answered|missed|declined|canceled|busy|failed|no_answer
	Duration int64  `json:"duration,omitempty"`
}

// Message is one chat history entry.
type Message struct {
	ID     string    `json:"id"`
	Peer   string    `json:"peer"`
	Out    bool      `json:"out"`
	Kind   string    `json:"kind"`
	Text   string    `json:"text,omitempty"`
	TS     int64     `json:"ts"`
	Status string    `json:"status"`
	File   *FileInfo `json:"file,omitempty"`
	Call   *CallInfo `json:"call,omitempty"`
}

func (m Message) clone() Message {
	if m.File != nil {
		f := *m.File
		m.File = &f
	}
	if m.Call != nil {
		c := *m.Call
		m.Call = &c
	}
	return m
}

type chatLog struct {
	msgs  []*Message
	index map[string]*Message
}

func (l *chatLog) add(m *Message) {
	l.msgs = append(l.msgs, m)
	l.index[m.ID] = m
	// keep chronological order even if a peer's clock is a bit off
	for i := len(l.msgs) - 1; i > 0 && l.msgs[i].TS < l.msgs[i-1].TS; i-- {
		l.msgs[i], l.msgs[i-1] = l.msgs[i-1], l.msgs[i]
	}
	if over := len(l.msgs) - MaxMessagesPerChat; over > 0 {
		for _, old := range l.msgs[:over] {
			delete(l.index, old.ID)
		}
		l.msgs = append([]*Message(nil), l.msgs[over:]...)
	}
}

// Store is safe for concurrent use.
type Store struct {
	dir string

	// Warnings lists problems found while loading (damaged files that were
	// set aside). The caller logs them.
	Warnings []string

	mu            sync.Mutex
	settings      Settings
	contacts      map[string]*Contact
	logs          map[string]*chatLog
	dirtySettings bool
	dirtyContacts bool
	dirtyLogs     map[string]bool

	kick    chan struct{}
	stop    chan struct{}
	stopped chan struct{}
	once    sync.Once
}

// DefaultSettings returns defaults for a fresh profile.
func DefaultSettings() Settings {
	return Settings{
		Schema:             3,
		HTTPPort:           47320,
		P2PPort:            47321,
		InternetDiscovery:  true,
		LANDiscovery:       true,
		PublicSTUN:         true,
		AutoAcceptImagesMB: 15,
		MaxIncomingMB:      8192,
		OpenWindowOnCall:   true,
		DesktopNotify:      true,
		UI:                 map[string]string{},
	}
}

// Open loads (or initialises) the store located in dir.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "history"), 0o700); err != nil {
		return nil, err
	}
	s := &Store{
		dir:       dir,
		settings:  DefaultSettings(),
		contacts:  map[string]*Contact{},
		logs:      map[string]*chatLog{},
		dirtyLogs: map[string]bool{},
		kick:      make(chan struct{}, 1),
		stop:      make(chan struct{}),
		stopped:   make(chan struct{}),
	}
	// A damaged file must not prevent the program from starting: it is kept
	// next to the original (".broken-<time>") for manual recovery.
	if err := readJSON(filepath.Join(dir, "settings.json"), &s.settings); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.settings = DefaultSettings()
		s.Warnings = append(s.Warnings, "settings.json: "+err.Error()+" — "+quarantine(filepath.Join(dir, "settings.json")))
	}
	s.normalizeSettings()
	var contacts []*Contact
	if err := readJSON(filepath.Join(dir, "contacts.json"), &contacts); err != nil && !errors.Is(err, os.ErrNotExist) {
		contacts = nil
		s.Warnings = append(s.Warnings, "contacts.json: "+err.Error()+" — "+quarantine(filepath.Join(dir, "contacts.json")))
	}
	for _, c := range contacts {
		if c != nil && c.PeerID != "" {
			s.contacts[c.PeerID] = c
		}
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "history"))
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		peer := strings.TrimSuffix(name, ".json")
		var msgs []*Message
		if err := readJSON(filepath.Join(dir, "history", name), &msgs); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				s.Warnings = append(s.Warnings, "history/"+name+": "+err.Error()+" — "+quarantine(filepath.Join(dir, "history", name)))
			}
			continue
		}
		l := &chatLog{index: map[string]*Message{}}
		for _, m := range msgs {
			if m != nil && m.ID != "" && l.index[m.ID] == nil {
				m.Peer = peer
				l.add(m)
			}
		}
		s.logs[peer] = l
	}
	s.dirtySettings = true
	go s.saver()
	s.signal()
	return s, nil
}

func (s *Store) normalizeSettings() {
	d := DefaultSettings()
	st := &s.settings
	if st.Schema < 3 {
		st.Schema = 3
	}
	if st.HTTPPort <= 0 || st.HTTPPort > 65535 {
		st.HTTPPort = d.HTTPPort
	}
	if st.P2PPort < 0 || st.P2PPort > 65535 {
		st.P2PPort = d.P2PPort
	}
	if st.MaxIncomingMB <= 0 {
		st.MaxIncomingMB = d.MaxIncomingMB
	}
	if st.AutoAcceptImagesMB < 0 {
		st.AutoAcceptImagesMB = 0
	}
	if st.UI == nil {
		st.UI = map[string]string{}
	}
}

// Dir returns the profile directory.
func (s *Store) Dir() string { return s.dir }

// Settings returns a deep copy of the current settings.
func (s *Store) Settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return copySettings(s.settings)
}

func copySettings(in Settings) Settings {
	out := in
	out.Relays = append([]string(nil), in.Relays...)
	out.ICEServers = nil
	for _, srv := range in.ICEServers {
		srv.URLs = append([]string(nil), srv.URLs...)
		out.ICEServers = append(out.ICEServers, srv)
	}
	out.UI = make(map[string]string, len(in.UI))
	for k, v := range in.UI {
		out.UI[k] = v
	}
	return out
}

// UpdateSettings applies fn atomically and schedules a save.
func (s *Store) UpdateSettings(fn func(*Settings)) Settings {
	s.mu.Lock()
	fn(&s.settings)
	s.normalizeSettings()
	s.dirtySettings = true
	out := copySettings(s.settings)
	s.mu.Unlock()
	s.signal()
	return out
}

// Contacts returns all contacts sorted by name.
func (s *Store) Contacts() []Contact {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Contact, 0, len(s.contacts))
	for _, c := range s.contacts {
		out = append(out, copyContact(c))
	}
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].DisplayName()) < strings.ToLower(out[j].DisplayName())
	})
	return out
}

func copyContact(c *Contact) Contact {
	out := *c
	out.Addrs = append([]string(nil), c.Addrs...)
	out.Relays = append([]string(nil), c.Relays...)
	return out
}

// Contact returns one contact.
func (s *Store) Contact(id string) (Contact, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.contacts[id]
	if !ok {
		return Contact{}, false
	}
	return copyContact(c), true
}

// UpsertContact creates the contact if missing and applies fn.
func (s *Store) UpsertContact(id string, fn func(c *Contact, created bool)) Contact {
	s.mu.Lock()
	c, ok := s.contacts[id]
	if !ok {
		c = &Contact{PeerID: id, AddedAt: time.Now().UnixMilli()}
		s.contacts[id] = c
	}
	fn(c, !ok)
	c.PeerID = id
	s.dirtyContacts = true
	out := copyContact(c)
	s.mu.Unlock()
	s.signal()
	return out
}

// UpdateContact applies fn to an existing contact.
func (s *Store) UpdateContact(id string, fn func(c *Contact)) (Contact, bool) {
	s.mu.Lock()
	c, ok := s.contacts[id]
	if !ok {
		s.mu.Unlock()
		return Contact{}, false
	}
	fn(c)
	s.dirtyContacts = true
	out := copyContact(c)
	s.mu.Unlock()
	s.signal()
	return out, true
}

// DeleteContact removes a contact and (optionally) its history.
func (s *Store) DeleteContact(id string, purgeHistory bool) {
	s.mu.Lock()
	delete(s.contacts, id)
	s.dirtyContacts = true
	if purgeHistory {
		delete(s.logs, id)
		delete(s.dirtyLogs, id)
	}
	s.mu.Unlock()
	if purgeHistory {
		_ = os.Remove(s.historyPath(id))
	}
	s.signal()
}

func (s *Store) historyPath(peer string) string {
	return filepath.Join(s.dir, "history", safeFileComponent(peer)+".json")
}

func safeFileComponent(v string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, v)
}

func (s *Store) logFor(peer string) *chatLog {
	l, ok := s.logs[peer]
	if !ok {
		l = &chatLog{index: map[string]*Message{}}
		s.logs[peer] = l
	}
	return l
}

// AddMessage appends a message; returns false if a message with this ID exists.
func (s *Store) AddMessage(m Message) bool {
	if m.ID == "" || m.Peer == "" {
		return false
	}
	s.mu.Lock()
	l := s.logFor(m.Peer)
	if l.index[m.ID] != nil {
		s.mu.Unlock()
		return false
	}
	cp := m.clone()
	l.add(&cp)
	s.dirtyLogs[m.Peer] = true
	s.mu.Unlock()
	s.signal()
	return true
}

// UpdateMessage applies fn to a message.
func (s *Store) UpdateMessage(peer, id string, fn func(m *Message)) (Message, bool) {
	s.mu.Lock()
	l, ok := s.logs[peer]
	if !ok || l.index[id] == nil {
		s.mu.Unlock()
		return Message{}, false
	}
	m := l.index[id]
	fn(m)
	s.dirtyLogs[peer] = true
	out := m.clone()
	s.mu.Unlock()
	s.signal()
	return out, true
}

// Message returns a single message.
func (s *Store) Message(peer, id string) (Message, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if l, ok := s.logs[peer]; ok && l.index[id] != nil {
		return l.index[id].clone(), true
	}
	return Message{}, false
}

// DeleteMessage removes a message locally.
func (s *Store) DeleteMessage(peer, id string) bool {
	s.mu.Lock()
	defer func() { s.mu.Unlock(); s.signal() }()
	l, ok := s.logs[peer]
	if !ok || l.index[id] == nil {
		return false
	}
	delete(l.index, id)
	for i, m := range l.msgs {
		if m.ID == id {
			l.msgs = append(l.msgs[:i], l.msgs[i+1:]...)
			break
		}
	}
	s.dirtyLogs[peer] = true
	return true
}

// ClearHistory deletes all messages with peer.
func (s *Store) ClearHistory(peer string) {
	s.mu.Lock()
	s.logs[peer] = &chatLog{index: map[string]*Message{}}
	s.dirtyLogs[peer] = true
	s.mu.Unlock()
	s.signal()
}

// Messages returns up to limit messages older than beforeTS (0 = newest), oldest first.
func (s *Store) Messages(peer string, beforeTS int64, limit int) []Message {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.logs[peer]
	if !ok {
		return []Message{}
	}
	end := len(l.msgs)
	if beforeTS > 0 {
		end = sort.Search(len(l.msgs), func(i int) bool { return l.msgs[i].TS >= beforeTS })
	}
	start := end - limit
	if start < 0 {
		start = 0
	}
	out := make([]Message, 0, end-start)
	for _, m := range l.msgs[start:end] {
		out = append(out, m.clone())
	}
	return out
}

// Find returns all messages matching pred (across all chats).
func (s *Store) Find(pred func(m *Message) bool) []Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Message
	for _, l := range s.logs {
		for _, m := range l.msgs {
			if pred(m) {
				out = append(out, m.clone())
			}
		}
	}
	return out
}

// FindByTransfer locates a file message by transfer id.
func (s *Store) FindByTransfer(tid string) (Message, bool) {
	res := s.Find(func(m *Message) bool { return m.File != nil && m.File.TransferID == tid })
	if len(res) == 0 {
		return Message{}, false
	}
	return res[0], true
}

// ChatSummary is used for the contact list.
type ChatSummary struct {
	Unread int      `json:"unread"`
	Last   *Message `json:"last,omitempty"`
}

// Summary returns unread count and last message for a peer.
func (s *Store) Summary(peer string) ChatSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out ChatSummary
	l, ok := s.logs[peer]
	if !ok {
		return out
	}
	for i := len(l.msgs) - 1; i >= 0; i-- {
		m := l.msgs[i]
		if out.Last == nil && m.Kind != KindSystem {
			cp := m.clone()
			out.Last = &cp
		}
		if !m.Out && m.Status == StatusReceived {
			out.Unread++
		}
	}
	return out
}

// MarkRead marks incoming messages as read and returns their ids.
func (s *Store) MarkRead(peer string) []string {
	s.mu.Lock()
	var ids []string
	if l, ok := s.logs[peer]; ok {
		for _, m := range l.msgs {
			if !m.Out && m.Status == StatusReceived {
				m.Status = StatusRead
				ids = append(ids, m.ID)
			}
		}
	}
	if len(ids) > 0 {
		s.dirtyLogs[peer] = true
	}
	s.mu.Unlock()
	if len(ids) > 0 {
		s.signal()
	}
	return ids
}

func (s *Store) signal() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *Store) saver() {
	defer close(s.stopped)
	for {
		select {
		case <-s.stop:
			s.flush()
			return
		case <-s.kick:
			// debounce bursts (e.g. file progress updates)
			select {
			case <-time.After(400 * time.Millisecond):
			case <-s.stop:
			}
			s.flush()
		}
	}
}

// Flush writes all dirty data synchronously.
func (s *Store) Flush() { s.flush() }

func (s *Store) flush() {
	s.mu.Lock()
	var settings *Settings
	if s.dirtySettings {
		cp := copySettings(s.settings)
		settings = &cp
		s.dirtySettings = false
	}
	var contacts []Contact
	saveContacts := s.dirtyContacts
	if saveContacts {
		for _, c := range s.contacts {
			contacts = append(contacts, copyContact(c))
		}
		sort.Slice(contacts, func(i, j int) bool { return contacts[i].AddedAt < contacts[j].AddedAt })
		s.dirtyContacts = false
	}
	logs := map[string][]Message{}
	for peer := range s.dirtyLogs {
		l, ok := s.logs[peer]
		if !ok {
			continue
		}
		msgs := make([]Message, 0, len(l.msgs))
		for _, m := range l.msgs {
			msgs = append(msgs, m.clone())
		}
		logs[peer] = msgs
	}
	s.dirtyLogs = map[string]bool{}
	s.mu.Unlock()

	if settings != nil {
		if err := writeJSON(filepath.Join(s.dir, "settings.json"), settings); err != nil {
			s.markDirtySettings()
		}
	}
	if saveContacts {
		if contacts == nil {
			contacts = []Contact{}
		}
		if err := writeJSON(filepath.Join(s.dir, "contacts.json"), contacts); err != nil {
			s.mu.Lock()
			s.dirtyContacts = true
			s.mu.Unlock()
		}
	}
	for peer, msgs := range logs {
		if err := writeJSON(s.historyPath(peer), msgs); err != nil {
			s.mu.Lock()
			s.dirtyLogs[peer] = true
			s.mu.Unlock()
		}
	}
}

func (s *Store) markDirtySettings() {
	s.mu.Lock()
	s.dirtySettings = true
	s.mu.Unlock()
}

// Close flushes and stops the background saver.
func (s *Store) Close() {
	s.once.Do(func() {
		close(s.stop)
		<-s.stopped
	})
}

// quarantine renames a damaged file so that it is not overwritten.
func quarantine(path string) string {
	dst := fmt.Sprintf("%s.broken-%s", path, time.Now().Format("20060102-150405"))
	if err := os.Rename(path, dst); err != nil {
		return "не удалось сохранить копию: " + err.Error()
	}
	return "копия сохранена в " + filepath.Base(dst)
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return os.ErrNotExist
	}
	return json.Unmarshal(data, v)
}

// WriteFileAtomic writes data to path via a temp file + rename.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	_ = os.Chmod(tmpName, perm)
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, data, 0o600)
}
