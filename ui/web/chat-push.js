// chat-push.js — Push и комнаты, живой фон для неоткрытых комнат
// v44: вынесено из chat.js без изменения логики (строки 6086–6396 v43).
import { b64u, codeAddrForScheme, deriveChatKeys, derivePinIkm, parseBlobHint, pubTagOf, tagBytesEq } from './crypto.js?v=44';
import { decryptWithVault, getChatDevice } from './identity.js?v=44';
import { kvAll } from './store.js?v=44';
import { $, api, closeCurrent, cur, existingPushSub, initChatUI, loadRoom, maybeNotifyMessage, myProfile, note, openRoomBySeed, renderRoomList, roomSummaryCache, saveRoom, sendDialInfoIfNeeded, showChatScreen, wipeLocalRoom } from './chat.js?v=44';
import { pairApi, redeemGreet, redeemJoin } from './chat-invite.js?v=44';
import { fetchMissed } from './chat-delivery.js?v=44';

// ---------- v38: push и комнаты ----------
// Открыть комнату по префиксу id (из уведомления SW).
export async function openRoomByPrefix(prefix) {
  if (!/^[a-f0-9]{8,64}$/.test(prefix || '')) return false;
  const rooms = (await kvAll('rooms')).map((x) => x.value).filter(Boolean);
  const r = rooms.find((x) => x.roomId.startsWith(prefix));
  if (!r) return false;
  if (cur && !cur.closed && cur.rec.roomId === r.roomId) {
    if (!cur.inCall) {
      showChatScreen();
      fetchMissed().catch(() => {});
    }
    return true;
  }
  await openRoomBySeed(await decryptWithVault(r.seedEnc));
  return true;
}

// Ключи неоткрытой комнаты (для /init, /unsub) — тем же путём, что свип.
export async function standaloneKeys(r) {
  const seedBytes = b64u.dec(await decryptWithVault(r.seedEnc));
  let pinIkm = null;
  if (r.pinEnc) {
    try {
      const pin = await decryptWithVault(r.pinEnc);
      if (pin) pinIkm = await derivePinIkm(pin, seedBytes);
    } catch {}
  }
  const keys = await deriveChatKeys(seedBytes, { pinIkm });
  return keys.roomId === r.roomId ? keys : null;
}

// Зарегистрировать push-подписку во всех комнатах, где она ещё не стоит
// (rec.pushEp — какой endpoint уже отдан серверу этой комнаты).
export let pushRegRunning = false;
export async function registerPushInRooms(sub) {
  if (!sub?.endpoint || pushRegRunning) return;
  pushRegRunning = true;
  try {
    const device = await getChatDevice();
    const rooms = (await kvAll('rooms')).map((x) => x.value).filter(Boolean);
    for (const r of rooms) {
      if (r.pushEp === sub.endpoint && Date.now() - (r.pushAt || 0) < 7 * 24 * 3600000) continue;
      try {
        const keys = await standaloneKeys(r);
        if (!keys) continue;
        const res = await api(r.roomId, keys.accessToken, '/init', {
          method: 'POST',
          body: { dev: device.devicePub, sub },
        });
        if (res.status === 410) {
          await wipeLocalRoom(r.roomId, { silent: true });
          continue;
        }
        if (res.status !== 200) continue;
        const live = cur && cur.rec.roomId === r.roomId ? cur.rec : await loadRoom(r.roomId);
        if (live) {
          live.pushEp = sub.endpoint;
          live.pushAt = Date.now();
          await saveRoom(live);
        }
      } catch {}
      await new Promise((ok) => setTimeout(ok, 150)); // не залпом
    }
  } finally {
    pushRegRunning = false;
  }
}

// Устройство уходит из комнаты — снять его push-подписку и состояние
// доставки на сервере (иначе сервер продолжал бы будить ушедшего и держать
// под него историю). Ошибки не важны: сервер сам чистит через 30 дней.
export async function unsubscribeRoom(r, keys = null) {
  try {
    const k = keys || (await standaloneKeys(r));
    if (!k) return;
    const device = await getChatDevice();
    const sub = window.__zvPush?.current?.() || (await existingPushSub());
    await api(r.roomId, k.accessToken, '/unsub', {
      method: 'POST',
      body: { endpoint: sub?.endpoint || '', dev: device.devicePub },
    });
  } catch {}
}

