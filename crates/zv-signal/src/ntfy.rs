//! ntfy.sh — резервный «слепой» pub/sub веба: подписка WebSocket `…/<topic>/ws?since=<now-30>`,
//! публикация `POST …/<topic>`. Через ntfy идёт только рукопожатие (политика — в RoomHub).

use crate::chan::{ChanCmd, ChanHandle};
use crate::{ChanEvent, ChanTx, Kind, SignalConfig};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(40);
const DEAD_AFTER: Duration = Duration::from_secs(110);

/// Кадр подписки → текст сообщения (только `event == "message"`).
pub fn parse_frame(s: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    if v.get("event")?.as_str()? != "message" {
        return None;
    }
    Some(v.get("message")?.as_str()?.to_string())
}

pub fn subscribe_url(base: &str, topic: &str, now_s: u64) -> String {
    let b = base.trim_end_matches('/');
    let b = match b.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => b.to_string(),
    };
    format!("{b}/{topic}/ws?since={}", now_s.saturating_sub(30))
}

pub(crate) fn spawn(base: &str, room_topic: &str, cfg: &SignalConfig, hub: ChanTx) -> ChanHandle {
    let base = base.trim_end_matches('/').to_string();
    let host = url::Url::parse(&base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    let (h, mut cmd_rx, shared) = ChanHandle::new(Kind::Ntfy, &host);
    let topic = zv_proto::topics::ntfy_signaling_topic(room_topic);
    let ua = cfg.user_agent.clone();
    let post_url = format!("{base}/{topic}");
    tokio::spawn(async move {
        let mut attempt: u32 = 0;
        loop {
            let url = subscribe_url(&base, &topic, zv_proto::ids::now_ms() / 1000);
            let t0 = Instant::now();
            let conn = tokio::select! {
                r = crate::tls::ws_connect(&url, None, &ua, CONNECT_TIMEOUT) => Some(r),
                c = cmd_rx.recv() => {
                    match c {
                        Some(ChanCmd::Send(d, _)) => { post(&post_url, d, &shared); None }
                        Some(ChanCmd::Profile(_)) => None,
                        Some(ChanCmd::Close) | None => {
                            shared.set_up(false);
                            shared.with(|i| i.state = "off");
                            let _ = hub.send(ChanEvent::State);
                            return;
                        }
                    }
                }
            };
            let Some(conn) = conn else { continue };
            let mut lived = Duration::ZERO;
            match conn {
                Err(e) => shared.error(e),
                Ok(mut ws) => {
                    shared.set_up(true);
                    shared.with(|i| {
                        i.state = "up";
                        i.transport = "wss";
                        i.connects += 1;
                        i.connect_ms = Some(t0.elapsed().as_millis() as u32);
                    });
                    let _ = hub.send(ChanEvent::State);
                    let _ = hub.send(ChanEvent::Up);
                    let mut last_rx = Instant::now();
                    let mut tick = tokio::time::interval(PING_EVERY);
                    tick.tick().await;
                    let end = loop {
                        tokio::select! {
                            c = cmd_rx.recv() => match c {
                                Some(ChanCmd::Send(d, _)) => post(&post_url, d, &shared),
                                Some(ChanCmd::Profile(_)) => {}
                                Some(ChanCmd::Close) | None => { let _ = ws.close(None).await; break true; }
                            },
                            m = ws.next() => match m {
                                Some(Ok(Message::Text(t))) => {
                                    last_rx = Instant::now();
                                    if let Some(msg) = parse_frame(t.as_str()) {
                                        shared.with(|i| { i.rx += 1; i.last_rx = zv_proto::ids::now_ms(); });
                                        let _ = hub.send(ChanEvent::Data { data: msg, via: "ntfy" });
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break false,
                                Some(Ok(_)) => last_rx = Instant::now(),
                            },
                            _ = tick.tick() => {
                                if last_rx.elapsed() > DEAD_AFTER { break false; }
                                if ws.send(Message::Ping(Vec::new().into())).await.is_err() { break false; }
                            },
                        }
                    };
                    lived = t0.elapsed();
                    shared.set_up(false);
                    shared.with(|i| i.state = if end { "off" } else { "down" });
                    let _ = hub.send(ChanEvent::State);
                    if end {
                        return;
                    }
                }
            }
            if lived > Duration::from_secs(60) {
                attempt = 0;
            }
            attempt = attempt.saturating_add(1);
            let delay = crate::backoff(1200, 25_000, attempt);
            let until = Instant::now() + delay;
            // ждём переподключения, продолжая публиковать
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(until) => break,
                    c = cmd_rx.recv() => match c {
                        Some(ChanCmd::Send(d, _)) => post(&post_url, d, &shared),
                        Some(ChanCmd::Profile(_)) => {}
                        Some(ChanCmd::Close) | None => {
                            shared.with(|i| i.state = "off");
                            let _ = hub.send(ChanEvent::State);
                            return;
                        }
                    },
                }
            }
        }
    });
    h
}

fn post(url: &str, data: Arc<str>, shared: &Arc<crate::chan::Shared>) {
    if data.len() > zv_proto::topics::NTFY_MAX_BODY {
        return;
    }
    shared.with(|i| i.tx += 1);
    let url = url.to_string();
    let shared = shared.clone();
    tokio::spawn(async move {
        let r = crate::tls::http()
            .post(url)
            .body(data.to_string())
            .timeout(Duration::from_secs(10))
            .send()
            .await;
        match r {
            Ok(resp) if !resp.status().is_success() => {
                shared.error(format!("POST HTTP {}", resp.status()))
            }
            Err(e) => shared.error(format!("POST: {e}")),
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_and_urls() {
        assert_eq!(
            parse_frame(r#"{"id":"x","time":1,"event":"message","topic":"t","message":"z1.a.b"}"#)
                .as_deref(),
            Some("z1.a.b")
        );
        assert_eq!(parse_frame(r#"{"event":"keepalive"}"#), None);
        assert_eq!(
            subscribe_url("https://ntfy.sh/", "zv1-abc", 1000),
            "wss://ntfy.sh/zv1-abc/ws?since=970"
        );
    }
}
