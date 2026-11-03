# Журнал разработки (для себя: состояние, команды, следующие шаги)

## Окружение (песочница)
- `source /data/tools/env-rust.sh` — Rust 1.99 (rustup в /data/tools/rust), цели x86_64/aarch64-pc-windows-msvc,
  cargo-xwin, tauri CLI (npm, /data/tools/tauri-cli), makensis 3.11 (/data/tools/nsis/bin), CARGO_TARGET_DIR=/data/zv4-target.
- clang/lld/llvm-rc из dnf; swap 6 ГБ (/swapfile, после перезапуска песочницы включить заново: `sudo swapon /swapfile`).
- Веб-эталон: /data/zvweb (3373aa0, v40; до этого a61b11e v39 — signaling/crypto не менялись). Векторы: `WEB_DIR=/data/zvweb node tools/gen-vectors.mjs > spec/vectors/web-v40.json`.
- Проверка Rust→JS: `cargo run -q -p zv-proto --example rust_sealed > /tmp/rs.json && WEB_DIR=/data/zvweb node tools/gen-vectors.mjs --check /tmp/rs.json`.

## Статус
- [x] M0: workspace, zv-proto (ссылки, deriveRoom, seal/open, ids, topics), векторы в обе стороны.
- [ ] M1: zv-signal ✅ (MQTT WSS+TCP, Worker WS+HTTP, Nostr, ntfy, RoomHub; живой обмен с сайтом v40 проверен:
  `tests/e2e/live-web-hello.mjs` + `zv-cli join`), zv-core, devhost, ui/desktop (signaling.js, preload.js), sync-web, E2E.
  - zv-cli probe: два ядра в одной комнате через публичную инфраструктуру. Из песочницы не работают test.mosquitto.org
    и mqtt.eclipseprojects.io (сервер рвёт TLS/CONNECT), relay.nostr.band — это их сторона.
- [ ] M2: Tauri-приложение, оболочка, «Мои ссылки», трей, установщик, обновления.
- [ ] M3: iroh + libp2p, контакты, ring, резерв голоса.
- [ ] M4: чаты, файлы. M5: группы. M6: Android.

## Решения по ходу
- ADR-0001: окно звонка — встроенный веб-клиент, заменён только signaling.js.
