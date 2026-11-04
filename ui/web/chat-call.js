// chat-call.js — Живой групповой звонок в чате и дозвон из чата через Inbox
// v44: вынесено из chat.js без изменения логики (строки 4912–5152 v43).
import { aggregateGcallState, gcallEventsFromEntries } from './chat-transport.js?v=44';
import { newSecret } from './crypto.js?v=44';
import { $, cur, knownMembers, memberEcdhPub, nickOf, note, roomMessages, sendMsg } from './chat.js?v=44';

// ---------- v29 (B): живой групповой звонок в чате ----------
// Модель: состояние звонка — подписанные 'gcall-state' сообщения в ленте
// комнаты; актуальное множество участников выводит чистая агрегация
// (chat-transport.js) с прунингом по heartbeat (v38: 30 с hb, 150 с тишины =
// вышел). Вход/выход свободные; дозвон делается только при старте.
// v38: навигация в звонок из чата больше НЕ закрывает контекст чата
// (checkHash) — heartbeat идёт всё время звонка; возобновление по моему
// последнему событию — только если звонок реально идёт на устройстве.
// v38: heartbeat — раз в 30 с, без пуша и со сроком хранения на сервере
// 15 минут (раньше раз в 20 с, навсегда и с пушем всем участникам);
// start — пуш-«звонок» тем, у кого чат закрыт.
export async function gcallPost(op, callId) {
  const bodyExtra =
    op === 'hb' ? { quiet: true, ttlSec: 900 } : op === 'start' ? { push: 'call' } : null;
  await sendMsg('gcall-state', JSON.stringify({ callId, op }), null, bodyExtra);
}
export const GCALL_HB_EVERY_MS = 30000;
export function adoptGcall(callId) {
  if (!cur) return;
  if (cur.gcall?.callId === callId && cur.gcall.hbTimer) return;
  if (cur.gcall?.hbTimer) clearInterval(cur.gcall.hbTimer);
  const c = cur;
  const hbTimer = setInterval(() => {
    if (cur === c && !c.closed && c.gcall?.callId === callId) {
      gcallPost('hb', callId).catch(() => {});
    }
  }, GCALL_HB_EVERY_MS);
  cur.gcall = { callId, hbTimer };
  cur.callSecrets.add(callId);
}

// v38: переход в звонок из чата — сразу в разговор (без лишнего экрана
// подготовки), ник чата — именем в звонке, по завершении — назад в чат.
// Контекст чата при этом НЕ закрывается (см. checkHash): heartbeat звонка
// и приём сообщений продолжаются, плашка не исчезает у остальных.
export function openCallFromChat(secret, { autoJoin = true } = {}) {
  if (!secret) return;
  if (cur) cur.callSecrets.add(secret);
  const link = callLinkOf(secret);
  const opts = { autoJoin, name: cur?.rec.nick || '', returnTo: cur?.returnHash || '', fromChat: true };
  if (window.__zvDial?.openCallLink) window.__zvDial.openCallLink(link, opts);
  else location.hash = 'k=' + secret;
}

