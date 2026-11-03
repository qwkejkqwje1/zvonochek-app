//! Ядро ZVONochek: комнаты веб-протокола (RoomHub), «Мои ссылки» с ожиданием звонка,
//! входящие, журнал, настройки, прокси HTTP для встроенного веб-клиента.
//!
//! Хосты (Tauri-приложение и тестовый стенд zv-devhost) вызывают `Core::dispatch(cmd, args)`
//! и подписываются на события `Core::subscribe()` — `{event, payload}`.

mod chats;
mod contacts;
mod db;
pub mod fetch;
mod files;
mod groups;
pub mod model;
mod p2p;
mod profile;
pub mod protect;
pub mod store;

pub use contacts::{decode_code as decode_contact_code, encode_code as encode_contact_code};

use model::{Contacts, HISTORY_MAX, History, HistoryEntry, LinkEntry, Links, Settings};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use store::JsonFile;
use tokio::sync::{broadcast, mpsc};
use zv_proto::ids::{now_ms, rand_hex};
use zv_signal::{HubEvent, HubStatus, Profile, RoomHub, SendOpts, SignalConfig};

/// Сколько молчания от звонящего считаем «положил трубку» (веб шлёт hello каждые 4,5 с).
const RING_SILENCE_MS: u64 = 15_000;
/// Дольше этого не звоним (звонящий может ждать бесконечно).
const RING_MAX_MS: u64 = 180_000;
/// Отклонённый/завершённый звонящий (по `inst`) не звонит снова, пока не замолчит на это время.
const SUPPRESS_MS: u64 = 30_000;

#[derive(Debug, Clone)]
pub struct CoreOptions {
    pub data_dir: PathBuf,
    pub app_version: String,
    /// Версия встроенного веб-клиента (`ver`).
    pub web_version: u32,
    pub platform: String,
    /// Режим разработки: прокси HTTP пускает localhost.
    pub dev: bool,
    /// Переопределение каналов (тесты, локальная инфраструктура).
    pub signal: Option<SignalConfig>,
    /// P2P через инфраструктуру n0 (релеи, поиск по ID). `false` — только прямые адреса (тесты).
    pub p2p_n0: bool,
    /// Куда сохранять файлы из чатов (`None` — папка данных/Downloads).
    pub downloads_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoreEvent {
    pub event: String,
    pub payload: Value,
}

#[derive(Clone)]
pub struct Core {
    inner: Arc<Inner>,
}

struct Inner {
    opts: CoreOptions,
    /// Рантайм, в котором запущено ядро: синхронные команды хоста (`dispatch_sync`)
    /// приходят из чужих потоков (главный поток Tauri) и входят в него.
    rt: tokio::runtime::Handle,
    events: broadcast::Sender<CoreEvent>,
    state: Mutex<State>,
    settings_file: JsonFile,
    links_file: JsonFile,
    history_file: JsonFile,
    contacts_file: JsonFile,
    identity_file: JsonFile,
    /// История чатов (SQLite).
    db: db::Db,
    /// Узел iroh (появляется через долю секунды после старта, если P2P включён; выключение — `None`).
    p2p: std::sync::RwLock<Option<zv_p2p::Node>>,
    p2p_starting: std::sync::atomic::AtomicBool,
    /// Поколение узла: события старого (выключенного) узла не трогают состояние нового.
    p2p_gen: AtomicU64,
}

struct State {
    settings: Settings,
    links: Links,
    history: History,
    rooms: HashMap<String, RoomEntry>,
    incoming: HashMap<String, Incoming>,
    /// inst звонящего → когда слышали последний раз
    suppressed: HashMap<String, u64>,
    contacts: Contacts,
    p2p: p2p::P2pState,
    chats: chats::ChatsState,
    groups: groups::GroupsState,
    /// Последний сохранённый файл профиля.
    last_export: Option<PathBuf>,
}

/// Зачем ядру комната.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RoomRole {
    /// Комната звонка (своя ссылка в ожидании или идущий звонок).
    Call,
    /// Мой ящик: сюда пишут контакты, если P2P не нашёлся.
    Inbox,
    /// Комната кода приглашения.
    Invite,
    /// Комната группы: сообщения участников, когда нет прямой связи.
    Group,
}

struct RoomEntry {
    hub: RoomHub,
    room: zv_proto::Room,
    role: RoomRole,
    /// Своя ссылка, по которой ждём звонка.
    link_id: Option<String>,
    joined: bool,
    session: Option<Session>,
    /// Ответили на входящий — следующий room_join будет входящим звонком.
    answered: Option<Incoming>,
    status: Option<HubStatus>,
}

#[derive(Debug, Clone)]
struct Session {
    started: u64,
    dir: &'static str,
    peer: String,
    peer_inst: Option<String>,
    peer_seen: bool,
    link_id: Option<String>,
    link_name: Option<String>,
    contact_id: Option<String>,
    peer_id: Option<String>,
    video: bool,
    /// Групповой звонок: id группы.
    group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Incoming {
    pub call_id: String,
    pub room_id: String,
    pub link_id: String,
    pub link_name: String,
    pub from: String,
    pub inst: String,
    pub name: String,
    pub started: u64,
    pub last_seen: u64,
    /// Звонящий — приложение ZVONochek.
    pub app: bool,
    /// Уже идёт другой звонок.
    pub busy: bool,
    /// Звонит контакт.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<String>,
    pub video: bool,
    /// Секрет комнаты звонка контакта (у ссылок он берётся из ссылки).
    #[serde(skip)]
    pub secret: Option<String>,
    /// Групповой звонок: id и название группы.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
}

fn s<'a>(args: &'a Value, k: &str) -> Result<&'a str, String> {
    args.get(k)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("нет аргумента {k}"))
}

fn ok<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

