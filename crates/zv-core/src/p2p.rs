//! P2P в ядре: личность устройства, узел iroh, канал `p2p` в комнатах (доказательство `bind`),
//! учёт линков. Логика контактов и звонков контактам — в `contacts.rs`.

use crate::{Inner, RoomRole};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::mpsc;
use zv_p2p::{Event, LinkId, Node};
use zv_proto::ids::now_ms;
use zv_signal::{ChanInfo, Channel, Kind, SendMeta};

/// Линк без комнат и дел закрываем после этого простоя.
const LINK_IDLE_MS: u64 = 90_000;
/// Собеседник-приложение из звонка может предложить обмен контактами в течение суток.
pub(crate) const RECENT_MS: u64 = 24 * 3600 * 1000;

#[derive(Default)]
pub(crate) struct P2pState {
    pub links: HashMap<LinkId, LinkState>,
    /// Идёт дозвон: «peer|topic».
    pub dialing: HashSet<String>,
    pub binds_sent: HashSet<(LinkId, String)>,
    /// Собеседники-приложения из звонков: peer → (имя, когда).
    pub recent: HashMap<String, (String, u64)>,
    pub pair_rooms: HashMap<String, zv_proto::Room>,
    pub c: crate::contacts::ContactsState,
}

pub(crate) struct LinkState {
    pub peer: String,
    pub rooms: HashSet<String>,
    pub last_used: u64,
}

pub(crate) fn chan_name(link: LinkId) -> String {
    format!("p2p#{link}")
}

/// Канал комнаты поверх P2P-линка: запечатанные пакеты веб-протокола (`env`), голос — датаграммами.
pub(crate) struct P2pChannel {
    node: Node,
    link: LinkId,
    topic: String,
    name: String,
    tx: AtomicU64,
}

