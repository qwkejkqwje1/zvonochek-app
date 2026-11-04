// ZVONochek — клиент Inbox (коммуникатор): регистрация устройства, дозвон,
// слушатель входящих по WebSocket, ответы и пропущенные. Протокол и подписи —
// см. worker/inbox.js. Ring идёт ТОЛЬКО через Worker (не через публичные
// транспорты — иначе «кому звонят» узнали бы все наблюдатели сигналинга).
import { signWithDevice } from './identity.js?v=44';

const base = (workerUrl, topic) => `${workerUrl.replace(/\/$/, '')}/inbox/${topic}`;

async function post(workerUrl, topic, path, body) {
  const res = await fetch(base(workerUrl, topic) + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

export async function inboxRegister(workerUrl, topic, bundle, sub = null) {
  const ts = Date.now();
  const sig = await signWithDevice(`register|${topic}|${bundle.devicePub}|${ts}`);
  return post(workerUrl, topic, '/register', {
    masterPub: bundle.masterPub,
    fp: bundle.fp,
    devicePub: bundle.devicePub,
    cert: bundle.cert,
    // v27: восстановленная личность — цепочка master → recovery → device.
    // У обычной личности chain отсутствует, тело запроса не меняется.
    ...(bundle.chain ? { chain: bundle.chain } : {}),
    label: bundle.label,
    sub: sub
      ? {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        }
      : null,
    ts,
    sig,
  });
}

// v38: «Сменить номер» / «Стереть всё»: владелец отзывает свой Inbox —
// сервер удаляет устройства, push-подписки, звонки и пропущенные; звонки
// по старой ссылке дальше получают 404 «номер не обслуживается».
// v41: погасить номер может только владелец. admin — adminSigner()
// (identity.js): подпись master-ключом или recovery-ключом фразы, сервер
// сверяет её с отпечатком владельца. Без admin — подпись ключом устройства
// (сервер примет её только от основного/восстановленного устройства,
// подключённое получит 403 'linked device').
export async function inboxRetire(workerUrl, topic, bundle, admin = null) {
  const ts = Date.now();
  const text = `retire|${topic}|${bundle.devicePub}|${ts}`;
  if (admin) {
    const sig = await admin.sign(text);
    return post(workerUrl, topic, '/retire', { devicePub: bundle.devicePub, ts, sig, by: admin.kind, ...admin.extra });
  }
  const sig = await signWithDevice(text);
  return post(workerUrl, topic, '/retire', { devicePub: bundle.devicePub, ts, sig });
}

// v39: отвязка устройства профиля. signer(text) → подпись; by — 'master'
// (основное устройство), 'recovery' (ключ фразы восстановления, extra:
// {recoveryPub, recoveryCert}) или 'self' (подпись ключом самого target).
export async function inboxRevoke(workerUrl, topic, target, by, signer, extra = {}) {
  const ts = Date.now();
  const sig = await signer(`revoke|${topic}|${target}|${ts}`);
  return post(workerUrl, topic, '/revoke', { target, ts, sig, by, ...extra });
}

export async function inboxRing(workerUrl, topic, { ringId, fromFp, fromDevicePub, blob }) {
  return post(workerUrl, topic, '/ring', { ringId, fromFp, fromDevicePub, blob });
}

export async function inboxRingState(workerUrl, topic, ringId) {
  const res = await fetch(`${base(workerUrl, topic)}/ring/${ringId}`);
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

export async function inboxAck(workerUrl, topic, ringId, bundle) {
  const ts = Date.now();
  const sig = await signWithDevice(`ack|${topic}|${ringId}|${ts}`);
  return post(workerUrl, topic, `/ring/${ringId}/ack`, { devicePub: bundle.devicePub, ts, sig });
}

export async function inboxAnswer(workerUrl, topic, ringId, verdict, signer) {
  const ts = Date.now();
  const sig = await signer.sign(`answer|${topic}|${ringId}|${verdict}|${ts}`);
  return post(workerUrl, topic, `/ring/${ringId}/answer`, {
    verdict,
    devicePub: signer.devicePub,
    ts,
    sig,
  });
}

export async function inboxCancel(workerUrl, topic, ringId, callerSign, callerPub) {
  const ts = Date.now();
  const sig = await callerSign(`cancel|${topic}|${ringId}|${ts}`);
  return post(workerUrl, topic, `/ring/${ringId}/answer`, {
    verdict: 'cancelled',
    devicePub: callerPub,
    ts,
    sig,
  });
}

export async function inboxMissed(workerUrl, topic, bundle) {
  const ts = Date.now();
  const sig = await signWithDevice(`missed|${topic}|${ts}`);
  const qs = new URLSearchParams({ devicePub: bundle.devicePub, ts: String(ts), sig });
  const res = await fetch(`${base(workerUrl, topic)}/missed?${qs}`);
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

export async function inboxMissedAck(workerUrl, topic, ringIds, bundle) {
  const ts = Date.now();
  const sig = await signWithDevice(`missed|${topic}|${ts}`);
  return post(workerUrl, topic, '/missed/ack', {
    ringIds,
    devicePub: bundle.devicePub,
    ts,
    sig,
  });
}

// Слушатель входящих: держит WS на Inbox, переподключается с бэкоффом.
// onRing({ringId, blob, fromFp}), onState({ringId, state, answeredBy}).
export class InboxListener {
  constructor(workerUrl, topic, bundle, { onRing, onState, onStatus } = {}) {
    this.workerUrl = workerUrl;
    this.topic = topic;
    this.bundle = bundle;
    this.onRing = onRing;
    this.onState = onState;
    this.onStatus = onStatus;
    this.ws = null;
    this.closed = false;
    this.backoff = 1000;
    this.pingTimer = null;
  }
  connect() {
    if (this.closed) return;
    const url =
      base(this.workerUrl, this.topic).replace(/^http/, 'ws') + '/listen';
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = async () => {
      // v38: backoff сбрасывается по 'auth-ok' (старый сервер его не шлёт —
      // тогда по успешному открытию, как раньше, но не после отказа в auth).
      if (!this.authFails) this.backoff = 1000;
      try {
        const ts = Date.now();
        const sig = await signWithDevice(`listen|${this.topic}|${this.bundle.devicePub}|${ts}`);
        ws.send(JSON.stringify({ type: 'auth', devicePub: this.bundle.devicePub, ts, sig }));
        this.onStatus?.('online');
      } catch {}
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        try {
          ws.send('ping');
        } catch {}
      }, 25000);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'ring') this.onRing?.(m);
      else if (m.type === 'ring-state') this.onState?.(m);
      // v38: сервер подтверждает/отклоняет auth (до v38 молчал). При отказе
      // он закрывает сокет — переподключение повторит auth (обычно причина —
      // auth раньше /register, и через секунду устройство уже известно).
      else if (m.type === 'auth-ok') {
        this.authFails = 0;
        this.backoff = 1000;
        this.onStatus?.('online');
      } else if (m.type === 'auth-fail') {
        // Не долбим сервер: 2, 4, 8 … до 60 с между попытками.
        this.authFails = (this.authFails || 0) + 1;
        this.backoff = Math.min(60000, 1000 * 2 ** this.authFails);
        this.onStatus?.('offline');
        // v39: устройство не узнано — номер могли сменить на другом
        // устройстве профиля; синхронизация проверит это сразу.
        try {
          window.dispatchEvent(new CustomEvent('zv-inbox-authfail'));
        } catch {}
      }
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      this.onStatus?.('offline');
      // v39: сервер закрыл сокет как «revoked» — устройство отвязали от
      // профиля. Слову сервера не верим (иначе он мог бы стирать устройства):
      // синхронизация проверит подписанный отзыв и только тогда сотрёт.
      if (e && e.code === 4003) {
        this.authFails = Math.max(this.authFails || 0, 5);
        this.backoff = 60000;
        try {
          window.dispatchEvent(new CustomEvent('zv-inbox-revoked'));
        } catch {}
      }
      this.retry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }
  retry() {
    if (this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.authFails ? 60000 : 30000, this.backoff * 2);
    setTimeout(() => this.connect(), wait);
  }
  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    try {
      this.ws?.close();
    } catch {}
  }
}
