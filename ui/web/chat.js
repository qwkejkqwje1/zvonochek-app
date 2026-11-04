// ZVONochek — приватный текстовый чат: комнаты по ссылке (#chat=<seed>),
// без регистрации. Сервер (ChatRoom DO) видит только шифротекст сообщений
// фиксированного размера; ключи выводятся из seed на устройстве
// (crypto.js: deriveChatKeys). Звонковый путь не затрагивается: кнопка
// «Позвонить» лишь создаёт обычную звонковую комнату и постит приглашение
// служебным сообщением. Техплан: ZVONochek-MESSENGER-TECHPLAN-v21.md.
//
// v25 — «мессенджерный» слой поверх фазы 1:
//   · presence: онлайн собеседника (WS-события сервера) и «был(а) в …»;
//   · receipts: «Отправлено / Доставлено / Прочитано» (members_state на DO);
//   · typing: «печатает…» — эфемерно, по WS, без хранения;
//   · файлы: чанки, зашифрованные отдельным файловым ключом (ключ — только
//     внутри зашифрованного сообщения type:'file'); сервер видит размер;
//   · код приветствия: одноразовый 9-символьный код быстрого подключения
//     (#greet= / ручной ввод), пара живёт на PairingDO не дольше 15 минут.
//
// v26 — фазы 2 и 3 техплана + короткая ссылка + голосовые:
//   · PIN входа (фаза 2): PIN подмешивается в вывод ключей (PBKDF2 600k),
//     без PIN не выводится даже Room_ID; маркер &p=1 в ссылке; контрольная
//     фраза комнаты из 4 слов — для устной сверки;
//   · эпохи (фаза 3): случайный секрет эпохи, завёртка на ECDH-ключи
//     устройств оставленных участников (сообщения 'ecdh' и 'epoch');
//   · постоянная короткая ссылка #join=<код9>: режим алиаса PairingDO —
//     не одноразовая, отзываемая, с rate-limit выдач;
//   · картинки ≤3 МБ подгружаются и расшифровываются автоматически;
//   · голосовые сообщения: MediaRecorder → тот же файловый канал,
//     тип 'voice', плеер в ленте.
//
// v29 — удаление чатов и живой групповой звонок:
//   · создатель публикует подписанный 'room-meta' первым сообщением —
//     остальные узнают creatorPub, сервер регистрирует его при seq=1;
//   · «Удалить у себя» (с 'leave' остальным), «Удалить для всех»
//     (подписанный 'room-delete' + серверный wipe по подписи создателя,
//     POST /room/delete; офлайн-участники добирают 410 Gone);
//   · автоудаление неактивных чатов: 30 дней без сообщений — серверный
//     wipe (alarm в ChatRoomDO) и локальный свип; per-room флаг
//     keepForever («Сохранить от автоудаления»);
//   · tombstones удалённых комнат в бэкапе v27 — восстановление их не
//     воскрешает (localStorage 'zvDeletedRooms');
//   · групповой звонок как ЖИВАЯ сессия: подписанные 'gcall-state'
//     (start/join/leave/hb/end), плашка «Идёт групповой звонок · Войти»
//     в шапке, свободный вход/выход, heartbeat 20 с, прунинг 60 с
//     (v38: 30 с / 150 с, время по серверу, контекст чата живёт в звонке).
//
// v30 — десктопная разметка и доступ по кодовому слову:
//   · двухпанельный экран чата ≥1024px: список комнат слева (тот же
//     renderRoomList, второй контейнер), открытый чат справа на всю
//     ширину; на телефоне поведение прежнее;
//   · rendezvous по фразе: владелец включает «Доступ по кодовому слову»
//     (3+ слова), собеседник вписывает фразу на главном экране — PairingDO
//     режим 'word': blob {seed, roomId} под PBKDF2(фраза, 600k), встреча
//     одноразовая, TTL 24 часа, отзыв по admin как у алиаса.
//
// v31 — храповик (forward secrecy), финальная версия цепочки:
//   · уровень 1: цепочки отправителя (Sender Chains) для всех комнат и
//     эпох — каждое сообщение шифруется одноразовым ключом цепочки
//     (rk:'c1', cn в шифротексте, подсказка маршрутизации — в nonce);
//     пропущенные ключи живут в skipped-окне ≤256 и удаляются после
//     использования; смена эпохи обрывает старые цепочки;
//   · уровень 2: Double Ratchet для комнат 1:1 поверх ecdh-публикаций
//     фазы 3 (rk:'d1', dh/pn/cn в шифротексте; первое сообщение новой
//     цепочки — транзитом через 'drx'); при живой DR-сессии контент не
//     в режиме d1 от собеседника не принимается (анти-downgrade);
//   · сообщения ≤v30 расшифровываются статичными ключами, как раньше.
import { CONFIG, getWorkerBase } from './config.js?v=44';
import {
  b64u,
  newSecret,
  deriveChatKeys,
  derivePinIkm,
  deriveEpochRoomKey,
  wrapEpochSecret,
  unwrapEpochSecret,
  sha256hex,
  encryptChatMessage,
  decryptChatMessage,
  hashChatBlob,
  newMsgId,
  FILE_CHUNK_PT,
  FILE_MAX_BYTES,
  importFileKey,
  encryptFileChunk,
  decryptFileChunk,
  newGreetCode,
  newJoinCode,
  normalizeWordPhrase,
  codeAccess,
  sealCodeBlob,
  openCodeBlob,
  codeAddrForScheme,
  REACT_EMOJIS,
  nextReactionOp,
  applyReactionState,
  applyEditOrDelete,
  applyPinState,
  deriveChainRoot,
  chainInitSendState,
  chainInitRecvState,
  chainSendTake,
  chainRecvTake,
  chainPruneRecvState,
  encryptChatWithKeyBytes,
  decryptChatWithKeyBytes,
  sealCompactWithKeyBytes,
  openCompactWithKeyBytes,
  parseBlobHint,
  chainNonce,
  drNonce,
  transitNonce,
  pubTagOf,
  pubTagHex,
  tagBytesEq,
  ecdhSharedBits,
  randomP256Scalar,
  drPairFromScalar,
  drRootFromInit,
  drKdfRk,
  drRecvStep,
  DR_CONTENT_TYPES,
  drDowngradeBlocked,
  genP256KeyPair,
  chainKeyAt,
  chainAdvanceSend,
} from './crypto.js?v=44';
import {
  kvGet,
  kvPut,
  kvDel,
  kvAll,
  kvPrefix,
  kvDelPrefix,
  kvDelMany,
  normalizeRoomRecord,
} from './store.js?v=44';
import { coalesced } from './coalesce.js?v=44';
import { plural } from './callstats.js?v=44';
import { anonName, randomAnonName } from './anon-names.js?v=44';
import {
  getChatDevice,
  getChatDeviceEcdh,
  getChatNostrSecret,
  signChatText,
  verifyChatSig,
  encryptWithVault,
  decryptWithVault,
  verifyDeviceCertClient,
} from './identity.js?v=44';
import { personKeyOf, groupPersons } from './sync-core.js?v=44';
import {
  ChatTransportManager,
  FallbackTransport,
  compareChatEntries,
  shouldNotifyMessage,
  ToastGate,
  observeDevice,
  receiptState,
  RECEIPT_GLYPHS,
  RECEIPT_LABELS,
  aggregateGcallState,
  gcallEventsFromEntries,
  shouldSweepRoom,
} from './chat-transport.js?v=44';
import { aliasRenewIfDue, checkHash, onIdentityChanged, openRoomByPrefix, ownTagCache, registerPushInRooms, standaloneKeys, startRoomSweep, sweepOtherRooms, sweepState, unsubscribeRoom, initChatPush } from './chat-push.js?v=44';
import { dialMember, joinGcall, leaveGcall, onCallEnded, openCallFromChat, startOrJoinGcall, updateGcallBanner } from './chat-call.js?v=44';
import { renderMessagesNow } from './chat-render.js?v=44';
import { aliasCreate, aliasRevokeCurrent, createInvite, pairApi, redeemCode, redeemGreet, redeemJoin, redeemWord, renderAliasBox, renderWordBox, renderWordHint, wordDisable, wordEnable, wordParts, wordRevokeCurrent } from './chat-invite.js?v=44';
import { startVoiceRec, stopVoiceRec, uploadFile } from './chat-files.js?v=44';
import { connectWs, setupTransport, initChatNet } from './chat-net.js?v=44';
import { applyHistFloor, chatVisible, fetchMissed, flushAcks, healHistory, queueStubsForRetry, resyncRoom, scheduleFetchMissed, scheduleRetry, syncState, verifyMemberCerts } from './chat-delivery.js?v=44';

export const $ = (s, r = document) => r.querySelector(s);
const te = new TextEncoder();

// Каноническая строка подписи НЕ меняется с v21: поле epoch в неё сознательно
// не входит — это лишь подсказка выбора ключа при расшифровке; подмена epoch
// ломает AEAD и сообщение отбрасывается, подпись при этом не страдает.
export const canonical = (m) => `zv-chat-v1|${m.id}|${m.ts}|${m.devPub}|${m.type}|${m.text}`;
const chatLinkOf = (seed, pinProtected = false) =>
  `${location.origin}${location.pathname}#chat=${seed}${pinProtected ? '&p=1' : ''}`;
export const greetLinkOf = (code) => `${location.origin}${location.pathname}#greet=${code}`;
export const joinLinkOf = (code) => `${location.origin}${location.pathname}#join=${code}`;

export let cur = null; // {rec, keys, keys0, device, ws, closed, backoff, pendingCall, online:Set, receipts:Map, typing, pin, pinIkm, epochKeys:Map, epochMissing}
let opening = false;
let pendingPinSeed = null; // seed, ожидающий ввода PIN (экран запроса PIN)
export const fileState = new Map(); // fileId -> {progress, url, name, error, busy}
export const voiceAudio = new Map(); // fileId -> HTMLAudioElement (сессионный кэш плеера)

// v36: перерисовки ленты и списка схлопываются (см. coalesce.js) — пачка
// досинхронизации больше не вызывает сотню полных перерисовок подряд.
export const renderMessages = coalesced(() => renderMessagesNow());
export const RENDER_PAGE = 200; // v38: окно ленты (строк в DOM)
export const renderRoomList = coalesced(() => renderRoomListNow(), 60);

// ---------- Сервер ----------
export const chatBase = (roomId) => `${getWorkerBase().replace(/\/$/, '')}/chat/${roomId}`;
export const workerBase = () => getWorkerBase().replace(/\/$/, '');

export async function api(roomId, token, path, opts = {}) {
  // v38: зависший запрос не должен навсегда держать очередь отправки.
  let signal;
  try {
    signal = AbortSignal.timeout ? AbortSignal.timeout(opts.timeout || 25000) : undefined;
  } catch {}
  const res = await fetch(chatBase(roomId) + path, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-access-token': token,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

export async function existingPushSub() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return null;
    const j = sub.toJSON();
    return { endpoint: j.endpoint, keys: j.keys };
  } catch {
    return null;
  }
}

// ---------- Локальное хранилище ----------
export const saveRoom = (rec) => {
  // v38: устаревшая копия ОТКРЫТОЙ комнаты (запись из списка комнат,
  // прочитанная раньше) не затирает живое состояние храповика, seq и
  // участников: сохраняется живая запись, из копии берётся только флаг
  // «не удалять автоматически» (единственное, что меняет меню списка).
  if (cur && rec && rec !== cur.rec && rec.roomId === cur.rec.roomId) {
    if (typeof rec.keepForever === 'boolean') cur.rec.keepForever = rec.keepForever;
    rec = cur.rec;
  }
  // v27: backup.js слушает это событие и (с дебаунсом) перезаливает
  // зашифрованный бэкап списка комнат, если бэкап включён.
  // v38: только когда меняется то, что лежит в бэкапе (PIN, дата создания;
  // новые и удалённые комнаты сообщают о себе отдельно). Раньше событие
  // шло на КАЖДОЕ сохранение — то есть на каждое сообщение, и бэкап
  // перезаливался на сервер после каждой паузы в переписке.
  const fp = `${rec.pinProtected ? 1 : 0}|${rec.pinEnc ? 1 : 0}|${rec.createdAt || 0}`;
  const prevFp = backupFpCache.get(rec.roomId);
  backupFpCache.set(rec.roomId, fp);
  if (prevFp !== undefined && prevFp !== fp) notifyRoomsChanged();
  // v39: то, что едет на другие устройства профиля (devices.js), — ник,
  // «не удалять», короткая ссылка, кодовое слово, эпохи, создатель.
  const sfp = `${rec.nick || ''}|${rec.keepForever ? 1 : 0}|${rec.alias?.code || ''}|${rec.word?.exp || 0}|${(rec.epochs || []).length}|${rec.creatorPub || ''}`;
  const prevSfp = syncFpCache.get(rec.roomId);
  syncFpCache.set(rec.roomId, sfp);
  if (prevSfp !== undefined && prevSfp !== sfp) {
    try {
      window.dispatchEvent(new CustomEvent('zv-sync-local'));
    } catch {}
  }
  return kvPut('rooms', rec.roomId, rec);
};
const backupFpCache = new Map(); // roomId -> отпечаток полей, входящих в бэкап
const syncFpCache = new Map(); // v39: roomId -> отпечаток синхронизируемых полей
export const loadRoom = (roomId) => kvGet('rooms', roomId);

// v38: сводки списка комнат кэшируются по комнате и сбрасываются при любой
// записи в её ленту (раньше каждый рендер списка читал ВСЕ сообщения ВСЕХ
// чатов — в старых больших чатах интерфейс заметно тормозил).
export const roomSummaryCache = new Map(); // roomId -> {last, lastTs, others:number[]}
// v44: поколение ленты комнаты. Сброс кэша только ДО записи оставлял гонку:
// сводка, начатая между сбросом и концом записи, читала ленту без нового
// сообщения и клала в кэш устаревшее превью (в списке чатов оставалось
// предпоследнее сообщение, пока не придёт следующее). Теперь лента
// «трогается» и после записи, а сводка кэшируется, только если за время
// чтения поколение не сменилось.
const roomSummaryGen = new Map();
export function touchRoomMsgs(roomId) {
  roomSummaryCache.delete(roomId);
  roomSummaryGen.set(roomId, (roomSummaryGen.get(roomId) || 0) + 1);
}
export async function putMsg(roomId, entry) {
  touchRoomMsgs(roomId);
  if (cur && cur.rec.roomId === roomId && cur.msgIds && entry?.msg?.id) cur.msgIds.add(entry.msg.id);
  await kvPut('messages', roomId + ':' + entry.hash, { roomId, ...entry });
  touchRoomMsgs(roomId);
}
async function delMsg(roomId, hash) {
  touchRoomMsgs(roomId);
  await kvDel('messages', roomId + ':' + hash);
  touchRoomMsgs(roomId);
}
export async function storeMessage(rec, entry) {
  await putMsg(rec.roomId, entry);
}

export async function roomMessages(roomId) {
  // v38: только ключи этой комнаты (`${roomId}:${hash}`), без полного
  // прохода по сторам всех чатов.
  const rows = await kvPrefix('messages', roomId + ':');
  return rows
    .map((x) => x.value)
    .filter((m) => m && m.roomId === roomId)
    // v28: единая сортировка слияния каналов — по seq, если он есть, иначе
    // по ts+hash (сообщения резервного канала получают seq только после
    // ресинка в воркер и не должны при этом теряться или дублироваться).
    .sort(compareChatEntries);
}

// v38: служебный heartbeat группового звонка (раз в 30 с от каждого
// участника) нужен только живому звонку — локально храним не дольше часа.
export const GCALL_HB_KEEP_MS = 3600000;
export function isGcallHb(it) {
  if (it?.msg?.type !== 'gcall-state') return false;
  if (typeof it.hb === 'boolean') return it.hb;
  return /"op":"hb"/.test(it.msg.text || '');
}

// ---------- UI: утилиты ----------
export function note(text) {
  const n = $('#chatNote');
  if (n) n.textContent = text || '';
  // v22: #chatNote находится внутри экрана комнаты — пока комната скрыта,
  // дублируем текст в #chatHomeNote на главном экране, иначе ошибки и
  // подсказки чата владелец не видит вообще (баг «кнопка молчит»).
  const h = $('#chatHomeNote');
  if (h && $('#chatroom')?.classList.contains('hidden')) h.textContent = text || '';
}
// Статус соединения в шапке комнаты. Норма («На связи») места не занимает —
// атрибут data-ok скрывает её стилем; видны только «Подключение…»,
// «Офлайн…» и «Резервный канал», и строка состава комнаты не обрезается.
export const ONLINE = 'На связи';
// Короткое подтверждение действия — общий #toast приложения.
let flashTimer = 0;
function flash(text) {
  const t = $('#toast');
  if (!t) return note(text);
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}
export function status(text) {
  const s = $('#chatStatus');
  if (!s) return;
  s.textContent = text;
  s.toggleAttribute('data-ok', text === ONLINE);
}
export function showChatScreen() {
  document.body.dataset.screen = 'chatroom';
  $('#home')?.classList.add('hidden');
  $('#prejoin')?.classList.add('hidden');
  $('#chatroom')?.classList.remove('hidden');
  syncChatEmpty();
  const h = $('#chatHomeNote');
  if (h) h.textContent = ''; // v22: комната открыта — домашний дубль подсказок больше не нужен
}
function hideChatScreen() {
  document.body.dataset.screen = 'home';
  $('#chatroom')?.classList.add('hidden');
  $('#home')?.classList.remove('hidden');
}

// ---------- v28: уведомления о сообщениях, пока приложение живо ----------
// Серверный push с закрытым приложением сознательно не трогаем (VAPID
// отложен владельцем). Здесь: внутриприложенческий тост, системное
// уведомление через SW при скрытой вкладке и опциональный звук.
// Своё устройство (запоминается при открытии комнаты): собственный intro,
// пришедший с историей, не должен превращать личный чат в «Анна, Борис».
let selfDev = '';
// v39: несколько устройств одного человека — один собеседник. Свои
// устройства профиля (реестр devices.js) — «я»; чужие устройства с
// проверенным сертификатом одного master — один человек (personKeyOf).
export const myProfile = () => window.__zvProfile || null;
function ownSetOf() {
  const own = new Set(myProfile()?.own || []);
  if (selfDev) own.add(selfDev);
  if (cur?.device?.devicePub) own.add(cur.device.devicePub);
  return own;
}
export function ownDev(dev, rec = cur?.rec) {
  if (!dev) return false;
  if (cur && dev === cur.device.devicePub) return false; // это устройство — it.mine
  if (myProfile()?.own?.has(dev)) return true;
  const m = rec?.members?.[dev];
  const master = myProfile()?.master;
  return !!(master && m?.certOk === true && m.masterPub === master);
}
export const isOwnEntry = (it, rec = cur?.rec) => !!it && (it.mine || ownDev(it.msg?.devPub, rec));
export function personOf(dev, rec = cur?.rec) {
  return personKeyOf(dev, rec?.members?.[dev], ownSetOf(), myProfile()?.master || '');
}
const peersOf = (rec) => {
  const out = [];
  const seen = new Set();
  const own = ownSetOf();
  const master = myProfile()?.master || '';
  for (const [d, m] of Object.entries(rec?.members || {})) {
    if (!m || m.left || !m.nick || d === selfDev) continue;
    const k = personKeyOf(d, m, own, master);
    if (k === 'self' || seen.has(k)) continue;
    seen.add(k);
    out.push([d, m]);
  }
  return out;
};
// Аватар личного чата — аватар собеседника (как в Telegram): тот же цвет
// в списке, шапке и составе комнаты. У групп — цвет комнаты.
const roomAvatarBg = (rec) => {
  const peers = peersOf(rec);
  return avatarBg(peers.length === 1 ? peers[0][0] : rec.roomId);
};
const roomTitleOf = (roomId, rec = null) => {
  if (rec && rec.members && typeof rec.members === 'object') {
    const names = peersOf(rec).map(([, m]) => m.nick);
    if (names.length === 1) return names[0];
    if (names.length > 1) return names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');
  }
  // v38: пока в чате никого нет — анонимное имя из id комнаты (одинаковое
  // у всех участников, ничего о людях не раскрывает) вместо «Новый чат».
  return roomId ? anonName(roomId) : 'Новый чат';
};
const notifyTextOn = () => {
  try {
    return localStorage.getItem('zvNotifyText') === '1';
  } catch {
    return false;
  }
};
const notifySoundOn = () => {
  try {
    return localStorage.getItem('zvNotifySound') === '1';
  } catch {
    return false;
  }
};
const toastGate = new ToastGate(2000);
let notifyAudioCtx = null;
function notifyBeep() {
  if (!notifySoundOn()) return;
  try {
    notifyAudioCtx = notifyAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = notifyAudioCtx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.2);
  } catch {}
}
function showChatToast({ title, body, roomId }) {
  try {
    document.querySelectorAll('.chat-toast').forEach((el) => el.remove());
    const el = document.createElement('div');
    el.className = 'chat-toast';
    const t = document.createElement('b');
    t.textContent = title;
    const b = document.createElement('span');
    b.textContent = body;
    el.append(t, b);
    el.onclick = () => {
      el.remove();
      if (cur && cur.rec.roomId === roomId) showChatScreen();
    };
    document.body.append(el);
    setTimeout(() => el.remove(), 6000);
  } catch {}
}
// rec — запись комнаты (для заголовка); system — служебное уведомление,
// его текст не секретен и показывается даже при скрытых превью.
export async function maybeNotifyMessage({ roomId, rec = null, nick, preview, mine, roomActive, system = false }) {
  const d = toastGate.check(roomId, {
    mine,
    roomActive,
    documentHidden: typeof document !== 'undefined' && document.hidden,
  });
  if (!d.show) return d;
  const roomTitle = roomTitleOf(roomId, rec);
  // Личный чат — только имя автора (как в Telegram), группа — «автор · чат».
  const title = !nick ? roomTitle : rec && peersOf(rec).length <= 1 ? nick : `${nick} · ${roomTitle}`;
  let body = system || notifyTextOn() ? String(preview || 'Новое сообщение') : 'Новое сообщение';
  if (d.count > 1) body += ` (+${d.count - 1})`;
  showChatToast({ title, body, roomId });
  notifyBeep();
  if (d.system && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body,
        tag: 'zvchat-' + roomId,
        data: { chatRoom: roomId },
      });
    } catch {}
  }
  return d;
}

