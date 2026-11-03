// Шифрование сигналинга и голосового моста: секрет живёт только во #фрагменте ссылки
// и никогда не уходит ни на GitHub, ни на брокеры, ни в Worker.
const te = new TextEncoder();
const td = new TextDecoder();

export const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < b.length; i += chunk) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + chunk));
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

export function newSecret() {
  return b64u.enc(crypto.getRandomValues(new Uint8Array(32))); // 256 бит
}

// Из одного секрета через HKDF-SHA256 получаем:
//  - topic: публичный идентификатор комнаты (по нему нельзя восстановить ключ)
//  - key:   AES-256-GCM ключ для всех сообщений сигналинга и резервного аудио-моста
export async function deriveRoom(secret) {
  const raw = b64u.dec(secret);
  if (raw.length < 16) throw new Error('bad secret');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = te.encode('ZVONochek/v1');
  const topicBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('topic') },
    base,
    128
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('aes-256-gcm') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { topic: hex(topicBits), key };
}

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
const canZip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

// Сообщения сжимаются (deflate) и шифруются AES-256-GCM: z2 = сжато, z1 = без сжатия
export async function seal(key, obj, aad) {
  let pt = te.encode(JSON.stringify(obj));
  let tag = 'z1';
  // Сжимаем текстовые JSON/SDP пакеты, но не тратим ресурсы на уже сжатое аудио Opus
  if (canZip && pt.length > 300 && !obj._noZip) {
    try {
      pt = await pipe(pt, new CompressionStream('deflate-raw'));
      tag = 'z2';
    } catch {}
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(aad + tag) },
    key,
    pt
  );
  return tag + '.' + b64u.enc(iv) + '.' + b64u.enc(ct);
}

export async function open(key, str, aad) {
  const p = String(str).split('.');
  if (p.length !== 3 || (p[0] !== 'z1' && p[0] !== 'z2')) return null;
  try {
    let pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64u.dec(p[1]), additionalData: te.encode(aad + p[0]) },
        key,
        b64u.dec(p[2])
      )
    );
    if (p[0] === 'z2') pt = await pipe(pt, new DecompressionStream('deflate-raw'));
    return JSON.parse(td.decode(pt));
  } catch {
    return null; // чужое или поврежденное сообщение — молча игнорируем
  }
}

// Код безопасности: хэш от DTLS-отпечатков обеих сторон (или ключей комнаты в режиме моста).
// Если у обоих собеседников он одинаковый — посредника (MITM) нет.
const EMOJI = [
  '🐶','🐱','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦄',
  '🐝','🦋','🐢','🐙','🐬','🐳','🌵','🌲','🌻','🍄','🌙','⭐','🔥','🌈','❄️','⚡',
  '🍎','🍋','🍉','🍇','🍓','🍒','🍑','🍍','🥕','🌽','🍕','🍔','🍩','🍪','🎂','☕',
  '⚽','🏀','🎸','🎹','🎲','🚀','🚲','🚗','⛵','✈️','🏠','🔑','🎁','📚','💡','🔔',
];

export async function safetyCode(sdpA, sdpB) {
  const fp = (sdp) =>
    (sdp.match(/a=fingerprint:\S+ \S+/g) || [])
      .map((s) => s.toUpperCase())
      .sort()
      .join('|');
  const parts = [fp(sdpA), fp(sdpB)].sort().join('#');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(parts)));
  const emoji = [0, 1, 2, 3, 4].map((i) => EMOJI[h[i] % 64]).join(' ');
  const digits = (((h[5] << 16) | (h[6] << 8) | h[7]) % 1000000).toString().padStart(6, '0');
  return { emoji, digits: digits.slice(0, 3) + ' ' + digits.slice(3) };
}

export async function safetyCodeBridge(topic, idA, idB) {
  const parts = ['bridge', topic, ...[String(idA), String(idB)].sort()].join('#');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(parts)));
  const emoji = [0, 1, 2, 3, 4].map((i) => EMOJI[h[i] % 64]).join(' ');
  const digits = (((h[5] << 16) | (h[6] << 8) | h[7]) % 1000000).toString().padStart(6, '0');
  return { emoji, digits: digits.slice(0, 3) + ' ' + digits.slice(3) };
}


// =======================================================================
// v21: приватный текстовый чат (комнаты по ссылке). Отдельный вывод ключей,
// звонковый deriveRoom выше НЕ используется и не меняется.
// Техплан: ZVONochek-MESSENGER-TECHPLAN-v21.md.
//
// Из seed (256 бит, живёт только во #фрагменте ссылки и в IndexedDB)
// через HKDF-SHA256 с раздельными info-метками выводятся:
//  - roomId:      публичный адрес Durable Object комнаты (hex, 64 символа)
//  - roomKey:     AES-256-GCM ключ эпохи (невыгружаемый)
//  - accessToken: клиент предъявляет серверу; сервер хранит только SHA-256
// opts.epoch — фаза 3 (ротация), входит в метку ключа; фаза 1: 0.
// opts.pinIkm — фаза 2 (PIN): результат медленного KDF, подмешивается в IKM.
// =======================================================================
export const CHAT_PT_SIZE = 4096; // размер plaintext-блока с паддингом
export const CHAT_BLOB_SIZE = 12 + CHAT_PT_SIZE + 16; // nonce + ct + тег = 4124

export async function sha256hex(data) {
  const buf = typeof data === 'string' ? te.encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function newMsgId() {
  return crypto.randomUUID();
}

// Контрольная фраза комнаты (фаза 2, техплан §5): слова из фиксированного
// списка в клиенте. Техплан предлагал список из 2048 слов × 3 слова (33 бита
// отпечатка); здесь — 256 слов × 4 слова (32 бита): сопоставимая энтропия
// при списке, который можно держать в одном файле без внешней зависимости.
// Слова выводятся из ключа комнаты отдельной HKDF-меткой (см. deriveChatKeys),
// поэтому у собеседников с одинаковым seed+PIN фраза совпадает, а при разном
// PIN — различается: это и ловит ошибку ввода PIN при устной сверке.
export const CHAT_WORDS = [
  'able','acid','aged','also','area','army','atom','aunt','auto','baby','back','bait','bake','bald','ball','band',
  'bank','bare','bark','barn','base','bath','bead','beam','bean','bear','beat','beef','beer','bell','belt','bend',
  'bent','best','bike','bill','bird','bite','blow','blue','boat','body','boil','bold','bolt','bomb','bond','bone',
  'book','boot','bore','born','boss','both','bowl','bulk','bull','burn','bury','bush','busy','cage','cake','calm',
  'came','camp','cane','cape','card','care','carp','cart','case','cash','cast','cave','cell','cent','chef','chin',
  'chip','city','clad','claw','clay','clip','club','clue','coal','coat','code','coil','coin','cold','colt','comb',
  'come','cook','cool','cope','copy','cord','core','corn','cost','cozy','crab','crew','crib','crop','crow','cube',
  'cure','curl','cute','dawn','days','dead','deal','dear','debt','deck','deed','deem','deep','deer','desk','dial',
  'dice','diet','dirt','dish','disk','dive','dock','doll','dome','done','doom','door','dose','dots','dove','down',
  'drag','draw','drip','drop','drum','duck','duct','dude','duel','dull','dump','dune','dusk','dust','duty','each',
  'earl','earn','ease','east','easy','echo','edge','edit','eggs','else','emit','epic','even','ever','exam','exit',
  'face','fact','fade','fail','fair','fake','fame','farm','fast','fate','fear','feed','feel','feet','fell','felt',
  'fern','file','fill','film','find','fine','fire','firm','fish','fist','fits','five','flag','flat','flaw','fled',
  'flex','flip','flow','foam','foil','fold','folk','fond','font','food','fool','foot','ford','fork','form','fort',
  'foul','four','free','frog','from','fuel','full','fund','funk','gain','gala','game','gasp','gate','gave','gaze',
  'gear','gems','germ','gift','girl','give','glad','glow','glue','goat','gold','golf','gone','gong','good','gray',
];

export async function deriveChatKeys(seedBytes, opts = {}) {
  if (!(seedBytes instanceof Uint8Array) || seedBytes.length < 32) {
    throw new Error('bad seed');
  }
  const epoch = Number(opts.epoch || 0);
  let ikm = seedBytes;
  if (opts.pinIkm) {
    // Фаза 2: IKM = seed || pinIkm (pinIkm — выход PBKDF2 от PIN, 32 байта)
    ikm = new Uint8Array(seedBytes.length + opts.pinIkm.length);
    ikm.set(seedBytes, 0);
    ikm.set(opts.pinIkm, seedBytes.length);
  }
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);
  const salt = te.encode('ZVONochek/chat/v1');
  const hk = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) });
  const roomIdBits = await crypto.subtle.deriveBits(hk('chat/v1/room-id'), base, 256);
  const roomKey = await crypto.subtle.deriveKey(
    hk(`chat/v1/room-key/e${epoch}`),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const tokenBits = await crypto.subtle.deriveBits(hk('chat/v1/access-token'), base, 256);
  // Контрольная фраза: отдельная метка, НЕ зависит от эпохи — фраза у комнаты
  // одна на всю жизнь; зависит от seed и PIN (через общий IKM).
  const phraseBits = new Uint8Array(await crypto.subtle.deriveBits(hk('chat/v1/phrase'), base, 32));
  const phrase = [...phraseBits].map((b) => CHAT_WORDS[b]).join(' ');
  return {
    roomId: hex(roomIdBits),
    roomKey,
    accessToken: b64u.enc(tokenBits),
    epoch,
    phrase,
  };
}

