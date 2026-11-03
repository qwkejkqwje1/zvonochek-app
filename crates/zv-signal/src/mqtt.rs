//! MQTT 3.1.1 (QoS 0) — свой компактный клиент: WSS (подпротокол `mqtt`, как mqtt.js веба)
//! и TCP 1883 (только приложение). Обе попытки идут параллельно, побеждает первая, получившая CONNACK.
//! Через TCP ротация не нужна (ТСПУ «замораживает» TLS), через WSS — бюджет 9000 байт как в вебе.

use crate::chan::{ChanHandle, Shared, run_rotating};
use crate::rotator::{ConnCmd, ConnEvent, ConnHandle, Rotator, RotatorCfg, Spawner};
use crate::{BrokerSpec, ChanTx, Kind, SignalConfig};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(7);
const KEEPALIVE_S: u16 = 30;
const PING_EVERY: Duration = Duration::from_secs(12);
const PONG_WAIT: Duration = Duration::from_secs(10);
const MAX_PACKET: usize = 1 << 20;

// ---------- кодек ----------

fn put_len(out: &mut Vec<u8>, mut n: usize) {
    loop {
        let mut b = (n % 128) as u8;
        n /= 128;
        if n > 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            break;
        }
    }
}

fn put_str(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u16).to_be_bytes());
    out.extend_from_slice(s);
}

fn packet(header: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 5);
    out.push(header);
    put_len(&mut out, body.len());
    out.extend_from_slice(body);
    out
}

pub fn encode_connect(
    client_id: &str,
    user: Option<&str>,
    pass: Option<&str>,
    keepalive: u16,
) -> Vec<u8> {
    let mut b = Vec::new();
    put_str(&mut b, b"MQTT");
    b.push(4); // 3.1.1
    let mut flags = 0x02; // clean session
    if user.is_some() {
        flags |= 0x80;
    }
    if pass.is_some() {
        flags |= 0x40;
    }
    b.push(flags);
    b.extend_from_slice(&keepalive.to_be_bytes());
    put_str(&mut b, client_id.as_bytes());
    if let Some(u) = user {
        put_str(&mut b, u.as_bytes());
    }
    if let Some(p) = pass {
        put_str(&mut b, p.as_bytes());
    }
    packet(0x10, &b)
}

pub fn encode_subscribe(packet_id: u16, topic: &str) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&packet_id.to_be_bytes());
    put_str(&mut b, topic.as_bytes());
    b.push(0); // QoS 0
    packet(0x82, &b)
}

pub fn encode_publish(topic: &str, payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(topic.len() + 2 + payload.len());
    put_str(&mut b, topic.as_bytes());
    b.extend_from_slice(payload);
    packet(0x30, &b)
}

const PINGREQ: [u8; 2] = [0xC0, 0x00];
const DISCONNECT: [u8; 2] = [0xE0, 0x00];

/// Достать из буфера один пакет: `(первый байт, тело)`. `Ok(None)` — данных пока мало.
pub fn take_packet(buf: &mut Vec<u8>) -> anyhow::Result<Option<(u8, Vec<u8>)>> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let mut len = 0usize;
    let mut mul = 1usize;
    let mut i = 1;
    loop {
        if i >= buf.len() {
            return Ok(None);
        }
        let b = buf[i];
        len += (b & 0x7f) as usize * mul;
        i += 1;
        if b & 0x80 == 0 {
            break;
        }
        mul *= 128;
        if i > 4 {
            anyhow::bail!("bad remaining length");
        }
    }
    if len > MAX_PACKET {
        anyhow::bail!("packet too large");
    }
    if buf.len() < i + len {
        return Ok(None);
    }
    let h = buf[0];
    let body = buf[i..i + len].to_vec();
    buf.drain(..i + len);
    Ok(Some((h, body)))
}

/// Разбор PUBLISH: `(qos, packet_id, payload)`.
pub fn parse_publish(h: u8, body: &[u8]) -> Option<(u8, Option<u16>, &[u8])> {
    let qos = (h >> 1) & 3;
    if body.len() < 2 {
        return None;
    }
    let tl = u16::from_be_bytes([body[0], body[1]]) as usize;
    let mut p = 2 + tl;
    if body.len() < p {
        return None;
    }
    let pid = if qos > 0 {
        if body.len() < p + 2 {
            return None;
        }
        let id = u16::from_be_bytes([body[p], body[p + 1]]);
        p += 2;
        Some(id)
    } else {
        None
    };
    Some((qos, pid, &body[p..]))
}

