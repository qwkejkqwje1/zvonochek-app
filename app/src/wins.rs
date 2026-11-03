//! Окна и трей.

use crate::{AppState, PRELOAD};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window, WindowEvent,
};

/// Одинаковые для всех окон (общее окружение WebView2): мелодия звонка без жеста пользователя.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
const TRAY_ID: &str = "zv-tray";

fn is_app_url(u: &url::Url) -> bool {
    matches!(u.scheme(), "tauri" | "about" | "data" | "blob")
        || (matches!(u.scheme(), "http" | "https") && u.host_str() == Some("tauri.localhost"))
}

/// Внешние ссылки — в браузере по умолчанию, не в окне приложения.
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

fn base<'a>(
    app: &'a AppHandle,
    label: &str,
    page: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let nav_app = app.clone();
    let win_app = app.clone();
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()));
    // переносная версия: профиль WebView2 — в папке данных рядом с exe (иначе Tauri берёт %LOCALAPPDATA%)
    if let Some(dir) = crate::portable::get().and_then(|p| p.webview.clone()) {
        b = b.data_directory(dir);
    }
    b.additional_browser_args(BROWSER_ARGS)
        .use_https_scheme(true)
        .on_navigation(move |u| {
            if is_app_url(u) {
                return true;
            }
            open_outside(&nav_app, u);
            false
        })
        .on_new_window(move |u, _| {
            open_outside(&win_app, &u);
            NewWindowResponse::Deny
        })
}

pub fn build_main(app: &AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window("main") {
        return Ok(w);
    }
    // создаём скрытым: сначала прежние размер и место, потом показываем (без прыжка из центра)
    let w = base(app, "main", "shell/index.html")
        .title("ZVONochek")
        .inner_size(980.0, 680.0)
        .min_inner_size(400.0, 520.0)
        .center()
        .visible(false)
        .initialization_script(PRELOAD)
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Autoplay | PermissionKind::ClipboardRead => PermissionResponse::Allow,
            PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::Geolocation => {
                PermissionResponse::Deny
            }
            _ => PermissionResponse::Default,
        })
        .build()?;
    let max = restore_main_state(app, &w);
    if visible {
        let _ = w.show();
        if max {
            let _ = w.maximize();
        }
        let _ = w.set_focus();
    }
    Ok(w)
}

