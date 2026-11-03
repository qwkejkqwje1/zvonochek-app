# Журнал разработки (для себя: состояние, команды, следующие шаги)

## Окружение (песочница)
- `source /data/tools/env-rust.sh` — Rust 1.99 (rustup в /data/tools/rust), цели x86_64/aarch64-pc-windows-msvc,
  cargo-xwin, tauri CLI (npm, /data/tools/tauri-cli), makensis 3.11 (/data/tools/nsis/bin), CARGO_TARGET_DIR=/data/zv4-target.
- clang/lld/llvm-rc из dnf; swap 6 ГБ (/swapfile, после перезапуска песочницы включить заново: `sudo swapon /swapfile`).
- Веб-эталон: /data/zvweb (3373aa0, v40; до этого a61b11e v39 — signaling/crypto не менялись). Векторы: `WEB_DIR=/data/zvweb node tools/gen-vectors.mjs > spec/vectors/web-v40.json`.
- Проверка Rust→JS: `cargo run -q -p zv-proto --example rust_sealed > /tmp/rs.json && WEB_DIR=/data/zvweb node tools/gen-vectors.mjs --check /tmp/rs.json`.

## Статус
- [x] M0: workspace, zv-proto (ссылки, deriveRoom, seal/open, ids, topics), векторы в обе стороны.
- [x] M1: zv-signal (MQTT WSS+TCP, Worker WS+HTTP, Nostr, ntfy, RoomHub), zv-core, zv-devhost, ui/desktop
  (signaling.js, preload.js), sync-web, E2E.
  - zv-cli probe: два ядра в одной комнате через публичную инфраструктуру. Из песочницы не работают test.mosquitto.org
    и mqtt.eclipseprojects.io (сервер рвёт TLS/CONNECT), relay.nostr.band — это их сторона.
  - E2E (живые сайт и каналы): `tests/e2e/devhost-live-call.mjs` — сайт ↔ веб-клиент в devhost соединяются за ~3 с;
    `tests/e2e/devhost-shell.mjs` — первый запуск → своя ссылка → браузер звонит → входящий через ~0,3 с → ответ →
    разговор (2 с) → история; повторный звонок и сброс → «пропущенный» + счётчик.
  - Запуск в песочнице: `PW_MODULE=/data/tools/node_modules/playwright-core/index.mjs CHROMIUM_PATH=/usr/local/bin/chromium node tests/e2e/…`,
    devhost: `/data/zv4-target/debug/zv-devhost --port 8790 --ui /data/zv4/ui --data /tmp/zvdev1`.
- [x] M2: Tauri-приложение (app/), оболочка (ui/shell), трей, окно входящего, установщик NSIS, обновления, CI.
  - Кросс-сборка: `NSISDIR=/data/tools/nsis ZV_UPDATER_KEY=/data/zv4-secrets/updater.key tools/build-win.sh x86_64|aarch64`
    (x64 ≈ 4,0 МБ, ARM64 ≈ 3,8 МБ; для ARM64 ring собирается обёрткой tools/xwin-clang/clang).
  - UI-тест оболочки: `tests/e2e/devhost-ui.mjs` на чистом devhost (все шаги, включая узкое окно 420×600).
  - Ключ подписи обновлений: /data/zv4-secrets/updater.key (без пароля; НЕ в репозитории) → секрет GitHub.
- [ ] M3: iroh + libp2p, контакты, ring, резерв голоса.
- [ ] M4: чаты, файлы. M5: группы. M6: Android.

## Решения по ходу
- ADR-0001: окно звонка — встроенный веб-клиент, заменён только signaling.js.
- Хранилище M2: JSON-файлы с атомарной записью (settings.json, history.json) + links.dat под DPAPI вместо SQLite —
  объёмы маленькие, SQLite появится в M4 (чаты).
- Команды ядра: `dispatch_sync` — всё быстрое (в т. ч. room_send) выполняется сразу и по порядку (Tauri: синхронная
  команда `zv_sync`); асинхронные — room_stats/room_status/http_fetch/diag_snapshot через `zv`.
- Подавление повторного звонка: inst звонящего после ответа/отклонения молчит 30 с, но `bye` от него снимает подавление
  (новый звонок того же вкладки браузера звонит сразу).
- Окна Tauri создаются программно: preload.js — init-скрипт; окно звонка получает `window.__ZV_BOOT__` и `#k=` init-скриптом;
  микрофон/камера разрешаются без запроса (on_permission_request); внешние ссылки — в браузере.
