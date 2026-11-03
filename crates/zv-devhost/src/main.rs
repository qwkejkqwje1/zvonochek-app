//! zv-devhost — ядро без окна + IPC по WebSocket + раздача `ui/` (разработка и автотесты в Chromium).
//!
//! zv-devhost [--port 8790] [--ui ui] [--data /tmp/zvdev] [--local mqtt=ws://127.0.0.1:9001,worker=http://127.0.0.1:8787]
//!            [--p2p-local] [--mock-worker 8799] [--mobile]
//!
//! `--mock-worker PORT` — поднять заглушку Worker (ChatRoom для почтовых ящиков) на 127.0.0.1:PORT;
//! второй devhost подключается к ней через `--local worker=http://127.0.0.1:PORT`.
//!
//! Протокол `/ipc`: запрос `{id, cmd, args}` → ответ `{id, ok, result | error}`; события `{event, payload}`.
//! Окно звонка: `/web/index.html#k=…` — в страницу встраивается `desktop/preload.js` (как init-скрипт Tauri).

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxPath, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use zv_core::{Core, CoreOptions};

struct App {
    core: Core,
    ui: PathBuf,
    /// Что вернёт следующий `host_pick_files` (тесты задают через `dev_set_pick`).
    pick: std::sync::Mutex<Vec<String>>,
    /// Что «открыли» через `host_open_path` (тесты читают через `dev_opened`).
    opened: std::sync::Mutex<Vec<Value>>,
    /// Папка данных (как у переносной версии на Windows — «рядом с программой»).
    data: PathBuf,
}

fn arg(name: &str) -> Option<String> {
    let mut it = std::env::args();
    while let Some(a) = it.next() {
        if a == name {
            return it.next();
        }
    }
    None
}

fn signal_override() -> Option<zv_signal::SignalConfig> {
    let local = arg("--local")?;
    let mut c = zv_signal::SignalConfig::default();
    c.brokers.clear();
    c.nostr_relays.clear();
    c.worker_url = None;
    c.ntfy_base = None;
    c.mqtt_tcp = false;
    for part in local.split(',') {
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        match k {
            "mqtt" => c.brokers.push(zv_signal::BrokerSpec {
                wss: v.into(),
                tcp: None,
                username: None,
                password: None,
            }),
            "mqtttcp" => {
                c.mqtt_tcp = true;
                if let Some(b) = c.brokers.last_mut() {
                    b.tcp = Some(v.into());
                }
            }
            "worker" => c.worker_url = Some(v.into()),
            "nostr" => c.nostr_relays.push(v.into()),
            "ntfy" => c.ntfy_base = Some(v.into()),
            _ => {}
        }
    }
    Some(c)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    let port: u16 = arg("--port").and_then(|p| p.parse().ok()).unwrap_or(8790);
    let ui = PathBuf::from(arg("--ui").unwrap_or_else(|| "ui".into()));
    let data = PathBuf::from(arg("--data").unwrap_or_else(|| "/tmp/zvdev".into()));
    let web_version = std::fs::read_to_string(ui.join("web/WEB_VERSION"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("ver=").and_then(|v| v.trim().parse().ok()))
        })
        .unwrap_or(0);
    if let Some(p) = arg("--mock-worker").and_then(|p| p.parse::<u16>().ok()) {
        let m = zv_signal::mock::MockWorker::spawn_on(p).await;
        tracing::info!("devhost: заглушка Worker {}", m.url);
    }
    let core = Core::start(CoreOptions {
        data_dir: data.clone(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        web_version,
        platform: "devhost".into(),
        dev: true,
        signal: signal_override(),
        // --p2p-local: только прямые адреса, без релеев и поиска n0
        p2p_n0: !std::env::args().any(|a| a == "--p2p-local"),
        downloads_dir: Some(data.join("Downloads")),
    })?;
    let app = Arc::new(App {
        core,
        ui,
        pick: Default::default(),
        opened: Default::default(),
        data: data.clone(),
    });
    let router = axum::Router::new()
        .route("/ipc", get(ipc))
        .route(
            "/",
            get(|| async { axum::response::Redirect::temporary("/shell/index.html") }),
        )
        .route("/{*path}", get(file))
        .with_state(app);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("devhost: http://{addr}/");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).await?;
    Ok(())
}

