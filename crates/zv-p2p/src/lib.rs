//! P2P между приложениями ZVONochek (протокол ZV4) поверх двух транспортов: iroh и libp2p
//! (ADR-0002, ADR-0007).
//!
//! Постоянный ID устройства — EndpointId (Ed25519 из мастер-сида); тот же ключ даёт PeerId libp2p.
//! iroh: QUIC с пробитием NAT, релеями n0 и поиском адреса по ID (DNS/pkarr n0). libp2p: TCP/QUIC,
//! mDNS, DHT Amino, релеи circuit v2 и DCUtR (см. `lp`).
//!
//! «Линк» — логическое соединение с собеседником. Под ним один или несколько «путей»
//! (соединение iroh или поток libp2p), у каждого свой управляющий поток с кадрами JSON
//! (длина u32 BE + UTF-8, ≤ 256 КБ); первый кадр с обеих сторон — `hello4`. Кадры идут по лучшему
//! пути (прямой лучше релея, при равенстве — iroh). Умер путь — линк живёт на остальных; не осталось
//! ни одного из-за сбоя — 5 с ждём переподключения, кадры копятся. Датаграммы (голос) — только по
//! пути iroh, иначе ядро шлёт голос кадрами. Собеседники 4.0 (без `mp` в `hello4`) — как раньше:
//! каждое соединение — отдельный линк.
//!
//! Допуск входящих решает ядро: до `authorize()` принимаются только `bind`, `contact_req`,
//! `contact_offer`, `ping`/`pong`; не допущенный за 8 с линк закрывается.

pub mod crypto;
mod lp;
mod stream;

use bytes::Bytes;
use iroh::endpoint::{Connection, ConnectionError, presets};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey, TransportAddr, Watcher};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, mpsc};

pub use iroh;
pub use lp::{DEFAULT_PORT as LP_PORT, LpConfig};
pub use stream::{LpRecv, LpSend, StreamRecv, StreamSend, read_frame};

pub const ALPN: &[u8] = b"zv/4";
pub const PROTO: u64 = 1;
pub const MAX_FRAME: usize = 256 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(8);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// libp2p: дозвон, при необходимости поиск в DHT, открытие потока.
const LP_CONNECT_TIMEOUT: Duration = Duration::from_secs(40);
const ADMIT_TIMEOUT: Duration = Duration::from_secs(8);
/// Сколько линк без путей ждёт переподключения.
const GRACE: Duration = Duration::from_secs(5);
const PENDING_MAX: usize = 512;
/// Не чаще: попытка добавить к линку недостающий транспорт.
const ENSURE_EVERY_MS: u64 = 25_000;
/// Что принимается до допуска (ядро проверит доказательства).
const PRE_AUTH: [&str; 5] = ["bind", "contact_req", "contact_offer", "ping", "pong"];
/// Остальные кадры до допуска ждут его (ядро допускает чуть позже `LinkUp`): не больше стольких.
const HELD_MAX: usize = 64;
const HELD_BYTES: usize = 1 << 20;
/// libp2p: пустой кадр `pk4` раз в 10 с простоя; тишина 35 с — путь мёртв (поток Yamux не всегда
/// узнаёт о гибели своего соединения).
const LP_KEEPALIVE_MS: u64 = 10_000;
const LP_DEAD_MS: u64 = 35_000;
const LP_PROBE_MS: u64 = 3_000;
/// Коды закрытия соединения iroh: 0 — линк закрыт приложением, 1 — не допущен, 2 — рукопожатие,
/// 4 — закрыт только этот путь (линк живёт).
const CLOSE_PATH: u32 = 4;

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
        send: StreamSend,
        recv: StreamRecv,
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
    /// Транспорт iroh.
    pub iroh: bool,
    /// Релеи и поиск адресов n0. `false` — только прямые адреса (тесты в изоляции).
    pub n0: bool,
    /// Транспорт libp2p; `None` — выключен.
    pub lp: Option<LpConfig>,
}

enum Tr {
    Iroh(Connection),
    Lp(libp2p::PeerId),
}

impl Tr {
    fn name(&self) -> &'static str {
        match self {
            Tr::Iroh(_) => "iroh",
            Tr::Lp(_) => "libp2p",
        }
    }
    fn kind(&self) -> usize {
        match self {
            Tr::Iroh(_) => 0,
            Tr::Lp(_) => 1,
        }
    }
}

/// Путь линка: транспортное соединение со своим управляющим потоком.
struct Path {
    pid: u64,
    tr: Tr,
    /// Открыт нами.
    outbound: bool,
    tx: Mutex<Option<mpsc::UnboundedSender<Bytes>>>,
    kill: Notify,
    /// Закрываем только путь (линк живёт): для собеседника это сбой, а не закрытие линка.
    drop_only: AtomicBool,
    /// Когда пришёл последний кадр / ушёл последний кадр, мс.
    last_rx: AtomicU64,
    last_tx: AtomicU64,
    /// libp2p: проверка «жив ли поток» — срок ответа, мс (0 — не проверяем).
    probe: AtomicU64,
}

struct Link {
    id: LinkId,
    peer_s: String,
    outbound: bool,
    /// Собеседник умеет несколько путей в одном линке (`mp` в `hello4`).
    mp: bool,
    authorized: AtomicBool,
    alive: AtomicBool,
    closing: AtomicBool,
    opened: u64,
    remote: Mutex<Value>,
    sent: AtomicU64,
    recvd: AtomicU64,
    paths: Mutex<Vec<Arc<Path>>>,
    primary: AtomicU64,
    /// Кадры, пока нет ни одного пути.
    pending: Mutex<VecDeque<Bytes>>,
    /// Входящие кадры до допуска (и их объём): отдаём ядру при допуске (`admit`).
    held: Mutex<(VecDeque<Value>, usize)>,
    /// Когда последний раз пробовали добавить путь iroh / libp2p.
    tried: Mutex<[u64; 2]>,
    /// Неудачных попыток подряд (интервал повтора удваивается).
    fails: Mutex<[u32; 2]>,
}

struct Inner {
    ep: Option<Endpoint>,
    lp: Option<lp::Lp>,
    me: String,
    pk: [u8; 32],
    secret: [u8; 32],
    links: Mutex<HashMap<LinkId, Arc<Link>>>,
    next: AtomicU64,
    events: mpsc::UnboundedSender<Event>,
    hello: Mutex<Map<String, Value>>,
    closed: AtomicBool,
}

