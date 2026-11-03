//! Контакты — устройства собеседников-приложений: коды приглашения, обмен контактами после
//! звонка, звонки контактам (`ring`), «в сети», ящики.
//!
//! Пути доставки: P2P-линк iroh (основной) и «ящик» контакта — комната веб-протокола из его
//! секрета, которую он слушает (MQTT/Worker/Nostr/ntfy). Через ящик ходит конверт
//! `{type: "zv4", f: мой ID, p: <запечатано ключом пары>}`; ключ пары — X25519 двух ID, поэтому
//! ни серверы, ни другие контакты прочитать или подделать его не могут.

use crate::model::{Contact, HistoryEntry, INVITE_TTL_MS, Invite};
use crate::{Incoming, Inner, RoomRole, ok, s};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::mpsc;
use zv_p2p::LinkId;
use zv_proto::ids::{now_ms, rand_hex};
use zv_signal::{HubEvent, Profile, RoomHub, SendOpts};

const RING_EVERY_MS: u64 = 3000;
const RING_TIMEOUT_MS: u64 = 45_000;
const ADD_TIMEOUT_MS: u64 = 60_000;
const ADD_EVERY_MS: u64 = 3000;
const OUT_HUB_IDLE_MS: u64 = 90_000;
const PRESENCE_TTL_MS: u64 = 20_000;
const SEEN_TTL_MS: u64 = 600_000;
const OFFER_TTL_MS: u64 = 10 * 60_000;
pub const CODE_PREFIX: &str = "zv4c:";

/// Откуда пришло сообщение ZV4.
#[derive(Debug, Clone)]
pub(crate) enum Src {
    Link(LinkId),
    Room(String),
    /// Из почтового ящика (собеседник, возможно, не в сети).
    Mail,
}

#[derive(Default)]
pub(crate) struct ContactsState {
    /// Звонки контактам и от контактов: комната звонка → звонок.
    pub calls: HashMap<String, ContactCall>,
    /// Комнаты чужих ящиков и приглашений, куда мы пишем.
    pub out_hubs: HashMap<String, OutHub>,
    pub seen: HashMap<String, u64>,
    /// Входящие предложения обменяться контактами.
    pub offers: HashMap<String, Offer>,
    /// Наши предложения: id → (peer, имя для контакта, когда).
    pub my_offers: HashMap<String, (String, String, u64)>,
    pub presence: HashMap<String, Presence>,
    /// Добавление по коду: id запроса → состояние.
    pub adds: HashMap<String, PendingAdd>,
    /// Принятый входящий от контакта ждёт room_join: комната → входящий.
    pub pending_answer: HashMap<String, Incoming>,
}

#[derive(Debug, Clone)]
pub(crate) struct ContactCall {
    pub cid: String,
    pub contact_id: String,
    pub peer: String,
    pub out: bool,
    pub secret: String,
    pub video: bool,
    pub started: u64,
    pub last_ring: u64,
    pub accepted: bool,
    /// Устройство собеседника подтвердило вызов (у него звонит).
    pub acked: bool,
    pub ended: Option<&'static str>,
    pub ended_at: u64,
}