impl Channel for P2pChannel {
    fn kind(&self) -> Kind {
        Kind::P2p
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_up(&self) -> bool {
        self.node.is_alive(self.link)
    }
    fn send(&self, data: Arc<str>, meta: SendMeta) {
        self.tx.fetch_add(1, Ordering::Relaxed);
        if meta.voice {
            let mut b = Vec::with_capacity(1 + self.topic.len() + data.len());
            b.push(b'E');
            b.extend_from_slice(self.topic.as_bytes());
            b.extend_from_slice(data.as_bytes());
            if self.node.send_datagram(self.link, b.into()) {
                return;
            }
        }
        self.node.send(self.link, &json!({"t": "env", "r": self.topic, "d": &*data}));
    }
    fn info(&self) -> ChanInfo {
        let mut i = ChanInfo::new(Kind::P2p, &self.name);
        let up = self.is_up();
        i.state = if up { "up" } else { "down" };
        let (path, rtt) = self.node.path(self.link);
        i.transport = match path.as_str() {
            "direct" => "direct",
            "relay" => "relay",
            _ => "",
        };
        i.connect_ms = rtt.map(|r| r as u32);
        i.tx = self.tx.load(Ordering::Relaxed);
        i.connects = 1;
        i
    }
    fn close(&self) {
        self.node.send(self.link, &json!({"t": "unbind", "r": self.topic}));
    }
}

impl Inner {
    pub(crate) fn node(&self) -> Option<Node> {
        self.p2p.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Мастер-сид устройства (создаётся при первом запуске, хранится под DPAPI).
    fn identity_seed(&self) -> [u8; 32] {
        let mut id: crate::model::Identity = self.identity_file.load();
        let mut seed = [0u8; 32];
        let ok = hex::decode(&id.seed).ok().filter(|b| b.len() == 32);
        match ok {
            Some(b) => seed.copy_from_slice(&b),
            None => {
                id.seed = zv_proto::ids::rand_hex(32);
                id.created = now_ms();
                if let Err(e) = self.identity_file.save(&id) {
                    tracing::warn!("identity.dat: {e}");
                }
                seed.copy_from_slice(&hex::decode(&id.seed).unwrap_or_else(|_| vec![0; 32]));
            }
        }
        seed
    }

    pub(crate) fn p2p_start(self: &Arc<Self>) {
        let (enabled, name) = {
            let st = self.lock();
            (st.settings.p2p, st.settings.name.clone())
        };
        if !enabled || self.node().is_some() || self.p2p_starting.swap(true, Ordering::SeqCst) {
            return;
        }
        let seed = self.identity_seed();
        let cfg = zv_p2p::Config {
            secret: zv_p2p::crypto::endpoint_secret(&seed),
            app_version: self.opts.app_version.clone(),
            name,
            caps: vec!["env".into(), "dgram".into(), "ring".into(), "contact".into()],
            n0: self.opts.p2p_n0,
        };
        let me = self.clone();
        self.rt.spawn(async move {
            let (tx, rx) = mpsc::unbounded_channel();
            let r = Node::start(cfg, tx).await;
            me.p2p_starting.store(false, Ordering::SeqCst);
            match r {
                Ok(node) => {
                    // P2P могли выключить, пока узел запускался
                    if !me.lock().settings.p2p {
                        node.shutdown().await;
                        return;
                    }
                    tracing::info!("p2p: ID устройства {}", node.id());
                    let id = node.id().to_string();
                    let generation = me.p2p_gen.fetch_add(1, Ordering::SeqCst) + 1;
                    *me.p2p.write().unwrap_or_else(|e| e.into_inner()) = Some(node);
                    // недоставленное — сразу на следующем такте чатов
                    me.lock().chats.next_link_retry = 0;
                    me.rt.spawn(p2p_events(Arc::downgrade(&me), rx, generation));
                    me.refresh_extras();
                    me.sync_listeners();
                    me.emit("p2p:ready", json!({"id": id}));
                    // адрес (релей) появляется через секунду-другую — обновим `zv` в hello
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    me.refresh_extras();
                }
                Err(e) => {
                    tracing::warn!("p2p: не запустился: {e}");
                    me.emit("p2p:error", json!({"error": e.to_string()}));
                }
            }
        });
    }

    /// Поля приложения в `hello`/`hi`/`g_hi`: `app`, `av` и (если P2P работает) `zv: {id, r, a}`.
    /// P2P выключили в настройках: закрыть узел, убрать P2P-каналы из комнат и `zv` из hello.
    pub(crate) fn p2p_stop(self: &Arc<Self>) {
        let Some(node) = self.p2p.write().unwrap_or_else(|e| e.into_inner()).take() else { return };
        self.p2p_gen.fetch_add(1, Ordering::SeqCst);
        let (hubs, links) = {
            let mut st = self.lock();
            let links: Vec<LinkId> = st.p2p.links.keys().copied().collect();
            st.p2p.links.clear();
            st.p2p.dialing.clear();
            st.p2p.binds_sent.clear();
            st.p2p.c.presence.clear();
            (st.rooms.values().map(|r| r.hub.clone()).collect::<Vec<_>>(), links)
        };
        for h in &hubs {
            for l in &links {
                h.remove_channel(&chan_name(*l));
            }
        }
        self.refresh_extras();
        self.rt.spawn(async move { node.shutdown().await });
        tracing::info!("p2p: выключен");
        self.emit("p2p:changed", Value::Null);
        self.emit("contacts:changed", Value::Null);
    }

    pub(crate) fn hub_extras(&self) -> Map<String, Value> {
        let mut extras = Map::new();
        extras.insert("app".into(), json!("zvd"));
        extras.insert("av".into(), json!(self.opts.app_version));
        if let Some(n) = self.node() {
            extras.insert("zv".into(), n.addr_json());
        }
        extras
    }

    pub(crate) fn refresh_extras(&self) {
        let e = self.hub_extras();
        let st = self.lock();
        for r in st.rooms.values().filter(|r| r.joined) {
            r.hub.set_extras(e.clone());
        }
    }

    /// Собеседник в комнате звонка прислал `zv` — поднимаем P2P и привязываем комнату.
    pub(crate) fn p2p_consider(self: &Arc<Self>, topic: &str, zv: &Value, name: Option<&str>) {
        let Some(node) = self.node() else { return };
        let Some(peer) = zv.get("id").and_then(|v| v.as_str()).map(str::to_string) else { return };
        if peer == node.id() || !zv_p2p::valid_id(&peer) {
            return;
        }
        let key = format!("{peer}|{topic}");
        {
            let mut st = self.lock();
            st.p2p.recent.insert(peer.clone(), (name.unwrap_or("").to_string(), now_ms()));
            if st.p2p.links.values().any(|l| l.peer == peer && l.rooms.contains(topic)) || st.p2p.dialing.contains(&key) {
                return;
            }
            st.p2p.dialing.insert(key.clone());
        }
        // звонит меньший ID; больший — через 2,5 с, если тот не успел
        let delay = if node.id() < peer.as_str() { 0 } else { 2500 };
        let me = self.clone();
        let topic = topic.to_string();
        let hint = zv.clone();
        self.rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let bound = me.lock().p2p.links.values().any(|l| l.peer == peer && l.rooms.contains(&topic));
            if !bound && me.joined(&topic) {
                match node.connect(&peer, Some(&hint)).await {
                    Ok(link) => me.send_bind(link, &topic),
                    Err(e) => tracing::debug!("p2p: дозвон {}: {e}", &peer[..8]),
                }
            }
            me.lock().p2p.dialing.remove(&key);
        });
    }

