// push-ui.js — Web Push: автоподписка, кнопки уведомлений и пропущенные звонки
// v44: вынесено из app.js без изменения логики (строки 5349–5498 v43).
import { anonName } from './anon-names.js?v=44';
import { b64u, open as openSealed } from './crypto.js?v=44';
import { getWorkerBase } from './config.js?v=44';
import { inboxMissed, inboxMissedAck, inboxRegister } from './inbox.js?v=44';
import { renderCallsList } from './stats-ui.js?v=44';
import { $, S, fetchJson, toast } from './app.js?v=44';
import { backOf, callPeer, contactsLoad, openContactMenu, rememberPeer } from './contacts.js?v=44';

// ---------- v38: Web Push — автоподписка и регистрация везде ----------
// Раньше подписка жила только до перезагрузки (S.pushSub не восстанавливался),
// топик дозвона из чата регистрировался без подписки, а кнопка уведомлений
// чата вообще не подписывалась на push. Теперь: если разрешение уже дано,
// подписка сверяется/создаётся при каждом запуске и регистрируется в Inbox
// (личная ссылка + дозвон из чата) и во всех чатах (событие zv-push-sub).
export const pushSupported = () =>
  'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window;
export let pushEnsuring = null;
export async function ensurePushSub({ interactive = false } = {}) {
  if (!pushSupported()) return null;
  if (Notification.permission === 'denied') return null;
  if (Notification.permission !== 'granted') {
    if (!interactive) return null;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return null;
  }
  if (pushEnsuring) return pushEnsuring;
  pushEnsuring = (async () => {
    // VAPID-ключ — у того же Worker, который подписывает пуши: у «своего
    // сервера» своя пара ключей; подписка на чужой ключ молча не доставлялась бы.
    const key = (await fetchJson(getWorkerBase() + '/push-key').catch(() => null))?.public;
    if (!key) return null;
    const appKey = b64u.dec(key);
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const subKey = sub?.options?.applicationServerKey;
    if (sub && subKey && b64u.enc(new Uint8Array(subKey)) !== b64u.enc(appKey)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const j = sub.toJSON();
    const next = { endpoint: j.endpoint, keys: j.keys };
    let lastEp = '';
    try {
      lastEp = localStorage.getItem('zvPushEp') || '';
    } catch {}
    const changed = !S.pushSub || S.pushSub.endpoint !== next.endpoint || lastEp !== next.endpoint;
    S.pushSub = next;
    if (changed) {
      try {
        localStorage.setItem('zvPushEp', next.endpoint);
      } catch {}
      await registerPushEverywhere().catch(() => {});
    }
    updatePushUI();
    return S.pushSub;
  })();
  try {
    return await pushEnsuring;
  } finally {
    pushEnsuring = null;
  }
}
export async function registerPushEverywhere() {
  if (!S.pushSub) return;
  const base = getWorkerBase();
  if (S.personal && S.personalRoom) {
    await inboxRegister(base, S.personalRoom.topic, S.personal, S.pushSub).catch(() => {});
    if (S.chatDialTopic) await inboxRegister(base, S.chatDialTopic, S.personal, S.pushSub).catch(() => {});
  }
  try {
    window.dispatchEvent(new CustomEvent('zv-push-sub', { detail: S.pushSub }));
  } catch {}
}

export function updatePushUI() {
  const b = $('#btnEnablePush');
  const hint = $('#pushHint');
  const set = (text, disabled, showHint) => {
    if (b) {
      b.disabled = disabled;
      (b.querySelector('span') || b).textContent = text;
    }
    hint?.classList.toggle('hidden', !showHint);
  };
  if (!pushSupported()) {
    set('Push-уведомления не поддерживаются браузером', true, false);
  } else if (Notification.permission === 'denied') {
    set('Уведомления запрещены в настройках браузера', true, false);
  } else if (S.pushSub) {
    set('Push включён: звонки приходят и при закрытом приложении', true, false);
  } else {
    set('Включить звонки при закрытом приложении', false, true);
  }
}

export async function loadMissed() {
  if (!S.personal || !S.personalRoom) return;
  // v38: сначала регистрация устройства (иначе первый запрос — 403).
  await Promise.resolve(S.inboxRegP).catch(() => {});
  const r = await inboxMissed(getWorkerBase(), S.personalRoom.topic, S.personal).catch(() => null);
  const items = r?.data?.missed || [];
  S.missedIds = items.map((m) => m.ring_id);
  const box = $('#missedBox');
  const list = $('#missedList');
  if (!box || !list) return;
  box.classList.toggle('hidden', items.length === 0);
  // v36: пропущенные рисуются тем же видом, что и журнал звонков.
  const entries = [];
  for (const m of items) {
    let name = anonName(m.from_fp || m.ring_id);
    let fp = null;
    try {
      const pl = await openSealed(S.personalRoom.key, m.blob, S.personalRoom.topic);
      if (pl?.name) name = String(pl.name).slice(0, 60);
      const back = backOf(pl, m.from_fp);
      if (back) {
        fp = back.d;
        await rememberPeer({ secret: back.k, fp, name }).catch(() => {});
      }
    } catch {}
    entries.push({ ts: m.ts, dir: 'in', name, outcome: 'missed', fp });
  }
  const book = await contactsLoad();
  renderCallsList(list, entries, {
    onCall: (v) => callPeer(v.fp),
    onMenu: (v, el) => openContactMenu(v.fp, el, v),
    nameOf: (v) => (v.fp && book.items[v.fp]?.saved ? book.items[v.fp].name : null),
  });
}

// Код, который в app.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initPushUi() {
  window.__zvPush = {
    enable: () => ensurePushSub({ interactive: true }),
    ensure: () => ensurePushSub(),
    current: () => S.pushSub,
    supported: pushSupported,
  };
  $('#btnEnablePush') &&
    ($('#btnEnablePush').onclick = async () => {
      try {
        const sub = await ensurePushSub({ interactive: true });
        if (!sub) {
          if (pushSupported() && Notification.permission !== 'granted') return toast('Разрешение на уведомления не дано');
          return toast('Сервер не поддерживает push (нужен Worker v38). Пока приложение открыто, звонки приходят и так');
        }
        toast('Готово: звонки и сообщения будут приходить и при закрытом приложении');
      } catch (e) {
        toast('Не удалось включить уведомления: ' + e.message);
      }
    });
  $('#btnPushHint') && ($('#btnPushHint').onclick = () => $('#btnEnablePush')?.click());
  $('#btnMissedClear') &&
    ($('#btnMissedClear').onclick = async () => {
      if (S.missedIds?.length) {
        await inboxMissedAck(getWorkerBase(), S.personalRoom.topic, S.missedIds, S.personal).catch(() => {});
      }
      loadMissed().catch(() => {});
    });
}