// =======================================================================
// v26, фаза 2 (техплан §5): PIN входа. PIN → PBKDF2-HMAC-SHA256, 600 000
// итераций, соль = 'ZVONochek/chat/pin/v1' || Room_ID-кандидат из seed-only
// вывода. Результат (pinIkm, 32 байта) подмешивается в IKM deriveChatKeys:
// без PIN выводятся ДРУГИЕ Room_ID, ключ и токен — сервер такую комнату
// «не знает», PIN в ссылке не передаётся и на устройстве хранится только
// зашифрованным vault-ключом (как seed).
// =======================================================================
export const PIN_PBKDF2_ITER = 600000;
export const PIN_SALT_PREFIX = 'ZVONochek/chat/pin/v1';

export async function derivePinIkm(pin, seedBytes) {
  const cand = await deriveChatKeys(seedBytes); // seed-only кандидат Room_ID
  const salt = new Uint8Array([
    ...te.encode(PIN_SALT_PREFIX),
    ...te.encode(cand.roomId),
  ]);
  const base = await crypto.subtle.importKey('raw', te.encode(String(pin)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PIN_PBKDF2_ITER, hash: 'SHA-256' },
    base,
    256
  );
  return new Uint8Array(bits);
}

// =======================================================================
// v26, фаза 3 (техплан §6): эпохи. Секрет эпохи — случайные 256 бит, НЕ
// выводится из seed: ключ эпохи = HKDF(seed ‖ pinIkm? ‖ epochSecret) с
// меткой chat/v1/room-key/e<N>. Room_ID и access-token при ротации НЕ
// меняются (выводятся из seed+PIN, как в эпохе 0): серверная комната та же,
// меняется только ключ шифрования сообщений. У кого нет секрета эпохи —
// новые сообщения не расшифровываются (AEAD), старая история при этом
// остаётся читаемой ключами прошлых эпох.
// =======================================================================
export async function deriveEpochRoomKey(seedBytes, epochSecret, epoch, opts = {}) {
  if (!(epochSecret instanceof Uint8Array) || epochSecret.length !== 32) {
    throw new Error('bad epoch secret');
  }
  const parts = [seedBytes];
  if (opts.pinIkm) parts.push(opts.pinIkm);
  parts.push(epochSecret);
  const ikm = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    ikm.set(p, off);
    off += p.length;
  }
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  const salt = te.encode('ZVONochek/chat/v1');
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: te.encode(`chat/v1/room-key/e${Number(epoch)}`),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Завёртка секрета эпохи на ECDH-ключ устройства участника: эфемерная пара
// отправителя → ECDH → HKDF → AES-256-GCM. В сообщение 'epoch' кладётся
// {eph, iv, ct} (base64url) на каждого оставленного участника.
async function epochWrapKey(sharedBits, roomId, epoch) {
  const base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: te.encode('ZVONochek/chat/v1'),
      info: te.encode(`chat/v1/epoch-wrap|${roomId}|${Number(epoch)}`),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapEpochSecret(myEcdhPriv, peerEcdhPubRaw, secretBytes, roomId, epoch) {
  const eph = await genP256KeyPair(['deriveBits'], 'ECDH');
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const peerKey = await crypto.subtle.importKey(
    'raw',
    peerEcdhPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, eph.privateKey, 256);
  const wk = await epochWrapKey(shared, roomId, epoch);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, secretBytes));
  return { eph: b64u.enc(ephRaw), iv: b64u.enc(iv), ct: b64u.enc(ct) };
}

// Обратная операция на стороне получателя; любая ошибка (не его завёртка,
// битые данные) → null, без исключений наружу.
export async function unwrapEpochSecret(myEcdhPriv, wrap, roomId, epoch) {
  try {
    if (!wrap?.eph || !wrap?.iv || !wrap?.ct) return null;
    const ephKey = await crypto.subtle.importKey(
      'raw',
      b64u.dec(wrap.eph),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const shared = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: ephKey },
      myEcdhPriv,
      256
    );
    const wk = await epochWrapKey(shared, roomId, epoch);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64u.dec(wrap.iv) },
      wk,
      b64u.dec(wrap.ct)
    );
    const out = new Uint8Array(pt);
    return out.length === 32 ? out : null;
  } catch {
    return null;
  }
}

// Шифрование одного сообщения: plaintext доводится до ровно CHAT_PT_SIZE
// байт (2 байта длины JSON + JSON + случайный паддинг), blob на проводе —
// nonce(12) || ciphertext. Возвращает Uint8Array длиной CHAT_BLOB_SIZE.
export async function encryptChatMessage(roomKey, msgObj) {
  const json = te.encode(JSON.stringify(msgObj));
  if (json.length > CHAT_PT_SIZE - 2) throw new Error('message too long');
  const pt = new Uint8Array(CHAT_PT_SIZE);
  new DataView(pt.buffer).setUint16(0, json.length, false);
  pt.set(json, 2);
  crypto.getRandomValues(pt.subarray(2 + json.length));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, roomKey, pt)
  );
  const blob = new Uint8Array(CHAT_BLOB_SIZE);
  blob.set(nonce, 0);
  blob.set(ct, 12);
  return blob;
}

// Обратное преобразование; при любом несоответствии (размер, тег AEAD,
// длина, JSON) возвращает null — чужие и битые blob молча отбрасываются.
export async function decryptChatMessage(roomKey, blob) {
  if (!(blob instanceof Uint8Array) || blob.length !== CHAT_BLOB_SIZE) return null;
  try {
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: blob.subarray(0, 12) },
        roomKey,
        blob.subarray(12)
      )
    );
    const len = new DataView(pt.buffer, pt.byteOffset).getUint16(0, false);
    if (len > CHAT_PT_SIZE - 2) return null;
    return JSON.parse(td.decode(pt.subarray(2, 2 + len)));
  } catch {
    return null;
  }
}

// Хэш шифротекста для дедупа (клиент и сервер считают одинаково — по
// сырым байтам blob).
export async function hashChatBlob(blob) {
  return sha256hex(blob);
}

// =======================================================================
// v24: fallback генерации пары ключей P-256 без subtle.generateKeyPair.
// Диагноз (проба v23 у владельца): secure=true, subtle есть, sign /
// importKey / encrypt / digest — функции, но generateKeyPair ===
// undefined. Из-за этого падали ensurePersonal / ensureDevice /
// ensureGuestDevice (identity.js) и гостевой ключ исходящего дозвона
// (app.js); звонки при этом работали — generateKeyPair им не нужен.
//
// Конструкция: если нативная generateKeyPair есть — используется ОНА
// (основной путь, поведение не меняется). Fallback включается только при
// её отсутствии: приватный скаляр d — случайные 32 байта (rejection
// sampling в [1, n-1]), публичная точка Q = d·G считается здесь на BigInt
// (константы кривой — SEC 2 / FIPS 186-4), после чего обе половины пары
// импортируются в обычные CryptoKey через subtle.importKey('jwk', …).
// Результат неотличим для остального кода: те же CryptoKey, приватный
// неэкспортируемый. Математика проверена тестом tests-v21/test-p256gen.mjs
// на векторах openssl (d, x, y совпадают байт-в-байт).
// Отдельным модулем не вынесено сознательно: по конвенциям проекта вся
// криптография живёт в crypto.js, а новый файл потребовал бы ещё и
// проводки через service worker (CORE) и ?v= импорты.
// =======================================================================
const P256 = {
  p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
  a: 0xffffffff00000001000000000000000000000000fffffffffffffffffffffffcn, // p - 3
  b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
  gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
};

