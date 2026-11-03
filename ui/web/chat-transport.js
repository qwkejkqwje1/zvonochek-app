// ZVONochek v28 — транспортный слой приватного чата.
//
// Интерфейс транспорта намеренно узкий: { kind, send(blob), fetchSince(cursor),
// subscribe(cb), close() }. WorkerTransport ниже — адаптер к функциям,
// которые предоставляет chat.js (его HTTP/WS-шов исторически живёт там),
// FallbackTransport — полностью автономный резервный канал: MQTT (только
// live) + Nostr kind 1 (хранимая лента) + ntfy (только live, v35). Fallback
// не знает ни ключей комнат,
// ни plaintext: на входе и выходе только тот же base64-шифротекст blob,
// который ходит в Worker.
//
// Чистые функции этого модуля (топики, события Nostr, слияние лент, решения
// об уведомлениях, реестр увиденных устройств, менеджер каналов) покрыты
// Node-тестами test-v28.mjs: chat.js при импорте трогает DOM и в тестах не
// поднимается.
import { b64u, sha256hex } from './crypto.js?v=40';
import { ntfyTopic, ntfySubscribeUrl, parseNtfyFrame, fitsNtfy } from './ntfy.js?v=40';
import { schnorr } from './vendor/secp256k1.js?v=40';

