package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func open(t *testing.T, dir string) *Store {
	t.Helper()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func TestPersistRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	s.UpdateSettings(func(st *Settings) { st.Nickname = "Анна"; st.UI["theme"] = "light" })
	s.UpsertContact("peerA", func(c *Contact, created bool) {
		if !created {
			t.Error("expected new contact")
		}
		c.Name, c.State = "Борис", ContactAccepted
	})
	for i := 0; i < 5; i++ {
		s.AddMessage(Message{ID: fmt.Sprintf("m%d", i), Peer: "peerA", Kind: KindText, Text: "привет", TS: int64(1000 + i), Status: StatusReceived})
	}
	s.Close()

	s2 := open(t, dir)
	defer s2.Close()
	if st := s2.Settings(); st.Nickname != "Анна" || st.UI["theme"] != "light" {
		t.Fatalf("settings not persisted: %+v", st)
	}
	c, ok := s2.Contact("peerA")
	if !ok || c.Name != "Борис" || c.State != ContactAccepted {
		t.Fatalf("contact not persisted: %+v", c)
	}
	if got := len(s2.Messages("peerA", 0, 100)); got != 5 {
		t.Fatalf("want 5 messages, got %d", got)
	}
	if sum := s2.Summary("peerA"); sum.Unread != 5 || sum.Last == nil || sum.Last.ID != "m4" {
		t.Fatalf("bad summary: %+v", sum)
	}
}

func TestAddMessageDedupAndOrder(t *testing.T) {
	s := open(t, t.TempDir())
	defer s.Close()
	if !s.AddMessage(Message{ID: "a", Peer: "p", TS: 30}) {
		t.Fatal("first add failed")
	}
	if s.AddMessage(Message{ID: "a", Peer: "p", TS: 31}) {
		t.Fatal("duplicate id must be rejected (peers re-send after reconnect)")
	}
	s.AddMessage(Message{ID: "b", Peer: "p", TS: 10}) // peer clock behind
	s.AddMessage(Message{ID: "c", Peer: "p", TS: 20})
	var ids []string
	for _, m := range s.Messages("p", 0, 10) {
		ids = append(ids, m.ID)
	}
	if strings.Join(ids, ",") != "b,c,a" {
		t.Fatalf("messages must be sorted by time, got %v", ids)
	}
	if s.AddMessage(Message{ID: "", Peer: "p"}) || s.AddMessage(Message{ID: "x"}) {
		t.Fatal("messages without id/peer must be rejected")
	}
}

func TestPagination(t *testing.T) {
	s := open(t, t.TempDir())
	defer s.Close()
	for i := 1; i <= 50; i++ {
		s.AddMessage(Message{ID: fmt.Sprint(i), Peer: "p", TS: int64(i)})
	}
	last := s.Messages("p", 0, 10)
	if len(last) != 10 || last[0].TS != 41 || last[9].TS != 50 {
		t.Fatalf("newest page wrong: %d..%d", last[0].TS, last[len(last)-1].TS)
	}
	older := s.Messages("p", last[0].TS, 10)
	if len(older) != 10 || older[0].TS != 31 || older[9].TS != 40 {
		t.Fatalf("older page wrong")
	}
	if got := s.Messages("nobody", 0, 10); got == nil || len(got) != 0 {
		t.Fatal("unknown chat must return an empty (non-nil) slice")
	}
}

func TestHistoryLimit(t *testing.T) {
	s := open(t, t.TempDir())
	defer s.Close()
	for i := 0; i < MaxMessagesPerChat+25; i++ {
		s.AddMessage(Message{ID: fmt.Sprint(i), Peer: "p", TS: int64(i)})
	}
	all := s.Messages("p", 0, 1000)
	if all[len(all)-1].ID != fmt.Sprint(MaxMessagesPerChat+24) {
		t.Fatal("newest message lost")
	}
	if _, ok := s.Message("p", "0"); ok {
		t.Fatal("oldest messages must be trimmed")
	}
	// a trimmed id may be stored again only as a new message; the index must stay consistent
	if !s.AddMessage(Message{ID: "0", Peer: "p", TS: 1 << 40}) {
		t.Fatal("index kept a trimmed message")
	}
}

func TestMarkReadAndStatus(t *testing.T) {
	s := open(t, t.TempDir())
	defer s.Close()
	s.AddMessage(Message{ID: "in1", Peer: "p", TS: 1, Status: StatusReceived})
	s.AddMessage(Message{ID: "out1", Peer: "p", TS: 2, Out: true, Status: StatusPending})
	s.AddMessage(Message{ID: "in2", Peer: "p", TS: 3, Status: StatusReceived})
	ids := s.MarkRead("p")
	if strings.Join(ids, ",") != "in1,in2" {
		t.Fatalf("MarkRead returned %v", ids)
	}
	if again := s.MarkRead("p"); len(again) != 0 {
		t.Fatal("second MarkRead must be empty")
	}
	m, ok := s.UpdateMessage("p", "out1", func(m *Message) { m.Status = StatusDelivered })
	if !ok || m.Status != StatusDelivered {
		t.Fatal("UpdateMessage failed")
	}
	if _, ok := s.UpdateMessage("p", "missing", func(*Message) {}); ok {
		t.Fatal("update of a missing message must fail")
	}
}

