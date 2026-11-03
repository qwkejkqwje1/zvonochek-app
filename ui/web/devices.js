// ZVONochek — v39: один профиль на нескольких устройствах.
//
// Что заимствовано и откуда (подробно — AUDIT-v39.md):
//   · Signal «Связанные устройства»: новое устройство показывает QR/код,
//     основное подтверждает; подключённое получает тот же номер, а master-
//     ключ остаётся только на основном. Плюс урок 2025 года — фишинг через
//     привязку устройства (Google TIG: UNC5792/UNC4221/APT44 против Signal):
//     предупреждение на экране подтверждения, контрольные слова, оповещение
//     всех устройств о новом и отвязка в одно касание.
//   · Matrix cross-signing: каждое устройство удостоверено подписью
//     master-ключа (или цепочкой master → recovery → device), реестр
//     устройств проверяется по подписям, а не по слову сервера.
//   · MLS (RFC 9420): общий секрет группы своих устройств меняется при
//     каждом удалении участника (rekey) — отвязанное устройство не читает
//     новые синхронизации; новая «эпоха» = новая комната синхронизации.
//
// Транспорт прежний: синхронизация — обычная E2EE-комната ChatRoom Worker
// (blob 4124 байта и зашифрованные файлы), сервер видит только шифротекст.
// Состояние — LWW-карта (sync-core.js); здесь ввод-вывод, проверки
// подписей, интерфейс привязки и списка устройств.
import {
  b64u,
  deriveChatKeys,
  derivePinIkm,
  encryptChatMessage,
  decryptChatMessage,
  sha256hex,
  newMsgId,
  importFileKey,
  encryptFileChunk,
  decryptFileChunk,
  wrapEpochSecret,
  unwrapEpochSecret,
  newLinkCode,
  formatLinkCode,
  normalizeLinkCode,
  parseLinkToken,
  linkAccess,
  linkBindOf,
  linkSasWords,
  linkRespKey,
  sealCodeBlob,
  openCodeBlob,
  genP256KeyPair,
  deriveRoom,
} from './crypto.js?v=40';
import {
  getPersonal,
  hasPersonal,
  adminSigner,
  newLinkKeys,
  installLinkedIdentity,
  applyRotatedIdentity,
  verifyDeviceCertClient,
  encryptWithVault,
  decryptWithVault,
  getChatDeviceEcdh,
  signWithKey,
  verifyChatSig,
  setOwnCert,
} from './identity.js?v=40';
import { kvGet, kvPut, kvDel, kvAll, kvPrefix, normalizeRoomRecord } from './store.js?v=40';
import { getWorkerBase, setWorkerBase, DEFAULT_WORKER_URL } from './config.js?v=40';
import { inboxRevoke } from './inbox.js?v=40';
import {
  commitLocal,
  mergeItems,
  pickItems,
  chunkDelta,
  stableStringify,
  sameValue,
  shortDev,
  deviceLabelFromUA,
} from './sync-core.js?v=40';

const te = new TextEncoder();
const td = new TextDecoder();
const $ = (s, r = document) => r.querySelector(s);

// Настройки, которые едут на все устройства профиля (имя, «передавать мой
// номер», вид уведомлений, автоудаление чатов). Аудио/видео/камера —
// свойства конкретного устройства и не синхронизируются.
export const SYNC_SETTINGS = ['zvName', 'zvShareBack', 'zvNotifyText', 'zvNotifySound', 'zvAutoDeleteChats'];
const LINK_TTL_MS = 10 * 60000;
const LINK_POLL_MS = 2500;
const POLL_VISIBLE_MS = 45000;
const POLL_HIDDEN_MS = 300000;
const PUBLISH_DEBOUNCE_MS = 4000;
const FULL_EVERY_MS = 7 * 86400000;
const HIST_DAYS = 45;
const HIST_MAX_PER_ROOM = 2000;
const HIST_MAX_BYTES = 12 * 1024 * 1024;
const CHUNK_PT = 192 * 1024;
const DELTA_MAX_BYTES = 2600;
const JOURNAL_TTL_MS = 30 * 86400000;
const REKEY_LABEL = 'zv-sync-rekey-v1';
const HIST_SKIP_TYPES = new Set([
  'react', 'edit', 'del', 'pin', 'unpin', 'ttl', 'dial', 'room-delete', 'gcall-state', 'dr-init', 'drx', 'ecdh', 'epoch',
]);

let st = null; // состояние синхронизации (identity/sync)
let K = null; // ключи текущей комнаты синхронизации
let me = null; // бандл личности этого устройства
let started = false;
let stopped = false;
let pollTimer = null;
let pubTimer = null;
let chain = Promise.resolve();
let wantFull = false;
const pendingKeys = new Set();
const trustCache = new Map();

const chatHooks = () => window.ZVChat?.sync || null;
const appHooks = () => window.__zvAppSync || null;
const base = () => getWorkerBase().replace(/\/$/, '');
const emit = (name, detail = {}) => {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {}
};
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}
function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- Состояние ----------
async function loadState() {
  try {
    st = (await kvGet('identity', 'sync')) || null;
  } catch {
    st = null;
  }
  if (st) {
    if (!st.items || typeof st.items !== 'object') st.items = {};
    if (!st.unapplied || typeof st.unapplied !== 'object') st.unapplied = {};
    if (!st.seen || typeof st.seen !== 'object') st.seen = {};
  }
  return st;
}
async function saveState() {
  if (st) await kvPut('identity', 'sync', st);
}
async function refreshMe() {
  me = await getPersonal().catch(() => null);
  publishProfileView();
  return me;
}

// Профиль для chat.js (синхронно): свои устройства (включая отвязанные —
// их старые сообщения тоже «мои») и текущий master.
function publishProfileView() {
  const own = new Set();
  if (me?.devicePub) own.add(me.devicePub);
  for (const [k, it] of Object.entries(st?.items || {})) {
    if (k.startsWith('dev:') && it && !it.del) own.add(k.slice(4));
    if (k.startsWith('rev:') && it && !it.del) own.add(k.slice(4));
  }
  const labels = {};
  for (const [k, it] of Object.entries(st?.items || {})) {
    if (k.startsWith('dev:') && it && !it.del && it.v?.label) labels[k.slice(4)] = it.v.label;
  }
  window.__zvProfile = { own, master: me?.masterPub || '', labels };
}

// ---------- Ключи комнаты синхронизации ----------
async function hkdfBits(keyBytes, info, salt = 'ZVONochek/sync/v39') {
  const k = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(salt), info: te.encode(info) }, k, 256)
  );
}
async function roomKeysFor(seedB64, gen) {
  const seed = b64u.dec(seedB64);
  const roomSeed = await hkdfBits(seed, 'zv-sync-room-v1|' + gen);
  const keys = await deriveChatKeys(roomSeed);
  const fileBase = await hkdfBits(seed, 'zv-sync-file-v1|' + gen);
  // gid — идентификатор группы своих устройств (меняется только с rekey,
  // не с gen): к нему привязана подпись rekey, чтобы старый rekey нельзя
  // было переслать в новую комнату и откатить группу на прошлый секрет.
  const gid = await sha256hex('zv-sync-gid-v1|' + seedB64);
  return { roomId: keys.roomId, roomKey: keys.roomKey, token: keys.accessToken, fileBase, gen, gid };
}
async function ensureKeys() {
  if (K && K.gen === st.gen && K.seedEnc === st.seedEnc) return K;
  const seedB64 = await decryptWithVault(st.seedEnc);
  K = await roomKeysFor(seedB64, st.gen);
  K.seedEnc = st.seedEnc;
  return K;
}
async function rapi(path, { method = 'GET', body = null, timeout = 25000 } = {}) {
  const res = await fetch(base() + '/chat/' + K.roomId + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-access-token': K.token },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeoutSignal(timeout),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
// Комната синхронизации стёрта сервером (30 дней без активности у всех
// устройств) — все устройства детерминированно переходят на gen+1.
async function roomGone() {
  st.gen = (st.gen || 0) + 1;
  st.lastSeq = 0;
  wantFull = true;
  await saveState();
  await ensureKeys();
}
async function ensureRoomInit() {
  await ensureKeys();
  if (st.initedRoom === K.roomId) return true;
  for (let i = 0; i < 3; i++) {
    const r = await rapi('/init', { method: 'POST', body: { dev: me.devicePub } });
    if (r.status === 200) {
      st.initedRoom = K.roomId;
      await saveState();
      return true;
    }
    if (r.status === 410) {
      await roomGone();
      continue;
    }
    return false;
  }
  return false;
}

// ---------- Конверт сообщения синхронизации ----------
// Подпись ключом устройства над id, типом, временем и хэшем тела; к
// конверту приложен сертификат автора — получатель проверяет его по
// master-ключу профиля (и по списку отозванных) сам, без сервера.
async function envText(env) {
  const sha = await sha256hex(stableStringify(env.body || null));
  return `zv-sync-v1|${env.t}|${env.dev}|${env.ts}|${env.id}|${sha}`;
}
async function post(t, body, as = null) {
  await ensureRoomInit();
  const env = {
    v: 1,
    id: newMsgId(),
    t,
    dev: me.devicePub,
    ts: Date.now(),
    cert: as ? as.cert : me.cert,
    chain: as ? as.chain || null : me.chain || null,
    body,
  };
  env.sig = await signWithKey(me.devicePriv, await envText(env));
  const blob = await encryptChatMessage(K.roomKey, env);
  let r = await rapi('/msg', { method: 'POST', body: { blob: b64u.enc(blob), dev: me.devicePub, quiet: true } });
  if (r.status === 410) {
    await roomGone();
    await ensureRoomInit();
    r = await rapi('/msg', { method: 'POST', body: { blob: b64u.enc(blob), dev: me.devicePub, quiet: true } });
  }
  if (r.status !== 201 && r.status !== 200) throw new Error('синхронизация: сервер ответил ' + r.status);
  return { id: env.id, seq: r.data.seq };
}

// ---------- Зашифрованные файлы (снимок профиля, история) ----------
async function fileKeyFor(fileId) {
  return importFileKey(await hkdfBits(K.fileBase, 'zv-sync-file|' + fileId, 'ZVONochek/sync/file'));
}
async function pipeBytes(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function uploadObject(obj) {
  if (!(await ensureRoomInit())) throw new Error('комната синхронизации недоступна');
  let bytes = te.encode(JSON.stringify(obj));
  const sha = await sha256hex(bytes);
  let z = 0;
  if (typeof CompressionStream === 'function' && typeof DecompressionStream === 'function') {
    try {
      bytes = await pipeBytes(bytes, new CompressionStream('deflate'));
      z = 1;
    } catch {}
  }
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_PT));
  if (total > 100) throw new Error('слишком большой объём для синхронизации');
  const fileId = b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
  const key = await fileKeyFor(fileId);
  const salt = new Uint8Array(16); // ключ уникален для файла — нонс = номер куска
  for (let i = 0; i < total; i++) {
    const ct = await encryptFileChunk(key, salt, i, bytes.subarray(i * CHUNK_PT, (i + 1) * CHUNK_PT));
    let r = null;
    for (let a = 0; a < 3; a++) {
      r = await rapi('/file', { method: 'POST', body: { fileId, idx: i, total, blob: b64u.enc(ct) }, timeout: 90000 }).catch(
        () => null
      );
      if (r && (r.status === 201 || r.status === 200)) break;
      await new Promise((res) => setTimeout(res, 800 * (a + 1)));
    }
    if (!r || (r.status !== 201 && r.status !== 200)) throw new Error('не удалось выгрузить данные (' + (r?.status || 'сеть') + ')');
  }
  return { fileId, total, sha, z, size: bytes.length };
}
async function downloadObject(ptr) {
  if (!ptr || typeof ptr.fileId !== 'string' || !Number.isInteger(ptr.total) || ptr.total < 1 || ptr.total > 100) {
    throw new Error('bad pointer');
  }
  await ensureKeys();
  const key = await fileKeyFor(ptr.fileId);
  const salt = new Uint8Array(16);
  const parts = [];
  let len = 0;
  for (let i = 0; i < ptr.total; i++) {
    const r = await rapi('/file?fileId=' + encodeURIComponent(ptr.fileId) + '&idx=' + i, { timeout: 90000 });
    if (r.status !== 200 || !r.data.blob) throw new Error('файл синхронизации недоступен (' + r.status + ')');
    const pt = await decryptFileChunk(key, salt, i, b64u.dec(r.data.blob));
    parts.push(pt);
    len += pt.length;
  }
  let bytes = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.length;
  }
  if (ptr.z) bytes = await pipeBytes(bytes, new DecompressionStream('deflate'));
  if ((await sha256hex(bytes)) !== ptr.sha) throw new Error('контрольная сумма не сошлась');
  return JSON.parse(td.decode(bytes));
}

