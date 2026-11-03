//! Почтовый ящик устройства: хранимая доставка ZV4 контакту, который сейчас не в сети.
//!
//! Адрес выводится из секрета ящика (тот же секрет, что у комнаты-ящика, его знают контакты)
//! через HKDF: id комнаты ChatRoom в Worker веба (64 hex), токен доступа к ней и ключ
//! AES-256-GCM «внешнего» слоя. Предмет ящика — `nonce(12) ‖ AES-GCM(u32 BE длина ‖ данные ‖ нули)`;
//! для Worker и Nostr — ровно 4124 байта (как blob ChatRoom веба: сервер не видит длину),
//! для ntfy — короткий (тело ≤ 4 КБ). Внутри — конверт, запечатанный ключом пары.
//!
//! Где лежит: ChatRoom Worker (до 7–30 дней, `/chat/<id>/init|msg|fetch|ack`), Nostr — обычные
//! (хранимые) события kind 1 с тегами `t=zvmail1`, `z=sha256(id)` на 3 реле, ntfy — кэш 12 ч.
//! Отправитель кладёт во все сразу, получатель забирает из всех; дубли отсекает ядро по id.

use crate::SignalConfig;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

/// Размер предмета для Worker/Nostr (= blob ChatRoom веба).
pub const ITEM_BYTES: usize = 4124;
const PLAIN_BYTES: usize = ITEM_BYTES - 12 - 16;
/// Сколько полезных байт влезает в один предмет.
pub const MAX_PLAIN: usize = PLAIN_BYTES - 4;
pub const NOSTR_KIND: u64 = 1;
pub const NOSTR_TAG: &str = "zvmail1";
pub const NTFY_PREFIX: &str = "zvmail1-";
const AAD: &[u8] = b"zv4-mail";
const HTTP_TIMEOUT: Duration = Duration::from_secs(12);
const WS_TIMEOUT: Duration = Duration::from_secs(8);
/// Хранимые события старше этого не запрашиваем (Worker держит до 30 дней).
const NOSTR_LOOKBACK_S: u64 = 30 * 24 * 3600;
const NOSTR_RELAYS: usize = 3;

#[derive(Clone)]
pub struct MailAddr {
    /// Комната ChatRoom в Worker.
    pub chat_id: String,
    token: String,
    key: [u8; 32],
    /// Публичный тег `z` в Nostr: sha256(chat_id).
    pub tag: String,
    pub ntfy_topic: String,
}

impl std::fmt::Debug for MailAddr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MailAddr({})", &self.chat_id[..12])
    }
}

impl MailAddr {
    /// Из секрета ящика (base64url, как секрет ссылки).
    pub fn derive(secret: &str) -> Option<MailAddr> {
        let room = zv_proto::Room::derive(secret).ok()?;
        let chat_id = hex::encode(room.subkey("zv4-mail-id"));
        let token = hex::encode(room.subkey("zv4-mail-token"));
        let key = room.subkey("zv4-mail-key");
        let tag = hex::encode(Sha256::digest(chat_id.as_bytes()));
        let ntfy_topic = zv_proto::topics::ntfy_topic(NTFY_PREFIX, &chat_id);
        Some(MailAddr { chat_id, token, key, tag, ntfy_topic })
    }

    /// Запечатать данные (≤ `MAX_PLAIN`). `fixed` — ровно `ITEM_BYTES`.
    pub fn seal(&self, data: &[u8], fixed: bool) -> Option<Vec<u8>> {
        if data.len() > MAX_PLAIN {
            return None;
        }
        let mut pt = Vec::with_capacity(PLAIN_BYTES);
        pt.extend_from_slice(&(data.len() as u32).to_be_bytes());
        pt.extend_from_slice(data);
        let target = if fixed { PLAIN_BYTES } else { pt.len().div_ceil(64) * 64 };
        pt.resize(target, 0);
        let mut iv = [0u8; 12];
        rand::fill(&mut iv);
        let ct = Aes256Gcm::new((&self.key).into()).encrypt(&Nonce::from(iv), Payload { msg: &pt, aad: AAD }).ok()?;
        let mut out = iv.to_vec();
        out.extend(ct);
        Some(out)
    }

    pub fn open(&self, item: &[u8]) -> Option<Vec<u8>> {
        if item.len() < 12 + 16 + 4 || item.len() > ITEM_BYTES {
            return None;
        }
        let iv: [u8; 12] = item[..12].try_into().ok()?;
        let pt = Aes256Gcm::new((&self.key).into()).decrypt(&Nonce::from(iv), Payload { msg: &item[12..], aad: AAD }).ok()?;
        let n = u32::from_be_bytes(pt[..4].try_into().ok()?) as usize;
        (n <= pt.len() - 4).then(|| pt[4..4 + n].to_vec())
    }
}

