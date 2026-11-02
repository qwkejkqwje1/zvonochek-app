package node

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"golang.org/x/time/rate"

	"zvonochek2/internal/store"
)

// File error codes stored in FileInfo.Error (the UI translates them).
const (
	errCodeInterrupted = "interrupted"
	errCodeHash        = "hash_mismatch"
	errCodeTooLarge    = "too_large"
	errCodeNoDirect    = "no_direct"
	errCodeIO          = "io"
	errCodeMissing     = "missing"
)

// MaxOutgoingFile limits what we offer (receivers have their own limit).
const MaxOutgoingFile = 64 << 30

type transfer struct {
	tid    string
	peer   peer.ID
	out    bool
	cancel context.CancelFunc
	mu     sync.Mutex
	done   int64
	size   int64
	speed  float64
}

func (n *Node) dataDir(sub string) string {
	d := filepath.Join(n.st.Dir(), sub)
	_ = os.MkdirAll(d, 0o700)
	return d
}

// DownloadsDir returns the configured downloads folder (created on demand).
func (n *Node) DownloadsDir() string {
	d := strings.TrimSpace(n.st.Settings().DownloadsDir)
	if d == "" {
		d = DefaultDownloadsDir()
	}
	_ = os.MkdirAll(d, 0o755)
	return d
}

// DefaultDownloadsDir is ~/Downloads/Zvonochek.
func DefaultDownloadsDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(os.TempDir(), "Zvonochek")
	}
	return filepath.Join(home, "Downloads", "Zvonochek")
}

var reservedWin = map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true}

// SanitizeFileName makes a peer-supplied name safe on every OS.
func SanitizeFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		switch {
		case r < 32 || r == 0x7f:
			return -1
		case strings.ContainsRune(`<>:"|?*`, r):
			return '_'
		case (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069): // bidi overrides ("exe.txt" tricks)
			return -1
		}
		return r
	}, strings.ToValidUTF8(name, ""))
	name = strings.Trim(name, " .")
	if name == "" {
		name = "file"
	}
	base := name
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(base, ext)
	if reservedWin[strings.ToUpper(stem)] {
		stem = "_" + stem
	}
	if len(ext) > 16 {
		ext = ""
	}
	for len(stem)+len(ext) > 150 {
		_, size := utf8.DecodeLastRuneInString(stem)
		stem = stem[:len(stem)-size]
	}
	if stem == "" {
		stem = "file"
	}
	return stem + ext
}

func uniquePath(dir, name string) string {
	p := filepath.Join(dir, name)
	if _, err := os.Lstat(p); os.IsNotExist(err) {
		return p
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; i < 10000; i++ {
		c := filepath.Join(dir, fmt.Sprintf("%s (%d)%s", stem, i, ext))
		if _, err := os.Lstat(c); os.IsNotExist(err) {
			return c
		}
	}
	return filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, time.Now().UnixNano(), ext))
}

func mimeOf(name string) string {
	t := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if i := strings.Index(t, ";"); i > 0 {
		t = t[:i]
	}
	return t
}

// IsPreviewable reports whether the UI may render the file inline.
func IsPreviewable(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif",
		".mp3", ".ogg", ".wav", ".m4a", ".opus", ".flac", ".mp4", ".webm":
		return true
	}
	return false
}

func isImage(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif":
		return true
	}
	return false
}

func removeQuiet(p string) { _ = os.Remove(p) }

// keepSentCopy reports whether the staged copy of a delivered file stays on
// disk: small pictures keep their preview in the sender's chat, everything
// else is removed right away to save space (it is deleted together with the
// message later).
func keepSentCopy(fi *store.FileInfo) bool {
	return isImage(fi.Name) && fi.Size <= 25<<20
}

