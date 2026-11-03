// ZVONochek для ПК — главное окно: звонок по ссылке, свои ссылки (ожидание звонка),
// история, настройки, диагностика. Данные и сеть — в ядре (window.__zvIpc → Rust).
import {
  $,
  $$,
  h,
  icon,
  hydrateIcons,
  call,
  on,
  host,
  applyTheme,
  initials,
  fmtTime,
  fmtDur,
  dayLabel,
  ago,
  toast,
  copyText,
  dialog,
  confirmDialog,
  promptDialog,
  menu,
  qrSvg,
  openCall,
  Ringer,
} from './lib.js';
import { mountIncoming } from './incoming.js';
import {
  C as CT,
  initContacts,
  contactsVisible,
  contactById,
  contactByPeer,
  callContact,
  offerContact,
  addDialog,
} from './contacts.js';

const S = {
  page: 'call',
  settings: {},
  links: [],
  history: [],
  info: {},
  hostInfo: {},
  status: {}, // roomId → HubStatus (комнаты своих ссылок)
  diagTimer: null,
  parsed: null,
};

// ---------- навигация ----------
function go(page) {
  S.page = page;
  for (const b of $$('.nav')) b.classList.toggle('on', b.dataset.page === page);
  for (const p of $$('.page')) p.classList.toggle('hidden', p.id !== 'page-' + page);
  $('.main').scrollTop = 0;
  clearInterval(S.diagTimer);
  contactsVisible(page === 'contacts');
  if (page === 'diag') {
    renderDiag();
    S.diagTimer = setInterval(renderDiag, 2000);
  }
  if (page === 'history') {
    localStorage.zvSeenMissed = String(Date.now());
    renderMissed();
  }
}
for (const b of $$('.nav')) b.addEventListener('click', () => go(b.dataset.page));
$('#sideStatus').addEventListener('click', () => go(S.links.some((l) => l.kind === 'mine') ? 'links' : 'call'));

// ---------- загрузка ----------
async function loadSettings() {
  S.settings = await call('settings_get');
  applyTheme(S.settings.theme);
  renderSettings();
  renderSide();
}
async function loadLinks() {
  S.links = await call('links_list');
  for (const l of S.links) if (l.status) S.status[l.roomId] = l.status;
  renderQuick();
  renderLinks();
  renderSide();
  onDialInput();
}
async function loadHistory() {
  S.history = await call('history_list');
  renderHistory();
  renderMissed();
}

on('links:', () => loadLinks().catch(console.error));
on('history:', () => loadHistory().catch(console.error));
on('settings:', () => loadSettings().catch(console.error));
on('room:status', (_, p) => {
  if (!p || !p.roomId) return;
  S.status[p.roomId] = p.status;
  renderSide();
  if (S.page === 'links') updateLinkStatuses();
});
on('host:', (ev, p) => {
  if (ev === 'host:deeplink' && p && p.url) handleDeepLink(p.url);
  if (ev === 'host:page' && p && p.page) go(p.page);
});