    pub(crate) fn send_bind(&self, link: LinkId, topic: &str) {
        let Some(node) = self.node() else { return };
        let Some(peer) = node.peer_of(link) else { return };
        let k = {
            let mut st = self.lock();
            let Some(r) = st.rooms.get(topic) else { return };
            let k = r.room.subkey("zv4-bind");
            if !st.p2p.binds_sent.insert((link, topic.to_string())) {
                return;
            }
            k
        };
        let proof = zv_p2p::crypto::bind_proof(&k, node.id(), &peer);
        node.send(link, &json!({"t": "bind", "r": topic, "p": proof}));
    }

    fn on_bind(self: &Arc<Self>, link: LinkId, peer: &str, msg: &Value) {
        let Some(node) = self.node() else { return };
        let topic = msg.get("r").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let proof = msg.get("p").and_then(|v| v.as_str()).unwrap_or("");
        let (hub, k, joined) = {
            let st = self.lock();
            let Some(r) = st.rooms.get(&topic) else { return };
            if !matches!(r.role, RoomRole::Call) {
                return;
            }
            (r.hub.clone(), r.room.subkey("zv4-bind"), r.joined)
        };
        let want = zv_p2p::crypto::bind_proof(&k, peer, node.id());
        if !zv_p2p::crypto::ct_eq(&want, proof) {
            tracing::debug!("p2p: неверный bind от {}", &peer[..8.min(peer.len())]);
            return;
        }
        node.authorize(link);
        let fresh = {
            let mut st = self.lock();
            let ls = st.p2p.links.entry(link).or_insert_with(|| LinkState {
                peer: peer.to_string(),
                rooms: HashSet::new(),
                last_used: now_ms(),
            });
            ls.last_used = now_ms();
            let fresh = ls.rooms.insert(topic.clone());
            if joined {
                let name = node.remote_hello(link).get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                st.p2p.recent.insert(peer.to_string(), (name, now_ms()));
                if let Some(sess) = st.rooms.get_mut(&topic).and_then(|r| r.session.as_mut())
                    && sess.peer_id.is_none()
                {
                    sess.peer_id = Some(peer.to_string());
                }
            }
            fresh
        };
        if fresh {
            hub.add_channel(Arc::new(P2pChannel {
                node: node.clone(),
                link,
                topic: topic.clone(),
                name: chan_name(link),
                tx: AtomicU64::new(0),
            }));
            tracing::info!("p2p: комната {} привязана к линку {link} ({:?})", &topic[..8], node.path(link).0);
            self.emit("p2p:changed", Value::Null);
            // наш прежний bind мог прийти, когда у собеседника ещё не было комнаты, — отвечаем заново
            self.lock().p2p.binds_sent.remove(&(link, topic.clone()));
        }
        self.send_bind(link, &topic);
    }

    fn detach(&self, link: LinkId, topic: &str) {
        let hub = {
            let mut st = self.lock();
            if let Some(l) = st.p2p.links.get_mut(&link) {
                l.rooms.remove(topic);
            }
            st.p2p.binds_sent.remove(&(link, topic.to_string()));
            st.rooms.get(topic).map(|r| r.hub.clone())
        };
        if let Some(h) = hub {
            h.remove_channel(&chan_name(link));
        }
    }