/// Докуда забрано из каждого хранилища.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Cursor {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub nostr: u64,
    #[serde(default)]
    pub ntfy: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PutReport {
    pub worker: bool,
    pub nostr: usize,
    pub ntfy: bool,
    pub errors: Vec<String>,
}

impl PutReport {
    pub fn any(&self) -> bool {
        self.worker || self.nostr > 0 || self.ntfy
    }
}

/// Предмет из ящика (уже открытый внешним ключом).
#[derive(Debug, Clone)]
pub struct MailItem {
    pub data: Vec<u8>,
    pub via: &'static str,
    /// Номер в Worker (для `/ack`).
    pub seq: Option<u64>,
}

#[derive(Debug, Default)]
pub struct FetchReport {
    pub items: Vec<MailItem>,
    pub worker_ok: bool,
    pub nostr_ok: usize,
    pub ntfy_ok: bool,
    pub errors: Vec<String>,
}

#[derive(Clone)]
pub struct Mailbox {
    cfg: SignalConfig,
}

impl Mailbox {
    pub fn new(cfg: SignalConfig) -> Mailbox {
        Mailbox { cfg }
    }

    fn worker(&self) -> Option<String> {
        self.cfg.worker_url.as_ref().map(|u| u.trim_end_matches('/').to_string())
    }

    fn relays(&self) -> Vec<String> {
        self.cfg.nostr_relays.iter().take(NOSTR_RELAYS).cloned().collect()
    }

    /// Положить данные (≤ `MAX_PLAIN`) во все доступные хранилища.
    pub async fn put(&self, addr: &MailAddr, data: &[u8]) -> PutReport {
        let mut rep = PutReport::default();
        let (Some(fixed), Some(short)) = (addr.seal(data, true), addr.seal(data, false)) else {
            rep.errors.push("слишком большой предмет".into());
            return rep;
        };
        let blob = zv_proto::b64u::enc(&fixed);
        let w = async {
            match self.worker() {
                Some(base) => worker_put(&base, addr, &blob).await.map(|_| true),
                None => Ok(false),
            }
        };
        let n = async {
            let mut ok = 0;
            let mut errs = Vec::new();
            let futs: Vec<_> = self.relays().into_iter().map(|r| nostr_put(r, addr.tag.clone(), blob.clone())).collect();
            for r in futures_util::future::join_all(futs).await {
                match r {
                    Ok(()) => ok += 1,
                    Err(e) => errs.push(format!("nostr: {e}")),
                }
            }
            (ok, errs)
        };
        let t = async {
            let body = zv_proto::b64u::enc(&short);
            match &self.cfg.ntfy_base {
                Some(base) if body.len() <= zv_proto::topics::NTFY_MAX_BODY - 96 => ntfy_put(base, &addr.ntfy_topic, body).await.map(|_| true),
                _ => Ok(false),
            }
        };
        let (w, (n, nerrs), t) = tokio::join!(w, n, t);
        match w {
            Ok(v) => rep.worker = v,
            Err(e) => rep.errors.push(format!("worker: {e}")),
        }
        rep.nostr = n;
        rep.errors.extend(nerrs);
        match t {
            Ok(v) => rep.ntfy = v,
            Err(e) => rep.errors.push(format!("ntfy: {e}")),
        }
        rep
    }

