// Settings dialog.
import { h, icon, api, toast, modal, clear, copyText, confirmDlg, fmtSize, shortId, avatar } from './lib.js';
import { tones, levelMeter } from './audio.js';
import { setSpeaker } from './call.js';

let A = null;
let restartNeeded = false;

const TABS = [
  ['profile', 'Профиль', 'users'],
  ['media', 'Звук и видео', 'mic'],
  ['network', 'Сеть', 'globe'],
  ['files', 'Файлы', 'folder'],
  ['privacy', 'Приватность', 'lock'],
  ['app', 'Приложение', 'sliders'],
  ['about', 'О программе', 'info'],
];

export function openSettings(app, tab = 'profile') {
  A = app;
  const nav = h('nav');
  const pane = h('div.pane');
  const wrap = h('div.settings', nav, pane);
  let cleanup = null;
  const m = modal({ title: 'Настройки', body: wrap, wide: true, onClose: () => { if (cleanup) cleanup(); } });
  const show = (t) => {
    if (cleanup) { cleanup(); cleanup = null; }
    clear(nav);
    for (const [id, label, ic] of TABS) {
      nav.appendChild(h('button' + (id === t ? '.on' : ''), { on: { click: () => show(id) } }, icon(ic, 'sm'), label));
    }
    clear(pane);
    if (restartNeeded) pane.appendChild(restartBar());
    const fn = { profile, media, network, files, privacy, app: appTab, about }[t];
    cleanup = fn(pane, m) || null;
  };
  show(tab);
  return m;
}

function restartBar() {
  return h('div.restart-bar', icon('refresh', 'sm'), h('div.grow', 'Изменения сети вступят в силу после перезапуска Звоночка.'),
    h('button.btn.sm.primary', { on: { click: restartApp } }, 'Перезапустить'));
}

