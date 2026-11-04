// ZVONochek v38 — отрисовка статистики: живая панель звонка, сводка и журнал
// на вкладке «Звонки». Данные готовит callstats.js; здесь только DOM.
// Все строки пользователя попадают в DOM через textContent.

import { ROUTE_LABELS, ROUTE_SHORT, mosLabel, sparkPath, fmtDur, fmtDurWords, fmtDurShort, fmtKbps, plural } from './callstats.js?v=44';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Короткий конструктор элемента: h('div.a.b', {title}, ...children). */
export function h(tag, attrs = null, ...kids) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

function svg(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function icon(id, cls = 'ic') {
  const s = svg('svg', { class: cls, 'aria-hidden': 'true' });
  s.append(svg('use', { href: '#' + id }));
  return s;
}

function spark(values, opts = {}) {
  const w = 120;
  const hgt = 28;
  const { line, area } = sparkPath(values, w, hgt, opts);
  const s = svg('svg', { class: 'cs-spark', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  if (line) {
    s.append(svg('path', { class: 'cs-spark-area', d: area }));
    s.append(svg('path', { class: 'cs-spark-line', d: line }));
  }
  return s;
}

const LIMITATION = { bandwidth: 'ширина канала', cpu: 'процессор', other: 'браузер' };
// v37: «Red» в статистике — это Opus с копией предыдущего пакета (RFC 2198).
export const audioCodecLabel = (c) =>
  !c ? '' : /^red$/i.test(c) ? 'Opus + RED' : c.charAt(0).toUpperCase() + c.slice(1);
/** «H264 · аппаратно» / «VP8 · программно» / «VP8». */
export function videoCodecLabel(v) {
  if (!v || !v.name) return '';
  const how = v.hw === true ? 'аппаратно' : v.hw === false ? 'программно' : '';
  return how ? `${v.name} · ${how}` : v.name;
}
const VIA = { worker: 'Worker', 'worker-http': 'HTTP', mqtt: 'MQTT', nostr: 'Nostr', ntfy: 'ntfy' };

function tile(label, value, unit, values, opts) {
  return h(
    'div.cs-tile',
    null,
    h('span.cs-tile-k', { text: label }),
    h('b.cs-tile-v', null, value, unit ? h('small', { text: unit }) : null),
    values ? spark(values, opts) : null
  );
}

const show = (v, digits = 0) => (v == null ? '—' : digits ? v.toFixed(digits).replace('.', ',') : String(Math.round(v)));

/**
 * Живая панель качества звонка.
 * @param {HTMLElement} root
 * @param {{rec: import('./callstats.js').CallRecorder|null, sample: object|null,
 *          callSec: number, delivery?: {first: object}, bridgeMode?: string}} st
 */
export function renderLiveStats(root, { rec, sample, callSec = 0, delivery = null, bridgeMode = '', media = '' }) {
  if (!root) return;
  const route = sample?.route || rec?.last?.route || null;
  const isBridge = route === 'bridge';
  const mos = sample?.mos ?? null;
  const q = mosLabel(mos);
  const level = isBridge ? 'mid' : sample?.level || q.level;
  const ring = svg('svg', { class: 'cs-ring', viewBox: '0 0 44 44', 'aria-hidden': 'true' });
  const frac = mos == null ? 0 : Math.max(0, Math.min(1, (mos - 1) / 3.5));
  ring.append(svg('circle', { class: 'cs-ring-bg', cx: 22, cy: 22, r: 19 }));
  ring.append(svg('circle', {
    class: 'cs-ring-fg', cx: 22, cy: 22, r: 19,
    'stroke-dasharray': `${(frac * 119.4).toFixed(1)} 119.4`,
  }));
  const routeLine = [sample?.proto, audioCodecLabel(sample?.codec)]
    .filter(Boolean)
    .join(' · ');
  const hero = h(
    'div.cs-hero',
    { dataset: { level } },
    h('div.cs-score', null, ring, h('b.cs-score-num', { text: isBridge ? '—' : show(mos, 1) })),
    h(
      'div.cs-hero-text',
      null,
      h('b', { text: isBridge ? 'Голос через мост' : `Качество: ${q.text}` }),
      h('span', { text: route ? ROUTE_LABELS[route] || route : 'Соединяемся…' }),
      routeLine ? h('span.cs-sub', { text: routeLine }) : null,
      isBridge ? h('span.cs-sub', { text: bridgeMode === 'webcodecs' ? 'Opus-кадры 20 мс (WebCodecs)' : 'Пакеты MediaRecorder' }) : null
    )
  );
  const grid = h('div.cs-grid');
  if (!isBridge) {
    const v = sample?.videoIn;
    grid.append(
      tile('Задержка', show(sample?.rtt), 'мс', rec?.series('rtt'), { min: 0 }),
      tile('Потери', show(sample?.loss, 1), '%', rec?.series('loss'), { min: 0, max: 10 }),
      tile('Джиттер', show(sample?.jitter), 'мс', rec?.series('jitter'), { min: 0 }),
      tile('Входящий', fmtKbps(sample?.kbpsIn), '', rec?.series('kbpsIn'), { min: 0 }),
      tile('Исходящий', fmtKbps(sample?.kbpsOut), '', rec?.series('kbpsOut'), { min: 0 }),
      tile('Видео', v ? `${v.w}×${v.h}` : 'нет', v ? `${v.fps} к/с` : '', null)
    );
  }
  const rows = h('div.cs-rows');
  const row = (k, v) => rows.append(h('div.cs-row', null, h('span', { text: k }), h('b', { text: v })));
  row('Длительность', fmtDur(callSec));
  const sum = rec?.summary();
  if (sum?.rtt != null) row('Средняя задержка', `${sum.rtt} мс (макс. ${sum.rttMax})`);
  if (sum?.loss != null) row('Средние потери', `${show(sum.loss, 1)} %`);
  if (sample?.limitation) row('Видео ограничивает', LIMITATION[sample.limitation] || sample.limitation);
  if (!isBridge && videoCodecLabel(sample?.vcodecOut)) row('Кодек исходящего видео', videoCodecLabel(sample.vcodecOut));
  if (!isBridge && videoCodecLabel(sample?.vcodecIn)) row('Кодек входящего видео', videoCodecLabel(sample.vcodecIn));
  if (media) row('Режим видео', media);
  // Какой канал сигналинга доставлял сообщения первым (доля от всех).
  const first = Object.entries(delivery?.first || {}).filter(([, n]) => n > 0);
  const total = first.reduce((acc, [, n]) => acc + n, 0);
  const via = first
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${VIA[k] || k} ${Math.round((n * 100) / total)} %`)
    .join(' · ');
  if (via) row('Первым доставлял сигнал', via);
  root.replaceChildren(hero, grid, rows);
}

// ---------- вкладка «Звонки» ----------

const OUTCOME = {
  completed: 'Разговор',
  accepted: 'Разговор',
  declined: 'Отклонён',
  missed: 'Без ответа',
  expired: 'Без ответа',
  cancelled: 'Отменён',
};

function whenText(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (ts >= today.getTime()) return t;
  if (ts >= today.getTime() - 86400000) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
}

/** KPI, дневной график и доля маршрутов. digest — из journalDigest(). */
export function renderCallsDashboard(root, digest) {
  if (!root) return;
  if (!digest || !digest.total) {
    root.replaceChildren();
    root.classList.add('hidden');
    return;
  }
  root.classList.remove('hidden');
  const kpi = (value, label, level) => h('div.cd-kpi', level ? { dataset: { level } } : null, h('b', { text: value }), h('span', { text: label }));
  const mos = digest.avgMos;
  const kpis = h(
    'div.cd-kpis',
    null,
    kpi(String(digest.talk), plural(digest.talk, 'разговор', 'разговора', 'разговоров')),
    kpi(fmtDurShort(digest.talkSec), 'на связи'),
    kpi(mos == null ? '—' : mos.toFixed(1).replace('.', ','), 'качество', mos == null ? null : mosLabel(mos).level),
    kpi(digest.avgRtt == null ? '—' : `${digest.avgRtt} мс`, 'задержка')
  );
  const days = digest.perDay;
  const peak = Math.max(1, ...days.map((d) => d.sec));
  const chartSec = days.reduce((a, d) => a + d.sec, 0);
  const dm = (key) => `${key.slice(8, 10)}.${key.slice(5, 7)}`;
  const bars = h('div.cd-bars', { role: 'img', 'aria-label': `Разговоры за ${days.length} ${plural(days.length, 'день', 'дня', 'дней')}: ${fmtDurWords(chartSec)}` });
  for (const d of days) {
    const pct = d.sec ? Math.max(6, Math.round((d.sec / peak) * 100)) : 0;
    const bar = h('i', { title: `${dm(d.day)}: ${d.n} · ${fmtDurWords(d.sec)}`, dataset: d.sec ? null : { empty: '' } });
    bar.style.height = pct + '%';
    bars.append(bar);
  }
  const chart = h(
    'div.cd-chart',
    null,
    h('div.cd-chart-head', null, h('span', { text: `Разговоры за ${days.length} ${plural(days.length, 'день', 'дня', 'дней')}` }), h('b', { text: chartSec ? fmtDurWords(chartSec) : 'тишина' })),
    bars,
    days.length ? h('div.cd-axis', null, h('span', { text: dm(days[0].day) }), h('span', { text: 'сегодня' })) : null
  );
  const head = h('div.cd-head', null, h('b', { text: 'Статистика' }), h('span', { text: digest.missed ? `за 30 дней · пропущено ${digest.missed}` : 'за 30 дней' }));
  const totalRoutes = Object.values(digest.routes).reduce((a, b) => a + b, 0);
  let routes = null;
  if (totalRoutes) {
    const bar = h('div.cd-route-bar');
    const legend = h('div.cd-legend');
    for (const [k, n] of Object.entries(digest.routes)) {
      if (!n) continue;
      const seg = h('i', { dataset: { route: k } });
      seg.style.flexGrow = String(n);
      bar.append(seg);
      legend.append(h('span', { dataset: { route: k } }, h('i'), `${ROUTE_LABELS[k]} · ${Math.round((n / totalRoutes) * 100)}%`));
    }
    routes = h('div.cd-routes', null, bar, legend);
  }
  root.replaceChildren(head, kpis, chart, routes || '');
}

/** Список последних звонков в стиле Telegram. */
export function renderCallsList(ul, entries, { limit = 30, now = Date.now(), onCall = null, onMenu = null, nameOf = null } = {}) {
  if (!ul) return;
  ul.replaceChildren();
  if (!entries.length) {
    ul.append(
      h('li.calls-empty', null, icon('i-clock', 'ic lg'), h('b', { text: 'Звонков пока нет' }), h('span', { text: 'Здесь появятся длительность, маршрут и качество каждого звонка.' }))
    );
    return;
  }
  for (const v of entries.slice(0, limit)) {
    const missed = v.outcome === 'missed' || v.outcome === 'expired' || v.outcome === 'declined';
    const kind = missed ? 'missed' : v.dir === 'in' ? 'in' : v.dir === 'out' ? 'out' : 'link';
    const dirText = v.dir === 'in' ? 'Входящий' : v.dir === 'out' ? 'Исходящий' : 'По ссылке';
    const parts = [dirText];
    if (v.dur > 0) parts.push(fmtDurWords(v.dur));
    else parts.push(OUTCOME[v.outcome] || v.outcome || '');
    if (v.route) parts.push(ROUTE_SHORT[v.route] || v.route);
    const q = v.mos != null ? mosLabel(v.mos) : null;
    // v38: имя из контактов (если номер сохранён) — приоритетнее имени из звонка.
    const name = (nameOf && nameOf(v)) || v.name || (v.dir === 'link' ? 'Звонок по ссылке' : 'Без имени');
    // v38: у записи с известным номером (fp) — кнопка обратного звонка.
    const canCall = !!(v.fp && onCall);
    const li = h(
      'li.call-li',
      { dataset: { kind }, tabindex: onMenu && v.fp ? '0' : null },
      h('span.call-av', { text: (name[0] || '?').toUpperCase(), 'aria-hidden': 'true' }),
      h(
        'div.call-body',
        null,
        h('b.call-name', { text: name }),
        h('span.call-meta', null, icon(v.dir === 'in' ? 'i-arrow-in' : 'i-arrow-out', 'ic call-dir'), parts.filter(Boolean).join(' · '))
      ),
      h(
        'div.call-side',
        null,
        h('span.call-when', { text: whenText(v.ts, now) }),
        q ? h('span.call-q', { dataset: { level: q.level }, title: `Качество ${q.text} (MOS ${v.mos})`, text: v.mos.toFixed(1).replace('.', ',') }) : null
      ),
      canCall ? h('button.icon-btn.call-back', { type: 'button', title: 'Перезвонить', 'aria-label': 'Перезвонить ' + name }, icon('i-phone')) : null
    );
    if (canCall) {
      li.querySelector('.call-back').onclick = (e) => {
        e.stopPropagation();
        onCall(v);
      };
    }
    if (onMenu && v.fp) {
      li.classList.add('has-menu');
      li.onclick = () => onMenu(v, li);
      li.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onMenu(v, li);
        }
      };
    }
    ul.append(li);
  }
}

/** v38: адресная книга на вкладке «Звонки». Имена — только локальные. */
export function renderContactsList(ul, contacts, { now = Date.now(), onCall = null, onMenu = null } = {}) {
  if (!ul) return;
  ul.replaceChildren();
  if (!contacts.length) {
    ul.append(
      h(
        'li.calls-empty.contacts-empty',
        null,
        h('b', { text: 'Контактов пока нет' }),
        h('span', { text: 'Сохраните номер из «Недавних звонков» (нажмите на запись) или добавьте чужую личную ссылку.' })
      )
    );
    return;
  }
  for (const c of contacts) {
    const name = c.name || 'Без имени';
    const meta = c.lastAt ? 'Последний звонок: ' + whenText(c.lastAt, now) : 'Номер ' + String(c.fp || '').slice(0, 4) + '…' + String(c.fp || '').slice(-4);
    const li = h(
      'li.call-li.contact-li',
      { tabindex: '0', dataset: { kind: 'contact' } },
      h('span.call-av', { text: (name[0] || '?').toUpperCase(), 'aria-hidden': 'true' }),
      h('div.call-body', null, h('b.call-name', { text: name }), h('span.call-meta', { text: meta })),
      h('button.icon-btn.call-back', { type: 'button', title: 'Позвонить', 'aria-label': 'Позвонить ' + name }, icon('i-phone'))
    );
    li.querySelector('.call-back').onclick = (e) => {
      e.stopPropagation();
      onCall?.(c);
    };
    li.onclick = () => onMenu?.(c, li);
    li.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onMenu?.(c, li);
      }
    };
    ul.append(li);
  }
}
