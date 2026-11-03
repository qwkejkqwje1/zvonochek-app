//! P2P между приложениями ZVONochek (протокол ZV4) поверх iroh.
//!
//! Постоянный ID устройства — EndpointId (Ed25519 из мастер-сида). Соединения — QUIC с пробитием
//! NAT, релеями n0 (HTTPS, TCP 443) и поиском адреса по ID (DNS/pkarr n0). Каждое соединение —
//! «линк»: один двунаправленный управляющий поток с кадрами JSON (длина u32 BE + UTF-8, ≤ 256 КБ)
//! и QUIC-датаграммы (голос). Первый кадр с обеих сторон — `hello4`.
//!
//! Допуск входящих решает ядро: до `authorize()` принимаются только `bind`, `contact_req`,
//! `contact_offer`, `ping`/`pong`; не допущенный за 8 с линк закрывается.

pub mod crypto;

use bytes::Bytes;
use iroh::endpoint::{Connection, RecvStream, SendStream, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey, TransportAddr, Watcher};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

pub use iroh;
pub use iroh::endpoint::{RecvStream as StreamRecv, SendStream as StreamSend};

pub const ALPN: &[u8] = b"zv/4";
pub const PROTO: u64 = 1;
pub const MAX_FRAME: usize = 256 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(8);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const ADMIT_TIMEOUT: Duration = Duration::from_secs(8);
/// Что принимается до допуска (ядро проверит доказательства).
const PRE_AUTH: [&str; 5] = ["bind", "contact_req", "contact_offer", "ping", "pong"];

pub type LinkId = u64;

pub enum Event {
    /// Линк поднят (рукопожатие `hello4` прошло). Исходящие допущены сразу.
    LinkUp {
        link: LinkId,
        peer: String,
        outbound: bool,
        hello: Value,
    },
    Msg {
        link: LinkId,
        peer: String,
        msg: Value,
    },
    Datagram {
        link: LinkId,
        peer: String,
        data: Bytes,
    },
    LinkDown {
        link: LinkId,
        peer: String,
        reason: String,
    },
    /// Собеседник открыл дополнительный поток (файлы). Только у допущенных линков.
    Stream {
        link: LinkId,
        peer: String,
        send: SendStream,
        recv: RecvStream,
    },
}

