// ZVONochek — идентичность коммуникатора (техплан, этап 1).
// Master-ключ ECDSA P-256 (приватная часть — невыгружаемый CryptoKey в
// IndexedDB) удостоверяет ключи устройств; секрет личной ссылки зашифрован
// vault-ключом устройства. Личная ссылка: #k=<секрет>&d=<fp>, где fp — первые
// 32 hex SHA-256 от X9.62-представления master-публичного ключа.
import { b64u, newSecret, genP256KeyPair, deriveRecoveryPair } from './crypto.js?v=40';
import { kvGet, kvPut, kvDel } from './store.js?v=40';
import { utils as secpUtils } from './vendor/secp256k1.js?v=40';

const te = new TextEncoder();
let cached = null; // {secret, masterPub, masterPriv, fp, devicePub, devicePriv, cert, label}

export async function fpOfPubRaw(rawBytes) {
  const h = await crypto.subtle.digest('SHA-256', rawBytes);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

async function getVaultKey() {
  let key = await kvGet('vault', 'key');
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await kvPut('vault', 'key', key);
  }
  return key;
}

export async function hasPersonal() {
  try {
    return !!(await kvGet('identity', 'personal'));
  } catch {
    return false;
  }
}

// Канонический текст сертификата устройства и его выпуск произвольным
// issuer-ключом (v27 вынесено из ensureDevice: тот же формат и та же подпись
// нужны для recovery-сертификата и для устройств восстановленной личности).
export function deviceCertText(devicePub, label, exp) {
  return `zv-device-v1|${devicePub}|${label}|${exp}`;
}

export async function signDeviceCert(privKey, devicePub, label, exp) {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    te.encode(deviceCertText(devicePub, label, exp))
  );
  return { sig: b64u.enc(sig), label, exp };
}

async function ensureDevice(masterPriv, label) {
  let dev = await kvGet('devices', 'self');
  if (dev?.devicePriv && dev?.cert) return dev;
  if (!masterPriv) {
    // v27, восстановленная личность: master-приватника на этом устройстве
    // нет и не появится (он невыгружаем и остался на потерянном устройстве).
    // Устройство с сертификатом от recovery-ключа создаёт поток
    // восстановления (backup.js) ДО первого ensurePersonal; здесь его
    // отсутствие — ошибка состояния, а не повод падать молча.
    throw new Error('Восстановленная личность без устройства: сначала завершите восстановление по фразе');
  }
  const pair = await genP256KeyPair();
  const devicePub = b64u.enc(await crypto.subtle.exportKey('raw', pair.publicKey));
  const exp = Date.now() + 10 * 365 * 24 * 3600000; // сертификат устройства на 10 лет
  const cert = await signDeviceCert(masterPriv, devicePub, label, exp);
  dev = {
    devicePub,
    devicePriv: pair.privateKey,
    cert,
    label,
  };
  await kvPut('devices', 'self', dev);
  return dev;
}

// Создаёт идентичность при первом вызове, дальше — только читает.
export async function ensurePersonal(label = 'Владелец') {
  if (cached) return cached;
  const vault = await getVaultKey();
  let rec = await kvGet('identity', 'personal');
  if (!rec) {
    const pair = await genP256KeyPair();
    const masterPub = b64u.enc(await crypto.subtle.exportKey('raw', pair.publicKey));
    const secret = newSecret();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault, te.encode(secret));
    const secretEnc = b64u.enc(new Uint8Array([...iv, ...new Uint8Array(ct)]));
    rec = { masterPub, masterPriv: pair.privateKey, secretEnc, createdAt: Date.now() };
    await kvPut('identity', 'personal', rec);
  }
  const raw = b64u.dec(rec.secretEnc);
  const secretBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(0, 12) },
    vault,
    raw.subarray(12)
  );
  const secret = new TextDecoder().decode(secretBytes);
  const fp = await fpOfPubRaw(b64u.dec(rec.masterPub));
  const dev = await ensureDevice(rec.masterPriv, label);
  cached = {
    secret,
    masterPub: rec.masterPub,
    masterPriv: rec.masterPriv,
    fp,
    devicePub: dev.devicePub,
    devicePriv: dev.devicePriv,
    cert: dev.cert,
    // v27: у восстановленной личности устройство удостоверено цепочкой
    // master → recovery → device; chain уходит в inboxRegister как есть.
    chain: dev.chain || null,
    restored: !!rec.restored,
    // v39: устройство привязано к профилю другого (основного) устройства.
    linked: !!rec.linked,
    label: dev.label,
  };
  return cached;
}

