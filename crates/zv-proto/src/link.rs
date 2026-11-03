//! Ссылки веб-версии: `https://qwkejkqwje1.github.io/zvonochek/#k=<секрет>[&d=<32 hex>]`,
//! `#chat=…`, `#link=…`, а также своя схема `zvonochek://call#k=…`.

/// Адрес веб-версии.
pub const WEB_BASE: &str = "https://qwkejkqwje1.github.io/zvonochek/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    /// Звонок: секрет комнаты (base64url, ≥ 22 символов) и необязательный отпечаток владельца номера.
    Call { secret: String, d: Option<String> },
    /// Приватный чат веба (`#chat=`) — в приложении пока не поддерживается.
    Chat(String),
    /// Привязка устройства веба (`#link=`) — в приложении пока не поддерживается.
    DeviceLink(String),
}

impl Link {
    pub fn secret(&self) -> Option<&str> {
        match self {
            Link::Call { secret, .. } => Some(secret),
            _ => None,
        }
    }
}

/// Проверка секрета так же, как в вебе: `/^[A-Za-z0-9_-]{22,}$/`.
pub fn valid_secret(s: &str) -> bool {
    s.len() >= 22
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_d(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Разбор ссылки, фрагмента (`#k=…`, `k=…`) или «голого» секрета.
pub fn parse_link(input: &str) -> Option<Link> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    let frag = match s.find('#') {
        Some(i) => &s[i + 1..],
        None if s.contains('=') => s.rsplit('?').next().unwrap_or(s),
        None if valid_secret(s) => {
            return Some(Link::Call {
                secret: s.to_string(),
                d: None,
            });
        }
        None => return None,
    };
    let mut k = None;
    let mut d = None;
    let mut chat = None;
    let mut link = None;
    for pair in frag.split('&') {
        let (key, val) = match pair.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let val = val.trim();
        match key {
            "k" if k.is_none() => k = Some(val.to_string()),
            "d" if d.is_none() => d = Some(val.to_string()),
            "chat" if chat.is_none() => chat = Some(val.to_string()),
            "link" if link.is_none() => link = Some(val.to_string()),
            _ => {}
        }
    }
    // Порядок как в route() веба: link, chat, затем k.
    if let Some(l) = link.filter(|v| !v.is_empty()) {
        return Some(Link::DeviceLink(l));
    }
    if let Some(c) = chat.filter(|v| !v.is_empty()) {
        return Some(Link::Chat(c));
    }
    let secret = k.filter(|v| valid_secret(v))?;
    Some(Link::Call {
        secret,
        d: d.filter(|v| valid_d(v)),
    })
}

/// Новый секрет как в вебе: 32 случайных байта → base64url (43 символа).
pub fn new_secret() -> String {
    let mut b = [0u8; 32];
    rand::fill(&mut b);
    crate::b64u::enc(&b)
}

/// Ссылка на звонок для браузера.
pub fn call_url(secret: &str) -> String {
    format!("{WEB_BASE}#k={secret}")
}

/// Ссылка «открыть в приложении».
pub fn app_url(secret: &str) -> String {
    format!("zvonochek://call#k={secret}")
}

#[cfg(test)]
mod tests {
    use super::*;
    const S: &str = "AbCdEfGhIjKlMnOpQrStUv";

    #[test]
    fn parses_variants() {
        let want = Link::Call {
            secret: S.into(),
            d: None,
        };
        assert_eq!(parse_link(&call_url(S)), Some(want.clone()));
        assert_eq!(parse_link(&app_url(S)), Some(want.clone()));
        assert_eq!(parse_link(&format!("#k={S}")), Some(want.clone()));
        assert_eq!(parse_link(&format!("k={S}")), Some(want.clone()));
        assert_eq!(parse_link(S), Some(want));
        let d = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_link(&format!("{WEB_BASE}#k={S}&d={d}")),
            Some(Link::Call {
                secret: S.into(),
                d: Some(d.into())
            })
        );
        assert_eq!(
            parse_link(&format!("{WEB_BASE}#chat=xyz")),
            Some(Link::Chat("xyz".into()))
        );
        assert_eq!(
            parse_link(&format!("{WEB_BASE}#link=a.b")),
            Some(Link::DeviceLink("a.b".into()))
        );
    }

    #[test]
    fn rejects_bad() {
        assert_eq!(parse_link("#k=short"), None);
        assert_eq!(parse_link("https://example.com/"), None);
        assert_eq!(parse_link(""), None);
        // некорректный d просто игнорируется
        assert_eq!(
            parse_link(&format!("#k={S}&d=XYZ")),
            Some(Link::Call {
                secret: S.into(),
                d: None
            })
        );
    }

    #[test]
    fn new_secret_is_valid() {
        let s = new_secret();
        assert_eq!(s.len(), 43);
        assert!(valid_secret(&s));
    }
}
