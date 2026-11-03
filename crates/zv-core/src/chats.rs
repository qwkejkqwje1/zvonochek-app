//! Чаты с контактами (M4): сообщения, статусы «доставлено/прочитано», правка и удаление,
//! «печатает…», очередь доставки и почтовый ящик для тех, кто не в сети.
//!
//! Кадры ZV4 (по линку, через комнату-ящик контакта или из почтового ящика):
//! `chat {id, lc, ts, k, b, re?, f?}` · `chat_edit {id, m, b, ts}` · `chat_del {id, m}` ·
//! `chat_ack {ids}` · `chat_read {id, m}` · `chat_typing` · `chat_file_cancel {fid}`.
//! Всё, кроме `chat_ack`/`chat_typing`/`chat_file_cancel`, лежит в очереди (`outbox`), пока
//! собеседник не подтвердит `chat_ack`: живой путь (линк или комната) сразу, через 8 с без
//! подтверждения — почтовый ящик (Worker/Nostr/ntfy), при появлении связи — повтор по линку.

use crate::contacts::Src;
use crate::db::{Msg, OutEntry};
use crate::groups::is_group;
use crate::{Inner, s};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use zv_proto::ids::{now_ms, rand_hex};
use zv_signal::mailbox::{Cursor, MAX_PLAIN, MailAddr, Mailbox};

pub(crate) const MAX_TEXT: usize = 16_000;
const MAIL_AFTER_MS: u64 = 8_000;
const MAIL_RETRY_MS: u64 = 60_000;
const LIVE_RETRY_MS: u64 = 30_000;
const FETCH_FIRST_MS: u64 = 4_000;
const FETCH_EVERY_MS: u64 = 10 * 60_000;
const TYPING_TTL_MS: u64 = 6_000;
const TYPING_EVERY_MS: u64 = 3_000;
const OFFLINE_FRESH_MS: u64 = 60_000;
/// Как часто пробовать поднять линк к тем, кому есть что доставить (очередь, ждущие файлы).
const LINK_RETRY_MS: u64 = 30_000;
const MAX_PARTS: usize = 16;
const PARTS_TTL_MS: u64 = 24 * 3_600_000;

#[derive(Default)]
pub(crate) struct ChatsState {
    /// Чат → до какого времени собеседник «печатает».
    pub typing: HashMap<String, u64>,
    pub my_typing: HashMap<String, u64>,
    /// Открытый в окне чат и видно ли окно.
    pub focus: Option<(String, bool)>,
    pub pending: HashMap<(String, String), Pending>,
    pub mail_busy: bool,
    pub next_fetch: u64,
    pub last_fetch: Value,
    pub last_put: Value,
    /// Части длинных предметов ящика: "h|m" → (n, части, когда).
    pub parts: HashMap<String, (usize, HashMap<usize, String>, u64)>,
    pub connecting: HashSet<String>,
    /// Не дозвонились по P2P: собеседник → когда.
    pub offline_at: HashMap<String, u64>,
    pub loaded: bool,
    /// Когда снова пробовать поднять линки для недоставленного (0 — сразу; сбрасывается при запуске узла).
    pub next_link_retry: u64,
    /// Идущие скачивания: fid → флаг отмены.
    pub transfers: HashMap<String, Arc<std::sync::atomic::AtomicBool>>,
}

#[derive(Debug, Clone)]
pub(crate) struct Pending {
    pub kind: String,
    pub last_live: u64,
    pub mail_after: u64,
    pub mailing: bool,
    pub mailed: bool,
}

/// ULID: 48 бит времени + 80 бит случайных, Crockford base32 (26 знаков, сортируется по времени).
pub(crate) fn ulid() -> String {
    const A: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let t = (now_ms() as u128) & ((1u128 << 48) - 1);
    let r = hex::decode(rand_hex(10)).unwrap_or_else(|_| vec![0; 10]);
    let mut rv = [0u8; 16];
    rv[6..].copy_from_slice(&r[..10]);
    let v = (t << 80) | u128::from_be_bytes(rv);
    (0..26)
        .rev()
        .map(|i| A[((v >> (i * 5)) & 31) as usize] as char)
        .collect()
}

pub(crate) fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 40
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(crate) fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

pub(crate) fn clean_text(s: &str) -> String {
    let t: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    t.trim_matches(|c: char| c.is_whitespace())
        .chars()
        .take(MAX_TEXT)
        .collect()
}

/// Кадр сообщения.
pub(crate) fn frame_of(m: &Msg) -> Value {
    let mut f = json!({"t": "chat", "id": m.id, "lc": m.lc, "ts": m.ts, "k": m.kind, "b": m.body});
    if let Some(r) = &m.reply {
        f["re"] = json!(r);
    }
    if let Some(x) = &m.file {
        f["f"] = x.clone();
    }
    f
}