// OfferFile stages the uploaded content and offers it to the peer.
func (n *Node) OfferFile(peerID, name string, r io.Reader) (store.Message, error) {
	pid, _, err := n.acceptedPeer(peerID)
	if err != nil {
		return store.Message{}, err
	}
	name = SanitizeFileName(name)
	tid := uuid.NewString()
	staged := filepath.Join(n.dataDir("outbox"), tid)
	f, err := os.OpenFile(staged, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return store.Message{}, err
	}
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, MaxOutgoingFile+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil || size > MaxOutgoingFile {
		removeQuiet(staged)
		if err == nil {
			err = errors.New("файл слишком большой")
		}
		return store.Message{}, err
	}
	m := store.Message{ID: uuid.NewString(), Peer: peerID, Out: true, Kind: store.KindFile,
		TS: time.Now().UnixMilli(), Status: store.StatusPending,
		File: &store.FileInfo{TransferID: tid, Name: name, Size: size, SHA256: hex.EncodeToString(h.Sum(nil)),
			Mime: mimeOf(name), State: store.FileOffered, Path: staged}}
	n.st.AddMessage(m)
	n.emitNew(m)
	go n.deliverFileOffer(pid, m)
	return m, nil
}

func (n *Node) deliverFileOffer(pid peer.ID, m store.Message) {
	if m.File == nil || m.File.State != store.FileOffered {
		return
	}
	f, _ := mkFrame(fFileOffer, m.ID, m.TS, fileOfferPayload{TID: m.File.TransferID, Name: m.File.Name,
		Size: m.File.Size, SHA256: m.File.SHA256, Mime: m.File.Mime})
	_, err := n.sendTimeout(pid, 45*time.Second, f, false)
	switch {
	case err == nil:
		n.setStatus(m.Peer, m.ID, store.StatusDelivered)
	case IsRemote(err, errNotContact):
		n.setStatus(m.Peer, m.ID, store.StatusFailed)
	}
}

func (n *Node) onFileOffer(pid peer.ID, f Frame) Ack {
	var p fileOfferPayload
	if err := jsonUnmarshal(f.D, &p); err != nil || !validID(f.ID) || !validID(p.TID) || p.Size < 0 || len(p.SHA256) != 64 {
		return Ack{Err: errBadFrame}
	}
	if _, err := hex.DecodeString(p.SHA256); err != nil {
		return Ack{Err: errBadFrame}
	}
	if existing, ok := n.st.FindByTransfer(p.TID); ok && existing.Peer != pid.String() {
		return Ack{Err: errBadFrame}
	}
	name := SanitizeFileName(p.Name)
	st := n.st.Settings()
	m := store.Message{ID: f.ID, Peer: pid.String(), Kind: store.KindFile, TS: sanitizeTS(f.TS),
		Status: store.StatusReceived,
		File: &store.FileInfo{TransferID: p.TID, Name: name, Size: p.Size, SHA256: strings.ToLower(p.SHA256),
			Mime: mimeOf(name), State: store.FileOffered}}
	tooLarge := p.Size > int64(st.MaxIncomingMB)<<20
	if tooLarge {
		m.File.State = store.FileDeclined
		m.File.Error = errCodeTooLarge
	}
	if !n.st.AddMessage(m) {
		return Ack{OK: true}
	}
	n.emitNew(m)
	n.notifyMessage(pid, "📎 "+name)
	if tooLarge {
		go n.sendFileRef(pid, fFileDecline, p.TID, "", errCodeTooLarge)
	} else if isImage(name) && p.Size <= int64(st.AutoAcceptImagesMB)<<20 {
		go func() { _ = n.AcceptFile(pid.String(), p.TID) }()
	}
	return Ack{OK: true}
}

func (n *Node) sendFileRef(pid peer.ID, typ, tid, state, code string) {
	f, _ := mkFrame(typ, NewSecret(), time.Now().UnixMilli(), fileRefPayload{TID: tid, State: state, Error: code})
	_, _ = n.sendTimeout(pid, 30*time.Second, f, false)
}

