package node

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zvonochek2/internal/store"
)

// Integration tests run real libp2p hosts on 127.0.0.1 (no internet, no mDNS).

type tnode struct {
	*Node
	dir string
}

func newTestNode(t *testing.T, nick string) *tnode {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.UpdateSettings(func(s *store.Settings) {
		s.Nickname = nick
		s.DownloadsDir = filepath.Join(dir, "downloads")
		s.P2PPort = 0
	})
	n, err := New(Options{Store: st, IdentityPath: filepath.Join(dir, "identity.key"), NoInternet: true, NoLAN: true, LoopbackOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = n.Close(); st.Close() })
	return &tnode{Node: n, dir: dir}
}

func eventually(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for: %s", what)
}

// pair makes a and b mutual contacts via an invite code of a.
func pair(t *testing.T, a, b *tnode) {
	t.Helper()
	code, _, err := a.Invite(false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cv, err := b.AddContact(ctx, code)
	if err != nil {
		t.Fatalf("AddContact: %v", err)
	}
	if cv.State != store.ContactAccepted {
		t.Fatalf("invite must give an accepted contact, got %q", cv.State)
	}
	if !cv.Presence.Online {
		t.Fatal("returned contact view must already be online")
	}
	eventually(t, "a accepts b", 10*time.Second, func() bool {
		c, ok := a.Store().Contact(b.ID().String())
		return ok && c.State == store.ContactAccepted
	})
}

func TestPairingAndChat(t *testing.T) {
	a, b := newTestNode(t, "Анна"), newTestNode(t, "Борис")
	pair(t, a, b)

	ca, _ := b.Store().Contact(a.ID().String())
	if ca.Name != "Анна" {
		t.Fatalf("nickname not exchanged: %q", ca.Name)
	}
	if SafetyCode(a.ID().String(), b.ID().String()) != SafetyCode(b.ID().String(), a.ID().String()) {
		t.Fatal("safety codes differ")
	}

	events, unsub := a.Subscribe()
	defer unsub()
	m, err := b.SendText(a.ID().String(), "Привет из теста")
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "message stored at a", 10*time.Second, func() bool {
		got, ok := a.Store().Message(b.ID().String(), m.ID)
		return ok && got.Text == "Привет из теста" && !got.Out && got.Status == store.StatusReceived
	})
	eventually(t, "delivered at b", 10*time.Second, func() bool {
		got, _ := b.Store().Message(a.ID().String(), m.ID)
		return got.Status == store.StatusDelivered
	})
	// a must have announced both the message and the refreshed contact summary
	sawMsg, sawContact := false, false
	timeout := time.After(3 * time.Second)
	for !(sawMsg && sawContact) {
		select {
		case ev := <-events:
			switch ev.Type {
			case "message":
				sawMsg = true
			case "contact":
				if v, ok := ev.Data.(ContactView); ok && v.Summary.Unread == 1 {
					sawContact = true
				}
			}
		case <-timeout:
			t.Fatalf("events missing: message=%v contact=%v", sawMsg, sawContact)
		}
	}

	a.MarkRead(b.ID().String())
	eventually(t, "read receipt at b", 10*time.Second, func() bool {
		got, _ := b.Store().Message(a.ID().String(), m.ID)
		return got.Status == store.StatusRead
	})
}

func TestOfflineQueue(t *testing.T) {
	a, b := newTestNode(t, "A"), newTestNode(t, "B")
	pair(t, a, b)
	bID := b.ID().String()
	bDir := b.dir
	// stop b, queue a message, start b again from the same profile
	_ = b.Close()
	eventually(t, "a sees b offline", 10*time.Second, func() bool {
		return !a.presence(b.ID()).Online
	})
	m, err := a.SendText(bID, "пока тебя не было")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if got, _ := a.Store().Message(bID, m.ID); got.Status != store.StatusPending {
		t.Fatalf("message must stay pending while offline, got %s", got.Status)
	}
	b.Store().Close()

	st, err := store.Open(bDir)
	if err != nil {
		t.Fatal(err)
	}
	b2, err := New(Options{Store: st, IdentityPath: filepath.Join(bDir, "identity.key"), NoInternet: true, NoLAN: true, LoopbackOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b2.Close(); st.Close() })
	if b2.ID().String() != bID {
		t.Fatal("identity must persist across restarts")
	}
	eventually(t, "queued message delivered after restart", 30*time.Second, func() bool {
		got, ok := b2.Store().Message(a.ID().String(), m.ID)
		return ok && got.Text == "пока тебя не было"
	})
	eventually(t, "status delivered", 10*time.Second, func() bool {
		got, _ := a.Store().Message(bID, m.ID)
		return got.Status == store.StatusDelivered
	})
}

