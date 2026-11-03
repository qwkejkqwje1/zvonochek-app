//! Совместимость с веб-версией: векторы, сгенерированные кодом веба (tools/gen-vectors.mjs).

use serde_json::Value;
use zv_proto::{Room, topics};

fn vectors() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/vectors/web-v40.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors file")).expect("json")
}

#[test]
fn derive_and_open_web_sealed() {
    let v = vectors();
    let rooms = v["rooms"].as_array().unwrap();
    assert!(rooms.len() >= 3);
    let mut opened = 0;
    for r in rooms {
        let room = Room::derive(r["secret"].as_str().unwrap()).unwrap();
        assert_eq!(room.topic, r["topic"].as_str().unwrap(), "topic");
        assert_eq!(topics::ntfy_signaling_topic(&room.topic), r["ntfy"].as_str().unwrap(), "ntfy");
        for s in r["sealed"].as_array().unwrap() {
            let sealed = s["sealed"].as_str().unwrap();
            let got = room.open(sealed).unwrap_or_else(|| panic!("open failed: {sealed}"));
            assert_eq!(got, s["plain"], "plain");
            opened += 1;
        }
    }
    assert!(opened >= 12);
}