impl std::fmt::Debug for Event {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Event::LinkUp { link, outbound, .. } => write!(f, "LinkUp({link}, out={outbound})"),
            Event::Msg { link, msg, .. } => {
                write!(f, "Msg({link}, {})", msg.get("t").unwrap_or(&Value::Null))
            }
            Event::Datagram { link, data, .. } => write!(f, "Datagram({link}, {} B)", data.len()),
            Event::LinkDown { link, reason, .. } => write!(f, "LinkDown({link}, {reason})"),
            Event::Stream { link, .. } => write!(f, "Stream({link})"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    /// Секретный ключ устройства (seed Ed25519), см. `crypto::endpoint_secret`.
    pub secret: [u8; 32],
    pub app_version: String,
    pub name: String,
    pub caps: Vec<String>,
    /// Релеи и поиск адресов n0. `false` — только прямые адреса (тесты в изоляции).
    pub n0: bool,
}

struct Link {
    id: LinkId,
    peer_s: String,
    conn: Connection,
    tx: mpsc::UnboundedSender<Bytes>,
    outbound: bool,
    authorized: AtomicBool,
    alive: AtomicBool,
    opened: u64,
    remote: Mutex<Value>,
    sent: AtomicU64,
    recvd: AtomicU64,
}

struct Inner {
    ep: Endpoint,
    me: String,
    links: Mutex<HashMap<LinkId, Arc<Link>>>,
    next: AtomicU64,
    events: mpsc::UnboundedSender<Event>,
    hello: Mutex<Map<String, Value>>,
}

/// Узел P2P. Клонируется.
#[derive(Clone)]
pub struct Node {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn encode_frame(v: &Value) -> Bytes {
    let body = serde_json::to_vec(v).unwrap_or_default();
    let mut b = Vec::with_capacity(body.len() + 4);
    b.extend_from_slice(&(body.len() as u32).to_be_bytes());
    b.extend_from_slice(&body);
    Bytes::from(b)
}

pub async fn read_frame(recv: &mut RecvStream) -> anyhow::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match recv.read_exact(&mut len).await {
        Ok(()) => {}
        Err(iroh::endpoint::ReadExactError::FinishedEarly(0)) => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let n = u32::from_be_bytes(len) as usize;
    anyhow::ensure!(n <= MAX_FRAME, "кадр {n} байт — больше предела");
    let mut buf = vec![0u8; n];
    recv.read_exact(&mut buf).await?;
    Ok(Some(serde_json::from_slice(&buf)?))
}

fn is_hello4(v: &Value) -> bool {
    v.get("t").and_then(|t| t.as_str()) == Some("hello4")
        && v.get("proto").and_then(|p| p.as_u64()).unwrap_or(0) >= 1
}

/// Адрес собеседника: ID + подсказки `{r: релей, a: ["ip:port", …]}` (из `hello` или контакта).
pub fn endpoint_addr(peer: &str, hint: Option<&Value>) -> anyhow::Result<EndpointAddr> {
    let id = EndpointId::from_str(peer.trim())?;
    let mut addrs = Vec::new();
    if let Some(h) = hint {
        if let Some(r) = h
            .get("r")
            .and_then(|v| v.as_str())
            .and_then(|s| RelayUrl::from_str(s).ok())
        {
            addrs.push(TransportAddr::Relay(r));
        }
        if let Some(a) = h.get("a").and_then(|v| v.as_array()) {
            for s in a.iter().filter_map(|v| v.as_str()).take(12) {
                if let Ok(sa) = SocketAddr::from_str(s) {
                    addrs.push(TransportAddr::Ip(sa));
                }
            }
        }
    }
    Ok(EndpointAddr::from_parts(id, addrs))
}

fn addr_of(ep: &Endpoint, me: &str) -> Value {
    let a = ep.addr();
    let ips: Vec<String> = a
        .ip_addrs()
        .filter(|s| match s.ip() {
            std::net::IpAddr::V4(v) => !v.is_unspecified(),
            std::net::IpAddr::V6(v) => !v.is_unspecified() && !v.is_loopback(),
        })
        .take(8)
        .map(|s| s.to_string())
        .collect();
    let mut o = Map::new();
    o.insert("id".into(), json!(me));
    if let Some(r) = a.relay_urls().next() {
        o.insert("r".into(), json!(r.to_string()));
    }
    if !ips.is_empty() {
        o.insert("a".into(), json!(ips));
    }
    Value::Object(o)
}

pub fn valid_id(s: &str) -> bool {
    s.len() == 64 && EndpointId::from_str(s).is_ok()
}

impl Node {
    pub async fn start(cfg: Config, events: mpsc::UnboundedSender<Event>) -> anyhow::Result<Node> {
        let sk = SecretKey::from_bytes(&cfg.secret);
        let b = if cfg.n0 {
            Endpoint::builder(presets::N0)
        } else {
            Endpoint::builder(presets::Minimal).relay_mode(iroh::RelayMode::Disabled)
        };
        let ep = b.secret_key(sk).alpns(vec![ALPN.to_vec()]).bind().await?;
        let me = ep.id().to_string();
        let mut hello = Map::new();
        hello.insert("t".into(), json!("hello4"));
        hello.insert("proto".into(), json!(PROTO));
        hello.insert("app".into(), json!(cfg.app_version));
        hello.insert("caps".into(), json!(cfg.caps));
        hello.insert("name".into(), json!(cfg.name));
        let inner = Arc::new(Inner {
            ep,
            me,
            links: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            events,
            hello: Mutex::new(hello),
        });
        tokio::spawn(accept_loop(inner.clone()));
        Ok(Node { inner })
    }

    pub fn id(&self) -> &str {
        &self.inner.me
    }

    pub fn id_bytes(&self) -> [u8; 32] {
        *self.inner.ep.id().as_bytes()
    }

    pub fn secret_bytes(&self) -> [u8; 32] {
        self.inner.ep.secret_key().to_bytes()
    }

    pub fn set_name(&self, name: &str) {
        self.inner.lock_hello().insert("name".into(), json!(name));
    }

    /// Наш адрес для `hello` веб-протокола и кодов приглашения: `{id, r, a}`.
    pub fn addr_json(&self) -> Value {
        addr_of(&self.inner.ep, &self.inner.me)
    }

    /// Подождать подключения к домашнему релею (не дольше `t`).
    pub async fn online(&self, t: Duration) -> bool {
        tokio::time::timeout(t, self.inner.ep.online())
            .await
            .is_ok()
    }