    /// Забрать новое из всех хранилищ. Курсор сдвигается только по тем, что ответили.
    pub async fn fetch(&self, addr: &MailAddr, cur: &mut Cursor, dev: &str) -> FetchReport {
        let mut rep = FetchReport::default();
        let w = async {
            match self.worker() {
                Some(base) => Some(worker_fetch(&base, addr, cur.seq, dev).await),
                None => None,
            }
        };
        let now_s = zv_proto::ids::now_ms() / 1000;
        let since = if cur.nostr == 0 { now_s.saturating_sub(NOSTR_LOOKBACK_S) } else { cur.nostr.saturating_sub(600) };
        let n = futures_util::future::join_all(self.relays().into_iter().map(|r| nostr_fetch(r, addr.tag.clone(), since)));
        let t = async {
            match &self.cfg.ntfy_base {
                Some(base) => Some(ntfy_fetch(base, &addr.ntfy_topic, &cur.ntfy).await),
                None => None,
            }
        };
        let (w, n, t) = tokio::join!(w, n, t);
        match w {
            Some(Ok((items, last))) => {
                rep.worker_ok = true;
                cur.seq = cur.seq.max(last);
                for (seq, blob) in items {
                    if let Some(d) = zv_proto::b64u::dec(&blob).ok().and_then(|b| addr.open(&b)) {
                        rep.items.push(MailItem { data: d, via: "worker", seq: Some(seq) });
                    }
                }
            }
            Some(Err(e)) => rep.errors.push(format!("worker: {e}")),
            None => {}
        }
        for r in n {
            match r {
                Ok((items, max_ts)) => {
                    rep.nostr_ok += 1;
                    cur.nostr = cur.nostr.max(max_ts);
                    for blob in items {
                        if let Some(d) = zv_proto::b64u::dec(&blob).ok().and_then(|b| addr.open(&b)) {
                            rep.items.push(MailItem { data: d, via: "nostr", seq: None });
                        }
                    }
                }
                Err(e) => rep.errors.push(format!("nostr: {e}")),
            }
        }
        match t {
            Some(Ok((items, last))) => {
                rep.ntfy_ok = true;
                if !last.is_empty() {
                    cur.ntfy = last;
                }
                for blob in items {
                    if let Some(d) = zv_proto::b64u::dec(&blob).ok().and_then(|b| addr.open(&b)) {
                        rep.items.push(MailItem { data: d, via: "ntfy", seq: None });
                    }
                }
            }
            Some(Err(e)) => rep.errors.push(format!("ntfy: {e}")),
            None => {}
        }
        // одно и то же могло прийти из нескольких хранилищ
        let mut seen = std::collections::HashSet::new();
        rep.items.retain(|i| seen.insert(Sha256::digest(&i.data).to_vec()) || i.seq.is_some());
        rep
    }

    /// Подтвердить Worker'у, что забрали (иначе он держит предметы до 30 дней).
    pub async fn ack(&self, addr: &MailAddr, seqs: &[u64], dev: &str) {
        let Some(base) = self.worker() else { return };
        for chunk in seqs.chunks(200) {
            let url = format!("{base}/chat/{}/ack", addr.chat_id);
            let r = crate::tls::http()
                .post(url)
                .header("x-access-token", &addr.token)
                .json(&json!({"seqs": chunk, "dev": dev}))
                .timeout(HTTP_TIMEOUT)
                .send()
                .await;
            if let Err(e) = r {
                tracing::debug!("mailbox ack: {e}");
            }
        }
    }
}

async fn worker_init(base: &str, addr: &MailAddr, dev: &str) -> anyhow::Result<u64> {
    let url = format!("{base}/chat/{}/init", addr.chat_id);
    let r = crate::tls::http()
        .post(url)
        .header("x-access-token", &addr.token)
        .json(&json!({"dev": dev}))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await?;
    let st = r.status();
    anyhow::ensure!(st.is_success(), "init HTTP {st}");
    let v: Value = r.json().await?;
    Ok(v.get("lastSeq").and_then(|x| x.as_u64()).unwrap_or(0))
}

async fn worker_put(base: &str, addr: &MailAddr, blob: &str) -> anyhow::Result<u64> {
    let url = format!("{base}/chat/{}/msg", addr.chat_id);
    for attempt in 0..2 {
        let r = crate::tls::http()
            .post(&url)
            .header("x-access-token", &addr.token)
            .json(&json!({"blob": blob, "dev": "", "quiet": true}))
            .timeout(HTTP_TIMEOUT)
            .send()
            .await?;
        let st = r.status();
        if st.as_u16() == 401 && attempt == 0 {
            worker_init(base, addr, "").await?;
            continue;
        }
        anyhow::ensure!(st.is_success(), "msg HTTP {st}");
        let v: Value = r.json().await?;
        return Ok(v.get("seq").and_then(|x| x.as_u64()).unwrap_or(0));
    }
    anyhow::bail!("нет доступа")
}

async fn worker_fetch(base: &str, addr: &MailAddr, after: u64, dev: &str) -> anyhow::Result<(Vec<(u64, String)>, u64)> {
    let mut out = Vec::new();
    let mut after = after;
    let mut inited = false;
    for _ in 0..20 {
        let url = format!("{base}/chat/{}/fetch?after={after}", addr.chat_id);
        let r = crate::tls::http().get(&url).header("x-access-token", &addr.token).timeout(HTTP_TIMEOUT).send().await?;
        let st = r.status();
        if st.as_u16() == 401 && !inited {
            // комнаты ещё нет — создаём (пустая)
            inited = true;
            worker_init(base, addr, dev).await?;
            continue;
        }
        if st.as_u16() == 410 {
            return Ok((out, after));
        }
        anyhow::ensure!(st.is_success(), "fetch HTTP {st}");
        let v: Value = r.json().await?;
        let msgs = v.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
        let n = msgs.len();
        for m in msgs {
            let (Some(seq), Some(blob)) = (m.get("seq").and_then(|x| x.as_u64()), m.get("blob").and_then(|x| x.as_str())) else {
                continue;
            };
            after = after.max(seq);
            out.push((seq, blob.to_string()));
        }
        if n < 500 {
            break;
        }
    }
    Ok((out, after))
}