/// Окно пароля профиля (zv-core vault.rs) — до запуска ядра; верный пароль → `zv_unlock` запускает остальное.
pub fn build_unlock(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    base(app, "unlock", "shell/unlock.html")
        .title("ZVONochek — пароль профиля")
        .inner_size(440.0, 460.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .focused(true)
        .build()
}

/// Размер и место главного окна (window.json в папке данных; физические пиксели, как у системы).
#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Copy)]
struct WinState {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    max: bool,
}

fn load_main_state() -> Option<WinState> {
    let raw = std::fs::read(crate::portable::window_file()?).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Прежние размер и место — если окно попадёт на один из мониторов (монитор могли отключить).
/// Возвращает, было ли окно развёрнуто.
fn restore_main_state(app: &AppHandle, w: &WebviewWindow) -> bool {
    let Some(s) = load_main_state() else {
        return false;
    };
    let visible = app
        .available_monitors()
        .map(|ms| {
            ms.iter().any(|m| {
                let (p, z) = (m.position(), m.size());
                let (r, b) = (p.x + z.width as i32, p.y + z.height as i32);
                // заголовок окна должен быть на экране: за него окно и перетаскивают
                s.x + s.w as i32 > p.x + 80 && s.x < r - 80 && s.y >= p.y - 8 && s.y < b - 40
            })
        })
        .unwrap_or(false);
    if s.w >= 300 && s.h >= 300 && visible {
        let _ = w.set_size(tauri::PhysicalSize::new(s.w, s.h));
        let _ = w.set_position(tauri::PhysicalPosition::new(s.x, s.y));
    }
    s.max
}

/// Запомнить размер и место главного окна (при закрытии и выходе).
pub fn save_main_state(app: &AppHandle) {
    let (Some(w), Some(file)) = (
        app.get_webview_window("main"),
        crate::portable::window_file(),
    ) else {
        return;
    };
    if w.is_minimized().unwrap_or(false) {
        return;
    }
    let mut s = load_main_state().unwrap_or_default();
    s.max = w.is_maximized().unwrap_or(false);
    // развёрнутое — запоминаем только флаг, обычный размер остаётся прежним
    if !s.max
        && let (Ok(p), Ok(z)) = (w.outer_position(), w.inner_size())
    {
        (s.x, s.y, s.w, s.h) = (p.x, p.y, z.width, z.height);
    }
    if let Ok(json) = serde_json::to_vec(&s)
        && let Err(e) = std::fs::write(&file, json)
    {
        tracing::warn!("{}: {e}", file.display());
    }
}

/// Показать главное окно (создать, если закрыто).
pub fn show_main(app: &AppHandle) {
    let app = app.clone();
    // создание окна — не в главном потоке обработчика (WebView2 на Windows)
    tauri::async_runtime::spawn(async move {
        match build_main(&app, true) {
            Ok(w) => {
                if w.is_minimized().unwrap_or(false) {
                    let _ = w.unminimize();
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => tracing::error!("главное окно: {e}"),
        }
    });
}

/// Окно звонка: встроенный веб-клиент со ссылкой `#k=…` и параметрами запуска.
pub fn open_call(app: &AppHandle, secret: &str, boot: Value) -> Result<Value, String> {
    if !zv_proto::link::valid_secret(secret) {
        return Err("неверная ссылка".into());
    }
    let st = app.state::<AppState>();
    let replace = boot
        .get("replace")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cur = st.current_call.lock().unwrap().clone();
    if let Some(label) = cur
        && let Some(w) = app.get_webview_window(&label)
    {
        if !replace {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return Ok(json!({"focused": true, "busy": true}));
        }
        // ответ на второй звонок: текущий завершаем сразу (bye), окно закрываем
        *st.current_call.lock().unwrap() = None;
        let _ = st
            .core
            .dispatch_sync("rooms_leave_all", &json!({"bye": true}));
        let _ = w.destroy();
    }
    let n = st.call_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("call-{n}");
    let boot_js = format!(
        "window.__ZV_BOOT__={};if(!/(^#|&)k=/.test(location.hash))history.replaceState(null,'',location.pathname+location.search+'#k={secret}');",
        serde_json::to_string(&boot).unwrap_or_else(|_| "{}".into())
    );
    let w = base(app, &label, "web/index.html")
        .title("Звонок — ZVONochek")
        .inner_size(1040.0, 740.0)
        .min_inner_size(360.0, 540.0)
        .center()
        .initialization_script(boot_js)
        .initialization_script(PRELOAD)
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone
            | PermissionKind::Camera
            | PermissionKind::DisplayCapture
            | PermissionKind::ClipboardRead
            | PermissionKind::Autoplay => PermissionResponse::Allow,
            PermissionKind::Notifications | PermissionKind::Geolocation => PermissionResponse::Deny,
            _ => PermissionResponse::Default,
        })
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    *st.current_call.lock().unwrap() = Some(label);
    Ok(json!({"opened": true}))
}

/// Всплывающее окно входящего звонка — внизу справа, поверх всех, без кражи фокуса.
pub fn show_incoming(app: &AppHandle, _call_id: &str, _text: &str) {
    if let Some(w) = app.get_webview_window("incoming") {
        let _ = w.show();
        return;
    }
    let (w, h) = (404.0, 250.0);
    let mut b = base(app, "incoming", "shell/incoming.html")
        .title("Входящий звонок — ZVONochek")
        .inner_size(w, h)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .initialization_script(PRELOAD)
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Autoplay => PermissionResponse::Allow,
            _ => PermissionResponse::Deny,
        });
    if let Ok(Some(m)) = app.primary_monitor() {
        let sf = m.scale_factor();
        let wa = m.work_area();
        let x = (wa.position.x as f64 + wa.size.width as f64) / sf - w - 12.0;
        let y = (wa.position.y as f64 + wa.size.height as f64) / sf - h - 12.0;
        b = b.position(x, y);
    }
    if let Err(e) = b.build() {
        tracing::error!("окно входящего: {e}");
    }
}

/// Окно звонка сообщило, что звонок закончен: закрыть его.
pub fn call_done(_app: &AppHandle, window: &WebviewWindow) {
    if window.label().starts_with("call-") {
        let _ = window.close();
    }
}

/// ПК: звонок — в своём окне, загрузка оболочки его не касается.
pub fn shell_loaded(_app: &AppHandle, _window: &WebviewWindow) {}

pub fn close_incoming(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("incoming") {
        let _ = w.destroy();
    }
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let st = app.state::<AppState>();
    let open = MenuItem::with_id(app, "open", "Открыть ZVONochek", true, None::<&str>)?;
    let dnd = CheckMenuItem::with_id(
        app,
        "dnd",
        "Не беспокоить",
        true,
        st.core.settings().dnd,
        None::<&str>,
    )?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &dnd, &sep, &quit])?;
    *st.tray_dnd.lock().unwrap() = Some(dnd);
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
        .tooltip("ZVONochek")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "dnd" => {
                let st = app.state::<AppState>();
                let dnd = !st.core.settings().dnd;
                let _ = st
                    .core
                    .dispatch_sync("settings_set", &json!({"patch": {"dnd": dnd}}));
            }
            "quit" => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    update_tray(app);
    Ok(())
}

