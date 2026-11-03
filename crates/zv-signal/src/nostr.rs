//! Публичные Nostr-реле: эфемерные события kind 29333 с тегом `t` = `zv-<topic>`,
//! подписанные одноразовым ключом (BIP-340), как в вебе. Ротация соединения после 9 КБ.

use crate::chan::{ChanHandle, Shared, run_rotating};
use crate::rotator::{ConnCmd, ConnEvent, ConnHandle, Rotator, RotatorCfg, Spawner};
use crate::{ChanTx, Kind, SignalConfig};
use futures_util::{SinkExt, StreamExt};
use k256::schnorr::SigningKey;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;

pub const KIND: u64 = 29333;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(25);
const DEAD_AFTER: Duration = Duration::from_secs(70);

/// Одноразовый ключ Nostr (на комнату, как `nsk` в Signaling веба).
pub struct NostrKey {
    sk: SigningKey,
    pub pubkey: String,
}

impl Default for NostrKey {
    fn default() -> Self {
        Self::random()
    }
}

impl NostrKey {
    pub fn random() -> NostrKey {
        loop {
            let mut b = [0u8; 32];
            rand::fill(&mut b);
            if let Ok(sk) = SigningKey::from_bytes(&b.into()) {
                let pubkey = hex::encode(sk.verifying_key().to_bytes());
                return NostrKey { sk, pubkey };
            }
        }
    }

    /// Кадр `["EVENT", {...}]` с содержимым `content`.
    pub fn event(&self, content: &str, ntag: &str, created_at: u64) -> String {
        let tags = serde_json::json!([["t", ntag]]);
        self.event_kind(KIND, tags, content, created_at).1
    }

    /// Событие любого вида: (id, кадр `["EVENT", {...}]`).
    pub fn event_kind(
        &self,
        kind: u64,
        tags: serde_json::Value,
        content: &str,
        created_at: u64,
    ) -> (String, String) {
        let ser = serde_json::to_string(&serde_json::json!([
            0,
            self.pubkey,
            created_at,
            kind,
            tags,
            content
        ]))
        .expect("json");
        let id: [u8; 32] = Sha256::digest(ser.as_bytes()).into();
        let mut aux = [0u8; 32];
        rand::fill(&mut aux);
        let sig = self.sk.sign_raw(&id, &aux).expect("schnorr");
        let ev = serde_json::json!({
            "pubkey": self.pubkey,
            "created_at": created_at,
            "kind": kind,
            "tags": tags,
            "content": content,
            "id": hex::encode(id),
            "sig": hex::encode(sig.to_bytes()),
        });
        (
            hex::encode(id),
            serde_json::to_string(&serde_json::json!(["EVENT", ev])).expect("json"),
        )
    }
}

/// Проверка подписи события (для тестов и приёма хранимых событий почтового ящика).
pub fn verify_event(ev: &serde_json::Value) -> bool {
    let get = |k: &str| ev.get(k);
    let (Some(pk), Some(ca), Some(kind), Some(tags), Some(content), Some(id), Some(sig)) = (
        get("pubkey").and_then(|v| v.as_str()),
        get("created_at").and_then(|v| v.as_u64()),
        get("kind").and_then(|v| v.as_u64()),
        get("tags"),
        get("content").and_then(|v| v.as_str()),
        get("id").and_then(|v| v.as_str()),
        get("sig").and_then(|v| v.as_str()),
    ) else {
        return false;
    };
    let ser = match serde_json::to_string(&serde_json::json!([0, pk, ca, kind, tags, content])) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let digest: [u8; 32] = Sha256::digest(ser.as_bytes()).into();
    if hex::encode(digest) != id {
        return false;
    }
    let (Ok(pkb), Ok(sigb)) = (hex::decode(pk), hex::decode(sig)) else {
        return false;
    };
    let (Ok(pkb), Ok(sigb)) = (
        <[u8; 32]>::try_from(pkb.as_slice()),
        <[u8; 64]>::try_from(sigb.as_slice()),
    ) else {
        return false;
    };
    let Ok(vk) = k256::schnorr::VerifyingKey::from_bytes(&pkb.into()) else {
        return false;
    };
    let Ok(sig) = k256::schnorr::Signature::from_bytes(&sigb) else {
        return false;
    };
    vk.verify_raw(&digest, &sig).is_ok()
}

struct NostrSpawner {
    url: String,
    ntag: String,
    own_pk: Arc<str>,
    ua: String,
    shared: Arc<Shared>,
}

impl Spawner for NostrSpawner {
    fn spawn(
        &mut self,
        id: u64,
        _renew: bool,
        events: mpsc::UnboundedSender<ConnEvent>,
    ) -> ConnHandle {
        let (h, cmd, bytes, _rotate) = ConnHandle::new(id);
        let url = self.url.clone();
        let ntag = self.ntag.clone();
        let own = self.own_pk.clone();
        let ua = self.ua.clone();
        let shared = self.shared.clone();
        tokio::spawn(async move {
            if let Err(e) = conn(id, &url, &ntag, &own, &ua, cmd, &events, bytes, &shared).await {
                shared.error(e);
            }
            let _ = events.send(ConnEvent::Closed(id));
        });
        h
    }
}

