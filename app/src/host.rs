//! Команды хоста (`host_*`) из окон.

use crate::{AppState, wins};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!("уведомление: {e}");
    }
}

pub async fn command(app: &AppHandle, window: &WebviewWindow, cmd: &str, args: Value) -> Result<Value, String> {
    let st = app.state::<AppState>();
    match cmd {
        "host_info" => {
            let pending = if window.label() == "main" {
                st.main_ready.store(true, Ordering::SeqCst);
                st.pending_url.lock().unwrap().take()
            } else {
                None
            };
            Ok(json!({
                "host": "tauri",
                "incomingWindow": true,
                "autostart": true,
                "pendingUrl": pending,
                "logDir": st.log_dir.display().to_string(),
            }))
        }
        "host_open_call" => {
            let secret = args.get("secret").and_then(|v| v.as_str()).ok_or("нет secret")?;
            let boot = args.get("boot").cloned().unwrap_or_else(|| json!({}));
            wins::open_call(app, secret, boot)
        }
        "host_call_done" => {
            if window.label().starts_with("call-") {
                let _ = window.close();
            }
            Ok(Value::Null)
        }
        "host_incoming_empty" => {
            wins::close_incoming(app);
            Ok(Value::Null)
        }
        "host_focus" => {
            wins::show_main(app);
            Ok(Value::Null)
        }
        "host_open_external" => {
            let url = args.get("url").and_then(|v| v.as_str()).ok_or("нет url")?;
            let u = url::Url::parse(url).map_err(|e| e.to_string())?;
            if !matches!(u.scheme(), "http" | "https") {
                return Err("только http(s)".into());
            }
            use tauri_plugin_opener::OpenerExt;
            app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "host_open_logs" => {
            use tauri_plugin_opener::OpenerExt;
            app.opener().open_path(st.log_dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "host_autostart_get" => {
            use tauri_plugin_autostart::ManagerExt;
            let on = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
            Ok(json!({"enabled": on}))
        }
        "host_autostart_set" => {
            use tauri_plugin_autostart::ManagerExt;
            let on = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let a = app.autolaunch();
            if on { a.enable() } else { a.disable() }.map_err(|e| e.to_string())?;
            Ok(json!({"enabled": on}))
        }
        "host_update_check" => {
            use tauri_plugin_updater::UpdaterExt;
            let upd = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
            Ok(match upd {
                Some(u) => json!({"available": true, "version": u.version, "notes": u.body}),
                None => json!({"available": false}),
            })
        }
        "host_update_install" => {
            use tauri_plugin_updater::UpdaterExt;
            let upd = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
            let Some(u) = upd else { return Ok(json!({"installed": false})) };
            u.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
            st.quitting.store(true, Ordering::SeqCst);
            app.restart();
        }
        "host_quit" => {
            crate::quit(app);
            Ok(Value::Null)
        }
        _ => Err(format!("неизвестная команда хоста {cmd}")),
    }
}
