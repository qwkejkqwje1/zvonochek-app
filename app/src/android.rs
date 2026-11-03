//! Android: мост к ZvPlugin.kt (gen/android/app/src/main/java/com/zvonochek/app/ZvPlugin.kt).
//!
//! - служба переднего плана «ZVONochek ждёт звонков» — процесс с ядром живёт, пока приложение свёрнуто
//!   (иначе Android его усыпит и звонки по ссылкам и от контактов не дойдут);
//! - входящий звонок — полноэкранное уведомление с мелодией (поверх экрана блокировки), «Ответить» открывает
//!   приложение; во время звонка служба помечена как «микрофон/камера», чтобы звук не пропадал в фоне;
//! - выбор файлов для чата (копии в кэше приложения: ядру нужны обычные пути), открыть и поделиться файлом
//!   (FileProvider), вывести приложение на экран.

use crate::AppState;
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::jboolean;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct Native(Arc<PluginHandle<Wry>>);

/// Для вызовов из Kotlin (JNI): MainActivity заново, кнопки уведомления о входящем.
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init() -> TauriPlugin<Wry> {
    Builder::<Wry>::new("zvandroid")
        .setup(|app, api| {
            let h = api.register_android_plugin("com.zvonochek.app", "ZvPlugin")?;
            app.manage(Native(Arc::new(h)));
            Ok(())
        })
        .build()
}

fn native(app: &AppHandle) -> Option<Arc<PluginHandle<Wry>>> {
    app.try_state::<Native>().map(|n| n.0.clone())
}

/// Команда без ответа (ошибку — в журнал).
fn fire(app: &AppHandle, cmd: &'static str, payload: Value) {
    let Some(h) = native(app) else { return };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = h.run_mobile_plugin_async::<Value>(cmd, payload).await {
            tracing::warn!("android {cmd}: {e}");
        }
    });
}

async fn ask(app: &AppHandle, cmd: &'static str, payload: Value) -> Result<Value, String> {
    let h = native(app).ok_or("нет связи с Android")?;
    h.run_mobile_plugin_async::<Value>(cmd, payload)
        .await
        .map_err(|e| e.to_string())
}

/// Запуск: разрешение на уведомления (Android 13+) и служба «ждём звонков».
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    fire(app, "startService", json!({}));
}

/// «Выйти»: служба больше не держит процесс.
pub async fn stop(app: &AppHandle) {
    let _ = ask(app, "stopService", json!({})).await;
}

pub fn bring_to_front(app: &AppHandle) {
    fire(app, "bringToFront", json!({}));
}

/// Новый процесс приложения (после переноса профиля): ZvPlugin перезапускает задачу и завершает этот.
pub async fn restart(app: &AppHandle) -> Result<(), String> {
    ask(app, "restart", json!({})).await?;
    Ok(())
}

/// Настройки батареи для ZVONochek (снять ограничения работы в фоне).
pub async fn background_settings(app: &AppHandle) -> Result<(), String> {
    ask(app, "backgroundSettings", json!({})).await?;
    Ok(())
}

pub fn incoming(app: &AppHandle, call_id: &str, text: &str) {
    fire(
        app,
        "incoming",
        json!({"title": "Входящий звонок", "text": text, "callId": call_id}),
    );
}

pub fn incoming_done(app: &AppHandle) {
    fire(app, "incomingDone", json!({}));
}

pub fn call_started(app: &AppHandle) {
    fire(app, "callState", json!({"active": true}));
}

pub fn call_ended(app: &AppHandle) {
    fire(app, "callState", json!({"active": false}));
}

/// Системный выбор файлов → копии в кэше → пути (отмена — пустой список).
pub async fn pick_files(app: &AppHandle, profile: bool) -> Result<Vec<String>, String> {
    let r = ask(app, "pickFiles", json!({"multiple": !profile})).await?;
    Ok(r["paths"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

/// Открыть файл в подходящем приложении (`share` — «Поделиться»/«Сохранить в…»).
pub async fn open_file(app: &AppHandle, path: &str, share: bool) -> Result<(), String> {
    let mime = mime_of(path);
    ask(
        app,
        if share { "shareFile" } else { "openFile" },
        json!({"path": path, "mime": mime}),
    )
    .await?;
    Ok(())
}

fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "ogg" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "zip" => "application/zip",
        "apk" => "application/vnd.android.package-archive",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "*/*",
    }
}

/// MainActivity создана заново в живом процессе (окно закрывали, а служба держала ядро): Tauri сам создаёт окно
/// только при первом запуске, поэтому «main» — заново (оболочка; звонок, если шёл, закончится в `shell_loaded`).
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zvonochek_app_ZvNative_activityRecreated(
    _env: JNIEnv,
    _class: JClass,
) {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let a = app.clone();
    let r = app.run_on_main_thread(move || {
        if a.get_webview_window("main").is_none()
            && let Err(e) = crate::wins::build_main(&a, true)
        {
            tracing::error!("окно после перезапуска Activity: {e}");
        }
    });
    if let Err(e) = r {
        tracing::error!("окно после перезапуска Activity: {e}");
    }
}

/// Кнопки уведомления о входящем: «Ответить» (из MainActivity) и «Отклонить» (ZvReceiver).
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_zvonochek_app_ZvNative_incomingAction(
    mut env: JNIEnv,
    _class: JClass,
    call_id: JString,
    answer: jboolean,
) {
    let Ok(id) = env.get_string(&call_id).map(String::from) else {
        return;
    };
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let answer = answer != 0;
    tauri::async_runtime::spawn(async move {
        if !answer {
            let core = app.state::<AppState>().core.clone();
            if let Err(e) = core.dispatch("call_decline", json!({"callId": id})).await {
                tracing::warn!("отклонить из уведомления: {e}");
            }
            return;
        }
        if let Err(e) = answer_call(&app, &id).await {
            tracing::warn!("ответ из уведомления: {e}");
            crate::host::notify(&app, "Не удалось ответить", &e);
        }
    });
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Как «Ответить» в карточке входящего (ui/shell/incoming.js): камера — как у звонящего, текущий звонок завершится.
async fn answer_call(app: &AppHandle, id: &str) -> Result<(), String> {
    let core = app.state::<AppState>().core.clone();
    let r = core.dispatch("call_answer", json!({"callId": id})).await?;
    let secret = r["secret"].as_str().ok_or("нет ссылки звонка")?.to_string();
    let s = core.settings();
    let peer = r["groupName"]
        .as_str()
        .filter(|g| !g.is_empty())
        .or(r["name"].as_str())
        .unwrap_or("");
    let mut boot = json!({
        "auto": s.skip_prejoin,
        "name": s.name,
        "dir": "in",
        "peer": peer,
        "replace": true,
    });
    let video = r["video"].as_bool().unwrap_or(false);
    if truthy(&r["contactId"]) {
        boot["contact"] = r["name"].clone();
        boot["video"] = json!(video);
    } else if truthy(&r["groupId"]) {
        boot["video"] = json!(video);
    }
    crate::wins::open_call(app, &secret, boot)?;
    Ok(())
}