// ---------- транспорт ----------

enum Io {
    Tcp(tokio::net::TcpStream),
    Ws(Box<crate::tls::Ws>),
}

impl Io {
    async fn write(&mut self, b: Vec<u8>) -> anyhow::Result<()> {
        match self {
            Io::Tcp(s) => {
                s.write_all(&b).await?;
                Ok(())
            }
            Io::Ws(w) => {
                w.send(Message::Binary(b.into())).await?;
                Ok(())
            }
        }
    }

    /// Прочитать порцию байт в буфер. `Ok(0)` — соединение закрыто.
    async fn read(&mut self, buf: &mut Vec<u8>) -> anyhow::Result<usize> {
        match self {
            Io::Tcp(s) => {
                let mut tmp = [0u8; 16384];
                let n = s.read(&mut tmp).await?;
                buf.extend_from_slice(&tmp[..n]);
                Ok(n)
            }
            Io::Ws(w) => loop {
                match w.next().await {
                    None => return Ok(0),
                    Some(Err(e)) => return Err(e.into()),
                    Some(Ok(Message::Binary(b))) => {
                        buf.extend_from_slice(&b);
                        if b.is_empty() {
                            continue;
                        }
                        return Ok(b.len());
                    }
                    Some(Ok(Message::Text(t))) => {
                        buf.extend_from_slice(t.as_bytes());
                        return Ok(t.len().max(1));
                    }
                    Some(Ok(Message::Close(_))) => return Ok(0),
                    Some(Ok(_)) => continue, // ping/pong — tungstenite отвечает сам
                }
            },
        }
    }

    fn is_tcp(&self) -> bool {
        matches!(self, Io::Tcp(_))
    }
}

struct Session {
    io: Io,
    buf: Vec<u8>,
    connect_ms: u32,
}

async fn handshake(mut io: Io, spec: &BrokerSpec, topic: &str) -> anyhow::Result<(Io, Vec<u8>)> {
    let cid = format!("zv_{}", zv_proto::ids::rand_hex(5));
    io.write(encode_connect(
        &cid,
        spec.username.as_deref(),
        spec.password.as_deref(),
        KEEPALIVE_S,
    ))
    .await?;
    let mut buf = Vec::new();
    loop {
        if let Some((h, body)) = take_packet(&mut buf)? {
            if h >> 4 == 2 {
                let rc = body.get(1).copied().unwrap_or(255);
                if rc != 0 {
                    anyhow::bail!("CONNACK rc={rc}");
                }
                break;
            }
            continue;
        }
        if io.read(&mut buf).await? == 0 {
            anyhow::bail!("closed before CONNACK");
        }
    }
    io.write(encode_subscribe(1, topic)).await?;
    Ok((io, buf))
}

async fn connect_tcp(addr: String, spec: BrokerSpec, topic: String) -> anyhow::Result<Session> {
    let t0 = Instant::now();
    let fut = async {
        let s = tokio::net::TcpStream::connect(&addr).await?;
        let _ = s.set_nodelay(true);
        handshake(Io::Tcp(s), &spec, &topic).await
    };
    let (io, buf) = tokio::time::timeout(CONNECT_TIMEOUT, fut)
        .await
        .map_err(|_| anyhow::anyhow!("tcp timeout"))??;
    Ok(Session {
        io,
        buf,
        connect_ms: t0.elapsed().as_millis() as u32,
    })
}

async fn connect_wss(spec: BrokerSpec, topic: String, ua: String) -> anyhow::Result<Session> {
    let t0 = Instant::now();
    let fut = async {
        let ws = crate::tls::ws_connect(&spec.wss, Some("mqtt"), &ua, CONNECT_TIMEOUT).await?;
        handshake(Io::Ws(Box::new(ws)), &spec, &topic).await
    };
    let (io, buf) = tokio::time::timeout(CONNECT_TIMEOUT, fut)
        .await
        .map_err(|_| anyhow::anyhow!("wss timeout"))??;
    Ok(Session {
        io,
        buf,
        connect_ms: t0.elapsed().as_millis() as u32,
    })
}

