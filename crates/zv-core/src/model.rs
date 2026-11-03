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
    /// Подсказка «работаю в трее» уже показана.
    pub tray_hint_shown: bool,
    /// Прямое соединение между приложениями (iroh): контакты, звонки контактам, P2P-канал в звонке.
    pub p2p: bool,
    /// Сообщать контакту, что его сообщения прочитаны.
    pub read_receipts: bool,
    /// Картинки до 25 МБ от контактов скачивать сразу.
    pub auto_images: bool,
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
            tray_hint_shown: false,
            p2p: true,
            read_receipts: true,
            auto_images: true,
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
    /// Звонок контакту / от контакта.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<String>,
    /// ID устройства собеседника-приложения (для «Сохранить в контакты»).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
    /// Видеозвонок контакту.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub video: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct History {
    pub items: Vec<HistoryEntry>,
}

pub const HISTORY_MAX: usize = 500;

/// Личность устройства: мастер-сид (32 байта, hex). Из него выводится ключ iroh (EndpointId).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Identity {
    pub seed: String,
    pub created: u64,
}

/// Контакт — устройство собеседника-приложения.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: String,
    /// Как назвал пользователь.
    pub name: String,
    /// EndpointId устройства (hex).
    pub peer: String,
    /// Как собеседник назвался сам.
    #[serde(default)]
    pub their_name: String,
    /// Секрет его «ящика» — комнаты, куда пишем, если P2P не нашёлся.
    pub inbox: String,
    #[serde(default)]
    pub verified: bool,
    pub created: u64,
    #[serde(default)]
    pub last_seen: u64,
    /// Последние известные адреса `{r, a}`.
    #[serde(default)]
    pub hint: Option<serde_json::Value>,
}

/// Код приглашения: действует до `expires`, «Новый код» отзывает старый.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub secret: String,
    pub created: u64,
    pub expires: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Contacts {
    pub items: Vec<Contact>,
    /// Секрет моего ящика.
    pub inbox: String,
    pub invite: Option<Invite>,
}

pub const INVITE_TTL_MS: u64 = 7 * 24 * 3600 * 1000;
