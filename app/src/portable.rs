//! Где хранятся данные.
//!
//! Windows — только переносная версия: всё лежит в папке `ZVONochek-data` рядом с ZVONochek.exe — настройки, ссылки,
//! контакты, история, переписка, журналы, профиль WebView2, размер окна, полученные файлы («Загрузки»), скачанные
//! обновления. Переносите exe вместе с папкой. Если рядом с exe писать нельзя (Program Files, носитель только для
//! чтения) — объясняем и не запускаемся. Первый запуск копирует данные прежней (установленной) версии из AppData
//! (оригинал остаётся там же).
//! Секреты (ключ устройства, контакты, ссылки) зашифрованы ключом данных профиля (zv-core vault.rs): без пароля
//! профиля он запомнен только на этом компьютере (DPAPI), с паролем папку можно открыть и на другом.
//! В реестр пишется только то, что без него не работает: ссылки `zvonochek://`, автозапуск (если включён) и
//! регистрация для уведомлений Windows (если включены); «Убрать следы» снимает всё это.
//! Android и прочие — каталоги приложения.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const DIR_NAME: &str = "ZVONochek-data";
#[cfg(windows)]
const MIGRATED: &str = "migrated-from.txt";

#[derive(Debug, Clone)]
pub struct Paths {
    /// Запущенный exe (путь на момент запуска: при обновлении сам файл переименовывается).
    #[cfg_attr(not(windows), allow(dead_code))]
    pub exe: PathBuf,
    pub data: PathBuf,
    pub logs: PathBuf,
    /// Профиль WebView2; `None` — по умолчанию Tauri (%LOCALAPPDATA%).
    #[cfg_attr(mobile, allow(dead_code))]
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

/// Размер и место главного окна.
#[cfg(desktop)]
pub fn window_file() -> Option<PathBuf> {
    get().map(|p| p.data.join("window.json"))
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
        exe: std::env::current_exe().unwrap_or_default(),
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
    let dir = exe
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("нет папки программы"))?;
    let data = dir.join(DIR_NAME);
    let mut notes = Vec::new();
    let mut migrated_from = None;
    if !data.is_dir() {
        if let Err(e) = probe(&dir) {
            fatal(&format!(
                "Рядом с ZVONochek.exe нельзя сохранять файлы:\n{}\n({e})\n\nZVONochek хранит все данные в папке \
                 ZVONochek-data рядом с программой. Переложите ZVONochek.exe в обычную папку — например, \
                 «Документы» или на флешку — и запустите снова.",
                dir.display()
            ));
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
                    notes.push(format!(
                        "скопированы данные прежней версии из {} ({n} файлов)",
                        old.data.display()
                    ));
                    migrated_from = Some(old.data);
                }
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&part);
                    let go = ask_box(&format!(
                        "Не удалось скопировать данные прежней версии ZVONochek из\n{}\n({e})\n\n\
                         Запустить без них, с чистого профиля? Прежние данные останутся на месте — их можно \
                         будет перенести файлом профиля.\n\n«Нет» — выйти, ничего не меняя.",
                        old.data.display()
                    ));
                    if !go {
                        std::process::exit(1);
                    }
                    notes.push(format!(
                        "копирование из {}: {e} — запуск без прежних данных",
                        old.data.display()
                    ));
                }
            }
        }
        std::fs::create_dir_all(&data)?;
    } else if let Err(e) = probe(&data) {
        fatal(&format!(
            "В папку данных ZVONochek нельзя записывать:\n{}\n({e})\n\nВозможно, флешка или папка только для \
             чтения. Разрешите запись или переложите ZVONochek.exe вместе с папкой ZVONochek-data в другое место.",
            data.display()
        ));
    }
    let mut p = portable_paths(&exe, &data);
    p.notes = notes;
    p.migrated_from = migrated_from.or_else(|| {
        std::fs::read_to_string(data.join(MIGRATED))
            .ok()
            .map(|s| PathBuf::from(s.trim()))
            .filter(|d| d.is_dir())
    });
    if in_temp(&dir) {
        const TEMP: &str = "ZVONochek запущен из временной папки — похоже, прямо из архива. Распакуйте ZVONochek.exe \
                            в постоянную папку, иначе данные пропадут при очистке временных файлов.";
        warn_box(TEMP);
        p.warning = Some(TEMP.into());
    }
    Ok(p)
}

