// Чаты с контактами и группы: список слева, переписка справа (в узком окне — по очереди).
// Сообщения, статусы, очередь доставки (P2P → комната контакта/группы → почтовый ящик) и файлы — в ядре:
// crates/zv-core/src/chats.rs, groups.rs, files.rs. Здесь — только страница «Чаты».
import {
  $,
  h,
  icon,
  call,
  on,
  host,
  initials,
  fmtTime,
  fmtSize,
  dayLabel,
  ago,
  toast,
  copyText,
  dialog,
  confirmDialog,
  promptDialog,
  menu,
  openCall,
  openWebChat,
} from './lib.js';
import {
  C as CT,
  callContact,
  contactById,
  safetyDialog,
  inviteDialog,
  addDialog,
  offerContact,
} from './contacts.js';

export const CH = {
  list: [], // чаты (по одному на контакт) и группы (group: true): chats_list
  unread: 0,
  cur: null, // открытый чат (id контакта)
  visible: false, // страница «Чаты» на экране
  msgs: [], // сообщения открытого чата по порядку
  more: false, // есть ли более старые
  loading: false,
  reply: null, // id сообщения, на которое отвечаем
  edit: null, // id своего сообщения, которое правим
  unreadMark: null, // первое непрочитанное на момент открытия
  newBelow: 0, // новых сообщений ниже видимой части
};
let onUnread = () => {};
let onList = () => {};
const drafts = new Map(); // чат → {text, reply}
const nodes = new Map(); // id сообщения → {sig, node}
const previews = new Map(); // fid → Promise<blob: URL | null>
let listT = null;
let presT = null;
let readT = null;
let focusKey = '';

const IMG_PREVIEW_MAX = 16 << 20;
const BLOB_MAX = 32 << 20;
const DANGEROUS =
  /\.(exe|msi|msix|msixbundle|msp|appx|appxbundle|bat|cmd|com|scr|pif|cpl|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|ws|hta|lnk|reg|jar|dll|sys|inf|url|application|gadget|msc|iso|img|vhd|vhdx|chm|scf)$/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}»]/gi;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;

const chatInfo = (id) => CH.list.find((c) => c.chat === id);
const byId = (id) => CH.msgs.find((m) => m.id === id);
const isImage = (f) => !!f && /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.mime || '');
const cmp = (a, b) => a.lc - b.lc || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const wide = () => matchMedia('(min-width: 821px)').matches;
const isGroup = (c) => !!(c && c.group);
const GROUP_MAX = 6;
const plural = (n, one, few, many) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
// цвет имени автора в группе — оттенок по его id (светлота — в CSS под тему)
const NAME_HUES = [340, 290, 215, 185, 130, 32, 12, 260];
const nameHue = (id = '') => {
  let x = 0;
  for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_HUES[x % NAME_HUES.length];
};
const avatar = (c) => (isGroup(c) ? h('div.av.grp', icon('users')) : h('div.av', initials(c.name)));
const typingText = (c) => {
  if (!isGroup(c)) return 'печатает…';
  const w = (c.typingWho || []).filter(Boolean);
  if (!w.length) return 'печатает…';
  return w.length === 1 ? `${w[0]} печатает…` : `${w.slice(0, 2).join(', ')}${w.length > 2 ? ' и др.' : ''} печатают…`;
};

// ---------- загрузка и события ----------
export async function loadChats() {
  const list = await call('chats_list').catch(() => null);
  if (!Array.isArray(list)) return;
  const was = chatInfo(CH.cur);
  const wasLeft = !!(was && was.left);
  CH.list = list;
  CH.unread = list.reduce((n, c) => n + (c.unread || 0), 0);
  onUnread(CH.unread);
  renderList();
  onList();
  const now = chatInfo(CH.cur);
  if (CH.cur && !now) closeChat(); // контакт или группа удалены
  else if (CH.cur && isGroup(now) && !!now.left !== wasLeft) {
    renderConv();
    renderMsgs({ bottom: true });
  } else if (CH.cur) renderHead();
}
const reloadList = () => {
  clearTimeout(listT);
  listT = setTimeout(() => loadChats().catch(console.error), 120);
};

function wire() {
  on('chat:', (ev, p) => {
    p = p || {};
    if (ev === 'chat:msg') onMsg(p);
    else if (ev === 'chat:state') onState(p);
    else if (ev === 'chat:typing') onTyping(p);
    else if (ev === 'chat:file') onFile(p);
    else if (ev === 'chat:unread') {
      CH.unread = p.total || 0;
      onUnread(CH.unread);
      for (const c of CH.list) c.unread = (p.chats && p.chats[c.chat]) || 0;
      renderList();
    } else if (ev === 'chat:removed') {
      if (p.chat === CH.cur) {
        CH.msgs = CH.msgs.filter((m) => m.id !== p.id);
        renderMsgs();
      }
      reloadList();
    } else if (ev === 'chat:cleared') {
      if (p.chat === CH.cur) {
        CH.msgs = [];
        CH.more = false;
        CH.unreadMark = null;
        renderMsgs();
      }
      reloadList();
    }
  });
  on('contacts:', (ev, p) => {
    if (ev === 'contacts:presence' && p && p.id) {
      const c = chatInfo(p.id);
      if (c) {
        c.online = p.online;
        if (p.online) c.lastSeen = Date.now();
        renderList();
        if (p.id === CH.cur) renderHead();
      }
      return;
    }
    reloadList();
  });
  on('group:', (ev, p) => {
    p = p || {};
    if (ev === 'group:joined') toast(`${p.by || 'Контакт'} добавил(а) вас в группу «${p.name || ''}»`, 4000);
    reloadList();
  });
  on('p2p:', () => renderP2p());
  on('host:', (ev, p) => {
    if (ev === 'host:drag') dragShow(!!(p && p.on));
    if (ev === 'host:drop') {
      dragShow(false);
      const paths = (p && p.paths) || [];
      if (paths.length) offerFiles(paths.map((path) => ({ path, name: String(path).split(/[\\/]/).pop() })));
    }
  });
  document.addEventListener('visibilitychange', syncFocus);
  addEventListener('focus', syncFocus);
  addEventListener('blur', syncFocus);
  $('#chNewGroup')?.addEventListener('click', () => newGroupDialog());
  $('#chWeb')?.addEventListener('click', () => openWebChat('').catch((e) => toast('Не открылось: ' + (e.message || e))));
  $('#chSearch').addEventListener('input', renderList);
  $('#chSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = '';
      renderList();
    }
  });
}

export function initChats(opts = {}) {
  onUnread = opts.onUnread || onUnread;
  onList = opts.onList || onList;
  wire();
  return loadChats();
}

