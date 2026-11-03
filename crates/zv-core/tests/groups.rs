//! Группы трёх ядер: создание и приглашение, сообщения (в том числе между участниками, которые
//! не контакты друг другу), «доставлено всем», правка, почтовый ящик группы для того, кто не в
//! сети, файл от участника-«не контакта», групповой звонок (вызов, ответ, вход из ленты, история),
//! исключение участника со сменой ключа и выход из группы.

use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::broadcast;
use zv_core::{Core, CoreEvent, CoreOptions};

fn opts(dir: &std::path::Path, worker: &str) -> CoreOptions {
    let mut sig = zv_signal::SignalConfig::default();
    sig.brokers.clear();
    sig.nostr_relays.clear();
    sig.worker_url = Some(worker.to_string());
    sig.ntfy_base = None;
    CoreOptions {
        data_dir: dir.to_path_buf(),
        app_version: "4.0.0-test".into(),
        web_version: 40,
        platform: "test".into(),
        dev: true,
        signal: Some(sig),
        p2p_n0: false,
        downloads_dir: Some(dir.join("Downloads")),
    }
}

async fn start(
    dir: &std::path::Path,
    name: &str,
    worker: &str,
) -> (Core, broadcast::Receiver<CoreEvent>) {
    let core = Core::start(opts(dir, worker)).unwrap();
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

async fn wait_for(
    rx: &mut broadcast::Receiver<CoreEvent>,
    name: &str,
    secs: u64,
    pred: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Ok(ev)) if ev.event == name && pred(&ev.payload) => return ev.payload,
            Ok(Ok(_)) => continue,
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            other => panic!("нет события {name}: {other:?}"),
        }
    }
}

fn step(s: &str) {
    eprintln!("[шаг] {s}");
}