// v38: «Сменить номер». Новая master-пара и новый секрет личной ссылки:
// новые topic и отпечаток d=…, по содержимому новую ссылку со старой не
// связать. Ключ устройства прежний (подписи и доверие в чатах не ломаются),
// его сертификат перевыпускается новым master. Recovery-сертификат был
// выдан старым master — состояние бэкапа сбрасывается (новая фраза).
// Возвращает {prev, next}: prev — бандл до смены (для отзыва старого Inbox).
export async function rotatePersonal() {
  const prev = await getPersonal();
  const vault = await getVaultKey();
  const pair = await genP256KeyPair();
  const masterPub = b64u.enc(await crypto.subtle.exportKey('raw', pair.publicKey));
  const secret = newSecret();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault, te.encode(secret));
  const secretEnc = b64u.enc(new Uint8Array([...iv, ...new Uint8Array(ct)]));
  const dev = await kvGet('devices', 'self');
  if (dev?.devicePub && dev?.devicePriv) {
    const label = dev.label || dev.cert?.label || 'Владелец';
    const exp = Date.now() + 10 * 365 * 24 * 3600000;
    const cert = await signDeviceCert(pair.privateKey, dev.devicePub, label, exp);
    const next = { ...dev, cert };
    delete next.chain; // цепочка восстановления относилась к старому master
    await kvPut('devices', 'self', next);
  }
  await kvPut('identity', 'personal', {
    masterPub,
    masterPriv: pair.privateKey,
    secretEnc,
    createdAt: Date.now(),
    rotatedAt: Date.now(),
  });
  try {
    await kvDel('identity', 'recovery');
  } catch {}
  cached = null;
  const next = await ensurePersonal();
  return { prev, next };
}

export async function getPersonal() {
  if (cached) return cached;
  return (await hasPersonal()) ? ensurePersonal() : null;
}

export function personalLinkOf(bundle) {
  return `${location.origin}${location.pathname}#k=${bundle.secret}&d=${bundle.fp}`;
}

// ---------- v27: состояние бэкапа личности (фраза восстановления) ----------
// Запись identity/recovery: {seedEnc, pub, cert, enabled, updatedAt}.
// seedEnc — seed фразы, зашифрованный vault-ключом устройства (как seed
// комнат): сама фраза на устройстве НЕ хранится, но seed нужен, чтобы
// подписывать обновления серверного бэкапа recovery-ключом без повторного
// ввода фразы. cert — публичный сертификат recovery-ключа от master
// (label 'recovery'), секретом не является.
export async function getRecoveryState() {
  try {
    return await kvGet('identity', 'recovery');
  } catch {
    return null;
  }
}

export async function saveRecoveryState(rec) {
  await kvPut('identity', 'recovery', rec);
}

export async function signWithDevice(text) {
  const p = await getPersonal();
  if (!p) throw new Error('no identity');
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    p.devicePriv,
    te.encode(text)
  );
  return b64u.enc(sig);
}

// Подпись произвольным ключом (для гостевого эфемерного ключа вызывающего).
export async function signWithKey(key, text) {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(text));
  return b64u.enc(sig);
}


// ---------- v21: чат — гостевое устройство, vault-хелперы, проверка подписей ----------
// У гостя без личной идентичности создаётся локальная пара устройства
// (без master-сертификата): сертификат в чате не требуется, закрепление
// собеседника идёт по TOFU из intro-сообщения. Существующий API выше не меняется.
export async function encryptWithVault(text) {
  const vault = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault, te.encode(text));
  return b64u.enc(new Uint8Array([...iv, ...new Uint8Array(ct)]));
}

export async function decryptWithVault(enc) {
  const vault = await getVaultKey();
  const raw = b64u.dec(enc);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(0, 12) },
    vault,
    raw.subarray(12)
  );
  return new TextDecoder().decode(pt);
}

export async function ensureGuestDevice(label = 'Гость') {
  let dev = await kvGet('devices', 'guest');
  if (dev?.devicePriv && dev?.devicePub) return dev;
  const pair = await genP256KeyPair();
  const devicePub = b64u.enc(await crypto.subtle.exportKey('raw', pair.publicKey));
  dev = { devicePub, devicePriv: pair.privateKey, cert: null, label, guest: true };
  await kvPut('devices', 'guest', dev);
  return dev;
}

// Устройство для подписи сообщений чата: личное, если идентичность есть,
// иначе гостевое. Возвращает {devicePub, devicePriv, cert, guest}.
export async function getChatDevice() {
  const p = await getPersonal();
  if (p) {
    return {
      devicePub: p.devicePub,
      devicePriv: p.devicePriv,
      cert: p.cert,
      guest: false,
      // v28: публичные данные личной идентичности для дозвона из чата.
      // masterPub/masterFp публичны; cert (и chain у восстановленной
      // личности) доказывает, что это устройство принадлежит master.
      masterPub: p.masterPub,
      masterFp: p.fp,
      chain: p.chain || null,
    };
  }
  const g = await ensureGuestDevice();
  return { devicePub: g.devicePub, devicePriv: g.devicePriv, cert: null, guest: true, masterPub: null, masterFp: null, chain: null };
}

