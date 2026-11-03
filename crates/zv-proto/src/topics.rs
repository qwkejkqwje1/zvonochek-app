//! Имена топиков каналов сигналинга (как в signaling.js / ntfy.js веба).

use sha2::{Digest, Sha256};

/// MQTT: `zvonochek/v1/<topic>`
pub fn mqtt_topic(topic: &str) -> String {
    format!("zvonochek/v1/{topic}")
}

/// Nostr: тег `t` = `zv-<topic>`
pub fn nostr_tag(topic: &str) -> String {
    format!("zv-{topic}")
}

/// ntfy: `prefix + sha256hex(id)[0..48]`; для сигналинга звонков prefix = `zv1-`.
pub fn ntfy_topic(prefix: &str, id: &str) -> String {
    let h = hex::encode(Sha256::digest(id.as_bytes()));
    format!("{prefix}{}", &h[..48])
}

pub fn ntfy_signaling_topic(topic: &str) -> String {
    ntfy_topic("zv1-", topic)
}

/// Типы сообщений, которые веб отправляет через ntfy (NTFY_TYPES).
pub const NTFY_TYPES: &[&str] = &[
    "hello", "hi", "g_hi", "full", "desc", "g_desc", "cand", "g_cand", "ack", "reset", "bye",
];
/// hello через ntfy — не чаще раза в 30 с.
pub const NTFY_HELLO_EVERY_MS: u64 = 30_000;
/// Тело длиннее 4096 байт ntfy превращает во вложение — такие пакеты не шлём.
pub const NTFY_MAX_BODY: usize = 4096;
