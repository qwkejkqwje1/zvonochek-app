package node

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestMsgRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	f, _ := mkFrame(fMsg, "id1", 42, msgPayload{Text: "привет"})
	if err := writeMsg(&buf, f, maxControlFrame); err != nil {
		t.Fatal(err)
	}
	var got Frame
	if err := readMsg(bufio.NewReader(&buf), &got, maxControlFrame); err != nil {
		t.Fatal(err)
	}
	var p msgPayload
	if err := jsonUnmarshal(got.D, &p); err != nil || got.T != fMsg || got.ID != "id1" || got.TS != 42 || p.Text != "привет" {
		t.Fatalf("round trip mismatch: %+v %+v", got, p)
	}
}

func TestMsgLimits(t *testing.T) {
	big := msgPayload{Text: strings.Repeat("x", 2000)}
	if err := writeMsg(&bytes.Buffer{}, big, 1000); err == nil {
		t.Fatal("writer must refuse oversized frames")
	}
	// a hostile peer announces a 1 GB frame: the reader must not allocate it
	var hdr [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(hdr[:], 1<<30)
	var v any
	if err := readMsg(bufio.NewReader(bytes.NewReader(hdr[:n])), &v, maxControlFrame); err == nil {
		t.Fatal("reader must refuse oversized frames")
	}
	n = binary.PutUvarint(hdr[:], 0)
	if err := readMsg(bufio.NewReader(bytes.NewReader(hdr[:n])), &v, maxControlFrame); err == nil {
		t.Fatal("empty frame must be rejected")
	}
	// truncated body
	n = binary.PutUvarint(hdr[:], 10)
	if err := readMsg(bufio.NewReader(bytes.NewReader(append(hdr[:n], '{'))), &v, maxControlFrame); err == nil {
		t.Fatal("truncated frame must fail")
	}
}

func TestBlob(t *testing.T) {
	var buf bytes.Buffer
	payload := bytes.Repeat([]byte{7}, 300)
	if err := writeBlob(&buf, payload); err != nil {
		t.Fatal(err)
	}
	got, err := readBlob(&buf)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatal("blob round trip failed")
	}
	if writeBlob(&buf, nil) == nil || writeBlob(&buf, make([]byte, maxVoiceFrame+1)) == nil {
		t.Fatal("invalid blob sizes must be refused")
	}
	if _, err := readBlob(bytes.NewReader([]byte{0xff, 0xff})); err == nil {
		t.Fatal("oversized blob header must be refused")
	}
}

func TestSafetyCode(t *testing.T) {
	a, b, c := "12D3KooWAAAA", "12D3KooWBBBB", "12D3KooWCCCC"
	ab, ba := SafetyCode(a, b), SafetyCode(b, a)
	if ab != ba {
		t.Fatal("safety code must be symmetric")
	}
	if ab == SafetyCode(a, c) {
		t.Fatal("different pairs must give different codes")
	}
	if len(ab) != 15 || strings.Count(ab, " ") != 3 {
		t.Fatalf("unexpected format %q", ab)
	}
}

func TestTextHelpers(t *testing.T) {
	s := clampText("ёжик", 3) // "ё" is 2 bytes, "ж" 2 bytes: cut must not split a rune
	if !utf8.ValidString(s) || s != "ё" {
		t.Fatalf("clampText = %q", s)
	}
	if got := cleanNick("  Анна\x00\u202e\n "); got != "Анна" {
		t.Fatalf("cleanNick = %q", got)
	}
	for id, ok := range map[string]bool{"abc-DEF_123": true, "": false, "a b": false, "../x": false, strings.Repeat("a", 65): false} {
		if validID(id) != ok {
			t.Errorf("validID(%q) != %v", id, ok)
		}
	}
}

func TestSanitizeFileName(t *testing.T) {
	cases := map[string]string{
		"report.pdf":                   "report.pdf",
		"../../etc/passwd":             "passwd",
		`C:\Windows\System32\evil.dll`: "evil.dll",
		"CON.txt":                      "_CON.txt",
		"lpt1":                         "_lpt1",
		"  .hidden. ":                  "hidden",
		"":                             "file",
		"..":                           "file",
		"a<b>c:d\"e|f?g*h.txt":         "a_b_c_d_e_f_g_h.txt",
		"tab\there\x00.txt":            "tabhere.txt",
		"invoice\u202etxt.exe":         "invoicetxt.exe", // bidi override trick removed
		"фото отпуска.jpg":             "фото отпуска.jpg",
	}
	for in, want := range cases {
		if got := SanitizeFileName(in); got != want {
			t.Errorf("SanitizeFileName(%q) = %q, want %q", in, got, want)
		}
	}
	long := SanitizeFileName(strings.Repeat("я", 300) + ".txt")
	if len(long) > 160 || !utf8.ValidString(long) || !strings.HasSuffix(long, ".txt") {
		t.Fatalf("long names must be shortened on a rune boundary, got %d bytes", len(long))
	}
}

func TestUniquePath(t *testing.T) {
	dir := t.TempDir()
	p1 := uniquePath(dir, "a.txt")
	if err := os.WriteFile(p1, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	p2 := uniquePath(dir, "a.txt")
	if filepath.Base(p2) != "a (1).txt" {
		t.Fatalf("got %s", filepath.Base(p2))
	}
}

func TestDecodeRejectsBadFrames(t *testing.T) {
	n := &Node{}
	if ack := n.onChat("", Frame{T: fMsg, ID: "bad id!", D: []byte(`{"text":"x"}`)}); ack.Err != errBadFrame {
		t.Fatalf("invalid id must be rejected, got %+v", ack)
	}
	if ack := n.onChat("", Frame{T: fMsg, ID: "ok", D: []byte(`{`)}); ack.Err != errBadFrame {
		t.Fatalf("invalid json must be rejected, got %+v", ack)
	}
}