// ---------- состояние ожидания (слева внизу) ----------
const isUp = (st) => !!st && (st.mqttUp + st.nostrUp + st.ntfyUp + (st.p2pUp || 0) > 0 || st.worker === 'up');
function chanSummary(st) {
  if (!st) return 'нет данных';
  const parts = [];
  if (st.mqttTotal) parts.push(`MQTT ${st.mqttUp}/${st.mqttTotal}`);
  if (st.worker && st.worker !== 'off') parts.push(`Worker ${st.worker === 'up' ? '✓' : '…'}`);
  if (st.nostrTotal) parts.push(`Nostr ${st.nostrUp}/${st.nostrTotal}`);
  if (st.ntfyTotal) parts.push(`ntfy ${st.ntfyUp}/${st.ntfyTotal}`);
  if (st.p2pUp) parts.push(`P2P ${st.p2pUp}`);
  return parts.join(' · ');
}
function renderSide() {
  const listen = S.links.filter((l) => l.kind === 'mine' && l.listen);
  const dot = $('#sideDot');
  let cls = 'off';
  let title = 'Ожидание выключено';
  let text = 'Создайте свою ссылку — по ней вам смогут звонить';
  if (listen.length) {
    const up = listen.filter((l) => isUp(S.status[l.roomId])).length;
    if (S.settings.dnd) {
      cls = 'warn';
      title = 'Не беспокоить';
      text = 'входящие попадут в историю без звонка';
    } else if (up === listen.length) {
      cls = 'ok';
      title = 'Ждём звонков';
      text = `${listen.length} ${plural(listen.length, 'ссылка', 'ссылки', 'ссылок')} · на связи`;
    } else if (up > 0) {
      cls = 'warn';
      title = 'Частично на связи';
      text = `${up} из ${listen.length} ссылок подключены`;
    } else {
      cls = 'bad';
      title = 'Нет связи';
      text = 'подключаемся… проверьте интернет';
    }
  } else if (S.links.some((l) => l.kind === 'mine')) {
    text = 'ожидание выключено у всех своих ссылок';
  }
  dot.className = 'dot ' + cls;
  $('#sideTitle').textContent = title;
  $('#sideText').textContent = text;
}
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- звонок по ссылке ----------
const dialInput = $('#dialInput');
const dialBtn = $('#dialBtn');
const dialHint = $('#dialHint');
let parseSeq = 0;
async function onDialInput() {
  const text = dialInput.value.trim();
  const seq = ++parseSeq;
  if (!text) {
    S.parsed = null;
    dialBtn.disabled = true;
    dialHint.textContent = '';
    dialHint.className = 'hint';
    return;
  }
  const r = await call('link_parse', { text });
  if (seq !== parseSeq) return;
  S.parsed = r;
  dialBtn.disabled = r.kind !== 'call' && r.kind !== 'contact';
  dialBtn.lastChild.textContent = r.kind === 'contact' ? 'Добавить' : 'Позвонить';
  let msg = '';
  let cls = 'hint';
  if (r.kind === 'call') {
    const known = S.links.find((l) => l.secret === r.secret);
    cls = 'hint ok';
    msg = known
      ? known.kind === 'mine'
        ? `Это ваша ссылка «${known.name}» — войдёте и будете ждать собеседника`
        : `Сохранённая ссылка «${known.name}»`
      : 'Ссылка на звонок ✓';
  } else if (r.kind === 'contact') {
    const expired = r.expires && r.expires < Date.now();
    cls = expired ? 'hint bad' : 'hint ok';
    msg = expired
      ? 'Код приглашения устарел — попросите новый'
      : `Приглашение в контакты от «${r.name || 'без имени'}» — нажмите «Добавить»`;
    if (expired) dialBtn.disabled = true;
  } else if (r.kind === 'chat') {
    cls = 'hint bad';
    msg = 'Это ссылка на чат — пока откройте её в браузере (чаты появятся в приложении позже)';
  } else if (r.kind === 'link') {
    cls = 'hint bad';
    msg = 'Это ссылка привязки устройства — в приложении пока не поддерживается';
  } else {
    cls = 'hint bad';
    msg = 'Не похоже на ссылку ZVONochek';
  }
  dialHint.textContent = msg;
  dialHint.className = cls;
}
dialInput.addEventListener('input', onDialInput);
dialInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !dialBtn.disabled) dial();
});
dialBtn.addEventListener('click', dial);
async function dial() {
  const r = S.parsed;
  if (r && r.kind === 'contact') {
    const code = dialInput.value.trim();
    dialInput.value = '';
    onDialInput();
    addDialog(code);
    return;
  }
  if (!r || r.kind !== 'call') return;
  let known = S.links.find((l) => l.secret === r.secret);
  try {
    if (!known && $('#dialSave').checked) {
      const name = $('#dialName').value.trim() || `Собеседник ${new Date().toLocaleDateString('ru-RU')}`;
      known = await call('link_save', { secret: r.secret, name });
    }
    if (known) call('link_touch', { id: known.id }).catch(() => {});
    await openCall(r.secret, { dir: 'out' });
    dialInput.value = '';
    $('#dialName').value = '';
    onDialInput();
  } catch (e) {
    toast('Не удалось начать звонок: ' + (e.message || e));
  }
}
function handleDeepLink(url) {
  if (/^zvonochek:\/\/contact/i.test(url) || /^zv4c:/.test(url)) {
    go('contacts');
    addDialog(url);
    return;
  }
  dialInput.value = url;
  go('call');
  onDialInput().then(() => {
    if (S.parsed && S.parsed.kind === 'call') {
      confirmDialog('Позвонить по ссылке?', 'Ссылку открыли в другом приложении или браузере.', 'Позвонить').then(
        (yes) => yes && dial()
      );
    }
  });
}

