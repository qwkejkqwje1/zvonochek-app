//! ZVONochek: протокол веб-версии v1 (совместим с веб-клиентом v39) и общие примитивы.
//!
//! Эталон — `crypto.js` / `signaling.js` / `ntfy.js` веба (коммит a61b11e).
//! Совместимость проверяется тест-векторами `spec/vectors/web-v39.json`,
//! которые генерирует сам код веба (`tools/gen-vectors.mjs`).

pub mod b64u;
pub mod ids;
pub mod link;
pub mod room;
pub mod seal;
pub mod topics;

pub use link::{Link, parse_link};
pub use room::Room;
pub use seal::{open, seal, seal_bytes};

/// Ошибки протокола.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("некорректный секрет ссылки")]
    BadSecret,
    #[error("некорректные данные base64url")]
    BadBase64,
    #[error("ошибка шифрования")]
    Crypto,
}

pub type Result<T> = std::result::Result<T, Error>;
