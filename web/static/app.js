// Звоночек 3 — main UI module.
import {
  h, icon, api, upload, toast, avatar, menu, modal, confirmDlg, promptDlg, copyText, debounce, linkify, isEmojiOnly,
  fmtTime, fmtDay, dayKey, fmtListTime, fmtAgo, fmtSize, fmtDur, extOf, IMG_EXT, AUDIO_EXT, VIDEO_EXT, shortId,
  fmtSafety, clear, hooks, plural,
} from './lib.js';
import * as Calls from './call.js';
import { tones, setOutputDevice } from './audio.js';
import { openSettings } from './settings.js';

export const S = {
  me: null,
  settings: null,
  net: null,
  relays: [],
  ice: [],
  contacts: new Map(),
  pairReqs: [],
  nearby: [],
  active: null,
  chats: new Map(),
  typing: new Map(),
  progress: new Map(),
  drafts: new Map(),
  uploads: new Map(),
  search: '',
  ws: null,
  wsUp: false,
  wsFails: 0,
  synced: false,
  superseded: false,
};

const E = {}; // persistent elements
const enc = encodeURIComponent;

// ------------------------------------------------------------------ helpers

export function displayName(peer) {
  const c = S.contacts.get(peer);
  if (c) return c.display || c.name || shortId(peer);
  const r = S.pairReqs.find((p) => p.peer_id === peer);
  if (r && r.nick) return r.nick;
  return shortId(peer);
}

