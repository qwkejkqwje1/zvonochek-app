//! Команды хоста (`host_*`) из окон.

use crate::{AppState, wins};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    // ПК: уведомления Windows можно выключить в настройках
    #[cfg(desktop)]
    if !app.state::<AppState>().core.settings().notifications {
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!("уведомление: {e}");
    }
}

pub async fn command(
    app: &AppHandle,
    window: &WebviewWindow,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    let st = app.state::<AppState>();
    match cmd {
        "host_info" => {
            let pending = if window.label() == "main" {
                st.main_ready.store(true, Ordering::SeqCst);
                wins::shell_loaded(app, window);
                st.pending_url.lock().unwrap().take()
            } else {
                None
            };
            let paths = crate::portable::get();
            let portable = paths.is_some_and(|p| p.portable);
            // ПК: отдельное окно входящего, автозапуск, автообновление, трей. Android — ничего из этого.
            Ok(json!({
                "host": "tauri",
                "mobile": cfg!(mobile),
                "incomingWindow": cfg!(desktop),
                "autostart": cfg!(desktop),
                "updates": cfg!(desktop),
                "tray": cfg!(desktop),
                // Android: кнопка «Работа в фоне» (ограничения батареи)
                "background": cfg!(target_os = "android"),
                "pendingUrl": pending,
                "logDir": st.log_dir.display().to_string(),
                // Windows: переносная версия — данные рядом с exe, обновление — заменой exe
                "portable": portable,
                "updateMode": if portable { "replace" } else { "install" },
                "dataDir": paths.filter(|_| cfg!(desktop)).map(|p| p.data.display().to_string()),
                "dataWarning": paths.and_then(|p| p.warning.clone()),
                "oldData": paths
                    .and_then(|p| p.migrated_from.as_ref())
                    .filter(|d| d.is_dir())
                    .map(|d| d.display().to_string()),
                "winNotify": cfg!(windows),
                "cleanup": cfg!(windows) && portable,
            }))
        }
        "host_open_call" => {
            let secret = args
                .get("secret")
                .and_then(|v| v.as_str())
                .ok_or("нет secret")?;
            let boot = args.get("boot").cloned().unwrap_or_else(|| json!({}));
            wins::open_call(app, secret, boot)
        }
        "host_call_done" => {
            wins::call_done(app, window);
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
            app.opener()
                .open_url(u.as_str(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        #[cfg(desktop)]
        "host_open_logs" => {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_path(st.log_dir.display().to_string(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        #[cfg(desktop)]
        "host_open_data" => {
            use tauri_plugin_opener::OpenerExt;
            let p = crate::portable::get().ok_or("нет папки данных")?;
            app.opener()
                .open_path(p.data.display().to_string(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        // уведомления Windows: настройка + регистрация в реестре (переносной версии без неё Windows их не покажет)
        #[cfg(desktop)]
        "host_notify_set" => {
            let on = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            #[cfg(windows)]
            if crate::portable::get().is_some_and(|p| p.portable) {
                crate::portable::toasts_register(app, on)?;
            }
            st.core
                .dispatch_sync("settings_set", &json!({"patch": {"notifications": on}}))
                .unwrap_or_else(|| Err("нет команды".into()))?;
            Ok(json!({"enabled": on}))
        }
        #[cfg(desktop)]
        "host_notify_test" => {
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title("ZVONochek")
                .body("Проверка: уведомления работают")
                .show()
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        #[cfg(windows)]
        "host_cleanup" => Ok(json!({"done": crate::portable::cleanup(app)})),
        #[cfg(windows)]
        "host_old_data_remove" => Ok(json!({"removed": crate::portable::remove_old(app)?})),
        #[cfg(desktop)]
        "host_autostart_get" => {
            use tauri_plugin_autostart::ManagerExt;
            let on = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
            Ok(json!({"enabled": on}))
        }
        #[cfg(desktop)]
        "host_autostart_set" => {
            use tauri_plugin_autostart::ManagerExt;
            let on = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let a = app.autolaunch();
            if on { a.enable() } else { a.disable() }.map_err(|e| e.to_string())?;
            Ok(json!({"enabled": on}))
        }
        #[cfg(desktop)]
        "host_update_check" => {
            use tauri_plugin_updater::UpdaterExt;
            let upd = app
                .updater()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())?;
            Ok(match upd {
                Some(u) => json!({"available": true, "version": u.version, "notes": u.body}),
                None => json!({"available": false}),
            })
        }
        #[cfg(desktop)]
        "host_update_install" => {
            use tauri_plugin_updater::UpdaterExt;
            if crate::portable::get().is_some_and(|p| p.portable) {
                return Err("переносная версия обновляется заменой ZVONochek.exe".into());
            }
            let upd = app
                .updater()
                .map_err(|e| e.to_string())?
                .check()
                .await
                .map_err(|e| e.to_string())?;
            let Some(u) = upd else {
                return Ok(json!({"installed": false}));
            };
            u.download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            st.quitting.store(true, Ordering::SeqCst);
            app.restart();
        }
        // выбрать файлы для отправки в чат (системный диалог; отмена — пустой список)
        // `{profile: true}` — один файл профиля `.zvp` (перенос с другого компьютера)
        #[cfg(target_os = "android")]
        "host_pick_files" => {
            let profile = args
                .get("profile")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let paths = crate::android::pick_files(app, profile).await?;
            Ok(json!({"paths": paths}))
        }
        #[cfg(desktop)]
        "host_pick_files" => {
            use tauri_plugin_dialog::DialogExt;
            let profile = args
                .get("profile")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let (tx, rx) = tokio::sync::oneshot::channel();
            let d = app.dialog().file().set_parent(window);
            if profile {
                d.set_title("Файл профиля")
                    .add_filter("Профиль ZVONochek", &["zvp"])
                    .pick_file(move |r| {
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
        // Android: файл — в кэш приложения, после записи оболочка предложит «Поделиться» (`share`)
        #[cfg(mobile)]
        "host_save_path" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("ZVONochek.zvp");
            let name: String = name
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
                .collect();
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|e| e.to_string())?
                .join("export");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let p = dir.join(if name.is_empty() {
                "ZVONochek.zvp"
            } else {
                &name
            });
            Ok(json!({"path": p.display().to_string(), "share": true}))
        }
        #[cfg(desktop)]
        "host_save_path" => {
            use tauri_plugin_dialog::DialogExt;
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("ZVONochek.zvp")
                .to_string();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut d = app
                .dialog()
                .file()
                .set_parent(window)
                .set_title("Сохранить профиль")
                .set_file_name(&name);
            d = d.add_filter("Профиль ZVONochek", &["zvp"]);
            if let Some(dir) = dirs_download() {
                d = d.set_directory(dir);
            }
            d.save_file(move |r| {
                let _ = tx.send(r);
            });
            let path = rx
                .await
                .ok()
                .flatten()
                .and_then(|p| p.into_path().ok())
                .map(|p| {
                    if p.extension().is_none() {
                        p.with_extension("zvp")
                    } else {
                        p
                    }
                });
            Ok(json!({"path": path.map(|p| p.display().to_string())}))
        }
        // перенос профиля подготовлен — перезапуск, ядро применит его при старте
        "host_restart" => {
            st.quitting.store(true, Ordering::SeqCst);
            restart(app).await
        }
        #[cfg(target_os = "android")]
        "host_background_settings" => {
            crate::android::background_settings(app).await?;
            Ok(Value::Null)
        }
        // Android: «Поделиться» файлом (сохранённый профиль, файл из чата)
        #[cfg(target_os = "android")]
        "host_share_path" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("нет пути")?;
            crate::android::open_file(app, path, true).await?;
            Ok(Value::Null)
        }
        // открыть файл из чата / показать в папке: путь — только из ядра (по fid), не из страницы
        "host_open_path" => {
            let info = st
                .core
                .dispatch_sync("chat_file_path", &args)
                .unwrap_or_else(|| Err("нет команды".into()))?;
            let path = info
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("нет пути")?
                .to_string();
            let reveal = args
                .get("reveal")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // Android: «Открыть» — в подходящем приложении, «Показать в папке» — «Поделиться»
            #[cfg(target_os = "android")]
            crate::android::open_file(app, &path, reveal).await?;
            #[cfg(desktop)]
            {
                use tauri_plugin_opener::OpenerExt;
                if reveal && info.get("dir").and_then(|v| v.as_bool()) != Some(true) {
                    app.opener()
                        .reveal_item_in_dir(&path)
                        .map_err(|e| e.to_string())?;
                } else {
                    app.opener()
                        .open_path(&path, None::<&str>)
                        .map_err(|e| e.to_string())?;
                }
            }
            Ok(json!({"path": path, "reveal": reveal}))
        }
        "host_quit" => {
            #[cfg(target_os = "android")]
            crate::android::stop(app).await;
            crate::quit(app);
            Ok(Value::Null)
        }
        #[cfg(mobile)]
        "host_autostart_get" | "host_autostart_set" | "host_open_logs" | "host_open_data"
        | "host_notify_set" | "host_notify_test" => Err("на телефоне недоступно".into()),
        #[cfg(mobile)]
        "host_update_check" | "host_update_install" => {
            Err("на Android обновление — новый APK со страницы релизов".into())
        }
        _ => Err(format!("неизвестная команда хоста {cmd}")),
    }
}

/// Перезапуск приложения (ядро применит подготовленный перенос профиля при старте).
#[cfg(not(target_os = "android"))]
async fn restart(app: &AppHandle) -> Result<Value, String> {
    app.restart()
}

/// Android: ядро закрываем сами, новый процесс запускает ZvPlugin (`restart`).
#[cfg(target_os = "android")]
async fn restart(app: &AppHandle) -> Result<Value, String> {
    let core = app.state::<AppState>().core.clone();
    core.shutdown().await;
    crate::android::restart(app).await?;
    Ok(Value::Null)
}

/// Папка «Загрузки» пользователя.
#[cfg(desktop)]
fn dirs_download() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(|h| std::path::PathBuf::from(h).join("Downloads"))
        .filter(|p| p.is_dir())
}
