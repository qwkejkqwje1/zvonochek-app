// chat-delivery.js — Доставка и прочтение, пакетные ack, очередь повтора нерасшифрованных
// v44: вынесено из chat.js без изменения логики (строки 2595–3173 v43).
import { b64u, drDowngradeBlocked, hashChatBlob } from './crypto.js?v=44';
import { kvGet } from './store.js?v=44';
import { verifyChatSig, verifyDeviceCertClient } from './identity.js?v=44';
import { $, CONTROL_TYPES, api, applyControlMessage, applyEpochMessage, canonical, cur, decryptIncoming, handleDrInit, handleRemoteDeleted, maybeNotifyMessage, maybeStartDr, note, noteRoomDevice, ownDev, previewOf, renderMembersList, renderMessages, renderPresence, renderRoomList, roomMessages, roomQueue, saveRoom, storeMessage, storeRatchetMiss, suspendDr } from './chat.js?v=44';

// ---------- Доставка / прочтение (v25) ----------
export const chatVisible = () =>
  !!cur && !$('#chatroom')?.classList.contains('hidden') && document.visibilityState === 'visible';

// Подтвердить прочтение всего, что уже лежит локально (lastSeq), если чат
// реально на экране. Сервер монотонно поднимает read_seq устройства и
// рассылает receipt остальным.
export async function sendReadAck() {
  if (!cur || !chatVisible() || !cur.rec.lastSeq) return;
  const upto = cur.rec.lastSeq;
  if ((cur.rec.lastReadSeq || 0) >= upto) return;
  cur.rec.lastReadSeq = upto;
  await saveRoom(cur.rec);
  api(cur.keys.roomId, cur.keys.accessToken, '/ack', {
    method: 'POST',
    body: { seqs: [upto], dev: cur.device.devicePub, read: true },
  }).catch(() => {});
  renderRoomList().catch(() => {});
}

export function applyReceipt(dev, delivered, read) {
  if (!cur || dev === cur.device.devicePub) return;
  // v39: прочитано на другом своём устройстве — прочитано и здесь.
  if (ownDev(dev) && (read || 0) > (cur.rec.lastReadSeq || 0)) {
    cur.rec.lastReadSeq = read;
    saveRoom(cur.rec).catch(() => {});
    renderRoomList().catch(() => {});
  }
  const prev = cur.receipts.get(dev) || { delivered: 0, read: 0 };
  cur.receipts.set(dev, {
    delivered: Math.max(prev.delivered, delivered || 0),
    read: Math.max(prev.read, read || 0),
  });
  renderMessages().catch(() => {});
}

export function applyPresence(dev, online, ts) {
  if (!cur || dev === cur.device.devicePub) return;
  // v28 (E): присутствие — источник реестра устройств без ника.
  noteRoomDevice(dev, { hasIntro: !!cur.rec.members[dev]?.nick }).catch(() => {});
  if (online) cur.online.add(dev);
  else {
    cur.online.delete(dev);
    if (cur.rec.members[dev]) {
      cur.rec.members[dev].lastSeen = ts || Date.now();
      saveRoom(cur.rec).catch(() => {});
    }
  }
  renderPresence();
  renderMembersList();
}

// Синхронизация сводки при открытии: кто дочитал до какого seq + кто онлайн.
export async function syncState() {
  if (!cur) return;
  const r = await api(cur.keys.roomId, cur.keys.accessToken, '/state').catch(() => null);
  if (!r || r.status !== 200 || !cur) return;
  for (const m of r.data.members || []) applyReceipt(m.dev, m.delivered, m.read);
  cur.online = new Set((r.data.online || []).filter((d) => d !== cur.device.devicePub));
  renderPresence();
  renderMembersList();
}

// opts.viaFetch — элемент из /fetch (порядок seq без дыр по определению);
// opts.retry — повтор ранее не расшифрованного (seq-хвост не трогаем);
// opts.live — пришло по WS прямо сейчас (оценка сдвига часов сервера).
export function ingest(item, opts = {}) {
  return roomQueue(() => ingestNow(item, opts));
}

