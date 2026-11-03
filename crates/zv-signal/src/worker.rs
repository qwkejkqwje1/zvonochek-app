//! Cloudflare Worker веба: WebSocket `/room/<topic>?peer=…` (ping/pong, ротация 9 КБ, `&renew=1`)
//! + резервный HTTP-опрос `GET ?since=` и отправка `POST`.
//!
//! Режим ожидания (Listen): редкие ping (автоответ Worker бесплатен) и без HTTP-опроса в простое —
//! у бесплатного Worker лимит запросов в сутки.

use crate::chan::{ChanCmd, ChanHandle, Shared};
use crate::rotator::{ConnCmd, ConnEvent, ConnHandle, Out, Rotator, RotatorCfg, Spawner, sleep_until_opt};
use crate::{ChanEvent, ChanTx, Kind, Profile, SignalConfig};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_START_AFTER: Duration = Duration::from_millis(1800);
const POLL_EVERY: Duration = Duration::from_millis(1100);
const POLL_TIMEOUT: Duration = Duration::from_millis(4500);
const MAX_POST: usize = 180_000;

fn ping_timing(fast: bool) -> (Duration, Duration) {
    if fast {
        (Duration::from_millis(6500), Duration::from_secs(18))
    } else {
        (Duration::from_secs(30), Duration::from_secs(75))
    }
}

struct WsSpawner {
    base_ws: String,
    topic: String,
    peer: String,
    ua: String,
    fast: Arc<AtomicBool>,
    shared: Arc<Shared>,
}

impl Spawner for WsSpawner {
    fn spawn(&mut self, id: u64, renew: bool, events: mpsc::UnboundedSender<ConnEvent>) -> ConnHandle {
        let (h, cmd, bytes, _rotate) = ConnHandle::new(id);
        let url = format!(
            "{}/room/{}?peer={}{}",
            self.base_ws,
            self.topic,
            self.peer,
            if renew { "&renew=1" } else { "" }
        );
        let ua = self.ua.clone();
        let fast = self.fast.clone();
        let shared = self.shared.clone();
        tokio::spawn(async move {
            let r = ws_conn(id, &url, &ua, fast, cmd, &events, bytes, &shared).await;
            if let Err(e) = r {
                shared.error(e);
            }
            let _ = events.send(ConnEvent::Closed(id));
        });
        h
    }
}

#[allow(clippy::too_many_arguments)]
async fn ws_conn(
    id: u64,
    url: &str,
    ua: &str,
    fast: Arc<AtomicBool>,
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
    shared.with(|i| {
        i.transport = "wss";
        i.connect_ms = Some(t0.elapsed().as_millis() as u32);
        i.connects += 1;
    });
    let _ = ev.send(ConnEvent::Connected(id));
    let mut last_rx = Instant::now();
    let mut last_ping = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
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
                        let s = t.as_str();
                        if s == "pong" {
                            continue;
                        }
                        if s.starts_with('{')
                            && let Ok(v) = serde_json::from_str::<serde_json::Value>(s)
                            && v.get("type").and_then(|x| x.as_str()) == Some("sys:peer_joined")
                        {
                            let _ = ev.send(ConnEvent::PeerJoined(id));
                            continue;
                        }
                        bytes.fetch_add(s.len(), Ordering::Relaxed);
                        let _ = ev.send(ConnEvent::Data(id, s.to_string()));
                    }
                    Message::Close(_) => anyhow::bail!("closed by server"),
                    _ => {}
                }
            },
            _ = tick.tick() => {
                let (every, dead) = ping_timing(fast.load(Ordering::Relaxed));
                if last_rx.elapsed() > dead {
                    anyhow::bail!("no pong");
                }
                if last_ping.elapsed() >= every {
                    last_ping = Instant::now();
                    bytes.fetch_add(4, Ordering::Relaxed);
                    ws.send(Message::Text("ping".into())).await?;
                }
            },
        }
    }
}

enum PollEv {
    Ok,
    Data(String),
    Fail,
}

struct Worker {
    base: String,
    topic: String,
    peer: String,
    fast: Arc<AtomicBool>,
    profile: Profile,
    shared: Arc<Shared>,
    hub: ChanTx,
    cursor: Arc<AtomicU64>,
    poll: Option<tokio::task::JoinHandle<()>>,
    poll_tx: mpsc::UnboundedSender<PollEv>,
    http_state: &'static str,
    poll_start_at: Option<Instant>,
}