func TestCloneIsolation(t *testing.T) {
	s := open(t, t.TempDir())
	defer s.Close()
	s.AddMessage(Message{ID: "f", Peer: "p", Kind: KindFile, File: &FileInfo{TransferID: "t1", Name: "a.txt", State: FileOffered}})
	m, _ := s.Message("p", "f")
	m.File.State = FileDone // must not leak into the store
	again, _ := s.Message("p", "f")
	if again.File.State != FileOffered {
		t.Fatal("returned messages must be deep copies")
	}
	if got, ok := s.FindByTransfer("t1"); !ok || got.ID != "f" {
		t.Fatal("FindByTransfer failed")
	}
}

func TestDeleteAndClear(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	s.UpsertContact("p", func(c *Contact, _ bool) { c.State = ContactAccepted })
	s.AddMessage(Message{ID: "1", Peer: "p", TS: 1})
	s.AddMessage(Message{ID: "2", Peer: "p", TS: 2})
	if !s.DeleteMessage("p", "1") || s.DeleteMessage("p", "1") {
		t.Fatal("DeleteMessage semantics")
	}
	s.ClearHistory("p")
	if len(s.Messages("p", 0, 10)) != 0 {
		t.Fatal("ClearHistory left messages")
	}
	s.AddMessage(Message{ID: "3", Peer: "p", TS: 3})
	s.Flush()
	s.DeleteContact("p", true)
	s.Close()
	if _, err := os.Stat(filepath.Join(dir, "history", "p.json")); !os.IsNotExist(err) {
		t.Fatal("purged history file still exists")
	}
	s2 := open(t, dir)
	defer s2.Close()
	if _, ok := s2.Contact("p"); ok {
		t.Fatal("deleted contact came back")
	}
}

func TestDamagedFilesDoNotBlockStartup(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	s.UpdateSettings(func(st *Settings) { st.Nickname = "x" })
	s.AddMessage(Message{ID: "1", Peer: "good", TS: 1})
	s.Close()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{broken"), 0o600))
	must(os.WriteFile(filepath.Join(dir, "contacts.json"), []byte("[{"), 0o600))
	must(os.WriteFile(filepath.Join(dir, "history", "bad.json"), []byte("nope"), 0o600))

	s2 := open(t, dir)
	defer s2.Close()
	if len(s2.Warnings) != 3 {
		t.Fatalf("want 3 warnings, got %v", s2.Warnings)
	}
	if s2.Settings().HTTPPort != DefaultSettings().HTTPPort {
		t.Fatal("defaults expected after damaged settings")
	}
	if len(s2.Messages("good", 0, 10)) != 1 {
		t.Fatal("intact history must survive")
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "settings.json.broken-*"))
	if len(matches) != 1 {
		t.Fatal("damaged settings must be kept for recovery")
	}
}

func TestNormalizeSettings(t *testing.T) {
	s := open(t, t.TempDir())
	defer s.Close()
	st := s.UpdateSettings(func(st *Settings) {
		st.HTTPPort, st.P2PPort, st.MaxIncomingMB, st.AutoAcceptImagesMB, st.UI = 70000, -1, 0, -5, nil
	})
	d := DefaultSettings()
	if st.HTTPPort != d.HTTPPort || st.P2PPort != d.P2PPort || st.MaxIncomingMB != d.MaxIncomingMB || st.AutoAcceptImagesMB != 0 || st.UI == nil {
		t.Fatalf("invalid values must be normalised: %+v", st)
	}
}

func TestConcurrentAccess(t *testing.T) {
	s := open(t, t.TempDir())
	defer s.Close()
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				id := fmt.Sprintf("%d-%d", g, i)
				s.AddMessage(Message{ID: id, Peer: "p", TS: int64(i), Status: StatusReceived})
				s.UpdateMessage("p", id, func(m *Message) { m.Text = "x" })
				_ = s.Summary("p")
				_ = s.Messages("p", 0, 20)
			}
		}(g)
	}
	wg.Wait()
	if n := len(s.Messages("p", 0, 1000)); n != 1000 {
		t.Fatalf("want 1000 (page limit), got %d", n)
	}
}

func TestDisplayName(t *testing.T) {
	cases := []struct {
		c    Contact
		want string
	}{
		{Contact{PeerID: "12D3KooWABCDEFGH", Name: "Боб", Alias: "Шеф"}, "Шеф"},
		{Contact{PeerID: "12D3KooWABCDEFGH", Name: "Боб"}, "Боб"},
		{Contact{PeerID: "12D3KooWABCDEFGH", Name: "  "}, "…CDEFGH"},
	}
	for _, c := range cases {
		if got := c.c.DisplayName(); got != c.want {
			t.Errorf("DisplayName(%+v) = %q, want %q", c.c, got, c.want)
		}
	}
}

func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.json")
	if err := WriteFileAtomic(p, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(p, []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "two" {
		t.Fatalf("got %q", b)
	}
	left, _ := filepath.Glob(filepath.Join(dir, ".tmp-*"))
	if len(left) != 0 {
		t.Fatal("temp files left behind")
	}
}
