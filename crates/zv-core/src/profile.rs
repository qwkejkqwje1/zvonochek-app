//! Перенос профиля на другой компьютер: файл `.zvp` под паролем (Argon2id → XChaCha20-Poly1305).
//!
//! Внутри — личность (ID устройства), контакты, ссылки, настройки, журнал звонков и переписка (без самих
//! файлов из чатов). Формат: `MAGIC ‖ u32 BE длина заголовка ‖ заголовок JSON ‖ шифротекст`, заголовок
//! (параметры KDF, соль, nonce) — связанные данные AEAD. Импорт не трогает работающее ядро: пакет
//! кладётся в `import.pending` (под DPAPI) и применяется при следующем запуске, до чтения данных.

use crate::model::{Contacts, History, Identity, Links, Settings};
use crate::store::JsonFile;
use crate::{Inner, s};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zv_proto::ids::{now_ms, rand_hex};

const MAGIC: &[u8] = b"ZVONochek-profile\n";
const VERSION: u64 = 1;
/// Argon2id по RFC 9106 (второй рекомендуемый набор): 64 МиБ, 3 прохода, 4 линии.
const KDF_M: u32 = 64 * 1024;
const KDF_T: u32 = 3;
const KDF_P: u32 = 4;
pub(crate) const MIN_PASSWORD: usize = 8;
const MAX_FILE: u64 = 1 << 30;
const PENDING: &str = "import.pending";
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

fn kdf(password: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let a = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    a.hash_password_into(password.as_bytes(), salt, &mut key).map_err(|e| e.to_string())?;
    Ok(key)
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    let v = hex::decode(rand_hex(N)).unwrap_or_default();
    out.copy_from_slice(&v[..N]);
    out
}

/// Зашифровать пакет паролем.
pub(crate) fn seal(password: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
    let salt: [u8; 16] = rand_bytes();
    let nonce: [u8; 24] = rand_bytes();
    let header = serde_json::to_vec(&json!({
        "v": VERSION, "kdf": "argon2id", "m": KDF_M, "t": KDF_T, "p": KDF_P,
        "salt": B64.encode(salt), "nonce": B64.encode(nonce),
    }))
    .map_err(|e| e.to_string())?;
    let mut out = MAGIC.to_vec();
    out.extend((header.len() as u32).to_be_bytes());
    out.extend(&header);
    let key = kdf(password, &salt, KDF_M, KDF_T, KDF_P)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ct = cipher.encrypt(&XNonce::from(nonce), Payload { msg: plain, aad: &out }).map_err(|_| "не удалось зашифровать")?;
    out.extend(ct);
    Ok(out)
}

/// Расшифровать пакет (ошибки — понятными словами).
pub(crate) fn open(password: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    const BAD: &str = "Это не файл профиля ZVONochek";
    let rest = data.strip_prefix(MAGIC).ok_or(BAD)?;
    if rest.len() < 4 {
        return Err(BAD.into());
    }
    let hl = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
    if hl > 4096 || rest.len() < 4 + hl + 16 {
        return Err(BAD.into());
    }
    let h: Value = serde_json::from_slice(&rest[4..4 + hl]).map_err(|_| BAD)?;
    if h["v"].as_u64().unwrap_or(0) > VERSION {
        return Err("Файл сохранён более новой версией ZVONochek — обновите приложение".into());
    }
    let num = |k: &str| h[k].as_u64().filter(|v| *v <= u32::MAX as u64).map(|v| v as u32);
    let (Some(m), Some(t), Some(p)) = (num("m"), num("t"), num("p")) else { return Err(BAD.into()) };
    // чужой файл не должен заставить считать вечно или съесть всю память
    if h["kdf"] != "argon2id" || m > 1 << 20 || t > 16 || p > 16 {
        return Err(BAD.into());
    }
    let b = |k: &str| h[k].as_str().and_then(|v| B64.decode(v).ok());
    let (Some(salt), Some(nonce)) = (b("salt"), b("nonce")) else { return Err(BAD.into()) };
    let nonce: [u8; 24] = nonce.try_into().map_err(|_| BAD)?;
    if salt.len() < 8 {
        return Err(BAD.into());
    }
    let key = kdf(password, &salt, m, t, p).map_err(|_| BAD)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| e.to_string())?;
    let aad = &data[..MAGIC.len() + 4 + hl];
    cipher
        .decrypt(&XNonce::from(nonce), Payload { msg: &data[aad.len()..], aad })
        .map_err(|_| "Неверный пароль или файл повреждён".into())
}