impl Worker {
    fn room_url(&self) -> String {
        format!("{}/room/{}?peer={}", self.base, self.topic, self.peer)
    }

    fn post(&self, data: Arc<str>) {
        if data.len() > MAX_POST {
            return;
        }
        let url = self.room_url();
        let shared = self.shared.clone();
        tokio::spawn(async move {
            let r = crate::tls::http()
                .post(url)
                .header("content-type", "text/plain;charset=UTF-8")
                .body(data.to_string())
                .timeout(Duration::from_secs(10))
                .send()
                .await;
            if let Err(e) = r {
                shared.error(format!("POST: {e}"));
            }
        });
    }

    fn start_poll(&mut self) {
        if self.poll.is_some() || self.profile == Profile::Listen {
            return;
        }
        self.http_state = "polling";
        self.update_info();
        let url_base = format!("{}/room/{}?peer={}&since=", self.base, self.topic, self.peer);
        let cursor = self.cursor.clone();
        let tx = self.poll_tx.clone();
        self.poll = Some(tokio::spawn(async move {
            loop {
                let since = cursor.load(Ordering::Relaxed);
                let url = format!("{url_base}{since}");
                let r = async {
                    let resp = crate::tls::http().get(&url).timeout(POLL_TIMEOUT).send().await?;
                    if !resp.status().is_success() {
                        anyhow::bail!("HTTP {}", resp.status());
                    }
                    let j: serde_json::Value = resp.json().await?;
                    Ok::<_, anyhow::Error>(j)
                }
                .await;
                match r {
                    Ok(j) => {
                        let _ = tx.send(PollEv::Ok);
                        if let Some(arr) = j.get("messages").and_then(|m| m.as_array()) {
                            for it in arr {
                                if let Some(ts) = it.get("ts").and_then(|t| t.as_u64())
                                    && ts > cursor.load(Ordering::Relaxed)
                                {
                                    cursor.store(ts, Ordering::Relaxed);
                                }
                                if let Some(d) = it.get("data").and_then(|d| d.as_str()) {
                                    let _ = tx.send(PollEv::Data(d.to_string()));
                                }
                            }
                        }
                        if let Some(now) = j.get("now").and_then(|t| t.as_u64())
                            && now > cursor.load(Ordering::Relaxed)
                        {
                            cursor.store(now, Ordering::Relaxed);
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(PollEv::Fail);
                    }
                }
                tokio::time::sleep(POLL_EVERY).await;
            }
        }));
    }

    fn stop_poll(&mut self) {
        if let Some(p) = self.poll.take() {
            p.abort();
        }
        self.http_state = "off";
        self.update_info();
    }

    fn update_info(&self) {
        let hs = self.http_state;
        self.shared.with(|i| i.http = Some(hs));
    }
}

/// Запустить канал Worker. `peer` — идентификатор этого ядра в комнате Worker.
pub(crate) fn spawn(base: &str, topic: &str, peer: &str, profile: Profile, cfg: &SignalConfig, hub: ChanTx) -> ChanHandle {
    let base = base.trim_end_matches('/').to_string();
    let host = url::Url::parse(&base).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let (h, mut cmd_rx, shared) = ChanHandle::new(Kind::Worker, &host);
    let fast = Arc::new(AtomicBool::new(profile == Profile::Full));
    let base_ws = if let Some(rest) = base.strip_prefix("http") { format!("ws{rest}") } else { base.clone() };
    let sp = WsSpawner {
        base_ws,
        topic: topic.to_string(),
        peer: peer.to_string(),
        ua: cfg.user_agent.clone(),
        fast: fast.clone(),
        shared: shared.clone(),
    };
    let rc = RotatorCfg {
        budget: 9000,
        renew_timeout: Duration::from_secs(12),
        close_old_after: Duration::from_secs(2),
        backoff: |a| crate::backoff(500, 12_000, a + 1),
    };
    let (mut rot, mut ev_rx) = Rotator::new(sp, rc);
    let (poll_tx, mut poll_rx) = mpsc::unbounded_channel();
    let mut w = Worker {
        base,
        topic: topic.to_string(),
        peer: peer.to_string(),
        fast,
        profile,
        shared: shared.clone(),
        hub: hub.clone(),
        cursor: Arc::new(AtomicU64::new(0)),
        poll: None,
        poll_tx,
        http_state: "off",
        poll_start_at: None,
    };
    w.update_info();
    tokio::spawn(async move {
        rot.start();
        if w.profile == Profile::Full {
            w.poll_start_at = Some(Instant::now() + POLL_START_AFTER);
        }
        loop {
            let dl = match (rot.deadline(), w.poll_start_at) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            tokio::select! {
                cmd = cmd_rx.recv() => match cmd {
                    Some(ChanCmd::Send(d, meta)) => {
                        let critical_dup = meta.critical && rot.active_bytes() > 7500;
                        let sent_ws = rot.send(d.clone());
                        if sent_ws {
                            w.shared.with(|i| i.tx += 1);
                            if critical_dup {
                                w.post(d);
                            }
                        } else if !meta.voice || meta.post_ok {
                            w.shared.with(|i| i.tx += 1);
                            w.post(d);
                        }
                    }
                    Some(ChanCmd::Profile(p)) => {
                        w.profile = p;
                        w.fast.store(p == Profile::Full, Ordering::Relaxed);
                        if p == Profile::Full && !rot.is_up() {
                            w.start_poll();
                        } else if p == Profile::Listen && w.poll.is_some() {
                            w.stop_poll();
                        }
                        let _ = w.hub.send(ChanEvent::State);
                    }
                    Some(ChanCmd::Close) | None => {
                        rot.close();
                        w.stop_poll();
                        w.shared.set_up(false);
                        w.shared.with(|i| i.state = "off");
                        let _ = w.hub.send(ChanEvent::State);
                        return;
                    }
                },
                Some(ev) = ev_rx.recv() => {
                    for o in rot.handle(ev) {
                        match o {
                            Out::Data(s) => {
                                w.shared.with(|i| { i.rx += 1; i.last_rx = zv_proto::ids::now_ms(); });
                                let _ = w.hub.send(ChanEvent::Data { data: s, via: "worker" });
                            }
                            Out::Up => {
                                let _ = w.hub.send(ChanEvent::Up);
                            }
                            Out::PeerJoined => {
                                let _ = w.hub.send(ChanEvent::PeerJoined);
                            }
                            Out::State => {
                                let up = rot.is_up();
                                w.shared.set_up(up);
                                let renewals = rot.renewals;
                                w.shared.with(|i| { i.state = if up { "up" } else { "down" }; i.renewals = renewals; });
                                if up {
                                    w.poll_start_at = None;
                                    if w.poll.is_some() { w.stop_poll(); }
                                } else if w.profile == Profile::Full {
                                    w.start_poll();
                                }
                                let _ = w.hub.send(ChanEvent::State);
                            }
                        }
                    }
                    let b = rot.active_bytes();
                    w.shared.with(|i| i.bytes = b);
                },
                Some(pe) = poll_rx.recv() => {
                    if w.poll.is_none() {
                        continue; // опрос уже остановлен
                    }
                    match pe {
                        PollEv::Ok => {
                            if w.http_state != "up" {
                                w.http_state = "up";
                                w.update_info();
                                let _ = w.hub.send(ChanEvent::State);
                                let _ = w.hub.send(ChanEvent::Up);
                            }
                        }
                        PollEv::Data(d) => {
                            w.shared.with(|i| { i.rx += 1; i.last_rx = zv_proto::ids::now_ms(); });
                            let _ = w.hub.send(ChanEvent::Data { data: d, via: "worker-http" });
                        }
                        PollEv::Fail => {
                            if w.http_state == "up" {
                                w.http_state = "polling";
                                w.update_info();
                                let _ = w.hub.send(ChanEvent::State);
                            }
                        }
                    }
                },
                _ = sleep_until_opt(dl) => {
                    rot.on_timer();
                    if let Some(t) = w.poll_start_at && t <= Instant::now() {
                        w.poll_start_at = None;
                        if !rot.is_up() {
                            w.start_poll();
                            let _ = w.hub.send(ChanEvent::State);
                        }
                    }
                },
            }
        }
    });
    h
}

/// «Маяк» выхода: POST `bye` в Worker (как `navigator.sendBeacon` веба).
pub async fn post_once(base: &str, topic: &str, peer: &str, data: String) -> anyhow::Result<()> {
    let url = format!("{}/room/{}?peer={}", base.trim_end_matches('/'), topic, peer);
    crate::tls::http()
        .post(url)
        .header("content-type", "text/plain;charset=UTF-8")
        .body(data)
        .timeout(Duration::from_secs(5))
        .send()
        .await?;
    Ok(())
}