/// Страница «Чаты» показана / скрыта.
export function chatsVisible(v) {
  if (!v) saveDraft();
  CH.visible = v;
  clearInterval(presT);
  presT = null;
  if (v) {
    renderP2p();
    if (!CH.cur && wide()) {
      const last = localStorage.zvLastChat;
      const first = (last && chatInfo(last)) || null;
      if (first) openChat(first.chat);
      else renderConv();
    } else if (CH.cur) {
      renderMsgs();
    }
    // «в сети»: ядро проверяет соединением, не чаще раза в 20 с на контакт
    const poll = () =>
      call('contacts_presence')
        .then((list) => {
          if (!Array.isArray(list)) return;
          for (const ct of list) {
            const c = chatInfo(ct.id);
            if (c) {
              c.online = ct.online;
              c.lastSeen = ct.lastSeen;
            }
          }
          renderList();
          renderHead();
        })
        .catch(() => {});
    poll();
    presT = setInterval(poll, 15000);
  }
  syncFocus();
}

/// Открыт ли чат на экране (ядро: не уведомлять; оболочка: отмечать прочитанным).
function syncFocus() {
  const shown = CH.visible && !!CH.cur && document.visibilityState === 'visible';
  const vis = shown && (host !== 'tauri' || document.hasFocus());
  const key = `${CH.visible ? CH.cur : ''}|${vis}`;
  if (key !== focusKey) {
    focusKey = key;
    call('chat_focus', { chat: CH.visible ? CH.cur : null, visible: vis }).catch(() => {});
  }
  if (vis) markRead();
}
function markRead() {
  clearTimeout(readT);
  readT = setTimeout(() => {
    const c = chatInfo(CH.cur);
    const any = CH.msgs.some((m) => !m.out && m.st < 3 && !m.deleted);
    if (!c || (!c.unread && !any)) return;
    for (const m of CH.msgs) if (!m.out && m.st < 3) m.st = 3;
    call('chat_read', { chat: c.chat }).catch(() => {});
  }, 250);
}

function onMsg(p) {
  const m = p.msg;
  if (!m || !m.chat) return;
  if (m.chat === CH.cur) {
    const sc = $('#chScroll');
    const atBottom = sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80 : true;
    const fresh = upsert(m);
    if (fresh && !m.out && !atBottom) CH.newBelow++;
    renderMsgs({ bottom: fresh && m.out });
    if (fresh && !m.out) syncFocus();
  }
  // список: последнее сообщение и порядок
  const c = chatInfo(m.chat);
  if (c && p.new) {
    c.last = m;
    if (!m.out) c.typing = false;
    CH.list.sort((a, b) => lastAt(b) - lastAt(a) || a.name.localeCompare(b.name, 'ru'));
    renderList();
  } else reloadList();
}
const lastAt = (c) => (c.last ? Math.min(c.last.ts, Math.max(c.last.rx || 0, c.last.ts)) : 0);

function onState(p) {
  if (p.chat === CH.cur) {
    for (const id of p.ids || []) {
      const m = byId(id);
      if (m && m.st < p.st) m.st = p.st;
    }
    renderMsgs();
  }
  const c = chatInfo(p.chat);
  if (c && c.last && (p.ids || []).includes(c.last.id) && c.last.st < p.st) {
    c.last.st = p.st;
    renderList();
  }
}

function onTyping(p) {
  const c = chatInfo(p.chat);
  if (!c) return;
  c.typing = !!p.on;
  if (isGroup(c)) c.typingWho = p.who || [];
  renderList();
  if (p.chat === CH.cur) renderHead();
}

function onFile(p) {
  if (p.chat !== CH.cur) return;
  const m = byId(p.msg);
  if (!m || !m.file) return;
  Object.assign(m.file, { st: p.st, done: p.done, path: p.path ?? m.file.path, err: p.err ?? '' });
  renderMsgs();
}

function upsert(m) {
  const i = CH.msgs.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    CH.msgs[i] = m;
    return false;
  }
  let j = CH.msgs.length;
  while (j > 0 && cmp(CH.msgs[j - 1], m) > 0) j--;
  CH.msgs.splice(j, 0, m);
  return true;
}

// ---------- список чатов ----------
function presenceOf(c) {
  if (c.online) return ['ok', 'в сети'];
  if (c.lastSeen) return ['off', `был(а) в сети ${ago(c.lastSeen)}`];
  return ['off', c.online === false ? 'не в сети' : ''];
}
function listTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ms);
  if ((now - d) / 864e5 < 6) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return d.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit',
  });
}
function previewText(m, you = false) {
  let t;
  if (m.deleted) t = 'Сообщение удалено';
  else if (m.kind === 'file' && m.file) t = `${isImage(m.file) ? '🖼' : '📎'} ${m.body || m.file.name}`;
  else if (m.kind === 'call') t = `${m.file && m.file.video ? '🎥' : '📞'} Групповой звонок`;
  else t = m.body || '';
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 120) t = t.slice(0, 120) + '…';
  if (m.kind === 'sys') return t;
  if (you && m.out) return `Вы: ${t}`;
  return you && m.senderName ? `${m.senderName}: ${t}` : t;
}
// в группе отметок о прочтении нет: ✓✓ — получили все, ✓ — получили не все (остальным — из ящика группы)
function tick(st, grp = false) {
  if (st >= 3) return h('span.tk.read', { title: 'Прочитано' }, icon('tick2'));
  if (st === 2) return h('span.tk', { title: grp ? 'Доставлено всем' : 'Доставлено' }, icon('tick2'));
  if (st === 1)
    return h(
      'span.tk',
      {
        title: grp
          ? 'Доставлено не всем — остальные получат, когда появятся в сети'
          : 'В почтовом ящике — собеседник получит, когда появится в сети',
      },
      icon('tick1'),
    );
  return h('span.tk.wait', { title: 'Отправляется…' }, icon('clock'));
}