    /// Комната закрывается/выходим из звонка — отвязать P2P.
    pub(crate) fn p2p_room_closed(&self, topic: &str) {
        let links: Vec<LinkId> = {
            let st = self.lock();
            st.p2p.links.iter().filter(|(_, l)| l.rooms.contains(topic)).map(|(id, _)| *id).collect()
        };
        for l in links {
            if let Some(n) = self.node() {
                n.send(l, &json!({"t": "unbind", "r": topic}));
            }
            self.detach(l, topic);
        }
    }

    fn on_p2p_event(self: &Arc<Self>, ev: Event) {
        match ev {
            Event::LinkUp { link, peer, outbound, hello } => {
                let name = hello.get("name").and_then(|v| v.as_str()).unwrap_or("").chars().take(40).collect::<String>();
                let contact = {
                    let mut st = self.lock();
                    st.p2p.links.insert(link, LinkState { peer: peer.clone(), rooms: HashSet::new(), last_used: now_ms() });
                    let now = now_ms();
                    let addr = hello.get("addr").filter(|a| a.is_object()).cloned();
                    let c = st.contacts.items.iter_mut().find(|c| c.peer == peer).map(|c| {
                        c.last_seen = now;
                        if !name.is_empty() {
                            c.their_name = name.clone();
                        }
                        if addr.is_some() {
                            c.hint = addr.clone();
                        }
                        c.id.clone()
                    });
                    if c.is_some() {
                        let _ = self.contacts_file.save(&st.contacts);
                    }
                    c
                };
                tracing::debug!("p2p: линк {link} {} {}", if outbound { "→" } else { "←" }, &peer[..8]);
                if let Some(cid) = contact {
                    if let Some(n) = self.node() {
                        n.authorize(link);
                    }
                    self.presence_set(&cid, true, Some(link));
                    self.chats_link_up(&peer);
                }
                self.emit("p2p:changed", Value::Null);
            }
            Event::Msg { link, peer, msg } => {
                if let Some(l) = self.lock().p2p.links.get_mut(&link) {
                    l.last_used = now_ms();
                }
                let t = msg.get("t").and_then(|v| v.as_str()).unwrap_or("").to_string();
                match t.as_str() {
                    "bind" => self.on_bind(link, &peer, &msg),
                    "unbind" => {
                        let topic = msg.get("r").and_then(|v| v.as_str()).unwrap_or("");
                        self.detach(link, topic);
                    }
                    "env" => {
                        let topic = msg.get("r").and_then(|v| v.as_str()).unwrap_or("");
                        let d = msg.get("d").and_then(|v| v.as_str()).unwrap_or("");
                        self.inject(link, topic, d);
                    }
                    "ping" => {
                        if let Some(n) = self.node() {
                            n.send(link, &json!({"t": "pong", "n": msg.get("n")}));
                        }
                    }
                    "pong" => {}
                    _ => self.on_zv4(crate::contacts::Src::Link(link), &peer, msg),
                }
            }
            Event::Datagram { link, data, .. } => {
                if data.len() > 33 && data[0] == b'E'
                    && let (Ok(topic), Ok(d)) = (std::str::from_utf8(&data[1..33]), std::str::from_utf8(&data[33..]))
                {
                    self.inject(link, topic, d);
                }
            }
            Event::Stream { link, peer, send, recv } => {
                if let Some(l) = self.lock().p2p.links.get_mut(&link) {
                    l.last_used = now_ms();
                }
                self.on_stream(peer, send, recv);
            }
            Event::LinkDown { link, peer, reason } => {
                tracing::debug!("p2p: линк {link} закрыт: {reason}");
                let (rooms, contact) = {
                    let mut st = self.lock();
                    let rooms: Vec<String> = st.p2p.links.remove(&link).map(|l| l.rooms.into_iter().collect()).unwrap_or_default();
                    st.p2p.binds_sent.retain(|(l, _)| *l != link);
                    let c = st.contacts.items.iter().find(|c| c.peer == peer).map(|c| c.id.clone());
                    (rooms, c)
                };
                for topic in rooms {
                    if let Some(h) = self.hub(&topic) {
                        h.remove_channel(&chan_name(link));
                    }
                }
                if let Some(cid) = contact
                    && self.node().and_then(|n| n.link_for(&peer)).is_none()
                {
                    self.presence_set(&cid, false, None);
                }
                self.emit("p2p:changed", Value::Null);
            }
        }
    }