// ---------- Доверие: сертификаты и отзывы ----------
const isRevoked = (dev) => {
  const r = st?.items?.['rev:' + dev];
  return !!(r && !r.del);
};
function masterCandidates() {
  const out = [];
  if (me?.masterPub) out.push(me.masterPub);
  if (st?.pendingRotate?.to) out.push(st.pendingRotate.to);
  return out;
}
async function certTrusted(dev, cert, chainObj) {
  if (!dev || !cert?.sig || isRevoked(dev)) return false;
  for (const mp of masterCandidates()) {
    const k = mp + '|' + dev + '|' + cert.sig + '|' + (chainObj?.recoveryCert?.sig || '');
    if (!trustCache.has(k)) trustCache.set(k, await verifyDeviceCertClient(mp, dev, cert, chainObj || null));
    if (trustCache.get(k)) return true;
  }
  return false;
}
const revText = (masterPub, dev, ts) => `zv-sync-revoke-v1|${masterPub}|${dev}|${ts}`;
const rotText = (from, to, ts) => `zv-sync-rotate-v1|${from}|${to}|${ts}`;
// rekey подписывает администратор профиля (master или фраза): иначе
// украденное подключённое устройство могло бы «исключить» основное.
const rekeyText = (masterPub, gid, h, ts) => `zv-sync-rekey-v1|${masterPub}|${gid}|${h}|${ts}`;
// Запись реестра dev:X подписана самим устройством X (ECDH-ключ, имя,
// признак «основное»): другое устройство профиля не подменит ключ, которым
// заворачивается секрет при rekey, и не переименует чужое устройство.
const devText = (dev, ecdhPub, main, label) => `zv-sync-dev-v1|${dev}|${ecdhPub}|${main ? 1 : 0}|${label}`;
// «Основное» подтверждает master-ключ номера.
const mainText = (dev) => `zv-sync-main-v1|${dev}`;
const normLabel = (s) => String(s || 'Устройство').slice(0, 60);
async function adminProofOk(p, masterPub, text) {
  if (p.by === 'master') return verifyChatSig(masterPub, p.sig, text);
  if (p.by === 'recovery') {
    if (!p.recoveryPub || p.recoveryCert?.label !== 'recovery') return false;
    if (!(await verifyDeviceCertClient(masterPub, p.recoveryPub, p.recoveryCert, null))) return false;
    return verifyChatSig(p.recoveryPub, p.sig, text);
  }
  return false;
}
async function verifyRevProof(dev, v) {
  if (!v || !v.sig || !v.ts || !v.masterPub) return false;
  const known = [...masterCandidates(), ...(st?.pastMasters || [])];
  if (!known.includes(v.masterPub)) return false;
  const text = revText(v.masterPub, dev, v.ts);
  if (v.by === 'self') return verifyChatSig(dev, v.sig, text);
  return adminProofOk(v, v.masterPub, text);
}
async function verifyRotateProof(p) {
  if (!p || !p.from || !p.to || !p.sig || !p.ts || p.from !== me?.masterPub) return false;
  return adminProofOk(p, p.from, rotText(p.from, p.to, p.ts));
}
async function verifyRekeyAuth(b) {
  const a = b?.auth;
  if (!a || !a.sig || !a.ts || !a.masterPub || !K?.gid) return false;
  if (!masterCandidates().includes(a.masterPub)) return false;
  const h = await sha256hex(stableStringify(b.wraps || {}));
  return adminProofOk(a, a.masterPub, rekeyText(a.masterPub, K.gid, h, a.ts));
}
async function devItemOk(dev, v) {
  if (!v || typeof v !== 'object' || typeof v.label !== 'string' || !v.esig) return false;
  if (!/^[A-Za-z0-9_-]{87}$/.test(v.ecdhPub || '')) return false;
  if (!(await certTrusted(dev, v.cert, v.chain))) return false;
  const k = 'e|' + dev + '|' + v.esig + (v.main ? '|' + (v.msig || '') + '|' + masterCandidates().join(',') : '');
  if (trustCache.has(k)) return trustCache.get(k);
  let ok = await verifyChatSig(dev, v.esig, devText(dev, v.ecdhPub, v.main, v.label));
  if (ok && v.main) {
    ok = false;
    for (const mp of masterCandidates()) {
      if (v.msig && (await verifyChatSig(mp, v.msig, mainText(dev)))) {
        ok = true;
        break;
      }
    }
  }
  trustCache.set(k, ok);
  return ok;
}
// Удалённые ключи реестра принимаются только с проверяемой подписью:
// dev:X — с сертификатом от master и подписью самого X; удаление dev:X —
// только вместе с подписанным отзывом rev:X (или после него).
async function acceptRemote(items) {
  const out = {};
  const list = Object.entries(items || {}).filter(([, it]) => it && typeof it === 'object' && Number.isFinite(it.u));
  for (const [key, it] of list) {
    if (!key.startsWith('rev:')) continue;
    if (it.del || !(await verifyRevProof(key.slice(4), it.v))) continue;
    out[key] = it;
  }
  for (const [key, it] of list) {
    if (key.startsWith('rev:')) continue;
    if (key.startsWith('dev:')) {
      const dev = key.slice(4);
      if (it.del ? !out['rev:' + dev] && !isRevoked(dev) : !(await devItemOk(dev, it.v))) continue;
    }
    out[key] = it;
  }
  return out;
}

// ---------- Локальное представление синхронизируемых данных ----------
function callView(v) {
  const out = {};
  for (const k of ['ts', 'dir', 'name', 'outcome', 'dur', 'route', 'fp', 'kind', 'q', 'mos', 'rtt', 'loss']) {
    if (v[k] !== undefined && v[k] !== null && typeof v[k] !== 'object') out[k] = v[k];
  }
  return out;
}
async function buildView() {
  const view = {};
  for (const { value: rec } of await kvAll('rooms')) {
    if (!rec?.seedEnc || !rec.roomId || rec.syncLocalOnly) continue;
    try {
      const v = {
        seed: await decryptWithVault(rec.seedEnc),
        nick: rec.nick || '',
        pp: !!rec.pinProtected,
        keep: !!rec.keepForever,
        createdAt: rec.createdAt || 0,
        creator: rec.creatorPub || null,
      };
      if (rec.pinEnc) {
        try {
          v.pin = await decryptWithVault(rec.pinEnc);
        } catch {}
      }
      if (rec.alias?.code && rec.alias.adminEnc) {
        try {
          v.alias = { code: rec.alias.code, admin: await decryptWithVault(rec.alias.adminEnc), scheme: rec.alias.scheme || null };
        } catch {}
      }
      if (rec.word?.phraseEnc && rec.word.adminEnc && (rec.word.exp || 0) > Date.now()) {
        try {
          v.word = {
            phrase: await decryptWithVault(rec.word.phraseEnc),
            admin: await decryptWithVault(rec.word.adminEnc),
            exp: rec.word.exp || 0,
            scheme: rec.word.scheme || null,
          };
        } catch {}
      }
      view['room:' + rec.roomId] = v;
      if ((rec.lastReadSeq || 0) > 0) view['read:' + rec.roomId] = rec.lastReadSeq;
      const eps = (rec.epochs || [])
        .filter((e) => e && e.n > 0 && e.secret)
        .map((e) => ({ n: e.n, secret: e.secret, ts: e.ts || 0 }));
      if (eps.length) view['ep:' + rec.roomId] = eps;
    } catch {}
  }
  const app = appHooks();
  if (app?.contactsView) {
    try {
      Object.assign(view, await app.contactsView());
    } catch {}
  }
  for (const name of SYNC_SETTINGS) {
    try {
      const v = localStorage.getItem(name);
      if (v !== null) view['set:' + name] = v;
    } catch {}
  }
  const cutoff = Date.now() - JOURNAL_TTL_MS;
  for (const { key, value } of await kvAll('calls')) {
    if (value && value.ts > cutoff) view['call:' + key] = callView(value);
  }
  return view;
}