// ---------- быстрый набор ----------
function renderQuick() {
  const items = [...S.links].sort((a, b) => (b.lastUsed || b.created) - (a.lastUsed || a.created)).slice(0, 8);
  $('#quickTitle').classList.toggle('hidden', !items.length);
  $('#quick').replaceChildren(
    ...items.map((l) =>
      h(
        'button.tile',
        { title: l.kind === 'mine' ? 'Войти и ждать собеседника' : 'Позвонить', onclick: () => callLink(l) },
        h('div.av', initials(l.name)),
        h('div', { style: { minWidth: 0 } }, h('b', l.name), h('small', l.kind === 'mine' ? 'своя ссылка' : ago(l.lastUsed)))
      )
    )
  );
}
async function callLink(l) {
  call('link_touch', { id: l.id }).catch(() => {});
  try {
    await openCall(l.secret, { dir: 'out' });
  } catch (e) {
    toast('Не удалось начать звонок: ' + (e.message || e));
  }
}

// ---------- свои и сохранённые ссылки ----------
function linkState(l) {
  if (l.inCall) return ['accent', 'в звонке'];
  if (l.kind !== 'mine') return null;
  if (!l.listen) return ['', 'ожидание выключено'];
  if (S.settings.dnd) return ['', 'не беспокоить'];
  return isUp(S.status[l.roomId]) ? ['ok', 'ждёт звонка'] : ['bad', 'нет связи'];
}
function linkRow(l) {
  const st = linkState(l);
  const sw = h('input', { type: 'checkbox' });
  sw.checked = !!l.listen;
  sw.addEventListener('change', () => call('link_set_listen', { id: l.id, listen: sw.checked }).catch((e) => toast(e.message)));
  return h(
    'div.item',
    { 'data-link': l.id },
    h('div.av', { class: l.kind === 'mine' ? '' : 'mute' }, initials(l.name)),
    h(
      'div.body',
      h('div.title', l.name),
      h(
        'div.sub',
        st ? h('span.chip', { class: st[0], 'data-st': '1' }, st[1]) : null,
        h('span', l.kind === 'mine' ? `создана ${dayLabel(l.created).toLowerCase()}` : ago(l.lastUsed))
      )
    ),
    h(
      'div.acts',
      l.kind === 'mine' ? h('label.switch', { title: 'Ждать звонков по этой ссылке' }, sw, h('span')) : null,
      h('button.btn.ghost.icon', { title: 'Поделиться', onclick: () => shareDialog(l) }, icon(l.kind === 'mine' ? 'qr' : 'copy')),
      h(
        'button.btn.ghost.icon',
        { title: l.kind === 'mine' ? 'Войти и ждать' : 'Позвонить', onclick: () => callLink(l) },
        icon('phone')
      ),
      h('button.btn.ghost.icon', { title: 'Ещё', onclick: (e) => linkMenu(e.currentTarget, l) }, icon('more'))
    )
  );
}
function renderLinks() {
  const mine = S.links.filter((l) => l.kind === 'mine');
  const saved = S.links.filter((l) => l.kind !== 'mine');
  $('#mineList').replaceChildren(
    ...(mine.length
      ? mine.map(linkRow)
      : [h('div.empty', icon('link'), h('div', 'Своих ссылок пока нет. Создайте — и отправьте собеседнику.'))])
  );
  $('#savedList').replaceChildren(
    ...(saved.length
      ? saved.map(linkRow)
      : [h('div.empty', icon('user'), h('div', 'Сюда попадают ссылки, по которым вы звонили.'))])
  );
}
function updateLinkStatuses() {
  for (const l of S.links) {
    const chip = $(`[data-link="${l.id}"] [data-st]`);
    const st = linkState(l);
    if (chip && st) {
      chip.className = 'chip ' + st[0];
      chip.textContent = st[1];
    }
  }
}
function linkMenu(anchor, l) {
  menu(anchor, [
    { icon: 'copy', label: 'Скопировать ссылку', run: () => copyText(l.url, 'Ссылка скопирована') },
    {
      icon: 'edit',
      label: 'Переименовать',
      run: async () => {
        const n = await promptDialog('Название ссылки', l.name);
        if (n) call('link_rename', { id: l.id, name: n }).catch((e) => toast(e.message));
      },
    },
    l.kind === 'mine' && {
      icon: 'refresh',
      label: 'Новый адрес',
      run: async () => {
        if (
          await confirmDialog(
            'Сменить адрес ссылки?',
            'Старая ссылка перестанет работать — новую нужно будет отправить собеседникам заново.',
            'Сменить'
          )
        ) {
          const nl = await call('link_rotate', { id: l.id });
          shareDialog(nl || l);
        }
      },
    },
    {
      icon: 'trash',
      label: 'Удалить',
      danger: true,
      run: async () => {
        if (
          await confirmDialog(
            `Удалить «${l.name}»?`,
            l.kind === 'mine' ? 'По этой ссылке вам больше не смогут дозвониться.' : 'Ссылка исчезнет из приложения.',
            'Удалить',
            true
          )
        )
          call('link_delete', { id: l.id }).catch((e) => toast(e.message));
      },
    },
  ]);
}
function shareDialog(l) {
  dialog((b, close) => {
    const svg = qrSvg(l.url);
    b.append(
      h('h3', l.name),
      h(
        'p',
        l.kind === 'mine'
          ? 'Отправьте ссылку собеседнику. Он откроет её в браузере или в приложении — у вас зазвонит.'
          : 'Ссылка собеседника.'
      ),
      h(
        'div.linkbox',
        h('span.mono.selectable', l.url),
        h('button.btn.sm.primary', { onclick: () => copyText(l.url, 'Ссылка скопирована') }, icon('copy', 'sm'), 'Копировать')
      ),
      svg ? h('div.qr', { html: svg }) : null,
      h(
        'div.actions',
        h(
          'button.btn.ghost',
          {
            onclick: () => {
              close();
              callLink(l);
            },
          },
          icon('phone', 'sm'),
          l.kind === 'mine' ? 'Войти и ждать' : 'Позвонить'
        ),
        h('button.btn.primary', { onclick: () => close() }, 'Готово')
      )
    );
  });
}
async function newLink() {
  const n = S.links.filter((l) => l.kind === 'mine').length;
  const name = await promptDialog('Новая ссылка', n ? `Моя ссылка ${n + 1}` : 'Моя ссылка', {
    label: 'Название видно только вам — например, «Для семьи» или «Работа».',
    okLabel: 'Создать',
  });
  if (name == null) return;
  try {
    const l = await call('link_create', { name: name || 'Моя ссылка', listen: true });
    shareDialog(l);
  } catch (e) {
    toast('Не удалось создать ссылку: ' + (e.message || e));
  }
}
$('#newLinkBtn').addEventListener('click', newLink);
$('#newLinkBtn2').addEventListener('click', newLink);

