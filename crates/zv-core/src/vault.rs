//! Ключ данных профиля (Windows). Секретные файлы (`identity.dat`, `contacts.dat`, `links.dat`, `import.pending`)
//! шифруются случайным ключом данных: `ZVK1 ‖ nonce 24 ‖ XChaCha20-Poly1305(имя файла — связанные данные)`.
//! Сам ключ лежит в `vault.json` (и копия `vault.bak`) в двух видах:
//! * под паролем профиля (Argon2id, как у файла переноса) — открывается на любом компьютере;
//! * «запомнен на этом компьютере» — под DPAPI пользователя Windows, по записи на компьютер; запись
//!   открывается только там, где сделана.
//!
//! Без пароля данные открываются только там, где ключ запомнен (как раньше с DPAPI). С паролем папку
//! можно унести на другой компьютер: там спросят пароль. Ключ данных не меняется никогда — смена пароля
//! перешифровывает только его.

use crate::profile::{KDF_M, KDF_P, KDF_T, MIN_PASSWORD, kdf, rand_bytes};
use crate::protect;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;

pub type DataKey = [u8; 32];

pub const FILE: &str = "vault.json";
const BAK: &str = "vault.bak";
pub(crate) const MAGIC: &[u8] = b"ZVK1";
/// Секретные файлы профиля.
pub(crate) const SECRET_FILES: &[&str] = &[
    "identity.dat",
    "contacts.dat",
    "links.dat",
    "import.pending",
];
/// Старый формат: DPAPI без ключа данных.
const DPAPI_MAGIC: &[u8] = b"ZVP1";
const AAD: &[u8] = b"ZVONochek vault v1";
const MAX_REMEMBER: usize = 16;

/// Итог открытия при запуске.
#[derive(Debug, Clone, PartialEq)]
pub enum Opened {
    /// Ключ есть (`None` — ключ данных не используется: не Windows).
    Ready(Option<DataKey>),
    /// Нужен пароль профиля.
    NeedPassword,
    /// Данные с другого компьютера, пароль не задан — здесь не открыть.
    Foreign,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Vault {
    v: u32,
    /// Отпечаток ключа данных: расшифровано именно то.
    check: String,
    pw: Option<PwBox>,
    /// Ключ под DPAPI — по записи на компьютер (base64).
    remember: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PwBox {
    kdf: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
    nonce: String,
    ct: String,
}

fn check(key: &DataKey) -> String {
    hex::encode(&blake3::derive_key("ZVONochek vault check v1", key)[..16])
}

fn cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.into())
}

/// Зашифровать секретный файл ключом данных.
pub(crate) fn seal_data(key: &DataKey, name: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
    let nonce: [u8; 24] = rand_bytes();
    let ct = cipher(key)
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: plain,
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| "не удалось зашифровать")?;
    let mut out = MAGIC.to_vec();
    out.extend(nonce);
    out.extend(ct);
    Ok(out)
}

/// Расшифровать секретный файл.
pub(crate) fn open_data(key: &DataKey, name: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let rest = data
        .strip_prefix(MAGIC)
        .ok_or("не зашифрован ключом данных")?;
    if rest.len() < 24 + 16 {
        return Err("файл повреждён".into());
    }
    let nonce: [u8; 24] = rest[..24].try_into().map_err(|_| "файл повреждён")?;
    cipher(key)
        .decrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &rest[24..],
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| "ключ не подходит или файл повреждён".into())
}

fn read(dir: &Path) -> Result<Option<Vault>, String> {
    for name in [FILE, BAK] {
        match std::fs::read(dir.join(name)) {
            Ok(raw) => match serde_json::from_slice::<Vault>(&raw) {
                Ok(v) if v.check.len() == 32 => return Ok(Some(v)),
                _ => tracing::warn!("{name}: повреждён"),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{name}: {e}")),
        }
    }
    Ok(None)
}

fn write_file(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)
}

/// Записать хранилище и его копию (без него данные не открыть).
fn write(dir: &Path, v: &Vault) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for name in [FILE, BAK] {
        write_file(&dir.join(name), &data).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(())
}