// ---------- Применение удалённых изменений ----------
async function applyRoom(id, v) {
  const hooks = chatHooks();
  if (!hooks || !v?.seed) return false;
  const rec = await kvGet('rooms', id);
  if (!rec) {
    // Новая для этого устройства комната: seed обязан выводить ровно этот
    // roomId (с PIN — с PIN), иначе запись битая или подложная.
    const seedBytes = b64u.dec(v.seed);
    let pinIkm = null;
    if (v.pin) pinIkm = await derivePinIkm(v.pin, seedBytes);
    else if (v.pp) return false;
    const keys = await deriveChatKeys(seedBytes, { pinIkm });
    if (keys.roomId !== id) return false;
    const next = normalizeRoomRecord({
      roomId: id,
      seedEnc: await encryptWithVault(v.seed),
      nick: v.nick || '',
      epoch: 0,
      lastSeq: 0,
      lastReadSeq: 0,
      members: {},
      introSent: false,
      createdAt: v.createdAt || 0,
    });
    // linkImport: комната пришла синхронизацией — chat.js представит это
    // устройство в ней сам (dial → intro → ecdh) и не покажет старую
    // историю, которую не может расшифровать (histFloor).
    next.linkImport = true;
    next.histMode = st && st.histMode && Date.now() - (st.joinedAt || 0) < 3600000 ? st.histMode : 'server';
    next.healV = 38;
    next.creatorPub = v.creator || null;
    next.metaSent = true;
    next.keepForever = !!v.keep;
    next.pinProtected = !!v.pp;
    if (v.pin) next.pinEnc = await encryptWithVault(v.pin);
    if (v.alias?.code) {
      next.alias = { code: v.alias.code, adminEnc: await encryptWithVault(v.alias.admin), scheme: v.alias.scheme ?? null, createdAt: Date.now() };
    }
    if (v.word?.phrase) {
      next.word = {
        phraseEnc: await encryptWithVault(v.word.phrase),
        adminEnc: await encryptWithVault(v.word.admin),
        exp: v.word.exp || 0,
        scheme: v.word.scheme ?? null,
      };
    }
    await hooks.saveNewRoom(next);
    return true;
  }
  const patch = { nick: v.nick || rec.nick || '', keepForever: !!v.keep };
  if (v.creator && !rec.creatorPub) patch.creatorPub = v.creator;
  if (v.pin && !rec.pinEnc) {
    patch.pinEnc = await encryptWithVault(v.pin);
    patch.pinProtected = true;
  }
  const curAlias = rec.alias?.code || null;
  if ((v.alias?.code || null) !== curAlias) {
    patch.alias = v.alias?.code
      ? { code: v.alias.code, adminEnc: await encryptWithVault(v.alias.admin), scheme: v.alias.scheme ?? null, createdAt: Date.now() }
      : null;
  }
  let curPhrase = null;
  if (rec.word?.phraseEnc) {
    try {
      curPhrase = await decryptWithVault(rec.word.phraseEnc);
    } catch {}
  }
  if ((v.word?.phrase || null) !== curPhrase) {
    patch.word = v.word?.phrase
      ? {
          phraseEnc: await encryptWithVault(v.word.phrase),
          adminEnc: await encryptWithVault(v.word.admin),
          exp: v.word.exp || 0,
          scheme: v.word.scheme ?? null,
        }
      : null;
  }
  await hooks.patchRoom(id, patch);
  return true;
}
function applySetting(name, v) {
  if (!SYNC_SETTINGS.includes(name)) return true;
  try {
    if (v === null || v === undefined) localStorage.removeItem(name);
    else localStorage.setItem(name, String(v));
  } catch {}
  emit('zv-settings-synced', { name });
  return true;
}
async function applyKey(key, it) {
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  const del = !!it.del;
  const v = it.v;
  const ch = chatHooks();
  const app = appHooks();
  switch (kind) {
    case 'room':
      if (!ch) return false;
      if (del) {
        await ch.removeRoom(id);
        return true;
      }
      return applyRoom(id, v);
    case 'read':
      if (del) return true;
      if (!ch) return false;
      return (await ch.markRead(id, Number(v) || 0)) !== false;
    case 'ep':
      if (del) return true;
      if (!ch) return false;
      return (await ch.epochs(id, Array.isArray(v) ? v : [])) !== false;
    case 'contact':
      if (!app?.contactApply) return false;
      return (await app.contactApply(id, del ? null : v)) !== false;
    case 'set':
      return applySetting(id, del ? null : v);
    case 'call':
      if (del) await kvDel('calls', id).catch(() => {});
      else await kvPut('calls', id, { ...v });
      emit('zv-journal-synced');
      return true;
    case 'dev':
      return true;
    case 'rev':
      if (id === me?.devicePub && !del) {
        setTimeout(() => selfRevoked(v?.by || ''), 0);
      }
      return true;
    default:
      return true;
  }
}
async function mergeRemote(remoteItems) {
  const filtered = await acceptRemote(remoteItems);
  const { items, applied } = mergeItems(st.items, filtered);
  st.items = items;
  let rooms = false;
  let registry = false;
  for (const key of applied) {
    let ok = false;
    try {
      ok = await applyKey(key, items[key]);
    } catch (e) {
      console.warn('sync apply', key, e);
      ok = false;
    }
    if (ok === false) st.unapplied[key] = 1;
    else delete st.unapplied[key];
    if (/^(room|read|ep):/.test(key)) rooms = true;
    if (/^(dev|rev):/.test(key)) registry = true;
  }
  await saveState();
  if (rooms) chatHooks()?.roomsChanged?.();
  if (registry) {
    publishProfileView();
    emit('zv-devices-changed');
    scheduleRender();
    // Новый отзыв чужого устройства: переключить секрет синхронизации
    // может только основное устройство / владелец фразы (как MLS-commit).
    const newRev = applied.filter((k) => k.startsWith('rev:') && k.slice(4) !== me.devicePub);
    if (newRev.length && !st.rekeyFor?.[newRev[0]]) {
      const admin = await adminSigner().catch(() => null);
      if (admin) {
        st.rekeyFor = { ...(st.rekeyFor || {}), [newRev[0]]: Date.now() };
        await saveState();
        setTimeout(() => serial(() => doRekey({})).catch(() => {}), 1500 + Math.random() * 3000);
      }
    }
  }
  return applied.length;
}
async function retryUnapplied() {
  const keys = Object.keys(st.unapplied || {});
  if (!keys.length) return;
  for (const key of keys) {
    const it = st.items[key];
    if (!it) {
      delete st.unapplied[key];
      continue;
    }
    let ok = false;
    try {
      ok = await applyKey(key, it);
    } catch {}
    if (ok !== false) delete st.unapplied[key];
  }
  await saveState();
  chatHooks()?.roomsChanged?.();
}

// ---------- Приём сообщений комнаты синхронизации ----------
function noteSeen(dev, ts) {
  if (!dev || !Number.isFinite(ts)) return;
  if ((st.seen[dev] || 0) < ts) st.seen[dev] = Math.min(ts, Date.now());
}
async function processMsg(m) {
  let env = null;
  try {
    env = await decryptChatMessage(K.roomKey, b64u.dec(m.blob));
  } catch {}
  if (!env || env.v !== 1 || typeof env.t !== 'string' || typeof env.dev !== 'string' || !env.sig) return null;
  if (!(await verifyChatSig(env.dev, env.sig, await envText(env)))) return null;
  const self = env.dev === me.devicePub;
  if (!self && !(await certTrusted(env.dev, env.cert, env.chain))) return null;
  if (!self) noteSeen(env.dev, env.ts);
  const body = env.body || {};
  if (env.t === 'rekey') return handleRekey(env, self);
  if (self) return null;
  if (env.t === 'delta') await mergeRemote(body.items);
  else if (env.t === 'snap') await handleSnap(body, env.dev);
  else if (env.t === 'need') wantFull = true;
  // История — только от устройства, которое нас подключило, и один раз.
  else if (env.t === 'hist' && body.for === me.devicePub && env.dev === st.addedBy && st.histExpected && !st.histDone) {
    await handleHist(body);
  }
  if (env.t === 'snap') {
    st.sawSnap = true;
    st.awaitSnap = false;
  }
  return null;
}
async function handleSnap(ptr, author) {
  let snap = null;
  try {
    snap = await downloadObject(ptr);
  } catch (e) {
    console.warn('sync snap', e);
    return;
  }
  if (!snap || snap.v !== 1 || !snap.items) return;
  if (snap.ident?.masterPub && snap.ident.masterPub !== me.masterPub) {
    await maybeApplyRotation(snap.ident, snap.items, author);
  }
  await mergeRemote(snap.items);
}
async function handleHist(ptr) {
  let data = null;
  try {
    data = await downloadObject(ptr);
  } catch (e) {
    console.warn('sync hist', e);
    return;
  }
  const ch = chatHooks();
  if (!data?.rooms || !ch?.importHistory) return;
  try {
    await ch.importHistory(data);
  } catch (e) {
    console.warn('sync hist import', e);
  }
  st.histDone = true;
  await saveState();
}
async function handleRekey(env, self) {
  const b = env.body || {};
  // Чужой rekey без подписи администратора профиля игнорируется (в т.ч.
  // «исключение» этого устройства): так поступило бы украденное устройство.
  if (!self && !(await verifyRekeyAuth(b))) return null;
  const wrap = b.wraps?.[me.devicePub];
  if (!wrap) {
    if (!self) {
      st.excluded = { ts: env.ts, by: env.dev };
      await saveState();
      scheduleRender();
      emit('zv-devices-changed');
    }
    return 'stop';
  }
  if (b.rotate && !self && !(await verifyRotateProof(b.rotate))) return null;
  const e = await getChatDeviceEcdh();
  const seed = await unwrapEpochSecret(e.ecdhPriv, wrap, REKEY_LABEL, 0);
  if (!seed) return null;
  st.pastRooms = [...(st.pastRooms || []), K.roomId].slice(-4);
  st.seedEnc = await encryptWithVault(b64u.enc(seed));
  st.gen = 0;
  st.lastSeq = 0;
  st.initedRoom = null;
  st.sawSnap = false;
  st.needAt = Date.now();
  if (b.rotate && !self) st.pendingRotate = { from: b.rotate.from, to: b.rotate.to, by: env.dev };
  if (self) wantFull = true;
  await saveState();
  await ensureKeys();
  return 'switched';
}
// Новый номер (секрет) принимается только из снимка того устройства, что
// сменило номер (автор подписанного rekey): другое устройство профиля не
// подсунет «свой» секрет.
async function maybeApplyRotation(ident, items, author) {
  const pr = st.pendingRotate;
  if (!pr || pr.to !== ident.masterPub || typeof ident.secret !== 'string' || !ident.secret) return false;
  if (pr.by && author !== pr.by) return false;
  const mine = items?.['dev:' + me.devicePub];
  if (!mine || mine.del || !mine.v?.cert) return false;
  if (!(await verifyDeviceCertClient(ident.masterPub, me.devicePub, mine.v.cert, mine.v.chain || null))) return false;
  const prevMaster = me.masterPub;
  await applyRotatedIdentity({ masterPub: ident.masterPub, secret: ident.secret, cert: mine.v.cert, chain: mine.v.chain || null });
  st.pastMasters = [...(st.pastMasters || []), prevMaster].slice(-4);
  st.pendingRotate = null;
  trustCache.clear();
  await refreshMe();
  await saveState();
  emit('zv-identity-changed', { reason: 'rotated' });
  return true;
}

