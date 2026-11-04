// chat-render.js — Отрисовка сообщений и списка
// v44: вынесено из chat.js без изменения логики (строки 4390–4912 v43).
import { RECEIPT_GLYPHS, RECEIPT_LABELS, gcallEventsFromEntries, receiptState } from './chat-transport.js?v=44';
import { kvDelMany } from './store.js?v=44';
import { openCallFromChat, updateGcallBanner } from './chat-call.js?v=44';
import { $, CONTROL_TYPES, GCALL_HB_KEEP_MS, RENDER_PAGE, TOUCH_UI, avatarBg, cur, dayLabel, excerptOf, fileState, fmtSize, fmtTime, isGcallHb, isOwnEntry, knownMembers, knownPersons, newDevKind, openMsgMenu, personOf, personReceipts, renderEditBar, renderPinBar, renderReplyBar, renderTextWithMarks, roomMessages, scrollToMessage, toggleReaction, touchRoomMsgs, ttlLabel } from './chat.js?v=44';
import { downloadFile, fmtDur, renderFileCardState, wireVoicePlayer } from './chat-files.js?v=44';

// ---------- Рендер ----------
// Карточка пустой ленты (по центру свободного места, как в Telegram).
// Пока собеседника нет — с кнопками приглашения из меню комнаты.
export function welcomeCard(alone) {
  const wrap = document.createElement('div');
  wrap.className = 'tg-chat-welcome';
  const card = document.createElement('div');
  card.className = 'tg-chat-welcome-card';
  const icon = document.createElement('div');
  icon.className = 'tg-chat-welcome-icon';
  icon.textContent = '🔒';
  const head = document.createElement('b');
  head.textContent = 'Сквозное шифрование';
  const text = document.createElement('p');
  text.textContent =
    'Ключи есть только у участников: сервер и брокеры видят лишь шифротекст. ' +
    (alone
      ? 'Пригласите собеседника ссылкой, кодом или QR.'
      : 'Напишите первое сообщение или запишите голосовое.');
  card.append(icon, head, text);
  if (alone) {
    const acts = document.createElement('div');
    acts.className = 'tg-chat-welcome-acts';
    for (const [label, target, kind] of [
      ['Пригласить', '#roomActInvite', 'primary'],
      ['Копировать ссылку', '#roomActCopy', 'ghost'],
    ]) {
      const b = document.createElement('button');
      b.className = `btn small ${kind}`;
      b.textContent = label;
      b.onclick = () => $(target)?.click();
      acts.append(b);
    }
    card.append(acts);
  }
  wrap.append(card);
  return wrap;
}

// v38: строка ленты, которая реально рисуется (для окна последних N).
export function rendersRow(it) {
  const t = it.msg?.type;
  if (!t || t === 'ecdh' || t === 'room-meta') return false;
  if (t === 'gcall-state') return !isGcallHb(it);
  if (t === 'ttl') return true;
  return !CONTROL_TYPES.has(t);
}
export function showEarlier() {
  const box = $('#chatMessages');
  if (!box || !cur) return;
  const prevH = box.scrollHeight;
  const prevTop = box.scrollTop;
  cur.renderLimit = (cur.renderLimit || RENDER_PAGE) + RENDER_PAGE;
  renderMessagesNow()
    .then(() => {
      box.scrollTop = box.scrollHeight - prevH + prevTop;
    })
    .catch(() => {});
}