async fn connect_any(
    spec: &BrokerSpec,
    topic: &str,
    tcp: bool,
    ua: &str,
) -> anyhow::Result<Session> {
    let mut tries: Vec<std::pin::Pin<Box<dyn Future<Output = anyhow::Result<Session>> + Send>>> =
        Vec::new();
    tries.push(Box::pin(connect_wss(
        spec.clone(),
        topic.to_string(),
        ua.to_string(),
    )));
    if tcp && let Some(addr) = &spec.tcp {
        tries.push(Box::pin(connect_tcp(
            addr.clone(),
            spec.clone(),
            topic.to_string(),
        )));
    }
    let (s, _rest) = futures_util::future::select_ok(tries).await?;
    Ok(s)
}

struct ConnCtx {
    id: u64,
    spec: BrokerSpec,
    topic: String,
    tcp: bool,
    ua: String,
    cmd: mpsc::UnboundedReceiver<ConnCmd>,
    ev: mpsc::UnboundedSender<ConnEvent>,
    bytes: Arc<std::sync::atomic::AtomicUsize>,
    rotate: Arc<std::sync::atomic::AtomicBool>,
    shared: Arc<Shared>,
}

async fn conn_task(mut c: ConnCtx) {
    let sess = tokio::select! {
        r = connect_any(&c.spec, &c.topic, c.tcp, &c.ua) => r,
        _ = wait_close(&mut c.cmd) => { let _ = c.ev.send(ConnEvent::Closed(c.id)); return; }
    };
    let mut s = match sess {
        Ok(s) => s,
        Err(e) => {
            c.shared.error(e);
            let _ = c.ev.send(ConnEvent::Closed(c.id));
            return;
        }
    };
    let tcp = s.io.is_tcp();
    c.rotate.store(!tcp, Ordering::Relaxed);
    c.shared.with(|i| {
        i.transport = if tcp { "tcp" } else { "wss" };
        i.connect_ms = Some(s.connect_ms);
        i.connects += 1;
    });
    let _ = c.ev.send(ConnEvent::Connected(c.id));
    let r = run(&mut c, &mut s).await;
    if let Err(e) = r {
        c.shared.error(e);
    }
    let _ = c.ev.send(ConnEvent::Closed(c.id));
}

async fn wait_close(cmd: &mut mpsc::UnboundedReceiver<ConnCmd>) {
    loop {
        match cmd.recv().await {
            Some(ConnCmd::Close) | None => return,
            Some(ConnCmd::Send(_)) => {} // ещё не подключены — канал не считается поднятым
        }
    }
}

async fn run(c: &mut ConnCtx, s: &mut Session) -> anyhow::Result<()> {
    // ping_at — когда отправлен PINGREQ, на который ещё ничего не пришло
    let mut ping_at: Option<Instant> = None;
    let mut last_ping = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    // пакеты, пришедшие вместе с CONNACK
    drain(c, s).await?;
    loop {
        tokio::select! {
            cmd = c.cmd.recv() => match cmd {
                Some(ConnCmd::Send(d)) => {
                    c.bytes.fetch_add(d.len(), Ordering::Relaxed);
                    s.io.write(encode_publish(&c.topic, d.as_bytes())).await?;
                }
                Some(ConnCmd::Close) | None => {
                    let _ = s.io.write(DISCONNECT.to_vec()).await;
                    return Ok(());
                }
            },
            n = s.io.read(&mut s.buf) => {
                if n? == 0 {
                    anyhow::bail!("closed by broker");
                }
                ping_at = None;
                drain(c, s).await?;
            },
            _ = tick.tick() => {
                if let Some(t) = ping_at
                    && t.elapsed() > PONG_WAIT
                {
                    anyhow::bail!("no PINGRESP");
                }
                if last_ping.elapsed() >= PING_EVERY {
                    s.io.write(PINGREQ.to_vec()).await?;
                    last_ping = Instant::now();
                    if ping_at.is_none() {
                        ping_at = Some(last_ping);
                    }
                }
            },
        }
    }
}