async function pullAll() {
  for (let guard = 0; guard < 30; guard++) {
    await ensureRoomInit();
    let r;
    try {
      r = await rapi('/fetch?after=' + (st.lastSeq || 0));
    } catch {
      return false;
    }
    if (r.status === 410) {
      await roomGone();
      continue;
    }
    if (r.status !== 200) return false;
    const list = Array.isArray(r.data.messages) ? r.data.messages : [];
    let switched = false;
    for (const m of list) {
      const res = await processMsg(m).catch((e) => {
        console.warn('sync msg', e);
        return null;
      });
      if (stopped) return false;
      if (res === 'stop') {
        st.lastSeq = m.seq;
        await saveState();
        return false;
      }
      if (res === 'switched') {
        switched = true;
        break;
      }
      st.lastSeq = Math.max(st.lastSeq || 0, m.seq || 0);
    }
    await saveState();
    if (switched) continue;
    if (list.length) {
      rapi('/ack', { method: 'POST', body: { seqs: [st.lastSeq], dev: me.devicePub } }).catch(() => {});
    }
    if (list.length < 500) break;
  }
  // Новая комната (после rekey) без снимка — просим его у остальных.
  if (st.needAt && !st.sawSnap && Date.now() - st.needAt > 20000 && !wantFull) {
    st.needAt = 0;
    await saveState();
    await post('need', {}).catch(() => {});
  }
  return true;
}

// ---------- Публикация своих изменений ----------
async function selfDevValue() {
  const e = await getChatDeviceEcdh();
  const label = normLabel(st.label || deviceLabelFromUA(navigator.userAgent));
  const main = !!me.masterPriv;
  // Подписи кэшируются: ECDSA недетерминирована, а запись не должна
  // «меняться» при каждом сравнении.
  const text = devText(me.devicePub, e.ecdhPub, main, label);
  if (st.esig?.text !== text) st.esig = { text, sig: await signWithKey(me.devicePriv, text) };
  const v = {
    label,
    ecdhPub: e.ecdhPub,
    esig: st.esig.sig,
    cert: me.cert,
    chain: me.chain || null,
    main,
    addedAt: st.joinedAt || Date.now(),
    addedBy: st.addedBy || null,
  };
  if (main) {
    const mt = me.masterPub + '|' + mainText(me.devicePub);
    if (st.msig?.text !== mt) st.msig = { text: mt, sig: await signWithKey(me.masterPriv, mainText(me.devicePub)) };
    v.msig = st.msig.sig;
  }
  return v;
}
function localSet(key, v) {
  const prev = st.items[key];
  const u = Math.max(Date.now(), (prev?.u || 0) + 1);
  st.items[key] = v === null ? { u, d: shortDev(me.devicePub), del: 1 } : { u, d: shortDev(me.devicePub), v };
  pendingKeys.add(key);
}
async function ensureSelfDevItem() {
  const v = await selfDevValue();
  const key = 'dev:' + me.devicePub;
  const prev = st.items[key];
  if (prev && !prev.del && sameValue(prev.v, v)) return;
  localSet(key, v);
}
function otherDevs() {
  const out = [];
  for (const [k, it] of Object.entries(st?.items || {})) {
    if (!k.startsWith('dev:') || !it || it.del) continue;
    const dev = k.slice(4);
    if (dev === me?.devicePub || isRevoked(dev)) continue;
    out.push(dev);
  }
  return out;
}
async function commitAndPublish({ force = false } = {}) {
  // Только что подключённое устройство сначала принимает снимок профиля:
  // иначе его «пустое» или гостевое состояние (имя, настройки) оказалось
  // бы новее и перетёрло профиль на всех устройствах.
  if (st.awaitSnap) return;
  const view = await buildView();
  const scope = (k) => !k.startsWith('dev:') && !k.startsWith('rev:') && !st.unapplied[k];
  const dropKey = (k, prev) => k.startsWith('call:') && (prev.v?.ts || 0) < Date.now() - JOURNAL_TTL_MS;
  const { items, changed } = commitLocal(st.items, view, shortDev(me.devicePub), Date.now(), { scope, dropKey });
  st.items = items;
  await ensureSelfDevItem();
  const keys = [...new Set([...changed, ...pendingKeys])];
  pendingKeys.clear();
  await saveState();
  if (!otherDevs().length && !force) return; // одно устройство — синхронизировать не с кем
  if (wantFull || force || !st.lastFullAt || Date.now() - st.lastFullAt > FULL_EVERY_MS) return publishFull();
  if (!keys.length) return;
  const chunks = chunkDelta(pickItems(st.items, keys), DELTA_MAX_BYTES);
  if (!chunks || chunks.length > 6) return publishFull();
  for (const c of chunks) await post('delta', { items: c });
}
async function publishFull() {
  const snap = { v: 1, ts: Date.now(), ident: { masterPub: me.masterPub, secret: me.secret }, items: st.items };
  const ptr = await uploadObject(snap);
  await post('snap', ptr);
  st.lastFullAt = Date.now();
  wantFull = false;
  await saveState();
}

// ---------- Цикл ----------
async function syncCycle({ force = false } = {}) {
  if (stopped || !st || !me) return;
  if (!(await hasPersonal())) return;
  const ok = await pullAll();
  if (stopped) return;
  await retryUnapplied();
  if (ok || force) await commitAndPublish({ force });
  st.lastSyncAt = Date.now();
  await saveState();
  scheduleRender();
  liveConnect();
}

// ---------- Живой канал (пока приложение открыто) ----------
// WebSocket комнаты синхронизации (Hibernation API: простаивающий сокет
// серверу ничего не стоит). Сервер сообщает «пришло новое» и кто из своих
// устройств сейчас в сети; содержимое по-прежнему забирается /fetch и
// проверяется подписями. Без сокета работает опрос раз в 45 с.
let live = null;
let liveBackoff = 2000;
let liveTimer = 0;
let liveKick = 0;
let liveOnline = new Set();
function wantLive() {
  return !!st && !stopped && !st.excluded && !!me && otherDevs().length > 0 && document.visibilityState === 'visible';
}
function liveClose() {
  clearTimeout(liveTimer);
  const s = live;
  live = null;
  if (liveOnline.size) {
    liveOnline = new Set();
    scheduleRender();
  }
  if (s) {
    try {
      s.close();
    } catch {}
  }
}
function liveRetry() {
  clearTimeout(liveTimer);
  if (!wantLive()) return;
  liveTimer = setTimeout(() => {
    ensureKeys()
      .then(liveConnect)
      .catch(() => {});
  }, liveBackoff);
  liveBackoff = Math.min(60000, liveBackoff * 2);
}
function liveConnect() {
  if (!wantLive() || !K || typeof WebSocket !== 'function') {
    if (!wantLive()) liveClose();
    return;
  }
  if (live && live.zvRoom === K.roomId && live.readyState <= 1) return;
  liveClose();
  const room = K.roomId;
  const token = K.token;
  let s;
  try {
    s = new WebSocket(base().replace(/^http/, 'ws') + '/chat/' + room + '/listen');
  } catch {
    liveRetry();
    return;
  }
  s.zvRoom = room;
  live = s;
  s.onopen = () => {
    liveBackoff = 2000;
    try {
      s.send(JSON.stringify({ type: 'auth', token, dev: me.devicePub }));
    } catch {}
  };
  s.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === 'msg') {
      clearTimeout(liveKick);
      liveKick = setTimeout(() => syncNow(), 300);
    } else if (m.type === 'ready') {
      liveOnline = new Set((Array.isArray(m.online) ? m.online : []).filter((d) => d !== me?.devicePub));
      scheduleRender();
      if ((m.lastSeq || 0) > (st?.lastSeq || 0)) syncNow();
    } else if (m.type === 'presence' && typeof m.dev === 'string') {
      if (m.online) liveOnline.add(m.dev);
      else liveOnline.delete(m.dev);
      scheduleRender();
    }
  };
  s.onclose = () => {
    if (live !== s) return;
    live = null;
    liveRetry();
  };
  s.onerror = () => {
    try {
      s.close();
    } catch {}
  };
}
export function syncNow(opts = {}) {
  if (!st || stopped) return Promise.resolve();
  return serial(() => syncCycle(opts)).catch((e) => console.warn('sync', e));
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (stopped || !st) return;
  const ms = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
  pollTimer = setTimeout(() => {
    syncNow().finally(schedulePoll);
  }, ms);
}
export function notifyLocalChange() {
  if (!st || stopped) return;
  clearTimeout(pubTimer);
  pubTimer = setTimeout(() => syncNow(), PUBLISH_DEBOUNCE_MS);
}