async fn nostr_put(relay: String, tag: String, blob: String) -> anyhow::Result<()> {
    let key = crate::nostr::NostrKey::random();
    let now_s = zv_proto::ids::now_ms() / 1000;
    let (id, frame) = key.event_kind(NOSTR_KIND, json!([["t", NOSTR_TAG], ["z", tag]]), &blob, now_s);
    let mut ws = crate::tls::ws_connect(&relay, None, "ZVONochek-Desktop", WS_TIMEOUT).await?;
    ws.send(Message::Text(frame.into())).await?;
    let r = tokio::time::timeout(WS_TIMEOUT, async {
        while let Some(m) = ws.next().await {
            let Message::Text(t) = m? else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
            if v.get(0).and_then(|x| x.as_str()) == Some("OK") && v.get(1).and_then(|x| x.as_str()) == Some(id.as_str()) {
                if v.get(2).and_then(|x| x.as_bool()) == Some(true) {
                    return Ok(());
                }
                anyhow::bail!("{}", v.get(3).and_then(|x| x.as_str()).unwrap_or("отказ"));
            }
        }
        anyhow::bail!("закрыто")
    })
    .await;
    let _ = ws.close(None).await;
    r.map_err(|_| anyhow::anyhow!("нет OK"))?
}

async fn nostr_fetch(relay: String, tag: String, since: u64) -> anyhow::Result<(Vec<String>, u64)> {
    let mut ws = crate::tls::ws_connect(&relay, None, "ZVONochek-Desktop", WS_TIMEOUT).await?;
    let req = json!(["REQ", "m", {"kinds": [NOSTR_KIND], "#t": [NOSTR_TAG], "#z": [tag], "since": since, "limit": 500}]);
    ws.send(Message::Text(req.to_string().into())).await?;
    let mut out = Vec::new();
    let mut max_ts = 0;
    let r = tokio::time::timeout(WS_TIMEOUT, async {
        while let Some(m) = ws.next().await {
            let Message::Text(t) = m? else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
            match v.get(0).and_then(|x| x.as_str()) {
                Some("EVENT") => {
                    let Some(ev) = v.get(2) else { continue };
                    if !event_matches(ev, &tag) || !crate::nostr::verify_event(ev) {
                        continue;
                    }
                    max_ts = max_ts.max(ev.get("created_at").and_then(|x| x.as_u64()).unwrap_or(0));
                    if let Some(c) = ev.get("content").and_then(|x| x.as_str()) {
                        out.push(c.to_string());
                    }
                }
                Some("EOSE") => return Ok(()),
                Some("CLOSED") => anyhow::bail!("CLOSED"),
                _ => {}
            }
        }
        anyhow::bail!("закрыто")
    })
    .await;
    let _ = ws.close(None).await;
    match r {
        Ok(Ok(())) => Ok((out, max_ts)),
        Ok(Err(e)) => Err(e),
        // нет EOSE, но что-то пришло — берём (курсор не двигаем)
        Err(_) if !out.is_empty() => Ok((out, 0)),
        Err(_) => anyhow::bail!("нет EOSE"),
    }
}

fn event_matches(ev: &Value, tag: &str) -> bool {
    if ev.get("kind").and_then(|x| x.as_u64()) != Some(NOSTR_KIND) {
        return false;
    }
    let tags = ev.get("tags").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let has = |k: &str, v: &str| tags.iter().any(|t| t.get(0).and_then(|x| x.as_str()) == Some(k) && t.get(1).and_then(|x| x.as_str()) == Some(v));
    has("t", NOSTR_TAG) && has("z", tag)
}

async fn ntfy_put(base: &str, topic: &str, body: String) -> anyhow::Result<()> {
    let url = format!("{}/{topic}", base.trim_end_matches('/'));
    let r = crate::tls::http().post(url).body(body).timeout(HTTP_TIMEOUT).send().await?;
    anyhow::ensure!(r.status().is_success(), "HTTP {}", r.status());
    Ok(())
}

