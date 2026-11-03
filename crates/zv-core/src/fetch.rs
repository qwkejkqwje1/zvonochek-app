//! Прокси HTTP для встроенного веб-клиента: Worker веба отвергает чужой Origin (`https://tauri.localhost`),
//! а запросы без Origin пускает. Поэтому `fetch` к Worker и TURN-провайдеру идёт через ядро.

use base64::Engine;
use serde_json::{Map, Value, json};
use std::time::Duration;

const MAX_BODY: usize = 4 * 1024 * 1024;

/// Разрешённые адреса: Worker из настроек, любые `*.workers.dev`, TURN Metered; в разработке — localhost.
pub fn allowed(url: &url::Url, worker_host: Option<&str>, dev: bool) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if dev && (host == "127.0.0.1" || host == "localhost") {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    Some(host) == worker_host
        || host.ends_with(".workers.dev")
        || host.ends_with(".metered.live")
        || host == "metered.live"
}

pub async fn http_fetch(
    args: &Value,
    worker_host: Option<&str>,
    dev: bool,
) -> Result<Value, String> {
    let url_s = args.get("url").and_then(|v| v.as_str()).ok_or("url")?;
    let url = url::Url::parse(url_s).map_err(|e| e.to_string())?;
    if !allowed(&url, worker_host, dev) {
        return Err(format!(
            "адрес не разрешён: {}",
            url.host_str().unwrap_or("")
        ));
    }
    let method = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = zv_signal::tls::http()
        .request(method, url.clone())
        .timeout(Duration::from_secs(20));
    if let Some(h) = args.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in h {
            let kl = k.to_ascii_lowercase();
            if matches!(
                kl.as_str(),
                "origin" | "host" | "cookie" | "referer" | "content-length" | "connection"
            ) {
                continue;
            }
            if let Some(s) = v.as_str() {
                req = req.header(k.as_str(), s);
            }
        }
    }
    if let Some(b) = args.get("bodyB64").and_then(|v| v.as_str()) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b)
            .map_err(|e| e.to_string())?;
        req = req.body(bytes);
    } else if let Some(b) = args.get("body").and_then(|v| v.as_str()) {
        req = req.body(b.to_string());
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let mut headers = Map::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            headers.insert(k.as_str().to_string(), Value::String(s.to_string()));
        }
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BODY {
        return Err("ответ слишком большой".into());
    }
    let mut out = json!({"status": status, "headers": headers, "url": url_s});
    match std::str::from_utf8(&bytes) {
        Ok(s) => out["body"] = Value::String(s.to_string()),
        Err(_) => {
            out["bodyB64"] = Value::String(base64::engine::general_purpose::STANDARD.encode(&bytes))
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowlist() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(allowed(
            &u("https://zvonochek.zerewgwe.workers.dev/turn"),
            None,
            false
        ));
        assert!(allowed(
            &u("https://x.metered.live/api/v1/turn/credentials"),
            None,
            false
        ));
        assert!(!allowed(&u("https://evil.example/"), None, false));
        assert!(!allowed(
            &u("http://zvonochek.zerewgwe.workers.dev/turn"),
            None,
            false
        ));
        assert!(allowed(
            &u("https://my.example/turn"),
            Some("my.example"),
            false
        ));
        assert!(!allowed(&u("http://127.0.0.1:8787/turn"), None, false));
        assert!(allowed(&u("http://127.0.0.1:8787/turn"), None, true));
    }
}
