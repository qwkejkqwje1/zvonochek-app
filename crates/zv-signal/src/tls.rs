//! Общая настройка TLS (rustls + ring + корневые сертификаты webpki) и клиенты WS/HTTP.

use std::sync::{Arc, OnceLock};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

pub type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    static P: OnceLock<Arc<rustls::crypto::CryptoProvider>> = OnceLock::new();
    P.get_or_init(|| {
        let p = rustls::crypto::ring::default_provider();
        let _ = p.clone().install_default();
        Arc::new(p)
    })
    .clone()
}

fn roots() -> rustls::RootCertStore {
    let mut r = rustls::RootCertStore::empty();
    r.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    r
}

/// TLS-конфигурация для WebSocket (без ALPN).
pub fn ws_tls() -> Arc<rustls::ClientConfig> {
    static C: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    C.get_or_init(|| {
        let cfg = rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("tls versions")
            .with_root_certificates(roots())
            .with_no_client_auth();
        Arc::new(cfg)
    })
    .clone()
}

/// Общий HTTP-клиент (reqwest + rustls/ring).
pub fn http() -> reqwest::Client {
    static H: OnceLock<reqwest::Client> = OnceLock::new();
    H.get_or_init(|| {
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("tls versions")
            .with_root_certificates(roots())
            .with_no_client_auth();
        cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        reqwest::Client::builder()
            .tls_backend_preconfigured(cfg)
            .user_agent(concat!("ZVONochek-Desktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(7))
            .build()
            .expect("http client")
    })
    .clone()
}

/// Подключение WebSocket (ws:// или wss://) с таймаутом.
pub async fn ws_connect(
    url: &str,
    subprotocol: Option<&str>,
    user_agent: &str,
    timeout: std::time::Duration,
) -> anyhow::Result<Ws> {
    let mut req = url.into_client_request()?;
    if let Some(p) = subprotocol {
        req.headers_mut().insert("Sec-WebSocket-Protocol", HeaderValue::from_str(p)?);
    }
    req.headers_mut().insert("User-Agent", HeaderValue::from_str(user_agent)?);
    let fut = tokio_tungstenite::connect_async_tls_with_config(
        req,
        None,
        false,
        Some(Connector::Rustls(ws_tls())),
    );
    let (ws, _resp) = tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| anyhow::anyhow!("timeout"))??;
    Ok(ws)
}