const bytesToBigInt = (bytes) => {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
};
const bigIntToBytes32 = (v) => {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const modP = (v) => ((v % P256.p) + P256.p) % P256.p;

// Обратный элемент по модулю p — расширенный алгоритм Евклида.
function modInvP(v) {
  let [oldR, r] = [modP(v), P256.p];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('p256: not invertible');
  return modP(oldS);
}

// Аффинные точки: {x, y} BigInt, точка на бесконечности — null.
// Одна инверсия на сложение: для разовой генерации ключа это десятки
// миллисекунд — приемлемо, fallback не на горячем пути.
function p256PointAdd(Pt, Qt) {
  if (Pt === null) return Qt;
  if (Qt === null) return Pt;
  const { p, a } = P256;
  let lambda;
  if (Pt.x === Qt.x) {
    if (modP(Pt.y + Qt.y) === 0n) return null; // P + (-P), включая удвоение при y=0
    lambda = modP((3n * Pt.x * Pt.x + a) * modInvP(2n * Pt.y)); // удвоение
  } else {
    lambda = modP((Qt.y - Pt.y) * modInvP(Qt.x - Pt.x));
  }
  const x = modP(lambda * lambda - Pt.x - Qt.x);
  const y = modP(lambda * (Pt.x - x) - Pt.y);
  return { x, y };
}

function p256PointMul(k) {
  let result = null;
  let addend = { x: P256.gx, y: P256.gy };
  while (k > 0n) {
    if (k & 1n) result = p256PointAdd(result, addend);
    addend = p256PointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

// Чистая часть fallback (экспортируется для векторных тестов):
// приватный скаляр (32 байта) → координаты публичной точки по 32 байта.
export function p256PubFromPriv(dBytes) {
  if (!(dBytes instanceof Uint8Array) || dBytes.length !== 32) {
    throw new Error('p256: bad private scalar');
  }
  const d = bytesToBigInt(dBytes);
  if (d < 1n || d >= P256.n) throw new Error('p256: scalar out of range');
  const Q = p256PointMul(d);
  return { x: bigIntToBytes32(Q.x), y: bigIntToBytes32(Q.y) };
}

// Fallback-пара из готового скаляра: JWK → subtle.importKey.
// Usages разносятся по половинам, как у нативной пары: публичная —
// ECDSA ['verify'] / ECDH [], приватная — вызывающие usages без
// публичных операций (importKey приватного JWK с 'verify' отклоняется
// WebCrypto: "Unsupported key usage").
export async function p256KeyPairFromPriv(dBytes, usages = ['sign', 'verify'], algName = 'ECDSA') {
  const { x, y } = p256PubFromPriv(dBytes);
  const alg = { name: algName, namedCurve: 'P-256' };
  const pubUsages = algName === 'ECDH' ? [] : ['verify'];
  const privUsages =
    algName === 'ECDH'
      ? usages.filter((u) => u === 'deriveKey' || u === 'deriveBits')
      : usages.filter((u) => u === 'sign');
  const pubJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u.enc(x),
    y: b64u.enc(y),
    ext: true,
    key_ops: pubUsages,
  };
  const privJwk = { ...pubJwk, d: b64u.enc(dBytes), key_ops: privUsages };
  // Публичный импортируется extractable=true: у нативной пары, созданной
  // generateKeyPair(..., false, ...), публичная половина всё равно
  // экспортируема (identity.js достаёт из неё raw) — повторяем семантику.
  // Приватный — строго неэкспортируемый.
  const publicKey = await crypto.subtle.importKey('jwk', pubJwk, alg, true, pubUsages);
  const privateKey = await crypto.subtle.importKey('jwk', privJwk, alg, false, privUsages);
  return { publicKey, privateKey };
}

// Генерация пары P-256: нативный generateKeyPair, если он есть; иначе
// fallback выше. forceFallback — только для тестов.
export async function genP256KeyPair(usages = ['sign', 'verify'], algName = 'ECDSA', forceFallback = false) {
  if (!forceFallback && typeof crypto?.subtle?.generateKeyPair === 'function') {
    return crypto.subtle.generateKeyPair({ name: algName, namedCurve: 'P-256' }, false, [
      ...usages,
    ]);
  }
  for (;;) {
    const dBytes = crypto.getRandomValues(new Uint8Array(32));
    const d = bytesToBigInt(dBytes);
    if (d >= 1n && d < P256.n) return p256KeyPairFromPriv(dBytes, usages, algName);
  }
}

// =======================================================================
// v25: файлы в чате и коды приветствия.
//
// ФАЙЛЫ. Файл шифруется отдельным случайным ключом (32 байта, живёт только
// внутри зашифрованного ключом комнаты сообщения-метаданных type:'file').
// Чанки по 256 КиБ открытого текста; nonce чанка строится детерминированно:
// 4 байта случайной соли файла || 8 байт big-endian индекса. Уникальность
// пары (ключ, nonce) гарантирована: ключ одноразовый на файл, индекс не
// повторяется внутри файла. Сервер видит число чанков и их размер — в
// отличие от текста, файлы паддинг до фиксированного размера НЕ получают
// (осознанный компромисс, AUDIT-v25).
// =======================================================================
export const FILE_CHUNK_PT = 256 * 1024;
// v27: лимит файла поднят с 10 до 25 МБ. Потолок задаёт не код, а бесплатный
// тариф Cloudflare: хранилище Durable Object (SQLite) на free-плане — общий
// объём по аккаунту, и 25 МБ × разумное число комнат укладывается в него с
// запасом; дальше упираемся в квоту, а не в протокол (чанки те же 256 КиБ).
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const FILE_MAX_CHUNKS = 100; // 100 × 256 КиБ = 25 МиБ — синхронно с ChatRoom DO

export async function importFileKey(rawBytes) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length !== 32) {
    throw new Error('bad file key');
  }
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function fileChunkNonce(salt, idx) {
  const nonce = new Uint8Array(12);
  nonce.set(salt.subarray(0, 4), 0);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(idx), false);
  return nonce;
}

export async function encryptFileChunk(fileKey, salt, idx, ptBytes) {
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: fileChunkNonce(salt, idx) },
    fileKey,
    ptBytes
  );
  return new Uint8Array(ct);
}

export async function decryptFileChunk(fileKey, salt, idx, ctBytes) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fileChunkNonce(salt, idx) },
    fileKey,
    ctBytes
  );
  return new Uint8Array(pt);
}

// =======================================================================
// КОД ПРИВЕТСТВИЯ (быстрое подключение, техплан v21 §6). Код — 9 символов
// base64url (~54 бита). Ключ пары: PBKDF2-HMAC-SHA256(код, соль GREET_SALT,
// 200 000). Соль фиксированная строковая, а НЕ roomId: гость roomId не
// знает — он и есть полезная нагрузка blob ({seed, roomId} внутри
// шифротекста). Адрес пары на сервере: codeHash = SHA-256(GREET_SALT||код),
// сам код и seed сервер не получает. Защита: энтропия кода + медленный KDF +
// TTL 15 минут + одноразовость и лимит попыток claim на сервере.
// =======================================================================
export const GREET_SALT = 'zv-greet-v1';
export const GREET_CODE_LEN = 9;
const GREET_PBKDF2_ITER = 200000;

export function newGreetCode() {
  // 54 бита: 7 случайных байт → 10 base64url-символов, берём первые 9 (54 бита)
  return b64u.enc(crypto.getRandomValues(new Uint8Array(7))).slice(0, GREET_CODE_LEN);
}

export async function greetCodeHash(code) {
  return sha256hex(GREET_SALT + String(code).trim());
}

async function deriveCodeKey(code, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(code).trim()), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode(salt), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function sealCodePayload(code, salt, iterations, payloadObj) {
  const key = await deriveCodeKey(code, salt, iterations);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(payloadObj)))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64u.enc(out);
}

async function openCodePayload(code, salt, iterations, blobB64) {
  try {
    const key = await deriveCodeKey(code, salt, iterations);
    const raw = b64u.dec(blobB64);
    if (raw.length < 13) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12) },
      key,
      raw.subarray(12)
    );
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}

// Запечатать {seed, roomId} под ключом из кода → base64url(nonce||ct).
export async function sealGreetPayload(code, payloadObj) {
  return sealCodePayload(code, GREET_SALT, GREET_PBKDF2_ITER, payloadObj);
}

// Открыть payload кодом; неверный код/битый blob → null.
export async function openGreetPayload(code, blobB64) {
  return openCodePayload(code, GREET_SALT, GREET_PBKDF2_ITER, blobB64);
}