async fn drain(c: &mut ConnCtx, s: &mut Session) -> anyhow::Result<()> {
    while let Some((h, body)) = take_packet(&mut s.buf)? {
        match h >> 4 {
            3 => {
                if let Some((qos, pid, payload)) = parse_publish(h, &body) {
                    c.bytes.fetch_add(payload.len(), Ordering::Relaxed);
                    if let Some(id) = pid {
                        let ack = if qos == 1 { 0x40 } else { 0x50 };
                        s.io.write(vec![ack, 2, (id >> 8) as u8, id as u8]).await?;
                    }
                    if let Ok(text) = std::str::from_utf8(payload) {
                        let _ = c.ev.send(ConnEvent::Data(c.id, text.to_string()));
                    }
                }
            }
            // PUBREL (QoS 2) → PUBCOMP
            6 if body.len() >= 2 => {
                s.io.write(vec![0x70, 2, body[0], body[1]]).await?;
            }
            _ => {} // SUBACK, PINGRESP, PUBACK…
        }
    }
    Ok(())
}

struct MqttSpawner {
    spec: BrokerSpec,
    topic: String,
    tcp: bool,
    ua: String,
    shared: Arc<Shared>,
}

impl Spawner for MqttSpawner {
    fn spawn(
        &mut self,
        id: u64,
        _renew: bool,
        events: mpsc::UnboundedSender<ConnEvent>,
    ) -> ConnHandle {
        let (h, cmd, bytes, rotate) = ConnHandle::new(id);
        let ctx = ConnCtx {
            id,
            spec: self.spec.clone(),
            topic: self.topic.clone(),
            tcp: self.tcp,
            ua: self.ua.clone(),
            cmd,
            ev: events,
            bytes,
            rotate,
            shared: self.shared.clone(),
        };
        tokio::spawn(conn_task(ctx));
        h
    }
}

/// Запустить канал MQTT к одному брокеру.
pub(crate) fn spawn(spec: &BrokerSpec, topic: &str, cfg: &SignalConfig, hub: ChanTx) -> ChanHandle {
    let (h, cmd_rx, shared) = ChanHandle::new(Kind::Mqtt, &spec.host());
    let sp = MqttSpawner {
        spec: spec.clone(),
        topic: zv_proto::topics::mqtt_topic(topic),
        tcp: cfg.mqtt_tcp,
        ua: cfg.user_agent.clone(),
        shared: shared.clone(),
    };
    let rc = RotatorCfg {
        budget: 9000,
        renew_timeout: Duration::from_secs(12),
        close_old_after: Duration::from_secs(2),
        backoff: |_| Duration::from_millis(3500),
    };
    let (rot, ev_rx) = Rotator::new(sp, rc);
    tokio::spawn(run_rotating(rot, ev_rx, cmd_rx, hub, shared, "mqtt"));
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_packets() {
        let p = encode_publish("zvonochek/v1/abc", b"hello");
        let mut buf = p.clone();
        buf.extend_from_slice(&PINGREQ);
        let (h, body) = take_packet(&mut buf).unwrap().unwrap();
        assert_eq!(h, 0x30);
        let (qos, pid, payload) = parse_publish(h, &body).unwrap();
        assert_eq!((qos, pid, payload), (0, None, &b"hello"[..]));
        let (h2, b2) = take_packet(&mut buf).unwrap().unwrap();
        assert_eq!((h2, b2.len()), (0xC0, 0));
        assert!(buf.is_empty());
    }

    #[test]
    fn long_remaining_length() {
        let payload = vec![b'x'; 200_000];
        let mut buf = encode_publish("t", &payload);
        // неполный пакет
        let mut part = buf[..1000].to_vec();
        assert!(take_packet(&mut part).unwrap().is_none());
        let (_, body) = take_packet(&mut buf).unwrap().unwrap();
        assert_eq!(parse_publish(0x30, &body).unwrap().2.len(), 200_000);
    }

    #[test]
    fn connect_layout() {
        let c = encode_connect("zv_0123456789", Some("public"), Some("public"), 30);
        assert_eq!(c[0], 0x10);
        assert_eq!(&c[2..8], b"\x00\x04MQTT");
        assert_eq!(c[8], 4);
        assert_eq!(c[9], 0xC2);
    }
}
