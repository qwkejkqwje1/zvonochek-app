//! ZVONochek для ПК (Windows): ядро на Rust + окна WebView2 (Tauri 2).
//!
//! Окна: «main» — оболочка (ui/shell), «call-N» — встроенный веб-клиент звонка (ui/web, signaling.js → ядро),
//! «incoming» — всплывающее окно входящего. Во все окна до скриптов страницы встраивается ui/desktop/preload.js.
//! Приложение живёт в трее и ждёт звонков по «Моим ссылкам»; выход — только из меню трея (или если отключено
//! «Закрывать в трей»).

#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

mod host;
mod wins;

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Wry};
use zv_core::{Core, CoreEvent, CoreOptions};

pub const PRELOAD: &str = include_str!("../../ui/desktop/preload.js");
const WEB_VERSION_FILE: &str = include_str!("../../ui/web/WEB_VERSION");

pub struct AppState {
    pub core: Core,
    pub call_seq: AtomicU32,
    /// Метка текущего окна звонка.
    pub current_call: Mutex<Option<String>>,
    /// Ссылка из командной строки / deep link, пока оболочка не загрузилась.
    pub pending_url: Mutex<Option<String>>,
    pub main_ready: AtomicBool,
    pub quitting: AtomicBool,
    pub tray_dnd: Mutex<Option<CheckMenuItem<Wry>>>,
    /// callId → (имя, ссылка) — для уведомления о пропущенном.
    pub incoming_names: Mutex<HashMap<String, (String, String)>>,
    pub last_url: Mutex<(String, std::time::Instant)>,
    pub log_dir: std::path::PathBuf,
}

fn web_version() -> u32 {
    WEB_VERSION_FILE.lines().find_map(|l| l.strip_prefix("ver=").and_then(|v| v.trim().parse().ok())).unwrap_or(0)
}

fn platform() -> String {
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    format!("{}-{arch}", std::env::consts::OS)
}

static LOG_GUARD: std::sync::OnceLock<tracing_appender::non_blocking::WorkerGuard> = std::sync::OnceLock::new();

fn init_logging(dir: &std::path::Path) {
    use tracing_subscriber::prelude::*;
    let _ = std::fs::create_dir_all(dir);
    let filter = tracing_subscriber::EnvFilter::try_from_env("ZV_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,zv_signal=info,tao=warn,wry=warn"));
    let file = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("zvonochek")
        .filename_suffix("log")
        .max_log_files(7)
        .build(dir);
    let registry = tracing_subscriber::registry().with(filter);
    match file {
        Ok(f) => {
            let (nb, guard) = tracing_appender::non_blocking(f);
            let _ = LOG_GUARD.set(guard);
            let _ = registry
                .with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(nb))
                .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
                .try_init();
        }
        Err(_) => {
            let _ = registry.with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr)).try_init();
        }
    }
}

/// Аргумент командной строки или deep link: ссылка звонка → в оболочку.
pub fn handle_url(app: &AppHandle, url: &str) {
    let st = app.state::<AppState>();
    {
        let mut last = st.last_url.lock().unwrap();
        if last.0 == url && last.1.elapsed().as_secs() < 3 {
            return;
        }
        *last = (url.to_string(), std::time::Instant::now());
    }
    let parsed = st.core.dispatch_sync("link_parse", &json!({"text": url})).and_then(|r| r.ok()).unwrap_or(Value::Null);
    let web_url = match parsed.get("kind").and_then(|v| v.as_str()) {
        Some("call") => parsed.get("url").and_then(|v| v.as_str()).unwrap_or(url).to_string(),
        // код приглашения в контакты — оболочка откроет «Добавить по коду»
        Some("contact") => url.to_string(),
        _ => {
            tracing::info!("ссылка не на звонок и не код контакта — пропускаю");
            return;
        }
    };
    wins::show_main(app);
    if st.main_ready.load(Ordering::SeqCst) {
        let _ = app.emit("zv", CoreEvent { event: "host:deeplink".into(), payload: json!({"url": web_url}) });
    } else {
        *st.pending_url.lock().unwrap() = Some(web_url);
    }
}

fn handle_argv(app: &AppHandle, argv: &[String]) {
    for a in argv.iter().skip(1) {
        if a.starts_with("zvonochek:") || a.contains("#k=") {
            handle_url(app, a);
        }
    }
}

