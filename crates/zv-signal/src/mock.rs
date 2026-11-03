//! Заглушка Worker веба для тестов и zv-devhost: только ChatRoom (`/chat/<id>/init|msg|fetch|ack`)
//! в памяти, HTTP/1.1 без keep-alive. Остальные пути — 404 (канал Worker сигналинга просто не поднимется).

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Default)]
struct Room {
    token_hash: Option<String>,
    msgs: Vec<(u64, String, String, u64)>, // seq, blob, hash, ts
    acked: std::collections::HashSet<u64>,
}

#[derive(Clone)]
pub struct MockWorker {
    pub url: String,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
}

impl MockWorker {
    /// Запустить на 127.0.0.1 (порт `port`, 0 — любой свободный).
    pub async fn spawn_on(port: u16) -> MockWorker {
        let l = TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("mock worker bind");
        let url = format!("http://{}", l.local_addr().unwrap());
        let me = MockWorker {
            url,
            rooms: Arc::default(),
        };
        let m = me.clone();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                let m = m.clone();
                tokio::spawn(async move {
                    let _ = m.serve(s).await;
                });
            }
        });
        me
    }

    pub async fn spawn() -> MockWorker {
        Self::spawn_on(0).await
    }

    /// Сколько предметов лежит в комнате (тесты).
    pub fn count(&self, chat_id: &str) -> usize {
        self.rooms
            .lock()
            .unwrap()
            .get(chat_id)
            .map(|r| r.msgs.len())
            .unwrap_or(0)
    }

    async fn serve(&self, mut s: TcpStream) -> anyhow::Result<()> {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8192];
        let head_end = loop {
            let n = s.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
            anyhow::ensure!(buf.len() < 64 * 1024, "заголовки");
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
        let mut lines = head.split("\r\n");
        let first = lines.next().unwrap_or("");
        let mut parts = first.split(' ');
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("").to_string();
        let mut headers = HashMap::new();
        for l in lines {
            if let Some((k, v)) = l.split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }
        let len: usize = headers
            .get("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        while buf.len() < head_end + len {
            let n = s.read(&mut tmp).await?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        let body: Value = serde_json::from_slice(&buf[head_end..(head_end + len).min(buf.len())])
            .unwrap_or(Value::Null);
        let token = headers.get("x-access-token").cloned().unwrap_or_default();
        let (code, resp) = self.route(&method, &target, &token, &body);
        let text = resp.to_string();
        let out = format!(
            "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
            text.len()
        );
        s.write_all(out.as_bytes()).await?;
        s.flush().await?;
        Ok(())
    }

    fn route(&self, method: &str, target: &str, token: &str, body: &Value) -> (u16, Value) {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let seg: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if seg.len() != 3 || seg[0] != "chat" || seg[1].len() != 64 {
            return (404, json!({"error": "not found"}));
        }
        let (id, op) = (seg[1], seg[2]);
        let hash = hex::encode(Sha256::digest(token.as_bytes()));
        let mut rooms = self.rooms.lock().unwrap();
        let room = rooms.entry(id.to_string()).or_default();
        if op == "init" && method == "POST" {
            if token.is_empty() {
                return (401, json!({"error": "no token"}));
            }
            match &room.token_hash {
                None => room.token_hash = Some(hash),
                Some(h) if *h != hash => return (403, json!({"error": "forbidden"})),
                _ => {}
            }
            let last = room.msgs.last().map(|m| m.0).unwrap_or(0);
            return (200, json!({"ok": true, "lastSeq": last}));
        }
        if room.token_hash.as_deref() != Some(hash.as_str()) || token.is_empty() {
            return (401, json!({"error": "unauthorized"}));
        }
        match (op, method) {
            ("msg", "POST") => {
                let Some(blob) = body.get("blob").and_then(|b| b.as_str()) else {
                    return (400, json!({"error": "bad blob"}));
                };
                match zv_proto::b64u::dec(blob) {
                    Ok(raw) if raw.len() == crate::mailbox::ITEM_BYTES => {
                        let h = hex::encode(Sha256::digest(&raw));
                        if let Some(m) = room.msgs.iter().find(|m| m.2 == h) {
                            return (200, json!({"ok": true, "seq": m.0, "dup": true}));
                        }
                        let seq = room.msgs.last().map(|m| m.0).unwrap_or(0) + 1;
                        room.msgs
                            .push((seq, blob.to_string(), h, zv_proto::ids::now_ms()));
                        (201, json!({"ok": true, "seq": seq}))
                    }
                    Ok(_) => (400, json!({"error": "bad blob size"})),
                    Err(_) => (400, json!({"error": "bad blob"})),
                }
            }
            ("fetch", "GET") => {
                let after: u64 = query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("after="))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let rows: Vec<Value> = room
                    .msgs
                    .iter()
                    .filter(|m| m.0 > after)
                    .take(500)
                    .map(|m| json!({"seq": m.0, "blob": m.1, "ts": m.3}))
                    .collect();
                let last = rows.last().and_then(|r| r["seq"].as_u64()).unwrap_or(after);
                (200, json!({"messages": rows, "lastSeq": last}))
            }
            ("ack", "POST") => {
                for s in body
                    .get("seqs")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
                {
                    if let Some(n) = s.as_u64() {
                        room.acked.insert(n);
                    }
                }
                (200, json!({"ok": true}))
            }
            _ => (404, json!({"error": "not found"})),
        }
    }
}