func (n *Node) updateFile(peerID, msgID string, fn func(fi *store.FileInfo)) (store.Message, bool) {
	m, ok := n.st.UpdateMessage(peerID, msgID, func(m *store.Message) {
		if m.File != nil {
			fn(m.File)
		}
	})
	if ok {
		n.emit("message", m)
	}
	return m, ok
}

// AcceptFile starts (or resumes) downloading an offered file.
func (n *Node) AcceptFile(peerID, tid string) error {
	pid, _, err := n.acceptedPeer(peerID)
	if err != nil {
		return err
	}
	m, ok := n.st.FindByTransfer(tid)
	if !ok || m.Out || m.Peer != peerID || m.File == nil {
		return errors.New("файл не найден")
	}
	switch m.File.State {
	case store.FileOffered, store.FileFailed, store.FileTransferring:
	default:
		return errors.New("файл уже обработан")
	}
	n.updateFile(peerID, m.ID, func(fi *store.FileInfo) { fi.State = store.FileTransferring; fi.Error = "" })
	go n.startDownload(pid, tid)
	return nil
}

// DeclineFile refuses an incoming offer.
func (n *Node) DeclineFile(peerID, tid string) error {
	pid, err := peer.Decode(peerID)
	if err != nil {
		return err
	}
	m, ok := n.st.FindByTransfer(tid)
	if !ok || m.Out || m.Peer != peerID {
		return errors.New("файл не найден")
	}
	n.stopTransfer(tid)
	removeQuiet(n.partPath(tid))
	n.updateFile(peerID, m.ID, func(fi *store.FileInfo) { fi.State = store.FileDeclined })
	go n.sendFileRef(pid, fFileDecline, tid, "", "")
	return nil
}

// CancelFile aborts a transfer in either direction.
func (n *Node) CancelFile(peerID, tid string) error {
	pid, err := peer.Decode(peerID)
	if err != nil {
		return err
	}
	m, ok := n.st.FindByTransfer(tid)
	if !ok || m.Peer != peerID {
		return errors.New("файл не найден")
	}
	if m.File.State == store.FileDone || m.File.State == store.FileDeclined || m.File.State == store.FileCanceled {
		return nil
	}
	n.stopTransfer(tid)
	n.updateFile(peerID, m.ID, func(fi *store.FileInfo) {
		fi.State = store.FileCanceled
		if m.Out {
			removeQuiet(fi.Path)
			fi.Path = ""
		}
	})
	if !m.Out {
		removeQuiet(n.partPath(tid))
	}
	go n.sendFileRef(pid, fFileCancel, tid, "", "")
	return nil
}

func (n *Node) onFileRef(pid peer.ID, f Frame) Ack {
	var p fileRefPayload
	if err := jsonUnmarshal(f.D, &p); err != nil || !validID(p.TID) {
		return Ack{Err: errBadFrame}
	}
	m, ok := n.st.FindByTransfer(p.TID)
	if !ok || m.Peer != pid.String() || m.File == nil {
		return Ack{OK: true}
	}
	switch f.T {
	case fFileDecline:
		if m.Out {
			n.stopTransfer(p.TID)
			n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) {
				fi.State = store.FileDeclined
				fi.Error = clampText(p.Error, 32)
				removeQuiet(fi.Path)
				fi.Path = ""
			})
		}
	case fFileCancel:
		if m.File.State == store.FileDone {
			break
		}
		n.stopTransfer(p.TID)
		n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) {
			fi.State = store.FileCanceled
			if m.Out {
				removeQuiet(fi.Path)
				fi.Path = ""
			}
		})
		if !m.Out {
			removeQuiet(n.partPath(p.TID))
		}
	case fFileStatus:
		if !m.Out {
			break
		}
		switch p.State {
		case store.FileDone:
			n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) {
				fi.State = store.FileDone
				fi.Done = fi.Size
				if !keepSentCopy(fi) {
					removeQuiet(fi.Path)
					fi.Path = ""
				}
			})
		case store.FileFailed:
			n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) { fi.State = store.FileFailed; fi.Error = clampText(p.Error, 32) })
		}
	}
	return Ack{OK: true}
}