    /// Установить исходящий линк (или вернуть живой допущенный к этому собеседнику).
    pub async fn connect(&self, peer: &str, hint: Option<&Value>) -> anyhow::Result<LinkId> {
        if let Some(l) = self.link_for(peer) {
            return Ok(l);
        }
        let addr = endpoint_addr(peer, hint)?;
        anyhow::ensure!(addr.id != self.inner.ep.id(), "это ваш собственный ID");
        let conn = tokio::time::timeout(CONNECT_TIMEOUT, self.inner.ep.connect(addr, ALPN))
            .await
            .map_err(|_| anyhow::anyhow!("нет ответа"))??;
        let (mut send, mut recv) = conn.open_bi().await?;
        let hello = self.inner.hello_now();
        send.write_all(&encode_frame(&hello)).await?;
        let first = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut recv))
            .await
            .map_err(|_| anyhow::anyhow!("нет hello4"))??
            .ok_or_else(|| anyhow::anyhow!("поток закрыт"))?;
        anyhow::ensure!(is_hello4(&first), "собеседник не ZVONochek 4");
        Ok(self.inner.clone().add_link(conn, true, first, send, recv))
    }

    /// Лучший живой допущенный линк к собеседнику (самый новый).
    pub fn link_for(&self, peer: &str) -> Option<LinkId> {
        let links = self.inner.lock_links();
        links
            .values()
            .filter(|l| {
                l.peer_s == peer
                    && l.alive.load(Ordering::Relaxed)
                    && l.authorized.load(Ordering::Relaxed)
            })
            .max_by_key(|l| l.id)
            .map(|l| l.id)
    }

    pub fn peer_of(&self, link: LinkId) -> Option<String> {
        self.inner.lock_links().get(&link).map(|l| l.peer_s.clone())
    }

