// chat-net.js — Транспортный менеджер, резервный канал и WebSocket
// v44: вынесено из chat.js без изменения логики (строки 3173–3395 v43).
import { CONFIG } from './config.js?v=44';
import { ChatTransportManager, FallbackTransport } from './chat-transport.js?v=44';
import { getChatNostrSecret } from './identity.js?v=44';
import { $, ONLINE, api, chatBase, cur, putMsg, renderMembersList, renderPresence, roomMessages, saveRoom, status, workerBase } from './chat.js?v=44';
import { applyPresence, applyReceipt, fetchMissed, ingest, sendReadAck } from './chat-delivery.js?v=44';

// ---------- v28: транспортный менеджер и резервный канал ----------
// Основной канал — воркер (WS + HTTP, поведение не менялось). При его
// недоступности дольше порога менеджер переключает комнату на
// FallbackTransport (MQTT live + Nostr store); сообщения этого периода
// помечаются pendingWorkerSync и при возврате воркера публикуются в него
// ровно тем же blob (серверный дедуп по хэшу съедает дубли).
export async function workerHealthOk() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(workerBase() + '/health', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}
export async function healthTick() {
  if (!cur || cur.closed || !cur.mgr) return;
  // v38: живой WS воркера — уже доказательство его здоровья; раньше каждая
  // открытая комната дёргала /health раз в 5 секунд (≈17 000 запросов в
  // сутки на устройство — заметная доля бесплатного лимита воркера).
  if (cur.transportMode === 'worker' && cur.ws && cur.ws.readyState === 1) {
    // Страховка от «полуоткрытого» сокета мобильной сети: долгое молчание
    // WS на видимом экране — один дешёвый fetch раз в 90 с.
    const now = Date.now();
    if (
      document.visibilityState === 'visible' &&
      now - (cur.lastWsAt || 0) > 90000 &&
      now - (cur.lastSafetyFetch || 0) > 90000
    ) {
      cur.lastSafetyFetch = now;
      fetchMissed().catch(() => {});
    }
    return;
  }
  if (navigator.onLine === false) return;
  const ok = await workerHealthOk();
  if (!cur || cur.closed || !cur.mgr) return;
  if (ok) await cur.mgr.noteWorkerSuccess().catch(() => {});
  else await cur.mgr.noteWorkerFailure().catch(() => {});
}
export function applyTransportMode(mode) {
  if (!cur) return;
  cur.transportMode = mode === 'worker' ? 'worker' : 'fallback';
  const fb = cur.transportMode === 'fallback';
  $('#chatFallbackBadge')?.classList.toggle('hidden', !fb);
  const attach = $('#chatAttach');
  if (attach) {
    attach.disabled = fb;
    attach.title = fb
      ? 'Файлы недоступны на резервном канале'
      : 'Прикрепить файл';
  }
  const mic = $('#chatMic');
  if (mic) {
    mic.disabled = fb;
    mic.title = fb ? 'Голосовые недоступны на резервном канале' : 'Голосовое сообщение';
  }
  if (fb) {
    status('Резервный канал');
    try {
      cur.ws?.close();
    } catch {}
    // Подтянуть историю из Nostr store за время отсутствия воркера
    // (fetchSince ждёт курсор в секундах, fallbackSince храним в мс).
    cur.fb
      ?.fetchSince(Math.floor((cur.rec.fallbackSince || 0) / 1000))
      .then(async (items) => {
        let maxTs = cur.rec.fallbackSince || 0;
        for (const it of items || []) {
          const blob = typeof it === 'string' ? it : it?.blob;
          if (blob) await ingest({ blob }).catch(() => {});
          const ts = typeof it === 'object' ? it?.ts || 0 : 0;
          if (ts > maxTs) maxTs = ts;
        }
        if (cur && maxTs > (cur.rec.fallbackSince || 0)) {
          cur.rec.fallbackSince = maxTs;
          saveRoom(cur.rec).catch(() => {});
        }
      })
      .catch(() => {});
  } else {
    status(ONLINE);
    if (!cur.ws || cur.ws.readyState > 1) connectWs();
    fetchMissed().catch(() => {});
  }
  renderPresence();
}
// Ресинк при возврате воркера: pending-сообщения публикуются в воркер тем
// же blob, затем докачивается пропущенное. Ошибка любого шага оставляет
// комнату на резервном канале (менеджер это обработает).
export async function resyncToWorker() {
  if (!cur) return;
  const roomId = cur.rec.roomId;
  const items = await roomMessages(roomId);
  for (const it of items) {
    if (!it.pendingWorkerSync || !it.blobB64) continue;
    const r = await api(roomId, cur.keys.accessToken, '/msg', {
      method: 'POST',
      body: { blob: it.blobB64, dev: cur.device.devicePub },
    }).catch(() => null);
    if (!r || (r.status !== 200 && r.status !== 201 && r.status !== 409)) {
      throw new Error('ресинк: воркер отклонил сообщение (' + (r?.status || 'нет сети') + ')');
    }
    const upd = { ...it };
    delete upd.pendingWorkerSync;
    delete upd.blobB64;
    if (Number.isFinite(r.data?.seq)) upd.seq = r.data.seq;
    await putMsg(roomId, upd);
  }
  await fetchMissed();
}
export async function setupTransport() {
  if (!cur || cur.mgr) return;
  let secret = null;
  try {
    secret = await getChatNostrSecret();
  } catch {}
  const fb = new FallbackTransport({
    roomId: cur.keys.roomId,
    brokers: CONFIG.MQTT_BROKERS || [],
    relays: CONFIG.NOSTR_RELAYS || [],
    ntfyBase: CONFIG.NTFY_BASE || '',
    secret,
    onBlob: (blob) => {
      ingest({ blob }).catch(() => {});
    },
  });
  cur.fb = fb;
  cur.transportMode = 'worker';
  cur.mgr = new ChatTransportManager({
    fallback: fb,
    thresholdMs: 8000,
    onModeChange: (m) => applyTransportMode(m),
    onResync: () => resyncToWorker(),
  });
  cur.healthTimer = setInterval(() => {
    healthTick().catch(() => {});
  }, 5000);
}