function renderList() {
  const box = $('#chList');
  if (!box) return;
  const q = ($('#chSearch').value || '').trim().toLowerCase();
  const items = CH.list.filter((c) => !q || c.name.toLowerCase().includes(q));
  if (!items.length) {
    box.replaceChildren(
      q
        ? h('div.empty', icon('search'), h('div', 'Никого не нашли'))
        : h(
            'div.empty',
            icon('chat'),
            h('div', 'Чатов пока нет'),
            h('div.muted', 'Добавьте контакт — и пишите ему напрямую, без серверов.'),
            h(
              'div.row',
              { style: { justifyContent: 'center', marginTop: '12px', flexWrap: 'wrap' } },
              h('button.btn', { onclick: () => addDialog() }, icon('userplus', 'sm'), 'Добавить по коду'),
              h('button.btn.primary', { onclick: () => inviteDialog() }, icon('plus', 'sm'), 'Пригласить'),
            ),
          ),
    );
    return;
  }
  box.replaceChildren(...items.map(listRow));
}
function listRow(c) {
  const last = c.last;
  const [pc, pt] = presenceOf(c);
  return h(
    'div.ch-item',
    {
      class: c.chat === CH.cur ? 'on' : '',
      'data-chat': c.chat,
      role: 'button',
      tabindex: '0',
      onclick: () => openChat(c.chat),
      onkeydown: (e) => {
        if (e.key === 'Enter') openChat(c.chat);
      },
    },
    h('div.av-wrap', avatar(c), isGroup(c) ? null : h('span.pres', { class: pc, title: pt })),
    h(
      'div.body',
      h(
        'div.top',
        h('b', c.name),
        isGroup(c) && c.left ? h('span.muted.sm', 'вы вышли') : null,
        c.verified ? h('span.vbadge', { title: 'Код безопасности сверен' }, icon('shield', 'sm')) : null,
        h('span.grow'),
        last && last.out && !last.deleted ? tick(last.st, isGroup(c)) : null,
        last ? h('span.time', listTime(last.ts)) : null,
      ),
      h(
        'div.bot',
        c.typing
          ? h('span.prev.typing', typingText(c))
          : h('span.prev', last ? previewText(last, true) : 'Нет сообщений'),
        c.unread ? h('span.pill', c.unread > 99 ? '99+' : String(c.unread)) : null,
      ),
    ),
  );
}

function renderP2p() {
  const w = $('#chP2p');
  if (!w) return;
  if (!CT.p2p.enabled) {
    w.replaceChildren(
      h('b', 'Прямые соединения выключены'),
      h('small', 'Сообщения идут медленнее, файлы не передаются.'),
      h(
        'button.btn.sm.primary',
        { onclick: () => call('settings_set', { patch: { p2p: true } }).catch((e) => toast(e.message || e)) },
        'Включить',
      ),
    );
    w.classList.remove('hidden');
  } else w.classList.add('hidden');
}

// ---------- переписка ----------
export async function openChat(chat) {
  if (!chatInfo(chat)) await loadChats();
  if (!chatInfo(chat)) return;
  if (CH.cur !== chat) {
    saveDraft();
    CH.cur = chat;
    CH.msgs = [];
    CH.more = false;
    CH.reply = CH.edit = null;
    CH.unreadMark = null;
    CH.newBelow = 0;
    nodes.clear();
    localStorage.zvLastChat = chat;
    renderConv();
    renderList();
    const r = await call('chat_history', { chat, limit: 60 }).catch(() => ({ msgs: [], more: false }));
    if (CH.cur !== chat) return;
    for (const m of r.msgs || []) upsert(m);
    CH.more = !!r.more;
    const first = CH.msgs.find((m) => !m.out && !m.deleted && m.st < 3);
    CH.unreadMark = first ? first.id : null;
    renderMsgs({ bottom: true });
    const mark = $('.ch-unread');
    if (mark) mark.scrollIntoView({ block: 'start' });
  }
  syncFocus();
  if (wide()) $('#chInput')?.focus();
}
function closeChat() {
  saveDraft();
  CH.cur = null;
  CH.msgs = [];
  nodes.clear();
  renderConv();
  renderList();
  syncFocus();
}

function renderConv() {
  const pane = $('#chConv');
  if (!pane) return;
  $('#page-chats').classList.toggle('open', !!CH.cur);
  const c = chatInfo(CH.cur);
  if (!c) {
    pane.replaceChildren(
      h(
        'div.ch-none',
        icon('chat', 'lg'),
        h('b', CH.list.length ? 'Выберите чат' : 'Здесь будут переписки'),
        h('small', 'Сообщения и файлы идут напрямую между устройствами. Если собеседник не в сети — дождутся его.'),
      ),
    );
    return;
  }
  const ta = h('textarea.field#chInput', { rows: 1, maxlength: 16000, placeholder: 'Сообщение', spellcheck: 'true' });
  const sc = h('div.ch-scroll#chScroll', h('div.ch-msgs#chMsgs'));
  const readOnly = isGroup(c) && c.left;
  pane.replaceChildren(
    h('div.ch-top#chTop'),
    sc,
    h(
      'button.ch-down.hidden#chDown',
      {
        title: 'К последним сообщениям',
        onclick: () => {
          CH.newBelow = 0;
          sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
        },
      },
      icon('down'),
      h('span.pill.hidden'),
    ),
    h('div.ch-drop.hidden#chDrop', h('div', icon('clip', 'lg'), h('b', 'Отпустите, чтобы отправить'))),
    readOnly
      ? h(
          'div.ch-compose.ch-left',
          h('span', 'Вы больше не участник этой группы — переписка осталась только для чтения.'),
          h('button.btn.sm', { onclick: () => deleteGroup(c) }, icon('trash', 'sm'), 'Удалить группу'),
        )
      : h(
          'div.ch-compose',
          h('div.ch-ctx.hidden#chCtx'),
          h(
            'div.ch-row',
            h('button.btn.ghost.icon#chAttach', { title: 'Прикрепить файл', onclick: attach }, icon('clip')),
            ta,
            h('button.btn.primary.icon#chSend', { title: 'Отправить (Enter)', onclick: send }, icon('send')),
          ),
        ),
  );
  // черновик
  const d = drafts.get(c.chat);
  if (d) {
    ta.value = d.text || '';
    CH.reply = d.reply || null;
  }
  ta.addEventListener('input', () => {
    autosize(ta);
    if (ta.value.trim() && !CH.edit) call('chat_typing', { chat: CH.cur }).catch(() => {});
  });
  ta.addEventListener('keydown', onKey);
  ta.addEventListener('paste', onPaste);
  sc.addEventListener('scroll', onScroll);
  // перетаскивание в браузере / zv-devhost (в приложении файлы приходят от окна: host:drop)
  pane.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      dragShow(true);
    }
  });
  pane.addEventListener('dragleave', (e) => {
    if (!pane.contains(e.relatedTarget)) dragShow(false);
  });
  pane.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length || readOnly) return;
    e.preventDefault();
    dragShow(false);
    offerFiles(files.map((f) => ({ file: f, name: f.name, size: f.size })));
  });
  renderHead();
  renderCtx();
  autosize(ta);
}