export async function ingestNow(item, { viaFetch = false, retry = false, live = false } = {}) {
  if (!cur || !item?.blob) return;
  const raw = b64u.dec(item.blob);
  const hash = await hashChatBlob(raw);
  const key = cur.rec.roomId + ':' + hash;
  const seen = await kvGet('messages', key);
  if (live && Number.isFinite(item.ts)) noteServerClock(item.ts);
  // v38: заглушка «не расшифровано» заменяется настоящим сообщением при повторе.
  if (!seen || (retry && seen.msg?.ratchetMiss)) {
    const dec = await decryptIncoming(raw);
    const undec = !dec || dec.__miss || dec.__retry || dec.v !== 1;
    if (undec && !seen && floorSkip(item)) {
      // v39: история до подключения этого устройства к профилю, которую
      // ему не расшифровать (Double Ratchet, чужие эпохи), — не заглушки:
      // её перенесло основное устройство (или владелец выбрал «без истории»).
    } else if (dec?.__miss) {
      // v31: ключ сообщения навсегда недоступен (использован и удалён или
      // вытеснен из skipped-окна) — кладём заглушку и НЕ выходим: seq-хвост
      // ниже обязан продвинуть lastSeq, иначе fetch принесёт это снова.
      if (!seen) await storeRatchetMiss(item, hash, dec.__miss);
    } else if (!dec || dec.__retry || dec.v !== 1) {
      // v38: не расшифровалось — раньше сообщение терялось молча и
      // навсегда (следующие seq сдвигали lastSeq). Теперь — очередь
      // повтора с бэкоффом: появится intro/ключ эпохи/ресинк — откроется.
      await noteFailed(item, hash, dec?.__retry || null);
    }
    const msg = dec && !dec.__miss && !dec.__retry && dec.v === 1 ? dec : null;
    if (msg) {
    if (Number.isFinite(item.seq)) clearFailed(item.seq);
    let sigOk = false;
    try {
      sigOk = !!(msg.devPub && msg.sig && (await verifyChatSig(msg.devPub, msg.sig, canonical(msg))));
    } catch {}
    const mine = msg.devPub === cur.device.devicePub;
    if (msg.type === 'intro' && msg.devPub) {
      cur.rec.members[msg.devPub] = {
        ...cur.rec.members[msg.devPub],
        nick: msg.nick || msg.text || 'Участник',
        firstSeen: cur.rec.members[msg.devPub]?.firstSeen || Date.now(),
        sigOk,
        left: false, // v29: вернувшийся после leave снова участник
      };
      // v31: третий участник в комнате с DR-сессией — сессия
      // приостанавливается, комната возвращается на цепочки уровня 1
      // (Double Ratchet по определению парный).
      const drIntro = cur.rec.ratchet?.dr;
      if (
        drIntro &&
        !drIntro.suspended &&
        msg.devPub !== drIntro.peer &&
        msg.devPub !== cur.device.devicePub
      ) {
        drIntro.suspended = true;
      }
      await saveRoom(cur.rec);
      renderPresence();
      renderMembersList();
    }
    if (msg.type === 'ecdh' && msg.devPub && sigOk) {
      // Ключ обмена участника: закрепляем только при валидной подписи, иначе
      // завёртку эпохи можно было бы подменить чужим ключом.
      const pub = String(msg.text || '');
      if (/^[A-Za-z0-9_-]{87}$/.test(pub)) {
        cur.rec.members[msg.devPub] = { ...cur.rec.members[msg.devPub], ecdhPub: pub };
        await saveRoom(cur.rec);
      }
    }
    // v28 (A): данные личной идентичности для дозвона — только с подписью.
    if (msg.type === 'dial' && msg.devPub && sigOk) {
      try {
        const d = JSON.parse(msg.text || '');
        if (d && typeof d.masterPub === 'string' && /^[A-Za-z0-9_-]{87}$/.test(d.masterPub)) {
          // v39: сертификат устройства под этим master — основание считать
          // несколько устройств одним человеком (и своими — свои).
          const certOk = await verifyDeviceCertClient(d.masterPub, msg.devPub, d.cert || null, d.chain || null).catch(
            () => false
          );
          cur.rec.members[msg.devPub] = {
            ...cur.rec.members[msg.devPub],
            masterPub: d.masterPub,
            masterFp: d.masterFp || null,
            cert: d.cert || null,
            chain: d.chain || null,
            certOk: !!certOk,
          };
          await saveRoom(cur.rec);
          renderMembersList();
        }
      } catch {}
    }
    // v29: создатель комнаты — из подписанного room-meta, первый валидный
    // закрепляется и не перезаписывается (как TOFU у участников).
    if (msg.type === 'room-meta' && msg.devPub && sigOk && !cur.rec.creatorPub) {
      try {
        const d = JSON.parse(msg.text || '');
        if (d && d.creator === msg.devPub) {
          cur.rec.creatorPub = msg.devPub;
          if (msg.devPub === cur.device.devicePub) cur.rec.createdByMe = true;
          await saveRoom(cur.rec);
          renderMembersList();
        }
      } catch {}
    }
    // v29: участник вышел из чата («Удалить у себя» у него) — помечаем
    // left: knownMembers его больше не считает, до следующего intro.
    if (msg.type === 'leave' && msg.devPub && sigOk) {
      cur.rec.members[msg.devPub] = { ...cur.rec.members[msg.devPub], left: true };
      await saveRoom(cur.rec);
      renderPresence();
      renderMembersList();
    }
    if (msg.type === 'epoch') {
      await applyEpochMessage(msg).catch(() => {});
    }
    // v31: caps собеседника (объявление поддержки храповика) — сливаем в
    // существующую запись участника; инициация DR — отдельным обработчиком.
    if (msg.caps && msg.devPub && cur.rec.members[msg.devPub]) {
      cur.rec.members[msg.devPub] = { ...cur.rec.members[msg.devPub], caps: msg.caps };
      saveRoom(cur.rec).catch(() => {});
    }
    if (msg.type === 'dr-init') {
      await handleDrInit(msg, sigOk).catch(() => {});
    }
    if (msg.type === 'ecdh' || msg.type === 'intro') {
      maybeStartDr().catch(() => {});
    }
    // v28 (E): реестр увиденных устройств (алерт — внутри noteRoomDevice).
    if (!mine && msg.devPub) {
      noteRoomDevice(msg.devPub, {
        hasIntro: !!cur.rec.members[msg.devPub]?.nick,
      }).catch(() => {});
    }
    // v28 (D): дедуп по id сообщения между каналами — один и тот же msg мог
    // прийти и из воркера, и из резервного канала разными blob-ами.
    // v38: по индексу id в памяти вместо чтения всей ленты на КАЖДОЕ сообщение.
    const byId = !!(msg.id && (await roomMsgIds()).has(msg.id));
    let blocked = drDowngradeBlocked(cur.rec.ratchet?.dr, msg);
    if (blocked && sigOk) {
      // v38: подписанное c1-сообщение самого DR-собеседника — он вышел из
      // сессии (потерял состояние или увидел третьего участника). Принимаем
      // и приостанавливаем DR у себя; раньше такие сообщения молча
      // отбрасывались — переписка шла «в одну сторону».
      suspendDr('peer-chain');
      blocked = false;
    }
    if (blocked) {
      // v31: неподписанный контент не в режиме d1 от DR-собеседника при живой
      // сессии не принимаем — защита от навязанного отката на статичный режим.
    } else if (!byId) {
      const entry = { hash, msg, sigOk, mine, reactions: {} };
      // seq есть только у воркера; у резервного канала его нет до ресинка.
      if (Number.isFinite(item.seq)) entry.seq = item.seq;
      // v38: время по серверу в локальной шкале (прунинг участников звонка
      // не зависит от сбитых часов отправителя).
      if (Number.isFinite(item.ts)) entry.lts = item.ts + (cur.clockSkew || 0);
      if (msg.type === 'gcall-state') entry.hb = /"op":"hb"/.test(msg.text || '');
      // v27: локальный срок жизни исчезающего сообщения — из шифротекста.
      if (msg.ttlSec > 0) entry.expiresAt = msg.ts + msg.ttlSec * 1000;
      await storeMessage(cur.rec, entry);
      if (CONTROL_TYPES.has(msg.type)) {
        await applyControlMessage(msg, sigOk).catch(() => {});
      }
      renderMessages().catch(() => {});
      if (!mine) renderRoomList().catch(() => {});
      // v28 (B): уведомление, пока приложение живо (v38: не при «лечении» истории).
      // v39: своё сообщение с другого устройства профиля — без уведомления.
      if (!mine && !ownDev(msg.devPub) && !CONTROL_TYPES.has(msg.type) && msg.type !== 'ecdh' && !cur.healing) {
        maybeNotifyMessage({
          roomId: cur.rec.roomId,
          rec: cur.rec,
          nick: msg.nick || 'Участник',
          preview: previewOf(msg),
          mine: false,
          roomActive: chatVisible(),
        }).catch(() => {});
      }
    }
    }
  }
  if (Number.isFinite(item.seq) && !retry && cur) {
    if (item.seq > cur.rec.lastSeq) {
      // v38: lastSeq двигается только без дыр: из /fetch (там порядок
      // полный) или ровно следующий номер по WS. Дыра (сообщение,
      // пропущенное сокетом) закрывается ближайшим fetch.
      if (viaFetch || item.seq === (cur.rec.lastSeq || 0) + 1) {
        cur.rec.lastSeq = item.seq;
        await saveRoom(cur.rec);
      } else {
        scheduleFetchMissed();
      }
    }
    // Доставка и прочтение — пачкой (раньше: два запроса на КАЖДОЕ
    // сообщение — сотни запросов к бесплатному воркеру при докачке).
    if (!cur.healing || item.seq > (cur.healKeepSeq || 0)) queueAck(item.seq);
  }
}