func (n *Node) partPath(tid string) string {
	return filepath.Join(n.dataDir("incoming"), tid+".part")
}

func (n *Node) registerTransfer(tid string, pid peer.ID, out bool, size int64) (*transfer, context.Context, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if _, busy := n.transfers[tid]; busy {
		return nil, nil, false
	}
	ctx, cancel := context.WithCancel(n.ctx)
	t := &transfer{tid: tid, peer: pid, out: out, cancel: cancel, size: size}
	n.transfers[tid] = t
	return t, ctx, true
}

func (n *Node) unregisterTransfer(tid string) {
	n.mu.Lock()
	if t, ok := n.transfers[tid]; ok {
		t.cancel()
		delete(n.transfers, tid)
	}
	n.mu.Unlock()
}

func (n *Node) stopTransfer(tid string) { n.unregisterTransfer(tid) }

// progressWriter reports throughput to the UI at most ~4 times per second.
type progressWriter struct {
	n        *Node
	t        *transfer
	peer     string
	msgID    string
	done     int64
	last     time.Time
	lastDone int64
	limiter  func(int)
}

func (w *progressWriter) Write(p []byte) (int, error) {
	if w.limiter != nil {
		w.limiter(len(p))
	}
	w.done += int64(len(p))
	now := time.Now()
	if now.Sub(w.last) >= 250*time.Millisecond {
		dt := now.Sub(w.last).Seconds()
		speed := 0.0
		if !w.last.IsZero() && dt > 0 {
			speed = float64(w.done-w.lastDone) / dt
		}
		w.last, w.lastDone = now, w.done
		w.t.mu.Lock()
		w.t.done, w.t.speed = w.done, speed
		w.t.mu.Unlock()
		w.n.emit("file_progress", map[string]any{"peer": w.peer, "id": w.msgID, "tid": w.t.tid,
			"done": w.done, "size": w.t.size, "speed": int64(speed), "out": w.t.out})
	}
	return len(p), nil
}

// callThrottle keeps transfers from starving a running call.
func (n *Node) callThrottle() func(int) {
	lim := rate.NewLimiter(rate.Limit(384<<10), 256<<10)
	return func(sz int) {
		if !n.callActive() {
			return
		}
		_ = lim.WaitN(context.Background(), min(sz, 256<<10))
	}
}

func (n *Node) startDownload(pid peer.ID, tid string) {
	m, ok := n.st.FindByTransfer(tid)
	if !ok || m.File == nil || m.Out {
		return
	}
	t, ctx, ok := n.registerTransfer(tid, pid, false, m.File.Size)
	if !ok {
		return // already running
	}
	defer n.unregisterTransfer(tid)
	n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) { fi.State = store.FileTransferring; fi.Error = "" })
	code, err := n.download(ctx, pid, m, t)
	if err == nil {
		return
	}
	if ctx.Err() != nil && n.ctx.Err() == nil {
		return // canceled by the user (state already updated)
	}
	if n.ctx.Err() != nil {
		code = errCodeInterrupted // shutting down: resume next time
	}
	n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) {
		if fi.State == store.FileTransferring {
			fi.State = store.FileFailed
			fi.Error = code
		}
	})
	if code == errCodeHash {
		go n.sendFileRef(pid, fFileStatus, tid, store.FileFailed, errCodeHash)
	}
}

