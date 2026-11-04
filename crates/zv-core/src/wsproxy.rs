//! Прокси WebSocket для встроенного веб-клиента (веб-чаты `#chat=` сайта): Worker отвергает чужой
//! Origin, а WebView шлёт его всегда (`https://tauri.localhost`). Ядро открывает сокет без Origin
//! (как и `fetch`, см. fetch.rs) и пересылает кадры событиями `ws:open` / `ws:msg` / `ws:close`.
//! Номер сокета выбирает страница (случайная строка): события приходят во все окна, и ответ на
//! `ws_open` не может разминуться с первым событием.

use crate::Inner;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

/// Не больше стольких сокетов сразу (чат держит один, страница с ошибкой не съест ресурсы).
const MAX_SOCKETS: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub(crate) enum Cmd {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

#[derive(Default)]
pub(crate) struct WsState {
    socks: HashMap<String, mpsc::UnboundedSender<Cmd>>,
}

/// Адрес сокета: `wss://` к тем же хостам, что разрешены для `fetch` (Worker, `*.workers.dev`);
/// в разработке — `ws://127.0.0.1` / `ws://localhost`.
pub fn allowed(url: &url::Url, worker_host: Option<&str>, dev: bool) -> bool {
    let mut u = url.clone();
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return false,
    };
    u.set_scheme(scheme).is_ok() && crate::fetch::allowed(&u, worker_host, dev)
}

fn valid_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn id_of(args: &Value) -> Result<&str, String> {
    args.get("id")
        .and_then(|v| v.as_str())
        .filter(|s| valid_id(s))
        .ok_or_else(|| "нет id сокета".to_string())
}

impl Inner {
    fn ws_lock(&self) -> std::sync::MutexGuard<'_, WsState> {
        self.ws.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `ws_open {id, url, protocols?}` → сразу `{id}`; дальше события `ws:open` / `ws:close`.
    pub(crate) fn ws_open(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let id = id_of(args)?.to_string();
        let url_s = args.get("url").and_then(|v| v.as_str()).ok_or("нет url")?;
        let url = url::Url::parse(url_s).map_err(|e| e.to_string())?;
        let wh = self.worker_host();
        if !allowed(&url, wh.as_deref(), self.opts.dev) {
            return Err(format!(
                "адрес не разрешён: {}",
                url.host_str().unwrap_or("")
            ));
        }
        let protos: Vec<String> = args
            .get("protocols")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|p| p.as_str())
                    .filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_graphic()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut st = self.ws_lock();
            if st.socks.contains_key(&id) {
                return Err("сокет с таким id уже есть".into());
            }
            if st.socks.len() >= MAX_SOCKETS {
                return Err("слишком много сокетов".into());
            }
            st.socks.insert(id.clone(), tx);
        }
        self.rt.spawn(run(
            Arc::downgrade(self),
            id.clone(),
            url.to_string(),
            protos,
            rx,
        ));
        Ok(json!({ "id": id }))
    }

    /// `ws_send {id, text}` или `{id, b64}`.
    pub(crate) fn ws_send(&self, args: &Value) -> Result<Value, String> {
        let id = id_of(args)?;
        let cmd = if let Some(t) = args.get("text").and_then(|v| v.as_str()) {
            Cmd::Text(t.to_string())
        } else if let Some(b) = args.get("b64").and_then(|v| v.as_str()) {
            Cmd::Binary(B64.decode(b).map_err(|e| e.to_string())?)
        } else {
            return Err("нечего отправлять".into());
        };
        let st = self.ws_lock();
        let tx = st.socks.get(id).ok_or("сокет закрыт")?;
        tx.send(cmd).map_err(|_| "сокет закрыт".to_string())?;
        Ok(Value::Null)
    }

    /// `ws_close {id, code?, reason?}` — закрыть (событие `ws:close` придёт после ответа сервера).
    pub(crate) fn ws_close(&self, args: &Value) -> Result<Value, String> {
        let id = id_of(args)?;
        let code = args
            .get("code")
            .and_then(|v| v.as_u64())
            .filter(|c| *c == 1000 || (3000..=4999).contains(c))
            .unwrap_or(1000) as u16;
        let reason: String = args
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(60)
            .collect();
        if let Some(tx) = self.ws_lock().socks.get(id) {
            let _ = tx.send(Cmd::Close(code, reason));
        }
        Ok(Value::Null)
    }
}