// v39: граница истории подключённого устройства (см. applyHistFloor).
export function floorSkip(item) {
  const f = cur?.rec?.histFloor;
  return Number.isFinite(f) && f > 0 && Number.isFinite(item?.seq) && item.seq <= f;
}
// Первое /init комнаты, пришедшей синхронизацией профиля: всё, что было
// на сервере до этого момента (seq ≤ lastSeq), — «старая» история.
// histMode 'none' — владелец не переносил историю: начинаем с «сейчас».
export function applyHistFloor(rec, serverLastSeq) {
  if (!rec?.linkImport || Number.isFinite(rec.histFloor)) return false;
  rec.histFloor = Number(serverLastSeq) || 0;
  if (rec.histMode === 'none' && (rec.lastSeq || 0) < rec.histFloor) rec.lastSeq = rec.histFloor;
  return true;
}

// v39: участники, записанные до v39 (dial без проверки сертификата), —
// проверяем один раз при открытии комнаты.
export async function verifyMemberCerts(c) {
  if (!c) return;
  let changed = false;
  for (const [d, m] of Object.entries(c.rec.members || {})) {
    if (!m || !m.masterPub || !m.cert || typeof m.certOk === 'boolean') continue;
    m.certOk = !!(await verifyDeviceCertClient(m.masterPub, d, m.cert, m.chain || null).catch(() => false));
    changed = true;
  }
  if (changed && cur === c) {
    await saveRoom(c.rec);
    renderPresence();
    renderMembersList();
    renderMessages().catch(() => {});
  }
}

