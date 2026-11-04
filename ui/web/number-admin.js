// number-admin.js — «Сменить номер» и «Стереть всё»
// v44: вынесено из app.js без изменения логики (строки 4768–5349 v43).
import { InboxListener, inboxAck, inboxAnswer, inboxRegister, inboxRetire } from './inbox.js?v=44';
import { adminSigner, ensurePersonal, getChatDeviceEcdh, getPersonal, hasPersonal, personalLinkOf, resetIdentityCache, rotatePersonal, signWithDevice } from './identity.js?v=44';
import { anonName } from './anon-names.js?v=44';
import { b64u, deriveRoom, open as openSealed } from './crypto.js?v=44';
import { ensurePushSub, loadMissed, updatePushUI } from './push-ui.js?v=44';
import { getWorkerBase } from './config.js?v=44';
import { hasOtherDevices, isLinkedDevice, rotateWithDevices, rotationCandidates, startDevices, unlinkSelf } from './devices.js?v=44';
import { wipeDatabase } from './store.js?v=44';
import { $, S, chatDialKey, chatDialTopic, copy, hangup, journalAdd, preJoin, renderCalls, renderQr, show, startRingtone, stopRingtone, toast } from './app.js?v=44';
import { backOf, rememberPeer, shareBackOn, syncLocal } from './contacts.js?v=44';