async fn ntfy_fetch(base: &str, topic: &str, since: &str) -> anyhow::Result<(Vec<String>, String)> {
    let since = if since.is_empty() { "12h" } else { since };
    let url = format!("{}/{topic}/json?poll=1&since={since}", base.trim_end_matches('/'));
    let r = crate::tls::http().get(url).timeout(HTTP_TIMEOUT).send().await?;
    anyhow::ensure!(r.status().is_success(), "HTTP {}", r.status());
    let text = r.text().await?;
    let mut out = Vec::new();
    let mut last = String::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("event").and_then(|x| x.as_str()) != Some("message") {
            continue;
        }
        if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
            last = id.to_string();
        }
        if let Some(m) = v.get("message").and_then(|x| x.as_str()) {
            out.push(m.to_string());
        }
    }
    Ok((out, last))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "AbCdEfGhIjKlMnOpQrStUv";

    #[test]
    fn addr_and_items() {
        let a = MailAddr::derive(SECRET).unwrap();
        assert_eq!(a.chat_id.len(), 64);
        assert!(a.ntfy_topic.starts_with(NTFY_PREFIX));
        let b = MailAddr::derive(SECRET).unwrap();
        assert_eq!(a.chat_id, b.chat_id);
        let fixed = a.seal(b"hello", true).unwrap();
        assert_eq!(fixed.len(), ITEM_BYTES);
        assert_eq!(b.open(&fixed).unwrap(), b"hello");
        let short = a.seal(b"hello", false).unwrap();
        assert!(short.len() < 200);
        assert_eq!(b.open(&short).unwrap(), b"hello");
        let big = vec![b'x'; MAX_PLAIN];
        assert_eq!(a.open(&a.seal(&big, true).unwrap()).unwrap(), big);
        assert!(a.seal(&vec![0; MAX_PLAIN + 1], true).is_none());
        let other = MailAddr::derive("ZZCdEfGhIjKlMnOpQrStUv").unwrap();
        assert!(other.open(&fixed).is_none());
    }

    /// Настоящие Worker, Nostr и ntfy (нужен интернет): `cargo test -p zv-signal live_mailbox -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_mailbox() {
        let mb = Mailbox::new(SignalConfig::default());
        let secret = zv_proto::link::new_secret();
        let a = MailAddr::derive(&secret).unwrap();
        let mut cur = Cursor::default();
        let t0 = std::time::Instant::now();
        let r = mb.fetch(&a, &mut cur, "live").await;
        println!("пустой fetch {:?}: worker {} nostr {} ntfy {} ошибки {:?}", t0.elapsed(), r.worker_ok, r.nostr_ok, r.ntfy_ok, r.errors);
        let t0 = std::time::Instant::now();
        let p = mb.put(&a, "привет из теста".as_bytes()).await;
        println!("put {:?}: {:?}", t0.elapsed(), p);
        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut cur2 = Cursor::default();
        let t0 = std::time::Instant::now();
        let r = mb.fetch(&a, &mut cur2, "live").await;
        let vias: Vec<_> = r.items.iter().map(|i| (i.via, String::from_utf8_lossy(&i.data).to_string())).collect();
        println!("fetch {:?}: {:?}; курсор {:?}; ошибки {:?}", t0.elapsed(), vias, cur2, r.errors);
        assert!(!r.items.is_empty());
    }

    #[cfg(feature = "mock")]
    #[tokio::test]
    async fn worker_roundtrip_with_mock() {
        let mock = crate::mock::MockWorker::spawn().await;
        let mut cfg = SignalConfig::default();
        cfg.worker_url = Some(mock.url.clone());
        cfg.nostr_relays.clear();
        cfg.ntfy_base = None;
        let mb = Mailbox::new(cfg);
        let a = MailAddr::derive(SECRET).unwrap();
        let mut cur = Cursor::default();
        let r = mb.fetch(&a, &mut cur, "dev1").await;
        assert!(r.worker_ok && r.items.is_empty(), "{:?}", r.errors);
        assert!(mb.put(&a, b"one").await.worker);
        assert!(mb.put(&a, b"two").await.worker);
        let r = mb.fetch(&a, &mut cur, "dev1").await;
        assert_eq!(r.items.iter().map(|i| i.data.clone()).collect::<Vec<_>>(), vec![b"one".to_vec(), b"two".to_vec()]);
        assert_eq!(cur.seq, 2);
        mb.ack(&a, &[1, 2], "dev1").await;
        assert!(mb.fetch(&a, &mut cur, "dev1").await.items.is_empty());
    }
}
