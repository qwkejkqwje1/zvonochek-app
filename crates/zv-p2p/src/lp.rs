//! Второй транспорт ZV4 — libp2p (ADR-0007). TCP и QUIC на порту 47322 (занят — любой), Noise,
//! Yamux. Поиск собеседника: адреса из подсказки (`l`), mDNS в локальной сети, DHT Amino (IPFS) —
//! запись провайдера по ключу из ID. NAT: UPnP, AutoNAT, резерв на публичных релеях circuit v2
//! (узлы IPFS) и DCUtR — пробитие NAT с переходом с релея на прямое соединение.
//! Ключ тот же, что у iroh (Ed25519 из сида), поэтому PeerId однозначно следует из ID устройства.

use futures::StreamExt;
use libp2p::core::ConnectedPoint;
use libp2p::multiaddr::Protocol;
use libp2p::swarm::behaviour::toggle::Toggle;
use libp2p::swarm::dial_opts::{DialOpts, PeerCondition};
use libp2p::core::transport::ListenerId;
use libp2p::swarm::{ConnectionId, DialError, NetworkBehaviour, SwarmEvent};
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, Swarm, autonat, dcutr, identify, identity, kad, mdns, noise,
    ping, relay, tcp, upnp, yamux,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

pub(crate) const P_CTL: StreamProtocol = StreamProtocol::new("/zv/4/ctl");
pub(crate) const P_FILE: StreamProtocol = StreamProtocol::new("/zv/4/f");
/// Порт по умолчанию (TCP и UDP для QUIC).
pub const DEFAULT_PORT: u16 = 47322;
const HOP: StreamProtocol = StreamProtocol::new("/libp2p/circuit/relay/0.2.0/hop");
/// Сколько резервов на релеях держим, пока NAT не признан «публичным».
const RESERVATIONS: usize = 2;
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// Узлы входа в DHT Amino (как у IPFS).
const BOOTSTRAP: [&str; 5] = [
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
];

#[derive(Debug, Clone)]
pub struct LpConfig {
    /// Порт TCP и UDP (QUIC); занят — любой свободный. 0 — сразу любой.
    pub port: u16,
    /// Только 127.0.0.1, без DHT, mDNS, UPnP, AutoNAT и публичных релеев (тесты).
    pub local_only: bool,
    /// Поиск собеседников в локальной сети.
    pub mdns: bool,
    /// Проброс порта на роутере.
    pub upnp: bool,
    /// DHT Amino: поиск собеседника по ID и публичных релеев.
    pub dht: bool,
    /// Свои релеи circuit v2: multiaddr с `/p2p/<id>`.
    pub relays: Vec<String>,
}

impl Default for LpConfig {
    fn default() -> Self {
        LpConfig {
            port: DEFAULT_PORT,
            local_only: false,
            mdns: true,
            upnp: true,
            dht: true,
            relays: vec![],
        }
    }
}

impl LpConfig {
    /// Изолированный режим для тестов.
    pub fn local() -> Self {
        LpConfig {
            port: 0,
            local_only: true,
            mdns: false,
            upnp: false,
            dht: false,
            relays: vec![],
        }
    }
}

#[derive(NetworkBehaviour)]
struct B {
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    kad: Toggle<kad::Behaviour<kad::store::MemoryStore>>,
    relay: relay::client::Behaviour,
    dcutr: dcutr::Behaviour,
    autonat: Toggle<autonat::Behaviour>,
    upnp: Toggle<upnp::tokio::Behaviour>,
    mdns: Toggle<mdns::tokio::Behaviour>,
    stream: libp2p_stream::Behaviour,
}

struct Cn {
    addr: Multiaddr,
    relayed: bool,
    dialer: bool,
    rtt: Option<u64>,
}

#[derive(Default)]
struct St {
    listen: Vec<Multiaddr>,
    external: Vec<Multiaddr>,
    nat: &'static str,
    upnp: &'static str,
    conns: HashMap<PeerId, HashMap<ConnectionId, Cn>>,
    /// релей → резерв подтверждён
    relays: HashMap<PeerId, bool>,
    dht: usize,
    lan: HashMap<PeerId, Vec<Multiaddr>>,
}

