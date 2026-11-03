// ZVONochek Service Worker v40 — мгновенный старт, офлайн-оболочка и безопасные обновления
const CACHE_NAME = 'zvonochek-v40';
const CORE = [
  './',
  './index.html',
  './style.css?v=40',
  './app.js?v=40',
  './group.js?v=40',
  './store.js?v=40',
  './identity.js?v=40',
  './inbox.js?v=40',
  './chat.js?v=40',
  './chat-transport.js?v=40',
  './backup.js?v=40',
  './signaling.js?v=40',
  './ntfy.js?v=40',
  './crypto.js?v=40',
  './config.js?v=40',
  './zvdiag.js?v=40',
  './callstats.js?v=40',
  './media-policy.js?v=40',
  './stats-ui.js?v=40',
  './coalesce.js?v=40',
  './mqtt-lite.js?v=40',
  './anon-names.js?v=40',
  './devices.js?v=40',
  './sync-core.js?v=40',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/badge-96.png',
  './manifest.webmanifest',
  './vendor/qrcode.js?v=40',
  './vendor/secp256k1.js?v=40',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      // Один отсутствующий файл не должен ломать установку всего SW.
      Promise.allSettled(CORE.map((url) => c.add(new Request(url, { cache: 'reload' }))))
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Версию, сам SW и любые коды ответов проверяем только по сети.
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('/sw.js')) return;
  if (req.headers.has('range')) return;

  // Навигация: сначала сеть (свежий index.html), при офлайне — кэш.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match('./index.html')))
    );
    return;
  }

  // Статика: stale-while-revalidate — мгновенный ответ из кэша + фоновое обновление.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ---------- Web Push (payload — только {t, topic, ringId} / {t, room}) ----------
// v38: звонок — громкое уведомление с вибрацией и кнопкой «Ответить», повторы
// сервера (3/20/45 с) перевибрируют то же уведомление; отменённый/истёкший
// звонок превращается в «Пропущенный»; приглашение в звонок из чата (call:1)
// — отдельное уведомление «Звонок в чате».
const RING_VIBRATE = [700, 300, 700, 300, 700, 300, 700, 300, 700];
const ICON = './icons/icon-192.png';
const BADGE = './icons/badge-96.png';

async function windowsState() {
  const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  return { wins, visible: wins.some((w) => w.visibilityState === 'visible') };
}

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {}
  if (d.t === 'ring') {
    e.waitUntil(
      (async () => {
        const { wins, visible } = await windowsState();
        for (const w of wins) {
          w.postMessage({ type: 'incoming-ring-push', ringId: d.ringId, topic: d.topic });
        }
        if (!visible) {
          await self.registration.showNotification('📞 Входящий звонок — ZVONochek', {
            body: 'Нажмите, чтобы ответить',
            tag: 'ring-' + d.ringId,
            icon: ICON,
            badge: BADGE,
            requireInteraction: true,
            renotify: true,
            vibrate: RING_VIBRATE,
            timestamp: Date.now(),
            actions: [{ action: 'accept', title: 'Ответить' }],
            data: { ringId: d.ringId, topic: d.topic },
          });
        }
      })()
    );
  } else if (d.t === 'chat') {
    // v21: wake-up приватного чата. Payload несёт только хэш-префикс комнаты:
    // ни текста, ни никнейма — уведомление принципиально пустое по смыслу.
    e.waitUntil(
      (async () => {
        const { wins, visible } = await windowsState();
        for (const w of wins) w.postMessage({ type: 'chat-push', room: d.room, call: d.call ? 1 : 0 });
        if (visible) return;
        if (d.call) {
          await self.registration.showNotification('📞 Звонок в чате — ZVONochek', {
            body: 'Вас зовут в звонок. Нажмите, чтобы открыть чат и войти',
            tag: 'chatcall-' + (d.room || ''),
            icon: ICON,
            badge: BADGE,
            requireInteraction: true,
            renotify: true,
            vibrate: RING_VIBRATE,
            timestamp: Date.now(),
            data: { chat: d.room || '', call: 1 },
          });
        } else {
          await self.registration.showNotification('Новое сообщение — ZVONochek', {
            body: 'В приватном чате есть непрочитанное сообщение',
            tag: 'chat-' + (d.room || ''),
            icon: ICON,
            badge: BADGE,
            vibrate: [120, 80, 120],
            timestamp: Date.now(),
            data: { chat: d.room || '' },
          });
        }
      })()
    );
  } else if (d.t === 'ring-done') {
    e.waitUntil(
      (async () => {
        const tags = ['ring-' + d.ringId, String(d.ringId || '')];
        let had = false;
        for (const tag of tags) {
          const ns = await self.registration.getNotifications({ tag }).catch(() => []);
          for (const n of ns) {
            had = true;
            n.close();
          }
        }
        if (had && (d.state === 'expired' || d.state === 'cancelled')) {
          await self.registration.showNotification('Пропущенный звонок — ZVONochek', {
            body: 'Вам звонили по личной ссылке',
            tag: 'missed-' + d.ringId,
            icon: ICON,
            badge: BADGE,
            silent: true,
            timestamp: Date.now(),
            data: { missed: 1 },
          });
        }
      })()
    );
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const ringId = data.ringId || '';
  const accept = e.action === 'accept' && !!ringId;
  // v28: уведомления о сообщениях чата — фокус приложения; комнату по
  // префиксу её id откроет сама страница из локального списка комнат (seed
  // в уведомление не кладём: это носитель доступа к комнате).
  const chatRoom = data.chatRoom || data.chat || '';
  e.waitUntil(
    (async () => {
      const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const msg = chatRoom
        ? { type: 'chat-notification', roomId: chatRoom, call: data.call ? 1 : 0 }
        : ringId
          ? { type: 'incoming-ring-push', ringId, act: accept ? 'accept' : '' }
          : { type: 'open-calls' };
      for (const w of wins) {
        try {
          await w.focus();
        } catch {}
        w.postMessage(msg);
        return;
      }
      let url = './';
      if (chatRoom) url += '?openchat=' + encodeURIComponent(chatRoom) + (data.call ? '&call=1' : '');
      else if (ringId) url += '?ring=' + encodeURIComponent(ringId) + (accept ? '&act=accept' : '');
      else if (data.missed) url += '?tab=calls';
      await clients.openWindow(url);
    })()
  );
});

self.addEventListener('pushsubscriptionchange', (e) => {
  // Страница при следующем старте сверит подписку и перерегистрируется
  // (v38: это делается при каждом запуске автоматически).
  e.waitUntil(
    caches.open('zvonochek-flags').then((c) => c.put('/push-resubscribe', new Response('1')))
  );
});