/// Подсказка трея: ждём ли звонков по своим ссылкам.
pub fn update_tray(app: &AppHandle) {
    let st = app.state::<AppState>();
    let links = st
        .core
        .dispatch_sync("links_list", &Value::Null)
        .and_then(|r| r.ok())
        .unwrap_or(Value::Null);
    let listen: Vec<&Value> = links
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|l| {
                    l.get("kind").and_then(|v| v.as_str()) == Some("mine")
                        && l.get("listen").and_then(|v| v.as_bool()) == Some(true)
                })
                .collect()
        })
        .unwrap_or_default();
    let up = listen
        .iter()
        .filter(|l| {
            let s = &l["status"];
            let n = |k: &str| s.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
            n("mqttUp") + n("nostrUp") + n("ntfyUp") + n("p2pUp") > 0
                || s.get("worker").and_then(|v| v.as_str()) == Some("up")
        })
        .count();
    let unread = st.unread.load(Ordering::SeqCst);
    let text = if listen.is_empty() {
        "ZVONochek".to_string()
    } else if st.core.settings().dnd {
        "ZVONochek — не беспокоить".to_string()
    } else if up == listen.len() {
        "ZVONochek — ждём звонков".to_string()
    } else if up > 0 {
        format!("ZVONochek — на связи {up} из {}", listen.len())
    } else {
        "ZVONochek — нет связи".to_string()
    };
    let text = if unread > 0 {
        format!("{text}\nНепрочитанных сообщений: {unread}")
    } else {
        text
    };
    if let Some(t) = app.tray_by_id(TRAY_ID) {
        let _ = t.set_tooltip(Some(&text));
    }
}

/// Новое сообщение, а окно не в фокусе — мигнуть кнопкой на панели задач.
pub fn flash_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main")
        && !w.is_focused().unwrap_or(false)
    {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

/// Значок поверх кнопки на панели задач: есть непрочитанные сообщения.
pub fn set_unread_badge(app: &AppHandle, n: u64) {
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        let icon = if n > 0 {
            Image::from_bytes(include_bytes!("../icons/badge.png")).ok()
        } else {
            None
        };
        let _ = w.set_overlay_icon(icon);
    }
    #[cfg(not(windows))]
    let _ = (app, n);
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let Some(st) = app.try_state::<AppState>() else {
        // профиль ещё закрыт паролем: закрыли окно пароля — выход
        if matches!(event, WindowEvent::Destroyed) && window.label() == "unlock" {
            app.exit(0);
        }
        return;
    };
    let label = window.label().to_string();
    match event {
        WindowEvent::CloseRequested { api, .. } if label == "main" => {
            if st.quitting.load(Ordering::SeqCst) {
                return;
            }
            save_main_state(app);
            let s = st.core.settings();
            if s.close_to_tray {
                api.prevent_close();
                let _ = window.hide();
                if !s.tray_hint_shown {
                    crate::host::notify(
                        app,
                        "ZVONochek работает в трее",
                        "Звонки по вашим ссылкам будут приходить. Выход — в меню значка в трее.",
                    );
                    let _ = st
                        .core
                        .dispatch_sync("settings_set", &json!({"patch": {"trayHintShown": true}}));
                }
            }
        }
        // файлы перетащили в главное окно — оболочка отправит их в открытый чат
        WindowEvent::DragDrop(e) if label == "main" => {
            let ev = match e {
                DragDropEvent::Enter { .. } => {
                    Some(json!({"event": "host:drag", "payload": {"on": true}}))
                }
                DragDropEvent::Leave => {
                    Some(json!({"event": "host:drag", "payload": {"on": false}}))
                }
                DragDropEvent::Drop { paths, .. } => {
                    Some(json!({"event": "host:drop", "payload": {
                        "paths": paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
                    }}))
                }
                _ => None,
            };
            if let Some(ev) = ev {
                let _ = app.emit_to("main", "zv", ev);
            }
        }
        WindowEvent::Destroyed => {
            if label.starts_with("call-") {
                let mut cur = st.current_call.lock().unwrap();
                if cur.as_deref() == Some(label.as_str()) {
                    *cur = None;
                    drop(cur);
                    // окно закрыли посреди звонка — выйти из комнаты с bye
                    let _ = st
                        .core
                        .dispatch_sync("rooms_leave_all", &json!({"bye": true}));
                }
            }
            if label == "main" {
                st.main_ready.store(false, Ordering::SeqCst);
            }
            if (label == "main" || label.starts_with("call-")) && !st.core.settings().close_to_tray
            {
                let call_open = st.current_call.lock().unwrap().is_some();
                if app.get_webview_window("main").is_none() && !call_open {
                    crate::quit(app);
                }
            }
        }
        _ => {}
    }
}