impl Inner {
    fn contact_by_chat(&self, chat: &str) -> Option<crate::model::Contact> {
        self.lock()
            .contacts
            .items
            .iter()
            .find(|c| c.id == chat)
            .cloned()
    }

    fn contact_by_peer(&self, peer: &str) -> Option<crate::model::Contact> {
        self.lock()
            .contacts
            .items
            .iter()
            .find(|c| c.peer == peer)
            .cloned()
    }

    /// Сообщение для интерфейса: с состоянием файла.
    pub(crate) fn msg_json(&self, m: &Msg) -> Value {
        let mut v = serde_json::to_value(m).unwrap_or(Value::Null);
        if let Some(fid) = m
            .file
            .as_ref()
            .and_then(|f| f.get("fid"))
            .and_then(|x| x.as_str())
            && let Some(r) = self.db.file(fid)
        {
            v["file"]["st"] = json!(r.st);
            v["file"]["done"] = json!(r.done);
            v["file"]["path"] = json!(r.path);
            v["file"]["err"] = json!(r.err);
        }
        self.group_msg_extra(m, &mut v);
        v
    }

    pub(crate) fn focused(&self, chat: &str) -> bool {
        matches!(&self.lock().chats.focus, Some((c, true)) if c == chat)
    }

    pub(crate) fn emit_unread(&self) {
        let u = self.db.unread();
        let total: u64 = u.iter().map(|(_, n)| n).sum();
        let map: serde_json::Map<String, Value> =
            u.into_iter().map(|(c, n)| (c, json!(n))).collect();
        self.emit("chat:unread", json!({"total": total, "chats": map}));
    }

    // ---------- команды ----------