// Продление постоянной короткой ссылки (алиас живёт 30 дней с последнего
// использования): владелец продлевает раз в неделю, пока открывает комнату.
export async function aliasRenewIfDue() {
  const c = cur;
  if (!c?.rec.alias?.code || c.rec.alias.scheme !== 2) return;
  if (Date.now() - (c.rec.alias.renewedAt || c.rec.alias.createdAt || 0) < 7 * 24 * 3600000) return;
  try {
    const admin = await decryptWithVault(c.rec.alias.adminEnc);
    const codeHash = await codeAddrForScheme('alias', c.rec.alias.code, c.rec.alias.scheme);
    const r = await pairApi('/pair/alias', { codeHash, renew: true, admin });
    if (cur !== c || !c.rec.alias) return;
    if (r.status === 200) {
      c.rec.alias.renewedAt = Date.now();
      await saveRoom(c.rec);
    } else if (r.status === 404) {
      // Алиас истёк (30 дней без использования) — при следующем открытии
      // блока «короткая ссылка» будет выпущен новый.
      c.rec.alias = null;
      await saveRoom(c.rec);
    }
  } catch {}
}

// ---------- v28 (B): живой фон для неоткрытых комнат ----------
// У неоткрытой комнаты нет WS; раз в 30 секунд лёгкий fetch по seq считает
// новые сообщения и поднимает тост/уведомление без текста переписки.
// Сообщения при этом НЕ помечаются прочитанными и не сохраняются — при
// входе в комнату их подтянет обычный fetchMissed.
export const sweepState = new Map(); // roomId -> {token, lastNotifiedSeq}
export let sweepStarted = false;
export function startRoomSweep() {
  if (sweepStarted) return;
  sweepStarted = true;
  setInterval(() => {
    sweepOtherRooms().catch(() => {});
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    roomSummaryCache.clear(); // другая вкладка могла писать в ленты
    renderRoomList().catch(() => {});
    sweepOtherRooms({ force: true }).catch(() => {});
  });
}
// v38: адаптивный опрос неоткрытых комнат: видимая вкладка — раз в
// минуту, скрытая — раз в 5 минут, «тихие» комнаты (сутки без новостей) —
// втрое реже; пуш (если включён) будит опрос нужной комнаты сразу. Раньше
// каждая комната опрашивалась раз в 30 секунд всегда — при десятке чатов
// это ~30 000 запросов в сутки с одного устройства.
export let sweeping = false;
export const sweepWanted = new Set(); // префиксы комнат из пушей, пришедших во время опроса
export async function sweepOtherRooms({ force = false, onlyPrefix = null } = {}) {
  if (sweeping) {
    if (onlyPrefix) sweepWanted.add(onlyPrefix);
    return;
  }
  if (navigator.onLine === false) return;
  sweeping = true;
  try {
    await sweepOtherRoomsNow({ force, onlyPrefix });
  } finally {
    sweeping = false;
  }
  if (sweepWanted.size) {
    const pre = [...sweepWanted][0];
    sweepWanted.delete(pre);
    sweepOtherRooms({ force: true, onlyPrefix: pre }).catch(() => {});
  }
}
export async function sweepOtherRoomsNow({ force = false, onlyPrefix = null } = {}) {
  const rooms = (await kvAll('rooms')).map((x) => x.value).filter(Boolean);
  const now = Date.now();
  const hidden = document.visibilityState !== 'visible';
  for (const r of rooms) {
    if (cur && !cur.closed && cur.rec.roomId === r.roomId) continue;
    if (onlyPrefix && !r.roomId.startsWith(onlyPrefix)) continue;
    let st = sweepState.get(r.roomId);
    if (!st) {
      try {
        const seed = await decryptWithVault(r.seedEnc);
        const seedBytes = b64u.dec(seed);
        let pinIkm = null;
        if (r.pinEnc) {
          try {
            const pin = await decryptWithVault(r.pinEnc);
            if (pin) pinIkm = await derivePinIkm(pin, seedBytes);
          } catch {}
        }
        const keys = await deriveChatKeys(seedBytes, { pinIkm });
        if (keys.roomId !== r.roomId) continue;
        st = { token: keys.accessToken, lastNotifiedSeq: r.lastReadSeq || 0, nextAt: 0, lastNewAt: 0 };
        sweepState.set(r.roomId, st);
      } catch {
        continue;
      }
    }
    if (!force && !onlyPrefix && now < (st.nextAt || 0)) continue;
    const quiet = now - (st.lastNewAt || 0) > 24 * 3600000;
    st.nextAt = now + (hidden ? 300000 : 60000) * (quiet ? 3 : 1);
    const after = Math.max(r.lastSeq || 0, st.lastNotifiedSeq);
    const res = await api(r.roomId, st.token, `/fetch?after=${after}`).catch(() => null);
    // v29: серверная копия удалена — стираем локальную молча (без тостов).
    if (res && res.status === 410) {
      await wipeLocalRoom(r.roomId, { silent: true });
      continue;
    }
    if (!res || res.status !== 200) continue;
    const all = res.data.messages || [];
    if (!all.length) continue;
    const top = Math.max(st.lastNotifiedSeq, ...all.map((i) => i.seq || 0));
    // v39: комната пришла с другого устройства профиля — первый опрос
    // только запоминает позицию (старое уже прочитано там).
    if (r.linkImport && !st.primed) {
      st.primed = true;
      st.lastNotifiedSeq = top;
      continue;
    }
    st.primed = true;
    // v39: свои сообщения с других устройств профиля — не «новые».
    const items = all.filter((i) => !ownBlob(i.blob));
    st.lastNotifiedSeq = top;
    if (!items.length) continue;
    st.lastNewAt = now;
    maybeNotifyMessage({
      roomId: r.roomId,
      rec: r,
      nick: null,
      preview: items.length > 1 ? `Новых сообщений: ${items.length}` : 'Новое сообщение',
      mine: false,
      roomActive: false,
    }).catch(() => {});
  }
}

