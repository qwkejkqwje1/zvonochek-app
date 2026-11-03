//! Данные профиля: настройки, ссылки, журнал звонков.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Имя в звонках (как `zvName` веба).
    pub name: String,
    /// Не беспокоить: входящие по ссылкам не звонят, только «пропущенный».
    pub dnd: bool,
    /// Тема: auto · light · dark.
    pub theme: String,
    /// Громкость мелодии, 0–100.
    pub ring_volume: u8,
    /// Закрытие окна сворачивает в трей.
    pub close_to_tray: bool,
    /// Первый запуск пройден (вопрос про автозапуск задан).
    pub onboarded: bool,
    /// MQTT по TCP 1883 параллельно с WSS.
    pub mqtt_tcp: bool,
    /// Свой адрес Worker (пусто — как у веба).
    pub worker_url: String,
    /// Входить в звонок сразу, без экрана проверки устройств веб-клиента.
    pub skip_prejoin: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            name: String::new(),
            dnd: false,
            theme: "auto".into(),
            ring_volume: 80,
            close_to_tray: true,
            onboarded: false,
            mqtt_tcp: true,
            worker_url: String::new(),
            skip_prejoin: true,
        }
    }
}

/// Ссылка: своя («Мои ссылки» — приложение ждёт по ней звонка) или сохранённая чужая.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEntry {
    pub id: String,
    pub name: String,
    pub secret: String,
    /// mine · saved
    pub kind: String,
    /// Ждать входящих по ссылке (только для своих).
    #[serde(default)]
    pub listen: bool,
    pub created: u64,
    #[serde(default)]
    pub last_used: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Links {
    pub items: Vec<LinkEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    /// in · out
    pub dir: String,
    /// answered · missed · declined · outgoing
    pub result: String,
    pub peer: String,
    #[serde(default)]
    pub link_id: Option<String>,
    #[serde(default)]
    pub link_name: Option<String>,
    pub started: u64,
    /// Длительность сессии в комнате, с.
    #[serde(default)]
    pub duration: u64,
    /// Был ли собеседник (пришли его сообщения).
    #[serde(default)]
    pub peer_seen: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct History {
    pub items: Vec<HistoryEntry>,
}

pub const HISTORY_MAX: usize = 500;
