package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"

	"zvonochek2/internal/store"
	"zvonochek2/internal/version"
)

var (
	jsonMarshal   = json.Marshal
	jsonUnmarshal = json.Unmarshal
)

// InviteTTL is how long a generated invite stays valid.
const InviteTTL = 7 * 24 * time.Hour

// PairRequest is an incoming "add me" request awaiting the user's decision.
type PairRequest struct {
	PeerID     string `json:"peer_id"`
	Nick       string `json:"nick"`
	At         int64  `json:"at"`
	SafetyCode string `json:"safety_code"`
	Via        string `json:"via,omitempty"`
}

// ContactView is what the UI renders in the contact list.
type ContactView struct {
	store.Contact
	Display    string            `json:"display"`
	Presence   Presence          `json:"presence"`
	Summary    store.ChatSummary `json:"summary"`
	SafetyCode string            `json:"safety_code"`
}

func (n *Node) contactView(c store.Contact) ContactView {
	v := ContactView{Contact: c, Display: c.DisplayName(), SafetyCode: SafetyCode(n.h.ID().String(), c.PeerID)}
	if pid, err := peer.Decode(c.PeerID); err == nil {
		v.Presence = n.presence(pid)
	}
	v.Summary = n.st.Summary(c.PeerID)
	return v
}

// ContactViews lists contacts with presence and chat summaries.
func (n *Node) ContactViews() []ContactView {
	cs := n.st.Contacts()
	out := make([]ContactView, 0, len(cs))
	for _, c := range cs {
		out = append(out, n.contactView(c))
	}
	return out
}

// ContactView returns a single view.
func (n *Node) ContactView(id string) (ContactView, bool) {
	c, ok := n.st.Contact(id)
	if !ok {
		return ContactView{}, false
	}
	return n.contactView(c), true
}

