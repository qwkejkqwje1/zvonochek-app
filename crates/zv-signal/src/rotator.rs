//! «Сначала новое, потом закрыть старое» (make-before-break), как в вебе:
//! держим активное соединение; когда через него прошло больше бюджета байт, поднимаем
//! следующее и подменяем активное, только когда новое подключилось. Если новое не
//! поднялось за 12 с — бросаем его, старое живёт дальше. Обрыв — переподключение с задержкой.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;

pub(crate) enum ConnCmd {
    Send(Arc<str>),
    Close,
}

pub(crate) enum ConnEvent {
    Connected(u64),
    Data(u64, String),
    PeerJoined,
    Closed(u64),
}

pub(crate) struct ConnHandle {
    pub id: u64,
    pub tx: mpsc::UnboundedSender<ConnCmd>,
    /// Байты, прошедшие через соединение (приём + отправка), для бюджета ротации.
    pub bytes: Arc<AtomicUsize>,
    /// Ротировать ли это соединение (TLS — да; MQTT по TCP — нет).
    pub rotate: Arc<AtomicBool>,
}

impl ConnHandle {
    pub fn new(
        id: u64,
    ) -> (
        ConnHandle,
        mpsc::UnboundedReceiver<ConnCmd>,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let bytes = Arc::new(AtomicUsize::new(0));
        let rotate = Arc::new(AtomicBool::new(true));
        (
            ConnHandle {
                id,
                tx,
                bytes: bytes.clone(),
                rotate: rotate.clone(),
            },
            rx,
            bytes,
            rotate,
        )
    }
    fn close(&self) {
        let _ = self.tx.send(ConnCmd::Close);
    }
}

pub(crate) trait Spawner: Send + 'static {
    /// Запустить соединение. `renew` — тихая ротация (Worker: `&renew=1`).
    fn spawn(
        &mut self,
        id: u64,
        renew: bool,
        events: mpsc::UnboundedSender<ConnEvent>,
    ) -> ConnHandle;
}

pub(crate) struct RotatorCfg {
    /// Бюджет байт на соединение (0 — без ротации).
    pub budget: usize,
    pub renew_timeout: Duration,
    pub close_old_after: Duration,
    pub backoff: fn(u32) -> Duration,
}

/// Что делать каналу после события.
pub(crate) enum Out {
    Data(String),
    /// Канал поднялся впервые (не ротация).
    Up,
    State,
    PeerJoined,
}

pub(crate) struct Rotator<S: Spawner> {
    spawner: S,
    cfg: RotatorCfg,
    ev_tx: mpsc::UnboundedSender<ConnEvent>,
    active: Option<ConnHandle>,
    active_up: bool,
    next: Option<(ConnHandle, Instant)>,
    attempt: u32,
    reconnect_at: Option<Instant>,
    ever_up: bool,
    seq: u64,
    closed: bool,
    pub renewals: u32,
}

impl<S: Spawner> Rotator<S> {
    pub fn new(spawner: S, cfg: RotatorCfg) -> (Self, mpsc::UnboundedReceiver<ConnEvent>) {
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        (
            Rotator {
                spawner,
                cfg,
                ev_tx,
                active: None,
                active_up: false,
                next: None,
                attempt: 0,
                reconnect_at: None,
                ever_up: false,
                seq: 0,
                closed: false,
                renewals: 0,
            },
            ev_rx,
        )
    }

    pub fn start(&mut self) {
        if self.active.is_none() && !self.closed {
            self.seq += 1;
            self.active = Some(self.spawner.spawn(self.seq, false, self.ev_tx.clone()));
            self.active_up = false;
        }
    }

    pub fn is_up(&self) -> bool {
        self.active_up
    }

