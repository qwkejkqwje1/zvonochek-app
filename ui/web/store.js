// ZVONochek — тонкая обёртка над IndexedDB для коммуникатора:
// vault-ключ, идентичность, устройства, журнал звонков.
// Все хранилища — с внешними ключами (put(value, key)).
const DB_NAME = 'zvonochek';
const DB_VERSION = 2; // v21: добавлены сторы чата (rooms, messages); существующие данные не трогаются
const STORES = ['vault', 'identity', 'devices', 'calls', 'missed', 'rooms', 'messages'];

let dbPromise = null;
let wiping = false; // v38: «Стереть всё» — новых соединений больше не открываем
export function idb() {
  if (wiping) return Promise.reject(new Error('Данные стираются'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dbPromise = null; // позволяем повторную попытку после закрытия чужих вкладок
      reject(e);
    };
    // v22: апгрейд базы может молча висеть, если старая версия открыта в другой
    // вкладке или в установленном PWA, — не висим молча дольше 10 секунд.
    const timer = setTimeout(() => fail(new Error('База данных не отвечает (10 с)')), 10000);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onblocked = () =>
      fail(
        new Error(
          'База данных заблокирована: закройте другие вкладки и установленное приложение ZVONochek, затем обновите страницу'
        )
      );
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const db = req.result;
      // Если другая вкладка захочет поднять версию — отпускаем соединение,
      // чтобы не блокировать её апгрейд (и не висеть самим в onblocked у неё).
      db.onversionchange = () => {
        try {
          db.close();
        } catch {}
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => fail(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return idb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        if (req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          t.oncomplete = () => resolve(undefined);
          t.onerror = () => reject(t.error);
        }
      })
  );
}

// v26: аддитивная нормализация записи комнаты. Записи v21–v25 не имеют полей
// epochs/alias/pinProtected/ecdhSent — подставляем дефолты на месте, без бампа
// DB_VERSION и без миграции данных (сторы не меняются, меняется только форма
// объекта внутри стора rooms). Чистая функция — покрыта тестом test-v26.
export function normalizeRoomRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  if (!Number.isInteger(rec.epoch) || rec.epoch < 0) rec.epoch = 0;
  if (!Array.isArray(rec.epochs) || !rec.epochs.length) {
    // Секрет эпохи 0 не нужен: её ключ выводится из seed напрямую.
    rec.epochs = [{ n: 0, secret: null, ts: rec.createdAt || 0 }];
  }
  if (typeof rec.lastReadSeq !== 'number') rec.lastReadSeq = rec.lastSeq || 0;
  if (typeof rec.pinProtected !== 'boolean') rec.pinProtected = false;
  if (!('pinEnc' in rec)) rec.pinEnc = null;
  if (!('alias' in rec)) rec.alias = null; // {code, adminEnc} | null
  if (typeof rec.ecdhSent !== 'boolean') rec.ecdhSent = false;
  if (!rec.members || typeof rec.members !== 'object') rec.members = {};
  // v27: исчезающие сообщения (ttlSec, 0 = выключено), закреп ({hash,by,ts}|null),
  // локальный черновик поля ввода. Тоже аддитивно, без бампа DB_VERSION.
  if (typeof rec.ttlSec !== 'number' || rec.ttlSec < 0) rec.ttlSec = 0;
  if (!('pinned' in rec)) rec.pinned = null;
  if (typeof rec.draft !== 'string') rec.draft = '';
  // v28: реестр увиденных устройств (видимость подключений без ника) и
  // очередь сообщений, отправленных резервным каналом до ресинка в Worker.
  if (!rec.seenDevices || typeof rec.seenDevices !== 'object') rec.seenDevices = {};
  if (typeof rec.fallbackSince !== 'number' || rec.fallbackSince < 0) rec.fallbackSince = 0;
  if (typeof rec.dialInfoSent !== 'boolean') rec.dialInfoSent = false;
  // v29: удаление чатов. creatorPub — создатель из подписанного room-meta
  // (null, пока не известен: комнаты до v29 и чужие комнаты до первого
  // room-meta); createdByMe — эта запись создана локальным «Создать чат»;
  // metaSent — room-meta уже опубликован этим устройством; keepForever —
  // «сохранить от автоудаления» (флаг списка комнат, не сообщение-закреп).
  if (!('creatorPub' in rec)) rec.creatorPub = null;
  if (typeof rec.createdByMe !== 'boolean') rec.createdByMe = false;
  if (typeof rec.metaSent !== 'boolean') rec.metaSent = false;
  if (typeof rec.keepForever !== 'boolean') rec.keepForever = false;
  // v30: доступ по кодовому слову (rendezvous). word = {phraseEnc, adminEnc,
  // exp} | null — фраза и admin встречи хранятся только vault-зашифрованными
  // в записи комнаты создателя; на сервере — хэш адреса и шифротекст blob.
  if (!('word' in rec)) rec.word = null;
  // v31: состояние храповика (forward secrecy). ratchet = {send: {epoch:
  // {ck, n}}, recv: {epoch: {dev: {ck, nextN, skipped, pruned?}}},
  // dr: <состояние Double Ratchet | null>} — всё JSON-безопасное (ключи —
  // base64-строки; приватный скаляр текущей отправляющей ratchet-пары DR —
  // vault-зашифрован в dr.send.privEnc). null — храповик не инициализирован.
  if (!('ratchet' in rec)) rec.ratchet = null;
  return rec;
}

export const kvGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const kvPut = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
export const kvDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const kvAll = (store) =>
  idb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const out = [];
        const t = db.transaction(store, 'readonly');
        const req = t.objectStore(store).openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            out.push({ key: cur.key, value: cur.value });
            cur.continue();
          } else resolve(out);
        };
        req.onerror = () => reject(req.error);
      })
  );

// v38: выборка по префиксу ключа (сообщения одной комнаты — ключи
// `${roomId}:${hash}`) без полного прохода по всем комнатам: раньше каждое
// открытие/рендер/дедуп читал ВСЕ сообщения ВСЕХ чатов.
const prefixRange = (prefix) => IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
export const kvPrefix = (store, prefix) =>
  idb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const out = [];
        const t = db.transaction(store, 'readonly');
        const req = t.objectStore(store).openCursor(prefixRange(prefix));
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            out.push({ key: cur.key, value: cur.value });
            cur.continue();
          } else resolve(out);
        };
        req.onerror = () => reject(req.error);
      })
  );
export const kvDelPrefix = (store, prefix) => tx(store, 'readwrite', (s) => s.delete(prefixRange(prefix)));
// v38: пакетное удаление по списку ключей одной транзакцией.
export const kvDelMany = (store, keys) =>
  tx(store, 'readwrite', (s) => {
    for (const k of keys) s.delete(k);
    return null;
  });

// v38: «Стереть всё с устройства»: закрыть своё соединение и удалить базу
// целиком (ключи, личность, чаты, журнал). Другие вкладки получают
// versionchange и отпускают базу сами (onversionchange выше); если какая-то
// держит её — удаление завершится, как только она закроется.
export async function wipeDatabase() {
  try {
    const db = await Promise.race([dbPromise || Promise.resolve(null), new Promise((r) => setTimeout(() => r(null), 3000))]);
    db?.close?.();
  } catch {}
  wiping = true;
  dbPromise = null;
  return new Promise((resolve) => {
    let done = false;
    const fin = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => fin(true);
      req.onerror = () => fin(false);
      req.onblocked = () => setTimeout(() => fin(false), 1500);
    } catch {
      fin(false);
    }
    setTimeout(() => fin(false), 6000);
  });
}