// Запуск на устройстве с личностью. Без состояния синхронизации (одно
// устройство, ни разу не подключали другие) — сеть не трогаем вовсе.
export async function startDevices() {
  if (started) return;
  if (!(await hasPersonal())) return;
  started = true;
  await refreshMe();
  await loadState();
  publishProfileView();
  scheduleRender();
  emit('zv-devices-changed', { initial: true });
  if (!st) return;
  if (st.excluded) return;
  stopped = false;
  await syncNow();
  schedulePoll();
}
function stopSync() {
  stopped = true;
  clearTimeout(pollTimer);
  clearTimeout(pubTimer);
  liveClose();
}

// Основное устройство при первой привязке создаёт состояние синхронизации.
async function ensureSyncState() {
  if (st) return st;
  st = {
    v: 1,
    seedEnc: await encryptWithVault(b64u.enc(crypto.getRandomValues(new Uint8Array(32)))),
    gen: 0,
    items: {},
    unapplied: {},
    seen: {},
    lastSeq: 0,
    joinedAt: Date.now(),
    label: deviceLabelFromUA(navigator.userAgent),
    createdAt: Date.now(),
  };
  await saveState();
  stopped = false;
  return st;
}

// ---------- Rekey (MLS-подобная смена секрета группы своих устройств) ----------
// Новый seed заворачивается ECDH-ключом каждого оставшегося устройства;
// сообщение уходит в СТАРУЮ комнату, все (и автор) переходят по первому
// валидному rekey в порядке сервера. Отвязанное устройство завёртки не
// получает и новых синхронизаций не читает.
async function doRekey({ rotate = null, as = null, signer = null } = {}) {
  if (!st || !me) return;
  const admin = signer || (await adminSigner());
  if (!admin) throw new Error('сменить секрет синхронизации может основное устройство или устройство с фразой восстановления');
  await ensureRoomInit();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const wraps = {};
  const mine = await getChatDeviceEcdh();
  wraps[me.devicePub] = await wrapEpochSecret(null, b64u.dec(mine.ecdhPub), seed, REKEY_LABEL, 0);
  for (const dev of otherDevs()) {
    const pub = st.items['dev:' + dev]?.v?.ecdhPub;
    if (!pub || !/^[A-Za-z0-9_-]{87}$/.test(pub)) continue;
    wraps[dev] = await wrapEpochSecret(null, b64u.dec(pub), seed, REKEY_LABEL, 0);
  }
  // Подпись администратора над завёртками и группой (gid): получатели
  // проверяют её по master, который знают сейчас (при смене номера — по
  // старому, rotate.from).
  const ts = Date.now();
  const masterPub = rotate ? rotate.from : me.masterPub;
  const h = await sha256hex(stableStringify(wraps));
  const auth = { by: admin.kind, masterPub, ts, sig: await admin.sign(rekeyText(masterPub, K.gid, h, ts)) };
  if (admin.kind === 'recovery') {
    auth.recoveryPub = admin.extra.recoveryPub;
    auth.recoveryCert = admin.extra.recoveryCert;
  }
  await post('rekey', { wraps, auth, ...(rotate ? { rotate } : {}) }, as);
  wantFull = true;
  await pullAll(); // переход — по общему правилу «первый rekey побеждает»
  await commitAndPublish({ force: true });
}

// ---------- Отвязка ----------
async function topicsOf(bundle) {
  const out = [];
  try {
    out.push((await deriveRoom(bundle.secret)).topic);
  } catch {}
  if (bundle.masterPub) out.push('chatdial-' + (await sha256hex(b64u.dec(bundle.masterPub))));
  return out;
}
// Отвязать чужое устройство: только основное или владелец фразы.
export async function revokeDevice(dev) {
  return serial(async () => {
    await refreshMe();
    const admin = await adminSigner();
    if (!admin) throw new Error('отвязывать другие устройства может основное устройство или устройство с фразой восстановления');
    if (!st) throw new Error('синхронизация не настроена');
    const topics = await topicsOf(me);
    for (const t of topics) {
      await inboxRevoke(base(), t, dev, admin.kind, admin.sign, admin.extra).catch(() => null);
    }
    const ts = Date.now();
    const proof = { ts, by: admin.kind, masterPub: me.masterPub, sig: await admin.sign(revText(me.masterPub, dev, ts)) };
    if (admin.kind === 'recovery') {
      proof.recoveryPub = admin.extra.recoveryPub;
      proof.recoveryCert = admin.extra.recoveryCert;
    }
    localSet('rev:' + dev, proof);
    localSet('dev:' + dev, null);
    await saveState();
    publishProfileView();
    // Сначала — дельта в старую комнату (отвязанное устройство увидит отзыв
    // и сотрёт себя), затем rekey без него.
    const chunks = chunkDelta(pickItems(st.items, ['rev:' + dev, 'dev:' + dev]), DELTA_MAX_BYTES) || [];
    pendingKeys.delete('rev:' + dev);
    pendingKeys.delete('dev:' + dev);
    for (const c of chunks) await post('delta', { items: c });
    st.rekeyFor = { ...(st.rekeyFor || {}), [dev]: Date.now() };
    await saveState();
    await doRekey({});
    scheduleRender();
    emit('zv-devices-changed');
  });
}
// Отвязать ЭТО устройство (вызывающий затем стирает локальные данные).
export async function unlinkSelf() {
  return serial(async () => {
    await refreshMe();
    if (!me) return;
    const sign = (t) => signWithKey(me.devicePriv, t);
    for (const t of await topicsOf(me)) {
      await inboxRevoke(base(), t, me.devicePub, 'self', sign).catch(() => null);
    }
    if (!st) return;
    const ts = Date.now();
    localSet('rev:' + me.devicePub, { ts, by: 'self', masterPub: me.masterPub, sig: await sign(revText(me.masterPub, me.devicePub, ts)) });
    localSet('dev:' + me.devicePub, null);
    const chunks = chunkDelta(pickItems(st.items, ['rev:' + me.devicePub, 'dev:' + me.devicePub]), DELTA_MAX_BYTES) || [];
    for (const c of chunks) await post('delta', { items: c }).catch(() => {});
    stopSync();
  });
}
// Отзыв пришёл от основного устройства (или мы сами) — устройство стирает себя.
let revokedHandled = false;
async function selfRevoked(by) {
  if (revokedHandled) return;
  revokedHandled = true;
  stopSync();
  emit('zv-device-revoked', { by });
}

// ---------- Смена номера на основном устройстве ----------
// keep — устройства, которые остаются в профиле (получат новый номер и
// сертификаты нового master); остальные отвязываются.
export function rotationCandidates() {
  return otherDevs().map((dev) => ({ dev, label: st.items['dev:' + dev]?.v?.label || 'Устройство', seenAt: st.seen?.[dev] || 0 }));
}
export async function rotateWithDevices(rotateFn, keep) {
  return serial(async () => {
    await refreshMe();
    const oldAdmin = await adminSigner();
    const others = st ? otherDevs() : [];
    if (!others.length || !st) return rotateFn();
    if (!oldAdmin) throw new Error('сменить номер может основное устройство или устройство с фразой восстановления');
    const drop = others.filter((d) => !keep.includes(d));
    // 1) Отзыв исключённых (по старому master, пока он у нас в памяти).
    for (const dev of drop) {
      const ts = Date.now();
      const proof = { ts, by: oldAdmin.kind, masterPub: me.masterPub, sig: await oldAdmin.sign(revText(me.masterPub, dev, ts)) };
      if (oldAdmin.kind === 'recovery') {
        proof.recoveryPub = oldAdmin.extra.recoveryPub;
        proof.recoveryCert = oldAdmin.extra.recoveryCert;
      }
      localSet('rev:' + dev, proof);
      localSet('dev:' + dev, null);
    }
    if (drop.length) {
      const chunks = chunkDelta(pickItems(st.items, drop.flatMap((d) => ['rev:' + d, 'dev:' + d])), DELTA_MAX_BYTES) || [];
      for (const c of chunks) await post('delta', { items: c }).catch(() => {});
    }
    const prevMaster = me.masterPub;
    // Старый сертификат устройства — для подписи rekey: оставшиеся устройства
    // ещё знают только старый master и проверят автора по нему.
    const oldAs = { cert: me.cert, chain: me.chain || null };
    // 2) Новый номер на этом устройстве.
    const result = await rotateFn();
    await refreshMe();
    // 3) Новые сертификаты оставшимся устройствам — от нового master.
    const admin = await adminSigner();
    for (const dev of keep) {
      const it = st.items['dev:' + dev];
      if (!it || it.del) continue;
      const { cert, chain: ch } = await admin.issue(dev);
      localSet('dev:' + dev, { ...it.v, cert, chain: ch || null });
    }
    // 4) Доказательство смены номера подписью СТАРОГО master + rekey.
    const ts = Date.now();
    const rotate = { from: prevMaster, to: me.masterPub, ts, by: oldAdmin.kind, sig: await oldAdmin.sign(rotText(prevMaster, me.masterPub, ts)) };
    if (oldAdmin.kind === 'recovery') {
      rotate.recoveryPub = oldAdmin.extra.recoveryPub;
      rotate.recoveryCert = oldAdmin.extra.recoveryCert;
    }
    st.pastMasters = [...(st.pastMasters || []), prevMaster].slice(-4);
    trustCache.clear();
    await saveState();
    await doRekey({ rotate, as: oldAs, signer: oldAdmin });
    publishProfileView();
    scheduleRender();
    return result;
  });
}