function renderHead() {
  const top = $('#chTop');
  const c = chatInfo(CH.cur);
  if (!top || !c) return;
  if (isGroup(c)) {
    const n = (c.members || []).length;
    const sub = c.typing
      ? typingText(c)
      : c.left
        ? 'вы больше не участник'
        : `${n} ${plural(n, 'участник', 'участника', 'участников')}`;
    const canCall = !c.left && n > 1;
    top.replaceChildren(
      h('button.btn.ghost.icon.ch-back', { title: 'К списку чатов', onclick: closeChat }, icon('back')),
      h('div.av-wrap', avatar(c)),
      h(
        'div.who.click',
        { role: 'button', tabindex: '0', title: 'Участники', onclick: () => membersDialog(c.chat) },
        h('b', c.name),
        h('small', { class: c.typing ? 'typing' : '' }, sub),
      ),
      h(
        'div.acts',
        canCall
          ? h('button.btn.ghost.icon', { title: 'Групповой звонок', onclick: () => callGroup(c, false) }, icon('phone'))
          : null,
        canCall
          ? h('button.btn.ghost.icon', { title: 'Групповой видеозвонок', onclick: () => callGroup(c, true) }, icon('video'))
          : null,
        h('button.btn.ghost.icon', { title: 'Ещё', onclick: (e) => groupMenu(e.currentTarget, c) }, icon('more')),
      ),
    );
    return;
  }
  const [pc, pt] = c.typing ? ['ok', 'печатает…'] : presenceOf(c);
  const ct = contactById(c.chat);
  top.replaceChildren(
    h('button.btn.ghost.icon.ch-back', { title: 'К списку чатов', onclick: closeChat }, icon('back')),
    h('div.av-wrap', h('div.av', initials(c.name)), h('span.pres', { class: c.online ? 'ok' : 'off' })),
    h(
      'div.who',
      h(
        'b',
        c.name,
        c.verified ? h('span.vbadge', { title: 'Код безопасности сверен' }, icon('shield', 'sm')) : null,
      ),
      h('small', { class: c.typing ? 'typing' : pc === 'ok' ? 'on' : '' }, pt || 'не в сети'),
    ),
    h(
      'div.acts',
      ct
        ? h('button.btn.ghost.icon', { title: 'Позвонить', onclick: () => callContact(ct, false) }, icon('phone'))
        : null,
      ct
        ? h('button.btn.ghost.icon', { title: 'Видеозвонок', onclick: () => callContact(ct, true) }, icon('video'))
        : null,
      h('button.btn.ghost.icon', { title: 'Ещё', onclick: (e) => chatMenu(e.currentTarget, c) }, icon('more')),
    ),
  );
}
function chatMenu(anchor, c) {
  const ct = contactById(c.chat);
  menu(anchor, [
    ct && { icon: 'shield', label: 'Код безопасности', run: () => safetyDialog(ct) },
    {
      icon: 'trash',
      label: 'Очистить историю',
      danger: true,
      run: async () => {
        if (
          await confirmDialog(
            `Очистить переписку с «${c.name}»?`,
            'Сообщения и файлы удалятся только на этом компьютере. У собеседника переписка останется.',
            'Очистить',
            true,
          )
        )
          call('chat_clear', { chat: c.chat }).catch((e) => toast(e.message || e));
      },
    },
  ]);
}

// ---------- группы ----------
/** Группа из списка чатов (или null). */
export const groupById = (id) => {
  const c = chatInfo(id);
  return isGroup(c) ? c : null;
};
export async function callGroup(c, video) {
  try {
    const r = await call('group_call', { chat: c.chat, video: !!video });
    // без boot.contact: окно звонка не завершается, когда уходит один из участников
    await openCall(r.secret, { dir: 'out', peer: r.name, video: !!video });
  } catch (e) {
    toast('Не удалось позвонить: ' + (e.message || e), 4000);
  }
}
async function joinGroupCall(m) {
  try {
    const r = await call('group_call_join', { chat: m.chat, id: m.id });
    await openCall(r.secret, { dir: 'in', peer: r.name, video: !!r.video });
  } catch (e) {
    toast(e.message || String(e), 4000);
  }
}

function groupMenu(anchor, c) {
  menu(anchor, [
    { icon: 'users', label: 'Участники', run: () => membersDialog(c.chat) },
    c.admin &&
      !c.left && {
        icon: 'edit',
        label: 'Переименовать',
        run: async () => {
          const n = await promptDialog('Название группы', c.name, { label: 'Новое название увидят все участники.' });
          if (n && n.trim() && n.trim() !== c.name)
            call('group_rename', { chat: c.chat, name: n.trim() }).catch((e) => toast(e.message || e));
        },
      },
    {
      icon: 'trash',
      label: 'Очистить историю',
      run: async () => {
        if (
          await confirmDialog(
            `Очистить переписку группы «${c.name}»?`,
            'Сообщения и файлы удалятся только на этом компьютере. У участников переписка останется.',
            'Очистить',
            true,
          )
        )
          call('chat_clear', { chat: c.chat }).catch((e) => toast(e.message || e));
      },
    },
    !c.left && {
      icon: 'out',
      label: 'Выйти из группы',
      danger: true,
      run: async () => {
        if (
          await confirmDialog(
            `Выйти из группы «${c.name}»?`,
            c.admin
              ? 'Вы администратор — группу продолжит вести другой участник. Переписка останется у вас только для чтения.'
              : 'Новые сообщения перестанут приходить. Переписка останется у вас только для чтения.',
            'Выйти',
            true,
          )
        )
          call('group_leave', { chat: c.chat }).catch((e) => toast(e.message || e));
      },
    },
    { icon: 'trash', label: 'Удалить группу', danger: true, run: () => deleteGroup(c) },
  ]);
}

async function deleteGroup(c) {
  const ok = await confirmDialog(
    `Удалить группу «${c.name}»?`,
    c.left
      ? 'Переписка и файлы группы удалятся с этого компьютера.'
      : 'Вы выйдете из группы, а переписка и файлы удалятся с этого компьютера. У остальных участников группа останется.',
    'Удалить',
    true,
  );
  if (ok) call('group_delete', { chat: c.chat }).catch((e) => toast(e.message || e));
}

