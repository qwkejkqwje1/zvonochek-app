// ZVONochek — синхронизация профиля между устройствами (v39), ЧИСТАЯ логика.
// Без DOM и сети: покрыта тестами tests/sync-core.test.mjs; ввод-вывод и
// шифрование — в devices.js.
//
// Модель — состояние-CRDT «последняя запись побеждает» (LWW-map), как
// синхронизация настроек/контактов у Signal и account data у Matrix:
//   items: { [key]: {u, d, v} | {u, d, del: 1} }
//     u — метка времени изменения (мс, монотонна по ключу: не меньше
//         прошлой метки + 1, поэтому сбитые часы одного устройства не
//         «замораживают» ключ навсегда);
//     d — короткий id устройства-автора (разрешение ничьих детерминировано:
//         все устройства выбирают одного победителя);
//     v — значение (JSON), del — надгробие удалённого ключа.
// Особые ключи сливаются не по LWW:
//   read:<roomId> — номер последнего прочитанного сообщения: максимум;
//   ep:<roomId>   — секреты эпох комнаты: объединение по номеру эпохи.
// Надгробия хранятся 90 дней, затем забываются (устройство, не выходившее
// на связь 90 дней, может «воскресить» удалённое — честное ограничение).
export const TOMB_KEEP_MS = 90 * 24 * 3600000;
//   rev:<devicePub> — отзыв устройства: «липкий», однажды появившись, не
//                   отменяется (надгробие его не стирает).
// Реестр устройств — тоже ключи: dev:<devicePub> → {label, ecdhPub, cert,
// chain, main, addedAt, addedBy}; доверие к ним проверяет devices.js
// (сертификат под текущим master, подпись отзыва).
export const SYNC_PREFIXES = ['room:', 'contact:', 'set:', 'call:', 'read:', 'ep:', 'dev:', 'rev:'];

// Стабильная сериализация (ключи объектов по алфавиту) — для сравнения.
export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export const sameValue = (a, b) => stableStringify(a) === stableStringify(b);

// Победитель LWW между двумя версиями одного ключа (a, b — items | undefined).
export function lwwWinner(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a.u !== b.u) return a.u > b.u ? a : b;
  const da = String(a.d || '');
  const db = String(b.d || '');
  if (da !== db) return da > db ? a : b;
  // Тот же автор и время — сравнение по содержимому (детерминированно).
  const sa = stableStringify(a.del ? { del: 1 } : a.v);
  const sb = stableStringify(b.del ? { del: 1 } : b.v);
  return sa >= sb ? a : b;
}

function mergeEpochLists(a, b) {
  const byN = new Map();
  for (const e of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!e || !Number.isInteger(e.n) || e.n < 0) continue;
    const prev = byN.get(e.n);
    if (!prev || (!prev.secret && e.secret)) byN.set(e.n, { n: e.n, secret: e.secret || null, ts: e.ts || 0 });
  }
  return [...byN.values()].sort((x, y) => x.n - y.n);
}

// Слияние двух версий ключа с учётом особых правил.
export function mergeItem(key, local, remote) {
  if (!remote) return local || null;
  if (!local) return remote;
  if (key.startsWith('rev:')) {
    if (!local.del) return local; // отзыв окончательный
    return remote.del ? lwwWinner(local, remote) : remote;
  }
  if (key.startsWith('read:')) {
    if (local.del || remote.del) return lwwWinner(local, remote);
    const v = Math.max(Number(local.v) || 0, Number(remote.v) || 0);
    const u = Math.max(local.u || 0, remote.u || 0);
    const d = (Number(remote.v) || 0) > (Number(local.v) || 0) ? remote.d : local.d;
    return { u, d, v };
  }
  if (key.startsWith('ep:')) {
    if (local.del || remote.del) return lwwWinner(local, remote);
    const v = mergeEpochLists(local.v, remote.v);
    const u = Math.max(local.u || 0, remote.u || 0);
    return { u, d: lwwWinner(local, remote).d, v };
  }
  return lwwWinner(local, remote);
}

/**
 * Слить удалённое состояние в локальное. Не мутирует входы.
 * @returns {{items: object, applied: string[]}} applied — ключи, у которых
 *   ИТОГОВОЕ значение отличается от локального (их надо применить к данным).
 */