/// События ядра → во все окна + реакция хоста (всплывающее окно, уведомления, трей).
async fn forward_events(app: AppHandle) {
    let mut rx = app.state::<AppState>().core.subscribe();
    loop {
        let ev = match rx.recv().await {
            Ok(ev) => ev,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!("пропущено {n} событий ядра");
                continue;
            }
            Err(_) => return,
        };
        let _ = app.emit("zv", &ev);
        let st = app.state::<AppState>();
        match ev.event.as_str() {
            "call:incoming" | "call:update" => {
                let p = &ev.payload;
                let id = p.get("callId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let link = p.get("linkName").and_then(|v| v.as_str()).unwrap_or("").to_string();
                st.incoming_names.lock().unwrap().insert(id, (name, link));
                if ev.event == "call:incoming" {
                    wins::show_incoming(&app);
                }
            }
            "call:ended" => {
                let id = ev.payload.get("callId").and_then(|v| v.as_str()).unwrap_or("");
                let reason = ev.payload.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                let info = st.incoming_names.lock().unwrap().remove(id);
                if reason == "missed" {
                    let (name, link) = info.unwrap_or_default();
                    let who = if name.is_empty() { "Собеседник".to_string() } else { name };
                    let text = if link.is_empty() { format!("{who} — контакт") } else { format!("{who} — по ссылке «{link}»") };
                    host::notify(&app, "Пропущенный звонок", &text);
                }
                let empty = st
                    .core
                    .dispatch_sync("incoming_list", &Value::Null)
                    .and_then(|r| r.ok())
                    .and_then(|v| v.as_array().map(|a| a.is_empty()))
                    .unwrap_or(true);
                if empty {
                    wins::close_incoming(&app);
                }
            }
            "settings:changed" => {
                let dnd = st.core.settings().dnd;
                if let Some(item) = st.tray_dnd.lock().unwrap().as_ref() {
                    let _ = item.set_checked(dnd);
                }
                wins::update_tray(&app);
            }
            "room:status" | "links:changed" => wins::update_tray(&app),
            "contact:offer" => {
                let name = ev.payload.get("name").and_then(|v| v.as_str()).unwrap_or("Собеседник");
                host::notify(&app, "Предложение контакта", &format!("{name} предлагает обменяться контактами"));
            }
            "contact:added" if ev.payload.get("via").and_then(|v| v.as_str()) == Some("invite") => {
                let name = ev.payload.get("name").and_then(|v| v.as_str()).unwrap_or("Собеседник");
                host::notify(&app, "Новый контакт", &format!("{name} добавил(а) вас в контакты по коду приглашения"));
            }
            _ => {}
        }
    }
}

pub fn quit(app: &AppHandle) {
    let st = app.state::<AppState>();
    st.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
async fn zv(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    cmd: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let args = args.unwrap_or(Value::Null);
    if cmd.starts_with("host_") {
        return host::command(&app, &window, &cmd, args).await;
    }
    state.core.dispatch(&cmd, args).await
}

/// Быстрые команды по порядку вызова (отправка сигналов звонка).
#[tauri::command]
fn zv_sync(state: tauri::State<'_, AppState>, cmd: String, args: Option<Value>) -> Result<Value, String> {
    let args = args.unwrap_or(Value::Null);
    state.core.dispatch_sync(&cmd, &args).unwrap_or_else(|| Err(format!("{cmd}: асинхронная команда")))
}

fn main() {
    let hidden = std::env::args().any(|a| a == "--hidden");
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            tracing::info!("повторный запуск: {} аргументов", argv.len());
            if !argv.iter().any(|a| a == "--hidden") {
                wins::show_main(app);
            }
            handle_argv(app, &argv);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_filter(|label| label == "main")
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![zv, zv_sync])
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let log_dir = app.path().app_log_dir().unwrap_or_else(|_| data_dir.join("logs"));
            init_logging(&log_dir);
            tracing::info!("ZVONochek {} ({}) — данные в {}", env!("CARGO_PKG_VERSION"), platform(), data_dir.display());
            let opts = CoreOptions {
                data_dir: data_dir.clone(),
                app_version: app.package_info().version.to_string(),
                web_version: web_version(),
                platform: platform(),
                dev: cfg!(debug_assertions),
                signal: None,
                p2p_n0: true,
                downloads_dir: app.path().download_dir().ok().map(|d| d.join("ZVONochek")),
            };
            let core = tauri::async_runtime::block_on(async { Core::start(opts) })?;
            app.manage(AppState {
                core,
                call_seq: AtomicU32::new(0),
                current_call: Mutex::new(None),
                pending_url: Mutex::new(None),
                main_ready: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                tray_dnd: Mutex::new(None),
                incoming_names: Mutex::new(HashMap::new()),
                last_url: Mutex::new((String::new(), std::time::Instant::now())),
                log_dir,
            });
            tauri::async_runtime::spawn(forward_events(handle.clone()));
            wins::build_tray(&handle)?;
            // deep links: zvonochek://call#k=…
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                #[cfg(windows)]
                if let Err(e) = app.deep_link().register_all() {
                    tracing::warn!("регистрация zvonochek://: {e}");
                }
                let h = handle.clone();
                app.deep_link().on_open_url(move |e| {
                    for u in e.urls() {
                        handle_url(&h, u.as_str());
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for u in urls {
                        handle_url(&handle, u.as_str());
                    }
                }
            }
            if !hidden {
                wins::build_main(&handle, true)?;
            }
            handle_argv(&handle, &std::env::args().collect::<Vec<_>>());
            Ok(())
        })
        .on_window_event(wins::on_window_event);

    let app = builder.build(tauri::generate_context!()).expect("не удалось запустить ZVONochek");
    app.run(|app, ev| match ev {
        RunEvent::ExitRequested { code, api, .. } => {
            // последнее окно закрылось — остаёмся в трее; выходим только по явной команде
            if code.is_none() && !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            tracing::info!("выход");
            let core = app.state::<AppState>().core.clone();
            tauri::async_runtime::block_on(async move { core.shutdown().await });
        }
        _ => {}
    });
}