// v38: id сообщений открытой комнаты (дедуп между каналами).
export async function roomMsgIds() {
  if (cur.msgIds) return cur.msgIds;
  const c = cur;
  const ids = new Set();
  for (const it of await roomMessages(c.rec.roomId)) if (it.msg?.id) ids.add(it.msg.id);
  c.msgIds = ids;
  return ids;
}

// v38: сдвиг часов «локальные − серверные» по живым сообщениям WS
// (минимум ≈ задержка доставки).
export function noteServerClock(serverTs) {
  const d = Date.now() - serverTs;
  if (!Number.isFinite(d) || Math.abs(d) > 7 * 24 * 3600000) return;
  if (cur.clockSkew === undefined || cur.clockSkewN < 1) {
    cur.clockSkew = d;
    cur.clockSkewN = 1;
    return;
  }
  cur.clockSkewN++;
  // Минимальная задержка ≈ истинный сдвиг; медленный дрейф вверх — на
  // случай перевода часов.
  if (d < cur.clockSkew) cur.clockSkew = d;
  else cur.clockSkew += Math.min(d - cur.clockSkew, 1000) * 0.05;
}

// ---------- v38: пакетные ack (доставка + прочтение) ----------
export function queueAck(seq) {
  const c = cur;
  if (!c || !Number.isFinite(seq)) return;
  if (!c.ackSeqs) c.ackSeqs = [];
  c.ackSeqs.push(seq);
  if (c.ackTimer) return;
  c.ackTimer = setTimeout(() => flushAcks(c), c.ackSeqs.length >= 150 ? 0 : 1200);
}
export function flushAcks(c) {
  if (!c) return;
  if (c.ackTimer) clearTimeout(c.ackTimer);
  c.ackTimer = null;
  const seqs = (c.ackSeqs || []).splice(0);
  if (!seqs.length) return;
  const read = cur === c && !c.closed && chatVisible();
  for (let i = 0; i < seqs.length; i += 200) {
    const part = seqs.slice(i, i + 200);
    const last = i + 200 >= seqs.length;
    api(c.keys.roomId, c.keys.accessToken, '/ack', {
      method: 'POST',
      body: { seqs: part, dev: c.device.devicePub, ...(read && last ? { read: true } : {}) },
    }).catch(() => {});
  }
  if (read) {
    const upto = Math.max(...seqs);
    if (upto > (c.rec.lastReadSeq || 0)) {
      c.rec.lastReadSeq = upto;
      saveRoom(c.rec).catch(() => {});
      renderRoomList().catch(() => {});
    }
  }
}

