//! Где хранятся данные.
//!
//! Windows — переносная версия: всё лежит в папке `ZVONochek-data` рядом с ZVONochek.exe — настройки, ссылки, контакты,
//! история, переписка, журналы, профиль WebView2, размер окна, полученные файлы («Загрузки»). Переносите exe вместе
//! с папкой. Если рядом с exe писать нельзя (Program Files, носитель только для чтения, защита папок Windows) —
//! как раньше, AppData. Первый запуск копирует данные прежней версии из AppData (оригинал остаётся там же).
//! Секреты (ключ устройства, контакты, ссылки) — как и раньше под DPAPI: папка открывается под той же учётной
//! записью Windows; на другой компьютер профиль переносится файлом («Перенос на другое устройство»).
//! В реестр пишется только то, что без него не работает: ссылки `zvonochek://`, автозапуск (если включён) и
//! регистрация для уведомлений Windows (если включены); «Убрать следы» снимает всё это.
//! Android и прочие — каталоги приложения, как раньше.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

pub const DIR_NAME: &str = "ZVONochek-data";
#[cfg(windows)]
const MIGRATED: &str = "migrated-from.txt";

#[derive(Debug, Clone)]
pub struct Paths {
    pub data: PathBuf,
    pub logs: PathBuf,
    /// Профиль WebView2; `None` — по умолчанию Tauri (%LOCALAPPDATA%).
    pub webview: Option<PathBuf>,
    /// Полученные файлы чатов.
    pub downloads: Option<PathBuf>,
    pub portable: bool,
    /// Откуда скопированы данные прежней версии (пока копия там есть).
    pub migrated_from: Option<PathBuf>,
    /// Предупреждение для оболочки (временная папка, нет записи рядом с exe).
    pub warning: Option<String>,
    /// Сообщения для журнала: пути выбираются до того, как журнал открыт.
    pub notes: Vec<String>,
}

static PATHS: OnceLock<Paths> = OnceLock::new();

pub fn get() -> Option<&'static Paths> {
    PATHS.get()
}

pub fn init(app: &AppHandle) -> anyhow::Result<&'static Paths> {
    if let Some(p) = PATHS.get() {
        return Ok(p);
    }
    let p = resolve(app)?;
    Ok(PATHS.get_or_init(|| p))
}

/// Как до переносной версии: каталоги приложения (Windows — AppData).
fn legacy(app: &AppHandle) -> anyhow::Result<Paths> {
    let data = app.path().app_data_dir()?;
    let logs = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| data.join("logs"));
    // ПК — «Загрузки\ZVONochek»; Android — внутри данных приложения (общая «Download» без MediaStore недоступна)
    let downloads = if cfg!(mobile) {
        Some(data.join("Downloads"))
    } else {
        app.path().download_dir().ok().map(|d| d.join("ZVONochek"))
    };
    Ok(Paths {
        data,
        logs,
        webview: None,
        downloads,
        portable: false,
        migrated_from: None,
        warning: None,
        notes: Vec::new(),
    })
}

#[cfg(not(windows))]
fn resolve(app: &AppHandle) -> anyhow::Result<Paths> {
    legacy(app)
}