/// Ключ, запомненный на этом компьютере.
fn remembered(v: &Vault) -> Option<DataKey> {
    v.remember.iter().find_map(|b| {
        let raw = B64.decode(b).ok()?;
        let key: DataKey = protect::open(&raw).ok()?.try_into().ok()?;
        (check(&key) == v.check).then_some(key)
    })
}

fn remember_here(v: &mut Vault, key: &DataKey) -> Result<(), String> {
    if remembered(v).is_some() {
        return Ok(());
    }
    let blob = protect::seal(key).map_err(|e| format!("не удалось запомнить ключ: {e}"))?;
    v.remember.push(B64.encode(blob));
    // без пароля чужие записи — единственный способ открыть данные там: не выкидываем
    if v.pw.is_some() && v.remember.len() > MAX_REMEMBER {
        let extra = v.remember.len() - MAX_REMEMBER;
        v.remember.drain(..extra);
    }
    Ok(())
}

fn forget_here(v: &mut Vault) {
    let c = v.check.clone();
    v.remember.retain(|b| {
        let opens = B64
            .decode(b)
            .ok()
            .and_then(|raw| protect::open(&raw).ok())
            .and_then(|k| <DataKey>::try_from(k).ok())
            .is_some_and(|k| check(&k) == c);
        !opens
    });
}

fn seal_pw(key: &DataKey, password: &str) -> Result<PwBox, String> {
    let salt: [u8; 16] = rand_bytes();
    let nonce: [u8; 24] = rand_bytes();
    let k = kdf(password, &salt, KDF_M, KDF_T, KDF_P)?;
    let ct = cipher(&k)
        .encrypt(&XNonce::from(nonce), Payload { msg: key, aad: AAD })
        .map_err(|_| "не удалось зашифровать")?;
    Ok(PwBox {
        kdf: "argon2id".into(),
        m: KDF_M,
        t: KDF_T,
        p: KDF_P,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ct: B64.encode(ct),
    })
}

fn open_pw(b: &PwBox, password: &str) -> Result<DataKey, String> {
    const BAD: &str = "файл ключа профиля повреждён";
    // чужой файл не должен заставить считать вечно или съесть всю память
    if b.kdf != "argon2id" || b.m > 1 << 20 || b.t > 16 || b.p > 16 {
        return Err(BAD.into());
    }
    let (Ok(salt), Ok(nonce), Ok(ct)) =
        (B64.decode(&b.salt), B64.decode(&b.nonce), B64.decode(&b.ct))
    else {
        return Err(BAD.into());
    };
    let nonce: [u8; 24] = nonce.try_into().map_err(|_| BAD)?;
    let k = kdf(password, &salt, b.m, b.t, b.p).map_err(|_| BAD)?;
    let key = cipher(&k)
        .decrypt(&XNonce::from(nonce), Payload { msg: &ct, aad: AAD })
        .map_err(|_| "Неверный пароль")?;
    key.try_into().map_err(|_| BAD.into())
}

/// Есть ли секретные файлы в формате `magic`.
fn any_file(dir: &Path, magic: &[u8]) -> bool {
    SECRET_FILES
        .iter()
        .any(|n| std::fs::read(dir.join(n)).is_ok_and(|raw| raw.starts_with(magic)))
}

/// Открыть при запуске: ключ запомнен здесь → готово; иначе пароль или «чужие данные».
/// Первый запуск (или данные старого формата) — новый ключ, запомненный на этом компьютере.
pub fn open(dir: &Path, enabled: bool) -> Result<Opened, String> {
    if !enabled {
        return Ok(Opened::Ready(None));
    }
    if let Some(v) = read(dir)? {
        if let Some(k) = remembered(&v) {
            return Ok(Opened::Ready(Some(k)));
        }
        return Ok(if v.pw.is_some() {
            Opened::NeedPassword
        } else {
            Opened::Foreign
        });
    }
    if any_file(dir, MAGIC) {
        return Err(format!(
            "Пропал файл ключа профиля ({FILE}) в папке {} — без него данные не открыть. Верните его из \
             резервной копии папки.",
            dir.display()
        ));
    }
    // старый формат с другого компьютера: DPAPI здесь не откроет
    let foreign = SECRET_FILES.iter().any(|n| {
        std::fs::read(dir.join(n)).is_ok_and(|raw| {
            raw.strip_prefix(DPAPI_MAGIC)
                .is_some_and(|d| protect::open(d).is_err())
        })
    });
    if foreign {
        return Ok(Opened::Foreign);
    }
    let key: DataKey = rand_bytes();
    let mut v = Vault {
        v: 1,
        check: check(&key),
        pw: None,
        remember: vec![],
    };
    remember_here(&mut v, &key)?;
    write(dir, &v)?;
    Ok(Opened::Ready(Some(key)))
}