// ---------- v38: очередь повтора нерасшифрованных сообщений ----------
// rec.retry = [{seq, n (попыток), next (ts следующей), why}] — не больше
// 300 записей; после 6 неудач — заглушка «не расшифровано» в ленте (если
// причина известна) и запись снимается.
export const RETRY_MAX = 300;
export const RETRY_TRIES = 6;
export async function noteFailed(item, hash, why) {
  if (!cur || !Number.isFinite(item.seq)) return;
  const rec = cur.rec;
  if (!Array.isArray(rec.retry)) rec.retry = [];
  let e = rec.retry.find((x) => x.seq === item.seq);
  if (!e) {
    e = { seq: item.seq, n: 0, next: 0, why: why || '' };
    rec.retry.push(e);
    if (rec.retry.length > RETRY_MAX) rec.retry.splice(0, rec.retry.length - RETRY_MAX);
  }
  e.n++;
  e.why = why || e.why;
  e.next = Date.now() + Math.min(6 * 3600000, 15000 * 2 ** e.n);
  if (e.n >= RETRY_TRIES) {
    rec.retry = rec.retry.filter((x) => x !== e);
    if (e.why) await storeUndecrypted(item, hash, e.why);
  }
  saveRoom(rec).catch(() => {});
}
export function clearFailed(seq) {
  const rec = cur?.rec;
  if (!rec || !Array.isArray(rec.retry) || !rec.retry.length) return;
  const n = rec.retry.length;
  rec.retry = rec.retry.filter((x) => x.seq !== seq);
  if (rec.retry.length !== n) saveRoom(rec).catch(() => {});
}
export async function storeUndecrypted(item, hash, why) {
  const seen = await kvGet('messages', cur.rec.roomId + ':' + hash);
  if (seen) return;
  const stubMsg = {
    v: 1,
    id: 'undec-' + hash,
    ts: Number.isFinite(item.ts) ? item.ts + (cur.clockSkew || 0) : Date.now(),
    nick: '',
    devPub: '',
    type: 'text',
    text: '',
    epoch: 0,
    ratchetMiss: true,
    undecrypted: why,
  };
  const entry = { hash, msg: stubMsg, sigOk: false, mine: false, reactions: {} };
  if (Number.isFinite(item.seq)) entry.seq = item.seq;
  await storeMessage(cur.rec, entry);
  renderMessages().catch(() => {});
}
export let retryTimer = null;
export function scheduleRetry(delay = 1500) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryFailed().catch(() => {});
  }, delay);
}
export async function retryFailed({ force = false } = {}) {
  const c = cur;
  if (!c || c.closed || c.retrying) return 0;
  const now = Date.now();
  const due = (c.rec.retry || []).filter((x) => force || x.next <= now).sort((a, b) => a.seq - b.seq);
  if (!due.length) return 0;
  c.retrying = true;
  let fixed = 0;
  try {
    let i = 0;
    while (i < due.length && cur === c && !c.closed) {
      const from = due[i].seq;
      const r = await api(c.keys.roomId, c.keys.accessToken, `/fetch?after=${from - 1}`).catch(() => null);
      if (!r || r.status !== 200 || cur !== c) break;
      const rows = r.data.messages || [];
      const bySeq = new Map(rows.map((x) => [x.seq, x]));
      const maxSeq = rows.length ? rows[rows.length - 1].seq : from;
      while (i < due.length && (due[i].seq <= maxSeq || rows.length < 500)) {
        const e = due[i++];
        const row = bySeq.get(e.seq);
        if (!row) {
          clearFailed(e.seq); // на сервере уже нет (срок хранения) — повторять нечего
          continue;
        }
        await ingest(row, { retry: true }).catch(() => {});
        if (!(c.rec.retry || []).some((x) => x.seq === e.seq)) fixed++;
      }
      if (rows.length < 500) break;
    }
  } finally {
    c.retrying = false;
  }
  if (fixed && cur === c) renderMessages().catch(() => {});
  return fixed;
}