// v26, фаза 3: отдельная ECDH-пара устройства для обмена эпохами. Подписной
// ECDSA-ключ для ECDH не годится (другие usages), поэтому у устройства две
// пары: ECDSA (подписи, как раньше) и ECDH (завёртка секретов эпох на это
// устройство). Публичная половина публикуется в комнату служебным сообщением
// type:'ecdh'; приватная — невыгружаемый CryptoKey в IndexedDB, как остальные.
export async function getChatDeviceEcdh() {
  const p = await getPersonal();
  const storeKey = p ? 'self-ecdh' : 'guest-ecdh';
  let dev = await kvGet('devices', storeKey);
  if (dev?.ecdhPriv && dev?.ecdhPub) return dev;
  const pair = await genP256KeyPair(['deriveBits'], 'ECDH');
  const ecdhPub = b64u.enc(await crypto.subtle.exportKey('raw', pair.publicKey));
  dev = { ecdhPub, ecdhPriv: pair.privateKey };
  await kvPut('devices', storeKey, dev);
  return dev;
}

// v28: стабильный Nostr-секрет устройства для резервного канала чата.
// У устройства нет экспортируемого долговременного секрета, из которого
// можно было бы вывести secp256k1-ключ, поэтому секрет создаётся один раз
// (валидный скаляр из vendored noble) и хранится vault-зашифрованным в той
// же записи устройства, что и остальные его материалы (как pinEnc в v26).
export async function getChatNostrSecret() {
  const p = await getPersonal();
  const storeKey = p ? 'self' : 'guest';
  if (!p) await ensureGuestDevice();
  let dev = await kvGet('devices', storeKey);
  if (!dev) throw new Error('устройство чата ещё не создано');
  if (!dev.nostrSecretEnc) {
    const secret = secpUtils.randomSecretKey();
    dev = { ...dev, nostrSecretEnc: await encryptWithVault(b64u.enc(secret)) };
    await kvPut('devices', storeKey, dev);
  }
  return b64u.dec(await decryptWithVault(dev.nostrSecretEnc));
}

export async function signChatText(text) {
  const d = await getChatDevice();
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    d.devicePriv,
    te.encode(text)
  );
  return b64u.enc(sig);
}

export async function verifyChatSig(devicePubB64, sigB64, text) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      b64u.dec(devicePubB64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64u.dec(sigB64),
      te.encode(text)
    );
  } catch {
    return false;
  }
}

// =======================================================================
// v39: несколько устройств одного профиля (devices.js).
// Модель доверия (как «Связанные устройства» Signal + кросс-подпись Matrix):
// master-ключ номера живёт на ОСНОВНОМ устройстве (невыгружаемый); любое
// устройство профиля удостоверено сертификатом от master — напрямую или по
// цепочке master → recovery → device (recovery-ключ из фразы
// восстановления). Подключённое устройство получает тот же секрет номера
// (те же входящие звонки), но master-приватника у него нет: подключать и
// отвязывать другие устройства и менять номер может только основное
// устройство или устройство, знающее фразу восстановления.
// =======================================================================
export const CERT_TTL_MS = 10 * 365 * 24 * 3600000;
export const LINKED_CERT_LABEL = 'Устройство';

export function resetIdentityCache() {
  cached = null;
}

async function verifyRaw(pubB64, sigB64, text) {
  return verifyChatSig(pubB64, sigB64, text);
}

// Сертификат устройства под master: прямой или по цепочке recovery.
export async function verifyDeviceCertClient(masterPub, devicePub, cert, chain = null) {
  if (!masterPub || !devicePub || !cert?.sig) return false;
  if (Number(cert.exp || 0) && Number(cert.exp) < Date.now()) return false;
  if (chain?.recoveryPub && chain?.recoveryCert?.sig) {
    if (chain.recoveryCert.label !== 'recovery') return false;
    const recOk = await verifyRaw(
      masterPub,
      chain.recoveryCert.sig,
      deviceCertText(chain.recoveryPub, chain.recoveryCert.label, chain.recoveryCert.exp)
    );
    if (!recOk) return false;
    return verifyRaw(chain.recoveryPub, cert.sig, deviceCertText(devicePub, cert.label, cert.exp));
  }
  return verifyRaw(masterPub, cert.sig, deviceCertText(devicePub, cert.label, cert.exp));
}

