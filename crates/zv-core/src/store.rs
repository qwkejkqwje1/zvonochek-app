//! Маленькие JSON-хранилища с атомарной записью (временный файл + rename) и резервной копией.

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};

pub struct JsonFile {
    path: PathBuf,
    protected: bool,
}

const MAGIC: &[u8] = b"ZVP1";

impl JsonFile {
    pub fn new(dir: &Path, name: &str, protected: bool) -> JsonFile {
        JsonFile {
            path: dir.join(name),
            protected,
        }
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
        let json = if raw.starts_with(MAGIC) {
            crate::protect::open(&raw[MAGIC.len()..])?
        } else {
            raw
        };
        Ok(Some(serde_json::from_slice(&json)?))
    }

    pub fn save<T: Serialize>(&self, v: &T) -> anyhow::Result<()> {
        let json = serde_json::to_vec_pretty(v)?;
        let data = if self.protected && crate::protect::ENABLED {
            let mut d = MAGIC.to_vec();
            d.extend(crate::protect::seal(&json)?);
            d
        } else {
            json
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