// v38: один fetch за раз (раньше на подключении их шло 2–3 параллельно по
// одному диапазону — гонка с заглушками «ключ недоступен») и докачка
// страницами: сервер отдаёт не больше 500 за запрос, а после долгого
// офлайна (или часа группового звонка с heartbeat) их больше — хвост
// раньше не докачивался до следующего открытия.
export function fetchMissed() {
  const c = cur;
  if (!c) return Promise.resolve();
  if (c.fetching) {
    c.fetchAgain = true;
    return c.fetching;
  }
  c.fetching = (async () => {
    try {
      let pages = 0;
      do {
        c.fetchAgain = false;
        const r = await api(c.keys.roomId, c.keys.accessToken, `/fetch?after=${c.rec.lastSeq || 0}`).catch(
          () => null
        );
        if (!r || cur !== c) return;
        // v29: комната удалена на сервере, пока мы были офлайн.
        if (r.status === 410) {
          await handleRemoteDeleted(c.rec.roomId);
          return;
        }
        if (r.status !== 200) return;
        const rows = r.data.messages || [];
        for (const item of rows) await ingest(item, { viaFetch: true });
        if (rows.length >= 500) c.fetchAgain = true;
      } while (c.fetchAgain && ++pages < 40 && cur === c && !c.closed);
    } finally {
      c.fetching = null;
    }
    if (cur === c && (c.rec.retry || []).some((x) => x.next <= Date.now())) scheduleRetry();
  })();
  return c.fetching;
}
export let fetchSoonTimer = null;
export function scheduleFetchMissed(delay = 700) {
  if (fetchSoonTimer) return;
  fetchSoonTimer = setTimeout(() => {
    fetchSoonTimer = null;
    fetchMissed().catch(() => {});
  }, delay);
}

