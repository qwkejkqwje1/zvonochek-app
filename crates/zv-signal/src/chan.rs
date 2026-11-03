//! Общая «обвязка» канала: дескриптор для RoomHub (очередь команд + разделяемое состояние)
//! и сведения для диагностики.

use crate::{ChanTx, Channel, Kind, SendMeta};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Состояние канала для статуса и диагностики.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChanInfo {
    pub kind: Kind,
    pub name: String,
    /// off · connecting · up · down (для HTTP-части Worker: off · polling · up)
    pub state: &'static str,
    /// wss · tcp · http — чем канал работает сейчас.
    pub transport: &'static str,
    /// Байты через текущее соединение (для бюджета ротации).
    pub bytes: usize,
    /// Сколько раз соединение тихо заменено (ротация 9 КБ).
    pub renewals: u32,
    pub connects: u32,
    pub tx: u64,
    pub rx: u64,
    /// Время последнего принятого пакета, мс unix.
    pub last_rx: u64,
    /// Время установления соединения, мс (последнее).
    pub connect_ms: Option<u32>,
    pub last_error: Option<String>,
    /// Дополнительно: состояние HTTP-опроса у Worker.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<&'static str>,
}

impl ChanInfo {
    pub fn new(kind: Kind, name: &str) -> ChanInfo {
        ChanInfo {
            kind,
            name: name.to_string(),
            state: "connecting",
            transport: "",
            bytes: 0,
            renewals: 0,
            connects: 0,
            tx: 0,
            rx: 0,
            last_rx: 0,
            connect_ms: None,
            last_error: None,
            http: None,
        }
    }
}

pub(crate) struct Shared {
    pub up: AtomicBool,
    pub info: Mutex<ChanInfo>,
}

impl Shared {
    pub fn new(kind: Kind, name: &str) -> Arc<Shared> {
        Arc::new(Shared {
            up: AtomicBool::new(false),
            info: Mutex::new(ChanInfo::new(kind, name)),
        })
    }
    pub fn with<R>(&self, f: impl FnOnce(&mut ChanInfo) -> R) -> R {
        let mut g = self.info.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g)
    }
    pub fn set_up(&self, up: bool) {
        self.up.store(up, Ordering::Relaxed);
    }
    pub fn error(&self, e: impl std::fmt::Display) {
        let s = e.to_string();
        self.with(|i| i.last_error = Some(s.chars().take(160).collect()));
    }
}

pub(crate) enum ChanCmd {
    Send(Arc<str>, SendMeta),
    Profile(crate::Profile),
    Close,
}

/// Дескриптор канала, который хранит RoomHub.
pub(crate) struct ChanHandle {
    pub kind: Kind,
    pub name: String,
    pub tx: mpsc::UnboundedSender<ChanCmd>,
    pub shared: Arc<Shared>,
}

impl ChanHandle {
    pub fn new(
        kind: Kind,
        name: &str,
    ) -> (ChanHandle, mpsc::UnboundedReceiver<ChanCmd>, Arc<Shared>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let shared = Shared::new(kind, name);
        (
            ChanHandle {
                kind,
                name: name.to_string(),
                tx,
                shared: shared.clone(),
            },
            rx,
            shared,
        )
    }
}

impl Channel for ChanHandle {
    fn kind(&self) -> Kind {
        self.kind
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_up(&self) -> bool {
        self.shared.up.load(Ordering::Relaxed)
    }
    fn send(&self, data: Arc<str>, meta: SendMeta) {
        let _ = self.tx.send(ChanCmd::Send(data, meta));
    }
    fn info(&self) -> ChanInfo {
        self.shared.with(|i| i.clone())
    }
    fn set_profile(&self, p: crate::Profile) {
        let _ = self.tx.send(ChanCmd::Profile(p));
    }
    fn close(&self) {
        let _ = self.tx.send(ChanCmd::Close);
    }
}

/// Цикл канала, построенного на `Rotator` (MQTT, Nostr): команды → активное соединение,
/// события соединений → RoomHub.
pub(crate) async fn run_rotating<S: crate::rotator::Spawner>(
    mut rot: crate::rotator::Rotator<S>,
    mut ev_rx: mpsc::UnboundedReceiver<crate::rotator::ConnEvent>,
    mut cmd_rx: mpsc::UnboundedReceiver<ChanCmd>,
    hub: ChanTx,
    shared: Arc<Shared>,
    via: &'static str,
) {
    use crate::ChanEvent;
    use crate::rotator::{Out, sleep_until_opt};
    rot.start();
    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => match cmd {
                Some(ChanCmd::Send(d, _meta)) => {
                    if rot.send(d) {
                        shared.with(|i| i.tx += 1);
                    }
                }
                Some(ChanCmd::Profile(_)) => {}
                Some(ChanCmd::Close) | None => {
                    rot.close();
                    shared.set_up(false);
                    shared.with(|i| i.state = "off");
                    let _ = hub.send(ChanEvent::State);
                    return;
                }
            },
            Some(ev) = ev_rx.recv() => {
                for o in rot.handle(ev) {
                    match o {
                        Out::Data(s) => {
                            shared.with(|i| {
                                i.rx += 1;
                                i.last_rx = zv_proto::ids::now_ms();
                            });
                            let _ = hub.send(ChanEvent::Data { data: s, via });
                        }
                        Out::Up => {
                            let _ = hub.send(ChanEvent::Up);
                        }
                        Out::PeerJoined => {
                            let _ = hub.send(ChanEvent::PeerJoined);
                        }
                        Out::State => {
                            let up = rot.is_up();
                            shared.set_up(up);
                            let renewals = rot.renewals;
                            shared.with(|i| {
                                i.state = if up { "up" } else { "down" };
                                i.renewals = renewals;
                            });
                            let _ = hub.send(ChanEvent::State);
                        }
                    }
                }
                let b = rot.active_bytes();
                shared.with(|i| i.bytes = b);
            },
            _ = sleep_until_opt(rot.deadline()) => {
                rot.on_timer();
            },
        }
    }
}