async function restartApp() {
  try {
    await api('/api/app/restart', {});
    toast('Перезапуск… окно переподключится само.', 'info', 6000);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function save(patch, pane) {
  try {
    const r = await api('/api/settings', patch);
    A.setSettings(r.settings);
    if (r.me) A.S.me = r.me;
    if (r.ice) A.S.ice = r.ice;
    if (r.restart_required && !restartNeeded) {
      restartNeeded = true;
      if (pane && !pane.querySelector('.restart-bar')) pane.prepend(restartBar());
    }
    A.renderSidebar();
    return r;
  } catch (e) {
    toast(e.message, 'err', 6000);
    return null;
  }
}

function toggle(checked, onChange) {
  const inp = h('input', { type: 'checkbox', checked: !!checked });
  inp.addEventListener('change', () => onChange(inp.checked, inp));
  return h('label.switch', inp, h('span'));
}

function setting(title, hint, control) {
  return h('div.setting', h('div.grow', h('div', title), hint ? h('div.hint', hint) : null), control);
}

// ------------------------------------------------------------------ profile

function profile(pane) {
  const S = A.S;
  const nick = h('input.input', { value: S.settings.nickname || '', maxLength: 40, placeholder: 'Как вас будут видеть собеседники' });
  const saveNick = async () => {
    const v = nick.value.trim();
    if (!v || v === S.settings.nickname) return;
    const r = await save({ nickname: v }, pane);
    if (r) toast('Имя сохранено и будет отправлено контактам', 'ok');
  };
  nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') nick.blur(); });
  nick.addEventListener('blur', saveNick);
  pane.append(
    h('h3', 'Профиль'),
    h('div.card.pad', h('div.row', { style: { gap: '16px' } }, avatar(S.me.peer_id, S.me.nick, 's56'),
      h('div.grow.field', h('label', 'Ваше имя'), nick))),
    h('div.field', h('label', 'Ваш ID (открытый ключ)'),
      h('div.row', h('div.codebox.grow', { style: { padding: '8px 12px' } }, S.me.peer_id),
        h('button.ibtn', { title: 'Скопировать', on: { click: () => copyText(S.me.peer_id, 'ID скопирован') } }, icon('copy')))),
    h('div.hint', 'ID вычисляется из ключа шифрования этого компьютера и никогда не меняется. Ключ хранится только у вас; при переустановке Windows сохраните папку данных (Настройки → Приложение), чтобы не потерять контакты.'),
    h('div.field', h('label', 'Профиль программы'), h('div', S.me.profile + (S.me.profile === 'default' ? ' (основной)' : ''))),
  );
}

// ------------------------------------------------------------------ media

function media(pane) {
  const S = A.S;
  const ui = S.settings.ui || {};
  const micSel = h('select.select');
  const camSel = h('select.select');
  const spkSel = h('select.select');
  const meter = h('div.meter', h('i'));
  const video = h('video', { autoplay: true, playsInline: true, muted: true });
  const camPh = h('div.ph', icon('video'), h('span', 'Камера выключена'));
  const camBox = h('div.cam-box', video, camPh);
  const permBtn = h('button.btn.sm', { on: { click: () => start(true) } }, 'Разрешить доступ к устройствам');
  let stream = null;
  let stopMeter = null;
  let camStream = null;

  const fill = (sel, list, cur, def) => {
    clear(sel);
    sel.appendChild(h('option', { value: '' }, def));
    for (const d of list) sel.appendChild(h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || 'Устройство ' + shortId(d.deviceId)));
  };

  async function enumerate() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const cams = devs.filter((d) => d.kind === 'videoinput');
    const spks = devs.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    fill(micSel, mics, ui.mic, 'Микрофон по умолчанию');
    fill(camSel, cams, ui.cam, 'Камера по умолчанию');
    fill(spkSel, spks, ui.spk, 'Динамики по умолчанию');
    permBtn.classList.toggle('hidden', devs.some((d) => d.label));
  }

  async function start(ask) {
    try {
      if (stopMeter) stopMeter();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micSel.value ? { exact: micSel.value } : undefined, echoCancellation: true, noiseSuppression: ui.ns !== '0' } });
      stopMeter = levelMeter(stream, (lvl) => { meter.firstChild.style.width = Math.min(100, lvl * 400) + '%'; });
      await enumerate();
    } catch (e) {
      if (ask) toast('Нет доступа к микрофону: ' + (e.message || e.name), 'err');
    }
  }

  async function startCam() {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: camSel.value ? { exact: camSel.value } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } });
      video.srcObject = camStream;
      camBox.classList.add('on');
    } catch (e) {
      toast('Камера недоступна: ' + (e.message || e.name), 'err');
    }
  }

  micSel.addEventListener('change', () => { A.saveUI({ mic: micSel.value }); start(false); });
  camSel.addEventListener('change', () => { A.saveUI({ cam: camSel.value }); if (camStream) startCam(); });
  spkSel.addEventListener('change', () => { A.saveUI({ spk: spkSel.value }); setSpeaker(spkSel.value); });

  const camBtn = h('button.btn.sm', { on: { click: () => { if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; video.srcObject = null; camBox.classList.remove('on'); camBtn.textContent = 'Проверить камеру'; } else { startCam(); camBtn.textContent = 'Выключить камеру'; } } } }, 'Проверить камеру');
  const testSpk = h('button.btn.sm', { on: { click: () => { tones.connected(); setTimeout(() => tones.message(), 450); } } }, icon('volume', 'sm'), 'Проверить звук');

  pane.append(
    h('h3', 'Микрофон'),
    h('div.card.pad.col', micSel, h('div.row', h('div.grow', meter), permBtn), h('div.hint', 'Скажите что-нибудь — полоска должна двигаться.')),
    h('h3', 'Динамики'),
    h('div.card.pad.col', 'setSinkId' in HTMLMediaElement.prototype ? spkSel : h('div.hint', 'Выбор устройства вывода не поддерживается этим браузером.'), h('div.row', testSpk)),
    h('h3', 'Камера'),
    h('div.card.pad.col', camSel, camBox, h('div.row', camBtn)),
    h('h3', 'Обработка звука'),
    h('div.card',
      setting('Шумоподавление', 'Убирает фоновый шум (вентилятор, клавиатуру).', toggle(ui.ns !== '0', (v) => A.saveUI({ ns: v ? '1' : '0' }))),
      setting('Автоусиление микрофона', 'Выравнивает громкость голоса.', toggle(ui.agc !== '0', (v) => A.saveUI({ agc: v ? '1' : '0' }))),
      setting('Звуки', 'Мелодия звонка и сигнал новых сообщений.', toggle(ui.sounds !== '0', (v) => { tones.enabled = v; A.saveUI({ sounds: v ? '1' : '0' }); }))),
  );
  enumerate().then(() => start(false)).catch(() => {});
  return () => {
    if (stopMeter) stopMeter();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
  };
}