// ---------- история ----------
const RESULT = {
  answered: ['ok', 'in', 'Входящий'],
  missed: ['bad', 'in', 'Пропущенный'],
  declined: ['mute', 'in', 'Отклонённый'],
  outgoing: ['', 'out', 'Исходящий'],
  cancelled: ['mute', 'out', 'Без ответа'],
};
// исходящий звонок контакту: итог вызова
const RESULT_OUT = {
  declined: ['mute', 'out', 'Отклонён'],
  noanswer: ['mute', 'out', 'Не ответил(а)'],
};
function renderHistory() {
  const list = $('#histList');
  $('#histClear').classList.toggle('hidden', !S.history.length);
  if (!S.history.length) {
    list.replaceChildren(h('div.empty', icon('clock'), h('div', 'Звонков пока не было.')));
    return;
  }
  const rows = [];
  let day = '';
  for (const e of S.history) {
    const d = dayLabel(e.started);
    if (d !== day) {
      day = d;
      rows.push(h('div.day', d));
    }
    const [cls, ic, label] = (e.dir === 'out' && RESULT_OUT[e.result]) || RESULT[e.result] || ['', e.dir === 'in' ? 'in' : 'out', e.result];
    const link = e.linkId && S.links.find((l) => l.id === e.linkId);
    const ct = (e.contactId && contactById(e.contactId)) || (e.peerId && contactByPeer(e.peerId)) || null;
    const title = (ct && ct.name) || e.peer || (e.dir === 'in' ? 'Неизвестный' : e.linkName || 'Звонок');
    const offer = !ct && e.peerId && CT.p2p.running;
    rows.push(
      h(
        'div.item',
        h('div.av', { class: cls }, icon(ic)),
        h(
          'div.body',
          h('div.title', title),
          h(
            'div.sub',
            h('span', label),
            e.video ? h('span', '· видео') : null,
            ct && e.contactId ? h('span', '· контакт') : e.linkName ? h('span', `· ${e.linkName}`) : null,
            h('span', `· ${fmtTime(e.started)}`),
            e.duration && (e.result === 'answered' || e.result === 'outgoing') ? h('span', `· ${fmtDur(e.duration)}`) : null
          )
        ),
        h(
          'div.acts',
          ct
            ? h('button.btn.ghost.icon', { title: 'Позвонить контакту', onclick: () => callContact(ct, !!e.video) }, icon('phone'))
            : link
              ? h('button.btn.ghost.icon', { title: 'Позвонить', onclick: () => callLink(link) }, icon('phone'))
              : null,
          offer
            ? h(
                'button.btn.ghost.icon',
                { title: 'Добавить в контакты', 'data-act': 'offer', onclick: () => offerContact(e.peerId, e.peer) },
                icon('userplus')
              )
            : null,
          h(
            'button.btn.ghost.icon',
            { title: 'Удалить запись', onclick: () => call('history_delete', { id: e.id }).catch(() => {}) },
            icon('trash')
          )
        )
      )
    );
  }
  list.replaceChildren(...rows);
}
function renderMissed() {
  const seen = Number(localStorage.zvSeenMissed || 0);
  const n = S.history.filter((e) => e.result === 'missed' && e.started > seen).length;
  const c = $('#missedCount');
  c.textContent = String(n);
  c.classList.toggle('hidden', !n || S.page === 'history');
}
$('#histClear').addEventListener('click', async () => {
  if (await confirmDialog('Очистить историю?', 'Все записи о звонках будут удалены.', 'Очистить', true))
    call('history_clear').catch(() => {});
});