fn emit(w: &Weak<Inner>, event: &str, payload: Value) {
    if let Some(i) = w.upgrade() {
        i.emit(event, payload);
    }
}

fn closed(w: &Weak<Inner>, id: &str, code: u16, reason: &str, clean: bool) {
    if let Some(i) = w.upgrade() {
        i.ws_lock().socks.remove(id);
        i.emit(
            "ws:close",
            json!({"id": id, "code": code, "reason": reason, "clean": clean}),
        );
    }
}

async fn run(
    w: Weak<Inner>,
    id: String,
    url: String,
    protos: Vec<String>,
    mut rx: mpsc::UnboundedReceiver<Cmd>,
) {
    let proto = (!protos.is_empty()).then(|| protos.join(", "));
    let ua = format!("ZVONochek-Desktop/{}", env!("CARGO_PKG_VERSION"));
    let conn = tokio::select! {
        r = zv_signal::tls::ws_connect(&url, proto.as_deref(), &ua, CONNECT_TIMEOUT) => r,
        // закрыли, не дождавшись подключения
        _ = rx.recv() => {
            closed(&w, &id, 1006, "", false);
            return;
        }
    };
    let ws = match conn {
        Ok(ws) => ws,
        Err(e) => {
            tracing::info!("ws {url}: {e}");
            closed(&w, &id, 1006, "", false);
            return;
        }
    };
    emit(&w, "ws:open", json!({"id": id, "protocol": ""}));
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
            m = stream.next() => match m {
                Some(Ok(Message::Text(t))) => emit(&w, "ws:msg", json!({"id": id, "text": t.as_str()})),
                Some(Ok(Message::Binary(b))) => emit(&w, "ws:msg", json!({"id": id, "b64": B64.encode(&b)})),
                Some(Ok(Message::Close(f))) => {
                    let (code, reason) = f
                        .map(|f| (u16::from(f.code), f.reason.as_str().to_string()))
                        .unwrap_or((1005, String::new()));
                    // ответный Close шлёт tungstenite; дождаться, пока он уйдёт
                    let _ = tokio::time::timeout(Duration::from_secs(2), sink.flush()).await;
                    closed(&w, &id, code, &reason, true);
                    return;
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    tracing::info!("ws {url}: {e}");
                    closed(&w, &id, 1006, "", false);
                    return;
                }
                None => {
                    closed(&w, &id, 1006, "", false);
                    return;
                }
            },
            c = rx.recv() => {
                let r = match c {
                    Some(Cmd::Text(t)) => sink.send(Message::Text(t.into())).await,
                    Some(Cmd::Binary(b)) => sink.send(Message::Binary(b.into())).await,
                    Some(Cmd::Close(code, reason)) => {
                        let frame = CloseFrame { code: code.into(), reason: reason.clone().into() };
                        let _ = sink.send(Message::Close(Some(frame))).await;
                        // ответ сервера (его Close) — не дольше 3 с
                        let _ = tokio::time::timeout(Duration::from_secs(3), async {
                            while let Some(Ok(m)) = stream.next().await {
                                if matches!(m, Message::Close(_)) {
                                    break;
                                }
                            }
                        })
                        .await;
                        closed(&w, &id, code, &reason, true);
                        return;
                    }
                    // ядро останавливается
                    None => {
                        let _ = sink.send(Message::Close(None)).await;
                        return;
                    }
                };
                if let Err(e) = r {
                    tracing::info!("ws {url}: {e}");
                    closed(&w, &id, 1006, "", false);
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(allowed(
            &u("wss://zvonochek.zerewgwe.workers.dev/chat/abc/listen"),
            None,
            false
        ));
        assert!(!allowed(
            &u("ws://zvonochek.zerewgwe.workers.dev/chat/abc/listen"),
            None,
            false
        ));
        assert!(!allowed(&u("wss://relay.example/"), None, false));
        assert!(allowed(&u("wss://my.example/x"), Some("my.example"), false));
        assert!(!allowed(&u("ws://127.0.0.1:8787/x"), None, false));
        assert!(allowed(&u("ws://127.0.0.1:8787/x"), None, true));
        assert!(!allowed(
            &u("https://zvonochek.zerewgwe.workers.dev/"),
            None,
            false
        ));
    }

    #[test]
    fn ids() {
        assert!(valid_id("abcDEF12-_"));
        assert!(!valid_id("short"));
        assert!(!valid_id("bad id with spaces"));
        assert!(!valid_id(&"x".repeat(65)));
    }
}