// ---------- v28: видимость устройств комнаты (без вайт-листа) ----------
// Реестр seenDevices живёт в записи комнаты. Первое появление устройства
// даёт одну локальную системную строку и, если комната не перед глазами,
// тост. Историческая подгрузка при открытии комнаты тревоги не поднимает
// (cur.syncingInitial). Это видимость, а не контроль доступа.
export async function noteRoomDevice(dev, { hasIntro = false } = {}) {
  if (!cur || !dev || dev === cur.device.devicePub) return;
  const silent = !!cur.syncingInitial;
  const res = observeDevice(cur.rec.seenDevices, dev, { hasIntro, silent });
  cur.rec.seenDevices = res.seen;
  const roomId = cur.rec.roomId;
  const recAt = cur.rec;
  await saveRoom(cur.rec).catch(() => {});
  if (!res.shouldAlert || !cur || cur.rec.roomId !== roomId) return;
  const entry = {
    hash: 'local-newdev-' + dev.slice(-16),
    // Локальная строка встаёт в ленту сразу за последним известным
    // сообщением (дробный seq), а не «прилипает» к концу ленты навсегда.
    seq: (cur.rec.lastSeq || 0) + 0.5,
    local: true,
    msg: {
      v: 1,
      id: 'local-newdev-' + dev,
      ts: Date.now(),
      nick: '',
      devPub: '',
      type: 'system',
      text: 'newdev:' + dev,
    },
    sigOk: true,
    mine: false,
    reactions: {},
  };
  await storeMessage(cur.rec, entry).catch(() => {});
  if (cur && cur.rec.roomId === roomId) renderMessages().catch(() => {});
  // v39: уведомление — через несколько секунд, когда устройство успело
  // представиться (dial с сертификатом приходит первым): своё устройство
  // профиля — без тревоги, новое устройство знакомого человека — спокойно.
  setTimeout(() => {
    // Комнату к этому моменту могли закрыть — классифицируем по ней же.
    const kind = newDevKind(dev, cur && cur.rec.roomId === roomId ? cur.rec : recAt);
    if (kind.own) return;
    maybeNotifyMessage({
      roomId,
      rec: cur && cur.rec.roomId === roomId ? cur.rec : null,
      nick: null,
      preview: kind.person
        ? `Новое устройство: ${kind.nick}`
        : kind.nick
          ? `⚠ Новое устройство в чате: ${kind.nick}`
          : '⚠ К чату подключилось новое устройство',
      mine: false,
      roomActive: chatVisible(),
      system: true,
    }).catch(() => {});
  }, 4000);
}

// v39: чьё это новое устройство. own — моё (реестр профиля или мой master
// с проверенным сертификатом); person — ещё одно устройство участника,
// который уже есть в чате (тот же master, сертификат проверен).
export function newDevKind(dev, rec = cur?.rec) {
  if (myProfile()?.own?.has(dev) || ownDev(dev, rec)) {
    return { own: true, person: true, nick: myProfile()?.labels?.[dev] || 'другое ваше устройство' };
  }
  if (!rec) return { own: false, person: false, nick: '' };
  const m = rec.members?.[dev];
  if (m?.certOk === true && m.masterPub) {
    for (const [d, o] of Object.entries(rec.members || {})) {
      if (d === dev || !o || o.certOk !== true || o.masterPub !== m.masterPub) continue;
      return { own: false, person: true, nick: o.nick || m.nick || 'участник' };
    }
  }
  return { own: false, person: false, nick: m?.nick || '' };
}

// Интерфейс только русский — локаль фиксирована, чтобы 24-часовое время
// и названия месяцев не зависели от языка браузера.
const RU = 'ru-RU';
const HM = { hour: '2-digit', minute: '2-digit' };
const sameDay = (a, b) => a.toDateString() === b.toDateString();
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString(RU, HM);
export const fmtDayTime = (ts) => {
  const d = new Date(ts);
  return sameDay(d, new Date())
    ? fmtTime(ts)
    : d.toLocaleDateString(RU, { day: '2-digit', month: '2-digit' }) + ' ' + fmtTime(ts);
};
// Время в списке комнат — как в Telegram: сегодня — часы, на этой неделе —
// день недели, в этом году — число и месяц, иначе — полная дата.
const fmtListTime = (ts) => {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return fmtTime(ts);
  if (now - d < 6 * 864e5) return d.toLocaleDateString(RU, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(RU, { day: 'numeric', month: 'short' }).replace('.', '');
  }
  return d.toLocaleDateString(RU, { day: '2-digit', month: '2-digit', year: '2-digit' });
};
// «был(а) в 14:05» / «был(а) вчера в 14:05» / «был(а) 28.10».
const fmtSeen = (ts) => {
  const d = new Date(ts);
  if (sameDay(d, new Date())) return 'в ' + fmtTime(ts);
  if (sameDay(d, new Date(Date.now() - 864e5))) return 'вчера в ' + fmtTime(ts);
  return d.toLocaleDateString(RU, { day: '2-digit', month: '2-digit' });
};
export const fmtSize = (b) =>
  b > 1024 * 1024 ? (b / (1024 * 1024)).toFixed(1) + ' МБ' : Math.max(1, Math.ceil(b / 1024)) + ' КБ';
// v28 (F): подпись чипа даты в ленте — «Сегодня»/«Вчера»/полная дата.
export const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  if (sameDay(d, today)) return 'Сегодня';
  if (sameDay(d, new Date(Date.now() - 864e5))) return 'Вчера';
  return d.toLocaleDateString(RU, {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
};
function hueOf(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
  return h;
}
// v36: палитра аватаров в духе Telegram — 7 мягких градиентов вместо
// случайного оттенка (тот давал грязно-зелёные и кислотные круги).
const AVATAR_GRADIENTS = [
  ['#ff885e', '#ff516a'], // красный
  ['#ffcd6a', '#ffa85c'], // оранжевый
  ['#82b1ff', '#665fff'], // фиолетовый
  ['#a0de7e', '#54cb68'], // зелёный
  ['#53edd6', '#28c9b7'], // бирюзовый
  ['#72d5fd', '#2a9ef1'], // голубой
  ['#e0a2f3', '#d669ed'], // розовый
];
export function avatarBg(str) {
  const [a, b] = AVATAR_GRADIENTS[hueOf(str) % AVATAR_GRADIENTS.length];
  return `linear-gradient(180deg, ${a}, ${b})`;
}
export function nickOf(devPub) {
  if (!cur) return 'Участник';
  if (devPub === cur.device.devicePub) return cur.rec.nick || 'Вы';
  return cur.rec.members?.[devPub]?.nick || 'Участник';
}

// Превью последнего сообщения комнаты и счётчик непрочитанных — для списка
// комнат на главном экране (только локальные данные).
export function previewOf(m) {
  if (!m) return '';
  if (m.deleted) return 'Сообщение удалено';
  if (m.type === 'intro') return `${m.nick || 'Участник'} теперь в чате`;
  if (m.type === 'voice') return 'Голосовое сообщение';
  if (m.type === 'epoch') return 'Сменена эпоха комнаты';
  if (m.type === 'file') {
    try {
      const meta = JSON.parse(m.text || '{}');
      return 'Файл: ' + (meta.name || 'без имени');
    } catch {
      return 'Файл';
    }
  }
  if (m.type === 'system' && typeof m.text === 'string' && m.text.startsWith('call:')) {
    return 'Приглашение на звонок';
  }
  if (m.type === 'system' && typeof m.text === 'string' && m.text.startsWith('gcall:')) {
    return 'Групповой звонок';
  }
  if (m.type === 'system' && typeof m.text === 'string' && m.text.startsWith('newdev:')) {
    return '⚠ Новое устройство в чате';
  }
  if (m.type === 'leave') return `${m.nick || 'Участник'} больше не в чате`;
  if (m.type === 'room-meta') return 'Чат создан';
  return String(m.text || '');
}
function unreadOf(rec, msgs) {
  const readSeq = rec.lastReadSeq || 0;
  return msgs.filter((it) => !isOwnEntry(it, rec) && !it.local && (it.seq || 0) > readSeq).length;
}

// v30: один построитель пункта списка комнат — используется и главным
// экраном (#chatRoomsList), и десктопным сайдбаром экрана чата
// (#chatRoomsSidebar). Состояние одно (kvAll), обработчики не дублируются
// между рендерами: каждый рендер пересоздаёт узлы целиком.
function buildRoomListItem({ r, last, unread }, { sidebar = false } = {}) {
  const li = document.createElement('li');
  li.className = 'tg-chat-li';
  const btn = document.createElement('button');
  btn.className = 'btn small chat-room-item tg-chat-item';
  if (cur && cur.rec.roomId === r.roomId) btn.classList.add('active');

  const displayTitle = roomTitleOf(r.roomId, r);
  const av = document.createElement('span');
  av.className = 'chat-avatar tg-item-avatar';
  av.style.background = roomAvatarBg(r);
  const firstChar = displayTitle.replace(/^Чат\s+/i, '').trim()[0] || '💬';
  av.textContent = firstChar.toUpperCase();
  if (r.pinProtected) {
    const lockBadge = document.createElement('span');
    lockBadge.className = 'tg-avatar-lock';
    lockBadge.textContent = '🔒';
    lockBadge.title = 'Защищён PIN-кодом';
    av.append(lockBadge);
  }

  const body = document.createElement('span');
  body.className = 'tg-item-body';

  const top = document.createElement('span');
  top.className = 'chat-room-top';
  const title = document.createElement('b');
  title.className = 'tg-item-title';
  title.textContent = (r.keepForever ? '★ ' : '') + displayTitle;
  const when = document.createElement('span');
  when.className = 'chat-room-when';
  when.textContent = last ? fmtListTime(last.msg.ts) : '';
  top.append(title, when);

  const bottom = document.createElement('span');
  bottom.className = 'chat-room-preview';
  const pv = document.createElement('span');
  pv.className = 'chat-room-preview-text';
  if (r.draft && (!cur || cur.rec.roomId !== r.roomId)) {
    const draftSpan = document.createElement('span');
    draftSpan.className = 'tg-draft-prefix';
    draftSpan.textContent = 'Черновик: ';
    pv.append(draftSpan, document.createTextNode(r.draft));
  } else {
    // Префикс автора — только в группах (в личном чате он очевиден).
    const group = peersOf(r).length > 1;
    const senderPrefix =
      !last || !group || last.msg.type !== 'text' ? '' : isOwnEntry(last, r) ? 'Вы: ' : last.msg.nick ? `${last.msg.nick}: ` : '';
    pv.textContent = last ? senderPrefix + previewOf(last.msg) : 'Нет сообщений · нажмите, чтобы открыть';
  }
  bottom.append(pv);
  if (unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'chat-unread-badge';
    badge.textContent = String(unread);
    bottom.append(badge);
  }
  body.append(top, bottom);
  btn.append(av, body);
  btn.onclick = async () => {
    const seed = await decryptWithVault(r.seedEnc);
    openRoomBySeed(seed);
  };
  // v29: меню действий с комнатой (открыть / сохранить от автоудаления /
  // удалить у себя / удалить для всех).
  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn small ghost chat-room-menu-btn';
  menuBtn.textContent = '···';
  menuBtn.title = 'Действия с чатом';
  menuBtn.setAttribute('aria-label', 'Действия с чатом');
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    openRoomListMenu(r, menuBtn).catch(() => {});
  };
  // v36: правый клик / долгое нажатие по чату — то же меню, как в Telegram.
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openRoomListMenu(r, menuBtn).catch(() => {});
  });
  li.append(btn, menuBtn);
  // v30: текст для фильтра поиска по сайдбару и главной (название + ID + превью).
  li.dataset.search = (title.textContent + ' ' + r.roomId.slice(0, 8) + ' ' + pv.textContent).toLowerCase();
  return li;
}

// v30: фильтр сайдбара по уже отрендеренным пунктам (без перерендера).
let sidebarQuery = '';
let homeChatQuery = '';
function applySidebarFilter() {
  const side = $('#chatRoomsSidebar');
  if (side) {
    const q = sidebarQuery.trim().toLowerCase();
    for (const li of side.children) {
      li.style.display = !q || (li.dataset.search || '').includes(q) ? '' : 'none';
    }
  }
  const homeList = $('#chatRoomsList');
  if (homeList) {
    const qh = homeChatQuery.trim().toLowerCase();
    for (const li of homeList.children) {
      if (li.classList.contains('tg-empty-rooms')) continue;
      li.style.display = !qh || (li.dataset.search || '').includes(qh) ? '' : 'none';
    }
  }
}

// v38: сводка комнаты для списка: последнее видимое сообщение и seq
// чужих видимых сообщений (непрочитанные считаются от lastReadSeq).
async function roomSummary(roomId, rec = null) {
  const hit = roomSummaryCache.get(roomId);
  if (hit) return hit;
  const gen = roomSummaryGen.get(roomId) || 0;
  const msgs = await roomMessages(roomId);
  // v27: превью — по последнему ВИДИМОМУ сообщению: управляющие типы
  // (реакции, правки, закрепы) и обмен ключами эпохи в превью не показываем.
  const visible = msgs.filter((x) => !CONTROL_TYPES.has(x.msg.type) && x.msg.type !== 'ecdh');
  const last = visible.length ? visible[visible.length - 1] : null;
  const others = visible.filter((it) => !isOwnEntry(it, rec) && !it.local).map((it) => it.seq || 0);
  const sm = { last, others };
  if ((roomSummaryGen.get(roomId) || 0) === gen) roomSummaryCache.set(roomId, sm);
  return sm;
}

async function renderRoomListNow() {
  const list = $('#chatRoomsList');
  const side = $('#chatRoomsSidebar');
  if (!list && !side) return;
  const rooms = (await kvAll('rooms')).map((x) => x.value).filter(Boolean);
  const enriched = [];
  for (const r0 of rooms) {
    // Открытая комната: актуальные lastReadSeq/ник — в памяти, не в IDB.
    const r = cur && cur.rec.roomId === r0.roomId ? cur.rec : r0;
    const sm = await roomSummary(r.roomId, r);
    const readSeq = r.lastReadSeq || 0;
    enriched.push({
      r,
      last: sm.last,
      unread: sm.others.filter((q) => q > readSeq).length,
      lastTs: sm.last ? sm.last.msg.ts : r.createdAt || 0,
    });
  }
  enriched.sort((a, b) => b.lastTs - a.lastTs);
  const totalUnread = enriched.reduce((acc, x) => acc + (x.unread || 0), 0);
  const tabUnread = $('#homeTabUnread');
  if (tabUnread) {
    tabUnread.textContent = totalUnread > 0 ? String(totalUnread) : '';
    tabUnread.classList.toggle('hidden', totalUnread <= 0);
  }
  if (list) {
    list.replaceChildren();
    if (!enriched.length) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'tg-empty-rooms';
      emptyLi.innerHTML = '<div class="tg-empty-rooms-box"><span class="tg-empty-rooms-ic">💬</span><b>Здесь будут ваши чаты</b><span>Кнопка ✏️ внизу создаёт зашифрованный чат, 🔗 вверху — вход по ссылке, коду или кодовой фразе.</span></div>';
      list.append(emptyLi);
    } else {
      for (const e of enriched) list.append(buildRoomListItem(e));
    }
    applySidebarFilter();
  }
  // v30: тот же список — в десктопный сайдбар экрана чата.
  if (side) {
    side.replaceChildren();
    if (!enriched.length) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'tg-empty-rooms';
      emptyLi.innerHTML = '<div class="tg-empty-rooms-box"><span class="tg-empty-rooms-ic">💬</span><b>Список чатов пуст</b><span>Кнопка ✏️ вверху создаёт новый чат</span></div>';
      side.append(emptyLi);
    } else {
      for (const e of enriched) side.append(buildRoomListItem(e, { sidebar: true }));
    }
    applySidebarFilter();
  }
  syncChatEmpty();
}

// v30: на десктопе, когда экран чата виден, но комната не открыта, правая
// панель показывает заглушку «Выберите чат слева» вместо карточки комнаты.
function syncChatEmpty() {
  $('#chatroom')?.classList.toggle('chat-no-room', !cur);
}

// ---------- v29: меню комнаты в списке и внутри комнаты ----------
// v36: меню ставится по реальному размеру: под якорем, у нижнего края
// экрана — над ним, и никогда не вылезает за края окна.
function placeMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = r.bottom + 4;
  const top = below + mh <= vh - 8 ? below : Math.max(8, r.top - 4 - mh);
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, Math.min(vw - mw - 8, r.left)) + 'px';
}
// На сенсорных экранах касание пузыря открывает меню сообщения (как в
// Telegram): iOS не присылает contextmenu на долгое нажатие.
export const TOUCH_UI = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

let listMenuRec = null;
function hideRoomListMenu() {
  $('#chatListMenu')?.classList.add('hidden');
  listMenuRec = null;
}
async function openRoomListMenu(rec, anchor) {
  const menu = $('#chatListMenu');
  if (!menu) return;
  if (listMenuRec?.roomId === rec.roomId && !menu.classList.contains('hidden')) {
    hideRoomListMenu();
    return;
  }
  listMenuRec = rec;
  const device = await getChatDevice().catch(() => null);
  const isCreator =
    !!device &&
    (rec.creatorPub === device.devicePub || (!rec.creatorPub && rec.createdByMe));
  setKeepLabel($('#roomListKeep'), rec.keepForever);
  const delAll = $('#roomListDelAll');
  if (delAll) delAll.classList.toggle('hidden', !isCreator);
  for (const id of ['#roomListDelSelf', '#roomListDelAll']) {
    const b = $(id);
    if (b) {
      delete b.dataset.armed;
      b.dataset.label = labelOf(b).textContent;
    }
  }
  menu.classList.remove('hidden');
  placeMenu(menu, anchor);
}
// Двухшаговое подтверждение для разрушительных пунктов меню: первый клик
// «взводит» кнопку (подпись меняется на «Точно …?»), второй — выполняет.
// Подпись пункта меню живёт в его <span> — иконку рядом не трогаем.
const labelOf = (btn) => btn.querySelector('span') || btn;
function setKeepLabel(btn, on) {
  if (!btn) return;
  labelOf(btn).textContent = on ? 'Сохранён от автоудаления' : 'Сохранить от автоудаления';
  btn.setAttribute('aria-pressed', String(!!on));
}
function armButton(btn, armedText) {
  if (!btn) return false;
  const label = labelOf(btn);
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    if (btn.dataset.label) label.textContent = btn.dataset.label;
    return true;
  }
  btn.dataset.armed = '1';
  if (!btn.dataset.label) btn.dataset.label = label.textContent;
  label.textContent = armedText;
  setTimeout(() => {
    if (btn.dataset.armed) {
      delete btn.dataset.armed;
      if (btn.dataset.label) label.textContent = btn.dataset.label;
    }
  }, 5000);
  return false;
}
// Состояние пунктов меню открытой комнаты (создатель/keepForever).
function renderRoomMenuState() {
  if (!cur) return;
  setKeepLabel($('#roomActKeep'), cur.rec.keepForever);
  const isCreator =
    cur.rec.creatorPub === cur.device.devicePub ||
    (!cur.rec.creatorPub && cur.rec.createdByMe);
  $('#roomActDeleteAll')?.classList.toggle('hidden', !isCreator);
  const noteEl = $('#roomMenuNote');
  if (noteEl) {
    noteEl.textContent = isCreator
      ? cur.rec.creatorPub
        ? '«Удалить для всех» сотрёт чат у участников и на сервере.'
        : 'Чат создан в старой версии: «Удалить для всех» сотрёт его у участников, а серверная копия исчезнет по сроку.'
      : cur.rec.creatorPub
        ? 'Удалить чат для всех может только его создатель.'
        : 'Создатель чата неизвестен (чат из версии до v29) — удалить его для всех нельзя.';
  }
}