enum Cmd {
    Dial(PeerId, Vec<Multiaddr>, oneshot::Sender<Result<(), String>>),
    Find(PeerId, oneshot::Sender<Result<(), String>>),
    CloseRelayed(PeerId),
    Shutdown,
}

pub(crate) enum LpEv {
    /// Входящий управляющий поток.
    Ctl(PeerId, libp2p::Stream),
    /// Входящий поток файлов.
    File(PeerId, libp2p::Stream),
    /// С собеседником появилось прямое соединение, релейные закрыты: путь стоит переоткрыть.
    Direct(PeerId),
}

/// Ручка узла libp2p. Клонируется; сам swarm живёт в своей задаче.
#[derive(Clone)]
pub(crate) struct Lp {
    me: PeerId,
    local: bool,
    cmd: mpsc::UnboundedSender<Cmd>,
    ctl: libp2p_stream::Control,
    st: Arc<Mutex<St>>,
}

/// PeerId из ID устройства (hex открытого ключа Ed25519).
pub(crate) fn peer_of_id(id: &str) -> Option<PeerId> {
    let b: [u8; 32] = hex::decode(id.trim()).ok()?.try_into().ok()?;
    let pk = identity::ed25519::PublicKey::try_from_bytes(&b).ok()?;
    Some(identity::PublicKey::from(pk).to_peer_id())
}

/// ID устройства из PeerId (только ключи Ed25519, встроенные в PeerId).
pub(crate) fn id_of_peer(p: &PeerId) -> Option<String> {
    let b = p.to_bytes();
    // multihash identity (0x00), длина 36: protobuf ключа Ed25519
    if b.len() != 38 || b[0] != 0 || b[1] != 36 {
        return None;
    }
    let pk = identity::PublicKey::try_decode_protobuf(&b[2..]).ok()?;
    Some(hex::encode(pk.try_into_ed25519().ok()?.to_bytes()))
}

/// Ключ записи «я в сети» в DHT: multihash sha2-256, как у CID.
fn presence_key(p: &PeerId) -> kad::RecordKey {
    let mut h = Sha256::new();
    h.update(b"zv4/presence/");
    h.update(p.to_bytes());
    let mut k = vec![0x12, 0x20];
    k.extend_from_slice(h.finalize().as_slice());
    kad::RecordKey::new(&k)
}

fn is_circuit(a: &Multiaddr) -> bool {
    a.iter().any(|p| matches!(p, Protocol::P2pCircuit))
}

/// Публичный адрес (не локальная сеть, не loopback, не CGNAT).
fn global(a: &Multiaddr) -> bool {
    match a.iter().next() {
        Some(Protocol::Ip4(ip)) => {
            let o = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_documentation()
                || (o[0] == 100 && (o[1] & 0xc0) == 64))
        }
        Some(Protocol::Ip6(ip)) => {
            let s = ip.segments()[0];
            !(ip.is_loopback() || ip.is_unspecified() || (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80)
        }
        Some(Protocol::Dns(_) | Protocol::Dns4(_) | Protocol::Dns6(_) | Protocol::Dnsaddr(_)) => true,
        _ => false,
    }
}

/// Адрес, по которому мы умеем звонить: TCP или QUIC v1 (без WebSocket/WebRTC/WebTransport).
fn usable(a: &Multiaddr) -> bool {
    a.iter().all(|p| {
        matches!(
            p,
            Protocol::Ip4(_)
                | Protocol::Ip6(_)
                | Protocol::Dns(_)
                | Protocol::Dns4(_)
                | Protocol::Dns6(_)
                | Protocol::Dnsaddr(_)
                | Protocol::Tcp(_)
                | Protocol::Udp(_)
                | Protocol::QuicV1
                | Protocol::P2p(_)
                | Protocol::P2pCircuit
        )
    })
}