#[cfg(windows)]
fn portable_paths(exe: &Path, data: &Path) -> Paths {
    Paths {
        exe: exe.to_path_buf(),
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

#[cfg(windows)]
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
            n += copy_dir(
                &wv,
                &new.join("webview").join("EBWebView"),
                &|name: &str| {
                    !(name.ends_with("Cache")
                        || name.ends_with("cache")
                        || matches!(
                            name,
                            "Crashpad" | "BrowserMetrics" | "Service Worker" | "LOCK" | "lockfile"
                        ))
                },
            )?;
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

/// Текст для `fatal`, когда папка данных с другого компьютера, а пароль профиля не задан (vault `Foreign`).
pub fn foreign_text(data: &Path) -> String {
    format!(
        "Папка с данными ZVONochek перенесена с другого компьютера (или из-под другой учётной записи Windows), \
         а пароль профиля не задан:\n{}\n\n\
         Без пароля профиль открывается только там, где его создали. ZVONochek не запускается с этой папкой — \
         чтобы ничего не потерять.\n\n\
         Как открыть профиль здесь:\n\
         1) на прежнем компьютере запустите ZVONochek и задайте пароль: Настройки → «Пароль профиля»;\n\
         2) перенесите папку ZVONochek-data сюда снова — ZVONochek спросит пароль.\n\n\
         Или перенесите профиль файлом: Настройки → «Перенос на другое устройство».",
        data.display()
    )
}

/// Ошибка до запуска интерфейса: окно с текстом (Windows) и выход.
pub fn fatal(text: &str) -> ! {
    #[cfg(windows)]
    message_box(text, MB_ERROR);
    #[cfg(not(windows))]
    eprintln!("ZVONochek: {text}");
    std::process::exit(1);
}

#[cfg(windows)]
const MB_ERROR: u32 = windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR
    | windows_sys::Win32::UI::WindowsAndMessaging::MB_OK;

#[cfg(windows)]
fn message_box(text: &str, flags: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_SETFOREGROUND, MessageBoxW};
    let w = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let (t, c) = (w(text), w("ZVONochek"));
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            t.as_ptr(),
            c.as_ptr(),
            flags | MB_SETFOREGROUND,
        )
    }
}

/// Предупреждение до запуска интерфейса.
#[cfg(windows)]
fn warn_box(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONWARNING, MB_OK};
    message_box(text, MB_ICONWARNING | MB_OK);
}

/// Вопрос «Да/Нет» до запуска интерфейса.
#[cfg(windows)]
fn ask_box(text: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONWARNING, MB_YESNO};
    message_box(text, MB_ICONWARNING | MB_YESNO) == IDYES
}

/// Нет WebView2: объяснить и предложить страницу загрузки Microsoft.
#[cfg(windows)]
pub fn webview2_missing(app: &AppHandle) {
    use tauri_plugin_opener::OpenerExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONERROR, MB_YESNO};
    const URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    let text = "Для работы ZVONochek нужен компонент Windows «Microsoft Edge WebView2». На этом компьютере он не \
                найден (обычно он уже есть в Windows 10 и 11).\n\nОткрыть страницу загрузки Microsoft? После \
                установки запустите ZVONochek снова.";
    if message_box(text, MB_ICONERROR | MB_YESNO) == IDYES
        && let Err(e) = app.opener().open_url(URL, None::<&str>)
    {
        tracing::warn!("не открыть {URL}: {e}");
    }
}

/// Запуск на Windows: регистрация для уведомлений (по настройке) и путь автозапуска — exe могли переложить.
#[cfg(windows)]
pub fn on_start(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    if get().is_some_and(|p| p.portable) {
        let on = app.state::<crate::AppState>().core.settings().notifications;
        if let Err(e) = toasts_register(app, on) {
            tracing::warn!("регистрация для уведомлений Windows: {e}");
        }
    }
    let a = app.autolaunch();
    if a.is_enabled().unwrap_or(false)
        && let Err(e) = a.enable()
    {
        tracing::warn!("обновление пути автозапуска: {e}");
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
    if std::fs::metadata(&f).ok().map(|m| m.len()) != Some(PNG.len() as u64) {
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
        if d.file_name()
            .map(|n| n.to_string_lossy() != id.as_str())
            .unwrap_or(true)
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