/** Участники: кто в сети, администратор; администратору — добавить/исключить. */
async function membersDialog(chat) {
  let info;
  try {
    info = await call('group_info', { chat });
  } catch (e) {
    toast(e.message || e);
    return;
  }
  dialog((b, close) => {
    const list = h('div.gm-list');
    const draw = () => {
      list.replaceChildren(
        ...info.members.map((m) =>
          h(
            'div.gm-row',
            h('div.av-wrap', h('div.av.sm', initials(m.name)), h('span.pres', { class: m.online ? 'ok' : 'off' })),
            h(
              'div.grow',
              h('b', m.me ? `${m.name} (вы)` : m.name),
              h(
                'small',
                [m.admin ? 'администратор' : '', !m.me && !m.contactId ? 'не в контактах' : '']
                  .filter(Boolean)
                  .join(' · ') || (m.online ? 'в сети' : ''),
              ),
            ),
            !m.me && !m.contactId
              ? h(
                  'button.btn.ghost.icon.sm',
                  { title: 'Добавить в контакты', onclick: () => offerContact(m.id, m.selfName || m.name) },
                  icon('userplus', 'sm'),
                )
              : null,
            info.admin && !info.left && !m.me
              ? h(
                  'button.btn.ghost.icon.sm',
                  {
                    title: 'Исключить из группы',
                    onclick: async () => {
                      if (
                        !(await confirmDialog(
                          `Исключить «${m.name}» из группы?`,
                          'Участник больше не получит новых сообщений: у группы сменится ключ.',
                          'Исключить',
                          true,
                        ))
                      )
                        return;
                      try {
                        await call('group_remove', { chat, member: m.id });
                        info = await call('group_info', { chat });
                        draw();
                      } catch (e) {
                        toast(e.message || e);
                      }
                    },
                  },
                  icon('x', 'sm'),
                )
              : null,
          ),
        ),
      );
    };
    draw();
    const free = (info.max || GROUP_MAX) - info.members.length;
    b.append(
      h('h3', info.name),
      h('p.muted', `${info.members.length} из ${info.max || GROUP_MAX} участников. Сообщения и звонки идут напрямую между устройствами.`),
      list,
      h(
        'div.actions',
        info.admin && !info.left && free > 0
          ? h(
              'button.btn',
              {
                onclick: () => {
                  close();
                  pickContacts({
                    title: 'Добавить в группу',
                    exclude: info.members.map((m) => m.id),
                    max: free,
                    okLabel: 'Добавить',
                  }).then((ids) => {
                    if (ids && ids.length)
                      call('group_add', { chat, members: ids }).catch((e) => toast(e.message || e, 4000));
                  });
                },
              },
              icon('userplus', 'sm'),
              'Добавить',
            )
          : null,
        h('span.grow'),
        h('button.btn.primary', { onclick: () => close() }, 'Готово'),
      ),
    );
  });
}

/** Выбор контактов (до `max`): Promise<id[] | null>. */
function pickContacts({ title, exclude = [], max = GROUP_MAX - 1, okLabel = 'Готово', withName = false } = {}) {
  return new Promise((res) => {
    const chosen = new Set();
    let done = false;
    dialog(
      (b, close) => {
        const name = withName ? h('input.field', { placeholder: 'Название группы', maxlength: 60 }) : null;
        const items = CT.list.filter((c) => !exclude.includes(c.peer));
        const ok = h('button.btn.primary', { disabled: true }, okLabel);
        const hint = h('small.muted');
        const upd = () => {
          ok.disabled = !chosen.size || (withName && !name.value.trim());
          hint.textContent = `Выбрано ${chosen.size} из ${max}`;
        };
        const rows = items.map((c) => {
          const cb = h('input', { type: 'checkbox' });
          cb.addEventListener('change', () => {
            if (cb.checked && chosen.size >= max) {
              cb.checked = false;
              toast(`Можно выбрать до ${max}`);
              return;
            }
            if (cb.checked) chosen.add(c.id);
            else chosen.delete(c.id);
            upd();
          });
          return h('label.gm-row.pick', cb, h('div.av.sm', initials(c.name)), h('div.grow', h('b', c.name)));
        });
        ok.addEventListener('click', () => {
          done = true;
          close();
          res(withName ? { name: name.value.trim(), ids: [...chosen] } : [...chosen]);
        });
        if (name) name.addEventListener('input', upd);
        b.append(
          h('h3', title),
          name,
          items.length
            ? h('div.gm-list', ...rows)
            : h('p.muted', 'Некого добавить: сначала добавьте людей в контакты.'),
          h('div.actions', hint, h('span.grow'), h('button.btn.ghost', { onclick: () => close() }, 'Отмена'), ok),
        );
        upd();
      },
      { onClose: () => !done && res(null) },
    );
  });
}

export async function newGroupDialog() {
  if (!CT.list.length) {
    toast('Сначала добавьте людей в контакты — из них собирается группа');
    return;
  }
  const r = await pickContacts({ title: 'Новая группа', withName: true, okLabel: 'Создать' });
  if (!r) return;
  try {
    const g = await call('group_create', { name: r.name, members: r.ids });
    await loadChats();
    openChat(g.chat);
  } catch (e) {
    toast(e.message || e, 4000);
  }
}

// ---------- сообщения ----------
function renderMsgs({ keep = false, bottom = false } = {}) {
  const sc = $('#chScroll');
  const box = $('#chMsgs');
  if (!sc || !box) return;
  const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  const prevH = sc.scrollHeight;
  const prevTop = sc.scrollTop;
  const kids = [];
  if (CH.more) kids.push(h('div.ch-more', CH.loading ? 'Загрузка…' : ''));
  let day = '';
  let prev = null;
  for (const m of CH.msgs) {
    const d = dayLabel(m.ts);
    if (d !== day) {
      day = d;
      kids.push(h('div.ch-day', h('span', d)));
      prev = null;
    }
    if (m.id === CH.unreadMark) {
      kids.push(h('div.ch-unread', h('span', 'Непрочитанные сообщения')));
      prev = null;
    }
    if (m.kind === 'sys' || m.kind === 'call') {
      kids.push(m.kind === 'sys' ? sysNode(m) : callNode(m));
      prev = null;
      continue;
    }
    const grp =
      !!prev && prev.out === m.out && (prev.sender || '') === (m.sender || '') && m.ts - prev.ts < 5 * 60e3 && !prev.deleted;
    kids.push(msgNode(m, grp));
    prev = m;
  }
  if (!CH.msgs.some((m) => m.kind !== 'sys')) {
    const c = chatInfo(CH.cur);
    kids.push(
      h(
        'div.ch-hello',
        icon(isGroup(c) ? 'users' : 'chat', 'lg'),
        h('b', 'Напишите первое сообщение'),
        h(
          'small',
          isGroup(c)
            ? `Переписка группы «${c.name}» идёт напрямую между участниками и хранится только у них.`
            : `Переписка с «${c ? c.name : 'собеседником'}» идёт напрямую между устройствами и хранится только у вас двоих.`,
        ),
      ),
    );
  }
  box.replaceChildren(...kids);
  if (keep) sc.scrollTop = prevTop + (sc.scrollHeight - prevH);
  else if (bottom || atBottom) sc.scrollTop = sc.scrollHeight;
  onScroll();
}

function onScroll() {
  const sc = $('#chScroll');
  if (!sc) return;
  const far = sc.scrollHeight - sc.scrollTop - sc.clientHeight > 240;
  if (!far) CH.newBelow = 0;
  const btn = $('#chDown');
  if (btn) {
    btn.classList.toggle('hidden', !far);
    const pill = btn.querySelector('.pill');
    pill.textContent = String(CH.newBelow);
    pill.classList.toggle('hidden', !CH.newBelow);
  }
  if (sc.scrollTop < 160 && CH.more && !CH.loading) loadOlder();
}

async function loadOlder() {
  const chat = CH.cur;
  if (!CH.msgs.length) return false;
  CH.loading = true;
  try {
    const r = await call('chat_history', { chat, before: CH.msgs[0].id, limit: 60 });
    if (chat !== CH.cur) return false;
    for (const m of r.msgs || []) upsert(m);
    CH.more = !!r.more;
  } catch {
    return false;
  } finally {
    CH.loading = false;
  }
  renderMsgs({ keep: true });
  return true;
}