// =======================================================================
// v26: ПОСТОЯННАЯ КОРОТКАЯ ССЫЛКА (#join=<код>) — режим алиаса PairingDO.
// Тот же приём, что код приветствия (PBKDF2 → AES-GCM blob {seed, roomId}),
// но: отдельное пространство (соль 'zv-alias-v1' — greet-код алиас не
// откроет и наоборот), пара НЕ одноразовая и без TTL, зато отзываемая
// (revoke по admin-секрету владельца) и с rate-limit выдач на сервере.
// Честная рамка: ≈54 бита энтропии кода против 256 бит длинной ссылки;
// компенсации — медленный KDF, rate-limit, отзываемость и комбинация с PIN
// (фаза 2). Длинная ссылка остаётся главным ключом комнаты.
// =======================================================================
export const ALIAS_SALT = 'zv-alias-v1';
const ALIAS_PBKDF2_ITER = 200000;

export function newJoinCode() {
  return newGreetCode(); // тот же формат: 9 символов base64url, ~54 бита
}

export async function aliasCodeHash(code) {
  return sha256hex(ALIAS_SALT + String(code).trim());
}

export async function sealAliasPayload(code, payloadObj) {
  return sealCodePayload(code, ALIAS_SALT, ALIAS_PBKDF2_ITER, payloadObj);
}

export async function openAliasPayload(code, blobB64) {
  return openCodePayload(code, ALIAS_SALT, ALIAS_PBKDF2_ITER, blobB64);
}

// =======================================================================
// v30: ДОСТУП ПО КОДОВОМУ СЛОВУ (rendezvous — «найти чат по фразе»).
// Владелец задаёт фразу из 3+ слов, собеседник вписывает её — и попадает
// в комнату: та же механика, что код приветствия (PBKDF2 → AES-GCM blob
// {seed, roomId} в PairingDO), но адрес и ключ выводятся из фразы, а не
// из случайного кода. Фраза — СЛАБЫЙ ключ, поэтому компенсации жёстче,
// чем у кодов: PBKDF2 600 000 итераций (втрое дороже greet), TTL встречи
// 24 часа, выдача одноразовая, сервер сжигает запись после 5 неудачных
// попыток claim. Постоянным доступом фраза не является: свою работу она
// делает один раз, дальше рулит 256-битный seed комнаты.
// Нормализация: lowercase, ё→е, схлопывание любых пробелов — чтобы
// «Тихий  Синий Кран» и «тихий синий кран» были одной фразой.
// =======================================================================
export const WORD_SALT = 'zv-word-v1';
const WORD_PBKDF2_ITER = 600000;

export function normalizeWordPhrase(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function wordCodeHash(phrase) {
  return sha256hex(WORD_SALT + ':' + normalizeWordPhrase(phrase));
}

export async function sealWordPayload(phrase, payloadObj) {
  return sealCodePayload(normalizeWordPhrase(phrase), WORD_SALT, WORD_PBKDF2_ITER, payloadObj);
}

export async function openWordPayload(phrase, blobB64) {
  return openCodePayload(normalizeWordPhrase(phrase), WORD_SALT, WORD_PBKDF2_ITER, blobB64);
}

// =======================================================================
// v36: АДРЕС КОДА — ИЗ МЕДЛЕННОГО KDF (схема 2).
//
// Проблема схем v25–v35: ключ blob-а защищён PBKDF2 (200k/600k), но адрес
// записи на сервере — быстрый SHA-256(соль‖код). Тот, кто видит адреса
// (оператор инфраструктуры, логи, дамп хранилища), перебирает коды и фразы
// со скоростью SHA-256 на GPU и упирается в PBKDF2 ровно один раз — на
// уже найденном ответе. Для фразы из 3 слов это часы, а не годы.
//
// Схема 2: один PBKDF2 → t1; адрес = HKDF(t1, 'zv-code-addr-v2'), ключ blob-а
// = HKDF(t1, 'zv-code-key-v2'). Проверка любой догадки по адресу теперь
// стоит полный PBKDF2. Сервер и формат адреса (64 hex) не меняются.
//
// Совместимость: claim сначала идёт по адресу схемы 2, при 404 — по старому
// адресу (записи, созданные клиентами ≤ v35, живут до своего TTL; постоянные
// короткие ссылки — до перевыпуска). Старый ключ — это сам t1: PBKDF2 с
// длиной 256 бит и есть прежний deriveKey, поэтому один KDF кормит обе ветки.
// =======================================================================
const CODE_KINDS = {
  greet: { salt: GREET_SALT, iterations: GREET_PBKDF2_ITER, legacyAddr: (c) => sha256hex(GREET_SALT + c) },
  alias: { salt: ALIAS_SALT, iterations: ALIAS_PBKDF2_ITER, legacyAddr: (c) => sha256hex(ALIAS_SALT + c) },
  word: { salt: WORD_SALT, iterations: WORD_PBKDF2_ITER, legacyAddr: (c) => sha256hex(WORD_SALT + ':' + c) },
};

const bytesHex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

// Нормализация ввода общая для всех схем: фраза — normalizeWordPhrase,
// коды — trim (как в v25–v35).
function normalizeCode(kind, code) {
  return kind === 'word' ? normalizeWordPhrase(code) : String(code).trim();
}

/**
 * Материал доступа по коду/фразе.
 * @param {'greet'|'alias'|'word'} kind
 * @param {string} code
 * @returns {Promise<{addr: string, key: CryptoKey, legacy: {addr: string, key: CryptoKey}}>}
 */
export async function codeAccess(kind, code) {
  const spec = CODE_KINDS[kind];
  if (!spec) throw new Error('unknown code kind: ' + kind);
  const norm = normalizeCode(kind, code);
  const base = await crypto.subtle.importKey('raw', te.encode(norm), 'PBKDF2', false, ['deriveBits']);
  const t1 = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: te.encode(spec.salt), iterations: spec.iterations, hash: 'SHA-256' },
    base,
    256
  );
  const hk = await crypto.subtle.importKey('raw', t1, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(spec.salt), info: te.encode(info) });
  const addrBits = await crypto.subtle.deriveBits(hkdf('zv-code-addr-v2'), hk, 256);
  const key = await crypto.subtle.deriveKey(hkdf('zv-code-key-v2'), hk, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const legacyKey = await crypto.subtle.importKey('raw', t1, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { addr: bytesHex(addrBits), key, legacy: { addr: await spec.legacyAddr(norm), key: legacyKey } };
}

/** Запечатать объект ключом из codeAccess → base64url(nonce‖ct). */
export async function sealCodeBlob(key, payloadObj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(payloadObj)))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64u.enc(out);
}

/** Открыть blob ключом из codeAccess; неверный ключ/битый blob → null. */
export async function openCodeBlob(key, blobB64) {
  try {
    const raw = b64u.dec(blobB64);
    if (raw.length < 13) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}

/**
 * Адрес записи для отзыва/обслуживания по схеме, которой она создана.
 * scheme 2 — v36+, иначе — старый быстрый адрес (записи ≤ v35).
 */
export async function codeAddrForScheme(kind, code, scheme) {
  if (scheme === 2) return (await codeAccess(kind, code)).addr;
  return CODE_KINDS[kind].legacyAddr(normalizeCode(kind, code));
}

// =======================================================================
// v39: привязка нового устройства к профилю (как «Связанные устройства»
// Signal). Новое устройство B показывает 12-значный код и QR; основное A
// вводит код (или сканирует QR) и подтверждает. Код — 12 цифр (~40 бит);
// из него медленным KDF (PBKDF2 300 000) выводятся ДВА адреса одноразовых
// записей Pairing DO и два ключа AES-GCM: запрос B→A (req) и ответ A→B
// (resp). Сервер видит только адреса и шифротекст.
//
// Защита от подмены сервером: (1) запрос запечатан ключом из кода — без
// перебора кода сервер его не подделает; перебор 10^12 × 300k PBKDF2 за
// минуты жизни запроса нереален; (2) QR несёт ещё и отпечаток (bind) ключей
// нового устройства — сканирующее устройство сверяет его автоматически,
// подмена исключена совсем; (3) ответ (секреты профиля) шифруется ECDH-
// ключом из запроса (эфемерные eA/eB) с примесью материала кода; (4) оба
// экрана показывают 4 контрольных слова — человек сверяет их глазами.
// =======================================================================
export const LINK_SALT = 'zv-link-v1';
const LINK_PBKDF2_ITER = 300000;
export const LINK_CODE_DIGITS = 12;

export function newLinkCode() {
  let out = '';
  while (out.length < LINK_CODE_DIGITS) {
    for (const x of crypto.getRandomValues(new Uint8Array(24))) {
      // отбраковка 250..255 — равномерные цифры
      if (x < 250 && out.length < LINK_CODE_DIGITS) out += String(x % 10);
    }
  }
  return out;
}

export function normalizeLinkCode(s) {
  return String(s || '').replace(/\D+/g, '');
}

export function formatLinkCode(code) {
  return normalizeLinkCode(code).replace(/(\d{4})(?=\d)/g, '$1 ');
}

// Ссылка/QR вида #link=<12 цифр>.<bind>; bind необязателен (ручной ввод).
export function parseLinkToken(s) {
  const m = String(s || '').trim().match(/(?:#|&|^)link=([0-9 -]{12,20})(?:\.([A-Za-z0-9_-]{16,43}))?/);
  const raw = m ? m[1] : String(s || '');
  const code = normalizeLinkCode(raw);
  if (code.length !== LINK_CODE_DIGITS) return null;
  return { code, bind: m && m[2] ? m[2] : null };
}

/**
 * Адреса и ключи записей привязки по коду.
 * @returns {Promise<{req:{addr,key}, resp:{addr,key}, mix: Uint8Array}>}
 */
export async function linkAccess(code) {
  const norm = normalizeLinkCode(code);
  if (norm.length !== LINK_CODE_DIGITS) throw new Error('bad link code');
  const base = await crypto.subtle.importKey('raw', te.encode(norm), 'PBKDF2', false, ['deriveBits']);
  const t1 = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: te.encode(LINK_SALT), iterations: LINK_PBKDF2_ITER, hash: 'SHA-256' },
    base,
    256
  );
  const hk = await crypto.subtle.importKey('raw', t1, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(LINK_SALT), info: te.encode(info) });
  const part = async (tag) => ({
    addr: bytesHex(await crypto.subtle.deriveBits(hkdf('zv-link-addr-' + tag), hk, 256)),
    key: await crypto.subtle.deriveKey(hkdf('zv-link-key-' + tag), hk, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  });
  const mix = new Uint8Array(await crypto.subtle.deriveBits(hkdf('zv-link-mix'), hk, 256));
  return { req: await part('req'), resp: await part('resp'), mix };
}

// Канонический текст запроса (ключи нового устройства) — его хэш и есть
// bind в QR и основа контрольных слов.
export function linkReqText(req) {
  return ['zv-link-req-v1', req.eB, req.devicePub, req.ecdhPub, req.label || '', req.ts || 0].join('|');
}

export async function linkBindOf(req) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(linkReqText(req))));
  return b64u.enc(h.subarray(0, 16));
}