/// Узел P2P. Клонируется.
#[derive(Clone)]
pub struct Node {
    inner: Arc<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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

/// Случайный ID сеанса узла (не секрет — только отличить перезапуск собеседника).
fn session_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(now_ms());
    h.write_u32(std::process::id());
    format!("{:016x}", h.finish())
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
        let pk = sk.public();
        let ep = if cfg.iroh {
            let b = if cfg.n0 {
                Endpoint::builder(presets::N0)
            } else {
                Endpoint::builder(presets::Minimal).relay_mode(iroh::RelayMode::Disabled)
            };
            Some(b.secret_key(sk).alpns(vec![ALPN.to_vec()]).bind().await?)
        } else {
            None
        };
        let (lp, lp_rx) = match cfg.lp.clone() {
            Some(c) => match lp::Lp::start(&cfg.secret, c) {
                Ok((l, rx)) => (Some(l), Some(rx)),
                Err(e) if ep.is_some() => {
                    tracing::warn!("p2p: libp2p не запустился: {e}");
                    (None, None)
                }
                Err(e) => return Err(e),
            },
            None => (None, None),
        };
        anyhow::ensure!(ep.is_some() || lp.is_some(), "нет ни одного транспорта");
        let mut hello = Map::new();
        hello.insert("t".into(), json!("hello4"));
        hello.insert("proto".into(), json!(PROTO));
        hello.insert("mp".into(), json!(1));
        // о закрытии линка поверх libp2p сообщаем кадром `lc4` (см. close_paths)
        hello.insert("lc".into(), json!(1));
        // сеанс узла: другой `s` от того же ID — собеседник перезапустился (см. attach)
        hello.insert("s".into(), json!(session_id()));
        // транспорты этой стороны: недостающий путь не дозваниваем, если у собеседника он выключен
        let tr: Vec<&str> = [(ep.is_some(), "iroh"), (lp.is_some(), "libp2p")]
            .into_iter()
            .filter_map(|(on, n)| on.then_some(n))
            .collect();
        hello.insert("tr".into(), json!(tr));
        hello.insert("app".into(), json!(cfg.app_version));
        hello.insert("caps".into(), json!(cfg.caps));
        hello.insert("name".into(), json!(cfg.name));
        let inner = Arc::new(Inner {
            ep,
            lp,
            me: pk.to_string(),
            pk: *pk.as_bytes(),
            secret: cfg.secret,
            links: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            events,
            hello: Mutex::new(hello),
            closed: AtomicBool::new(false),
        });
        if inner.ep.is_some() {
            tokio::spawn(accept_loop(inner.clone()));
        }
        if let Some(rx) = lp_rx {
            tokio::spawn(lp_events(Arc::downgrade(&inner), rx));
        }
        tokio::spawn(maintain(Arc::downgrade(&inner)));
        Ok(Node { inner })
    }

    pub fn id(&self) -> &str {
        &self.inner.me
    }

    pub fn id_bytes(&self) -> [u8; 32] {
        self.inner.pk
    }

    pub fn secret_bytes(&self) -> [u8; 32] {
        self.inner.secret
    }

    pub fn set_name(&self, name: &str) {
        lock(&self.inner.hello).insert("name".into(), json!(name));
    }

    /// Наш адрес для `hello` веб-протокола и кодов приглашения: `{id, r, a, l}`.
    pub fn addr_json(&self) -> Value {
        self.inner.addr_now()
    }

    /// Подождать подключения к домашнему релею iroh (не дольше `t`).
    pub async fn online(&self, t: Duration) -> bool {
        match &self.inner.ep {
            Some(ep) => tokio::time::timeout(t, ep.online()).await.is_ok(),
            None => true,
        }
    }

    /// Установить исходящий линк (или вернуть живой допущенный к этому собеседнику). Транспорты
    /// дозваниваются параллельно: первый ответивший даёт линк, остальные добавятся к нему путями.
    pub async fn connect(&self, peer: &str, hint: Option<&Value>) -> anyhow::Result<LinkId> {
        if let Some(l) = self.link_for(peer) {
            if let Some(link) = self.inner.get(l) {
                self.inner.ensure_paths(&link, hint);
            }
            return Ok(l);
        }
        let peer = peer.trim().to_string();
        anyhow::ensure!(valid_id(&peer), "неверный ID");
        anyhow::ensure!(peer != self.inner.me, "это ваш собственный ID");
        let (tx, mut rx) = mpsc::unbounded_channel::<(&'static str, anyhow::Result<LinkId>)>();
        for kind in [0usize, 1] {
            if (kind == 0 && self.inner.ep.is_none()) || (kind == 1 && self.inner.lp.is_none()) {
                continue;
            }
            let (me, tx, peer, hint) =
                (self.inner.clone(), tx.clone(), peer.clone(), hint.cloned());
            tokio::spawn(async move {
                let r = me.dial(kind, &peer, hint.as_ref()).await;
                let _ = tx.send((if kind == 0 { "iroh" } else { "libp2p" }, r));
            });
        }
        drop(tx);
        let first = async {
            let mut errs = Vec::new();
            while let Some((name, r)) = rx.recv().await {
                match r {
                    Ok(l) => return Ok(l),
                    Err(e) => errs.push(format!("{name}: {e}")),
                }
            }
            Err(anyhow::anyhow!(errs.join("; ")))
        };
        // у каждого транспорта свои тайм-ауты (libp2p ищет в DHT дольше); здесь — только страховка
        let wait = if self.inner.lp.is_some() {
            LP_CONNECT_TIMEOUT
        } else {
            CONNECT_TIMEOUT
        } + HELLO_TIMEOUT
            + Duration::from_secs(2);
        tokio::time::timeout(wait, first)
            .await
            .map_err(|_| anyhow::anyhow!("нет ответа"))?
    }

    /// Лучший живой допущенный линк к собеседнику (самый новый).
    pub fn link_for(&self, peer: &str) -> Option<LinkId> {
        let links = lock(&self.inner.links);
        links
            .values()
            .filter(|l| {
                l.peer_s == peer
                    && l.alive.load(Ordering::Relaxed)
                    && l.authorized.load(Ordering::Relaxed)
            })
            .max_by_key(|l| (!l.closing.load(Ordering::Relaxed), l.id))
            .map(|l| l.id)
    }

    pub fn peer_of(&self, link: LinkId) -> Option<String> {
        self.inner.get(link).map(|l| l.peer_s.clone())
    }

    pub fn is_alive(&self, link: LinkId) -> bool {
        self.inner
            .get(link)
            .is_some_and(|l| l.alive.load(Ordering::Relaxed))
    }

    pub fn is_authorized(&self, link: LinkId) -> bool {
        self.inner
            .get(link)
            .is_some_and(|l| l.authorized.load(Ordering::Relaxed))
    }

    pub fn remote_hello(&self, link: LinkId) -> Value {
        self.inner
            .get(link)
            .map(|l| lock(&l.remote).clone())
            .unwrap_or(Value::Null)
    }

    pub fn authorize(&self, link: LinkId) {
        if let Some(l) = self.inner.get(link) {
            self.inner.admit(&l);
        }
    }

    pub fn send(&self, link: LinkId, msg: &Value) -> bool {
        let Some(l) = self.inner.get(link) else {
            return false;
        };
        if !l.alive.load(Ordering::Relaxed) {
            return false;
        }
        l.sent.fetch_add(1, Ordering::Relaxed);
        self.inner.push(&l, encode_frame(msg))
    }

    /// Отправить собеседнику по лучшему линку.
    pub fn send_peer(&self, peer: &str, msg: &Value) -> bool {
        match self.link_for(peer) {
            Some(l) => self.send(l, msg),
            None => false,
        }
    }

    /// Датаграмма (без гарантий) по основному пути, если это iroh. `false` — не влезла, путь не
    /// iroh или линк мёртв: тогда ядро шлёт кадром.
    pub fn send_datagram(&self, link: LinkId, data: Bytes) -> bool {
        let Some(l) = self.inner.get(link) else {
            return false;
        };
        if !l.alive.load(Ordering::Relaxed) {
            return false;
        }
        let Some(c) = self.inner.dgram_conn(&l) else {
            return false;
        };
        match c.max_datagram_size() {
            Some(max) if data.len() <= max => {
                l.sent.fetch_add(1, Ordering::Relaxed);
                c.send_datagram(data).is_ok()
            }
            _ => false,
        }
    }

    /// Открыть дополнительный поток к собеседнику (файлы) по основному пути. Первый кадр пишет
    /// вызывающий.
    pub async fn open_stream(&self, link: LinkId) -> anyhow::Result<(StreamSend, StreamRecv)> {
        let l = self
            .inner
            .get(link)
            .ok_or_else(|| anyhow::anyhow!("нет линка"))?;
        anyhow::ensure!(l.alive.load(Ordering::Relaxed), "линк закрыт");
        let p = self
            .inner
            .primary(&l)
            .ok_or_else(|| anyhow::anyhow!("нет пути"))?;
        match &p.tr {
            Tr::Iroh(c) => {
                let (s, r) = c.open_bi().await?;
                Ok((StreamSend::Iroh(s), StreamRecv::Iroh(r)))
            }
            Tr::Lp(peer) => {
                let lp = self
                    .inner
                    .lp
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("libp2p выключен"))?;
                let s = lp.open(*peer, vec![], lp::P_FILE).await?;
                Ok(stream::lp_pair(s))
            }
        }
    }

    pub fn close_link(&self, link: LinkId, reason: &str) {
        if let Some(l) = self.inner.get(link) {
            self.inner.close_paths(&l, 0, reason);
        }
    }

    /// Путь линка: `direct` / `relay` и RTT, мс (по основному пути).
    pub fn path(&self, link: LinkId) -> (String, Option<u64>) {
        let Some(l) = self.inner.get(link) else {
            return ("none".into(), None);
        };
        match self.inner.primary(&l) {
            Some(p) => self.inner.path_info(&p),
            None => ("none".into(), None),
        }
    }

    /// Транспорт основного пути: `iroh` / `libp2p`.
    pub fn transport(&self, link: LinkId) -> Option<&'static str> {
        let l = self.inner.get(link)?;
        self.inner.primary(&l).map(|p| p.tr.name())
    }

    /// Для диагностики.
    pub fn status(&self) -> Value {
        let relays: Vec<Value> = match &self.inner.ep {
            Some(ep) => ep
                .home_relay_status()
                .get()
                .iter()
                .map(|r| json!({"url": r.url().to_string(), "connected": r.is_connected()}))
                .collect(),
            None => vec![],
        };
        let links: Vec<Arc<Link>> = lock(&self.inner.links).values().cloned().collect();
        let mut lv = Vec::new();
        for l in links {
            let (path, rtt) = self.path(l.id);
            let name = lock(&l.remote).get("name").cloned().unwrap_or(Value::Null);
            let main = l.primary.load(Ordering::Relaxed);
            let paths: Vec<Value> = lock(&l.paths)
                .iter()
                .map(|p| {
                    let (k, rtt) = self.inner.path_info(p);
                    json!({"tr": p.tr.name(), "path": k, "rttMs": rtt, "main": p.pid == main, "outbound": p.outbound})
                })
                .collect();
            lv.push(json!({
                "link": l.id,
                "peer": &l.peer_s[..12.min(l.peer_s.len())],
                "name": name,
                "outbound": l.outbound,
                "authorized": l.authorized.load(Ordering::Relaxed),
                "path": path,
                "rttMs": rtt,
                "transport": self.transport(l.id),
                "paths": paths,
                "ageS": now_ms().saturating_sub(l.opened) / 1000,
                "tx": l.sent.load(Ordering::Relaxed),
                "rx": l.recvd.load(Ordering::Relaxed),
            }));
        }
        json!({
            "id": self.inner.me,
            "addr": self.addr_json(),
            "iroh": self.inner.ep.is_some(),
            "relays": relays,
            "libp2p": self.inner.lp.as_ref().map(|l| l.status()),
            "links": lv,
        })
    }

    pub async fn shutdown(&self) {
        self.inner.closed.store(true, Ordering::Relaxed);
        let links: Vec<Arc<Link>> = lock(&self.inner.links).values().cloned().collect();
        for l in links {
            self.inner.close_paths(&l, 0, "bye");
        }
        if let Some(lp) = &self.inner.lp {
            // дать кадрам закрытия уйти
            tokio::time::sleep(Duration::from_millis(200)).await;
            lp.shutdown();
        }
        if let Some(ep) = &self.inner.ep {
            let _ = tokio::time::timeout(Duration::from_secs(2), ep.close()).await;
        }
    }
}

