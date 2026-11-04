# Журнал разработки (для себя: состояние, команды, следующие шаги)

## Окружение (песочница)
- С 3 ноября: песочницу сбрасывает к снимку /data (≈ 2 ноября) — инструменты и сборка ВНЕ /data:
  `source ~/.zv/env.sh` (RUSTUP_HOME/CARGO_HOME=~/zvtools, CARGO_TARGET_DIR=~/zv4-target); токен GitHub — ~/.zv/gh-token
  (не в репозитории), `~/.zv/git.sh` / `~/.zv/gh-api.sh`. Всё важное — сразу в GitHub.
- E2E в песочнице: `PW_MODULE=/data/tools/node_modules/playwright-core/index.mjs CHROMIUM_PATH=/usr/local/bin/chromium`
  (Playwright 1.64.1). devhost-contacts изредка падает на «повторное добавление» (клик, 30 с) — повтор проходит.
- Веб-эталон v41: /data/zvweb-new (ZVONochek/zvonochek.github.io, b954896); сайт — https://zvonochek.github.io/
  (старый qwkejkqwje1.github.io/zvonochek отдаёт ту же версию). Синхронизация: `WEB_DIR=/data/zvweb-new tools/sync-web.sh HEAD`.
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
- [x] M3: P2P (iroh, ADR-0002; libp2p отложен), контакты, звонок контакту (ring), голос моста датаграммами.
  - crates/zv-p2p: узел iroh, ALPN zv/4, hello4, авторизация линков, кадры/датаграммы, крипто (пара, коды).
  - zv-core: p2p.rs (апгрейд комнат звонка на P2P: bind с доказательством, канал `p2p` в RoomHub), contacts.rs
    (код приглашения, ящики, предложения, ring, «в сети»), P2P выкл/вкл на лету (поколение узла).
  - Тесты: `cargo test -p zv-core --test contacts` (два ядра, только P2P); UI: `tests/e2e/devhost-contacts.mjs`
    на двух чистых devhost (8790/8791) — приглашение → контакт → «в сети» → код безопасности → звонок → отклонение →
    «не беспокоить» → удаление → звонок по ссылке → «Добавить в контакты» из истории → P2P выкл/вкл.
  - devhost: `--p2p-local` — без релеев/DNS n0 (только прямые адреса).
- [x] M4: чаты, почтовый ящик, файлы, перенос профиля (ADR-0003).
  - zv-signal: mailbox.rs (адрес ящика из секрета, Worker ChatRoom + Nostr + ntfy, предметы 4124 байта, части).
  - zv-core: chats.rs (кадры chat*, очередь outbox → линк/комната → через 8 с ящик; повтор линков раз в 30 с),
    files.rs (потоки `{t:get,fid,off}`, BLAKE3, `.part`, MOTW), db.rs (SQLite), profile.rs (`.zvp`: Argon2id +
    XChaCha20-Poly1305, `import.pending` → применяется при старте).
  - Приложение: уведомления о сообщениях, мигание окна, значок непрочитанных (оверлей панели задач + подсказка трея),
    перетаскивание файлов, системные диалоги (выбор файлов, сохранение профиля), перезапуск после импорта профиля.
  - Тесты: `cargo test -p zv-core --test chats` (P2P-чат, файлы, ящик офлайн, докачка 160 МБ после обрыва, перенос
    профиля); UI: `tests/e2e/devhost-chats.mjs` и `tests/e2e/devhost-profile.mjs` (запускают свои devhost и заглушку
    Worker), плюс прежние devhost-ui/devhost-contacts.
  - Проверка Windows: `cd app && PKG_CONFIG_PATH=/data/zv4/tools/fakepc TAURI_LINUX_AYATANA_APPINDICATOR=1 cargo xwin check
    --target x86_64-pc-windows-msvc` (ARM64 — так же с `ZV_REAL_CLANG="$(command -v clang)" PATH=/data/zv4/tools/xwin-clang:$PATH`).
- [x] M5: группы (ADR-0004).
  - zv-core: groups.rs (подписанные конверты `gm`, комната и ящик группы, `g_sync` от администратора с ключом для
    каждого, смена ключа при исключении/выходе, передача прав, групповые звонки `g_ring` и «Присоединиться» 2 ч),
    ветки групп в chats.rs/files.rs/p2p.rs (линки и файлы от участников-неконтактов).
  - Интерфейс: «Новая группа», шапка группы (участники, «печатает» с именами, звонки), диалог участников,
    служебные строки, имена авторов, только чтение после выхода; входящий групповой звонок; история «· группа».
  - Тесты: `cargo test -p zv-core --test groups` (три ядра), `tests/e2e/devhost-groups.mjs` (три devhost).