// v38: «Пересинхронизировать шифрование» (меню чата): приостановить
// Double Ratchet, повторить все нерасшифрованные и заново пройти историю
// сервера (до 30 дней): сохранённое пропускается по хэшу, ранее
// потерянное расшифровывается из корней цепочек.
export async function resyncRoom() {
  const c = cur;
  if (!c) return;
  note('Пересинхронизация шифрования…');
  suspendDr('manual');
  c.drFails = 0;
  await queueStubsForRetry();
  const before = (c.rec.retry || []).length;
  const fixed = await healHistory(c, { force: true });
  if (cur !== c) return;
  const left = (c.rec.retry || []).length;
  note(
    `Готово: восстановлено ${fixed}` +
      (before ? ` (в очереди было ${before})` : '') +
      (left ? `; не открылось ${left} — отправитель неизвестен или ключ удалён храповиком` : '') +
      '. Новые сообщения идут в устойчивом режиме цепочек.'
  );
  renderMessages().catch(() => {});
}

// Заглушки (ratchetMiss/undecrypted) с seq — в очередь повтора.
export async function queueStubsForRetry() {
  const c = cur;
  if (!c) return 0;
  const items = await roomMessages(c.rec.roomId);
  if (!Array.isArray(c.rec.retry)) c.rec.retry = [];
  const have = new Set(c.rec.retry.map((x) => x.seq));
  let n = 0;
  for (const it of items) {
    if (!it.msg?.ratchetMiss || !Number.isFinite(it.seq) || have.has(it.seq)) continue;
    c.rec.retry.push({ seq: it.seq, n: 0, next: 0, why: it.msg.undecrypted || 'miss' });
    n++;
  }
  if (c.rec.retry.length > RETRY_MAX) c.rec.retry.splice(0, c.rec.retry.length - RETRY_MAX);
  if (n) saveRoom(c.rec).catch(() => {});
  return n;
}

// v38: «лечение» истории: повтор очереди и повторный проход серверной
// истории (до 30 дней) — сохранённое пропускается по хэшу, а сообщения,
// которые версии ≤ v37 молча выбросили (разрыв цепочки > 1000, гонки),
// расшифровываются заново. Без уведомлений; один раз на комнату после
// обновления и вручную из меню.
export async function healHistory(c, { force = false } = {}) {
  if (!c || cur !== c) return 0;
  // hash -> была ли заглушкой (для подсчёта восстановленного)
  const before = new Map((await roomMessages(c.rec.roomId)).map((x) => [x.hash, !!x.msg?.ratchetMiss]));
  c.healing = true;
  try {
    await retryFailed({ force });
    const keepSeq = c.rec.lastSeq || 0;
    c.healKeepSeq = keepSeq;
    c.rec.lastSeq = 0;
    await fetchMissed();
    if (cur === c && (c.rec.lastSeq || 0) < keepSeq) c.rec.lastSeq = keepSeq;
    c.rec.healV = 38;
    await saveRoom(c.rec);
  } finally {
    c.healing = false;
  }
  if (cur !== c) return 0;
  let n = 0;
  for (const it of await roomMessages(c.rec.roomId)) {
    if (it.msg?.ratchetMiss) continue;
    if (!before.has(it.hash) || before.get(it.hash) === true) {
      if (!it.mine && !CONTROL_TYPES.has(it.msg?.type)) n++;
    }
  }
  return n;
}