impl Inner {
    fn get(&self, link: LinkId) -> Option<Arc<Link>> {
        lock(&self.links).get(&link).cloned()
    }

    fn addr_now(&self) -> Value {
        let mut o = match &self.ep {
            Some(ep) => addr_of(ep, &self.me),
            None => json!({"id": self.me}),
        };
        if let Some(lp) = &self.lp {
            let l = lp.hint();
            if !l.is_empty() {
                o["l"] = json!(l);
            }
        }
        o
    }

    /// `hello4` с текущими адресами (релей появляется не сразу).
    fn hello_now(&self) -> Value {
        let mut h = lock(&self.hello).clone();
        h.insert("addr".into(), self.addr_now());
        Value::Object(h)
    }

    /// Дозвон одним транспортом: 0 — iroh, 1 — libp2p. Успех — путь в линке собеседника.
    async fn dial(
        self: &Arc<Self>,
        kind: usize,
        peer: &str,
        hint: Option<&Value>,
    ) -> anyhow::Result<LinkId> {
        let (tr, mut send, mut recv) = if kind == 0 {
            let ep = self
                .ep
                .clone()
                .ok_or_else(|| anyhow::anyhow!("iroh выключен"))?;
            let addr = endpoint_addr(peer, hint)?;
            let conn = tokio::time::timeout(CONNECT_TIMEOUT, ep.connect(addr, ALPN))
                .await
                .map_err(|_| anyhow::anyhow!("нет ответа"))??;
            let (s, r) = conn.open_bi().await?;
            (Tr::Iroh(conn), StreamSend::Iroh(s), StreamRecv::Iroh(r))
        } else {
            let lp = self
                .lp
                .clone()
                .ok_or_else(|| anyhow::anyhow!("libp2p выключен"))?;
            let pid = lp::peer_of_id(peer).ok_or_else(|| anyhow::anyhow!("неверный ID"))?;
            let addrs = lp::hint_addrs(hint, &pid);
            let s = tokio::time::timeout(LP_CONNECT_TIMEOUT, lp.open(pid, addrs, lp::P_CTL))
                .await
                .map_err(|_| anyhow::anyhow!("нет ответа"))??;
            let (s, r) = stream::lp_pair(s);
            (Tr::Lp(pid), s, r)
        };
        let r = async {
            send.write_all(&encode_frame(&self.hello_now())).await?;
            let first = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut recv))
                .await
                .map_err(|_| anyhow::anyhow!("нет hello4"))??
                .ok_or_else(|| anyhow::anyhow!("поток закрыт"))?;
            anyhow::ensure!(is_hello4(&first), "собеседник не ZVONochek 4");
            Ok(first)
        }
        .await;
        match r {
            Ok(first) => Ok(self.attach(peer.to_string(), tr, true, first, send, recv, None)),
            Err(e) => {
                if let Tr::Iroh(c) = &tr {
                    c.close(2u32.into(), b"handshake");
                }
                Err(e)
            }
        }
    }

    /// Новый путь: в линк собеседника (если оба умеют `mp`) или в новый линк.
    #[allow(clippy::too_many_arguments)]
    fn attach(
        self: &Arc<Self>,
        peer_s: String,
        tr: Tr,
        outbound: bool,
        remote: Value,
        send: StreamSend,
        recv: StreamRecv,
        first: Option<Bytes>,
    ) -> LinkId {
        let pid = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        if let Some(b) = first {
            let _ = tx.send(b);
        }
        let path = Arc::new(Path {
            pid,
            tr,
            outbound,
            tx: Mutex::new(Some(tx)),
            kill: Notify::new(),
            drop_only: AtomicBool::new(false),
            last_rx: AtomicU64::new(now_ms()),
            last_tx: AtomicU64::new(now_ms()),
            probe: AtomicU64::new(0),
        });
        let mp = remote.get("mp").is_some();
        let mut stale = None;
        let (link, created) = {
            let mut links = lock(&self.links);
            let found = mp
                .then(|| {
                    links
                        .values()
                        .filter(|l| {
                            l.mp && l.peer_s == peer_s
                                && l.alive.load(Ordering::Relaxed)
                                && !l.closing.load(Ordering::Relaxed)
                        })
                        .max_by_key(|l| l.id)
                        .cloned()
                })
                .flatten();
            // другой сеанс (`s` в hello4) — собеседник перезапустился: пути прежнего линка мёртвые,
            // а их таймаут — десятки секунд тишины. Прежний линк закрываем, новому сеансу — новый линк
            let found = match found {
                Some(l) if lock(&l.remote).get("s") != remote.get("s") => {
                    stale = Some(l);
                    None
                }
                f => f,
            };
            let (l, created) = match found {
                Some(l) => (l, false),
                None => {
                    let id = self.next.fetch_add(1, Ordering::Relaxed);
                    let l = Arc::new(Link {
                        id,
                        peer_s: peer_s.clone(),
                        outbound,
                        mp,
                        authorized: AtomicBool::new(outbound),
                        alive: AtomicBool::new(true),
                        closing: AtomicBool::new(false),
                        opened: now_ms(),
                        remote: Mutex::new(remote.clone()),
                        sent: AtomicU64::new(0),
                        recvd: AtomicU64::new(0),
                        paths: Mutex::new(Vec::new()),
                        primary: AtomicU64::new(0),
                        pending: Mutex::new(VecDeque::new()),
                        held: Mutex::new((VecDeque::new(), 0)),
                        tried: Mutex::new([0; 2]),
                        fails: Mutex::new([0; 2]),
                    });
                    links.insert(id, l.clone());
                    (l, true)
                }
            };
            lock(&l.paths).push(path.clone());
            (l, created)
        };
        if let Some(old) = stale {
            tracing::debug!("p2p: собеседник перезапустился — линк {} закрыт", old.id);
            self.close_paths(&old, 0, "restart");
        }
        if outbound {
            self.admit(&link);
        }
        if !created {
            *lock(&link.remote) = remote.clone();
        }
        tracing::debug!(
            "p2p: линк {} + путь {} {} {}",
            link.id,
            pid,
            path.tr.name(),
            if outbound { "→" } else { "←" }
        );
        if created {
            let _ = self.events.send(Event::LinkUp {
                link: link.id,
                peer: peer_s,
                outbound,
                hello: remote,
            });
            if !outbound {
                let (me, l) = (self.clone(), link.clone());
                tokio::spawn(async move {
                    tokio::time::sleep(ADMIT_TIMEOUT).await;
                    if !l.authorized.load(Ordering::Relaxed) && l.alive.load(Ordering::Relaxed) {
                        me.close_paths(&l, 1, "unauthorized");
                    }
                });
            }
        }
        self.spawn_path(link.clone(), path, send, recv, rx);
        self.pick_primary(&link);
        self.flush(&link);
        self.prune(&link);
        link.id
    }

    fn spawn_path(
        self: &Arc<Self>,
        link: Arc<Link>,
        path: Arc<Path>,
        mut send: StreamSend,
        mut recv: StreamRecv,
        mut rx: mpsc::UnboundedReceiver<Bytes>,
    ) {
        let wp = path.clone();
        let writer = tokio::spawn(async move {
            while let Some(b) = rx.recv().await {
                if let Err(e) = send.write_all(&b).await {
                    tracing::debug!("p2p: путь {}: запись: {e}", wp.pid);
                    wp.drop_only.store(true, Ordering::Relaxed);
                    wp.kill.notify_one();
                    return;
                }
                wp.last_tx.store(now_ms(), Ordering::Relaxed);
            }
            let _ = send.finish().await;
        });
        if let Tr::Iroh(conn) = &path.tr {
            let (me, l, c) = (self.clone(), link.clone(), conn.clone());
            tokio::spawn(async move {
                while let Ok(data) = c.read_datagram().await {
                    l.recvd.fetch_add(1, Ordering::Relaxed);
                    if l.authorized.load(Ordering::Relaxed) {
                        let _ = me.events.send(Event::Datagram {
                            link: l.id,
                            peer: l.peer_s.clone(),
                            data,
                        });
                    }
                }
            });
            let (me, l, c) = (self.clone(), link.clone(), conn.clone());
            tokio::spawn(async move {
                while let Ok((s, mut r)) = c.accept_bi().await {
                    if !l.authorized.load(Ordering::Relaxed) {
                        let _ = r.stop(3u32.into());
                        continue;
                    }
                    let _ = me.events.send(Event::Stream {
                        link: l.id,
                        peer: l.peer_s.clone(),
                        send: StreamSend::Iroh(s),
                        recv: StreamRecv::Iroh(r),
                    });
                }
            });
        }
        let me = self.clone();
        tokio::spawn(async move {
            let mut dropped = false;
            let mut peer_closed = false;
            let (mut reason, mut explicit) = loop {
                let f = tokio::select! {
                    f = read_frame(&mut recv) => f,
                    _ = path.kill.notified() => break ("закрыт".to_string(), !path.drop_only.load(Ordering::Relaxed)),
                };
                if f.as_ref().is_ok_and(|x| x.is_some()) {
                    path.last_rx.store(now_ms(), Ordering::Relaxed);
                    path.probe.store(0, Ordering::Relaxed);
                }
                match f {
                    Ok(Some(v)) if v.get("t").and_then(|t| t.as_str()) == Some("path_drop4") => {
                        dropped = true;
                    }
                    Ok(Some(v)) if v.get("t").and_then(|t| t.as_str()) == Some("lc4") => {
                        peer_closed = true;
                    }
                    Ok(Some(v)) if v.get("t").and_then(|t| t.as_str()) == Some("pk4") => {
                        if v.get("q").is_some()
                            && let Some(tx) = lock(&path.tx).as_ref()
                        {
                            let _ = tx.send(encode_frame(&json!({"t": "pk4"})));
                        }
                    }
                    Ok(Some(v)) => me.on_frame(&link, v),
                    // libp2p: конец потока бывает и при обрыве (релейное соединение закрыто после DCUtR) —
                    // закрытие линка собеседник с `lc` объявляет кадром `lc4`, иначе ждём переподключения
                    Ok(None) => {
                        let lc =
                            matches!(path.tr, Tr::Lp(_)) && lock(&link.remote).get("lc").is_some();
                        break (
                            "поток закрыт".to_string(),
                            if lc { peer_closed } else { !dropped },
                        );
                    }
                    Err(e) => break (e.to_string(), false),
                }
            };
            if let Tr::Iroh(c) = &path.tr {
                match c.close_reason() {
                    Some(ConnectionError::ApplicationClosed(a)) => {
                        explicit = a.error_code != CLOSE_PATH.into();
                        reason = String::from_utf8_lossy(&a.reason).into_owned();
                    }
                    Some(ConnectionError::LocallyClosed) => {
                        explicit = !path.drop_only.load(Ordering::Relaxed)
                    }
                    _ => {}
                }
            }
            drop(lock(&path.tx).take());
            if explicit {
                // дописать очередь и закрыть поток аккуратно
                let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
            } else {
                writer.abort();
            }
            if let Tr::Iroh(c) = &path.tr {
                c.close(CLOSE_PATH.into(), b"path");
            }
            me.path_gone(&link, &path, reason, explicit);
        });
    }

    fn on_frame(&self, l: &Link, v: Value) {
        l.recvd.fetch_add(1, Ordering::Relaxed);
        let t = v.get("t").and_then(|t| t.as_str()).unwrap_or("");
        if t == "hello4" {
            *lock(&l.remote) = v;
            return;
        }
        if !PRE_AUTH.contains(&t) && !l.authorized.load(Ordering::Acquire) {
            let mut h = lock(&l.held);
            // admit() отдаёт очередь и ставит флаг под этим же замком — порядок кадров сохраняется
            if !l.authorized.load(Ordering::Acquire) {
                let n = serde_json::to_vec(&v).map_or(0, |b| b.len());
                if h.0.len() < HELD_MAX && h.1 + n <= HELD_BYTES {
                    h.1 += n;
                    h.0.push_back(v);
                }
                return;
            }
        }
        let _ = self.events.send(Event::Msg {
            link: l.id,
            peer: l.peer_s.clone(),
            msg: v,
        });
    }

    /// Допустить линк: кадры, пришедшие до допуска, — ядру, по порядку.
    fn admit(&self, l: &Link) {
        let mut h = lock(&l.held);
        for msg in h.0.drain(..) {
            let _ = self.events.send(Event::Msg {
                link: l.id,
                peer: l.peer_s.clone(),
                msg,
            });
        }
        h.1 = 0;
        l.authorized.store(true, Ordering::Release);
    }

    fn score(&self, p: &Path) -> u8 {
        match &p.tr {
            Tr::Iroh(c) => {
                if iroh_direct(c).unwrap_or(false) {
                    4
                } else {
                    2
                }
            }
            Tr::Lp(peer) => {
                if self
                    .lp
                    .as_ref()
                    .and_then(|lp| lp.is_direct(peer))
                    .unwrap_or(false)
                {
                    3
                } else {
                    1
                }
            }
        }
    }

    /// Выбрать основной путь: лучший по оценке; текущий меняем только на строго лучший.
    fn pick_primary(&self, l: &Link) -> Option<Arc<Path>> {
        let ps = lock(&l.paths);
        let cur = l.primary.load(Ordering::Relaxed);
        let mut best: Option<(u8, &Arc<Path>)> = None;
        for p in ps.iter() {
            let s = self.score(p);
            if best.is_none_or(|(bs, _)| s > bs) {
                best = Some((s, p));
            }
        }
        let (bs, bp) = best?;
        let chosen = match ps.iter().find(|p| p.pid == cur) {
            Some(c) if self.score(c) >= bs => c,
            _ => bp,
        }
        .clone();
        if chosen.pid != cur {
            l.primary.store(chosen.pid, Ordering::Relaxed);
            tracing::debug!(
                "p2p: линк {} идёт по {} (путь {})",
                l.id,
                chosen.tr.name(),
                chosen.pid
            );
        }
        Some(chosen)
    }

    fn primary(&self, l: &Link) -> Option<Arc<Path>> {
        let pid = l.primary.load(Ordering::Relaxed);
        if let Some(p) = lock(&l.paths).iter().find(|p| p.pid == pid) {
            return Some(p.clone());
        }
        self.pick_primary(l)
    }

    /// Соединение для датаграмм (голос): основной путь, если он iroh, иначе лучший путь iroh.
    fn dgram_conn(&self, l: &Link) -> Option<Connection> {
        if let Some(p) = self.primary(l)
            && let Tr::Iroh(c) = &p.tr
        {
            return Some(c.clone());
        }
        let paths = lock(&l.paths).clone();
        paths
            .iter()
            .filter(|p| matches!(p.tr, Tr::Iroh(_)))
            .max_by_key(|p| self.score(p))
            .and_then(|p| match &p.tr {
                Tr::Iroh(c) => Some(c.clone()),
                Tr::Lp(_) => None,
            })
    }

    fn primary_tx(&self, l: &Link) -> Option<mpsc::UnboundedSender<Bytes>> {
        self.primary(l).and_then(|p| lock(&p.tx).clone())
    }

    /// Кадр в основной путь; путей нет — в очередь до переподключения.
    fn push(&self, l: &Link, b: Bytes) -> bool {
        let mut q = lock(&l.pending);
        if let Some(tx) = self.primary_tx(l) {
            while let Some(x) = q.front() {
                if tx.send(x.clone()).is_err() {
                    break;
                }
                q.pop_front();
            }
            if q.is_empty() && tx.send(b.clone()).is_ok() {
                return true;
            }
        }
        if !l.alive.load(Ordering::Relaxed) {
            return false;
        }
        if q.len() >= PENDING_MAX {
            q.pop_front();
        }
        q.push_back(b);
        true
    }

    fn flush(&self, l: &Link) {
        let mut q = lock(&l.pending);
        if q.is_empty() {
            return;
        }
        if let Some(tx) = self.primary_tx(l) {
            while let Some(x) = q.front() {
                if tx.send(x.clone()).is_err() {
                    break;
                }
                q.pop_front();
            }
        }
    }

    /// Два пути одного транспорта (встречный дозвон) — оставляем один, одинаково на обеих сторонах:
    /// открытый стороной с меньшим ID, из них самый новый.
    fn prune(&self, l: &Link) {
        if !l.mp {
            return;
        }
        let small = self.me < l.peer_s;
        let victims: Vec<Arc<Path>> = {
            let ps = lock(&l.paths);
            let mut v = Vec::new();
            for kind in [0usize, 1] {
                let same: Vec<&Arc<Path>> = ps.iter().filter(|p| p.tr.kind() == kind).collect();
                if same.len() < 2 {
                    continue;
                }
                let keep = same
                    .iter()
                    .filter(|p| p.outbound == small)
                    .max_by_key(|p| p.pid)
                    .or_else(|| same.iter().max_by_key(|p| p.pid))
                    .map(|p| p.pid);
                v.extend(same.into_iter().filter(|p| Some(p.pid) != keep).cloned());
            }
            v
        };
        for p in victims {
            tracing::debug!("p2p: линк {}: лишний путь {} {}", l.id, p.pid, p.tr.name());
            self.kill_path(&p, CLOSE_PATH, "dup");
        }
    }

    fn kill_path(&self, p: &Path, code: u32, reason: &str) {
        if code == CLOSE_PATH {
            p.drop_only.store(true, Ordering::Relaxed);
        }
        match &p.tr {
            Tr::Iroh(c) => c.close(code.into(), reason.as_bytes()),
            Tr::Lp(_) => {
                if code == CLOSE_PATH {
                    // собеседник поймёт, что закрыт только путь
                    if let Some(tx) = lock(&p.tx).as_ref() {
                        let _ = tx.send(encode_frame(&json!({"t": "path_drop4"})));
                    }
                }
                p.kill.notify_one()
            }
        }
    }

    fn close_paths(&self, l: &Link, code: u32, reason: &str) {
        l.closing.store(true, Ordering::Relaxed);
        let ps: Vec<Arc<Path>> = lock(&l.paths).clone();
        if ps.is_empty() {
            self.link_down(l, reason.to_string());
        }
        let lc = lock(&l.remote).get("lc").is_some();
        for p in ps {
            if lc
                && matches!(p.tr, Tr::Lp(_))
                && let Some(tx) = lock(&p.tx).as_ref()
            {
                let _ = tx.send(encode_frame(&json!({"t": "lc4"})));
            }
            self.kill_path(&p, code, reason);
        }
    }

    fn path_gone(self: &Arc<Self>, l: &Arc<Link>, p: &Arc<Path>, reason: String, explicit: bool) {
        let left = {
            let mut ps = lock(&l.paths);
            ps.retain(|x| x.pid != p.pid);
            ps.len()
        };
        tracing::debug!(
            "p2p: линк {} − путь {} {}: {reason}",
            l.id,
            p.pid,
            p.tr.name()
        );
        if left > 0 {
            self.pick_primary(l);
            self.flush(l);
            return;
        }
        if !l.alive.load(Ordering::Relaxed) {
            return;
        }
        if explicit
            || !l.mp
            || l.closing.load(Ordering::Relaxed)
            || !l.authorized.load(Ordering::Relaxed)
            || self.closed.load(Ordering::Relaxed)
        {
            self.link_down(l, reason);
            return;
        }
        // сбой единственного пути: ждём переподключения, кадры копятся в `pending`
        let (me, l) = (self.clone(), l.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            *lock(&l.tried) = [0; 2];
            me.ensure_paths(&l, None);
            let t0 = Instant::now();
            while t0.elapsed() < GRACE {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if !lock(&l.paths).is_empty() || !l.alive.load(Ordering::Relaxed) {
                    return;
                }
            }
            me.link_down(&l, reason);
        });
    }

    fn link_down(&self, l: &Link, reason: String) {
        {
            let mut links = lock(&self.links);
            if !lock(&l.paths).is_empty() || !l.alive.swap(false, Ordering::Relaxed) {
                return;
            }
            links.remove(&l.id);
        }
        lock(&l.pending).clear();
        *lock(&l.held) = (VecDeque::new(), 0);
        let _ = self.events.send(Event::LinkDown {
            link: l.id,
            peer: l.peer_s.clone(),
            reason,
        });
    }

    /// Добавить к допущенному линку недостающие транспорты (не чаще раза в 25 с на транспорт).
    fn ensure_paths(self: &Arc<Self>, l: &Arc<Link>, hint: Option<&Value>) {
        if !l.mp
            || !l.alive.load(Ordering::Relaxed)
            || !l.authorized.load(Ordering::Relaxed)
            || l.closing.load(Ordering::Relaxed)
            || self.closed.load(Ordering::Relaxed)
        {
            return;
        }
        let have: Vec<usize> = lock(&l.paths).iter().map(|p| p.tr.kind()).collect();
        let (hint, theirs) = {
            let r = lock(&l.remote);
            (
                hint.cloned().or_else(|| r.get("addr").cloned()),
                r.get("tr").and_then(|v| v.as_array()).cloned(),
            )
        };
        let now = now_ms();
        let mut tried = lock(&l.tried);
        let fails = *lock(&l.fails);
        for kind in [0usize, 1] {
            let name = if kind == 0 { "iroh" } else { "libp2p" };
            let on = if kind == 0 {
                self.ep.is_some()
            } else {
                self.lp.is_some()
            };
            let they = theirs
                .as_ref()
                .is_none_or(|a| a.iter().any(|v| v.as_str() == Some(name)));
            // неудачи подряд — реже: 25 с, 50 с … до ~13 мин (поиск в DHT не бесплатный)
            let every = ENSURE_EVERY_MS << fails[kind].min(5);
            if !on || !they || have.contains(&kind) || now.saturating_sub(tried[kind]) < every {
                continue;
            }
            tried[kind] = now;
            let (me, l2, peer, h) = (self.clone(), l.clone(), l.peer_s.clone(), hint.clone());
            tokio::spawn(async move {
                match me.dial(kind, &peer, h.as_ref()).await {
                    Ok(_) => lock(&l2.fails)[kind] = 0,
                    Err(e) => {
                        let mut f = lock(&l2.fails);
                        f[kind] = f[kind].saturating_add(1);
                        tracing::debug!(
                            "p2p: {}: путь {name} не добавился ({}): {e}",
                            &peer[..8],
                            f[kind]
                        );
                    }
                }
            });
        }
    }

    fn path_info(&self, p: &Path) -> (String, Option<u64>) {
        match &p.tr {
            Tr::Iroh(c) => {
                let paths = c.paths();
                match paths.iter().find(|x| x.is_selected()) {
                    Some(x) => (
                        (if x.is_relay() { "relay" } else { "direct" }).into(),
                        Some(x.rtt().as_millis() as u64),
                    ),
                    None => ("none".into(), None),
                }
            }
            Tr::Lp(peer) => {
                let lp = self.lp.as_ref();
                match lp.and_then(|lp| lp.is_direct(peer)) {
                    Some(d) => (
                        (if d { "direct" } else { "relay" }).into(),
                        lp.and_then(|lp| lp.rtt(peer)),
                    ),
                    None => ("none".into(), None),
                }
            }
        }
    }

    async fn lp_inbound(
        self: Arc<Self>,
        peer: libp2p::PeerId,
        s: libp2p::Stream,
    ) -> anyhow::Result<()> {
        let id = lp::id_of_peer(&peer).ok_or_else(|| anyhow::anyhow!("не ключ Ed25519"))?;
        let (send, mut recv) = stream::lp_pair(s);
        let first = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut recv))
            .await??
            .ok_or_else(|| anyhow::anyhow!("пусто"))?;
        anyhow::ensure!(is_hello4(&first), "не hello4");
        let h = encode_frame(&self.hello_now());
        self.attach(id, Tr::Lp(peer), false, first, send, recv, Some(h));
        Ok(())
    }
}

