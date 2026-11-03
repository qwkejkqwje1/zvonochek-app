//! Комната: из секрета ссылки через HKDF-SHA256 (salt `ZVONochek/v1`) выводятся
//! публичный топик (info `topic`, 128 бит, hex) и ключ AES-256-GCM (info `aes-256-gcm`).

use hkdf::Hkdf;
use sha2::Sha256;

pub const SALT: &[u8] = b"ZVONochek/v1";

#[derive(Clone)]
pub struct Room {
    /// Публичный идентификатор комнаты (32 hex).
    pub topic: String,
    key: [u8; 32],
    ikm: Vec<u8>,
}

impl std::fmt::Debug for Room {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Room").field("topic", &self.topic).finish_non_exhaustive()
    }
}

impl Room {
    /// Вывод из секрета ссылки (base64url). Как в вебе: секрет короче 16 байт — ошибка.
    pub fn derive(secret_b64u: &str) -> crate::Result<Room> {
        let raw = crate::b64u::dec(secret_b64u).map_err(|_| crate::Error::BadSecret)?;
        Self::from_raw(&raw)
    }

    pub fn from_raw(raw: &[u8]) -> crate::Result<Room> {
        if raw.len() < 16 {
            return Err(crate::Error::BadSecret);
        }
        let hk = Hkdf::<Sha256>::new(Some(SALT), raw);
        let mut t = [0u8; 16];
        hk.expand(b"topic", &mut t).map_err(|_| crate::Error::Crypto)?;
        let mut key = [0u8; 32];
        hk.expand(b"aes-256-gcm", &mut key).map_err(|_| crate::Error::Crypto)?;
        Ok(Room { topic: hex::encode(t), key, ikm: raw.to_vec() })
    }

    /// Ключ AES-256-GCM сообщений комнаты.
    pub fn key(&self) -> &[u8; 32] {
        &self.key
    }

    /// Дополнительный ключ приложения (не используется вебом), например `zv4-bind`.
    pub fn subkey(&self, info: &str) -> [u8; 32] {
        let hk = Hkdf::<Sha256>::new(Some(SALT), &self.ikm);
        let mut out = [0u8; 32];
        hk.expand(info.as_bytes(), &mut out).expect("32 bytes ok");
        out
    }

    pub fn seal(&self, obj: &serde_json::Value) -> String {
        crate::seal::seal(&self.key, &self.topic, obj)
    }

    pub fn open(&self, sealed: &str) -> Option<serde_json::Value> {
        crate::seal::open(&self.key, &self.topic, sealed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_short() {
        assert!(Room::derive("AAAA").is_err());
        assert!(Room::derive("AbCdEfGhIjKlMnOpQrStUv").is_ok());
    }
    #[test]
    fn topic_is_hex32() {
        let r = Room::derive("AbCdEfGhIjKlMnOpQrStUv").unwrap();
        assert_eq!(r.topic.len(), 32);
        assert!(r.topic.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(r.subkey("zv4-bind"), *r.key());
    }
}
