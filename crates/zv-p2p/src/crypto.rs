//! Криптография протокола ZV4: ключ устройства из мастер-сида, общий секрет пары контактов
//! (статический X25519 из ключей Ed25519 обоих устройств — секрет пары никогда не передаётся),
//! доказательство знания секрета комнаты (`bind`) и код безопасности контакта.

use curve25519_dalek::edwards::CompressedEdwardsY;
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256, Sha512};

pub const SALT: &[u8] = b"ZVONochek/v4";

fn hkdf32(ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(SALT), ikm);
    let mut out = [0u8; 32];
    hk.expand(info, &mut out).expect("32 bytes");
    out
}

pub fn hmac_hex(key: &[u8], parts: &[&[u8]]) -> String {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("any key size");
    for p in parts {
        m.update(p);
    }
    hex::encode(m.finalize().into_bytes())
}

/// Сравнение без утечки по времени.
pub fn ct_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Мастер-сид устройства → секретный ключ iroh (seed Ed25519).
pub fn endpoint_secret(seed: &[u8; 32]) -> [u8; 32] {
    hkdf32(seed, b"zv4-iroh-endpoint")
}

/// Общий секрет пары: X25519(мой секрет, его ID) → HKDF. Оба устройства получают одно и то же,
/// третьи лица (даже знающие код приглашения) — нет. `None` — ID собеседника не точка кривой.
pub fn pair_secret(my_secret: &[u8; 32], my_id: &[u8; 32], their_id: &[u8; 32]) -> Option<[u8; 32]> {
    let h = Sha512::digest(my_secret);
    let mut scalar = [0u8; 32];
    scalar.copy_from_slice(&h[..32]);
    let their = CompressedEdwardsY(*their_id).decompress()?.to_montgomery();
    let shared = their.mul_clamped(scalar);
    if shared.0 == [0u8; 32] {
        return None;
    }
    let (a, b) = if my_id < their_id { (my_id, their_id) } else { (their_id, my_id) };
    let mut info = b"zv4-pair".to_vec();
    info.extend_from_slice(a);
    info.extend_from_slice(b);
    Some(hkdf32(&shared.0, &info))
}

/// `bind`: HMAC(K_bind, "zv4-bind" ‖ ID отправителя ‖ ID получателя), K_bind — подключ комнаты `zv4-bind`.
pub fn bind_proof(k_bind: &[u8; 32], from: &str, to: &str) -> String {
    hmac_hex(k_bind, &[b"zv4-bind", from.as_bytes(), to.as_bytes()])
}

/// Хеш секрета приглашения (сверка «знает код»).
pub fn invite_tag(invite_secret: &str, from: &str, to: &str) -> String {
    hmac_hex(invite_secret.as_bytes(), &[b"zv4-invite", from.as_bytes(), to.as_bytes()])
}

const EMOJI: [&str; 64] = [
    "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", //
    "🐧", "🐦", "🦆", "🦉", "🐺", "🐴", "🦄", "🐝", "🦋", "🐌", "🐞", "🐢", "🐙", "🦀", "🐠", "🐬", //
    "🐳", "🐘", "🦒", "🌵", "🌲", "🌻", "🌹", "🍄", "🌙", "⭐", "🔥", "🌈", "⛄", "🍎", "🍌", "🍇", //
    "🍓", "🍒", "🍕", "🎂", "⚽", "🎸", "🚲", "🚀", "⏰", "🔑", "🎈", "📚", "💡", "🎁", "⚓", "🔔",
];

/// Код безопасности пары: 5 эмодзи + 6 цифр от SHA-256(отсортированные ID). Одинаков у обоих.
pub fn safety_code(a: &str, b: &str) -> (String, String) {
    let (x, y) = if a < b { (a, b) } else { (b, a) };
    let mut h = Sha256::new();
    h.update(b"zv4-safety");
    h.update(x.as_bytes());
    h.update(y.as_bytes());
    let d = h.finalize();
    let bits = u64::from_be_bytes(d[..8].try_into().unwrap());
    let emoji: Vec<&str> = (0..5).map(|i| EMOJI[((bits >> (58 - i * 6)) & 63) as usize]).collect();
    let num = u32::from_be_bytes(d[8..12].try_into().unwrap()) % 1_000_000;
    (emoji.join(" "), format!("{:03} {:03}", num / 1000, num % 1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keypair(seed: u8) -> ([u8; 32], [u8; 32]) {
        let sk = iroh::SecretKey::from_bytes(&endpoint_secret(&[seed; 32]));
        (sk.to_bytes(), *sk.public().as_bytes())
    }

    #[test]
    fn pair_secret_matches_both_sides() {
        let (sa, pa) = keypair(1);
        let (sb, pb) = keypair(2);
        let (sc, pc) = keypair(3);
        let ab = pair_secret(&sa, &pa, &pb).unwrap();
        let ba = pair_secret(&sb, &pb, &pa).unwrap();
        assert_eq!(ab, ba);
        let ac = pair_secret(&sa, &pa, &pc).unwrap();
        assert_ne!(ab, ac);
        let cb = pair_secret(&sc, &pc, &pb).unwrap();
        assert_ne!(ab, cb);
    }

    #[test]
    fn safety_code_symmetric() {
        let (e1, n1) = safety_code("aa", "bb");
        let (e2, n2) = safety_code("bb", "aa");
        assert_eq!((e1.clone(), n1.clone()), (e2, n2));
        assert_eq!(e1.split(' ').count(), 5);
        assert_eq!(n1.len(), 7);
    }
}