func TestStrangerIsRejected(t *testing.T) {
	a, c := newTestNode(t, "A"), newTestNode(t, "Чужой")
	// c pretends that a is its contact and knows a's address
	c.Store().UpsertContact(a.ID().String(), func(ct *store.Contact, _ bool) {
		ct.State = store.ContactAccepted
		for _, ad := range a.Host().Addrs() {
			ct.Addrs = append(ct.Addrs, ad.String())
		}
	})
	c.rememberAddrs(a.ID(), c.mustContact(t, a.ID().String()).Addrs, nil)
	m, err := c.SendText(a.ID().String(), "спам")
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "message refused", 20*time.Second, func() bool {
		got, _ := c.Store().Message(a.ID().String(), m.ID)
		return got.Status == store.StatusFailed
	})
	if msgs := a.Store().Messages(c.ID().String(), 0, 10); len(msgs) != 0 {
		t.Fatal("a stored a message from a stranger")
	}
	if _, err := c.StartCall(context.Background(), a.ID().String(), false); err == nil {
		t.Fatal("stranger call must be refused")
	}
	if _, ok := a.CurrentCall(); ok {
		t.Fatal("a must not ring for a stranger")
	}
}

func (n *tnode) mustContact(t *testing.T, id string) store.Contact {
	c, ok := n.Store().Contact(id)
	if !ok {
		t.Fatalf("contact %s missing", id)
	}
	return c
}

func TestFileTransferIntegrity(t *testing.T) {
	a, b := newTestNode(t, "A"), newTestNode(t, "B")
	pair(t, a, b)
	data := make([]byte, 6<<20+12345) // not a multiple of any chunk size
	_, _ = rand.Read(data)
	sum := sha256.Sum256(data)

	m, err := b.OfferFile(a.ID().String(), "../../секретный отчёт.bin", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if m.File.Name != "секретный отчёт.bin" {
		t.Fatalf("name must be sanitised, got %q", m.File.Name)
	}
	if m.File.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("sender hash mismatch")
	}
	var tid string
	eventually(t, "offer at a", 10*time.Second, func() bool {
		got, ok := a.Store().Message(b.ID().String(), m.ID)
		if ok && got.File != nil && got.File.State == store.FileOffered {
			tid = got.File.TransferID
			return true
		}
		return false
	})
	if err := a.AcceptFile(b.ID().String(), tid); err != nil {
		t.Fatal(err)
	}
	var path string
	eventually(t, "file received", 30*time.Second, func() bool {
		got, _ := a.Store().Message(b.ID().String(), m.ID)
		if got.File != nil && got.File.State == store.FileDone {
			path = got.File.Path
			return true
		}
		return false
	})
	if !strings.HasPrefix(path, a.DownloadsDir()) {
		t.Fatalf("file saved outside downloads: %s", path)
	}
	recv, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := sha256.Sum256(recv); got != sum {
		t.Fatal("received file differs from the original")
	}
	eventually(t, "sender sees done", 10*time.Second, func() bool {
		got, _ := b.Store().Message(a.ID().String(), m.ID)
		return got.File != nil && got.File.State == store.FileDone
	})
	// a second file with the same name must not overwrite the first one
	m2, err := b.OfferFile(a.ID().String(), "секретный отчёт.bin", bytes.NewReader([]byte("второй")))
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "second offer", 10*time.Second, func() bool {
		got, ok := a.Store().Message(b.ID().String(), m2.ID)
		if ok && got.File != nil {
			tid = got.File.TransferID
		}
		return ok
	})
	if err := a.AcceptFile(b.ID().String(), tid); err != nil {
		t.Fatal(err)
	}
	eventually(t, "second file received", 15*time.Second, func() bool {
		got, _ := a.Store().Message(b.ID().String(), m2.ID)
		return got.File != nil && got.File.State == store.FileDone && got.File.Path != path
	})
	if again, _ := os.ReadFile(path); !bytes.Equal(again, data) {
		t.Fatal("first file was overwritten")
	}
}

