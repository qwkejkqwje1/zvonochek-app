//! zv-cli — консольная проверка каналов и протокола.
//!
//! zv-cli probe [секрет]        два ядра в одной комнате: доставка по каналам, задержки
//! zv-cli join <ссылка> [имя]   войти в комнату и печатать сообщения (hello каждые 4,5 с, как веб)
//! zv-cli listen <ссылка>       режим ожидания «моей ссылки»

use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use zv_signal::{HubEvent, Profile, RoomHub, SendOpts, SignalConfig};

fn room_from(arg: Option<String>) -> anyhow::Result<(String, zv_proto::Room)> {
    let secret = match arg {
        Some(a) => zv_proto::parse_link(&a)
            .and_then(|l| l.secret().map(str::to_string))
            .ok_or_else(|| anyhow::anyhow!("не ссылка звонка"))?,
        None => zv_proto::link::new_secret(),
    };
    let room = zv_proto::Room::derive(&secret)?;
    Ok((secret, room))
}

fn cfg_from_env() -> SignalConfig {
    let mut c = SignalConfig::default();
    if let Ok(only) = std::env::var("ZV_ONLY") {
        // ZV_ONLY=mqtt,worker,nostr,ntfy — оставить только эти каналы
        let has = |k: &str| only.split(',').any(|x| x == k);
        if !has("mqtt") {
            c.brokers.clear();
        }
        if !has("worker") {
            c.worker_url = None;
        }
        if !has("nostr") {
            c.nostr_relays.clear();
        }
        if !has("ntfy") {
            c.ntfy_base = None;
        }
    }
    if std::env::var("ZV_NO_TCP").is_ok() {
        c.mqtt_tcp = false;
    }
    c
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_default();
    match cmd.as_str() {
        "probe" => probe(args.next()).await,
        "join" => join(args.next(), args.next(), Profile::Full).await,
        "listen" => join(args.next(), None, Profile::Listen).await,
        _ => {
            eprintln!("использование: zv-cli probe [секрет] | join <ссылка> [имя] | listen <ссылка>");
            Ok(())
        }
    }
}

async fn probe(secret: Option<String>) -> anyhow::Result<()> {
    let (_s, room) = room_from(secret)?;
    let cfg = Arc::new(cfg_from_env());
    let (ta, mut ra) = mpsc::unbounded_channel();
    let (tb, mut rb) = mpsc::unbounded_channel();
    let a = RoomHub::spawn(room.clone(), cfg.clone(), Profile::Full, ta);
    let b = RoomHub::spawn(room.clone(), cfg.clone(), Profile::Full, tb);
    a.set_identity("aaaaaaaaaaaaaaaa", "aaaaaaaaaaaa");
    b.set_identity("bbbbbbbbbbbbbbbb", "bbbbbbbbbbbb");
    println!("комната {} (топик), ждём каналы 8 с…", room.topic);
    let t0 = Instant::now();
    let mut st_b = None;
    while t0.elapsed() < Duration::from_secs(8) {
        tokio::select! {
            Some(e) = ra.recv() => { if let HubEvent::Status(s) = e { println!("A {s:?}"); } }
            Some(e) = rb.recv() => { if let HubEvent::Status(s) = e { st_b = Some(s); } }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }
    println!("B {:?}", st_b);
    for ci in a.channels().await {
        println!(
            "  {:6} {:28} {:10} {:4} {:>6} мс  {}",
            format!("{:?}", ci.kind),
            ci.name,
            ci.state,
            ci.transport,
            ci.connect_ms.map(|m| m.to_string()).unwrap_or("-".into()),
            ci.last_error.unwrap_or_default()
        );
    }
    // A → B: 20 сообщений, в т.ч. большие (сжатие) и «голос»; приём B — параллельно
    let collector = tokio::spawn(async move {
        let mut got: BTreeMap<u32, (String, Instant)> = BTreeMap::new();
        let t1 = Instant::now();
        while t1.elapsed() < Duration::from_secs(10) {
            tokio::select! {
                Some(e) = rb.recv() => {
                    if let HubEvent::Message { msg, via } = e
                        && let Some(n) = msg.get("n").and_then(|v| v.as_u64())
                    {
                        got.entry(n as u32).or_insert((via.to_string(), Instant::now()));
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
        (got, rb)
    });
    let drain_a = tokio::spawn(async move { while ra.recv().await.is_some() {} });
    let mut sent_at: BTreeMap<u32, Instant> = BTreeMap::new();
    for i in 0..20u32 {
        let pad = if i % 5 == 4 { "x".repeat(3000) } else { String::new() };
        let typ = if i % 7 == 6 { "voice" } else { "zvtest" };
        sent_at.insert(i, Instant::now());
        a.send(json!({"type": typ, "n": i, "pad": pad}), SendOpts { voice: typ == "voice" });
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let (got_t, _rb) = collector.await?;
    drain_a.abort();
    let got: BTreeMap<u32, (String, u128)> = got_t
        .into_iter()
        .map(|(n, (via, t))| {
            let ms = sent_at.get(&n).map(|s| t.duration_since(*s).as_millis()).unwrap_or(0);
            (n, (via, ms))
        })
        .collect();
    println!("доставлено {}/20", got.len());
    for (n, (via, ms)) in &got {
        println!("  #{n:2} первым {via:12} {ms:5} мс");
    }
    println!("статистика B: {}", b.delivery_stats().await);
    a.close();
    b.close();
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(())
}

async fn join(link: Option<String>, name: Option<String>, profile: Profile) -> anyhow::Result<()> {
    let link = link.ok_or_else(|| anyhow::anyhow!("нужна ссылка"))?;
    let (_s, room) = room_from(Some(link))?;
    let cfg = Arc::new(cfg_from_env());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let hub = RoomHub::spawn(room.clone(), cfg, profile, tx);
    let self_id = zv_proto::ids::rand_hex(8);
    hub.set_identity(&self_id, &zv_proto::ids::rand_hex(6));
    println!("комната {}, я {self_id}", room.topic);
    let name = name.unwrap_or_else(|| "zv-cli".into());
    let mut tick = tokio::time::interval(Duration::from_millis(4500));
    loop {
        tokio::select! {
            Some(e) = rx.recv() => match e {
                HubEvent::Message { msg, via } => {
                    let mut s = msg.to_string();
                    if s.len() > 300 { s.truncate(300); s.push('…'); }
                    println!("[{via}] {s}");
                }
                HubEvent::Status(s) => println!("статус {s:?}"),
                HubEvent::TransportUp => println!("канал поднялся"),
                HubEvent::PeerJoined => println!("Worker: вошёл участник"),
            },
            _ = tick.tick() => {
                if profile == Profile::Full {
                    hub.send(json!({"type": "hello", "name": name, "ver": 39}), SendOpts::default());
                }
            }
            _ = tokio::signal::ctrl_c() => { hub.bye(); tokio::time::sleep(Duration::from_millis(500)).await; hub.close(); return Ok(()); }
        }
    }
}
