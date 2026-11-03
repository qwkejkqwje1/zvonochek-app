//! Два ядра в одном процессе, только P2P (без MQTT/Worker/Nostr/ntfy и без n0):
//! код приглашения → контакт у обоих → звонок контакту → ответ → комната звонка идёт по P2P →
//! журнал; отклонение; «не беспокоить».

use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::broadcast;
use zv_core::{Core, CoreEvent, CoreOptions};

fn opts(dir: &std::path::Path) -> CoreOptions {
    let mut sig = zv_signal::SignalConfig::default();
    sig.brokers.clear();
    sig.nostr_relays.clear();
    sig.worker_url = None;
    sig.ntfy_base = None;
    CoreOptions {
        data_dir: dir.to_path_buf(),
        app_version: "4.0.0-test".into(),
        web_version: 40,
        platform: "test".into(),
        dev: true,
        signal: Some(sig),
        p2p_n0: false,
        downloads_dir: None,
    }
}

async fn start(dir: &std::path::Path, name: &str) -> (Core, broadcast::Receiver<CoreEvent>) {
    let core = Core::start(opts(dir)).unwrap();
    let rx = core.subscribe();
    core.dispatch("settings_set", json!({"patch": {"name": name}}))
        .await
        .unwrap();
    for _ in 0..100 {
        if core.device_id().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(core.device_id().is_some(), "P2P не запустился");
    (core, rx)
}

async fn wait_event(rx: &mut broadcast::Receiver<CoreEvent>, name: &str, secs: u64) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Ok(ev)) if ev.event == name => return ev.payload,
            Ok(Ok(_)) => continue,
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            other => panic!("нет события {name}: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invite_call_p2p_history() {
    let da = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let (a, mut arx) = start(da.path(), "Аня").await;
    let (b, mut brx) = start(db.path(), "Борис").await;

    // приглашение A → B
    eprintln!("[шаг] приглашение A → B");
    let inv = a.dispatch("contact_invite", json!({})).await.unwrap();
    let code = inv["code"].as_str().unwrap().to_string();
    assert!(code.starts_with("zv4c:"));
    let parsed = b
        .dispatch("link_parse", json!({"text": code}))
        .await
        .unwrap();
    assert_eq!(parsed["kind"], "contact");
    assert_eq!(parsed["name"], "Аня");
    let r = b
        .dispatch("contact_add", json!({"code": code}))
        .await
        .unwrap();
    assert_eq!(r["pending"], true);
    let added_b = wait_event(&mut brx, "contact:added", 15).await;
    assert_eq!(added_b["name"], "Аня");
    let added_a = wait_event(&mut arx, "contact:added", 5).await;
    assert_eq!(added_a["name"], "Борис");
    let lb = b.dispatch("contacts_list", Value::Null).await.unwrap();
    let la = a.dispatch("contacts_list", Value::Null).await.unwrap();
    assert_eq!(lb.as_array().unwrap().len(), 1);
    assert_eq!(la.as_array().unwrap().len(), 1);
    // код безопасности одинаков у обоих
    eprintln!("[шаг] код безопасности одинаков у обоих");
    assert_eq!(lb[0]["safety"], la[0]["safety"]);
    assert_eq!(lb[0]["peer"].as_str(), a.device_id().as_deref());
    // повторное добавление — ошибка
    eprintln!("[шаг] повторное добавление — ошибка");
    assert!(
        b.dispatch("contact_add", json!({"code": code}))
            .await
            .is_err()
    );

    // звонок B → A
    eprintln!("[шаг] звонок B → A");
    let cb = lb[0]["id"].as_str().unwrap().to_string();
    let call = b
        .dispatch("contact_call", json!({"id": cb, "video": true}))
        .await
        .unwrap();
    let secret = call["secret"].as_str().unwrap().to_string();
    let room_b = b
        .dispatch(
            "room_join",
            json!({"secret": secret, "selfId": "bbbb0001", "inst": "bi01"}),
        )
        .await
        .unwrap();
    let inc = wait_event(&mut arx, "call:incoming", 10).await;
    assert_eq!(inc["name"], "Борис");
    assert_eq!(inc["video"], true);
    assert!(inc["contactId"].is_string());
    wait_event(&mut brx, "ring:ringing", 5).await;
    let ans = a
        .dispatch("call_answer", json!({"callId": inc["callId"]}))
        .await
        .unwrap();
    assert_eq!(ans["secret"].as_str(), Some(secret.as_str()));
    let room_a = a
        .dispatch(
            "room_join",
            json!({"secret": secret, "selfId": "aaaa0001", "inst": "ai01"}),
        )
        .await
        .unwrap();
    assert_eq!(room_a["roomId"], room_b["roomId"]);
    wait_event(&mut brx, "ring:accepted", 5).await;
    // сигналы звонка идут по P2P (других каналов нет)
    eprintln!("[шаг] сигналы звонка идут по P2P (других каналов нет)");
    let rid = room_b["roomId"].as_str().unwrap().to_string();
    let mut got = None;
    for _ in 0..40 {
        b.dispatch(
            "room_send",
            json!({"roomId": rid, "msg": {"type": "hello", "name": "Борис"}}),
        )
        .await
        .unwrap();
        let t0 = tokio::time::Instant::now();
        while t0.elapsed() < Duration::from_millis(250) {
            if let Ok(Ok(ev)) = tokio::time::timeout(Duration::from_millis(50), arx.recv()).await
                && ev.event == "room:msg"
            {
                got = Some(ev.payload);
                break;
            }
        }
        if got.is_some() {
            break;
        }
    }
    let got = got.expect("hello не дошёл по P2P");
    assert_eq!(got["msg"]["via"], "p2p");
    assert_eq!(got["msg"]["zv"]["id"].as_str(), b.device_id().as_deref());
    // голос моста — датаграммой
    eprintln!("[шаг] голос моста — датаграммой");
    b.dispatch(
        "room_send",
        json!({"roomId": rid, "msg": {"type": "voice", "d": "AAAA"}, "voice": true}),
    )
    .await
    .unwrap();
    let v = loop {
        let ev = wait_event(&mut arx, "room:msg", 5).await;
        if ev["msg"]["type"] == "voice" {
            break ev;
        }
    };
    assert_eq!(v["msg"]["via"], "p2p");
    let diag = a.dispatch("diag_snapshot", Value::Null).await.unwrap();
    assert_eq!(diag["p2p"]["running"], true);
    a.dispatch("room_leave", json!({"roomId": rid}))
        .await
        .unwrap();
    b.dispatch("room_leave", json!({"roomId": rid}))
        .await
        .unwrap();
    let ha = a.dispatch("history_list", Value::Null).await.unwrap();
    let hb = b.dispatch("history_list", Value::Null).await.unwrap();
    assert_eq!(ha[0]["dir"], "in");
    assert_eq!(ha[0]["result"], "answered");
    assert!(ha[0]["contactId"].is_string());
    assert_eq!(hb[0]["dir"], "out");
    assert_eq!(hb[0]["result"], "outgoing");
    assert_eq!(hb[0]["video"], true);

    // отклонение: A → B
    eprintln!("[шаг] отклонение: A → B");
    let ca = la[0]["id"].as_str().unwrap().to_string();
    let call2 = a.dispatch("contact_call", json!({"id": ca})).await.unwrap();
    a.dispatch(
        "room_join",
        json!({"secret": call2["secret"], "selfId": "aaaa0002", "inst": "ai02"}),
    )
    .await
    .unwrap();
    let inc2 = wait_event(&mut brx, "call:incoming", 10).await;
    assert_eq!(inc2["name"], "Аня");
    b.dispatch("call_decline", json!({"callId": inc2["callId"]}))
        .await
        .unwrap();
    let end = wait_event(&mut arx, "ring:ended", 5).await;
    assert_eq!(end["reason"], "declined");
    a.dispatch("room_leave", json!({"roomId": call2["roomId"]}))
        .await
        .unwrap();
    let ha = a.dispatch("history_list", Value::Null).await.unwrap();
    assert_eq!(ha[0]["result"], "declined");
    let hb = b.dispatch("history_list", Value::Null).await.unwrap();
    assert_eq!(hb[0]["result"], "declined");

    // «не беспокоить» у B: звонок сразу отклоняется с причиной dnd
    eprintln!("[шаг] «не беспокоить» у B: звонок сразу отклоняется с причиной dnd");
    b.dispatch("settings_set", json!({"patch": {"dnd": true}}))
        .await
        .unwrap();
    let call3 = a.dispatch("contact_call", json!({"id": ca})).await.unwrap();
    a.dispatch(
        "room_join",
        json!({"secret": call3["secret"], "selfId": "aaaa0003", "inst": "ai03"}),
    )
    .await
    .unwrap();
    let end = wait_event(&mut arx, "ring:ended", 10).await;
    assert_eq!(end["reason"], "dnd");
    a.dispatch("room_leave", json!({"roomId": call3["roomId"]}))
        .await
        .unwrap();
    let hb = b.dispatch("history_list", Value::Null).await.unwrap();
    assert_eq!(hb[0]["result"], "missed");

    // в сети
    eprintln!("[шаг] в сети");
    let p = a.dispatch("contacts_presence", Value::Null).await.unwrap();
    assert!(p.is_array());

    // P2P выключили и снова включили — тот же ID, звонок контакту снова доступен
    let id_a = a.device_id();
    a.dispatch("settings_set", json!({"patch": {"p2p": false}}))
        .await
        .unwrap();
    assert_eq!(
        a.dispatch("p2p_status", Value::Null).await.unwrap()["running"],
        false
    );
    assert!(a.dispatch("contact_call", json!({"id": ca})).await.is_err());
    a.dispatch("settings_set", json!({"patch": {"p2p": true}}))
        .await
        .unwrap();
    wait_event(&mut arx, "p2p:ready", 10).await;
    assert_eq!(a.device_id(), id_a);
    assert!(a.dispatch("contact_call", json!({"id": ca})).await.is_ok());
    a.shutdown().await;
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn offer_after_call() {
    let da = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let (a, mut arx) = start(da.path(), "Аня").await;
    let (b, mut brx) = start(db.path(), "Борис").await;
    // звонок по обычной ссылке между приложениями: P2P поднимется из `zv` в hello — здесь без каналов,
    eprintln!(
        "[шаг] звонок по обычной ссылке между приложениями: P2P поднимется из `zv` в hello — здесь без каналов,"
    );
    // поэтому имитируем: B «видел» A в звонке (hello с zv дошёл бы через MQTT/Worker).
    eprintln!(
        "[шаг] поэтому имитируем: B «видел» A в звонке (hello с zv дошёл бы через MQTT/Worker)."
    );
    let link = a
        .dispatch("link_create", json!({"name": "Тест"}))
        .await
        .unwrap();
    let secret = link["secret"].as_str().unwrap().to_string();
    let rb = b
        .dispatch(
            "room_join",
            json!({"secret": secret, "selfId": "bbbb0009", "inst": "bi09"}),
        )
        .await
        .unwrap();
    let rid = rb["roomId"].as_str().unwrap().to_string();
    // A отвечает «вручную»: входит в комнату и знакомится через P2P (подставляем zv в сообщение B напрямую)
    eprintln!(
        "[шаг] A отвечает «вручную»: входит в комнату и знакомится через P2P (подставляем zv в сообщение B напрямую)"
    );
    let ra = a
        .dispatch(
            "room_join",
            json!({"secret": secret, "selfId": "aaaa0009", "inst": "ai09"}),
        )
        .await
        .unwrap();
    assert_eq!(ra["roomId"], rid);
    // `zv` в hello — адрес узла (id + relay + прямые адреса), как его кладёт hub_extras()
    eprintln!(
        "[шаг] `zv` в hello — адрес узла (id + relay + прямые адреса), как его кладёт hub_extras()"
    );
    let zv_a = a.dispatch("p2p_status", Value::Null).await.unwrap()["addr"].clone();
    assert_eq!(zv_a["id"].as_str(), a.device_id().as_deref());
    // B получает hello от A с zv (тестовая команда ядра room_inject) → p2p_consider
    eprintln!(
        "[шаг] B получает hello от A с zv (тестовая команда ядра room_inject) → p2p_consider"
    );
    let hello =
        json!({"type": "hello", "from": "aaaa0009", "inst": "ai09", "name": "Аня", "zv": zv_a});
    b.dispatch("room_inject", json!({"roomId": rid, "msg": hello}))
        .await
        .unwrap();
    let t0 = std::time::Instant::now();
    loop {
        let st = b.dispatch("p2p_status", Value::Null).await.unwrap();
        if st["bound"]
            .as_array()
            .is_some_and(|v| v.iter().any(|l| !l["rooms"].as_array().unwrap().is_empty()))
        {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "комната не привязалась: {st}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    b.dispatch("room_leave", json!({"roomId": rid}))
        .await
        .unwrap();
    a.dispatch("room_leave", json!({"roomId": rid}))
        .await
        .unwrap();
    let hb = b.dispatch("history_list", Value::Null).await.unwrap();
    let peer_id = hb[0]["peerId"]
        .as_str()
        .expect("в журнале нет peerId")
        .to_string();
    assert_eq!(Some(peer_id.clone()), a.device_id());
    // B предлагает обменяться контактами, A принимает
    eprintln!("[шаг] B предлагает обменяться контактами, A принимает");
    b.dispatch(
        "contact_offer",
        json!({"peerId": peer_id, "name": "Аня из звонка"}),
    )
    .await
    .unwrap();
    let offer = wait_event(&mut arx, "contact:offer", 10).await;
    assert_eq!(offer["name"], "Борис");
    a.dispatch(
        "contact_offer_answer",
        json!({"offerId": offer["id"], "accept": true}),
    )
    .await
    .unwrap();
    let added = wait_event(&mut brx, "contact:added", 10).await;
    assert_eq!(added["name"], "Аня из звонка");
    let la = a.dispatch("contacts_list", Value::Null).await.unwrap();
    assert_eq!(la[0]["name"], "Борис");
    a.shutdown().await;
    b.shutdown().await;
}