// ---------- Открытие комнаты ----------
// Поиск локальной записи комнаты по seed: комнаты немного, seed сверяем
// расшифровкой seedEnc каждой записи (vault). Нужен до вывода ключей:
// PIN-защищённая комната имеет другой Room_ID, и без PIN её запись по
// Room_ID не найти.
async function findRoomBySeed(seedStr) {
  const target = String(seedStr).trim();
  const rooms = (await kvAll('rooms')).map((x) => x.value).filter(Boolean);
  for (const r of rooms) {
    try {
      if ((await decryptWithVault(r.seedEnc)) === target) return r;
    } catch {}
  }
  return null;
}

function showPinPrompt(seedStr) {
  pendingPinSeed = String(seedStr).trim();
  hideChatScreen();
  $('#chatPinBox')?.classList.remove('hidden');
  $('#chatPinEntry')?.focus();
  note('Этот чат защищён PIN-кодом: без него не выводится даже адрес комнаты. Введите PIN, который вам сообщили устно.');
}

// Ключ произвольной эпохи комнаты (лениво, с кэшем на сессию открытия).
// Эпоха 0 — базовый ключ из deriveChatKeys; эпохи ≥1 — из секрета эпохи.
async function keyForEpoch(n) {
  if (!cur) return null;
  if (cur.epochKeys.has(n)) return cur.epochKeys.get(n);
  const entry = (cur.rec.epochs || []).find((e) => e.n === n);
  if (!entry?.secret) return null;
  const seed = await decryptWithVault(cur.rec.seedEnc);
  const key = await deriveEpochRoomKey(b64u.dec(seed), b64u.dec(entry.secret), n, {
    pinIkm: cur.pinIkm,
  });
  cur.epochKeys.set(n, key);
  return key;
}

// Расшифровка blob любым известным ключом комнаты: текущая эпоха, затем
// остальные эпохи по убыванию, затем базовый ключ. Чужие/битые blob → null.
async function decryptAny(raw) {
  if (!cur) return null;
  const tried = new Set();
  const candidates = [cur.keys.roomKey, cur.keys0?.roomKey];
  const epochsDesc = [...(cur.rec.epochs || [])].sort((a, b) => b.n - a.n);
  for (const e of epochsDesc) {
    const k = await keyForEpoch(e.n);
    if (k) candidates.push(k);
  }
  for (const k of candidates) {
    if (!k || tried.has(k)) continue;
    tried.add(k);
    const m = await decryptChatMessage(k, raw);
    if (m) return m;
  }
  return null;
}

// ---------- v31: храповик (forward secrecy) ----------
// Уровень 1 — цепочки отправителя для всех комнат/эпох; уровень 2 —
// Double Ratchet для комнат 1:1. Состояние — в записи комнаты
// (rec.ratchet, JSON), переходы — чистые функции crypto.js; здесь только
// хранение, маршрутизация по nonce-подсказке и ввод-вывод. Сообщения
// версий ≤v30 (без rk) расшифровываются статичными ключами как раньше
// (decryptAny) — маршрутная ветка при неудаче всегда откатывается на неё.
async function roomSeedB64() {
  if (cur.seedB64) return cur.seedB64;
  const s = await decryptWithVault(cur.rec.seedEnc);
  cur.seedB64 = s;
  return s;
}

function epochSecretBytes(n) {
  if (!n) return null;
  const entry = (cur.rec.epochs || []).find((e) => e.n === n);
  return entry?.secret ? b64u.dec(entry.secret) : null;
}

function ratchetRt() {
  if (!cur.rec.ratchet || typeof cur.rec.ratchet !== 'object') {
    cur.rec.ratchet = { send: {}, recv: {}, dr: null };
  }
  if (!cur.rec.ratchet.send) cur.rec.ratchet.send = {};
  if (!cur.rec.ratchet.recv) cur.rec.ratchet.recv = {};
  if (!('dr' in cur.rec.ratchet)) cur.rec.ratchet.dr = null;
  return cur.rec.ratchet;
}

async function chainRootB64(epoch, dev) {
  const cacheKey = `${epoch}|${dev}`;
  if (cur.chainRoots.has(cacheKey)) return cur.chainRoots.get(cacheKey);
  const secret = epoch > 0 ? epochSecretBytes(epoch) : null;
  if (epoch > 0 && !secret) return null;
  const seedBytes = b64u.dec(await roomSeedB64());
  const root = await deriveChainRoot(seedBytes, cur.pinIkm, secret, epoch, dev);
  cur.chainRoots.set(cacheKey, root);
  return root;
}

async function getSendChain(epoch) {
  const rt = ratchetRt();
  if (!rt.send[epoch]) {
    const root = await chainRootB64(epoch, cur.device.devicePub);
    if (!root) return null;
    rt.send[epoch] = chainInitSendState(root);
  }
  return rt.send[epoch];
}

function peekRecvChain(epoch, dev) {
  return cur.rec.ratchet?.recv?.[epoch]?.[dev] || null;
}

async function freshRecvChain(epoch, dev) {
  const root = await chainRootB64(epoch, dev);
  return root ? chainInitRecvState(root) : null;
}

function commitRecvChain(epoch, dev, state) {
  const rt = ratchetRt();
  if (!rt.recv[epoch]) rt.recv[epoch] = {};
  rt.recv[epoch][dev] = state;
  saveRoom(cur.rec).catch(() => {});
}

// Смена эпохи: принимающие цепочки старых эпох теряют ck (остаются только
// skipped-ключи недоставленных сообщений), отправляющие выбрасываются —
// в старой эпохе мы больше не пишем.
function pruneOldEpochChains(newEpoch) {
  const rt = cur.rec.ratchet;
  if (!rt) return;
  for (const ep of Object.keys(rt.recv || {})) {
    if (Number(ep) < newEpoch) {
      for (const dev of Object.keys(rt.recv[ep])) chainPruneRecvState(rt.recv[ep][dev]);
    }
  }
  for (const ep of Object.keys(rt.send || {})) {
    if (Number(ep) < newEpoch) delete rt.send[ep];
  }
}

// Отправка в режиме цепочки: одноразовый ключ сообщения из цепочки
// текущей эпохи, подсказка маршрутизации — в nonce.
async function encryptOutgoing(m) {
  const epoch = m.epoch || 0;
  const st = await getSendChain(epoch);
  if (!st) {
    // Секрета текущей эпохи у нас нет (исключили при ротации): поведение
    // как до v31 — статичный ключ; такие сообщения всё равно нечитаемы.
    return encryptChatMessage(cur.keys.roomKey, m);
  }
  const { mk, cn } = await chainSendTake(st);
  m.rk = 'c1';
  m.cn = cn;
  const blob = await encryptChatWithKeyBytes(
    mk,
    m,
    chainNonce(cn, epoch, b64u.dec(cur.device.devicePub))
  );
  saveRoom(cur.rec).catch(() => {});
  return blob;
}

// Кандидаты-отправители для маршрутной расшифровки: сначала совпавшие по
// 2-байтному тегу dev из nonce, если таких нет — все известные устройства.
function chainCandidateDevs(tag2) {
  const devs = new Set([
    cur.device.devicePub,
    ...Object.keys(cur.rec.members || {}),
    ...Object.keys(cur.rec.seenDevices || {}),
    ...cur.receipts.keys(),
    ...cur.online,
  ]);
  const matched = [];
  for (const d of devs) {
    let t = cur.devTagCache.get(d);
    if (!t) {
      try {
        t = [...pubTagOf(b64u.dec(d)).subarray(0, 2)];
      } catch {
        continue;
      }
      cur.devTagCache.set(d, t);
    }
    if (tagBytesEq(t, tag2)) matched.push(d);
  }
  return matched.length ? { devs: matched, matched: true } : { devs: [...devs], matched: false };
}

// v38: ключ сообщения cn заново из корня цепочки (без изменения
// сохранённого состояния) — для опоздавших, повторных и «вытесненных»
// сообщений. Корень выводится из seed и секрета эпохи, которые и так
// хранятся у участника, поэтому forward secrecy уровня 1 это не ослабляет
// (её дают смена эпох и Double Ratchet). Контрольные точки — в памяти.
const CHAIN_CPS_MAX = 512;
async function chainKeyFromRoot(epoch, dev, cn) {
  const root = await chainRootB64(epoch, dev);
  if (!root || !Number.isInteger(cn) || cn < 0) return null;
  if (!cur.chainCps) cur.chainCps = new Map();
  const ck = `${epoch}|${dev}`;
  let cps = cur.chainCps.get(ck);
  if (!cps) {
    cps = new Map();
    cur.chainCps.set(ck, cps);
  }
  let startN = 0;
  let startCk = root;
  const cpN = cn - (cn % 512);
  for (let n = cpN; n > 0; n -= 512) {
    if (cps.has(n)) {
      startN = n;
      startCk = cps.get(n);
      break;
    }
  }
  return chainKeyAt(startCk, startN, cn, (n, bytes) => {
    if (cps.size < CHAIN_CPS_MAX && !cps.has(n)) cps.set(n, b64u.enc(bytes));
  });
}

const cloneChain = (st) => JSON.parse(JSON.stringify(st));

// Расшифровка blob режима 'c1' по подсказке nonce. При успехе состояние
// цепочки коммитится; при «ключ уже использован и удалён» возвращает
// {__miss} — вызывающий положит заглушку в ленту.
// v38: ключ, уже израсходованный или вытесненный из окна skipped, больше
// не означает потерю сообщения — он выводится заново из корня цепочки
// (chainKeyFromRoot); неизвестный отправитель или отсутствующий секрет
// эпохи — временная ошибка ({__retry}), сообщение уходит в очередь повтора.
async function chainDecrypt(raw, hint) {
  const epoch = hint.epoch;
  if (epoch > 0 && !epochSecretBytes(epoch)) return { __retry: 'epoch' };
  const { devs, matched } = chainCandidateDevs(hint.tag);
  for (const dev of devs) {
    const stored = peekRecvChain(epoch, dev);
    const base = stored || (await freshRecvChain(epoch, dev));
    if (!base) continue;
    const trial = cloneChain(base);
    // Перебор «всех известных» (тег не совпал ни с кем) — с коротким
    // потолком: длинный проход для чужих цепочек бесполезен.
    const r = await chainRecvTake(trial, hint.cn, matched ? undefined : 2000);
    let mk = r.status === 'ok' ? r.mk : null;
    let commit = r.status === 'ok';
    if (!mk && matched && (r.status === 'unavailable' || r.status === 'gap')) {
      mk = await chainKeyFromRoot(epoch, dev, hint.cn);
      commit = false;
    }
    if (!mk) continue;
    const msg = await decryptChatWithKeyBytes(mk, raw);
    if (msg && msg.devPub === dev && msg.rk === 'c1' && msg.cn === hint.cn) {
      if (commit) commitRecvChain(epoch, dev, trial);
      if (msg.type === 'drx') return await drOpenInnerFromOuter(msg);
      return msg;
    }
  }
  return matched ? null : { __retry: 'dev' };
}

// ---------- v31: Double Ratchet (комнаты 1:1) ----------
function drState() {
  return cur?.rec.ratchet?.dr || null;
}
function drActive() {
  const dr = drState();
  return dr && !dr.suspended ? dr : null;
}

// Приватный ключ для принимающего DH-шага: пара, чья публичная половина
// была моей последней отправленной (текущая отправляющая пара DR), а до
// первой своей отправки — долговременный ECDH-ключ устройства.
async function drStepPrivKey(dr) {
  if (dr.send?.privEnc) {
    const scalar = b64u.dec(await decryptWithVault(dr.send.privEnc));
    return (await drPairFromScalar(scalar)).privateKey;
  }
  const d = await getChatDeviceEcdh();
  return d.ecdhPriv;
}

// Отправка контента в режиме DR. Возвращает blob для провода; само
// сообщение m (с полями rk/dh/pn/cn) — то, что ляжет в локальную ленту.
async function drEncryptContent(m) {
  const dr = drState();
  if (dr.needStep || !dr.send) {
    // DH-шаг отправки: новая ratchet-пара, корень продвигается, первое
    // сообщение новой цепочки едет транзитом (см. drOpenInnerFromOuter).
    const scalar = randomP256Scalar();
    const pair = await drPairFromScalar(scalar);
    const peerPub = memberEcdhPub(dr.peer);
    const theirPubRaw = dr.recvDh ? b64u.dec(dr.recvDh) : peerPub ? b64u.dec(peerPub) : null;
    if (!theirPubRaw) throw new Error('dr: нет публичного ключа собеседника');
    const dhOut = await ecdhSharedBits(pair.privateKey, theirPubRaw);
    const { rk, ck } = await drKdfRk(dr.rk, dhOut);
    const pn = dr.send ? dr.send.n : 0;
    const newSend = {
      dh: b64u.enc(pair.pubRaw),
      ck,
      n: 0,
      pn,
      privEnc: await encryptWithVault(b64u.enc(scalar)),
    };
    m.rk = 'd1';
    m.dh = newSend.dh;
    m.pn = pn;
    m.cn = 0;
    const tmp = { ck, n: 0 };
    const { mk } = await chainSendTake(tmp);
    newSend.ck = tmp.ck;
    newSend.n = tmp.n;
    const innerBytes = await sealCompactWithKeyBytes(mk, m);
    const outer = await buildMsg(
      'drx',
      JSON.stringify({ dh: newSend.dh, pn, inner: b64u.enc(innerBytes) })
    );
    const prevSend = dr.send;
    dr.rk = rk;
    dr.send = newSend;
    dr.needStep = false;
    let blob;
    if (prevSend) {
      // Внешняя обёртка — ключом предыдущей отправляющей цепочки
      // (индекс pn: ровно следующий за её сообщениями).
      const pst = { ck: prevSend.ck, n: prevSend.n };
      const t = await chainSendTake(pst);
      blob = await encryptChatWithKeyBytes(t.mk, outer, transitNonce(t.cn, b64u.dec(prevSend.dh)));
    } else {
      // Самое первое сообщение сессии с этой стороны: обёртка едет
      // обычным сообщением цепочки уровня 1.
      blob = await encryptOutgoing(outer);
    }
    saveRoom(cur.rec).catch(() => {});
    return blob;
  }
  const tmp = { ck: dr.send.ck, n: dr.send.n };
  const { mk, cn } = await chainSendTake(tmp);
  dr.send.ck = tmp.ck;
  dr.send.n = tmp.n;
  m.rk = 'd1';
  m.dh = dr.send.dh;
  m.pn = dr.send.pn;
  m.cn = cn;
  const blob = await encryptChatWithKeyBytes(mk, m, drNonce(cn, b64u.dec(dr.send.dh)));
  saveRoom(cur.rec).catch(() => {});
  return blob;
}

// Открытие транзитной обёртки 'drx': подпись внешнего сообщения обязана
// быть валидной и принадлежать DR-собеседнику — шаг состояния делается
// только по аутентифицированному dh, иначе сессию можно было бы
// рассинхронизировать подделкой.
async function drOpenInnerFromOuter(outer) {
  const dr = drState();
  if (!dr || !outer || outer.devPub !== dr.peer) return null;
  let sigOk = false;
  try {
    sigOk = !!(outer.sig && (await verifyChatSig(outer.devPub, outer.sig, canonical(outer))));
  } catch {}
  if (!sigOk) return null;
  let data = null;
  try {
    data = JSON.parse(outer.text || '');
  } catch {}
  if (!data?.dh || !data?.inner) return null;
  const innerBytes = b64u.dec(data.inner);
  const theirPubRaw = b64u.dec(data.dh);
  const tag = pubTagHex(theirPubRaw);
  if (dr.recvDh === data.dh && dr.recvChains?.[tag]) {
    // Повторный транзит уже принятой цепочки — внутреннее сообщение cn=0.
    const trial = cloneChain(dr.recvChains[tag]);
    const r = await chainRecvTake(trial, 0);
    if (r.status !== 'ok') return null;
    const inner = await openCompactWithKeyBytes(r.mk, innerBytes);
    if (inner && inner.rk === 'd1' && inner.dh === data.dh) {
      dr.recvChains[tag] = trial;
      saveRoom(cur.rec).catch(() => {});
      return inner;
    }
    return null;
  }
  const stepPriv = await drStepPrivKey(dr);
  await drRecvStep(dr, stepPriv, theirPubRaw, Number.isInteger(data.pn) ? data.pn : 0);
  dr.needStep = true;
  const chain = dr.recvChains?.[tag];
  if (!chain) return null;
  const trial = cloneChain(chain);
  const r = await chainRecvTake(trial, 0);
  if (r.status !== 'ok') {
    saveRoom(cur.rec).catch(() => {});
    return null;
  }
  const inner = await openCompactWithKeyBytes(r.mk, innerBytes);
  if (inner && inner.rk === 'd1' && inner.dh === data.dh) {
    dr.recvChains[tag] = trial;
    saveRoom(cur.rec).catch(() => {});
    return inner;
  }
  saveRoom(cur.rec).catch(() => {});
  return null;
}

async function drDecryptDirect(raw, hint) {
  const dr = drState();
  if (!dr) return null;
  const chain = dr.recvChains?.[hint.tag];
  if (!chain) return null;
  const trial = cloneChain(chain);
  const r = await chainRecvTake(trial, hint.cn);
  if (r.status !== 'ok') {
    if (r.status === 'unavailable' && hint.cn < chain.nextN) {
      return { __miss: { dev: dr.peer, cn: hint.cn, epoch: cur.rec.epoch || 0 } };
    }
    return null;
  }
  const msg = await decryptChatWithKeyBytes(r.mk, raw);
  if (msg && msg.rk === 'd1' && msg.cn === hint.cn && msg.dh === chain.dh && msg.devPub === dr.peer) {
    dr.recvChains[hint.tag] = trial;
    saveRoom(cur.rec).catch(() => {});
    return msg;
  }
  return null;
}

async function drDecryptTransit(raw, hint) {
  const dr = drState();
  if (!dr) return null;
  const chain = dr.recvChains?.[hint.tag];
  if (!chain) return null;
  const trial = cloneChain(chain);
  const r = await chainRecvTake(trial, hint.cn);
  if (r.status !== 'ok') return null;
  const outer = await decryptChatWithKeyBytes(r.mk, raw);
  if (!outer || outer.type !== 'drx' || outer.devPub !== dr.peer) return null;
  dr.recvChains[hint.tag] = trial; // обёртка потреблена, даже если шаг не выйдет
  saveRoom(cur.rec).catch(() => {});
  return await drOpenInnerFromOuter(outer);
}

// Единая точка расшифровки входящего blob: сначала маршрутная ветка по
// подсказке nonce, при неудаче — статичные ключи (все сообщения ≤v30 и
// служебные автономные посты). drx-обёртки, пришедшие статичным или
// цепочечным путём, разворачиваются в DR-сообщение.
export async function decryptIncoming(raw) {
  const hint = parseBlobHint(raw.subarray(0, 12));
  let retry = null;
  if (hint?.mode === 'c1') {
    const r = await chainDecrypt(raw, hint);
    if (r && !r.__retry) return r;
    if (r?.__retry) retry = r;
  } else if (hint?.mode === 'd1') {
    const r = await drDecryptDirect(raw, hint);
    if (r) {
      if (!r.__miss) cur.drFails = 0;
      return r;
    }
  } else if (hint?.mode === 'tx') {
    const r = await drDecryptTransit(raw, hint);
    if (r) {
      cur.drFails = 0;
      return r;
    }
  }
  const m = await decryptAny(raw);
  if (m && m.type === 'drx') return await drOpenInnerFromOuter(m);
  if (m) return m;
  if ((hint?.mode === 'd1' || hint?.mode === 'tx') && drState()) {
    // v38: сообщение Double Ratchet не открылось ни одной известной
    // цепочкой. Несколько таких подряд — рассинхронизация сессии (потеря
    // состояния у одной из сторон): приостанавливаем DR, комната
    // возвращается на цепочки уровня 1, собеседник v38 увидит наше
    // подписанное c1-сообщение и тоже приостановит свою сессию.
    cur.drFails = (cur.drFails || 0) + 1;
    if (cur.drFails >= 3) suspendDr('desync');
    return { __retry: 'dr' };
  }
  return retry;
}

// v38: приостановка Double Ratchet (третий участник, рассинхронизация,
// подписанное c1-сообщение собеседника). Чат продолжает работать на
// цепочках уровня 1 — сообщения не теряются.
export function suspendDr(reason) {
  const dr = cur?.rec.ratchet?.dr;
  if (!dr || dr.suspended) return;
  dr.suspended = true;
  dr.suspendedAt = Date.now();
  dr.suspendReason = reason;
  saveRoom(cur.rec).catch(() => {});
}

