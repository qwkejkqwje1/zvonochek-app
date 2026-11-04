//! Ссылки веб-версии: `https://zvonochek.github.io/#k=<секрет>[&d=<32 hex>]` (старый адрес
//! `https://qwkejkqwje1.github.io/zvonochek/` тоже разбирается — разбор не зависит от домена),
//! `#chat=…`, `#link=…`, а также своя схема `zvonochek://call#k=…`.

/// Адрес веб-версии (с 03.11.2026 сайт переехал с qwkejkqwje1.github.io/zvonochek).
pub const WEB_BASE: &str = "https://zvonochek.github.io/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    /// Звонок: секрет комнаты (base64url, ≥ 22 символов) и необязательный отпечаток владельца номера.
    Call { secret: String, d: Option<String> },
    /// Приватный чат веба (`#chat=`) — открывается в окне веб-чатов приложения (встроенный веб-клиент).
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

/// Фрагмент ссылки веб-чата для окна приложения: `chat=<seed>[&p=1]` (`p=1` — комната с PIN).
/// Только символы base64url: фрагмент подставляется в адрес окна.
pub fn chat_fragment(input: &str) -> Option<String> {
    let s = input.trim();
    let frag = &s[s.find('#')? + 1..];
    let mut seed = None;
    let mut pin = false;
    for pair in frag.split('&') {
        match pair.split_once('=') {
            Some(("chat", v)) if seed.is_none() => seed = Some(v.trim()),
            Some(("p", v)) => pin = v.trim() == "1",
            _ => {}
        }
    }
    let seed = seed.filter(|v| {
        (22..=128).contains(&v.len())
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_=".contains(&b))
    })?;
    Some(format!("chat={seed}{}", if pin { "&p=1" } else { "" }))
}

/// `#chat=…` для адреса окна веб-чатов из фрагмента `chat=…[&p=1]` (пустой — список чатов);
/// `None` — фрагмент не такой, какой даёт [`chat_fragment`].
pub fn chat_hash(frag: &str) -> Option<String> {
    if frag.is_empty() {
        return Some(String::new());
    }
    chat_fragment(&format!("#{frag}"))
        .filter(|f| f == frag)
        .map(|f| format!("#{f}"))
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
    fn chat_frag() {
        let seed = "q3bL0x9_Zk-AbCdEfGhIjKlMnOpQrStUvWxYz012345";
        assert_eq!(
            chat_fragment(&format!("{WEB_BASE}#chat={seed}")),
            Some(format!("chat={seed}"))
        );
        assert_eq!(
            chat_fragment(&format!(
                "https://qwkejkqwje1.github.io/zvonochek/#chat={seed}&p=1"
            )),
            Some(format!("chat={seed}&p=1"))
        );
        assert_eq!(
            chat_fragment(&format!("#chat={seed}&p=0")),
            Some(format!("chat={seed}"))
        );
        assert_eq!(chat_fragment("#chat=short"), None);
        assert_eq!(chat_fragment(&format!("#chat={seed}');alert(1)//")), None);
        assert_eq!(chat_fragment(&format!("chat={seed}")), None);
        assert_eq!(chat_fragment(&format!("#k={seed}")), None);
        assert_eq!(chat_hash(""), Some(String::new()));
        assert_eq!(
            chat_hash(&format!("chat={seed}&p=1")),
            Some(format!("#chat={seed}&p=1"))
        );
        assert_eq!(chat_hash(&format!("chat={seed}&x=<b>")), None);
    }

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
        // старый адрес сайта (до переезда на zvonochek.github.io) — ссылки из прошлых приглашений
        assert_eq!(
            parse_link(&format!("https://qwkejkqwje1.github.io/zvonochek/#k={S}")),
            Some(want.clone())
        );
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