// ---------- настройки ----------
const setPatch = (patch) => call('settings_set', { patch }).catch((e) => toast('Не сохранилось: ' + (e.message || e)));
let nameT;
function renderSettings() {
  const s = S.settings;
  if (document.activeElement !== $('#setName')) $('#setName').value = s.name || '';
  $('#setDnd').checked = !!s.dnd;
  $('#setSkip').checked = s.skipPrejoin !== false;
  $('#setVol').value = s.ringVolume ?? 80;
  $('#setVolText').textContent = `${s.ringVolume ?? 80}%`;
  $('#setTray').checked = s.closeToTray !== false;
  $('#setTcp').checked = s.mqttTcp !== false;
  $('#setP2p').checked = s.p2p !== false;
  if (document.activeElement !== $('#setWorker')) $('#setWorker').value = s.workerUrl || '';
  for (const b of $$('#setTheme button')) b.classList.toggle('on', b.dataset.v === (s.theme || 'auto'));
}
$('#setName').addEventListener('input', (e) => {
  clearTimeout(nameT);
  nameT = setTimeout(() => setPatch({ name: e.target.value.trim() }), 400);
});
$('#setDnd').addEventListener('change', (e) => setPatch({ dnd: e.target.checked }));
$('#setSkip').addEventListener('change', (e) => setPatch({ skipPrejoin: e.target.checked }));
$('#setVol').addEventListener('input', (e) => ($('#setVolText').textContent = `${e.target.value}%`));
$('#setVol').addEventListener('change', (e) => setPatch({ ringVolume: Number(e.target.value) }));
const testRinger = new Ringer();
$('#setVolTest').addEventListener('click', () => testRinger.once(Number($('#setVol').value) / 100));
$('#setTray').addEventListener('change', (e) => setPatch({ closeToTray: e.target.checked }));
$('#setTcp').addEventListener('change', (e) => setPatch({ mqttTcp: e.target.checked }));
$('#setP2p').addEventListener('change', async (e) => {
  if (
    !e.target.checked &&
    !(await confirmDialog(
      'Выключить прямые соединения?',
      'Контакты перестанут работать: им нельзя будет позвонить, и они не дозвонятся до вас.',
      'Выключить',
      true
    ))
  ) {
    e.target.checked = true;
    return;
  }
  setPatch({ p2p: e.target.checked });
});
$('#setWorker').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v && !/^https:\/\/[^/\s]+/.test(v)) {
    toast('Адрес Worker должен начинаться с https://');
    return;
  }
  setPatch({ workerUrl: v });
});
for (const b of $$('#setTheme button')) b.addEventListener('click', () => setPatch({ theme: b.dataset.v }));
$('#setAutostart').addEventListener('change', async (e) => {
  try {
    await call('host_autostart_set', { enabled: e.target.checked });
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast('Не удалось: ' + (err.message || err));
  }
});
$('#updBtn').addEventListener('click', async () => {
  const btn = $('#updBtn');
  btn.disabled = true;
  try {
    const r = await call('host_update_check');
    if (!r || !r.available) toast('Установлена последняя версия');
    else if (
      await confirmDialog(`Доступна версия ${r.version}`, r.notes || 'Установить обновление сейчас? Приложение перезапустится.', 'Обновить')
    ) {
      toast('Загрузка обновления…', 60000);
      await call('host_update_install');
    }
  } catch (e) {
    toast(host === 'tauri' ? 'Проверка не удалась: ' + (e.message || e) : 'Обновления — в установленном приложении');
  } finally {
    btn.disabled = false;
  }
});
$('#licBtn').addEventListener('click', () => {
  dialog((b, close) => {
    b.style.width = 'min(760px, calc(100vw - 40px))';
    b.append(
      h('h3', 'Лицензии'),
      h('iframe', {
        src: 'licenses.html',
        style: { width: '100%', height: '60vh', border: '1px solid var(--line-2)', borderRadius: '10px', background: '#fff' },
      }),
      h('div.actions', h('button.btn.primary', { onclick: () => close() }, 'Закрыть'))
    );
  });
});