func (n *Node) download(ctx context.Context, pid peer.ID, m store.Message, t *transfer) (string, error) {
	fi := m.File
	part := n.partPath(fi.TransferID)
	out, err := os.OpenFile(part, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return errCodeIO, err
	}
	defer out.Close()
	h := sha256.New()
	// hash what we already have (resume)
	offset, err := io.Copy(h, io.LimitReader(out, fi.Size))
	if err != nil {
		return errCodeIO, err
	}
	if err := out.Truncate(offset); err != nil {
		return errCodeIO, err
	}
	if offset < fi.Size {
		sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if n.h.Network().Connectedness(pid) != network.Connected {
			if err := n.dialPeer(sctx, pid); err != nil {
				cancel()
				return errCodeInterrupted, err
			}
		}
		s, err := n.h.NewStream(sctx, pid, ProtoFile)
		cancel()
		if err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "limited") {
				return errCodeNoDirect, err
			}
			return errCodeInterrupted, err
		}
		defer s.Close()
		go func() { <-ctx.Done(); s.Reset() }()
		_ = s.SetDeadline(time.Now().Add(30 * time.Second))
		rd := bufio.NewReaderSize(s, 64<<10)
		if err := writeMsg(s, fileReq{TID: fi.TransferID, Offset: offset}, 4096); err != nil {
			return errCodeInterrupted, err
		}
		var resp fileResp
		if err := readMsg(rd, &resp, 4096); err != nil {
			return errCodeInterrupted, err
		}
		if !resp.OK {
			if resp.Err == errCodeMissing {
				return errCodeMissing, errors.New(resp.Err)
			}
			return errCodeInterrupted, errors.New(resp.Err)
		}
		if resp.Size != fi.Size || resp.Start != offset {
			return errCodeIO, errors.New("size mismatch")
		}
		_ = s.SetDeadline(time.Time{})
		pw := &progressWriter{n: n, t: t, peer: m.Peer, msgID: m.ID, done: offset}
		buf := make([]byte, 64<<10)
		remaining := fi.Size - offset
		for remaining > 0 {
			_ = s.SetReadDeadline(time.Now().Add(45 * time.Second))
			chunk := buf
			if int64(len(chunk)) > remaining {
				chunk = chunk[:remaining]
			}
			nr, rerr := rd.Read(chunk)
			if nr > 0 {
				if _, werr := out.Write(chunk[:nr]); werr != nil {
					return errCodeIO, werr
				}
				h.Write(chunk[:nr])
				pw.Write(chunk[:nr])
				remaining -= int64(nr)
			}
			if rerr != nil {
				if remaining == 0 {
					break
				}
				return errCodeInterrupted, rerr
			}
		}
	}
	if err := out.Sync(); err != nil {
		return errCodeIO, err
	}
	if hex.EncodeToString(h.Sum(nil)) != fi.SHA256 {
		out.Close()
		removeQuiet(part)
		return errCodeHash, errors.New("checksum mismatch")
	}
	out.Close()
	final := uniquePath(n.DownloadsDir(), fi.Name)
	if err := moveFile(part, final); err != nil {
		return errCodeIO, err
	}
	markFromInternet(final)
	n.updateFile(m.Peer, m.ID, func(f *store.FileInfo) {
		f.State = store.FileDone
		f.Done = f.Size
		f.Path = final
		f.Error = ""
	})
	go n.sendFileRef(pid, fFileStatus, fi.TransferID, store.FileDone, "")
	return "", nil
}

func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	// different volume: copy + remove
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	in.Close()
	return os.Remove(src)
}

