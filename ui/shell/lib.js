// Общие помощники оболочки: мост к ядру, иконки, диалоги, форматирование, мелодия звонка.
export const ipc = window.__zvIpc;
export const host = ipc ? ipc.host : 'none';
export const call = (cmd, args = {}) => ipc.call(cmd, args);
export const on = (prefix, fn) => ipc.on(prefix, fn);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div.cls#id', {attrs, onclick}, ...children) */
export function h(tag, attrs, ...kids) {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const p of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (p[0] === '.') el.classList.add(p.slice(1));
    else el.id = p.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(9)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

// ---------- иконки (свои, 24×24, обводка) ----------
const ICONS = {
  phone:
    '<path d="M6.2 3.8h2.6l1.7 4.4-2.1 1.4a11.5 11.5 0 0 0 6 6l1.4-2.1 4.4 1.7v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.2 6a2 2 0 0 1 2-2.2z"/>',
  hangup:
    '<path transform="rotate(135 12 12)" d="M6.2 3.8h2.6l1.7 4.4-2.1 1.4a11.5 11.5 0 0 0 6 6l1.4-2.1 4.4 1.7v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.2 6a2 2 0 0 1 2-2.2z"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1.2 1.2"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1.2-1.2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sliders:
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  pulse: '<path d="M3 12h4l2.2-6 4.2 12 2.2-6H21"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14v1"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4.5 7h15M10 11v5.5M14 11v5.5M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7M9.5 7V4.5h5V7"/>',
  edit: '<path d="M4.5 19.5h4l10.3-10.3a2.1 2.1 0 0 0-3-3L5.5 16.5z"/><path d="M14 8l2.5 2.5"/>',
  refresh: '<path d="M19.5 11.5a7.5 7.5 0 1 0-2.2 5.3"/><path d="M19.5 5v6.5H13"/>',
  bell: '<path d="M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.8 2H4.7z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  bellOff: '<path d="M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.8 2H4.7z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0M3.5 3.5l17 17"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  in: '<path d="M17 7L7.5 16.5M7 9.5V17h7.5"/>',
  out: '<path d="M7 17l9.5-9.5M9.5 7H17v7.5"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
  users:
    '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5a6.5 6.5 0 0 1 13 0"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.6 14.2a6.5 6.5 0 0 1 3.9 5.3"/>',
  userplus: '<circle cx="10" cy="8.5" r="3.8"/><path d="M2.8 20a7.2 7.2 0 0 1 11.6-5.7"/><path d="M18.5 14v6M15.5 17h6"/>',
  video: '<rect x="3" y="6.5" width="12.5" height="11" rx="2.2"/><path d="M15.5 10.6l5-3.1v9l-5-3.1z"/>',
  shield: '<path d="M12 3.5l7 2.8v5.2c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6.3z"/><path d="M8.8 12l2.3 2.3 4.2-4.4"/>',
  external:
    '<path d="M14 4.5h5.5V10M19.5 4.5l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  moon: '<path d="M19.5 14.5A7.8 7.8 0 1 1 9.5 4.5a6.2 6.2 0 0 0 10 10z"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  wave: '<path d="M8.5 9a4 4 0 0 0 0 6M15.5 9a4 4 0 0 1 0 6M5.5 6.5a8 8 0 0 0 0 11M18.5 6.5a8 8 0 0 1 0 11"/><circle cx="12" cy="12" r="1.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
};
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', ('ic ' + cls).trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
/** Заменить <i data-ic="name" class="..."> на SVG. */
export function hydrateIcons(root = document) {
  for (const i of $$('i[data-ic]', root)) i.replaceWith(icon(i.dataset.ic, i.className));
}

// ---------- тема ----------
const mq = window.matchMedia('(prefers-color-scheme: light)');
let themePref = 'auto';
export function applyTheme(t) {
  themePref = t || 'auto';
  const light = themePref === 'light' || (themePref === 'auto' && mq.matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}
mq.addEventListener?.('change', () => applyTheme(themePref));

// ---------- форматирование ----------
export const initials = (name) =>
  (String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин ${pad(sec % 60)} с`;
  return `${Math.floor(m / 60)} ч ${pad(m % 60)} мин`;
}
export function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Сегодня';
  if (same(d, y)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}
export function ago(ms) {
  if (!ms) return 'ещё не звонили';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return dayLabel(ms).toLowerCase();
}

// ---------- уведомления, буфер ----------
let toastT;
export function toast(msg, ms = 2400) {
  let t = $('.toast');
  if (!t) {
    t = h('div.toast');
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.remove(), ms);
}
export async function copyText(text, msg = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}

// ---------- диалоги ----------
export function dialog(build, { onClose } = {}) {
  const box = h('div.dialog', { role: 'dialog', 'aria-modal': 'true' });
  const ov = h('div.overlay', box);
  const close = (v) => {
    ov.remove();
    removeEventListener('keydown', key);
    onClose?.(v);
  };
  const key = (e) => {
    if (e.key === 'Escape') close();
  };
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) close();
  });
  addEventListener('keydown', key);
  build(box, close);
  document.body.append(ov);
  hydrateIcons(box);
  setTimeout(() => $('input, button.primary', box)?.focus(), 30);
  return close;
}
export function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((res) => {
    dialog(
      (b, close) => {
        b.append(
          h('h3', title),
          text ? h('p', text) : null,
          h(
            'div.actions',
            h('button.btn.ghost', { onclick: () => close(false) }, 'Отмена'),
            h('button.btn', { class: danger ? 'danger' : 'primary', onclick: () => close(true) }, okLabel)
          )
        );
      },
      { onClose: (v) => res(!!v) }
    );
  });
}
export function promptDialog(title, value = '', { label = '', okLabel = 'Сохранить', placeholder = '' } = {}) {
  return new Promise((res) => {
    let inp;
    dialog(
      (b, close) => {
        inp = h('input.field', { value, placeholder, maxlength: 60 });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') close(inp.value.trim());
        });
        b.append(
          h('h3', title),
          label ? h('p', label) : null,
          inp,
          h(
            'div.actions',
            h('button.btn.ghost', { onclick: () => close(null) }, 'Отмена'),
            h('button.btn.primary', { onclick: () => close(inp.value.trim()) }, okLabel)
          )
        );
        setTimeout(() => inp.select(), 40);
      },
      { onClose: (v) => res(v == null ? null : v) }
    );
  });
}
export function menu(anchor, items) {
  $('.menu')?.remove();
  const m = h(
    'div.menu',
    items.filter(Boolean).map((it) =>
      h(
        'button',
        {
          class: it.danger ? 'danger' : '',
          onclick: () => {
            m.remove();
            it.run();
          },
        },
        icon(it.icon, 'sm'),
        it.label
      )
    )
  );
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
  const off = (e) => {
    if (!m.contains(e.target)) {
      m.remove();
      removeEventListener('mousedown', off, true);
    }
  };
  setTimeout(() => addEventListener('mousedown', off, true), 0);
}
export function qrSvg(text, level = 'M') {
  if (typeof window.qrcode !== 'function') return null;
  const q = window.qrcode(0, level);
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// ---------- звонок ----------
/** Открыть окно звонка (встроенный веб-клиент) по секрету ссылки. */
export async function openCall(secret, boot = {}) {
  const st = await call('settings_get');
  const b = { auto: st.skipPrejoin !== false, name: st.name || '', ...boot };
  const r = await call('host_open_call', { secret, boot: b });
  if (r && r.url) {
    // zv-devhost: окно звонка — вкладка
    const w = window.open(r.url, 'zvcall');
    if (!w) location.href = r.url;
  }
  return r;
}

// ---------- мелодия (WebAudio, своя: «звоночек» из двух нот) ----------
export class Ringer {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.volume = 0.8;
  }
  _strike(t, f, v) {
    const c = this.ctx;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(v, t + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    out.connect(c.destination);
    for (const [mul, g] of [
      [1, 1],
      [2.01, 0.42],
      [3.02, 0.2],
      [4.18, 0.09],
    ]) {
      const o = c.createOscillator();
      const og = c.createGain();
      o.type = 'sine';
      o.frequency.value = f * mul;
      og.gain.value = g;
      o.connect(og).connect(out);
      o.start(t);
      o.stop(t + 1.15);
    }
  }
  _pattern() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.03;
    const v = Math.max(0.0002, 0.35 * this.volume);
    [
      [0, 1318.5],
      [0.16, 1046.5],
      [0.32, 1318.5],
      [0.48, 1046.5],
    ].forEach(([dt, f]) => this._strike(t + dt, f, v));
  }
  start(volume = 0.8) {
    this.volume = volume;
    if (this.timer) return;
    try {
      this.ctx = this.ctx || new AudioContext();
      this.ctx.resume?.();
    } catch {
      return;
    }
    this._pattern();
    this.timer = setInterval(() => this._pattern(), 2600);
  }
  once(volume = 0.8) {
    this.volume = volume;
    try {
      this.ctx = this.ctx || new AudioContext();
      this.ctx.resume?.();
    } catch {
      return;
    }
    this._pattern();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.ctx) {
      const c = this.ctx;
      this.ctx = null;
      c.close().catch(() => {});
    }
  }
}
