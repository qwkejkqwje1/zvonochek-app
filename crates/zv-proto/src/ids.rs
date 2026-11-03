//! Идентификаторы как в вебе: `rid()` для mid, `randHex(n)` для from/inst.

use rand::RngExt;

/// `crypto.getRandomValues(new Uint32Array(2)).join('-')`
pub fn rid() -> String {
    let mut r = rand::rng();
    format!("{}-{}", r.random::<u32>(), r.random::<u32>())
}

/// `randHex(n)`: n случайных байт в hex (selfId = randHex(8), inst = randHex(6)).
pub fn rand_hex(nbytes: usize) -> String {
    let mut buf = vec![0u8; nbytes];
    rand::fill(&mut buf[..]);
    hex::encode(buf)
}

/// Время в мс с эпохи Unix (как Date.now()).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formats() {
        let m = rid();
        let parts: Vec<_> = m.split('-').collect();
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|p| p.parse::<u32>().is_ok()));
        assert_eq!(rand_hex(8).len(), 16);
        assert_eq!(rand_hex(6).len(), 12);
    }
}