// handleFileStream serves a download request from the receiver.
func (n *Node) handleFileStream(s network.Stream) {
	defer s.Close()
	pid := s.Conn().RemotePeer()
	_ = s.SetDeadline(time.Now().Add(30 * time.Second))
	rd := bufio.NewReader(s)
	var req fileReq
	if err := readMsg(rd, &req, 4096); err != nil {
		s.Reset()
		return
	}
	fail := func(code string) { _ = writeMsg(s, fileResp{Err: code}, 4096) }
	c, ok := n.st.Contact(pid.String())
	if !ok || c.State != store.ContactAccepted {
		fail(errNotContact)
		return
	}
	m, ok := n.st.FindByTransfer(req.TID)
	if !ok || !m.Out || m.Peer != pid.String() || m.File == nil {
		fail(errCodeMissing)
		return
	}
	if m.File.State != store.FileOffered && m.File.State != store.FileTransferring && m.File.State != store.FileFailed {
		fail(errCodeMissing)
		return
	}
	f, err := os.Open(m.File.Path)
	if err != nil {
		fail(errCodeMissing)
		return
	}
	defer f.Close()
	if req.Offset < 0 || req.Offset > m.File.Size {
		fail(errBadFrame)
		return
	}
	if _, err := f.Seek(req.Offset, io.SeekStart); err != nil {
		fail(errCodeIO)
		return
	}
	t, ctx, ok := n.registerTransfer(req.TID, pid, true, m.File.Size)
	if !ok {
		// a stale stream is still registered: replace it
		n.unregisterTransfer(req.TID)
		if t, ctx, ok = n.registerTransfer(req.TID, pid, true, m.File.Size); !ok {
			fail(errCodeIO)
			return
		}
	}
	defer n.unregisterTransfer(req.TID)
	go func() { <-ctx.Done(); s.Reset() }()
	if err := writeMsg(s, fileResp{OK: true, Size: m.File.Size, Start: req.Offset}, 4096); err != nil {
		return
	}
	n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) { fi.State = store.FileTransferring; fi.Error = "" })
	_ = s.SetDeadline(time.Time{})
	pw := &progressWriter{n: n, t: t, peer: m.Peer, msgID: m.ID, done: req.Offset, limiter: n.callThrottle()}
	buf := make([]byte, 64<<10)
	for {
		nr, rerr := f.Read(buf)
		if nr > 0 {
			_ = s.SetWriteDeadline(time.Now().Add(45 * time.Second))
			if _, err := s.Write(buf[:nr]); err != nil {
				n.markOutgoingInterrupted(m)
				return
			}
			pw.Write(buf[:nr])
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			n.markOutgoingInterrupted(m)
			return
		}
	}
	_ = s.CloseWrite()
	// wait (briefly) for the receiver to close; final state arrives via file_status
	_ = s.SetReadDeadline(time.Now().Add(20 * time.Second))
	_, _ = io.Copy(io.Discard, s)
}

func (n *Node) markOutgoingInterrupted(m store.Message) {
	n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) {
		if fi.State == store.FileTransferring {
			fi.State = store.FileOffered // receiver will resume
		}
	})
}

// resumeTransfers fixes states left over from a previous run.
func (n *Node) resumeTransfers() {
	for _, m := range n.st.Find(func(m *store.Message) bool {
		return m.File != nil && m.File.State == store.FileTransferring
	}) {
		n.updateFile(m.Peer, m.ID, func(fi *store.FileInfo) {
			if m.Out {
				fi.State = store.FileOffered
			} else {
				fi.State = store.FileFailed
				fi.Error = errCodeInterrupted
			}
		})
	}
	// drop staged/partial files that no longer belong to any message
	keep := map[string]bool{}
	for _, m := range n.st.Find(func(m *store.Message) bool { return m.File != nil }) {
		keep[m.File.TransferID] = true
	}
	for _, sub := range []string{"outbox", "incoming"} {
		entries, _ := os.ReadDir(n.dataDir(sub))
		for _, e := range entries {
			tid := strings.TrimSuffix(e.Name(), ".part")
			if !keep[tid] {
				removeQuiet(filepath.Join(n.dataDir(sub), e.Name()))
			}
		}
	}
}

// FileForServing returns a completed incoming file (or a staged outgoing one).
func (n *Node) FileForServing(peerID, tid string) (path, name string, ok bool) {
	m, found := n.st.FindByTransfer(tid)
	if !found || m.Peer != peerID || m.File == nil || m.File.Path == "" {
		return "", "", false
	}
	if !m.Out && m.File.State != store.FileDone {
		return "", "", false
	}
	if _, err := os.Stat(m.File.Path); err != nil {
		return "", "", false
	}
	return m.File.Path, m.File.Name, true
}