/// Открыть паролем; `remember` — больше не спрашивать на этом компьютере. Долго (Argon2id).
pub fn unlock(dir: &Path, password: &str, remember: bool) -> Result<DataKey, String> {
    let mut v = read(dir)?.ok_or("нет файла ключа профиля")?;
    let b = v.pw.clone().ok_or("пароль профиля не задан")?;
    let key = open_pw(&b, password)?;
    if check(&key) != v.check {
        return Err("файл ключа профиля повреждён".into());
    }
    if remember {
        remember_here(&mut v, &key)?;
        write(dir, &v)?;
    }
    Ok(key)
}

/// `(пароль задан, ключ запомнен на этом компьютере)`.
pub fn status(dir: &Path) -> Result<(bool, bool), String> {
    let v = read(dir)?.ok_or("нет файла ключа профиля")?;
    Ok((v.pw.is_some(), remembered(&v).is_some()))
}

fn load_for(dir: &Path, key: &DataKey) -> Result<Vault, String> {
    let v = read(dir)?.ok_or("нет файла ключа профиля")?;
    if check(key) != v.check {
        return Err("ключ данных не совпадает с файлом ключа профиля".into());
    }
    Ok(v)
}

/// Задать или сменить пароль. Долго (Argon2id).
pub fn set_password(dir: &Path, key: &DataKey, password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD {
        return Err(format!("Пароль — не короче {MIN_PASSWORD} символов"));
    }
    let mut v = load_for(dir, key)?;
    v.pw = Some(seal_pw(key, password)?);
    write(dir, &v)
}

/// Убрать пароль: данные открываются только там, где ключ запомнен (этот компьютер — запоминается).
pub fn remove_password(dir: &Path, key: &DataKey) -> Result<(), String> {
    let mut v = load_for(dir, key)?;
    remember_here(&mut v, key)?;
    v.pw = None;
    write(dir, &v)
}

/// Запомнить ключ на этом компьютере или забыть (только когда задан пароль — иначе данные не открыть).
pub fn set_remember(dir: &Path, key: &DataKey, on: bool) -> Result<(), String> {
    let mut v = load_for(dir, key)?;
    if on {
        remember_here(&mut v, key)?;
    } else {
        if v.pw.is_none() {
            return Err("Сначала задайте пароль профиля — иначе данные будет не открыть".into());
        }
        forget_here(&mut v);
    }
    write(dir, &v)
}

/// Перед запуском ядра: зашифрованные файлы есть, а ключа нет или он не подходит ни к одному.
pub(crate) fn check_files(dir: &Path, key: Option<&DataKey>) -> Result<(), String> {
    let mut total = 0;
    let mut good = 0;
    for n in SECRET_FILES {
        let Ok(raw) = std::fs::read(dir.join(n)) else {
            continue;
        };
        if !raw.starts_with(MAGIC) {
            continue;
        }
        total += 1;
        if key.is_some_and(|k| open_data(k, n, &raw).is_ok()) {
            good += 1;
        }
    }
    if total > 0 && good == 0 {
        return Err(if key.is_none() {
            "данные профиля зашифрованы, а ключа нет".into()
        } else {
            "ключ профиля не подходит к данным в этой папке".into()
        });
    }
    Ok(())
}

impl crate::Inner {
    fn vault_key(&self) -> Result<DataKey, String> {
        if !self.opts.vault {
            return Err("пароль профиля здесь не используется".into());
        }
        self.opts
            .data_key
            .ok_or_else(|| "нет ключа данных профиля".into())
    }

