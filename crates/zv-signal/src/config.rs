//! Настройки каналов (по умолчанию — как CONFIG веба v39).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrokerSpec {
    /// WSS-адрес, как у веба.
    pub wss: String,
    /// TCP-адрес `host:port` того же брокера (только приложение).
    pub tcp: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl BrokerSpec {
    pub fn host(&self) -> String {
        url::Url::parse(&self.wss)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| self.wss.clone())
    }
}

/// Режим комнаты.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    /// Звонок: все каналы, как в вебе.
    Full,
    /// Ожидание звонка по «моей ссылке» в трее: экономный набор каналов.
    Listen,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalConfig {
    pub brokers: Vec<BrokerSpec>,
    pub worker_url: Option<String>,
    pub nostr_relays: Vec<String>,
    pub ntfy_base: Option<String>,
    /// Пробовать MQTT по TCP 1883 параллельно с WSS (кто первый — тот и работает).
    pub mqtt_tcp: bool,
    /// Сколько MQTT-брокеров и Nostr-реле держать в режиме ожидания.
    pub listen_mqtt: usize,
    pub listen_nostr: usize,
    pub user_agent: String,
}

fn b(wss: &str, tcp: &str) -> BrokerSpec {
    BrokerSpec { wss: wss.into(), tcp: Some(tcp.into()), username: None, password: None }
}

impl Default for SignalConfig {
    fn default() -> Self {
        SignalConfig {
            brokers: vec![
                BrokerSpec {
                    wss: "wss://public.cloud.shiftr.io".into(),
                    tcp: Some("public.cloud.shiftr.io:1883".into()),
                    username: Some("public".into()),
                    password: Some("public".into()),
                },
                b("wss://broker.emqx.io:8084/mqtt", "broker.emqx.io:1883"),
                b("wss://broker.hivemq.com:8884/mqtt", "broker.hivemq.com:1883"),
                b("wss://test.mosquitto.org:8081/mqtt", "test.mosquitto.org:1883"),
                b("wss://mqtt.eclipseprojects.io/mqtt", "mqtt.eclipseprojects.io:1883"),
            ],
            worker_url: Some("https://zvonochek.zerewgwe.workers.dev".into()),
            nostr_relays: [
                "wss://relay.damus.io",
                "wss://nos.lol",
                "wss://relay.primal.net",
                "wss://nostr.mom",
                "wss://offchain.pub",
                "wss://relay.snort.social",
                "wss://relay.nostr.band",
                "wss://nostr-pub.wellorder.net",
                "wss://relay.nostr.info",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            ntfy_base: Some("https://ntfy.sh".into()),
            mqtt_tcp: true,
            listen_mqtt: 2,
            listen_nostr: 2,
            user_agent: format!("ZVONochek-Desktop/{}", env!("CARGO_PKG_VERSION")),
        }
    }
}