#[allow(clippy::too_many_arguments)]
async fn conn(
    id: u64,
    url: &str,
    ntag: &str,
    own_pk: &str,
    ua: &str,
    mut cmd: mpsc::UnboundedReceiver<ConnCmd>,
    ev: &mpsc::UnboundedSender<ConnEvent>,
    bytes: Arc<std::sync::atomic::AtomicUsize>,
    shared: &Shared,
) -> anyhow::Result<()> {
    let t0 = Instant::now();
    let mut ws = tokio::select! {
        r = crate::tls::ws_connect(url, None, ua, CONNECT_TIMEOUT) => r?,
        _ = async { loop { match cmd.recv().await { Some(ConnCmd::Close) | None => break, _ => {} } } } => return Ok(()),
    };
    let since = zv_proto::ids::now_ms() / 1000 - 60;
    let req = serde_json::json!(["REQ", "zv", {"kinds": [KIND], "#t": [ntag], "since": since}]);
    ws.send(Message::Text(req.to_string().into())).await?;
    shared.with(|i| {
        i.transport = "wss";
        i.connect_ms = Some(t0.elapsed().as_millis() as u32);
        i.connects += 1;
    });
    let _ = ev.send(ConnEvent::Connected(id));
    let mut last_rx = Instant::now();
    let mut tick = tokio::time::interval(PING_EVERY);
    tick.tick().await;
    loop {
        tokio::select! {
            c = cmd.recv() => match c {
                Some(ConnCmd::Send(d)) => {
                    bytes.fetch_add(d.len(), Ordering::Relaxed);
                    ws.send(Message::Text(d.as_ref().into())).await?;
                }
                Some(ConnCmd::Close) | None => {
                    let _ = ws.close(None).await;
                    return Ok(());
                }
            },
            m = ws.next() => {
                let m = match m {
                    None => anyhow::bail!("closed"),
                    Some(Err(e)) => return Err(e.into()),
                    Some(Ok(m)) => m,
                };
                last_rx = Instant::now();
                match m {
                    Message::Text(t) => {
                        bytes.fetch_add(t.len(), Ordering::Relaxed);
                        if let Some(content) = event_content(t.as_str(), own_pk) {
                            let _ = ev.send(ConnEvent::Data(id, content));
                        }
                    }
                    Message::Close(_) => anyhow::bail!("closed by relay"),
                    _ => {}
                }
            },
            _ = tick.tick() => {
                if last_rx.elapsed() > DEAD_AFTER {
                    anyhow::bail!("relay silent");
                }
                ws.send(Message::Ping(Vec::new().into())).await?;
            },
        }
    }
}

/// Содержимое чужого события нашего вида из кадра реле.
fn event_content(frame: &str, own_pk: &str) -> Option<String> {
    if !frame.starts_with("[\"EVENT\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(frame).ok()?;
    let e = v.get(2)?;
    if e.get("kind")?.as_u64()? != KIND {
        return None;
    }
    if e.get("pubkey").and_then(|p| p.as_str()) == Some(own_pk) {
        return None;
    }
    Some(e.get("content")?.as_str()?.to_string())
}

/// Запустить канал к одному реле. Отправляемые пакеты — уже готовые кадры `["EVENT", …]`.
pub(crate) fn spawn(
    url: &str,
    topic: &str,
    own_pk: Arc<str>,
    cfg: &SignalConfig,
    hub: ChanTx,
) -> ChanHandle {
    let name = url.trim_start_matches("wss://").trim_end_matches('/');
    let (h, cmd_rx, shared) = ChanHandle::new(Kind::Nostr, name);
    let sp = NostrSpawner {
        url: url.to_string(),
        ntag: zv_proto::topics::nostr_tag(topic),
        own_pk,
        ua: cfg.user_agent.clone(),
        shared: shared.clone(),
    };
    let rc = RotatorCfg {
        budget: 9000,
        renew_timeout: Duration::from_secs(12),
        close_old_after: Duration::from_secs(2),
        backoff: |a| crate::backoff(900, 25_000, a),
    };
    let (rot, ev_rx) = Rotator::new(sp, rc);
    tokio::spawn(run_rotating(rot, ev_rx, cmd_rx, hub, shared, "nostr"));
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn event_signature_verifies() {
        let k = NostrKey::random();
        let frame = k.event("z1.abc.def", "zv-0123", 1_700_000_000);
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v[0], "EVENT");
        assert!(verify_event(&v[1]));
        let mut bad = v[1].clone();
        bad["content"] = "z1.other".into();
        assert!(!verify_event(&bad));
        assert_eq!(
            event_content(&format!("[\"EVENT\",\"zv\",{}]", v[1]), "other").as_deref(),
            Some("z1.abc.def")
        );
        assert_eq!(
            event_content(&format!("[\"EVENT\",\"zv\",{}]", v[1]), &k.pubkey),
            None
        );
    }
}