fn loopback(a: &Multiaddr) -> bool {
    match a.iter().next() {
        Some(Protocol::Ip4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(Protocol::Ip6(ip)) => {
            ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
        _ => false,
    }
}

/// Адреса libp2p из подсказки `{l: [multiaddr, …]}`.
pub(crate) fn hint_addrs(hint: Option<&Value>, p: &PeerId) -> Vec<Multiaddr> {
    hint.and_then(|h| h.get("l"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str()?.parse::<Multiaddr>().ok())
                .filter(|m| usable(m))
                .filter(|m| match m.iter().last() {
                    Some(Protocol::P2p(x)) => x == *p,
                    _ => true,
                })
                .take(12)
                .collect()
        })
        .unwrap_or_default()
}

fn behaviour(key: &identity::Keypair, relay: relay::client::Behaviour, cfg: &LpConfig) -> B {
    let id = key.public().to_peer_id();
    let wide = !cfg.local_only;
    let kad = (wide && cfg.dht).then(|| {
        let mut kc = kad::Config::new(kad::PROTOCOL_NAME);
        kc.set_query_timeout(Duration::from_secs(60));
        let mut k = kad::Behaviour::with_config(id, kad::store::MemoryStore::new(id), kc);
        // сервером DHT не работаем: мы за NAT и не храним чужие записи
        k.set_mode(Some(kad::Mode::Client));
        k
    });
    let mdns = if wide && cfg.mdns {
        mdns::tokio::Behaviour::new(mdns::Config::default(), id).ok()
    } else {
        None
    };
    B {
        identify: identify::Behaviour::new(
            identify::Config::new("/ipfs/0.1.0".into(), key.public())
                .with_agent_version(format!("zvonochek/{}", env!("CARGO_PKG_VERSION"))),
        ),
        ping: ping::Behaviour::new(ping::Config::new().with_interval(Duration::from_secs(15))),
        kad: Toggle::from(kad),
        relay,
        dcutr: dcutr::Behaviour::new(id),
        autonat: Toggle::from(wide.then(|| autonat::Behaviour::new(id, autonat::Config::default()))),
        upnp: Toggle::from((wide && cfg.upnp).then(upnp::tokio::Behaviour::default)),
        mdns: Toggle::from(mdns),
        stream: libp2p_stream::Behaviour::new(),
    }
}

fn build(secret: &[u8; 32], cfg: &LpConfig, system_dns: bool) -> anyhow::Result<Swarm<B>> {
    let kp = identity::Keypair::ed25519_from_bytes(*secret)?;
    let b = libp2p::SwarmBuilder::with_existing_identity(kp)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic();
    macro_rules! rest {
        ($b:expr) => {
            $b.with_relay_client(noise::Config::new, yamux::Config::default)?
                .with_behaviour(|key, relay| behaviour(key, relay, cfg))?
                .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
                .build()
        };
    }
    Ok(if system_dns {
        rest!(b.with_dns()?)
    } else {
        rest!(b.with_dns_config(
            libp2p::dns::ResolverConfig::udp_and_tcp(&hickory_resolver::config::CLOUDFLARE),
            libp2p::dns::ResolverOpts::default(),
        ))
    })
}

fn listen(sw: &mut Swarm<B>, cfg: &LpConfig) {
    let ips: &[&str] = if cfg.local_only {
        &["/ip4/127.0.0.1"]
    } else {
        &["/ip4/0.0.0.0", "/ip6/::"]
    };
    for ip in ips {
        for quic in [false, true] {
            let addr = |port: u16| -> Option<Multiaddr> {
                let s = if quic {
                    format!("{ip}/udp/{port}/quic-v1")
                } else {
                    format!("{ip}/tcp/{port}")
                };
                s.parse().ok()
            };
            let fixed = (cfg.port != 0)
                .then(|| addr(cfg.port))
                .flatten()
                .is_some_and(|a| sw.listen_on(a).is_ok());
            if !fixed
                && let Some(a) = addr(0)
                && let Err(e) = sw.listen_on(a)
            {
                tracing::debug!("libp2p: не слушаем {ip} (quic={quic}): {e}");
            }
        }
    }
}

impl Lp {
    pub(crate) fn start(
        secret: &[u8; 32],
        cfg: LpConfig,
    ) -> anyhow::Result<(Lp, mpsc::UnboundedReceiver<LpEv>)> {
        let mut sw = match build(secret, &cfg, true) {
            Ok(s) => s,
            Err(e) => {
                tracing::debug!("libp2p: системный DNS недоступен ({e}), берём 1.1.1.1");
                build(secret, &cfg, false)?
            }
        };
        listen(&mut sw, &cfg);
        let me = *sw.local_peer_id();
        let mut ctl = sw.behaviour().stream.new_control();
        let (etx, erx) = mpsc::unbounded_channel();
        for (proto, file) in [(P_CTL, false), (P_FILE, true)] {
            let mut inc = ctl
                .accept(proto)
                .map_err(|e| anyhow::anyhow!("libp2p: {e}"))?;
            let etx = etx.clone();
            tokio::spawn(async move {
                while let Some((p, s)) = inc.next().await {
                    let ev = if file { LpEv::File(p, s) } else { LpEv::Ctl(p, s) };
                    if etx.send(ev).is_err() {
                        break;
                    }
                }
            });
        }
        let (ctx, crx) = mpsc::unbounded_channel();
        let st = Arc::new(Mutex::new(St {
            nat: "unknown",
            upnp: if cfg.upnp && !cfg.local_only { "…" } else { "off" },
            ..Default::default()
        }));
        let drv = Driver {
            sw,
            me,
            st: st.clone(),
            ev: etx,
            cmd_tx: ctx.clone(),
            dials: HashMap::new(),
            finds: HashMap::new(),
            hops: Vec::new(),
            reserving: HashMap::new(),
            failed: HashMap::new(),
            provided: None,
            ext_changed: false,
            cfg: cfg.clone(),
        };
        tokio::spawn(drv.run(crx));
        Ok((
            Lp {
                me,
                local: cfg.local_only,
                cmd: ctx,
                ctl,
                st,
            },
            erx,
        ))
    }

    fn lock(&self) -> MutexGuard<'_, St> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn ask(&self, f: impl FnOnce(oneshot::Sender<Result<(), String>>) -> Cmd) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.cmd
            .send(f(tx))
            .map_err(|_| anyhow::anyhow!("libp2p остановлен"))?;
        rx.await
            .map_err(|_| anyhow::anyhow!("libp2p остановлен"))?
            .map_err(|e| anyhow::anyhow!(e))
    }

    /// Соединиться (адреса из подсказки, mDNS, иначе поиск в DHT) и открыть поток протокола.
    pub(crate) async fn open(
        &self,
        p: PeerId,
        addrs: Vec<Multiaddr>,
        proto: StreamProtocol,
    ) -> anyhow::Result<libp2p::Stream> {
        if let Err(e) = self.ask(|tx| Cmd::Dial(p, addrs, tx)).await {
            tracing::debug!("libp2p: {p}: {e}; ищем в DHT");
            self.ask(|tx| Cmd::Find(p, tx)).await?;
        }
        let mut c = self.ctl.clone();
        let s = tokio::time::timeout(OPEN_TIMEOUT, c.open_stream(p, proto))
            .await
            .map_err(|_| anyhow::anyhow!("libp2p: поток не открылся"))?
            .map_err(|e| anyhow::anyhow!("libp2p: {e}"))?;
        Ok(s)
    }

    /// Наши адреса для подсказки `l` (с `/p2p/<мы>`): прямые внешние, в локальной сети, через релеи.
    pub(crate) fn hint(&self) -> Vec<String> {
        let st = self.lock();
        let mut out: Vec<Multiaddr> = Vec::new();
        let direct_ext = st.external.iter().filter(|a| !is_circuit(a));
        let lan = st
            .listen
            .iter()
            .filter(|a| !is_circuit(a) && (self.local || !loopback(a)));
        let relayed = st.external.iter().filter(|a| is_circuit(a));
        for a in direct_ext.chain(lan).chain(relayed) {
            if usable(a) && !out.contains(a) {
                out.push(a.clone());
            }
        }
        out.into_iter()
            .take(8)
            .map(|a| match a.iter().last() {
                Some(Protocol::P2p(_)) => a.to_string(),
                _ => a.with(Protocol::P2p(self.me)).to_string(),
            })
            .collect()
    }

    /// `Some(true)` — все соединения с собеседником прямые, `Some(false)` — есть релейные.
    pub(crate) fn is_direct(&self, p: &PeerId) -> Option<bool> {
        let st = self.lock();
        let m = st.conns.get(p).filter(|m| !m.is_empty())?;
        Some(m.values().all(|c| !c.relayed))
    }

    pub(crate) fn rtt(&self, p: &PeerId) -> Option<u64> {
        let st = self.lock();
        st.conns.get(p)?.values().filter_map(|c| c.rtt).min()
    }

    pub(crate) fn status(&self) -> Value {
        let st = self.lock();
        let short = |p: &PeerId| {
            let s = p.to_string();
            s[s.len().saturating_sub(8)..].to_string()
        };
        json!({
            "peer": self.me.to_string(),
            "nat": st.nat,
            "upnp": st.upnp,
            "listen": st.listen.iter().filter(|a| !is_circuit(a)).take(8).map(|a| a.to_string()).collect::<Vec<_>>(),
            "external": st.external.iter().take(8).map(|a| a.to_string()).collect::<Vec<_>>(),
            "relays": st.relays.iter().map(|(p, ok)| json!({"id": short(p), "ok": ok})).collect::<Vec<_>>(),
            "dht": st.dht,
            "peers": st.conns.len(),
            "lan": st.lan.len(),
        })
    }

    pub(crate) fn shutdown(&self) {
        let _ = self.cmd.send(Cmd::Shutdown);
    }
}