async fn ipc(State(app): State<Arc<App>>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(8 << 20)
        .on_upgrade(move |s| client(app, s))
}

async fn client(app: Arc<App>, ws: WebSocket) {
    let (mut tx, mut rx) = ws.split();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut events = app.core.subscribe();
    let ev_tx = out_tx.clone();
    let ev_task = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(ev) => {
                    if ev_tx
                        .send(serde_json::to_string(&ev).unwrap_or_default())
                        .is_err()
                    {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("ipc: пропущено {n} событий")
                }
                Err(_) => return,
            }
        }
    });
    let writer = tokio::spawn(async move {
        while let Some(s) = out_rx.recv().await {
            if tx.send(Message::Text(s.into())).await.is_err() {
                return;
            }
        }
    });
    // комнаты, в которые вошла эта страница: при закрытии вкладки — выйти (как окно звонка в Tauri)
    let joined: Arc<std::sync::Mutex<std::collections::HashSet<String>>> = Default::default();
    while let Some(Ok(m)) = rx.next().await {
        let Message::Text(t) = m else { continue };
        let Ok(req) = serde_json::from_str::<Value>(t.as_str()) else {
            continue;
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let cmd = req
            .get("cmd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args = req.get("args").cloned().unwrap_or(Value::Null);
        let reply = |out: &tokio::sync::mpsc::UnboundedSender<String>,
                     id: Value,
                     r: Result<Value, String>| {
            let resp = match r {
                Ok(v) => json!({"id": id, "ok": true, "result": v}),
                Err(e) => json!({"id": id, "ok": false, "error": e}),
            };
            let _ = out.send(resp.to_string());
        };
        // команды хоста: в devhost окна — это вкладки, их открывает сама страница
        let host = match cmd.as_str() {
            // --mobile: оболочка в режиме телефона (как Android: нижние вкладки, «Назад», без трея)
            // ПК — как переносная версия Windows: папка данных, уведомления, «Убрать следы»;
            // `old` в папке данных — будто копия прежней версии в AppData
            "host_info" => Some(Ok(if std::env::args().any(|a| a == "--mobile") {
                json!({"host": "devhost", "mobile": true, "background": true})
            } else {
                let old = app.data.join("old");
                json!({"host": "devhost", "portable": true, "updateMode": "replace",
                    "dataDir": app.data.display().to_string(), "winNotify": true, "cleanup": true,
                    "oldData": old.is_dir().then(|| old.display().to_string())})
            })),
            "host_notify_set" => {
                let on = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                app.opened.lock().unwrap().push(json!({"notify": on}));
                Some(
                    app.core
                        .dispatch_sync("settings_set", &json!({"patch": {"notifications": on}}))
                        .unwrap_or_else(|| Err("нет команды".into()))
                        .map(|_| json!({"enabled": on})),
                )
            }
            "host_notify_test" | "host_open_data" | "host_quit" => {
                app.opened.lock().unwrap().push(json!({"host": cmd}));
                Some(Ok(Value::Null))
            }
            "host_cleanup" => {
                app.opened.lock().unwrap().push(json!({"host": cmd}));
                Some(Ok(json!({"done": ["ссылки zvonochek://", "уведомления Windows"]})))
            }
            "host_old_data_remove" => {
                let old = app.data.join("old");
                Some(std::fs::remove_dir_all(&old).map(|_| json!({"removed": [old.display().to_string()]})).map_err(|e| e.to_string()))
            }
            "host_open_call" => Some(Ok(host_open_call(&args))),
            "host_call_done" | "host_focus" | "host_open_external" | "host_incoming_empty" => Some(Ok(Value::Null)),
            // как в приложении: путь берём у ядра (только файлы чатов), но не открываем — запоминаем
            "host_open_path" => Some(app.core.dispatch_sync("chat_file_path", &args).unwrap_or_else(|| Err("нет команды".into())).map(|v| {
                let rec = json!({"path": v["path"], "reveal": args.get("reveal").and_then(|x| x.as_bool()).unwrap_or(false)});
                app.opened.lock().unwrap().push(rec.clone());
                rec
            })),
            "dev_opened" => Some(Ok(Value::Array(app.opened.lock().unwrap().clone()))),
            // событие хоста только этой странице (имитация перетаскивания файлов: host:drop)
            "dev_emit" => {
                let ev = json!({"event": args.get("event").cloned().unwrap_or(Value::Null), "payload": args.get("payload").cloned().unwrap_or(Value::Null)});
                let _ = out_tx.send(ev.to_string());
                Some(Ok(Value::Null))
            }
            "host_pick_files" => Some(Ok(json!({"paths": std::mem::take(&mut *app.pick.lock().unwrap())}))),
            // без диалога: ядро сохранит профиль в папку загрузок
            "host_save_path" => Some(Ok(json!({"path": null}))),
            // перезапуск делает тест (перезапускает процесс devhost); здесь только отмечаем
            "host_restart" => {
                app.opened.lock().unwrap().push(json!({"restart": true}));
                Some(Ok(json!({"restart": false})))
            }
            "dev_set_pick" => {
                let v: Vec<String> = args
                    .get("paths")
                    .and_then(|p| p.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                *app.pick.lock().unwrap() = v;
                Some(Ok(Value::Null))
            }
            "host_autostart_get" | "host_autostart_set" | "host_update_check" | "host_update_install" => {
                Some(Err("не поддерживается в zv-devhost".to_string()))
            }
            _ => None,
        };
        if let Some(r) = host {
            reply(&out_tx, id, r);
            continue;
        }
        // быстрые команды — сразу и по порядку
        if let Some(r) = app.core.dispatch_sync(&cmd, &args) {
            if let Ok(v) = &r {
                let mut j = joined.lock().unwrap();
                match cmd.as_str() {
                    "room_join" => {
                        if let Some(rid) = v.get("roomId").and_then(|x| x.as_str()) {
                            j.insert(rid.to_string());
                        }
                    }
                    "room_leave" => {
                        if let Some(rid) = args.get("roomId").and_then(|x| x.as_str()) {
                            j.remove(rid);
                        }
                    }
                    _ => {}
                }
            }
            reply(&out_tx, id, r);
            continue;
        }
        let core = app.core.clone();
        let out = out_tx.clone();
        tokio::spawn(async move {
            let r = core.dispatch(&cmd, args).await;
            reply(&out, id, r);
        });
    }
    let rooms: Vec<String> = joined.lock().unwrap().drain().collect();
    for rid in rooms {
        tracing::info!("ipc: страница закрыта — выход из комнаты {rid}");
        let a = json!({"roomId": rid});
        let _ = app.core.dispatch_sync("room_bye", &a);
        let _ = app.core.dispatch_sync("room_leave", &a);
    }
    ev_task.abort();
    writer.abort();
}

/// Адрес окна звонка: встроенный веб-клиент с параметрами запуска (`?zvboot=`) и ссылкой в `#k=`.
fn host_open_call(args: &Value) -> Value {
    let secret = args.get("secret").and_then(|v| v.as_str()).unwrap_or("");
    let boot = args.get("boot").cloned().unwrap_or_else(|| json!({}));
    let q: String = url_encode(&boot.to_string());
    json!({"url": format!("/web/index.html?zvboot={q}#k={secret}")})
}

fn url_encode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

fn mime(p: &str) -> &'static str {
    match p.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

async fn file(State(app): State<Arc<App>>, AxPath(path): AxPath<String>) -> Response {
    if path
        .split('/')
        .any(|seg| seg == ".." || seg.starts_with('.'))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut p = path.clone();
    if p.ends_with('/') || p.is_empty() {
        p.push_str("index.html");
    }
    let full = app.ui.join(&p);
    let Ok(mut bytes) = tokio::fs::read(&full).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // окно звонка: preload раньше всех скриптов страницы (как init-скрипт Tauri)
    if p == "web/index.html" {
        let html = String::from_utf8_lossy(&bytes).to_string();
        let tag = "<script src=\"../desktop/preload.js\"></script>";
        let html = match html.find("<head>") {
            Some(i) => format!("{}{tag}{}", &html[..i + 6], &html[i + 6..]),
            None => format!("{tag}{html}"),
        };
        bytes = html.into_bytes();
    }
    let mut r = Response::new(axum::body::Body::from(bytes));
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(&p)));
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}