// app.js сообщает о завершении звонка: если это групповой звонок чата —
// выходим из него (leave; последний участник — end).
export async function onCallEnded(secret) {
  if (!cur || !secret) return;
  if (cur.inCall === secret) cur.inCall = null;
  if (cur.gcall?.callId === secret) {
    const st = cur.gcallState;
    const others = (st?.participants || []).filter((p) => p.dev !== cur.device.devicePub);
    await leaveGcall().catch(() => {});
    if (st && st.callId === secret && !others.length) {
      if (!cur.gcallEndPosted) cur.gcallEndPosted = new Set();
      if (!cur.gcallEndPosted.has(secret)) {
        cur.gcallEndPosted.add(secret);
        await gcallPost('end', secret).catch(() => {});
      }
    }
  }
}
export function dropGcall() {
  if (!cur?.gcall) return;
  if (cur.gcall.hbTimer) clearInterval(cur.gcall.hbTimer);
  cur.gcall = null;
}
export async function leaveGcall() {
  if (!cur?.gcall) return;
  const { callId } = cur.gcall;
  dropGcall();
  await gcallPost('leave', callId).catch(() => {});
  updateGcallBanner().catch(() => {});
}
export async function joinGcall(callId) {
  if (!cur) return;
  if (!cur.rec.nick) return note('Сначала введите никнейм.');
  const already = cur.gcall?.callId === callId;
  adoptGcall(callId);
  // Переход — сразу; join уходит параллельно (не ждём сеть перед звонком).
  openCallFromChat(callId, { autoJoin: true });
  if (!already) await gcallPost('join', callId).catch(() => {});
}
// Кнопка «Групповой звонок»: активного звонка нет — создать и дозвониться;
// есть — просто войти (повторного дозвонa не делается).
export async function startOrJoinGcall() {
  if (!cur || !cur.rec.nick) return note('Сначала введите никнейм.');
  const items = await roomMessages(cur.rec.roomId);
  const st = aggregateGcallState(gcallEventsFromEntries(items));
  if (st && st.active) {
    await joinGcall(st.callId);
    return;
  }
  const callId = newSecret();
  const c = cur;
  await gcallPost('start', callId);
  // v38: сразу в звонок; дозвон участников и служебные строки — фоном
  // (контекст чата живёт и во время звонка). Раньше звонящий ждал, пока
  // по очереди отработают все дозвоны.
  adoptGcall(callId);
  openCallFromChat(callId, { autoJoin: true });
  (async () => {
    // Legacy-приглашение для клиентов v28 (у них нет gcall-state).
    await postCallLine('gcall:' + callId);
    const link = callLinkOf(callId);
    const devs = knownMembers().filter((d) => d !== c.device.devicePub && c.rec.members?.[d]?.masterPub);
    const results = await Promise.all(
      devs.map((dev) => dialMember(dev, { group: true, secret: callId, link }).catch(() => ({ dialed: false })))
    );
    if (cur !== c) return;
    const dialed = results.filter((r) => r.dialed).length;
    await postCallLine(
      dialed
        ? `📞 Групповой звонок: дозвон ${dialed} участн. — телефоны звонят`
        : '📞 Групповой звонок начат: вход — по плашке в шапке чата'
    );
  })().catch(() => {});
}
// Плашка «Идёт групповой звонок» в шапке + возобновление/завершение моей
// сессии звонка по агрегации. Вызывается из renderMessages (с готовыми
// событиями), из applyControlMessage и по таймеру прунинга (20 с).
export async function updateGcallBanner(eventsArg) {
  const bar = $('#chatGcallBar');
  if (!cur) return;
  let events = eventsArg;
  if (!events) {
    const items = await roomMessages(cur.rec.roomId);
    if (!cur) return;
    events = gcallEventsFromEntries(items);
  }
  const st = aggregateGcallState(events);
  cur.gcallState = st;
  if (st && st.active) {
    if (cur.gcall && cur.gcall.callId !== st.callId) dropGcall();
    if (!cur.gcall) {
      // Возобновление: моё последнее событие этого звонка — start/join/hb
      // и не было leave: я всё ещё участник (контекст чата пересоздался
      // после возврата из звонкового экрана).
      const mine = [...events]
        .reverse()
        .find((e) => e.callId === st.callId && e.dev === cur.device.devicePub);
      // v38: только если звонок на этом устройстве действительно идёт —
      // иначе закрытая посреди звонка вкладка превращала участника в
      // «призрака», и звонок не завершался.
      const live = window.__zvDial?.activeCallSecret?.() === st.callId;
      if (live && mine && (mine.op === 'start' || mine.op === 'join' || mine.op === 'hb')) {
        adoptGcall(st.callId);
        gcallPost('hb', st.callId).catch(() => {});
      }
    }
  } else if (cur.gcall) {
    dropGcall();
  }
  // Автозавершение: звонок опустел по прунингу и end ещё никто не вывел —
  // выводим один раз (идемпотентно по callId в рамках сессии и ленты).
  if (st && st.autoEnded && cur.rec.nick) {
    if (!cur.gcallEndPosted) cur.gcallEndPosted = new Set();
    if (!cur.gcallEndPosted.has(st.callId)) {
      cur.gcallEndPosted.add(st.callId);
      gcallPost('end', st.callId).catch(() => {});
    }
  }
  const gbtnSpan = $('#chatGroupCallBtn span');
  if (gbtnSpan) gbtnSpan.textContent = st && st.active ? 'Войти в звонок' : 'Групповой звонок';
  if (!bar) return;
  if (!st || !st.active) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const names = st.participants.map((p) => p.nick || 'Участник').join(', ');
  const txt = $('#chatGcallText');
  if (txt) {
    txt.textContent =
      `📞 Идёт групповой звонок · ${st.participants.length} участн.` + (names ? ` · ${names}` : '');
  }
  const joined = !!cur.gcall && cur.gcall.callId === st.callId;
  const jb = $('#chatGcallJoin span');
  if (jb) jb.textContent = joined ? 'Вернуться' : 'Войти';
  $('#chatGcallJoin')?.classList.remove('hidden');
  $('#chatGcallLeave')?.classList.toggle('hidden', !joined);
  bar.classList.toggle('joined', joined);
}