#[cfg(test)]
impl Inner {
    /// Тест: «сбой» пути данного транспорта (0 — iroh, 1 — libp2p).
    fn drop_transport(&self, link: LinkId, kind: usize) {
        let Some(l) = self.get(link) else { return };
        let ps: Vec<Arc<Path>> = lock(&l.paths).clone();
        for p in ps.iter().filter(|p| p.tr.kind() == kind) {
            self.kill_path(p, CLOSE_PATH, "test");
        }
    }
    fn path_count(&self, link: LinkId) -> usize {
        self.get(link).map(|l| lock(&l.paths).len()).unwrap_or(0)
    }
    fn path_ids(&self, link: LinkId) -> Vec<u64> {
        self.get(link)
            .map(|l| lock(&l.paths).iter().map(|p| p.pid).collect())
            .unwrap_or_default()
    }
}

fn iroh_direct(c: &Connection) -> Option<bool> {
    let paths = c.paths();
    paths
        .iter()
        .find(|x| x.is_selected())
        .map(|x| !x.is_relay())
}

async fn accept_loop(inner: Arc<Inner>) {
    let Some(ep) = inner.ep.clone() else { return };
    while let Some(incoming) = ep.accept().await {
        let inner = inner.clone();
        tokio::spawn(async move {
            let Ok(conn) = incoming.await else { return };
            let r = async {
                let (send, recv) = tokio::time::timeout(HELLO_TIMEOUT, conn.accept_bi()).await??;
                let mut recv = StreamRecv::Iroh(recv);
                let first = tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut recv)).await??;
                let first = first.ok_or_else(|| anyhow::anyhow!("пусто"))?;
                anyhow::ensure!(is_hello4(&first), "не hello4");
                Ok::<_, anyhow::Error>((send, recv, first))
            }
            .await;
            match r {
                Ok((send, recv, first)) => {
                    let peer = conn.remote_id().to_string();
                    let h = encode_frame(&inner.hello_now());
                    inner.attach(
                        peer,
                        Tr::Iroh(conn),
                        false,
                        first,
                        StreamSend::Iroh(send),
                        recv,
                        Some(h),
                    );
                }
                Err(e) => {
                    tracing::debug!("p2p: входящее отклонено: {e}");
                    conn.close(2u32.into(), b"handshake");
                }
            }
        });
    }
}