// PairRequests returns pending incoming requests.
func (n *Node) PairRequests() []PairRequest {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make([]PairRequest, 0, len(n.pairReqs))
	for _, r := range n.pairReqs {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

// Invite returns the current invite code, creating or renewing it if needed.
func (n *Node) Invite(renew bool) (string, time.Time, error) {
	st := n.st.Settings()
	if renew || st.InviteSecret == "" || time.Now().Unix() > st.InviteExpires-3600 {
		st = n.st.UpdateSettings(func(s *store.Settings) {
			s.InviteSecret = NewSecret()
			s.InviteExpires = time.Now().Add(InviteTTL).Unix()
		})
	}
	inv := Invite{
		PeerID:  n.h.ID(),
		Secret:  st.InviteSecret,
		Expires: time.Unix(st.InviteExpires, 0),
		Nick:    n.nick(),
		Addrs:   n.inviteAddrs(),
	}
	code, err := EncodeInvite(inv)
	return code, inv.Expires, err
}

// inviteAddrs ranks our addresses: public, LAN/VPN, own relays, public relays, loopback.
func (n *Node) inviteAddrs() []ma.Multiaddr {
	var pub, lan, circ, loop []ma.Multiaddr
	for _, a := range n.h.Addrs() {
		switch {
		case isCircuit(a):
			circ = append(circ, a)
		case manet.IsIPLoopback(a):
			loop = append(loop, a)
		case manet.IsPublicAddr(a):
			pub = append(pub, a)
		default:
			if ip, err := manet.ToIP(a); err == nil && ip.IsLinkLocalUnicast() {
				continue
			}
			lan = append(lan, a)
		}
	}
	var own []ma.Multiaddr
	for _, r := range n.ownRelayAddrs() {
		if a, err := ma.NewMultiaddr(r + "/p2p-circuit"); err == nil {
			own = append(own, a)
		}
	}
	limit := func(in []ma.Multiaddr, k int) []ma.Multiaddr {
		if len(in) > k {
			return in[:k]
		}
		return in
	}
	var out []ma.Multiaddr
	out = append(out, limit(pub, 3)...)
	out = append(out, limit(lan, 4)...)
	out = append(out, limit(own, 2)...)
	out = append(out, limit(circ, 2)...)
	out = append(out, limit(loop, 1)...)
	return out
}

// AddContact accepts a zv3: invite code or a bare peer id.
// With an invite the remote side auto-accepts; with a bare peer id the
// remote user has to confirm the request.
func (n *Node) AddContact(ctx context.Context, input string) (ContactView, error) {
	input = strings.TrimSpace(input)
	var (
		pid    peer.ID
		secret string
		nick   string
		addrs  []string
	)
	if strings.HasPrefix(strings.ToLower(strings.Join(strings.Fields(input), "")), "zv") {
		inv, err := DecodeInvite(input)
		if err != nil {
			return ContactView{}, err
		}
		pid, secret, nick = inv.PeerID, inv.Secret, inv.Nick
		for _, a := range inv.Addrs {
			addrs = append(addrs, a.String())
		}
	} else {
		id, err := peer.Decode(strings.Trim(input, " \"'"))
		if err != nil {
			return ContactView{}, errors.New("вставьте код приглашения (zv3:…) или ID собеседника (12D3Koo…)")
		}
		pid = id
	}
	if pid == n.h.ID() {
		return ContactView{}, errors.New("это ваш собственный код — отправьте его собеседнику, а сюда вставьте его код")
	}
	existing, known := n.st.Contact(pid.String())
	if known && existing.State == store.ContactAccepted {
		n.rememberAddrs(pid, addrs, nil)
		go n.sayHello(pid, true)
		return n.contactView(existing), nil
	}
	// a pending request from them + our attempt = mutual consent
	n.mu.Lock()
	_, theyAsked := n.pairReqs[pid]
	n.mu.Unlock()
	if theyAsked {
		return n.RespondPair(ctx, pid.String(), true)
	}
	n.h.ConnManager().Protect(pid, "contact")
	c := n.st.UpsertContact(pid.String(), func(c *store.Contact, created bool) {
		if c.State != store.ContactAccepted {
			c.State = store.ContactOutgoing
		}
		if nick != "" && c.Name == "" {
			c.Name = nick
		}
		c.Addrs = mergeAddrs(addrs, c.Addrs, 8)
	})
	n.rememberAddrs(pid, c.Addrs, nil)
	n.emit("contact", n.contactView(c))

	req := pairReqPayload{Nick: n.nick(), Ver: version.Version, Secret: secret, Relays: n.ownRelayAddrs()}
	f, _ := mkFrame(fPairReq, NewSecret(), time.Now().UnixMilli(), req)
	sctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	ack, err := n.send(sctx, pid, f, false)
	if err != nil {
		if IsRemote(err, errRejected) {
			n.st.DeleteContact(pid.String(), false)
			n.emit("contact_removed", map[string]string{"peer": pid.String()})
			return ContactView{}, errors.New("собеседник отклонил запрос")
		}
		if IsRemote(err, errRateLimit) {
			return n.contactView(c), errors.New("слишком много запросов, попробуйте через минуту")
		}
		// keep the contact as "outgoing": the request is retried on reconnect
		return n.contactView(c), fmt.Errorf("контакт сохранён, но собеседник сейчас недоступен — запрос будет отправлен автоматически, когда он появится в сети (%s)", shortErr(err))
	}
	var ok pairOKPayload
	if len(ack.D) > 0 {
		_ = jsonUnmarshal(ack.D, &ok)
	}
	if ok.Ver != "" {
		c = n.acceptContact(pid, ok.Nick, ok.Ver, ok.Relays)
		n.setOnline(pid) // synchronously, so the returned view is already "online"
		return n.contactView(c), nil
	}
	// accepted for review on their side
	return n.contactView(c), nil
}

func (n *Node) acceptContact(pid peer.ID, nick, ver string, relays []string) store.Contact {
	nick = cleanNick(nick)
	relays = sanitizeRelays(relays)
	n.h.ConnManager().Protect(pid, "contact")
	c := n.st.UpsertContact(pid.String(), func(c *store.Contact, created bool) {
		c.State = store.ContactAccepted
		if nick != "" {
			c.Name = nick
		}
		if ver != "" {
			c.Version = clampText(ver, 32)
		}
		if relays != nil {
			c.Relays = relays
		}
	})
	n.rememberAddrs(pid, nil, relays)
	n.mu.Lock()
	delete(n.pairReqs, pid)
	delete(n.nearby, pid)
	n.mu.Unlock()
	n.emit("contact", n.contactView(c))
	n.emit("pair_requests", n.PairRequests())
	n.emit("nearby", n.Nearby())
	return c
}

func (n *Node) onPairRequest(pid peer.ID, conn network.Conn, f Frame) Ack {
	var req pairReqPayload
	if err := jsonUnmarshal(f.D, &req); err != nil {
		return Ack{Err: errBadFrame}
	}
	nick := cleanNick(req.Nick)
	c, known := n.st.Contact(pid.String())
	st := n.st.Settings()
	validSecret := req.Secret != "" && st.InviteSecret != "" &&
		constantTimeEq(req.Secret, st.InviteSecret) && time.Now().Unix() <= st.InviteExpires
	if validSecret || (known && (c.State == store.ContactAccepted || c.State == store.ContactOutgoing)) {
		c = n.acceptContact(pid, nick, req.Ver, req.Relays)
		go n.setOnline(pid)
		if !known {
			n.emit("toast", map[string]string{"kind": "ok", "text": fmt.Sprintf("Новый контакт: %s", c.DisplayName())})
		}
		reply, _ := jsonMarshal(pairOKPayload{Nick: n.nick(), Ver: version.Version, Relays: n.ownRelayAddrs()})
		return Ack{OK: true, D: reply}
	}
	if req.Secret != "" {
		// wrong or expired secret: fall through to manual approval
		nick = nick + " (код устарел)"
	}
	n.mu.Lock()
	if len(n.pairReqs) >= 30 {
		n.mu.Unlock()
		return Ack{Err: errRateLimit}
	}
	_, dup := n.pairReqs[pid]
	n.pairReqs[pid] = &PairRequest{PeerID: pid.String(), Nick: nick, At: time.Now().UnixMilli(),
		SafetyCode: SafetyCode(n.h.ID().String(), pid.String()), Via: viaLabel(conn)}
	n.mu.Unlock()
	if relays := sanitizeRelays(req.Relays); len(relays) > 0 {
		n.rememberAddrs(pid, nil, relays)
	}
	if !dup {
		n.emit("pair_requests", n.PairRequests())
		n.emit("notify", map[string]string{"kind": "pair", "title": "Запрос в контакты", "text": nick + " хочет добавить вас в контакты"})
	}
	return Ack{OK: true}
}

func viaLabel(c network.Conn) string {
	if c == nil {
		return ""
	}
	if isCircuit(c.RemoteMultiaddr()) {
		return "relay"
	}
	if isPrivateAddr(c.RemoteMultiaddr()) {
		return "lan"
	}
	return "internet"
}

func (n *Node) onPairOK(pid peer.ID, f Frame) Ack {
	c, known := n.st.Contact(pid.String())
	if !known || c.State != store.ContactOutgoing {
		return Ack{Err: errNotContact}
	}
	var ok pairOKPayload
	if err := jsonUnmarshal(f.D, &ok); err != nil {
		return Ack{Err: errBadFrame}
	}
	c = n.acceptContact(pid, ok.Nick, ok.Ver, ok.Relays)
	n.emit("toast", map[string]string{"kind": "ok", "text": fmt.Sprintf("%s принял(а) ваш запрос", c.DisplayName())})
	go n.setOnline(pid)
	return Ack{OK: true}
}

func (n *Node) onPairNo(pid peer.ID) Ack {
	c, known := n.st.Contact(pid.String())
	if known && c.State == store.ContactOutgoing {
		n.st.DeleteContact(pid.String(), false)
		n.emit("contact_removed", map[string]string{"peer": pid.String()})
		n.emit("toast", map[string]string{"kind": "warn", "text": fmt.Sprintf("%s отклонил(а) запрос в контакты", c.DisplayName())})
	}
	return Ack{OK: true}
}

func (n *Node) onWhois() Ack {
	if !n.lan {
		return Ack{Err: errNotContact}
	}
	d, _ := jsonMarshal(map[string]string{"nick": n.nick(), "ver": version.Version})
	return Ack{OK: true, D: d}
}

// RespondPair accepts or declines an incoming request.
func (n *Node) RespondPair(ctx context.Context, id string, accept bool) (ContactView, error) {
	pid, err := peer.Decode(id)
	if err != nil {
		return ContactView{}, err
	}
	n.mu.Lock()
	req, ok := n.pairReqs[pid]
	delete(n.pairReqs, pid)
	n.mu.Unlock()
	n.emit("pair_requests", n.PairRequests())
	if !ok {
		return ContactView{}, errors.New("запрос уже обработан")
	}
	if !accept {
		f, _ := mkFrame(fPairNo, NewSecret(), time.Now().UnixMilli(), nil)
		go n.sendTimeout(pid, 20*time.Second, f, false)
		return ContactView{}, nil
	}
	nick := strings.TrimSuffix(req.Nick, " (код устарел)")
	c := n.acceptContact(pid, nick, "", nil)
	f, _ := mkFrame(fPairOK, NewSecret(), time.Now().UnixMilli(), pairOKPayload{Nick: n.nick(), Ver: version.Version, Relays: n.ownRelayAddrs()})
	go func() {
		if _, err := n.sendTimeout(pid, 40*time.Second, f, false); err == nil {
			n.setOnline(pid)
		}
	}()
	return n.contactView(c), nil
}

// UpdateContact changes local-only contact attributes.
func (n *Node) UpdateContact(id string, alias *string, verified, muted *bool) (ContactView, error) {
	c, ok := n.st.UpdateContact(id, func(c *store.Contact) {
		if alias != nil {
			c.Alias = cleanNick(*alias)
		}
		if verified != nil {
			c.Verified = *verified
		}
		if muted != nil {
			c.Muted = *muted
		}
	})
	if !ok {
		return ContactView{}, errors.New("контакт не найден")
	}
	v := n.contactView(c)
	n.emit("contact", v)
	return v, nil
}

// RemoveContact deletes (or blocks) a contact.
func (n *Node) RemoveContact(id string, purge, block bool) error {
	pid, err := peer.Decode(id)
	if err != nil {
		return err
	}
	if block {
		c := n.st.UpsertContact(id, func(c *store.Contact, _ bool) { c.State = store.ContactBlocked })
		if purge {
			n.st.ClearHistory(id)
		}
		n.h.ConnManager().Unprotect(pid, "contact")
		_ = n.h.Network().ClosePeer(pid)
		n.emit("contact", n.contactView(c))
		return nil
	}
	n.st.DeleteContact(id, purge)
	n.h.ConnManager().Unprotect(pid, "contact")
	n.mu.Lock()
	if r := n.peers[pid]; r != nil {
		r.online = false
	}
	n.mu.Unlock()
	n.emit("contact_removed", map[string]string{"peer": id})
	return nil
}

// Unblock restores a blocked contact as a normal pending one.
func (n *Node) Unblock(id string) {
	n.st.DeleteContact(id, false)
	n.emit("contact_removed", map[string]string{"peer": id})
}

func (n *Node) retryPendingPair(pid peer.ID) {
	c, ok := n.st.Contact(pid.String())
	if !ok || c.State != store.ContactOutgoing {
		return
	}
	req := pairReqPayload{Nick: n.nick(), Ver: version.Version, Relays: n.ownRelayAddrs()}
	f, _ := mkFrame(fPairReq, NewSecret(), time.Now().UnixMilli(), req)
	ack, err := n.sendTimeout(pid, 30*time.Second, f, false)
	if err != nil {
		return
	}
	var ok2 pairOKPayload
	if len(ack.D) > 0 && jsonUnmarshal(ack.D, &ok2) == nil && ok2.Ver != "" {
		n.acceptContact(pid, ok2.Nick, ok2.Ver, ok2.Relays)
		n.setOnline(pid)
	}
}

func constantTimeEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

func sanitizeRelays(in []string) []string {
	var out []string
	for _, r := range in {
		if len(out) >= 4 {
			break
		}
		r = strings.TrimSpace(r)
		if len(r) > 300 {
			continue
		}
		if _, err := peer.AddrInfoFromString(r); err == nil {
			out = append(out, r)
		}
	}
	return out
}

// SetNickname changes our display name and tells online contacts.
func (n *Node) SetNickname(nick string) string {
	nick = cleanNick(nick)
	n.st.UpdateSettings(func(s *store.Settings) { s.Nickname = nick })
	n.mu.Lock()
	var online []peer.ID
	for id, r := range n.peers {
		if r.online {
			online = append(online, id)
		}
	}
	n.mu.Unlock()
	for _, pid := range online {
		go n.sayHello(pid, true)
	}
	return nick
}
