//! Обновление переносной версии (Windows): манифест `latest.json` на странице релизов → новый exe, подписанный
//! ключом проекта (Ed25519). Скачивание — в `<данные>/update/`, проверка размера и подписи; заменяет exe само
//! приложение (app/src/selfupdate.rs: запущенный exe переименовывается в `.old`, новый ложится на его место).
//!
//! latest.json: `{"version":"4.0.1","notes":"…","platforms":{"windows-x64":{"url":"…","size":N,"sig":"base64"}}}`,
//! ключ платформы — как `platform` ядра; подпись — Ed25519 над байтами exe (release.yml, секрет ZV_UPDATE_KEY).

use crate::Inner;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Где искать манифест — по очереди: релизы репозитория приложения, затем открытого репозитория для файлов.
pub const MANIFEST_URLS: &[&str] = &[
    "https://github.com/qwkejkqwje1/zvonochek-app/releases/latest/download/latest.json",
    "https://github.com/qwkejkqwje1/zvonochek-releases/releases/latest/download/latest.json",
];

/// Открытые ключи подписи обновлений (hex). Закрытый — только в секретах GitHub.
pub const KEYS_HEX: &[&str] = &["9bde6dab4023b25ed4754ec4fc0dd9cccf01fbb70978cf39e5c68e6de4397693"];

const MAX_SIZE: u64 = 300 << 20;

#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub notes: String,
    pub url: String,
    pub size: u64,
    pub sig: Vec<u8>,
}

pub fn keys(hex_keys: &[&str]) -> Vec<[u8; 32]> {
    hex_keys
        .iter()
        .filter_map(|k| hex::decode(k).ok()?.try_into().ok())
        .collect()
}

/// Версия `a` новее `b` (x.y.z; «v» в начале и суффиксы после «-»/«+» не учитываются).
pub fn newer(a: &str, b: &str) -> bool {
    fn parse(v: &str) -> [u64; 3] {
        let v = v.trim().trim_start_matches('v');
        let core = v.split(['-', '+']).next().unwrap_or("");
        let mut out = [0u64; 3];
        for (i, p) in core.split('.').take(3).enumerate() {
            out[i] = p.parse().unwrap_or(0);
        }
        out
    }
    parse(a) > parse(b)
}

/// Сборка для своей платформы из манифеста.
pub fn parse_manifest(m: &Value, platform: &str, allow_http: bool) -> Result<Release, String> {
    let version = m["version"]
        .as_str()
        .ok_or("в манифесте обновления нет версии")?
        .trim()
        .trim_start_matches('v')
        .to_string();
    if version.is_empty()
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
    {
        return Err("неверная версия в манифесте обновления".into());
    }
    let p = &m["platforms"][platform];
    let url = p["url"]
        .as_str()
        .ok_or_else(|| format!("в обновлении нет сборки для {platform}"))?
        .to_string();
    if !(url.starts_with("https://") || allow_http && url.starts_with("http://")) {
        return Err("адрес обновления — не https".into());
    }
    let size = p["size"].as_u64().unwrap_or(0);
    if size == 0 || size > MAX_SIZE {
        return Err("неверный размер обновления".into());
    }
    let sig = p["sig"]
        .as_str()
        .and_then(|s| B64.decode(s.trim()).ok())
        .filter(|s| s.len() == 64)
        .ok_or("у обновления нет подписи")?;
    Ok(Release {
        version,
        notes: m["notes"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(4000)
            .collect(),
        url,
        size,
        sig,
    })
}

/// Подпись Ed25519 одного из ключей проекта над байтами файла.
pub fn verify(data: &[u8], sig: &[u8], keys: &[[u8; 32]]) -> bool {
    let Ok(sig) = ed25519_dalek::Signature::from_slice(sig) else {
        return false;
    };
    keys.iter().any(|k| {
        ed25519_dalek::VerifyingKey::from_bytes(k)
            .is_ok_and(|vk| vk.verify_strict(data, &sig).is_ok())
    })
}

/// Первый доступный манифест.
pub async fn fetch_manifest(urls: &[String]) -> Result<Value, String> {
    let mut last = String::from("нет адреса обновлений");
    for u in urls {
        let r = zv_signal::tls::http()
            .get(u)
            .timeout(Duration::from_secs(20))
            .send()
            .await;
        match r {
            Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                Ok(v) => return Ok(v),
                Err(e) => last = format!("{u}: {e}"),
            },
            Ok(r) => last = format!("{u}: HTTP {}", r.status().as_u16()),
            Err(e) => last = format!("{u}: {e}"),
        }
    }
    Err(last)
}

/// Скачать сборку в `dir` и проверить размер и подпись. Результат — путь к проверенному exe.
pub async fn download(
    rel: &Release,
    dir: &Path,
    keys: &[[u8; 32]],
    progress: impl Fn(u64, u64),
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("ZVONochek-{}.exe", rel.version));
    let mut resp = zv_signal::tls::http()
        .get(&rel.url)
        .timeout(Duration::from_secs(900))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut data = Vec::with_capacity(rel.size as usize);
    let mut last = Instant::now();
    while let Some(c) = resp.chunk().await.map_err(|e| e.to_string())? {
        data.extend_from_slice(&c);
        if data.len() as u64 > rel.size {
            return Err("файл обновления больше, чем указано в манифесте".into());
        }
        if last.elapsed() > Duration::from_millis(250) {
            progress(data.len() as u64, rel.size);
            last = Instant::now();
        }
    }
    progress(data.len() as u64, rel.size);
    if data.len() as u64 != rel.size {
        return Err("обновление скачалось не полностью".into());
    }
    if !verify(&data, &rel.sig, keys) {
        return Err(
            "подпись обновления не сходится — файл не от ZVONochek, не устанавливаем".into(),
        );
    }
    let part = dir.join(format!("ZVONochek-{}.exe.part", rel.version));
    std::fs::write(&part, &data).map_err(|e| format!("{}: {e}", part.display()))?;
    let _ = std::fs::remove_file(&path);
    std::fs::rename(&part, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// Уже скачанный и проверенный файл этой версии (автообновление скачало раньше).
fn ready(path: &Path, rel: &Release, keys: &[[u8; 32]]) -> bool {
    std::fs::read(path).is_ok_and(|d| d.len() as u64 == rel.size && verify(&d, &rel.sig, keys))
}

/// Убрать из папки обновлений всё, кроме `keep` (старые версии, недокачанное).
fn prune(dir: &Path, keep: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p != keep && p.is_file() {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Снимает отметку «идёт загрузка обновления» при любом выходе.
struct Busy<'a>(&'a Inner);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.lock().update_busy = false;
    }
}

