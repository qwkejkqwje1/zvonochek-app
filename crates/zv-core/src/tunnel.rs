//! Туннель звонка через P2P-линк приложений (ADR-0008) — «как Hamachi».
//!
//! Окно звонка (встроенный веб-клиент) соединяется по WebRTC само. Если собеседник — тоже
//! приложение и комната звонка привязана к P2P-линку (iroh/libp2p), ядро открывает UDP-сокет на
//! адресе этого ПК и добавляет его в SDP собеседника, который получает окно, кандидатом ICE:
//! приоритет ниже прямых (host/srflx) и выше TURN. Всё, что браузер шлёт на этот сокет, уходит
//! собеседнику датаграммой линка (`T` + 8 знаков комнаты + пакет); у собеседника ядро отдаёт пакет
//! своему браузеру со своего такого же сокета. Браузеры видят друг друга по этим адресам и сами
//! проверяют путь (STUN); DTLS/SRTP — сквозные, ядро ничего не расшифровывает и никуда, кроме
//! своего браузера, пакеты не шлёт. Не влезло в датаграмму или путь libp2p — кадр `tun` по потоку
//! линка (надёжно, по порядку).

use crate::Inner;
use base64::Engine;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use zv_p2p::LinkId;
use zv_proto::ids::now_ms;

/// Приоритет кандидата: тип 90 — ниже host (126), prflx (110), srflx (100), выше TURN (0–2).
const PRIO: u32 = (90 << 24) | (65535 << 8) | 255;
const FOUNDATION: &str = "zvtun";
/// Браузер шлёт проверки с нескольких своих сокетов; адрес назначения меняем на новый, только если
/// с него пошёл не-STUN (DTLS/медиа — выбранная пара) или прежний молчит дольше этого.
const LEARN_STALE_MS: u64 = 3000;
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD_NO_PAD;

#[derive(Default)]
pub(crate) struct TunState {
    rooms: HashMap<String, RoomTun>,
}

#[derive(Default)]
struct RoomTun {
    /// selfId и ID узла собеседника-приложения (из его hello с `zv`).
    peer_from: Option<String>,
    peer_node: Option<String>,
    /// Линк, к которому привязана комната и который умеет туннель (bind с `tun: 1`).
    link: Option<LinkId>,
    /// Последнее описание (desc) собеседника: кандидат досылаем, если туннель появился позже.
    last_desc: Option<Value>,
    tun: Option<Arc<Tun>>,
}

#[derive(Default)]
struct Learned {
    addr: Option<SocketAddr>,
    last: u64,
}

pub(crate) struct Tun {
    topic: String,
    tag: [u8; 8],
    addr: SocketAddr,
    sock: Arc<tokio::net::UdpSocket>,
    link: Mutex<Option<LinkId>>,
    browser: Mutex<Learned>,
    /// от собеседника → браузеру / от браузера → собеседнику / из них кадрами потока
    rx: AtomicU64,
    tx: AtomicU64,
    tx_frames: AtomicU64,
    task: Mutex<Option<tokio::task::AbortHandle>>,
}

impl Tun {
    fn candidate(&self) -> String {
        candidate_line(self.addr)
    }

    fn learn(&self, src: SocketAddr, stun: bool, now: u64) {
        let mut l = self.browser.lock().unwrap_or_else(|e| e.into_inner());
        match l.addr {
            Some(a) if a == src => l.last = now,
            Some(_) if stun && now.saturating_sub(l.last) < LEARN_STALE_MS => {}
            _ => {
                l.addr = Some(src);
                l.last = now;
            }
        }
    }

    fn deliver(&self, pkt: &[u8]) {
        let to = self.browser.lock().unwrap_or_else(|e| e.into_inner()).addr;
        if let Some(to) = to {
            self.rx.fetch_add(1, Ordering::Relaxed);
            let _ = self.sock.try_send_to(pkt, to);
        }
    }