// 4 контрольных слова из словаря чата: SHA-256(код | bind). Совпадают на
// обоих экранах, только если A получил ровно тот запрос, что создал B.
export async function linkSasWords(code, bind) {
  const h = new Uint8Array(
    await crypto.subtle.digest('SHA-256', te.encode('zv-link-sas-v1|' + normalizeLinkCode(code) + '|' + bind))
  );
  return [h[0], h[1], h[2], h[3]].map((x) => CHAT_WORDS[x]);
}

// Ключ ответа A→B: HKDF(ECDH(eA, eB), соль = mix кода, info с bind).
export async function linkRespKey(myEcdhPriv, peerPubB64, mix, bind) {
  const peer = await crypto.subtle.importKey('raw', b64u.dec(peerPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, myEcdhPriv, 256);
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: mix, info: te.encode('zv-link-resp-v1|' + bind) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// =======================================================================
// v27: мессенджерные управляющие сообщения (реакции, правки, удаление,
// закреп) — ЧИСТЫЕ функции состояния. Живут здесь, потому что chat.js при
// импорте трогает DOM и в Node-тестах не поднимается; вся логика применения
// управляющих сообщений вынесена в тестируемые чистые функции, а chat.js
// только вызывает их при ingest и при собственной отправке.
//
// Модель: управляющие сообщения — обычные подписанные сообщения чата
// (type 'react' | 'edit' | 'del' | 'pin' | 'unpin' | 'ttl'), цель — по
// хэшу blob целевого сообщения (entry.hash в локальном хранилище).
// =======================================================================
export const REACT_EMOJIS = ['❤️', '👍', '🔥', '😂', '😮', '💩', '👎'];

// Состояние реакций одного сообщения: {emoji: [devPub, ...]}.
// Возвращает СЛЕДУЮЩУЮ операцию для dev: если dev уже ставил этот emoji —
// 'remove' (toggle), иначе 'add'. Неизвестный emoji → null (нельзя отправить).
export function nextReactionOp(reactions, dev, emoji) {
  if (!REACT_EMOJIS.includes(emoji) || !dev) return null;
  const list = reactions?.[emoji] || [];
  return list.includes(dev) ? 'remove' : 'add';
}

// Применение одной реакции к состоянию. Чистая: возвращает новый объект,
// входной не мутирует. Чужие/неизвестные emoji и пустые dev игнорируются.
export function applyReactionState(reactions, dev, emoji, op) {
  const out = {};
  for (const [k, v] of Object.entries(reactions || {})) {
    if (Array.isArray(v) && v.length) out[k] = [...v];
  }
  if (!REACT_EMOJIS.includes(emoji) || !dev || (op !== 'add' && op !== 'remove')) return out;
  const list = out[emoji] || [];
  const has = list.includes(dev);
  if (op === 'add' && !has) list.push(dev);
  if (op === 'remove' && has) list.splice(list.indexOf(dev), 1);
  if (list.length) out[emoji] = list;
  else delete out[emoji];
  return out;
}

// Применение 'edit'/'del' к локальной записи сообщения (entry = {msg, ...}).
// Правила: подпись обязана быть валидна (sigOk посчитан вызывающим через
// verifyChatSig), автор управляющего сообщения обязан совпадать с автором
// оригинала, удалённое сообщение больше не редактируется и не удаляется
// повторно. Мутирует entry.msg при успехе; возвращает true, если применено.
export function applyEditOrDelete(entry, ctrlMsg, sigOk) {
  if (!entry?.msg || !ctrlMsg || !sigOk) return false;
  if (ctrlMsg.devPub !== entry.msg.devPub) return false; // только автор оригинала
  if (entry.msg.deleted) return false;
  if (ctrlMsg.type === 'edit') {
    let text = null;
    try {
      text = JSON.parse(ctrlMsg.text || '')?.text;
    } catch {}
    if (typeof text !== 'string' || !text) return false;
    entry.msg.text = text;
    entry.msg.edited = true;
    return true;
  }
  if (ctrlMsg.type === 'del') {
    entry.msg.deleted = true;
    entry.msg.text = '';
    return true;
  }
  return false;
}

// Применение 'pin'/'unpin': активен один закреп, последний побеждает.
// Возвращает новое значение pinned (или undefined — «без изменений», если
// подпись невалидна). pinned: {hash, by, ts} | null.
export function applyPinState(current, ctrlMsg, sigOk) {
  if (!ctrlMsg || !sigOk) return undefined;
  if (ctrlMsg.type === 'pin') {
    let target = null;
    try {
      target = JSON.parse(ctrlMsg.text || '')?.target;
    } catch {}
    if (typeof target !== 'string' || !target) return undefined;
    return { hash: target, by: ctrlMsg.devPub, ts: ctrlMsg.ts || 0 };
  }
  if (ctrlMsg.type === 'unpin') return null;
  return undefined;
}

// =======================================================================
// v27: фраза восстановления личности и серверный бэкап (этап 4 техплана
// v15, адаптированный под серверное хранение в PairingDO).
//
// Seed бэкапа — 128 бит. Кодировка фразы: seed (16 байт) + первый байт
// SHA-256(seed) = 17 байт; каждый байт — одно слово из CHAT_WORDS (256
// слов, тот же список, что у контрольной фразы комнаты). Итого 17 слов:
// 16 слов данных + 1 контрольное. Ошибка в любом слове ловится контрольной
// суммой при вводе (decode бросает понятную ошибку), неизвестное слово —
// тоже. Фраза = полная власть над личностью: по ней выводятся И ключ
// бэкапа (шифрование списка комнат), И recovery-пара (подпись бэкапа и
// сертификатов новых устройств).
// =======================================================================
export const RECOVERY_WORDS_COUNT = 17;
export const RECOVERY_SEED_BYTES = 16;

export async function mnemonicEncode(seedBytes) {
  if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== RECOVERY_SEED_BYTES) {
    throw new Error('mnemonic: нужен seed ровно 16 байт');
  }
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', seedBytes));
  const all = new Uint8Array(RECOVERY_SEED_BYTES + 1);
  all.set(seedBytes, 0);
  all[RECOVERY_SEED_BYTES] = h[0];
  return [...all].map((b) => CHAT_WORDS[b]).join(' ');
}

export async function mnemonicDecode(phrase) {
  const words = String(phrase || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length !== RECOVERY_WORDS_COUNT) {
    throw new Error(`Фраза восстановления — ${RECOVERY_WORDS_COUNT} слов, получено ${words.length}`);
  }
  const bytes = new Uint8Array(RECOVERY_WORDS_COUNT);
  for (let i = 0; i < words.length; i++) {
    const idx = CHAT_WORDS.indexOf(words[i]);
    if (idx < 0) throw new Error(`Слова «${words[i]}» нет в списке слов ZVONochek`);
    bytes[i] = idx;
  }
  const seed = bytes.subarray(0, RECOVERY_SEED_BYTES);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', seed));
  if (bytes[RECOVERY_SEED_BYTES] !== h[0]) {
    throw new Error('Контрольная сумма фразы не сошлась: где-то ошибка в словах');
  }
  return new Uint8Array(seed);
}

// Recovery-пара из seed: скаляр = HKDF(seed, 'zv-recovery-v1'), публичная
// точка — существующей механикой p256KeyPairFromPriv (v24). Вывод
// детерминирован: одна фраза → одна пара на любом устройстве.
export async function deriveRecoveryPair(seedBytes) {
  if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== RECOVERY_SEED_BYTES) {
    throw new Error('recovery: нужен seed 16 байт');
  }
  const base = await crypto.subtle.importKey('raw', seedBytes, 'HKDF', false, ['deriveBits']);
  for (let counter = 0; ; counter++) {
    const info = counter === 0 ? 'zv-recovery-v1' : `zv-recovery-v1/${counter}`;
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: te.encode('ZVONochek/v27'), info: te.encode(info) },
        base,
        256
      )
    );
    try {
      const pair = await p256KeyPairFromPriv(bits, ['sign'], 'ECDSA');
      const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      return { publicKey: pair.publicKey, privateKey: pair.privateKey, pubRaw, pubB64: b64u.enc(pubRaw) };
    } catch {
      // Скаляр вне [1, n-1] — шанс ~2^-128, но вывод обязан быть тотальным:
      // следующая попытка с другим info даёт независимый скаляр.
      continue;
    }
  }
}