impl Inner {
    /// Адреса манифеста; в режиме разработки — `ZV_UPDATE_URL` (через запятую), для тестов.
    fn update_urls(&self) -> Vec<String> {
        if self.opts.dev
            && let Ok(u) = std::env::var("ZV_UPDATE_URL")
        {
            return u
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
        MANIFEST_URLS.iter().map(|s| s.to_string()).collect()
    }

    /// Ключи проверки; в режиме разработки — `ZV_UPDATE_KEY` (hex), для тестов.
    fn update_keys(&self) -> Vec<[u8; 32]> {
        if self.opts.dev
            && let Ok(k) = std::env::var("ZV_UPDATE_KEY")
        {
            return keys(&[k.trim()]);
        }
        keys(KEYS_HEX)
    }

    /// Есть ли версия новее: `{available, version, notes, current, size}`.
    pub(crate) async fn update_check(&self) -> Result<Value, String> {
        let m = fetch_manifest(&self.update_urls()).await?;
        let rel = parse_manifest(&m, &self.opts.platform, self.opts.dev)?;
        let available = newer(&rel.version, &self.opts.app_version);
        let out = json!({
            "available": available,
            "version": rel.version,
            "notes": rel.notes,
            "current": self.opts.app_version,
            "size": rel.size,
        });
        self.lock().update = available.then_some(rel);
        Ok(out)
    }

    /// Скачать и проверить найденную версию (`<данные>/update/ZVONochek-<версия>.exe`): `{path, version}`.
    /// Ход — событиями `update:progress` `{done, total}`.
    pub(crate) async fn update_download(&self) -> Result<Value, String> {
        if std::mem::replace(&mut self.lock().update_busy, true) {
            return Err("обновление уже скачивается".into());
        }
        let _busy = Busy(self);
        let cur = self.lock().update.clone();
        let rel = match cur {
            Some(r) => r,
            None => {
                let c = self.update_check().await?;
                if c["available"] != true {
                    return Err("новой версии нет".into());
                }
                let cur = self.lock().update.clone();
                cur.ok_or("новой версии нет")?
            }
        };
        let dir = self.opts.data_dir.join("update");
        let keys = self.update_keys();
        let path = dir.join(format!("ZVONochek-{}.exe", rel.version));
        let path = if ready(&path, &rel, &keys) {
            path
        } else {
            download(&rel, &dir, &keys, |done, total| {
                self.emit("update:progress", json!({"done": done, "total": total}));
            })
            .await?
        };
        prune(&dir, &path);
        Ok(json!({"path": path.to_string_lossy(), "version": rel.version}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;
    use serde_json::json;

    #[test]
    fn versions() {
        assert!(newer("4.0.1", "4.0.0"));
        assert!(newer("v4.1", "4.0.9"));
        assert!(newer("10.0.0", "9.9.9"));
        assert!(!newer("4.0.0", "4.0.0"));
        assert!(!newer("4.0.0-beta", "4.0.0"));
        assert!(!newer("3.9.9", "4.0.0"));
    }

    #[test]
    fn manifest_and_signature() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let exe = b"MZ fake exe".to_vec();
        let sig = sk.sign(&exe).to_bytes();
        let m = json!({"version": "v4.0.1", "notes": "что нового", "platforms": {"windows-x64": {
            "url": "https://example.com/ZVONochek.exe", "size": exe.len(), "sig": B64.encode(sig)}}});
        let r = parse_manifest(&m, "windows-x64", false).unwrap();
        assert_eq!(r.version, "4.0.1");
        assert!(verify(&exe, &r.sig, &[pk]));
        // чужой ключ, подменённый файл
        assert!(!verify(&exe, &r.sig, &[[9u8; 32]]));
        assert!(!verify(b"MZ other", &r.sig, &[pk]));
        // нет сборки для платформы, http без разрешения, нет подписи
        assert!(parse_manifest(&m, "windows-arm64", false).is_err());
        let mut h = m.clone();
        h["platforms"]["windows-x64"]["url"] = json!("http://example.com/x.exe");
        assert!(parse_manifest(&h, "windows-x64", false).is_err());
        assert!(parse_manifest(&h, "windows-x64", true).is_ok());
        h["platforms"]["windows-x64"]["sig"] = json!("");
        assert!(parse_manifest(&h, "windows-x64", true).is_err());
        let mut bad = m.clone();
        bad["version"] = json!("../../x");
        assert!(parse_manifest(&bad, "windows-x64", false).is_err());
    }

    #[test]
    fn project_key_parses() {
        assert_eq!(keys(KEYS_HEX).len(), KEYS_HEX.len());
    }
}