// ---------- v38: «Сменить номер» и «Стереть всё» ----------
// Отзыв Inbox, который не удалось выполнить сразу (нет сети), повторяется
// при следующих запусках: иначе по старой ссылке ещё приходили бы пуши.
export const RETIRE_KEY = 'zvRetirePending';
export function pendingRetire() {
  try {
    const v = JSON.parse(localStorage.getItem(RETIRE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && /^[a-z0-9-]{16,80}$/.test(t)) : [];
  } catch {
    return [];
  }
}
export function setPendingRetire(list) {
  try {
    if (list.length) localStorage.setItem(RETIRE_KEY, JSON.stringify([...new Set(list)].slice(0, 8)));
    else localStorage.removeItem(RETIRE_KEY);
  } catch {}
}
// v41: admin — подпись владельца номера (adminSigner(), снятый ДО смены
// master-ключа). Если её не приняли (у старого topic другой владелец, или
// сервер ещё v40), повторяем подписью устройства.
export async function retireTopics(topics, bundle, admin = null) {
  const left = [];
  for (const t of topics) {
    let r = admin ? await inboxRetire(getWorkerBase(), t, bundle, admin).catch(() => null) : null;
    if (!r || r.status !== 200) r = await inboxRetire(getWorkerBase(), t, bundle).catch(() => null);
    // 403: устройства там уже нет (стёрт ранее / не регистрировался) — готово.
    if (!r || (r.status !== 200 && r.status !== 403)) left.push(t);
  }
  return left;
}
export let retryingRetire = false;
export async function retryPendingRetire() {
  const list = pendingRetire();
  if (!list.length || retryingRetire || !S.personal || !getWorkerBase()) return;
  retryingRetire = true;
  try {
    setPendingRetire(await retireTopics(list, S.personal));
  } finally {
    retryingRetire = false;
  }
}
export function stopInboxListeners() {
  try {
    S.inboxListener?.close?.();
  } catch {}
  try {
    S.inboxDialListener?.close?.();
  } catch {}
  S.inboxListener = null;
  S.inboxDialListener = null;
  S.chatDialTopic = null;
}

export async function changeNumber(say, keep = []) {
  const prev = S.personal || (await getPersonal());
  if (!prev) throw new Error('номера ещё нет');
  // v39: на подключённом устройстве master-ключа нет — номер меняет основное.
  if (!(await adminSigner().catch(() => null))) {
    throw new Error('сменить номер можно только на основном устройстве профиля (или после восстановления по фразе)');
  }
  if (hasOtherDevices()) {
    return rotateWithDevices(() => changeNumberCore(prev, say), keep);
  }
  return changeNumberCore(prev, say);
}
export async function changeNumberCore(prev, say) {
  const oldTopics = [];
  try {
    oldTopics.push((await deriveRoom(prev.secret)).topic);
  } catch {}
  if (prev.masterPub) oldTopics.push(await chatDialTopic(prev.masterPub));
  say('Удаляем старую резервную копию…');
  let bk = null;
  try {
    bk = await window.__zvBackup?.deleteServer?.();
  } catch {}
  say('Создаём новый номер…');
  stopInboxListeners();
  // v41: подпись старого владельца — до смены master-ключа (после rotatePersonal
  // его приватной части в хранилище уже нет, а сервер гасит номер только по ней
  // или по подписи основного устройства).
  const oldAdmin = await adminSigner().catch(() => null);
  const { next } = await rotatePersonal();
  S.personal = next;
  S.personalRoom = await deriveRoom(next.secret);
  S.inboxNotOwner = false;
  say('Отключаем старую ссылку на сервере…');
  const left = await retireTopics(oldTopics, next, oldAdmin);
  setPendingRetire([...pendingRetire(), ...left]);
  await refreshPersonalUI();
  window.ZVChat?.identityChanged?.();
  window.__zvBackup?.render?.()?.catch?.(() => {});
  let msg = 'Готово: новый номер создан. Отправьте новую ссылку тем, кому доверяете.';
  if (left.length) msg += ' Старая ссылка будет отключена на сервере, как только появится связь.';
  if (bk?.had) msg += ' Резервную копию создайте заново — старая фраза больше не подходит.';
  return msg;
}

export async function wipeEverything(say, { backupToo = false, revoked = false, query = 'wiped=1' } = {}) {
  say('Стираем…');
  if (S.joined) await Promise.resolve(hangup()).catch(() => {});
  const tasks = [];
  const p = S.personal || (await getPersonal().catch(() => null));
  // v39: у профиля есть другие устройства — номер живёт на них: этот
  // аппарат только отвязывается (сервер входящих забывает его одного),
  // а не гасит номер целиком. Отвязанное (revoked) — уже отвязано.
  // v41: подключённое устройство номер не гасит (сервер это и не примет) —
  // всегда только отвязывается, даже если список устройств ещё не пришёл.
  const multi = !revoked && (hasOtherDevices() || !!p?.linked);
  if (multi) {
    tasks.push(unlinkSelf().catch(() => {}));
  } else if (p && getWorkerBase() && !revoked) {
    tasks.push(
      (async () => {
        const topics = [];
        try {
          topics.push((await deriveRoom(p.secret)).topic);
        } catch {}
        if (p.masterPub) topics.push(await chatDialTopic(p.masterPub));
        const admin = await adminSigner().catch(() => null);
        await retireTopics([...topics, ...pendingRetire()], p, admin);
      })().catch(() => {})
    );
  }
  if (backupToo) tasks.push(Promise.resolve(window.__zvBackup?.deleteServer?.()).catch(() => {}));
  await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 6000))]);
  stopInboxListeners();
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const sub = await reg?.pushManager?.getSubscription?.();
    await sub?.unsubscribe?.();
  } catch {}
  await wipeDatabase();
  await wipeOwnSiteData();
  location.replace(location.pathname + '?' + query);
}
// v41: стираем только своё. Сайт на github.io делит origin с другими
// проектами аккаунта (например, /TorrClient/): у них общие localStorage,
// кэши и список service worker. Раньше «Стереть всё» делало
// localStorage.clear(), удаляло все кэши и все регистрации SW origin —
// и заодно чужие настройки (в т.ч. сохранённые логины TURN).
// Ключи Звоночка начинаются с 'zv' (tests/static.test.mjs), кэши — с
// 'zvonochek-', регистрации — со scope этой папки.
export async function wipeOwnSiteData() {
  for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      const own = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith('zv')) own.push(k);
      }
      for (const k of own) store.removeItem(k);
    } catch {}
  }
  try {
    for (const k of await caches.keys()) if (k.startsWith('zvonochek-')) await caches.delete(k);
  } catch {}
  try {
    const scope = new URL('./', location.href).href;
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) {
      if (r.scope.startsWith(scope)) await r.unregister();
    }
  } catch {}
}