/** Прокрутить к сообщению (подгрузив старые, если нужно) и подсветить. */
async function jumpTo(id) {
  for (let i = 0; i < 20 && !byId(id) && CH.more; i++) if (!(await loadOlder())) break;
  const el = document.querySelector(`.msg[data-id="${id}"]`);
  if (!el) {
    toast('Сообщение не найдено — возможно, удалено');
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function msgNode(m, grp) {
  const f = m.file || {};
  const sig = [m.st, m.edited, m.deleted, grp, m.body, f.st, f.done, f.err, m.reply && !!byId(m.reply), m.senderName].join(
    '|',
  );
  const hit = nodes.get(m.id);
  if (hit && hit.sig === sig) return hit.node;
  const b = h('div.bubble');
  let metaW = 44;
  if (m.deleted) {
    b.classList.add('del');
    b.append(h('div.txt', icon('trash', 'sm'), m.out ? 'Вы удалили сообщение' : 'Сообщение удалено', spacer(44)));
  } else {
    if (!m.out && m.senderName && !grp) b.append(h('div.who', { style: `--h:${nameHue(m.sender)}` }, m.senderName));
    if (m.reply) b.append(quoteNode(m.reply));
    const img = m.kind === 'file' && isImage(m.file) && (m.out || f.st === 'done') && f.size <= IMG_PREVIEW_MAX;
    if (m.kind === 'file' && m.file) b.append(img ? imageNode(m) : fileCard(m));
    if (m.edited) metaW += 62;
    if (m.out) metaW += 18;
    if (m.body) {
      b.append(
        h('div.txt', { class: EMOJI_ONLY.test(m.body.trim()) ? 'big' : '' }, ...linkify(m.body), spacer(metaW)),
      );
    } else if (img) b.classList.add('media');
    else b.append(h('div.meta-line'));
  }
  b.append(
    h(
      'span.meta',
      m.edited && !m.deleted ? h('span', { title: 'Изменено ' + new Date(m.edited).toLocaleString('ru-RU') }, 'изменено') : null,
      h('span', { title: new Date(m.ts).toLocaleString('ru-RU') }, fmtTime(m.ts)),
      m.out && !m.deleted ? tick(m.st, isGroup(chatInfo(m.chat))) : null,
    ),
  );
  b.addEventListener('contextmenu', (e) => {
    if (getSelection().toString() && b.contains(getSelection().anchorNode)) return; // копирование выделенного
    e.preventDefault();
    msgMenu({ x: e.clientX, y: e.clientY }, m);
  });
  const node = h(
    'div.msg',
    { class: (m.out ? 'out' : 'in') + (grp ? ' grp' : ''), 'data-id': m.id },
    b,
    h('button.m-act', { title: 'Действия', onclick: (e) => msgMenu(e.currentTarget, m) }, icon('more')),
  );
  nodes.set(m.id, { sig, node });
  return node;
}
const spacer = (w) => h('span.spacer', { style: { width: w + 'px' } });

/** Служебная строка группы: «Аня добавила Веру», «Название изменено…». */
function sysNode(m) {
  const sig = 'sys|' + m.body;
  const hit = nodes.get(m.id);
  if (hit && hit.sig === sig) return hit.node;
  const node = h('div.ch-sys', { 'data-id': m.id }, h('span', { title: new Date(m.ts).toLocaleString('ru-RU') }, m.body));
  nodes.set(m.id, { sig, node });
  return node;
}

/** Групповой звонок в ленте: «Присоединиться», пока звонок идёт (до 2 ч). */
function callNode(m) {
  const f = m.file || {};
  const sig = ['call', f.joinable, f.ended, m.senderName].join('|');
  const hit = nodes.get(m.id);
  if (hit && hit.sig === sig) return hit.node;
  const who = m.out ? 'Вы' : m.senderName || 'Участник';
  const node = h(
    'div.ch-call',
    { 'data-id': m.id, class: f.joinable ? 'live' : '' },
    h('div.ci', icon(f.video ? 'video' : 'phone')),
    h(
      'div.cb',
      h('b', f.video ? 'Групповой видеозвонок' : 'Групповой звонок'),
      h('small', `${who} · ${fmtTime(m.ts)}${f.joinable ? '' : ' · завершён'}`),
    ),
    f.joinable ? h('button.btn.sm.primary', { onclick: () => joinGroupCall(m) }, 'Присоединиться') : null,
  );
  nodes.set(m.id, { sig, node });
  return node;
}

function quoteNode(id) {
  const q = byId(id);
  const c = chatInfo(CH.cur);
  return h(
    'div.quote',
    { title: 'Перейти к сообщению', onclick: () => jumpTo(id) },
    h('b', q ? (q.out ? 'Вы' : q.senderName || (c && c.name) || 'Собеседник') : 'Ответ'),
    h('span', q ? previewText(q) : 'сообщение выше'),
  );
}

function linkify(text) {
  const out = [];
  let i = 0;
  for (const mt of text.matchAll(URL_RE)) {
    if (mt.index > i) out.push(text.slice(i, mt.index));
    const url = mt[0];
    out.push(
      h(
        'a',
        {
          href: url,
          title: url,
          onclick: (e) => {
            e.preventDefault();
            openUrl(url);
          },
        },
        url,
      ),
    );
    i = mt.index + url.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}
async function openUrl(url) {
  const r = await call('link_parse', { text: url }).catch(() => ({}));
  if (r.kind === 'call') {
    if (await confirmDialog('Позвонить по ссылке?', 'Ссылку прислали в чате.', 'Позвонить')) {
      openCall(r.secret, { dir: 'out' }).catch((e) => toast('Не удалось начать звонок: ' + (e.message || e)));
    }
    return;
  }
  if (r.kind === 'contact') {
    addDialog(url);
    return;
  }
  if (host === 'tauri') call('host_open_external', { url }).catch((e) => toast(e.message || e));
  else window.open(url, '_blank', 'noopener');
}

// ---------- файлы ----------
function fileCard(m) {
  const f = m.file;
  const st = f.st || (m.out ? 'ready' : 'offered');
  const pct = f.size ? Math.min(100, Math.floor(((f.done || 0) * 100) / f.size)) : 0;
  const size = fmtSize(f.size);
  const btn = (ic, label, run, cls = '') =>
    h('button.btn.sm', { class: cls, 'data-act': label, onclick: run }, icon(ic, 'sm'), label);
  const cancel = () => btn('x', 'Отмена', () => call('chat_file_cancel', { fid: f.fid }).catch((e) => toast(e.message || e)), 'ghost');
  const accept = (label) => btn('download', label, () => call('chat_file_accept', { fid: f.fid }).catch((e) => toast(e.message || e)), 'primary');
  let sub = size;
  let bar = null;
  const acts = [];
  if (m.out) {
    if (st === 'sending') {
      sub = `передаётся · ${pct}%`;
      bar = pct;
    } else if (st === 'canceled') sub = `${size} · отправка отменена`;
    if (st !== 'canceled') acts.push(btn('folder', 'В папке', () => openFile(m, true), 'ghost'));
  } else if (st === 'offered') acts.push(accept('Скачать'));
  else if (st === 'queued' || st === 'waiting') {
    sub = st === 'waiting' ? `${size} · ждём, когда собеседник будет в сети` : `${size} · в очереди`;
    acts.push(cancel());
  } else if (st === 'loading') {
    sub = `${fmtSize(f.done || 0)} из ${size} · ${pct}%`;
    bar = pct;
    acts.push(cancel());
  } else if (st === 'done') {
    acts.push(btn('external', 'Открыть', () => openFile(m)), btn('folder', 'В папке', () => openFile(m, true), 'ghost'));
  } else if (st === 'failed') {
    sub = `не скачалось${f.err ? ': ' + f.err : ''}`;
    acts.push(accept('Повторить'));
  } else if (st === 'canceled') {
    sub = `${size} · отменено`;
    acts.push(accept('Скачать'));
  }
  return h(
    'div.ch-file',
    { 'data-fid': f.fid, 'data-st': st },
    h('div.fi', { class: isImage(f) ? 'img' : '' }, icon(isImage(f) ? 'image' : 'file')),
    h(
      'div.fb',
      h('b', { title: f.name }, f.name),
      h('small', { class: st === 'failed' ? 'bad' : '' }, sub),
      bar != null ? h('div.bar', h('i', { style: { width: bar + '%' } })) : null,
      acts.length ? h('div.fa', ...acts) : null,
    ),
  );
}

function imageNode(m) {
  const f = m.file;
  const im = h('img', { alt: f.name, draggable: 'false' });
  const box = h('div.ch-img', { title: f.name, onclick: () => viewImage(m) }, im);
  loadPreview(f.fid).then((url) => {
    if (!url) {
      box.replaceWith(fileCard(m));
      return;
    }
    const sc = $('#chScroll');
    const atBottom = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
    im.onload = () => {
      box.classList.add('ready');
      if (sc && atBottom) sc.scrollTop = sc.scrollHeight;
    };
    im.src = url;
  });
  return box;
}

function loadPreview(fid) {
  if (!previews.has(fid)) {
    const p = call('chat_file_data', { fid })
      .then((r) => URL.createObjectURL(dataBlob(r.url)))
      .catch(() => {
        previews.delete(fid);
        return null;
      });
    previews.set(fid, p);
    if (previews.size > 80) {
      const [k, old] = previews.entries().next().value;
      previews.delete(k);
      old.then((u) => u && setTimeout(() => URL.revokeObjectURL(u), 60000));
    }
  }
  return previews.get(fid);
}

/** data:URL → Blob (fetch к data: запрещён политикой CSP окна). */
function dataBlob(u) {
  const i = u.indexOf(',');
  const mime = /^data:([^;,]+)/.exec(u)?.[1] || 'application/octet-stream';
  const bin = atob(u.slice(i + 1));
  const a = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) a[j] = bin.charCodeAt(j);
  return new Blob([a], { type: mime });
}

function viewImage(m) {
  loadPreview(m.file.fid).then((url) => {
    if (!url) return;
    const close = () => {
      ov.remove();
      removeEventListener('keydown', key, true);
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const ov = h(
      'div.ch-lightbox',
      { onclick: (e) => e.target === ov && close() },
      h('img', { src: url, alt: m.file.name }),
      h(
        'div.lb-bar',
        h('span.grow', m.file.name, h('small', ' · ' + fmtSize(m.file.size))),
        h('button.btn.sm', { onclick: () => openFile(m) }, icon('external', 'sm'), 'Открыть'),
        h('button.btn.sm', { onclick: () => openFile(m, true) }, icon('folder', 'sm'), 'В папке'),
        h('button.btn.sm.icon', { title: 'Закрыть (Esc)', onclick: close }, icon('x')),
      ),
    );
    addEventListener('keydown', key, true);
    document.body.append(ov);
  });
}

async function openFile(m, reveal = false) {
  const f = m.file;
  if (!reveal && !m.out && DANGEROUS.test(f.name)) {
    const ok = await confirmDialog(
      `Открыть «${f.name}»?`,
      'Это программа или скрипт. Запускайте, только если доверяете собеседнику и ждали этот файл.',
      'Открыть',
      true,
    );
    if (!ok) return;
  }
  call('host_open_path', { fid: f.fid, reveal }).catch((e) => toast(e.message || e, 4000));
}

// ---------- поле ввода ----------
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 180) + 'px';
}
function saveDraft() {
  const ta = $('#chInput');
  if (!CH.cur || !ta) return;
  if (ta.value.trim() || CH.reply) drafts.set(CH.cur, { text: CH.edit ? '' : ta.value, reply: CH.reply });
  else drafts.delete(CH.cur);
}

function onKey(e) {
  const ta = e.currentTarget;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  } else if (e.key === 'Escape' && (CH.reply || CH.edit)) {
    e.preventDefault();
    e.stopPropagation();
    if (CH.edit) ta.value = '';
    clearCtx();
    autosize(ta);
  } else if (e.key === 'ArrowUp' && !ta.value && !CH.edit) {
    const last = [...CH.msgs].reverse().find((m) => m.out && !m.deleted && m.kind === 'text');
    if (last) {
      e.preventDefault();
      startEdit(last);
    }
  }
}