pub(crate) struct OutHub {
    hub: RoomHub,
    up: bool,
    queue: Vec<Value>,
    last_used: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Offer {
    pub id: String,
    pub peer: String,
    pub name: String,
    #[serde(skip)]
    pub inbox: String,
    #[serde(skip)]
    pub link: Option<LinkId>,
    #[serde(skip)]
    pub hint: Option<Value>,
    pub created: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Presence {
    pub online: bool,
    pub at: u64,
    pub path: String,
    pub checking: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingAdd {
    pub peer: String,
    pub secret: String,
    pub name: String,
    pub hint: Option<Value>,
    pub started: u64,
    pub last_sent: u64,
    pub req: Value,
}

/// Код приглашения: `zv4c:` + base64url(JSON {v, i: ID, k: секрет, n: имя, r: релей, x: срок, с}).
pub fn encode_code(id: &str, secret: &str, name: &str, addr: &Value, expires: u64) -> String {
    let mut o = json!({"v": 1, "i": id, "k": secret, "n": name, "x": expires / 1000});
    if let Some(r) = addr.get("r") {
        o["r"] = r.clone();
    }
    if let Some(a) = addr.get("a").and_then(|v| v.as_array()) {
        o["a"] = json!(a.iter().take(4).collect::<Vec<_>>());
    }
    format!(
        "{CODE_PREFIX}{}",
        zv_proto::b64u::enc(o.to_string().as_bytes())
    )
}

pub fn decode_code(text: &str) -> Option<Value> {
    let t = text.trim();
    let t = t
        .strip_prefix("zvonochek://contact?c=")
        .or_else(|| t.strip_prefix("zvonochek://contact/?c="))
        .unwrap_or(t);
    let body = t.strip_prefix(CODE_PREFIX)?;
    let raw = zv_proto::b64u::dec(body.trim()).ok()?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    let id = v.get("i")?.as_str()?;
    let k = v.get("k")?.as_str()?;
    if !zv_p2p::valid_id(id) || !zv_proto::link::valid_secret(k) {
        return None;
    }
    Some(v)
}

/// Адреса собеседника: из сообщения (`addr`) или из его `hello4`.
fn hint_of(node: Option<&zv_p2p::Node>, src: Option<&Src>, msg: &Value) -> Option<Value> {
    if let Some(a) = msg.get("addr").filter(|a| a.is_object()) {
        return Some(a.clone());
    }
    match (node, src) {
        (Some(n), Some(Src::Link(l))) => n.remote_hello(*l).get("addr").cloned(),
        _ => None,
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

fn clean_name(s: &str) -> String {
    s.trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect()
}

impl Inner {
    pub(crate) fn my_name(&self) -> String {
        let n = self.lock().settings.name.clone();
        if n.trim().is_empty() {
            "Без имени".into()
        } else {
            n
        }
    }

    /// Секрет моего ящика (создаётся при первом контакте).
    fn my_inbox(&self) -> String {
        let mut st = self.lock();
        if st.contacts.inbox.is_empty() {
            st.contacts.inbox = zv_proto::link::new_secret();
            let _ = self.contacts_file.save(&st.contacts);
        }
        st.contacts.inbox.clone()
    }

    fn save_contacts(&self, st: &crate::State) {
        if let Err(e) = self.contacts_file.save(&st.contacts) {
            tracing::warn!("contacts.dat: {e}");
        }
    }

    /// Какие комнаты ящиков/приглашений слушать: (секрет, роль).
    pub(crate) fn contact_listen_rooms(&self, st: &crate::State) -> Vec<(String, RoomRole)> {
        let mut v = Vec::new();
        if !st.settings.p2p {
            return v;
        }
        if !st.contacts.items.is_empty() && !st.contacts.inbox.is_empty() {
            v.push((st.contacts.inbox.clone(), RoomRole::Inbox));
        }
        if let Some(inv) = &st.contacts.invite
            && inv.expires > now_ms()
        {
            v.push((inv.secret.clone(), RoomRole::Invite));
        }
        v
    }

    /// Собеседники, с которыми идут дела (звонок, добавление, предложение) — их линки не закрываем.
    pub(crate) fn contacts_busy_peers(&self) -> HashSet<String> {
        let st = self.lock();
        let c = &st.p2p.c;
        let mut v: HashSet<String> = c.calls.values().map(|x| x.peer.clone()).collect();
        v.extend(c.adds.values().map(|a| a.peer.clone()));
        v.extend(c.offers.values().map(|o| o.peer.clone()));
        v.extend(c.my_offers.values().map(|o| o.0.clone()));
        v
    }

    // ---------- отправка ----------

    /// Конверт ZV4 для комнаты: запечатан ключом пары.
    fn zv4_envelope(&self, peer: &str, msg: &Value) -> Option<Value> {
        let node = self.node()?;
        let room = self.pair_room(peer)?;
        Some(json!({"type": "zv4", "f": node.id(), "p": room.seal(msg)}))
    }

    /// Написать в чужую комнату (ящик контакта или приглашение): временная комната, пока не поднимется —
    /// очередь.
    pub(crate) fn send_room(self: &Arc<Self>, secret: &str, envelope: Value) {
        let Ok(room) = zv_proto::Room::derive(secret) else {
            return;
        };
        let topic = room.topic.clone();
        // своя комната (приглашение, которое мы слушаем) — шлём через неё
        let joined = self.lock().rooms.get(&topic).map(|r| r.hub.clone());
        if let Some(h) = joined {
            h.send(envelope, SendOpts::default());
            return;
        }
        let cfg = Arc::new(self.signal_config());
        let mut st = self.lock();
        let now = now_ms();
        if let Some(o) = st.p2p.c.out_hubs.get_mut(&topic) {
            o.last_used = now;
            if o.up {
                o.hub.send(envelope, SendOpts::default());
            } else {
                o.queue.push(envelope);
            }
            return;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let hub = RoomHub::spawn(room, cfg, Profile::Full, tx);
        st.p2p.c.out_hubs.insert(
            topic.clone(),
            OutHub {
                hub,
                up: false,
                queue: vec![envelope],
                last_used: now,
            },
        );
        drop(st);
        self.rt.spawn(out_pump(Arc::downgrade(self), topic, rx));
    }

    /// Отправить контакту: по линку, если он есть; через ящик — если линка нет или `room`.
    pub(crate) fn send_contact(self: &Arc<Self>, peer: &str, msg: &Value, room: bool) -> bool {
        let mut sent = false;
        if let Some(n) = self.node() {
            sent = n.send_peer(peer, msg);
        }
        if room || !sent {
            let inbox = self
                .lock()
                .contacts
                .items
                .iter()
                .find(|c| c.peer == peer)
                .map(|c| c.inbox.clone());
            if let (Some(inbox), Some(env)) = (
                inbox.filter(|s| !s.is_empty()),
                self.zv4_envelope(peer, msg),
            ) {
                self.send_room(&inbox, env);
                sent = true;
            }
        }
        sent
    }

    fn reply(self: &Arc<Self>, src: &Src, peer: &str, msg: &Value) {
        match src {
            Src::Link(l) => {
                if let Some(n) = self.node() {
                    n.send(*l, msg);
                }
            }
            Src::Mail => {
                self.send_contact(peer, msg, false);
            }
            Src::Room(topic) => {
                let Some(env) = self.zv4_envelope(peer, msg) else {
                    return;
                };
                let hub = {
                    let st = self.lock();
                    st.rooms
                        .get(topic)
                        .map(|r| r.hub.clone())
                        .or_else(|| st.p2p.c.out_hubs.get(topic).map(|o| o.hub.clone()))
                };
                if let Some(h) = hub {
                    h.send(env, SendOpts::default());
                }
            }
        }
    }

    /// Сообщение `zv4` в комнате ящика/приглашения (или во временной комнате).
    pub(crate) fn on_zv4_room(self: &Arc<Self>, topic: &str, msg: &Value) {
        if str_of(msg, "type") != "zv4" {
            return;
        }
        let f = str_of(msg, "f").to_string();
        let Some(node) = self.node() else { return };
        if f == node.id() || !zv_p2p::valid_id(&f) {
            return;
        }
        let Some(room) = self.pair_room(&f) else {
            return;
        };
        let Some(inner) = room.open(str_of(msg, "p")) else {
            return;
        };
        self.on_zv4(Src::Room(topic.to_string()), &f, inner);
    }

    /// Сообщения ZV4 о контактах и звонках (из линка или из комнаты).
    pub(crate) fn on_zv4(self: &Arc<Self>, src: Src, peer: &str, msg: Value) {
        let t = str_of(&msg, "t").to_string();
        let now = now_ms();
        // кадр группы по прямой связи (подпись и состав проверяет groups.rs)
        if t == "zvg" {
            if matches!(src, Src::Link(_)) {
                self.on_group_link(peer, &msg);
            }
            return;
        }
        // чаты дедуплицирует база и подтверждает каждый повтор
        if t.starts_with("chat") {
            self.on_chat(src, peer, msg);
            return;
        }
        if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
            let mut st = self.lock();
            let key = format!("{peer}|{id}");
            if st.p2p.c.seen.contains_key(&key) {
                return;
            }
            st.p2p.c.seen.insert(key, now);
        }
        let contact = self
            .lock()
            .contacts
            .items
            .iter()
            .find(|c| c.peer == peer)
            .cloned();
        match (t.as_str(), contact) {
            ("contact_req", _) => self.on_contact_req(&src, peer, &msg),
            ("contact_ok", _) => self.on_contact_ok(peer, &msg),
            ("contact_no", _) => {
                let re = str_of(&msg, "re").to_string();
                let had = self.lock().p2p.c.adds.remove(&re).is_some();
                if had {
                    self.emit(
                        "contact:add_failed",
                        json!({"reason": str_of(&msg, "reason")}),
                    );
                }
            }
            ("contact_offer", c) => self.on_contact_offer(&src, peer, &msg, c),
            ("contact_accept", _) => self.on_contact_accept(peer, &msg),
            ("contact_decline", _) => {
                let re = str_of(&msg, "re").to_string();
                let had = self.lock().p2p.c.my_offers.remove(&re);
                if let Some((_, name, _)) = had {
                    self.emit("contact:offer_declined", json!({"name": name}));
                }
            }
            ("ring", Some(c)) => self.on_ring(&src, &c, &msg),
            ("ring_ack", Some(_)) => {
                if let Some(topic) = self.call_by_cid(str_of(&msg, "cid"), true) {
                    let first = self
                        .lock()
                        .p2p
                        .c
                        .calls
                        .get_mut(&topic)
                        .is_some_and(|c| !std::mem::replace(&mut c.acked, true));
                    if first {
                        self.emit("ring:ringing", json!({"roomId": topic}));
                    }
                }
            }
            ("ring_accept", Some(_)) => {
                if let Some(topic) = self.call_by_cid(str_of(&msg, "cid"), true) {
                    if let Some(c) = self.lock().p2p.c.calls.get_mut(&topic) {
                        c.accepted = true;
                    }
                    self.emit("ring:accepted", json!({"roomId": topic}));
                    self.bind_call(&topic);
                }
            }
            ("ring_decline", Some(c)) => {
                if let Some(topic) = self.call_by_cid(str_of(&msg, "cid"), true) {
                    let reason = if str_of(&msg, "reason") == "dnd" {
                        "dnd"
                    } else {
                        "declined"
                    };
                    let mut st = self.lock();
                    let Some(call) = st.p2p.c.calls.get_mut(&topic) else {
                        return;
                    };
                    if call.accepted || call.ended.is_some() {
                        return;
                    }
                    call.ended = Some(if reason == "dnd" { "dnd" } else { "declined" });
                    call.ended_at = now;
                    drop(st);
                    self.emit(
                        "ring:ended",
                        json!({"roomId": topic, "reason": reason, "name": c.name}),
                    );
                }
            }
            ("ring_cancel", Some(_)) => {
                let cid = str_of(&msg, "cid").to_string();
                let exists = self.lock().incoming.contains_key(&cid);
                if exists {
                    self.end_incoming(&cid, "missed");
                }
            }
            (other, c) => tracing::debug!(
                "zv4: {other} от {} (контакт: {})",
                &peer[..8.min(peer.len())],
                c.is_some()
            ),
        }
    }

    fn call_by_cid(&self, cid: &str, out: bool) -> Option<String> {
        let st = self.lock();
        st.p2p
            .c
            .calls
            .iter()
            .find(|(_, c)| c.cid == cid && c.out == out)
            .map(|(t, _)| t.clone())
    }

    // ---------- коды приглашения ----------

    fn invite_json(&self, inv: &Invite) -> Value {
        let (id, addr) = match self.node() {
            Some(n) => (n.id().to_string(), n.addr_json()),
            None => (String::new(), Value::Null),
        };
        let code = encode_code(&id, &inv.secret, &self.my_name(), &addr, inv.expires);
        json!({"code": code, "url": format!("zvonochek://contact?c={code}"), "expires": inv.expires, "created": inv.created})
    }

    pub(crate) fn contact_invite(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        if self.node().is_none() {
            return Err(self.p2p_unavailable());
        }
        let renew = args.get("renew").and_then(|v| v.as_bool()).unwrap_or(false);
        let inv = {
            let mut st = self.lock();
            let now = now_ms();
            let valid = st
                .contacts
                .invite
                .as_ref()
                .is_some_and(|i| i.expires > now + 3_600_000);
            if renew || !valid {
                st.contacts.invite = Some(Invite {
                    secret: zv_proto::link::new_secret(),
                    created: now,
                    expires: now + INVITE_TTL_MS,
                });
                self.save_contacts(&st);
            }
            st.contacts.invite.clone().ok_or("нет кода")?
        };
        self.my_inbox();
        self.sync_listeners();
        Ok(self.invite_json(&inv))
    }

    pub(crate) fn p2p_unavailable(&self) -> String {
        if self.lock().settings.p2p {
            "Прямое соединение ещё запускается — попробуйте через пару секунд".into()
        } else {
            "Включите «Прямое соединение между приложениями» в настройках".into()
        }
    }

    /// Добавить по коду приглашения (мы — приглашённый).
    pub(crate) fn contact_add(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let node = self.node().ok_or_else(|| self.p2p_unavailable())?;
        let code = decode_code(s(args, "code")?).ok_or("Это не код приглашения ZVONochek")?;
        let peer = str_of(&code, "i").to_string();
        let secret = str_of(&code, "k").to_string();
        if peer == node.id() {
            return Err("Это ваш собственный код".into());
        }
        if code
            .get("x")
            .and_then(|v| v.as_u64())
            .is_some_and(|x| x * 1000 < now_ms())
        {
            return Err("Срок действия кода истёк — попросите новый".into());
        }
        let user_name = clean_name(args.get("name").and_then(|v| v.as_str()).unwrap_or(""));
        let name = if user_name.is_empty() {
            clean_name(str_of(&code, "n"))
        } else {
            user_name
        };
        let name = if name.is_empty() {
            "Контакт".to_string()
        } else {
            name
        };
        if let Some(c) = self.lock().contacts.items.iter().find(|c| c.peer == peer) {
            return Err(format!("Уже в контактах: {}", c.name));
        }
        let id = rand_hex(8);
        let req = json!({
            "t": "contact_req",
            "id": id,
            "ik": zv_p2p::crypto::invite_tag(&secret, node.id(), &peer),
            "name": self.my_name(),
            "inbox": self.my_inbox(),
            "addr": node.addr_json(),
        });
        let hint = json!({"r": code.get("r"), "a": code.get("a")});
        self.lock().p2p.c.adds.insert(
            id.clone(),
            PendingAdd {
                peer: peer.clone(),
                secret: secret.clone(),
                name: name.clone(),
                hint: Some(hint.clone()),
                started: now_ms(),
                last_sent: now_ms(),
                req: req.clone(),
            },
        );
        // путь 1: P2P
        let me = self.clone();
        let (p2, r2) = (peer.clone(), req.clone());
        self.rt.spawn(async move {
            match node.connect(&p2, Some(&hint)).await {
                Ok(link) => {
                    node.send(link, &r2);
                }
                Err(e) => tracing::info!(
                    "контакт по коду: P2P не вышел ({e}), остаётся комната приглашения"
                ),
            }
            let _ = me;
        });
        // путь 2: комната приглашения
        if let Some(env) = self.zv4_envelope(&peer, &req) {
            self.send_room(&secret, env);
        }
        Ok(json!({"pending": true, "reqId": id, "name": name}))
    }

    fn on_contact_req(self: &Arc<Self>, src: &Src, peer: &str, msg: &Value) {
        let Some(node) = self.node() else { return };
        let inv = self.lock().contacts.invite.clone();
        let re = str_of(msg, "id").to_string();
        let Some(inv) = inv.filter(|i| i.expires > now_ms()) else {
            self.reply(
                src,
                peer,
                &json!({"t": "contact_no", "id": rand_hex(8), "re": re, "reason": "expired"}),
            );
            return;
        };
        let want = zv_p2p::crypto::invite_tag(&inv.secret, peer, node.id());
        if !zv_p2p::crypto::ct_eq(&want, str_of(msg, "ik")) {
            tracing::info!("контакт: запрос с чужим кодом от {}", &peer[..8]);
            if matches!(src, Src::Room(_)) {
                self.reply(
                    src,
                    peer,
                    &json!({"t": "contact_no", "id": rand_hex(8), "re": re, "reason": "expired"}),
                );
            }
            return;
        }
        let inbox = str_of(msg, "inbox").to_string();
        if !zv_proto::link::valid_secret(&inbox) {
            return;
        }
        if let Src::Link(l) = src {
            node.authorize(*l);
        }
        let their = clean_name(str_of(msg, "name"));
        let hint = hint_of(Some(&node), Some(src), msg);
        let (cid, name, fresh) = self.upsert_contact(peer, &their, &their, &inbox, hint);
        self.reply(
            src,
            peer,
            &json!({"t": "contact_ok", "id": rand_hex(8), "re": re, "name": self.my_name(), "inbox": self.my_inbox(), "addr": node.addr_json()}),
        );
        if fresh {
            self.emit(
                "contact:added",
                json!({"id": cid, "name": name, "via": "invite"}),
            );
        }
    }

    /// Создать или обновить контакт. → (id, имя, новый ли).
    fn upsert_contact(
        self: &Arc<Self>,
        peer: &str,
        name: &str,
        their: &str,
        inbox: &str,
        hint: Option<Value>,
    ) -> (String, String, bool) {
        let hint = hint.filter(|h| {
            h.get("r").is_some_and(|r| r.is_string()) || h.get("a").is_some_and(|a| a.is_array())
        });
        let now = now_ms();
        let r = {
            let mut st = self.lock();
            let r = if let Some(c) = st.contacts.items.iter_mut().find(|c| c.peer == peer) {
                if !inbox.is_empty() {
                    c.inbox = inbox.to_string();
                }
                if !their.is_empty() {
                    c.their_name = their.to_string();
                }
                if hint.is_some() {
                    c.hint = hint.clone();
                }
                c.last_seen = now;
                (c.id.clone(), c.name.clone(), false)
            } else {
                let c = Contact {
                    id: rand_hex(6),
                    name: if name.is_empty() {
                        "Контакт".into()
                    } else {
                        name.to_string()
                    },
                    peer: peer.to_string(),
                    their_name: their.to_string(),
                    inbox: inbox.to_string(),
                    verified: false,
                    created: now,
                    last_seen: now,
                    hint: hint.clone(),
                };
                let r = (c.id.clone(), c.name.clone(), true);
                st.contacts.items.push(c);
                r
            };
            self.save_contacts(&st);
            r
        };
        self.my_inbox();
        self.sync_listeners();
        self.emit("contacts:changed", Value::Null);
        r
    }

    fn on_contact_ok(self: &Arc<Self>, peer: &str, msg: &Value) {
        let re = str_of(msg, "re").to_string();
        let add = {
            let mut st = self.lock();
            match st.p2p.c.adds.get(&re) {
                Some(a) if a.peer == peer => st.p2p.c.adds.remove(&re),
                _ => None,
            }
        };
        let Some(add) = add else { return };
        let inbox = str_of(msg, "inbox").to_string();
        if !zv_proto::link::valid_secret(&inbox) {
            return;
        }
        let their = clean_name(str_of(msg, "name"));
        let hint = hint_of(self.node().as_ref(), None, msg).or(add.hint);
        let (cid, name, _) = self.upsert_contact(peer, &add.name, &their, &inbox, hint);
        if let Some(n) = self.node()
            && let Some(l) = n.link_for(peer)
        {
            n.authorize(l);
        }
        self.emit(
            "contact:added",
            json!({"id": cid, "name": name, "via": "code"}),
        );
    }

    // ---------- обмен контактами после звонка ----------

    /// Предложить собеседнику-приложению из недавнего звонка обменяться контактами.
    pub(crate) fn contact_offer(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let node = self.node().ok_or_else(|| self.p2p_unavailable())?;
        let peer = s(args, "peerId")?.to_string();
        if !zv_p2p::valid_id(&peer) || peer == node.id() {
            return Err("неверный ID".into());
        }
        if let Some(c) = self.lock().contacts.items.iter().find(|c| c.peer == peer) {
            return Err(format!("Уже в контактах: {}", c.name));
        }
        let name = clean_name(args.get("name").and_then(|v| v.as_str()).unwrap_or(""));
        let id = rand_hex(8);
        let msg = json!({"t": "contact_offer", "id": id, "name": self.my_name(), "inbox": self.my_inbox(), "addr": node.addr_json()});
        self.lock()
            .p2p
            .c
            .my_offers
            .insert(id.clone(), (peer.clone(), name.clone(), now_ms()));
        let me = self.clone();
        let oid = id.clone();
        self.rt.spawn(async move {
            match node.connect(&peer, None).await {
                Ok(link) => {
                    node.send(link, &msg);
                    me.emit("contact:offer_sent", json!({"peerId": peer}));
                }
                Err(e) => {
                    me.lock().p2p.c.my_offers.remove(&oid);
                    me.emit(
                        "contact:offer_failed",
                        json!({"peerId": peer, "error": format!("Собеседник не в сети ({e})")}),
                    );
                }
            }
        });
        Ok(json!({"pending": true, "offerId": id}))
    }

    fn on_contact_offer(
        self: &Arc<Self>,
        src: &Src,
        peer: &str,
        msg: &Value,
        existing: Option<Contact>,
    ) {
        let Some(node) = self.node() else { return };
        let Src::Link(link) = src else { return };
        let inbox = str_of(msg, "inbox").to_string();
        if !zv_proto::link::valid_secret(&inbox) {
            return;
        }
        let their = clean_name(str_of(msg, "name"));
        let id = str_of(msg, "id").to_string();
        if existing.is_some() {
            // уже контакт (например, у него контакт удалён) — просто обновить и подтвердить
            node.authorize(*link);
            self.upsert_contact(
                peer,
                &their,
                &their,
                &inbox,
                hint_of(Some(&node), Some(src), msg),
            );
            node.send(
                *link,
                &json!({"t": "contact_accept", "id": rand_hex(8), "re": id, "name": self.my_name(), "inbox": self.my_inbox(), "addr": node.addr_json()}),
            );
            return;
        }
        let recent = self
            .lock()
            .p2p
            .recent
            .get(peer)
            .is_some_and(|(_, t)| now_ms().saturating_sub(*t) < crate::p2p::RECENT_MS);
        if !recent {
            tracing::info!("контакт: предложение от незнакомого {}", &peer[..8]);
            return;
        }
        node.authorize(*link);
        let offer = Offer {
            id: id.clone(),
            peer: peer.to_string(),
            name: their.clone(),
            inbox,
            link: Some(*link),
            hint: hint_of(Some(&node), Some(src), msg),
            created: now_ms(),
        };
        self.lock().p2p.c.offers.insert(id.clone(), offer.clone());
        self.emit(
            "contact:offer",
            serde_json::to_value(&offer).unwrap_or_default(),
        );
    }

    pub(crate) fn contact_offer_answer(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let id = s(args, "offerId")?;
        let accept = args
            .get("accept")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let offer = self
            .lock()
            .p2p
            .c
            .offers
            .remove(id)
            .ok_or("Предложение уже неактуально")?;
        let node = self.node().ok_or_else(|| self.p2p_unavailable())?;
        let reply = if accept {
            let name = clean_name(args.get("name").and_then(|v| v.as_str()).unwrap_or(""));
            let name = if name.is_empty() {
                offer.name.clone()
            } else {
                name
            };
            let (cid, name, _) = self.upsert_contact(
                &offer.peer,
                &name,
                &offer.name,
                &offer.inbox,
                offer.hint.clone(),
            );
            self.emit(
                "contact:added",
                json!({"id": cid, "name": name, "via": "offer"}),
            );
            json!({"t": "contact_accept", "id": rand_hex(8), "re": offer.id, "name": self.my_name(), "inbox": self.my_inbox(), "addr": node.addr_json()})
        } else {
            json!({"t": "contact_decline", "id": rand_hex(8), "re": offer.id})
        };
        let sent = offer.link.is_some_and(|l| node.send(l, &reply));
        if !sent {
            let me = self.clone();
            self.rt.spawn(async move {
                if let Ok(l) = node.connect(&offer.peer, None).await {
                    node.send(l, &reply);
                }
                let _ = me;
            });
        }
        Ok(Value::Null)
    }

    fn on_contact_accept(self: &Arc<Self>, peer: &str, msg: &Value) {
        let re = str_of(msg, "re").to_string();
        let mine = {
            let mut st = self.lock();
            match st.p2p.c.my_offers.get(&re) {
                Some((p, _, _)) if p == peer => st.p2p.c.my_offers.remove(&re),
                _ => None,
            }
        };
        let inbox = str_of(msg, "inbox").to_string();
        if !zv_proto::link::valid_secret(&inbox) {
            return;
        }
        let their = clean_name(str_of(msg, "name"));
        match mine {
            Some((_, name, _)) => {
                let name = if name.is_empty() { their.clone() } else { name };
                let (cid, name, _) = self.upsert_contact(
                    peer,
                    &name,
                    &their,
                    &inbox,
                    hint_of(self.node().as_ref(), None, msg),
                );
                self.emit(
                    "contact:added",
                    json!({"id": cid, "name": name, "via": "offer"}),
                );
            }
            None => {
                // подтверждение для уже существующего контакта — только обновить ящик
                if self.lock().contacts.items.iter().any(|c| c.peer == peer) {
                    self.upsert_contact(
                        peer,
                        "",
                        &their,
                        &inbox,
                        hint_of(self.node().as_ref(), None, msg),
                    );
                }
            }
        }
    }

    // ---------- список, правка ----------

    pub(crate) fn contacts_list(&self) -> Value {
        let st = self.lock();
        let me = self.node().map(|n| n.id().to_string()).unwrap_or_default();
        let v: Vec<Value> = st
            .contacts
            .items
            .iter()
            .map(|c| {
                let p = st.p2p.c.presence.get(&c.id);
                json!({
                    "id": c.id,
                    "name": c.name,
                    "theirName": c.their_name,
                    "peer": c.peer,
                    "verified": c.verified,
                    "created": c.created,
                    "lastSeen": c.last_seen,
                    "online": p.map(|p| p.online),
                    "path": p.map(|p| p.path.clone()),
                    "checking": p.map(|p| p.checking).unwrap_or(false),
                    "safety": if me.is_empty() { Value::Null } else {
                        let (e, d) = zv_p2p::crypto::safety_code(&me, &c.peer);
                        json!({"emoji": e, "digits": d})
                    },
                })
            })
            .collect();
        Value::Array(v)
    }

    pub(crate) fn contact_update(&self, args: &Value) -> Result<Value, String> {
        let id = s(args, "id")?;
        let mut st = self.lock();
        let c = st
            .contacts
            .items
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or("нет такого контакта")?;
        if let Some(n) = args.get("name").and_then(|v| v.as_str()) {
            let n = clean_name(n);
            if !n.is_empty() {
                c.name = n;
            }
        }
        if let Some(v) = args.get("verified").and_then(|v| v.as_bool()) {
            c.verified = v;
        }
        self.save_contacts(&st);
        drop(st);
        self.emit("contacts:changed", Value::Null);
        Ok(Value::Null)
    }

    pub(crate) fn contact_delete(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let id = s(args, "id")?;
        let peer = {
            let mut st = self.lock();
            let peer = st
                .contacts
                .items
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.peer.clone());
            st.contacts.items.retain(|c| c.id != id);
            st.p2p.c.presence.remove(id);
            self.save_contacts(&st);
            peer
        };
        if let Some(p) = peer {
            self.chat_forget(id, &p);
        }
        self.sync_listeners();
        self.emit("contacts:changed", Value::Null);
        Ok(Value::Null)
    }

    pub(crate) fn presence_set(&self, cid: &str, online: bool, link: Option<LinkId>) {
        let path = match (link, self.node()) {
            (Some(l), Some(n)) => n.path(l).0,
            _ => String::new(),
        };
        let changed = {
            let mut st = self.lock();
            let old = st
                .p2p
                .c
                .presence
                .get(cid)
                .map(|p| (p.online, p.path.clone()));
            st.p2p.c.presence.insert(
                cid.to_string(),
                Presence {
                    online,
                    at: now_ms(),
                    path: path.clone(),
                    checking: false,
                },
            );
            old != Some((online, path.clone()))
        };
        if changed {
            self.emit(
                "contacts:presence",
                json!({"id": cid, "online": online, "path": path}),
            );
        }
    }

    /// Проверить, кто в сети (страница контактов открыта): живые линки — сразу, остальным — дозвон.
    pub(crate) fn contacts_presence(self: &Arc<Self>) -> Result<Value, String> {
        let Some(node) = self.node() else {
            return Ok(Value::Null);
        };
        let now = now_ms();
        let todo: Vec<(String, String, Option<Value>)> =
            {
                let mut st = self.lock();
                let items: Vec<(String, String, Option<Value>)> = st
                    .contacts
                    .items
                    .iter()
                    .map(|c| (c.id.clone(), c.peer.clone(), c.hint.clone()))
                    .collect();
                let mut todo = Vec::new();
                for (cid, peer, hint) in items {
                    if node.link_for(&peer).is_some() {
                        continue;
                    }
                    let fresh =
                        st.p2p.c.presence.get(&cid).is_some_and(|p| {
                            p.checking || now.saturating_sub(p.at) < PRESENCE_TTL_MS
                        });
                    if fresh {
                        continue;
                    }
                    let prev = st
                        .p2p
                        .c
                        .presence
                        .get(&cid)
                        .map(|p| p.online)
                        .unwrap_or(false);
                    st.p2p.c.presence.insert(
                        cid.clone(),
                        Presence {
                            online: prev,
                            at: now,
                            path: String::new(),
                            checking: true,
                        },
                    );
                    todo.push((cid, peer, hint));
                }
                todo
            };
        // отдельной переменной: временный guard в заголовке `for` жил бы до конца цикла
        let all: Vec<(String, String)> = self
            .lock()
            .contacts
            .items
            .iter()
            .map(|c| (c.id.clone(), c.peer.clone()))
            .collect();
        for (cid, peer) in all {
            if let Some(l) = node.link_for(&peer) {
                self.presence_set(&cid, true, Some(l));
            }
        }
        for (cid, peer, hint) in todo {
            let me = self.clone();
            let node = node.clone();
            self.rt.spawn(async move {
                let r = tokio::time::timeout(
                    Duration::from_secs(10),
                    node.connect(&peer, hint.as_ref()),
                )
                .await;
                match r {
                    Ok(Ok(l)) => me.presence_set(&cid, true, Some(l)),
                    _ => me.presence_set(&cid, false, None),
                }
            });
        }
        Ok(self.contacts_list())
    }

    // ---------- звонки контактам ----------

    pub(crate) fn contact_call(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        if self.node().is_none() {
            return Err(self.p2p_unavailable());
        }
        let id = s(args, "id")?;
        let video = args.get("video").and_then(|v| v.as_bool()).unwrap_or(false);
        let c = self
            .lock()
            .contacts
            .items
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or("нет такого контакта")?;
        if self.lock().rooms.values().any(|r| r.joined) {
            return Err("Сначала завершите текущий звонок".into());
        }
        let secret = zv_proto::link::new_secret();
        let topic = zv_proto::Room::derive(&secret)
            .map_err(|e| e.to_string())?
            .topic;
        let cid = rand_hex(8);
        let now = now_ms();
        self.lock().p2p.c.calls.insert(
            topic.clone(),
            ContactCall {
                cid: cid.clone(),
                contact_id: c.id.clone(),
                peer: c.peer.clone(),
                out: true,
                secret: secret.clone(),
                video,
                started: now,
                last_ring: now,
                accepted: false,
                acked: false,
                ended: None,
                ended_at: 0,
            },
        );
        self.ring_send(&topic, true);
        // поднять линк и повторить звонок по нему сразу
        if let Some(node) = self.node() {
            let me = self.clone();
            let (peer, hint, t2) = (c.peer.clone(), c.hint.clone(), topic.clone());
            self.rt.spawn(async move {
                if node.link_for(&peer).is_none()
                    && node.connect(&peer, hint.as_ref()).await.is_ok()
                {
                    me.ring_send(&t2, false);
                }
            });
        }
        Ok(
            json!({"secret": secret, "roomId": topic, "callId": cid, "name": c.name, "video": video}),
        )
    }

    fn ring_send(self: &Arc<Self>, topic: &str, room: bool) {
        let (call, name) = {
            let mut st = self.lock();
            let name = st.settings.name.clone();
            let Some(c) = st.p2p.c.calls.get_mut(topic) else {
                return;
            };
            c.last_ring = now_ms();
            (c.clone(), name)
        };
        let msg = json!({"t": "ring", "id": rand_hex(8), "cid": call.cid, "k": call.secret, "video": call.video, "name": name});
        self.send_contact(&call.peer, &msg, room);
    }

    fn on_ring(self: &Arc<Self>, src: &Src, c: &Contact, msg: &Value) {
        let cid = str_of(msg, "cid").to_string();
        let k = str_of(msg, "k").to_string();
        let Ok(room) = zv_proto::Room::derive(&k) else {
            return;
        };
        let now = now_ms();
        let video = msg.get("video").and_then(|v| v.as_bool()).unwrap_or(false);
        let mut st = self.lock();
        if let Some(inc) = st.incoming.get_mut(&cid) {
            inc.last_seen = now;
            return;
        }
        if st.p2p.c.calls.values().any(|x| x.cid == cid) {
            return; // уже ответили/отклонили
        }
        st.p2p.c.calls.insert(
            room.topic.clone(),
            ContactCall {
                cid: cid.clone(),
                contact_id: c.id.clone(),
                peer: c.peer.clone(),
                out: false,
                secret: k.clone(),
                video,
                started: now,
                last_ring: now,
                accepted: false,
                acked: false,
                ended: None,
                ended_at: 0,
            },
        );
        if st.settings.dnd {
            let e = HistoryEntry {
                id: rand_hex(6),
                dir: "in".into(),
                result: "missed".into(),
                peer: c.name.clone(),
                link_id: None,
                link_name: None,
                started: now,
                duration: 0,
                peer_seen: true,
                contact_id: Some(c.id.clone()),
                peer_id: Some(c.peer.clone()),
                video,
                group_id: None,
            };
            self.push_history(&mut st, e);
            if let Some(call) = st.p2p.c.calls.get_mut(&room.topic) {
                call.ended = Some("dnd");
                call.ended_at = now;
            }
            drop(st);
            self.emit("history:changed", Value::Null);
            let m = json!({"t": "ring_decline", "id": rand_hex(8), "cid": cid, "reason": "dnd"});
            self.reply(src, &c.peer, &m);
            self.send_contact(&c.peer, &m, false);
            return;
        }
        let busy = st.rooms.values().any(|r| r.joined);
        let inc = Incoming {
            call_id: cid.clone(),
            room_id: room.topic.clone(),
            link_id: String::new(),
            link_name: String::new(),
            from: c.peer.clone(),
            inst: format!("c:{cid}"),
            name: c.name.clone(),
            started: now,
            last_seen: now,
            app: true,
            busy,
            contact_id: Some(c.id.clone()),
            video,
            secret: Some(k),
            group_id: None,
            group_name: None,
        };
        st.incoming.insert(cid.clone(), inc.clone());
        drop(st);
        self.emit(
            "call:incoming",
            serde_json::to_value(&inc).unwrap_or_default(),
        );
        self.reply(
            src,
            &c.peer,
            &json!({"t": "ring_ack", "id": rand_hex(8), "cid": cid}),
        );
    }

    /// Ответили на входящий от контакта: сообщить звонящему (по всем путям).
    pub(crate) fn ring_answered(self: &Arc<Self>, inc: &Incoming) {
        {
            let mut st = self.lock();
            if let Some(c) = st.p2p.c.calls.get_mut(&inc.room_id) {
                c.accepted = true;
            }
            st.p2p
                .c
                .pending_answer
                .insert(inc.room_id.clone(), inc.clone());
        }
        self.send_contact(
            &inc.from,
            &json!({"t": "ring_accept", "id": rand_hex(8), "cid": inc.call_id}),
            true,
        );
    }

    pub(crate) fn ring_declined(self: &Arc<Self>, inc: &Incoming) {
        {
            let mut st = self.lock();
            if let Some(c) = st.p2p.c.calls.get_mut(&inc.room_id) {
                c.ended = Some("declined");
                c.ended_at = now_ms();
            }
        }
        self.send_contact(
            &inc.from,
            &json!({"t": "ring_decline", "id": rand_hex(8), "cid": inc.call_id}),
            true,
        );
    }

    /// Контактный звонок: привязать комнату звонка к линку сразу (не дожидаясь `hello` с `zv`).
    pub(crate) fn bind_call(self: &Arc<Self>, topic: &str) {
        let Some(node) = self.node() else { return };
        let Some(call) = self.lock().p2p.c.calls.get(topic).cloned() else {
            return;
        };
        if !self.joined(topic) {
            return;
        }
        let me = self.clone();
        let topic = topic.to_string();
        self.rt.spawn(async move {
            let hint = me
                .lock()
                .contacts
                .items
                .iter()
                .find(|c| c.peer == call.peer)
                .and_then(|c| c.hint.clone());
            if let Ok(l) = node.connect(&call.peer, hint.as_ref()).await {
                me.send_bind(l, &topic);
            }
        });
    }

    /// Выход из комнаты звонка контакту: отменить незавершённый вызов; итог для журнала.
    /// Состояние вызова контакта по секрету комнаты (окно звонка открылось позже событий `ring:*`).
    pub(crate) fn contact_call_state(&self, args: &Value) -> Result<Value, String> {
        let secret = s(args, "secret")?;
        let topic = zv_proto::Room::derive(secret)
            .map_err(|e| e.to_string())?
            .topic;
        let st = self.lock();
        let Some(c) = st.p2p.c.calls.get(&topic) else {
            return Ok(Value::Null);
        };
        let name = st
            .contacts
            .items
            .iter()
            .find(|x| x.id == c.contact_id)
            .map(|x| x.name.clone())
            .unwrap_or_default();
        let state = match (c.ended, c.accepted, c.acked) {
            (Some(_), _, _) => "ended",
            (None, true, _) => "accepted",
            (None, false, true) => "ringing",
            _ => "calling",
        };
        Ok(
            json!({"roomId": topic, "out": c.out, "state": state, "reason": c.ended, "name": name, "video": c.video}),
        )
    }

    pub(crate) fn contact_call_left(
        self: &Arc<Self>,
        topic: &str,
    ) -> Option<(&'static str, String, bool)> {
        let call = self.lock().p2p.c.calls.remove(topic)?;
        if call.out && !call.accepted && call.ended.is_none() {
            self.send_contact(
                &call.peer,
                &json!({"t": "ring_cancel", "id": rand_hex(8), "cid": call.cid}),
                true,
            );
        }
        let res = match (call.out, call.ended) {
            (true, Some("declined" | "dnd")) => "declined",
            (true, Some("noanswer")) => "noanswer",
            (true, None) if call.accepted => "outgoing",
            _ => "",
        };
        Some((res, call.contact_id, call.video))
    }

    pub(crate) fn contacts_tick(self: &Arc<Self>, now: u64) {
        // повтор звонка и таймаут
        type Resend = Vec<(String, bool)>;
        type Timeout = Vec<(String, String)>;
        let (resend, timeout): (Resend, Timeout) = {
            let st = self.lock();
            let mut r = Vec::new();
            let mut t = Vec::new();
            for (topic, c) in &st.p2p.c.calls {
                if !c.out || c.accepted || c.ended.is_some() {
                    continue;
                }
                if now.saturating_sub(c.started) > RING_TIMEOUT_MS {
                    let name = st
                        .contacts
                        .items
                        .iter()
                        .find(|x| x.id == c.contact_id)
                        .map(|x| x.name.clone())
                        .unwrap_or_default();
                    t.push((topic.clone(), name));
                } else if now.saturating_sub(c.last_ring) >= RING_EVERY_MS {
                    // через ящик — каждые 3 с первые 15 с, потом каждые 6 с
                    let age = now.saturating_sub(c.started);
                    r.push((
                        topic.clone(),
                        age < 15_000 || (age / RING_EVERY_MS).is_multiple_of(2),
                    ));
                }
            }
            (r, t)
        };
        for (topic, room) in resend {
            self.ring_send(&topic, room);
        }
        for (topic, name) in timeout {
            let peer_cid = {
                let mut st = self.lock();
                st.p2p.c.calls.get_mut(&topic).map(|c| {
                    c.ended = Some("noanswer");
                    c.ended_at = now;
                    (c.peer.clone(), c.cid.clone())
                })
            };
            if let Some((peer, cid)) = peer_cid {
                self.send_contact(
                    &peer,
                    &json!({"t": "ring_cancel", "id": rand_hex(8), "cid": cid}),
                    true,
                );
                self.emit(
                    "ring:ended",
                    json!({"roomId": topic, "reason": "noanswer", "name": name}),
                );
            }
        }
        // добавление по коду: повтор через комнату приглашения и таймаут
        let (again, failed): (Vec<PendingAdd>, Vec<String>) = {
            let mut st = self.lock();
            let mut again = Vec::new();
            let mut failed = Vec::new();
            for (id, a) in st.p2p.c.adds.iter_mut() {
                if now.saturating_sub(a.started) > ADD_TIMEOUT_MS {
                    failed.push(id.clone());
                } else if now.saturating_sub(a.last_sent) >= ADD_EVERY_MS {
                    a.last_sent = now;
                    again.push(a.clone());
                }
            }
            for id in &failed {
                st.p2p.c.adds.remove(id);
            }
            (again, failed)
        };
        for a in again {
            let sent_p2p = self.node().is_some_and(|n| n.send_peer(&a.peer, &a.req));
            if !sent_p2p && let Some(env) = self.zv4_envelope(&a.peer, &a.req) {
                self.send_room(&a.secret, env);
            }
        }
        for _ in failed {
            self.emit("contact:add_failed", json!({"reason": "timeout"}));
        }
        // уборка
        let mut close = Vec::new();
        {
            let mut st = self.lock();
            let c = &mut st.p2p.c;
            c.seen.retain(|_, t| now.saturating_sub(*t) < SEEN_TTL_MS);
            c.offers
                .retain(|_, o| now.saturating_sub(o.created) < OFFER_TTL_MS);
            c.my_offers
                .retain(|_, o| now.saturating_sub(o.2) < OFFER_TTL_MS);
            // завершённые — через 2 мин; зависшие (окно звонка так и не открылось) — через 12 ч
            c.calls.retain(|_, x| {
                (x.ended.is_none() || now.saturating_sub(x.ended_at) < 120_000)
                    && now.saturating_sub(x.started) < 12 * 3_600_000
            });
            c.out_hubs.retain(|t, o| {
                let keep = now.saturating_sub(o.last_used) < OUT_HUB_IDLE_MS;
                if !keep {
                    close.push((t.clone(), o.hub.clone()));
                }
                keep
            });
        }
        for (_, h) in close {
            h.close();
        }
    }

    pub(crate) fn contact_offers(&self) -> Value {
        let st = self.lock();
        Value::Array(
            st.p2p
                .c
                .offers
                .values()
                .map(|o| serde_json::to_value(o).unwrap_or_default())
                .collect(),
        )
    }

    pub(crate) fn contact_parse(&self, text: &str) -> Value {
        match decode_code(text) {
            Some(c) => {
                json!({"kind": "contact", "name": str_of(&c, "n"), "expires": c.get("x").and_then(|v| v.as_u64()).map(|x| x * 1000)})
            }
            None => json!({"kind": "none"}),
        }
    }
}

async fn out_pump(w: Weak<Inner>, topic: String, mut rx: mpsc::UnboundedReceiver<HubEvent>) {
    while let Some(ev) = rx.recv().await {
        let Some(inner) = w.upgrade() else { return };
        match ev {
            HubEvent::Status(s) => {
                let up = s.mqtt_up + s.nostr_up + s.ntfy_up > 0 || s.worker == "up";
                if up {
                    let mut st = inner.lock();
                    if let Some(o) = st.p2p.c.out_hubs.get_mut(&topic) {
                        o.up = true;
                        for m in o.queue.drain(..) {
                            o.hub.send(m, SendOpts::default());
                        }
                    }
                }
            }
            HubEvent::Message { msg, .. } => inner.on_zv4_room(&topic, &msg),
            _ => {}
        }
    }
}

#[allow(dead_code)]
fn _assert_ok() -> Result<Value, String> {
    ok(1)
}