- [x] M6: Android (ADR-0005) — собирается и проходит проверки; на устройстве не проверено (в песочнице нет Android).
  - Окружение: `source /data/tools/env-android.sh` (SDK /data/android/sdk: platform 37, build-tools 37, NDK r27d;
    JDK 21; шим `rustup` в /data/tools/shims). Сборка: `/data/tools/build-apk.sh release > /data/backups/apk-build.log 2>&1`
    → `app/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk` (arm64, ≈ 24 МБ).
  - app: `lib.rs` (бывший main.rs, общий для ПК и Android), `android.rs` (плагин `zvandroid` + JNI-входы),
    `wins_mobile.rs` (одно окно); `app/gen/android` — проект Gradle (MainActivity, ZvService, ZvPlugin, ZvReceiver,
    ZvNative, манифест, тема, иконки); BuildTask.kt вызывает `tauri` из PATH.
  - UI телефона: `zv-devhost --mobile` + `tests/e2e/devhost-mobile.mjs` (нижние вкладки, «Назад», настройки, 360×740).
  - Проверки: `cargo clippy -p zvonochek --target aarch64-linux-android -- -D warnings`; CI — `android.yml`
    (подпись — секреты ANDROID_KEYSTORE_B64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS, без них APK неподписанный).
  - CI на f6cd650: CI (Linux + сборка Windows x64/ARM64) и Android (APK arm64+armv7, ≈ 24 мин) — зелёные.
- [x] После M6: веб-клиент v41 и новый адрес сайта (WEB_BASE), тест `devhost-live-video.mjs` (видео сайт ↔ приложение;
  `ZV_WEB_GUM_DELAY=мс` — браузер долго не отвечает на запрос микрофона); CI собирает тестовые установщики NSIS
  (артефакты `zvonochek-setup-<target>`, без подписи обновлений).
  Диагностика → «Сеть звонков (WebRTC)» (ui/shell/nettest.js): STUN/TURN из WebView, без IP в отчёте.
- [x] Переносная версия Windows (app/src/portable.rs): данные в `ZVONochek-data` рядом с exe (рядом `uninstall.exe` —
  установленная версия, как раньше AppData; нельзя писать рядом — AppData с предупреждением), копия данных прежней
  версии при первом запуске (через `ZVONochek-data.part` + rename), профиль WebView2 — `data_directory`, размер окна —
  свой `window.json` вместо tauri-plugin-window-state, уведомления — регистрация AUMID в
  `HKCU\Software\Classes\AppUserModelId\com.zvonochek.app` (DisplayName, IconUri) и настройка `notifications`,
  «Убрать следы», удаление старой копии, обновление — заменой exe. CI: артефакт `zvonochek-portable-<target>`
  (ZVONochek.exe); release.yml — `…_portable.exe`. Не проверено на настоящей Windows: тосты без ярлыка, перенос папки.
- [x] Windows — только переносная версия, пароль профиля, самообновление (ADR-0006): установщик и плагин updater убраны
  (`tauri build --no-bundle`); нельзя писать рядом с exe — окно и выход; нет WebView2 — окно со ссылкой. zv-core
  `vault.rs` — ключ данных (`ZVK1`), `vault.json` (DPAPI-записи по компьютерам + пароль Argon2id), окно `unlock` до
  запуска ядра; `update.rs` — `latest.json` + подпись Ed25519 (ключ `ZV_UPDATE_KEY` в секретах, открытый — `KEYS_HEX`),
  `selfupdate.rs` — exe → `.old`, новый на место, `--wait-pid` при перезапуске, автопроверка раз в 6 ч.
  Проверка сборки под Windows в песочнице: `cargo clippy -p zvonochek --target x86_64-pc-windows-gnu` с `zig cc`
  (pip `ziglang`) и `llvm-windres` (~/wincheck.sh). E2E: `tests/e2e/update-vault.sh` (devhost `--vault`, тестовый
  релиз на http.server). Не проверено на настоящей Windows: замена работающего exe на FAT32-флешке, окно пароля, тосты.
