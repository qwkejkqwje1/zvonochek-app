//! RoomHub — сторона ядра для `Signaling` веба: конверт, шифрование, веерная отправка
//! по каналам с правилами веба, приём с фильтрами и дедупликацией по `mid`.

use crate::chan::{ChanHandle, ChanInfo};
use crate::nostr::NostrKey;
use crate::{ChanEvent, Channel, Kind, Profile, SendMeta, SignalConfig};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use zv_proto::Room;
use zv_proto::ids::now_ms;

const MAX_RAW: usize = 220_000;
const SEEN_PRUNE_AT: usize = 2500;
const SEEN_TTL_MS: u64 = 300_000;
const UP_COALESCE: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Copy, Default)]
pub struct SendOpts {
    /// Голос моста (`voice`, `voice2`) — только быстрые каналы.
    pub voice: bool,
}

/// Статус в форме `onStatus` веба (+ свои поля).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubStatus {
    pub mqtt_up: usize,
    pub mqtt_total: usize,
    pub worker: &'static str,
    pub worker_http: &'static str,
    pub nostr_up: usize,
    pub nostr_total: usize,
    pub ntfy_up: usize,
    pub ntfy_total: usize,
    pub p2p_up: usize,
    pub listen: bool,
}

#[derive(Debug)]
pub enum HubEvent {
    /// Расшифрованное сообщение собеседника (поле `via` уже проставлено).
    Message { msg: Value, via: &'static str },
    Status(HubStatus),
    /// Поднялся канал — веб в этот момент повторяет `hello`.
    TransportUp,
    /// Worker сообщил о новом участнике комнаты.
    PeerJoined,
}

enum HubCmd {
    Send { msg: Value, mid: String, opts: SendOpts },
    SetIdentity { self_id: String, inst: String },
    SetExtras(Map<String, Value>),
    SetProfile(Profile),
    AddChannel(Arc<dyn Channel>),
    RemoveChannel(String),
    Inject { data: String, via: &'static str },
    Status(oneshot::Sender<HubStatus>),
    Channels(oneshot::Sender<Vec<ChanInfo>>),
    Stats(oneshot::Sender<Value>),
    Close,
}

/// Дескриптор комнаты. Клонируется; комната живёт, пока не вызван `close()`.
#[derive(Clone)]
pub struct RoomHub {
    tx: mpsc::UnboundedSender<HubCmd>,
    pub topic: String,
}

impl RoomHub {
    pub fn spawn(room: Room, cfg: Arc<SignalConfig>, profile: Profile, events: mpsc::UnboundedSender<HubEvent>) -> RoomHub {
        let (tx, rx) = mpsc::unbounded_channel();
        let topic = room.topic.clone();
        let (chan_tx, chan_rx) = mpsc::unbounded_channel();
        let nkey = NostrKey::random();
        let hub = Hub {
            ntag: zv_proto::topics::nostr_tag(&room.topic),
            npk: Arc::from(nkey.pubkey.as_str()),
            nkey,
            room,
            cfg,
            profile,
            self_id: zv_proto::ids::rand_hex(8),
            inst: zv_proto::ids::rand_hex(6),
            worker_peer: zv_proto::ids::rand_hex(8),
            extras: Map::new(),
            mqtt: Vec::new(),
            worker: None,
            nostr: Vec::new(),
            ntfy: None,
            extra: Vec::new(),
            seen: HashMap::new(),
            first: BTreeMap::new(),
            dup: BTreeMap::new(),
            ntfy_hello_at: 0,
            chan_tx,
            events,
            last_status: None,
            up_last: None,
            up_pending: false,
        };
        tokio::spawn(hub.run(rx, chan_rx));
        RoomHub { tx, topic }
    }

    /// Отправить сообщение веб-протокола (объект с `type`). Возвращает `mid`.
    pub fn send(&self, msg: Value, opts: SendOpts) -> String {
        let mid = zv_proto::ids::rid();
        let _ = self.tx.send(HubCmd::Send { msg, mid: mid.clone(), opts });
        mid
    }

    /// `selfId`/`inst` клиента звонка (до этого — случайные).
    pub fn set_identity(&self, self_id: &str, inst: &str) {
        let _ = self.tx.send(HubCmd::SetIdentity { self_id: self_id.into(), inst: inst.into() });
    }

    /// Поля приложения, которые дописываются в `hello`/`hi`/`g_hi` (`app`, `av`, `zv`).
    pub fn set_extras(&self, extras: Map<String, Value>) {
        let _ = self.tx.send(HubCmd::SetExtras(extras));
    }

    pub fn set_profile(&self, p: Profile) {
        let _ = self.tx.send(HubCmd::SetProfile(p));
    }