async function send() {
  const ta = $('#chInput');
  const chat = CH.cur;
  if (!ta || !chat) return;
  const text = ta.value.trim();
  if (CH.edit) {
    const id = CH.edit;
    const m = byId(id);
    if (!text) return;
    clearCtx();
    ta.value = '';
    autosize(ta);
    if (m && m.body === text) return;
    call('chat_edit', { id, text }).catch((e) => toast('Не изменилось: ' + (e.message || e)));
    return;
  }
  if (!text) return;
  const reply = CH.reply;
  ta.value = '';
  autosize(ta);
  clearCtx();
  drafts.delete(chat);
  try {
    const m = await call('chat_send', { chat, text, reply });
    if (m && m.id && chat === CH.cur && upsert(m)) renderMsgs({ bottom: true });
  } catch (e) {
    toast('Не отправилось: ' + (e.message || e), 4000);
    if (!ta.value) ta.value = text;
    autosize(ta);
  }
}

function startReply(m) {
  CH.reply = m.id;
  if (CH.edit) $('#chInput').value = '';
  CH.edit = null;
  renderCtx();
  $('#chInput').focus();
}
function startEdit(m) {
  CH.edit = m.id;
  CH.reply = null;
  const ta = $('#chInput');
  ta.value = m.body;
  autosize(ta);
  renderCtx();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
function clearCtx() {
  CH.reply = CH.edit = null;
  renderCtx();
}
function renderCtx() {
  const box = $('#chCtx');
  if (!box) return;
  const id = CH.edit || CH.reply;
  if (!id) {
    box.classList.add('hidden');
    return;
  }
  const m = byId(id);
  const c = chatInfo(CH.cur);
  box.replaceChildren(
    icon(CH.edit ? 'edit' : 'reply'),
    h(
      'div.grow',
      h(
        'b',
        CH.edit
          ? 'Изменение сообщения'
          : `Ответ ${m && m.out ? 'на своё сообщение' : `«${(m && m.senderName) || (c && c.name) || ''}»`}`,
      ),
      h('small', m ? previewText(m) : '…'),
    ),
    h(
      'button.btn.ghost.icon.sm',
      {
        title: 'Отмена (Esc)',
        onclick: () => {
          if (CH.edit) $('#chInput').value = '';
          clearCtx();
          $('#chInput').focus();
        },
      },
      icon('x'),
    ),
  );
  box.classList.remove('hidden');
}

// ---------- меню сообщения ----------
function msgMenu(anchor, m) {
  const f = m.file;
  const ready = f && (m.out ? f.st !== 'canceled' : f.st === 'done');
  menu(anchor, [
    !m.deleted && { icon: 'reply', label: 'Ответить', run: () => startReply(m) },
    !m.deleted && m.body && { icon: 'copy', label: 'Копировать текст', run: () => copyText(m.body, 'Текст скопирован') },
    !m.deleted && m.out && m.kind === 'text' && { icon: 'edit', label: 'Изменить', run: () => startEdit(m) },
    !m.deleted && ready && !m.out && { icon: 'external', label: 'Открыть файл', run: () => openFile(m) },
    !m.deleted && ready && { icon: 'folder', label: 'Показать в папке', run: () => openFile(m, true) },
    !m.deleted &&
      f &&
      m.out &&
      (f.st === 'ready' || f.st === 'sending') && {
        icon: 'x',
        label: 'Остановить передачу',
        run: () => call('chat_file_cancel', { fid: f.fid }).catch((e) => toast(e.message || e)),
      },
    { icon: 'trash', label: 'Удалить', danger: true, run: () => deleteMsg(m) },
  ]);
}

function deleteMsg(m) {
  const c = chatInfo(CH.cur);
  const both = m.out && !m.deleted;
  dialog((b, close) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = true;
    b.append(
      h('h3', 'Удалить сообщение?'),
      h(
        'p',
        both
          ? 'Без галочки сообщение исчезнет только у вас.'
          : 'Сообщение исчезнет только на этом компьютере.',
      ),
      both
        ? h(
            'label.row',
            { style: { cursor: 'pointer', gap: '10px' } },
            h('span.switch', cb, h('span')),
            isGroup(c) ? 'Удалить у всех участников' : `Удалить и у «${(c && c.name) || 'собеседника'}»`,
          )
        : null,
      h(
        'div.actions',
        h('button.btn.ghost', { onclick: () => close() }, 'Отмена'),
        h(
          'button.btn.danger',
          {
            onclick: () => {
              close();
              if (CH.edit === m.id || CH.reply === m.id) clearCtx();
              call('chat_delete', { id: m.id, everyone: both && cb.checked }).catch((e) => toast(e.message || e));
            },
          },
          'Удалить',
        ),
      ),
    );
  });
}