- [ ] Релиз 4.0.0 — за владельцем: ключ Android — создать по согласию; публичность репозитория или отдельный открытый
  репозиторий релизов (`ZV_RELEASE_REPO` + `ZV_RELEASE_TOKEN`; иначе latest.json и exe недоступны приложениям), тег
  `v4.0.0`, проверка на Windows 10/11 и телефоне. Секрет `ZV_UPDATE_KEY` уже в репозитории.

- [x] 4.1: libp2p — второй P2P-транспорт и мультипуть (ADR-0007): `zv-p2p/src/lp.rs` (QUIC/TCP, Noise, Yamux,
  identify, ping, Kademlia-клиент, relay-клиент + DCUtR, AutoNAT, UPnP, mDNS, libp2p-stream), `stream.rs` (потоки
  iroh/libp2p под одним типом), линк из путей (`hello4` `mp`), keepalive `pk4`, настройка «Второй транспорт (libp2p)»,
  `ZV_P2P_ONLY`, диагностика путей. Тесты zv-p2p: libp2p-линк и файлы, переход между путями без разрыва, релей →
  DCUtR → прямое; zv-p2p добавлен в CI. Живой тест `libp2p_live` (`-- --ignored`, из песочницы через интернет):
  бутстрап Amino, резервации на публичных релеях за ~5 с, запись присутствия в DHT за ~25 с, поиск по одному ID
  за 0,4 с, релей → DCUtR → прямое. Нужна поддержка RSA (`rsa`): у бутстрап-узлов IPFS ключи RSA, без неё DHT
  недоступна. E2E devhost-contacts/chats/groups проходят. Не проверено: UPnP, домашние NAT, Android.
  Релиз v4.1.0 опубликован (exe x64 29,5 МБ, ARM64 26,8 МБ; подпись обновления проверена ключом из `KEYS_HEX`);
  строка про APK в тексте релиза — только когда подписанный APK загружен (android.yml).
- [x] Ключ подписи Android (4 ноября): PKCS12 RSA-4096, псевдоним `zvonochek`, до 2054 г.; секреты
  ANDROID_KEYSTORE_B64 / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS; резервная копия — у владельца (без неё
  обновить APK поверх нельзя). android.yml: ручной запуск с `release_tag` — APK из тега в выпущенный релиз
  (так APK 4.1.0 попал в v4.1.0).
- [x] 4.2: туннель звонка (ADR-0008, `zv-core/src/tunnel.rs`): кандидат ICE ядра, датаграммы `T`, кадры `tun`,
  через libp2p-релей медиа не гоним; настройка «Звонки через P2P-туннель». E2E `tests/e2e/devhost-tunnel.mjs`
  (2 devhost, 4 сценария: только туннель iroh/libp2p, обычный звонок, туннель выключен) проходит.
- [x] 4.2: чаты сайта `#chat=` (ADR-0009): окно встроенного веб-клиента (`host_open_chat`; ПК — окно `webchat`,
  Android — главное окно), прокси WebSocket в ядре (`zv-core/src/wsproxy.rs`, `ws_open/ws_send/ws_close/ws_keep`),
  подмена `WebSocket` и `serviceWorker.ready` в preload.js. Живой E2E `tests/e2e/live-webchat.mjs` (сайт ↔ окно
  «Чаты сайта» devhost): сообщения и файлы в обе стороны (сообщения за ~0,5 с), основной канал, кнопка списка.
  Не проверено: Android на устройстве (APK собирается), PIN-комнаты.
- [x] Релиз v4.2.0 опубликован (4 ноября): exe x64 29,7 МБ, ARM64 26,9 МБ, APK 51,1 МБ (подписан ключом проекта);
  подписи `latest.json` проверены ключом из `KEYS_HEX`. Найдено: PATCH текста черновика без `tag_name` (android.yml)
  делал релиз `untagged-…` → ссылки из `latest.json` давали бы 404; исправлено (tag_name передаётся), v4.2.0 привязан
  к тегу вручную.
