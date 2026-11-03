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
        // выбрать файлы для отправки в чат (системный диалог; отмена — пустой список)
        // `{profile: true}` — один файл профиля `.zvp` (перенос с другого компьютера)
        "host_pick_files" => {
            use tauri_plugin_dialog::DialogExt;
            let profile = args.get("profile").and_then(|v| v.as_bool()).unwrap_or(false);
            let (tx, rx) = tokio::sync::oneshot::channel();
            let d = app.dialog().file().set_parent(window);
            if profile {
                d.set_title("Файл профиля").add_filter("Профиль ZVONochek", &["zvp"]).pick_file(move |r| {
                    let _ = tx.send(r.map(|p| vec![p]));
                });
            } else {
                d.set_title("Отправить файлы").pick_files(move |r| {
                    let _ = tx.send(r);
                });
            }
            let paths: Vec<String> = rx
                .await
                .ok()
                .flatten()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .map(|p| p.display().to_string())
                .collect();
            Ok(json!({"paths": paths}))
        }
        // куда сохранить файл профиля (отмена — `path: null`)
        "host_save_path" => {
            use tauri_plugin_dialog::DialogExt;
            let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("ZVONochek.zvp").to_string();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut d = app.dialog().file().set_parent(window).set_title("Сохранить профиль").set_file_name(&name);
            d = d.add_filter("Профиль ZVONochek", &["zvp"]);
            if let Some(dir) = dirs_download() {
                d = d.set_directory(dir);
            }
            d.save_file(move |r| {
                let _ = tx.send(r);
            });
            let path = rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| {
                if p.extension().is_none() { p.with_extension("zvp") } else { p }
            });
            Ok(json!({"path": path.map(|p| p.display().to_string())}))
        }
        // перенос профиля подготовлен — перезапуск, ядро применит его при старте
        "host_restart" => {
            st.quitting.store(true, Ordering::SeqCst);
            app.restart();
        }
        // открыть файл из чата / показать в папке: путь — только из ядра (по fid), не из страницы
        "host_open_path" => {
            let info = st.core.dispatch_sync("chat_file_path", &args).unwrap_or_else(|| Err("нет команды".into()))?;
            let path = info.get("path").and_then(|v| v.as_str()).ok_or("нет пути")?.to_string();
            let reveal = args.get("reveal").and_then(|v| v.as_bool()).unwrap_or(false);
            use tauri_plugin_opener::OpenerExt;
            if reveal && info.get("dir").and_then(|v| v.as_bool()) != Some(true) {
                app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())?;
            } else {
                app.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())?;
            }
            Ok(json!({"path": path, "reveal": reveal}))
        }
        "host_quit" => {
            crate::quit(app);
            Ok(Value::Null)
        }
        _ => Err(format!("неизвестная команда хоста {cmd}")),
    }
}

/// Папка «Загрузки» пользователя.
fn dirs_download() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE").map(|h| std::path::PathBuf::from(h).join("Downloads")).filter(|p| p.is_dir())
}