/// Дата для имени файла (UTC, ГГГГ-ММ-ДД).
fn ymd(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}")
}

/// Отложенный импорт: применить до чтения данных (вызывается в `Core::start`).
pub(crate) fn apply_pending(dir: &Path) {
    let pending = JsonFile::new(dir, PENDING, true);
    let p: Value = pending.load();
    if p.is_null() {
        return;
    }
    let path = dir.join(PENDING);
    match apply(dir, &p) {
        Ok(()) => tracing::info!("профиль: перенос применён"),
        Err(e) => tracing::error!("профиль: перенос не применён: {e}"),
    }
    let _ = std::fs::remove_file(path);
}

fn apply(dir: &Path, p: &Value) -> anyhow::Result<()> {
    let chats = B64.decode(p["chats"].as_str().unwrap_or(""))?;
    anyhow::ensure!(chats.is_empty() || chats.starts_with(SQLITE_MAGIC), "переписка повреждена");
    // отметки этого компьютера (вопрос про автозапуск, подсказка трея) — свои
    let local: Settings = JsonFile::new(dir, "settings.json", false).load();
    let mut settings: Settings = serde_json::from_value(p["settings"].clone())?;
    settings.onboarded = local.onboarded;
    settings.tray_hint_shown = local.tray_hint_shown;
    let identity: Identity = serde_json::from_value(p["identity"].clone())?;
    JsonFile::new(dir, "identity.dat", true).save(&identity)?;
    JsonFile::new(dir, "contacts.dat", true).save(&serde_json::from_value::<Contacts>(p["contacts"].clone())?)?;
    JsonFile::new(dir, "links.dat", true).save(&serde_json::from_value::<Links>(p["links"].clone())?)?;
    JsonFile::new(dir, "history.json", false).save(&serde_json::from_value::<History>(p["history"].clone())?)?;
    JsonFile::new(dir, "settings.json", false).save(&settings)?;
    for ext in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(dir.join(format!("chats.db{ext}")));
    }
    if !chats.is_empty() {
        std::fs::write(dir.join("chats.db"), &chats)?;
        // пути недокачанных файлов — со старого компьютера: докачаем заново в свою папку
        let c = rusqlite::Connection::open(dir.join("chats.db"))?;
        c.execute("UPDATE files SET path = '', done = 0 WHERE out = 0 AND st != 'done'", [])?;
    }
    Ok(())
}

fn check_password(pw: &str) -> Result<(), String> {
    if pw.chars().count() < MIN_PASSWORD {
        return Err(format!("Пароль — не короче {MIN_PASSWORD} символов"));
    }
    Ok(())
}