export async function renderMessagesNow() {
  const box = $('#chatMessages');
  if (!box || !cur) return;
  const nowMs = Date.now();
  const roomId = cur.rec.roomId;
  const stale = [];
  const all = await roomMessages(roomId);
  if (!cur || cur.rec.roomId !== roomId) return;
  const items = all.filter((it) => {
    if (it.expiresAt && it.expiresAt <= nowMs) {
      stale.push(roomId + ':' + it.hash);
      return false;
    }
    // v38: heartbeat звонка старше часа — мусор, чистим локально.
    if (isGcallHb(it) && nowMs - (it.lts || it.msg.ts || 0) > GCALL_HB_KEEP_MS) {
      stale.push(roomId + ':' + it.hash);
      return false;
    }
    return true;
  });
  if (stale.length) {
    touchRoomMsgs(roomId);
    kvDelMany('messages', stale)
      .catch(() => {})
      .then(() => touchRoomMsgs(roomId));
  }
  cur.lastItemHashes = items.map((x) => x.hash);
  renderPinBar(items);
  // v29: контекст живого группового звонка для строк ленты и плашки.
  const gEvents = gcallEventsFromEntries(items);
  const gStartTs = new Map();
  for (const e of gEvents) {
    if (e.op === 'start' && !gStartTs.has(e.callId)) gStartTs.set(e.callId, e.ts);
  }
  const gStateIds = new Set(gEvents.map((e) => e.callId));
  const gEndShown = new Set();
  updateGcallBanner(gEvents).catch(() => {});
  // v28 (F): группировка подряд идущих пузырей одного автора (пауза < 5 мин,
  // один день): аватар — у нижнего в группе, ник — у первого.
  const bubbleItems = items.filter(
    (x) => ['text', 'file', 'voice'].includes(x.msg.type) && !x.msg.ratchetMiss
  );
  const grp = new Map();
  bubbleItems.forEach((x, i) => {
    const same = (a, b) =>
      !!a &&
      !!b &&
      (a.msg.devPub === b.msg.devPub || personOf(a.msg.devPub) === personOf(b.msg.devPub)) &&
      Math.abs(b.msg.ts - a.msg.ts) < 5 * 60000 &&
      new Date(a.msg.ts).toDateString() === new Date(b.msg.ts).toDateString();
    grp.set(x.hash, { first: !same(bubbleItems[i - 1], x), last: !same(x, bubbleItems[i + 1]) });
  });
  // Личный чат (двое) — как в Telegram: без аватаров и ников у входящих.
  // v39: считаются люди, а не устройства (второе своё устройство — не третий).
  const persons = knownPersons();
  const duo = persons.size <= 2;
  const rcpt = personReceipts(persons);
  box.classList.toggle('duo', duo);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  // v38: в DOM — только последние renderLimit строк (раньше лента из
  // тысяч сообщений перестраивалась целиком на каждое новое).
  const limit = cur.renderLimit || RENDER_PAGE;
  let start = 0;
  for (let i = items.length - 1, cnt = 0; i >= 0; i--) {
    if (rendersRow(items[i]) && ++cnt > limit) {
      start = i + 1;
      break;
    }
  }
  box.replaceChildren();
  if (!bubbleItems.length) box.append(welcomeCard(knownMembers().length < 2));
  if (start > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chat-more-btn';
    more.textContent = 'Показать более ранние сообщения';
    more.onclick = () => showEarlier();
    box.append(more);
  }
  let lastDayKey = '';
  const introduced = new Set(); // v39: люди, чей «теперь в чате» уже показан
  for (const it of start > 0 ? items.slice(start) : items) {
    const m = it.msg;
    const dk = new Date(m.ts).toDateString();
    if (dk !== lastDayKey) {
      lastDayKey = dk;
      const chip = document.createElement('div');
      chip.className = 'chat-date-chip';
      chip.textContent = dayLabel(m.ts);
      box.append(chip);
    }
    if (m.type === 'intro') {
      // v39: ещё одно устройство уже знакомого человека (и ваше) — без
      // повторного «теперь в чате»: о нём говорит строка «новое устройство».
      const pk = personOf(m.devPub);
      if (introduced.has(pk)) continue;
      introduced.add(pk);
      const div = document.createElement('div');
      div.className = 'chat-sys';
      div.textContent = `${m.nick || 'Участник'} теперь в чате`;
      box.append(div);
      continue;
    }
    if (m.type === 'ecdh') {
      continue; // служебный обмен ключами эпохи — в ленте не показываем
    }
    if (m.type === 'epoch') {
      let n = '';
      try {
        n = JSON.parse(m.text || '')?.n ?? '';
      } catch {}
      const div = document.createElement('div');
      div.className = 'chat-sys';
      div.textContent = `Эпоха сменена · ${n}`;
      box.append(div);
      continue;
    }
    if (m.type === 'ttl') {
      let sec = 0;
      try {
        sec = Number(JSON.parse(m.text || '{}')?.ttl) || 0;
      } catch {}
      const div = document.createElement('div');
      div.className = 'chat-sys';
      div.textContent =
        sec > 0 ? `Исчезающие сообщения: ${ttlLabel(sec)}` : 'Исчезающие сообщения выключены';
      box.append(div);
      continue;
    }
    if (m.type === 'room-meta') {
      continue; // v29: служебная метка создателя — в ленте не показываем
    }
    if (m.type === 'leave') {
      // v39: человек вышел с одного из устройств, но остался на другом.
      const pk = personOf(m.devPub);
      const still = Object.entries(cur.rec.members || {}).some(
        ([d, o]) => d !== m.devPub && o && !o.left && o.nick && personOf(d) === pk
      );
      if (still) continue;
      introduced.delete(pk);
      const div = document.createElement('div');
      div.className = 'chat-sys';
      div.textContent = `${m.nick || 'Участник'} больше не в чате`;
      box.append(div);
      continue;
    }
    if (m.type === 'gcall-state') {
      // v29: строки живого звонка. hb в ленту не пишем; end — один раз на
      // звонок, с длительностью от start (по клиентским ts — приблизительно).
      let d = null;
      try {
        d = JSON.parse(m.text || '');
      } catch {}
      if (!d || d.op === 'hb') continue;
      if (d.op === 'end') {
        if (gEndShown.has(d.callId)) continue;
        gEndShown.add(d.callId);
      }
      const div = document.createElement('div');
      div.className = 'chat-sys';
      if (d.op === 'start') div.textContent = `📞 ${m.nick || 'Участник'}: групповой звонок`;
      else if (d.op === 'join') div.textContent = `${m.nick || 'Участник'} теперь в звонке`;
      else if (d.op === 'leave') div.textContent = `${m.nick || 'Участник'} больше не в звонке`;
      else if (d.op === 'end') {
        const st = gStartTs.get(d.callId);
        const dur =
          st && m.ts > st ? ` · длился ${Math.max(1, Math.round((m.ts - st) / 60000))} мин` : '';
        div.textContent = `Звонок завершён${dur}`;
      } else continue;
      box.append(div);
      continue;
    }
    if (CONTROL_TYPES.has(m.type)) {
      continue; // react/edit/del/pin/unpin уже применены к состоянию при ingest
    }
    if (m.ratchetMiss) {
      // v31: содержимое навсегда недоступно — ключ сообщения использован
      // и удалён храповиком (или вытеснен из окна пропущенных). Место в
      // ленте показываем честной заглушкой, а не дырой.
      const div = document.createElement('div');
      div.className = 'chat-bubble ratchet-miss';
      div.textContent = m.undecrypted
        ? '🔒 Сообщение не расшифровано — попросите отправить ещё раз (меню чата → «Пересинхронизировать шифрование»)'
        : '🔒 Ключ сообщения недоступен (устарело)';
      box.append(div);
      continue;
    }
    if (m.type === 'system' && typeof m.text === 'string' && m.text.startsWith('newdev:')) {
      // v28 (E): локальная строка о новом устройстве (вне сервера).
      // Ник подставляется, как только устройство представилось (intro);
      // хвост ключа — чтобы сверить с собеседником голосом.
      const dev = m.text.slice(7);
      const who = cur.rec.members?.[dev]?.nick;
      const kind = newDevKind(dev);
      const div = document.createElement('div');
      div.className = 'chat-sys' + (kind.person ? '' : ' warn');
      const key = document.createElement('span');
      key.className = 'chat-sys-key';
      key.textContent = `ключ …${dev.slice(-6)}`;
      // v39: устройство, подписанное тем же master, что и уже знакомый
      // участник (или вы сами), — не чужак; остальные — по-прежнему с ⚠.
      const text = kind.own
        ? `Ваше устройство подключилось к чату: ${kind.nick}`
        : kind.person
          ? `${kind.nick}: новое устройство (подтверждено ключом профиля)`
          : who
            ? `⚠ Новое устройство в чате: ${who}`
            : '⚠ К чату подключилось новое устройство';
      div.append(text, key);
      box.append(div);
      continue;
    }
    if (m.type === 'system' && typeof m.text === 'string' && m.text.startsWith('gcall:')) {
      // v29: если этот звонок ведётся gcall-state-сообщениями, legacy-строка
      // не нужна — вход живёт на плашке «Идёт групповой звонок».
      if (gStateIds.has(m.text.slice(6))) continue;
      const div = document.createElement('div');
      div.className = 'chat-sys';
      const span = document.createElement('span');
      span.textContent = `📞 ${m.nick || 'Участник'}: групповой звонок `;
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      btn.textContent = 'Войти в групповой звонок';
      btn.onclick = () => openCallFromChat(m.text.slice(6), { autoJoin: true });
      div.append(span, btn);
      box.append(div);
      continue;
    }
    if (m.type === 'system' && typeof m.text === 'string' && m.text.startsWith('call:')) {
      const div = document.createElement('div');
      div.className = 'chat-sys';
      const span = document.createElement('span');
      span.textContent = isOwnEntry(it) ? 'Вы позвонили ' : `${m.nick || 'Участник'} приглашает на звонок `;
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      // v38: старое приглашение (больше 3 часов) — просто «Позвонить» заново.
      const fresh = Date.now() - (it.lts || m.ts || 0) < 3 * 3600000;
      btn.textContent = fresh && !isOwnEntry(it) ? 'Ответить' : 'Войти в звонок';
      btn.onclick = () => openCallFromChat(m.text.slice(5), { autoJoin: true });
      div.append(span, btn);
      box.append(div);
      continue;
    }
    if (m.type === 'system') {
      // v28: прочие системные строки (статусы дозвонa и т.п.) — плашкой.
      const div = document.createElement('div');
      div.className = 'chat-sys';
      div.textContent = String(m.text || '');
      box.append(div);
      continue;
    }
    const g = grp.get(it.hash) || { first: true, last: true };
    // v39: сообщение с другого своего устройства — тоже «моё» (справа, без
    // ника); править и удалять его можно только там, где оно написано.
    const own = isOwnEntry(it);
    const rowEl = document.createElement('div');
    rowEl.className =
      'chat-msg-row' +
      (own ? ' mine' : '') +
      (g.first ? ' grp-first' : '') +
      (g.last ? ' grp-last' : '') +
      (g.last ? ' tail' : '');
    rowEl.dataset.hash = it.hash; // v27: цель для цитат, закрепа и поиска
    if (!own && !duo) {
      const av = document.createElement('span');
      // v28 (F): аватар виден только у нижнего сообщения группы (место в
      // раскладке сохраняется прозрачным слотом, чтобы пузыри не прыгали).
      av.className = 'chat-avatar' + (g.last ? '' : ' ghost');
      av.style.background = avatarBg(m.devPub || '');
      av.textContent = (m.nick || 'У')[0].toUpperCase();
      rowEl.append(av);
    }
    const div = document.createElement('div');
    div.className = 'chat-msg' + (own ? ' mine' : '') + (g.last ? ' tail' : '');
    if (!m.deleted && (m.type === 'file' || m.type === 'voice')) {
      let meta = null;
      try {
        meta = JSON.parse(m.text || '');
      } catch {}
      if (meta && meta.fileId && m.type === 'voice') {
        // Голосовое: плеер; звук автоподгружается всегда (они маленькие).
        const wrap = document.createElement('div');
        wrap.className = 'chat-voice';
        wrap.dataset.voice = meta.fileId;
        const pb = document.createElement('button');
        pb.className = 'btn small chat-voice-play';
        pb.textContent = '▶';
        pb.setAttribute('aria-label', 'Прослушать голосовое сообщение');
        const bar = document.createElement('div');
        bar.className = 'chat-voice-bar';
        const fill = document.createElement('div');
        fill.className = 'chat-voice-fill';
        bar.append(fill);
        const tm = document.createElement('span');
        tm.className = 'chat-voice-time';
        tm.textContent = fmtDur(meta.durSec || 0);
        const ste = document.createElement('div');
        ste.className = 'chat-file-state';
        wrap.append(pb, bar, tm, ste);
        div.append(wrap);
        wireVoicePlayer(wrap, meta);
        const st = fileState.get(meta.fileId);
        if (!st?.url && !st?.busy && !st?.error) {
          downloadFile(meta, wrap, { auto: true }).catch(() => {});
        } else if (st?.error) {
          ste.textContent = 'Не удалось загрузить голосовое';
        }
      } else if (meta && meta.fileId) {
        const card = document.createElement('div');
        card.className = 'chat-file';
        const nm = document.createElement('div');
        nm.className = 'chat-file-name';
        nm.textContent = meta.name || 'файл';
        const sz = document.createElement('div');
        sz.className = 'chat-file-size';
        sz.textContent = fmtSize(meta.size || 0);
        const pv = document.createElement('div');
        pv.className = 'chat-file-preview';
        const barEl = document.createElement('div');
        barEl.className = 'chat-file-bar';
        const barFill = document.createElement('div');
        barFill.className = 'chat-file-bar-fill';
        barEl.append(barFill);
        const btn = document.createElement('button');
        btn.className = 'btn small chat-file-btn';
        btn.textContent = 'Скачать';
        const stEl = document.createElement('div');
        stEl.className = 'chat-file-state';
        btn.onclick = () => downloadFile(meta, card).catch(() => {});
        card.append(nm, sz, pv, barEl, btn, stEl);
        div.append(card);
        const st = fileState.get(meta.fileId);
        if (st) renderFileCardState(meta, card, st);
        // v26: картинки до 3 МБ подгружаются и расшифровываются сами.
        const isSmallImage =
          (meta.mime || '').startsWith('image/') && (meta.size || 0) <= 3 * 1024 * 1024;
        if (isSmallImage && !st?.url && !st?.busy && !st?.error) {
          downloadFile(meta, card, { auto: true }).catch(() => {});
        }
      } else {
        const body = document.createElement('div');
        body.className = 'chat-msg-text';
        body.textContent = 'Файл (повреждённые метаданные)';
        div.append(body);
      }
    } else if (m.deleted) {
      const body = document.createElement('div');
      body.className = 'chat-msg-text chat-deleted';
      body.textContent = 'Сообщение удалено';
      div.append(body);
    } else {
      if (!own && g.first && !duo) {
        // v28 (F): ник — только у первого сообщения группы одного автора.
        const head = document.createElement('div');
        head.className = 'chat-msg-head';
        head.textContent = m.nick || 'Участник';
        div.append(head);
      }
      // v27: цитата-ответ — блок внутри пузыря, клик ведёт к оригиналу.
      if (m.replyTo && (m.replyTo.hash || m.replyTo.excerpt)) {
        const q = document.createElement('div');
        q.className = 'chat-quote';
        const qn = document.createElement('b');
        qn.textContent = m.replyTo.name || 'Участник';
        const qt = document.createElement('span');
        qt.textContent = m.replyTo.excerpt || '';
        q.append(qn, qt);
        q.onclick = () => scrollToMessage(m.replyTo.hash);
        div.append(q);
      }
      const body = document.createElement('div');
      body.className = 'chat-msg-text';
      renderTextWithMarks(body, m.text || '', cur.search?.q);
      div.append(body);
    }
    const foot = document.createElement('div');
    foot.className = 'chat-msg-foot';
    const tm = document.createElement('span');
    tm.textContent = fmtTime(m.ts);
    foot.append(tm);
    if (own) {
      // v28 (F): статус — галочками в стиле Telegram, подпись — в title.
      // v39: по людям — «прочитано», когда прочитал каждый собеседник на
      // любом своём устройстве; свои устройства в расчёт не входят.
      const st = receiptState(it, rcpt.map, rcpt.others);
      const rc = document.createElement('span');
      rc.className = 'chat-receipt st-' + st;
      rc.textContent = RECEIPT_GLYPHS[st] || '✓';
      rc.title = RECEIPT_LABELS[st] || '';
      foot.append(rc);
    } else if (!it.sigOk) {
      const warn = document.createElement('span');
      warn.className = 'chat-receipt warn';
      warn.textContent = 'подпись не подтверждена';
      foot.append(warn);
    }
    if (m.edited && !m.deleted) {
      const ed = document.createElement('span');
      ed.className = 'chat-edited';
      ed.textContent = 'изменено';
      foot.append(ed);
    }
    // v27: кнопка действий (ответить, реакция, закрепить; у своих — ещё
    // изменить и удалить). У удалённых и служебных действий нет.
    if (!m.deleted && (m.type === 'text' || m.type === 'file' || m.type === 'voice')) {
      const mb = document.createElement('button');
      mb.className = 'chat-act-btn';
      mb.textContent = '···';
      mb.title = 'Действия с сообщением';
      mb.setAttribute('aria-label', 'Действия с сообщением');
      mb.onclick = (e) => {
        e.stopPropagation();
        openMsgMenu(it, mb);
      };
      foot.append(mb);
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMsgMenu(it, mb);
      });
      if (TOUCH_UI) {
        div.addEventListener('click', (e) => {
          if (e.target.closest('button, a, input, .chat-quote, .chat-voice, .chat-file')) return;
          if (window.getSelection()?.toString()) return;
          e.stopPropagation(); // иначе общий обработчик клика сразу закроет меню
          openMsgMenu(it, mb);
        });
      }
      div.addEventListener('dblclick', (e) => {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        if (!cur) return;
        cur.replyTo = { hash: it.hash, name: it.msg.nick || 'Участник', excerpt: excerptOf(it) };
        cur.editing = null;
        renderEditBar();
        renderReplyBar();
        $('#chatInput')?.focus();
      });
    }
    div.append(foot);
    rowEl.append(div);
    // v27: чипы реакций под пузырём; клик по чипу — toggle своей реакции.
    const reactions = it.reactions || {};
    const reactedEmojis = Object.keys(reactions).filter((e) => reactions[e]?.length);
    if (reactedEmojis.length && !m.deleted) {
      const chips = document.createElement('div');
      chips.className = 'chat-reactions';
      for (const emoji of reactedEmojis) {
        const chip = document.createElement('button');
        chip.className =
          'chat-chip' + (reactions[emoji].includes(cur.device.devicePub) ? ' mine' : '');
        chip.textContent = `${emoji} ${reactions[emoji].length}`;
        chip.onclick = () => toggleReaction(it, emoji).catch(() => {});
        chips.append(chip);
      }
      rowEl.append(chips);
    }
    box.append(rowEl);
  }
  if (nearBottom || !box.dataset.scrolled) {
    box.scrollTop = box.scrollHeight;
    box.dataset.scrolled = '1';
  }
}