impl Core {
    /// Запуск ядра (внутри tokio-runtime).
    pub fn start(opts: CoreOptions) -> anyhow::Result<Core> {
        std::fs::create_dir_all(&opts.data_dir)?;
        profile::apply_pending(&opts.data_dir);
        let settings_file = JsonFile::new(&opts.data_dir, "settings.json", false);
        let links_file = JsonFile::new(&opts.data_dir, "links.dat", true);
        let history_file = JsonFile::new(&opts.data_dir, "history.json", false);
        let contacts_file = JsonFile::new(&opts.data_dir, "contacts.dat", true);
        let identity_file = JsonFile::new(&opts.data_dir, "identity.dat", true);
        let state = State {
            settings: settings_file.load(),
            links: links_file.load(),
            history: history_file.load(),
            rooms: HashMap::new(),
            incoming: HashMap::new(),
            suppressed: HashMap::new(),
            contacts: contacts_file.load(),
            p2p: p2p::P2pState::default(),
            chats: chats::ChatsState::default(),
            groups: groups::GroupsState::default(),
            last_export: None,
        };
        let db = match db::Db::open(&opts.data_dir.join("chats.db")) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("chats.db: {e}; история чатов только в памяти");
                db::Db::memory()
            }
        };
        let (events, _) = broadcast::channel(4096);
        let rt = tokio::runtime::Handle::current();
        let inner = Arc::new(Inner {
            opts,
            rt,
            events,
            state: Mutex::new(state),
            settings_file,
            links_file,
            history_file,
            contacts_file,
            identity_file,
            db,
            p2p: std::sync::RwLock::new(None),
            p2p_starting: std::sync::atomic::AtomicBool::new(false),
            p2p_gen: AtomicU64::new(0),
        });
        let core = Core { inner };
        core.inner.files_after_start();
        core.inner.sync_listeners();
        core.inner.p2p_start();
        tokio::spawn(ticker(Arc::downgrade(&core.inner)));
        Ok(core)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.inner.events.subscribe()
    }

    pub fn settings(&self) -> Settings {
        self.inner.lock().settings.clone()
    }

    /// Закрыть все комнаты (выход из приложения): в звонках — `bye`.
    pub async fn shutdown(&self) {
        let hubs: Vec<(RoomHub, bool)> = {
            let st = self.inner.lock();
            st.rooms
                .values()
                .map(|r| (r.hub.clone(), r.joined))
                .collect()
        };
        for (h, joined) in &hubs {
            if *joined {
                h.bye();
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        for (h, _) in hubs {
            h.close();
        }
        if let Some(n) = self.inner.node() {
            n.shutdown().await;
        }
    }

    /// ID устройства (EndpointId), если P2P запущен.
    pub fn device_id(&self) -> Option<String> {
        self.inner.node().map(|n| n.id().to_string())
    }

    /// Асинхронные команды (сеть, опрос каналов); остальные — через `dispatch_sync`.
    pub async fn dispatch(&self, cmd: &str, args: Value) -> Result<Value, String> {
        if let Some(r) = self.dispatch_sync(cmd, &args) {
            return r;
        }
        let i = &self.inner;
        match cmd {
            "room_stats" => match i.hub(s(&args, "roomId")?) {
                Some(h) => Ok(h.delivery_stats().await),
                None => Ok(Value::Null),
            },
            "room_status" => match i.hub(s(&args, "roomId")?) {
                Some(h) => ok(h.status().await),
                None => Ok(Value::Null),
            },
            "http_fetch" => {
                let wh = i.worker_host();
                fetch::http_fetch(&args, wh.as_deref(), i.opts.dev).await
            }
            "diag_snapshot" => Ok(i.diag().await),
            "chat_send_file" => i.chat_send_file(&args).await,
            "chat_send_blob" => i.chat_send_blob(&args).await,
            "chat_file_data" => i.chat_file_data(&args).await,
            "profile_export" => i.profile_export(&args).await,
            "profile_import" => i.profile_import(&args).await,
            "chat_mail_fetch" => {
                let busy = std::mem::replace(&mut i.lock().chats.mail_busy, true);
                if busy {
                    return Err("ящик уже проверяется".into());
                }
                Ok(i.mail_fetch().await)
            }
            _ => Err(format!("неизвестная команда {cmd}")),
        }
    }

    /// Быстрые команды, выполняемые сразу и по порядку (отправка сигналов звонка не должна
    /// перемешиваться). `None` — команда асинхронная, нужен `dispatch`.
    pub fn dispatch_sync(&self, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
        const ASYNC: [&str; 10] = [
            "room_stats",
            "room_status",
            "http_fetch",
            "diag_snapshot",
            "chat_send_file",
            "chat_send_blob",
            "chat_file_data",
            "chat_mail_fetch",
            "profile_export",
            "profile_import",
        ];
        if ASYNC.contains(&cmd) {
            return None;
        }
        let _rt = self.inner.rt.enter();
        Some(self.run_sync(cmd, args.clone()))
    }

    fn run_sync(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let i = &self.inner;
        match cmd {
            "app_info" => Ok(json!({
                "version": i.opts.app_version,
                "webVersion": i.opts.web_version,
                "platform": i.opts.platform,
                "protected": protect::ENABLED,
            })),
            "settings_get" => ok(i.lock().settings.clone()),
            "settings_set" => i.settings_set(&args),
            "link_parse" => {
                let t = s(&args, "text")?;
                let c = i.contact_parse(t);
                Ok(if c["kind"] == "contact" {
                    c
                } else {
                    link_parse(t)
                })
            }
            "links_list" => Ok(i.links_list()),
            "link_create" => i.link_create(&args),
            "link_save" => i.link_save(&args),
            "link_rename" => i.link_update(&args, |l, a| {
                if let Some(n) = a.get("name").and_then(|v| v.as_str()) {
                    l.name = n.trim().chars().take(60).collect();
                }
            }),
            "link_set_listen" => i.link_update(&args, |l, a| {
                if l.kind == "mine" {
                    l.listen = a.get("listen").and_then(|v| v.as_bool()).unwrap_or(true);
                }
            }),
            "link_rotate" => i.link_update(&args, |l, _| {
                if l.kind == "mine" {
                    l.secret = zv_proto::link::new_secret();
                }
            }),
            "link_touch" => i.link_update(&args, |l, _| l.last_used = now_ms()),
            "link_delete" => i.link_delete(&args),
            "room_join" => i.room_join(&args),
            "room_send" => i.room_send(&args),
            "room_leave" => i.room_leave(&args),
            "room_bye" => {
                if let Some(h) = args
                    .get("roomId")
                    .and_then(|v| v.as_str())
                    .and_then(|r| i.hub(r))
                {
                    h.bye();
                }
                Ok(Value::Null)
            }
            "rooms_leave_all" => {
                i.rooms_leave_all(args.get("bye").and_then(|v| v.as_bool()).unwrap_or(true))
            }
            "incoming_list" => ok(i.lock().incoming.values().cloned().collect::<Vec<_>>()),
            "call_answer" => i.call_answer(&args),
            "call_decline" => i.call_decline(&args),
            "history_list" => {
                let st = i.lock();
                let mut v = st.history.items.clone();
                v.reverse();
                ok(v)
            }
            "history_delete" => {
                let id = s(&args, "id")?.to_string();
                let mut st = i.lock();
                st.history.items.retain(|h| h.id != id);
                let _ = i.history_file.save(&st.history);
                drop(st);
                i.emit("history:changed", Value::Null);
                Ok(Value::Null)
            }
            "contacts_list" => Ok(i.contacts_list()),
            "contacts_presence" => i.contacts_presence(),
            "contact_invite" => i.contact_invite(&args),
            "contact_add" => i.contact_add(&args),
            "contact_offer" => i.contact_offer(&args),
            "contact_offers" => Ok(i.contact_offers()),
            "contact_offer_answer" => i.contact_offer_answer(&args),
            "contact_update" => i.contact_update(&args),
            "contact_delete" => i.contact_delete(&args),
            "contact_call" => i.contact_call(&args),
            "contact_call_state" => i.contact_call_state(&args),
            "group_create" => i.group_create(&args),
            "group_info" => i.group_info(&args),
            "group_rename" => i.group_rename(&args),
            "group_add" => i.group_add(&args),
            "group_remove" => i.group_remove(&args),
            "group_leave" => i.group_leave(&args),
            "group_delete" => i.group_delete(&args),
            "group_call" => i.group_call(&args),
            "group_call_join" => i.group_call_join(&args),
            // только для тестов (dev): сообщение комнаты «как будто пришло из канала»
            "room_inject" if i.opts.dev => {
                let rid = s(&args, "roomId")?.to_string();
                let msg = args.get("msg").cloned().ok_or("нет msg")?;
                i.clone().on_msg(&rid, msg);
                Ok(Value::Null)
            }
            "p2p_status" => Ok(i.p2p_status()),
            "chats_list" => Ok(i.chats_list()),
            "chat_history" => i.chat_history(&args),
            "chat_send" => i.chat_send(&args),
            "chat_edit" => i.chat_edit(&args),
            "chat_delete" => i.chat_delete(&args),
            "chat_read" => i.chat_read(&args),
            "chat_typing" => i.chat_typing(&args),
            "chat_focus" => i.chat_focus(&args),
            "chat_clear" => i.chat_clear(&args),
            "chat_file_accept" => i.chat_file_accept(&args),
            "chat_file_cancel" => i.chat_file_cancel(&args),
            "chat_status" => Ok(i.chat_status()),
            "chat_file_path" => i.chat_file_path(&args),
            "chat_unread" => {
                i.emit_unread();
                Ok(Value::Null)
            }
            "history_clear" => {
                let mut st = i.lock();
                st.history.items.clear();
                let _ = i.history_file.save(&st.history);
                drop(st);
                i.emit("history:changed", Value::Null);
                Ok(Value::Null)
            }
            _ => Err(format!("неизвестная команда {cmd}")),
        }
    }
}

fn link_parse(text: &str) -> Value {
    match zv_proto::parse_link(text) {
        Some(zv_proto::Link::Call { secret, d }) => json!({
            "kind": "call",
            "secret": secret,
            "d": d,
            "url": zv_proto::link::call_url(&secret),
        }),
        // веб-чат по ссылке — открывается в браузере (чаты приложения — с контактами)
        Some(zv_proto::Link::Chat(_)) => {
            let t = text.trim();
            let url =
                (t.starts_with("https://") || t.starts_with("http://")).then(|| t.to_string());
            json!({"kind": "chat", "url": url})
        }
        Some(zv_proto::Link::DeviceLink(_)) => json!({"kind": "link"}),
        None => json!({"kind": "none"}),
    }
}

async fn ticker(w: Weak<Inner>) {
    let mut t = tokio::time::interval(Duration::from_secs(1));
    loop {
        t.tick().await;
        let Some(inner) = w.upgrade() else { return };
        inner.tick();
    }
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, event: &str, payload: Value) {
        let _ = self.events.send(CoreEvent {
            event: event.to_string(),
            payload,
        });
    }

    fn hub(&self, room_id: &str) -> Option<RoomHub> {
        self.lock().rooms.get(room_id).map(|r| r.hub.clone())
    }

    fn worker_host(&self) -> Option<String> {
        let cfg = self.signal_config();
        cfg.worker_url
            .and_then(|u| url::Url::parse(&u).ok())
            .and_then(|u| u.host_str().map(str::to_string))
    }

    fn signal_config(&self) -> SignalConfig {
        let st = self.lock();
        let mut c = self.opts.signal.clone().unwrap_or_default();
        c.mqtt_tcp = c.mqtt_tcp && st.settings.mqtt_tcp;
        let w = st.settings.worker_url.trim();
        if !w.is_empty() {
            c.worker_url = Some(w.trim_end_matches('/').to_string());
        }
        c.user_agent = format!("ZVONochek-Desktop/{}", self.opts.app_version);
        c
    }

    /// `cfg` берётся заранее (`signal_config()` сам берёт блокировку состояния).
    fn spawn_hub(
        self: &Arc<Self>,
        room: zv_proto::Room,
        profile: Profile,
        cfg: Arc<SignalConfig>,
    ) -> RoomHub {
        let (tx, rx) = mpsc::unbounded_channel();
        let room_id = room.topic.clone();
        let hub = RoomHub::spawn(room, cfg, profile, tx);
        hub.set_extras(self.hub_extras());
        self.rt.spawn(pump(Arc::downgrade(self), room_id, rx));
        hub
    }

    // ---------- настройки ----------

    fn settings_set(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let patch = args.get("patch").unwrap_or(args);
        let mut st = self.lock();
        let mut cur = serde_json::to_value(&st.settings).map_err(|e| e.to_string())?;
        if let (Some(c), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                c.insert(k.clone(), v.clone());
            }
        }
        let mut new: Settings = serde_json::from_value(cur).map_err(|e| e.to_string())?;
        new.name = new.name.trim().chars().take(40).collect();
        let p2p_changed = new.p2p != st.settings.p2p;
        st.settings = new.clone();
        self.settings_file
            .save(&st.settings)
            .map_err(|e| e.to_string())?;
        drop(st);
        if let Some(n) = self.node() {
            n.set_name(&new.name);
        }
        if p2p_changed {
            if new.p2p {
                self.p2p_start();
            } else {
                self.p2p_stop();
            }
            self.sync_listeners();
        }
        self.emit(
            "settings:changed",
            serde_json::to_value(&new).unwrap_or_default(),
        );
        ok(new)
    }

    // ---------- ссылки ----------

    fn link_json(&self, l: &LinkEntry, st: &State) -> Value {
        let topic = zv_proto::Room::derive(&l.secret)
            .map(|r| r.topic)
            .unwrap_or_default();
        let room = st.rooms.get(&topic);
        json!({
            "id": l.id,
            "name": l.name,
            "kind": l.kind,
            "listen": l.listen,
            "created": l.created,
            "lastUsed": l.last_used,
            "secret": l.secret,
            "url": zv_proto::link::call_url(&l.secret),
            "appUrl": zv_proto::link::app_url(&l.secret),
            "roomId": topic,
            "status": room.and_then(|r| r.status.clone()),
            "inCall": room.map(|r| r.joined).unwrap_or(false),
        })
    }

    fn links_list(&self) -> Value {
        let st = self.lock();
        Value::Array(
            st.links
                .items
                .iter()
                .map(|l| self.link_json(l, &st))
                .collect(),
        )
    }

    fn save_links(&self, st: &State) -> Result<(), String> {
        self.links_file.save(&st.links).map_err(|e| e.to_string())
    }

    fn link_create(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(60)
            .collect::<String>();
        let listen = args.get("listen").and_then(|v| v.as_bool()).unwrap_or(true);
        let entry = LinkEntry {
            id: rand_hex(6),
            name: if name.is_empty() {
                "Моя ссылка".into()
            } else {
                name
            },
            secret: zv_proto::link::new_secret(),
            kind: "mine".into(),
            listen,
            created: now_ms(),
            last_used: 0,
        };
        let v = {
            let mut st = self.lock();
            st.links.items.push(entry.clone());
            self.save_links(&st)?;
            self.link_json(&entry, &st)
        };
        self.sync_listeners();
        self.emit("links:changed", Value::Null);
        Ok(v)
    }

    fn link_save(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let text = s(args, "secret").or_else(|_| s(args, "url"))?;
        let secret = zv_proto::parse_link(text)
            .and_then(|l| l.secret().map(str::to_string))
            .ok_or("это не ссылка звонка")?;
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(60)
            .collect::<String>();
        let v = {
            let mut st = self.lock();
            if let Some(l) = st.links.items.iter_mut().find(|l| l.secret == secret) {
                if !name.is_empty() {
                    l.name = name;
                }
                let l = l.clone();
                self.save_links(&st)?;
                self.link_json(&l, &st)
            } else {
                let entry = LinkEntry {
                    id: rand_hex(6),
                    name: if name.is_empty() {
                        "Ссылка".into()
                    } else {
                        name
                    },
                    secret,
                    kind: "saved".into(),
                    listen: false,
                    created: now_ms(),
                    last_used: now_ms(),
                };
                st.links.items.push(entry.clone());
                self.save_links(&st)?;
                self.link_json(&entry, &st)
            }
        };
        self.emit("links:changed", Value::Null);
        Ok(v)
    }

    fn link_update(
        self: &Arc<Self>,
        args: &Value,
        f: impl FnOnce(&mut LinkEntry, &Value),
    ) -> Result<Value, String> {
        let id = s(args, "id")?;
        let v = {
            let mut st = self.lock();
            let l = st
                .links
                .items
                .iter_mut()
                .find(|l| l.id == id)
                .ok_or("нет такой ссылки")?;
            f(l, args);
            let l = l.clone();
            self.save_links(&st)?;
            self.link_json(&l, &st)
        };
        self.sync_listeners();
        self.emit("links:changed", Value::Null);
        Ok(v)
    }

    fn link_delete(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let id = s(args, "id")?;
        {
            let mut st = self.lock();
            st.links.items.retain(|l| l.id != id);
            self.save_links(&st)?;
        }
        self.sync_listeners();
        self.emit("links:changed", Value::Null);
        Ok(Value::Null)
    }

    /// Поднять ожидание для своих ссылок с `listen` (и комнат ящика/приглашения), снять — для остальных.
    fn sync_listeners(self: &Arc<Self>) {
        let cfg = Arc::new(self.signal_config());
        let mut st = self.lock();
        let want: HashMap<String, String> = st
            .links
            .items
            .iter()
            .filter(|l| l.kind == "mine" && l.listen)
            .filter_map(|l| {
                zv_proto::Room::derive(&l.secret)
                    .ok()
                    .map(|r| (r.topic, l.id.clone()))
            })
            .collect();
        let special: HashMap<String, (zv_proto::Room, RoomRole)> = if self.node().is_some() {
            let mut rooms = self.contact_listen_rooms(&st);
            rooms.extend(self.group_listen_rooms(&st));
            rooms
                .into_iter()
                .filter_map(|(sec, role)| {
                    zv_proto::Room::derive(&sec)
                        .ok()
                        .map(|r| (r.topic.clone(), (r, role)))
                })
                .collect()
        } else {
            HashMap::new()
        };
        // снять лишние
        let mut remove = Vec::new();
        for (topic, r) in st.rooms.iter_mut() {
            match r.role {
                RoomRole::Call => {
                    if r.link_id.is_some() && !want.contains_key(topic) {
                        r.link_id = None;
                        if !r.joined {
                            r.hub.close();
                            remove.push(topic.clone());
                        }
                    }
                }
                RoomRole::Inbox | RoomRole::Invite | RoomRole::Group => {
                    if !special.contains_key(topic) {
                        r.hub.close();
                        remove.push(topic.clone());
                    }
                }
            }
        }
        for t in remove {
            st.rooms.remove(&t);
        }
        st.incoming.retain(|_, inc| {
            inc.contact_id.is_some() || inc.group_id.is_some() || want.contains_key(&inc.room_id)
        });
        // поднять недостающие
        for (topic, link_id) in want {
            if let Some(r) = st.rooms.get_mut(&topic) {
                r.link_id = Some(link_id);
                continue;
            }
            let secret = st
                .links
                .items
                .iter()
                .find(|l| l.id == link_id)
                .map(|l| l.secret.clone());
            let Some(room) = secret.and_then(|s| zv_proto::Room::derive(&s).ok()) else {
                continue;
            };
            let hub = self.spawn_hub(room.clone(), Profile::Listen, cfg.clone());
            st.rooms.insert(
                topic,
                RoomEntry {
                    hub,
                    room,
                    role: RoomRole::Call,
                    link_id: Some(link_id),
                    joined: false,
                    session: None,
                    answered: None,
                    status: None,
                },
            );
        }
        for (topic, (room, role)) in special {
            if st.rooms.contains_key(&topic) {
                continue;
            }
            let hub = self.spawn_hub(room.clone(), Profile::Listen, cfg.clone());
            st.rooms.insert(
                topic,
                RoomEntry {
                    hub,
                    room,
                    role,
                    link_id: None,
                    joined: false,
                    session: None,
                    answered: None,
                    status: None,
                },
            );
        }
    }

    // ---------- комнаты ----------

    fn room_join(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let self_id = s(args, "selfId")?.to_string();
        let inst = s(args, "inst")?.to_string();
        let want_topic = args
            .get("topic")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let mut secrets: Vec<String> = Vec::new();
        if let Some(sv) = args.get("secret").and_then(|v| v.as_str()) {
            secrets.push(sv.to_string());
        }
        if let Some(arr) = args.get("secrets").and_then(|v| v.as_array()) {
            secrets.extend(arr.iter().filter_map(|v| v.as_str().map(str::to_string)));
        }
        let room = secrets
            .iter()
            .filter_map(|s| zv_proto::Room::derive(s).ok())
            .find(|r| want_topic.as_ref().is_none_or(|t| *t == r.topic))
            .ok_or("не найден секрет комнаты")?;
        let room_id = room.topic.clone();
        let cfg = Arc::new(self.signal_config());
        let mut st = self.lock();
        let busy_other = st.rooms.iter().any(|(t, r)| r.joined && *t != room_id);
        let link_name = |st: &State, lid: &Option<String>| -> Option<String> {
            lid.as_ref().and_then(|id| {
                st.links
                    .items
                    .iter()
                    .find(|l| &l.id == id)
                    .map(|l| l.name.clone())
            })
        };
        let saved_name = st
            .links
            .items
            .iter()
            .find(|l| {
                zv_proto::Room::derive(&l.secret)
                    .map(|r| r.topic == room_id)
                    .unwrap_or(false)
            })
            .map(|l| (l.id.clone(), l.name.clone()));
        if st
            .rooms
            .get(&room_id)
            .is_some_and(|r| r.role != RoomRole::Call)
        {
            return Err("это служебная комната".into());
        }
        let entry = match st.rooms.remove(&room_id) {
            Some(e) => {
                e.hub.set_identity(&self_id, &inst);
                e.hub.set_profile(Profile::Full);
                e
            }
            None => {
                let hub = self.spawn_hub(room.clone(), Profile::Full, cfg);
                hub.set_identity(&self_id, &inst);
                RoomEntry {
                    hub,
                    room,
                    role: RoomRole::Call,
                    link_id: None,
                    joined: false,
                    session: None,
                    answered: None,
                    status: None,
                }
            }
        };
        let mut entry = entry;
        entry.joined = true;
        let answered = entry
            .answered
            .take()
            .or_else(|| st.p2p.c.pending_answer.remove(&room_id));
        let call = st.p2p.c.calls.get(&room_id).cloned();
        let contact_name = call.as_ref().and_then(|c| {
            st.contacts
                .items
                .iter()
                .find(|x| x.id == c.contact_id)
                .map(|x| x.name.clone())
        });
        // групповой звонок: свой вызов, ответ на вызов или вход из ленты группы
        let gcall = st.groups.calls.get_mut(&room_id).map(|c| {
            c.accepted = true;
            (c.gid.clone(), c.out, c.video)
        });
        let group = gcall.map(|(gid, out, video)| {
            let name = st
                .contacts
                .groups
                .iter()
                .find(|g| g.id == gid)
                .map(|g| g.name.clone())
                .unwrap_or_default();
            (gid, name, out, video)
        });
        let (dir, peer, lname) = match (&group, &answered, &call) {
            (Some((_, name, out, _)), _, _) => {
                (if *out { "out" } else { "in" }, name.clone(), None)
            }
            (None, Some(inc), _) => (
                "in",
                inc.name.clone(),
                (!inc.link_name.is_empty()).then(|| inc.link_name.clone()),
            ),
            (None, None, Some(c)) => (
                if c.out { "out" } else { "in" },
                contact_name.clone().unwrap_or_default(),
                None,
            ),
            (None, None, None) => (
                "out",
                String::new(),
                link_name(&st, &entry.link_id).or(saved_name.as_ref().map(|x| x.1.clone())),
            ),
        };
        entry.session = Some(Session {
            started: now_ms(),
            dir,
            peer,
            peer_inst: answered.as_ref().map(|a| a.inst.clone()),
            peer_seen: answered.is_some(),
            link_id: if call.is_some() || group.is_some() {
                None
            } else {
                entry.link_id.clone().or(saved_name.map(|x| x.0))
            },
            link_name: lname,
            contact_id: call.as_ref().map(|c| c.contact_id.clone()),
            peer_id: call.as_ref().map(|c| c.peer.clone()),
            video: group
                .as_ref()
                .map(|g| g.3)
                .or(call.as_ref().map(|c| c.video))
                .unwrap_or(false),
            group_id: group.as_ref().map(|g| g.0.clone()),
        });
        let bind_now = call.as_ref().is_some_and(|c| !c.out);
        let up = entry
            .status
            .as_ref()
            .map(|s| s.mqtt_up + s.nostr_up + s.ntfy_up > 0 || s.worker == "up")
            .unwrap_or(false);
        let status = entry.status.clone();
        // входящие по этой комнате больше не звонят
        let ended: Vec<Incoming> = st
            .incoming
            .values()
            .filter(|x| x.room_id == room_id)
            .cloned()
            .collect();
        for inc in &ended {
            st.incoming.remove(&inc.call_id);
        }
        st.rooms.insert(room_id.clone(), entry);
        drop(st);
        for inc in ended {
            self.emit(
                "call:ended",
                json!({"callId": inc.call_id, "reason": "answered"}),
            );
        }
        if bind_now {
            // ответили контакту — комната звонка сразу идёт по P2P
            self.bind_call(&room_id);
        }
        if up {
            // каналы уже подняты (ожидание по своей ссылке) — сразу сообщаем, чтобы веб отправил hello
            let me = self.clone();
            let rid = room_id.clone();
            self.rt.spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if let Some(st) = status {
                    me.emit("room:status", json!({"roomId": rid, "status": st}));
                }
                me.emit("room:up", json!({"roomId": rid}));
            });
        }
        Ok(json!({"roomId": room_id, "busyOther": busy_other}))
    }

    fn room_send(&self, args: &Value) -> Result<Value, String> {
        let room_id = s(args, "roomId")?;
        let msg = args.get("msg").cloned().ok_or("нет msg")?;
        if !msg.is_object() {
            return Err("msg — не объект".into());
        }
        let voice = args.get("voice").and_then(|v| v.as_bool()).unwrap_or(false);
        let hub = self.hub(room_id).ok_or("комната закрыта")?;
        let mid = hub.send(msg, SendOpts { voice });
        Ok(json!({"mid": mid}))
    }

    fn room_leave(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let room_id = s(args, "roomId")?.to_string();
        let mut st = self.lock();
        let Some(r) = st.rooms.get_mut(&room_id) else {
            return Ok(Value::Null);
        };
        if !r.joined {
            return Ok(Value::Null);
        }
        r.joined = false;
        let session = r.session.take();
        let listen = r.link_id.is_some();
        if listen {
            r.hub.set_identity(&rand_hex(8), &rand_hex(6));
            r.hub.set_profile(Profile::Listen);
        } else {
            // bye/последние сигналы уже в очереди каналов — даём им уйти
            let h = r.hub.clone();
            self.rt.spawn(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                h.close();
            });
            st.rooms.remove(&room_id);
        }
        drop(st);
        // P2P отвязываем чуть позже: `bye` веба ещё в очереди комнаты
        let me = self.clone();
        let rid = room_id.clone();
        self.rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(450)).await;
            if !me.joined(&rid) {
                me.p2p_room_closed(&rid);
            }
        });
        let contact = self.contact_call_left(&room_id);
        self.group_call_left(&room_id, session.as_ref().is_some_and(|s| s.peer_seen));
        let mut st = self.lock();
        if let Some(sess) = session {
            if let Some(pi) = &sess.peer_inst {
                st.suppressed.insert(pi.clone(), now_ms());
            }
            let mut result = match (sess.dir, sess.peer_seen) {
                ("in", _) => "answered",
                (_, true) => "outgoing",
                _ => "cancelled",
            };
            if let Some((r, _, _)) = &contact
                && !r.is_empty()
                && !sess.peer_seen
            {
                result = r;
            }
            let e = HistoryEntry {
                id: rand_hex(6),
                dir: sess.dir.into(),
                result: result.into(),
                peer: sess.peer,
                link_id: sess.link_id,
                link_name: sess.link_name,
                started: sess.started,
                duration: now_ms().saturating_sub(sess.started) / 1000,
                peer_seen: sess.peer_seen,
                contact_id: sess.contact_id.or(contact.as_ref().map(|c| c.1.clone())),
                peer_id: sess.peer_id,
                video: sess.video,
                group_id: sess.group_id,
            };
            self.push_history(&mut st, e);
        }
        drop(st);
        self.emit("history:changed", Value::Null);
        self.emit("links:changed", Value::Null);
        Ok(Value::Null)
    }

    /// Окно звонка закрыто: выйти из всех комнат звонка (с `bye`, если окно не успело).
    fn rooms_leave_all(self: &Arc<Self>, bye: bool) -> Result<Value, String> {
        let joined: Vec<(String, RoomHub)> = {
            let st = self.lock();
            st.rooms
                .iter()
                .filter(|(_, r)| r.joined)
                .map(|(t, r)| (t.clone(), r.hub.clone()))
                .collect()
        };
        for (room_id, hub) in joined {
            if bye {
                hub.bye();
            }
            self.room_leave(&json!({"roomId": room_id}))?;
        }
        Ok(Value::Null)
    }

    fn push_history(&self, st: &mut State, e: HistoryEntry) {
        st.history.items.push(e);
        if st.history.items.len() > HISTORY_MAX {
            let n = st.history.items.len() - HISTORY_MAX;
            st.history.items.drain(..n);
        }
        let _ = self.history_file.save(&st.history);
    }

    // ---------- входящие ----------

    fn on_msg(self: &Arc<Self>, room_id: &str, msg: Value) {
        let mut st = self.lock();
        let Some(r) = st.rooms.get_mut(room_id) else {
            return;
        };
        if r.role != RoomRole::Call {
            let group = r.role == RoomRole::Group;
            drop(st);
            if group {
                self.on_group_room(room_id, &msg);
            } else {
                self.on_zv4_room(room_id, &msg);
            }
            return;
        }
        let typ = msg
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let from = msg
            .get("from")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let inst = msg
            .get("inst")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = msg
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(60).collect::<String>());
        if r.joined {
            if let Some(sess) = r.session.as_mut()
                && !from.is_empty()
                && matches!(
                    typ.as_str(),
                    "hello" | "hi" | "desc" | "cand" | "g_hi" | "ack"
                )
            {
                sess.peer_seen = true;
                if sess.peer_inst.is_none() {
                    sess.peer_inst = Some(inst.clone());
                }
                if let Some(n) = &name
                    && sess.peer.is_empty()
                {
                    sess.peer = n.clone();
                }
            }
            // групповой звонок — сетка из нескольких участников: P2P к одному из них не подставляем
            let group_call = r.session.as_ref().is_some_and(|s| s.group_id.is_some());
            let zv = msg
                .get("zv")
                .filter(|_| !group_call && matches!(typ.as_str(), "hello" | "hi" | "g_hi"))
                .cloned();
            if let Some(zv) = &zv
                && let Some(sess) = r.session.as_mut()
                && sess.peer_id.is_none()
            {
                sess.peer_id = zv
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| zv_p2p::valid_id(s))
                    .map(str::to_string);
            }
            drop(st);
            if let Some(zv) = zv {
                self.p2p_consider(room_id, &zv, name.as_deref());
            }
            self.emit("room:msg", json!({"roomId": room_id, "msg": msg}));
            return;
        }
        let Some(link_id) = r.link_id.clone() else {
            return;
        };
        if inst.is_empty() || from.is_empty() {
            return;
        }
        let now = now_ms();
        if typ == "bye" {
            // звонящий вышел из комнаты: следующий его hello — новый звонок, а не хвост старого
            st.suppressed.remove(&inst);
            let id = st
                .incoming
                .values()
                .find(|x| x.room_id == room_id && x.inst == inst)
                .map(|x| x.call_id.clone());
            if let Some(id) = id {
                drop(st);
                self.end_incoming(&id, "missed");
            }
            return;
        }
        if !matches!(typ.as_str(), "hello" | "g_hi") {
            return;
        }
        if let Some(t) = st.suppressed.get_mut(&inst) {
            *t = now;
            return;
        }
        if let Some(x) = st.incoming.values_mut().find(|x| x.room_id == room_id) {
            if x.inst == inst {
                x.last_seen = now;
                if let Some(n) = name
                    && n != x.name
                {
                    x.name = n;
                    let v = serde_json::to_value(&*x).unwrap_or_default();
                    drop(st);
                    self.emit("call:update", v);
                }
            }
            return;
        }
        let link_name = st
            .links
            .items
            .iter()
            .find(|l| l.id == link_id)
            .map(|l| l.name.clone())
            .unwrap_or_default();
        let busy = st.rooms.values().any(|r| r.joined);
        let inc = Incoming {
            call_id: rand_hex(6),
            room_id: room_id.to_string(),
            link_id,
            link_name,
            from,
            inst: inst.clone(),
            name: name.unwrap_or_default(),
            started: now,
            last_seen: now,
            app: msg.get("app").and_then(|v| v.as_str()) == Some("zvd"),
            busy,
            contact_id: None,
            video: false,
            secret: None,
            group_id: None,
            group_name: None,
        };
        if st.settings.dnd {
            st.suppressed.insert(inst, now);
            let e = HistoryEntry {
                id: rand_hex(6),
                dir: "in".into(),
                result: "missed".into(),
                peer: inc.name.clone(),
                link_id: Some(inc.link_id.clone()),
                link_name: Some(inc.link_name.clone()),
                started: now,
                duration: 0,
                peer_seen: true,
                contact_id: None,
                peer_id: None,
                video: false,
                group_id: None,
            };
            self.push_history(&mut st, e);
            drop(st);
            self.emit("history:changed", Value::Null);
            return;
        }
        st.incoming.insert(inc.call_id.clone(), inc.clone());
        drop(st);
        self.emit(
            "call:incoming",
            serde_json::to_value(&inc).unwrap_or_default(),
        );
    }

    fn end_incoming(self: &Arc<Self>, call_id: &str, reason: &str) {
        let mut st = self.lock();
        let Some(inc) = st.incoming.remove(call_id) else {
            return;
        };
        let contact = inc.contact_id.is_some();
        let link = !contact && inc.group_id.is_none();
        if reason != "answered" {
            st.suppressed.insert(inc.inst.clone(), now_ms());
            let e = HistoryEntry {
                id: rand_hex(6),
                dir: "in".into(),
                result: reason.into(),
                peer: inc.group_name.clone().unwrap_or_else(|| inc.name.clone()),
                link_id: link.then(|| inc.link_id.clone()),
                link_name: link.then(|| inc.link_name.clone()),
                started: inc.started,
                duration: 0,
                peer_seen: true,
                contact_id: inc.contact_id.clone(),
                peer_id: contact.then(|| inc.from.clone()),
                video: inc.video,
                group_id: inc.group_id.clone(),
            };
            self.push_history(&mut st, e);
            if contact && let Some(c) = st.p2p.c.calls.get_mut(&inc.room_id) {
                c.ended = Some(if reason == "declined" {
                    "declined"
                } else {
                    "missed"
                });
                c.ended_at = now_ms();
            }
        }
        drop(st);
        if contact && reason == "declined" {
            self.ring_declined(&inc);
        }
        self.emit("call:ended", json!({"callId": call_id, "reason": reason}));
        self.emit("history:changed", Value::Null);
    }

    fn call_answer(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        let id = s(args, "callId")?;
        let mut st = self.lock();
        let inc = st.incoming.remove(id).ok_or("звонок уже завершён")?;
        let secret = match &inc.secret {
            Some(k) => k.clone(),
            None => st
                .links
                .items
                .iter()
                .find(|l| l.id == inc.link_id)
                .map(|l| l.secret.clone())
                .ok_or("ссылка удалена")?,
        };
        if let Some(r) = st.rooms.get_mut(&inc.room_id) {
            r.answered = Some(inc.clone());
        }
        if let Some(c) = st.groups.calls.get_mut(&inc.room_id) {
            c.accepted = true;
        }
        drop(st);
        if inc.contact_id.is_some() {
            self.ring_answered(&inc);
        }
        self.emit("call:ended", json!({"callId": id, "reason": "answered"}));
        Ok(json!({
            "secret": secret,
            "roomId": inc.room_id,
            "name": inc.name,
            "linkName": inc.link_name,
            "contactId": inc.contact_id,
            "video": inc.video,
            "groupId": inc.group_id,
            "groupName": inc.group_name,
        }))
    }

    fn call_decline(self: &Arc<Self>, args: &Value) -> Result<Value, String> {
        self.end_incoming(s(args, "callId")?, "declined");
        Ok(Value::Null)
    }

    fn tick(self: &Arc<Self>) {
        let now = now_ms();
        self.p2p_tick(now);
        self.contacts_tick(now);
        self.chats_tick(now);
        self.groups_tick(now);
        let expired: Vec<String> = {
            let mut st = self.lock();
            st.suppressed
                .retain(|_, t| now.saturating_sub(*t) < SUPPRESS_MS);
            st.incoming
                .values()
                .filter(|x| {
                    now.saturating_sub(x.last_seen) > RING_SILENCE_MS
                        || now.saturating_sub(x.started) > RING_MAX_MS
                })
                .map(|x| x.call_id.clone())
                .collect()
        };
        for id in expired {
            self.end_incoming(&id, "missed");
        }
    }

    fn on_status(&self, room_id: &str, status: HubStatus) {
        let mut st = self.lock();
        if let Some(r) = st.rooms.get_mut(room_id) {
            r.status = Some(status.clone());
        }
        drop(st);
        self.emit("room:status", json!({"roomId": room_id, "status": status}));
    }

    fn joined(&self, room_id: &str) -> bool {
        self.lock()
            .rooms
            .get(room_id)
            .map(|r| r.joined)
            .unwrap_or(false)
    }

    async fn diag(&self) -> Value {
        let rooms: Vec<(String, RoomHub, bool, Option<String>)> = {
            let st = self.lock();
            st.rooms
                .iter()
                .map(|(t, r)| {
                    let ln = r.link_id.as_ref().and_then(|id| {
                        st.links
                            .items
                            .iter()
                            .find(|l| &l.id == id)
                            .map(|l| l.name.clone())
                    });
                    (t.clone(), r.hub.clone(), r.joined, ln)
                })
                .collect()
        };
        let mut out = Vec::new();
        for (topic, hub, joined, link) in rooms {
            let channels = hub.channels().await;
            let status = hub.status().await;
            let stats = hub.delivery_stats().await;
            out.push(json!({
                "room": &topic[..8.min(topic.len())],
                "joined": joined,
                "link": link,
                "status": status,
                "delivery": stats,
                "channels": channels,
            }));
        }
        json!({"rooms": out, "time": now_ms(), "version": self.opts.app_version, "p2p": self.p2p_status()})
    }
}

