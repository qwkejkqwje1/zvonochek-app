//! Android: одно окно «main». Оболочка (shell) и звонок (web) открываются в нём по очереди: звонок — переход на
//! `web/index.html?zvboot=…#k=…`, конец звонка (`host_call_done`) или «Назад» — обратно в оболочку. Входящий —
//! карточка поверх оболочки, а если приложение не на экране — уведомление (android.rs: полноэкранное, со звуком).
//! Трея и значка на панели задач нет.

use crate::{AppState, PRELOAD};
use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

const SHELL: &str = "shell/index.html";

fn is_app_url(u: &url::Url) -> bool {
    matches!(u.scheme(), "tauri" | "about" | "data" | "blob")
        || (matches!(u.scheme(), "http" | "https") && u.host_str() == Some("tauri.localhost"))
}

/// Внешние ссылки — в браузере, не в окне приложения.
fn open_outside(app: &AppHandle, u: &url::Url) {
    if matches!(u.scheme(), "http" | "https" | "mailto") {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app.opener().open_url(u.as_str(), None::<&str>) {
            tracing::warn!("не открыть внешнюю ссылку: {e}");
        }
    } else if u.scheme() == "zvonochek" {
        crate::handle_url(app, u.as_str());
    }
}

pub fn build_main(app: &AppHandle, _visible: bool) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window("main") {
        return Ok(w);
    }
    let nav_app = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App(SHELL.into()))
        .use_https_scheme(true)
        .initialization_script(PRELOAD)
        .on_navigation(move |u| {
            if is_app_url(u) {
                return true;
            }
            open_outside(&nav_app, u);
            false
        })
        .build()
}

pub fn show_main(app: &AppHandle) {
    if let Err(e) = build_main(app, true) {
        tracing::error!("главное окно: {e}");
    }
    #[cfg(target_os = "android")]
    crate::android::bring_to_front(app);
}

/// Адрес страницы приложения в том же источнике, что и текущая страница окна.
fn app_url(w: &WebviewWindow, path_and_query: &str) -> Result<url::Url, String> {
    let cur = w.url().map_err(|e| e.to_string())?;
    cur.join(path_and_query).map_err(|e| e.to_string())
}

pub fn open_call(app: &AppHandle, secret: &str, boot: Value) -> Result<Value, String> {
    if !zv_proto::link::valid_secret(secret) {
        return Err("неверная ссылка".into());
    }
    let st = app.state::<AppState>();
    let w = build_main(app, true).map_err(|e| e.to_string())?;
    let replace = boot
        .get("replace")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let in_call = st.current_call.lock().unwrap().is_some();
    if in_call && !replace {
        return Ok(json!({"focused": true, "busy": true}));
    }
    if in_call {
        // ответ на второй звонок: текущий завершаем сразу (bye)
        let _ = st
            .core
            .dispatch_sync("rooms_leave_all", &json!({"bye": true}));
    }
    let q: String = url::form_urlencoded::byte_serialize(
        serde_json::to_string(&boot)
            .unwrap_or_else(|_| "{}".into())
            .as_bytes(),
    )
    .collect();
    let u = app_url(&w, &format!("/web/index.html?zvboot={q}#k={secret}"))?;
    *st.current_call.lock().unwrap() = Some("main".into());
    w.navigate(u).map_err(|e| e.to_string())?;
    #[cfg(target_os = "android")]
    crate::android::call_started(app);
    Ok(json!({"opened": true}))
}

/// Веб-чаты сайта (`#chat=`): встроенный веб-клиент в том же окне; «Назад» из списка чатов —
/// `host_call_done` (звонка нет — просто обратно в оболочку).
pub fn open_chat(app: &AppHandle, hash: &str, boot: Value) -> Result<Value, String> {
    let st = app.state::<AppState>();
    if st.current_call.lock().unwrap().is_some() {
        return Err("идёт звонок — чаты сайта откроются после него".into());
    }
    let w = build_main(app, true).map_err(|e| e.to_string())?;
    let q: String = url::form_urlencoded::byte_serialize(
        serde_json::to_string(&boot)
            .unwrap_or_else(|_| "{}".into())
            .as_bytes(),
    )
    .collect();
    let u = app_url(&w, &format!("/web/index.html?zvboot={q}{hash}"))?;
    w.navigate(u).map_err(|e| e.to_string())?;
    Ok(json!({"opened": true}))
}

/// Звонок закончился (страница звонка сообщила или ушли с неё): выйти из комнат и вернуться в оболочку.
pub fn call_done(app: &AppHandle, window: &WebviewWindow) {
    let st = app.state::<AppState>();
    let was = st.current_call.lock().unwrap().take().is_some();
    if was {
        let _ = st
            .core
            .dispatch_sync("rooms_leave_all", &json!({"bye": true}));
    }
    #[cfg(target_os = "android")]
    crate::android::call_ended(app);
    if window.label() == "main"
        && let Ok(u) = app_url(window, &format!("/{SHELL}"))
        && window.url().map(|c| c.path() != u.path()).unwrap_or(true)
    {
        let _ = window.navigate(u);
    }
}

/// Оболочка загрузилась: если до этого шёл звонок (ушли «Назад»), он закончен.
pub fn shell_loaded(app: &AppHandle, window: &WebviewWindow) {
    if !window
        .url()
        .map(|u| u.path().starts_with("/shell/"))
        .unwrap_or(false)
    {
        return;
    }
    let st = app.state::<AppState>();
    if st.current_call.lock().unwrap().take().is_some() {
        let _ = st
            .core
            .dispatch_sync("rooms_leave_all", &json!({"bye": true}));
        #[cfg(target_os = "android")]
        crate::android::call_ended(app);
    }
}

pub fn show_incoming(app: &AppHandle, call_id: &str, text: &str) {
    #[cfg(target_os = "android")]
    crate::android::incoming(app, call_id, text);
    #[cfg(not(target_os = "android"))]
    let _ = (app, call_id, text);
}

pub fn close_incoming(app: &AppHandle) {
    #[cfg(target_os = "android")]
    crate::android::incoming_done(app);
    #[cfg(not(target_os = "android"))]
    let _ = app;
}

pub fn update_tray(_app: &AppHandle) {}

pub fn flash_main(_app: &AppHandle) {}

pub fn set_unread_badge(_app: &AppHandle, _n: u64) {}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::Destroyed = event
        && window.label() == "main"
    {
        let app = window.app_handle();
        app.state::<AppState>()
            .main_ready
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