async fn lp_events(w: Weak<Inner>, mut rx: mpsc::UnboundedReceiver<lp::LpEv>) {
    while let Some(ev) = rx.recv().await {
        let Some(inner) = w.upgrade() else { return };
        match ev {
            lp::LpEv::Ctl(peer, s) => {
                tokio::spawn(async move {
                    if let Err(e) = inner.lp_inbound(peer, s).await {
                        tracing::debug!("p2p: входящее libp2p отклонено: {e}");
                    }
                });
            }
            lp::LpEv::File(peer, s) => {
                let l = lp::id_of_peer(&peer).and_then(|id| {
                    lock(&inner.links)
                        .values()
                        .filter(|l| {
                            l.peer_s == id
                                && l.alive.load(Ordering::Relaxed)
                                && l.authorized.load(Ordering::Relaxed)
                        })
                        .max_by_key(|l| l.id)
                        .cloned()
                });
                // нет допущенного линка — поток просто бросаем
                if let Some(l) = l {
                    let (send, recv) = stream::lp_pair(s);
                    let _ = inner.events.send(Event::Stream {
                        link: l.id,
                        peer: l.peer_s.clone(),
                        send,
                        recv,
                    });
                }
            }
            lp::LpEv::Direct(peer) => {
                // релейные соединения закрыты — путь libp2p переоткроется уже напрямую
                let Some(id) = lp::id_of_peer(&peer) else {
                    continue;
                };
                let links: Vec<Arc<Link>> = lock(&inner.links)
                    .values()
                    .filter(|l| l.peer_s == id)
                    .cloned()
                    .collect();
                // поток мог остаться на закрытом релейном соединении: проверим, отвечает ли
                let deadline = now_ms() + LP_PROBE_MS;
                for l in &links {
                    for p in lock(&l.paths).iter().filter(|p| matches!(p.tr, Tr::Lp(_))) {
                        p.probe.store(deadline, Ordering::Relaxed);
                        if let Some(tx) = lock(&p.tx).as_ref() {
                            let _ = tx.send(encode_frame(&json!({"t": "pk4", "q": 1})));
                        }
                    }
                }
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    for l in links {
                        lock(&l.tried)[1] = 0;
                        inner.ensure_paths(&l, None);
                    }
                });
            }
        }
    }
}

