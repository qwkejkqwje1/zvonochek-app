//! Конверт сообщений веба: JSON → (deflate-raw, если > 300 байт и нет `_noZip`) →
//! AES-256-GCM (IV 12 байт, AAD = топик + тег) → `тег.b64u(iv).b64u(шифротекст)`.
//! Тег `z2` — сжато, `z1` — без сжатия.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use flate2::Compression;
use std::io::{Read, Write};

/// Порог сжатия (как в вебе).
pub const ZIP_THRESHOLD: usize = 300;
/// Максимальный размер распакованного сообщения (защита от «zip-бомб»).
pub const MAX_PLAINTEXT: u64 = 2 * 1024 * 1024;
/// Веб не принимает запечатанные строки длиннее 220000 символов.
pub const MAX_SEALED: usize = 220_000;

/// Запечатать JSON-объект.
pub fn seal(key: &[u8; 32], topic: &str, obj: &serde_json::Value) -> String {
    let no_zip = obj.get("_noZip").map(truthy).unwrap_or(false);
    let pt = serde_json::to_vec(obj).expect("json");
    seal_bytes(key, topic, &pt, no_zip)
}

fn truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Запечатать готовые байты JSON.
pub fn seal_bytes(key: &[u8; 32], topic: &str, json: &[u8], no_zip: bool) -> String {
    let (pt, tag) = if json.len() > ZIP_THRESHOLD && !no_zip {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(json).expect("deflate");
        (enc.finish().expect("deflate"), "z2")
    } else {
        (json.to_vec(), "z1")
    };
    let mut iv = [0u8; 12];
    rand::fill(&mut iv);
    let cipher = Aes256Gcm::new(key.into());
    let aad = format!("{topic}{tag}");
    let ct = cipher
        .encrypt(
            &Nonce::from(iv),
            Payload {
                msg: &pt,
                aad: aad.as_bytes(),
            },
        )
        .expect("aes-gcm encrypt");
    format!("{tag}.{}.{}", crate::b64u::enc(&iv), crate::b64u::enc(&ct))
}

/// Открыть конверт. `None` — чужое или повреждённое сообщение (как в вебе — молча).
pub fn open(key: &[u8; 32], topic: &str, sealed: &str) -> Option<serde_json::Value> {
    let bytes = open_bytes(key, topic, sealed)?;
    serde_json::from_slice(&bytes).ok()
}

/// Открыть конверт и вернуть байты JSON.
pub fn open_bytes(key: &[u8; 32], topic: &str, sealed: &str) -> Option<Vec<u8>> {
    if sealed.len() > MAX_SEALED {
        return None;
    }
    let mut parts = sealed.split('.');
    let (tag, iv, ct) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || (tag != "z1" && tag != "z2") {
        return None;
    }
    let iv = crate::b64u::dec(iv).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let iv: [u8; 12] = iv.try_into().ok()?;
    let ct = crate::b64u::dec(ct).ok()?;
    let cipher = Aes256Gcm::new(key.into());
    let aad = format!("{topic}{tag}");
    let pt = cipher
        .decrypt(
            &Nonce::from(iv),
            Payload {
                msg: &ct,
                aad: aad.as_bytes(),
            },
        )
        .ok()?;
    if tag == "z2" {
        let mut out = Vec::new();
        flate2::read::DeflateDecoder::new(&pt[..])
            .take(MAX_PLAINTEXT + 1)
            .read_to_end(&mut out)
            .ok()?;
        if out.len() as u64 > MAX_PLAINTEXT {
            return None;
        }
        Some(out)
    } else {
        Some(pt)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    fn room() -> crate::Room {
        crate::Room::derive("AbCdEfGhIjKlMnOpQrStUv").unwrap()
    }

    #[test]
    fn small_is_z1_big_is_z2() {
        let r = room();
        let small = r.seal(&json!({"type":"hello","name":"Аня"}));
        assert!(small.starts_with("z1."));
        assert_eq!(r.open(&small).unwrap()["name"], "Аня");
        let big = json!({"type":"desc","desc":{"sdp":"v=0\r\n".repeat(200)}});
        let s = r.seal(&big);
        assert!(s.starts_with("z2."));
        assert_eq!(r.open(&s).unwrap(), big);
        let nz = json!({"type":"voice2","b64":"A".repeat(400),"_noZip":1});
        assert!(r.seal(&nz).starts_with("z1."));
    }

    #[test]
    fn wrong_room_or_tampered_is_none() {
        let r = room();
        let other = crate::Room::derive("ZZCdEfGhIjKlMnOpQrStUv").unwrap();
        let s = r.seal(&json!({"type":"hi"}));
        assert!(other.open(&s).is_none());
        let mut t = s.clone();
        t.replace_range(0..2, "z2");
        assert!(r.open(&t).is_none());
        assert!(r.open("garbage").is_none());
        assert!(r.open("z1.a.b.c").is_none());
    }
}