// ---------- диагностика ----------
let lastDiag = null;
async function renderDiag() {
  let d;
  try {
    d = await call('diag_snapshot');
  } catch (e) {
    $('#diagBody').replaceChildren(h('div.empty', 'Нет данных: ' + (e.message || e)));
    return;
  }
  lastDiag = d;
  if (S.page !== 'diag') return;
  const rooms = d.rooms || [];
  rooms.sort((a, b) => (b.joined ? 1 : 0) - (a.joined ? 1 : 0));
  $('#diagBody').replaceChildren(
    diagP2p(d.p2p || {}),
    ...(rooms.length
      ? []
      : [h('div.empty', icon('pulse'), h('div', 'Нет активных комнат. Создайте свою ссылку или начните звонок.'))]),
    ...rooms.map((r) =>
      h(
        'div.card.diag-room',
        h(
          'div.row',
          h('h3.grow', { style: { margin: 0 } }, r.joined ? 'Звонок' : r.link ? `Ожидание: ${r.link}` : 'Комната'),
          h('span.chip', { class: r.joined ? 'accent' : '' }, r.joined ? 'в звонке' : 'ожидание'),
          h('span.chip.mono', r.room)
        ),
        h('div.muted', { style: { marginTop: '4px' } }, chanSummary(r.status)),
        h(
          'div.chan-grid',
          ...(r.channels || []).map((c) => {
            const cls = c.state === 'up' ? 'ok' : c.state === 'connecting' || c.state === 'polling' ? 'warn' : c.state === 'off' ? 'off' : 'bad';
            const meta = [
              c.transport && c.state === 'up' ? c.transport.toUpperCase() : c.state,
              c.connectMs != null ? `${c.connectMs} мс` : null,
              `↑${c.tx} ↓${c.rx}`,
              c.renewals ? `ротаций ${c.renewals}` : null,
              c.http ? `HTTP ${c.http}` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return h(
              'div.chan',
              h('div.nm', h('span.dot', { class: cls }), `${c.kind} · ${c.name}`),
              h('div.meta', meta),
              c.lastError && c.state !== 'up' ? h('div.meta', { style: { color: 'var(--bad)' } }, c.lastError) : null
            );
          })
        )
      )
    )
  );
}
function diagP2p(p) {
  const relay = (p.relays || [])[0];
  const state = !p.enabled ? ['off', 'выключен'] : p.running ? ['ok', 'работает'] : ['warn', 'запускается'];
  const names = new Map(CT.list.map((c) => [c.peer.slice(0, 12), c.name]));
  return h(
    'div.card.diag-p2p',
    h(
      'div.row',
      h('h3.grow', { style: { margin: 0 } }, 'Прямые соединения (P2P)'),
      h('span.chip', { class: state[0] === 'ok' ? 'ok' : '' }, state[1]),
      p.id ? h('span.chip.mono', { title: 'ID устройства (открытый ключ)' }, p.id.slice(0, 12)) : null
    ),
    p.running
      ? h(
          'div.muted',
          { style: { marginTop: '4px' } },
          [
            relay ? `ретранслятор ${relay.url.replace(/^https?:\/\//, '').replace(/\/$/, '')} ${relay.connected ? '✓' : '…'}` : 'без ретранслятора',
            `адресов ${((p.addr && p.addr.a) || []).length}`,
            `соединений ${(p.links || []).length}`,
          ].join(' · ')
        )
      : null,
    (p.links || []).length
      ? h(
          'div.links',
          ...p.links.map((l) => {
            const bound = (p.bound || []).find((b) => b.link === l.link);
            return h(
              'div.lk',
              h('span.dot', { class: l.path === 'direct' ? 'ok' : l.path === 'relay' ? 'warn' : 'bad' }),
              h('b', names.get(l.peer) || l.name || l.peer),
              h('span.muted', l.path === 'direct' ? 'напрямую' : l.path === 'relay' ? 'через ретранслятор' : 'нет пути'),
              l.rttMs != null ? h('span.muted', `${l.rttMs} мс`) : null,
              h('span.muted', l.outbound ? 'исходящее' : 'входящее'),
              bound && bound.rooms.length ? h('span.chip.accent', `комнат ${bound.rooms.length}`) : null,
              h('span.muted', `↑${l.tx} ↓${l.rx}`)
            );
          })
        )
      : null
  );
}
$('#diagCopy').addEventListener('click', async () => {
  const d = lastDiag || (await call('diag_snapshot').catch(() => null));
  const report = {
    app: S.info,
    host: S.hostInfo,
    ua: navigator.userAgent,
    time: new Date().toISOString(),
    diag: d,
  };
  copyText(JSON.stringify(report, null, 2), 'Отчёт скопирован');
});

// ---------- первый запуск ----------
function onboarding() {
  dialog(
    (b, close) => {
      const nm = h('input.field', { placeholder: 'Как вас называть в звонках', maxlength: 40, value: S.settings.name || '' });
      const auto = h('input', { type: 'checkbox' });
      auto.checked = true;
      const mk = h('input', { type: 'checkbox' });
      mk.checked = !S.links.some((l) => l.kind === 'mine');
      b.append(
        h('div', { style: { textAlign: 'center' } }, h('img', { src: 'icon.svg', style: { width: '64px', height: '64px' } })),
        h('h3', { style: { textAlign: 'center' } }, 'Добро пожаловать в ZVONochek'),
        h(
          'p',
          { style: { textAlign: 'center' } },
          'Звонки по ссылке: отправьте свою ссылку собеседнику — и он дозвонится, даже когда окно приложения закрыто.'
        ),
        nm,
        h(
          'div',
          { style: { marginTop: '14px', display: 'grid', gap: '10px' } },
          S.hostInfo.autostart !== false
            ? h('label.row', { style: { cursor: 'pointer' } }, h('span.switch', auto, h('span')), 'Запускать вместе с Windows')
            : null,
          h('label.row', { style: { cursor: 'pointer' } }, h('span.switch', mk, h('span')), 'Создать мою ссылку для звонков')
        ),
        h(
          'div.actions',
          h(
            'button.btn.primary.lg',
            {
              onclick: async () => {
                close(true);
                await setPatch({ name: nm.value.trim(), onboarded: true });
                if (S.hostInfo.autostart !== false) call('host_autostart_set', { enabled: auto.checked }).catch(() => {});
                if (mk.checked) {
                  const l = await call('link_create', { name: 'Моя ссылка', listen: true }).catch(() => null);
                  if (l) shareDialog(l);
                }
              },
            },
            'Начать'
          )
        )
      );
    },
    {
      onClose: (v) => {
        if (!v) setPatch({ onboarded: true });
      },
    }
  );
}

// ---------- старт ----------
async function start() {
  hydrateIcons();
  try {
    S.hostInfo = (await call('host_info')) || {};
  } catch {
    S.hostInfo = {};
  }
  S.info = await call('app_info');
  $('#brandVer').textContent = `версия ${S.info.version}`;
  $('#aboutVer').textContent = `Версия ${S.info.version} · ${S.info.platform}${S.info.protected ? ' · данные защищены DPAPI' : ''}`;
  $('#aboutWeb').textContent = `Веб-клиент v${S.info.webVersion}`;
  await Promise.all([loadSettings(), loadLinks(), loadHistory()]);
  await initContacts({
    onChange: () => {
      const n = CT.offers.length;
      $('#offerCount').textContent = String(n);
      $('#offerCount').classList.toggle('hidden', !n);
      renderHistory();
    },
  }).catch(console.error);
  // автозапуск — только там, где хост умеет
  try {
    const a = await call('host_autostart_get');
    $('#setAutostart').checked = !!(a && a.enabled);
  } catch {
    $('#rowAutostart').classList.add('hidden');
    S.hostInfo.autostart = false;
  }
  // входящие поверх окна — если у хоста нет отдельного всплывающего окна
  if (!S.hostInfo.incomingWindow) mountIncoming($('#incOverlay'));
  if (!S.settings.onboarded) onboarding();
  if (S.hostInfo.pendingUrl) handleDeepLink(S.hostInfo.pendingUrl);
}
start().catch((e) => {
  console.error(e);
  toast('Ошибка запуска: ' + (e.message || e), 8000);
});