async function deriveBackupKey(seedBytes) {
  const base = await crypto.subtle.importKey('raw', seedBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode('ZVONochek/v27'), info: te.encode('zv-backup-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Запечатать объект бэкапа ключом из seed → base64url(iv || ct).
export async function sealBackup(seedBytes, obj) {
  const key = await deriveBackupKey(seedBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64u.enc(out);
}

// Открыть бэкап; неверный seed / битый blob → null (не исключение).
export async function openBackup(seedBytes, blobB64) {
  try {
    const key = await deriveBackupKey(seedBytes);
    const raw = b64u.dec(blobB64);
    if (raw.length < 13) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12) },
      key,
      raw.subarray(12)
    );
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}

// Адрес серверного бэкапа: SHA-256 от сырого (65 байт) recovery-публичного
// ключа, hex — совпадает с проверкой на стороне PairingDO.
export async function backupIdHash(pubRaw) {
  return sha256hex(pubRaw);
}

// =======================================================================
// v31: ХРАПОВИК — forward secrecy для переписки. До v31 ключ комнаты был
// статичным: утечка seed/ключа эпохи открывала ВЕСЬ серверный архив
// переписки задним числом. Теперь каждое сообщение шифруется одноразовым
// ключом, а цепочки ключей необратимо продвигаются (ключи прошлого
// уничтожить — в этом и смысл).
//
// УРОВЕНЬ 1 — цепочки отправителя (Sender Chains), все комнаты и эпохи.
// На пару (эпоха, отправитель-dev) цепочка выводится из того же IKM, что
// ключ эпохи (deriveEpochRoomKey), отдельной HKDF-меткой
// 'zv-chain-v1:<devPub>': корень цепочки может вывести любой участник
// комнаты (как в Signal Sender Keys — секретность внутри группы не цель;
// цель — необратимость продвижения). mk_n = HMAC(ck_n, 'zv-mk'),
// ck_{n+1} = HMAC(ck_n, 'zv-ck'). Сообщение несёт rk:'c1', cn:n внутри
// шифротекста.
//
// Маршрутизация без вскрытия: получатель не знает отправителя и cn, пока
// не расшифрует, а сервер требует blob строго 4124 байта — свободного
// места в формате нет. Поэтому подсказка лежит в nonce (12 байт, всегда
// был виден на проводе): байт 0 — режим ('C' chain / 'D' DR / 'T' DR
// transit), дальше cn и короткий тег отправителя/цепочки. Уникальность
// пары (ключ, nonce) при этом не страдает: ключ сообщения одноразовый,
// а в nonce дополнительно есть случайные байты. Старые сообщения (≤v30)
// имеют полностью случайный nonce: подсказка может случайно совпасть с
// тегом режима (шанс ~3/256) — вызывающий код при неудаче маршрутного
// пути обязан откатываться на статичную расшифровку (chat.js так и делает).
//
// УРОВЕНЬ 2 — Double Ratchet для комнат 1:1: классика Signal поверх
// цепочек уровня 1 (KDF root-цепочки, DH-шаг при смене направления).
// Заголовок (rk:'d1', dh, pn, cn) — внутри шифротекста; первое сообщение
// новой цепочки едет «транзитом»: завёрнуто компактно ключом новой
// цепочки, снаружи — обычным сообщением type:'drx', зашифрованным
// предыдущей цепочкой отправителя (или цепочкой уровня 1 для самого
// первого сообщения сессии): получатель сначала открывает внешнее
// (ключи у него есть), узнаёт новый dh, делает DH-шаг и открывает
// внутреннее. Состояния — чистые JSON-объекты, переходы — функции ниже;
// chat.js только хранит состояние и делает ввод-вывод.
// =======================================================================
// v38: потолок пропуска поднят с 1000 до 200 000. Раньше участник, у
// которого в старом чате набралось >1000 сообщений (включая служебные
// heartbeat группового звонка), становился НЕЧИТАЕМЫМ для новичка и для
// вернувшегося после долгого офлайна: разрыв цепочки >1000 → 'gap' →
// сообщение молча терялось. Проход теперь синхронный (sha256/HMAC на JS,
// ~2–10 мкс на шаг) и уступает поток каждые 8192 шага.
export const CHAIN_MAX_GAP = 200000; // потолок пропуска вперёд за один take
export const CHAIN_SKIPPED_MAX = 256; // потолок сохранённых skipped-ключей на цепочку

// ---------- v38: синхронные SHA-256 и HMAC-SHA256 (быстрый проход цепочек) ----------
// Результат бит-в-бит совпадает с WebCrypto (проверено тестом); асинхронный
// WebCrypto на каждый шаг цепочки стоил ~0.1–0.5 мс, что делало длинные
// разрывы неподъёмными на слабых телефонах.
const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const shaW = new Int32Array(64);

function shaCompress(H, buf, off) {
  const W = shaW;
  for (let i = 0; i < 16; i++) {
    const j = off + i * 4;
    W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15];
    const b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0;
  H[1] = (H[1] + b) | 0;
  H[2] = (H[2] + c) | 0;
  H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0;
  H[5] = (H[5] + f) | 0;
  H[6] = (H[6] + g) | 0;
  H[7] = (H[7] + h) | 0;
}

export function sha256Sync(msg) {
  const data = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
  const len = data.length;
  const total = (((len + 9 + 63) >> 6) << 6) >>> 0;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, (len * 8) >>> 0, false);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
  const H = new Int32Array(SHA_IV);
  for (let off = 0; off < total; off += 64) shaCompress(H, buf, off);
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i] >>> 0, false);
  return out;
}

export function hmacSha256Sync(keyBytes, data) {
  let k = keyBytes instanceof Uint8Array ? keyBytes : new Uint8Array(keyBytes);
  if (k.length > 64) k = sha256Sync(k);
  const msg = typeof data === 'string' ? te.encode(data) : data;
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    const kb = i < k.length ? k[i] : 0;
    inner[i] = kb ^ 0x36;
    outer[i] = kb ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256Sync(inner), 64);
  return sha256Sync(outer);
}

const CHAIN_MK = te.encode('zv-mk');
const CHAIN_CK = te.encode('zv-ck');
const yieldNow = () => new Promise((r) => setTimeout(r, 0));

// v38: ключ сообщения номер cn по ck на позиции startN (для повторного
// вывода из корня цепочки, когда ключ уже израсходован/вытеснен: повтор
// cn у отправителя, сообщение старой эпохи, опоздавшее сообщение вне окна
// skipped). onCheckpoint(n, ckBytes) вызывается каждые 512 шагов — кэш в
// памяти вызывающего. null — неверный номер или разрыв больше потолка.
export async function chainKeyAt(startCkB64, startN, cn, onCheckpoint = null) {
  if (!Number.isInteger(cn) || !Number.isInteger(startN) || cn < startN || cn - startN > CHAIN_MAX_GAP) {
    return null;
  }
  let ck = b64u.dec(startCkB64);
  for (let k = startN; k < cn; k++) {
    ck = hmacSha256Sync(ck, CHAIN_CK);
    if (onCheckpoint && ((k + 1) & 511) === 0) onCheckpoint(k + 1, ck);
    if (((k - startN) & 8191) === 8191) await yieldNow();
  }
  return hmacSha256Sync(ck, CHAIN_MK);
}

