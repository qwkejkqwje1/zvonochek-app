//! Маленькие JSON-хранилища с атомарной записью (временный файл + rename) и резервной копией.
//!
//! Секретные (`protected`) — зашифрованы: ключом данных профиля (`ZVK1`, vault.rs), если он есть,
//! иначе DPAPI Windows (`ZVP1`). Файл старого формата перешифровывается ключом данных при чтении.

use crate::vault::{self, DataKey};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};

pub struct JsonFile {
    path: PathBuf,
    name: String,
    protected: bool,
    key: Option<DataKey>,
}

const MAGIC: &[u8] = b"ZVP1";

impl JsonFile {
    pub fn new(dir: &Path, name: &str, protected: bool) -> JsonFile {
        JsonFile {
            path: dir.join(name),
            name: name.to_string(),
            protected,
            key: None,
        }
    }

    /// Шифровать ключом данных профиля.
    pub fn keyed(mut self, key: Option<DataKey>) -> JsonFile {
        self.key = key;
        self
    }

    pub fn load<T: DeserializeOwned + Default>(&self) -> T {
        match self.try_load() {
            Ok(Some(v)) => v,
            Ok(None) => T::default(),
            Err(e) => {
                tracing::warn!("{}: {e}; начинаем с чистого", self.path.display());
                let bad = self.path.with_extension("broken");
                let _ = std::fs::rename(&self.path, bad);
                T::default()
            }
        }
    }

    fn try_load<T: DeserializeOwned>(&self) -> anyhow::Result<Option<T>> {
        let raw = match std::fs::read(&self.path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let (json, old_format) = if raw.starts_with(vault::MAGIC) {
            let key = self
                .key
                .ok_or_else(|| anyhow::anyhow!("нет ключа данных профиля"))?;
            let json = vault::open_data(&key, &self.name, &raw).map_err(anyhow::Error::msg)?;
            (json, false)
        } else if raw.starts_with(MAGIC) {
            (crate::protect::open(&raw[MAGIC.len()..])?, true)
        } else {
            (raw, true)
        };
        let v = serde_json::from_slice(&json)?;
        if old_format
            && self.protected
            && self.key.is_some()
            && let Err(e) = self.write(&json)
        {
            tracing::warn!("{}: не перешифрован: {e}", self.path.display());
        }
        Ok(Some(v))
    }

    pub fn save<T: Serialize>(&self, v: &T) -> anyhow::Result<()> {
        self.write(&serde_json::to_vec_pretty(v)?)
    }

    fn write(&self, json: &[u8]) -> anyhow::Result<()> {
        let data = match (self.protected, self.key) {
            (true, Some(k)) => {
                vault::seal_data(&k, &self.name, json).map_err(anyhow::Error::msg)?
            }
            (true, None) if crate::protect::ENABLED => {
                let mut d = MAGIC.to_vec();
                d.extend(crate::protect::seal(json)?);
                d
            }
            _ => json.to_vec(),
        };
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, &data)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}
