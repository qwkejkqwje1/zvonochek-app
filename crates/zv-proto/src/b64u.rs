//! base64url без выравнивания — как `b64u` в crypto.js веба.
//! Декодер снисходителен (как atob в вебе): принимает и `+/`, и `-_`, с `=` и без.

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

const ENC: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new().with_encode_padding(false),
);
const DEC: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub fn enc(data: &[u8]) -> String {
    ENC.encode(data)
}

pub fn dec(s: &str) -> crate::Result<Vec<u8>> {
    let norm: String = s
        .trim()
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            c => c,
        })
        .filter(|c| *c != '=')
        .collect();
    DEC.decode(norm.as_bytes())
        .map_err(|_| crate::Error::BadBase64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_lenient() {
        let data = [0xfbu8, 0xff, 0x00, 0x10, 0x7e];
        let e = enc(&data);
        assert!(!e.contains('=') && !e.contains('+') && !e.contains('/'));
        assert_eq!(dec(&e).unwrap(), data);
        // стандартный алфавит и выравнивание тоже принимаем
        let std = e.replace('-', "+").replace('_', "/") + "==";
        assert_eq!(dec(&std).unwrap(), data);
    }
}