// ------------------------------------------------------------------ network

function network(pane) {
  const S = A.S;
  const st = S.settings;
  const statusBox = h('div.card.pad');
  const relaysBox = h('div');
  const diag = h('div');

  const renderStatus = (net, relays) => {
    const n = net || {};
    const reach = { public: 'Прямой доступ из интернета', private: 'За NAT (через hole punching / relay)', unknown: 'определяется…' }[n.reachability] || n.reachability;
    clear(statusBox).append(h('div.kv',
      h('div', 'Доступность'), h('div', n.internet ? reach : 'Интернет-поиск отключён'),
      h('div', 'Узлов DHT'), h('div', n.internet ? String(n.dht_peers || 0) : '—'),
      h('div', 'Соединений'), h('div', String(n.connected || 0)),
      h('div', 'P2P-порт'), h('div', String(n.p2p_port || '—') + ' (TCP и UDP)'),
      h('div', 'Публичные адреса'), h('div.mono', (n.public_addrs || []).join('\n') || '—'),
      h('div', 'Адреса в сети'), h('div.mono', (n.local_addrs || []).slice(0, 6).join('\n') || '—'),
      h('div', 'Через relay'), h('div.mono', (n.relay_addrs || []).slice(0, 4).join('\n') || '—')));
    clear(relaysBox);
    for (const r of relays || []) {
      const cls = r.state === 'reserved' ? 'ok' : r.state === 'error' ? 'bad' : 'warn';
      const txt = { reserved: 'подключён', connecting: 'подключение…', error: 'ошибка' }[r.state] || r.state;
      relaysBox.appendChild(h('div.relay-item', h('span.chip.' + cls, txt), h('span.mono', { title: r.addr }, r.addr), r.error ? h('span.hint', r.error) : null));
    }
  };
  renderStatus(S.net, S.relays);

  const relaysTa = h('textarea.textarea', { placeholder: '/ip4/203.0.113.10/tcp/4002/p2p/12D3KooW…', spellcheck: false }, (st.relays || []).join('\n'));
  relaysTa.value = (st.relays || []).join('\n');
  const saveRelays = h('button.btn.sm', { on: { click: async () => {
    const list = relaysTa.value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const r = await save({ relays: list }, pane);
    if (r) toast('Список relay сохранён', 'ok');
  } } }, 'Сохранить');

  const ice = (st.ice_servers || [])[0] || { urls: [] };
  const turnUrl = h('input.input', { value: (ice.urls || []).join(' '), placeholder: 'turn:turn.example.com:3478', spellcheck: false });
  const turnUser = h('input.input', { value: ice.username || '', placeholder: 'логин' });
  const turnPass = h('input.input', { value: ice.credential || '', placeholder: 'пароль', type: 'password' });
  const saveTurn = h('button.btn.sm', { on: { click: async () => {
    const urls = turnUrl.value.split(/\s+/).filter(Boolean);
    const list = urls.length ? [{ urls, username: turnUser.value.trim(), credential: turnPass.value }] : [];
    const r = await save({ ice_servers: list }, pane);
    if (r) toast(urls.length ? 'TURN-сервер сохранён — применится к следующему звонку' : 'TURN-сервер удалён', 'ok');
  } } }, 'Сохранить');

  const port = h('input.input', { type: 'number', min: 0, max: 65535, value: st.p2p_port, style: { width: '120px' } });
  port.addEventListener('change', () => save({ p2p_port: parseInt(port.value, 10) || 0 }, pane));

  const loadDiag = async () => {
    try {
      const d = await api('/api/diagnostics');
      renderStatus(d.net, d.relays);
      const rows = (d.conns || []).sort((a, b) => (b.contact ? 1 : 0) - (a.contact ? 1 : 0)).slice(0, 60).map((c) =>
        h('tr', h('td', c.contact || shortId(c.peer)), h('td.mono', c.addr), h('td', c.limited ? 'relay (огранич.)' : c.addr.includes('p2p-circuit') ? 'relay' : 'прямое'), h('td', c.direction === 'Inbound' ? 'вх.' : 'исх.')));
      clear(diag).append(
        h('div.hint', `Версия ${d.version} (${d.commit}) · ${d.os} · ${d.go} · работает ${Math.round(d.uptime_s / 60)} мин · ${d.mem_mb} МБ · горутин ${d.goroutines}`),
        rows.length ? h('table.table', h('tr', h('th', 'Узел'), h('th', 'Адрес'), h('th', 'Тип'), h('th', '')), rows) : h('div.hint', 'Активных соединений нет'));
    } catch (e) {
      clear(diag).append(h('div.hint', e.message));
    }
  };
  loadDiag();
  const timer = setInterval(loadDiag, 5000);

  pane.append(
    h('h3', 'Состояние'),
    statusBox,
    h('div.row', h('button.btn.sm', { on: { click: async () => { await api('/api/reconnect', {}).catch(() => {}); toast('Переподключаюсь к контактам…', 'info'); loadDiag(); } } }, icon('refresh', 'sm'), 'Переподключиться')),
    h('h3', 'Поиск собеседников'),
    h('div.card',
      setting('Через интернет', 'Публичная сеть libp2p (DHT, hole punching, ретрансляторы). Нужна, если собеседник не в вашей локальной сети.', toggle(st.internet_discovery, (v) => save({ internet_discovery: v }, pane))),
      setting('В локальной сети', 'Автоматический поиск в Wi-Fi/LAN (mDNS) и между хостом и виртуальной машиной.', toggle(st.lan_discovery, (v) => save({ lan_discovery: v }, pane))),
      setting('P2P-порт', 'TCP и UDP. 0 — выбрать автоматически. Проброс порта на роутере ускоряет соединение, но не обязателен (UPnP включён).', port)),
    h('h3', 'Свои relay-серверы'),
    h('div.card.pad.col',
      h('div.hint', 'Если у обоих собеседников строгий NAT (мобильный интернет, CGNAT), запустите ', h('b', 'zvonochek-relay'), ' на любом VPS и вставьте сюда напечатанный им адрес — по одному в строке. Через свой relay работают файлы и звонки без ограничений.'),
      relaysTa, relaysBox, h('div.row', h('div.spacer'), saveRelays)),
    h('h3', 'Звонки (WebRTC)'),
    h('div.card',
      setting('Публичные STUN-серверы', 'Google и Cloudflare помогают пробить NAT для звонков. Через них не идёт ни звук, ни видео.', toggle(st.public_stun, (v) => save({ public_stun: v }, pane)))),
    h('div.card.pad.col',
      h('div', { style: { fontWeight: 550 } }, 'TURN-сервер (необязательно)'),
      h('div.hint', 'Если звонок не соединяется напрямую, Звоночек сам переключится на аудиомост через своё соединение. TURN нужен только для видео в очень строгих сетях (например, coturn на своём VPS).'),
      turnUrl, h('div.row', turnUser, turnPass), h('div.row', h('div.spacer'), saveTurn)),
    h('h3', 'Диагностика'),
    h('div.card.pad', diag),
  );
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ files

function files(pane) {
  const S = A.S;
  const st = S.settings;
  const dir = h('input.input', { value: st.downloads_dir || '', placeholder: S.me.downloads_dir, spellcheck: false });
  const saveDir = h('button.btn.sm', { on: { click: async () => { const r = await save({ downloads_dir: dir.value.trim() }, pane); if (r) toast('Папка сохранена', 'ok'); } } }, 'Сохранить');
  const auto = h('input.input', { type: 'number', min: 0, max: 200, value: st.auto_accept_images_mb, style: { width: '110px' } });
  auto.addEventListener('change', () => save({ auto_accept_images_mb: parseInt(auto.value, 10) || 0 }, pane));
  const maxIn = h('input.input', { type: 'number', min: 1, max: 65536, value: Math.round(st.max_incoming_mb / 1024 * 10) / 10, step: 0.5, style: { width: '110px' } });
  maxIn.addEventListener('change', () => save({ max_incoming_mb: Math.max(1, Math.round(parseFloat(maxIn.value) * 1024)) }, pane));
  pane.append(
    h('h3', 'Куда сохранять'),
    h('div.card.pad.col',
      h('div.row', dir, saveDir),
      h('div.hint', `Сейчас: ${S.me.downloads_dir}. Пусто — папка «Загрузки\\Zvonochek».`),
      h('div.row', h('button.btn.sm', { on: { click: () => api('/api/files/open-folder', { which: 'downloads' }).catch((e) => toast(e.message, 'err')) } }, icon('folder', 'sm'), 'Открыть папку'))),
    h('h3', 'Приём файлов'),
    h('div.card',
      setting('Автоматически принимать картинки до (МБ)', '0 — спрашивать всегда. Остальные файлы всегда требуют подтверждения.', auto),
      setting('Максимальный размер входящего файла (ГБ)', `Сейчас ${fmtSize(st.max_incoming_mb * 1048576)}. Большие файлы передаются с докачкой и проверкой SHA-256.`, maxIn)),
    h('div.hint', 'Загруженные файлы помечаются как полученные из интернета — Windows SmartScreen предупредит перед запуском программ.'),
  );
}

// ------------------------------------------------------------------ privacy

function privacy(pane) {
  const S = A.S;
  const blocked = [...S.contacts.values()].filter((c) => c.state === 'blocked');
  const list = h('div.card');
  if (!blocked.length) list.appendChild(h('div.setting', h('div.hint', 'Заблокированных контактов нет')));
  for (const c of blocked) {
    list.appendChild(h('div.setting', avatar(c.peer_id, c.display, 's32'), h('div.grow', h('div', c.display), h('div.hint.mono', shortId(c.peer_id))),
      h('button.btn.sm', { on: { click: async (e) => { e.currentTarget.disabled = true; await A.unblock(c.peer_id); e.currentTarget.closest('.setting').remove(); } } }, 'Разблокировать')));
  }
  pane.append(
    h('h3', 'Как защищены данные'),
    h('div.card.pad.col',
      h('div.row', icon('lock', 'sm'), h('div', 'Сообщения и файлы идут напрямую между компьютерами по зашифрованному каналу libp2p (Noise / TLS 1.3).')),
      h('div.row', icon('phone', 'sm'), h('div', 'Звонки шифруются DTLS-SRTP (WebRTC); аудиомост — тем же каналом libp2p.')),
      h('div.row', icon('server', 'sm'), h('div', 'Ретрансляторы (relay) видят только зашифрованный поток и не могут его прочитать.')),
      h('div.row', icon('shieldCheck', 'sm'), h('div', 'Писать и звонить могут только подтверждённые контакты. Сверьте код безопасности, чтобы исключить подмену.')),
      h('div.row', icon('folder', 'sm'), h('div', 'История хранится только на этом компьютере, в папке профиля.'))),
    h('h3', 'Заблокированные'),
    list,
  );
}

// ------------------------------------------------------------------ app

function appTab(pane) {
  const S = A.S;
  const st = S.settings;
  const ui = st.ui || {};
  const theme = h('select.select', { style: { width: '200px' } },
    h('option', { value: 'system', selected: (ui.theme || 'system') === 'system' }, 'Как в системе'),
    h('option', { value: 'dark', selected: ui.theme === 'dark' }, 'Тёмная'),
    h('option', { value: 'light', selected: ui.theme === 'light' }, 'Светлая'));
  theme.addEventListener('change', async () => { await A.saveUI({ theme: theme.value }); A.applyTheme(); });
  const auto = S.me.autostart_supported
    ? toggle(S.me.autostart, async (v, inp) => {
      try { const me = await api('/api/app/autostart', { enabled: v }); A.S.me = me; } catch (e) { inp.checked = !v; toast(e.message, 'err'); }
    })
    : h('span.hint', 'только Windows');
  const notifyToggle = toggle(st.desktop_notify, async (v) => {
    await save({ desktop_notify: v }, pane);
    if (v && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  });
  pane.append(
    h('h3', 'Внешний вид'),
    h('div.card', setting('Тема', null, theme)),
    h('h3', 'Поведение'),
    h('div.card',
      setting('Запускать вместе с Windows', 'Звоночек будет тихо работать в трее и принимать звонки и сообщения.', auto),
      setting('Уведомления', 'Показывать уведомления о сообщениях и звонках, когда окно свёрнуто или закрыто.', notifyToggle),
      setting('Открывать окно при входящем звонке', 'Если окно закрыто, оно появится само.', toggle(st.open_window_on_call, (v) => save({ open_window_on_call: v }, pane)))),
    h('div.hint', 'Закрытие окна не выключает Звоночек: он остаётся в трее (значок у часов). Полный выход — кнопкой ниже или из меню трея.'),
    h('h3', 'Данные'),
    h('div.card.pad.col',
      h('div.kv', h('div', 'Папка профиля'), h('div.mono', S.me.data_dir), h('div', 'Журнал'), h('div.mono', S.me.log_file)),
      h('div.row',
        h('button.btn.sm', { on: { click: () => api('/api/files/open-folder', { which: 'data' }).catch((e) => toast(e.message, 'err')) } }, icon('folder', 'sm'), 'Открыть папку профиля'),
        h('button.btn.sm', { on: { click: () => api('/api/files/open-folder', { which: 'logs' }).catch((e) => toast(e.message, 'err')) } }, icon('file', 'sm'), 'Открыть журналы'))),
    h('h3', 'Управление'),
    h('div.row',
      h('button.btn', { on: { click: restartApp } }, icon('refresh', 'sm'), 'Перезапустить'),
      h('button.btn.danger', { on: { click: async () => {
        if (!(await confirmDlg({ title: 'Выйти из Звоночка?', text: 'Пока программа выключена, вам не дозвонятся, а сообщения будут ждать у отправителя.', ok: 'Выйти', danger: true }))) return;
        await api('/api/app/quit', {}).catch(() => {});
        document.body.innerHTML = '<div class="fatal"><img src="/icon-192.png" alt=""><h2>Звоночек закрыт</h2><p>Это окно можно закрыть.</p></div>';
        setTimeout(() => window.close(), 400);
      } } }, icon('power', 'sm'), 'Выйти из Звоночка')),
  );
}

// ------------------------------------------------------------------ about

function about(pane) {
  const S = A.S;
  pane.append(
    h('div', { style: { display: 'grid', justifyItems: 'center', gap: '10px', padding: '20px 0 6px', textAlign: 'center' } },
      h('img', { src: '/icon-192.png', alt: '', style: { width: '88px', height: '88px' } }),
      h('div', { style: { fontSize: '22px', fontWeight: 700 } }, 'Звоночек'),
      h('div.muted', `Версия ${S.me.version}`),
      h('div.hint', { style: { maxWidth: '460px' } }, 'P2P-мессенджер для звонков, видео, чата и файлов. Работает без центральных серверов: в локальной сети, через интернет и даже между хостом и виртуальной машиной.')),
    h('h3', 'Что нового в 3.0'),
    h('div.card.pad.col', { style: { gap: '6px' } },
      ...[
        'Новый интерфейс: тёмная и светлая темы, уведомления, перетаскивание файлов, превью картинок.',
        'Видеозвонки и показ экрана; автоматический переход на аудиомост, если прямое соединение невозможно.',
        'Надёжный чат: очередь сообщений до появления собеседника в сети, отметки «доставлено» и «прочитано».',
        'Файлы любого размера с докачкой после обрыва и проверкой SHA-256.',
        'Безопасность: только подтверждённые контакты, коды безопасности, защита локального интерфейса.',
        'Трей, автозапуск, одно окно приложения, собственный relay-сервер для сложных сетей.',
      ].map((t) => h('div.row', { style: { alignItems: 'flex-start' } }, icon('check', 'sm'), h('div', t)))),
  );
}