    /// Аналог `sendByeBeacon()` веба: `bye` во все каналы (ядро живёт и после закрытия окна).
    pub fn bye(&self) {
        self.send(serde_json::json!({"type": "bye"}), SendOpts::default());
    }

    pub fn add_channel(&self, ch: Arc<dyn Channel>) {
        let _ = self.tx.send(HubCmd::AddChannel(ch));
    }

    /// Убрать внешний канал (по имени) — например, P2P-линк закрылся.
    pub fn remove_channel(&self, name: &str) {
        let _ = self.tx.send(HubCmd::RemoveChannel(name.to_string()));
    }

    /// Запечатанный пакет, пришедший внешним путём (P2P): те же фильтры и дедупликация, что у каналов.
    pub fn inject(&self, data: String, via: &'static str) {
        let _ = self.tx.send(HubCmd::Inject { data, via });
    }

    pub async fn status(&self) -> Option<HubStatus> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(HubCmd::Status(tx)).ok()?;
        rx.await.ok()
    }

    pub async fn channels(&self) -> Vec<ChanInfo> {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(HubCmd::Channels(tx)).is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// Как `deliveryStats()` веба: `{first: {via: n}, dup: {via: n}}`.
    pub async fn delivery_stats(&self) -> Value {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(HubCmd::Stats(tx)).is_err() {
            return Value::Null;
        }
        rx.await.unwrap_or(Value::Null)
    }

    pub fn close(&self) {
        let _ = self.tx.send(HubCmd::Close);
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

struct Hub {
    room: Room,
    cfg: Arc<SignalConfig>,
    profile: Profile,
    self_id: String,
    inst: String,
    worker_peer: String,
    extras: Map<String, Value>,
    mqtt: Vec<ChanHandle>,
    worker: Option<ChanHandle>,
    nostr: Vec<ChanHandle>,
    ntfy: Option<ChanHandle>,
    extra: Vec<Arc<dyn Channel>>,
    nkey: NostrKey,
    npk: Arc<str>,
    ntag: String,
    seen: HashMap<String, u64>,
    first: BTreeMap<&'static str, u64>,
    dup: BTreeMap<&'static str, u64>,
    ntfy_hello_at: u64,
    chan_tx: crate::ChanTx,
    events: mpsc::UnboundedSender<HubEvent>,
    last_status: Option<HubStatus>,
    up_last: Option<Instant>,
    up_pending: bool,
}

/// Истинность значения по правилам JS.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn is_critical(t: &str) -> bool {
    matches!(t, "hello" | "hi" | "desc" | "bye")
}

impl Hub {
    fn want_mqtt(&self) -> usize {
        match self.profile {
            Profile::Full => self.cfg.brokers.len(),
            Profile::Listen => self.cfg.listen_mqtt.min(self.cfg.brokers.len()),
        }
    }
    fn want_nostr(&self) -> usize {
        match self.profile {
            Profile::Full => self.cfg.nostr_relays.len(),
            Profile::Listen => self.cfg.listen_nostr.min(self.cfg.nostr_relays.len()),
        }
    }

    fn ensure_channels(&mut self) {
        let topic = self.room.topic.clone();
        while self.mqtt.len() < self.want_mqtt() {
            let spec = self.cfg.brokers[self.mqtt.len()].clone();
            self.mqtt.push(crate::mqtt::spawn(&spec, &topic, &self.cfg, self.chan_tx.clone()));
        }
        while self.mqtt.len() > self.want_mqtt() {
            if let Some(c) = self.mqtt.pop() {
                c.close();
            }
        }
        while self.nostr.len() < self.want_nostr() {
            let url = self.cfg.nostr_relays[self.nostr.len()].clone();
            self.nostr.push(crate::nostr::spawn(&url, &topic, self.npk.clone(), &self.cfg, self.chan_tx.clone()));
        }
        while self.nostr.len() > self.want_nostr() {
            if let Some(c) = self.nostr.pop() {
                c.close();
            }
        }
        if self.worker.is_none()
            && let Some(base) = self.cfg.worker_url.clone().filter(|s| !s.is_empty())
        {
            self.worker = Some(crate::worker::spawn(
                &base,
                &topic,
                &self.worker_peer,
                self.profile,
                &self.cfg,
                self.chan_tx.clone(),
            ));
        }
        if self.ntfy.is_none()
            && let Some(base) = self.cfg.ntfy_base.clone().filter(|s| !s.is_empty())
        {
            self.ntfy = Some(crate::ntfy::spawn(&base, &topic, &self.cfg, self.chan_tx.clone()));
        }
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<HubCmd>, mut chan_rx: mpsc::UnboundedReceiver<ChanEvent>) {
        self.ensure_channels();
        self.emit_status();
        loop {
            let up_at = if self.up_pending { self.up_last.map(|t| t + UP_COALESCE) } else { None };
            tokio::select! {
                cmd = rx.recv() => {
                    let Some(cmd) = cmd else { self.shutdown(); return };
                    match cmd {
                        HubCmd::Send { msg, mid, opts } => self.send(msg, mid, opts),
                        HubCmd::SetIdentity { self_id, inst } => {
                            self.self_id = self_id;
                            self.inst = inst;
                        }
                        HubCmd::SetExtras(e) => self.extras = e,
                        HubCmd::SetProfile(p) => {
                            if p != self.profile {
                                self.profile = p;
                                self.ensure_channels();
                                if let Some(w) = &self.worker { w.set_profile(p); }
                                self.emit_status();
                            }
                        }
                        HubCmd::AddChannel(c) => {
                            if let Some(old) = self.extra.iter().position(|x| x.name() == c.name()) {
                                self.extra.remove(old);
                            }
                            self.extra.push(c);
                            self.emit_status();
                        }
                        HubCmd::RemoveChannel(name) => {
                            self.extra.retain(|x| x.name() != name);
                            self.emit_status();
                        }
                        HubCmd::Inject { data, via } => self.recv(&data, via),
                        HubCmd::Status(tx) => { let _ = tx.send(self.status()); }
                        HubCmd::Channels(tx) => { let _ = tx.send(self.channel_infos()); }
                        HubCmd::Stats(tx) => {
                            let _ = tx.send(serde_json::json!({"first": self.first, "dup": self.dup}));
                        }
                        HubCmd::Close => { self.shutdown(); return; }
                    }
                }
                Some(ev) = chan_rx.recv() => match ev {
                    ChanEvent::Data { data, via } => self.recv(&data, via),
                    ChanEvent::State => self.emit_status(),
                    ChanEvent::Up => self.transport_up(),
                    ChanEvent::PeerJoined => { let _ = self.events.send(HubEvent::PeerJoined); }
                },
                _ = crate::rotator::sleep_until_opt(up_at) => {
                    self.up_pending = false;
                    self.up_last = Some(Instant::now());
                    let _ = self.events.send(HubEvent::TransportUp);
                }
            }
        }
    }

    fn shutdown(&mut self) {
        for c in self.mqtt.drain(..) {
            c.close();
        }
        for c in self.nostr.drain(..) {
            c.close();
        }
        if let Some(c) = self.worker.take() {
            c.close();
        }
        if let Some(c) = self.ntfy.take() {
            c.close();
        }
        for c in self.extra.drain(..) {
            c.close();
        }
    }

    fn transport_up(&mut self) {
        let now = Instant::now();
        match self.up_last {
            Some(t) if now.duration_since(t) < UP_COALESCE => self.up_pending = true,
            _ => {
                self.up_last = Some(now);
                let _ = self.events.send(HubEvent::TransportUp);
            }
        }
    }

    fn ntfy_wanted(&mut self, t: &str) -> bool {
        if !zv_proto::topics::NTFY_TYPES.contains(&t) {
            return false;
        }
        if t != "hello" {
            return true;
        }
        let now = now_ms();
        if now.saturating_sub(self.ntfy_hello_at) < zv_proto::topics::NTFY_HELLO_EVERY_MS {
            return false;
        }
        self.ntfy_hello_at = now;
        true
    }

    fn send(&mut self, msg: Value, mid: String, opts: SendOpts) {
        let Value::Object(mut obj) = msg else { return };
        let t = obj.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if matches!(t.as_str(), "hello" | "hi" | "g_hi") {
            for (k, v) in &self.extras {
                obj.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        let ts = now_ms();
        obj.insert("from".into(), Value::String(self.self_id.clone()));
        obj.insert("inst".into(), Value::String(self.inst.clone()));
        obj.insert("mid".into(), Value::String(mid.clone()));
        obj.insert("ts".into(), Value::from(ts));
        self.seen.insert(mid, ts);
        let data: Arc<str> = Arc::from(self.room.seal(&Value::Object(obj)));

        if opts.voice || t == "voice" {
            self.send_voice(data);
            return;
        }
        let meta = SendMeta { critical: is_critical(&t), voice: false, post_ok: true };
        for c in &self.extra {
            if c.is_up() {
                c.send(data.clone(), meta);
            }
        }
        for c in &self.mqtt {
            if c.is_up() {
                c.send(data.clone(), meta);
            }
        }
        if let Some(w) = &self.worker {
            w.send(data.clone(), meta);
        }
        let up: Vec<&ChanHandle> = self.nostr.iter().filter(|c| c.is_up()).collect();
        if !up.is_empty() {
            let ev: Arc<str> = Arc::from(self.nkey.event(&data, &self.ntag, ts / 1000));
            for c in up {
                c.send(ev.clone(), meta);
            }
        }
        if self.ntfy.is_some() && data.len() <= zv_proto::topics::NTFY_MAX_BODY && self.ntfy_wanted(&t)
            && let Some(n) = &self.ntfy
        {
            n.send(data, meta);
        }
    }

    fn send_voice(&mut self, data: Arc<str>) {
        let meta = SendMeta { critical: false, voice: true, post_ok: false };
        let mut sent = false;
        for c in self.extra.iter().filter(|c| c.is_up()) {
            c.send(data.clone(), meta);
            sent = true;
        }
        for c in self.mqtt.iter().filter(|c| c.is_up()).take(2) {
            c.send(data.clone(), meta);
            sent = true;
        }
        if let Some(w) = &self.worker {
            if w.is_up() {
                w.send(data.clone(), meta);
                sent = true;
            } else if !sent {
                w.send(data.clone(), SendMeta { post_ok: true, ..meta });
                sent = true;
            }
        }
        if !sent && let Some(n) = self.nostr.iter().find(|c| c.is_up()) {
            let ev: Arc<str> = Arc::from(self.nkey.event(&data, &self.ntag, now_ms() / 1000));
            n.send(ev, meta);
        }
    }

    fn recv(&mut self, raw: &str, via: &'static str) {
        if raw.is_empty() || raw.len() > MAX_RAW {
            return;
        }
        let Some(Value::Object(mut m)) = self.room.open(raw) else { return };
        if m.get("from").and_then(|v| v.as_str()) == Some(self.self_id.as_str()) {
            return;
        }
        if truthy(m.get("to")) && m.get("to").and_then(|v| v.as_str()) != Some(self.self_id.as_str()) {
            return;
        }
        if truthy(m.get("toInst")) && m.get("toInst").and_then(|v| v.as_str()) != Some(self.inst.as_str()) {
            return;
        }
        if !truthy(m.get("mid")) {
            return;
        }
        let mid = match m.get("mid") {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => return,
        };
        if self.seen.contains_key(&mid) {
            *self.dup.entry(via).or_insert(0) += 1;
            return;
        }
        let now = now_ms();
        self.seen.insert(mid, now);
        *self.first.entry(via).or_insert(0) += 1;
        if self.seen.len() > SEEN_PRUNE_AT {
            self.seen.retain(|_, t| now.saturating_sub(*t) <= SEEN_TTL_MS);
        }
        m.insert("via".into(), Value::String(via.into()));
        let _ = self.events.send(HubEvent::Message { msg: Value::Object(m), via });
    }

    fn status(&self) -> HubStatus {
        let (worker, worker_http) = match &self.worker {
            None => ("off", "off"),
            Some(w) => {
                let i = w.info();
                let ws = match i.state {
                    "up" => "up",
                    "off" => "off",
                    "down" => "down",
                    _ => "connecting",
                };
                (ws, i.http.unwrap_or("off"))
            }
        };
        HubStatus {
            mqtt_up: self.mqtt.iter().filter(|c| c.is_up()).count(),
            mqtt_total: self.mqtt.len(),
            worker,
            worker_http,
            nostr_up: self.nostr.iter().filter(|c| c.is_up()).count(),
            nostr_total: self.nostr.len(),
            ntfy_up: self.ntfy.as_ref().map(|c| c.is_up() as usize).unwrap_or(0),
            ntfy_total: self.ntfy.is_some() as usize,
            p2p_up: self.extra.iter().filter(|c| c.kind() == Kind::P2p && c.is_up()).count(),
            listen: self.profile == Profile::Listen,
        }
    }

    fn emit_status(&mut self) {
        let st = self.status();
        if self.last_status.as_ref() != Some(&st) {
            self.last_status = Some(st.clone());
            let _ = self.events.send(HubEvent::Status(st));
        }
    }

    fn channel_infos(&self) -> Vec<ChanInfo> {
        let mut v = Vec::new();
        v.extend(self.mqtt.iter().map(|c| c.info()));
        v.extend(self.worker.iter().map(|c| c.info()));
        v.extend(self.nostr.iter().map(|c| c.info()));
        v.extend(self.ntfy.iter().map(|c| c.info()));
        v.extend(self.extra.iter().map(|c| c.info()));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn js_truthiness() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&Value::String(String::new()))));
        assert!(truthy(Some(&Value::String("a".into()))));
        assert!(!truthy(Some(&serde_json::json!(0))));
        assert!(truthy(Some(&serde_json::json!(1))));
        assert!(!truthy(Some(&Value::Null)));
    }
}