    pub fn active_bytes(&self) -> usize {
        self.active
            .as_ref()
            .map(|a| a.bytes.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    /// Отправить через активное соединение. `false` — канал не поднят.
    pub fn send(&mut self, data: Arc<str>) -> bool {
        if !self.active_up {
            return false;
        }
        let ok = match &self.active {
            Some(a) => a.tx.send(ConnCmd::Send(data)).is_ok(),
            None => false,
        };
        self.check_budget();
        ok
    }

    fn check_budget(&mut self) {
        if self.cfg.budget == 0 || !self.active_up || self.next.is_some() || self.closed {
            return;
        }
        let Some(a) = &self.active else { return };
        if !a.rotate.load(Ordering::Relaxed) || a.bytes.load(Ordering::Relaxed) <= self.cfg.budget {
            return;
        }
        self.seq += 1;
        let h = self.spawner.spawn(self.seq, true, self.ev_tx.clone());
        self.next = Some((h, Instant::now() + self.cfg.renew_timeout));
    }

    pub fn handle(&mut self, ev: ConnEvent) -> Vec<Out> {
        let mut out = Vec::new();
        if self.closed {
            return out;
        }
        match ev {
            ConnEvent::Connected(id) => {
                if self.active.as_ref().map(|a| a.id) == Some(id) {
                    self.active_up = true;
                    self.attempt = 0;
                    self.reconnect_at = None;
                    if !self.ever_up {
                        self.ever_up = true;
                    }
                    out.push(Out::State);
                    out.push(Out::Up);
                } else if self.next.as_ref().map(|n| n.0.id) == Some(id) {
                    let (n, _) = self.next.take().expect("next");
                    if let Some(old) = self.active.replace(n) {
                        let delay = self.cfg.close_old_after;
                        tokio::spawn(async move {
                            tokio::time::sleep(delay).await;
                            old.close();
                        });
                    }
                    let was_up = self.active_up;
                    self.active_up = true;
                    self.renewals += 1;
                    self.reconnect_at = None;
                    out.push(Out::State);
                    if !was_up {
                        out.push(Out::Up);
                    }
                }
            }
            ConnEvent::Data(id, s) => {
                out.push(Out::Data(s));
                if self.active.as_ref().map(|a| a.id) == Some(id) {
                    self.check_budget();
                }
            }
            ConnEvent::PeerJoined => out.push(Out::PeerJoined),
            ConnEvent::Closed(id) => {
                if self.active.as_ref().map(|a| a.id) == Some(id) {
                    self.active = None;
                    self.active_up = false;
                    if let Some((n, _)) = self.next.take() {
                        // идёт ротация — новое соединение станет активным, когда подключится
                        self.active = Some(n);
                    } else {
                        let d = (self.cfg.backoff)(self.attempt);
                        self.attempt = self.attempt.saturating_add(1);
                        self.reconnect_at = Some(Instant::now() + d);
                    }
                    out.push(Out::State);
                } else if self.next.as_ref().map(|n| n.0.id) == Some(id) {
                    self.next = None;
                }
            }
        }
        out
    }

    /// Ближайший момент, когда нужен `on_timer`.
    pub fn deadline(&self) -> Option<Instant> {
        match (self.reconnect_at, self.next.as_ref().map(|n| n.1)) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    pub fn on_timer(&mut self) -> Vec<Out> {
        let now = Instant::now();
        if let Some(t) = self.reconnect_at
            && t <= now
            && self.active.is_none()
        {
            self.reconnect_at = None;
            self.start();
        }
        if let Some((_, t)) = &self.next
            && *t <= now
        {
            let (n, _) = self.next.take().expect("next");
            n.close();
        }
        Vec::new()
    }

    pub fn close(&mut self) {
        self.closed = true;
        if let Some(a) = self.active.take() {
            a.close();
        }
        if let Some((n, _)) = self.next.take() {
            n.close();
        }
        self.active_up = false;
    }
}

/// Сон до момента или «навсегда».
pub(crate) async fn sleep_until_opt(t: Option<Instant>) {
    match t {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending::<()>().await,
    }
}