/// Раз в секунду: пересмотр основного пути, живость путей libp2p; раз в 30 с — недостающие
/// транспорты (со стороны, открывшей линк).
async fn maintain(w: Weak<Inner>) {
    let mut n = 0u64;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some(inner) = w.upgrade() else { return };
        if inner.closed.load(Ordering::Relaxed) {
            return;
        }
        n += 1;
        let links: Vec<Arc<Link>> = lock(&inner.links).values().cloned().collect();
        let now = now_ms();
        for l in links {
            inner.pick_primary(&l);
            if n.is_multiple_of(30) && l.outbound {
                inner.ensure_paths(&l, None);
            }
            let ps: Vec<Arc<Path>> = lock(&l.paths).clone();
            for p in ps.iter().filter(|p| matches!(p.tr, Tr::Lp(_))) {
                let rx = p.last_rx.load(Ordering::Relaxed);
                let probe = p.probe.load(Ordering::Relaxed);
                if now.saturating_sub(rx) > LP_DEAD_MS || (probe != 0 && now > probe) {
                    tracing::debug!("p2p: линк {}: путь {} libp2p молчит", l.id, p.pid);
                    inner.kill_path(p, CLOSE_PATH, "silent");
                } else if now.saturating_sub(p.last_tx.load(Ordering::Relaxed)) > LP_KEEPALIVE_MS
                    && let Some(tx) = lock(&p.tx).as_ref()
                {
                    let _ = tx.send(encode_frame(&json!({"t": "pk4"})));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn node(seed: u8) -> (Node, mpsc::UnboundedReceiver<Event>) {
        node_with(seed, true, None).await
    }

    async fn node_with(
        seed: u8,
        iroh: bool,
        lp: Option<LpConfig>,
    ) -> (Node, mpsc::UnboundedReceiver<Event>) {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".into()))
            .with_test_writer()
            .try_init();
        let (tx, rx) = mpsc::unbounded_channel();
        let cfg = Config {
            secret: crypto::endpoint_secret(&[seed; 32]),
            app_version: "test".into(),
            name: format!("n{seed}"),
            caps: vec![],
            iroh,
            n0: false,
            lp,
        };
        (Node::start(cfg, tx).await.unwrap(), rx)
    }

    /// Адрес с libp2p-частью `l` (сокеты слушают не мгновенно).
    async fn hint_with_l(n: &Node, need: &str) -> Value {
        for _ in 0..100 {
            let h = n.addr_json();
            let ok = h["l"].as_array().is_some_and(|a| {
                a.iter()
                    .any(|x| x.as_str().is_some_and(|s| s.contains(need)))
            });
            if ok {
                return h;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("нет адреса libp2p «{need}»: {}", n.addr_json());
    }

    fn no_link_down(rx: &mut mpsc::UnboundedReceiver<Event>) {
        while let Ok(e) = rx.try_recv() {
            assert!(!matches!(e, Event::LinkDown { .. }), "лишний {e:?}");
        }
    }

    async fn next_stream(
        rx: &mut mpsc::UnboundedReceiver<Event>,
    ) -> (LinkId, StreamSend, StreamRecv) {
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv())
                .await
                .unwrap()
                .unwrap()
            {
                Event::Stream {
                    link, send, recv, ..
                } => return (link, send, recv),
                _ => continue,
            }
        }
    }

    async fn wait_down(rx: &mut mpsc::UnboundedReceiver<Event>, want: LinkId) {
        loop {
            if let Event::LinkDown { link, .. } =
                tokio::time::timeout(Duration::from_secs(10), rx.recv())
                    .await
                    .unwrap()
                    .unwrap()
            {
                assert_eq!(link, want);
                return;
            }
        }
    }

    #[tokio::test]
    async fn libp2p_link_and_files() {
        let (a, mut arx) = node_with(21, false, Some(LpConfig::local())).await;
        let (b, mut brx) = node_with(22, false, Some(LpConfig::local())).await;
        let hint = hint_with_l(&b, "/tcp/").await;
        let la = a.connect(b.id(), Some(&hint)).await.unwrap();
        assert_eq!(a.transport(la), Some("libp2p"));
        a.send(la, &json!({"t": "secret"}));
        a.send(la, &json!({"t": "bind"}));
        let (lb, m) = next_msg(&mut brx).await;
        assert_eq!(m["t"], "bind");
        assert_eq!(b.peer_of(lb).as_deref(), Some(a.id()));
        b.authorize(lb);
        let (_, m) = next_msg(&mut brx).await;
        assert_eq!(m["t"], "secret");
        b.send(lb, &json!({"t": "pong", "n": 1}));
        let (_, m) = next_msg(&mut arx).await;
        assert_eq!(m["t"], "pong");
        // датаграмм у libp2p нет: ядро отправит голос кадром
        assert!(!a.send_datagram(la, Bytes::from_static(b"Ex")));
        a.send(la, &json!({"t": "env", "d": "y".repeat(200_000)}));
        let (_, m) = next_msg(&mut brx).await;
        assert_eq!(m["d"].as_str().unwrap().len(), 200_000);
        // файл: 1 МБ в ответ на запрос
        let (mut s, mut r) = a.open_stream(la).await.unwrap();
        s.write_all(&encode_frame(&json!({"t": "get"})))
            .await
            .unwrap();
        let (l, mut bs, mut br) = next_stream(&mut brx).await;
        assert_eq!(l, lb);
        assert_eq!(read_frame(&mut br).await.unwrap().unwrap()["t"], "get");
        // окно Yamux меньше 1 МБ: пишем параллельно с чтением
        let w = tokio::spawn(async move {
            bs.write_all(&vec![9u8; 1 << 20]).await.unwrap();
            bs.finish().await.unwrap();
            // ждём, пока a дочитает и закроет поток
            tokio::time::timeout(Duration::from_secs(5), bs.stopped())
                .await
                .unwrap()
                .unwrap();
            drop(br);
        });
        let got = tokio::time::timeout(Duration::from_secs(10), r.read_to_end(4 << 20))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(got.len(), 1 << 20);
        assert!(got.iter().all(|&x| x == 9));
        drop((s, r));
        w.await.unwrap();
        assert_eq!(a.path(la).0, "direct");
        // закрытие объявлено кадром `lc4` — собеседник не ждёт переподключения (GRACE)
        let t0 = std::time::Instant::now();
        a.close_link(la, "test");
        wait_down(&mut brx, lb).await;
        assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
    }

    #[tokio::test]
    async fn multipath_failover() {
        let (a, mut arx) = node_with(23, true, Some(LpConfig::local())).await;
        let (b, mut brx) = node_with(24, true, Some(LpConfig::local())).await;
        let hint = hint_with_l(&b, "/tcp/").await;
        let la = a.connect(b.id(), Some(&hint)).await.unwrap();
        a.send(la, &json!({"t": "bind"}));
        let (lb, _) = next_msg(&mut brx).await;
        b.authorize(lb);
        // второй транспорт — путём того же линка
        for _ in 0..100 {
            if a.inner.path_count(la) == 2 && b.inner.path_count(lb) == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(a.inner.path_count(la), 2, "{}", a.status());
        assert_eq!(b.inner.path_count(lb), 2, "{}", b.status());
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert_eq!(a.transport(la), Some("iroh"), "{}", a.status());
        // сбой пути iroh: линк живёт на libp2p
        a.inner.drop_transport(la, 0);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(a.is_alive(la) && b.is_alive(lb));
        assert_eq!(a.transport(la), Some("libp2p"));
        assert_eq!(b.transport(lb), Some("libp2p"));
        a.send(la, &json!({"t": "ping", "n": 2}));
        let (l, m) = next_msg(&mut brx).await;
        assert_eq!((l, m["n"].as_u64()), (lb, Some(2)));
        b.send(lb, &json!({"t": "pong", "n": 3}));
        let (l, m) = next_msg(&mut arx).await;
        assert_eq!((l, m["n"].as_u64()), (la, Some(3)));
        no_link_down(&mut arx);
        no_link_down(&mut brx);
        // сбой и второго: 5 с ждём переподключения, оно и случается — линк тот же
        let old = a.inner.path_ids(la);
        a.inner.drop_transport(la, 1);
        for _ in 0..50 {
            let now = a.inner.path_ids(la);
            if !now.is_empty() && now.iter().all(|p| !old.contains(p)) && b.inner.path_count(lb) > 0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(a.is_alive(la) && b.is_alive(lb));
        a.send(la, &json!({"t": "ping", "n": 4}));
        let (l, m) = next_msg(&mut brx).await;
        assert_eq!((l, m["n"].as_u64()), (lb, Some(4)), "{}", a.status());
        no_link_down(&mut arx);
        no_link_down(&mut brx);
        a.close_link(la, "test");
        wait_down(&mut brx, lb).await;
    }

    /// Локальный релей circuit v2 для теста.
    async fn relay_server() -> String {
        use futures::StreamExt;
        use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
        #[derive(NetworkBehaviour)]
        struct R {
            relay: libp2p::relay::Behaviour,
            identify: libp2p::identify::Behaviour,
            ping: libp2p::ping::Behaviour,
        }
        let mut sw = libp2p::SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                libp2p::tcp::Config::default(),
                libp2p::noise::Config::new,
                libp2p::yamux::Config::default,
            )
            .unwrap()
            .with_behaviour(|k| R {
                relay: libp2p::relay::Behaviour::new(
                    k.public().to_peer_id(),
                    libp2p::relay::Config::default(),
                ),
                identify: libp2p::identify::Behaviour::new(libp2p::identify::Config::new(
                    "/ipfs/0.1.0".into(),
                    k.public(),
                )),
                ping: libp2p::ping::Behaviour::default(),
            })
            .unwrap()
            .build();
        sw.listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap())
            .unwrap();
        let addr = loop {
            if let SwarmEvent::NewListenAddr { address, .. } = sw.select_next_some().await {
                break address;
            }
        };
        sw.add_external_address(addr.clone());
        let id = *sw.local_peer_id();
        tokio::spawn(async move {
            loop {
                sw.select_next_some().await;
            }
        });
        format!("{addr}/p2p/{id}")
    }

    #[tokio::test]
    async fn libp2p_relay_then_direct() {
        let relay = relay_server().await;
        let mut ca = LpConfig::local();
        ca.relays = vec![relay];
        let (a, mut arx) = node_with(25, false, Some(ca)).await;
        let (b, mut brx) = node_with(26, false, Some(LpConfig::local())).await;
        let ha = hint_with_l(&a, "p2p-circuit").await;
        let circ: Vec<Value> = ha["l"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|x| x.as_str().unwrap().contains("p2p-circuit"))
            .cloned()
            .collect();
        // b знает только адрес через релей
        let lb = b
            .connect(a.id(), Some(&json!({"id": a.id(), "l": circ})))
            .await
            .unwrap();
        b.send(lb, &json!({"t": "bind"}));
        let (la, _) = next_msg(&mut arx).await;
        a.authorize(la);
        // DCUtR: появилось прямое соединение, релейное закрыто, путь переоткрыт в том же линке
        let (old_a, old_b) = (a.inner.path_ids(la), b.inner.path_ids(lb));
        let mut direct = false;
        for _ in 0..200 {
            let (na, nb) = (a.inner.path_ids(la), b.inner.path_ids(lb));
            if b.path(lb).0 == "direct"
                && a.path(la).0 == "direct"
                && !na.is_empty()
                && !nb.is_empty()
                && na.iter().all(|p| !old_a.contains(p))
                && nb.iter().all(|p| !old_b.contains(p))
            {
                direct = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(direct, "{}\n{}", b.status(), a.status());
        b.send(lb, &json!({"t": "ping", "n": 7}));
        let (l, m) = next_msg(&mut arx).await;
        assert_eq!((l, m["n"].as_u64()), (la, Some(7)));
        a.send(la, &json!({"t": "pong", "n": 8}));
        let (l, m) = next_msg(&mut brx).await;
        assert_eq!((l, m["n"].as_u64()), (lb, Some(8)));
        no_link_down(&mut arx);
        no_link_down(&mut brx);
    }

    #[test]
    fn peer_id_roundtrip() {
        let sk = SecretKey::from_bytes(&crypto::endpoint_secret(&[9; 32]));
        let id = sk.public().to_string();
        let p = lp::peer_of_id(&id).unwrap();
        assert_eq!(lp::id_of_peer(&p).as_deref(), Some(id.as_str()));
        // тот же ключ — тот же PeerId, что у libp2p из сида
        let kp = libp2p::identity::Keypair::ed25519_from_bytes(crypto::endpoint_secret(&[9; 32]))
            .unwrap();
        assert_eq!(kp.public().to_peer_id(), p);
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
        // до допуска проходит только bind, остальное ждёт допуска
        a.send(la, &json!({"t": "secret"}));
        a.send(la, &json!({"t": "bind", "r": "x"}));
        let (lb, m) = next_msg(&mut brx).await;
        assert_eq!(m["t"], "bind");
        assert_eq!(b.peer_of(lb).as_deref(), Some(a.id()));
        b.authorize(lb);
        let (_, m) = next_msg(&mut brx).await;
        assert_eq!(m["t"], "secret");
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
                iroh: true,
                n0: true,
                lp: None,
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

    /// libp2p через публичную инфраструктуру (нужен интернет): бутстрап DHT, AutoNAT, публичные релеи,
    /// поиск по одному ID. `cargo test -p zv-p2p libp2p_live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn libp2p_live() {
        let cfg = || LpConfig {
            port: 0,
            mdns: false,
            upnp: false,
            ..Default::default()
        };
        let (a, mut arx) = node_with(21, false, Some(cfg())).await;
        let (b, _brx) = node_with(22, false, Some(cfg())).await;
        let t0 = std::time::Instant::now();
        loop {
            let lp = a.status()["libp2p"].clone();
            let relay = lp["relays"]
                .as_array()
                .is_some_and(|r| r.iter().any(|x| x["ok"] == true));
            if (relay && lp["record"] == "ok") || t0.elapsed() > Duration::from_secs(180) {
                println!("a через {:?}: {lp}", t0.elapsed());
                break;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        println!("b: {}", b.status()["libp2p"]);
        // только ID: адрес — из DHT (провайдер-запись присутствия)
        let t1 = std::time::Instant::now();
        let r = tokio::time::timeout(Duration::from_secs(120), b.connect(a.id(), None)).await;
        println!("по одному ID: {:?} → {r:?}", t1.elapsed());
        let lb = r.expect("тайм-аут").expect("не соединились");
        b.send(lb, &json!({"t": "bind"}));
        let (_, m) = next_msg(&mut arx).await;
        assert_eq!(m["t"], "bind");
        tokio::time::sleep(Duration::from_secs(5)).await;
        println!("путь {:?}; статус {}", b.path(lb), b.status());
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
        bs.finish().await.unwrap();
        let ok = read_frame(&mut r).await.unwrap().unwrap();
        assert_eq!(ok["size"], 1 << 20);
        let got = r.read_to_end(4 << 20).await.unwrap();
        assert_eq!(got.len(), 1 << 20);
        assert!(got.iter().all(|&x| x == 7));
    }

    /// Собеседник перезапустился (тот же ключ, другой `s`), а старые пути у нас ещё «живы»:
    /// старый линк закрывается сразу, новый сеанс — отдельный линк; кадры до допуска не теряются.
    #[tokio::test]
    async fn peer_restart_new_link() {
        // старый процесс — только libp2p, новый — только iroh: два сеанса одного ключа не путают транспорт
        let (a1, _a1rx) = node_with(31, false, Some(LpConfig::local())).await;
        let (b, mut brx) = node_with(32, true, Some(LpConfig::local())).await;
        let hint = hint_with_l(&b, "/tcp/").await;
        a1.connect(b.id(), Some(&hint)).await.unwrap();
        let lb1 = loop {
            if let Event::LinkUp { link, .. } =
                tokio::time::timeout(Duration::from_secs(10), brx.recv())
                    .await
                    .unwrap()
                    .unwrap()
            {
                break link;
            }
        };
        b.authorize(lb1);
        let (a2, _a2rx) = node_with(31, true, None).await;
        assert_eq!(a2.id(), a1.id());
        let l2 = a2.connect(b.id(), Some(&b.addr_json())).await.unwrap();
        a2.send(l2, &json!({"t": "x"}));
        let (mut up, mut down) = (None, false);
        let t0 = std::time::Instant::now();
        while up.is_none() || !down {
            match tokio::time::timeout(Duration::from_secs(5), brx.recv())
                .await
                .unwrap()
                .unwrap()
            {
                Event::LinkUp { link, .. } => up = Some(link),
                Event::LinkDown { link, .. } => {
                    assert_eq!(link, lb1);
                    down = true;
                }
                _ => {}
            }
        }
        assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
        let lb2 = up.unwrap();
        assert_ne!(lb2, lb1);
        b.authorize(lb2);
        let (l, m) = next_msg(&mut brx).await;
        assert_eq!((l, m["t"].as_str()), (lb2, Some("x")));
        assert_eq!(b.link_for(a2.id()), Some(lb2));
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
