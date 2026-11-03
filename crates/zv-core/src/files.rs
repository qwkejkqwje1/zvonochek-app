//! Файлы в чатах. Предложение едет в сообщении (`f: {fid, name, size, mime, hash}`), сами байты —
//! отдельным потоком P2P-линка: получатель пишет `{t: "get", fid, off}`, отправитель отвечает
//! `{ok, size}` и байтами начиная с `off`. Проверка BLAKE3, докачка из `.part`, метка
//! «из интернета» (Zone.Identifier) на Windows. Картинки до 25 МБ скачиваются сами.

use crate::db::{FileRec, Msg};
use crate::groups::is_group;
use crate::{Inner, s};
use base64::Engine;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use zv_p2p::{StreamRecv, StreamSend, encode_frame, read_frame};
use zv_proto::ids::{now_ms, rand_hex};

pub(crate) const MAX_FILE: u64 = 4 << 30;
const AUTO_IMAGE_MAX: u64 = 25 << 20;
const PREVIEW_MAX: u64 = 16 << 20;
const BLOB_MAX: usize = 32 << 20;
const PROGRESS_EVERY_MS: u64 = 300;
const CHUNK: usize = 64 * 1024;

enum DlErr {
    NoLink,
    Canceled,
    Other(String),
}

/// Имя файла, безопасное для Windows.
pub(crate) fn safe_name(s: &str) -> String {
    let base = s.rsplit(['/', '\\']).next().unwrap_or("");
    let n: String = base
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(150)
        .collect();
    let mut n = n.trim().trim_end_matches(['.', ' ']).to_string();
    if n.is_empty() {
        n = "файл".into();
    }
    let stem = n.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        n = format!("_{n}");
    }
    n
}

pub(crate) fn mime_of(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "doc" | "docx" => "application/msword",
        "xls" | "xlsx" => "application/vnd.ms-excel",
        "ppt" | "pptx" => "application/vnd.ms-powerpoint",
        _ => "application/octet-stream",
    }
}

/// Свободное имя в папке: `имя (1).ext`, … (учитывая и недокачанные `.part`).
pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for i in 0..10_000 {
        let n = if i == 0 {
            name.to_string()
        } else {
            format!("{stem} ({i}){ext}")
        };
        let p = dir.join(&n);
        if !p.exists() && !part_of(&p).exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-{}{ext}", rand_hex(4)))
}

fn part_of(p: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", p.display()))
}

/// Метка «файл из интернета» — Windows покажет предупреждение SmartScreen при запуске.
#[cfg(windows)]
fn motw(p: &Path) {
    let ads = format!("{}:Zone.Identifier", p.display());
    let _ = std::fs::write(ads, "[ZoneTransfer]\r\nZoneId=3\r\n");
}
#[cfg(not(windows))]
fn motw(_: &Path) {}

impl Inner {
    pub(crate) fn downloads_dir(&self) -> PathBuf {
        self.opts
            .downloads_dir
            .clone()
            .unwrap_or_else(|| self.opts.data_dir.join("Downloads"))
    }

    /// Описание файла из кадра (проверенное).
    pub(crate) fn file_meta(&self, frame: &Value) -> Option<Value> {
        let f = frame.get("f")?;
        let fid = f.get("fid")?.as_str()?;
        let hash = f.get("hash")?.as_str()?;
        let size = f.get("size")?.as_u64()?;
        if fid.len() < 16 || fid.len() > 64 || !fid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        if hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
            || size == 0
            || size > MAX_FILE
        {
            return None;
        }
        let name = safe_name(f.get("name").and_then(|v| v.as_str()).unwrap_or(""));
        let mime: String = f
            .get("mime")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .filter(|c| c.is_ascii_graphic())
            .take(100)
            .collect();
        let mime = if mime.is_empty() {
            mime_of(&name).to_string()
        } else {
            mime
        };
        Some(json!({"fid": fid, "name": name, "size": size, "mime": mime, "hash": hash}))
    }