// v38: продвинуть отправляющую цепочку до позиции toN (самолечение после
// отката состояния: номера, уже ушедшие в сеть, повторно не выдаются).
export async function chainAdvanceSend(state, toN) {
  if (!state || !Number.isInteger(toN) || toN <= state.n || toN - state.n > CHAIN_MAX_GAP) return false;
  let ck = b64u.dec(state.ck);
  for (let k = state.n; k < toN; k++) {
    ck = hmacSha256Sync(ck, CHAIN_CK);
    if (((k - state.n) & 8191) === 8191) await yieldNow();
  }
  state.ck = b64u.enc(ck);
  state.n = toN;
  return true;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const dataBytes = typeof data === 'string' ? te.encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

export async function aesKeyFromRaw(rawBytes) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length !== 32) throw new Error('bad aes key');
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Варианты encryptChatMessage/decryptChatMessage с явным ключом-сырьём и
// явным nonce: паддинг и формат blob — те же (4124 байта), поэтому сервер
// и старые проверки размера не замечают разницы.
export async function encryptChatWithKeyBytes(keyBytes, msgObj, nonce) {
  const key = await aesKeyFromRaw(keyBytes);
  const json = te.encode(JSON.stringify(msgObj));
  if (json.length > CHAT_PT_SIZE - 2) throw new Error('message too long');
  const pt = new Uint8Array(CHAT_PT_SIZE);
  new DataView(pt.buffer).setUint16(0, json.length, false);
  pt.set(json, 2);
  crypto.getRandomValues(pt.subarray(2 + json.length));
  const iv = nonce ? new Uint8Array(nonce) : crypto.getRandomValues(new Uint8Array(12));
  if (iv.length !== 12) throw new Error('bad nonce');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  const blob = new Uint8Array(CHAT_BLOB_SIZE);
  blob.set(iv, 0);
  blob.set(ct, 12);
  return blob;
}

export async function decryptChatWithKeyBytes(keyBytes, blob) {
  const key = await aesKeyFromRaw(keyBytes);
  return decryptChatMessage(key, blob);
}

// Компактное запечатывание БЕЗ паддинга (nonce||ct переменной длины):
// используется только внутри drx-обёрток, которые сами едут в обычном
// padded-blob, — наружу компактный формат не выходит.
export async function sealCompactWithKeyBytes(keyBytes, obj) {
  const key = await aesKeyFromRaw(keyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function openCompactWithKeyBytes(keyBytes, bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 13) return null;
    const key = await aesKeyFromRaw(keyBytes);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
      key,
      bytes.subarray(12)
    );
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}

// ---------- Подсказки в nonce ----------
const NONCE_TAG = { chain: 0x43, dr: 0x44, transit: 0x54 }; // 'C' 'D' 'T'

// Тег маршрутизации: первые 4 байта сырого публичного ключа (65 байт,
// 0x04||X||Y). Энтропии тега хватает различить отправителей/цепочки
// внутри одной комнаты; после расшифровки принадлежность проверяется
// строго (devPub/dh сверяются полностью).
export function pubTagOf(pubRaw) {
  return new Uint8Array(pubRaw).subarray(0, 4);
}
export const pubTagHex = (pubRaw) =>
  [...pubTagOf(pubRaw)].map((x) => x.toString(16).padStart(2, '0')).join('');

function nonceWithTag(tag, cn, tagBytes, tailLen) {
  const nonce = new Uint8Array(12);
  nonce[0] = tag;
  new DataView(nonce.buffer).setUint32(1, cn >>> 0, false);
  nonce.set(new Uint8Array(tagBytes).subarray(0, 4), 5);
  const tail = crypto.getRandomValues(new Uint8Array(tailLen));
  nonce.set(tail, 9);
  return nonce;
}

// 'C': [tag][cn:4][epoch:2][devTag:2]… — для цепочки эпоха нужна до
// расшифровки, поэтому раскладка своя: [tag][cn:4][epoch:2][devTag(первые
// 2 байта ключа dev — маршрутизация) + 3 случайных]. Полный devTag (4
// байта) в 12 байт вместе с cn и эпохой не влезает; 2 байта тега + строгая
// проверка devPub после расшифровки дают достаточную маршрутизацию:
// коллизия тегов двух участников комнаты практически исключена, а при
// коллизии вызывающий перебирает обоих кандидатов.
export function chainNonce(cn, epoch, devPubRaw) {
  const nonce = new Uint8Array(12);
  nonce[0] = NONCE_TAG.chain;
  new DataView(nonce.buffer).setUint32(1, cn >>> 0, false);
  new DataView(nonce.buffer).setUint16(5, epoch & 0xffff, false);
  nonce.set(pubTagOf(devPubRaw).subarray(0, 2), 7);
  nonce.set(crypto.getRandomValues(new Uint8Array(3)), 9);
  return nonce;
}

// 'D': [tag][cn:4][dhTag:4][rand:3] — dhTag = первые 4 байта публичного
// ключа цепочки (dh), получатель выбирает принимающую цепочку по нему.
export function drNonce(cn, dhPubRaw) {
  return nonceWithTag(NONCE_TAG.dr, cn, pubTagOf(dhPubRaw), 3);
}

// 'T': [tag][cn:4][prevDhTag:4][rand:3] — cn и цепочка относятся к
// ПРЕДЫДУЩЕЙ отправляющей цепочке отправителя: её ключом зашифрована
// внешняя drx-обёртка.
export function transitNonce(cn, prevDhPubRaw) {
  return nonceWithTag(NONCE_TAG.transit, cn, pubTagOf(prevDhPubRaw), 3);
}

// Разбор подсказки; null — подсказки нет (случайный nonce старых версий
// или статичных служебных сообщений).
export function parseBlobHint(nonce) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12) return null;
  const dv = new DataView(nonce.buffer, nonce.byteOffset, 12);
  const tag = nonce[0];
  if (tag === NONCE_TAG.chain) {
    return {
      mode: 'c1',
      cn: dv.getUint32(1, false),
      epoch: dv.getUint16(5, false),
      tag: [...nonce.subarray(7, 9)],
    };
  }
  if (tag === NONCE_TAG.dr) return { mode: 'd1', cn: dv.getUint32(1, false), tag: hex(nonce.subarray(5, 9)) };
  if (tag === NONCE_TAG.transit)
    return { mode: 'tx', cn: dv.getUint32(1, false), tag: hex(nonce.subarray(5, 9)) };
  return null;
}

export const tagBytesEq = (a, b) => a?.length === b?.length && a.every((v, i) => v === b[i]);

// ---------- Уровень 1: цепочки отправителя ----------
// IKM корня цепочки повторяет IKM ключа эпохи (deriveEpochRoomKey):
// эпоха 0 — seed‖pinIkm?; эпоха ≥1 — seed‖pinIkm?‖epochSecret. Метка
// HKDF отдельная, поэтому ключи эпохи и цепочки не пересекаются.
export async function deriveChainRoot(seedBytes, pinIkm, epochSecret, epoch, devPub) {
  const parts = [seedBytes];
  if (pinIkm) parts.push(pinIkm);
  if (Number(epoch) > 0) {
    if (!(epochSecret instanceof Uint8Array) || epochSecret.length !== 32) {
      throw new Error('chain: нет секрета эпохи');
    }
    parts.push(epochSecret);
  }
  const ikm = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    ikm.set(p, off);
    off += p.length;
  }
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: te.encode('ZVONochek/chat/v1'),
      info: te.encode('zv-chain-v1:' + devPub),
    },
    base,
    256
  );
  return b64u.enc(bits);
}

export const chainInitSendState = (ckB64) => ({ ck: ckB64, n: 0 });
export const chainInitRecvState = (ckB64) => ({ ck: ckB64, nextN: 0, skipped: [] });

// Отправка: ключ сообщения из текущего ck, цепочка продвигается.
// Мутирует state; возвращает {mk (bytes), cn}.
export async function chainSendTake(state) {
  const ck = b64u.dec(state.ck);
  const mk = await hmacSha256(ck, 'zv-mk');
  state.ck = b64u.enc(await hmacSha256(ck, 'zv-ck'));
  const cn = state.n;
  state.n += 1;
  return { mk, cn };
}

