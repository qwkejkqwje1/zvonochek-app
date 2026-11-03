//! Печатает конверты, запечатанные Rust, для проверки веб-кодом:
//!   cargo run -q -p zv-proto --example rust_sealed > /tmp/rust-sealed.json
//!   WEB_DIR=… node tools/gen-vectors.mjs --check /tmp/rust-sealed.json
use serde_json::json;
use zv_proto::Room;

fn main() {
    let plains = [
        json!({"type":"hello","name":"Rust 🦀","ver":39,"bc":1,"app":"zvd"}),
        json!({"type":"desc","gen":1,"desc":{"type":"answer","sdp":"v=0\r\n".repeat(300)}}),
        json!({"type":"voice2","b64":"QUJD".repeat(200),"_noZip":1}),
    ];
    let mut out = vec![];
    for secret in ["AbCdEfGhIjKlMnOpQrStUv", &zv_proto::link::new_secret()] {
        let room = Room::derive(secret).unwrap();
        for p in &plains {
            out.push(
                json!({"secret": secret, "topic": room.topic, "plain": p, "sealed": room.seal(p)}),
            );
        }
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