// ---------- WebSocket ----------
export function connectWs() {
  if (!cur || cur.closed) return;
  const url = chatBase(cur.keys.roomId).replace(/^http/, 'ws') + '/listen';
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  cur.ws = ws;
  ws.onopen = () => {
    cur.backoff = 1000;
    // v28 (D): живой WS воркера — сигнал менеджеру каналов.
    cur.mgr?.noteWorkerSuccess().catch(() => {});
    ws.send(JSON.stringify({ type: 'auth', token: cur.keys.accessToken, dev: cur.device.devicePub }));
  };
  ws.onmessage = async (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (cur) cur.lastWsAt = Date.now();
    if (m.type === 'msg') await ingest({ seq: m.seq, blob: m.blob, ts: m.ts }, { live: true }).catch(() => {});
    else if (m.type === 'ready') {
      if (Array.isArray(m.online) && cur) {
        cur.online = new Set(m.online.filter((d) => d !== cur.device.devicePub));
        renderPresence();
        renderMembersList();
      }
      if (Array.isArray(m.members)) {
        for (const s of m.members) applyReceipt(s.dev, s.delivered, s.read);
      }
      fetchMissed().catch(() => {});
    } else if (m.type === 'presence') applyPresence(m.dev, !!m.online, m.ts);
    else if (m.type === 'receipt') applyReceipt(m.dev, m.delivered, m.read);
    else if (m.type === 'typing' && cur) {
      cur.typing = { dev: m.dev, until: Date.now() + 4000 };
      renderPresence();
      if (cur.typingTimer) clearTimeout(cur.typingTimer);
      cur.typingTimer = setTimeout(() => renderPresence(), 4100);
    }
  };
  ws.onclose = () => {
    if (!cur || cur.closed) return;
    // v28 (D): обрыв WS кормит менеджер; в fallback переподключения к
    // воркеру не крутим — возвратом управляет health-цикл менеджера.
    cur.mgr?.noteWorkerFailure().catch(() => {});
    if (cur.transportMode === 'fallback') return;
    status('Офлайн, переподключение…');
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}
export function scheduleReconnect() {
  if (!cur || cur.closed || cur.transportMode === 'fallback') return;
  const wait = cur.backoff;
  cur.backoff = Math.min(30000, cur.backoff * 2);
  setTimeout(() => {
    if (cur && !cur.closed) {
      connectWs();
      fetchMissed().catch(() => {});
    }
  }, wait);
}

// Код, который в chat.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initChatNet() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && cur && !cur.closed) {
      fetchMissed()
        .then(() => sendReadAck())
        .catch(() => {});
    }
  });
}
