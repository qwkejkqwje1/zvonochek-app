//! История чатов — SQLite (`chats.db` в папке данных): сообщения, исходящая очередь доставки,
//! файлы и мелкие значения (курсор ящика).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS msgs (
  id TEXT PRIMARY KEY,
  chat TEXT NOT NULL,
  out INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  rx INTEGER NOT NULL,
  lc INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  reply TEXT,
  file TEXT,
  st INTEGER NOT NULL DEFAULT 0,
  edited INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS msgs_chat ON msgs(chat, lc, ts, id);
CREATE TABLE IF NOT EXISTS outbox (
  fid TEXT NOT NULL,
  peer TEXT NOT NULL,
  kind TEXT NOT NULL,
  frame TEXT NOT NULL,
  created INTEGER NOT NULL,
  mailed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fid, peer)
);
CREATE TABLE IF NOT EXISTS files (
  fid TEXT PRIMARY KEY,
  chat TEXT NOT NULL,
  msg TEXT NOT NULL,
  out INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  st TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  err TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_chat ON files(chat);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"#;

/// Состояния исходящего: 0 — в очереди, 1 — отправлено в ящик, 2 — доставлено, 3 — прочитано.
/// Входящее: 0 — не прочитано, 3 — прочитано.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Msg {
    pub id: String,
    pub chat: String,
    pub out: bool,
    pub ts: u64,
    pub rx: u64,
    pub lc: u64,
    pub kind: String,
    pub body: String,
    pub reply: Option<String>,
    pub file: Option<Value>,
    pub st: u8,
    pub edited: Option<u64>,
    pub deleted: bool,
    pub via: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRec {
    pub fid: String,
    pub chat: String,
    pub msg: String,
    pub out: bool,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub hash: String,
    pub path: String,
    /// ready (свой, раздаём) · offered · queued · waiting (нет связи) · loading · done · failed · canceled
    pub st: String,
    pub done: u64,
    pub err: String,
    pub updated: u64,
}

#[derive(Debug, Clone)]
pub struct OutEntry {
    pub fid: String,
    pub peer: String,
    pub kind: String,
    pub frame: Value,
    pub created: u64,
    pub mailed: bool,
}

pub struct Db {
    c: Mutex<Connection>,
}

fn msg_row(r: &rusqlite::Row) -> rusqlite::Result<Msg> {
    let file: Option<String> = r.get(9)?;
    Ok(Msg {
        id: r.get(0)?,
        chat: r.get(1)?,
        out: r.get::<_, i64>(2)? != 0,
        ts: r.get::<_, i64>(3)? as u64,
        rx: r.get::<_, i64>(4)? as u64,
        lc: r.get::<_, i64>(5)? as u64,
        kind: r.get(6)?,
        body: r.get(7)?,
        reply: r.get(8)?,
        file: file.and_then(|f| serde_json::from_str(&f).ok()),
        st: r.get::<_, i64>(10)? as u8,
        edited: r.get::<_, Option<i64>>(11)?.map(|v| v as u64),
        deleted: r.get::<_, i64>(12)? != 0,
        via: r.get(13)?,
    })
}

const MSG_COLS: &str = "id, chat, out, ts, rx, lc, kind, body, reply, file, st, edited, deleted, via";

fn file_row(r: &rusqlite::Row) -> rusqlite::Result<FileRec> {
    Ok(FileRec {
        fid: r.get(0)?,
        chat: r.get(1)?,
        msg: r.get(2)?,
        out: r.get::<_, i64>(3)? != 0,
        name: r.get(4)?,
        size: r.get::<_, i64>(5)? as u64,
        mime: r.get(6)?,
        hash: r.get(7)?,
        path: r.get(8)?,
        st: r.get(9)?,
        done: r.get::<_, i64>(10)? as u64,
        err: r.get(11)?,
        updated: r.get::<_, i64>(12)? as u64,
    })
}

const FILE_COLS: &str = "fid, chat, msg, out, name, size, mime, hash, path, st, done, err, updated";

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Db> {
        let c = Connection::open(path)?;
        c.pragma_update(None, "journal_mode", "WAL")?;
        c.pragma_update(None, "synchronous", "NORMAL")?;
        c.execute_batch(SCHEMA)?;
        Ok(Db { c: Mutex::new(c) })
    }

    pub fn memory() -> Db {
        let c = Connection::open_in_memory().expect("sqlite");
        c.execute_batch(SCHEMA).expect("schema");
        Db { c: Mutex::new(c) }
    }

    /// Снимок базы в файл (для переноса профиля).
    pub fn snapshot(&self, path: &Path) -> anyhow::Result<()> {
        let _ = std::fs::remove_file(path);
        self.c().execute("VACUUM INTO ?1", [path.display().to_string()])?;
        Ok(())
    }

    pub fn msgs_count(&self) -> u64 {
        self.c().query_row("SELECT COUNT(*) FROM msgs WHERE deleted = 0", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64
    }

    fn c(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.c.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---------- сообщения ----------

    /// `false` — такое уже есть.
    pub fn insert_msg(&self, m: &Msg) -> bool {
        let file = m.file.as_ref().map(|f| f.to_string());
        let r = self.c().execute(
            "INSERT OR IGNORE INTO msgs (id, chat, out, ts, rx, lc, kind, body, reply, file, st, edited, deleted, via)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                m.id,
                m.chat,
                m.out as i64,
                m.ts as i64,
                m.rx as i64,
                m.lc as i64,
                m.kind,
                m.body,
                m.reply,
                file,
                m.st as i64,
                m.edited.map(|v| v as i64),
                m.deleted as i64,
                m.via
            ],
        );
        matches!(r, Ok(n) if n > 0)
    }

    pub fn msg(&self, id: &str) -> Option<Msg> {
        self.c()
            .query_row(&format!("SELECT {MSG_COLS} FROM msgs WHERE id = ?1"), [id], msg_row)
            .optional()
            .ok()
            .flatten()
    }

    /// Сообщения чата по порядку; `before` — id, раньше которого (для подгрузки вверх).
    pub fn history(&self, chat: &str, before: Option<&str>, limit: usize) -> (Vec<Msg>, bool) {
        let c = self.c();
        let pivot = before.and_then(|b| {
            c.query_row("SELECT lc, ts, id FROM msgs WHERE id = ?1", [b], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
            })
            .optional()
            .ok()
            .flatten()
        });
        let lim = (limit + 1) as i64;
        let mut v: Vec<Msg> = match pivot {
            Some((lc, ts, id)) => {
                let mut q = c
                    .prepare(&format!(
                        "SELECT {MSG_COLS} FROM msgs WHERE chat = ?1 AND (lc, ts, id) < (?2, ?3, ?4)
                         ORDER BY lc DESC, ts DESC, id DESC LIMIT ?5"
                    ))
                    .expect("sql");
                q.query_map(params![chat, lc, ts, id, lim], msg_row).map(|r| r.flatten().collect()).unwrap_or_default()
            }
            None => {
                let mut q = c
                    .prepare(&format!("SELECT {MSG_COLS} FROM msgs WHERE chat = ?1 ORDER BY lc DESC, ts DESC, id DESC LIMIT ?2"))
                    .expect("sql");
                q.query_map(params![chat, lim], msg_row).map(|r| r.flatten().collect()).unwrap_or_default()
            }
        };
        let more = v.len() > limit;
        v.truncate(limit);
        v.reverse();
        (v, more)
    }

    pub fn last_msg(&self, chat: &str) -> Option<Msg> {
        self.c()
            .query_row(&format!("SELECT {MSG_COLS} FROM msgs WHERE chat = ?1 ORDER BY lc DESC, ts DESC, id DESC LIMIT 1"), [chat], msg_row)
            .optional()
            .ok()
            .flatten()
    }

    pub fn max_lc(&self, chat: &str) -> u64 {
        self.c()
            .query_row("SELECT COALESCE(MAX(lc), 0) FROM msgs WHERE chat = ?1", [chat], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as u64
    }

    /// Непрочитанные входящие по чатам.
    pub fn unread(&self) -> Vec<(String, u64)> {
        let c = self.c();
        let mut q = c.prepare("SELECT chat, COUNT(*) FROM msgs WHERE out = 0 AND st < 3 AND deleted = 0 GROUP BY chat").expect("sql");
        q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))).map(|r| r.flatten().collect()).unwrap_or_default()
    }

    /// Поднять состояние исходящих (только вверх). Возвращает изменённые id.
    pub fn raise_out(&self, chat: &str, ids: &[String], st: u8) -> Vec<String> {
        let c = self.c();
        let mut changed = Vec::new();
        for id in ids {
            let n = c
                .execute("UPDATE msgs SET st = ?1 WHERE id = ?2 AND chat = ?3 AND out = 1 AND st < ?1", params![st as i64, id, chat])
                .unwrap_or(0);
            if n > 0 {
                changed.push(id.clone());
            }
        }
        changed
    }

    /// Собеседник прочитал всё до `upto` (наше сообщение) включительно.
    pub fn read_out_upto(&self, chat: &str, upto: &str) -> Vec<String> {
        let c = self.c();
        let Ok(lc) = c.query_row("SELECT lc FROM msgs WHERE id = ?1 AND chat = ?2", params![upto, chat], |r| r.get::<_, i64>(0)) else {
            return Vec::new();
        };
        let ids: Vec<String> = {
            let mut q = c.prepare("SELECT id FROM msgs WHERE chat = ?1 AND out = 1 AND st < 3 AND lc <= ?2").expect("sql");
            q.query_map(params![chat, lc], |r| r.get::<_, String>(0)).map(|r| r.flatten().collect()).unwrap_or_default()
        };
        let _ = c.execute("UPDATE msgs SET st = 3 WHERE chat = ?1 AND out = 1 AND st < 3 AND lc <= ?2", params![chat, lc]);
        ids
    }

    /// Пометить входящие чата прочитанными; вернуть последнее входящее (для отметки собеседнику).
    pub fn read_in_all(&self, chat: &str) -> (u64, Option<String>) {
        let c = self.c();
        let n = c.execute("UPDATE msgs SET st = 3 WHERE chat = ?1 AND out = 0 AND st < 3", [chat]).unwrap_or(0) as u64;
        let last = c
            .query_row("SELECT id FROM msgs WHERE chat = ?1 AND out = 0 ORDER BY lc DESC, ts DESC, id DESC LIMIT 1", [chat], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten();
        (n, last)
    }

    pub fn edit(&self, id: &str, body: &str, ts: u64) -> bool {
        self.c()
            .execute("UPDATE msgs SET body = ?1, edited = ?2 WHERE id = ?3 AND deleted = 0", params![body, ts as i64, id])
            .unwrap_or(0)
            > 0
    }

    /// Удалено у всех: текст и файл стираются, место в ленте остаётся.
    pub fn mark_deleted(&self, id: &str) -> bool {
        self.c()
            .execute("UPDATE msgs SET deleted = 1, body = '', file = NULL, reply = NULL WHERE id = ?1", [id])
            .unwrap_or(0)
            > 0
    }

    /// Удалено у меня — совсем.
    pub fn remove(&self, id: &str) -> bool {
        let c = self.c();
        let _ = c.execute("DELETE FROM files WHERE msg = ?1", [id]);
        c.execute("DELETE FROM msgs WHERE id = ?1", [id]).unwrap_or(0) > 0
    }

    pub fn clear_chat(&self, chat: &str) {
        let c = self.c();
        let _ = c.execute("DELETE FROM msgs WHERE chat = ?1", [chat]);
        let _ = c.execute("DELETE FROM files WHERE chat = ?1", [chat]);
    }

    #[cfg(test)]
    pub fn count(&self, chat: &str) -> u64 {
        self.c().query_row("SELECT COUNT(*) FROM msgs WHERE chat = ?1", [chat], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64
    }

    // ---------- очередь доставки ----------

    pub fn out_put(&self, e: &OutEntry) {
        let _ = self.c().execute(
            "INSERT OR REPLACE INTO outbox (fid, peer, kind, frame, created, mailed) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![e.fid, e.peer, e.kind, e.frame.to_string(), e.created as i64, e.mailed as i64],
        );
    }

    pub fn out_del(&self, fid: &str, peer: &str) -> bool {
        self.c().execute("DELETE FROM outbox WHERE fid = ?1 AND peer = ?2", params![fid, peer]).unwrap_or(0) > 0
    }

    /// Убрать устаревшие записи вида (например, прежнюю отметку о прочтении).
    pub fn out_del_kind(&self, peer: &str, kind: &str) {
        let _ = self.c().execute("DELETE FROM outbox WHERE peer = ?1 AND kind = ?2", params![peer, kind]);
    }

    pub fn out_del_peer(&self, peer: &str) {
        let _ = self.c().execute("DELETE FROM outbox WHERE peer = ?1", [peer]);
    }

    pub fn out_mailed(&self, fid: &str, peer: &str) {
        let _ = self.c().execute("UPDATE outbox SET mailed = 1 WHERE fid = ?1 AND peer = ?2", params![fid, peer]);
    }

    pub fn out_all(&self) -> Vec<OutEntry> {
        let c = self.c();
        let mut q = c.prepare("SELECT fid, peer, kind, frame, created, mailed FROM outbox ORDER BY created").expect("sql");
        q.query_map([], |r| {
            Ok(OutEntry {
                fid: r.get(0)?,
                peer: r.get(1)?,
                kind: r.get(2)?,
                frame: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Null),
                created: r.get::<_, i64>(4)? as u64,
                mailed: r.get::<_, i64>(5)? != 0,
            })
        })
        .map(|r| r.flatten().collect())
        .unwrap_or_default()
    }

    // ---------- файлы ----------

    pub fn file_put(&self, f: &FileRec) {
        let _ = self.c().execute(
            &format!("INSERT OR REPLACE INTO files ({FILE_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"),
            params![
                f.fid,
                f.chat,
                f.msg,
                f.out as i64,
                f.name,
                f.size as i64,
                f.mime,
                f.hash,
                f.path,
                f.st,
                f.done as i64,
                f.err,
                f.updated as i64
            ],
        );
    }

    pub fn file(&self, fid: &str) -> Option<FileRec> {
        self.c().query_row(&format!("SELECT {FILE_COLS} FROM files WHERE fid = ?1"), [fid], file_row).optional().ok().flatten()
    }

    pub fn files_where_st(&self, sts: &[&str]) -> Vec<FileRec> {
        let c = self.c();
        let list = sts.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",");
        let mut q = c.prepare(&format!("SELECT {FILE_COLS} FROM files WHERE st IN ({list})")).expect("sql");
        q.query_map([], file_row).map(|r| r.flatten().collect()).unwrap_or_default()
    }

    pub fn file_set(&self, fid: &str, st: &str, done: u64, path: Option<&str>, err: &str) {
        let c = self.c();
        let now = zv_proto::ids::now_ms() as i64;
        match path {
            Some(p) => {
                let _ = c.execute(
                    "UPDATE files SET st = ?1, done = ?2, path = ?3, err = ?4, updated = ?5 WHERE fid = ?6",
                    params![st, done as i64, p, err, now, fid],
                );
            }
            None => {
                let _ = c.execute(
                    "UPDATE files SET st = ?1, done = ?2, err = ?3, updated = ?4 WHERE fid = ?5",
                    params![st, done as i64, err, now, fid],
                );
            }
        }
    }

    pub fn files_of_chat(&self, chat: &str) -> Vec<FileRec> {
        let c = self.c();
        let mut q = c.prepare(&format!("SELECT {FILE_COLS} FROM files WHERE chat = ?1")).expect("sql");
        q.query_map([chat], file_row).map(|r| r.flatten().collect()).unwrap_or_default()
    }

    // ---------- мелочи ----------

    pub fn kv(&self, k: &str) -> Option<String> {
        self.c().query_row("SELECT v FROM kv WHERE k = ?1", [k], |r| r.get::<_, String>(0)).optional().ok().flatten()
    }

    pub fn kv_set(&self, k: &str, v: &str) {
        let _ = self.c().execute("INSERT OR REPLACE INTO kv (k, v) VALUES (?1, ?2)", params![k, v]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str, chat: &str, out: bool, lc: u64) -> Msg {
        Msg {
            id: id.into(),
            chat: chat.into(),
            out,
            ts: lc * 10,
            rx: lc * 10,
            lc,
            kind: "text".into(),
            body: format!("b{id}"),
            reply: None,
            file: None,
            st: 0,
            edited: None,
            deleted: false,
            via: String::new(),
        }
    }

    #[test]
    fn history_order_unread_receipts() {
        let db = Db::memory();
        for i in 1..=5u64 {
            assert!(db.insert_msg(&m(&format!("m{i}"), "c1", i % 2 == 0, i)));
        }
        assert!(!db.insert_msg(&m("m1", "c1", false, 1)));
        let (v, more) = db.history("c1", None, 3);
        assert_eq!(v.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m3", "m4", "m5"]);
        assert!(more);
        let (v, more) = db.history("c1", Some("m3"), 10);
        assert_eq!(v.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1", "m2"]);
        assert!(!more);
        assert_eq!(db.unread(), vec![("c1".to_string(), 3)]);
        let (n, last) = db.read_in_all("c1");
        assert_eq!((n, last.as_deref()), (3, Some("m5")));
        assert!(db.unread().is_empty());
        assert_eq!(db.raise_out("c1", &["m2".into(), "m4".into()], 2), vec!["m2", "m4"]);
        assert!(db.raise_out("c1", &["m2".into()], 1).is_empty());
        assert_eq!(db.read_out_upto("c1", "m2"), vec!["m2"]);
        assert_eq!(db.msg("m4").unwrap().st, 2);
        assert_eq!(db.max_lc("c1"), 5);
        assert!(db.edit("m4", "new", 99));
        assert_eq!(db.msg("m4").unwrap().edited, Some(99));
        assert!(db.mark_deleted("m4"));
        assert!(db.msg("m4").unwrap().deleted);
        assert!(db.remove("m5"));
        assert_eq!(db.count("c1"), 4);
    }
}
