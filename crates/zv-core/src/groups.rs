//! Группы (M5): переписка, файлы и звонки до 6 устройств.
//!
//! У группы общий секрет. Из него — комната группы (её слушают все участники, как свой ящик) и
//! почтовый ящик группы (Worker/Nostr/ntfy — для тех, кто не в сети). Любое сообщение группы —
//! `gm = {t: "gm", g: id группы, f: ID автора, d: JSON нагрузки, s: подпись}`, где подпись —
//! Ed25519 ключом устройства автора (тем же, что у iroh) над `"zv4-group\0" ‖ g ‖ "\0" ‖ d`.
//! Принимаем только от участников и только с верной подписью: участник не напишет от чужого
//! имени, а сервер или посторонний без секрета — вообще ничего.
//!
//! Пути: P2P-линки к участникам (кадр `{t: "zvg", gm}`), комната группы (`{type: "zvg", gm}`,
//! запечатана ключом комнаты), почтовый ящик группы — через 8 с, если не все подтвердили.
//!
//! Нагрузка `d = {t, id, n: имя автора, v: версия группы у автора, a?: адреса автора, …}`:
//! `chat` · `chat_edit` · `chat_del` (как в чатах с контактом) · `g_ack {ids}` · `g_typing` ·
//! `g_ring {cid, k, video, ts}` · `g_ring_end {cid}` · `g_left` · `chat_file_cancel {fid}` ·
//! `g_sync {name, admin, members, keys, why?}` — состав от администратора (`keys`: секрет группы,
//! запечатанный ключом пары с каждым участником) · `g_sync_req` — «пришли состав, я отстал».
//!
//! Приглашение — кадр `chat_group {id, g: описание с секретом}` по обычному каналу контакта и
//! только от администратора (новых участников он берёт из своих контактов). Исключение и выход —
//! с новым секретом: ключ получают только оставшиеся, прежний читаем ещё 7 дней.

use crate::chats::{clean_text, frame_of, str_of, ulid, valid_id};
use crate::db::{Msg, OutEntry};
use crate::model::{GROUP_MAX, Group, GroupMember, HistoryEntry, OldKey};
use crate::{Incoming, Inner, RoomRole, s};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use zv_proto::ids::{now_ms, rand_hex};
use zv_signal::mailbox::{Cursor, MAX_PLAIN, MailAddr, Mailbox};

const MAIL_AFTER_MS: u64 = 8_000;
const MAIL_RETRY_MS: u64 = 60_000;
/// Повтор неподтверждённого по живым путям: 30 с, 1 мин, 2 мин … до 30 мин.
const LIVE_FIRST_MS: u64 = 30_000;
const LIVE_MAX_MS: u64 = 30 * 60_000;
const FLUSH_EVERY_MS: u64 = 30_000;
const TYPING_TTL_MS: u64 = 6_000;
const TYPING_EVERY_MS: u64 = 3_000;
const RING_EVERY_MS: u64 = 3_000;
const RING_TIMEOUT_MS: u64 = 45_000;
/// Вызов старше этого (по часам звонящего) не звонит.
const RING_FRESH_MS: u64 = 120_000;
const OLD_KEY_MS: u64 = 7 * 24 * 3_600_000;
/// Сколько в ленте группы держится «Присоединиться» к звонку.
const CALL_JOIN_MS: u64 = 2 * 3_600_000;
const SYNC_REQ_EVERY_MS: u64 = 60_000;
const DEFER_TTL_MS: u64 = 10 * 60_000;
const MAX_PARTS: usize = 16;
const NAME_MAX: usize = 60;
const ACKS_PER_FRAME: usize = 200;

