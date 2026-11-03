//! Чаты двух ядер: P2P (сообщение, «доставлено», «прочитано», правка, «печатает», удаление у всех),
//! файлы (ручной приём, автоприём картинки, предпросмотр), доставка через почтовый ящик, пока
//! получатель не в сети (заглушка Worker), включая длинное сообщение частями.

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

async fn start(dir: &std::path::Path, name: &str, worker: &str) -> (Core, broadcast::Receiver<CoreEvent>) {
    let core = Core::start(opts(dir, worker)).unwrap();
    let rx = core.subscribe();
    core.dispatch("settings_set", json!({"patch": {"name": name}})).await.unwrap();
    for _ in 0..100 {
        if core.device_id().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(core.device_id().is_some(), "P2P не запустился");
    (core, rx)
}

async fn wait_for(rx: &mut broadcast::Receiver<CoreEvent>, name: &str, secs: u64, pred: impl Fn(&Value) -> bool) -> Value {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn chats_p2p_files_mailbox() {
    let mock = zv_signal::mock::MockWorker::spawn().await;
    let da = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let (a, mut arx) = start(da.path(), "Аня", &mock.url).await;
    let (b, mut brx) = start(db.path(), "Борис", &mock.url).await;

    step("контакт по коду");
    let inv = a.dispatch("contact_invite", json!({})).await.unwrap();
    b.dispatch("contact_add", json!({"code": inv["code"]})).await.unwrap();
    wait_for(&mut brx, "contact:added", 15, |_| true).await;
    wait_for(&mut arx, "contact:added", 5, |_| true).await;
    let chat_a = a.dispatch("chats_list", Value::Null).await.unwrap()[0]["chat"].as_str().unwrap().to_string();
    let chat_b = b.dispatch("chats_list", Value::Null).await.unwrap()[0]["chat"].as_str().unwrap().to_string();

    step("сообщение по P2P → доставлено");
    let m = a.dispatch("chat_send", json!({"chat": chat_a, "text": "  Привет, Борис!  "})).await.unwrap();
    let mid = m["id"].as_str().unwrap().to_string();
    assert_eq!(m["body"], "Привет, Борис!");
    let got = wait_for(&mut brx, "chat:msg", 10, |p| p["new"] == true).await;
    assert_eq!(got["msg"]["body"], "Привет, Борис!");
    assert_eq!(got["msg"]["via"], "p2p");
    assert_eq!(got["msg"]["out"], false);
    assert_eq!(got["notify"], true);
    let st = wait_for(&mut arx, "chat:state", 10, |p| p["st"] == 2).await;
    assert_eq!(st["ids"][0], mid.as_str());
    let l = b.dispatch("chats_list", Value::Null).await.unwrap();
    assert_eq!(l[0]["unread"], 1);
    assert_eq!(l[0]["last"]["body"], "Привет, Борис!");

    step("прочитано");
    b.dispatch("chat_focus", json!({"chat": chat_b, "visible": true})).await.unwrap();
    assert_eq!(b.dispatch("chat_read", json!({"chat": chat_b})).await.unwrap()["read"], 1);
    wait_for(&mut arx, "chat:state", 10, |p| p["st"] == 3).await;
    assert_eq!(b.dispatch("chats_list", Value::Null).await.unwrap()[0]["unread"], 0);

    step("ответ с цитатой, «печатает», правка");
    b.dispatch("chat_typing", json!({"chat": chat_b})).await.unwrap();
    wait_for(&mut arx, "chat:typing", 5, |p| p["on"] == true).await;
    let r = b.dispatch("chat_send", json!({"chat": chat_b, "text": "Привет!", "reply": mid})).await.unwrap();
    // пришло сообщение — «печатает» гаснет сразу (событие раньше chat:msg)
    wait_for(&mut arx, "chat:typing", 3, |p| p["on"] == false).await;
    let got = wait_for(&mut arx, "chat:msg", 10, |p| p["new"] == true).await;
    assert_eq!(got["msg"]["reply"], mid.as_str());
    a.dispatch("chat_edit", json!({"id": mid, "text": "Привет, Борис! (исправлено)"})).await.unwrap();
    let ed = wait_for(&mut brx, "chat:msg", 10, |p| p["new"] == false).await;
    assert_eq!(ed["msg"]["body"], "Привет, Борис! (исправлено)");
    assert!(ed["msg"]["edited"].as_u64().is_some());
    // чужое изменить нельзя
    assert!(a.dispatch("chat_edit", json!({"id": r["id"], "text": "x"})).await.is_err());

    step("удаление у всех");
    a.dispatch("chat_delete", json!({"id": mid, "everyone": true})).await.unwrap();
    let del = wait_for(&mut brx, "chat:msg", 10, |p| p["msg"]["deleted"] == true).await;
    assert_eq!(del["msg"]["body"], "");
    let h = b.dispatch("chat_history", json!({"chat": chat_b})).await.unwrap();
    assert_eq!(h["msgs"].as_array().unwrap().len(), 2);

    step("файл: ручной приём");
    let src = da.path().join("отчёт.bin");
    let data: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
    std::fs::write(&src, &data).unwrap();
    let fm = a.dispatch("chat_send_file", json!({"chat": chat_a, "path": src.display().to_string()})).await.unwrap();
    assert_eq!(fm["kind"], "file");
    assert_eq!(fm["file"]["st"], "ready");
    let got = wait_for(&mut brx, "chat:msg", 10, |p| p["new"] == true && p["msg"]["kind"] == "file").await;
    assert_eq!(got["msg"]["file"]["st"], "offered");
    assert_eq!(got["msg"]["file"]["name"], "отчёт.bin");
    let fid = got["msg"]["file"]["fid"].as_str().unwrap().to_string();
    b.dispatch("chat_file_accept", json!({"fid": fid})).await.unwrap();
    let done = wait_for(&mut brx, "chat:file", 20, |p| p["st"] == "done" || p["st"] == "failed").await;
    assert_eq!(done["st"], "done", "{done}");
    let path = done["path"].as_str().unwrap();
    assert!(path.ends_with("отчёт.bin"));
    assert_eq!(std::fs::read(path).unwrap(), data);

    step("картинка: автоприём и предпросмотр");
    let png = da.path().join("pic.png");
    std::fs::write(&png, b"\x89PNG\r\n\x1a\nnot-really-a-png").unwrap();
    a.dispatch("chat_send_file", json!({"chat": chat_a, "path": png.display().to_string(), "text": "смотри"})).await.unwrap();
    let done = wait_for(&mut brx, "chat:file", 20, |p| p["st"] == "done").await;
    let pv = b.dispatch("chat_file_data", json!({"fid": done["fid"]})).await.unwrap();
    assert!(pv["url"].as_str().unwrap().starts_with("data:image/png;base64,"));

    step("получатель не в сети → почтовый ящик");
    b.shutdown().await;
    drop(b);
    drop(brx);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let m1 = a.dispatch("chat_send", json!({"chat": chat_a, "text": "Ты где?"})).await.unwrap();
    let long: String = (0..9000).map(|i| char::from(b'a' + ((i * 7919 + i / 3) % 26) as u8)).collect::<String>()
        + &zv_proto::ids::rand_hex(3000);
    let m2 = a.dispatch("chat_send", json!({"chat": chat_a, "text": long})).await.unwrap();
    // через ~8 с без подтверждения — в ящик (состояние 1)
    let mut mailed = std::collections::HashSet::new();
    while mailed.len() < 2 {
        let p = wait_for(&mut arx, "chat:state", 40, |p| p["st"] == 1).await;
        for id in p["ids"].as_array().unwrap() {
            mailed.insert(id.as_str().unwrap().to_string());
        }
    }
    assert!(mailed.contains(m1["id"].as_str().unwrap()) && mailed.contains(m2["id"].as_str().unwrap()));
    let st = a.dispatch("chat_status", Value::Null).await.unwrap();
    assert_eq!(st["mailed"], 2, "{st}");

    step("получатель запустился → забрал ящик → отправитель видит «доставлено»");
    let (b, mut brx) = start(db.path(), "Борис", &mock.url).await;
    let mut got = Vec::new();
    while got.len() < 2 {
        let p = wait_for(&mut brx, "chat:msg", 30, |p| p["new"] == true).await;
        got.push(p["msg"].clone());
    }
    assert!(got.iter().any(|m| m["body"] == "Ты где?"));
    assert!(got.iter().all(|m| m["via"] == "mail"), "{got:?}");
    assert!(got.iter().any(|m| m["body"].as_str() == Some(long.as_str())), "длинное сообщение не собралось");
    let mut acked = std::collections::HashSet::new();
    while acked.len() < 2 {
        let p = wait_for(&mut arx, "chat:state", 30, |p| p["st"] == 2).await;
        for id in p["ids"].as_array().unwrap() {
            acked.insert(id.as_str().unwrap().to_string());
        }
    }
    let st = a.dispatch("chat_status", Value::Null).await.unwrap();
    assert_eq!(st["outbox"], 0, "{st}");
    let hb = b.dispatch("chat_history", json!({"chat": chat_b})).await.unwrap();
    assert_eq!(hb["msgs"].as_array().unwrap().len(), 6);

    step("удаление контакта стирает переписку");
    let cid = b.dispatch("contacts_list", Value::Null).await.unwrap()[0]["id"].clone();
    b.dispatch("contact_delete", json!({"id": cid})).await.unwrap();
    let hb = b.dispatch("chat_history", json!({"chat": chat_b})).await.unwrap();
    assert!(hb["msgs"].as_array().unwrap().is_empty());
}