// ---------- История для нового устройства (как перенос истории Signal) ----------
// Основное устройство выгружает расшифрованную ленту последних 45 дней
// (без служебных сообщений и заглушек) зашифрованным файлом комнаты
// синхронизации; новое устройство вливает её у себя (chat.js importHistory).
async function exportHistoryFor(dev) {
  const cutoff = Date.now() - HIST_DAYS * 86400000;
  const rooms = {};
  let bytes = 0;
  let total = 0;
  for (const { value: rec } of await kvAll('rooms')) {
    if (!rec?.roomId || !rec.seedEnc || rec.syncLocalOnly) continue;
    const rows = await kvPrefix('messages', rec.roomId + ':');
    const entries = [];
    for (const { value: e } of rows) {
      const m = e?.msg;
      if (!m || !e.hash || e.local || m.ratchetMiss || m.undecrypted) continue;
      if (HIST_SKIP_TYPES.has(m.type)) continue;
      if ((m.ts || 0) < cutoff) continue;
      if (e.expiresAt && e.expiresAt <= Date.now()) continue;
      const { roomId, ...rest } = e;
      entries.push(rest);
    }
    entries.sort((a, b) => (a.seq || 0) - (b.seq || 0) || (a.msg.ts || 0) - (b.msg.ts || 0));
    const pick = entries.slice(-HIST_MAX_PER_ROOM);
    const size = te.encode(JSON.stringify(pick)).length;
    if (bytes + size > HIST_MAX_BYTES) continue;
    bytes += size;
    total += pick.length;
    rooms[rec.roomId] = {
      entries: pick,
      st: {
        lastSeq: rec.lastSeq || 0,
        lastReadSeq: rec.lastReadSeq || 0,
        members: rec.members || {},
        seenDevices: rec.seenDevices || {},
        creatorPub: rec.creatorPub || null,
        pinned: rec.pinned || null,
        ttlSec: rec.ttlSec || 0,
      },
    };
  }
  const ptr = await uploadObject({ v: 1, ts: Date.now(), rooms });
  await post('hist', { for: dev, ...ptr });
  return total;
}

// ---------- Интерфейс: список устройств ----------
const RU = 'ru-RU';
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(RU, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
function fmtAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 120000) return 'только что';
  if (d < 3600000) return Math.round(d / 60000) + ' мин назад';
  if (d < 86400000) return Math.round(d / 3600000) + ' ч назад';
  return fmtDate(ts);
}
let renderTimer = 0;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderDevicesCard().catch((e) => console.warn('devices ui', e));
  }, 50);
}
// Кнопка с подтверждением вторым нажатием (как «Стереть всё»).
function armedButton(text, armedText, cls, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small ' + cls;
  b.textContent = text;
  b.onclick = async () => {
    if (!b.dataset.armed) {
      b.dataset.armed = '1';
      b.textContent = armedText;
      setTimeout(() => {
        if (b.isConnected && b.dataset.armed && !b.disabled) {
          delete b.dataset.armed;
          b.textContent = text;
        }
      }, 6000);
      return;
    }
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      devNote('Не получилось: ' + (e?.message || e));
      b.disabled = false;
      delete b.dataset.armed;
      b.textContent = text;
    }
  };
  return b;
}
function devNote(text) {
  const n = $('#devicesNote');
  if (n) n.textContent = text || '';
}
function mainLabel() {
  for (const [k, it] of Object.entries(st?.items || {})) {
    if (k.startsWith('dev:') && it && !it.del && it.v?.main) return it.v.label || 'Основное устройство';
  }
  return '';
}
async function renderDevicesCard() {
  const card = $('#devicesCard');
  if (!card) return;
  if (!me || !(await hasPersonal())) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const admin = await adminSigner().catch(() => null);
  const rows = [
    {
      dev: me.devicePub,
      self: true,
      label: st?.label || deviceLabelFromUA(navigator.userAgent),
      main: !!me.masterPriv,
      addedAt: st?.joinedAt || 0,
      seenAt: 0,
    },
  ];
  for (const dev of st ? otherDevs() : []) {
    const v = st.items['dev:' + dev]?.v || {};
    rows.push({ dev, self: false, label: v.label || 'Устройство', main: !!v.main, addedAt: v.addedAt || 0, seenAt: st.seen?.[dev] || 0 });
  }
  const list = $('#devicesList');
  if (list) {
    list.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement('li');
        li.className = 'device-row' + (r.self ? ' self' : '');
        li.dataset.dev = r.dev;
        const ic = document.createElement('span');
        ic.className = 'device-ic';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'ic');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', /iPhone|iPad|Android|телефон|планшет/i.test(r.label) ? '#i-phone-dev' : '#i-laptop');
        svg.append(use);
        ic.append(svg);
        const main = document.createElement('span');
        main.className = 'device-main';
        const b = document.createElement('b');
        b.textContent = r.label;
        const meta = document.createElement('span');
        meta.className = 'device-meta';
        const bits = [];
        if (r.self) bits.push('это устройство');
        if (r.main) bits.push('основное');
        if (r.addedAt && !r.main) bits.push('подключено ' + fmtDate(r.addedAt));
        if (!r.self) bits.push(liveOnline.has(r.dev) ? 'в сети' : r.seenAt ? 'активно ' + fmtAgo(r.seenAt) : 'ещё не синхронизировалось');
        bits.push('ключ …' + r.dev.slice(-6));
        meta.textContent = bits.join(' · ');
        main.append(b, meta);
        li.append(ic, main);
        if (!r.self && admin) {
          li.append(
            armedButton('Отвязать', 'Точно отвязать?', 'ghost danger', async () => {
              devNote('Отвязываем…');
              await revokeDevice(r.dev);
              devNote(`Устройство «${r.label}» отвязано: оно сотрёт данные профиля при следующем выходе в сеть и больше не получит синхронизацию.`);
            })
          );
        } else if (r.self && !r.main && st && rows.length > 1) {
          li.append(
            armedButton('Отвязать', 'Стереть и отвязать?', 'ghost danger', async () => {
              devNote('Отвязываем…');
              await unlinkSelf();
              emit('zv-device-revoked', { by: 'self' });
            })
          );
        }
        return li;
      })
    );
  }
  const linkBtn = $('#btnLinkDevice');
  const hint = $('#devicesHint');
  linkBtn?.classList.toggle('hidden', !admin || !!st?.excluded);
  if (hint) {
    let t = '';
    if (!admin) {
      const ml = mainLabel();
      t =
        'Подключать новые устройства, отвязывать их и менять номер можно только на основном устройстве' +
        (ml ? ` («${ml}»)` : '') +
        ' или на устройстве, где введена фраза восстановления.';
    } else if (rows.length === 1) {
      t = 'Сейчас номер только на этом устройстве. Подключите телефон или компьютер — переписка и контакты появятся и там.';
    }
    hint.textContent = t;
    hint.classList.toggle('hidden', !t);
  }
  const ex = $('#devicesExcluded');
  if (ex) {
    ex.classList.toggle('hidden', !st?.excluded);
    if (st?.excluded) {
      ex.replaceChildren();
      const p = document.createElement('p');
      p.textContent =
        'Это устройство отвязано от профиля на другом устройстве: синхронизация остановлена, новые чаты и контакты сюда не придут.';
      const wipe = armedButton('Стереть данные профиля', 'Точно стереть?', 'danger', async () => {
        emit('zv-device-revoked', { by: 'excluded' });
      });
      ex.append(p, wipe);
    }
  }
  const sync = $('#devicesSyncState');
  if (sync) {
    const many = rows.length > 1;
    sync.classList.toggle('hidden', !many);
    sync.textContent = st?.lastSyncAt ? 'синхронизировано ' + fmtAgo(st.lastSyncAt) : 'синхронизация…';
  }
}

