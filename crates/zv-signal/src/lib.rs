//! Каналы сигналинга, совместимые с веб-версией (signaling.js v39), и RoomHub.
//!
//! Каналы: MQTT (WSS, а у приложения ещё и TCP 1883), Cloudflare Worker веба (WS + HTTP),
//! Nostr (эфемерные события 29333), ntfy.sh. Все работают параллельно, дубли
//! отбрасываются по `mid`. Все WSS-соединения ротируются после ~9 КБ (как в вебе —
//! защита от «заморозки» ТСПУ после ~16 КБ).

mod chan;
pub mod config;
pub mod hub;
pub mod mailbox;
#[cfg(feature = "mock")]
pub mod mock;
pub mod mqtt;
pub mod nostr;
pub mod ntfy;
mod rotator;
pub mod tls;
pub mod worker;

pub use chan::ChanInfo;
pub use config::{BrokerSpec, Profile, SignalConfig};
pub use hub::{HubEvent, HubStatus, RoomHub, SendOpts};

use std::sync::Arc;
use tokio::sync::mpsc;

/// Вид канала.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Mqtt,
    Worker,
    Nostr,
    Ntfy,
    P2p,
}

/// События каналов для RoomHub.
#[derive(Debug)]
pub enum ChanEvent {
    /// Запечатанный пакет; `via` — как в вебе: mqtt, worker, worker-http, nostr, ntfy, p2p.
    Data { data: String, via: &'static str },
    /// Изменилось состояние канала — пересчитать статус.
    State,
    /// Канал поднялся впервые (не ротация) — веб в этот момент повторяет hello.
    Up,
    /// Worker сообщил, что в комнату вошёл участник.
    PeerJoined,
}

pub type ChanTx = mpsc::UnboundedSender<ChanEvent>;

/// Метаданные отправки.
#[derive(Debug, Clone, Copy, Default)]
pub struct SendMeta {
    /// Пакет рукопожатия (hello, hi, desc, bye) — Worker дублирует его HTTP POST при заполненном сокете.
    pub critical: bool,
    /// Голос моста — только быстрые каналы.
    pub voice: bool,
    /// Голос: разрешён HTTP POST в Worker (ни один быстрый канал не принял пакет).
    pub post_ok: bool,
}

/// Канал с точки зрения RoomHub.
pub trait Channel: Send + Sync {
    fn kind(&self) -> Kind;
    fn name(&self) -> &str;
    fn is_up(&self) -> bool;
    /// Неблокирующая отправка запечатанного пакета. Если канал не поднят — пакет отбрасывается.
    fn send(&self, data: Arc<str>, meta: SendMeta);
    fn info(&self) -> ChanInfo;
    /// Смена режима комнаты (ожидание ↔ звонок).
    fn set_profile(&self, _p: Profile) {}
    fn close(&self);
}

/// Экспоненциальная задержка переподключения как в вебе: min(cap, base * 2^min(n, 5)).
pub(crate) fn backoff(base_ms: u64, cap_ms: u64, attempt: u32) -> std::time::Duration {
    let ms = base_ms.saturating_mul(1u64 << attempt.min(5)).min(cap_ms);
    std::time::Duration::from_millis(ms)
}