/// Id чата-группы: `g` + 16 hex (у контактов — только hex).
pub(crate) fn is_group(chat: &str) -> bool {
    chat.len() == 17 && chat.starts_with('g') && chat[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn clean_name(s: &str) -> String {
    s.trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(NAME_MAX)
        .collect::<String>()
        .trim()
        .to_string()
}

#[derive(Default)]
pub(crate) struct GroupsState {
    /// Неподтверждённые хранимые: id → кому ещё доставить.
    pub pending: HashMap<String, GPending>,
    pub loaded: bool,
    /// Группа → кто «печатает» → до какого времени.
    pub typing: HashMap<String, HashMap<String, u64>>,
    pub my_typing: HashMap<String, u64>,
    /// Групповые звонки: комната звонка → звонок.
    pub calls: HashMap<String, GroupCall>,
    /// Участник → когда последний раз повторяли ему очередь.
    pub flushed: HashMap<String, u64>,
    pub sync_req: HashMap<String, u64>,
    /// Состав не от того, кого мы считаем администратором (пришёл раньше передачи прав).
    pub deferred: Vec<(String, Value, u64)>,
    /// Подтверждения пачкой (раз в такт): (группа, автор) → id.
    pub acks: HashMap<(String, String), Vec<String>>,
}

#[derive(Debug, Clone)]
pub(crate) struct GPending {
    pub gid: String,
    pub kind: String,
    pub waiting: HashSet<String>,
    pub next_live: u64,
    pub live_n: u32,
    pub mail_after: u64,
    pub mailing: bool,
    pub mailed: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct GroupCall {
    pub cid: String,
    pub gid: String,
    pub out: bool,
    pub secret: String,
    pub video: bool,
    pub started: u64,
    pub last_ring: u64,
    /// Вошли в звонок (ответили, присоединились или звоним сами).
    pub accepted: bool,
}

/// Откуда пришло сообщение группы.
#[derive(Debug, Clone)]
pub(crate) enum GSrc {
    /// Прямая связь с автором (ID устройства).
    Link(String),
    Room(String),
    Mail(String),
}

fn sig_input(gid: &str, d: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(12 + gid.len() + d.len());
    v.extend_from_slice(b"zv4-group\0");
    v.extend_from_slice(gid.as_bytes());
    v.push(0);
    v.extend_from_slice(d.as_bytes());
    v
}

/// Проверить подпись `gm`: (группа, автор, нагрузка).
pub(crate) fn verify_gm(gm: &Value) -> Option<(String, String, Value)> {
    if str_of(gm, "t") != "gm" {
        return None;
    }
    let (g, f, d, sig) = (
        str_of(gm, "g"),
        str_of(gm, "f"),
        str_of(gm, "d"),
        str_of(gm, "s"),
    );
    if !is_group(g) || !zv_p2p::valid_id(f) || d.len() > 200_000 {
        return None;
    }
    let fb: [u8; 32] = hex::decode(f).ok()?.try_into().ok()?;
    let sb: [u8; 64] = hex::decode(sig).ok()?.try_into().ok()?;
    let pk = zv_p2p::iroh::PublicKey::from_bytes(&fb).ok()?;
    pk.verify(&sig_input(g, d), &zv_p2p::iroh::Signature::from_bytes(&sb))
        .ok()?;
    let p: Value = serde_json::from_str(d).ok()?;
    p.is_object().then(|| (g.to_string(), f.to_string(), p))
}

/// Состав из сообщения: проверенные ID, без повторов, не больше `GROUP_MAX`.
fn parse_members(v: Option<&Value>) -> Option<Vec<GroupMember>> {
    let arr = v?.as_array()?;
    if arr.is_empty() || arr.len() > GROUP_MAX {
        return None;
    }
    let mut out: Vec<GroupMember> = Vec::new();
    for m in arr {
        let id = str_of(m, "id");
        if !zv_p2p::valid_id(id) || out.iter().any(|x| x.id == id) {
            return None;
        }
        let hint = m
            .get("hint")
            .filter(|h| h.is_object() && h.to_string().len() < 2000)
            .cloned();
        out.push(GroupMember {
            id: id.to_string(),
            name: clean_name(str_of(m, "name")),
            hint,
        });
    }
    Some(out)
}

/// Секреты, через которые идёт сообщение: состав — ещё и через прежние (их слушают отставшие).
fn secrets_for(g: &Group, kind: &str, now: u64) -> Vec<String> {
    let mut v = vec![g.secret.clone()];
    if kind == "sync" {
        v.extend(
            g.old
                .iter()
                .filter(|o| o.until > now)
                .map(|o| o.secret.clone()),
        );
    }
    v
}

fn topics_of(g: &Group) -> Vec<String> {
    std::iter::once(&g.secret)
        .chain(g.old.iter().map(|o| &o.secret))
        .filter_map(|s| zv_proto::Room::derive(s).ok().map(|r| r.topic))
        .collect()
}

/// Предметы почтового ящика группы: `{s}` или части `{m, i, n, p}` (запечатано ключом комнаты группы).
fn gm_items(room: &zv_proto::Room, fid: &str, gm: &Value) -> Option<Vec<Vec<u8>>> {
    let sealed = room.seal(gm);
    let one = json!({"s": sealed}).to_string().into_bytes();
    if one.len() <= MAX_PLAIN {
        return Some(vec![one]);
    }
    let chunk = MAX_PLAIN - 200;
    let parts: Vec<&str> = sealed
        .as_bytes()
        .chunks(chunk)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect();
    if parts.len() > MAX_PARTS || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let n = parts.len();
    Some(
        parts
            .iter()
            .enumerate()
            .map(|(i, p)| {
                json!({"m": fid, "i": i, "n": n, "p": p})
                    .to_string()
                    .into_bytes()
            })
            .collect(),
    )
}

impl Inner {
    pub(crate) fn group(&self, gid: &str) -> Option<Group> {
        self.lock()
            .contacts
            .groups
            .iter()
            .find(|g| g.id == gid)
            .cloned()
    }

    fn my_id(&self) -> Option<String> {
        self.node().map(|n| n.id().to_string())
    }

    /// Изменить группу и сохранить.
    fn group_update<R>(&self, gid: &str, f: impl FnOnce(&mut Group) -> R) -> Option<R> {
        let mut st = self.lock();
        let g = st.contacts.groups.iter_mut().find(|g| g.id == gid)?;
        let r = f(g);
        if let Err(e) = self.contacts_file.save(&st.contacts) {
            tracing::warn!("contacts.dat: {e}");
        }
        Some(r)
    }

    /// Комнаты групп, которые слушаем (как свой ящик).
    pub(crate) fn group_listen_rooms(&self, st: &crate::State) -> Vec<(String, RoomRole)> {
        if !st.settings.p2p {
            return Vec::new();
        }
        st.contacts
            .groups
            .iter()
            .filter(|g| !g.left)
            .map(|g| (g.secret.clone(), RoomRole::Group))
            .collect()
    }

    /// Участник одной из моих групп (его линки допускаем, его просьбы о файлах группы — тоже).
    pub(crate) fn is_group_peer(&self, peer: &str) -> bool {
        self.lock()
            .contacts
            .groups
            .iter()
            .any(|g| !g.left && g.members.iter().any(|m| m.id == peer))
    }

    /// Известные адреса устройства: из контакта или из группы.
    pub(crate) fn peer_hint(&self, peer: &str) -> Option<Value> {
        let st = self.lock();
        st.contacts
            .items
            .iter()
            .find(|c| c.peer == peer)
            .and_then(|c| c.hint.clone())
            .or_else(|| {
                st.contacts
                    .groups
                    .iter()
                    .flat_map(|g| g.members.iter())
                    .find(|m| m.id == peer)
                    .and_then(|m| m.hint.clone())
            })
    }

    /// Имя участника для показа: как записан у меня в контактах, иначе — как назвался сам.
    pub(crate) fn member_name(&self, g: &Group, id: &str) -> String {
        let st = self.lock();
        if let Some(c) = st.contacts.items.iter().find(|c| c.peer == id) {
            return c.name.clone();
        }
        let cur = st
            .contacts
            .groups
            .iter()
            .find(|x| x.id == g.id)
            .unwrap_or(g);
        cur.members
            .iter()
            .chain(cur.former.iter())
            .chain(g.members.iter())
            .find(|m| m.id == id)
            .map(|m| m.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Участник".into())
    }

    // ---------- отправка ----------

    fn sign_gm(&self, gid: &str, p: &Value) -> Option<Value> {
        let node = self.node()?;
        let d = p.to_string();
        let sk = zv_p2p::iroh::SecretKey::from_bytes(&node.secret_bytes());
        let sig = sk.sign(&sig_input(gid, &d));
        Some(json!({"t": "gm", "g": gid, "f": node.id(), "d": d, "s": hex::encode(sig.to_bytes())}))
    }

    /// Отправить в группу. `store` — с подтверждениями, повторами и почтовым ящиком; иначе — один
    /// раз по живым путям. `to` — только этим участникам. Возвращает (id, gm).
    pub(crate) fn group_post(
        self: &Arc<Self>,
        g: &Group,
        kind: &str,
        mut p: Value,
        store: bool,
        to: Option<&HashSet<String>>,
    ) -> Result<(String, Value), String> {
        let node = self.node().ok_or_else(|| self.p2p_unavailable())?;
        let me = node.id().to_string();
        let id = p
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(ulid);
        p["id"] = json!(id);
        p["n"] = json!(self.my_name());
        p["v"] = json!(g.v);
        if store || kind == "ring" {
            p["a"] = node.addr_json();
        }
        let gm = self
            .sign_gm(&g.id, &p)
            .ok_or("не удалось подписать сообщение")?;
        let all: HashSet<String> = g
            .members
            .iter()
            .map(|m| m.id.clone())
            .filter(|m| *m != me)
            .collect();
        let waiting: HashSet<String> = match to {
            Some(t) => all.intersection(t).cloned().collect(),
            None => all,
        };
        if store {
            if waiting.is_empty() {
                // в группе только я — доставлять некому
                if kind == "chat" {
                    self.db.raise_out(&g.id, std::slice::from_ref(&id), 2);
                }
                return Ok((id, gm));
            }
            let now = now_ms();
            self.db.out_put(&OutEntry {
                fid: id.clone(),
                peer: g.id.clone(),
                kind: kind.into(),
                frame: json!({"gm": gm, "w": waiting}),
                created: now,
                mailed: false,
            });
            self.lock().groups.pending.insert(
                id.clone(),
                GPending {
                    gid: g.id.clone(),
                    kind: kind.into(),
                    waiting: waiting.clone(),
                    next_live: now + LIVE_FIRST_MS,
                    live_n: 0,
                    mail_after: now + MAIL_AFTER_MS,
                    mailing: false,
                    mailed: false,
                },
            );
        }
        self.group_send_live(g, kind, &gm, &waiting, store || kind == "ring");
        Ok((id, gm))
    }

    /// По линкам — тем, к кому есть линк; остальным — через комнату группы (её слышат все).
    fn group_send_live(
        self: &Arc<Self>,
        g: &Group,
        kind: &str,
        gm: &Value,
        to: &HashSet<String>,
        dial: bool,
    ) {
        if to.is_empty() {
            return;
        }
        let node = self.node();
        let frame = json!({"t": "zvg", "gm": gm});
        let rest: Vec<String> = to
            .iter()
            .filter(|m| !node.as_ref().is_some_and(|n| n.send_peer(m, &frame)))
            .cloned()
            .collect();
        if rest.is_empty() {
            return;
        }
        for sec in secrets_for(g, kind, now_ms()) {
            self.send_room(&sec, json!({"type": "zvg", "gm": gm}));
        }
        if dial {
            for m in rest {
                self.ensure_link(&m);
            }
        }
    }

    /// Один раз: живые пути и почтовые ящики (выход из группы — подтверждений уже не дождаться).
    fn group_post_once(self: &Arc<Self>, g: &Group, kind: &str, p: Value) {
        let Ok((id, gm)) = self.group_post(g, kind, p, false, None) else {
            return;
        };
        let me = self.clone();
        let g = g.clone();
        let kind = kind.to_string();
        self.rt.spawn(async move {
            let mb = Mailbox::new(me.signal_config());
            for sec in secrets_for(&g, &kind, now_ms()) {
                let (Some(addr), Ok(room)) = (MailAddr::derive(&sec), zv_proto::Room::derive(&sec))
                else {
                    continue;
                };
                for it in gm_items(&room, &id, &gm).unwrap_or_default() {
                    mb.put(&addr, &it).await;
                }
            }
        });
    }

    /// Состав для `g_sync`: секрет — каждому участнику, запечатан ключом пары.
    fn group_sync_payload(&self, g: &Group, why: Option<(&str, &str)>) -> Value {
        let me = self.my_id().unwrap_or_default();
        let mut keys = serde_json::Map::new();
        for m in g.members.iter().filter(|m| m.id != me) {
            if let Some(r) = self.pair_room(&m.id) {
                keys.insert(
                    m.id.clone(),
                    json!(r.seal(&json!({"g": g.id, "k": g.secret}))),
                );
            }
        }
        let mut p = json!({"t": "g_sync", "name": g.name, "admin": g.admin, "members": g.members, "keys": keys});
        if let Some((id, w)) = why {
            p["why"] = json!({ id: w });
        }
        p
    }

    /// Описание группы для приглашения.
    fn group_def(&self, g: &Group) -> Value {
        json!({"id": g.id, "name": g.name, "secret": g.secret, "admin": g.admin, "members": g.members, "v": g.v, "created": g.created, "at": now_ms()})
    }

    /// Приглашение — по каналу контакта, с подтверждением и почтовым ящиком.
    fn group_invite(self: &Arc<Self>, g: &Group, peer: &str) {
        let fid = ulid();
        self.deliver(
            peer,
            &fid,
            "group",
            json!({"t": "chat_group", "id": fid, "g": self.group_def(g)}),
        );
    }

    /// Запись в ленте группы (кто-то добавлен, вышел, переименовал…).
    fn group_note(&self, gid: &str, actor: &str, text: &str) {
        let now = now_ms();
        let m = Msg {
            id: ulid(),
            chat: gid.to_string(),
            out: false,
            ts: now,
            rx: now,
            lc: self.db.max_lc(gid) + 1,
            kind: "sys".into(),
            body: text.to_string(),
            reply: None,
            file: None,
            st: 3,
            edited: None,
            deleted: false,
            via: String::new(),
            sender: actor.to_string(),
        };
        if self.db.insert_msg(&m) {
            self.emit(
                "chat:msg",
                json!({"msg": self.msg_json(&m), "new": true, "notify": false}),
            );
        }
    }

    /// Звонок в ленте группы: «Присоединиться» в течение 2 ч.
    fn group_call_note(&self, g: &Group, actor: &str, cid: &str, k: &str, video: bool, ts: u64) {
        let now = now_ms();
        let me = self.my_id().unwrap_or_default();
        let m = Msg {
            id: format!("call-{cid}"),
            chat: g.id.clone(),
            out: actor == me,
            ts: ts.min(now),
            rx: now,
            lc: self.db.max_lc(&g.id) + 1,
            kind: "call".into(),
            body: String::new(),
            reply: None,
            file: Some(
                json!({"call": cid, "k": k, "video": video, "until": ts.min(now) + CALL_JOIN_MS}),
            ),
            st: 3,
            edited: None,
            deleted: false,
            via: String::new(),
            sender: actor.to_string(),
        };
        if self.db.msg(&m.id).is_none() && self.db.insert_msg(&m) {
            self.emit(
                "chat:msg",
                json!({"msg": self.msg_json(&m), "new": true, "notify": false}),
            );
        }
    }

    // ---------- приём ----------

    /// Сообщение в комнате группы.
    pub(crate) fn on_group_room(self: &Arc<Self>, topic: &str, msg: &Value) {
        if str_of(msg, "type") != "zvg" {
            return;
        }
        if let Some(gm) = msg.get("gm") {
            self.on_gm(GSrc::Room(topic.to_string()), gm);
        }
    }

    /// Кадр `zvg` по P2P-линку.
    pub(crate) fn on_group_link(self: &Arc<Self>, peer: &str, msg: &Value) {
        if let Some(gm) = msg.get("gm") {
            self.on_gm(GSrc::Link(peer.to_string()), gm);
        }
    }

    /// Принять `gm`. Из почтового ящика возвращает (автор, id) — подтвердим пачкой.
    pub(crate) fn on_gm(self: &Arc<Self>, src: GSrc, gm: &Value) -> Option<(String, String)> {
        let node = self.node()?;
        let (gid, f, p) = verify_gm(gm)?;
        if f == node.id() {
            return None;
        }
        let g = self.group(&gid)?;
        let from_ok = match &src {
            GSrc::Room(topic) => topics_of(&g).iter().any(|t| t == topic),
            GSrc::Link(peer) => *peer == f,
            GSrc::Mail(m) => *m == gid,
        };
        if !from_ok || g.left || !g.members.iter().any(|m| m.id == f) {
            return None;
        }
        let t = str_of(&p, "t").to_string();
        self.group_member_seen(&g, &f, &p, &src);
        let ack = match t.as_str() {
            "chat" => self.g_on_chat(&g, &f, &p, &src),
            "chat_edit" | "chat_del" => self.g_on_edit(&g, &f, &p, &t),
            "g_sync" => self.g_on_sync(&g, &f, &p, gm),
            "g_ack" => {
                self.g_on_ack(&g, &f, &p);
                None
            }
            "g_typing" => {
                if !matches!(src, GSrc::Mail(_)) {
                    self.g_on_typing(&g, &f);
                }
                None
            }
            "g_ring" => {
                self.g_on_ring(&g, &f, &p);
                None
            }
            "g_ring_end" => {
                self.g_on_ring_end(&g, &p);
                None
            }
            "g_left" => {
                self.g_on_left(&g, &f);
                None
            }
            "g_sync_req" => {
                self.g_on_sync_req(&g, &f);
                None
            }
            "chat_file_cancel" => {
                let fid = str_of(&p, "fid");
                if let Some(r) = self.db.file(fid).filter(|r| r.chat == g.id && !r.out)
                    && self.db.msg(&r.msg).is_some_and(|m| m.sender == f)
                {
                    self.file_cancel_inner(&r.fid, true);
                }
                None
            }
            _ => None,
        }?;
        match src {
            GSrc::Mail(_) => Some((f, ack)),
            GSrc::Link(..) => {
                let to: HashSet<String> = [f.clone()].into();
                let _ = self.group_post(
                    &g,
                    "ack",
                    json!({"t": "g_ack", "ids": [ack]}),
                    false,
                    Some(&to),
                );
                None
            }
            GSrc::Room(_) => {
                self.lock()
                    .groups
                    .acks
                    .entry((g.id.clone(), f))
                    .or_default()
                    .push(ack);
                None
            }
        }
    }

    /// Автор на связи: имя и адреса, не отстали ли мы, очередь ему.
    fn group_member_seen(self: &Arc<Self>, g: &Group, f: &str, p: &Value, src: &GSrc) {
        let n = clean_name(str_of(p, "n"));
        let a = p
            .get("a")
            .filter(|a| a.is_object() && a.to_string().len() < 2000)
            .cloned();
        let changed = {
            let st = self.lock();
            st.contacts
                .groups
                .iter()
                .find(|x| x.id == g.id)
                .and_then(|x| x.members.iter().find(|m| m.id == f))
                .is_some_and(|m| (!n.is_empty() && m.name != n) || (a.is_some() && m.hint != a))
        };
        if changed {
            self.group_update(&g.id, |x| {
                if let Some(m) = x.members.iter_mut().find(|m| m.id == f) {
                    if !n.is_empty() {
                        m.name = n.clone();
                    }
                    if a.is_some() {
                        m.hint = a.clone();
                    }
                }
            });
        }
        let v = p.get("v").and_then(|x| x.as_u64()).unwrap_or(0);
        if v > g.v {
            self.group_sync_request(g);
        }
        if !matches!(src, GSrc::Mail(_)) {
            self.group_flush_member(g, f, false);
        }
    }

    /// Мы отстали (у участника версия группы новее): попросить состав у администратора
    /// и поскорее заглянуть в ящик (новый состав лежит и там).
    fn group_sync_request(self: &Arc<Self>, g: &Group) {
        let now = now_ms();
        {
            let mut st = self.lock();
            let last = st.groups.sync_req.get(&g.id).copied().unwrap_or(0);
            if now.saturating_sub(last) < SYNC_REQ_EVERY_MS {
                return;
            }
            st.groups.sync_req.insert(g.id.clone(), now);
            st.chats.next_fetch = st.chats.next_fetch.min(now + 2_000);
        }
        let to: HashSet<String> = [g.admin.clone()].into();
        let _ = self.group_post(g, "sync_req", json!({"t": "g_sync_req"}), false, Some(&to));
        self.ensure_link(&g.admin);
    }

    fn g_on_chat(self: &Arc<Self>, g: &Group, f: &str, p: &Value, src: &GSrc) -> Option<String> {
        let id = str_of(p, "id").to_string();
        if !valid_id(&id) {
            return None;
        }
        let now = now_ms();
        let ts = p.get("ts").and_then(|v| v.as_u64()).unwrap_or(now);
        // написано до того, как меня добавили (лежало в ящике группы), — не показываем
        if g.joined > 0 && ts + 60_000 < g.joined {
            return Some(id);
        }
        let kind = if str_of(p, "k") == "file" {
            "file"
        } else {
            "text"
        };
        let body = clean_text(str_of(p, "b"));
        let file = if kind == "file" {
            self.file_meta(p)
        } else {
            None
        };
        if (kind == "text" && body.is_empty()) || (kind == "file" && file.is_none()) {
            return Some(id);
        }
        let via = match src {
            GSrc::Link(..) => "p2p",
            GSrc::Room(_) => "room",
            GSrc::Mail(_) => "mail",
        };
        let m = Msg {
            id: id.clone(),
            chat: g.id.clone(),
            out: false,
            ts: ts.min(now + 300_000),
            rx: now,
            lc: p
                .get("lc")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                .min(u64::MAX / 4),
            kind: kind.into(),
            body,
            reply: p
                .get("re")
                .and_then(|v| v.as_str())
                .filter(|r| valid_id(r))
                .map(str::to_string),
            file: file.clone(),
            st: 0,
            edited: None,
            deleted: false,
            via: via.into(),
            sender: f.to_string(),
        };
        // такой id уже есть, но чужой (подделка) — игнор
        let clash = self
            .db
            .msg(&id)
            .is_some_and(|x| x.chat != g.id || x.out || x.sender != f);
        if !clash && self.db.insert_msg(&m) {
            if let Some(fl) = &file {
                self.file_offered(&g.id, &m, fl);
            }
            let was = self
                .lock()
                .groups
                .typing
                .get_mut(&g.id)
                .and_then(|t| t.remove(f))
                .is_some();
            if was {
                self.emit_group_typing(&g.id);
            }
            let notify = !self.focused(&g.id);
            let who = self.member_name(g, f);
            self.emit("chat:msg", json!({"msg": self.msg_json(&m), "new": true, "name": g.name, "who": who, "notify": notify}));
            self.emit_unread();
        }
        Some(id)
    }

    fn g_on_edit(self: &Arc<Self>, g: &Group, f: &str, p: &Value, t: &str) -> Option<String> {
        let fid = str_of(p, "id").to_string();
        let mid = str_of(p, "m");
        if let Some(m) = self
            .db
            .msg(mid)
            .filter(|m| m.chat == g.id && !m.out && m.sender == f && m.kind != "sys")
        {
            let changed = if t == "chat_edit" {
                let b = clean_text(str_of(p, "b"));
                m.kind == "text"
                    && !b.is_empty()
                    && self.db.edit(
                        mid,
                        &b,
                        p.get("ts").and_then(|v| v.as_u64()).unwrap_or(now_ms()),
                    )
            } else {
                if let Some(x) = m
                    .file
                    .as_ref()
                    .and_then(|x| x.get("fid"))
                    .and_then(|x| x.as_str())
                {
                    self.file_cancel_inner(x, true);
                }
                self.db.mark_deleted(mid)
            };
            if changed && let Some(m) = self.db.msg(mid) {
                self.emit("chat:msg", json!({"msg": self.msg_json(&m), "new": false}));
                self.emit_unread();
            }
        }
        valid_id(&fid).then_some(fid)
    }

    fn g_on_ack(self: &Arc<Self>, g: &Group, f: &str, p: &Value) {
        let ids: Vec<String> = p
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .filter(|x| valid_id(x))
                    .take(500)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            self.g_acked(&g.id, &id, f);
        }
    }

    /// Участник `who` получил `fid`: все получили — ✓✓, кто-то — ✓.
    fn g_acked(self: &Arc<Self>, gid: &str, fid: &str, who: &str) {
        let (done, kind, waiting) = {
            let mut st = self.lock();
            let Some(e) = st.groups.pending.get_mut(fid) else {
                return;
            };
            if e.gid != gid || !e.waiting.remove(who) {
                return;
            }
            let r = (e.waiting.is_empty(), e.kind.clone(), e.waiting.clone());
            if r.0 {
                st.groups.pending.remove(fid);
            }
            r
        };
        if done {
            self.db.out_del(fid, gid);
        } else if let Some(e) = self.db.out_get(fid, gid) {
            let mut fr = e.frame;
            fr["w"] = json!(waiting);
            self.db.out_set_frame(fid, gid, &fr);
        }
        if kind == "chat" {
            let st = if done { 2 } else { 1 };
            let ch = self.db.raise_out(gid, &[fid.to_string()], st);
            if !ch.is_empty() {
                self.emit("chat:state", json!({"chat": gid, "ids": ch, "st": st}));
            }
        }
    }

    fn g_on_typing(&self, g: &Group, f: &str) {
        let first = {
            let mut st = self.lock();
            st.groups
                .typing
                .entry(g.id.clone())
                .or_default()
                .insert(f.to_string(), now_ms() + TYPING_TTL_MS)
                .is_none()
        };
        if first {
            self.emit_group_typing(&g.id);
        }
    }

    /// Кто в группе «печатает» (имена).
    pub(crate) fn group_typers(&self, gid: &str) -> Vec<String> {
        let now = now_ms();
        let ids: Vec<String> = {
            let st = self.lock();
            st.groups
                .typing
                .get(gid)
                .map(|t| {
                    t.iter()
                        .filter(|(_, u)| **u > now)
                        .map(|(id, _)| id.clone())
                        .collect()
                })
                .unwrap_or_default()
        };
        let Some(g) = self.group(gid) else {
            return Vec::new();
        };
        ids.iter().map(|id| self.member_name(&g, id)).collect()
    }

    fn emit_group_typing(&self, gid: &str) {
        let who = self.group_typers(gid);
        self.emit(
            "chat:typing",
            json!({"chat": gid, "on": !who.is_empty(), "who": who}),
        );
    }

    fn g_on_ring(self: &Arc<Self>, g: &Group, f: &str, p: &Value) {
        let cid = str_of(p, "cid").to_string();
        let k = str_of(p, "k").to_string();
        if cid.is_empty() || cid.len() > 32 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return;
        }
        let Ok(room) = zv_proto::Room::derive(&k) else {
            return;
        };
        let now = now_ms();
        let ts = p.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        if ts + RING_FRESH_MS < now || ts > now + RING_FRESH_MS {
            return;
        }
        let video = p.get("video").and_then(|v| v.as_bool()).unwrap_or(false);
        self.group_call_note(g, f, &cid, &k, video, ts);
        let who = self.member_name(g, f);
        let mut st = self.lock();
        if let Some(inc) = st.incoming.get_mut(&cid) {
            inc.last_seen = now;
            return;
        }
        // уже ответили, отклонили или сами в этом звонке
        if st.groups.calls.contains_key(&room.topic)
            || st.rooms.get(&room.topic).is_some_and(|r| r.joined)
        {
            return;
        }
        st.groups.calls.insert(
            room.topic.clone(),
            GroupCall {
                cid: cid.clone(),
                gid: g.id.clone(),
                out: false,
                secret: k.clone(),
                video,
                started: now,
                last_ring: now,
                accepted: false,
            },
        );
        if st.settings.dnd {
            let e = HistoryEntry {
                id: rand_hex(6),
                dir: "in".into(),
                result: "missed".into(),
                peer: g.name.clone(),
                link_id: None,
                link_name: None,
                started: now,
                duration: 0,
                peer_seen: true,
                contact_id: None,
                peer_id: None,
                video,
                group_id: Some(g.id.clone()),
            };
            self.push_history(&mut st, e);
            drop(st);
            self.emit("history:changed", Value::Null);
            return;
        }
        let busy = st.rooms.values().any(|r| r.joined);
        let inc = Incoming {
            call_id: cid.clone(),
            room_id: room.topic.clone(),
            link_id: String::new(),
            link_name: String::new(),
            from: f.to_string(),
            inst: format!("g:{cid}"),
            name: who,
            started: now,
            last_seen: now,
            app: true,
            busy,
            contact_id: None,
            video,
            secret: Some(k),
            group_id: Some(g.id.clone()),
            group_name: Some(g.name.clone()),
        };
        st.incoming.insert(cid, inc.clone());
        drop(st);
        self.emit(
            "call:incoming",
            serde_json::to_value(&inc).unwrap_or_default(),
        );
    }

    fn g_on_ring_end(self: &Arc<Self>, g: &Group, p: &Value) {
        let cid = str_of(p, "cid").to_string();
        let ringing = self
            .lock()
            .incoming
            .get(&cid)
            .is_some_and(|i| i.group_id.as_deref() == Some(g.id.as_str()));
        if ringing {
            self.end_incoming(&cid, "missed");
        }
        let id = format!("call-{cid}");
        if let Some(m) = self
            .db
            .msg(&id)
            .filter(|m| m.chat == g.id && m.kind == "call")
            && let Some(mut f) = m.file
        {
            f["ended"] = json!(true);
            self.db.set_msg_file(&id, &f);
            if let Some(m) = self.db.msg(&id) {
                self.emit("chat:msg", json!({"msg": self.msg_json(&m), "new": false}));
            }
        }
    }

    fn g_on_left(self: &Arc<Self>, g: &Group, f: &str) {
        let name = self.member_name(g, f);
        let me = self.my_id().unwrap_or_default();
        if g.admin == me {
            let _ =
                self.group_remove_member(&g.id, f, &format!("«{name}» выходит из группы"), "left");
        } else {
            // администратор пришлёт новый состав и ключ; пока — просто убрать
            self.group_update(&g.id, |x| {
                if let Some(i) = x.members.iter().position(|m| m.id == f) {
                    let m = x.members.remove(i);
                    x.former.retain(|o| o.id != m.id);
                    x.former.push(m);
                }
            });
            self.group_forget_member(&g.id, f);
            self.group_note(&g.id, f, &format!("«{name}» выходит из группы"));
            self.emit("group:changed", json!({"chat": g.id}));
        }
    }

    fn g_on_sync(self: &Arc<Self>, g: &Group, f: &str, p: &Value, gm: &Value) -> Option<String> {
        let id = str_of(p, "id").to_string();
        let ack = valid_id(&id).then_some(id);
        let v = p.get("v").and_then(|x| x.as_u64()).unwrap_or(0);
        if v <= g.v {
            return ack;
        }
        if f != g.admin {
            // мог прийти раньше передачи прав — повторим после следующего состава
            let mut st = self.lock();
            st.groups.deferred.retain(|(_, x, _)| x != gm);
            st.groups
                .deferred
                .push((g.id.clone(), gm.clone(), now_ms()));
            return ack;
        }
        self.group_apply_sync(g, f, p);
        let later: Vec<Value> = {
            let mut st = self.lock();
            let (mine, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut st.groups.deferred)
                .into_iter()
                .partition(|(gid, _, _)| *gid == g.id);
            st.groups.deferred = rest;
            mine.into_iter().map(|x| x.1).collect()
        };
        for x in later {
            self.on_gm(GSrc::Mail(g.id.clone()), &x);
        }
        ack
    }

    fn group_apply_sync(self: &Arc<Self>, g: &Group, f: &str, p: &Value) {
        let Some(me) = self.my_id() else { return };
        let Some(members) = parse_members(p.get("members")) else {
            return;
        };
        let admin = str_of(p, "admin").to_string();
        if !members.iter().any(|m| m.id == admin) && members.iter().any(|m| m.id == me) {
            return;
        }
        let v = p.get("v").and_then(|x| x.as_u64()).unwrap_or(0);
        let name = clean_name(str_of(p, "name"));
        let name = if name.is_empty() {
            g.name.clone()
        } else {
            name
        };
        let by = self.member_name(g, f);
        let why = |id: &str| {
            p.get("why")
                .and_then(|w| w.get(id))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string()
        };
        let now = now_ms();
        if !members.iter().any(|m| m.id == me) {
            // меня исключили (если вышел сам — группа уже помечена)
            self.group_update(&g.id, |x| {
                x.left = true;
                x.v = v;
                x.members = members.clone();
                x.admin = admin.clone();
            });
            self.group_drop_pending(&g.id);
            self.sync_listeners();
            let text = if f == me {
                "Вы вышли из группы".to_string()
            } else {
                format!("«{by}» исключает вас из группы")
            };
            self.group_note(&g.id, f, &text);
            self.emit("group:changed", json!({"chat": g.id}));
            return;
        }
        let key = p
            .get("keys")
            .and_then(|k| k.get(&me))
            .and_then(|x| x.as_str())
            .and_then(|sealed| self.pair_room(f)?.open(sealed))
            .filter(|o| str_of(o, "g") == g.id)
            .map(|o| str_of(&o, "k").to_string())
            .filter(|k| zv_proto::Room::derive(k).is_ok() && MailAddr::derive(k).is_some());
        let old: HashSet<&str> = g.members.iter().map(|m| m.id.as_str()).collect();
        let new: HashSet<&str> = members.iter().map(|m| m.id.as_str()).collect();
        let mut notes = Vec::new();
        for m in members
            .iter()
            .filter(|m| !old.contains(m.id.as_str()) && m.id != me)
        {
            let n = self
                .lock()
                .contacts
                .items
                .iter()
                .find(|c| c.peer == m.id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| m.name.clone());
            notes.push((f.to_string(), format!("«{by}» добавляет в группу «{n}»")));
        }
        for m in g.members.iter().filter(|m| !new.contains(m.id.as_str())) {
            let n = self.member_name(g, &m.id);
            if why(&m.id) == "left" {
                notes.push((m.id.clone(), format!("«{n}» выходит из группы")));
            } else {
                notes.push((f.to_string(), format!("«{by}» исключает из группы «{n}»")));
            }
        }
        if name != g.name {
            notes.push((
                f.to_string(),
                format!("«{by}» переименовывает группу в «{name}»"),
            ));
        }
        if admin != g.admin {
            let text = if admin == me {
                "Теперь вы администратор группы".to_string()
            } else {
                let n = members
                    .iter()
                    .find(|m| m.id == admin)
                    .map(|m| m.name.clone())
                    .unwrap_or_default();
                let n = self
                    .lock()
                    .contacts
                    .items
                    .iter()
                    .find(|c| c.peer == admin)
                    .map(|c| c.name.clone())
                    .unwrap_or(n);
                format!("Администратор группы теперь «{n}»")
            };
            notes.push((admin.clone(), text));
        }
        let gone: Vec<String> = g
            .members
            .iter()
            .filter(|m| !new.contains(m.id.as_str()))
            .map(|m| m.id.clone())
            .collect();
        self.group_update(&g.id, |x| {
            if let Some(k) = key
                && k != x.secret
            {
                let prev = std::mem::replace(&mut x.secret, k);
                x.old.push(OldKey {
                    secret: prev,
                    until: now + OLD_KEY_MS,
                });
            }
            for m in x.members.iter().filter(|m| !new.contains(m.id.as_str())) {
                let m = m.clone();
                x.former.retain(|o| o.id != m.id);
                x.former.push(m);
            }
            let prev = std::mem::take(&mut x.members);
            x.members = members
                .iter()
                .map(|m| {
                    let mut m = m.clone();
                    if m.hint.is_none() {
                        m.hint = prev
                            .iter()
                            .find(|o| o.id == m.id)
                            .and_then(|o| o.hint.clone());
                    }
                    m
                })
                .collect();
            x.name = name.clone();
            x.admin = admin.clone();
            x.v = v;
        });
        for id in gone {
            self.group_forget_member(&g.id, &id);
        }
        self.sync_listeners();
        for (actor, text) in notes {
            self.group_note(&g.id, &actor, &text);
        }
        self.emit("group:changed", json!({"chat": g.id}));
    }

    fn g_on_sync_req(self: &Arc<Self>, g: &Group, f: &str) {
        if self.my_id().as_deref() != Some(g.admin.as_str()) {
            return;
        }
        let to: HashSet<String> = [f.to_string()].into();
        let p = self.group_sync_payload(g, None);
        let _ = self.group_post(g, "sync", p, false, Some(&to));
    }

    /// Участника больше нет: не ждать его подтверждений, не слать приглашение.
    fn group_forget_member(self: &Arc<Self>, gid: &str, who: &str) {
        let fids: Vec<String> = {
            let st = self.lock();
            st.groups
                .pending
                .iter()
                .filter(|(_, e)| e.gid == gid && e.waiting.contains(who))
                .map(|(k, _)| k.clone())
                .collect()
        };
        for fid in fids {
            self.g_acked(gid, &fid, who);
        }
        let mut st = self.lock();
        if let Some(t) = st.groups.typing.get_mut(gid) {
            t.remove(who);
        }
    }

    fn group_drop_pending(&self, gid: &str) {
        self.db.out_del_peer(gid);
        let mut st = self.lock();
        st.groups.pending.retain(|_, e| e.gid != gid);
        st.groups.typing.remove(gid);
        st.groups.acks.retain(|(g, _), _| g != gid);
    }

    /// Повторить участнику то, что он ещё не подтвердил (по линку или через комнату).
    pub(crate) fn group_flush_member(self: &Arc<Self>, g: &Group, who: &str, force: bool) {
        let now = now_ms();
        let mut fids: Vec<String> = {
            let mut st = self.lock();
            let last = st.groups.flushed.get(who).copied().unwrap_or(0);
            if !force && now.saturating_sub(last) < FLUSH_EVERY_MS {
                return;
            }
            let v: Vec<String> = st
                .groups
                .pending
                .iter()
                .filter(|(_, e)| e.gid == g.id && e.waiting.contains(who))
                .map(|(k, _)| k.clone())
                .collect();
            if v.is_empty() {
                return;
            }
            st.groups.flushed.insert(who.to_string(), now);
            v
        };
        fids.sort();
        let to: HashSet<String> = [who.to_string()].into();
        for fid in fids {
            if let Some(e) = self.db.out_get(&fid, &g.id) {
                self.group_send_live(g, &e.kind, &e.frame["gm"], &to, false);
            }
        }
    }

    /// Появился линк к участнику: повторить ему очередь всех общих групп.
    pub(crate) fn groups_link_up(self: &Arc<Self>, peer: &str) {
        let groups: Vec<Group> = self
            .lock()
            .contacts
            .groups
            .iter()
            .filter(|g| !g.left && g.members.iter().any(|m| m.id == peer))
            .cloned()
            .collect();
        for g in &groups {
            self.group_flush_member(g, peer, true);
        }
    }

    // ---------- такт ----------

    pub(crate) fn groups_tick(self: &Arc<Self>, now: u64) {
        if self.node().is_none() {
            return;
        }
        let first = {
            let mut st = self.lock();
            !std::mem::replace(&mut st.groups.loaded, true)
        };
        if first {
            let rows: Vec<OutEntry> = self
                .db
                .out_all()
                .into_iter()
                .filter(|e| is_group(&e.peer))
                .collect();
            let mut st = self.lock();
            for e in rows {
                let waiting: HashSet<String> = e.frame["w"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                st.groups.pending.insert(
                    e.fid,
                    GPending {
                        gid: e.peer,
                        kind: e.kind,
                        waiting,
                        next_live: now + 5_000,
                        live_n: 0,
                        mail_after: now + MAIL_AFTER_MS,
                        mailing: false,
                        mailed: e.mailed,
                    },
                );
            }
        }
        // в почтовый ящик группы — то, что за 8 с подтвердили не все
        let to_mail: Vec<String> = {
            let mut st = self.lock();
            let mut v = Vec::new();
            for (fid, e) in st.groups.pending.iter_mut() {
                if !e.mailed && !e.mailing && now >= e.mail_after && !e.waiting.is_empty() {
                    e.mailing = true;
                    v.push(fid.clone());
                }
            }
            v
        };
        if !to_mail.is_empty() {
            let me = self.clone();
            self.rt.spawn(async move {
                for fid in to_mail {
                    me.group_mail_put(&fid).await;
                }
            });
        }
        // повтор по живым путям с нарастающей паузой
        let due: Vec<(String, String, String, HashSet<String>)> = {
            let mut st = self.lock();
            let mut v = Vec::new();
            for (fid, e) in st.groups.pending.iter_mut() {
                if now >= e.next_live && !e.waiting.is_empty() {
                    e.next_live = now + (LIVE_FIRST_MS << e.live_n.min(8)).min(LIVE_MAX_MS);
                    e.live_n += 1;
                    v.push((
                        fid.clone(),
                        e.gid.clone(),
                        e.kind.clone(),
                        e.waiting.clone(),
                    ));
                }
            }
            v
        };
        for (fid, gid, kind, waiting) in due {
            if let (Some(g), Some(e)) = (self.group(&gid), self.db.out_get(&fid, &gid)) {
                self.group_send_live(&g, &kind, &e.frame["gm"], &waiting, true);
            }
        }
        // подтверждения пачкой
        let acks = std::mem::take(&mut self.lock().groups.acks);
        for ((gid, f), ids) in acks {
            if let Some(g) = self.group(&gid) {
                let to: HashSet<String> = [f].into();
                for part in ids.chunks(ACKS_PER_FRAME) {
                    let _ = self.group_post(
                        &g,
                        "ack",
                        json!({"t": "g_ack", "ids": part}),
                        false,
                        Some(&to),
                    );
                }
            }
        }
        // «печатает» истекло
        let expired: Vec<String> = {
            let mut st = self.lock();
            let mut v = Vec::new();
            for (gid, t) in st.groups.typing.iter_mut() {
                let n = t.len();
                t.retain(|_, u| *u > now);
                if t.len() != n {
                    v.push(gid.clone());
                }
            }
            st.groups.typing.retain(|_, t| !t.is_empty());
            v
        };
        for gid in expired {
            self.emit_group_typing(&gid);
        }
        // свой групповой вызов: повтор каждые 3 с первые 45 с
        let rings: Vec<String> = {
            let st = self.lock();
            st.groups
                .calls
                .iter()
                .filter(|(_, c)| {
                    c.out
                        && now.saturating_sub(c.started) < RING_TIMEOUT_MS
                        && now.saturating_sub(c.last_ring) >= RING_EVERY_MS
                })
                .map(|(t, _)| t.clone())
                .collect()
        };
        for t in rings {
            self.group_ring(&t);
        }
        // уборка
        let expired_keys = {
            let mut st = self.lock();
            st.groups
                .deferred
                .retain(|(_, _, t)| now.saturating_sub(*t) < DEFER_TTL_MS);
            st.groups
                .flushed
                .retain(|_, t| now.saturating_sub(*t) < 10 * 60_000);
            let joined: HashSet<String> = st
                .rooms
                .iter()
                .filter(|(_, r)| r.joined)
                .map(|(t, _)| t.clone())
                .collect();
            // чужие вызовы, в которые не вошли, — через 10 мин; свои и свои входы — по выходу из комнаты
            st.groups.calls.retain(|t, c| {
                joined.contains(t)
                    || now.saturating_sub(c.started)
                        < if c.accepted { 12 * 3_600_000 } else { 600_000 }
            });
            st.contacts
                .groups
                .iter()
                .any(|g| g.old.iter().any(|o| o.until <= now))
        };
        if expired_keys {
            let ids: Vec<String> = self
                .lock()
                .contacts
                .groups
                .iter()
                .map(|g| g.id.clone())
                .collect();
            for id in ids {
                self.group_update(&id, |g| g.old.retain(|o| o.until > now));
            }
        }
    }

    async fn group_mail_put(self: &Arc<Self>, fid: &str) {
        let Some((gid, kind)) = self
            .lock()
            .groups
            .pending
            .get(fid)
            .map(|e| (e.gid.clone(), e.kind.clone()))
        else {
            return;
        };
        let entry = self.db.out_get(fid, &gid);
        let g = self.group(&gid);
        let (Some(entry), Some(g)) = (entry, g) else {
            let mut st = self.lock();
            if let Some(p) = st.groups.pending.get_mut(fid) {
                p.mailing = false;
                p.mail_after = now_ms() + MAIL_RETRY_MS * 10;
            }
            return;
        };
        let gm = entry.frame["gm"].clone();
        let mb = Mailbox::new(self.signal_config());
        let mut all = true;
        for sec in secrets_for(&g, &kind, now_ms()) {
            let (Some(addr), Ok(room)) = (MailAddr::derive(&sec), zv_proto::Room::derive(&sec))
            else {
                continue;
            };
            let Some(items) = gm_items(&room, fid, &gm) else {
                all = false;
                continue;
            };
            for it in items {
                all &= mb.put(&addr, &it).await.any();
            }
        }
        let still = {
            let mut st = self.lock();
            match st.groups.pending.get_mut(fid) {
                Some(p) => {
                    p.mailing = false;
                    if all {
                        p.mailed = true;
                    } else {
                        p.mail_after = now_ms() + MAIL_RETRY_MS;
                    }
                    true
                }
                None => false,
            }
        };
        if all && still {
            self.db.out_mailed(fid, &gid);
            if kind == "chat" {
                let ch = self.db.raise_out(&gid, &[fid.to_string()], 1);
                if !ch.is_empty() {
                    self.emit("chat:state", json!({"chat": gid, "ids": ch, "st": 1}));
                }
            }
        }
    }

    /// Есть ли группы, чьи ящики надо забирать.
    pub(crate) fn groups_to_fetch(&self) -> bool {
        self.lock().contacts.groups.iter().any(|g| !g.left)
    }

    /// Забрать почтовые ящики групп (и прежних ключей, пока они читаются).
    pub(crate) async fn groups_mail_fetch(self: &Arc<Self>, dev: &str) -> Value {
        let now = now_ms();
        let jobs: Vec<(String, String)> = {
            let st = self.lock();
            st.contacts
                .groups
                .iter()
                .filter(|g| !g.left)
                .flat_map(|g| {
                    std::iter::once(g.secret.clone())
                        .chain(
                            g.old
                                .iter()
                                .filter(|o| o.until > now)
                                .map(|o| o.secret.clone()),
                        )
                        .map(move |s| (g.id.clone(), s))
                })
                .collect()
        };
        if jobs.is_empty() {
            return Value::Null;
        }
        let mb = Mailbox::new(self.signal_config());
        let mut acks: HashMap<(String, String), Vec<String>> = HashMap::new();
        let (mut items, mut frames, mut ok, mut errors) = (0usize, 0usize, false, Vec::new());
        for (gid, secret) in jobs {
            let (Some(addr), Ok(room)) =
                (MailAddr::derive(&secret), zv_proto::Room::derive(&secret))
            else {
                continue;
            };
            let key = format!("gmail:{}", &addr.chat_id[..16]);
            let mut cur: Cursor = self
                .db
                .kv(&key)
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let rep = mb.fetch(&addr, &mut cur, dev).await;
            ok |= rep.worker_ok || rep.nostr_ok > 0 || rep.ntfy_ok;
            items += rep.items.len();
            for it in &rep.items {
                if let Some(gm) = self.open_group_item(&room, &it.data) {
                    frames += 1;
                    if let Some((f, id)) = self.on_gm(GSrc::Mail(gid.clone()), &gm) {
                        acks.entry((gid.clone(), f)).or_default().push(id);
                    }
                }
            }
            self.db
                .kv_set(&key, &serde_json::to_string(&cur).unwrap_or_default());
            let seqs: Vec<u64> = rep.items.iter().filter_map(|i| i.seq).collect();
            if !seqs.is_empty() {
                mb.ack(&addr, &seqs, dev).await;
            }
            errors.extend(rep.errors);
        }
        for ((gid, f), ids) in acks {
            if let Some(g) = self.group(&gid) {
                let to: HashSet<String> = [f.clone()].into();
                for part in ids.chunks(ACKS_PER_FRAME) {
                    let _ = self.group_post(
                        &g,
                        "ack",
                        json!({"t": "g_ack", "ids": part}),
                        false,
                        Some(&to),
                    );
                }
                // без прямой связи подтверждение могло не дойти — поднимем линк: автор повторит по нему
                if self.node().is_some_and(|n| n.link_for(&f).is_none()) {
                    self.ensure_link(&f);
                }
            }
        }
        json!({"ok": ok, "items": items, "frames": frames, "errors": errors})
    }

    fn open_group_item(&self, room: &zv_proto::Room, data: &[u8]) -> Option<Value> {
        let v: Value = serde_json::from_slice(data).ok()?;
        let sealed = if let Some(n) = v.get("n").and_then(|x| x.as_u64()) {
            let (n, i, m) = (
                n as usize,
                v.get("i")?.as_u64()? as usize,
                str_of(&v, "m").to_string(),
            );
            if n == 0 || n > MAX_PARTS || i >= n || !valid_id(&m) {
                return None;
            }
            let key = format!("g{}|{m}", room.topic);
            let mut st = self.lock();
            let e = st
                .chats
                .parts
                .entry(key.clone())
                .or_insert_with(|| (n, HashMap::new(), now_ms()));
            e.1.insert(i, str_of(&v, "p").to_string());
            if e.1.len() < e.0 {
                return None;
            }
            let (n, parts, _) = st.chats.parts.remove(&key)?;
            (0..n)
                .map(|i| parts.get(&i).cloned())
                .collect::<Option<Vec<_>>>()?
                .concat()
        } else {
            str_of(&v, "s").to_string()
        };
        room.open(&sealed)
    }

    // ---------- приглашение ----------

    /// Приглашение в группу от контакта (кадр `chat_group`). Возвращает id для подтверждения.
    pub(crate) fn on_group_invite(
        self: &Arc<Self>,
        c: &crate::model::Contact,
        frame: &Value,
    ) -> Option<String> {
        let fid = str_of(frame, "id").to_string();
        let ack = valid_id(&fid).then_some(fid);
        let me = self.my_id()?;
        let Some(d) = frame.get("g") else { return ack };
        let gid = str_of(d, "id").to_string();
        let secret = str_of(d, "secret").to_string();
        let Some(members) = parse_members(d.get("members")) else {
            return ack;
        };
        // приглашает только администратор, и я в составе
        if !is_group(&gid)
            || str_of(d, "admin") != c.peer
            || !members.iter().any(|m| m.id == me)
            || !members.iter().any(|m| m.id == c.peer)
            || zv_proto::Room::derive(&secret).is_err()
            || MailAddr::derive(&secret).is_none()
        {
            return ack;
        }
        let now = now_ms();
        let v = d.get("v").and_then(|x| x.as_u64()).unwrap_or(1);
        let at = d.get("at").and_then(|x| x.as_u64()).unwrap_or(now).min(now);
        let name = clean_name(str_of(d, "name"));
        let name = if name.is_empty() {
            "Группа".to_string()
        } else {
            name
        };
        let existing = self.group(&gid);
        if existing.as_ref().is_some_and(|x| !x.left && x.v >= v) {
            return ack; // повтор
        }
        let fresh = existing.as_ref().is_none_or(|x| x.left);
        let g = Group {
            id: gid.clone(),
            name: name.clone(),
            secret,
            old: existing.as_ref().map(|x| x.old.clone()).unwrap_or_default(),
            admin: c.peer.clone(),
            members,
            v,
            created: d
                .get("created")
                .and_then(|x| x.as_u64())
                .unwrap_or(now)
                .min(now),
            joined: if fresh {
                at
            } else {
                existing.as_ref().map(|x| x.joined).unwrap_or(at)
            },
            left: false,
            former: existing
                .as_ref()
                .map(|x| x.former.clone())
                .unwrap_or_default(),
        };
        {
            let mut st = self.lock();
            st.contacts.groups.retain(|x| x.id != gid);
            st.contacts.groups.push(g);
            if let Err(e) = self.contacts_file.save(&st.contacts) {
                tracing::warn!("contacts.dat: {e}");
            }
        }
        self.sync_listeners();
        if fresh {
            self.group_note(
                &gid,
                &c.peer,
                &format!("«{}» добавляет вас в группу «{name}»", c.name),
            );
            self.emit(
                "group:joined",
                json!({"chat": gid, "name": name, "by": c.name}),
            );
        }
        self.emit("group:changed", json!({"chat": gid}));
        // заглянуть в ящик группы — там может ждать переписка с момента приглашения
        {
            let mut st = self.lock();
            st.chats.next_fetch = st.chats.next_fetch.min(now + 3_000);
        }
        ack
    }

    // ---------- команды ----------

    fn group_of(&self, args: &Value) -> Result<Group, String> {
        self.group(s(args, "chat")?)
            .ok_or_else(|| "нет такой группы".to_string())
    }

    /// Группа, в которую я могу писать (участник).
    pub(crate) fn group_writable(&self, gid: &str) -> Result<Group, String> {
        let g = self.group(gid).ok_or("нет такой группы")?;
        if g.left {
            return Err("Вы больше не участник этой группы".into());
        }
        if self.node().is_none() {
            return Err(self.p2p_unavailable());
        }
        Ok(g)
    }

    /// Может ли устройство `peer` получить файл чата `chat` (контакт этого чата или участник группы).
    pub(crate) fn file_peer_ok(&self, peer: &str, chat: &str) -> bool {
        let st = self.lock();
        if is_group(chat) {
            st.contacts
                .groups
                .iter()
                .any(|g| g.id == chat && !g.left && g.members.iter().any(|m| m.id == peer))
        } else {
            st.contacts
                .items
                .iter()
                .any(|c| c.id == chat && c.peer == peer)
        }
    }

    fn group_admin_of(&self, args: &Value) -> Result<Group, String> {
        let g = self.group_of(args)?;
        if g.left {
            return Err("Вы больше не участник этой группы".into());
        }
        if self.my_id().as_deref() != Some(g.admin.as_str()) {
            return Err("Это может только администратор группы".into());
        }
        Ok(g)
    }

    fn contacts_by_ids(&self, v: Option<&Value>) -> Result<Vec<crate::model::Contact>, String> {
        let ids: Vec<String> = v
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let st = self.lock();
        let mut out: Vec<crate::model::Contact> = Vec::new();
        for id in ids {
            let c = st
                .contacts
                .items
                .iter()
                .find(|c| c.id == id)
                .cloned()
                .ok_or("нет такого контакта")?;
            if !out.iter().any(|x| x.peer == c.peer) {
                out.push(c);
            }
        }
        Ok(out)
    }

    fn member_of(c: &crate::model::Contact) -> GroupMember {
        GroupMember {
            id: c.peer.clone(),
            name: if c.their_name.is_empty() {
                c.name.clone()
            } else {
                c.their_name.clone()
            },
            hint: c.hint.clone(),
        }
    }

    pub(crate) fn group_create(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let node = self.node().ok_or_else(|| self.p2p_unavailable())?;
        let name = clean_name(args.get("name").and_then(|v| v.as_str()).unwrap_or(""));
        if name.is_empty() {
            return Err("Введите название группы".into());
        }
        let contacts = self.contacts_by_ids(args.get("members"))?;
        if contacts.is_empty() {
            return Err("Выберите хотя бы одного участника".into());
        }
        if contacts.len() + 1 > GROUP_MAX {
            return Err(format!(
                "В группе может быть до {GROUP_MAX} участников, считая вас"
            ));
        }
        let me = node.id().to_string();
        let now = now_ms();
        let mut members = vec![GroupMember {
            id: me.clone(),
            name: self.my_name(),
            hint: None,
        }];
        members.extend(
            contacts
                .iter()
                .filter(|c| c.peer != me)
                .map(Self::member_of),
        );
        let g = Group {
            id: format!("g{}", rand_hex(8)),
            name: name.clone(),
            secret: zv_proto::link::new_secret(),
            old: Vec::new(),
            admin: me.clone(),
            members,
            v: 1,
            created: now,
            joined: now,
            left: false,
            former: Vec::new(),
        };
        {
            let mut st = self.lock();
            st.contacts.groups.push(g.clone());
            if let Err(e) = self.contacts_file.save(&st.contacts) {
                tracing::warn!("contacts.dat: {e}");
            }
        }
        self.sync_listeners();
        self.group_note(&g.id, &me, &format!("Вы создали группу «{name}»"));
        for c in &contacts {
            self.group_invite(&g, &c.peer);
        }
        self.emit("group:changed", json!({"chat": g.id}));
        Ok(json!({"chat": g.id, "name": g.name}))
    }

    pub(crate) fn group_info(&self, args: &Value) -> Result<Value, String> {
        let g = self.group_of(args)?;
        let me = self.my_id().unwrap_or_default();
        let node = self.node();
        let st = self.lock();
        let mut members: Vec<Value> = g
            .members
            .iter()
            .map(|m| {
                let c = st.contacts.items.iter().find(|c| c.peer == m.id);
                let online = m.id == me
                    || c.and_then(|c| st.p2p.c.presence.get(&c.id)).is_some_and(|p| p.online)
                    || node.as_ref().is_some_and(|n| n.link_for(&m.id).is_some());
                json!({
                    "id": m.id,
                    "name": c.map(|c| c.name.clone()).unwrap_or_else(|| if m.name.is_empty() { "Участник".into() } else { m.name.clone() }),
                    "selfName": m.name,
                    "me": m.id == me,
                    "admin": m.id == g.admin,
                    "contactId": c.map(|c| c.id.clone()),
                    "online": online,
                })
            })
            .collect();
        members.sort_by_key(|m| {
            (
                !m["me"].as_bool().unwrap_or(false),
                !m["admin"].as_bool().unwrap_or(false),
            )
        });
        Ok(json!({
            "chat": g.id,
            "name": g.name,
            "admin": g.admin == me,
            "left": g.left,
            "v": g.v,
            "created": g.created,
            "members": members,
            "max": GROUP_MAX,
        }))
    }

    /// Разослать новый состав (хранимо: с подтверждениями и почтовым ящиком).
    fn group_publish(
        self: &Arc<Self>,
        g: &Group,
        why: Option<(&str, &str)>,
    ) -> Result<Value, String> {
        let p = self.group_sync_payload(g, why);
        let (_, gm) = self.group_post(g, "sync", p, true, None)?;
        Ok(gm)
    }

    pub(crate) fn group_rename(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let g = self.group_admin_of(args)?;
        let name = clean_name(args.get("name").and_then(|v| v.as_str()).unwrap_or(""));
        if name.is_empty() {
            return Err("Введите название группы".into());
        }
        if name == g.name {
            return Ok(Value::Null);
        }
        let g = self
            .group_update(&g.id, |x| {
                x.name = name.clone();
                x.v += 1;
                x.clone()
            })
            .ok_or("нет такой группы")?;
        let me = self.my_id().unwrap_or_default();
        self.group_note(&g.id, &me, &format!("Вы переименовали группу в «{name}»"));
        self.group_publish(&g, None)?;
        self.emit("group:changed", json!({"chat": g.id}));
        Ok(Value::Null)
    }

    pub(crate) fn group_add(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let g = self.group_admin_of(args)?;
        let add: Vec<crate::model::Contact> = self
            .contacts_by_ids(args.get("members"))?
            .into_iter()
            .filter(|c| !g.members.iter().any(|m| m.id == c.peer))
            .collect();
        if add.is_empty() {
            return Err("Выберите, кого добавить".into());
        }
        if g.members.len() + add.len() > GROUP_MAX {
            return Err(format!(
                "В группе может быть до {GROUP_MAX} участников, считая вас"
            ));
        }
        let g = self
            .group_update(&g.id, |x| {
                x.members.extend(add.iter().map(Self::member_of));
                x.former.retain(|o| !add.iter().any(|c| c.peer == o.id));
                x.v += 1;
                x.clone()
            })
            .ok_or("нет такой группы")?;
        let me = self.my_id().unwrap_or_default();
        for c in &add {
            self.group_note(&g.id, &me, &format!("Вы добавили в группу «{}»", c.name));
        }
        self.group_publish(&g, None)?;
        for c in &add {
            self.group_invite(&g, &c.peer);
        }
        self.emit("group:changed", json!({"chat": g.id}));
        Ok(Value::Null)
    }

    pub(crate) fn group_remove(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let g = self.group_admin_of(args)?;
        let who = s(args, "member")?.to_string();
        if Some(who.as_str()) == self.my_id().as_deref() {
            return Err("Чтобы выйти из группы, выберите «Покинуть группу»".into());
        }
        let name = self.member_name(&g, &who);
        self.group_remove_member(
            &g.id,
            &who,
            &format!("Вы исключили из группы «{name}»"),
            "removed",
        )?;
        Ok(Value::Null)
    }

    /// Администратор убирает участника: новый ключ (только оставшимся) и новый состав.
    fn group_remove_member(
        self: &Arc<Self>,
        gid: &str,
        who: &str,
        note: &str,
        why: &str,
    ) -> Result<(), String> {
        let now = now_ms();
        let g = self
            .group_update(gid, |x| {
                let i = x.members.iter().position(|m| m.id == who)?;
                let m = x.members.remove(i);
                x.former.retain(|o| o.id != m.id);
                x.former.push(m);
                let prev = std::mem::replace(&mut x.secret, zv_proto::link::new_secret());
                x.old.push(OldKey {
                    secret: prev,
                    until: now + OLD_KEY_MS,
                });
                x.v += 1;
                Some(x.clone())
            })
            .flatten()
            .ok_or("нет такого участника")?;
        // недоставленное приглашение ему — уже не нужно
        self.db.out_del_kind(who, "group");
        self.lock()
            .chats
            .pending
            .retain(|(_, p), e| !(p == who && e.kind == "group"));
        self.group_forget_member(gid, who);
        self.sync_listeners();
        let me = self.my_id().unwrap_or_default();
        self.group_note(gid, if why == "left" { who } else { &me }, note);
        let gm = self.group_publish(&g, Some((who, why)))?;
        // ему самому — тоже: узнает, что он больше не в группе
        let to: HashSet<String> = [who.to_string()].into();
        self.group_send_live(&g, "sync", &gm, &to, false);
        self.emit("group:changed", json!({"chat": gid}));
        Ok(())
    }

    pub(crate) fn group_leave(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let g = self.group_of(args)?;
        if g.left {
            return Ok(Value::Null);
        }
        let me = self.my_id().ok_or_else(|| self.p2p_unavailable())?;
        self.group_leave_inner(&g, &me);
        Ok(Value::Null)
    }

    fn group_leave_inner(self: &Arc<Self>, g: &Group, me: &str) {
        let now = now_ms();
        if g.admin == me {
            if let Some(next) = g.members.iter().find(|m| m.id != me).map(|m| m.id.clone()) {
                // передать группу первому участнику и сменить ключ — оставшимся
                let g2 = self.group_update(&g.id, |x| {
                    x.members.retain(|m| m.id != me);
                    x.admin = next.clone();
                    let prev = std::mem::replace(&mut x.secret, zv_proto::link::new_secret());
                    x.old.push(OldKey {
                        secret: prev,
                        until: now + OLD_KEY_MS,
                    });
                    x.v += 1;
                    x.clone()
                });
                if let Some(g2) = g2 {
                    let p = self.group_sync_payload(&g2, Some((me, "left")));
                    self.group_post_once(&g2, "sync", p);
                }
            }
        } else {
            self.group_post_once(g, "left", json!({"t": "g_left"}));
        }
        self.group_update(&g.id, |x| x.left = true);
        self.group_drop_pending(&g.id);
        self.sync_listeners();
        self.group_note(&g.id, me, "Вы вышли из группы");
        self.emit("group:changed", json!({"chat": g.id}));
    }

    /// Удалить группу у себя (выйдя из неё, если ещё участник) вместе с перепиской.
    pub(crate) fn group_delete(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let g = self.group_of(args)?;
        if !g.left {
            let me = self.my_id().ok_or_else(|| self.p2p_unavailable())?;
            self.group_leave_inner(&g, &me);
        }
        for f in self.db.files_of_chat(&g.id) {
            self.file_cancel_inner(&f.fid, true);
        }
        self.db.clear_chat(&g.id);
        self.group_drop_pending(&g.id);
        {
            let mut st = self.lock();
            st.contacts.groups.retain(|x| x.id != g.id);
            if let Err(e) = self.contacts_file.save(&st.contacts) {
                tracing::warn!("contacts.dat: {e}");
            }
        }
        self.sync_listeners();
        self.emit("chat:cleared", json!({"chat": g.id}));
        self.emit("group:changed", json!({"chat": g.id, "deleted": true}));
        self.emit_unread();
        Ok(Value::Null)
    }

    // ---------- звонки ----------

    pub(crate) fn group_call(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let me = self.my_id().ok_or_else(|| self.p2p_unavailable())?;
        let g = self.group_of(args)?;
        if g.left {
            return Err("Вы больше не участник этой группы".into());
        }
        if g.members.len() < 2 {
            return Err("В группе пока только вы".into());
        }
        if self.lock().rooms.values().any(|r| r.joined) {
            return Err("Сначала завершите текущий звонок".into());
        }
        let video = args.get("video").and_then(|v| v.as_bool()).unwrap_or(false);
        let secret = zv_proto::link::new_secret();
        let topic = zv_proto::Room::derive(&secret)
            .map_err(|e| e.to_string())?
            .topic;
        let cid = rand_hex(8);
        let now = now_ms();
        self.lock().groups.calls.insert(
            topic.clone(),
            GroupCall {
                cid: cid.clone(),
                gid: g.id.clone(),
                out: true,
                secret: secret.clone(),
                video,
                started: now,
                last_ring: 0,
                accepted: true,
            },
        );
        self.group_call_note(&g, &me, &cid, &secret, video, now);
        self.group_ring(&topic);
        Ok(
            json!({"secret": secret, "roomId": topic, "callId": cid, "name": g.name, "video": video, "groupId": g.id}),
        )
    }

    fn group_ring(self: &Arc<Self>, topic: &str) {
        let call = {
            let mut st = self.lock();
            let Some(c) = st.groups.calls.get_mut(topic) else {
                return;
            };
            c.last_ring = now_ms();
            c.clone()
        };
        if let Some(g) = self.group(&call.gid).filter(|g| !g.left) {
            let p = json!({"t": "g_ring", "cid": call.cid, "k": call.secret, "video": call.video, "ts": call.started});
            let _ = self.group_post(&g, "ring", p, false, None);
        }
    }

    /// Присоединиться к звонку из ленты группы.
    pub(crate) fn group_call_join(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let g = self.group_of(args)?;
        if g.left {
            return Err("Вы больше не участник этой группы".into());
        }
        let m = self
            .db
            .msg(s(args, "id")?)
            .filter(|m| m.chat == g.id && m.kind == "call")
            .ok_or("звонок не найден")?;
        let f = m.file.unwrap_or(Value::Null);
        let k = str_of(&f, "k").to_string();
        let until = f.get("until").and_then(|v| v.as_u64()).unwrap_or(0);
        if until < now_ms() || f.get("ended").and_then(|v| v.as_bool()) == Some(true) {
            return Err("Звонок уже закончился".into());
        }
        let topic = zv_proto::Room::derive(&k)
            .map_err(|_| "звонок не найден")?
            .topic;
        let cid = str_of(&f, "call").to_string();
        let video = f.get("video").and_then(|v| v.as_bool()).unwrap_or(false);
        {
            let mut st = self.lock();
            if st.rooms.iter().any(|(t, r)| r.joined && *t != topic) {
                return Err("Сначала завершите текущий звонок".into());
            }
            let now = now_ms();
            let e = st
                .groups
                .calls
                .entry(topic.clone())
                .or_insert_with(|| GroupCall {
                    cid: cid.clone(),
                    gid: g.id.clone(),
                    out: false,
                    secret: k.clone(),
                    video,
                    started: now,
                    last_ring: 0,
                    accepted: true,
                });
            e.accepted = true;
        }
        // если ещё звонит — уже не нужно
        let ringing = self.lock().incoming.remove(&cid).is_some();
        if ringing {
            self.emit("call:ended", json!({"callId": cid, "reason": "answered"}));
        }
        Ok(json!({"secret": k, "roomId": topic, "name": g.name, "video": video, "groupId": g.id}))
    }

    /// Вышли из комнаты группового звонка: свой вызов, на который никто не пришёл, — отменить.
    pub(crate) fn group_call_left(self: &Arc<Self>, topic: &str, peer_seen: bool) {
        let Some(call) = self.lock().groups.calls.remove(topic) else {
            return;
        };
        if call.out
            && !peer_seen
            && let Some(g) = self.group(&call.gid).filter(|g| !g.left)
        {
            let _ = self.group_post(
                &g,
                "ring_end",
                json!({"t": "g_ring_end", "cid": call.cid}),
                false,
                None,
            );
            let id = format!("call-{}", call.cid);
            if let Some(m) = self.db.msg(&id)
                && let Some(mut f) = m.file
            {
                f["ended"] = json!(true);
                self.db.set_msg_file(&id, &f);
                if let Some(m) = self.db.msg(&id) {
                    self.emit("chat:msg", json!({"msg": self.msg_json(&m), "new": false}));
                }
            }
        }
    }

    // ---------- чаты групп ----------

    /// «Печатает…» в группе — только по линкам (без серверов).
    pub(crate) fn group_typing(self: &Arc<Self>, g: &Group) {
        let now = now_ms();
        {
            let mut st = self.lock();
            let last = st.groups.my_typing.get(&g.id).copied().unwrap_or(0);
            if now.saturating_sub(last) < TYPING_EVERY_MS {
                return;
            }
            st.groups.my_typing.insert(g.id.clone(), now);
        }
        let Some(node) = self.node() else { return };
        let linked: HashSet<String> = g
            .members
            .iter()
            .filter(|m| m.id != node.id() && node.link_for(&m.id).is_some())
            .map(|m| m.id.clone())
            .collect();
        if !linked.is_empty() {
            let _ = self.group_post(g, "typing", json!({"t": "g_typing"}), false, Some(&linked));
        }
    }

    /// Отправить своё сообщение в группу.
    pub(crate) fn group_send_msg(self: &Arc<Self>, g: &Group, m: &Msg) -> Result<(), String> {
        self.lock().groups.my_typing.remove(&g.id);
        self.group_post(g, "chat", frame_of(m), true, None)
            .map(|_| ())
    }

    /// Неподтверждённое в группах (для `chat_status`).
    pub(crate) fn groups_status(&self) -> Value {
        let st = self.lock();
        json!({
            "outbox": st.groups.pending.len(),
            "mailed": st.groups.pending.values().filter(|p| p.mailed).count(),
            "groups": st.contacts.groups.iter().filter(|g| !g.left).count(),
        })
    }

    /// Участники групп, кому есть что доставить (поднимать к ним линки).
    pub(crate) fn groups_waiting_peers(&self) -> HashSet<String> {
        let st = self.lock();
        st.groups
            .pending
            .values()
            .flat_map(|e| e.waiting.iter().cloned())
            .collect()
    }

    /// Строки групп для `chats_list`.
    pub(crate) fn group_rows(&self, unread: &HashMap<String, u64>) -> Vec<Value> {
        let groups = self.lock().contacts.groups.clone();
        let me = self.my_id().unwrap_or_default();
        groups
            .iter()
            .map(|g| {
                let typers = self.group_typers(&g.id);
                json!({
                    "chat": g.id,
                    "group": true,
                    "name": g.name,
                    "members": g.members.iter()
                        .map(|m| json!({"id": m.id, "name": self.member_name(g, &m.id), "me": m.id == me, "admin": m.id == g.admin}))
                        .collect::<Vec<_>>(),
                    "admin": g.admin == me,
                    "left": g.left,
                    "last": self.db.last_msg(&g.id).map(|m| self.msg_json(&m)),
                    "unread": unread.get(&g.id).copied().unwrap_or(0),
                    "typing": !typers.is_empty(),
                    "typingWho": typers,
                    "created": g.created,
                })
            })
            .collect()
    }

    /// Сообщение группы для интерфейса: имя автора; у звонка — без ключа, с флагом «можно войти».
    pub(crate) fn group_msg_extra(&self, m: &Msg, v: &mut Value) {
        if !is_group(&m.chat) {
            return;
        }
        let Some(g) = self.group(&m.chat) else { return };
        if !m.out && !m.sender.is_empty() {
            v["senderName"] = json!(self.member_name(&g, &m.sender));
        }
        if m.kind == "call"
            && let Some(f) = v.get_mut("file").and_then(|f| f.as_object_mut())
        {
            let until = f.get("until").and_then(|x| x.as_u64()).unwrap_or(0);
            let ended = f.get("ended").and_then(|x| x.as_bool()) == Some(true);
            f.remove("k");
            f.insert(
                "joinable".into(),
                json!(!g.left && !ended && until > now_ms()),
            );
        }
    }
}