    /// `{enabled, password, remember}`.
    pub(crate) fn vault_status(&self) -> Result<Value, String> {
        if !self.opts.vault || self.opts.data_key.is_none() {
            return Ok(json!({"enabled": false}));
        }
        let (password, remember) = status(&self.opts.data_dir)?;
        Ok(json!({"enabled": true, "password": password, "remember": remember}))
    }

    pub(crate) async fn vault_set_password(&self, args: &Value) -> Result<Value, String> {
        let key = self.vault_key()?;
        let pw = crate::s(args, "password")?.to_string();
        let dir = self.opts.data_dir.clone();
        tokio::task::spawn_blocking(move || set_password(&dir, &key, &pw))
            .await
            .map_err(|e| e.to_string())??;
        self.vault_status()
    }

    pub(crate) fn vault_remove_password(&self) -> Result<Value, String> {
        remove_password(&self.opts.data_dir, &self.vault_key()?)?;
        self.vault_status()
    }

    pub(crate) fn vault_remember(&self, args: &Value) -> Result<Value, String> {
        let on = args.get("on").and_then(|v| v.as_bool()).unwrap_or(true);
        set_remember(&self.opts.data_dir, &self.vault_key()?, on)?;
        self.vault_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_roundtrip() {
        let k: DataKey = [5; 32];
        let c = seal_data(&k, "links.dat", b"{}").unwrap();
        assert!(c.starts_with(MAGIC));
        assert_eq!(open_data(&k, "links.dat", &c).unwrap(), b"{}");
        assert!(open_data(&[6; 32], "links.dat", &c).is_err());
        // файл, подложенный под другим именем
        assert!(open_data(&k, "identity.dat", &c).is_err());
    }

    #[test]
    fn vault_flow() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        // первый запуск: новый ключ, запомнен здесь, пароля нет
        let Opened::Ready(Some(k)) = open(dir, true).unwrap() else {
            panic!("нет ключа")
        };
        assert_eq!(open(dir, true).unwrap(), Opened::Ready(Some(k)));
        assert_eq!(status(dir).unwrap(), (false, true));
        assert!(set_remember(dir, &k, false).is_err());
        assert!(set_password(dir, &k, "короткий").is_ok());
        assert!(set_password(dir, &k, "1234567").is_err());
        set_password(dir, &k, "пароль-профиля").unwrap();
        assert_eq!(status(dir).unwrap(), (true, true));
        // забыть здесь: спросит пароль
        set_remember(dir, &k, false).unwrap();
        assert_eq!(open(dir, true).unwrap(), Opened::NeedPassword);
        assert_eq!(unlock(dir, "не тот", false).unwrap_err(), "Неверный пароль");
        assert_eq!(unlock(dir, "пароль-профиля", false).unwrap(), k);
        assert_eq!(open(dir, true).unwrap(), Opened::NeedPassword);
        assert_eq!(unlock(dir, "пароль-профиля", true).unwrap(), k);
        assert_eq!(open(dir, true).unwrap(), Opened::Ready(Some(k)));
        // убрать пароль: запомнен здесь
        remove_password(dir, &k).unwrap();
        assert_eq!(status(dir).unwrap(), (false, true));
        // повреждённый vault.json — копия
        std::fs::write(dir.join(FILE), b"{broken").unwrap();
        assert_eq!(open(dir, true).unwrap(), Opened::Ready(Some(k)));
        // чужой ключ к данным
        assert!(set_password(dir, &[1; 32], "пароль-профиля").is_err());
    }

    #[test]
    fn lost_vault_and_files() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let Opened::Ready(Some(k)) = open(dir, true).unwrap() else {
            panic!("нет ключа")
        };
        std::fs::write(
            dir.join("links.dat"),
            seal_data(&k, "links.dat", b"{}").unwrap(),
        )
        .unwrap();
        assert!(check_files(dir, Some(&k)).is_ok());
        assert!(check_files(dir, None).is_err());
        assert!(check_files(dir, Some(&[2; 32])).is_err());
        std::fs::remove_file(dir.join(FILE)).unwrap();
        std::fs::remove_file(dir.join(BAK)).unwrap();
        assert!(open(dir, true).is_err());
        assert_eq!(open(dir, false).unwrap(), Opened::Ready(None));
    }
}