// Право администрировать профиль на ЭТОМ устройстве: master-приватник
// (основное устройство) или seed фразы восстановления, recovery-сертификат
// которого выдан текущим master. → {kind, sign(text), extra, issue(devPub)} | null
export async function adminSigner() {
  const p = await getPersonal();
  if (!p) return null;
  if (p.masterPriv) {
    return {
      kind: 'master',
      sign: (text) => signWithKey(p.masterPriv, text),
      extra: { masterPub: p.masterPub },
      issue: async (devicePub) => ({
        cert: await signDeviceCert(p.masterPriv, devicePub, LINKED_CERT_LABEL, Date.now() + CERT_TTL_MS),
        chain: null,
      }),
    };
  }
  const st = await getRecoveryState();
  if (!st?.seedEnc || !st?.cert?.sig || !st?.pub) return null;
  const certOk = await verifyRaw(p.masterPub, st.cert.sig, deviceCertText(st.pub, st.cert.label, st.cert.exp));
  if (!certOk || st.cert.label !== 'recovery') return null;
  let pair;
  try {
    pair = await deriveRecoveryPair(b64u.dec(await decryptWithVault(st.seedEnc)));
  } catch {
    return null;
  }
  if (pair.pubB64 !== st.pub) return null;
  const chain = { recoveryPub: pair.pubB64, recoveryCert: st.cert };
  return {
    kind: 'recovery',
    sign: (text) => signWithKey(pair.privateKey, text),
    extra: { masterPub: p.masterPub, recoveryPub: pair.pubB64, recoveryCert: st.cert },
    issue: async (devicePub) => ({
      cert: await signDeviceCert(pair.privateKey, devicePub, LINKED_CERT_LABEL, Date.now() + CERT_TTL_MS),
      chain,
    }),
  };
}

// Новое подключаемое устройство: пары создаются ДО запроса привязки и
// хранятся отдельно (devices/link-pending), пока основное не ответит.
export async function newLinkKeys() {
  const dev = await genP256KeyPair();
  const ecdh = await genP256KeyPair(['deriveBits'], 'ECDH');
  const eph = await genP256KeyPair(['deriveBits'], 'ECDH');
  return {
    devicePub: b64u.enc(await crypto.subtle.exportKey('raw', dev.publicKey)),
    devicePriv: dev.privateKey,
    ecdhPub: b64u.enc(await crypto.subtle.exportKey('raw', ecdh.publicKey)),
    ecdhPriv: ecdh.privateKey,
    eB: b64u.enc(await crypto.subtle.exportKey('raw', eph.publicKey)),
    eBPriv: eph.privateKey,
  };
}

// Установка личности, полученной от основного устройства (без masterPriv).
export async function installLinkedIdentity({ masterPub, secret, devicePub, devicePriv, ecdhPub, ecdhPriv, cert, chain, label }) {
  await kvPut('devices', 'self', {
    devicePub,
    devicePriv,
    cert,
    label: label || LINKED_CERT_LABEL,
    ...(chain ? { chain } : {}),
    linkedAt: Date.now(),
  });
  await kvPut('devices', 'self-ecdh', { ecdhPub, ecdhPriv });
  await kvPut('identity', 'personal', {
    masterPub,
    masterPriv: null,
    secretEnc: await encryptWithVault(secret),
    linked: true,
    createdAt: Date.now(),
  });
  cached = null;
  return ensurePersonal();
}

// Номер сменён на другом устройстве профиля: новый master (его приватник —
// там), новый секрет, новый сертификат этого устройства. Recovery-состояние
// относилось к старому master — сбрасывается (как в rotatePersonal).
export async function applyRotatedIdentity({ masterPub, secret, cert, chain }) {
  const dev = await kvGet('devices', 'self');
  if (!dev?.devicePriv) throw new Error('нет ключа устройства');
  const next = { ...dev, cert };
  if (chain) next.chain = chain;
  else delete next.chain;
  await kvPut('devices', 'self', next);
  await kvPut('identity', 'personal', {
    masterPub,
    masterPriv: null,
    secretEnc: await encryptWithVault(secret),
    linked: true,
    createdAt: Date.now(),
    rotatedAt: Date.now(),
  });
  try {
    await kvDel('identity', 'recovery');
  } catch {}
  cached = null;
  return ensurePersonal();
}

// Перевыпуск сертификата ЭТОГО устройства (основным/recovery) — при смене
// номера на основном и при восстановлении.
export async function setOwnCert(cert, chain = null) {
  const dev = await kvGet('devices', 'self');
  if (!dev) return;
  const next = { ...dev, cert };
  if (chain) next.chain = chain;
  else delete next.chain;
  await kvPut('devices', 'self', next);
  cached = null;
}