    pub(crate) fn chats_list(&self) -> Value {
        let (contacts, typing, presence) = {
            let st = self.lock();
            let now = now_ms();
            let typing: HashSet<String> = st
                .chats
                .typing
                .iter()
                .filter(|(_, t)| **t > now)
                .map(|(c, _)| c.clone())
                .collect();
            let presence: HashMap<String, bool> = st
                .p2p
                .c
                .presence
                .iter()
                .map(|(k, p)| (k.clone(), p.online))
                .collect();
            (st.contacts.items.clone(), typing, presence)
        };
        let unread: HashMap<String, u64> = self.db.unread().into_iter().collect();
        let mut v: Vec<(u64, Value)> = contacts
            .iter()
            .map(|c| {
                let last = self.db.last_msg(&c.id);
                let at = last.as_ref().map(|m| m.ts.min(m.rx.max(m.ts))).unwrap_or(0);
                (
                    at,
                    json!({
                        "chat": c.id,
                        "name": c.name,
                        "peer": c.peer,
                        "verified": c.verified,
                        "online": presence.get(&c.id),
                        "lastSeen": c.last_seen,
                        "last": last.map(|m| self.msg_json(&m)),
                        "unread": unread.get(&c.id).copied().unwrap_or(0),
                        "typing": typing.contains(&c.id),
                    }),
                )
            })
            .collect();
        for g in self.group_rows(&unread) {
            let at = g["last"]["ts"]
                .as_u64()
                .unwrap_or_else(|| g["created"].as_u64().unwrap_or(0));
            v.push((at, g));
        }
        v.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1["name"].as_str().cmp(&b.1["name"].as_str()))
        });
        Value::Array(v.into_iter().map(|x| x.1).collect())
    }

    pub(crate) fn chat_history(&self, args: &Value) -> Result<Value, String> {
        let chat = s(args, "chat")?;
        let before = args.get("before").and_then(|v| v.as_str());
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(60)
            .clamp(1, 500) as usize;
        let (msgs, more) = self.db.history(chat, before, limit);
        Ok(json!({"msgs": msgs.iter().map(|m| self.msg_json(m)).collect::<Vec<_>>(), "more": more}))
    }

    pub(crate) fn chat_send(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let chat = s(args, "chat")?;
        let body = clean_text(args.get("text").and_then(|v| v.as_str()).unwrap_or(""));
        if body.is_empty() {
            return Err("пустое сообщение".into());
        }
        let reply = args
            .get("reply")
            .and_then(|v| v.as_str())
            .filter(|r| valid_id(r))
            .map(str::to_string);
        if is_group(chat) {
            let g = self.group_writable(chat)?;
            let m = self.new_out_msg(&g.id, "text", body, reply, None);
            self.group_send_msg(&g, &m)?;
            let v = self.msg_json(&m);
            self.emit("chat:msg", json!({"msg": v, "new": true}));
            return Ok(v);
        }
        let c = self.contact_by_chat(chat).ok_or("нет такого контакта")?;
        let m = self.new_out_msg(&c.id, "text", body, reply, None);
        // у собеседника «печатает…» погаснет с приходом сообщения — следующий ввод сообщим сразу
        self.lock().chats.my_typing.remove(&c.id);
        self.deliver(&c.peer, &m.id, "chat", frame_of(&m));
        let v = self.msg_json(&m);
        self.emit("chat:msg", json!({"msg": v, "new": true}));
        Ok(v)
    }

    pub(crate) fn new_out_msg(
        &self,
        chat: &str,
        kind: &str,
        body: String,
        reply: Option<String>,
        file: Option<Value>,
    ) -> Msg {
        let now = now_ms();
        let m = Msg {
            id: ulid(),
            chat: chat.to_string(),
            out: true,
            ts: now,
            rx: now,
            lc: self.db.max_lc(chat) + 1,
            kind: kind.into(),
            body,
            reply,
            file,
            st: 0,
            edited: None,
            deleted: false,
            via: String::new(),
            sender: String::new(),
        };
        self.db.insert_msg(&m);
        m
    }

    pub(crate) fn chat_edit(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let id = s(args, "id")?;
        let m = self.db.msg(id).ok_or("нет такого сообщения")?;
        if !m.out || m.deleted || m.kind != "text" {
            return Err("это сообщение нельзя изменить".into());
        }
        let body = clean_text(args.get("text").and_then(|v| v.as_str()).unwrap_or(""));
        if body.is_empty() {
            return Err("пустое сообщение".into());
        }
        let now = now_ms();
        if is_group(&m.chat) {
            let g = self.group_writable(&m.chat)?;
            self.db.edit(id, &body, now);
            self.group_post(
                &g,
                "edit",
                json!({"t": "chat_edit", "m": id, "b": body, "ts": now}),
                true,
                None,
            )?;
        } else {
            let c = self.contact_by_chat(&m.chat).ok_or("нет такого контакта")?;
            self.db.edit(id, &body, now);
            let fid = ulid();
            self.deliver(
                &c.peer,
                &fid,
                "edit",
                json!({"t": "chat_edit", "id": fid, "m": id, "b": body, "ts": now}),
            );
        }
        let m = self.db.msg(id).ok_or("нет такого сообщения")?;
        let v = self.msg_json(&m);
        self.emit("chat:msg", json!({"msg": v, "new": false}));
        Ok(v)
    }

    pub(crate) fn chat_delete(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let id = s(args, "id")?;
        let everyone = args
            .get("everyone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let m = self.db.msg(id).ok_or("нет такого сообщения")?;
        if let Some(fid) = m
            .file
            .as_ref()
            .and_then(|f| f.get("fid"))
            .and_then(|x| x.as_str())
        {
            self.file_cancel_inner(fid, false);
        }
        if everyone && m.out && !m.deleted {
            if is_group(&m.chat) {
                let g = self.group_writable(&m.chat)?;
                self.db.mark_deleted(id);
                self.group_post(&g, "del", json!({"t": "chat_del", "m": id}), true, None)?;
            } else {
                let c = self.contact_by_chat(&m.chat).ok_or("нет такого контакта")?;
                self.db.mark_deleted(id);
                let fid = ulid();
                self.deliver(
                    &c.peer,
                    &fid,
                    "del",
                    json!({"t": "chat_del", "id": fid, "m": id}),
                );
            }
            if let Some(m) = self.db.msg(id) {
                self.emit("chat:msg", json!({"msg": self.msg_json(&m), "new": false}));
            }
        } else {
            self.db.remove(id);
            self.emit("chat:removed", json!({"chat": m.chat, "id": id}));
        }
        self.emit_unread();
        Ok(Value::Null)
    }

    pub(crate) fn chat_read(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let chat = s(args, "chat")?;
        let (n, last) = self.db.read_in_all(chat);
        if n == 0 {
            return Ok(json!({"read": 0}));
        }
        self.emit_unread();
        let receipts = self.lock().settings.read_receipts;
        if receipts
            && !is_group(chat)
            && let (Some(last), Some(c)) = (last, self.contact_by_chat(chat))
        {
            // прежняя отметка больше не нужна — новая её покрывает
            self.db.out_del_kind(&c.peer, "read");
            self.lock()
                .chats
                .pending
                .retain(|(_, p), e| !(p == &c.peer && e.kind == "read"));
            let fid = ulid();
            self.deliver(
                &c.peer,
                &fid,
                "read",
                json!({"t": "chat_read", "id": fid, "m": last}),
            );
        }
        Ok(json!({"read": n}))
    }

    pub(crate) fn chat_typing(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let chat = s(args, "chat")?;
        if is_group(chat) {
            if let Some(g) = self.group(chat).filter(|g| !g.left) {
                self.group_typing(&g);
            }
            return Ok(Value::Null);
        }
        let now = now_ms();
        {
            let mut st = self.lock();
            let last = st.chats.my_typing.get(chat).copied().unwrap_or(0);
            if now.saturating_sub(last) < TYPING_EVERY_MS {
                return Ok(Value::Null);
            }
            st.chats.my_typing.insert(chat.to_string(), now);
        }
        if let (Some(c), Some(n)) = (self.contact_by_chat(chat), self.node()) {
            n.send_peer(&c.peer, &json!({"t": "chat_typing"}));
        }
        Ok(Value::Null)
    }

    pub(crate) fn chat_focus(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let chat = args
            .get("chat")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let visible = args
            .get("visible")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        self.lock().chats.focus = chat.map(|c| (c, visible));
        Ok(Value::Null)
    }

    pub(crate) fn chat_clear(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let chat = s(args, "chat")?;
        for f in self.db.files_of_chat(chat) {
            self.file_cancel_inner(&f.fid, false);
        }
        self.db.clear_chat(chat);
        self.emit("chat:cleared", json!({"chat": chat}));
        self.emit_unread();
        Ok(Value::Null)
    }

    /// Контакт удалён: переписка и очередь к нему тоже.
    pub(crate) fn chat_forget(self: &Arc<Self>, chat: &str, peer: &str) {
        for f in self.db.files_of_chat(chat) {
            self.file_cancel_inner(&f.fid, false);
        }
        self.db.clear_chat(chat);
        self.db.out_del_peer(peer);
        self.lock().chats.pending.retain(|(_, p), _| p != peer);
        self.emit("chat:cleared", json!({"chat": chat}));
        self.emit_unread();
    }

    pub(crate) fn chat_status(&self) -> Value {
        let groups = self.groups_status();
        let st = self.lock();
        json!({
            "groups": groups,
            "outbox": st.chats.pending.len(),
            "mailing": st.chats.pending.values().filter(|p| p.mailing).count(),
            "mailed": st.chats.pending.values().filter(|p| p.mailed).count(),
            "nextFetchIn": st.chats.next_fetch.saturating_sub(now_ms()) / 1000,
            "lastFetch": st.chats.last_fetch,
            "lastPut": st.chats.last_put,
            "downloads": self.downloads_dir().display().to_string(),
        })
    }

    // ---------- доставка ----------

    /// Поставить кадр в очередь и попробовать отправить сразу.
    pub(crate) fn deliver(self: &Arc<Self>, peer: &str, fid: &str, kind: &str, frame: Value) {
        let now = now_ms();
        self.db.out_put(&OutEntry {
            fid: fid.into(),
            peer: peer.into(),
            kind: kind.into(),
            frame: frame.clone(),
            created: now,
            mailed: false,
        });
        let known_offline = self
            .lock()
            .chats
            .offline_at
            .get(peer)
            .is_some_and(|t| now.saturating_sub(*t) < OFFLINE_FRESH_MS);
        let linked = self.node().and_then(|n| n.link_for(peer)).is_some();
        let mail_after = if !linked && known_offline {
            now
        } else {
            now + MAIL_AFTER_MS
        };
        self.lock().chats.pending.insert(
            (fid.into(), peer.into()),
            Pending {
                kind: kind.into(),
                last_live: now,
                mail_after,
                mailing: false,
                mailed: false,
            },
        );
        if linked {
            if let Some(n) = self.node() {
                n.send_peer(peer, &frame);
            }
        } else {
            if !known_offline {
                self.send_contact(peer, &frame, true);
            }
            self.ensure_link(peer);
        }
    }

    fn retry_links(self: &Arc<Self>, now: u64) {
        let mut peers: HashSet<String> = {
            let mut st = self.lock();
            if now < st.chats.next_link_retry {
                return;
            }
            st.chats.next_link_retry = now + LINK_RETRY_MS;
            st.chats.pending.keys().map(|(_, p)| p.clone()).collect()
        };
        peers.extend(self.groups_waiting_peers());
        let waiting = self.db.files_where_st(&["waiting"]);
        if !waiting.is_empty() {
            let senders: Vec<(String, String)> = waiting
                .iter()
                .filter(|f| !f.out && is_group(&f.chat))
                .filter_map(|f| self.db.msg(&f.msg).map(|m| (f.chat.clone(), m.sender)))
                .collect();
            let st = self.lock();
            for f in waiting.iter().filter(|f| !f.out) {
                if let Some(c) = st.contacts.items.iter().find(|c| c.id == f.chat) {
                    peers.insert(c.peer.clone());
                }
            }
            // файл группы качаем у автора сообщения
            for (gid, who) in senders {
                if !who.is_empty()
                    && st
                        .contacts
                        .groups
                        .iter()
                        .any(|g| g.id == gid && !g.left && g.members.iter().any(|m| m.id == who))
                {
                    peers.insert(who);
                }
            }
        }
        for p in peers {
            self.ensure_link(&p);
        }
    }

    /// Поднять линк к контакту (в фоне); получится — очередь уйдёт по нему (`chats_link_up`).
    pub(crate) fn ensure_link(self: &Arc<Self>, peer: &str) {
        let Some(node) = self.node() else { return };
        if node.link_for(peer).is_some() {
            return;
        }
        let hint = {
            let mut st = self.lock();
            if !st.chats.connecting.insert(peer.to_string()) {
                return;
            }
            st.contacts
                .items
                .iter()
                .find(|c| c.peer == peer)
                .and_then(|c| c.hint.clone())
        };
        let hint = hint.or_else(|| self.peer_hint(peer));
        let me = self.clone();
        let peer = peer.to_string();
        self.rt.spawn(async move {
            let r =
                tokio::time::timeout(Duration::from_secs(20), node.connect(&peer, hint.as_ref()))
                    .await;
            let mut st = me.lock();
            st.chats.connecting.remove(&peer);
            if !matches!(r, Ok(Ok(_))) {
                st.chats.offline_at.insert(peer.clone(), now_ms());
                // без связи — в ящик, не дожидаясь 8 с
                let now = now_ms();
                for ((_, p), e) in st.chats.pending.iter_mut() {
                    if *p == peer && !e.mailed && !e.mailing {
                        e.mail_after = e.mail_after.min(now);
                    }
                }
            }
        });
    }

    /// Появился линк к контакту: отправить очередь, продолжить файлы.
    pub(crate) fn chats_link_up(self: &Arc<Self>, peer: &str) {
        self.lock().chats.offline_at.remove(peer);
        self.flush_peer(peer, true);
        self.files_resume(peer);
    }

    /// Повторить очередь к собеседнику (по линку; `force` — не глядя на время прошлой попытки).
    fn flush_peer(self: &Arc<Self>, peer: &str, force: bool) {
        let Some(node) = self.node() else { return };
        let Some(link) = node.link_for(peer) else {
            return;
        };
        let now = now_ms();
        let due: Vec<String> = {
            let mut st = self.lock();
            let mut v = Vec::new();
            for ((fid, p), e) in st.chats.pending.iter_mut() {
                if p == peer && (force || now.saturating_sub(e.last_live) >= LIVE_RETRY_MS) {
                    e.last_live = now;
                    v.push(fid.clone());
                }
            }
            v
        };
        if due.is_empty() {
            return;
        }
        let set: HashSet<String> = due.into_iter().collect();
        for e in self.db.out_all() {
            if e.peer == peer && set.contains(&e.fid) {
                node.send(link, &e.frame);
            }
        }
    }

    pub(crate) fn chats_tick(self: &Arc<Self>, now: u64) {
        if self.node().is_none() {
            return;
        }
        // очередь из базы — один раз
        let first = {
            let mut st = self.lock();
            !std::mem::replace(&mut st.chats.loaded, true)
        };
        if first {
            let all = self.db.out_all();
            let mut st = self.lock();
            for e in all.into_iter().filter(|e| !is_group(&e.peer)) {
                st.chats.pending.insert(
                    (e.fid, e.peer),
                    Pending {
                        kind: e.kind,
                        last_live: 0,
                        mail_after: now + MAIL_AFTER_MS,
                        mailing: false,
                        mailed: e.mailed,
                    },
                );
            }
            st.chats.next_fetch = now + FETCH_FIRST_MS;
        }
        // в ящик
        let to_mail: Vec<(String, String)> = {
            let mut st = self.lock();
            let mut v = Vec::new();
            for ((fid, peer), e) in st.chats.pending.iter_mut() {
                if !e.mailed && !e.mailing && now >= e.mail_after {
                    e.mailing = true;
                    v.push((fid.clone(), peer.clone()));
                }
            }
            v
        };
        if !to_mail.is_empty() {
            let me = self.clone();
            self.rt.spawn(async move {
                for (fid, peer) in to_mail {
                    me.mail_put(&fid, &peer).await;
                }
            });
        }
        // нет линка, а доставить есть что (очередь, ждущие файлы от собеседника) — поднять
        self.retry_links(now);
        // повтор по живым линкам
        if (now / 1000).is_multiple_of(5) {
            let peers: HashSet<String> = self
                .lock()
                .chats
                .pending
                .keys()
                .map(|(_, p)| p.clone())
                .collect();
            for p in peers {
                self.flush_peer(&p, false);
            }
        }
        // «печатает» истекло
        let expired: Vec<String> = {
            let mut st = self.lock();
            let v: Vec<String> = st
                .chats
                .typing
                .iter()
                .filter(|(_, t)| **t <= now)
                .map(|(c, _)| c.clone())
                .collect();
            for c in &v {
                st.chats.typing.remove(c);
            }
            st.chats
                .parts
                .retain(|_, (_, _, t)| now.saturating_sub(*t) < PARTS_TTL_MS);
            v
        };
        for c in expired {
            self.emit("chat:typing", json!({"chat": c, "on": false}));
        }
        // забрать ящик (свой и ящики групп)
        let groups = self.groups_to_fetch();
        let fetch = {
            let mut st = self.lock();
            let has = (!st.contacts.inbox.is_empty() && !st.contacts.items.is_empty()) || groups;
            if has && !st.chats.mail_busy && now >= st.chats.next_fetch {
                st.chats.mail_busy = true;
                true
            } else {
                false
            }
        };
        if fetch {
            let me = self.clone();
            self.rt.spawn(async move {
                me.mail_fetch().await;
            });
        }
    }

    /// Предметы ящика для кадра: `{h, p}` или части `{h, m, i, n, p}`.
    fn mail_items(&self, peer: &str, fid: &str, frame: &Value) -> Option<Vec<Vec<u8>>> {
        let room = self.pair_room(peer)?;
        let sealed = room.seal(frame);
        let h = room.topic.clone();
        let one = json!({"h": h, "p": sealed}).to_string().into_bytes();
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
                    json!({"h": h, "m": fid, "i": i, "n": n, "p": p})
                        .to_string()
                        .into_bytes()
                })
                .collect(),
        )
    }

    async fn mail_put(self: &Arc<Self>, fid: &str, peer: &str) {
        let entry = self
            .db
            .out_all()
            .into_iter()
            .find(|e| e.fid == fid && e.peer == peer);
        let inbox = self
            .contact_by_peer(peer)
            .map(|c| c.inbox)
            .unwrap_or_default();
        let key = (fid.to_string(), peer.to_string());
        let (Some(entry), Some(addr)) = (entry, MailAddr::derive(&inbox)) else {
            // запись подтвердили или контакта/ящика нет — больше не пытаемся
            let mut st = self.lock();
            if let Some(p) = st.chats.pending.get_mut(&key) {
                p.mailing = false;
                p.mail_after = now_ms() + MAIL_RETRY_MS * 10;
            }
            return;
        };
        let Some(items) = self.mail_items(peer, fid, &entry.frame) else {
            let mut st = self.lock();
            if let Some(p) = st.chats.pending.get_mut(&key) {
                p.mailing = false;
                p.mail_after = now_ms() + MAIL_RETRY_MS;
            }
            return;
        };
        let mb = Mailbox::new(self.signal_config());
        let mut all = true;
        let mut reports = Vec::new();
        for it in items {
            let r = mb.put(&addr, &it).await;
            all &= r.any();
            reports.push(serde_json::to_value(&r).unwrap_or(Value::Null));
        }
        let acked = !self.lock().chats.pending.contains_key(&key);
        {
            let mut st = self.lock();
            st.chats.last_put = json!({"at": now_ms(), "ok": all, "reports": reports});
            if let Some(p) = st.chats.pending.get_mut(&key) {
                p.mailing = false;
                if all {
                    p.mailed = true;
                } else {
                    p.mail_after = now_ms() + MAIL_RETRY_MS;
                }
            }
        }
        if all && !acked {
            self.db.out_mailed(fid, peer);
            if entry.kind == "chat"
                && let Some(c) = self.contact_by_peer(peer)
            {
                let ch = self.db.raise_out(&c.id, &[fid.to_string()], 1);
                if !ch.is_empty() {
                    self.emit("chat:state", json!({"chat": c.id, "ids": ch, "st": 1}));
                }
            }
        }
    }

    /// Забрать свой почтовый ящик.
    pub(crate) async fn mail_fetch(self: &Arc<Self>) -> Value {
        let (inbox, dev, contacts) = {
            let st = self.lock();
            (
                st.contacts.inbox.clone(),
                self.node()
                    .map(|n| format!("zv4-{}", &n.id()[..16]))
                    .unwrap_or_default(),
                !st.contacts.items.is_empty(),
            )
        };
        let done = |me: &Arc<Self>, v: Value| {
            let mut st = me.lock();
            st.chats.mail_busy = false;
            st.chats.next_fetch = now_ms() + FETCH_EVERY_MS;
            st.chats.last_fetch = v.clone();
            v
        };
        if dev.is_empty() {
            return done(self, json!({"ok": false, "error": "P2P не запущен"}));
        }
        let groups = if self.groups_to_fetch() {
            self.groups_mail_fetch(&dev).await
        } else {
            Value::Null
        };
        let Some(addr) = MailAddr::derive(&inbox).filter(|_| contacts) else {
            let ok = groups.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let err = if groups.is_null() {
                json!("нет ящика")
            } else {
                Value::Null
            };
            return done(
                self,
                json!({"ok": ok, "at": now_ms(), "items": 0, "frames": 0, "error": err, "groups": groups}),
            );
        };
        let mut cur: Cursor = self
            .db
            .kv("mail_cursor")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mb = Mailbox::new(self.signal_config());
        let rep = mb.fetch(&addr, &mut cur, &dev).await;
        // подсказки пар: h → собеседник
        let peers: Vec<String> = self
            .lock()
            .contacts
            .items
            .iter()
            .map(|c| c.peer.clone())
            .collect();
        let hints: HashMap<String, String> = peers
            .into_iter()
            .filter_map(|p| self.pair_room(&p).map(|r| (r.topic.clone(), p)))
            .collect();
        let mut n = 0;
        let mut acks: HashMap<String, Vec<String>> = HashMap::new();
        for it in &rep.items {
            if let Some((peer, frame)) = self.open_mail_item(&it.data, &hints) {
                n += 1;
                if let Some(id) = self.on_chat(Src::Mail, &peer, frame) {
                    acks.entry(peer).or_default().push(id);
                }
            }
        }
        self.db.kv_set(
            "mail_cursor",
            &serde_json::to_string(&cur).unwrap_or_default(),
        );
        let seqs: Vec<u64> = rep.items.iter().filter_map(|i| i.seq).collect();
        if !seqs.is_empty() {
            mb.ack(&addr, &seqs, &dev).await;
        }
        // подтверждения тем, кто писал в ящик: по живому пути, а если линка нет — тоже в ящик
        // (и пробуем поднять линк: тогда отправитель сам повторит очередь и получит подтверждения)
        for (peer, ids) in acks {
            let frame = json!({"t": "chat_ack", "ids": ids});
            let linked = self.node().and_then(|n| n.link_for(&peer)).is_some();
            self.send_contact(&peer, &frame, false);
            if !linked {
                self.ensure_link(&peer);
            }
            if !linked
                && let (Some(c), Some(items)) = (
                    self.contact_by_peer(&peer),
                    self.mail_items(&peer, "ack", &frame),
                )
                && let Some(a) = MailAddr::derive(&c.inbox)
            {
                for it in items {
                    mb.put(&a, &it).await;
                }
            }
        }
        done(
            self,
            json!({
                "ok": rep.worker_ok || rep.nostr_ok > 0 || rep.ntfy_ok,
                "at": now_ms(),
                "items": rep.items.len(),
                "frames": n,
                "worker": rep.worker_ok,
                "nostr": rep.nostr_ok,
                "ntfy": rep.ntfy_ok,
                "errors": rep.errors,
                "groups": groups,
            }),
        )
    }

    fn open_mail_item(
        &self,
        data: &[u8],
        hints: &HashMap<String, String>,
    ) -> Option<(String, Value)> {
        let v: Value = serde_json::from_slice(data).ok()?;
        let h = str_of(&v, "h");
        let peer = hints.get(h)?.clone();
        let sealed = if let Some(n) = v.get("n").and_then(|x| x.as_u64()) {
            let (n, i, m) = (
                n as usize,
                v.get("i")?.as_u64()? as usize,
                str_of(&v, "m").to_string(),
            );
            if n == 0 || n > MAX_PARTS || i >= n {
                return None;
            }
            let key = format!("{h}|{m}");
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
            str_of(&v, "p").to_string()
        };
        let frame = self.pair_room(&peer)?.open(&sealed)?;
        Some((peer, frame))
    }

    // ---------- приём ----------

    /// Кадр чата от контакта. Возвращает id для подтверждения, если его надо подтвердить
    /// пачкой (из ящика); для живых путей подтверждает сам.
    pub(crate) fn on_chat(self: &Arc<Self>, src: Src, peer: &str, frame: Value) -> Option<String> {
        let c = self.contact_by_peer(peer)?;
        let t = str_of(&frame, "t").to_string();
        let now = now_ms();
        let via = match &src {
            Src::Link(_) => "p2p",
            Src::Room(_) => "room",
            Src::Mail => "mail",
        };
        // собеседник на связи — повторим ему очередь
        if !matches!(src, Src::Mail) {
            self.lock().chats.offline_at.remove(peer);
            self.flush_peer(peer, false);
        }
        let ack_id = match t.as_str() {
            "chat" => {
                let id = str_of(&frame, "id").to_string();
                if !valid_id(&id) {
                    return None;
                }
                let kind = match str_of(&frame, "k") {
                    "file" => "file",
                    _ => "text",
                };
                let body = clean_text(str_of(&frame, "b"));
                let file = if kind == "file" {
                    self.file_meta(&frame)
                } else {
                    None
                };
                if (kind == "text" && body.is_empty()) || (kind == "file" && file.is_none()) {
                    return Some(id);
                }
                let ts = frame.get("ts").and_then(|v| v.as_u64()).unwrap_or(now);
                let m = Msg {
                    id: id.clone(),
                    chat: c.id.clone(),
                    out: false,
                    ts: ts.min(now + 300_000),
                    rx: now,
                    lc: frame
                        .get("lc")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0)
                        .min(u64::MAX / 4),
                    kind: kind.into(),
                    body,
                    reply: frame
                        .get("re")
                        .and_then(|v| v.as_str())
                        .filter(|r| valid_id(r))
                        .map(str::to_string),
                    file: file.clone(),
                    st: 0,
                    edited: None,
                    deleted: false,
                    via: via.into(),
                    sender: String::new(),
                };
                // своё сообщение с тем же id (подделка) — игнор
                let mine = self.db.msg(&id).is_some_and(|x| x.chat != c.id || x.out);
                if !mine && self.db.insert_msg(&m) {
                    if let Some(f) = &file {
                        self.file_offered(&c.id, &m, f);
                    }
                    let was_typing = self.lock().chats.typing.remove(&c.id).is_some();
                    if was_typing {
                        self.emit("chat:typing", json!({"chat": c.id, "on": false}));
                    }
                    let notify = !self.focused(&c.id);
                    self.emit("chat:msg", json!({"msg": self.msg_json(&m), "new": true, "name": c.name, "notify": notify}));
                    self.emit_unread();
                }
                Some(id)
            }
            "chat_edit" | "chat_del" => {
                let fid = str_of(&frame, "id").to_string();
                let mid = str_of(&frame, "m");
                if let Some(m) = self.db.msg(mid).filter(|m| m.chat == c.id && !m.out) {
                    let changed = if t == "chat_edit" {
                        let b = clean_text(str_of(&frame, "b"));
                        !b.is_empty()
                            && self.db.edit(
                                mid,
                                &b,
                                frame.get("ts").and_then(|v| v.as_u64()).unwrap_or(now),
                            )
                    } else {
                        if let Some(f) = m
                            .file
                            .as_ref()
                            .and_then(|f| f.get("fid"))
                            .and_then(|x| x.as_str())
                        {
                            self.file_cancel_inner(f, true);
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
            "chat_group" => self.on_group_invite(&c, &frame),
            "chat_ack" => {
                let ids: Vec<String> = frame
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
                {
                    let mut st = self.lock();
                    for id in &ids {
                        st.chats.pending.remove(&(id.clone(), peer.to_string()));
                    }
                }
                for id in &ids {
                    self.db.out_del(id, peer);
                }
                let ch = self.db.raise_out(&c.id, &ids, 2);
                if !ch.is_empty() {
                    self.emit("chat:state", json!({"chat": c.id, "ids": ch, "st": 2}));
                }
                None
            }
            "chat_read" => {
                let fid = str_of(&frame, "id").to_string();
                let ch = self.db.read_out_upto(&c.id, str_of(&frame, "m"));
                if !ch.is_empty() {
                    self.emit("chat:state", json!({"chat": c.id, "ids": ch, "st": 3}));
                }
                valid_id(&fid).then_some(fid)
            }
            "chat_typing" => {
                if !matches!(src, Src::Link(_)) {
                    return None;
                }
                let first = self
                    .lock()
                    .chats
                    .typing
                    .insert(c.id.clone(), now + TYPING_TTL_MS)
                    .is_none();
                if first {
                    self.emit("chat:typing", json!({"chat": c.id, "on": true}));
                }
                None
            }
            "chat_file_cancel" => {
                let fid = str_of(&frame, "fid");
                if let Some(r) = self.db.file(fid).filter(|r| r.chat == c.id && !r.out) {
                    self.file_cancel_inner(&r.fid, true);
                }
                None
            }
            _ => None,
        };
        let id = ack_id?;
        match src {
            Src::Mail => Some(id),
            Src::Link(l) => {
                if let Some(n) = self.node() {
                    n.send(l, &json!({"t": "chat_ack", "ids": [id]}));
                }
                None
            }
            Src::Room(_) => {
                self.send_contact(peer, &json!({"t": "chat_ack", "ids": [id]}), false);
                None
            }
        }
    }
}