const te = new TextEncoder();
export const bytesToHex = (bytes) =>
  [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const hexToBytes = (hex) => {
  const s = String(hex || '');
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

// ---------- Адреса резервного канала ----------
// roomId и так известен серверу воркера, но публичным брокерам/релеям мы его
// не показываем: наружу уходит только SHA-256(roomId) hex.
export async function chatRoomHash(roomId) {
  return sha256hex(String(roomId));
}

export async function mqttTopicForRoom(roomId) {
  return 'zvchat1/' + (await chatRoomHash(roomId));
}

// ---------- ntfy (третий канал fallback) ----------
// Отдельный префикс 'zvchat1n-', чтобы топики чата в ntfy не пересекались
// ни с MQTT ('zvchat1/'), ни с сигналингом звонков ('zv1-'). Хэш — тот же
// SHA-256(roomId), что у остальных резервных каналов (усечение — в ntfy.js).
export const NTFY_CHAT_TOPIC_PREFIX = 'zvchat1n-';
export const ntfyTopicForRoom = (roomId) => ntfyTopic(NTFY_CHAT_TOPIC_PREFIX, roomId);

export const NOSTR_CHAT_KIND = 1;
export const NOSTR_CHAT_TAG = 'zvchat1';

export function nostrFiltersForRoom(roomHash, sinceSec = 0) {
  const base = { kinds: [NOSTR_CHAT_KIND], '#t': [NOSTR_CHAT_TAG] };
  if (sinceSec > 0) base.since = Math.floor(sinceSec);
  // Первый фильтр — точный (по хэшу комнаты в теге z). Не все реле умеют
  // индексировать произвольный тег z, поэтому вторым фильтром просим ленту
  // по t и фильтруем по z уже на клиенте (parse/verify ниже это делает).
  return [{ ...base, '#z': [roomHash] }, { ...base }];
}

export function nostrEventIdBytes(event) {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return crypto.subtle.digest('SHA-256', te.encode(serialized)).then((h) => new Uint8Array(h));
}

function secretBytes(secret) {
  if (secret instanceof Uint8Array) return secret;
  if (typeof secret === 'string' && /^[0-9a-fA-F]{64}$/.test(secret)) return hexToBytes(secret);
  if (typeof secret === 'string') return b64u.dec(secret);
  throw new Error('nostr secret: нужны 32 байта');
}

export async function nostrPublicKeyHex(secret) {
  return bytesToHex(schnorr.getPublicKey(secretBytes(secret)));
}

export async function createNostrEvent({ secret, roomHash, blob, createdAt }) {
  const sec = secretBytes(secret);
  const pubkey = bytesToHex(schnorr.getPublicKey(sec));
  const ts = Math.floor(createdAt || Date.now() / 1000);
  const event = {
    pubkey,
    created_at: ts,
    kind: NOSTR_CHAT_KIND,
    tags: [
      ['t', NOSTR_CHAT_TAG],
      ['z', roomHash],
      // 's' — подсказка порядка ленты (ts события): у резервного канала нет
      // серверного seq, лента сортируется по этому полю и по ts сообщения.
      ['s', String(ts)],
    ],
    content: String(blob),
  };
  const id = await nostrEventIdBytes(event);
  event.id = bytesToHex(id);
  event.sig = bytesToHex(await schnorr.signAsync(id, sec));
  return event;
}

export async function verifyNostrEvent(event, roomHash = null) {
  try {
    if (!event || event.kind !== NOSTR_CHAT_KIND || typeof event.content !== 'string') return false;
    if (!/^[0-9a-f]{64}$/.test(event.id || '') || !/^[0-9a-f]{64}$/.test(event.pubkey || '')) return false;
    if (!/^[0-9a-f]{128}$/.test(event.sig || '')) return false;
    const tags = new Map();
    for (const t of event.tags || []) if (Array.isArray(t) && t.length >= 2) tags.set(t[0], t[1]);
    if (tags.get('t') !== NOSTR_CHAT_TAG) return false;
    if (roomHash && tags.get('z') !== roomHash) return false;
    const id = await nostrEventIdBytes(event);
    if (bytesToHex(id) !== event.id) return false;
    return await schnorr.verifyAsync(hexToBytes(event.sig), id, hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

export function parseNostrRelayMessage(data) {
  try {
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    if (!Array.isArray(arr)) return null;
    if (arr[0] === 'EVENT' && arr[2] && typeof arr[2] === 'object') {
      return { type: 'event', subId: arr[1], event: arr[2] };
    }
    if (arr[0] === 'EOSE') return { type: 'eose', subId: arr[1] };
    if (arr[0] === 'CLOSED') return { type: 'closed', subId: arr[1], reason: arr[2] || '' };
    if (arr[0] === 'NOTICE') return { type: 'notice', message: arr[1] || '' };
    return { type: String(arr[0] || 'unknown') };
  } catch {
    return null;
  }
}

// ---------- Слияние лент и порядок ----------
// У сообщений основного канала есть серверный seq; у fallback-сообщений его
// нет до ресинка. Сортировка: сначала всё с seq по seq, затем бес-seq по
// (ts, hash). Дубли — по хэшу blob; версия с seq побеждает версию без него.
export function compareChatEntries(a, b) {
  const sa = Number.isFinite(a?.seq) ? a.seq : null;
  const sb = Number.isFinite(b?.seq) ? b.seq : null;
  if (sa !== null && sb !== null && sa !== sb) return sa - sb;
  if (sa !== null && sb === null) return -1;
  if (sa === null && sb !== null) return 1;
  const ta = a?.msg?.ts || a?.ts || 0;
  const tb = b?.msg?.ts || b?.ts || 0;
  if (ta !== tb) return ta - tb;
  return String(a?.hash || '').localeCompare(String(b?.hash || ''));
}

export function sortChatItems(items) {
  return [...items].sort(compareChatEntries);
}

export function mergeChatItems(existing, incoming) {
  const byHash = new Map();
  for (const it of [...(existing || []), ...(incoming || [])]) {
    if (!it?.hash) continue;
    const prev = byHash.get(it.hash);
    if (!prev || (Number.isFinite(it.seq) && !Number.isFinite(prev.seq))) byHash.set(it.hash, it);
  }
  return sortChatItems([...byHash.values()]);
}

// ---------- Уведомления: чистое решение и троттлинг ----------
// Показываем тост, если сообщение не моё и комната сейчас не перед глазами:
// либо открыта другая комната/экран, либо вкладка скрыта. Системное
// уведомление (showNotification) — только когда документ скрыт.
export function shouldNotifyMessage({
  mine = false,
  roomActive = false,
  documentHidden = false,
  now = Date.now(),
  lastShownAt = 0,
  minIntervalMs = 2000,
} = {}) {
  if (mine) return { show: false, system: false, reason: 'mine' };
  if (roomActive && !documentHidden) return { show: false, system: false, reason: 'active' };
  // lastShownAt=0 — «ещё ни разу не показывали»: троттлинг не применяется.
  if (lastShownAt > 0 && now - lastShownAt < minIntervalMs) {
    return { show: false, system: false, reason: 'throttled' };
  }
  return { show: true, system: !!documentHidden, reason: 'inactive' };
}

export class ToastGate {
  constructor(minIntervalMs = 2000) {
    this.minIntervalMs = minIntervalMs;
    this.lastByRoom = new Map();
    this.pendingByRoom = new Map();
  }
  check(roomId, opts = {}) {
    const now = opts.now || Date.now();
    const last = this.lastByRoom.get(roomId) || 0;
    const d = shouldNotifyMessage({ ...opts, now, lastShownAt: last, minIntervalMs: this.minIntervalMs });
    if (d.show) {
      const count = (this.pendingByRoom.get(roomId) || 0) + 1;
      this.pendingByRoom.set(roomId, 0);
      this.lastByRoom.set(roomId, now);
      return { ...d, count };
    }
    if (d.reason === 'throttled') {
      this.pendingByRoom.set(roomId, (this.pendingByRoom.get(roomId) || 0) + 1);
    }
    return d;
  }
}

// ---------- Реестр увиденных устройств комнаты ----------
// seen: { dev: {firstSeen, lastSeen, hasIntro, alerted} }. silent=true —
// историческая подгрузка (уже известные участники не должны поднимать
// тревогу при первом открытии комнаты клиентом v28).
export function observeDevice(seen, dev, { hasIntro = false, now = Date.now(), silent = false } = {}) {
  const out = { ...(seen || {}) };
  if (!dev || typeof dev !== 'string') return { seen: out, isNew: false, shouldAlert: false, anonymous: false };
  const prev = out[dev];
  const isNew = !prev;
  const mergedHasIntro = !!(prev?.hasIntro || hasIntro);
  out[dev] = {
    firstSeen: prev?.firstSeen || now,
    lastSeen: now,
    hasIntro: mergedHasIntro,
    alerted: !!(prev?.alerted || (isNew && !silent)),
  };
  return { seen: out, isNew, shouldAlert: isNew && !silent, anonymous: !mergedHasIntro };
}

// ---------- Статусы прочтения (для галочек) ----------
export function receiptState(entry, receipts, others) {
  if (!entry || !Number.isFinite(entry.seq)) return entry?.pendingWorkerSync ? 'pending' : 'local';
  const list = others || [];
  if (!list.length) return 'sent';
  const get = (dev) => {
    const r = receipts instanceof Map ? receipts.get(dev) : receipts?.[dev];
    return { delivered: r?.delivered || 0, read: r?.read || 0 };
  };
  if (list.every((d) => get(d).read >= entry.seq)) return 'read';
  if (list.some((d) => get(d).delivered >= entry.seq)) return 'delivered';
  return 'sent';
}

export const RECEIPT_GLYPHS = { local: '✓', pending: '✓', sent: '✓', delivered: '✓✓', read: '✓✓' };
export const RECEIPT_LABELS = {
  local: 'Отправлено',
  pending: 'Отправлено · ждёт основной сервер',
  sent: 'Отправлено',
  delivered: 'Доставлено',
  read: 'Прочитано',
};

// ---------- v29: живой групповой звонок в чате (gcall-state) ----------
// Состояние звонка выводится из подписанных системных сообщений
// type:'gcall-state' {callId, op:'start'|'join'|'leave'|'hb'|'end'}.
// Участник без heartbeat дольше GCALL_HB_TIMEOUT_MS считается вышедшим;
// когда множество участников пустеет, звонок завершён (явным 'end' или
// автоматически — end при этом дописывает любой клиент, заметивший пустоту).
// v38: heartbeat раз в 30 с, тишина 150 с = вышел (было 20/60 с: один
// пропущенный пакет на мобильной сети, вкладка в фоне или сбитые часы
// участника — и звонок «заканчивался» для всех, плашка входа исчезала).
export const GCALL_HB_TIMEOUT_MS = 150000;

// Извлечь события звонка из сохранённых записей ленты (entry.msg).
export function gcallEventsFromEntries(items) {
  const out = [];
  for (const it of items || []) {
    const m = it?.msg;
    if (!m || m.type !== 'gcall-state') continue;
    let d = null;
    try {
      d = JSON.parse(m.text || '');
    } catch {}
    if (!d || typeof d.callId !== 'string' || !d.callId) continue;
    if (!['start', 'join', 'leave', 'hb', 'end'].includes(d.op)) continue;
    out.push({
      callId: d.callId,
      op: d.op,
      dev: m.devPub || '',
      nick: m.nick || '',
      // v38: время по серверу в локальной шкале (lts), если известно, —
      // прунинг не зависит от сбитых часов отправителя.
      ts: Number.isFinite(it.lts) ? it.lts : m.ts || 0,
      hash: it.hash || '',
    });
  }
  out.sort((a, b) => a.ts - b.ts || String(a.hash).localeCompare(String(b.hash)));
  return out;
}

// Агрегация актуального состояния: берётся ПОСЛЕДНИЙ звонок (по первому
// событию) среди имеющих 'start' — старые звонки на новый не влияют.
// Возвращает null, если звонков не было вовсе.
export function aggregateGcallState(events, now = Date.now()) {
  const list = [...(events || [])].sort((a, b) => a.ts - b.ts);
  if (!list.length) return null;
  const byCall = new Map();
  for (const e of list) {
    if (!byCall.has(e.callId)) byCall.set(e.callId, []);
    byCall.get(e.callId).push(e);
  }
  let callId = null;
  let firstTs = -1;
  for (const [id, evs] of byCall) {
    if (!evs.some((e) => e.op === 'start')) continue;
    const t0 = evs[0].ts;
    if (t0 > firstTs) {
      firstTs = t0;
      callId = id;
    }
  }
  if (!callId) {
    // Нет ни одного start (история обрезана) — берём просто последний callId.
    callId = list[list.length - 1].callId;
  }
  const evs = byCall.get(callId) || [];
  let startedAt = null;
  let endedAt = null;
  let lastEventTs = 0;
  const parts = new Map(); // dev -> {dev, nick, lastSeen}
  for (const e of evs) {
    lastEventTs = Math.max(lastEventTs, e.ts || 0);
    if (endedAt !== null) break; // после end события этого звонка не действуют
    if (e.op === 'start') {
      if (startedAt === null) startedAt = e.ts;
      parts.set(e.dev, { dev: e.dev, nick: e.nick || '', lastSeen: e.ts });
    } else if (e.op === 'join' || e.op === 'hb') {
      const prev = parts.get(e.dev);
      parts.set(e.dev, {
        dev: e.dev,
        nick: e.nick || prev?.nick || '',
        lastSeen: Math.max(prev?.lastSeen || 0, e.ts),
      });
    } else if (e.op === 'leave') {
      parts.delete(e.dev);
    } else if (e.op === 'end') {
      endedAt = e.ts;
    }
  }
  if (endedAt !== null) {
    return {
      callId,
      active: false,
      ended: true,
      autoEnded: false,
      startedAt,
      endedAt,
      durationMs: startedAt !== null ? Math.max(0, endedAt - startedAt) : null,
      participants: [],
    };
  }
  // Прунинг по heartbeat: молчащие дольше таймаута считаются вышедшими.
  for (const [dev, p] of parts) {
    if (now - p.lastSeen > GCALL_HB_TIMEOUT_MS) parts.delete(dev);
  }
  const participants = [...parts.values()].sort((a, b) => a.lastSeen - b.lastSeen);
  if (startedAt !== null && participants.length === 0) {
    return {
      callId,
      active: false,
      ended: true,
      autoEnded: true,
      startedAt,
      endedAt: lastEventTs || startedAt,
      durationMs: Math.max(0, (lastEventTs || startedAt) - startedAt),
      participants: [],
    };
  }
  return {
    callId,
    active: participants.length > 0,
    ended: false,
    autoEnded: false,
    startedAt,
    endedAt: null,
    durationMs: null,
    participants,
  };
}

// ---------- v29: автоудаление неактивных чатов (локальный свип) ----------
// Срок — цифра владельца: 30 дней без активности. Активность комнаты —
// последнее сообщение любого типа или момент создания записи.
export const CHAT_INACTIVE_MS = 30 * 24 * 3600000;

export function roomLastActivityTs(rec, items) {
  let t = rec?.createdAt || 0;
  for (const it of items || []) {
    const ts = it?.msg?.ts || it?.ts || 0;
    if (ts > t) t = ts;
  }
  return t;
}

export function shouldSweepRoom(rec, items, now = Date.now(), { enabled = true } = {}) {
  if (!enabled || !rec || rec.keepForever) return false;
  return now - roomLastActivityTs(rec, items) > CHAT_INACTIVE_MS;
}

// ---------- v29: tombstones удалённых комнат в бэкапе ----------
// Восстановление не воскрешает комнату, если её tombstone новее записи
// комнаты в бэкапе (ts записи = createdAt на момент сбора бэкапа).
export function isRoomTombstoned(roomId, roomTs, tombstones) {
  if (!roomId) return false;
  let max = null;
  for (const t of tombstones || []) {
    if (t && t.roomId === roomId && Number.isFinite(t.ts)) {
      if (max === null || t.ts > max) max = t.ts;
    }
  }
  return max !== null && max > (roomTs || 0);
}

export function filterRestoredRooms(candidates, tombstones) {
  return (candidates || []).filter((c) => c && !isRoomTombstoned(c.roomId, c.ts, tombstones));
}

// ---------- Менеджер каналов ----------
export class ChatTransportManager {
  constructor({ worker, fallback, thresholdMs = 8000, onModeChange, onResync, nowFn } = {}) {
    this.worker = worker || null;
    this.fallback = fallback || null;
    this.thresholdMs = thresholdMs;
    this.onModeChange = onModeChange || (() => {});
    this.onResync = onResync || (async () => {});
    this.nowFn = nowFn || (() => Date.now());
    this.mode = 'worker';
    this.workerDownSince = null;
    this.switching = false;
  }
  get kind() {
    return this.mode;
  }
  async noteWorkerFailure(now = this.nowFn()) {
    if (this.workerDownSince == null) this.workerDownSince = now;
    if (
      this.mode === 'worker' &&
      this.fallback &&
      now - this.workerDownSince >= this.thresholdMs &&
      !this.switching
    ) {
      this.switching = true;
      try {
        await this.fallback.start?.();
        this.mode = 'fallback';
        this.onModeChange('fallback');
      } finally {
        this.switching = false;
      }
    }
    return this.mode;
  }
  async noteWorkerSuccess(now = this.nowFn()) {
    this.workerDownSince = null;
    if (this.mode === 'fallback' && !this.switching) {
      this.switching = true;
      this.mode = 'resync';
      this.onModeChange('resync');
      try {
        await this.onResync();
        await this.fallback?.close?.();
        this.mode = 'worker';
        this.onModeChange('worker');
      } catch (e) {
        // Ресинк не удался — остаёмся на резервном канале, воркер попробуем
        // снова при следующем успешном health.
        this.mode = 'fallback';
        this.onModeChange('fallback');
        throw e;
      } finally {
        this.switching = false;
      }
    }
    return this.mode;
  }
  async checkHealth(healthOk, now = this.nowFn()) {
    return healthOk ? this.noteWorkerSuccess(now) : this.noteWorkerFailure(now);
  }
  async send(blob) {
    const t = this.mode === 'fallback' ? this.fallback : this.worker;
    if (!t) throw new Error('нет активного транспорта чата');
    return t.send(blob);
  }
  async fetchSince(cursor) {
    const t = this.mode === 'fallback' ? this.fallback : this.worker;
    if (!t?.fetchSince) return [];
    return t.fetchSince(cursor);
  }
  close() {
    try {
      this.worker?.close?.();
    } catch {}
    try {
      this.fallback?.close?.();
    } catch {}
  }
}

// Адаптер основного канала. Реальные send/fetch/subscribe предоставляет
// chat.js (его api() и WebSocket), здесь — только форма интерфейса.
export class WorkerTransport {
  constructor(handlers = {}) {
    this.kind = 'worker';
    this.handlers = handlers;
  }
  async send(blob) {
    if (!this.handlers.send) throw new Error('WorkerTransport: нет send');
    return this.handlers.send(blob);
  }
  async fetchSince(cursor) {
    if (!this.handlers.fetchSince) return [];
    return this.handlers.fetchSince(cursor);
  }
  subscribe(cb) {
    return this.handlers.subscribe ? this.handlers.subscribe(cb) : () => {};
  }
  close() {
    this.handlers.close?.();
  }
}

// ---------- Резервный канал: MQTT live + Nostr store + ntfy live ----------
export class FallbackTransport {
  constructor({
    roomId,
    brokers = [],
    relays = [],
    secret,
    ntfyBase = '',
    onBlob,
    onStatus,
    mqttConnect,
    webSocketFactory,
    fetchFn,
    historyTimeoutMs = 1500,
  } = {}) {
    this.kind = 'fallback';
    this.roomId = roomId;
    this.brokers = brokers;
    this.relays = relays.slice(0, 3);
    this.secret = secret;
    this.ntfyBase = String(ntfyBase || '').replace(/\/$/, '');
    this.onBlob = onBlob || (() => {});
    this.onStatus = onStatus || (() => {});
    this.mqttConnect = mqttConnect || ((url, opts) => globalThis.mqtt?.connect(url, opts));
    this.webSocketFactory = webSocketFactory || ((url) => new WebSocket(url));
    this.fetchFn = fetchFn || ((url, opts) => globalThis.fetch(url, opts));
    this.historyTimeoutMs = historyTimeoutMs;
    this.roomHash = null;
    this.topic = null;
    this.ntfyTopic = null;
    this.ntfyWs = null;
    this.ntfyTimer = null;
    this.ntfySeen = new Set(); // id сообщений ntfy (дедуп реплеев кэша)
    this.pubkey = null;
    this.mqttClients = [];
    this.sockets = new Map(); // url -> ws
    this.historyWaiters = new Map(); // subId -> {resolve, events, eose:Set}
    this.closed = false;
    this.started = false;
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    this.roomHash = await chatRoomHash(this.roomId);
    this.topic = await mqttTopicForRoom(this.roomId);
    if (this.secret) this.pubkey = await nostrPublicKeyHex(this.secret);
    for (const b of this.brokers) this._connectMqtt(b);
    for (const url of this.relays) this._connectRelay(url);
    if (this.ntfyBase) {
      this.ntfyTopic = await ntfyTopicForRoom(this.roomId);
      this._connectNtfy();
    }
    return this;
  }

  _connectMqtt(broker) {
    const url = typeof broker === 'string' ? broker : broker?.url;
    if (!url || typeof this.mqttConnect !== 'function') return;
    let client;
    try {
      client = this.mqttConnect(url, {
        ...(broker?.username ? { username: broker.username, password: broker.password } : {}),
        clientId: 'zvchat_' + Math.random().toString(16).slice(2, 12),
        clean: true,
        keepalive: 30,
        connectTimeout: 7000,
        reconnectPeriod: 3500,
        protocolVersion: 4,
      });
    } catch {
      return;
    }
    if (!client?.on) return;
    client.on('connect', () => {
      try {
        client.subscribe(this.topic, { qos: 1 });
      } catch {}
      this.onStatus({ mqtt: true });
    });
    client.on('message', (topic, payload) => {
      if (topic !== this.topic || this.closed) return;
      const blob = typeof payload === 'string' ? payload : payload?.toString?.();
      if (blob) this.onBlob(blob, { via: 'mqtt' });
    });
    this.mqttClients.push(client);
  }

  _connectRelay(url) {
    let ws;
    try {
      ws = this.webSocketFactory(url);
    } catch {
      return;
    }
    if (!ws) return;
    this.sockets.set(url, ws);
    const sendReq = (subId, sinceSec) => {
      try {
        ws.send(JSON.stringify(['REQ', subId, ...nostrFiltersForRoom(this.roomHash, sinceSec)]));
      } catch {}
    };
    ws.onopen = () => {
      if (this.closed) return;
      sendReq('live', Math.floor(Date.now() / 1000) - 3600);
      // Подхватываем ожидающие историю запросы, если fetchSince звали рано.
      for (const [subId, w] of this.historyWaiters) sendReq(subId, w.sinceSec || 0);
    };
    ws.onmessage = async (e) => {
      const parsed = parseNostrRelayMessage(e.data);
      if (!parsed) return;
      if (parsed.type === 'event') {
        const ev = parsed.event;
        if (!(await verifyNostrEvent(ev, this.roomHash))) return;
        if (parsed.subId === 'live') {
          this.onBlob(ev.content, { via: 'nostr', ts: ev.created_at * 1000, event: ev });
        } else if (this.historyWaiters.has(parsed.subId)) {
          this.historyWaiters.get(parsed.subId).events.push(ev);
        }
      } else if (parsed.type === 'eose' && this.historyWaiters.has(parsed.subId)) {
        const w = this.historyWaiters.get(parsed.subId);
        w.eose.add(url);
        if (w.eose.size >= this.sockets.size) w.finish();
      }
    };
    ws.onclose = () => {
      if (this.sockets.get(url) === ws) this.sockets.delete(url);
    };
    ws.onerror = () => {};
  }

  // v35: подписка ntfy (только live, как MQTT; хранимая лента — Nostr).
  // Дедуп: публичный сервер при переподключении может отдать то же
  // сообщение ещё раз (кэш 12 ч минус окно since) — отсекаем по id
  // сообщения ntfy; глобальный дедуп по хэшу blob по-прежнему делает
  // chat.js на ingest.
  _connectNtfy() {
    if (this.closed || !this.ntfyBase || !this.ntfyTopic) return;
    let ws;
    try {
      ws = this.webSocketFactory(ntfySubscribeUrl(this.ntfyBase, this.ntfyTopic));
    } catch {
      return;
    }
    if (!ws) return;
    this.ntfyWs = ws;
    ws.onopen = () => {
      if (this.closed) return;
      this.onStatus({ ntfy: true });
    };
    ws.onmessage = (e) => {
      if (this.closed) return;
      const f = parseNtfyFrame(e.data);
      if (!f) return;
      const dedupKey = f.id || 'b:' + f.message;
      if (this.ntfySeen.has(dedupKey)) return;
      this.ntfySeen.add(dedupKey);
      if (this.ntfySeen.size > 2000) {
        // Грубая чистка: сбрасываем старейшую тысячу ключей (Set хранит
        // порядок вставки), свежая половина остаётся.
        const it = this.ntfySeen.values();
        for (let i = 0; i < 1000; i++) this.ntfySeen.delete(it.next().value);
      }
      this.onBlob(f.message, { via: 'ntfy', ts: f.time ? f.time * 1000 : Date.now() });
    };
    ws.onclose = () => {
      if (this.ntfyWs === ws) this.ntfyWs = null;
      if (this.closed || !this.started) return;
      this.ntfyTimer = setTimeout(() => this._connectNtfy(), 4000);
    };
    ws.onerror = () => {};
  }

  async publish(blob) {
    return this.send(blob);
  }

  async send(blob) {
    if (!this.started) await this.start();
    const payload = String(blob);
    let mqttSent = 0;
    for (const c of this.mqttClients) {
      if (c?.connected) {
        try {
          c.publish(this.topic, payload, { qos: 1 });
          mqttSent++;
        } catch {}
      }
    }
    let nostrSent = 0;
    if (this.secret) {
      const ev = await createNostrEvent({ secret: this.secret, roomHash: this.roomHash, blob: payload });
      const frame = JSON.stringify(['EVENT', ev]);
      for (const ws of this.sockets.values()) {
        if (ws?.readyState === 1) {
          try {
            ws.send(frame);
            nostrSent++;
          } catch {}
        }
      }
    }
    let ntfySent = 0;
    if (this.ntfyBase && this.ntfyTopic && fitsNtfy(payload)) {
      try {
        // Публикация — POST, тело = тот же blob байт-в-байт, что в MQTT.
        // Троттлинг публичного ntfy (429 по IP) просто обнуляет ntfySent:
        // сообщение в этот момент несут MQTT/Nostr.
        const r = await this.fetchFn(this.ntfyBase + '/' + this.ntfyTopic, {
          method: 'POST',
          body: payload,
        });
        if (r && (r.ok === undefined || r.ok)) ntfySent = 1;
      } catch {}
    }
    if (!mqttSent && !nostrSent && !ntfySent) throw new Error('резервный канал: нет живых брокеров/реле');
    return { via: 'fallback', mqttSent, nostrSent, ntfySent, pendingWorkerSync: true };
  }

  // Хранимая лента Nostr: REQ с since по открытым реле, ждём EOSE или
  // таймаут. MQTT и ntfy истории здесь не дают — они только live.
  async fetchSince(cursorSec = 0) {
    if (!this.started) await this.start();
    const open = [...this.sockets.values()].filter((w) => w?.readyState === 1);
    if (!open.length) return [];
    const subId = 'hist' + Math.random().toString(16).slice(2, 10);
    return new Promise((resolve) => {
      const waiter = {
        sinceSec: Math.floor(cursorSec || 0),
        events: [],
        eose: new Set(),
        finish: () => {
          clearTimeout(timer);
          this.historyWaiters.delete(subId);
          try {
            for (const ws of open) ws.send(JSON.stringify(['CLOSE', subId]));
          } catch {}
          const sorted = waiter.events.sort((a, b) => a.created_at - b.created_at);
          resolve(sorted.map((ev) => ({ blob: ev.content, ts: ev.created_at * 1000, event: ev })));
        },
      };
      const timer = setTimeout(() => waiter.finish(), this.historyTimeoutMs);
      this.historyWaiters.set(subId, waiter);
      for (const ws of open) {
        try {
          ws.send(JSON.stringify(['REQ', subId, ...nostrFiltersForRoom(this.roomHash, waiter.sinceSec)]));
        } catch {}
      }
    });
  }

  subscribe(cb) {
    const prev = this.onBlob;
    this.onBlob = (blob, meta) => {
      prev(blob, meta);
      cb(blob, meta);
    };
    return () => {
      this.onBlob = prev;
    };
  }

  async close() {
    this.closed = true;
    if (this.ntfyTimer) {
      clearTimeout(this.ntfyTimer);
      this.ntfyTimer = null;
    }
    try {
      this.ntfyWs?.close();
    } catch {}
    this.ntfyWs = null;
    for (const c of this.mqttClients) {
      try {
        c.end?.(true);
      } catch {}
    }
    this.mqttClients = [];
    for (const ws of this.sockets.values()) {
      try {
        ws.close();
      } catch {}
    }
    this.sockets.clear();
    this.started = false;
  }
}