    pub fn is_alive(&self, link: LinkId) -> bool {
        self.inner
            .lock_links()
            .get(&link)
            .map(|l| l.alive.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    pub fn is_authorized(&self, link: LinkId) -> bool {
        self.inner
            .lock_links()
            .get(&link)
            .map(|l| l.authorized.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    pub fn remote_hello(&self, link: LinkId) -> Value {
        self.inner
            .lock_links()
            .get(&link)
            .map(|l| l.remote.lock().unwrap_or_else(|e| e.into_inner()).clone())
            .unwrap_or(Value::Null)
    }

    pub fn authorize(&self, link: LinkId) {
        if let Some(l) = self.inner.lock_links().get(&link) {
            l.authorized.store(true, Ordering::Relaxed);
        }
    }

    pub fn send(&self, link: LinkId, msg: &Value) -> bool {
        let Some(l) = self.inner.lock_links().get(&link).cloned() else {
            return false;
        };
        if !l.alive.load(Ordering::Relaxed) {
            return false;
        }
        l.sent.fetch_add(1, Ordering::Relaxed);
        l.tx.send(encode_frame(msg)).is_ok()
    }

    /// Отправить собеседнику по лучшему линку.
    pub fn send_peer(&self, peer: &str, msg: &Value) -> bool {
        match self.link_for(peer) {
            Some(l) => self.send(l, msg),
            None => false,
        }
    }

    /// Датаграмма (без гарантий). `false` — не влезла или линк мёртв.
    pub fn send_datagram(&self, link: LinkId, data: Bytes) -> bool {
        let Some(l) = self.inner.lock_links().get(&link).cloned() else {
            return false;
        };
        if !l.alive.load(Ordering::Relaxed) {
            return false;
        }
        match l.conn.max_datagram_size() {
            Some(max) if data.len() <= max => {
                l.sent.fetch_add(1, Ordering::Relaxed);
                l.conn.send_datagram(data).is_ok()
            }
            _ => false,
        }
    }

    /// Открыть дополнительный поток к собеседнику (файлы). Первый кадр пишет вызывающий.
    pub async fn open_stream(&self, link: LinkId) -> anyhow::Result<(SendStream, RecvStream)> {
        let l = self
            .inner
            .lock_links()
            .get(&link)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("нет линка"))?;
        anyhow::ensure!(l.alive.load(Ordering::Relaxed), "линк закрыт");
        Ok(l.conn.open_bi().await?)
    }

    pub fn close_link(&self, link: LinkId, reason: &str) {
        let l = self.inner.lock_links().get(&link).cloned();
        if let Some(l) = l {
            l.conn.close(0u32.into(), reason.as_bytes());
        }
    }

    /// Путь линка: `direct` / `relay` и RTT, мс.
    pub fn path(&self, link: LinkId) -> (String, Option<u64>) {
        let Some(l) = self.inner.lock_links().get(&link).cloned() else {
            return ("none".into(), None);
        };
        let paths = l.conn.paths();
        let sel = paths.iter().find(|p| p.is_selected());
        match sel {
            Some(p) => (
                (if p.is_relay() { "relay" } else { "direct" }).into(),
                Some(p.rtt().as_millis() as u64),
            ),
            None => ("none".into(), None),
        }
    }

    /// Для диагностики.
    pub fn status(&self) -> Value {
        let relays: Vec<Value> = self
            .inner
            .ep
            .home_relay_status()
            .get()
            .iter()
            .map(|r| json!({"url": r.url().to_string(), "connected": r.is_connected()}))
            .collect();
        let links: Vec<Arc<Link>> = self.inner.lock_links().values().cloned().collect();
        let mut lv = Vec::new();
        for l in links {
            let (path, rtt) = self.path(l.id);
            let name = l
                .remote
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get("name")
                .cloned()
                .unwrap_or(Value::Null);
            lv.push(json!({
                "link": l.id,
                "peer": &l.peer_s[..12.min(l.peer_s.len())],
                "name": name,
                "outbound": l.outbound,
                "authorized": l.authorized.load(Ordering::Relaxed),
                "path": path,
                "rttMs": rtt,
                "ageS": now_ms().saturating_sub(l.opened) / 1000,
                "tx": l.sent.load(Ordering::Relaxed),
                "rx": l.recvd.load(Ordering::Relaxed),
            }));
        }
        json!({"id": self.inner.me, "addr": self.addr_json(), "relays": relays, "links": lv})
    }

    pub async fn shutdown(&self) {
        let links: Vec<Arc<Link>> = self.inner.lock_links().values().cloned().collect();
        for l in links {
            l.conn.close(0u32.into(), b"bye");
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), self.inner.ep.close()).await;
    }
}

impl Inner {
    fn lock_links(&self) -> std::sync::MutexGuard<'_, HashMap<LinkId, Arc<Link>>> {
        self.links.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn lock_hello(&self) -> std::sync::MutexGuard<'_, Map<String, Value>> {
        self.hello.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `hello4` с текущими адресами (релей появляется не сразу).
    fn hello_now(&self) -> Value {
        let mut h = self.lock_hello().clone();
        h.insert("addr".into(), addr_of(&self.ep, &self.me));
        Value::Object(h)
    }

    fn add_link(
        self: Arc<Self>,
        conn: Connection,
        outbound: bool,
        remote: Value,
        send: SendStream,
        recv: RecvStream,
    ) -> LinkId {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let peer = conn.remote_id();
        let link = Arc::new(Link {
            id,
            peer_s: peer.to_string(),
            conn,
            tx,
            outbound,
            authorized: AtomicBool::new(outbound),
            alive: AtomicBool::new(true),
            opened: now_ms(),
            remote: Mutex::new(remote.clone()),
            sent: AtomicU64::new(0),
            recvd: AtomicU64::new(0),
        });
        self.lock_links().insert(id, link.clone());
        let _ = self.events.send(Event::LinkUp {
            link: id,
            peer: link.peer_s.clone(),
            outbound,
            hello: remote,
        });
        if !outbound {
            let l = link.clone();
            tokio::spawn(async move {
                tokio::time::sleep(ADMIT_TIMEOUT).await;
                if !l.authorized.load(Ordering::Relaxed) {
                    l.conn.close(1u32.into(), b"unauthorized");
                }
            });
        }
        tokio::spawn(self.clone().accept_streams(link.clone()));
        tokio::spawn(self.run_link(link, send, recv, rx));
        id
    }

    /// Дополнительные потоки линка (передача файлов): только у допущенных.
    async fn accept_streams(self: Arc<Self>, link: Arc<Link>) {
        while let Ok((send, mut recv)) = link.conn.accept_bi().await {
            if !link.authorized.load(Ordering::Relaxed) {
                let _ = recv.stop(3u32.into());
                continue;
            }
            let _ = self.events.send(Event::Stream {
                link: link.id,
                peer: link.peer_s.clone(),
                send,
                recv,
            });
        }
    }

    async fn run_link(
        self: Arc<Self>,
        link: Arc<Link>,
        mut send: SendStream,
        mut recv: RecvStream,
        mut rx: mpsc::UnboundedReceiver<Bytes>,
    ) {
        let writer = tokio::spawn(async move {
            while let Some(b) = rx.recv().await {
                if send.write_all(&b).await.is_err() {
                    break;
                }
            }
            let _ = send.finish();
        });
        let reason = loop {
            tokio::select! {
                f = read_frame(&mut recv) => match f {
                    Ok(Some(v)) => {
                        link.recvd.fetch_add(1, Ordering::Relaxed);
                        let t = v.get("t").and_then(|t| t.as_str()).unwrap_or("");
                        if t == "hello4" {
                            *link.remote.lock().unwrap_or_else(|e| e.into_inner()) = v;
                            continue;
                        }
                        if !link.authorized.load(Ordering::Relaxed) && !PRE_AUTH.contains(&t) {
                            continue;
                        }
                        let _ = self.events.send(Event::Msg { link: link.id, peer: link.peer_s.clone(), msg: v });
                    }
                    Ok(None) => break "поток закрыт".to_string(),
                    Err(e) => break e.to_string(),
                },
                d = link.conn.read_datagram() => match d {
                    Ok(data) => {
                        link.recvd.fetch_add(1, Ordering::Relaxed);
                        if link.authorized.load(Ordering::Relaxed) {
                            let _ = self.events.send(Event::Datagram { link: link.id, peer: link.peer_s.clone(), data });
                        }
                    }
                    Err(e) => break e.to_string(),
                },
            }
        };
        link.alive.store(false, Ordering::Relaxed);
        writer.abort();
        link.conn.close(0u32.into(), b"done");
        self.lock_links().remove(&link.id);
        let _ = self.events.send(Event::LinkDown {
            link: link.id,
            peer: link.peer_s.clone(),
            reason,
        });
    }
}

async fn accept_loop(inner: Arc<Inner>) {
    while let Some(incoming) = inner.ep.accept().await {
        let inner = inner.clone();
        tokio::spawn(async move {
            let Ok(conn) = incoming.await else { return };
            let r = async {
                let (mut send, mut recv) =
                    tokio::time::timeout(HELLO_TIMEOUT, conn.accept_bi()).await??;
                let first = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut recv)).await??;
                let first = first.ok_or_else(|| anyhow::anyhow!("пусто"))?;
                anyhow::ensure!(is_hello4(&first), "не hello4");
                let hello = inner.hello_now();
                send.write_all(&encode_frame(&hello)).await?;
                Ok::<_, anyhow::Error>((send, recv, first))
            }
            .await;
            match r {
                Ok((send, recv, first)) => {
                    inner.add_link(conn, false, first, send, recv);
                }
                Err(e) => {
                    tracing::debug!("p2p: входящее отклонено: {e}");
                    conn.close(2u32.into(), b"handshake");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn node(seed: u8) -> (Node, mpsc::UnboundedReceiver<Event>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let cfg = Config {
            secret: crypto::endpoint_secret(&[seed; 32]),
            app_version: "test".into(),
            name: format!("n{seed}"),
            caps: vec![],
            n0: false,
        };
        (Node::start(cfg, tx).await.unwrap(), rx)
    }

    async fn next_msg(rx: &mut mpsc::UnboundedReceiver<Event>) -> (LinkId, Value) {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap()
            {
                Event::Msg { link, msg, .. } => return (link, msg),
                _ => continue,
            }
        }
    }

    #[tokio::test]
    async fn link_frames_admission_datagrams() {
        let (a, mut arx) = node(1).await;
        let (b, mut brx) = node(2).await;
        let hint = b.addr_json();
        let la = a.connect(b.id(), Some(&hint)).await.unwrap();
        // до допуска проходит только bind
        a.send(la, &json!({"t": "secret"}));
        a.send(la, &json!({"t": "bind", "r": "x"}));
        let (lb, m) = next_msg(&mut brx).await;
        assert_eq!(m["t"], "bind");
        assert_eq!(b.peer_of(lb).as_deref(), Some(a.id()));
        b.authorize(lb);
        b.send(lb, &json!({"t": "pong", "n": 1}));
        let (_, m) = next_msg(&mut arx).await;
        assert_eq!(m["t"], "pong");
        a.send(la, &json!({"t": "env", "d": "x".repeat(70_000)}));
        let (_, m) = next_msg(&mut brx).await;
        assert_eq!(m["d"].as_str().unwrap().len(), 70_000);
        assert!(a.send_datagram(la, Bytes::from_static(b"Evoice")));
        loop {
            match tokio::time::timeout(Duration::from_secs(5), brx.recv())
                .await
                .unwrap()
                .unwrap()
            {
                Event::Datagram { data, .. } => {
                    assert_eq!(&data[..], b"Evoice");
                    break;
                }
                _ => continue,
            }
        }
        assert_eq!(a.link_for(b.id()), Some(la));
        assert_eq!(a.path(la).0, "direct");
        a.close_link(la, "test");
        loop {
            if let Event::LinkDown { link, .. } =
                tokio::time::timeout(Duration::from_secs(5), brx.recv())
                    .await
                    .unwrap()
                    .unwrap()
            {
                assert_eq!(link, lb);
                break;
            }
        }
    }

    /// Через настоящие релеи n0 (нужен интернет): `cargo test -p zv-p2p -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn relay_and_discovery_n0() {
        let mk = |seed: u8| {
            let (tx, rx) = mpsc::unbounded_channel();
            let cfg = Config {
                secret: crypto::endpoint_secret(&[seed; 32]),
                app_version: "test".into(),
                name: format!("r{seed}"),
                caps: vec![],
                n0: true,
            };
            async move { (Node::start(cfg, tx).await.unwrap(), rx) }
        };
        let (a, _arx) = mk(11).await;
        let (b, mut brx) = mk(12).await;
        assert!(
            a.online(Duration::from_secs(15)).await,
            "a не подключился к релею"
        );
        assert!(
            b.online(Duration::from_secs(15)).await,
            "b не подключился к релею"
        );
        println!("a: {}", a.addr_json());
        // только ID: адрес найдётся через DNS/pkarr n0
        let t0 = std::time::Instant::now();
        let la = a.connect(b.id(), None).await.unwrap();
        println!("по одному ID: {:?}, путь {:?}", t0.elapsed(), a.path(la));
        a.send(la, &json!({"t": "ping"}));
        let (_, m) = next_msg(&mut brx).await;
        assert_eq!(m["t"], "ping");
        tokio::time::sleep(Duration::from_secs(3)).await;
        println!("через 3 с путь {:?}; статус {}", a.path(la), a.status());
    }

    #[tokio::test]
    async fn extra_streams_for_files() {
        let (a, _arx) = node(5).await;
        let (b, mut brx) = node(6).await;
        let la = a.connect(b.id(), Some(&b.addr_json())).await.unwrap();
        a.send(la, &json!({"t": "bind"}));
        let (lb, _) = next_msg(&mut brx).await;
        b.authorize(lb);
        // a → b: запрос и 1 МБ данных в ответ
        let (mut s, mut r) = a.open_stream(la).await.unwrap();
        s.write_all(&encode_frame(&json!({"t": "get", "fid": "x"})))
            .await
            .unwrap();
        let (mut bs, mut br) = loop {
            match tokio::time::timeout(Duration::from_secs(5), brx.recv())
                .await
                .unwrap()
                .unwrap()
            {
                Event::Stream {
                    send, recv, link, ..
                } => {
                    assert_eq!(link, lb);
                    break (send, recv);
                }
                _ => continue,
            }
        };
        let head = read_frame(&mut br).await.unwrap().unwrap();
        assert_eq!(head["fid"], "x");
        let data = vec![7u8; 1 << 20];
        bs.write_all(&encode_frame(&json!({"ok": true, "size": data.len()})))
            .await
            .unwrap();
        bs.write_all(&data).await.unwrap();
        bs.finish().unwrap();
        let ok = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(ok["size"], 1 << 20);
        let got = r.read_to_end(4 << 20).await.unwrap();
        assert_eq!(got.len(), 1 << 20);
        assert!(got.iter().all(|&x| x == 7));
    }

    #[tokio::test]
    async fn unauthorized_inbound_closed() {
        let (a, mut arx) = node(3).await;
        let (b, _brx) = node(4).await;
        let la = a.connect(b.id(), Some(&b.addr_json())).await.unwrap();
        let t0 = std::time::Instant::now();
        loop {
            if let Event::LinkDown { link, .. } =
                tokio::time::timeout(Duration::from_secs(15), arx.recv())
                    .await
                    .unwrap()
                    .unwrap()
            {
                assert_eq!(link, la);
                break;
            }
        }
        assert!(t0.elapsed() >= Duration::from_secs(7));
    }
}