// ---------- отправка файлов ----------
async function attach() {
  if (!CH.cur) return;
  try {
    const r = await call('host_pick_files');
    const paths = (r && r.paths) || [];
    if (paths.length) offerFiles(paths.map((path) => ({ path, name: String(path).split(/[\\/]/).pop() })));
  } catch (e) {
    toast('Не удалось выбрать файл: ' + (e.message || e));
  }
}

function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const stamp = new Date().toLocaleString('ru-RU').replace(/[/:]/g, '-').replace(',', '');
  offerFiles(
    files.map((f) => ({
      file: f,
      size: f.size,
      name: !f.name || /^image\.\w+$/i.test(f.name) ? `Вставка ${stamp}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}` : f.name,
    })),
  );
}

function dragShow(on) {
  const d = $('#chDrop');
  if (d) d.classList.toggle('hidden', !on || !CH.cur || !CH.visible);
}

/** Диалог «Отправить файлы»: пути (выбор, перетаскивание в приложении) или File (вставка, браузер). */
function offerFiles(items) {
  const chat = CH.cur;
  const c = chatInfo(chat);
  if (!CH.visible || !c) {
    toast('Откройте чат, чтобы отправить файлы');
    return;
  }
  const big = items.filter((it) => it.file && it.size > BLOB_MAX);
  if (big.length) {
    toast(`«${big[0].name}» больше 32 МБ — отправьте его кнопкой со скрепкой`, 5000);
    items = items.filter((it) => !big.includes(it));
    if (!items.length) return;
  }
  dialog((b, close) => {
    const cap = h('input.field', { placeholder: 'Подпись (необязательно)', maxlength: 4000 });
    const go = () => {
      close();
      sendItems(chat, items, cap.value.trim());
    };
    cap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    const imgName = (n) => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(n);
    b.append(
      h('h3', items.length === 1 ? 'Отправить файл' : `Отправить файлы: ${items.length}`),
      h('p', `«${c.name}» получит их напрямую с вашего компьютера.`),
      h(
        'div.ch-sendlist',
        ...items.slice(0, 8).map((it) =>
          h(
            'div.row',
            icon(imgName(it.name) ? 'image' : 'file', 'sm'),
            h('span.grow', it.name),
            it.size ? h('small.muted', fmtSize(it.size)) : null,
          ),
        ),
        items.length > 8 ? h('small.muted', `и ещё ${items.length - 8}`) : null,
      ),
      cap,
      h(
        'div.actions',
        h('button.btn.ghost', { onclick: () => close() }, 'Отмена'),
        h('button.btn.primary', { 'data-act': 'send-files', onclick: go }, icon('send', 'sm'), 'Отправить'),
      ),
    );
  });
}

const readData = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });

async function sendItems(chat, items, caption) {
  for (const [i, it] of items.entries()) {
    const text = i === 0 ? caption : '';
    try {
      let m;
      if (it.path) m = await call('chat_send_file', { chat, path: it.path, text });
      else m = await call('chat_send_blob', { chat, name: it.name, data: await readData(it.file), text });
      if (m && m.id && chat === CH.cur && upsert(m)) renderMsgs({ bottom: true });
    } catch (e) {
      toast(`«${it.name}»: ${e.message || e}`, 5000);
    }
  }
}