export function mergeItems(localItems, remoteItems, now = Date.now()) {
  const items = { ...(localItems || {}) };
  const applied = [];
  for (const [key, rem] of Object.entries(remoteItems || {})) {
    if (!rem || typeof rem !== 'object' || !Number.isFinite(rem.u)) continue;
    if (!SYNC_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (rem.del && now - rem.u > TOMB_KEEP_MS) continue; // протухшее надгробие
    const loc = items[key];
    const res = mergeItem(key, loc, rem);
    if (!res || res === loc) continue;
    const before = loc ? (loc.del ? { del: 1 } : loc.v) : undefined;
    const after = res.del ? { del: 1 } : res.v;
    items[key] = res;
    if (!loc || !!loc.del !== !!res.del || !sameValue(before, after)) applied.push(key);
  }
  return { items, applied };
}

/**
 * Зафиксировать локальные изменения: current — {key: value} текущего вида
 * синхронизируемых данных (без надгробий). Изменившиеся/новые ключи получают
 * новую метку от dev, исчезнувшие — надгробие. Не мутирует входы.
 * opts.dropKey(key, oldItem) → true: ключ исчез «естественно» (срок жизни
 * журнала) — удалить без надгробия. opts.scope(key) → false: ключ ведётся
 * не сканом данных (реестр устройств), commitLocal его не трогает.
 * @returns {{items: object, changed: string[]}}
 */
export function commitLocal(items, current, dev, now = Date.now(), opts = {}) {
  const out = { ...(items || {}) };
  const changed = [];
  const inScope = opts.scope || (() => true);
  for (const [key, v] of Object.entries(current || {})) {
    if (!inScope(key)) continue;
    const prev = out[key];
    if (prev && !prev.del && sameValue(prev.v, v)) continue;
    if (key.startsWith('read:') && prev && !prev.del && (Number(prev.v) || 0) >= (Number(v) || 0)) continue;
    if (key.startsWith('ep:') && prev && !prev.del) {
      const merged = mergeEpochLists(prev.v, v);
      if (sameValue(merged, prev.v)) continue;
      out[key] = { u: Math.max(now, (prev.u || 0) + 1), d: dev, v: merged };
      changed.push(key);
      continue;
    }
    out[key] = { u: Math.max(now, (prev?.u || 0) + 1), d: dev, v };
    changed.push(key);
  }
  for (const [key, prev] of Object.entries(out)) {
    if (!prev || prev.del || key in (current || {})) continue;
    if (!inScope(key) || key.startsWith('rev:')) continue; // отзыв не «исчезает»
    if (opts.dropKey && opts.dropKey(key, prev)) {
      delete out[key];
      continue;
    }
    out[key] = { u: Math.max(now, (prev.u || 0) + 1), d: dev, del: 1 };
    changed.push(key);
  }
  // Протухшие надгробия забываем.
  for (const [key, it] of Object.entries(out)) {
    if (it?.del && now - it.u > TOMB_KEEP_MS) delete out[key];
  }
  return { items: out, changed };
}

// Подмножество items по списку ключей (для дельты).
export function pickItems(items, keys) {
  const out = {};
  for (const k of keys) if (items[k]) out[k] = items[k];
  return out;
}

// Длина строки в байтах UTF-8 (блок сообщения чата меряется байтами).
const te = new TextEncoder();
export const utf8Len = (s) => te.encode(s).length;

// Разбить дельту на куски, каждый из которых в JSON не длиннее maxBytes.
export function chunkDelta(items, maxBytes) {
  const chunks = [];
  let cur = {};
  let size = 2;
  for (const [k, v] of Object.entries(items || {})) {
    const part = utf8Len(JSON.stringify(k)) + 1 + utf8Len(JSON.stringify(v)) + 1;
    if (part + 2 > maxBytes) return null; // ключ не влезает — нужен полный снимок
    if (size + part > maxBytes && Object.keys(cur).length) {
      chunks.push(cur);
      cur = {};
      size = 2;
    }
    cur[k] = v;
    size += part;
  }
  if (Object.keys(cur).length) chunks.push(cur);
  return chunks;
}

// Короткий id устройства для поля d (детерминированный tie-break).
export const shortDev = (devicePub) => String(devicePub || '').slice(0, 16);

// Метка устройства из User-Agent (только для реестра профиля: на сервер не
// уходит — сертификат несёт обезличенную метку).
export function deviceLabelFromUA(ua = '') {
  const s = String(ua);
  const os = /iPhone/.test(s)
    ? 'iPhone'
    : /iPad/.test(s)
      ? 'iPad'
      : /Android/.test(s)
        ? 'Android'
        : /Windows/.test(s)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(s)
            ? 'Mac'
            : /CrOS/.test(s)
              ? 'Chromebook'
              : /Linux/.test(s)
                ? 'Linux'
                : 'Устройство';
  const br = /YaBrowser/.test(s)
    ? 'Яндекс Браузер'
    : /Edg\//.test(s)
      ? 'Edge'
      : /OPR\/|Opera/.test(s)
        ? 'Opera'
        : /Firefox\//.test(s)
          ? 'Firefox'
          : /SamsungBrowser/.test(s)
            ? 'Samsung Internet'
            : /Chrome\//.test(s)
              ? 'Chrome'
              : /Safari\//.test(s)
                ? 'Safari'
                : '';
  return br ? `${os} · ${br}` : os;
}

// ---------- Группировка участников чата по людям ----------
// Устройство с подтверждённым (certOk) master — «человек» p:<masterPub>;
// без подтверждения — само по себе d:<devPub>. Свои устройства профиля —
// всегда «я» (self), даже если dial ещё не пришёл.
export function personKeyOf(devPub, member, ownSet, myMasterPub) {
  if (ownSet && ownSet.has(devPub)) return 'self';
  if (member?.masterPub && member.certOk === true) {
    if (myMasterPub && member.masterPub === myMasterPub) return 'self';
    return 'p:' + member.masterPub;
  }
  return 'd:' + devPub;
}

// Сгруппировать устройства: → Map(personKey → {devs:[], nick, lastSeen}).
export function groupPersons(members, ownSet, myMasterPub) {
  const out = new Map();
  for (const [dev, m] of Object.entries(members || {})) {
    if (!m || m.left) continue;
    const k = personKeyOf(dev, m, ownSet, myMasterPub);
    const g = out.get(k) || { key: k, devs: [], nick: '', firstSeen: Infinity };
    g.devs.push(dev);
    if (m.nick && (!g.nick || (m.firstSeen || 0) < g.firstSeen)) {
      g.nick = m.nick;
      g.firstSeen = m.firstSeen || 0;
    }
    out.set(k, g);
  }
  return out;
}