func TestDeclineAndCancel(t *testing.T) {
	a, b := newTestNode(t, "A"), newTestNode(t, "B")
	pair(t, a, b)
	m, err := b.OfferFile(a.ID().String(), "x.zip", bytes.NewReader([]byte("zipzip")))
	if err != nil {
		t.Fatal(err)
	}
	var tid string
	eventually(t, "offer", 10*time.Second, func() bool {
		got, ok := a.Store().Message(b.ID().String(), m.ID)
		if ok && got.File != nil {
			tid = got.File.TransferID
		}
		return ok
	})
	if err := a.DeclineFile(b.ID().String(), tid); err != nil {
		t.Fatal(err)
	}
	eventually(t, "sender sees decline", 10*time.Second, func() bool {
		got, _ := b.Store().Message(a.ID().String(), m.ID)
		return got.File != nil && got.File.State == store.FileDeclined && got.File.Path == ""
	})
	staged, _ := os.ReadDir(filepath.Join(b.dir, "outbox"))
	if len(staged) != 0 {
		t.Fatal("staged copy must be removed after decline")
	}
}

func TestCallSignallingAndBridge(t *testing.T) {
	a, b := newTestNode(t, "A"), newTestNode(t, "B")
	pair(t, a, b)
	cv, err := a.StartCall(context.Background(), b.ID().String(), true)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "b rings", 10*time.Second, func() bool {
		c, ok := b.CurrentCall()
		return ok && c.ID == cv.ID && c.State == CallIncoming && c.Video
	})
	// a second call while busy must be refused
	if _, err := b.StartCall(context.Background(), a.ID().String(), false); err == nil {
		t.Fatal("parallel call must be refused")
	}
	if _, err := b.AcceptCall(cv.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "a active", 10*time.Second, func() bool {
		c, ok := a.CurrentCall()
		return ok && c.State == CallActive
	})

	// audio bridge through the libp2p connection
	sendA, _, _, detachA, err := a.VoiceAttach(cv.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer detachA()
	_, recvB, statsB, detachB, err := b.VoiceAttach(cv.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer detachB()
	frame := append([]byte{1, 0, 0, 0, 1}, bytes.Repeat([]byte{0xAB}, 80)...)
	got := make(chan []byte, 1)
	go func() {
		for f := range recvB {
			select {
			case got <- f:
			default:
			}
			return
		}
	}()
	deadline := time.After(10 * time.Second)
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
loop:
	for {
		select {
		case f := <-got:
			if !bytes.Equal(f, frame) {
				t.Fatal("voice frame corrupted")
			}
			break loop
		case <-tick.C:
			sendA(frame)
		case <-deadline:
			t.Fatalf("voice frame not received, stats %+v", statsB())
		}
	}

	if err := a.EndCall(cv.ID, "hangup"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "b ended", 10*time.Second, func() bool {
		_, ok := b.CurrentCall()
		return !ok
	})
	eventually(t, "call logs", 10*time.Second, func() bool {
		la := a.Store().Messages(b.ID().String(), 0, 10)
		lb := b.Store().Messages(a.ID().String(), 0, 10)
		return len(la) == 1 && len(lb) == 1 && la[0].Call != nil && la[0].Call.Result == "answered" && lb[0].Call.Result == "answered"
	})
}

func TestRejectedCall(t *testing.T) {
	a, b := newTestNode(t, "A"), newTestNode(t, "B")
	pair(t, a, b)
	cv, err := a.StartCall(context.Background(), b.ID().String(), false)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "b rings", 10*time.Second, func() bool { _, ok := b.CurrentCall(); return ok })
	if err := b.RejectCall(cv.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "a ended", 10*time.Second, func() bool { _, ok := a.CurrentCall(); return !ok })
	eventually(t, "declined log", 10*time.Second, func() bool {
		la := a.Store().Messages(b.ID().String(), 0, 10)
		return len(la) == 1 && la[0].Call.Result == "declined"
	})
}

func TestRemoveContactStopsTraffic(t *testing.T) {
	a, b := newTestNode(t, "A"), newTestNode(t, "B")
	pair(t, a, b)
	if err := a.RemoveContact(b.ID().String(), true, true); err != nil { // block
		t.Fatal(err)
	}
	m, err := b.SendText(a.ID().String(), "ты тут?")
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "blocked message refused", 20*time.Second, func() bool {
		got, _ := b.Store().Message(a.ID().String(), m.ID)
		return got.Status == store.StatusFailed
	})
	if len(a.Store().Messages(b.ID().String(), 0, 10)) != 0 {
		t.Fatal("blocked contact's message was stored")
	}
}