struct Driver {
    sw: Swarm<B>,
    me: PeerId,
    cfg: LpConfig,
    st: Arc<Mutex<St>>,
    ev: mpsc::UnboundedSender<LpEv>,
    cmd_tx: mpsc::UnboundedSender<Cmd>,
    dials: HashMap<PeerId, Vec<oneshot::Sender<Result<(), String>>>>,
    finds: HashMap<kad::QueryId, PeerId>,
    /// Кандидаты в релеи: (релей, адрес с `/p2p/<релей>`).
    hops: Vec<(PeerId, Multiaddr)>,
    reserving: HashMap<ListenerId, PeerId>,
    failed: HashMap<PeerId, Instant>,
    provided: Option<Instant>,
    ext_changed: bool,
}

impl Driver {
    fn lock(&self) -> MutexGuard<'_, St> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn run(mut self, mut cmd: mpsc::UnboundedReceiver<Cmd>) {
        self.bootstrap();
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        loop {
            tokio::select! {
                c = cmd.recv() => match c {
                    None | Some(Cmd::Shutdown) => break,
                    Some(Cmd::Dial(p, a, done)) => self.dial(p, a, done),
                    Some(Cmd::Find(p, done)) => self.find(p, done),
                    Some(Cmd::CloseRelayed(p)) => self.close_relayed(p),
                },
                e = self.sw.select_next_some() => self.on_event(e),
                _ = tick.tick() => self.maintain(),
            }
        }
        tracing::debug!("libp2p: остановлен");
    }

    fn bootstrap(&mut self) {
        for r in &self.cfg.relays {
            if let Ok(a) = r.parse::<Multiaddr>()
                && let Some(Protocol::P2p(p)) = a.iter().last()
            {
                self.hops.push((p, a));
            }
        }
        let Some(k) = self.sw.behaviour_mut().kad.as_mut() else {
            return;
        };
        for s in BOOTSTRAP {
            if let Ok(a) = s.parse::<Multiaddr>()
                && let Some(Protocol::P2p(p)) = a.iter().last()
            {
                k.add_address(&p, a);
            }
        }
        if let Err(e) = k.bootstrap() {
            tracing::debug!("libp2p: DHT: {e}");
        }
    }

    fn later(&self, d: Duration, c: Cmd) {
        let tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(d).await;
            let _ = tx.send(c);
        });
    }

    fn dial(&mut self, p: PeerId, addrs: Vec<Multiaddr>, done: oneshot::Sender<Result<(), String>>) {
        if self.sw.is_connected(&p) {
            let _ = done.send(Ok(()));
            return;
        }
        let opts = DialOpts::peer_id(p)
            .addresses(addrs)
            .condition(PeerCondition::DisconnectedAndNotDialing)
            .extend_addresses_through_behaviour()
            .build();
        match self.sw.dial(opts) {
            Ok(()) | Err(DialError::DialPeerConditionFalse(_)) => {
                self.dials.entry(p).or_default().push(done)
            }
            Err(e) => {
                let _ = done.send(Err(e.to_string()));
            }
        }
    }

    fn find(&mut self, p: PeerId, done: oneshot::Sender<Result<(), String>>) {
        if self.sw.is_connected(&p) {
            let _ = done.send(Ok(()));
            return;
        }
        let Some(k) = self.sw.behaviour_mut().kad.as_mut() else {
            let _ = done.send(Err("нет адресов, DHT выключена".into()));
            return;
        };
        let q = k.get_providers(presence_key(&p));
        self.finds.insert(q, p);
        self.dials.entry(p).or_default().push(done);
    }

    fn fail_dials(&mut self, p: PeerId, e: String) {
        for d in self.dials.remove(&p).unwrap_or_default() {
            let _ = d.send(Err(e.clone()));
        }
    }

    /// Есть прямое соединение — релейные (лимит по времени и объёму) закрываем.
    fn close_relayed(&mut self, p: PeerId) {
        let ids: Vec<ConnectionId> = {
            let st = self.lock();
            match st.conns.get(&p) {
                Some(m) if m.values().any(|c| !c.relayed) => m
                    .iter()
                    .filter(|(_, c)| c.relayed)
                    .map(|(id, _)| *id)
                    .collect(),
                _ => vec![],
            }
        };
        if ids.is_empty() {
            return;
        }
        for id in ids {
            self.sw.close_connection(id);
        }
        tracing::debug!("libp2p: {p}: перешли с релея на прямое соединение");
        let _ = self.ev.send(LpEv::Direct(p));
    }

    fn on_event(&mut self, e: SwarmEvent<BEvent>) {
        match e {
            SwarmEvent::ConnectionEstablished {
                peer_id,
                connection_id,
                endpoint,
                ..
            } => {
                let relayed = endpoint.is_relayed();
                let (addr, dialer) = match &endpoint {
                    ConnectedPoint::Dialer { address, .. } => (address.clone(), true),
                    ConnectedPoint::Listener { send_back_addr, .. } => (send_back_addr.clone(), false),
                };
                let mixed = {
                    let mut st = self.lock();
                    let m = st.conns.entry(peer_id).or_default();
                    m.insert(
                        connection_id,
                        Cn {
                            addr,
                            relayed,
                            dialer,
                            rtt: None,
                        },
                    );
                    m.values().any(|c| c.relayed) && m.values().any(|c| !c.relayed)
                };
                for d in self.dials.remove(&peer_id).unwrap_or_default() {
                    let _ = d.send(Ok(()));
                }
                if mixed {
                    self.later(Duration::from_secs(2), Cmd::CloseRelayed(peer_id));
                }
            }
            SwarmEvent::ConnectionClosed {
                peer_id,
                connection_id,
                ..
            } => {
                let mut st = self.lock();
                if let Some(m) = st.conns.get_mut(&peer_id) {
                    m.remove(&connection_id);
                    if m.is_empty() {
                        st.conns.remove(&peer_id);
                    }
                }
            }
            SwarmEvent::OutgoingConnectionError {
                peer_id: Some(p),
                error,
                ..
            } => {
                if !self.sw.is_connected(&p) && !self.finds.values().any(|x| *x == p) {
                    self.fail_dials(p, error.to_string());
                }
            }
            SwarmEvent::NewListenAddr { address, .. } => {
                let mut st = self.lock();
                if !st.listen.contains(&address) {
                    st.listen.push(address);
                }
            }
            SwarmEvent::ExpiredListenAddr { address, .. } => {
                self.lock().listen.retain(|a| *a != address);
            }
            SwarmEvent::ExternalAddrConfirmed { address } => {
                tracing::debug!("libp2p: внешний адрес {address}");
                let mut st = self.lock();
                if !st.external.contains(&address) {
                    st.external.push(address);
                }
                drop(st);
                self.ext_changed = true;
            }
            SwarmEvent::ExternalAddrExpired { address } => {
                self.lock().external.retain(|a| *a != address);
                self.ext_changed = true;
            }
            SwarmEvent::ListenerClosed { listener_id, .. } => {
                if let Some(r) = self.reserving.remove(&listener_id) {
                    self.lock().relays.remove(&r);
                    self.failed.insert(r, Instant::now());
                }
            }
            SwarmEvent::Behaviour(ev) => self.on_behaviour(ev),
            _ => {}
        }
    }

    fn on_behaviour(&mut self, ev: BEvent) {
        match ev {
            BEvent::Identify(identify::Event::Received { peer_id, info, .. }) => {
                if info.protocols.contains(&kad::PROTOCOL_NAME)
                    && let Some(k) = self.sw.behaviour_mut().kad.as_mut()
                {
                    for a in info
                        .listen_addrs
                        .iter()
                        .filter(|a| global(a) && usable(a) && !is_circuit(a))
                        .take(4)
                    {
                        k.add_address(&peer_id, a.clone());
                    }
                }
                if !self.cfg.local_only
                    && info.protocols.contains(&HOP)
                    && !self.hops.iter().any(|(p, _)| *p == peer_id)
                {
                    let addr = {
                        let st = self.lock();
                        st.conns.get(&peer_id).and_then(|m| {
                            m.values()
                                .find(|c| c.dialer && !c.relayed && global(&c.addr) && usable(&c.addr))
                                .map(|c| c.addr.clone())
                        })
                    };
                    if let Some(a) = addr.and_then(|a| a.with_p2p(peer_id).ok()) {
                        self.hops.push((peer_id, a));
                        if self.hops.len() > 32 {
                            let busy: Vec<PeerId> = self.reserving.values().copied().collect();
                            if let Some(i) = self.hops.iter().position(|(p, _)| !busy.contains(p)) {
                                self.hops.remove(i);
                            }
                        }
                        self.maintain_relays();
                    }
                }
            }
            BEvent::Ping(ping::Event {
                peer,
                connection,
                result: Ok(rtt),
            }) => {
                let mut st = self.lock();
                if let Some(c) = st.conns.get_mut(&peer).and_then(|m| m.get_mut(&connection)) {
                    c.rtt = Some(rtt.as_millis() as u64);
                }
            }
            BEvent::Kad(e) => self.on_kad(e),
            BEvent::Relay(relay::client::Event::ReservationReqAccepted { relay_peer_id, .. }) => {
                self.lock().relays.insert(relay_peer_id, true);
            }
            BEvent::Dcutr(dcutr::Event {
                remote_peer_id,
                result,
            }) => match result {
                Ok(_) => tracing::debug!("libp2p: {remote_peer_id}: NAT пробит"),
                Err(e) => tracing::debug!("libp2p: {remote_peer_id}: NAT не пробит: {e}"),
            },
            BEvent::Autonat(autonat::Event::StatusChanged { new, .. }) => {
                self.lock().nat = match new {
                    autonat::NatStatus::Public(_) => "public",
                    autonat::NatStatus::Private => "private",
                    autonat::NatStatus::Unknown => "unknown",
                };
            }
            BEvent::Upnp(e) => {
                self.lock().upnp = match e {
                    upnp::Event::NewExternalAddr { .. } => "ok",
                    upnp::Event::ExpiredExternalAddr { .. } => "…",
                    upnp::Event::GatewayNotFound => "нет",
                    upnp::Event::NonRoutableGateway => "за NAT провайдера",
                };
            }
            BEvent::Mdns(mdns::Event::Discovered(list)) => {
                let mut direct_to = Vec::new();
                {
                    let mut st = self.lock();
                    for (p, a) in list {
                        let v = st.lan.entry(p).or_default();
                        if !v.contains(&a) && v.len() < 8 {
                            v.push(a);
                        }
                        // собеседник рядом, а соединение через релей — позвоним напрямую
                        if st.conns.get(&p).is_some_and(|m| !m.is_empty() && m.values().all(|c| c.relayed))
                            && !direct_to.contains(&p)
                        {
                            direct_to.push(p);
                        }
                    }
                }
                for p in direct_to {
                    let addrs = self.lock().lan.get(&p).cloned().unwrap_or_default();
                    let _ = self.sw.dial(DialOpts::peer_id(p).addresses(addrs).condition(PeerCondition::Always).build());
                }
            }
            BEvent::Mdns(mdns::Event::Expired(list)) => {
                let mut st = self.lock();
                for (p, a) in list {
                    if let Some(v) = st.lan.get_mut(&p) {
                        v.retain(|x| *x != a);
                        if v.is_empty() {
                            st.lan.remove(&p);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn on_kad(&mut self, e: kad::Event) {
        let kad::Event::OutboundQueryProgressed {
            id, result, step, ..
        } = e
        else {
            return;
        };
        match result {
            kad::QueryResult::GetProviders(Ok(kad::GetProvidersOk::FoundProviders {
                providers,
                ..
            })) => {
                let Some(p) = self.finds.get(&id).copied() else {
                    return;
                };
                if !providers.contains(&p) {
                    return;
                }
                // адреса провайдера kad отдаёт, пока запрос жив, — звоним сразу
                let r = self.sw.dial(
                    DialOpts::peer_id(p)
                        .condition(PeerCondition::DisconnectedAndNotDialing)
                        .build(),
                );
                if let Some(mut q) = self.sw.behaviour_mut().kad.as_mut().and_then(|k| k.query_mut(&id)) {
                    q.finish();
                }
                self.finds.remove(&id);
                if let Err(e) = r
                    && !matches!(e, DialError::DialPeerConditionFalse(_))
                {
                    self.fail_dials(p, e.to_string());
                }
            }
            kad::QueryResult::GetProviders(_) if step.last => {
                if let Some(p) = self.finds.remove(&id)
                    && !self.sw.is_connected(&p)
                {
                    self.fail_dials(p, "не найден в DHT".into());
                }
            }
            kad::QueryResult::StartProviding(r) => {
                tracing::debug!("libp2p: запись в DHT: {}", if r.is_ok() { "ok" } else { "ошибка" });
            }
            _ => {}
        }
    }

    fn maintain(&mut self) {
        if let Some(k) = self.sw.behaviour_mut().kad.as_mut() {
            let n: usize = k.kbuckets().map(|b| b.num_entries()).sum();
            self.lock().dht = n;
        }
        self.maintain_relays();
        // «я в сети» в DHT: когда есть внешние адреса; при их смене — не чаще раза в 2 мин
        let (dht, has_ext) = {
            let st = self.lock();
            (st.dht, !st.external.is_empty())
        };
        let due = match self.provided {
            None => has_ext && dht > 0,
            Some(t) => {
                t.elapsed() > Duration::from_secs(30 * 60)
                    || (self.ext_changed && t.elapsed() > Duration::from_secs(120))
            }
        };
        if due && let Some(k) = self.sw.behaviour_mut().kad.as_mut() {
            self.provided = Some(Instant::now());
            self.ext_changed = false;
            if let Err(e) = k.start_providing(presence_key(&self.me)) {
                tracing::debug!("libp2p: DHT: {e}");
            }
        }
        if self.failed.len() > 64 {
            self.failed.retain(|_, t| t.elapsed() < Duration::from_secs(300));
        }
    }

    /// Держим до двух резервов на релеях (свои из настроек — первыми), пока NAT не публичный.
    fn maintain_relays(&mut self) {
        let want = if self.lock().nat == "public" { 0 } else { RESERVATIONS };
        while self.reserving.len() < want {
            let now = Instant::now();
            let next = self
                .hops
                .iter()
                .find(|(p, _)| {
                    !self.reserving.values().any(|r| r == p)
                        && self
                            .failed
                            .get(p)
                            .is_none_or(|t| now.duration_since(*t) > Duration::from_secs(300))
                })
                .cloned();
            let Some((p, a)) = next else { break };
            match self.sw.listen_on(a.with(Protocol::P2pCircuit)) {
                Ok(id) => {
                    self.reserving.insert(id, p);
                    self.lock().relays.insert(p, false);
                }
                Err(_) => {
                    self.failed.insert(p, now);
                }
            }
        }
    }
}