// Инициация DR-сессии собеседником: dr-init приходит обычным сообщением
// текущего режима; корень выводится из ECDH(эфемерный ключ инициатора,
// наш ECDH устройства) и секрета эпохи инициации.
export async function handleDrInit(msg, sigOk) {
  if (!cur || !sigOk || !msg?.devPub) return;
  const peer = msg.devPub;
  if (peer === cur.device.devicePub) return;
  const others = knownMembers().filter((d) => d !== cur.device.devicePub);
  if (others.length !== 1 || others[0] !== peer) return;
  let data = null;
  try {
    data = JSON.parse(msg.text || '');
  } catch {}
  if (!data?.ephPub) return;
  const existing = drState();
  if (existing && !existing.suspended) {
    // Коллизия одновременных инициаций: инициатором остаётся меньший
    // devPub; если собеседник меньше — принимаем его сессию.
    // v38: законный инициатор (меньший devPub) может и ПЕРЕинициировать
    // сессию (потерял состояние) — принимаем более новый подписанный
    // dr-init, иначе стороны навсегда расходились в разные сессии.
    if (!(peer < cur.device.devicePub)) return;
    if (!existing.initiator && (Number(msg.ts) || 0) <= (existing.initTs || 0)) return;
  }
  const epoch = Number.isInteger(data.epoch) ? data.epoch : cur.rec.epoch || 0;
  const mat = epoch === 0 ? b64u.dec(await roomSeedB64()) : epochSecretBytes(epoch);
  if (!mat) return;
  const d = await getChatDeviceEcdh();
  const shared = await ecdhSharedBits(d.ecdhPriv, b64u.dec(data.ephPub));
  const rk = await drRootFromInit(shared, mat);
  ratchetRt().dr = {
    peer,
    initiator: false,
    rk,
    recvDh: null,
    recvChains: {},
    send: null,
    needStep: false,
    suspended: false,
    startedTs: Date.now(),
    initTs: Number(msg.ts) || Date.now(),
  };
  saveRoom(cur.rec).catch(() => {});
}

// Инициатор — устройство с меньшим devPub (детерминированный тай-брейк,
// обе стороны считают одинаково). Условия: комната строго 1:1,
// собеседник объявил dr в caps и опубликовал ecdhPub.
export async function maybeStartDr() {
  if (!cur || !cur.rec.nick) return;
  const existing = drState();
  if (existing) return;
  const others = knownMembers().filter((d) => d !== cur.device.devicePub);
  if (others.length !== 1) return;
  const peer = others[0];
  const mem = cur.rec.members?.[peer];
  if (!mem?.ecdhPub || mem?.caps?.dr !== 1) return;
  if (!(cur.device.devicePub < peer)) return; // инициатор — меньший devPub
  const epoch = cur.rec.epoch || 0;
  const mat = epoch === 0 ? b64u.dec(await roomSeedB64()) : epochSecretBytes(epoch);
  if (!mat) return;
  const eph = await genP256KeyPair(['deriveBits'], 'ECDH');
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = await ecdhSharedBits(eph.privateKey, b64u.dec(mem.ecdhPub));
  const rk = await drRootFromInit(shared, mat);
  ratchetRt().dr = {
    peer,
    initiator: true,
    rk,
    recvDh: null,
    recvChains: {},
    send: null,
    needStep: false,
    suspended: false,
    startedTs: Date.now(),
  };
  saveRoom(cur.rec).catch(() => {});
  await sendMsg('dr-init', JSON.stringify({ ephPub: b64u.enc(ephRaw), epoch }));
}

// Заглушка навсегда недоступного сообщения храповика: ключ использован и
// удалён (или вытеснен из skipped-окна) — содержимое не восстановить, но
// место сообщения в ленте честно показываем.
export async function storeRatchetMiss(item, hash, miss) {
  const stubMsg = {
    v: 1,
    id: 'miss-' + hash,
    ts: item.ts || Date.now(),
    nick: '',
    devPub: miss.dev || '',
    type: 'text',
    text: '',
    epoch: miss.epoch || 0,
    ratchetMiss: true,
  };
  const entry = { hash, msg: stubMsg, sigOk: false, mine: false, reactions: {} };
  if (Number.isFinite(item.seq)) entry.seq = item.seq;
  await storeMessage(cur.rec, entry);
  renderMessages().catch(() => {});
}

// opts.pin — PIN строкой; opts.pinProtected — ссылка помечена как PIN-комната
// (маркер &p=1): если PIN не задан и локально не сохранён, показываем экран
// запроса PIN и комнату не открываем.
export async function openRoomBySeed(seedStr, opts = {}) {
  if (opening) return;
  opening = true;
  try {
    const seedBytes = b64u.dec(String(seedStr).trim());
    if (seedBytes.length !== 32) throw new Error('bad seed');
    let pin = opts.pin ? String(opts.pin) : null;
    const existing = await findRoomBySeed(seedStr);
    if (!pin && existing?.pinEnc) {
      try {
        pin = await decryptWithVault(existing.pinEnc);
      } catch {}
    }
    if (!pin && opts.pinProtected && !(existing && !existing.pinProtected)) {
      showPinPrompt(seedStr);
      return;
    }
    const pinIkm = pin ? await derivePinIkm(pin, seedBytes) : null;
    const keys0 = await deriveChatKeys(seedBytes, { pinIkm });
    if (cur && cur.keys.roomId === keys0.roomId) {
      // уже открыта эта комната. v38: возврат из звонка, начатого в этом
      // чате, — контекст (WS, heartbeat звонка, приём) жив, показываем экран.
      if (cur.inCall || $('#chatroom')?.classList.contains('hidden')) {
        cur.inCall = null;
        showChatScreen();
        renderMessages().catch(() => {});
        updateGcallBanner().catch(() => {});
        fetchMissed().catch(() => {});
      }
      return;
    }
    // v38: одна вкладка на комнату (иначе две копии храповика выдают
    // одинаковые номера сообщений и расходятся состояния приёма).
    await acquireRoomLock(keys0.roomId);
    const device = await getChatDevice();
    let rec = await loadRoom(keys0.roomId);
    if (!rec && existing && existing.roomId === keys0.roomId) rec = existing;
    const freshRoom = !rec;
    if (!rec) {
      rec = {
        roomId: keys0.roomId,
        seedEnc: await encryptWithVault(b64u.enc(seedBytes)),
        nick: '',
        epoch: 0,
        lastSeq: 0,
        lastReadSeq: 0,
        members: {},
        introSent: false,
        createdAt: Date.now(),
      };
      // v29: комната создана этим устройством через «Создать чат» —
      // оно опубликует room-meta и получит право «Удалить для всех».
      if (opts.created) {
        rec.createdByMe = true;
        rec.creatorPub = device.devicePub;
      }
    }
    rec = normalizeRoomRecord(rec);
    if (pin) {
      rec.pinProtected = true;
      if (!rec.pinEnc) rec.pinEnc = await encryptWithVault(pin);
    }
    await saveRoom(rec);
    if (freshRoom) notifyRoomsChanged(); // v38: новая комната — в бэкап
    closeCurrent(false);
    selfDev = device.devicePub;
    // Ключ текущей эпохи: эпоха 0 — базовый; выше — из секрета эпохи, если
    // он у нас есть. Нет секрета (нас не оставили при ротации) — остаёмся на
    // базовом ключе: старая история читается, новые сообщения не расшифруются.
    const epochKeys = new Map([[0, keys0.roomKey]]);
    let currentKey = keys0.roomKey;
    let epochMissing = false;
    cur = {
      rec,
      keys: keys0,
      keys0,
      device,
      ws: null,
      closed: false,
      backoff: 1000,
      pendingCall: null,
      online: new Set(),
      receipts: new Map(),
      typing: null,
      typingTimer: null,
      lastTypingSent: 0,
      pin,
      pinIkm,
      epochKeys,
      epochMissing: false,
      // v27: состояние редактора и ленты
      replyTo: null, // {hash, name, excerpt} — цитата к следующему сообщению
      editing: null, // {hash} — редактируемое своё сообщение
      search: null, // {q, hashes:[], idx} — активный поиск по переписке
      menuTarget: null, // запись сообщения, для которой открыто меню действий
      expireTimer: null,
      draftTimer: null,
      // v28: транспорт (воркер/резерв), реестр устройств, ворота ника
      transportMode: 'worker',
      mgr: null,
      fb: null,
      healthTimer: null,
      syncingInitial: true, // до конца первой синхронизации алертов устройств нет
      // v29: живой групповой звонок (сессия этого открытия комнаты)
      gcall: null, // {callId, hbTimer} — я участник этого звонка
      gcallState: null, // последняя агрегация aggregateGcallState
      gcallEndPosted: new Set(), // callId, по которым end уже выведен мной
      gcallTimer: null, // периодический прунинг/перерендер плашки
      // v31: храповик — кэш seed комнаты и корней цепочек на сессию открытия
      seedB64: null,
      chainRoots: new Map(), // `${epoch}|${dev}` -> ck0 base64
      devTagCache: new Map(), // devPub -> [b0, b1] тег маршрутизации nonce
      // v38: очереди, индексы и окно ленты
      q: Promise.resolve(), // криптоочередь приёма/подготовки отправки
      sendQ: Promise.resolve(), // порядок отправок
      msgIds: null, // Set id сообщений (дедуп между каналами)
      chainCps: new Map(), // контрольные точки цепочек для вывода из корня
      drFails: 0,
      renderLimit: RENDER_PAGE,
      callSecrets: new Set(), // звонки, начатые/принятые из этого чата
      inCall: null, // секрет звонка, пока экран чата скрыт звонком
      returnHash: '',
    };
    if (rec.epoch > 0) {
      const k = await keyForEpoch(rec.epoch);
      if (k) currentKey = k;
      else epochMissing = true;
    }
    cur.keys = { ...keys0, roomKey: currentKey };
    cur.epochMissing = epochMissing;
    const keys = cur.keys;
    showChatScreen();
    // v27: черновик этой комнаты — недописанный текст не теряется.
    const draftInput = $('#chatInput');
    if (draftInput && rec.draft) {
      draftInput.value = rec.draft;
      // input-событие обновит видимость кнопок mic/send; typing не уйдёт —
      // WS в этот момент ещё не подключён (connectWs ниже).
      draftInput.dispatchEvent(new Event('input'));
    }
    const dispTitle = roomTitleOf(keys.roomId, rec);
    $('#chatRoomTitle').textContent = dispTitle;
    const roomAv = $('#chatRoomAvatar');
    if (roomAv) {
      roomAv.style.background = roomAvatarBg(rec);
      roomAv.textContent = (dispTitle.replace(/^Чат\s+/i, '').trim()[0] || '💬').toUpperCase();
    }
    history.replaceState(
      null,
      '',
      location.pathname + '#chat=' + b64u.enc(seedBytes) + (rec.pinProtected ? '&p=1' : '')
    );
    cur.returnHash = location.hash;
    // Инициализация на сервере (идемпотентно) + регистрация существующей push-подписки
    const sub = await existingPushSub();
    const init = await api(keys.roomId, keys.accessToken, '/init', {
      method: 'POST',
      body: { dev: device.devicePub, sub },
    });
    if (init.status === 200 && sub?.endpoint) {
      rec.pushEp = sub.endpoint;
      rec.pushAt = Date.now();
    }
    if (init.status === 200 && applyHistFloor(rec, init.data?.lastSeq)) await saveRoom(rec);
    if (init.status === 200) verifyMemberCerts(cur).catch(() => {});
    setTimeout(() => aliasRenewIfDue().catch(() => {}), 5000);
    // v29: серверная копия уже удалена — не воскрешаем локальную запись.
    if (init.status === 410) {
      await wipeLocalRoom(keys.roomId, { silent: true });
      note('Этот чат удалён (создателем или после 30 дней неактивности) — локальная копия тоже стёрта.');
      return;
    }
    if (init.status === 403) {
      note('Сервер отклонил доступ к этой комнате (токен не совпал).');
      status('Ошибка доступа');
      return;
    }
    status('Подключение…');
    // v28 (E): ник обязателен — до его ввода лента и поле ввода скрыты,
    // сообщения не рендерятся (раньше вошедший без ника молча читал чат).
    const nickGate = (on) => {
      $('#chatMessages')?.classList.toggle('hidden', on);
      $('#chatroom .chat-input-bar')?.classList.toggle('hidden', on);
      $('#chatPinBar')?.classList.toggle('hidden', on);
    };
    if (!rec.nick) {
      nickGate(true);
      $('#chatNickBox')?.classList.remove('hidden');
      // v38: готовый анонимный ник (свой для каждой комнаты — по никам
      // разные чаты друг с другом не связать); 🎲 — другой, или впишите своё.
      const nickIn = $('#chatNickInput');
      if (nickIn) nickIn.value = randomAnonName();
      nickIn?.focus();
      nickIn?.select?.();
      note('Введите никнейм — без него сообщения не показываются. Это единственная «регистрация», только для этой комнаты.');
    } else {
      nickGate(false);
      $('#chatNickBox')?.classList.add('hidden');
      renderMessages().catch(() => {});
      await sendRoomMetaIfNeeded(); // v29: room-meta — строго первым сообщением
      // v39: комната пришла с другого устройства профиля — сначала 'dial'
      // (сертификат: собеседники увидят «ещё одно устройство того же
      // человека», а не нового участника), затем intro.
      if (cur.rec.linkImport && !cur.rec.introSent) await sendDialInfoIfNeeded();
      await sendIntroIfNeeded();
      await sendEcdhIfNeeded();
      await sendDialInfoIfNeeded();
    }
    connectWs();
    // v38: самолечение отправляющих цепочек после отката состояния (номера,
    // уже ушедшие в сеть, повторно не выдаются).
    await roomQueue(() => fastForwardOwnChains()).catch(() => {});
    await fetchMissed();
    await syncState();
    // v31: если комната 1:1 и собеседник объявил DR — поднять сессию
    // Double Ratchet (инициатор — меньший devPub, см. maybeStartDr).
    await maybeStartDr().catch(() => {});
    await setupTransport();
    if (cur) cur.syncingInitial = false;
    // v38: один раз после обновления — «лечение» истории комнаты (повторная
    // расшифровка того, что v37 и раньше молча теряли). Фоном, без тостов.
    if (cur && cur.rec.nick && cur.rec.healV !== 38) {
      const c = cur;
      queueStubsForRetry()
        .then(() => healHistory(c))
        .then((n) => {
          if (n > 0 && cur === c) note(`Восстановлено ранее не дошедших сообщений: ${n}`);
        })
        .catch(() => {});
    } else if (cur && (cur.rec.retry || []).length) {
      scheduleRetry(3000);
    }
    // v29: периодический прунинг участников звонка и плашка (20 с).
    if (cur) {
      cur.gcallTimer = setInterval(() => updateGcallBanner().catch(() => {}), 20000);
      updateGcallBanner().catch(() => {});
      renderRoomMenuState();
    }
    status(cur && cur.transportMode === 'fallback' ? 'Резервный канал' : ONLINE);
    // v27: локальная чистка истёкших исчезающих сообщений.
    if (cur) {
      cur.expireTimer = setInterval(() => pruneExpired().catch(() => {}), 30000);
      pruneExpired().catch(() => {});
    }
    if (epochMissing) {
      note(
        'При последней смене эпохи вас не включили в список участников: старая переписка доступна, новые сообщения вы читать не сможете. Попросите собеседника сменить эпоху ещё раз и оставить вас.'
      );
    } else if (pin && freshRoom) {
      note(
        `Контрольная фраза комнаты: ${keys.phrase}. Сверьте её голосом с тем, кто дал ссылку: если PIN введён неверно, фраза будет другой, а комната — пустой.`
      );
    }
    renderRoomList().catch(() => {});
  } catch (e) {
    note('Не удалось открыть чат: ' + e.message);
  } finally {
    opening = false;
  }
}

// ---------- v38: одна вкладка на комнату (Web Locks) ----------
// Новая вкладка забирает замок (steal) — старая закрывает комнату у себя.
let roomLock = null; // {roomId, release}
async function acquireRoomLock(roomId) {
  if (!navigator.locks?.request) return;
  if (roomLock?.roomId === roomId) return;
  releaseRoomLock();
  const name = 'zv-room-' + roomId;
  let heldElsewhere = false;
  try {
    const q = await navigator.locks.query();
    heldElsewhere = (q.held || []).some((l) => l.name === name);
  } catch {}
  const ctl = { roomId, release: null };
  roomLock = ctl;
  await new Promise((granted) => {
    navigator.locks
      .request(name, { steal: true }, () => new Promise((rel) => {
        ctl.release = rel;
        granted();
      }))
      .catch(() => {
        granted();
        if (roomLock === ctl) {
          roomLock = null;
          if (cur && cur.rec.roomId === roomId) {
            closeCurrent(true);
            note('Этот чат открыт в другой вкладке или окне — здесь он закрыт, чтобы ключи шифрования не разошлись.');
          }
        }
      });
  });
  // Даём прежней вкладке дописать состояние в IDB.
  if (heldElsewhere) await new Promise((r) => setTimeout(r, 400));
}
function releaseRoomLock(roomId = null) {
  const l = roomLock;
  if (!l || (roomId && l.roomId !== roomId)) return;
  roomLock = null;
  try {
    l.release?.();
  } catch {}
}

// v38: номер следующего своего сообщения не меньше уже отправленных
// (по своим записям ленты) — защита от отката состояния цепочки.
async function fastForwardOwnChains() {
  const items = await roomMessages(cur.rec.roomId);
  const ids = new Set();
  const maxCn = new Map();
  for (const it of items) {
    if (it.msg?.id) ids.add(it.msg.id);
    if (it.mine && it.msg?.rk === 'c1' && Number.isInteger(it.msg.cn)) {
      const e = it.msg.epoch || 0;
      if ((maxCn.get(e) ?? -1) < it.msg.cn) maxCn.set(e, it.msg.cn);
    }
  }
  cur.msgIds = ids;
  const rt = cur.rec.ratchet;
  let moved = false;
  for (const [e, n] of maxCn) {
    const st = rt?.send?.[e];
    if (st && st.n <= n && (await chainAdvanceSend(st, n + 1))) moved = true;
  }
  if (moved) await saveRoom(cur.rec);
}

export function closeCurrent(hideScreen = true) {
  if (cur) {
    cur.closed = true;
    flushAcks(cur);
    releaseRoomLock(cur.rec.roomId);
    for (const st of fileState.values()) {
      if (st?.url) {
        try { URL.revokeObjectURL(st.url); } catch {}
      }
    }
    fileState.clear();
    for (const a of voiceAudio.values()) {
      try { a.pause(); } catch {}
    }
    voiceAudio.clear();
    if (cur.typingTimer) clearTimeout(cur.typingTimer);
    if (cur.expireTimer) clearInterval(cur.expireTimer);
    if (cur.draftTimer) clearTimeout(cur.draftTimer);
    if (cur.healthTimer) clearInterval(cur.healthTimer);
    if (cur.gcallTimer) clearInterval(cur.gcallTimer);
    if (cur.gcall?.hbTimer) clearInterval(cur.gcall.hbTimer);
    try {
      cur.fb?.close();
    } catch {}
    cur.mgr = null;
    cur.fb = null;
    hideMsgMenu();
    try {
      cur.ws?.close();
    } catch {}
    cur = null;
    syncChatEmpty();
  }
  if (hideScreen) hideChatScreen();
}

// ---------- v29: удаление чатов ----------
// Tombstones живут в localStorage ('zvDeletedRooms': [{roomId, ts}]) —
// backup.js читает тот же ключ при сборе бэкапа и при восстановлении,
// чтобы удалённая комната не воскресала из резервной копии.
const TOMBSTONE_KEY = 'zvDeletedRooms';
function loadTombstones() {
  try {
    const arr = JSON.parse(localStorage.getItem(TOMBSTONE_KEY) || '[]');
    return Array.isArray(arr)
      ? arr.filter((t) => t && typeof t.roomId === 'string' && Number.isFinite(t.ts))
      : [];
  } catch {
    return [];
  }
}
function addTombstone(roomId) {
  try {
    const arr = loadTombstones().filter((t) => t.roomId !== roomId);
    arr.push({ roomId, ts: Date.now() });
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(arr.slice(-200)));
  } catch {}
}
function notifyRoomsChanged() {
  try {
    window.dispatchEvent(new CustomEvent('zv-rooms-changed'));
  } catch {}
}

// Полное локальное стирание комнаты: сообщения, запись, черновик и
// seenDevices (всё внутри записи), tombstone против воскрешения из бэкапа.
// Если комната сейчас открыта — закрываем её экран.
export async function wipeLocalRoom(roomId, { byCreator = false, silent = false } = {}) {
  const isCur = !!cur && cur.rec.roomId === roomId;
  if (isCur) closeCurrent(true);
  // v38: одной транзакцией по диапазону ключей комнаты.
  touchRoomMsgs(roomId);
  await kvDelPrefix('messages', roomId + ':').catch(() => {});
  touchRoomMsgs(roomId);
  await kvDel('rooms', roomId).catch(() => {});
  sweepState.delete(roomId);
  addTombstone(roomId);
  notifyRoomsChanged();
  renderRoomList().catch(() => {});
  if (!silent) {
    if (byCreator) {
      showChatToast({
        title: 'Чат удалён создателем',
        body: 'Комната и её локальная копия стёрты на этом устройстве.',
        roomId,
      });
      note('Чат удалён создателем — локальная копия стёрта.');
    }
  }
}

// Сервер ответил 410 Gone: серверной копии больше нет (удаление
// создателем или автоудаление по неактивности) — стираем и локально.
export async function handleRemoteDeleted(roomId) {
  await wipeLocalRoom(roomId, { silent: true });
  note('Этот чат удалён на сервере (создателем или после 30 дней неактивности) — локальная копия стёрта.');
}