- [x] Проверка кода (4 ноября, ветка `review`, CHANGELOG 4.2.1). Сломанное: окно `webchat` не было в
  `app/capabilities/default.json` → нет `core:event` → `ws:open/ws:msg` не доходили (в devhost-тестах не видно);
  ночная «Совместимость с веб-версией» падала с 3 ноября на устаревшей проверке `deliveryStats` в sync-web.sh (теперь
  проверяется, что все `S.sig.X` из app.js есть в ui/desktop/signaling.js) → веб-клиент синхронизирован до v44;
  libp2p: конец потока считался закрытием линка → после DCUtR закрытие релейного соединения иногда рвало линк (кадр
  `lc4` + `lc` в hello4); перезапуск собеседника: новый путь вливался в старый линк, `prune` мог убить новый путь ради
  мёртвого старого до таймаута (~30 с) → `s` (сеанс) в hello4, другой сеанс — старый линк закрыт, новый линк
  (тест `peer_restart_new_link`); кадры до допуска входящего линка выбрасывались (гонка с `authorize` в ядре) →
  держатся до допуска (`admit`, ≤ 64 кадров / 1 МБ); «Добавить» контакта: поздний ответ проверки кода затирал
  ошибку, а код из буфера + вставка Ctrl+V (или `fill` в e2e) давали двойной код → «Не похоже на код» (код выделяется).
  Лишнее: `zvOnboarded`, `ConnEvent::PeerJoined(u64)`, `_assert_ok`. Усилено: bidi-символы в именах файлов.
  Нестабильно в песочнице (2 CPU): `libp2p_relay_then_direct` — DCUtR «Protocol error» libp2p, в CI зелёный.
  Песочницу дважды сбрасывали (несохранённое в GitHub пропадало) — коммитить и отправлять сразу.

## Решения по ходу
- ADR-0007: libp2p — второй транспорт с тем же ключом устройства; линк — логический, из путей iroh и libp2p,
  основной путь по оценке (прямой iroh > прямой libp2p > релей iroh > релей libp2p), голос — датаграммами iroh.
- ADR-0006: Windows — только переносной exe; секреты — ключом данных профиля (DPAPI-запись на компьютер + пароль
  Argon2id), окно пароля до запуска ядра; самообновление — подписанный Ed25519 exe из релиза, замена работающего exe
  переименованием в `.old`.
- ADR-0005: Android — то же ядро и интерфейс в одном окне, служба переднего плана `specialUse` вместо FCM
  (без Firebase и аккаунтов), полноэкранный входящий с кнопками в уведомлении, без встроенного обновления.
- ADR-0004: группы — общий секрет (комната + ящик группы), конверты с подписью ключа устройства, состав и ключ — только
  от администратора (ключ — каждому секретом пары, в т. ч. неконтактам), смена ключа при исключении/выходе; в группах
  нет отметок «прочитано» (✓✓ — получили все); сигнализация группового звонка — транспортами комнаты, не P2P.
- ADR-0003: чаты — кадры ZV4 с очередью до `chat_ack`; офлайн — почтовый ящик (Worker ChatRoom + Nostr + ntfy);
  файлы — свои потоки iroh вместо iroh-blobs; история — SQLite открыто (как у мессенджеров), секреты — под DPAPI;
  перенос профиля — файл под паролем, применяется при перезапуске.
- ADR-0001: окно звонка — встроенный веб-клиент, заменён только signaling.js.
- ADR-0002: P2P — только iroh; libp2p отложен; контакты — ID устройств, секрет пары X25519, ящики через сигнализацию.
- Окно звонка контакту (preload): статус вызова («Звоним…», «У … звонит», «отклонил(а)»), завершение, когда
  собеседник положил трубку (`bye`); без видео — первый запрос камеры отбрасывается.
- Хранилище M2: JSON-файлы с атомарной записью (settings.json, history.json) + links.dat под DPAPI вместо SQLite —
  объёмы маленькие, SQLite появится в M4 (чаты).
- Команды ядра: `dispatch_sync` — всё быстрое (в т. ч. room_send) выполняется сразу и по порядку (Tauri: синхронная
  команда `zv_sync`); асинхронные — room_stats/room_status/http_fetch/diag_snapshot через `zv`.
- Подавление повторного звонка: inst звонящего после ответа/отклонения молчит 30 с, но `bye` от него снимает подавление
  (новый звонок того же вкладки браузера звонит сразу).
- Окна Tauri создаются программно: preload.js — init-скрипт; окно звонка получает `window.__ZV_BOOT__` и `#k=` init-скриптом;
  микрофон/камера разрешаются без запроса (on_permission_request); внешние ссылки — в браузере.