// ---------- v28 (A): дозвон из чата через Inbox ----------
// Чат не реализует Inbox сам: звонит публичный хук app.js
// (window.__zvDial.ringPersonal). Приглашение в чат ('call:'/'gcall:') при
// этом остаётся и как запасной путь, и как кнопка входа в звонковую
// комнату для всех участников.
export const callLinkOf = (secret) => `${location.origin}${location.pathname}#k=${secret}`;
// v38: служебные строки звонка («дозвон…», «принял(а)») — без пуша;
// приглашение 'call:'/'gcall:' будит пушем-«звонком» тех, у кого чат
// закрыт (opts.ring), если телефон собеседника не звонит иначе.
export async function postCallLine(text, { ring = false } = {}) {
  try {
    await sendMsg('system', text, null, ring ? { push: 'call' } : { quiet: true });
  } catch {}
}
export async function dialMember(dev, { group = false, secret = null, link = null } = {}) {
  if (!cur) return { dialed: false, reason: 'no-room' };
  const member = cur.rec.members?.[dev] || {};
  const dial = window.__zvDial;
  if (!member.masterPub || !dial?.ringPersonal) return { dialed: false, reason: 'no-dial' };
  const roomId = cur.rec.roomId;
  const sec = secret || newSecret();
  const lnk = link || callLinkOf(sec);
  // v39: звенят все устройства человека (подтверждённые его master), а
  // не только то, с которого он писал: ring несёт завёртку на каждое.
  const ecdhPubs = [];
  for (const [d, m] of Object.entries(cur.rec.members || {})) {
    if (!m || m.left || !m.ecdhPub) continue;
    if (d === dev || (m.certOk === true && member.certOk === true && m.masterPub === member.masterPub)) ecdhPubs.push(m.ecdhPub);
  }
  const res = await dial
    .ringPersonal(member.masterPub, lnk, {
      ecdhPub: member.ecdhPub || memberEcdhPub(dev),
      ecdhPubs: [...new Set(ecdhPubs)].slice(0, 5),
      name: cur.rec.nick || 'Участник чата',
      callKind: group ? 'group' : 'single',
      onState: (state) => {
        if (!cur || cur.closed || cur.rec.roomId !== roomId) return;
        const label = {
          accepted: 'принял(а) звонок',
          declined: 'отклонил(а) звонок',
          cancelled: 'звонок отменён',
          expired: 'не ответил(а) на звонок',
        }[state];
        if (label) postCallLine(`📞 ${nickOf(dev)} ${label}`);
      },
    })
    .catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (res?.ok) {
    if (!group) {
      await postCallLine('call:' + sec);
      await postCallLine(`📞 Дозвон: ${nickOf(dev)} — телефон звенит…`);
    }
    return { dialed: true, secret: sec, link: lnk };
  }
  return { dialed: false, reason: res?.error || 'ring-failed' };
}