#[cfg(windows)]
fn resolve(app: &AppHandle) -> anyhow::Result<Paths> {
    let exe = std::env::current_exe()?;
    let Some(dir) = exe.parent().map(Path::to_path_buf) else {
        return legacy(app);
    };
    let data = dir.join(DIR_NAME);
    let fallback = |app: &AppHandle, why: String, warning: &str| -> anyhow::Result<Paths> {
        let mut p = legacy(app)?;
        p.notes.push(why);
        p.warning = Some(warning.into());
        Ok(p)
    };
    if !data.is_dir() {
        if let Err(e) = probe(&dir) {
            return fallback(
                app,
                format!("рядом с exe нельзя писать ({}): {e} — данные в AppData", dir.display()),
                "Рядом с ZVONochek.exe нельзя сохранять файлы, поэтому данные хранятся в AppData. Чтобы всё было \
                 рядом с программой, переложите ZVONochek.exe в обычную папку (например, «Документы» или на флешку).",
            );
        }
        // первый запуск переносной версии: данные прежней — копией, сначала во временную папку рядом
        let old = legacy(app)?;
        if has_profile(&old.data) {
            let part = dir.join(format!("{DIR_NAME}.part"));
            let _ = std::fs::remove_dir_all(&part);
            match migrate(app, &old.data, &part).and_then(|n| {
                std::fs::rename(&part, &data)?;
                Ok(n)
            }) {
                Ok(n) => {
                    let mut p = portable_paths(&dir, &data);
                    p.notes.push(format!(
                        "скопированы данные прежней версии из {} ({n} файлов)",
                        old.data.display()
                    ));
                    p.migrated_from = Some(old.data);
                    return Ok(finish(p, &dir));
                }
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&part);
                    return fallback(
                        app,
                        format!("копирование из {}: {e} — пока данные в AppData", old.data.display()),
                        "Не удалось скопировать данные рядом с программой, поэтому пока ZVONochek работает с AppData. \
                         Попробует снова при следующем запуске.",
                    );
                }
            }
        }
        std::fs::create_dir_all(&data)?;
    } else if let Err(e) = probe(&data) {
        return fallback(
            app,
            format!("в {} нельзя писать: {e} — данные в AppData", data.display()),
            "В папку ZVONochek-data нельзя записывать (только для чтения?), поэтому данные хранятся в AppData.",
        );
    }
    let mut p = portable_paths(&dir, &data);
    if let Ok(s) = std::fs::read_to_string(data.join(MIGRATED)) {
        let old = PathBuf::from(s.trim());
        if old.is_dir() {
            p.migrated_from = Some(old);
        }
    }
    Ok(finish(p, &dir))
}

#[cfg(windows)]
fn portable_paths(_dir: &Path, data: &Path) -> Paths {
    Paths {
        data: data.to_path_buf(),
        logs: data.join("logs"),
        webview: Some(data.join("webview")),
        downloads: Some(data.join("Загрузки")),
        portable: true,
        migrated_from: None,
        warning: None,
        notes: Vec::new(),
    }
}

#[cfg(windows)]
fn finish(mut p: Paths, dir: &Path) -> Paths {
    if in_temp(dir) {
        p.warning = Some(
            "ZVONochek запущен из временной папки — похоже, прямо из архива. Распакуйте ZVONochek.exe в постоянную \
             папку, иначе данные пропадут при очистке временных файлов."
                .into(),
        );
    }
    p
}

#[cfg(windows)]
fn probe(dir: &Path) -> std::io::Result<()> {
    let f = dir.join(format!(".zv-write-test-{}", std::process::id()));
    std::fs::write(&f, b"ok")?;
    std::fs::remove_file(&f)
}

#[cfg(windows)]
fn in_temp(dir: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(dir).starts_with(canon(&std::env::temp_dir()))
}

fn has_profile(dir: &Path) -> bool {
    dir.join("identity.dat").is_file() || dir.join("settings.json").is_file()
}

/// Копия данных прежней версии: каталог ядра (AppData\Roaming) + профиль WebView2 без кэшей (AppData\Local).
#[cfg(windows)]
fn migrate(app: &AppHandle, old: &Path, new: &Path) -> anyhow::Result<usize> {
    let mut n = copy_dir(old, new, &|name: &str| {
        !(name.ends_with(".tmp")
            || name == "logs"
            || name == "EBWebView"
            || name == ".window-state.json")
    })?;
    if let Ok(local) = app.path().app_local_data_dir() {
        let wv = local.join("EBWebView");
        if wv.is_dir() {
            n += copy_dir(&wv, &new.join("webview").join("EBWebView"), &|name: &str| {
                !(name.ends_with("Cache")
                    || name.ends_with("cache")
                    || matches!(name, "Crashpad" | "BrowserMetrics" | "Service Worker" | "LOCK" | "lockfile"))
            })?;
        }
    }
    std::fs::write(new.join(MIGRATED), format!("{}\n", old.display()))?;
    Ok(n)
}

#[cfg(windows)]
fn copy_dir(from: &Path, to: &Path, keep: &dyn Fn(&str) -> bool) -> anyhow::Result<usize> {
    std::fs::create_dir_all(to)?;
    let mut n = 0;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().to_string();
        if !keep(&name) {
            continue;
        }
        let ft = e.file_type()?;
        if ft.is_dir() {
            n += copy_dir(&e.path(), &to.join(&name), keep)?;
        } else if ft.is_file() {
            std::fs::copy(e.path(), to.join(&name))?;
            n += 1;
        }
    }
    Ok(n)
}