export let dangerKind = null;
export function openDanger(kind) {
  const box = $('#dangerBox');
  if (!box) return;
  dangerKind = kind;
  const title = $('#dangerTitle');
  const text = $('#dangerText');
  const go = $('#dangerGo');
  const note = $('#dangerNote');
  if (note) note.textContent = '';
  $('#wipeBackupOpt')?.classList.toggle('hidden', kind !== 'wipe');
  const wbt = $('#wipeBackupToo');
  if (wbt) wbt.checked = false;
  const keepBox = $('#dangerKeepBox');
  if (keepBox) {
    keepBox.replaceChildren();
    keepBox.classList.add('hidden');
  }
  if (kind === 'number') {
    title.textContent = 'Сменить номер?';
    text.textContent =
      'Будет создана новая личная ссылка — новый крипто-номер. По старой ссылке до вас больше не дозвониться: сервер удалит её вместе с push-подписками и пропущенными. Новую ссылку отправьте заново тем, кому доверяете. Чаты, контакты и журнал останутся. Резервную копию (17 слов) нужно будет создать заново.';
    (go.querySelector('span') || go).textContent = 'Сменить номер';
    // v39: другие устройства профиля — выбрать, какие получат новый номер
    // (остальные отвязываются: как смена номера с потерянным телефоном).
    const cands = hasOtherDevices() ? rotationCandidates() : [];
    if (keepBox && cands.length) {
      const head = document.createElement('p');
      head.className = 'hint';
      head.textContent = 'Новый номер получат отмеченные устройства. Снимите галочку с потерянного или чужого — оно будет отвязано.';
      keepBox.append(head);
      for (const c of cands) {
        const lab = document.createElement('label');
        lab.className = 'check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.keepDev = c.dev;
        lab.append(cb, ` ${c.label} · ключ …${c.dev.slice(-6)}`);
        keepBox.append(lab);
      }
      keepBox.classList.remove('hidden');
    }
    if (isLinkedDevice() || dangerKind === 'number') {
      adminSigner()
        .then((a) => {
          if (a || dangerKind !== 'number') return;
          text.textContent =
            'Номер профиля меняет основное устройство (на нём хранится master-ключ) или устройство, где введена фраза восстановления. Откройте «Мой номер» на основном устройстве.';
          go.disabled = true;
        })
        .catch(() => {});
    }
  } else {
    title.textContent = 'Стереть всё с этого устройства?';
    text.textContent = hasOtherDevices()
      ? 'С этого устройства будут удалены личность, чаты и их ключи, контакты, журнал, настройки и кэш; устройство отвяжется от профиля. Номер продолжит работать на других ваших устройствах.' +
        (isLinkedDevice() ? '' : ' Это основное устройство: после стирания подключать новые устройства и менять номер можно будет только с фразой восстановления.')
      : 'Будут удалены личность и номер, все чаты и их ключи, контакты, журнал звонков, настройки, кэш приложения и push-подписка; сервер забудет ваш номер. Отменить нельзя. Если резервная копия включена и вы оставите её на сервере, личность и список чатов можно вернуть фразой из 17 слов.';
    (go.querySelector('span') || go).textContent = 'Стереть всё';
  }
  delete go.dataset.armed;
  go.disabled = false;
  box.classList.remove('hidden');
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export async function refreshPersonalUI() {
  if (!$('#personalBox')) return;
  let has;
  try {
    has = await hasPersonal();
  } catch (e) {
    // v22: не молчим — владелец должен видеть, что хранилище недоступно.
    const hm = $('#homeMsg');
    if (hm) hm.textContent = 'Не удалось открыть локальное хранилище: ' + (e?.message || e);
    return;
  }
  $('#personalNone')?.classList.toggle('hidden', has);
  $('#personalMain')?.classList.toggle('hidden', !has);
  if (!has) return;
  const p = await getPersonal();
  S.personal = p;
  if (!S.personalRoom) S.personalRoom = await deriveRoom(p.secret);
  const linkEl = $('#personalLink');
  if (linkEl) linkEl.value = personalLinkOf(p);
  // v43: после «Сменить номер» открытый QR показывает уже новую ссылку.
  if ($('#personalQr') && !$('#personalQr').classList.contains('hidden')) renderQr($('#personalQr'), personalLinkOf(p));
  startInboxListener();
  loadMissed().catch(() => {});
  updatePushUI();
  ensurePushSub().catch(() => {});
  const sb = $('#shareBack');
  if (sb) sb.checked = shareBackOn();
  retryPendingRetire().catch(() => {});
  // v39: синхронизация с другими устройствами профиля (если они есть).
  startDevices().catch((e) => console.warn('devices', e));
}
export let knownDevs = null;
export async function devicesSeenCheck() {
  const st = window.ZVDevices?.state?.();
  if (!st?.items) {
    if (knownDevs === null) knownDevs = new Set();
    return;
  }
  const now = Object.keys(st.items).filter((k) => k.startsWith('dev:') && st.items[k] && !st.items[k].del);
  if (knownDevs === null) {
    knownDevs = new Set(now);
    return;
  }
  const me = S.personal?.devicePub || (await getPersonal().catch(() => null))?.devicePub || '';
  for (const k of now) {
    if (knownDevs.has(k)) continue;
    knownDevs.add(k);
    if (k === 'dev:' + me || st.items[k]?.v?.addedBy === me) continue;
    const label = st.items[k]?.v?.label || 'Устройство';
    toast(`К вашему профилю подключено устройство: ${label}. Если это не вы — «Мой номер» → «Мои устройства» → «Отвязать».`, 8000);
  }
}

export function inboxStateHandler(m) {
  if (S.incoming && m.ringId === S.incoming.ringId && m.state !== 'ringing') {
    closeIncoming();
    toast(
      m.state === 'accepted'
        ? 'Звонок принят на другом устройстве'
        : m.state === 'declined'
          ? 'Звонок отклонён на другом устройстве'
          : 'Входящий звонок завершён'
    );
  }
}

export function startInboxListener() {
  if (S.inboxListener || !getWorkerBase() || !S.personal || !S.personalRoom) return;
  const p = S.personal;
  const topic = S.personalRoom.topic;
  S.inboxRegP = inboxRegister(getWorkerBase(), topic, p, S.pushSub).catch(() => {});
  S.inboxListener = new InboxListener(getWorkerBase(), topic, p, {
    onRing: (m) => handleIncomingRing(m).catch(() => {}),
    onState: inboxStateHandler,
    onStatus: (st) => {
      const el = $('#personalStatus');
      if (el) {
        el.textContent =
          st === 'online'
            ? 'Вы доступны для входящих звонков по личной ссылке'
            : 'Нет связи с сервером входящих — дозвон временно недоступен';
      }
    },
  });
  // v38: слушатель — после регистрации устройства (auth до /register сервер
  // отклоняет; раньше такой сокет молча оставался глухим до перезагрузки).
  const listener = S.inboxListener;
  Promise.resolve(S.inboxRegP).then((r) => {
    if (S.inboxListener !== listener) return;
    // v41: сервер закрепил этот номер за другим master-ключом (тот, кто первым
    // зарегистрировался по ссылке). Слушать бесполезно — звонки по этой ссылке
    // сюда не придут; выход — сменить номер.
    if (r?.status === 403 && r.data?.error === 'not owner') {
      S.inboxNotOwner = true;
      listener.close();
      const el = $('#personalStatus');
      if (el) {
        el.textContent =
          'Эта личная ссылка на сервере закреплена за другим ключом — ' +
          (p.linked ? 'смените номер на основном устройстве профиля' : 'нажмите «Сменить номер (новая ссылка)» ниже');
      }
      return;
    }
    listener.connect();
  });
  // v28: второй, аддитивный слушатель дозвонa ИЗ ЧАТА. Его topic выводится
  // из публичного masterPub владельца (chatDialTopic ниже), поэтому личная
  // ссылка в чат не публикуется; payload запечатан ECDH-ключом пары
  // «эфемерный ключ звонящего ↔ ECDH-ключ устройства из чата».
  if (!S.inboxDialListener && p.masterPub) {
    chatDialTopic(p.masterPub)
      .then((dialTopic) => {
        if (S.inboxDialListener) return;
        S.chatDialTopic = dialTopic;
        // v38: с push-подпиской (раньше null — дозвон из чата в закрытую
        // вкладку не доходил никогда).
        const regP = inboxRegister(getWorkerBase(), dialTopic, p, S.pushSub).catch(() => {});
        const dl = new InboxListener(getWorkerBase(), dialTopic, p, {
          onRing: (m) => handleChatDialRing(m).catch(() => {}),
          onState: inboxStateHandler,
        });
        S.inboxDialListener = dl;
        regP.then(() => {
          if (S.inboxDialListener === dl) dl.connect();
        });
      })
      .catch(() => {});
  }
}

export async function handleIncomingRing({ ringId, blob, fromFp }) {
  if (S.incoming || S.joined || !S.personalRoom) return;
  let payload = null;
  try {
    payload = await openSealed(S.personalRoom.key, blob, S.personalRoom.topic);
  } catch {}
  presentIncomingRing({ ringId, payload, fromFp, topic: S.personalRoom.topic, viaChat: false });
}

// v28: входящий дозвон из чата. blob — конверт 'ecd1.' + JSON {eph, blob}:
// внутренний blob запечатан ECDH-ключом на ECDH-публичный ключ нашего
// устройства из чата; вне чата такой ring не создать и не прочитать.
export async function handleChatDialRing({ ringId, blob, fromFp }) {
  if (S.incoming || S.joined || !S.personal || !S.chatDialTopic) return;
  try {
    if (typeof blob !== 'string' || !(blob.startsWith('ecd1.') || blob.startsWith('ecd2.'))) return;
    const env = JSON.parse(new TextDecoder().decode(b64u.dec(blob.slice(5))));
    const mine = await getChatDeviceEcdh();
    if (!mine?.ecdhPriv) return;
    const key = await chatDialKey(mine.ecdhPriv, b64u.dec(env.eph), S.chatDialTopic);
    let payload = null;
    // v39: 'ecd2.' — завёртки на все устройства человека; наша — одна из них.
    for (const w of blob.startsWith('ecd2.') ? (Array.isArray(env.wraps) ? env.wraps.slice(0, 5) : []) : [env.blob]) {
      try {
        payload = await openSealed(key, w, S.chatDialTopic);
      } catch {
        payload = null;
      }
      if (payload) break;
    }
    if (!payload) return;
    presentIncomingRing({ ringId, payload, fromFp, topic: S.chatDialTopic, viaChat: true });
  } catch {}
}

export function presentIncomingRing({ ringId, payload, fromFp, topic, viaChat }) {
  if (S.incoming || S.joined) return;
  // v38: без имени — анонимное из отпечатка звонящего (стабильно для одного
  // и того же человека, но ничего о нём не раскрывает).
  const name = String(payload?.name || '').trim() || anonName(fromFp || ringId);
  const back = backOf(payload, fromFp);
  S.incoming = { ringId, payload, fromFp, topic, name, back };
  if (back) rememberPeer({ secret: back.k, fp: back.d, name }).catch(() => {});
  $('#inName').textContent = name;
  $('#inMeta').textContent = viaChat
    ? `Входящий звонок из чата · отпечаток ${String(fromFp || '').slice(0, 8)}…`
    : `Входящий звонок по личной ссылке · отпечаток ${String(fromFp || '').slice(0, 8)}…`;
  $('#inAvatar').textContent = (name.trim()[0] || '?').toUpperCase();
  $('#incomingCall')?.classList.remove('hidden');
  startRingtone();
  inboxAck(getWorkerBase(), topic, ringId, S.personal).catch(() => {});
  // v38: нажали «Ответить» в уведомлении — принимаем без второго тапа.
  if (S.pendingAccept && S.pendingAccept === ringId) {
    S.pendingAccept = null;
    setTimeout(() => $('#btnAccept')?.click(), 60);
  }
}

export function closeIncoming() {
  stopRingtone();
  $('#incomingCall')?.classList.add('hidden');
  S.incoming = null;
}

// Код, который в app.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initNumberAdmin() {
  $('#btnChangeNumber') && ($('#btnChangeNumber').onclick = () => openDanger('number'));
  $('#btnWipeAll') && ($('#btnWipeAll').onclick = () => openDanger('wipe'));
  $('#dangerCancel') &&
    ($('#dangerCancel').onclick = () => {
      $('#dangerBox')?.classList.add('hidden');
      dangerKind = null;
    });
  $('#dangerGo') &&
    ($('#dangerGo').onclick = async () => {
      const go = $('#dangerGo');
      const note = $('#dangerNote');
      const say = (t) => {
        if (note) note.textContent = t;
      };
      // Второе нажатие подтверждает: случайный тап ничего не сотрёт.
      if (!go.dataset.armed) {
        go.dataset.armed = '1';
        (go.querySelector('span') || go).textContent = dangerKind === 'number' ? 'Точно сменить?' : 'Точно стереть?';
        return;
      }
      go.disabled = true;
      try {
        if (dangerKind === 'number') {
          const keep = [...document.querySelectorAll('#dangerKeepBox input[data-keep-dev]')]
            .filter((x) => x.checked)
            .map((x) => x.dataset.keepDev);
          const msg = await changeNumber(say, keep);
          say(msg);
          toast('Номер сменён');
          setTimeout(() => $('#dangerBox')?.classList.add('hidden'), 9000);
        } else if (dangerKind === 'wipe') {
          await wipeEverything(say, { backupToo: !!$('#wipeBackupToo')?.checked });
        }
      } catch (e) {
        say('Не получилось: ' + (e?.message || e));
        go.disabled = false;
        delete go.dataset.armed;
      }
    });
  $('#shareBack') &&
    ($('#shareBack').onchange = (e) => {
      try {
        localStorage.zvShareBack = e.target.checked ? '1' : '0';
      } catch {}
      syncLocal();
    });
  // v39: события синхронизации профиля (devices.js).
  window.addEventListener('zv-identity-changed', () => {
    // Номер сменён на основном устройстве (или это устройство только что
    // подключено): новый секрет, новый topic, новый сертификат.
    stopInboxListeners();
    resetIdentityCache();
    S.personal = null;
    S.personalRoom = null;
    refreshPersonalUI().catch(() => {});
    window.ZVChat?.identityChanged?.();
    window.__zvBackup?.render?.()?.catch?.(() => {});
  });
  window.addEventListener('zv-device-revoked', (e) => {
    // Это устройство отвязано (с основного или само): стираем данные
    // профиля локально; номер на сервере не трогаем — он живёт на других.
    const by = e?.detail?.by || '';
    toast(by === 'self' ? 'Устройство отвязано — стираем данные' : 'Это устройство отвязано от профиля — стираем данные', 4000);
    setTimeout(() => {
      wipeEverything(() => {}, { revoked: true, query: 'unlinked=1' }).catch(() => {});
    }, by === 'self' ? 200 : 1500);
  });
  window.addEventListener('zv-settings-synced', () => {
    const sb = $('#shareBack');
    if (sb) sb.checked = shareBackOn();
    const nm = $('#name');
    if (nm && !S.joined && !S.callNameOverride && document.activeElement !== nm) nm.value = localStorage.zvName || '';
  });
  window.addEventListener('zv-journal-synced', () => {
    renderCalls();
  });
  window.addEventListener('zv-devices-changed', () => {
    // Новое устройство в профиле — честное уведомление на всех остальных
    // (урок фишинга через привязку: владелец должен заметить чужое).
    devicesSeenCheck().catch(() => {});
  });
  $('#btnAccept') &&
    ($('#btnAccept').onclick = async () => {
      const inc = S.incoming;
      if (!inc || !S.personal) return;
      closeIncoming();
      await inboxAnswer(getWorkerBase(), inc.topic || S.personalRoom.topic, inc.ringId, 'accepted', {
        devicePub: S.personal.devicePub,
        sign: (t) => signWithDevice(t),
      }).catch(() => {});
      const inName = inc.name || inc.payload?.name;
      const inFp = inc.back?.d || null;
      S.callMeta = { dir: 'in', name: inName, fp: inFp, key: journalAdd('in', inName, 'accepted', inFp ? { fp: inFp } : null) };
      S.autoJoinPending = true;
      let target = `k=${S.personal.secret}&d=${S.personal.fp}`;
      // v28: дозвон из чата несёт в запечатанном payload секрет отдельной
      // звонковой комнаты (1:1 из чата или групповой). Принявший входит именно
      // в неё, а не в личную комнату владельца — иначе чат-дозвон не сойдётся
      // с вызывающим. Обычный дозвон по личной ссылке payload без roomSecret
      // и идёт прежним путём.
      try {
        const ks = inc.payload?.roomSecret;
        if (ks && /^[A-Za-z0-9_-]{22,}$/.test(ks)) target = `k=${ks}`;
      } catch {}
      if (location.hash.slice(1) === target) preJoin();
      else location.hash = target;
    });
  $('#btnDecline') &&
    ($('#btnDecline').onclick = async () => {
      const inc = S.incoming;
      if (!inc || !S.personal) return;
      closeIncoming();
      await inboxAnswer(getWorkerBase(), inc.topic || S.personalRoom.topic, inc.ringId, 'declined', {
        devicePub: S.personal.devicePub,
        sign: (t) => signWithDevice(t),
      }).catch(() => {});
      journalAdd('in', inc.name || inc.payload?.name, 'declined', inc.back?.d ? { fp: inc.back.d } : null);
    });
  $('#btnCreatePersonal') &&
    ($('#btnCreatePersonal').onclick = async () => {
      try {
        // v38: метка устройства уходит на сервер входящих открытым текстом —
        // не отправляем туда имя пользователя.
        await ensurePersonal('Владелец');
        toast('Личная ссылка создана — отправьте её тем, кто должен вам звонить');
        refreshPersonalUI().catch(() => {});
      } catch (e) {
        // v22: раньше здесь не было try/catch — любая ошибка (например,
        // заблокированная IndexedDB) умирала молча, кнопка «не работала».
        const text = 'Не удалось создать ссылку: ' + (e?.message || e);
        toast(text);
        window.__zvShowDiag?.(text + ' Пришлите этот текст разработчику.');
      }
    });
  $('#btnCopyPersonal') &&
    ($('#btnCopyPersonal').onclick = () => S.personal && copy(personalLinkOf(S.personal)));
  // v43: QR личной ссылки — собеседник наводит камеру телефона и сразу звонит.
  $('#btnQrPersonal') &&
    ($('#btnQrPersonal').onclick = () => {
      const q = $('#personalQr');
      if (!q || !S.personal) return;
      const show = q.classList.contains('hidden');
      q.classList.toggle('hidden', !show);
      $('#btnQrPersonal').setAttribute('aria-expanded', String(show));
      if (show) renderQr(q, personalLinkOf(S.personal));
    });
  $('#btnSharePersonal') &&
    ($('#btnSharePersonal').onclick = () =>
      S.personal &&
      navigator
        .share({ title: 'ZVONochek', text: 'Моя личная ссылка для звонков:', url: personalLinkOf(S.personal) })
        .catch(() => {}));
}