// Автономная отправка системного сообщения в НЕоткрытую комнату (для
// 'leave' и 'room-delete' из списка комнат): ключи выводятся из seedEnc
// записи, подпись — текущим устройством. Шифрование базовым ключом эпохи 0:
// получатели пробуют его при расшифровке всегда (decryptAny).
async function postSystemStandalone(rec, type, text, { quiet = false } = {}) {
  const seed = await decryptWithVault(rec.seedEnc);
  const seedBytes = b64u.dec(seed);
  let pinIkm = null;
  if (rec.pinEnc) {
    try {
      const pin = await decryptWithVault(rec.pinEnc);
      if (pin) pinIkm = await derivePinIkm(pin, seedBytes);
    } catch {}
  }
  const keys = await deriveChatKeys(seedBytes, { pinIkm });
  if (keys.roomId !== rec.roomId) throw new Error('ключи не совпали с комнатой');
  const device = await getChatDevice();
  const m = {
    v: 1,
    id: newMsgId(),
    ts: Date.now(),
    nick: rec.nick || 'Участник',
    devPub: device.devicePub,
    type,
    text,
    epoch: 0,
  };
  m.sig = await signChatText(canonical(m));
  const blob = await encryptChatMessage(keys.roomKey, m);
  const r = await api(rec.roomId, keys.accessToken, '/msg', {
    method: 'POST',
    body: { blob: b64u.enc(blob), dev: device.devicePub, ...(quiet ? { quiet: true } : {}) },
  });
  return r.status;
}

// «Удалить у себя»: остальным — подписанный 'leave' (если мы успели
// представиться в комнате), затем локальное стирание с tombstone.
async function deleteRoomSelf(rec) {
  if (!rec) return;
  const roomId = rec.roomId;
  try {
    if (cur && cur.rec.roomId === roomId) {
      if (cur.gcall) await leaveGcall().catch(() => {});
      if (rec.nick) await sendMsg('leave', rec.nick || '').catch(() => {});
    } else if (rec.nick && rec.introSent) {
      await postSystemStandalone(rec, 'leave', rec.nick || '').catch(() => {});
    }
  } catch {}
  // v30: своя встреча по кодовому слову при удалении чата гасится досрочно.
  if (rec.word) await wordRevokeCurrent(rec).catch(() => {});
  // v38: сервер больше не будит это устройство и не держит под него историю.
  await unsubscribeRoom(rec).catch(() => {});
  await wipeLocalRoom(roomId, { silent: true });
  note('Чат удалён на этом устройстве.');
}

// «Удалить для всех» (только создатель): подписанный 'room-delete'
// участникам + серверный wipe по подписи создателя + отзыв короткой
// ссылки + локальное стирание. Возвращает текст исхода для UI.
async function deleteRoomForAll(rec) {
  if (!rec) return 'Комната не найдена.';
  const roomId = rec.roomId;
  const device = await getChatDevice();
  const isCreator =
    rec.creatorPub === device.devicePub || (!rec.creatorPub && rec.createdByMe);
  if (!isCreator) return 'Удалить для всех может только создатель чата.';
  // 1) Короткая ссылка: отозвать, пока есть admin из записи комнаты.
  if (rec.alias?.code) {
    try {
      const admin = await decryptWithVault(rec.alias.adminEnc);
      const codeHash = await codeAddrForScheme('alias', rec.alias.code, rec.alias.scheme);
      await pairApi('/pair/revoke', { codeHash, admin });
    } catch {}
  }
  // 1b) v30: встреча по кодовому слову тоже гасится — чат удаляется для всех.
  if (rec.word) await wordRevokeCurrent(rec).catch(() => {});
  // 2) Подписанное управляющее сообщение участникам (онлайн получат по WS,
  //    офлайн — при докачке; кто не докачает, упрётся в серверный 410).
  try {
    if (cur && cur.rec.roomId === roomId) {
      await sendMsg('room-delete', JSON.stringify({ roomId }));
    } else {
      await postSystemStandalone(rec, 'room-delete', JSON.stringify({ roomId }));
    }
  } catch {}
  // 3) Серверный wipe: подпись создателя над 'zv-room-delete-v1:'+roomId.
  let serverNote = '';
  try {
    const sig = await signChatText('zv-room-delete-v1:' + roomId);
    const res = await fetch(workerBase() + '/room/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, creatorPub: device.devicePub, sig }),
    });
    if (res.status === 200) {
      serverNote = 'Серверная копия вычищена.';
    } else if (res.status === 403) {
      serverNote =
        'Сервер не подтвердил создателя (комната создана до v29 или room-meta не дошёл): серверная копия НЕ вычищена, но у участников чат удалён сообщением.';
    } else {
      serverNote = `Серверный wipe не подтвердился (статус ${res.status}): у участников чат удалён сообщением.`;
    }
  } catch {
    serverNote = 'Сервер недоступен: wipe не выполнен, у участников чат удалён сообщением.';
  }
  // 4) Локальное стирание.
  await wipeLocalRoom(roomId, { silent: true });
  return 'Чат удалён для всех. ' + serverNote;
}

// Настройка «Автоудаление неактивных чатов»: default ON (цифра владельца —
// 30 дней; срок в UI не редактируется, только вкл/выкл).
const autoDeleteOn = () => {
  try {
    return localStorage.getItem('zvAutoDeleteChats') !== '0';
  } catch {
    return true;
  }
};

const CHAT_INACTIVE_MS_LOCAL = 30 * 24 * 3600000;
// Локальный свип при старте: комнаты без сообщений дольше 30 дней
// удаляются молча (сервер сделает то же своим alarm-ом). Открытая комната
// и комнаты с keepForever не трогаются.
async function sweepInactiveRooms() {
  if (!autoDeleteOn()) return;
  try {
    const rooms = (await kvAll('rooms')).map((x) => x.value).filter(Boolean);
    if (!rooms.length) return;
    const now = Date.now();
    // v38: по одной комнате (раньше при каждом запуске в память читались
    // сообщения ВСЕХ комнат разом).
    for (const rec of rooms) {
      if (cur && cur.rec.roomId === rec.roomId) continue;
      if (rec.keepForever || now - (rec.createdAt || 0) <= CHAT_INACTIVE_MS_LOCAL) continue;
      const items = await roomMessages(rec.roomId).catch(() => null);
      if (!items) continue;
      if (shouldSweepRoom(rec, items, now)) {
        await wipeLocalRoom(rec.roomId, { silent: true });
      }
    }
  } catch {}
}

// ---------- Сообщения ----------
// v27: управляющие типы — применяются к состоянию комнаты/сообщений, в ленте
// пузырями не рендерятся (кроме 'ttl' — служебной строкой о смене таймера).
// v29: 'room-delete' (wipe у клиентов) и 'gcall-state' (агрегация живого
// звонка) — тоже управляющие; у gcall-state есть своя ветка рендера строк.
export const CONTROL_TYPES = new Set([
  'react',
  'edit',
  'del',
  'pin',
  'unpin',
  'ttl',
  'dial',
  'room-delete',
  'gcall-state',
  // v31: служебные сообщения храповика — не рендерятся и не нотифицируют;
  // dr-init обрабатывается в ingest, drx разворачивается при расшифровке.
  'dr-init',
  'drx',
]);

async function buildMsg(type, text) {
  const m = {
    v: 1,
    id: newMsgId(),
    ts: Date.now(),
    nick: cur.rec.nick || 'Гость',
    devPub: cur.device.devicePub,
    type,
    text,
    epoch: cur.rec.epoch || 0,
    // v31: объявление возможностей храповика (вне канонической строки
    // подписи, как epoch и replyTo): собеседники видят, что устройство
    // понимает цепочки (rk) и Double Ratchet (dr).
    caps: { rk: 1, dr: 1 },
  };
  m.sig = await signChatText(canonical(m));
  return m;
}

// v38: единая очередь криптоопераций открытой комнаты. Приём (ingest) и
// подготовка отправки (шифрование) меняют одно состояние храповика;
// раньше они шли параллельно (WS, несколько fetch, таймер heartbeat
// звонка, отправка пользователя) — одинаковые номера cn у двух сообщений,
// «перетёртый» корень Double Ratchet и заглушка «ключ недоступен» поверх
// уже расшифрованного сообщения. Теперь — строго по одному.
export function roomQueue(fn) {
  const c = cur;
  if (!c) return Promise.reject(new Error('no room'));
  const run = c.q.then(() => (cur === c && !c.closed ? fn() : undefined));
  c.q = run.catch(() => {});
  return run;
}

// Служебные типы без пуша получателям (сервер не будит телефоны ради
// реакций, heartbeat звонка, обмена ключами).
const QUIET_TYPES = new Set([
  ...CONTROL_TYPES,
  'intro',
  'ecdh',
  'room-meta',
  'epoch',
  'leave',
]);

// extra — дополнительные поля шифротекста (replyTo у текстовых сообщений).
// bodyExtra — поля тела /msg ВНЕ шифротекста (v29: creatorPub у room-meta —
// сервер слеп к содержимому и регистрирует создателя только по этому полю;
// v38: quiet — без пуша, push:'call' — пуш-звонок, ttlSec — серверный срок).
export function sendMsg(type, text, extra = null, bodyExtra = null) {
  const c = cur;
  if (!c) return Promise.reject(new Error('no room'));
  // Отправки упорядочены между собой (номера цепочек уходят на сервер по
  // возрастанию), но сетевой POST не держит очередь приёма.
  const job = c.sendQ.then(async () => {
    if (cur !== c || c.closed) throw new Error('no room');
    const prep = await roomQueue(() => prepareOutgoing(type, text, extra));
    if (!prep) throw new Error('no room');
    return deliverOutgoing(c, prep, bodyExtra);
  });
  c.sendQ = job.catch(() => {});
  return job;
}

async function prepareOutgoing(type, text, extra) {
  const m = await buildMsg(type, text);
  if (extra) Object.assign(m, extra);
  // v27: исчезающие сообщения — срок жизни дублируется внутри шифротекста
  // (для локального срока) и вне его (для серверной чистки по expires_at).
  const ttlSec =
    cur.rec.ttlSec > 0 && (type === 'text' || type === 'file' || type === 'voice')
      ? cur.rec.ttlSec
      : 0;
  if (ttlSec) m.ttlSec = ttlSec;
  // v31: выбор режима шифрования. Контент при живой DR-сессии — только
  // Double Ratchet; всё остальное — цепочка отправителя текущей эпохи;
  // единственное статичное исключение — intro нового устройства
  // (бутстрап: получатели ещё не знают его devPub и цепочку не выведут).
  let blob;
  const dr = drActive();
  if (dr && DR_CONTENT_TYPES.has(type)) {
    try {
      blob = await drEncryptContent(m);
    } catch {
      blob = await encryptOutgoing(m); // DR не вышло — цепочка уровня 1
    }
  } else if (type === 'intro' && !cur.rec.introSent) {
    blob = await encryptChatMessage(cur.keys.roomKey, m);
  } else {
    blob = await encryptOutgoing(m);
  }
  // v38: состояние цепочки фиксируется в IDB ДО ухода blob в сеть —
  // закрытие вкладки сразу после отправки не приведёт к повтору номера.
  await saveRoom(cur.rec);
  const hash = await hashChatBlob(blob);
  return { m, blob, hash, ttlSec, type };
}

async function deliverOutgoing(c, { m, blob, hash, ttlSec, type }, bodyExtra) {
  // v28 (D): резервный канал — тот же blob уходит в MQTT/Nostr, локально
  // помечается pendingWorkerSync и хранит blob для точного ресинка.
  if (c.transportMode === 'fallback' && c.fb) {
    await c.fb.send(b64u.enc(blob));
    const entry = {
      hash,
      msg: m,
      sigOk: true,
      mine: true,
      reactions: {},
      pendingWorkerSync: true,
      blobB64: b64u.enc(blob),
    };
    if (ttlSec) entry.expiresAt = m.ts + ttlSec * 1000;
    await storeMessage(c.rec, entry);
    if (cur === c && CONTROL_TYPES.has(type)) await applyControlMessage(m, true).catch(() => {});
    if (cur === c) renderMessages().catch(() => {});
    return m;
  }
  const quiet = QUIET_TYPES.has(type) && !(bodyExtra && bodyExtra.push);
  const r = await api(c.keys.roomId, c.keys.accessToken, '/msg', {
    method: 'POST',
    body: {
      blob: b64u.enc(blob),
      dev: c.device.devicePub,
      ...(ttlSec ? { ttlSec } : {}),
      ...(quiet ? { quiet: true } : {}),
      ...(bodyExtra || {}),
    },
  });
  // v29: серверная копия комнаты удалена (создателем или по неактивности) —
  // стираем комнату и локально, а не показываем абстрактную «ошибку сервера».
  if (r.status === 410) {
    await handleRemoteDeleted(c.rec.roomId);
    throw new Error('Этот чат удалён на сервере');
  }
  if (r.status === 429) throw new Error('Слишком часто: лимит 60 сообщений в минуту на комнату');
  if (r.status !== 200 && r.status !== 201) throw new Error('Сервер: ' + r.status);
  const entry = { hash, seq: r.data.seq, msg: m, sigOk: true, mine: true, reactions: {} };
  if (ttlSec) entry.expiresAt = m.ts + ttlSec * 1000;
  if (type === 'gcall-state') entry.hb = /"op":"hb"/.test(m.text || '');
  await storeMessage(c.rec, entry);
  if (cur === c && CONTROL_TYPES.has(type)) await applyControlMessage(m, true).catch(() => {});
  if (r.data.seq > c.rec.lastSeq) {
    // v38: lastSeq — «всё до него обработано». Свой seq мог перепрыгнуть
    // чужие сообщения, ещё не дошедшие по WS (обрыв сети, медленный
    // сокет): раньше они после этого не докачивались НИКОГДА. Двигаем
    // только без дыры, иначе дыру закроет ближайший fetch.
    if (r.data.seq === (c.rec.lastSeq || 0) + 1) c.rec.lastSeq = r.data.seq;
    else scheduleFetchMissed();
    c.rec.lastReadSeq = Math.max(c.rec.lastReadSeq || 0, r.data.seq);
    await saveRoom(c.rec);
  }
  if (cur === c) renderMessages().catch(() => {});
  return m;
}

// Применение управляющего сообщения к локальному состоянию. Вызывается и
// при ingest (с фактическим sigOk), и при собственной отправке (sigOk=true).
// Чужая подпись (sigOk=false) и чужие edit/del игнорируются внутри чистых
// функций crypto.js; здесь — только I/O и перерисовка.
export async function applyControlMessage(msg, sigOk) {
  if (!cur || !msg || !CONTROL_TYPES.has(msg.type)) return;
  const roomId = cur.rec.roomId;
  const loadTarget = async () => {
    let target = null;
    try {
      target = JSON.parse(msg.text || '')?.target;
    } catch {}
    if (typeof target !== 'string' || !target) return null;
    const entry = await kvGet('messages', roomId + ':' + target);
    return entry ? { target, entry } : null;
  };
  try {
    if (msg.type === 'react') {
      if (!sigOk) return;
      const got = await loadTarget();
      if (!got) return;
      let data = null;
      try {
        data = JSON.parse(msg.text || '');
      } catch {}
      if (!data) return;
      got.entry.reactions = applyReactionState(got.entry.reactions, msg.devPub, data.emoji, data.op);
      touchRoomMsgs(roomId);
      await kvPut('messages', roomId + ':' + got.target, got.entry);
      touchRoomMsgs(roomId);
      renderMessages().catch(() => {});
      return;
    }
    if (msg.type === 'edit' || msg.type === 'del') {
      const got = await loadTarget();
      if (!got) return;
      // Метаданные файла нужны до применения del (текст зачищается).
      let fileId = null;
      if (msg.type === 'del' && (got.entry.msg.type === 'file' || got.entry.msg.type === 'voice')) {
        try {
          fileId = JSON.parse(got.entry.msg.text || '')?.fileId || null;
        } catch {}
      }
      if (applyEditOrDelete(got.entry, msg, sigOk)) {
        touchRoomMsgs(roomId);
        await kvPut('messages', roomId + ':' + got.target, got.entry);
        touchRoomMsgs(roomId);
        if (fileId) {
          // Удаление «для всех»: локально забываем скачанные чанки файла.
          const st = fileState.get(fileId);
          if (st?.url) URL.revokeObjectURL(st.url);
          fileState.delete(fileId);
          const a = voiceAudio.get(fileId);
          if (a) {
            try {
              a.pause();
            } catch {}
            voiceAudio.delete(fileId);
          }
        }
        renderMessages().catch(() => {});
      }
      return;
    }
    if (msg.type === 'pin' || msg.type === 'unpin') {
      const next = applyPinState(cur.rec.pinned, msg, sigOk);
      if (next !== undefined) {
        cur.rec.pinned = next;
        await saveRoom(cur.rec);
        renderMessages().catch(() => {});
      }
      return;
    }
    if (msg.type === 'ttl') {
      if (!sigOk) return;
      let ttl = null;
      try {
        ttl = Number(JSON.parse(msg.text || '')?.ttl);
      } catch {}
      if (Number.isFinite(ttl) && ttl >= 0 && ttl !== cur.rec.ttlSec) {
        cur.rec.ttlSec = ttl;
        await saveRoom(cur.rec);
        renderTtlState();
        renderMessages().catch(() => {});
      }
      return;
    }
    // v29: удаление комнаты создателем. Авторизация: подпись валидна и
    // подписант — создатель из room-meta. Для комнат без room-meta
    // (созданы до v29) принимаем room-delete от известного участника с
    // intro — слабее, но это единственная доступная проверка; градация
    // честно записана в AUDIT-v29.
    if (msg.type === 'room-delete') {
      if (!sigOk) return;
      let target = null;
      try {
        target = JSON.parse(msg.text || '')?.roomId;
      } catch {}
      if (target !== roomId) return;
      const authorized = cur.rec.creatorPub
        ? msg.devPub === cur.rec.creatorPub
        : !!cur.rec.members[msg.devPub]?.nick;
      if (!authorized) return;
      await wipeLocalRoom(roomId, { byCreator: true });
      return;
    }
    // v29: событие живого группового звонка — состояние выводится из ленты
    // чистой агрегацией; здесь только перерендер плашки.
    if (msg.type === 'gcall-state') {
      if (!sigOk) return;
      updateGcallBanner().catch(() => {});
      return;
    }
  } catch {}
}

// v29: создатель комнаты публикует подписанный 'room-meta' ПЕРВЫМ
// сообщением комнаты (до intro): остальные клиенты закрепляют creatorPub
// по валидной подписи, а сервер по полю creatorPub в теле этого же /msg
// регистрирует создателя для серверного wipe (POST /room/delete).
async function sendRoomMetaIfNeeded() {
  if (!cur || !cur.rec.createdByMe || cur.rec.metaSent || !cur.rec.nick) return;
  const dev = cur.device.devicePub;
  await sendMsg('room-meta', JSON.stringify({ creator: dev }), null, { creatorPub: dev });
  cur.rec.metaSent = true;
  cur.rec.creatorPub = dev;
  await saveRoom(cur.rec);
}

async function sendIntroIfNeeded() {
  if (!cur || cur.rec.introSent || !cur.rec.nick) return;
  await sendMsg('intro', cur.rec.nick);
  cur.rec.introSent = true;
  await saveRoom(cur.rec);
}

// v26, фаза 3: публикация ECDH-публичного ключа устройства в комнату — без
// него участник не может получить завёртку секрета новой эпохи. Шлётся один
// раз на комнату (флаг ecdhSent), получатели закрепляют ключ в members.
async function sendEcdhIfNeeded() {
  if (!cur || cur.rec.ecdhSent || !cur.rec.nick) return;
  const d = await getChatDeviceEcdh();
  await sendMsg('ecdh', d.ecdhPub);
  cur.rec.ecdhSent = true;
  await saveRoom(cur.rec);
}

// v28 (A): публикация данных личной идентичности для дозвона из чата.
// Отдельное управляющее сообщение 'dial' (в ленте не рендерится): masterPub
// и отпечаток публичны, cert/chain доказывают принадлежность устройства
// master-ключу. Секрет личной ссылки сюда НЕ входит: адрес дозвонa
// выводится из masterPub, а payload запечатывается ECDH-ключом устройства.
export async function sendDialInfoIfNeeded() {
  if (!cur || cur.rec.dialInfoSent || !cur.rec.nick) return;
  const dev = cur.device;
  if (!dev?.masterPub) {
    cur.rec.dialInfoSent = true; // гостевое устройство: публиковать нечего
    await saveRoom(cur.rec);
    return;
  }
  await sendMsg(
    'dial',
    JSON.stringify({
      masterPub: dev.masterPub,
      masterFp: dev.masterFp || null,
      cert: dev.cert || null,
      chain: dev.chain || null,
    })
  );
  cur.rec.dialInfoSent = true;
  await saveRoom(cur.rec);
}