/// Папка данных создана под другой учётной записью Windows или на другом компьютере: секреты под DPAPI здесь
/// не открываются. Ядро в таком случае начало бы с чистого профиля — поэтому не запускаемся и объясняем.
#[cfg(windows)]
pub fn foreign_profile(data: &Path) -> bool {
    ["identity.dat", "contacts.dat", "links.dat"].iter().any(|f| {
        std::fs::read(data.join(f))
            .ok()
            .filter(|raw| raw.starts_with(b"ZVP1"))
            .is_some_and(|raw| zv_core::protect::open(&raw[4..]).is_err())
    })
}

/// Системное окно с ошибкой до запуска интерфейса.
#[cfg(windows)]
pub fn error_box(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MessageBoxW,
    };
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (t, c) = (w(text), w("ZVONochek"));
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            t.as_ptr(),
            c.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

/// Регистрация для уведомлений Windows без установщика: запись AppUserModelId в HKCU (имя и значок).
#[cfg(windows)]
pub fn toasts_register(app: &AppHandle, on: bool) -> Result<(), String> {
    use windows_registry::CURRENT_USER;
    let key = format!(
        "Software\\Classes\\AppUserModelId\\{}",
        app.config().identifier
    );
    if on {
        let k = CURRENT_USER.create(&key).map_err(|e| e.to_string())?;
        k.set_string("DisplayName", "ZVONochek")
            .map_err(|e| e.to_string())?;
        if let Some(icon) = icon_file() {
            k.set_string("IconUri", icon.display().to_string())
                .map_err(|e| e.to_string())?;
        }
    } else if CURRENT_USER.open(&key).is_ok() {
        CURRENT_USER.remove_tree(&key).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Значок для уведомлений — файлом в папке данных (Windows берёт его по пути).
#[cfg(windows)]
fn icon_file() -> Option<PathBuf> {
    const PNG: &[u8] = include_bytes!("../icons/128x128.png");
    let f = get()?.data.join("icon.png");
    if std::fs::metadata(&f).map(|m| m.len() as usize) .ok() != Some(PNG.len()) {
        std::fs::write(&f, PNG).ok()?;
    }
    Some(f)
}

/// «Убрать следы с этого компьютера»: автозапуск, ссылки `zvonochek://`, регистрация уведомлений.
/// Данные в папке рядом с exe не трогаются. Возвращает, что снято.
#[cfg(windows)]
pub fn cleanup(app: &AppHandle) -> Vec<String> {
    use tauri_plugin_autostart::ManagerExt;
    use tauri_plugin_deep_link::DeepLinkExt;
    let mut done = Vec::new();
    if app.autolaunch().is_enabled().unwrap_or(false) && app.autolaunch().disable().is_ok() {
        done.push("автозапуск".to_string());
    }
    match app.deep_link().unregister("zvonochek") {
        Ok(()) => done.push("ссылки zvonochek://".into()),
        Err(e) => tracing::warn!("снятие zvonochek://: {e}"),
    }
    match toasts_register(app, false) {
        Ok(()) => done.push("уведомления Windows".into()),
        Err(e) => tracing::warn!("снятие регистрации уведомлений: {e}"),
    }
    tracing::info!("убраны следы: {}", done.join(", "));
    done
}

/// Удалить копию прежней версии в AppData (после переноса рядом с программой).
#[cfg(windows)]
pub fn remove_old(app: &AppHandle) -> Result<Vec<String>, String> {
    let p = get().ok_or("нет путей")?;
    let old = p.migrated_from.clone().ok_or("старой копии нет")?;
    let id = app.config().identifier.clone();
    if !p.portable || !has_profile(&p.data) {
        return Err("данные рядом с программой не найдены — старую копию не трогаем".into());
    }
    let mut dirs = vec![old];
    if let Ok(local) = app.path().app_local_data_dir() {
        dirs.push(local);
    }
    let mut removed = Vec::new();
    for d in dirs {
        // только каталоги приложения (…\com.zvonochek.app) и никогда — папка рядом с exe
        if d.file_name().map(|n| n.to_string_lossy() != id.as_str()).unwrap_or(true)
            || d.starts_with(&p.data)
            || !d.is_dir()
        {
            continue;
        }
        std::fs::remove_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
        removed.push(d.display().to_string());
    }
    let _ = std::fs::remove_file(p.data.join(MIGRATED));
    tracing::info!("удалена старая копия: {}", removed.join(", "));
    Ok(removed)
}