    pub(crate) fn emit_file(&self, fid: &str) {
        if let Some(r) = self.db.file(fid) {
            self.emit(
                "chat:file",
                json!({"fid": r.fid, "chat": r.chat, "msg": r.msg, "out": r.out, "st": r.st, "done": r.done, "size": r.size, "path": r.path, "err": r.err}),
            );
        }
    }

    /// Пришло сообщение с файлом.
    pub(crate) fn file_offered(self: &Arc<Self>, chat: &str, m: &Msg, f: &Value) {
        let fid = f["fid"].as_str().unwrap_or("").to_string();
        if self.db.file(&fid).is_some() {
            return; // такой fid уже есть (повтор или подделка своего)
        }
        let size = f["size"].as_u64().unwrap_or(0);
        let mime = f["mime"].as_str().unwrap_or("").to_string();
        self.db.file_put(&FileRec {
            fid: fid.clone(),
            chat: chat.to_string(),
            msg: m.id.clone(),
            out: false,
            name: f["name"].as_str().unwrap_or("файл").to_string(),
            size,
            mime: mime.clone(),
            hash: f["hash"].as_str().unwrap_or("").to_string(),
            path: String::new(),
            st: "offered".into(),
            done: 0,
            err: String::new(),
            updated: now_ms(),
        });
        let auto = self.lock().settings.auto_images;
        if auto && mime.starts_with("image/") && size <= AUTO_IMAGE_MAX {
            let _ = self.file_start(&fid);
        }
    }

    pub(crate) fn chat_file_accept(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        self.file_start(s(args, "fid")?)?;
        Ok(Value::Null)
    }

    pub(crate) fn chat_file_cancel(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        self.file_cancel_inner(s(args, "fid")?, false);
        Ok(Value::Null)
    }

    /// Отменить приём/раздачу. `remote` — отменил собеседник.
    pub(crate) fn file_cancel_inner(self: &Arc<Self>, fid: &str, remote: bool) {
        let Some(r) = self.db.file(fid) else { return };
        if let Some(flag) = self.lock().chats.transfers.get(fid) {
            flag.store(true, Ordering::SeqCst);
        }
        if r.out {
            if r.st != "canceled" {
                self.db.file_set(fid, "canceled", r.done, None, "");
                if !remote && is_group(&r.chat) {
                    if let Some(g) = self.group(&r.chat).filter(|g| !g.left) {
                        let _ = self.group_post(
                            &g,
                            "fcancel",
                            json!({"t": "chat_file_cancel", "fid": fid}),
                            true,
                            None,
                        );
                    }
                } else if !remote
                    && let (Some(c), Some(n)) = (
                        self.lock()
                            .contacts
                            .items
                            .iter()
                            .find(|c| c.id == r.chat)
                            .cloned(),
                        self.node(),
                    )
                {
                    n.send_peer(&c.peer, &json!({"t": "chat_file_cancel", "fid": fid}));
                }
            }
        } else if r.st != "done" && r.st != "canceled" {
            if !r.path.is_empty() {
                let _ = std::fs::remove_file(part_of(Path::new(&r.path)));
            }
            self.db.file_set(
                fid,
                "canceled",
                0,
                None,
                if remote {
                    "отправитель отменил"
                } else {
                    ""
                },
            );
        }
        self.emit_file(fid);
    }