    fn stop(&self) {
        if let Some(h) = self.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
            h.abort();
        }
    }

    fn json(&self) -> Value {
        let l = self.browser.lock().unwrap_or_else(|e| e.into_inner());
        json!({
            "room": &self.topic[..8.min(self.topic.len())],
            "addr": self.addr.to_string(),
            "browser": l.addr.is_some(),
            "link": *self.link.lock().unwrap_or_else(|e| e.into_inner()),
            "rx": self.rx.load(Ordering::Relaxed),
            "tx": self.tx.load(Ordering::Relaxed),
            "txFrames": self.tx_frames.load(Ordering::Relaxed),
        })
    }
}

/// `candidate:` для SDP/trickle: тип srflx — веб покажет «Напрямую (P2P)», а не «Локальная сеть».
pub(crate) fn candidate_line(a: SocketAddr) -> String {
    format!(
        "candidate:{FOUNDATION} 1 udp {PRIO} {} {} typ srflx raddr 0.0.0.0 rport 0 generation 0",
        a.ip(),
        a.port()
    )
}

/// Добавить кандидата в первую m-секцию (max-bundle: транспорт один). `None` — в SDP нет m=.
pub(crate) fn sdp_add_candidate(sdp: &str, cand: &str) -> Option<String> {
    let eol = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    let line = format!("a={cand}");
    if sdp.split(eol).any(|l| l == line) {
        return Some(sdp.to_string());
    }
    let mut lines: Vec<&str> = sdp.split(eol).collect();
    let first = lines.iter().position(|l| l.starts_with("m="))?;
    let end = lines
        .iter()
        .skip(first + 1)
        .position(|l| l.starts_with("m="))
        .map(|p| p + first + 1)
        .unwrap_or_else(|| {
            // хвостовая пустая строка после последнего \r\n
            if lines.last().is_some_and(|l| l.is_empty()) {
                lines.len() - 1
            } else {
                lines.len()
            }
        });
    // перед a=end-of-candidates, если он есть
    let pos = lines[first..end]
        .iter()
        .position(|l| *l == "a=end-of-candidates")
        .map(|p| p + first)
        .unwrap_or(end);
    lines.insert(pos, &line);
    Some(lines.join(eol))
}

/// Режим «только туннель» (проверка): убрать из SDP чужие кандидаты.
pub(crate) fn sdp_strip_candidates(sdp: &str) -> String {
    let eol = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    sdp.split(eol)
        .filter(|l| !l.starts_with("a=candidate:") || l.contains(FOUNDATION))
        .collect::<Vec<_>>()
        .join(eol)
}

/// Значение атрибута `a=<name>:` в первой m-секции.
pub(crate) fn sdp_first_attr(sdp: &str, name: &str) -> Option<String> {
    let pre = format!("a={name}:");
    sdp.lines()
        .skip_while(|l| !l.starts_with("m="))
        .skip(1)
        .take_while(|l| !l.starts_with("m="))
        .find_map(|l| l.trim_end().strip_prefix(&pre).map(str::to_string))
}

/// IPv4 этого ПК по маршруту по умолчанию (пакетов не шлёт); нет сети — 127.0.0.1.
fn local_ipv4() -> Ipv4Addr {
    let ip = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("1.1.1.1:53").map(|_| s))
        .and_then(|s| s.local_addr())
        .ok()
        .and_then(|a| match a.ip() {
            IpAddr::V4(v) if !v.is_unspecified() => Some(v),
            _ => None,
        });
    ip.unwrap_or(Ipv4Addr::LOCALHOST)
}

/// Проверка: ZV_TUNNEL_ONLY=1 — собеседник виден браузеру только через туннель.
fn only_mode() -> bool {
    std::env::var("ZV_TUNNEL_ONLY").is_ok_and(|v| v == "1")
}

fn tag_of(topic: &str) -> [u8; 8] {
    let mut t = [0u8; 8];
    for (i, b) in topic.bytes().take(8).enumerate() {
        t[i] = b;
    }
    t
}