// ---------- Эпохи (v26, фаза 3) ----------
// Сообщение 'epoch' зашифровано ключом УХОДЯЩЕЙ эпохи (его читают все
// текущие участники), внутри — завёртки нового секрета только оставленным.
export async function applyEpochMessage(msg) {
  if (!cur || !msg) return;
  let data = null;
  try {
    data = JSON.parse(msg.text || '');
  } catch {}
  if (!data || !Number.isInteger(data.n) || data.n <= 0) return;
  const n = data.n;
  if ((cur.rec.epochs || []).some((e) => e.n === n)) return; // уже применена
  const wrap = data.wraps?.[cur.device.devicePub];
  if (!wrap) {
    if (n > (cur.rec.epoch || 0)) {
      cur.epochMissing = true;
      note(
        'Собеседник сменил эпоху и не включил вас в список участников: старая переписка остаётся доступной, новые сообщения вы читать не сможете.'
      );
    }
    return;
  }
  const d = await getChatDeviceEcdh();
  const secret = await unwrapEpochSecret(d.ecdhPriv, wrap, cur.rec.roomId, n);
  if (!secret) return;
  cur.rec.epochs.push({ n, secret: b64u.enc(secret), ts: Date.now() });
  if (n > (cur.rec.epoch || 0)) {
    cur.rec.epoch = n;
    const k = await keyForEpoch(n);
    if (k) cur.keys = { ...cur.keys, roomKey: k };
  }
  // v31: цепочки старых эпох обрываются (см. pruneOldEpochChains).
  pruneOldEpochChains(n);
  cur.epochMissing = false;
  await saveRoom(cur.rec);
  renderMessages().catch(() => {});
}

export function memberEcdhPub(dev) {
  if (!cur) return null;
  if (dev === cur.device.devicePub) return cur.ownEcdhPub || null;
  return cur.rec.members?.[dev]?.ecdhPub || null;
}

// Диалог ротации: список участников с чекбоксами. Участник без ecdhPub
// (старый клиент v25 или ни разу не заходил с v26) ключ эпохи получить НЕ
// может — его чекбокс заблокирован с честной пометкой, а не с обещанием
// «догоняющей» выдачи, которой в протоколе нет.
async function openEpochDialog() {
  if (!cur) return;
  if (!cur.rec.nick) return note('Сначала введите никнейм.');
  const d = await getChatDeviceEcdh();
  cur.ownEcdhPub = d.ecdhPub;
  await sendEcdhIfNeeded();
  const box = $('#epochMembers');
  const dlg = $('#chatEpochBox');
  if (!box || !dlg) return;
  box.replaceChildren();
  for (const dev of knownMembers()) {
    const isMe = dev === cur.device.devicePub;
    const pub = memberEcdhPub(dev);
    const row = document.createElement('label');
    row.className = 'chat-epoch-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.dev = dev;
    cb.checked = isMe || !!pub;
    cb.disabled = isMe || !pub;
    const nm = document.createElement('span');
    nm.className = 'chat-member-name';
    nm.textContent = nickOf(dev) + (isMe ? ' (вы)' : '');
    const fp = document.createElement('span');
    fp.className = 'chat-member-seen';
    fp.textContent = dev.slice(0, 10) + '…';
    row.append(cb, nm, fp);
    if (!pub && !isMe) {
      const warn = document.createElement('span');
      warn.className = 'chat-epoch-warn';
      warn.textContent =
        'нет ключа обмена (не заходил с v26) — при смене эпохи не сможет читать новые сообщения';
      row.append(warn);
    }
    box.append(row);
  }
  dlg.classList.remove('hidden');
}

