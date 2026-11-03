//! Самообновление переносной версии (Windows). Ядро находит и скачивает подписанный exe (zv-core update.rs) в
//! `ZVONochek-data\update\`; здесь он встаёт на место запущенного: работающий ZVONochek.exe переименовывается в
//! `ZVONochek.exe.old` (Windows это разрешает), новый ложится на его место. Новая версия начинает работать со
//! следующего запуска; «Перезапустить» запускает её с `--wait-pid` — дождаться выхода старой (иначе «один
//! экземпляр» отдал бы запуск ей же). `.old` удаляется после успешного запуска новой.
//!
//! Автообновление (настройка «Обновлять автоматически», по умолчанию включена): через 2 минуты после запуска
//! и затем раз в 6 часов — проверить, скачать и поставить; оболочке — событие `host:update`.

use crate::AppState;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use zv_core::CoreEvent;

/// Версия, которая уже стоит на месте exe и ждёт перезапуска.
static READY: Mutex<Option<String>> = Mutex::new(None);

pub fn ready() -> Option<String> {
    READY.lock().unwrap().clone()
}

/// Перезапуск после обновления: дождаться выхода прежнего процесса.
pub fn wait_pid() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    let args: Vec<String> = std::env::args().collect();
    let Some(pid) = args
        .iter()
        .position(|a| a == "--wait-pid")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse::<u32>().ok())
    else {
        return;
    };
    unsafe {
        let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !h.is_null() {
            WaitForSingleObject(h, 60_000);
            CloseHandle(h);
        }
    }
}

fn exe() -> Result<PathBuf, String> {
    crate::portable::get()
        .map(|p| p.exe.clone())
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "не найден путь к ZVONochek.exe".into())
}

fn old_path(exe: &Path) -> PathBuf {
    let mut s = exe.as_os_str().to_owned();
    s.push(".old");
    PathBuf::from(s)
}

/// Поставить проверенный exe на место запущенного (откат при ошибке).
fn install(new: &Path) -> Result<(), String> {
    let exe = exe()?;
    let old = old_path(&exe);
    if old.exists() {
        std::fs::remove_file(&old)
            .map_err(|e| format!("не удалось удалить {}: {e}", old.display()))?;
    }
    std::fs::rename(&exe, &old).map_err(|e| {
        format!(
            "не удалось переименовать {} (папка только для чтения?): {e}",
            exe.display()
        )
    })?;
    if let Err(e) = std::fs::rename(new, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("не удалось поставить новую версию: {e}"));
    }
    tracing::info!("обновление: новая версия на месте {}", exe.display());
    Ok(())
}

/// Скачать (если ещё нет) и поставить найденную версию: `{ready, version}`.
pub async fn download_install(app: &AppHandle) -> Result<Value, String> {
    if let Some(v) = ready() {
        return Ok(json!({"ready": true, "version": v}));
    }
    let core = app.state::<AppState>().core.clone();
    let d = core.dispatch("update_download", Value::Null).await?;
    let path = d["path"].as_str().ok_or("нет файла обновления")?;
    let version = d["version"].as_str().unwrap_or("").to_string();
    install(Path::new(path))?;
    *READY.lock().unwrap() = Some(version.clone());
    Ok(json!({"ready": true, "version": version}))
}

/// Запустить новую версию и выйти.
pub fn restart(app: &AppHandle) -> Result<Value, String> {
    let exe = exe()?;
    std::process::Command::new(&exe)
        .arg("--wait-pid")
        .arg(std::process::id().to_string())
        .spawn()
        .map_err(|e| format!("не удалось запустить {}: {e}", exe.display()))?;
    crate::quit(app);
    Ok(Value::Null)
}

/// После успешного запуска: убрать прежний exe (прежний процесс мог ещё не выйти — несколько попыток)
/// и проверять обновления в фоне.
pub fn after_start(app: &AppHandle) {
    if let Ok(exe) = exe() {
        let old = old_path(&exe);
        if old.exists() {
            std::thread::spawn(move || {
                for _ in 0..30 {
                    if std::fs::remove_file(&old).is_ok() || !old.exists() {
                        tracing::info!("обновление: прежняя версия удалена");
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
                tracing::warn!("не удалось удалить {}", old.display());
            });
        }
    }
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        loop {
            auto_once(&app).await;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit(
        "zv",
        CoreEvent {
            event: "host:update".into(),
            payload,
        },
    );
}

async fn auto_once(app: &AppHandle) {
    if ready().is_some() {
        return;
    }
    let core = app.state::<AppState>().core.clone();
    let c = match core.dispatch("update_check", Value::Null).await {
        Ok(c) => c,
        Err(e) => {
            tracing::info!("обновление: проверка не удалась: {e}");
            return;
        }
    };
    if c["available"] != true {
        return;
    }
    let version = c["version"].as_str().unwrap_or("").to_string();
    if !core.settings().auto_update {
        emit(
            app,
            json!({"version": version, "notes": c["notes"], "ready": false}),
        );
        return;
    }
    tracing::info!("обновление: скачиваю {version}");
    match download_install(app).await {
        Ok(_) => {
            emit(
                app,
                json!({"version": version, "notes": c["notes"], "ready": true}),
            );
            crate::host::notify(
                app,
                "ZVONochek обновлён",
                &format!("Версия {version} заработает после перезапуска программы"),
            );
        }
        Err(e) => {
            tracing::warn!("обновление {version}: {e}");
            emit(
                app,
                json!({"version": version, "notes": c["notes"], "ready": false, "error": e}),
            );
        }
    }
}