async fn pump(me: Weak<Inner>, t: Arc<Tun>) {
    let mut buf = vec![0u8; 4096];
    loop {
        let (n, src) = match t.sock.recv_from(&mut buf).await {
            Ok(x) => x,
            Err(e) => {
                // Windows: ICMP «порт недоступен» после отправки — WSAECONNRESET на приёме
                tracing::trace!("туннель: приём: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                continue;
            }
        };
        // только свой ПК: сокет на адресе машины, чужие пакеты из сети — мимо
        if n == 0 || !(src.ip() == t.addr.ip() || src.ip().is_loopback()) {
            continue;
        }
        t.learn(src, buf[0] < 4, now_ms());
        let Some(inner) = me.upgrade() else { break };
        inner.tun_forward(&t, &buf[..n]);
    }
}

impl Inner {
    fn tun_lock(&self) -> std::sync::MutexGuard<'_, TunState> {
        self.tun.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn tunnel_enabled(&self) -> bool {
        self.lock().settings.tunnel
    }

    fn tun_forward(&self, t: &Tun, pkt: &[u8]) {
        let Some(link) = *t.link.lock().unwrap_or_else(|e| e.into_inner()) else {
            return;
        };
        let Some(node) = self.node() else { return };
        let mut b = Vec::with_capacity(9 + pkt.len());
        b.push(b'T');
        b.extend_from_slice(&t.tag);
        b.extend_from_slice(pkt);
        t.tx.fetch_add(1, Ordering::Relaxed);
        if !node.send_datagram(link, b.into()) {
            t.tx_frames.fetch_add(1, Ordering::Relaxed);
            node.send(
                link,
                &json!({"t": "tun", "r": t.topic, "d": B64.encode(pkt)}),
            );
        }
    }

    fn tun_find(&self, link: LinkId, pred: impl Fn(&Tun) -> bool) -> Option<Arc<Tun>> {
        self.tun_lock()
            .rooms
            .values()
            .filter_map(|r| r.tun.clone())
            .find(|t| *t.link.lock().unwrap_or_else(|e| e.into_inner()) == Some(link) && pred(t))
    }

    /// Датаграмма `T…` от собеседника.
    pub(crate) fn tun_datagram(&self, link: LinkId, data: &[u8]) {
        if data.len() <= 9 {
            return;
        }
        if let Some(t) = self.tun_find(link, |t| t.tag[..] == data[1..9]) {
            t.deliver(&data[9..]);
        }
    }

    /// Кадр `tun` (пакет не влез в датаграмму или путь без датаграмм).
    pub(crate) fn tun_frame(&self, link: LinkId, msg: &Value) {
        let topic = msg.get("r").and_then(|v| v.as_str()).unwrap_or("");
        let Some(d) = msg
            .get("d")
            .and_then(|v| v.as_str())
            .and_then(|d| B64.decode(d).ok())
        else {
            return;
        };
        if let Some(t) = self.tun_find(link, |t| t.topic == topic) {
            t.deliver(&d);
        }
    }

    /// Туннель комнаты (сокет открываем при первой надобности).
    fn tun_ensure(self: &Arc<Self>, topic: &str, link: LinkId) -> Option<Arc<Tun>> {
        let mut ts = self.tun_lock();
        let r = ts.rooms.entry(topic.to_string()).or_default();
        if let Some(t) = &r.tun {
            *t.link.lock().unwrap_or_else(|e| e.into_inner()) = Some(link);
            return Some(t.clone());
        }
        let ip = local_ipv4();
        let std_sock = std::net::UdpSocket::bind((ip, 0))
            .or_else(|_| std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)))
            .ok()?;
        std_sock.set_nonblocking(true).ok()?;
        let addr = std_sock.local_addr().ok()?;
        let _guard = self.rt.enter();
        let sock = Arc::new(tokio::net::UdpSocket::from_std(std_sock).ok()?);
        let t = Arc::new(Tun {
            topic: topic.to_string(),
            tag: tag_of(topic),
            addr,
            sock,
            link: Mutex::new(Some(link)),
            browser: Mutex::new(Learned::default()),
            rx: AtomicU64::new(0),
            tx: AtomicU64::new(0),
            tx_frames: AtomicU64::new(0),
            task: Mutex::new(None),
        });
        let h = self.rt.spawn(pump(Arc::downgrade(self), t.clone()));
        *t.task.lock().unwrap_or_else(|e| e.into_inner()) = Some(h.abort_handle());
        tracing::info!("туннель: комната {} → {addr}", &topic[..8.min(topic.len())]);
        r.tun = Some(t.clone());
        Some(t)
    }

    /// Сообщение собеседника в комнате звонка (1:1) перед отдачей окну: запоминаем собеседника-
    /// приложение, в его SDP добавляем кандидата туннеля. `None` — не отдавать (режим проверки).
    pub(crate) fn tun_on_msg(
        self: &Arc<Self>,
        topic: &str,
        typ: &str,
        from: &str,
        mut msg: Value,
    ) -> Option<Value> {
        let only = only_mode();
        match typ {
            "hello" | "hi" | "g_hi" => {
                if let Some(id) = msg
                    .get("zv")
                    .and_then(|z| z.get("id"))
                    .and_then(|v| v.as_str())
                    .filter(|s| zv_p2p::valid_id(s))
                {
                    let mut ts = self.tun_lock();
                    let r = ts.rooms.entry(topic.to_string()).or_default();
                    r.peer_from = Some(from.to_string());
                    r.peer_node = Some(id.to_string());
                }
            }
            "desc" | "g_desc" => {
                let (link, is_peer) = {
                    let mut ts = self.tun_lock();
                    let r = ts.rooms.entry(topic.to_string()).or_default();
                    let is_peer = r.peer_from.as_deref() == Some(from);
                    if is_peer {
                        r.last_desc = Some(msg.clone());
                    }
                    (r.link, is_peer)
                };
                let tun = match link {
                    Some(l) if is_peer && self.tunnel_enabled() => self.tun_ensure(topic, l),
                    _ => None,
                };
                if let Some(sdp) = msg
                    .get("desc")
                    .and_then(|d| d.get("sdp"))
                    .and_then(|v| v.as_str())
                {
                    let mut sdp = sdp.to_string();
                    if only {
                        sdp = sdp_strip_candidates(&sdp);
                    }
                    if let Some(t) = &tun
                        && let Some(s) = sdp_add_candidate(&sdp, &t.candidate())
                    {
                        sdp = s;
                    }
                    msg["desc"]["sdp"] = json!(sdp);
                }
            }
            "cand" | "g_cand" if only => return None,
            _ => {}
        }
        Some(msg)
    }

    /// Комнату привязали к линку (bind собеседника). `tun` — собеседник умеет туннель.
    pub(crate) fn tun_bound(self: &Arc<Self>, topic: &str, link: LinkId, peer: &str, tun: bool) {
        if !tun || !self.tunnel_enabled() {
            return;
        }
        let desc = {
            let mut ts = self.tun_lock();
            let r = ts.rooms.entry(topic.to_string()).or_default();
            if r.peer_node.as_deref().is_some_and(|p| p != peer) {
                return;
            }
            r.link = Some(link);
            if let Some(t) = &r.tun {
                *t.link.lock().unwrap_or_else(|e| e.into_inner()) = Some(link);
            }
            r.last_desc.clone()
        };
        // описание собеседника уже у окна — досылаем кандидата туннеля отдельно (trickle)
        if let Some(d) = desc
            && let Some(t) = self.tun_ensure(topic, link)
        {
            let sdp = d
                .get("desc")
                .and_then(|x| x.get("sdp"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut m = d.clone();
            let g = d.get("type").and_then(|v| v.as_str()) == Some("g_desc");
            if let Some(o) = m.as_object_mut() {
                o.remove("desc");
                o.insert("type".into(), json!(if g { "g_cand" } else { "cand" }));
                o.insert(
                    "cand".into(),
                    json!({
                        "candidate": t.candidate(),
                        "sdpMid": sdp_first_attr(sdp, "mid").unwrap_or_else(|| "0".into()),
                        "sdpMLineIndex": 0,
                        "usernameFragment": sdp_first_attr(sdp, "ice-ufrag"),
                    }),
                );
            }
            self.emit("room:msg", json!({"roomId": topic, "msg": m}));
        }
    }

    /// Линк закрылся: туннели на нём ждут нового (пакеты пока теряются).
    pub(crate) fn tun_link_down(&self, link: LinkId) {
        let mut ts = self.tun_lock();
        for r in ts.rooms.values_mut() {
            if r.link == Some(link) {
                r.link = None;
                if let Some(t) = &r.tun {
                    *t.link.lock().unwrap_or_else(|e| e.into_inner()) = None;
                }
            }
        }
    }

    /// Звонок закончился (комнату отвязали от P2P) — закрыть туннель.
    pub(crate) fn tun_close(&self, topic: &str) {
        if let Some(r) = self.tun_lock().rooms.remove(topic)
            && let Some(t) = r.tun
        {
            t.stop();
            tracing::info!(
                "туннель: комната {} закрыта (к браузеру {}, от него {}, кадрами {})",
                &topic[..8.min(topic.len())],
                t.rx.load(Ordering::Relaxed),
                t.tx.load(Ordering::Relaxed),
                t.tx_frames.load(Ordering::Relaxed)
            );
        }
    }

    pub(crate) fn tun_close_all(&self) {
        let rooms: Vec<String> = self.tun_lock().rooms.keys().cloned().collect();
        for r in rooms {
            self.tun_close(&r);
        }
    }

    pub(crate) fn tun_status(&self) -> Value {
        Value::Array(
            self.tun_lock()
                .rooms
                .values()
                .filter_map(|r| r.tun.as_ref().map(|t| t.json()))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SDP: &str = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\n\
        m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:abcd\r\na=mid:0\r\n\
        a=candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host\r\n\
        m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\n";

    #[test]
    fn candidate_into_first_section() {
        let a: SocketAddr = "10.0.0.7:40000".parse().unwrap();
        let c = candidate_line(a);
        assert!(c.starts_with("candidate:zvtun 1 udp 1526726655 10.0.0.7 40000 typ srflx"));
        let s = sdp_add_candidate(SDP, &c).unwrap();
        let lines: Vec<&str> = s.split("\r\n").collect();
        let i = lines.iter().position(|l| l.contains("zvtun")).unwrap();
        assert_eq!(lines[i + 1], "m=video 9 UDP/TLS/RTP/SAVPF 96");
        assert!(s.ends_with("a=mid:1\r\n"));
        // повтор не дублирует
        assert_eq!(sdp_add_candidate(&s, &c).unwrap(), s);
        // только туннель
        let o = sdp_strip_candidates(&s);
        assert!(!o.contains("192.168.1.5") && o.contains("zvtun"));
        assert_eq!(sdp_first_attr(&s, "mid").as_deref(), Some("0"));
        assert_eq!(sdp_first_attr(&s, "ice-ufrag").as_deref(), Some("abcd"));
        // одна m-секция, без хвостового перевода строки и с end-of-candidates
        let one = "v=0\nm=audio 9 X 0\na=mid:0\na=end-of-candidates";
        let s1 = sdp_add_candidate(one, &c).unwrap();
        assert!(s1.ends_with(&format!("a={c}\na=end-of-candidates")));
        assert!(sdp_add_candidate("v=0\r\n", &c).is_none());
    }

    #[test]
    fn priority_between_srflx_and_relay() {
        let srflx_min = 100u32 << 24;
        let relay_max = 3u32 << 24;
        assert!(PRIO < srflx_min && PRIO > relay_max);
    }
}
