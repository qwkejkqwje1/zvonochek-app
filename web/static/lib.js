// Small DOM / formatting helpers shared by the UI modules.

const ICONS = {
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  hangup: '<g transform="rotate(135 12 12)"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></g>',
  phoneIn: '<path d="M16 2v6h6M22 2l-6 6"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  phoneOut: '<path d="M22 8V2h-6M16 8l6-6"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  phoneMissed: '<path d="m16 2 6 6M22 2l-6 6"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  videoOff: '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="m2 2 20 20"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  micOff: '<path d="m2 2 20 20"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M12 19v3"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="m9 10 3-3 3 3M12 7v6"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checks: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  more: '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  wifi: '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  minimize: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  open: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3z"/>',
};

export function icon(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

// h('div.cls#id', {attrs, on:{click}}, ...children)
export function h(tag, props, ...kids) {
  let [t, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(t || 'div');
  for (const r of rest) {
    if (r[0] === '.') el.classList.add(r.slice(1));
    else if (r[0] === '#') el.id = r.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export class ApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

export const hooks = { unauthorized: () => {} };

export async function api(path, body, opts = {}) {
  const init = { method: body === undefined ? 'GET' : 'POST', headers: {}, signal: opts.signal };
  if (body !== undefined) {
    init.headers['X-ZV'] = '1';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(path, init);
  } catch (e) {
    throw new ApiError('Нет связи с программой Звоночек', 0);
  }
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty */ }
  if (r.status === 401) {
    hooks.unauthorized();
    throw new ApiError('Сессия истекла', 401);
  }
  if (!r.ok) throw new ApiError((data && data.error) || `Ошибка ${r.status}`, r.status);
  return data;
}

// upload streams a file to the daemon with progress.
export function upload(peer, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/files/upload?peer=${encodeURIComponent(peer)}&name=${encodeURIComponent(file.name || 'file')}`);
    x.setRequestHeader('X-ZV', '1');
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    x.onload = () => {
      let data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
      if (x.status === 401) hooks.unauthorized();
      if (x.status >= 200 && x.status < 300) resolve(data);
      else reject(new ApiError((data && data.error) || `Ошибка ${x.status}`, x.status));
    };
    x.onerror = () => reject(new ApiError('Не удалось передать файл программе', 0));
    x.send(file);
  });
}

// ---------- formatting ----------
const tf = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dfy = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const dshort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const wd = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });

export const fmtTime = (ts) => tf.format(new Date(ts));

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function dayKey(ts) { return startOfDay(ts); }

export function fmtDay(ts) {
  const today = startOfDay(Date.now());
  const d = startOfDay(ts);
  if (d === today) return 'Сегодня';
  if (d === today - 86400000) return 'Вчера';
  const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
  return (sameYear ? df : dfy).format(new Date(ts));
}

export function fmtListTime(ts) {
  if (!ts) return '';
  const today = startOfDay(Date.now());
  const d = startOfDay(ts);
  if (d === today) return fmtTime(ts);
  if (today - d < 6 * 86400000) return wd.format(new Date(ts));
  return dshort.format(new Date(ts)).replace('.', '');
}

export function fmtAgo(ts) {
  if (!ts) return 'не в сети';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'был(а) только что';
  if (diff < 3600000) return `был(а) ${Math.floor(diff / 60000)} мин назад`;
  const today = startOfDay(Date.now());
  const d = startOfDay(ts);
  if (d === today) return `был(а) сегодня в ${fmtTime(ts)}`;
  if (d === today - 86400000) return `был(а) вчера в ${fmtTime(ts)}`;
  return `был(а) ${dshort.format(new Date(ts)).replace('.', '')}`;
}

export function fmtSize(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} Б`;
  const u = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${u[i]}`;
}

export function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ---------- avatar ----------
const GRADS = [
  ['#8b5cf6', '#6366f1'], ['#3b82f6', '#06b6d4'], ['#ec4899', '#f43f5e'], ['#f59e0b', '#ef4444'],
  ['#10b981', '#0ea5e9'], ['#14b8a6', '#22c55e'], ['#a855f7', '#ec4899'], ['#6366f1', '#0ea5e9'],
];

export function hashCode(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

export function gradFor(id) {
  const [a, b] = GRADS[hashCode(id || '') % GRADS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function initials(name) {
  const w = String(name || '?').replace(/[…\s]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!w.length) return '?';
  const first = [...w[0]][0] || '?';
  const second = w.length > 1 ? ([...w[1]][0] || '') : '';
  return (first + second).toUpperCase();
}

export function avatar(id, name, size = '', presence = null) {
  const el = h('div.avatar' + (size ? '.' + size : ''), { style: { background: gradFor(id) } }, initials(name));
  if (presence && presence.online) el.appendChild(h('i.pres' + (presence.conn && presence.conn !== 'direct' ? '.relay' : '')));
  return el;
}

// ---------- toasts / menus / modals ----------
export function toast(text, kind = 'info', ms = 4200) {
  const box = document.getElementById('toasts');
  const t = h('div.toast.' + kind, h('div.grow', text));
  box.appendChild(t);
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 260); };
  t.addEventListener('click', close);
  setTimeout(close, ms);
  while (box.children.length > 4) box.firstChild.remove();
}

let openMenuEl = null;
export function closeMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}

// items: [{label, icon, onClick, danger}] or 'sep'
export function menu(anchorOrEvent, items) {
  closeMenu();
  const m = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { m.appendChild(h('hr')); continue; }
    m.appendChild(h('button' + (it.danger ? '.danger' : ''), {
      on: { click: (e) => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); } },
    }, it.icon ? icon(it.icon, 'sm') : null, it.label));
  }
  document.body.appendChild(m);
  let x, y;
  if (anchorOrEvent instanceof MouseEvent && anchorOrEvent.type === 'contextmenu') {
    x = anchorOrEvent.clientX; y = anchorOrEvent.clientY;
  } else {
    const el = anchorOrEvent.currentTarget || anchorOrEvent.target || anchorOrEvent;
    const r = el.getBoundingClientRect();
    x = r.right - m.offsetWidth; y = r.bottom + 6;
  }
  x = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8));
  if (y + m.offsetHeight > innerHeight - 8) y = Math.max(8, y - m.offsetHeight - 40);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  openMenuEl = m;
  return m;
}
document.addEventListener('click', closeMenu);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

const modalStack = [];
export function modal({ title, body, foot, wide = false, onClose, cls = '' }) {
  const box = h('div.modal' + (wide ? '.wide' : '') + (cls ? '.' + cls : ''), { role: 'dialog', 'aria-modal': 'true' });
  const ov = h('div.overlay', box);
  const close = () => {
    const i = modalStack.indexOf(api);
    if (i >= 0) modalStack.splice(i, 1);
    ov.remove();
    onClose && onClose();
  };
  const api = { el: box, close, overlay: ov };
  if (title !== undefined) {
    box.appendChild(h('div.modal-head', h('h2', title), h('button.ibtn', { title: 'Закрыть', on: { click: close } }, icon('x'))));
  }
  if (body) box.appendChild(body instanceof Node ? body : h('div.modal-body', body));
  if (foot) box.appendChild(h('div.modal-foot', foot));
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.dataset.down = '1'; });
  ov.addEventListener('mouseup', (e) => { if (e.target === ov && ov.dataset.down) close(); delete ov.dataset.down; });
  document.body.appendChild(ov);
  modalStack.push(api);
  const f = box.querySelector('[autofocus]');
  if (f) setTimeout(() => f.focus(), 30);
  return api;
}

export function topModal() { return modalStack[modalStack.length - 1]; }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (openMenuEl) { closeMenu(); return; }
    const lb = document.querySelector('.lightbox');
    if (lb) { lb.remove(); return; }
    const m = topModal();
    if (m && !m.el.dataset.sticky) m.close();
  }
});

export function confirmDlg({ title, text, ok = 'OK', danger = false, check }) {
  return new Promise((resolve) => {
    let result = false;
    let cb = null;
    const body = h('div.modal-body', h('div.muted', text));
    if (check) {
      cb = h('input', { type: 'checkbox' });
      body.appendChild(h('label.row', { style: { cursor: 'pointer' } }, cb, h('span', check)));
    }
    const m = modal({
      title,
      body,
      foot: [
        h('button.btn.ghost', { on: { click: () => m.close() } }, 'Отмена'),
        h('button.btn' + (danger ? '.danger' : '.primary'), { autofocus: true, on: { click: () => { result = cb ? { checked: cb.checked } : true; m.close(); } } }, ok),
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDlg({ title, label, value = '', ok = 'Сохранить', placeholder = '', max = 64 }) {
  return new Promise((resolve) => {
    let result = null;
    const inp = h('input.input', { value, placeholder, maxLength: max, autofocus: true });
    const done = () => { result = inp.value; m.close(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    const m = modal({
      title,
      body: h('div.modal-body', h('div.field', label ? h('label', label) : null, inp)),
      foot: [h('button.btn.ghost', { on: { click: () => m.close() } }, 'Отмена'), h('button.btn.primary', { on: { click: done } }, ok)],
      onClose: () => resolve(result),
    });
    setTimeout(() => inp.select(), 40);
  });
}

export async function copyText(text, what = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(what, 'ok', 2200);
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}»]/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

export function isEmojiOnly(s) {
  const t = s.trim();
  if (!t || t.length > 16) return false;
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t);
}

export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
export const AUDIO_EXT = new Set(['mp3', 'ogg', 'wav', 'm4a', 'opus', 'flac']);
export const VIDEO_EXT = new Set(['mp4', 'webm']);

export function shortId(id) {
  if (!id) return '';
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

export function fmtSafety(code) {
  return String(code || '').replace(/(\d{4})(?=\d)/g, '$1 ');
}