    /// Начать (или продолжить) скачивание.
    pub(crate) fn file_start(self: &Arc<Self>, fid: &str) -> Result<(), String> {
        let r = self.db.file(fid).ok_or("нет такого файла")?;
        if r.out {
            return Err("это ваш файл".into());
        }
        if r.st == "done" {
            return Ok(());
        }
        // файл группы качаем у автора сообщения, пока он участник
        let (peer, hint) = if is_group(&r.chat) {
            let who = self.db.msg(&r.msg).map(|m| m.sender).unwrap_or_default();
            if who.is_empty() || !self.file_peer_ok(&who, &r.chat) {
                return Err("автора файла больше нет в группе".into());
            }
            let hint = self.peer_hint(&who);
            (who, hint)
        } else {
            let c = self
                .lock()
                .contacts
                .items
                .iter()
                .find(|c| c.id == r.chat)
                .cloned()
                .ok_or("нет такого контакта")?;
            (c.peer, c.hint)
        };
        let flag = {
            let mut st = self.lock();
            if st.chats.transfers.contains_key(fid) {
                return Ok(());
            }
            let f = Arc::new(AtomicBool::new(false));
            st.chats.transfers.insert(fid.to_string(), f.clone());
            f
        };
        self.db.file_set(fid, "queued", r.done, None, "");
        self.emit_file(fid);
        let me = self.clone();
        self.rt.spawn(async move {
            let res = me.download(&r, &peer, hint, &flag).await;
            me.lock().chats.transfers.remove(&r.fid);
            let done = me.db.file(&r.fid).map(|x| x.done).unwrap_or(0);
            match res {
                Ok(path) => me.db.file_set(&r.fid, "done", r.size, Some(&path), ""),
                Err(DlErr::NoLink) => me.db.file_set(&r.fid, "waiting", done, None, ""),
                Err(DlErr::Canceled) => {}
                Err(DlErr::Other(e)) => me.db.file_set(&r.fid, "failed", done, None, &e),
            }
            me.emit_file(&r.fid);
        });
        Ok(())
    }