// v39: blob цепочки (c1) несёт 2 байта ключа автора — по ним опрос фона
// отличает сообщения с других своих устройств, не расшифровывая их.
export const ownTagCache = new Map();
export function ownBlob(blobB64) {
  const own = myProfile()?.own;
  if (!own || own.size < 2 || typeof blobB64 !== 'string') return false;
  let nonce;
  try {
    nonce = b64u.dec(blobB64.slice(0, 24)).subarray(0, 12);
  } catch {
    return false;
  }
  const h = parseBlobHint(nonce);
  if (!h || h.mode !== 'c1') return false;
  for (const d of own) {
    let t = ownTagCache.get(d);
    if (!t) {
      try {
        t = [...pubTagOf(b64u.dec(d)).subarray(0, 2)];
      } catch {
        continue;
      }
      ownTagCache.set(d, t);
    }
    if (tagBytesEq(t, h.tag)) return true;
  }
  return false;
}

export function checkHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const join = params.get('join');
  if (join && /^[A-Za-z0-9_-]{9}$/.test(join)) {
    $('#home')?.classList.remove('hidden');
    redeemJoin(join).then((okJoin) => {
      if (!okJoin) note('Короткая ссылка не найдена или отключена владельцем комнаты.');
    });
    return;
  }
  const greet = params.get('greet');
  if (greet && /^[A-Za-z0-9_-]{9}$/.test(greet)) {
    $('#home')?.classList.remove('hidden');
    redeemGreet(greet);
    return;
  }
  const seed = params.get('chat');
  if (seed && /^[A-Za-z0-9_-]{43}$/.test(seed)) {
    openRoomBySeed(seed, { pinProtected: params.get('p') === '1' });
  } else if (cur && params.get('k') && cur.callSecrets?.has(params.get('k'))) {
    // v38: звонок, начатый или принятый из этого чата: контекст чата живёт
    // (WS, heartbeat группового звонка, приём сообщений) — скрываем только
    // экран; по завершении звонка app.js вернёт сюда (#chat=…).
    cur.inCall = params.get('k');
    document.body.dataset.screen = 'call';
    $('#chatroom')?.classList.add('hidden');
    $('#home')?.classList.add('hidden');
  } else if (cur) {
    // Ушли по звонковой ссылке или домой — закрываем чат-канал.
    closeCurrent(true);
    $('#chatroom')?.classList.add('hidden');
    $('#home')?.classList.add('hidden'); // экранами дальше управляет app.js (route)
  }
}

// Для тестов и отладки: чистое API модуля.
// v38: «Сменить номер» (app.js): masterPub и сертификат устройства сменились —
// во всех комнатах заново публикуем 'dial' (иначе собеседники звонили бы на
// отозванный адрес). Ключ устройства прежний: переписка не затрагивается.
export async function onIdentityChanged() {
  if (cur) cur.rec.dialInfoSent = false;
  const rooms = (await kvAll('rooms')).map((x) => x.value).filter(Boolean);
  for (const r of rooms) {
    if (!r.dialInfoSent) continue;
    r.dialInfoSent = false;
    await saveRoom(r).catch(() => {});
  }
  if (cur) {
    cur.device = await getChatDevice().catch(() => cur.device);
    await sendDialInfoIfNeeded().catch(() => {});
  }
}

// Код, который в chat.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initChatPush() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initChatUI();
      checkHash();
    });
  } else {
    initChatUI();
    checkHash();
  }
  window.addEventListener('hashchange', checkHash);
}