// ---------- Привязка: НОВОЕ устройство (B) ----------
async function pairPost(baseUrl, path, body) {
  const res = await fetch(baseUrl.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(20000),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
function renderQr(el, text) {
  if (!el) return;
  el.replaceChildren();
  if (typeof qrcode === 'undefined') return;
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
function wordsEl(el, words) {
  if (!el) return;
  el.replaceChildren(
    ...words.map((w) => {
      const s = document.createElement('span');
      s.className = 'link-word';
      s.textContent = w;
      return s;
    })
  );
}
function linkStatus(text, cls = '') {
  const el = $('#linkNewStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status-line' + (cls ? ' ' + cls : '');
}
let linkNew = null; // {code, acc, keys, req, bind, exp, base, timer}
function linkUrlOf(code, bind) {
  const w = getWorkerBase().replace(/\/$/, '');
  const custom = w && w !== String(DEFAULT_WORKER_URL || '').replace(/\/$/, '');
  return `${location.origin}${location.pathname}#link=${code}.${bind}` + (custom ? '&w=' + encodeURIComponent(w) : '');
}
async function showLinkNew(L) {
  $('#linkNewBox')?.classList.remove('hidden');
  $('#btnLinkNew')?.classList.add('hidden');
  renderQr($('#linkNewQr'), linkUrlOf(L.code, L.bind));
  const c = $('#linkNewCode');
  if (c) c.textContent = formatLinkCode(L.code);
  wordsEl($('#linkNewWords'), await linkSasWords(L.code, L.bind));
}
function hideLinkNew() {
  $('#linkNewBox')?.classList.add('hidden');
  $('#btnLinkNew')?.classList.remove('hidden');
  const q = $('#linkNewQr');
  if (q) q.replaceChildren();
  const c = $('#linkNewCode');
  if (c) c.textContent = '';
}
export async function startLinkAsNew() {
  if (await hasPersonal()) throw new Error('на этом устройстве уже есть номер');
  cancelLinkNew(true);
  linkStatus('Готовим код…');
  $('#linkNewBox')?.classList.remove('hidden');
  const keys = await newLinkKeys();
  const label = normLabel(deviceLabelFromUA(navigator.userAgent));
  const req = { t: 'zv-link-req-v1', eB: keys.eB, devicePub: keys.devicePub, ecdhPub: keys.ecdhPub, label, ts: Date.now() };
  // Подпись записи реестра этого устройства — её разошлёт основное.
  req.esig = await signWithKey(keys.devicePriv, devText(keys.devicePub, keys.ecdhPub, false, label));
  const bind = await linkBindOf(req);
  const b = base();
  let code = null;
  let acc = null;
  for (let i = 0; i < 4 && !code; i++) {
    const c = newLinkCode();
    const a = await linkAccess(c);
    const r = await pairPost(b, '/pair/create', {
      codeHash: a.req.addr,
      blob: await sealCodeBlob(a.req.key, req),
      exp: Date.now() + LINK_TTL_MS,
      nx: true,
    });
    if (r.status === 201) {
      code = c;
      acc = a;
    } else if (r.status !== 409) {
      throw new Error(r.status === 501 ? 'на сервере не настроена привязка устройств' : 'сервер ответил ' + r.status);
    }
  }
  if (!code) throw new Error('не удалось выдать код — попробуйте ещё раз');
  const L = { code, acc, keys, req, bind, exp: Date.now() + LINK_TTL_MS, base: b, timer: 0 };
  linkNew = L;
  await kvPut('devices', 'link-pending', { code, keys, req, bind, exp: L.exp, base: b }).catch(() => {});
  await showLinkNew(L);
  linkStatus('Ждём подтверждения на основном устройстве…');
  pollLinkNew(L);
  return L;
}
function cancelLinkNew(silent = false) {
  if (linkNew?.timer) clearTimeout(linkNew.timer);
  linkNew = null;
  kvDel('devices', 'link-pending').catch(() => {});
  hideLinkNew();
  if (!silent) linkStatus('');
}
function pollLinkNew(L) {
  if (linkNew !== L) return;
  L.timer = setTimeout(async () => {
    if (linkNew !== L) return;
    if (Date.now() > L.exp) {
      linkStatus('Код истёк (10 минут). Нажмите «Подключить к моему профилю» ещё раз.', 'warn');
      cancelLinkNew(true);
      $('#linkNewBox')?.classList.remove('hidden');
      return;
    }
    let r = null;
    try {
      r = await pairPost(L.base, '/pair/claim', { codeHash: L.acc.resp.addr });
    } catch {}
    if (linkNew !== L) return;
    if (r && r.status === 200 && r.data?.blob) {
      try {
        await finishLinkNew(L, r.data.blob);
      } catch (e) {
        linkStatus('Не удалось подключить: ' + (e?.message || e), 'warn');
        cancelLinkNew(true);
        $('#linkNewBox')?.classList.remove('hidden');
      }
      return;
    }
    pollLinkNew(L);
  }, LINK_POLL_MS);
}
async function finishLinkNew(L, blob) {
  const resp = await openCodeBlob(L.acc.resp.key, blob);
  if (!resp || resp.t !== 'zv-link-resp-v1') throw new Error('ответ повреждён');
  if (!resp.ok) {
    linkStatus('Основное устройство отклонило подключение.', 'warn');
    cancelLinkNew(true);
    $('#linkNewBox')?.classList.remove('hidden');
    return;
  }
  const key = await linkRespKey(L.keys.eBPriv, resp.eA, L.acc.mix, L.bind);
  let bundle = null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(resp.iv) }, key, b64u.dec(resp.ct));
    bundle = JSON.parse(td.decode(pt));
  } catch {
    throw new Error('не удалось расшифровать ответ основного устройства');
  }
  const ok =
    bundle &&
    bundle.v === 1 &&
    /^[A-Za-z0-9_-]{87}$/.test(bundle.masterPub || '') &&
    typeof bundle.secret === 'string' &&
    bundle.secret.length >= 22 &&
    /^[A-Za-z0-9_-]{43}$/.test(bundle.sync?.seed || '');
  if (!ok) throw new Error('ответ неполный');
  if (!(await verifyDeviceCertClient(bundle.masterPub, L.keys.devicePub, bundle.cert, bundle.chain || null))) {
    throw new Error('сертификат устройства не прошёл проверку');
  }
  linkStatus('Подключено. Получаем чаты, контакты и журнал…', 'good');
  await installLinkedIdentity({
    masterPub: bundle.masterPub,
    secret: bundle.secret,
    devicePub: L.keys.devicePub,
    devicePriv: L.keys.devicePriv,
    ecdhPub: L.keys.ecdhPub,
    ecdhPriv: L.keys.ecdhPriv,
    cert: bundle.cert,
    chain: bundle.chain || null,
    label: String(L.req.label || LINKED_LABEL_FALLBACK).slice(0, 60),
  });
  if (bundle.worker && typeof bundle.worker === 'string') {
    try {
      setWorkerBase(bundle.worker);
    } catch {}
  }
  linkNew = null;
  await kvDel('devices', 'link-pending').catch(() => {});
  st = {
    v: 1,
    seedEnc: await encryptWithVault(bundle.sync.seed),
    gen: Number.isInteger(bundle.sync.gen) ? bundle.sync.gen : 0,
    items: {},
    unapplied: {},
    seen: {},
    lastSeq: 0,
    joinedAt: Date.now(),
    label: normLabel(L.req.label),
    // Та же подпись записи реестра, что ушла в запросе: запись, которую
    // разослало основное устройство, и своя совпадут.
    esig: L.req.esig ? { text: devText(L.keys.devicePub, L.keys.ecdhPub, false, normLabel(L.req.label)), sig: L.req.esig } : null,
    addedBy: bundle.from?.devicePub || null,
    histMode: bundle.hist ? 'import' : 'none',
    histExpected: !!bundle.hist,
    awaitSnap: true,
    needAt: Date.now(), // нет снимка за 20 с — попросим ('need')
    createdAt: Date.now(),
  };
  await saveState();
  started = true;
  stopped = false;
  await refreshMe();
  K = null;
  // Первая синхронизация: ждём снимок профиля (и историю, если её переносят).
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await syncNow();
    if (st.sawSnap && (!st.histExpected || st.histDone || Date.now() - t0 > 90000)) break;
    const rooms = (await kvAll('rooms').catch(() => [])).length;
    linkStatus(
      st.sawSnap ? `Получено чатов: ${rooms}. ${st.histExpected && !st.histDone ? 'Ждём историю переписки…' : ''}` : 'Ждём данные с основного устройства…',
      'good'
    );
    await new Promise((r) => setTimeout(r, 2500));
  }
  try {
    await chatHooks()?.introSweep?.();
  } catch {}
  emit('zv-identity-changed', { reason: 'linked' });
  linkStatus('Готово! Перезагружаем…', 'good');
  try {
    localStorage.setItem('zvHomeTab', 'personal'); // после перезагрузки — «Мой номер» со списком устройств
  } catch {}
  setTimeout(() => location.replace(location.pathname + '?linked=1'), 700);
}
const LINKED_LABEL_FALLBACK = 'Устройство';
async function resumeLinkNew() {
  if (await hasPersonal()) {
    await kvDel('devices', 'link-pending').catch(() => {});
    return;
  }
  const p = await kvGet('devices', 'link-pending').catch(() => null);
  if (!p || !p.code || !p.keys?.eBPriv || Date.now() > (p.exp || 0)) {
    if (p) await kvDel('devices', 'link-pending').catch(() => {});
    return;
  }
  const acc = await linkAccess(p.code);
  const L = { code: p.code, acc, keys: p.keys, req: p.req, bind: p.bind, exp: p.exp, base: p.base || base(), timer: 0 };
  linkNew = L;
  await showLinkNew(L);
  linkStatus('Ждём подтверждения на основном устройстве…');
  pollLinkNew(L);
}