/// Контакт по коду: возвращает id контакта у `a`.
async fn befriend(
    a: &Core,
    arx: &mut broadcast::Receiver<CoreEvent>,
    b: &Core,
    brx: &mut broadcast::Receiver<CoreEvent>,
) -> String {
    let inv = a.dispatch("contact_invite", json!({})).await.unwrap();
    b.dispatch("contact_add", json!({"code": inv["code"]}))
        .await
        .unwrap();
    wait_for(brx, "contact:added", 15, |_| true).await;
    wait_for(arx, "contact:added", 5, |_| true).await;
    let peer = b.device_id().unwrap();
    let l = a.dispatch("contacts_list", Value::Null).await.unwrap();
    l.as_array()
        .unwrap()
        .iter()
        .find(|c| c["peer"] == peer.as_str())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn row(list: &Value, chat: &str) -> Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|r| r["chat"] == chat)
        .cloned()
        .unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn groups_three_cores() {
    let mock = zv_signal::mock::MockWorker::spawn().await;
    let da = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let dc = tempfile::tempdir().unwrap();
    let (a, mut arx) = start(da.path(), "Аня", &mock.url).await;
    let (b, mut brx) = start(db.path(), "Борис", &mock.url).await;
    let (c, mut crx) = start(dc.path(), "Вера", &mock.url).await;
    let (b_id, c_id) = (b.device_id().unwrap(), c.device_id().unwrap());

    step("Аня — контакт Бориса и Веры; Борис и Вера друг другу не контакты");
    let ab = befriend(&a, &mut arx, &b, &mut brx).await;
    let ac = befriend(&a, &mut arx, &c, &mut crx).await;

    step("создание группы → приглашение участникам");
    assert!(
        a.dispatch("group_create", json!({"name": "  ", "members": [ab]}))
            .await
            .is_err()
    );
    let g = a
        .dispatch(
            "group_create",
            json!({"name": "Семья", "members": [ab, ac]}),
        )
        .await
        .unwrap();
    let gid = g["chat"].as_str().unwrap().to_string();
    assert!(gid.starts_with('g'));
    let jb = wait_for(&mut brx, "group:joined", 20, |p| p["chat"] == gid.as_str()).await;
    assert_eq!(jb["name"], "Семья");
    assert_eq!(jb["by"], "Аня");
    wait_for(&mut crx, "group:joined", 20, |p| p["chat"] == gid.as_str()).await;
    let info = b
        .dispatch("group_info", json!({"chat": gid}))
        .await
        .unwrap();
    assert_eq!(info["members"].as_array().unwrap().len(), 3, "{info}");
    assert_eq!(info["admin"], false);
    let lb = b.dispatch("chats_list", Value::Null).await.unwrap();
    let r = row(&lb, &gid);
    assert_eq!(r["group"], true, "{lb}");
    assert_eq!(r["name"], "Семья");
    // только администратор меняет состав
    assert!(
        b.dispatch("group_rename", json!({"chat": gid, "name": "Моя"}))
            .await
            .is_err()
    );

    step("сообщение Ани → всем → «доставлено» всем");
    let m = a
        .dispatch("chat_send", json!({"chat": gid, "text": "Всем привет!"}))
        .await
        .unwrap();
    let mid = m["id"].as_str().unwrap().to_string();
    let gb = wait_for(&mut brx, "chat:msg", 20, |p| {
        p["new"] == true && p["msg"]["body"] == "Всем привет!"
    })
    .await;
    assert_eq!(gb["msg"]["chat"], gid.as_str());
    assert_eq!(gb["msg"]["senderName"], "Аня");
    assert_eq!(gb["msg"]["out"], false);
    wait_for(&mut crx, "chat:msg", 20, |p| {
        p["new"] == true && p["msg"]["body"] == "Всем привет!"
    })
    .await;
    let st = wait_for(&mut arx, "chat:state", 20, |p| {
        p["chat"] == gid.as_str() && p["st"] == 2
    })
    .await;
    assert_eq!(st["ids"][0], mid.as_str());

    step("Вера пишет — Борис получает, хотя они не контакты");
    c.dispatch("chat_send", json!({"chat": gid, "text": "Привет от Веры"}))
        .await
        .unwrap();
    let gv = wait_for(&mut brx, "chat:msg", 30, |p| {
        p["new"] == true && p["msg"]["body"] == "Привет от Веры"
    })
    .await;
    assert_eq!(gv["msg"]["senderName"], "Вера");
    wait_for(&mut arx, "chat:msg", 30, |p| {
        p["new"] == true && p["msg"]["body"] == "Привет от Веры"
    })
    .await;

    step("правка своего сообщения");
    a.dispatch(
        "chat_edit",
        json!({"id": mid, "text": "Всем привет! (испр.)"}),
    )
    .await
    .unwrap();
    let ed = wait_for(&mut brx, "chat:msg", 20, |p| {
        p["new"] == false && p["msg"]["id"] == mid.as_str()
    })
    .await;
    assert_eq!(ed["msg"]["body"], "Всем привет! (испр.)");
    assert!(
        b.dispatch("chat_edit", json!({"id": mid, "text": "x"}))
            .await
            .is_err()
    );

    step("файл Бориса → Вера качает у Бориса напрямую");
    let src = db.path().join("фото.bin");
    let data: Vec<u8> = (0..200_000u32).map(|i| (i * 13 % 251) as u8).collect();
    std::fs::write(&src, &data).unwrap();
    b.dispatch(
        "chat_send_file",
        json!({"chat": gid, "path": src.display().to_string()}),
    )
    .await
    .unwrap();
    let fm = wait_for(&mut crx, "chat:msg", 30, |p| {
        p["new"] == true && p["msg"]["kind"] == "file"
    })
    .await;
    assert_eq!(fm["msg"]["file"]["st"], "offered");
    let fid = fm["msg"]["file"]["fid"].as_str().unwrap().to_string();
    c.dispatch("chat_file_accept", json!({"fid": fid}))
        .await
        .unwrap();
    let done = wait_for(&mut crx, "chat:file", 40, |p| {
        p["st"] == "done" || p["st"] == "failed"
    })
    .await;
    assert_eq!(done["st"], "done", "{done}");
    assert_eq!(std::fs::read(done["path"].as_str().unwrap()).unwrap(), data);

    step("групповой звонок: вызов, ответ, вход из ленты, история");
    let call = a
        .dispatch("group_call", json!({"chat": gid, "video": true}))
        .await
        .unwrap();
    assert_eq!(call["groupId"], gid.as_str());
    let ib = wait_for(&mut brx, "call:incoming", 20, |p| {
        p["groupId"] == gid.as_str()
    })
    .await;
    assert_eq!(ib["groupName"], "Семья");
    assert_eq!(ib["video"], true);
    let ans = b
        .dispatch("call_answer", json!({"callId": ib["callId"]}))
        .await
        .unwrap();
    assert_eq!(ans["secret"], call["secret"]);
    assert_eq!(ans["groupId"], gid.as_str());
    wait_for(&mut crx, "call:incoming", 20, |p| {
        p["groupId"] == gid.as_str()
    })
    .await;
    let hc = c
        .dispatch("chat_history", json!({"chat": gid}))
        .await
        .unwrap();
    let note = hc["msgs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["kind"] == "call")
        .cloned()
        .expect("нет заметки о звонке");
    assert_eq!(note["file"]["joinable"], true, "{note}");
    assert!(
        note["file"].get("k").is_none(),
        "ключ звонка не должен уходить в интерфейс"
    );
    let j = c
        .dispatch("group_call_join", json!({"chat": gid, "id": note["id"]}))
        .await
        .unwrap();
    assert_eq!(j["roomId"], call["roomId"]);
    let room = a
        .dispatch(
            "room_join",
            json!({"secret": call["secret"], "selfId": "aaaa0001", "inst": "ai01"}),
        )
        .await
        .unwrap();
    assert_eq!(room["roomId"], call["roomId"]);
    a.dispatch("room_leave", json!({"roomId": call["roomId"]}))
        .await
        .unwrap();
    let ha = a.dispatch("history_list", Value::Null).await.unwrap();
    assert_eq!(ha[0]["groupId"], gid.as_str(), "{ha}");
    assert_eq!(ha[0]["dir"], "out");
    assert_eq!(ha[0]["peer"], "Семья");

    step("Вера не в сети → сообщение ждёт её в ящике группы");
    c.shutdown().await;
    drop(c);
    drop(crx);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = a.dispatch("chat_status", Value::Null).await.unwrap()["groups"]["mailed"]
        .as_u64()
        .unwrap_or(0);
    let m2 = a
        .dispatch("chat_send", json!({"chat": gid, "text": "Вера, ты где?"}))
        .await
        .unwrap();
    // Борис подтвердил сразу («доставлено не всем»), Вера — нет: через ~8 с — в ящик группы
    let part = wait_for(&mut arx, "chat:state", 20, |p| {
        p["chat"] == gid.as_str() && p["st"] == 1
    })
    .await;
    assert_eq!(part["ids"][0], m2["id"]);
    let mut mailed = false;
    for _ in 0..60 {
        let st = a.dispatch("chat_status", Value::Null).await.unwrap();
        if st["groups"]["mailed"].as_u64().unwrap_or(0) > before {
            mailed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(mailed, "сообщение не легло в ящик группы");
    let (c, mut crx) = start(dc.path(), "Вера", &mock.url).await;
    let mut got = Value::Null;
    for i in 0..80 {
        let h = c
            .dispatch("chat_history", json!({"chat": gid}))
            .await
            .unwrap();
        if let Some(m) = h["msgs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["body"] == "Вера, ты где?")
        {
            got = m.clone();
            break;
        }
        if i % 10 == 9 {
            let _ = c.dispatch("chat_mail_fetch", Value::Null).await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let diag = (
        c.dispatch("chat_status", Value::Null).await.unwrap(),
        a.dispatch("chat_status", Value::Null).await.unwrap(),
    );
    assert_eq!(got["via"], "mail", "{diag:?}");
    wait_for(&mut arx, "chat:state", 40, |p| {
        p["chat"] == gid.as_str() && p["st"] == 2 && p["ids"][0] == m2["id"]
    })
    .await;

    step("исключение Веры: новый ключ, Вера только читает");
    a.dispatch("group_remove", json!({"chat": gid, "member": c_id}))
        .await
        .unwrap();
    wait_for(&mut crx, "group:changed", 30, |p| p["chat"] == gid.as_str()).await;
    let mut left = false;
    for _ in 0..60 {
        let lc = c.dispatch("chats_list", Value::Null).await.unwrap();
        if row(&lc, &gid)["left"] == true {
            left = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(left, "Вера всё ещё в группе");
    assert!(
        c.dispatch("chat_send", json!({"chat": gid, "text": "я тут"}))
            .await
            .is_err()
    );
    let mut ok = false;
    for _ in 0..80 {
        let info = b
            .dispatch("group_info", json!({"chat": gid}))
            .await
            .unwrap();
        if info["members"].as_array().unwrap().len() == 2 {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(ok, "у Бориса не обновился состав");
    a.dispatch("chat_send", json!({"chat": gid, "text": "Без Веры"}))
        .await
        .unwrap();
    wait_for(&mut brx, "chat:msg", 20, |p| {
        p["new"] == true && p["msg"]["body"] == "Без Веры"
    })
    .await;

    step("Борис выходит из группы");
    b.dispatch("group_leave", json!({"chat": gid}))
        .await
        .unwrap();
    let mut alone = false;
    for _ in 0..80 {
        let info = a
            .dispatch("group_info", json!({"chat": gid}))
            .await
            .unwrap();
        if info["members"].as_array().unwrap().len() == 1 {
            alone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(alone, "Аня всё ещё видит Бориса в группе");
    let st = a.dispatch("chat_status", Value::Null).await.unwrap();
    assert!(st["groups"].is_object(), "{st}");
    let _ = (b_id, c);
}