    async fn download(
        self: &Arc<Self>,
        r: &FileRec,
        peer: &str,
        hint: Option<Value>,
        cancel: &AtomicBool,
    ) -> Result<String, DlErr> {
        let node = self.node().ok_or(DlErr::NoLink)?;
        let link = match node.link_for(peer) {
            Some(l) => l,
            None => {
                tokio::time::timeout(Duration::from_secs(20), node.connect(peer, hint.as_ref()))
                    .await
                    .ok()
                    .and_then(|x| x.ok())
                    .ok_or(DlErr::NoLink)?
            }
        };
        let dir = self.downloads_dir();
        let _ = tokio::fs::create_dir_all(&dir).await;
        let fin = if r.path.is_empty() {
            unique_path(&dir, &r.name)
        } else {
            PathBuf::from(&r.path)
        };
        let part = part_of(&fin);
        let fin_s = fin.display().to_string();
        let mut off = tokio::fs::metadata(&part)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if off > r.size {
            let _ = tokio::fs::remove_file(&part).await;
            off = 0;
        }
        self.db.file_set(&r.fid, "loading", off, Some(&fin_s), "");
        self.emit_file(&r.fid);
        // хэш уже скачанной части
        let mut hasher = if off > 0 {
            let p = part.clone();
            tokio::task::spawn_blocking(move || {
                let mut h = blake3::Hasher::new();
                std::fs::File::open(&p)
                    .and_then(|f| h.update_reader(f).map(|_| ()))
                    .map(|_| h)
            })
            .await
            .map_err(|e| DlErr::Other(e.to_string()))?
            .map_err(|e| DlErr::Other(e.to_string()))?
        } else {
            blake3::Hasher::new()
        };
        let (mut tx, mut rx) = node.open_stream(link).await.map_err(|_| DlErr::NoLink)?;
        tx.write_all(&encode_frame(
            &json!({"t": "get", "fid": r.fid, "off": off}),
        ))
        .await
        .map_err(|_| DlErr::NoLink)?;
        let head = tokio::time::timeout(Duration::from_secs(20), read_frame(&mut rx))
            .await
            .map_err(|_| DlErr::NoLink)?
            .map_err(|_| DlErr::NoLink)?
            .ok_or(DlErr::NoLink)?;
        if head.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Err(DlErr::Other(
                head.get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("отправитель отказал")
                    .to_string(),
            ));
        }
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part)
            .await
            .map_err(|e| DlErr::Other(format!("не удалось записать файл: {e}")))?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = off;
        let mut last = 0u64;
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = rx.stop(0u32.into());
                drop(f);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(DlErr::Canceled);
            }
            let n = match tokio::time::timeout(Duration::from_secs(60), rx.read(&mut buf)).await {
                Ok(Ok(Some(n))) => n,
                Ok(Ok(None)) => break,
                _ => {
                    let _ = f.flush().await;
                    return Err(DlErr::NoLink);
                }
            };
            f.write_all(&buf[..n])
                .await
                .map_err(|e| DlErr::Other(format!("не удалось записать файл: {e}")))?;
            hasher.update(&buf[..n]);
            done += n as u64;
            if done > r.size {
                drop(f);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(DlErr::Other("файл больше заявленного".into()));
            }
            let now = now_ms();
            if now.saturating_sub(last) >= PROGRESS_EVERY_MS {
                last = now;
                self.touch_peer(peer);
                self.db.file_set(&r.fid, "loading", done, None, "");
                self.emit_file(&r.fid);
            }
        }
        f.flush().await.map_err(|e| DlErr::Other(e.to_string()))?;
        let _ = f.sync_all().await;
        drop(f);
        if done != r.size {
            self.db.file_set(&r.fid, "loading", done, None, "");
            return Err(DlErr::NoLink);
        }
        if hasher.finalize().to_hex().as_str() != r.hash {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(DlErr::Other("файл повреждён при передаче".into()));
        }
        let fin = if fin.exists() {
            unique_path(&dir, &r.name)
        } else {
            fin
        };
        tokio::fs::rename(&part, &fin)
            .await
            .map_err(|e| DlErr::Other(e.to_string()))?;
        motw(&fin);
        Ok(fin.display().to_string())
    }

    /// Связь с собеседником появилась: продолжить ждущие файлы от него.
    pub(crate) fn files_resume(self: &Arc<Self>, peer: &str) {
        let cid = self
            .lock()
            .contacts
            .items
            .iter()
            .find(|c| c.peer == peer)
            .map(|c| c.id.clone());
        for f in self.db.files_where_st(&["waiting"]) {
            if f.out {
                continue;
            }
            let from = if is_group(&f.chat) {
                self.db.msg(&f.msg).is_some_and(|m| m.sender == peer)
            } else {
                cid.as_deref() == Some(f.chat.as_str())
            };
            if from {
                let _ = self.file_start(&f.fid);
            }
        }
    }

    /// После запуска: прерванные скачивания — в «ждут связи».
    pub(crate) fn files_after_start(&self) {
        for f in self.db.files_where_st(&["loading", "queued"]) {
            self.db.file_set(&f.fid, "waiting", f.done, None, "");
        }
    }

    /// Собеседник просит файл (поток линка).
    pub(crate) fn on_stream(
        self: &Arc<Self>,
        peer: String,
        mut tx: StreamSend,
        mut rx: StreamRecv,
    ) {
        let me = self.clone();
        self.rt.spawn(async move {
            let Ok(Ok(Some(h))) = tokio::time::timeout(Duration::from_secs(10), read_frame(&mut rx)).await else { return };
            if h.get("t").and_then(|v| v.as_str()) != Some("get") {
                return;
            }
            let fid = h.get("fid").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let off = h.get("off").and_then(|v| v.as_u64()).unwrap_or(0);
            let rec = me.db.file(&fid).filter(|r| r.out && r.st != "canceled" && me.file_peer_ok(&peer, &r.chat));
            let fail = |e: &str| encode_frame(&json!({"ok": false, "error": e}));
            let Some(r) = rec else {
                let _ = tx.write_all(&fail("файла больше нет у отправителя")).await;
                let _ = tx.finish();
                return;
            };
            let opened = tokio::fs::File::open(&r.path).await;
            let mut f = match opened {
                Ok(f) if f.metadata().await.map(|m| m.len()).unwrap_or(0) == r.size => f,
                Ok(_) => {
                    let _ = tx.write_all(&fail("файл у отправителя изменился")).await;
                    let _ = tx.finish();
                    return;
                }
                Err(_) => {
                    let _ = tx.write_all(&fail("файл у отправителя недоступен")).await;
                    let _ = tx.finish();
                    return;
                }
            };
            if off > r.size || f.seek(std::io::SeekFrom::Start(off)).await.is_err() {
                let _ = tx.write_all(&fail("неверное смещение")).await;
                let _ = tx.finish();
                return;
            }
            if tx.write_all(&encode_frame(&json!({"ok": true, "size": r.size}))).await.is_err() {
                return;
            }
            let mut buf = vec![0u8; CHUNK];
            let mut sent = off;
            let mut last = 0u64;
            loop {
                let n = match f.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => return,
                };
                if tx.write_all(&buf[..n]).await.is_err() {
                    return;
                }
                sent += n as u64;
                let now = now_ms();
                if now.saturating_sub(last) >= PROGRESS_EVERY_MS {
                    last = now;
                    me.touch_peer(&peer);
                    if me.db.file(&fid).is_some_and(|x| x.st == "canceled") {
                        let _ = tx.reset(0u32.into());
                        return;
                    }
                    me.emit("chat:file", json!({"fid": fid, "chat": r.chat, "msg": r.msg, "out": true, "st": "sending", "done": sent, "size": r.size}));
                }
            }
            let _ = tx.finish();
            let _ = tokio::time::timeout(Duration::from_secs(30), tx.stopped()).await;
            me.db.file_set(&fid, "ready", r.size, None, "");
            me.emit_file(&fid);
        });
    }

    // ---------- отправка ----------

    pub(crate) async fn chat_send_file(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let chat = s(args, "chat")?.to_string();
        let path = PathBuf::from(s(args, "path")?);
        let caption = args
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(4000)
            .collect::<String>();
        let meta = tokio::fs::metadata(&path)
            .await
            .map_err(|e| format!("файл недоступен: {e}"))?;
        if !meta.is_file() {
            return Err("это не файл".into());
        }
        let size = meta.len();
        if size == 0 {
            return Err("файл пустой".into());
        }
        if size > MAX_FILE {
            return Err("файл больше 4 ГБ".into());
        }
        let name = safe_name(
            &path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        );
        self.send_file_msg(&chat, path, name, size, caption).await
    }

    /// Вставка из буфера обмена / перетаскивание без пути: данные base64.
    pub(crate) async fn chat_send_blob(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let chat = s(args, "chat")?.to_string();
        let name = safe_name(
            args.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("картинка.png"),
        );
        let raw = s(args, "data")?;
        let raw = raw.split_once(";base64,").map(|x| x.1).unwrap_or(raw);
        let data = base64::engine::general_purpose::STANDARD
            .decode(raw.trim())
            .map_err(|_| "не удалось прочитать данные")?;
        if data.is_empty() || data.len() > BLOB_MAX {
            return Err("слишком большой файл для вставки (до 32 МБ)".into());
        }
        let dir = self.opts.data_dir.join("sent");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
        let path = dir.join(format!("{}-{name}", rand_hex(4)));
        tokio::fs::write(&path, &data)
            .await
            .map_err(|e| e.to_string())?;
        let caption = args
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(4000)
            .collect::<String>();
        self.send_file_msg(&chat, path, name, data.len() as u64, caption)
            .await
    }

    async fn send_file_msg(
        self: &Arc<Self>,
        chat: &str,
        path: PathBuf,
        name: String,
        size: u64,
        caption: String,
    ) -> Result<Value, String> {
        let group = if is_group(chat) {
            Some(self.group_writable(chat)?)
        } else {
            None
        };
        let peer = match &group {
            Some(_) => String::new(),
            None => self
                .lock()
                .contacts
                .items
                .iter()
                .find(|c| c.id == chat)
                .map(|c| c.peer.clone())
                .ok_or("нет такого контакта")?,
        };
        let p2 = path.clone();
        let hash = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
            let mut h = blake3::Hasher::new();
            h.update_reader(std::fs::File::open(&p2)?)?;
            Ok(h.finalize().to_hex().to_string())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("не удалось прочитать файл: {e}"))?;
        let fid = rand_hex(16);
        let mime = mime_of(&name).to_string();
        let file = json!({"fid": fid, "name": name, "size": size, "mime": mime, "hash": hash});
        let m = self.new_out_msg(chat, "file", caption, None, Some(file));
        self.db.file_put(&FileRec {
            fid,
            chat: chat.to_string(),
            msg: m.id.clone(),
            out: true,
            name,
            size,
            mime,
            hash,
            path: path.display().to_string(),
            st: "ready".into(),
            done: 0,
            err: String::new(),
            updated: now_ms(),
        });
        match &group {
            Some(g) => self.group_send_msg(g, &m)?,
            None => self.deliver(&peer, &m.id, "chat", crate::chats::frame_of(&m)),
        }
        let v = self.msg_json(&m);
        self.emit("chat:msg", json!({"msg": v, "new": true}));
        Ok(v)
    }

    /// Путь файла для «Открыть» / «Показать в папке» (хост открывает только файлы чатов).
    pub(crate) fn chat_file_path(&self, args: &Value) -> Result<Value, String> {
        if args.get("export").and_then(|v| v.as_bool()) == Some(true) {
            let p = self.last_export().ok_or("файл профиля не найден")?;
            return Ok(
                json!({"path": p.display().to_string(), "name": p.file_name().map(|n| n.to_string_lossy().to_string()), "out": true, "dir": false}),
            );
        }
        if args.get("downloads").and_then(|v| v.as_bool()) == Some(true) {
            let d = self.downloads_dir();
            let _ = std::fs::create_dir_all(&d);
            return Ok(json!({"path": d.display().to_string(), "dir": true}));
        }
        let r = self.db.file(s(args, "fid")?).ok_or("нет такого файла")?;
        if !r.out && r.st != "done" {
            return Err("файл ещё не скачан".into());
        }
        if r.path.is_empty() || !std::path::Path::new(&r.path).is_file() {
            return Err("файл удалён или перемещён".into());
        }
        Ok(json!({"path": r.path, "name": r.name, "out": r.out, "dir": false}))
    }

    /// Картинка для предпросмотра: data:URL (до 16 МБ).
    pub(crate) async fn chat_file_data(&self, args: &Value) -> Result<Value, String> {
        let r = self.db.file(s(args, "fid")?).ok_or("нет такого файла")?;
        if !r.out && r.st != "done" {
            return Err("файл ещё не скачан".into());
        }
        if !r.mime.starts_with("image/") || r.size > PREVIEW_MAX {
            return Err("нет предпросмотра".into());
        }
        let data = tokio::fs::read(&r.path)
            .await
            .map_err(|_| "файл недоступен")?;
        Ok(
            json!({"url": format!("data:{};base64,{}", r.mime, base64::engine::general_purpose::STANDARD.encode(data))}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names() {
        assert_eq!(safe_name("..\\..\\evil.exe"), "evil.exe");
        assert_eq!(safe_name("a/b/c:d?.txt"), "cd.txt");
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_name("   ...  "), "файл");
        assert_eq!(safe_name("отчёт.pdf."), "отчёт.pdf");
        assert_eq!(mime_of("Фото.JPG"), "image/jpeg");
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "x").unwrap();
        std::fs::write(d.path().join("a (1).txt.part"), "x").unwrap();
        assert_eq!(
            unique_path(d.path(), "a.txt").file_name().unwrap(),
            "a (2).txt"
        );
        assert_eq!(unique_path(d.path(), "b").file_name().unwrap(), "b");
    }
}