function wsSend(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

export async function saveUI(patch) {
  S.settings.ui = { ...(S.settings.ui || {}), ...patch };
  try {
    const r = await api('/api/settings', { ui: patch });
    S.settings = r.settings;
  } catch (e) {
    toast(e.message, 'err');
  }
}

export function applyTheme() {
  const t = (S.settings && S.settings.ui && S.settings.ui.theme) || localStorage.getItem('zv.theme') || 'system';
  localStorage.setItem('zv.theme', t);
  const eff = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
  document.documentElement.setAttribute('data-theme', eff);
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

function fatal(title, text, retry) {
  const el = h('div.fatal', h('img', { src: '/icon-192.png', alt: '' }), h('h2', title), h('p', text),
    retry ? h('button.btn.primary', { on: { click: () => location.reload() } }, 'Обновить') : null);
  document.body.appendChild(el);
}

hooks.unauthorized = () => {
  if (document.querySelector('.fatal')) return;
  fatal('Сессия устарела', 'Откройте Звоночек заново через ярлык на рабочем столе или значок в трее — окно подключится автоматически.');
};

// ------------------------------------------------------------------ boot

async function boot() {
  let b;
  try {
    b = await api('/api/bootstrap');
  } catch (e) {
    if (e.status !== 401) fatal('Нет связи с Звоночком', 'Программа не отвечает. Убедитесь, что Звоночек запущен (значок в трее), и обновите окно.', true);
    return;
  }
  applyBootstrap(b);
  applyTheme();
  tones.enabled = (S.settings.ui || {}).sounds !== '0';
  setOutputDevice((S.settings.ui || {}).spk || '');
  buildLayout();
  Calls.initCalls(appApi);
  if (b.call) Calls.onCallEvent(b.call);
  const last = localStorage.getItem('zv.last');
  if (last && S.contacts.has(last)) openChat(last);
  else renderMain();
  connectWS();
  askNotifyPermissionLater();
  setInterval(() => { renderSidebarSoon(); if (S.active) renderHeader(); }, 30000);
}

function applyBootstrap(b) {
  S.me = b.me;
  S.settings = b.settings;
  S.net = b.net;
  S.relays = b.relays || [];
  S.ice = b.ice || [];
  S.pairReqs = b.pair_requests || [];
  S.nearby = b.nearby || [];
  S.contacts = new Map((b.contacts || []).map((c) => [c.peer_id, c]));
}

async function resync() {
  try {
    const b = await api('/api/bootstrap');
    applyBootstrap(b);
    renderSidebar();
    if (S.active && !S.contacts.has(S.active)) S.active = null;
    if (S.active) {
      S.chats.delete(S.active);
      await loadChat(S.active);
      renderHeader();
      renderBanner();
      renderMessages();
      scrollBottom(true);
    } else renderMain();
    Calls.onCallEvent(b.call || null);
  } catch (e) { /* reconnect will retry */ }
}

function connectWS() {
  if (S.superseded) return;
  const ws = new WebSocket(`ws://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.wsUp = true;
    S.wsFails = 0;
    E.connbar.classList.add('hidden');
    if (S.synced) resync();
    S.synced = true;
  };
  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (err) { return; }
    try { onEvent(ev); } catch (err) { console.error('event', ev && ev.type, err); }
  };
  ws.onclose = () => {
    S.wsUp = false;
    if (S.superseded) return;
    E.connbar.classList.remove('hidden');
    const delay = Math.min(5000, 300 * 2 ** S.wsFails++);
    setTimeout(connectWS, delay);
  };
}

setInterval(() => wsSend({ type: 'ping' }), 20000);

function onEvent(ev) {
  const d = ev.data;
  switch (ev.type) {
    case 'ready':
    case 'pong':
      break;
    case 'superseded':
      S.superseded = true;
      Calls.shutdownCall();
      try { S.ws.close(); } catch (e) { /* ignore */ }
      fatal('Звоночек открыт в другом окне', 'Это окно больше не используется — его можно закрыть.');
      setTimeout(() => window.close(), 300);
      break;
    case 'message': onMessage(d); break;
    case 'message_deleted': removeMessage(d.peer, d.id); break;
    case 'history_cleared': {
      S.chats.delete(d.peer);
      if (S.active === d.peer) { loadChat(d.peer).then(() => renderMessages()); }
      break;
    }
    case 'contact': upsertContact(d); break;
    case 'contact_removed':
      S.contacts.delete(d.peer);
      S.chats.delete(d.peer);
      if (S.active === d.peer) { S.active = null; renderMain(); }
      renderSidebarSoon();
      break;
    case 'contact_rejected': renderSidebarSoon(); break;
    case 'pair_requests': S.pairReqs = d || []; renderSidebarSoon(); updateTitle(); break;
    case 'nearby': S.nearby = d || []; renderSidebarSoon(); break;
    case 'net': S.net = d; renderSidebarSoon(); break;
    case 'toast': toast(d.text, { ok: 'ok', warn: 'warn', err: 'err' }[d.kind] || 'info'); break;
    case 'notify': onNotify(d); break;
    case 'typing': onTyping(d.peer); break;
    case 'file_progress': onProgress(d); break;
    case 'call': Calls.onCallEvent(d); break;
    case 'rtc': Calls.onRTC(d); break;
    default: break;
  }
}

// ------------------------------------------------------------------ layout

function buildLayout() {
  const app = clear(document.getElementById('app'));
  E.sbHead = h('div.sb-head');
  E.search = h('input.input', { type: 'search', placeholder: 'Поиск', spellcheck: false });
  E.search.addEventListener('input', () => { S.search = E.search.value.trim().toLowerCase(); renderSidebar(); });
  E.sbList = h('div.sb-list');
  E.sidebar = h('aside.sidebar', E.sbHead, h('div.sb-search', icon('search', 'sm'), E.search), E.sbList);
  E.main = h('main.main');
  E.connbar = h('div.connbar.hidden', h('div', 'Нет связи с программой Звоночек — переподключаюсь…'));
  E.layout = h('div.layout', E.sidebar, E.main);
  app.appendChild(E.layout);
  document.body.appendChild(E.connbar);
  renderSidebar();
  setupDrop();
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); E.search.focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); openAddContact(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(appApi); }
  });
  window.addEventListener('focus', () => { markReadSoon(); stopTitleFlash(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) markReadSoon(); });
}

// ------------------------------------------------------------------ sidebar

function netState() {
  const n = S.net || {};
  if (!S.wsUp && S.synced) return ['bad', 'Нет связи с программой'];
  if (n.internet && (n.dht_peers > 0 || (n.public_addrs || []).length || (n.relay_addrs || []).length)) {
    const how = n.reachability === 'public' ? 'прямой доступ' : (n.relay_addrs || []).length ? 'через relay' : 'за NAT';
    return ['ok', `В сети · ${how}`];
  }
  if (n.internet) return ['warn', 'Подключение к сети…'];
  if (n.lan) return ['ok', 'Только локальная сеть'];
  return ['warn', 'Поиск отключён'];
}

let sbRaf = 0;
function renderSidebarSoon() {
  if (sbRaf) return;
  sbRaf = requestAnimationFrame(() => { sbRaf = 0; renderSidebar(); updateTitle(); });
}

function renderSidebar() {
  const [cls, text] = netState();
  clear(E.sbHead).append(
    h('div.sb-me', { title: 'Настройки профиля', on: { click: () => openSettings(appApi, 'profile') } },
      h('div.row', avatar(S.me.peer_id, S.me.nick, 's40'),
        h('div.grow', h('div.name.ellipsis', S.me.nick || 'Я'), h('div.netline', h('i.dot.' + cls), h('span.ellipsis', text))))),
    h('button.ibtn', { title: 'Добавить контакт (Ctrl+N)', on: { click: () => openAddContact() } }, icon('userPlus')),
    h('button.ibtn', { title: 'Настройки (Ctrl+,)', on: { click: () => openSettings(appApi) } }, icon('settings')),
  );
  const list = clear(E.sbList);
  const q = S.search;
  const match = (...xs) => !q || xs.some((x) => x && String(x).toLowerCase().includes(q));

  if (S.pairReqs.length && !q) {
    list.appendChild(h('div.sb-section', 'Запросы в контакты', h('span.count', S.pairReqs.length)));
    for (const r of S.pairReqs) list.appendChild(pairReqItem(r));
  }
  const contacts = [...S.contacts.values()].filter((c) => c.state !== 'blocked' && match(c.display, c.name, c.alias, c.peer_id));
  contacts.sort((a, b) => lastActivity(b) - lastActivity(a));
  const nearby = S.nearby.filter((n) => !S.contacts.has(n.peer_id) && match(n.nick, n.peer_id));
  if (contacts.length) {
    if (S.pairReqs.length || nearby.length) list.appendChild(h('div.sb-section', 'Чаты'));
    for (const c of contacts) list.appendChild(contactItem(c));
  } else if (!q) {
    list.appendChild(h('div.sb-empty',
      h('div', 'Контактов пока нет.'),
      h('div', 'Обменяйтесь кодами приглашения с собеседником — и можно общаться.'),
      h('button.btn.primary', { on: { click: () => openAddContact() } }, icon('userPlus', 'sm'), 'Добавить контакт')));
  } else {
    list.appendChild(h('div.sb-empty', 'Ничего не найдено'));
  }
  if (nearby.length) {
    list.appendChild(h('div.sb-section', 'Рядом', h('span.count', nearby.length)));
    for (const n of nearby) list.appendChild(nearbyItem(n));
  }
}

function lastActivity(c) {
  const l = c.summary && c.summary.last;
  return Math.max(l ? l.ts : 0, c.added_at || 0);
}

function previewText(c) {
  if (S.typing.has(c.peer_id)) return h('span', { style: { color: 'var(--accent)' } }, 'печатает…');
  if (c.state === 'outgoing') return h('span', 'Ожидает подтверждения');
  const m = c.summary && c.summary.last;
  if (!m) return h('span.dim', c.presence && c.presence.online ? 'в сети' : 'Нет сообщений');
  const you = m.out ? h('span.you', 'Вы: ') : null;
  if (m.kind === 'file') return h('span', you, icon('clip', 'xs'), (m.file && m.file.name) || 'Файл');
  if (m.kind === 'call') return h('span', icon(m.call && m.call.result === 'missed' && !m.out ? 'phoneMissed' : 'phone', 'xs'), callTitle(m));
  if (m.kind === 'system') return h('span.dim', m.text);
  return h('span', you, (m.text || '').replace(/\s+/g, ' ').slice(0, 120));
}

function contactItem(c) {
  const unread = (c.summary && c.summary.unread) || 0;
  const last = c.summary && c.summary.last;
  const el = h('div.citem' + (S.active === c.peer_id ? '.active' : ''), {
    on: {
      click: () => openChat(c.peer_id),
      contextmenu: (e) => { e.preventDefault(); contactMenu(e, c.peer_id); },
    },
  },
  avatar(c.peer_id, c.display, '', c.presence),
  h('div.body',
    h('div.l1', h('span.nm', c.display), c.verified ? h('span.verified', { title: 'Код безопасности проверен' }, icon('shieldCheck', 'xs')) : null,
      c.muted ? h('span.dim', { title: 'Без звука' }, icon('bellOff', 'xs')) : null,
      h('span.tm', last ? fmtListTime(last.ts) : '')),
    h('div.l2', h('span.pv', previewText(c)),
      c.state === 'outgoing' ? h('span.tag', 'запрос') : null,
      unread ? h('span.unread' + (c.muted ? '.muted' : ''), unread > 99 ? '99+' : unread) : null)));
  return el;
}

function pairReqItem(r) {
  return h('div.req',
    h('div.row', avatar(r.peer_id, r.nick, 's40'),
      h('div.grow', h('div.ellipsis', r.nick || shortId(r.peer_id)),
        h('div.hint', r.via === 'lan' ? 'из локальной сети' : 'хочет добавить вас в контакты'))),
    h('div.hint', 'Код безопасности: ', h('span.mono', fmtSafety(r.safety_code))),
    h('div.row',
      h('button.btn.primary.sm', { style: { flex: 1 }, on: { click: (e) => respondPair(r.peer_id, true, e.currentTarget) } }, icon('check', 'sm'), 'Принять'),
      h('button.btn.sm', { style: { flex: 1 }, on: { click: (e) => respondPair(r.peer_id, false, e.currentTarget) } }, 'Отклонить')));
}

async function respondPair(peer, accept, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/pair/respond', { peer, accept });
    S.pairReqs = S.pairReqs.filter((p) => p.peer_id !== peer);
    if (accept && r.contact) { upsertContact(r.contact); openChat(peer); }
    renderSidebarSoon();
  } catch (e) {
    toast(e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

function nearbyItem(n) {
  return h('div.citem', { title: n.peer_id },
    h('div.avatar', { style: { background: 'var(--panel-2)', color: 'var(--text-2)' } }, icon('laptop')),
    h('div.body', h('div.l1', h('span.nm', n.nick || shortId(n.peer_id))),
      h('div.l2', h('span.pv', n.via === 'vm' ? 'виртуальная машина / хост' : 'в этой локальной сети'))),
    h('button.btn.sm', { on: { click: async (e) => {
      e.stopPropagation();
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const r = await api('/api/contacts/add', { input: n.peer_id });
        upsertContact(r.contact);
        toast(`Запрос отправлен. ${n.nick || 'Собеседник'} увидит его и сможет принять.`, 'ok');
        openChat(n.peer_id);
      } catch (err) {
        toast(err.message, 'err');
        b.disabled = false;
      }
    } } }, icon('plus', 'sm'), 'Добавить'));
}

function upsertContact(c) {
  const prev = S.contacts.get(c.peer_id);
  S.contacts.set(c.peer_id, c);
  renderSidebarSoon();
  if (S.active === c.peer_id) {
    renderHeader();
    if (!prev || prev.state !== c.state) { renderBanner(); renderComposerState(); }
  }
}

function updateTitle() {
  let n = 0;
  for (const c of S.contacts.values()) if (!c.muted && c.state !== 'blocked') n += (c.summary && c.summary.unread) || 0;
  n += S.pairReqs.length;
  if (!flashTimer) document.title = (n ? `(${n}) ` : '') + 'Звоночек';
}

// ------------------------------------------------------------------ chat

function chatState(peer) {
  let cs = S.chats.get(peer);
  if (!cs) { cs = { list: [], byId: new Map(), all: false, loaded: false }; S.chats.set(peer, cs); }
  return cs;
}

async function loadChat(peer) {
  const cs = chatState(peer);
  if (cs.loaded) return cs;
  const r = await api(`/api/messages?peer=${enc(peer)}&limit=150`);
  cs.list = r.messages || [];
  cs.byId = new Map(cs.list.map((m) => [m.id, m]));
  cs.all = cs.list.length < 150;
  cs.loaded = true;
  return cs;
}

export async function openChat(peer) {
  if (!S.contacts.has(peer)) return;
  if (S.active && E.input) S.drafts.set(S.active, E.input.value);
  S.active = peer;
  localStorage.setItem('zv.last', peer);
  E.layout.classList.add('has-chat');
  renderSidebarSoon();
  buildChat();
  try {
    await loadChat(peer);
  } catch (e) {
    toast(e.message, 'err');
  }
  if (S.active !== peer) return;
  renderMessages();
  scrollBottom(true);
  markReadSoon();
  if (E.input && !Calls.currentCall()) E.input.focus();
}

// closeChat returns to the chat list (used by the narrow-window layout).
function closeChat() {
  if (S.active && E.input) S.drafts.set(S.active, E.input.value);
  S.active = null;
  localStorage.removeItem('zv.last');
  renderMain();
  renderSidebarSoon();
}

function renderMain() {
  if (S.active) return;
  E.layout.classList.remove('has-chat');
  const main = clear(E.main);
  if (E.ro) { E.ro.disconnect(); E.ro = null; }
  E.msgs = E.input = null;
  const hasContacts = [...S.contacts.values()].some((c) => c.state !== 'blocked');
  main.appendChild(h('div.empty',
    h('img', { src: '/icon-512.png', alt: '' }),
    h('h1', hasContacts ? 'Выберите чат' : 'Добро пожаловать в Звоночек'),
    h('p', 'Звонки, видео, чат и файлы — напрямую между компьютерами. Без серверов, регистрации и номеров телефона.'),
    h('div.row',
      h('button.btn.primary.lg', { on: { click: () => openAddContact('add') } }, icon('userPlus'), 'Добавить контакт'),
      h('button.btn.lg', { on: { click: () => openAddContact('mine') } }, icon('link'), 'Мой код приглашения')),
    h('div.feature-grid',
      feature('lock', 'Шифрование', 'Всё идёт напрямую и зашифровано: Noise/TLS для чата и файлов, DTLS-SRTP для звонков.'),
      feature('wifi', 'Работает в локальной сети', 'Компьютеры в одной сети находят друг друга сами — интернет не обязателен.'),
      feature('download', 'Файлы без ограничений', 'Передача с докачкой и проверкой целостности SHA-256.'))));
  Calls.render();
}

function feature(ic, title, text) {
  return h('div.feature', icon(ic), h('b', title), h('span', text));
}

function buildChat() {
  const peer = S.active;
  const main = clear(E.main);
  E.head = h('header.chat-head');
  E.banner = h('div');
  E.msgsInner = h('div.msgs-inner');
  E.msgs = h('div.msgs', E.msgsInner);
  E.msgMap = new Map();
  E.jump = h('button.jump.hidden', { title: 'К последним сообщениям', on: { click: () => scrollBottom(true) } }, icon('arrowDown'));
  E.msgs.addEventListener('scroll', onScroll, { passive: true });
  // keep the view pinned to the newest message while content grows
  // (images and media finish loading after the first layout)
  S.stick = true;
  if (E.ro) E.ro.disconnect();
  E.ro = new ResizeObserver(() => { if (S.stick && E.msgs) E.msgs.scrollTop = E.msgs.scrollHeight; });
  E.ro.observe(E.msgsInner);
  E.input = h('textarea', { rows: 1, placeholder: 'Сообщение', spellcheck: true, maxLength: 16000 });
  E.input.value = S.drafts.get(peer) || '';
  E.input.addEventListener('input', onInput);
  E.input.addEventListener('keydown', onKey);
  E.input.addEventListener('paste', onPaste);
  E.file = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
  E.file.addEventListener('change', () => { for (const f of E.file.files) sendFile(f); E.file.value = ''; });
  E.sendBtn = h('button.send', { title: 'Отправить (Enter)', on: { click: sendText } }, icon('send'));
  E.composer = h('div.composer', h('div.composer-inner',
    h('button.ibtn', { title: 'Отправить файл', on: { click: () => E.file.click() } }, icon('clip')),
    E.input, E.sendBtn), E.file);
  E.drop = h('div.dropzone.hidden', icon('download', 'lg'), 'Отпустите файлы, чтобы отправить');
  main.append(E.head, E.banner, E.msgs, E.jump, E.composer, E.drop);
  renderHeader();
  renderBanner();
  renderComposerState();
  autosize();
  renderCallBar();
}

function presenceLine(c) {
  if (S.typing.has(c.peer_id)) return h('div.st.typing', h('span.typing-dots', h('i'), h('i'), h('i')), 'печатает');
  if (c.state === 'outgoing') return h('div.st', 'ожидает подтверждения запроса');
  if (c.state === 'blocked') return h('div.st', 'заблокирован');
  const p = c.presence || {};
  if (p.online) {
    const how = p.conn === 'relay' ? 'через relay' : p.lan ? 'локальная сеть' : 'напрямую';
    return h('div.st.on', 'в сети', h('span.chip' + (p.conn === 'relay' ? '.warn' : '.ok'), how + (p.rtt ? ` · ${p.rtt} мс` : '')));
  }
  return h('div.st', fmtAgo(c.last_seen));
}

function renderHeader() {
  if (!E.head || !S.active) return;
  const c = S.contacts.get(S.active);
  if (!c) return;
  const ok = c.state === 'accepted';
  clear(E.head).append(
    h('button.ibtn.back', { title: 'К списку чатов', on: { click: closeChat } }, icon('arrowLeft')),
    avatar(c.peer_id, c.display, 's40', c.presence),
    h('div.who', { on: { click: () => openContactInfo(c.peer_id) } },
      h('div.nm', h('span.ellipsis', c.display),
        c.verified ? h('span.verified', { title: 'Код безопасности проверен' }, icon('shieldCheck', 'sm')) : null),
      presenceLine(c)),
    h('button.ibtn', { title: 'Аудиозвонок', disabled: !ok, on: { click: () => Calls.startCall(c.peer_id, false) } }, icon('phone')),
    h('button.ibtn', { title: 'Видеозвонок', disabled: !ok, on: { click: () => Calls.startCall(c.peer_id, true) } }, icon('video')),
    h('button.ibtn', { title: 'Информация о контакте', on: { click: () => openContactInfo(c.peer_id) } }, icon('info')),
    h('button.ibtn', { title: 'Ещё', on: { click: (e) => { e.stopPropagation(); contactMenu(e, c.peer_id); } } }, icon('more')),
  );
}

function renderBanner() {
  if (!E.banner || !S.active) return;
  const c = S.contacts.get(S.active);
  clear(E.banner);
  if (!c) return;
  if (c.state === 'outgoing') {
    E.banner.appendChild(h('div.banner.accent', icon('clock'),
      h('div.grow', `Запрос отправлен. Когда ${c.display} подтвердит его (или откроет Звоночек, если сейчас не в сети), можно будет переписываться и звонить.`),
      h('button.btn.sm', { on: { click: () => removeContact(c.peer_id, true) } }, 'Отменить')));
  } else if (c.state === 'blocked') {
    E.banner.appendChild(h('div.banner.warn', icon('ban'), h('div.grow', 'Контакт заблокирован: сообщения и звонки от него не принимаются.'),
      h('button.btn.sm', { on: { click: () => unblock(c.peer_id) } }, 'Разблокировать')));
  }
}

function renderComposerState() {
  if (!E.composer) return;
  const c = S.contacts.get(S.active);
  const ok = c && c.state === 'accepted';
  E.composer.classList.toggle('locked', !ok);
  E.input.disabled = !ok;
  E.input.placeholder = ok ? 'Сообщение' : 'Отправка станет доступна после подтверждения';
  updateSendBtn();
}

function updateSendBtn() {
  if (E.sendBtn) E.sendBtn.disabled = !E.input.value.trim();
}

function autosize() {
  const t = E.input;
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}

let lastTyping = 0;
function onInput() {
  autosize();
  updateSendBtn();
  const now = Date.now();
  if (E.input.value && now - lastTyping > 3000) {
    lastTyping = now;
    wsSend({ type: 'typing', peer: S.active });
  }
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
    e.preventDefault();
    sendText();
  }
}

function onPaste(e) {
  const files = [...(e.clipboardData && e.clipboardData.files ? e.clipboardData.files : [])];
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) {
    let file = f;
    if (!f.name || f.name === 'image.png') {
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      file = new File([f], `Изображение ${stamp}.${ext}`, { type: f.type });
    }
    sendFile(file);
  }
}

async function sendText() {
  const peer = S.active;
  const text = E.input.value;
  if (!text.trim() || !peer) return;
  E.input.value = '';
  S.drafts.delete(peer);
  autosize();
  updateSendBtn();
  lastTyping = 0;
  try {
    const m = await api('/api/messages/send', { peer, text });
    onMessage(m, true);
    scrollBottom(true);
  } catch (e) {
    toast(e.message, 'err');
    if (S.active === peer && !E.input.value) { E.input.value = text; autosize(); updateSendBtn(); }
  }
}

async function sendFile(file) {
  const peer = S.active;
  const c = S.contacts.get(peer);
  if (!c || c.state !== 'accepted') { toast('Файлы можно отправлять только подтверждённым контактам', 'warn'); return; }
  const key = Math.random().toString(36).slice(2);
  const item = { peer, name: file.name, size: file.size, done: 0 };
  S.uploads.set(key, item);
  renderUploads();
  scrollBottom(true);
  try {
    const m = await upload(peer, file, (done) => { item.done = done; updateUpload(key); });
    S.uploads.delete(key);
    renderUploads();
    onMessage(m, true);
  } catch (e) {
    S.uploads.delete(key);
    renderUploads();
    toast(`${file.name}: ${e.message}`, 'err');
  }
}

function renderUploads() {
  if (!E.msgsInner) return;
  for (const el of E.msgsInner.querySelectorAll('.m.uploading')) el.remove();
  for (const [key, u] of S.uploads) {
    if (u.peer !== S.active) continue;
    const pct = u.size ? Math.round((100 * u.done) / u.size) : 0;
    E.msgsInner.appendChild(h('div.m.out.uploading', { dataset: { up: key } }, h('div.mcol', h('div.bubble',
      h('div.file', h('div.ficon', (extOf(u.name) || 'file').slice(0, 4).toUpperCase()),
        h('div.grow', h('div.fname', u.name), h('div.fsub', h('span.upl', `Подготовка… ${pct}%`), fmtSize(u.size)),
          h('div.prog', h('i', { style: { width: pct + '%' } }))))))));
  }
}

function updateUpload(key) {
  const u = S.uploads.get(key);
  const el = E.msgsInner && E.msgsInner.querySelector(`[data-up="${key}"]`);
  if (!u || !el) return;
  const pct = u.size ? Math.round((100 * u.done) / u.size) : 0;
  el.querySelector('.prog > i').style.width = pct + '%';
  el.querySelector('.upl').textContent = `Подготовка… ${pct}%`;
}

// ------------------------------------------------------------------ messages

// Delivery states only move forward; a late HTTP response must not undo a
// "delivered"/"read" that already arrived over the WebSocket.
const STATUS_RANK = { pending: 1, delivered: 2, read: 3 };

function onMessage(m, local) {
  if (!m || !m.peer) return;
  const cs = S.chats.get(m.peer);
  if (cs && cs.loaded) {
    const old = cs.byId.get(m.id);
    if (old && local) return; // the WebSocket copy is at least as fresh
    if (old && m.kind === 'text' && (STATUS_RANK[old.status] || 0) > (STATUS_RANK[m.status] || 99)) m = { ...m, status: old.status };
    if (old) {
      const i = cs.list.indexOf(old);
      if (i >= 0) cs.list[i] = m;
    } else if (!cs.list.length || cs.list[cs.list.length - 1].ts <= m.ts) {
      cs.list.push(m);
    } else {
      let i = cs.list.length;
      while (i > 0 && cs.list[i - 1].ts > m.ts) i--;
      cs.list.splice(i, 0, m);
    }
    cs.byId.set(m.id, m);
  }
  if (!m.out && S.typing.has(m.peer)) {
    clearTimeout(S.typing.get(m.peer));
    S.typing.delete(m.peer);
    if (S.active === m.peer) renderHeader();
    renderSidebarSoon();
  }
  if (m.peer !== S.active || !E.msgsInner || !cs || !cs.loaded) return;
  const el = E.msgMap.get(m.id);
  const idx = cs.list.indexOf(cs.byId.get(m.id));
  const prev = idx > 0 ? cs.list[idx - 1] : null;
  if (el) {
    const nel = msgNode(m, prev);
    el.replaceWith(nel);
    E.msgMap.set(m.id, nel);
    return;
  }
  if (idx === cs.list.length - 1) {
    const stick = nearBottom();
    const hint = E.msgsInner.querySelector('.chat-hint');
    if (hint) hint.remove();
    const ups = [...E.msgsInner.querySelectorAll('.m.uploading')];
    ups.forEach((u) => u.remove());
    if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) E.msgsInner.appendChild(h('div.day', fmtDay(m.ts)));
    const nel = msgNode(m, prev && dayKey(prev.ts) === dayKey(m.ts) ? prev : null);
    E.msgsInner.appendChild(nel);
    E.msgMap.set(m.id, nel);
    ups.forEach((u) => E.msgsInner.appendChild(u));
    if (stick || m.out) scrollBottom(m.out);
    else showJump(true);
    if (!m.out) markReadSoon();
  } else {
    renderMessages(true);
  }
}

function removeMessage(peer, id) {
  const cs = S.chats.get(peer);
  if (cs) {
    const m = cs.byId.get(id);
    if (m) { cs.list.splice(cs.list.indexOf(m), 1); cs.byId.delete(id); }
  }
  if (peer === S.active) renderMessages(true);
}

function renderMessages(keepScroll) {
  if (!E.msgsInner || !S.active) return;
  const cs = chatState(S.active);
  const oldH = E.msgs.scrollHeight;
  const oldTop = E.msgs.scrollTop;
  const wasBottom = nearBottom();
  const inner = clear(E.msgsInner);
  E.msgMap = new Map();
  if (cs.loaded && !cs.all && cs.list.length) {
    inner.appendChild(h('button.btn.sm.ghost.more-btn', { on: { click: loadOlder } }, 'Показать более ранние сообщения'));
  }
  let prev = null;
  let lastDay = null;
  for (const m of cs.list) {
    const dk = dayKey(m.ts);
    if (dk !== lastDay) { inner.appendChild(h('div.day', fmtDay(m.ts))); lastDay = dk; prev = null; }
    const el = msgNode(m, prev);
    inner.appendChild(el);
    E.msgMap.set(m.id, el);
    prev = m;
  }
  if (cs.loaded && !cs.list.length) inner.appendChild(chatHint());
  renderUploads();
  if (keepScroll === 'prepend') E.msgs.scrollTop = oldTop + (E.msgs.scrollHeight - oldH);
  else if (keepScroll && !wasBottom) E.msgs.scrollTop = oldTop;
  else if (keepScroll) scrollBottom(false);
}

function chatHint() {
  const c = S.contacts.get(S.active);
  if (!c) return null;
  return h('div.sys.chat-hint', { style: { marginTop: '40px', maxWidth: '420px' } },
    h('div', { style: { display: 'grid', justifyItems: 'center', gap: '10px' } }, avatar(c.peer_id, c.display, 's96'),
      h('div', { style: { fontSize: '16px', fontWeight: 650, color: 'var(--text)' } }, c.display),
      c.state === 'accepted'
        ? h('div', 'Это начало вашей переписки. Сообщения хранятся только на ваших компьютерах. Можно отправить файл, перетащив его в окно.')
        : h('div', 'Ожидаем подтверждения запроса.'),
      c.state === 'accepted' ? h('div', h('button.btn.sm', { on: { click: () => openContactInfo(c.peer_id) } }, icon('shield', 'sm'), 'Сверить код безопасности')) : null));
}

async function loadOlder(e) {
  const peer = S.active;
  const cs = chatState(peer);
  if (!cs.list.length) return;
  if (e && e.currentTarget) e.currentTarget.disabled = true;
  try {
    const r = await api(`/api/messages?peer=${enc(peer)}&before=${cs.list[0].ts}&limit=150`);
    const older = (r.messages || []).filter((m) => !cs.byId.has(m.id));
    cs.list = older.concat(cs.list);
    for (const m of older) cs.byId.set(m.id, m);
    cs.all = (r.messages || []).length < 150;
    if (S.active === peer) renderMessages('prepend');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function tick(m) {
  if (!m.out) return null;
  switch (m.status) {
    case 'pending': return h('span', { title: 'Отправляется (будет доставлено, когда собеседник появится в сети)' }, icon('clock', 'xs'));
    case 'delivered': return h('span', { title: 'Доставлено' }, icon('check', 'xs'));
    case 'read': return h('span.st-read', { title: 'Прочитано' }, icon('checks', 'xs'));
    case 'failed': return h('span.st-failed', { title: 'Не доставлено' }, icon('alert', 'xs'));
    default: return null;
  }
}

function meta(m) {
  return h('span.meta', fmtTime(m.ts), tick(m));
}

function msgNode(m, prev) {
  if (m.kind === 'call') return callLogNode(m);
  if (m.kind === 'system') return h('div.sys', { dataset: { id: m.id } }, m.text);
  const cont = prev && (prev.kind === 'text' || prev.kind === 'file') && prev.out === m.out && m.ts - prev.ts < 5 * 60000;
  const el = h('div.m.' + (m.out ? 'out' : 'in') + (cont ? '.cont' : '') + (m.status === 'failed' ? '.failed' : ''), { dataset: { id: m.id } });
  const b = h('div.bubble');
  if (m.kind === 'file' && m.file) {
    b.appendChild(fileNode(m));
  } else {
    const text = m.text || '';
    b.appendChild(h('div.txt' + (isEmojiOnly(text) ? '.big' : ''), linkify(text), meta(m)));
  }
  const col = h('div.mcol', b);
  if (m.status === 'failed' && m.out && m.kind === 'text') {
    col.appendChild(h('div.fail-line', 'Не доставлено',
      h('a', { on: { click: () => retryMsg(m) } }, 'Повторить'),
      h('a', { on: { click: () => deleteMsg(m) } }, 'Удалить')));
  }
  el.appendChild(col);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); msgMenu(e, m); });
  return el;
}

function callTitle(m) {
  const c = m.call || {};
  const v = c.video ? 'видеозвонок' : 'звонок';
  switch (c.result) {
    case 'answered': return `${m.out ? 'Исходящий' : 'Входящий'} ${v} · ${fmtDur(c.duration || 0)}`;
    case 'missed': return m.out ? `Собеседник пропустил ${v}` : `Пропущенный ${v}`;
    case 'declined': return m.out ? `${cap(v)} отклонён` : `Вы отклонили ${v}`;
    case 'canceled': return m.out ? `Отменённый ${v}` : `Пропущенный ${v}`;
    case 'busy': return `${cap(v)}: занято`;
    case 'no_answer': return `${cap(v)}: нет ответа`;
    default: return `${cap(v)} не состоялся`;
  }
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function callLogNode(m) {
  const c = m.call || {};
  const missed = !m.out && (c.result === 'missed' || c.result === 'canceled');
  const ok = S.contacts.get(m.peer) && S.contacts.get(m.peer).state === 'accepted';
  return h('div.calllog' + (missed ? '.missed' : ''), { dataset: { id: m.id }, on: { contextmenu: (e) => { e.preventDefault(); msgMenu(e, m); } } },
    icon(missed ? 'phoneMissed' : m.out ? 'phoneOut' : 'phoneIn', 'sm'),
    h('span', callTitle(m)), h('span.tm', fmtTime(m.ts)),
    ok ? h('button.btn.sm.ghost.again', { title: 'Перезвонить', on: { click: () => Calls.startCall(m.peer, !!c.video) } }, icon(c.video ? 'video' : 'phone', 'sm')) : null);
}

const FILE_ERR = {
  interrupted: 'Передача прервалась',
  hash_mismatch: 'Файл повреждён при передаче — контрольная сумма не совпала',
  too_large: 'Файл больше разрешённого размера (см. Настройки → Файлы)',
  no_direct: 'Нет подходящего соединения: через публичный relay файлы не передаются — нужен прямой канал или свой relay',
  io: 'Ошибка записи на диск',
  missing: 'Исходный файл больше недоступен у отправителя',
};

function fileSrc(m, download) {
  return `/api/files/content?peer=${enc(m.peer)}&tid=${enc(m.file.tid)}${download ? '&download=1' : ''}`;
}

function fileNode(m) {
  const f = m.file;
  const ext = extOf(f.name);
  const wrap = h('div');
  const servable = m.out ? !!f.path && f.state !== 'canceled' : f.state === 'done';
  if (servable && IMG_EXT.has(ext)) {
    const img = h('img', { src: fileSrc(m), alt: f.name, loading: 'lazy', draggable: false });
    img.addEventListener('error', () => { const p = img.closest('.preview'); if (p) p.remove(); });
    wrap.appendChild(h('div.preview', { on: { click: () => lightbox(fileSrc(m), f.name) } }, img));
  } else if (servable && AUDIO_EXT.has(ext)) {
    wrap.appendChild(h('audio', { controls: true, preload: 'metadata', src: fileSrc(m) }));
  } else if (servable && VIDEO_EXT.has(ext)) {
    wrap.appendChild(h('video', { controls: true, preload: 'metadata', src: fileSrc(m) }));
  }
  const sub = h('div.fsub');
  const btns = h('div.fbtns');
  const prog = S.progress.get(f.tid);
  const done = prog ? prog.done : f.done || 0;
  const act = (label, ic, fn, cls = '') => h('button.btn.sm' + cls, { on: { click: (e) => { e.stopPropagation(); fn(e.currentTarget); } } }, ic ? icon(ic, 'sm') : null, label);
  let progEl = null;
  switch (f.state) {
    case 'offered':
      if (m.out) {
        sub.append(fmtSize(f.size), ' · ждём, пока собеседник примет');
        btns.appendChild(act('Отменить', 'x', () => fileAction('cancel', m)));
      } else {
        sub.append(fmtSize(f.size));
        const tooBig = S.settings && f.size > S.settings.max_incoming_mb * 1048576;
        if (tooBig) sub.append(' · больше лимита в настройках');
        btns.append(act('Принять', 'download', (b) => fileAction('accept', m, b), '.primary'), act('Отклонить', null, () => fileAction('decline', m)));
      }
      break;
    case 'transferring': {
      const pct = f.size ? Math.min(100, Math.floor((100 * done) / f.size)) : 0;
      progEl = h('div.prog' + (done ? '' : '.indet'), h('i', { style: { width: pct + '%' } }));
      sub.appendChild(h('span.ptext', progressText(done, f.size, prog && prog.speed)));
      btns.appendChild(act('Отменить', 'x', () => fileAction('cancel', m)));
      break;
    }
    case 'done':
      sub.append(fmtSize(f.size), m.out ? ' · доставлен' : ' · сохранён');
      if (!m.out) btns.append(act('Открыть', 'open', () => openFile(m)), act('Показать в папке', 'folder', () => reveal(m)));
      break;
    case 'declined':
      sub.append(fmtSize(f.size), m.out ? ' · собеседник отклонил' : ' · отклонён');
      break;
    case 'canceled':
      sub.append(fmtSize(f.size), ' · отменён');
      break;
    case 'failed':
      sub.classList.add('err');
      sub.append(FILE_ERR[f.error] || f.error || 'Ошибка передачи');
      if (!m.out && f.error !== 'missing') btns.appendChild(act(f.done ? 'Докачать' : 'Повторить', 'refresh', (b) => fileAction('accept', m, b)));
      break;
    default:
      sub.append(fmtSize(f.size));
  }
  wrap.appendChild(h('div.file',
    h('div.ficon', ext && ext.length <= 4 ? ext.toUpperCase() : icon('file')),
    h('div.grow', h('div.fname', { title: f.name }, f.name), sub, progEl, btns.children.length ? btns : null),
  ));
  wrap.appendChild(h('div.fmeta', meta(m)));
  return wrap;
}

function progressText(done, size, speed) {
  const pct = size ? Math.min(100, Math.floor((100 * done) / size)) : 0;
  let s = `${pct}% · ${fmtSize(done)} из ${fmtSize(size)}`;
  if (speed > 0) {
    s += ` · ${fmtSize(speed)}/с`;
    const left = (size - done) / speed;
    if (left > 1 && left < 86400 * 3) s += ` · ещё ${left < 60 ? Math.ceil(left) + ' с' : left < 3600 ? Math.ceil(left / 60) + ' мин' : (left / 3600).toFixed(1).replace('.', ',') + ' ч'}`;
  }
  return s;
}

function onProgress(d) {
  S.progress.set(d.tid, { done: d.done, size: d.size, speed: d.speed });
  if (d.peer !== S.active || !E.msgMap) return;
  const el = E.msgMap.get(d.id);
  if (!el) return;
  const bar = el.querySelector('.prog');
  if (bar) {
    bar.classList.remove('indet');
    bar.firstChild.style.width = (d.size ? Math.min(100, (100 * d.done) / d.size) : 0) + '%';
  }
  const t = el.querySelector('.ptext');
  if (t) t.textContent = progressText(d.done, d.size, d.speed);
}

async function fileAction(what, m, btn) {
  if (btn) btn.disabled = true;
  try {
    await api(`/api/files/${what}`, { peer: m.peer, tid: m.file.tid });
  } catch (e) {
    toast(e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

async function reveal(m) {
  try { await api('/api/files/reveal', { peer: m.peer, tid: m.file.tid }); } catch (e) { toast(e.message, 'err'); }
}

async function openFile(m) {
  try { await api('/api/files/open', { peer: m.peer, tid: m.file.tid }); } catch (e) { toast(e.message, 'warn', 7000); }
}

function lightbox(src, name) {
  const lb = h('div.lightbox', { on: { click: () => lb.remove() } }, h('img', { src, alt: name }), h('div.cap', name));
  document.body.appendChild(lb);
}

function msgMenu(e, m) {
  const items = [];
  if (m.kind === 'text') items.push({ icon: 'copy', label: 'Копировать текст', onClick: () => copyText(m.text, 'Текст скопирован') });
  if (m.kind === 'file' && m.file && m.file.state === 'done' && !m.out) {
    items.push({ icon: 'open', label: 'Открыть', onClick: () => openFile(m) });
    items.push({ icon: 'folder', label: 'Показать в папке', onClick: () => reveal(m) });
  }
  if (m.out && m.status === 'failed' && m.kind === 'text') items.push({ icon: 'refresh', label: 'Отправить ещё раз', onClick: () => retryMsg(m) });
  if (items.length) items.push('sep');
  items.push({ icon: 'trash', label: 'Удалить у себя', danger: true, onClick: () => deleteMsg(m) });
  menu(e, items);
}

async function retryMsg(m) {
  try { await api('/api/messages/retry', { peer: m.peer, id: m.id }); } catch (e) { toast(e.message, 'err'); }
}

async function deleteMsg(m) {
  try { await api('/api/messages/delete', { peer: m.peer, id: m.id }); removeMessage(m.peer, m.id); } catch (e) { toast(e.message, 'err'); }
}

// ------------------------------------------------------------------ scrolling / read state

function nearBottom() {
  const el = E.msgs;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

function scrollBottom(force) {
  const el = E.msgs;
  if (!el) return;
  requestAnimationFrame(() => {
    if (force || S.stick !== false) el.scrollTop = el.scrollHeight;
    S.stick = true;
    showJump(false);
  });
}

function onScroll() {
  S.stick = nearBottom();
  if (S.stick) showJump(false);
  if (E.msgs.scrollTop < 60) {
    const cs = S.chats.get(S.active);
    if (cs && cs.loaded && !cs.all && !cs.loadingOlder) {
      cs.loadingOlder = true;
      loadOlder().finally(() => { cs.loadingOlder = false; });
    }
  }
}

function showJump(on) {
  if (E.jump) E.jump.classList.toggle('hidden', !on);
}

const markReadSoon = debounce(() => {
  if (!S.active || document.hidden || !document.hasFocus()) return;
  const c = S.contacts.get(S.active);
  if (c && c.summary && c.summary.unread > 0) wsSend({ type: 'read', peer: S.active });
}, 250);

function onTyping(peer) {
  clearTimeout(S.typing.get(peer));
  S.typing.set(peer, setTimeout(() => { S.typing.delete(peer); if (S.active === peer) renderHeader(); renderSidebarSoon(); }, 6000));
  if (S.active === peer) renderHeader();
  renderSidebarSoon();
}

// ------------------------------------------------------------------ notifications

function askNotifyPermissionLater() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const ask = () => {
    removeEventListener('pointerdown', ask, true);
    if (S.settings.desktop_notify) Notification.requestPermission().catch(() => {});
  };
  addEventListener('pointerdown', ask, true);
}

let lastNote = null;
function desktopNote(title, body, peer, sticky) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !S.settings.desktop_notify) return null;
  try {
    const n = new Notification(title, { body, icon: '/icon-192.png', tag: peer || 'zv', silent: true, requireInteraction: !!sticky });
    n.onclick = () => { window.focus(); if (peer && S.contacts.has(peer)) openChat(peer); n.close(); };
    lastNote = n;
    return n;
  } catch (e) {
    return null;
  }
}

function onNotify(d) {
  const focused = document.hasFocus() && !document.hidden;
  if (d.kind === 'message') {
    const c = S.contacts.get(d.peer);
    if (c && c.muted) return;
    if (focused && S.active === d.peer && nearBottom()) return;
    tones.message();
    if (!focused) desktopNote(d.title, d.text, d.peer);
  } else if (d.kind === 'pair') {
    tones.message();
    if (!focused) desktopNote(d.title, d.text, null);
  }
}

let flashTimer = null;
let callNote = null;
function attention(on, cv) {
  if (on) {
    const name = displayName(cv.peer);
    if (!document.hasFocus()) {
      callNote = desktopNote(cv.video ? 'Входящий видеозвонок' : 'Входящий звонок', name, cv.peer, true);
      try { window.focus(); } catch (e) { /* ignore */ }
    }
    let flip = false;
    clearInterval(flashTimer);
    flashTimer = setInterval(() => { flip = !flip; document.title = flip ? `📞 ${name} звонит` : 'Звоночек'; }, 900);
  } else {
    stopTitleFlash();
    if (callNote) { try { callNote.close(); } catch (e) { /* ignore */ } callNote = null; }
  }
}

function stopTitleFlash() {
  if (!flashTimer) return;
  const c = Calls.currentCall();
  if (c && c.state === 'incoming') return;
  clearInterval(flashTimer);
  flashTimer = null;
  updateTitle();
}

// ------------------------------------------------------------------ call bar

export function renderCallBar() {
  const old = document.querySelector('.callbar');
  const c = Calls.currentCall();
  if (!c || !c.minimized || c.state !== 'active') { if (old) old.remove(); return; }
  const bar = h('div.callbar', { title: 'Вернуться к звонку', on: { click: () => Calls.restore() } },
    icon('phone', 'sm'),
    h('b', displayName(c.peer)),
    h('span.call-timer', c.answered ? fmtDur((Date.now() - c.answered) / 1000) : ''),
    h('button.ibtn', { title: c.micOn ? 'Выключить микрофон' : 'Включить микрофон', on: { click: (e) => { e.stopPropagation(); Calls.toggleMicCurrent(); } } }, icon(c.micOn ? 'mic' : 'micOff', 'sm')),
    h('button.ibtn.red', { title: 'Завершить', on: { click: (e) => { e.stopPropagation(); Calls.hangupCurrent(); } } }, icon('hangup', 'sm')));
  if (old) old.replaceWith(bar);
  else E.main.appendChild(bar);
}

// ------------------------------------------------------------------ drag & drop

function setupDrop() {
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  E.main.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !E.drop) return;
    e.preventDefault();
    depth++;
    E.drop.classList.remove('hidden');
  });
  E.main.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  E.main.addEventListener('dragleave', () => { if (--depth <= 0 && E.drop) { depth = 0; E.drop.classList.add('hidden'); } });
  E.main.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    if (E.drop) E.drop.classList.add('hidden');
    if (!S.active) { toast('Сначала откройте чат', 'warn'); return; }
    for (const f of e.dataTransfer.files) sendFile(f);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

// ------------------------------------------------------------------ contacts: menus & dialogs

function contactMenu(e, peer) {
  const c = S.contacts.get(peer);
  if (!c) return;
  const ok = c.state === 'accepted';
  menu(e, [
    ok ? { icon: 'phone', label: 'Аудиозвонок', onClick: () => Calls.startCall(peer, false) } : null,
    ok ? { icon: 'video', label: 'Видеозвонок', onClick: () => Calls.startCall(peer, true) } : null,
    { icon: 'info', label: 'Информация и код безопасности', onClick: () => openContactInfo(peer) },
    { icon: 'edit', label: 'Переименовать', onClick: () => renameContact(peer) },
    { icon: c.muted ? 'bell' : 'bellOff', label: c.muted ? 'Включить уведомления' : 'Без звука', onClick: () => updateContact(peer, { muted: !c.muted }) },
    'sep',
    { icon: 'trash', label: 'Очистить историю', onClick: () => clearHistory(peer) },
    c.state !== 'blocked' ? { icon: 'ban', label: 'Заблокировать', danger: true, onClick: () => blockContact(peer) } : null,
    { icon: 'x', label: 'Удалить контакт', danger: true, onClick: () => removeContact(peer) },
  ]);
}

async function updateContact(peer, patch) {
  try {
    const c = await api('/api/contacts/update', { peer, ...patch });
    if (c && c.peer_id) upsertContact(c);
    return c;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

async function renameContact(peer) {
  const c = S.contacts.get(peer);
  const v = await promptDlg({ title: 'Имя контакта', label: `Видно только вам. Собственное имя: ${c.name || 'не указано'}`, value: c.alias || c.display, placeholder: c.name });
  if (v === null) return;
  await updateContact(peer, { alias: v.trim() });
}

async function clearHistory(peer) {
  const ok = await confirmDlg({ title: 'Очистить историю?', text: `Вся переписка с ${displayName(peer)} будет удалена с этого компьютера. У собеседника она останется.`, ok: 'Очистить', danger: true });
  if (!ok) return;
  try { await api('/api/contacts/clear', { peer }); } catch (e) { toast(e.message, 'err'); }
}

async function removeContact(peer, quick) {
  const name = displayName(peer);
  let purge = false;
  if (!quick) {
    const r = await confirmDlg({ title: 'Удалить контакт?', text: `${name} пропадёт из списка. Чтобы снова общаться, понадобится новый код приглашения.`, ok: 'Удалить', danger: true, check: 'Удалить и всю переписку' });
    if (!r) return;
    purge = r.checked;
  }
  try { await api('/api/contacts/remove', { peer, purge, block: false }); } catch (e) { toast(e.message, 'err'); }
}

async function blockContact(peer) {
  const r = await confirmDlg({ title: 'Заблокировать?', text: `${displayName(peer)} не сможет писать, звонить и отправлять файлы. Разблокировать можно в Настройках → Приватность.`, ok: 'Заблокировать', danger: true, check: 'Удалить переписку' });
  if (!r) return;
  try { await api('/api/contacts/remove', { peer, purge: r.checked, block: true }); } catch (e) { toast(e.message, 'err'); }
}

async function unblock(peer) {
  try {
    await api('/api/contacts/update', { peer, unblock: true });
    toast('Контакт разблокирован. Чтобы общаться снова, обменяйтесь кодами приглашения.', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function openContactInfo(peer) {
  const c = S.contacts.get(peer);
  if (!c) return;
  const p = c.presence || {};
  const alias = h('input.input', { value: c.alias || '', placeholder: c.name || 'Имя контакта', maxLength: 64 });
  const saveAlias = async () => { if ((c.alias || '') !== alias.value.trim()) await updateContact(peer, { alias: alias.value.trim() }); };
  alias.addEventListener('keydown', (e) => { if (e.key === 'Enter') { saveAlias(); alias.blur(); } });
  alias.addEventListener('blur', saveAlias);
  const verifyBtn = h('button.btn' + (c.verified ? '' : '.primary'), { on: { click: async () => { const r = await updateContact(peer, { verified: !c.verified }); if (r) { m.close(); openContactInfo(peer); } } } },
    icon(c.verified ? 'x' : 'shieldCheck', 'sm'), c.verified ? 'Снять отметку о проверке' : 'Коды совпадают — отметить проверенным');
  const conn = p.online ? `${p.conn === 'relay' ? 'через relay' : 'прямое'}${p.lan ? ', локальная сеть' : ''}${p.transport ? ' · ' + p.transport : ''}${p.rtt ? ' · ' + p.rtt + ' мс' : ''}` : 'не в сети';
  const body = h('div.modal-body',
    h('div', { style: { display: 'grid', justifyItems: 'center', gap: '8px', padding: '4px 0 6px' } },
      avatar(c.peer_id, c.display, 's96', c.presence),
      h('div', { style: { fontSize: '19px', fontWeight: 700, display: 'flex', gap: '6px', alignItems: 'center' } }, c.display, c.verified ? h('span.verified', icon('shieldCheck')) : null),
      h('div.dim', c.alias && c.name ? `собственное имя: ${c.name}` : p.online ? 'в сети' : fmtAgo(c.last_seen))),
    h('div.field', h('label', 'Имя контакта (видно только вам)'), alias),
    h('div.field', h('label', 'Код безопасности'),
      h('div.safety', fmtSafety(c.safety_code)),
      h('div.hint', 'Сравните код с собеседником голосом или лично — у вас обоих он должен быть одинаковым. Совпадение гарантирует, что соединение никто не подменил.'),
      c.state === 'accepted' ? verifyBtn : null),
    h('div.kv',
      h('div', 'ID собеседника'), h('div.mono', { style: { cursor: 'copy' }, title: 'Скопировать', on: { click: () => copyText(c.peer_id, 'ID скопирован') } }, c.peer_id),
      h('div', 'Соединение'), h('div', conn),
      h('div', 'Версия'), h('div', c.version || '—'),
      h('div', 'Добавлен'), h('div', c.added_at ? new Date(c.added_at).toLocaleString('ru-RU') : '—')),
  );
  const m = modal({
    title: 'Контакт',
    body,
    foot: [
      h('button.btn.ghost', { on: { click: () => { m.close(); updateContact(peer, { muted: !c.muted }); } } }, icon(c.muted ? 'bell' : 'bellOff', 'sm'), c.muted ? 'Включить звук' : 'Без звука'),
      h('div.spacer'),
      h('button.btn.danger', { on: { click: () => { m.close(); removeContact(peer); } } }, 'Удалить'),
      h('button.btn', { on: { click: () => m.close() } }, 'Готово'),
    ],
  });
}

// ------------------------------------------------------------------ add contact

export function openAddContact(tab = 'add') {
  const tabs = h('div.tabs');
  const pane = h('div.col', { style: { gap: '12px' } });
  const body = h('div.modal-body', tabs, pane);
  const m = modal({ title: 'Добавить контакт', body });
  const show = (t) => {
    clear(tabs).append(
      h('button' + (t === 'add' ? '.on' : ''), { on: { click: () => show('add') } }, 'Ввести код собеседника'),
      h('button' + (t === 'mine' ? '.on' : ''), { on: { click: () => show('mine') } }, 'Мой код'));
    clear(pane);
    if (t === 'add') addPane(pane, m);
    else minePane(pane);
  };
  show(tab);
}

function addPane(pane, m) {
  const ta = h('textarea.textarea', { placeholder: 'zv3:…  или  12D3KooW…', autofocus: true, spellcheck: false });
  const err = h('div.hint', { style: { color: 'var(--bad)' } });
  const btn = h('button.btn.primary', { on: { click: go } }, icon('userPlus', 'sm'), 'Добавить');
  async function go() {
    const input = ta.value.trim();
    if (!input) { ta.focus(); return; }
    btn.disabled = true;
    clear(btn).append(icon('refresh', 'sm'), 'Подключаюсь…');
    err.textContent = '';
    try {
      const r = await api('/api/contacts/add', { input });
      m.close();
      upsertContact(r.contact);
      openChat(r.contact.peer_id);
      if (r.contact.state === 'accepted') toast(`${r.contact.display} добавлен(а) в контакты`, 'ok');
      else toast(r.warning ? `Запрос сохранён: ${r.warning}. Он будет отправлен, когда собеседник появится в сети.` : 'Запрос отправлен — ждём подтверждения', r.warning ? 'warn' : 'ok', 7000);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false;
      clear(btn).append(icon('userPlus', 'sm'), 'Добавить');
    }
  }
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); go(); } });
  pane.append(
    h('div.hint', 'Вставьте код приглашения, который прислал собеседник (из его окна «Мой код»). С кодом вы сразу станете контактами. Можно ввести и просто ID — тогда собеседнику придёт запрос на подтверждение.'),
    ta, err,
    h('div.row', h('div.spacer'), btn));
  setTimeout(() => ta.focus(), 50);
}

async function minePane(pane) {
  const box = h('div.codebox', 'Создаю код…');
  const exp = h('div.hint');
  const copyBtn = h('button.btn.primary', { disabled: true }, icon('copy', 'sm'), 'Скопировать код');
  const renew = h('button.btn.ghost', { title: 'Старый код перестанет работать' }, icon('refresh', 'sm'), 'Новый код');
  pane.append(
    h('div.hint', 'Отправьте этот код собеседнику любым способом (мессенджер, почта). Он вставит его у себя — и вы сразу станете контактами. Код действует 7 дней и подходит для нескольких человек.'),
    box, exp, h('div.row', copyBtn, renew, h('div.spacer')),
    h('div.field', { style: { marginTop: '6px' } }, h('label', 'Ваш ID'),
      h('div.row', h('div.codebox.grow', { style: { padding: '8px 12px' } }, S.me.peer_id),
        h('button.ibtn', { title: 'Скопировать ID', on: { click: () => copyText(S.me.peer_id, 'ID скопирован') } }, icon('copy')))),
    h('div.hint', 'По ID тоже можно добавиться, но тогда нужно подтверждение, а соединение найдётся только через интернет-поиск или локальную сеть.'));
  const load = async (renewIt) => {
    try {
      const r = await api('/api/invite', { renew: !!renewIt });
      box.textContent = r.code;
      exp.textContent = `Действует до ${new Date(r.expires).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`;
      copyBtn.disabled = false;
      copyBtn.onclick = () => copyText(r.code, 'Код приглашения скопирован');
      if (renewIt) toast('Создан новый код. Старый больше не действует.', 'ok');
    } catch (e) {
      box.textContent = e.message;
    }
  };
  renew.onclick = async () => {
    if (await confirmDlg({ title: 'Создать новый код?', text: 'Старый код перестанет работать — те, кому вы его отправили, не смогут добавиться.', ok: 'Создать' })) load(true);
  };
  load(false);
}

// ------------------------------------------------------------------ app API (for call.js / settings.js)

export const appApi = {
  S,
  wsSend,
  displayName,
  openChat,
  saveUI,
  applyTheme,
  attention,
  renderCallBar,
  renderSidebar: renderSidebarSoon,
  upsertContact,
  unblock,
  setSettings(st) { S.settings = st; },
};

boot();