async fn pump(w: Weak<Inner>, room_id: String, mut rx: mpsc::UnboundedReceiver<HubEvent>) {
    while let Some(ev) = rx.recv().await {
        let Some(inner) = w.upgrade() else { return };
        match ev {
            HubEvent::Message { msg, .. } => inner.on_msg(&room_id, msg),
            HubEvent::Status(st) => inner.on_status(&room_id, st),
            HubEvent::TransportUp => {
                if inner.joined(&room_id) {
                    inner.emit("room:up", json!({"roomId": room_id}));
                }
            }
            HubEvent::PeerJoined => {
                if inner.joined(&room_id) {
                    inner.emit("room:peer_joined", json!({"roomId": room_id}));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(dir: &std::path::Path) -> CoreOptions {
        let mut sig = SignalConfig::default();
        sig.brokers.clear();
        sig.nostr_relays.clear();
        sig.worker_url = None;
        sig.ntfy_base = None;
        CoreOptions {
            data_dir: dir.to_path_buf(),
            app_version: "test".into(),
            web_version: 40,
            platform: "test".into(),
            dev: true,
            signal: Some(sig),
            p2p_n0: false,
            downloads_dir: None,
        }
    }

    #[tokio::test]
    async fn links_and_settings_persist() {
        let d = tempfile::tempdir().unwrap();
        let core = Core::start(opts(d.path())).unwrap();
        let l = core
            .dispatch("link_create", json!({"name": "Мама"}))
            .await
            .unwrap();
        assert_eq!(l["name"], "Мама");
        assert!(l["url"].as_str().unwrap().contains("#k="));
        core.dispatch("settings_set", json!({"patch": {"name": "  Аня  "}}))
            .await
            .unwrap();
        drop(core);
        let core2 = Core::start(opts(d.path())).unwrap();
        let list = core2.dispatch("links_list", Value::Null).await.unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(core2.settings().name, "Аня");
        let p = core2
            .dispatch("link_parse", json!({"text": l["url"]}))
            .await
            .unwrap();
        assert_eq!(p["kind"], "call");
    }

    #[tokio::test]
    async fn join_send_leave() {
        let d = tempfile::tempdir().unwrap();
        let core = Core::start(opts(d.path())).unwrap();
        let secret = zv_proto::link::new_secret();
        let r = core
            .dispatch(
                "room_join",
                json!({"secrets": [secret], "selfId": "a1", "inst": "b1"}),
            )
            .await
            .unwrap();
        let rid = r["roomId"].as_str().unwrap().to_string();
        core.dispatch(
            "room_send",
            json!({"roomId": rid, "msg": {"type": "hello"}}),
        )
        .await
        .unwrap();
        core.dispatch("room_leave", json!({"roomId": rid}))
            .await
            .unwrap();
        let h = core.dispatch("history_list", Value::Null).await.unwrap();
        assert_eq!(h[0]["result"], "cancelled");
    }
}