impl Inner {
    /// Сохранить профиль в файл (`path` — от хоста; без него — в папку загрузок).
    pub(crate) async fn profile_export(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let pw = s(args, "password")?.to_string();
        check_password(&pw)?;
        let tmp = self.opts.data_dir.join(format!("chats.export-{}.tmp", rand_hex(4)));
        let snap = self.db.snapshot(&tmp);
        let chats = std::fs::read(&tmp).unwrap_or_default();
        let _ = std::fs::remove_file(&tmp);
        snap.map_err(|e| format!("Не удалось прочитать переписку: {e}"))?;
        let (payload, summary) = {
            let st = self.lock();
            let identity: Identity = self.identity_file.load();
            if identity.seed.is_empty() {
                return Err("Профиль ещё не создан".into());
            }
            let summary = json!({
                "name": st.settings.name,
                "contacts": st.contacts.items.len(),
                "links": st.links.items.len(),
                "msgs": self.db.msgs_count(),
                "deviceId": self.node().map(|n| n.id().to_string()),
            });
            let payload = json!({
                "v": VERSION,
                "app": self.opts.app_version,
                "created": now_ms(),
                "summary": summary,
                "identity": identity,
                "settings": st.settings,
                "links": st.links,
                "history": st.history,
                "contacts": st.contacts,
                "chats": B64.encode(&chats),
            });
            (payload, summary)
        };
        let plain = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let data = tokio::task::spawn_blocking(move || seal(&pw, &plain)).await.map_err(|e| e.to_string())??;
        let path = match args.get("path").and_then(|v| v.as_str()).filter(|p| !p.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => {
                let dir = self.downloads_dir();
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                crate::files::unique_path(&dir, &format!("ZVONochek-профиль-{}.zvp", ymd(now_ms())))
            }
        };
        let tmp = PathBuf::from(format!("{}.tmp", path.display()));
        std::fs::write(&tmp, &data).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Не удалось сохранить файл: {e}")
        })?;
        self.lock().last_export = Some(path.clone());
        tracing::info!("профиль: сохранён ({} байт)", data.len());
        Ok(json!({
            "path": path.display().to_string(),
            "name": path.file_name().map(|n| n.to_string_lossy().to_string()),
            "size": data.len(),
            "summary": summary,
        }))
    }

    /// Проверить файл и пароль и подготовить перенос (применится при перезапуске).
    pub(crate) async fn profile_import(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let path = PathBuf::from(s(args, "path")?);
        let pw = s(args, "password")?.to_string();
        let meta = std::fs::metadata(&path).map_err(|_| "Файл не найден")?;
        if !meta.is_file() || meta.len() > MAX_FILE {
            return Err("Это не файл профиля ZVONochek".into());
        }
        let data = std::fs::read(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;
        let plain = tokio::task::spawn_blocking(move || open(&pw, &data)).await.map_err(|e| e.to_string())??;
        let p: Value = serde_json::from_slice(&plain).map_err(|_| "Файл профиля повреждён")?;
        // проверить всё до записи
        let id: Identity = serde_json::from_value(p["identity"].clone()).map_err(|_| "Файл профиля повреждён")?;
        if hex::decode(&id.seed).map(|b| b.len()) != Ok(32) {
            return Err("Файл профиля повреждён".into());
        }
        let contacts: Contacts = serde_json::from_value(p["contacts"].clone()).map_err(|_| "Файл профиля повреждён")?;
        let links: Links = serde_json::from_value(p["links"].clone()).map_err(|_| "Файл профиля повреждён")?;
        serde_json::from_value::<Settings>(p["settings"].clone()).map_err(|_| "Файл профиля повреждён")?;
        serde_json::from_value::<History>(p["history"].clone()).map_err(|_| "Файл профиля повреждён")?;
        let chats = B64.decode(p["chats"].as_str().unwrap_or("")).map_err(|_| "Файл профиля повреждён")?;
        if !chats.is_empty() && !chats.starts_with(SQLITE_MAGIC) {
            return Err("Файл профиля повреждён".into());
        }
        JsonFile::new(&self.opts.data_dir, PENDING, true).save(&p).map_err(|e| format!("Не удалось подготовить перенос: {e}"))?;
        tracing::info!("профиль: перенос подготовлен, применится при перезапуске");
        Ok(json!({
            "ok": true,
            "name": p["settings"]["name"],
            "contacts": contacts.items.len(),
            "links": links.items.len(),
            "msgs": p["summary"]["msgs"],
            "created": p["created"],
            "restart": true,
        }))
    }

    /// Последний сохранённый файл профиля (для «Показать в папке»).
    pub(crate) fn last_export(&self) -> Option<PathBuf> {
        self.lock().last_export.clone().filter(|p| p.is_file())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let data = seal("пароль-123", b"hello profile").unwrap();
        assert!(data.starts_with(MAGIC));
        assert_eq!(open("пароль-123", &data).unwrap(), b"hello profile");
        assert_eq!(open("пароль-124", &data).unwrap_err(), "Неверный пароль или файл повреждён");
        // подмена заголовка (параметры KDF) ломает проверку
        let mut bad = data.clone();
        let i = MAGIC.len() + 4 + 2;
        bad[i] ^= 1;
        assert!(open("пароль-123", &bad).is_err());
        assert_eq!(open("x", b"PK\x03\x04").unwrap_err(), "Это не файл профиля ZVONochek");
    }

    #[test]
    fn dates() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(1_793_577_600_000), "2026-11-02");
        assert_eq!(ymd(951_782_400_000), "2000-02-29");
    }
}