function skippedSet(state, n, mkBytes) {
  const arr = state.skipped;
  const i = arr.findIndex(([k]) => k === n);
  if (i >= 0) arr[i] = [n, b64u.enc(mkBytes)];
  else arr.push([n, b64u.enc(mkBytes)]);
  while (arr.length > CHAIN_SKIPPED_MAX) {
    let minI = 0;
    for (let j = 1; j < arr.length; j++) if (arr[j][0] < arr[minI][0]) minI = j;
    arr.splice(minI, 1);
  }
}

// Приём: достать ключ сообщения cn из принимающей цепочки.
//  - cn == nextN: вывести из ck и продвинуться;
//  - cn >  nextN: промежуточные ключи — в skipped (потолок пропуска
//    CHAIN_MAX_GAP, дальше — status 'gap' БЕЗ мутации состояния);
//  - cn <  nextN: ключ только из skipped, после использования УДАЛЯЕТСЯ;
//    нет в skipped — status 'unavailable' (ключ уже использован/вытеснен:
//    прямое следствие forward secrecy).
//  - state.pruned (ck стёрт сменой эпохи): работает только skipped-ветка.
// Мутирует state только при status 'ok'. Возвращает {status, mk?}.
export async function chainRecvTake(state, cn, maxGap = CHAIN_MAX_GAP) {
  if (!Number.isInteger(cn) || cn < 0) return { status: 'unavailable' };
  if (cn < state.nextN) {
    const i = state.skipped.findIndex(([k]) => k === cn);
    if (i < 0) return { status: 'unavailable' };
    const mk = b64u.dec(state.skipped[i][1]);
    state.skipped.splice(i, 1);
    return { status: 'ok', mk };
  }
  if (state.pruned || !state.ck) return { status: 'unavailable' };
  const gap = cn - state.nextN;
  if (gap > Math.min(maxGap, CHAIN_MAX_GAP)) return { status: 'gap' };
  // v38: синхронный проход; ключи skipped считаем только для последних
  // CHAIN_SKIPPED_MAX позиций — более ранние всё равно были бы вытеснены
  // (результат тот же, что у прежнего полного прохода с вытеснением).
  let ck = b64u.dec(state.ck);
  const keepFrom = Math.max(state.nextN, cn - CHAIN_SKIPPED_MAX);
  for (let k = state.nextN; k < cn; k++) {
    if (k >= keepFrom) skippedSet(state, k, hmacSha256Sync(ck, CHAIN_MK));
    ck = hmacSha256Sync(ck, CHAIN_CK);
    if (((k - state.nextN) & 8191) === 8191) await yieldNow();
  }
  const mk = hmacSha256Sync(ck, CHAIN_MK);
  state.ck = b64u.enc(hmacSha256Sync(ck, CHAIN_CK));
  state.nextN = cn + 1;
  return { status: 'ok', mk };
}

// Смена эпохи: принимающая цепочка старой эпохи теряет ck (вывести новые
// ключи из неё больше нельзя), остаются только skipped-ключи недоставленных
// сообщений. Мутирует и возвращает state.
export function chainPruneRecvState(state) {
  if (!state) return state;
  state.ck = null;
  state.pruned = true;
  return state;
}

// ---------- Уровень 2: Double Ratchet ----------
// ECDH между существующими парами проекта (ECDH P-256, 256 бит общего
// секрета — как в завёртках эпох).
export async function ecdhSharedBits(privKey, pubRawBytes) {
  const pub = await crypto.subtle.importKey(
    'raw',
    pubRawBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, privKey, 256));
}

// Случайный валидный скаляр P-256 (для ratchet-пар: приватная половина
// должна переживать перезагрузку, поэтому пара строится из скаляра
// функцией p256KeyPairFromPriv, а скаляр хранится vault-зашифрованным).
export function randomP256Scalar() {
  for (;;) {
    const d = crypto.getRandomValues(new Uint8Array(32));
    try {
      p256PubFromPriv(d);
      return d;
    } catch {}
  }
}

export async function drPairFromScalar(scalarBytes) {
  const pair = await p256KeyPairFromPriv(scalarBytes, ['deriveBits'], 'ECDH');
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, pubRaw };
}

// Корень сессии DR: HKDF(ECDH(eph, staticPeer) ‖ секрет эпохи) — привязка
// к комнате и её эпохе инициации. Для эпохи 0 «секрет эпохи» — seed.
export async function drRootFromInit(sharedBytes, epochSecretBytes) {
  const ikm = new Uint8Array(sharedBytes.length + epochSecretBytes.length);
  ikm.set(sharedBytes, 0);
  ikm.set(epochSecretBytes, sharedBytes.length);
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: te.encode('ZVONochek/chat/v1'),
      info: te.encode('zv-dr-v1'),
    },
    base,
    256
  );
  return b64u.enc(bits);
}

// KDF корня при DH-шаге: (новый root, ключ новой цепочки) — HKDF с
// солью = текущий root, IKM = выход ECDH (схема Signal).
export async function drKdfRk(rkB64, dhOutBytes) {
  const base = await crypto.subtle.importKey('raw', dhOutBytes, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: b64u.dec(rkB64),
        info: te.encode('zv-dr-v1/rk'),
      },
      base,
      512
    )
  );
  return { rk: b64u.enc(bits.subarray(0, 32)), ck: b64u.enc(bits.subarray(32, 64)) };
}

// Принимающий DH-шаг: по новому dh собеседника и pn (сколько сообщений
// он отправил на своей предыдущей цепочке) обновляет dr-состояние:
//  - хвост предыдущей принимающей цепочки: недостающие ключи — в skipped
//    (потолок CHAIN_MAX_GAP на добор; дальше — честно теряем хвост);
//  - корень продвигается, создаётся новая принимающая цепочка.
// dr — JSON-состояние из записи комнаты; stepPrivKey — CryptoKey пары,
// чья публичная половина была последней отправленной мной (или ключ ECDH
// устройства для самого первого шага отвечающего). Мутирует dr.
export async function drRecvStep(dr, stepPrivKey, theirPubRaw, pn) {
  // Повторный шаг на тот же dh (ре-транзит уже принятой цепочки) —
  // идемпотентный no-op: второй DH-шаг на том же ключе разъехал бы корни.
  if (dr.recvDh && pubTagHex(b64u.dec(dr.recvDh)) === pubTagHex(theirPubRaw)) {
    return pubTagHex(theirPubRaw);
  }
  const prevTag = dr.recvDh ? pubTagHex(b64u.dec(dr.recvDh)) : null;
  if (prevTag && dr.recvChains?.[prevTag] && Number.isInteger(pn) && pn >= 0) {
    const prev = dr.recvChains[prevTag];
    // pn из подписанного заголовка — авторитетная длина предыдущей
    // цепочки отправителя. Добираем недостающие ключи в skipped и
    // обрываем вывод: ck предыдущей цепочки после шага не живёт
    // (иначе ключи «хвоста» выводились бы бесконечно). Неконсистентный
    // pn (< уже принятых) — оборонительно ничего не трогаем.
    if (!prev.pruned && prev.ck && pn >= prev.nextN) {
      const fillTo = Math.min(pn, prev.nextN + CHAIN_MAX_GAP);
      let ck = b64u.dec(prev.ck);
      for (let k = prev.nextN; k < fillTo; k++) {
        skippedSet(prev, k, await hmacSha256(ck, 'zv-mk'));
        ck = await hmacSha256(ck, 'zv-ck');
      }
      prev.nextN = fillTo;
      prev.ck = null;
      prev.pruned = true;
    }
  }
  const dhOut = await ecdhSharedBits(stepPrivKey, theirPubRaw);
  const { rk, ck } = await drKdfRk(dr.rk, dhOut);
  dr.rk = rk;
  const dhB64 = b64u.enc(theirPubRaw);
  const tag = pubTagHex(theirPubRaw);
  dr.recvChains = dr.recvChains || {};
  if (!dr.recvChains[tag]) {
    dr.recvChains[tag] = { dh: dhB64, ck, nextN: 0, skipped: [] };
  }
  dr.recvDh = dhB64;
  return tag;
}

// Допустимость контентного сообщения при активной DR-сессии (политика
// против downgrade): контент от DR-собеседника принимается только в
// режиме d1; служебные типы идут своими путями (их подписи и семантика
// не зависят от режима шифрования контента).
export const DR_CONTENT_TYPES = new Set(['text', 'file', 'voice', 'react', 'edit', 'del']);
export function drDowngradeBlocked(dr, msg) {
  if (!dr || dr.suspended || !msg) return false;
  if (msg.devPub !== dr.peer) return false;
  if (!DR_CONTENT_TYPES.has(msg.type)) return false;
  return msg.rk !== 'd1';
}