async function doEpochRotate() {
  if (!cur) return;
  const box = $('#epochMembers');
  if (!box) return;
  const kept = [...box.querySelectorAll('input[type=checkbox][data-dev]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.dev);
  const me = cur.device.devicePub;
  if (!kept.includes(me)) kept.push(me);
  try {
    const d = await getChatDeviceEcdh();
    cur.ownEcdhPub = d.ecdhPub;
    const n = (cur.rec.epoch || 0) + 1;
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const wraps = {};
    for (const dev of kept) {
      const pub = dev === me ? d.ecdhPub : cur.rec.members?.[dev]?.ecdhPub;
      if (!pub) continue; // без ключа обмена завёртку не сделать
      wraps[dev] = await wrapEpochSecret(d.ecdhPriv, b64u.dec(pub), secret, cur.rec.roomId, n);
    }
    if (!wraps[me]) throw new Error('не удалось завернуть секрет эпохи для себя');
    // Сообщение эпохи уходит зашифрованным ключом уходящей эпохи.
    await sendMsg('epoch', JSON.stringify({ n, wraps }));
    cur.rec.epochs.push({ n, secret: b64u.enc(secret), ts: Date.now() });
    cur.rec.epoch = n;
    // v31: цепочки уходящей эпохи обрываются и у инициатора ротации.
    pruneOldEpochChains(n);
    await saveRoom(cur.rec);
    const k = await keyForEpoch(n);
    if (k) cur.keys = { ...cur.keys, roomKey: k };
    $('#chatEpochBox')?.classList.add('hidden');
    note(
      `Эпоха сменена: теперь эпоха ${n}. Новые сообщения читают только оставленные участники (${Object.keys(wraps).length}); старая история у исключённых на устройствах остаётся.`
    );
    renderMessages().catch(() => {});
  } catch (e) {
    note('Не удалось сменить эпоху: ' + e.message);
  }
}

// Доставка и прочтение, пакетные ack, очередь повтора нерасшифрованных — chat-delivery.js (v44)

// Транспортный менеджер, резервный канал и WebSocket — chat-net.js (v44)
initChatNet();

// Файлы и голосовые сообщения — chat-files.js (v44)

// Код приветствия, постоянная короткая ссылка и кодовое слово — chat-invite.js (v44)

// ---------- Присутствие и шапка ----------
export function knownMembers() {
  if (!cur) return [];
  const devs = new Set([
    cur.device.devicePub,
    ...Object.keys(cur.rec.members || {}),
    ...cur.receipts.keys(),
    ...cur.online,
    // v28 (E): устройства из реестра увиденных — видны, даже если молчат.
    ...Object.keys(cur.rec.seenDevices || {}),
  ]);
  // v29: вышедшие из чата (leave) участниками не считаются — до их
  // следующего intro. Себя из списка не выкидываем никогда.
  return [...devs].filter(
    (d) => d === cur.device.devicePub || !cur.rec.members?.[d]?.left
  );
}

// v39: участники по людям: Map(personKey → {key, devs, nick}).
export function knownPersons() {
  const obj = {};
  for (const d of knownMembers()) obj[d] = cur.rec.members?.[d] || {};
  return groupPersons(obj, ownSetOf(), myProfile()?.master || '');
}
export function personReceipts(persons) {
  const others = [];
  const map = new Map();
  for (const [k, g] of persons) {
    if (k === 'self') continue;
    others.push(k);
    let delivered = 0;
    let read = 0;
    for (const d of g.devs) {
      const r = cur.receipts.get(d);
      if (!r) continue;
      delivered = Math.max(delivered, r.delivered || 0);
      read = Math.max(read, r.read || 0);
    }
    map.set(k, { delivered, read });
  }
  return { others, map };
}
const personOnline = (g) => g.devs.some((d) => cur.online.has(d));
const personLastSeen = (g) => Math.max(0, ...g.devs.map((d) => cur.rec.members?.[d]?.lastSeen || 0));

// Как в Telegram: в личном чате — «в сети» / «был(а) в 14:05»,
// в группе — «3 участника · 2 в сети».
function presenceText(total, others, onlineCount) {
  if (others.length === 1) {
    const [g] = others;
    if (personOnline(g)) return 'в сети';
    const ls = personLastSeen(g);
    return ls ? 'был(а) ' + fmtSeen(ls) : 'не в сети';
  }
  const count = `${total} ${plural(total, 'участник', 'участника', 'участников')}`;
  return onlineCount ? `${count} · ${onlineCount} в сети` : count;
}

export function renderPresence() {
  const line = $('#chatPresence');
  if (!line || !cur) return;
  const titleEl = $('#chatRoomTitle');
  if (titleEl) {
    const dt = roomTitleOf(cur.rec.roomId, cur.rec);
    titleEl.textContent = dt;
    const roomAv = $('#chatRoomAvatar');
    if (roomAv) {
      roomAv.style.background = roomAvatarBg(cur.rec);
      roomAv.textContent = (dt.replace(/^Чат\s+/i, '').trim()[0] || '💬').toUpperCase();
    }
  }
  const persons = knownPersons();
  const others = [...persons.values()].filter((g) => g.key !== 'self');
  const onlineCount = others.filter(personOnline).length;
  const typing =
    cur.typing &&
    cur.typing.until > Date.now() &&
    cur.typing.dev !== cur.device.devicePub &&
    !ownDev(cur.typing.dev);
  if (typing) line.textContent = others.length === 1 ? 'печатает…' : `${nickOf(cur.typing.dev)} печатает…`;
  else line.textContent = presenceText(Math.max(1, persons.size), others, onlineCount);
  // Акцентный цвет — как у Telegram для «в сети» и «печатает…».
  line.toggleAttribute('data-live', typing || (others.length === 1 && onlineCount === 1));
  // v28 (A): групповой звонок имеет смысл при двух и более собеседниках.
  $('#chatGroupCallBtn')?.classList.toggle('hidden', others.length < 2);
}

export function renderMembersList() {
  const box = $('#chatMembersList');
  if (!box || !cur || box.classList.contains('hidden')) return;
  box.replaceChildren();
  // v26, фаза 2: контрольная фраза комнаты — для устной сверки с собеседником.
  if (cur.keys0?.phrase) {
    const ph = document.createElement('div');
    ph.className = 'chat-phrase';
    ph.textContent =
      `Контрольная фраза: ${cur.keys0.phrase}` +
      (cur.rec.pinProtected ? ' · комната защищена PIN' : '') +
      ` · эпоха ${cur.rec.epoch || 0}`;
    box.append(ph);
  }
  // v39: строка на человека; несколько устройств — пометка «N устройства».
  const persons = [...knownPersons().values()].sort((a, b) => (a.key === 'self' ? -1 : b.key === 'self' ? 1 : 0));
  for (const g of persons) {
    const isMe = g.key === 'self';
    const dev = isMe ? cur.device.devicePub : g.devs.find((d) => cur.online.has(d)) || g.devs[0];
    const row = document.createElement('div');
    row.className = 'chat-member-row';
    const av = document.createElement('span');
    av.className = 'chat-avatar';
    av.style.background = avatarBg(dev);
    av.textContent = (nickOf(dev)[0] || '?').toUpperCase();
    const dot = document.createElement('span');
    const isOnline = isMe || personOnline(g);
    dot.className = 'chat-dot' + (isOnline ? ' on' : '');
    av.append(dot);
    const name = document.createElement('span');
    name.className = 'chat-member-name';
    // v28 (E): устройство без intro видно честной строкой, а не «Участник».
    const nickDev = g.devs.find((d) => cur.rec.members?.[d]?.nick);
    const hasIntro = !!nickDev;
    name.textContent = isMe
      ? nickOf(cur.device.devicePub)
      : hasIntro
        ? nickOf(nickDev)
        : `Без ника · устройство …${dev.slice(-6)}`;
    const seen = document.createElement('span');
    seen.className = 'chat-member-seen';
    const nDev = g.devs.length;
    const devTail = nDev > 1 ? ` · ${nDev} ${plural(nDev, 'устройство', 'устройства', 'устройств')}` : '';
    if (isMe) seen.textContent = 'это вы' + devTail;
    else if (personOnline(g)) seen.textContent = 'в сети' + devTail;
    else {
      const ls = personLastSeen(g);
      seen.textContent = (ls ? 'был(а) ' + fmtSeen(ls) : 'не в сети') + devTail;
    }
    row.append(av, name, seen);
    // v28 (A): кнопка дозвона участнику с личной идентичностью.
    const dialDev = isMe ? null : g.devs.find((d) => cur.rec.members?.[d]?.masterPub);
    if (dialDev) {
      const cb = document.createElement('button');
      cb.className = 'btn small ghost chat-member-call';
      cb.textContent = '📞';
      cb.title = 'Позвонить участнику (его телефон зазвонит)';
      cb.setAttribute('aria-label', 'Позвонить участнику');
      cb.onclick = (e) => {
        e.stopPropagation();
        dialMember(dialDev)
          .then((r) => {
            if (!r.dialed) note('Не удалось дозвониться участнику — отправлено приглашение в чат.');
            else openCallFromChat(r.secret, { autoJoin: true }); // v38: сразу ждём в звонке
          })
          .catch(() => {});
      };
      row.append(cb);
    }
    box.append(row);
  }
}

// Статус прочтения своего сообщения: по сводкам receipts остальных.
function receiptLabel(it) {
  if (!cur || !it.seq) return '';
  const others = knownMembers().filter((d) => d !== cur.device.devicePub);
  if (!others.length) return 'Отправлено';
  const delivered = others.some((d) => (cur.receipts.get(d)?.delivered || 0) >= it.seq);
  const readAll = others.every((d) => (cur.receipts.get(d)?.read || 0) >= it.seq);
  if (readAll) return 'Прочитано';
  if (delivered) return 'Доставлено';
  return 'Отправлено';
}

// ---------- v27: цитаты, закреп, поиск, сроки жизни ----------
export function excerptOf(it) {
  const m = it?.msg || {};
  if (m.deleted) return 'Сообщение удалено';
  if (m.type === 'voice') return 'Голосовое сообщение';
  if (m.type === 'file') {
    try {
      return 'Файл: ' + (JSON.parse(m.text || '{}').name || 'без имени');
    } catch {
      return 'Файл';
    }
  }
  return String(m.text || '').slice(0, 120);
}

const TTL_OPTIONS = [
  { sec: 0, label: 'Выключено' },
  { sec: 3600, label: '1 час' },
  { sec: 24 * 3600, label: '24 часа' },
  { sec: 7 * 24 * 3600, label: '7 дней' },
];
export const ttlLabel = (sec) => TTL_OPTIONS.find((o) => o.sec === sec)?.label || `${sec} с`;

// Локальная чистка истёкших исчезающих сообщений (сервер чистит по своему
// expires_at независимо; здесь — чтобы не висели в ленте офлайн).
async function pruneExpired() {
  if (!cur) return;
  const items = await roomMessages(cur.rec.roomId);
  const now = Date.now();
  let removed = false;
  for (const it of items) {
    if (it.expiresAt && it.expiresAt <= now) {
      await delMsg(cur.rec.roomId, it.hash);
      removed = true;
    }
  }
  if (removed && cur) renderMessages().catch(() => {});
}

export function scrollToMessage(hash, flash = true) {
  const box = $('#chatMessages');
  if (!box || !hash) return;
  const el = box.querySelector(`[data-hash="${hash}"]`);
  if (!el) {
    // v38: сообщение за пределами окна ленты — расширяем окно и повторяем.
    if (!cur || cur.expandingTo === hash) return;
    const idx = (cur.lastItemHashes || []).indexOf(hash);
    if (idx < 0) return;
    cur.expandingTo = hash;
    cur.renderLimit = Math.max(cur.renderLimit || RENDER_PAGE, cur.lastItemHashes.length - idx + 20);
    renderMessagesNow()
      .then(() => {
        if (cur) cur.expandingTo = null;
        const el2 = box.querySelector(`[data-hash="${hash}"]`);
        if (el2) scrollToMessage(hash, flash);
      })
      .catch(() => {});
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (flash) {
    el.classList.add('chat-flash');
    setTimeout(() => el.classList.remove('chat-flash'), 1300);
  }
}

export function renderPinBar(items) {
  const bar = $('#chatPinBar');
  if (!bar || !cur) return;
  const pin = cur.rec.pinned;
  if (!pin?.hash) {
    bar.classList.add('hidden');
    return;
  }
  const target = (items || []).find((it) => it.hash === pin.hash);
  const textEl = $('#chatPinText');
  if (textEl) {
    textEl.textContent = target
      ? `${target.msg.nick || 'Участник'}: ${excerptOf(target)}`
      : 'Закреплённое сообщение';
  }
  bar.classList.remove('hidden');
}

export function renderTextWithMarks(el, text, q) {
  const needle = (q || '').trim().toLowerCase();
  if (!needle) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let pos = 0;
  let idx = lower.indexOf(needle);
  if (idx < 0) {
    el.textContent = text;
    return;
  }
  while (idx >= 0) {
    if (idx > pos) el.append(document.createTextNode(text.slice(pos, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + needle.length);
    el.append(mark);
    pos = idx + needle.length;
    idx = lower.indexOf(needle, pos);
  }
  if (pos < text.length) el.append(document.createTextNode(text.slice(pos)));
}

// Реакция из UI: toggle по текущему локальному состоянию.
export async function toggleReaction(it, emoji) {
  if (!cur) return;
  const op = nextReactionOp(it.reactions, cur.device.devicePub, emoji);
  if (!op) return;
  try {
    await sendMsg('react', JSON.stringify({ target: it.hash, emoji, op }));
  } catch (e) {
    note(e.message);
  }
}

// ---------- v27: меню действий сообщения ----------
function hideMsgMenu() {
  $('#chatMsgMenu')?.classList.add('hidden');
  if (cur) cur.menuTarget = null;
}

export function openMsgMenu(it, anchor) {
  const menu = $('#chatMsgMenu');
  if (!menu || !cur) return;
  if (cur.menuTarget?.hash === it.hash && !menu.classList.contains('hidden')) {
    hideMsgMenu();
    return;
  }
  cur.menuTarget = it;
  const editBtn = $('#msgActEdit');
  const delBtn = $('#msgActDel');
  if (editBtn) editBtn.classList.toggle('hidden', !(it.mine && it.msg.type === 'text'));
  if (delBtn) delBtn.classList.toggle('hidden', !it.mine);
  $('#msgActCopy')?.classList.toggle('hidden', it.msg.type !== 'text' || !!it.msg.deleted);
  menu.classList.remove('hidden');
  placeMenu(menu, anchor);
}

export function renderReplyBar() {
  const bar = $('#chatReplyBar');
  if (!bar || !cur) return;
  if (!cur.replyTo) {
    bar.classList.add('hidden');
    return;
  }
  const t = $('#chatReplyText');
  if (t) {
    const who = document.createElement('b');
    who.textContent = cur.replyTo.name;
    const what = document.createElement('span');
    what.textContent = cur.replyTo.excerpt;
    t.replaceChildren(who, what);
  }
  bar.classList.remove('hidden');
}

export function renderEditBar() {
  const bar = $('#chatEditBar');
  if (!bar || !cur) return;
  bar.classList.toggle('hidden', !cur.editing);
}

function renderTtlState() {
  const sel = $('#chatTtlSelect');
  if (sel && cur) sel.value = String(cur.rec.ttlSec || 0);
  const curEl = $('#chatTtlCurrent');
  if (curEl && cur) {
    curEl.textContent =
      cur.rec.ttlSec > 0
        ? `Сейчас: сообщения исчезают через ${ttlLabel(cur.rec.ttlSec)} после отправки.`
        : 'Сейчас: сообщения не исчезают.';
  }
}

// Отрисовка сообщений и списка — chat-render.js (v44)

// Живой групповой звонок в чате и дозвон из чата через Inbox — chat-call.js (v44)

// ---------- Проводка UI ----------
export function initChatUI() {
  // v30: меню списка комнат (···) должно открываться и из десктопного
  // сайдбара экрана чата, где #home скрыт. Меню — position:fixed,
  // поэтому переносим узел в body: от родителя оно не зависит.
  const listMenu = $('#chatListMenu');
  if (listMenu && listMenu.parentElement !== document.body) {
    document.body.append(listMenu);
  }
  // v30: поиск по уже загруженным комнатам в сайдбаре (фильтр по DOM).
  const sideSearch = $('#chatSidebarSearch');
  if (sideSearch) {
    sideSearch.oninput = () => {
      sidebarQuery = sideSearch.value || '';
      applySidebarFilter();
    };
  }
  const homeSearch = $('#homeChatSearch');
  if (homeSearch) {
    homeSearch.oninput = () => {
      homeChatQuery = homeSearch.value || '';
      applySidebarFilter();
    };
  }
  const sideNewChat = $('#chatSidebarNewBtn');
  if (sideNewChat) {
    sideNewChat.onclick = () => $('#btnCreateChat')?.click();
  }
  const sideHomeBtn = $('#chatSidebarHomeBtn');
  if (sideHomeBtn) {
    sideHomeBtn.onclick = () => $('#chatBack')?.click();
  }
  // Home segmented tabs (Чаты / Звонки / Личный номер)
  document.querySelectorAll('[data-home-tab]').forEach((tabBtn) => {
    tabBtn.onclick = () => {
      const target = tabBtn.dataset.homeTab;
      document.querySelectorAll('[data-home-tab]').forEach((b) => {
        b.classList.toggle('active', b.dataset.homeTab === target);
        b.setAttribute('aria-selected', String(b.dataset.homeTab === target));
      });
      document.querySelectorAll('[data-home-pane]').forEach((pane) => {
        pane.classList.toggle('tab-active', pane.dataset.homePane === target);
      });
      try { localStorage.setItem('zvHomeTab', target); } catch {}
    };
  });
  try {
    const savedTab = localStorage.getItem('zvHomeTab');
    if (savedTab) {
      const btn = document.querySelector(`[data-home-tab="${savedTab}"]`);
      if (btn) btn.click();
    }
  } catch {}
  // Toggle collapsible create/join drawer in home chat pane
  const toggleJoinDrawer = $('#btnToggleJoinChat');
  if (toggleJoinDrawer) {
    toggleJoinDrawer.onclick = () => {
      $('#homeChatJoinDrawer')?.classList.toggle('hidden');
      $('#chatLinkInput')?.focus();
    };
  }
  const toggleChatSettings = $('#btnToggleChatPrefs');
  if (toggleChatSettings) {
    toggleChatSettings.onclick = () => {
      $('#homeChatPrefsDrawer')?.classList.toggle('hidden');
    };
  }
  // Close room panels on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMsgMenu();
      hideRoomListMenu();
      ['#chatRoomMenuBox', '#chatTtlBox', '#chatAliasBox', '#chatWordBox', '#chatEpochBox', '#chatGreetBox', '#chatMembersList'].forEach((sel) => $(sel)?.classList.add('hidden'));
    }
  });
  // v30: блок «Доступ по кодовому слову» в меню комнаты.
  const roomActWord = $('#roomActWord');
  if (roomActWord) {
    roomActWord.onclick = () => {
      $('#chatRoomMenuBox')?.classList.add('hidden');
      const box = $('#chatWordBox');
      if (!box) return;
      if (box.classList.contains('hidden')) renderWordBox().catch(() => {});
      else box.classList.add('hidden');
    };
  }
  const wordEnableBtn = $('#wordEnable');
  if (wordEnableBtn) wordEnableBtn.onclick = () => wordEnable().catch(() => {});
  const wordDisableBtn = $('#wordDisable');
  if (wordDisableBtn) wordDisableBtn.onclick = () => wordDisable().catch(() => {});
  const wordCloseBtn = $('#wordClose');
  if (wordCloseBtn) wordCloseBtn.onclick = () => $('#chatWordBox')?.classList.add('hidden');
  const wordInput = $('#wordPhraseInput');
  if (wordInput) {
    wordInput.oninput = () => renderWordHint(wordParts(wordInput.value).words.length);
  }
  const create = $('#btnCreateChat');
  if (create) {
    create.onclick = async () => {
      try {
        // v26, фаза 2: опция «Защитить PIN» при создании комнаты.
        let pin = null;
        if ($('#chatPinProtect')?.checked) {
          pin = ($('#chatPinInput')?.value || '').trim();
          if (pin.length < 4) {
            return note(
              'PIN слишком короткий: минимум 4 символа, лучше слово или фраза круга — короткие цифры перебираются быстрее.'
            );
          }
          if (/^\d+$/.test(pin) && pin.length < 6) {
            note('Предупреждение: PIN только из цифр короче 6 знаков слаб; продолжаем, но лучше слово/фраза.');
          }
        }
        const seed = newSecret();
        await openRoomBySeed(seed, { ...(pin ? { pin } : {}), created: true });
        note(
          pin
            ? 'Чат создан и защищён PIN: ссылка без PIN бесполезна. Сообщите PIN собеседнику устно и сверьте контрольную фразу (список участников в шапке комнаты).'
            : 'Ссылка на чат — в адресной строке и по кнопке «Ссылка». Передайте её собеседнику вне этого чата.'
        );
      } catch (e) {
        // v22: openRoomBySeed ловит свои ошибки сама (note теперь виден на
        // главном экране); сюда долетают только сбои вне её — показываем
        // и в note, и баннером, чтобы не было молчания.
        const text = 'Не удалось создать чат: ' + (e?.message || e);
        note(text);
        window.__zvShowDiag?.(text + ' Пришлите этот текст разработчику.');
      }
    };
  }
  const openBtn = $('#btnOpenChat');
  if (openBtn) {
    openBtn.onclick = () => {
      const raw = ($('#chatLinkInput')?.value || '').trim();
      const j = raw.match(/join=([A-Za-z0-9_-]{9})/);
      if (j) return redeemJoin(j[1]);
      const g = raw.match(/greet=([A-Za-z0-9_-]{9})/);
      if (g) return redeemGreet(g[1]);
      const bare = raw.match(/^([A-Za-z0-9_-]{9})$/);
      if (bare) return redeemCode(bare[1]); // алиас → приветствие (порядок в redeemCode)
      const m = raw.match(/chat=([A-Za-z0-9_-]{43})/) || raw.match(/^([A-Za-z0-9_-]{43})$/);
      if (m) {
        return openRoomBySeed(m[1], { pinProtected: /[?&]p=1/.test(raw) || raw.includes('&p=1') });
      }
      // v30: кодовое слово/фраза. Порядок проб для неоднозначного ввода:
      // сначала все точные форматы (ссылки join/greet, голый код-9,
      // seed-43) — они однозначны и ничего не сжигают; фраза пробуется
      // ПОСЛЕДНЕЙ: её claim одноразовый, жечь встречу случайным вводом
      // нельзя. Признак фразы: есть пробелы или ввод длиннее кодов (>12).
      if (/\s/.test(raw) || raw.length > 12) return redeemWord(raw);
      return note('Вставьте ссылку на чат (#chat=…), сам ключ, код подключения из 9 символов или кодовую фразу (3+ слова).');
    };
  }
  const pinProtectCheck = $('#chatPinProtect');
  if (pinProtectCheck) {
    pinProtectCheck.onchange = () =>
      $('#chatPinInput')?.classList.toggle('hidden', !pinProtectCheck.checked);
  }
  const pinGo = $('#chatPinGo');
  if (pinGo) {
    pinGo.onclick = () => {
      const pin = ($('#chatPinEntry')?.value || '').trim();
      if (!pin) return note('Введите PIN.');
      if (!pendingPinSeed) return note('Сначала откройте ссылку на чат.');
      $('#chatPinBox')?.classList.add('hidden');
      const seed = pendingPinSeed;
      pendingPinSeed = null;
      openRoomBySeed(seed, { pin, pinProtected: true });
    };
  }
  const back = $('#chatBack');
  if (back) {
    back.onclick = () => {
      // v29: выход из комнаты завершает и участие в живом звонке.
      if (cur?.gcall) leaveGcall().catch(() => {});
      closeCurrent(true);
      history.replaceState(null, '', location.pathname);
      renderRoomList().catch(() => {});
    };
  }
  const nickDice = $('#chatNickDice');
  if (nickDice) {
    nickDice.onclick = () => {
      const el = $('#chatNickInput');
      if (!el) return;
      el.value = randomAnonName();
      el.focus();
    };
  }
  const nickSave = $('#chatNickSave');
  if (nickSave) {
    nickSave.onclick = async () => {
      if (!cur) return;
      const nick = ($('#chatNickInput')?.value || '').trim().slice(0, 40);
      if (!nick) return note('Никнейм не может быть пустым.');
      cur.rec.nick = nick;
      await saveRoom(cur.rec);
      $('#chatNickBox')?.classList.add('hidden');
      // v28 (E): ворота ника сняты — показываем ленту и ввод.
      $('#chatMessages')?.classList.remove('hidden');
      $('#chatroom .chat-input-bar')?.classList.remove('hidden');
      note('');
      await sendRoomMetaIfNeeded(); // v29: создатель — room-meta первым сообщением
      await sendIntroIfNeeded();
      await sendEcdhIfNeeded();
      await sendDialInfoIfNeeded();
      renderPresence();
      renderMessages().catch(() => {});
    };
  }
  const send = $('#chatSend');
  const doSend = async () => {
    const myInput = $('#chatInput');
    const text = (myInput?.value || '').trim();
    if (!text || !cur) return;
    if (!cur.rec.nick) return note('Сначала введите никнейм.');
    // v43: поле очищаем сразу, до отправки. Раньше оно очищалось после
    // await sendMsg (шифрование + сеть): то, что человек успел набрать за это
    // время, стиралось, а следующее Enter уходило в пустоту — так терялось
    // каждое второе сообщение при быстрой отправке подряд.
    const c = cur;
    const editing = c.editing;
    const replyTo = c.replyTo;
    c.editing = null;
    c.replyTo = null;
    renderEditBar();
    renderReplyBar();
    myInput.value = '';
    myInput.dispatchEvent(new Event('input')); // mic/send + черновик ниже
    c.rec.draft = '';
    saveRoom(c.rec).catch(() => {});
    try {
      // v27: режим редактирования — вместо нового сообщения уходит 'edit'.
      if (editing) await sendMsg('edit', JSON.stringify({ target: editing.hash, text }));
      else await sendMsg('text', text, replyTo ? { replyTo } : null);
    } catch (e) {
      note(e.message);
      // Не отправилось — возвращаем текст, если поле ещё пустое.
      if (cur === c && !myInput.value) {
        myInput.value = text;
        c.editing = editing;
        c.replyTo = replyTo;
        renderEditBar();
        renderReplyBar();
        myInput.dispatchEvent(new Event('input'));
      }
    }
  };
  if (send) send.onclick = doSend;
  const input = $('#chatInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSend();
    });
    // v25: «печатает…» — не чаще раза в 3 секунды, только по живому WS.
    input.addEventListener('input', () => {
      if (!cur || !input.value || cur.ws?.readyState !== 1) return;
      const now = Date.now();
      if (now - (cur.lastTypingSent || 0) < 3000) return;
      cur.lastTypingSent = now;
      try {
        cur.ws.send(JSON.stringify({ type: 'typing' }));
      } catch {}
    });
    // v27: черновик комнаты — недописанный текст переживает выход из
    // комнаты и перезагрузку (локально, в записи комнаты; дебаунс 300 мс).
    input.addEventListener('input', () => {
      if (!cur) return;
      if (cur.draftTimer) clearTimeout(cur.draftTimer);
      cur.draftTimer = setTimeout(() => {
        if (!cur) return;
        cur.rec.draft = input.value;
        saveRoom(cur.rec).catch(() => {});
      }, 300);
    });
  }
  const attach = $('#chatAttach');
  const fileInput = $('#chatFileInput');
  if (attach && fileInput) {
    attach.onclick = () => fileInput.click();
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (f) uploadFile(f).catch(() => {});
    });
  }
  const copyBtn = $('#chatCopyLink');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      if (!cur) return;
      const seed = await decryptWithVault(cur.rec.seedEnc);
      const link = chatLinkOf(seed, cur.rec.pinProtected);
      try {
        await navigator.clipboard.writeText(link);
        note(
          cur.rec.pinProtected
            ? 'Ссылка скопирована. PIN в ней нет — сообщите его собеседнику устно, иначе ссылка бесполезна.'
            : 'Ссылка на чат скопирована.'
        );
      } catch {
        note(link);
      }
    };
  }
  const aliasBtn = $('#chatAliasBtn');
  if (aliasBtn) {
    aliasBtn.onclick = () => {
      const box = $('#chatAliasBox');
      if (!box) return;
      const willShow = box.classList.contains('hidden');
      closeRoomPopovers('chatAliasBox');
      if (willShow) renderAliasBox().catch(() => {});
      else box.classList.add('hidden');
    };
  }
  const aliasCopy = $('#aliasCopy');
  if (aliasCopy) {
    aliasCopy.onclick = async () => {
      const v = $('#aliasLink')?.value || '';
      if (!v) return;
      try {
        await navigator.clipboard.writeText(v);
        note('Короткая ссылка скопирована.');
      } catch {
        note(v);
      }
    };
  }
  const aliasReissue = $('#aliasReissue');
  if (aliasReissue) {
    aliasReissue.onclick = async () => {
      if (!cur) return;
      if (await aliasRevokeCurrent()) {
        if (await aliasCreate()) {
          renderAliasBox().catch(() => {});
          note('Короткая ссылка перевыпущена: старая больше не работает.');
        }
      }
    };
  }
  const aliasDisable = $('#aliasDisable');
  if (aliasDisable) {
    aliasDisable.onclick = async () => {
      if (!cur) return;
      if (await aliasRevokeCurrent()) {
        renderAliasBox().catch(() => {});
        note('Короткая ссылка отключена. Длинная ссылка комнаты продолжает работать.');
      }
    };
  }
  const aliasClose = $('#aliasClose');
  if (aliasClose) aliasClose.onclick = () => $('#chatAliasBox')?.classList.add('hidden');
  const inviteBtn = $('#chatInviteBtn');
  if (inviteBtn) inviteBtn.onclick = () => createInvite();
  const greetClose = $('#greetClose');
  if (greetClose) {
    greetClose.onclick = () => $('#chatGreetBox')?.classList.add('hidden');
  }
  const greetCopy = $('#greetCopy');
  if (greetCopy) {
    greetCopy.onclick = async () => {
      const v = $('#greetLink')?.value || '';
      if (!v) return;
      try {
        await navigator.clipboard.writeText(v);
        note('Короткая ссылка скопирована.');
      } catch {
        note(v);
      }
    };
  }
  const titleBox = $('#chatTitleBox');
  if (titleBox) {
    titleBox.onclick = () => {
      const box = $('#chatMembersList');
      if (!box) return;
      box.classList.toggle('hidden');
      renderMembersList();
    };
  }
  const callBtn = $('#chatCallBtn');
  if (callBtn) {
    callBtn.onclick = async () => {
      if (!cur || !cur.rec.nick) return note('Сначала введите никнейм.');
      const others = knownMembers().filter((d) => d !== cur.device.devicePub);
      if (others.length > 1) {
        return note('В группе используйте «Групповой звонок» или кнопку 📞 у участника в списке (шапка комнаты).');
      }
      try {
        const peer = others[0];
        if (peer) {
          // v28 (A): настоящий дозвон, если у собеседника есть личная
          // идентичность в чате; иначе — прежнее приглашение с пометкой.
          const r = await dialMember(peer);
          if (r.dialed) {
            // v38: звонящий сразу ждёт в звонковой комнате (как обычный
            // звонок), собеседник войдёт, приняв вызов или по кнопке в чате.
            cur.pendingCall = r.secret;
            openCallFromChat(r.secret, { autoJoin: true });
            return;
          }
          const secret = newSecret();
          await sendMsg('system', 'call:' + secret, null, { push: 'call' });
          cur.pendingCall = secret;
          note('У собеседника нет личной идентичности в чате (гостевое устройство): его телефон получит push-приглашение (если уведомления включены), приглашение — и в чате; вы уже ждёте в звонке.');
          openCallFromChat(secret, { autoJoin: true });
          return;
        }
        const secret = newSecret();
        await sendMsg('system', 'call:' + secret, null, { push: 'call' });
        cur.pendingCall = secret;
        openCallFromChat(secret, { autoJoin: true });
      } catch (e) {
        note(e.message);
      }
    };
  }
  // v29 (B): кнопка группового звонка — модель «живой звонок»: нет
  // активного — создать и дозвониться; есть — войти по плашке/кнопке.
  const groupCallBtn = $('#chatGroupCallBtn');
  if (groupCallBtn) {
    groupCallBtn.onclick = () => startOrJoinGcall().catch((e) => note(e.message));
  }
  // v38: вся плашка — кнопка входа (раньше реагировала только маленькая
  // «Войти»; тап по тексту плашки ничего не делал).
  const gcallBar = $('#chatGcallBar');
  if (gcallBar) {
    gcallBar.setAttribute('role', 'button');
    gcallBar.tabIndex = 0;
    const go = () => {
      const st = cur?.gcallState;
      if (st && st.active) joinGcall(st.callId).catch((e) => note(e.message));
    };
    gcallBar.onclick = (e) => {
      if (e.target.closest('#chatGcallLeave')) return;
      go();
    };
    gcallBar.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    };
  }
  const gcallLeave = $('#chatGcallLeave');
  if (gcallLeave) {
    gcallLeave.onclick = (e) => {
      e.stopPropagation();
      leaveGcall().catch(() => {});
    };
  }
  // ---------- v29: управление комнатой (меню внутри комнаты) ----------
  const closeRoomPopovers = (exceptId = '') => {
    for (const id of ['chatRoomMenuBox', 'chatTtlBox', 'chatAliasBox', 'chatWordBox', 'chatEpochBox', 'chatGreetBox', 'chatMembersList']) {
      if (id !== exceptId) $('#' + id)?.classList.add('hidden');
    }
  };
  const roomMenuBtn = $('#chatRoomMenuBtn');
  if (roomMenuBtn) {
    roomMenuBtn.onclick = (e) => {
      e.stopPropagation();
      const box = $('#chatRoomMenuBox');
      if (!box) return;
      const willShow = box.classList.contains('hidden');
      closeRoomPopovers('chatRoomMenuBox');
      box.classList.toggle('hidden', !willShow);
      if (willShow) renderRoomMenuState();
    };
  }
  // Меню комнаты и состав участников закрываются кликом мимо, как обычные меню.
  document.addEventListener('click', (e) => {
    for (const [box, toggle] of [
      ['#chatRoomMenuBox', '#chatRoomMenuBtn'],
      ['#chatMembersList', '#chatTitleBox'],
    ]) {
      const el = $(box);
      if (el && !el.classList.contains('hidden') && !el.contains(e.target) && !e.target.closest(toggle)) {
        el.classList.add('hidden');
      }
    }
  });
  // v38: ручная пересинхронизация шифрования комнаты.
  const roomResync = $('#roomActResync');
  if (roomResync) {
    roomResync.onclick = () => {
      $('#chatRoomMenuBox')?.classList.add('hidden');
      resyncRoom().catch((e) => note('Пересинхронизация не удалась: ' + e.message));
    };
  }
  const roomKeep = $('#roomActKeep');
  if (roomKeep) {
    roomKeep.onclick = async () => {
      if (!cur) return;
      cur.rec.keepForever = !cur.rec.keepForever;
      await saveRoom(cur.rec);
      renderRoomMenuState();
      renderRoomList().catch(() => {});
      note(
        cur.rec.keepForever
          ? 'Чат сохранён от автоудаления на этом устройстве.'
          : 'Автоудаление для этого чата снова включено (30 дней без сообщений).'
      );
    };
  }
  const roomDelSelf = $('#roomActDeleteSelf');
  if (roomDelSelf) {
    roomDelSelf.onclick = async () => {
      if (!cur) return;
      if (!armButton(roomDelSelf, 'Точно удалить у себя? Ещё раз — удалить')) return;
      const rec = cur.rec;
      $('#chatRoomMenuBox')?.classList.add('hidden');
      await deleteRoomSelf(rec);
    };
  }
  const roomDelAll = $('#roomActDeleteAll');
  if (roomDelAll) {
    roomDelAll.onclick = async () => {
      if (!cur) return;
      if (
        !armButton(
          roomDelAll,
          'Удалить для ВСЕХ безвозвратно? Ещё раз — подтвердить'
        )
      )
        return;
      const rec = cur.rec;
      $('#chatRoomMenuBox')?.classList.add('hidden');
      const res = await deleteRoomForAll(rec);
      note(res);
    };
  }
  // v36: на узком экране «Пригласить» и «Скопировать ссылку» живут в меню
  // комнаты — пункты меню просто нажимают кнопки шапки.
  for (const [itemId, targetId] of [['#roomActInvite', '#chatInviteBtn'], ['#roomActCopy', '#chatCopyLink']]) {
    const item = $(itemId);
    if (!item) continue;
    item.onclick = () => {
      $('#chatRoomMenuBox')?.classList.add('hidden');
      $(targetId)?.click();
    };
  }
  // ---------- v29: меню комнаты в списке ----------
  const rlOpen = $('#roomListOpen');
  if (rlOpen) {
    rlOpen.onclick = async () => {
      const rec = listMenuRec;
      hideRoomListMenu();
      if (rec) openRoomBySeed(await decryptWithVault(rec.seedEnc));
    };
  }
  const rlKeep = $('#roomListKeep');
  if (rlKeep) {
    rlKeep.onclick = async () => {
      const rec = listMenuRec;
      if (!rec) return;
      rec.keepForever = !rec.keepForever;
      normalizeRoomRecord(rec);
      await saveRoom(rec);
      hideRoomListMenu();
      renderRoomList().catch(() => {});
    };
  }
  const rlDelSelf = $('#roomListDelSelf');
  if (rlDelSelf) {
    rlDelSelf.onclick = async () => {
      const rec = listMenuRec;
      if (!rec) return;
      if (!armButton(rlDelSelf, 'Точно удалить у себя? Ещё раз — удалить')) return;
      hideRoomListMenu();
      await deleteRoomSelf(rec);
    };
  }
  const rlDelAll = $('#roomListDelAll');
  if (rlDelAll) {
    rlDelAll.onclick = async () => {
      const rec = listMenuRec;
      if (!rec) return;
      if (!armButton(rlDelAll, 'Удалить для ВСЕХ безвозвратно? Ещё раз — подтвердить')) return;
      hideRoomListMenu();
      note(await deleteRoomForAll(rec));
    };
  }
  document.addEventListener('click', (e) => {
    const menu = $('#chatListMenu');
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) {
      hideRoomListMenu();
    }
  });
  const epochBtn = $('#chatEpochBtn');
  if (epochBtn) epochBtn.onclick = () => openEpochDialog().catch(() => {});
  const epochCancel = $('#epochCancel');
  if (epochCancel) epochCancel.onclick = () => $('#chatEpochBox')?.classList.add('hidden');
  const epochConfirm = $('#epochConfirm');
  if (epochConfirm) epochConfirm.onclick = () => doEpochRotate().catch(() => {});
  // v26: голосовые — микрофон виден при пустом поле, отправка при непустом.
  const micBtn = $('#chatMic');
  if (micBtn) micBtn.onclick = () => startVoiceRec().catch(() => {});
  const recCancel = $('#chatRecCancel');
  if (recCancel) recCancel.onclick = () => stopVoiceRec(false);
  const recSend = $('#chatRecSend');
  if (recSend) recSend.onclick = () => stopVoiceRec(true);
  const syncMicSend = () => {
    const inp = $('#chatInput');
    const empty = !(inp?.value || '').trim();
    $('#chatMic')?.classList.toggle('hidden', !empty);
    $('#chatSend')?.classList.toggle('hidden', empty);
  };
  const micInput = $('#chatInput');
  if (micInput) micInput.addEventListener('input', syncMicSend);
  syncMicSend();

  // ---------- v27: поиск по переписке ----------
  const searchBar = $('#chatSearchBar');
  const searchInput = $('#chatSearchInput');
  const updateSearchCount = () => {
    const c = $('#chatSearchCount');
    if (!c) return;
    if (!cur?.search) {
      c.textContent = '';
      return;
    }
    c.textContent = cur.search.hashes.length
      ? `${cur.search.idx + 1}/${cur.search.hashes.length}`
      : '0/0';
  };
  const runSearch = async () => {
    if (!cur || !searchInput) return;
    const q = searchInput.value.trim();
    if (!q) {
      cur.search = null;
      updateSearchCount();
      renderMessages().catch(() => {});
      return;
    }
    const ql = q.toLowerCase();
    const items = await roomMessages(cur.rec.roomId);
    const hashes = [];
    for (const it of items) {
      if (it.expiresAt && it.expiresAt <= Date.now()) continue;
      const m = it.msg;
      if (m.deleted) continue;
      let hay = null;
      if (m.type === 'text') hay = m.text || '';
      else if (m.type === 'file') {
        try {
          hay = JSON.parse(m.text || '{}').name || '';
        } catch {}
      }
      if (hay && hay.toLowerCase().includes(ql)) hashes.push(it.hash);
    }
    if (!cur) return;
    cur.search = { q, hashes, idx: hashes.length ? 0 : -1 };
    updateSearchCount();
    await renderMessages().catch(() => {});
    if (cur.search && cur.search.idx >= 0) scrollToMessage(cur.search.hashes[cur.search.idx], false);
  };
  const searchBtn = $('#chatSearchBtn');
  if (searchBtn && searchBar) {
    searchBtn.onclick = () => {
      const willShow = searchBar.classList.contains('hidden');
      searchBar.classList.toggle('hidden');
      if (willShow) searchInput?.focus();
      else {
        if (cur) cur.search = null;
        if (searchInput) searchInput.value = '';
        updateSearchCount();
        renderMessages().catch(() => {});
      }
    };
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => runSearch().catch(() => {}));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#chatSearchNext')?.click();
      }
    });
  }
  const searchNav = (delta) => {
    if (!cur?.search || !cur.search.hashes.length) return;
    const n = cur.search.hashes.length;
    cur.search.idx = (((cur.search.idx + delta) % n) + n) % n;
    updateSearchCount();
    scrollToMessage(cur.search.hashes[cur.search.idx]);
  };
  const sprev = $('#chatSearchPrev');
  if (sprev) sprev.onclick = () => searchNav(-1);
  const snext = $('#chatSearchNext');
  if (snext) snext.onclick = () => searchNav(1);
  const sclose = $('#chatSearchClose');
  if (sclose) sclose.onclick = () => searchBtn?.click();

  // ---------- v27: исчезающие сообщения (настройка комнаты) ----------
  const ttlBtn = $('#chatTtlBtn');
  if (ttlBtn) {
    ttlBtn.onclick = () => {
      const box = $('#chatTtlBox');
      if (!box) return;
      const willShow = box.classList.contains('hidden');
      box.classList.toggle('hidden');
      if (willShow) renderTtlState();
    };
  }
  const ttlSel = $('#chatTtlSelect');
  if (ttlSel) {
    ttlSel.onchange = async () => {
      if (!cur) return;
      if (!cur.rec.nick) return note('Сначала введите никнейм.');
      const ttl = Number(ttlSel.value) || 0;
      if (ttl === cur.rec.ttlSec) return;
      try {
        await sendMsg('ttl', JSON.stringify({ ttl }));
        note(
          ttl > 0
            ? `Исчезающие сообщения включены: новые сообщения будут жить ${ttlLabel(ttl)}.`
            : 'Исчезающие сообщения выключены.'
        );
      } catch (e) {
        note(e.message);
      }
    };
  }

  // ---------- v27: закреп ----------
  const pinTextEl = $('#chatPinText');
  if (pinTextEl) {
    pinTextEl.onclick = () => {
      if (cur?.rec.pinned?.hash) scrollToMessage(cur.rec.pinned.hash);
    };
  }
  const pinUnpinBtn = $('#chatPinUnpin');
  if (pinUnpinBtn) {
    pinUnpinBtn.onclick = async () => {
      if (!cur) return;
      try {
        await sendMsg('unpin', '{}');
      } catch (e) {
        note(e.message);
      }
    };
  }

  // ---------- v27: плашки цитаты и редактирования ----------
  const replyCancel = $('#chatReplyCancel');
  if (replyCancel) {
    replyCancel.onclick = () => {
      if (!cur) return;
      cur.replyTo = null;
      renderReplyBar();
    };
  }
  const editCancel = $('#chatEditCancel');
  if (editCancel) {
    editCancel.onclick = () => {
      if (!cur) return;
      cur.editing = null;
      renderEditBar();
      const inp = $('#chatInput');
      if (inp) {
        inp.value = cur.rec.draft || '';
        inp.dispatchEvent(new Event('input'));
      }
    };
  }

  // ---------- v27: меню действий сообщения ----------
  const menuAct = (id, fn) => {
    const b = $(id);
    if (!b) return;
    b.onclick = () => {
      const it = cur?.menuTarget;
      hideMsgMenu();
      if (!it) return;
      try {
        const r = fn(it);
        if (r?.catch) r.catch((e) => note(e.message));
      } catch (e) {
        note(e.message);
      }
    };
  };
  menuAct('#msgActReply', (it) => {
    if (!cur) return;
    cur.replyTo = { hash: it.hash, name: it.msg.nick || 'Участник', excerpt: excerptOf(it) };
    cur.editing = null;
    renderEditBar();
    renderReplyBar();
    $('#chatInput')?.focus();
  });
  document.querySelectorAll('.chat-react-emoji').forEach((b) => {
    b.onclick = () => {
      const it = cur?.menuTarget;
      hideMsgMenu();
      if (it) toggleReaction(it, b.dataset.emoji).catch(() => {});
    };
  });
  menuAct('#msgActCopy', async (it) => {
    await navigator.clipboard.writeText(it.msg.text || '');
    flash('Текст скопирован');
  });
  menuAct('#msgActPin', (it) => sendMsg('pin', JSON.stringify({ target: it.hash })));
  menuAct('#msgActEdit', (it) => {
    if (!cur) return;
    cur.editing = { hash: it.hash };
    cur.replyTo = null;
    renderReplyBar();
    renderEditBar();
    const inp = $('#chatInput');
    if (inp) {
      inp.value = it.msg.text || '';
      inp.dispatchEvent(new Event('input'));
      inp.focus();
    }
  });
  menuAct('#msgActDel', (it) => sendMsg('del', JSON.stringify({ target: it.hash })));
  document.addEventListener('click', (e) => {
    const menu = $('#chatMsgMenu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (e.target.closest('#chatMsgMenu') || e.target.closest('.chat-act-btn')) return;
    hideMsgMenu();
  });

  // ---------- v28 (B): настройки уведомлений о сообщениях ----------
  const notifyBtn = $('#chatNotifyBtn');
  if (notifyBtn) {
    const syncNotifyBtn = () => {
      if (!('Notification' in window)) {
        notifyBtn.disabled = true;
        notifyBtn.textContent = '🔔 Уведомления не поддерживаются браузером';
        return;
      }
      notifyBtn.disabled = Notification.permission === 'denied';
      notifyBtn.querySelector('span').textContent =
        Notification.permission === 'granted'
          ? '🔔 Уведомления включены'
          : Notification.permission === 'denied'
            ? '🔔 Уведомления запрещены в браузере'
            : '🔔 Включить уведомления';
    };
    notifyBtn.onclick = async () => {
      // Разрешение запрашиваем только по явному действию, не при загрузке.
      // v38: вместе с разрешением — push-подписка (раньше её не было, и
      // уведомления работали только при открытом приложении).
      let sub = null;
      try {
        sub = window.__zvPush ? await window.__zvPush.enable() : null;
        if (!window.__zvPush) await Notification.requestPermission();
      } catch {}
      syncNotifyBtn();
      if (Notification.permission === 'granted') {
        note(
          sub
            ? 'Уведомления включены: сообщения и звонки приходят и при закрытом приложении.'
            : 'Уведомления включены, пока приложение открыто (сервер без push — нужен Worker v38).'
        );
      }
    };
    syncNotifyBtn();
  }
  const nt = $('#chatNotifyText');
  if (nt) {
    nt.checked = notifyTextOn();
    nt.onchange = () => {
      try {
        localStorage.setItem('zvNotifyText', nt.checked ? '1' : '0');
      } catch {}
    };
  }
  const ns = $('#chatNotifySound');
  if (ns) {
    ns.checked = notifySoundOn();
    ns.onchange = () => {
      try {
        localStorage.setItem('zvNotifySound', ns.checked ? '1' : '0');
      } catch {}
      if (ns.checked) notifyBeep();
    };
  }
  // v29: настройка автоудаления неактивных чатов (default ON, срок 30 дней
  // задан владельцем и в UI не редактируется).
  const adt = $('#chatAutoDelToggle');
  if (adt) {
    adt.checked = autoDeleteOn();
    adt.onchange = () => {
      try {
        localStorage.setItem('zvAutoDeleteChats', adt.checked ? '1' : '0');
      } catch {}
      if (adt.checked) sweepInactiveRooms().catch(() => {});
    };
  }
  startRoomSweep();
  // v29: локальный свип неактивных комнат при старте приложения.
  sweepInactiveRooms().catch(() => {});
  // v28 (B): тап по системному уведомлению чата (SW шлёт chat-notification).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      // v38: пуш чата при живой вкладке — сразу докачать нужную комнату.
      if (e.data?.type === 'chat-push') {
        const pre = String(e.data.room || '');
        if (cur && pre && cur.rec.roomId.startsWith(pre)) fetchMissed().catch(() => {});
        else sweepOtherRooms({ force: true, onlyPrefix: pre || null }).catch(() => {});
        return;
      }
      if (e.data?.type !== 'chat-notification') return;
      // v38: SW знает только префикс id комнаты — открываем комнату по нему
      // (раньше сравнение с полным id не срабатывало никогда).
      openRoomByPrefix(String(e.data.roomId || '')).then((okOpen) => {
        if (!okOpen) renderRoomList().catch(() => {});
      });
    });
  }
  // v38: переход из уведомления в закрытое приложение: ?openchat=<префикс>.
  try {
    const sp = new URLSearchParams(location.search);
    const pre = sp.get('openchat');
    if (pre) {
      sp.delete('openchat');
      sp.delete('call');
      const q = sp.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
      setTimeout(() => openRoomByPrefix(pre).catch(() => {}), 400);
    }
  } catch {}
  // v38: появилась/сменилась push-подписка — зарегистрировать её во всех чатах.
  window.addEventListener('zv-push-sub', (e) => {
    registerPushInRooms(e.detail).catch(() => {});
  });

  renderRoomList().catch(() => {});
  // v22: флаг успешной инициализации чата для watchdog в zvdiag.js.
  window.__zvChatBooted = true;
}