// ---------- Привязка: ОСНОВНОЕ устройство (A) подтверждает ----------
let linkAdmin = null; // {code, acc, req, bind, base, words}
function adminNote(text, cls = '') {
  const n = $('#linkAdminNote');
  if (!n) return;
  n.textContent = text || '';
  n.className = 'note' + (cls ? ' ' + cls : '');
}
function workerFromToken(s) {
  const m = String(s || '').match(/[#&?]w=([^&#\s]+)/);
  if (!m) return '';
  try {
    const u = new URL(decodeURIComponent(m[1]));
    return u.protocol === 'https:' || u.hostname === '127.0.0.1' || u.hostname === 'localhost' ? u.origin + u.pathname.replace(/\/$/, '') : '';
  } catch {
    return '';
  }
}
export async function adminFind(input) {
  const admin = await adminSigner();
  if (!admin) throw new Error('подключать устройства может только основное устройство профиля');
  await refreshMe();
  let tok = parseLinkToken(input);
  if (!tok) {
    const digits = normalizeLinkCode(input);
    if (digits.length === 12) tok = { code: digits, bind: null };
  }
  if (!tok) throw new Error('нужен 12-значный код с экрана нового устройства');
  adminNote('Ищем запрос… (несколько секунд — код защищён медленным хэшем)');
  $('#linkConfirmBox')?.classList.add('hidden');
  const acc = await linkAccess(tok.code);
  const bases = [];
  for (const b of [workerFromToken(input), base(), String(DEFAULT_WORKER_URL || '')]) {
    const x = String(b || '').replace(/\/$/, '');
    if (x && !bases.includes(x)) bases.push(x);
  }
  let found = null;
  for (const b of bases) {
    const r = await pairPost(b, '/pair/claim', { codeHash: acc.req.addr }).catch(() => null);
    if (r && r.status === 200 && r.data?.blob) {
      found = { b, blob: r.data.blob };
      break;
    }
  }
  if (!found) throw new Error('запрос не найден: проверьте код или создайте новый на новом устройстве (код живёт 10 минут и срабатывает один раз)');
  const req = await openCodeBlob(acc.req.key, found.blob);
  const valid =
    req &&
    req.t === 'zv-link-req-v1' &&
    /^[A-Za-z0-9_-]{87}$/.test(req.eB || '') &&
    /^[A-Za-z0-9_-]{87}$/.test(req.devicePub || '') &&
    /^[A-Za-z0-9_-]{87}$/.test(req.ecdhPub || '') &&
    typeof req.esig === 'string' &&
    (await verifyChatSig(req.devicePub, req.esig, devText(req.devicePub, req.ecdhPub, false, normLabel(req.label))));
  if (!valid) throw new Error('запрос повреждён или создан старой версией — обновите приложение на новом устройстве');
  const bind = await linkBindOf(req);
  if (tok.bind && tok.bind !== bind) {
    throw new Error('QR-код не совпадает с запросом на сервере — возможна подмена. Не подключайте это устройство.');
  }
  if (req.devicePub === me.devicePub) throw new Error('это и есть текущее устройство');
  if (isRevoked(req.devicePub)) throw new Error('это устройство уже отвязывали — создайте на нём новый код');
  const words = await linkSasWords(tok.code, bind);
  linkAdmin = { code: tok.code, acc, req, bind, base: found.b, words, viaQr: !!tok.bind };
  const lbl = $('#linkReqLabel');
  if (lbl) lbl.textContent = String(req.label || 'Устройство').slice(0, 60);
  wordsEl($('#linkReqWords'), words);
  $('#linkConfirmBox')?.classList.remove('hidden');
  adminNote(tok.bind ? 'QR совпал с запросом. Сверьте контрольные слова с экраном нового устройства.' : 'Сверьте контрольные слова с экраном нового устройства.');
  return linkAdmin;
}
async function sealResp(L, obj) {
  return sealCodeBlob(L.acc.resp.key, obj);
}
export async function adminDecline() {
  const L = linkAdmin;
  linkAdmin = null;
  $('#linkConfirmBox')?.classList.add('hidden');
  if (!L) return;
  await pairPost(L.base, '/pair/create', {
    codeHash: L.acc.resp.addr,
    blob: await sealResp(L, { t: 'zv-link-resp-v1', ok: false }),
    exp: Date.now() + LINK_TTL_MS,
    nx: true,
  }).catch(() => {});
  adminNote('Подключение отклонено.');
}
export async function adminConfirm({ hist = true } = {}) {
  const L = linkAdmin;
  if (!L) throw new Error('нет запроса на подключение');
  return serial(async () => {
    await refreshMe();
    const admin = await adminSigner();
    if (!admin) throw new Error('нет права подключать устройства');
    adminNote('Подключаем…');
    await ensureSyncState();
    // Комната синхронизации должна быть доступна ДО того, как новое
    // устройство получит номер: иначе оно ждало бы данные впустую.
    if (!(await ensureRoomInit())) throw new Error('сервер синхронизации недоступен, попробуйте ещё раз');
    const { cert, chain: ch } = await admin.issue(L.req.devicePub);
    const seed = await decryptWithVault(st.seedEnc);
    const w = base();
    const custom = w !== String(DEFAULT_WORKER_URL || '').replace(/\/$/, '');
    const bundle = {
      v: 1,
      masterPub: me.masterPub,
      secret: me.secret,
      cert,
      chain: ch || null,
      sync: { seed, gen: st.gen || 0 },
      from: { devicePub: me.devicePub, label: st.label || '' },
      hist: !!hist,
      worker: custom ? w : null,
    };
    const eph = await genP256KeyPair(['deriveBits'], 'ECDH');
    const eA = b64u.enc(new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey)));
    const key = await linkRespKey(eph.privateKey, L.req.eB, L.acc.mix, L.bind);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(bundle))));
    const blob = await sealResp(L, { t: 'zv-link-resp-v1', ok: true, eA, iv: b64u.enc(iv), ct: b64u.enc(ct) });
    const r = await pairPost(L.base, '/pair/create', { codeHash: L.acc.resp.addr, blob, exp: Date.now() + LINK_TTL_MS, nx: true });
    if (r.status === 409) {
      linkAdmin = null;
      throw new Error('по этому коду уже кто-то ответил — возможна атака. Отмените подключение на новом устройстве и начните заново.');
    }
    if (r.status !== 201) throw new Error('сервер ответил ' + r.status);
    linkAdmin = null;
    localSet('dev:' + L.req.devicePub, {
      label: normLabel(L.req.label),
      ecdhPub: L.req.ecdhPub,
      esig: L.req.esig,
      cert,
      chain: ch || null,
      main: false,
      addedAt: Date.now(),
      addedBy: me.devicePub,
    });
    await ensureSelfDevItem();
    await saveState();
    publishProfileView();
    stopped = false;
    const view = await buildView();
    const { items } = commitLocal(st.items, view, shortDev(me.devicePub), Date.now(), {
      scope: (k) => !k.startsWith('dev:') && !k.startsWith('rev:') && !st.unapplied[k],
    });
    st.items = items;
    pendingKeys.clear();
    // Номер уже передан: сбой выгрузки снимка — не повод для ошибки,
    // ближайший цикл синхронизации повторит её (wantFull).
    try {
      await publishFull();
    } catch (e) {
      console.warn('link snap', e);
      wantFull = true;
      setTimeout(() => syncNow({ force: true }), 5000);
    }
    let n = 0;
    if (hist) {
      adminNote('Выгружаем историю переписки…');
      try {
        n = await exportHistoryFor(L.req.devicePub);
      } catch (e) {
        console.warn('hist export', e);
      }
    }
    $('#linkConfirmBox')?.classList.add('hidden');
    $('#linkAdminBox')?.classList.add('hidden');
    adminNote('');
    devNote(
      `Устройство «${String(L.req.label || 'Устройство').slice(0, 60)}» подключено.` +
        (hist ? ` Перенесено сообщений: ${n}.` : '') +
        ' Если это были не вы — сразу нажмите «Отвязать».'
    );
    schedulePoll();
    scheduleRender();
    emit('zv-devices-changed');
  });
}

// ---------- Сканер QR (BarcodeDetector, где он есть) ----------
let scanStream = null;
let scanTimer = 0;
function stopScan() {
  clearTimeout(scanTimer);
  try {
    scanStream?.getTracks?.().forEach((t) => t.stop());
  } catch {}
  scanStream = null;
  const v = $('#linkScanVideo');
  if (v) {
    v.srcObject = null;
    v.classList.add('hidden');
  }
}
async function startScan() {
  if (typeof BarcodeDetector === 'undefined') {
    adminNote('Этот браузер не умеет сканировать QR. Наведите камеру телефона на QR (откроется ссылка) или введите 12 цифр вручную.');
    return;
  }
  stopScan();
  const v = $('#linkScanVideo');
  if (!v) return;
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  v.srcObject = scanStream;
  v.classList.remove('hidden');
  await v.play().catch(() => {});
  const tick = async () => {
    if (!scanStream) return;
    try {
      const codes = await det.detect(v);
      const hit = codes.find((c) => /link=/.test(c.rawValue || ''));
      if (hit) {
        stopScan();
        const input = $('#linkCodeInput');
        if (input) input.value = formatLinkCode(parseLinkToken(hit.rawValue)?.code || '');
        await adminFind(hit.rawValue).catch((e) => adminNote(e?.message || String(e), 'warn'));
        return;
      }
    } catch {}
    scanTimer = setTimeout(tick, 350);
  };
  tick();
}

// Открыта ссылка #link=… (камера телефона распознала QR нового устройства).
export async function openAdminLink(hash) {
  const admin = await adminSigner().catch(() => null);
  $('#linkAdminBox')?.classList.remove('hidden');
  if (!admin) {
    adminNote(
      (await hasPersonal())
        ? 'Подключать устройства может только основное устройство профиля.'
        : 'Это ссылка подключения нового устройства. Откройте её на своём основном устройстве (там, где создан номер).',
      'warn'
    );
    return;
  }
  const tok = parseLinkToken(hash);
  const input = $('#linkCodeInput');
  if (input && tok) input.value = formatLinkCode(tok.code);
  await adminFind(hash).catch((e) => adminNote(e?.message || String(e), 'warn'));
}

// ---------- Проводка ----------
function initDevicesUI() {
  const btnNew = $('#btnLinkNew');
  if (btnNew) {
    btnNew.onclick = () => {
      startLinkAsNew().catch((e) => {
        linkStatus('Не получилось: ' + (e?.message || e), 'warn');
      });
    };
  }
  const cancel = $('#btnLinkNewCancel');
  if (cancel) cancel.onclick = () => cancelLinkNew();
  const linkBtn = $('#btnLinkDevice');
  if (linkBtn) {
    linkBtn.onclick = () => {
      const box = $('#linkAdminBox');
      if (!box) return;
      const show = box.classList.contains('hidden');
      box.classList.toggle('hidden', !show);
      if (show) $('#linkCodeInput')?.focus();
      else stopScan();
    };
  }
  const find = $('#btnLinkFind');
  if (find) {
    find.onclick = () => {
      find.disabled = true;
      adminFind($('#linkCodeInput')?.value || '')
        .catch((e) => adminNote(e?.message || String(e), 'warn'))
        .finally(() => {
          find.disabled = false;
        });
    };
  }
  const codeIn = $('#linkCodeInput');
  if (codeIn) {
    codeIn.onkeydown = (e) => {
      if (e.key === 'Enter') $('#btnLinkFind')?.click();
    };
  }
  const scan = $('#btnLinkScan');
  if (scan) scan.onclick = () => startScan().catch((e) => adminNote('Камера недоступна: ' + (e?.message || e), 'warn'));
  const ok = $('#btnLinkConfirm');
  if (ok) {
    ok.onclick = () => {
      ok.disabled = true;
      adminConfirm({ hist: !!$('#linkHistory')?.checked })
        .catch((e) => adminNote('Не получилось: ' + (e?.message || e), 'warn'))
        .finally(() => {
          ok.disabled = false;
        });
    };
  }
  const no = $('#btnLinkDecline');
  if (no) no.onclick = () => adminDecline().catch(() => {});
  window.addEventListener('zv-rooms-changed', () => notifyLocalChange());
  window.addEventListener('zv-sync-local', () => notifyLocalChange());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && st && !stopped) {
      syncNow();
      schedulePoll();
    } else if (document.visibilityState !== 'visible') {
      liveClose();
    }
  });
  // Сервер входящих закрыл сокет «revoked»: проверяем подписанный отзыв в
  // синхронизации сразу, не дожидаясь очередного опроса.
  // То же при отказе в авторизации (номер сменили на основном) — не чаще
  // раза в 10 с.
  let inboxKickAt = 0;
  const inboxKick = () => {
    if (!st || stopped || Date.now() - inboxKickAt < 10000) return;
    inboxKickAt = Date.now();
    syncNow();
  };
  window.addEventListener('zv-inbox-revoked', inboxKick);
  window.addEventListener('zv-inbox-authfail', inboxKick);
  resumeLinkNew().catch(() => {});
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDevicesUI);
  else initDevicesUI();
}

// Для app.js, chat.js и тестов.
export function hasOtherDevices() {
  return !!st && otherDevs().length > 0;
}
export function isLinkedDevice() {
  return !!me && !me.masterPriv && !!me.linked;
}
window.ZVDevices = {
  start: startDevices,
  syncNow,
  notifyLocalChange,
  revokeDevice,
  unlinkSelf,
  rotationCandidates,
  rotateWithDevices,
  hasOtherDevices,
  isLinkedDevice,
  openAdminLink,
  adminFind,
  adminConfirm,
  adminDecline,
  startLinkAsNew,
  state: () => st,
  render: scheduleRender,
};