    fn inject(&self, link: LinkId, topic: &str, d: &str) {
        let hub = {
            let st = self.lock();
            if !st.p2p.links.get(&link).is_some_and(|l| l.rooms.contains(topic)) {
                return;
            }
            st.rooms.get(topic).map(|r| r.hub.clone())
        };
        if let Some(h) = hub {
            h.inject(d.to_string(), "p2p");
        }
    }

    /// Раз в секунду: простаивающие линки — закрыть.
    pub(crate) fn p2p_tick(self: &Arc<Self>, now: u64) {
        let Some(node) = self.node() else { return };
        let busy: HashSet<String> = self.contacts_busy_peers();
        let idle: Vec<LinkId> = {
            let st = self.lock();
            st.p2p
                .links
                .iter()
                .filter(|(_, l)| l.rooms.is_empty() && !busy.contains(&l.peer) && now.saturating_sub(l.last_used) > LINK_IDLE_MS)
                .map(|(id, _)| *id)
                .collect()
        };
        for l in idle {
            node.close_link(l, "idle");
        }
        if (now / 1000).is_multiple_of(10) {
            self.refresh_extras();
            let mut st = self.lock();
            st.p2p.recent.retain(|_, (_, t)| now.saturating_sub(*t) < RECENT_MS);
        }
    }

    pub(crate) fn p2p_status(&self) -> Value {
        let Some(node) = self.node() else {
            let on = self.lock().settings.p2p;
            return json!({"enabled": on, "running": false});
        };
        let mut v = node.status();
        let st = self.lock();
        let rooms: Vec<Value> = st
            .p2p
            .links
            .iter()
            .map(|(id, l)| json!({"link": id, "rooms": l.rooms.iter().map(|t| &t[..8]).collect::<Vec<_>>()}))
            .collect();
        v["bound"] = Value::Array(rooms);
        v["enabled"] = json!(true);
        v["running"] = json!(true);
        v
    }

    /// Комната пары с контактом (секрет — X25519 двух ID): ею запечатываются сообщения через ящики.
    /// Идёт передача файла — линк не простаивает.
    pub(crate) fn touch_peer(&self, peer: &str) {
        let now = now_ms();
        for l in self.lock().p2p.links.values_mut() {
            if l.peer == peer {
                l.last_used = now;
            }
        }
    }

    pub(crate) fn pair_room(&self, peer: &str) -> Option<zv_proto::Room> {
        let node = self.node()?;
        if let Some(r) = self.lock().p2p.pair_rooms.get(peer) {
            return Some(r.clone());
        }
        let pid = zv_p2p::iroh::EndpointId::from_str_hex(peer)?;
        let secret = zv_p2p::crypto::pair_secret(&node.secret_bytes(), &node.id_bytes(), &pid)?;
        let room = zv_proto::Room::from_raw(&secret).ok()?;
        self.lock().p2p.pair_rooms.insert(peer.to_string(), room.clone());
        Some(room)
    }
}

/// Разбор hex-ID без зависимостей от трейтов iroh.
trait FromStrHex {
    fn from_str_hex(s: &str) -> Option<[u8; 32]>;
}
impl FromStrHex for zv_p2p::iroh::EndpointId {
    fn from_str_hex(s: &str) -> Option<[u8; 32]> {
        let b = hex::decode(s).ok()?;
        b.try_into().ok()
    }
}

async fn p2p_events(w: Weak<Inner>, mut rx: mpsc::UnboundedReceiver<Event>, generation: u64) {
    while let Some(ev) = rx.recv().await {
        let Some(inner) = w.upgrade() else { return };
        if inner.p2p_gen.load(Ordering::SeqCst) != generation {
            return; // узел выключили — его события больше не нужны
        }
        inner.on_p2p_event(ev);
    }
}