// Push и комнаты, живой фон для неоткрытых комнат — chat-push.js (v44)
initChatPush();

// ---------- v39: хуки синхронизации профиля (devices.js) ----------
// Живая запись открытой комнаты — cur.rec (её же сохраняет saveRoom);
// для остальных — запись из IndexedDB.
async function liveRoom(id) {
  if (cur && cur.rec.roomId === id) return cur.rec;
  return loadRoom(id);
}
let introSweepTimer = 0;
let introSweepRunning = false;
function scheduleIntroSweep(ms = 3000) {
  clearTimeout(introSweepTimer);
  introSweepTimer = setTimeout(() => introSweep().catch(() => {}), ms);
}
// Комнаты, пришедшие с другого устройства профиля: это устройство
// представляется в них само — dial (сертификат профиля: собеседники видят
// «ещё одно устройство того же человека»), затем intro и ecdh. Без этого
// оно было бы молчаливым читателем, а v28 таких как раз подсвечивает.
async function introSweep() {
  if (introSweepRunning) return;
  introSweepRunning = true;
  try {
    const device = await getChatDevice();
    if (device.guest) return;
    const rooms = (await kvAll('rooms')).map((x) => x.value).filter((r) => r && r.linkImport && !r.introSent && r.nick);
    for (const r0 of rooms) {
      if (cur && cur.rec.roomId === r0.roomId) continue; // открытая комната представится сама
      try {
        const keys = await standaloneKeys(r0);
        if (!keys) continue;
        const sub = await existingPushSub();
        const init = await api(r0.roomId, keys.accessToken, '/init', {
          method: 'POST',
          body: { dev: device.devicePub, sub },
        });
        if (init.status === 410) {
          await wipeLocalRoom(r0.roomId, { silent: true });
          continue;
        }
        if (init.status !== 200) continue;
        if (cur && cur.rec.roomId === r0.roomId) continue;
        const r = await loadRoom(r0.roomId);
        if (!r || r.introSent) continue;
        applyHistFloor(r, init.data?.lastSeq);
        if (sub?.endpoint) {
          r.pushEp = sub.endpoint;
          r.pushAt = Date.now();
        }
        if (!r.dialInfoSent && device.masterPub) {
          const dial = JSON.stringify({
            masterPub: device.masterPub,
            masterFp: device.masterFp || null,
            cert: device.cert || null,
            chain: device.chain || null,
          });
          if ((await postSystemStandalone(r, 'dial', dial, { quiet: true })) === 201) r.dialInfoSent = true;
        }
        if ((await postSystemStandalone(r, 'intro', r.nick, { quiet: true })) === 201) r.introSent = true;
        if (!r.ecdhSent) {
          const e = await getChatDeviceEcdh();
          if ((await postSystemStandalone(r, 'ecdh', e.ecdhPub, { quiet: true })) === 201) r.ecdhSent = true;
        }
        await saveRoom(r);
      } catch (e) {
        console.warn('intro sweep', e);
      }
      await new Promise((ok) => setTimeout(ok, 150));
    }
  } finally {
    introSweepRunning = false;
  }
}
// Перенос истории с основного устройства: записи ленты с теми же hash,
// что дал бы сервер (повторный fetch их не задвоит), плюс состояние комнаты.
async function importHistory(data) {
  const device = await getChatDevice();
  let n = 0;
  for (const [roomId, h] of Object.entries(data?.rooms || {})) {
    const live = await liveRoom(roomId);
    if (!live || !h || !Array.isArray(h.entries)) continue;
    for (const e of h.entries) {
      if (!e || typeof e.hash !== 'string' || !e.msg || typeof e.msg !== 'object') continue;
      const key = roomId + ':' + e.hash;
      if (await kvGet('messages', key)) continue;
      await kvPut('messages', key, { ...e, roomId, mine: e.msg.devPub === device.devicePub, imported: true });
      n++;
    }
    touchRoomMsgs(roomId);
    const st = h.st || {};
    live.members = live.members || {};
    for (const [d, m] of Object.entries(st.members || {})) {
      if (!m || typeof m !== 'object') continue;
      live.members[d] = { ...m, ...(live.members[d] || {}) };
    }
    live.seenDevices = live.seenDevices || {};
    for (const [d, sd] of Object.entries(st.seenDevices || {})) {
      if (!live.seenDevices[d] && sd && typeof sd === 'object') live.seenDevices[d] = { ...sd, alerted: true };
    }
    if (!live.creatorPub && typeof st.creatorPub === 'string') live.creatorPub = st.creatorPub;
    if (!live.pinned && st.pinned) live.pinned = st.pinned;
    if (!live.ttlSec && st.ttlSec > 0) live.ttlSec = st.ttlSec;
    if ((st.lastReadSeq || 0) > (live.lastReadSeq || 0)) live.lastReadSeq = st.lastReadSeq;
    if (!live.histImported) {
      live.histImported = true;
      // Всё до lastSeq основного устройства уже здесь — с сервера только новее.
      if ((st.lastSeq || 0) > (live.lastSeq || 0)) live.lastSeq = st.lastSeq;
    }
    await saveRoom(live);
  }
  if (cur) {
    cur.msgIds = null;
    renderMessages().catch(() => {});
  }
  renderRoomList().catch(() => {});
  return n;
}
const syncHooks = {
  async saveNewRoom(rec) {
    if (await loadRoom(rec.roomId)) return true;
    await saveRoom(normalizeRoomRecord(rec));
    roomSummaryCache.delete(rec.roomId);
    renderRoomList().catch(() => {});
    scheduleIntroSweep();
    return true;
  },
  async patchRoom(id, patch) {
    const rec = await liveRoom(id);
    if (!rec) return false;
    let changed = false;
    for (const [k, v] of Object.entries(patch || {})) {
      if (JSON.stringify(rec[k]) === JSON.stringify(v)) continue;
      rec[k] = v;
      changed = true;
    }
    if (!changed) return true;
    if ('nick' in patch && rec.nick && !rec.introSent && rec.linkImport) scheduleIntroSweep();
    await saveRoom(rec);
    renderRoomList().catch(() => {});
    if (cur && cur.rec === rec) {
      renderPresence();
      renderRoomMenuState();
    }
    return true;
  },
  async removeRoom(id) {
    const rec = await liveRoom(id);
    if (!rec) return true;
    try {
      if (rec.nick && rec.introSent) await postSystemStandalone(rec, 'leave', rec.nick || '', { quiet: true });
    } catch {}
    if (rec.word) await wordRevokeCurrent(rec).catch(() => {});
    await unsubscribeRoom(rec).catch(() => {});
    await wipeLocalRoom(id, { silent: true });
    return true;
  },
  async markRead(id, seq) {
    const rec = await liveRoom(id);
    if (!rec) return false;
    if (seq > (rec.lastReadSeq || 0)) {
      rec.lastReadSeq = seq;
      await saveRoom(rec);
      renderRoomList().catch(() => {});
    }
    return true;
  },
  async epochs(id, list) {
    const rec = await liveRoom(id);
    if (!rec) return false;
    rec.epochs = Array.isArray(rec.epochs) ? rec.epochs : [];
    let changed = false;
    for (const e of list || []) {
      if (!e || !Number.isInteger(e.n) || e.n <= 0 || typeof e.secret !== 'string') continue;
      if (rec.epochs.some((x) => x.n === e.n)) continue;
      rec.epochs.push({ n: e.n, secret: e.secret, ts: e.ts || Date.now() });
      changed = true;
    }
    if (!changed) return true;
    const top = Math.max(0, ...rec.epochs.map((x) => x.n || 0));
    const isCur = !!cur && cur.rec === rec;
    if (top > (rec.epoch || 0)) {
      rec.epoch = top;
      if (isCur) {
        const k = await keyForEpoch(top);
        if (k) cur.keys = { ...cur.keys, roomKey: k };
        cur.epochMissing = false;
        pruneOldEpochChains(top);
      }
    }
    await saveRoom(rec);
    if (isCur) {
      scheduleRetry(800);
      renderMessages().catch(() => {});
    }
    return true;
  },
  roomsChanged() {
    roomSummaryCache.clear();
    renderRoomList().catch(() => {});
  },
  importHistory,
  introSweep,
};
window.addEventListener('zv-devices-changed', () => {
  roomSummaryCache.clear();
  ownTagCache.clear();
  renderRoomList().catch(() => {});
  if (cur) {
    renderPresence();
    renderMembersList();
    renderMessages().catch(() => {});
  }
});
window.addEventListener('zv-settings-synced', () => {
  const nt = $('#chatNotifyText');
  if (nt) nt.checked = notifyTextOn();
  const ns = $('#chatNotifySound');
  if (ns) ns.checked = notifySoundOn();
  const adt = $('#chatAutoDelToggle');
  if (adt) adt.checked = autoDeleteOn();
});

window.ZVChat = {
  sync: syncHooks,
  identityChanged: () => onIdentityChanged().catch(() => {}),
  openRoomBySeed,
  openFromHash: checkHash,
  onCallEnded: (secret) => onCallEnded(secret).catch(() => {}),
  resync: () => resyncRoom(),
  get inCallRoom() {
    return cur && cur.inCall ? cur.rec.roomId : null;
  },
  canonical,
  redeemGreet,
  redeemJoin,
  redeemCode,
  redeemWord,
};
