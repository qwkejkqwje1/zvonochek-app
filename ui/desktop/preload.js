// ZVONochek для ПК — preload: выполняется раньше скриптов страницы в каждом окне
// (Tauri: initialization_script; zv-devhost: вставляется первым <script> в web/index.html).
//  • window.__zvIpc — мост к ядру: call(cmd, args) → Promise, on(префикс события, fn) → отписка.
//  • Во встроенном веб-клиенте (ui/web): fetch к Worker/TURN — через ядро (Worker отвергает чужой Origin),
//    service worker не регистрируется, сырые ключи HKDF запоминаются (секрет комнаты для моста signaling.js),
//    автоматический вход в звонок и возврат в оболочку по завершении.
(function () {
  'use strict';
  if (window.__zvIpc) return;

  // ---------- IPC ----------
  const listeners = new Set();
  const deliver = (ev) => {
    if (!ev || typeof ev.event !== 'string') return;
    for (const l of listeners) {
      if (ev.event.startsWith(l.prefix)) {
        try {
          l.fn(ev.event, ev.payload);
        } catch (e) {
          console.error('[zv] обработчик события', ev.event, e);
        }
      }
    }
  };
  let call;
  const tauri = !!window.__TAURI_INTERNALS__;
  if (tauri) {
    // Быстрые команды — синхронной командой Tauri: выполняются по порядку (desc раньше cand).
    const ORDERED = new Set(['room_send', 'room_join', 'room_leave', 'room_bye']);
    call = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(ORDERED.has(cmd) ? 'zv_sync' : 'zv', { cmd, args });
    const sub = () => {
      const ev = window.__TAURI__ && window.__TAURI__.event;
      if (ev && ev.listen) ev.listen('zv', (e) => deliver(e.payload));
      else setTimeout(sub, 20);
    };
    sub();
  } else {
    let ws = null;
    let open = false;
    let seq = 0;
    const pending = new Map();
    const queue = [];
    const connect = () => {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ipc');
      ws.onopen = () => {
        open = true;
        while (queue.length) ws.send(queue.shift());
      };
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.event) return deliver(m);
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.res(m.result);
        else p.rej(new Error(m.error));
      };
      ws.onclose = () => {
        open = false;
        for (const p of pending.values()) p.rej(new Error('ipc closed'));
        pending.clear();
        setTimeout(connect, 500);
      };
    };
    connect();
    call = (cmd, args = {}) =>
      new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        const s = JSON.stringify({ id, cmd, args });
        if (open) ws.send(s);
        else queue.push(s);
      });
  }
  const on = (prefix, fn) => {
    const l = { prefix, fn };
    listeners.add(l);
    return () => listeners.delete(l);
  };
  window.__zvIpc = { call, on, host: tauri ? 'tauri' : 'devhost' };

  // ---------- только встроенный веб-клиент ----------
  if (!/\/web\/(index\.html)?$/.test(location.pathname)) return;

  const boot = (() => {
    if (window.__ZV_BOOT__) return window.__ZV_BOOT__;
    try {
      const q = new URLSearchParams(location.search).get('zvboot');
      if (q) {
        sessionStorage.zvBoot = q;
        return JSON.parse(q);
      }
      return JSON.parse(sessionStorage.zvBoot || '{}');
    } catch {
      return {};
    }
  })();
  window.__zvBoot = boot;

  try {
    localStorage.zvOnboarded = '1';
    if (boot.name) localStorage.zvName = boot.name;
  } catch {}

  // service worker: не нужен (файлы локальные) и опасен — закэшировал бы старую версию приложения
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.reject(new Error('service worker отключён в приложении'));
      navigator.serviceWorker
        .getRegistrations?.()
        .then((rs) => rs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
  } catch {}

  const b64 = {
    enc(u8) {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    },
    dec(s) {
      const bin = atob(s);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    },
  };
  const bytesOf = (b) =>
    b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);

  // сырые ключи HKDF → кандидаты секрета комнаты (выбирает ядро по топику)
  try {
    const subtle = crypto.subtle;
    const orig = subtle.importKey.bind(subtle);
    window.__zvHkdfSecrets = [];
    subtle.importKey = function (format, keyData, alg, ...rest) {
      try {
        const name = typeof alg === 'string' ? alg : alg && alg.name;
        if (format === 'raw' && String(name).toUpperCase() === 'HKDF') {
          const s = b64.enc(bytesOf(keyData)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const arr = window.__zvHkdfSecrets;
          if (!arr.includes(s)) {
            arr.push(s);
            if (arr.length > 32) arr.shift();
          }
        }
      } catch {}
      return orig(format, keyData, alg, ...rest);
    };
  } catch {}

  // fetch к Worker и TURN-провайдеру — через ядро (без заголовка Origin)
  const origFetch = window.fetch.bind(window);
  const proxied = (u) =>
    /^https:\/\/([^/]+\.)?(workers\.dev|metered\.live)(\/|$|\?)/.test(u) ||
    (!!boot.proxyLocal && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(u) && !u.startsWith(location.origin));
  window.fetch = async function (input, init) {
    init = init || {};
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : isReq ? input.url : String(input);
    let abs;
    try {
      abs = new URL(raw, location.href).href;
    } catch {
      return origFetch(input, init);
    }
    if (!proxied(abs)) return origFetch(input, init);
    const method = String(init.method || (isReq ? input.method : 'GET')).toUpperCase();
    const headers = {};
    try {
      new Headers(init.headers || (isReq ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    } catch {}
    let body;
    let bodyB64;
    let b = init.body;
    if (b == null && isReq && method !== 'GET' && method !== 'HEAD') b = await input.clone().arrayBuffer();
    if (typeof b === 'string') body = b;
    else if (b instanceof URLSearchParams) {
      body = b.toString();
      headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded;charset=UTF-8';
    } else if (b instanceof Blob) bodyB64 = b64.enc(new Uint8Array(await b.arrayBuffer()));
    else if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) bodyB64 = b64.enc(bytesOf(b));
    else if (b != null) body = String(b);
    const signal = init.signal;
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const p = window.__zvIpc.call('http_fetch', { url: abs, method, headers, body, bodyB64 });
    const r = await (signal
      ? Promise.race([
          p,
          new Promise((_, rej) =>
            signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true })
          ),
        ])
      : p);
    const data = r.bodyB64 != null ? b64.dec(r.bodyB64) : r.body;
    const nobody = r.status === 204 || r.status === 205 || r.status === 304 || method === 'HEAD';
    return new Response(nobody ? null : data, { status: r.status, headers: r.headers || {} });
  };

  // автоматический вход (ответ на входящий / звонок из оболочки)
  if (boot.auto) {
    const t0 = Date.now();
    const tryJoin = () => {
      const pj = document.querySelector('#prejoin');
      const btn = document.querySelector('#btnJoin');
      if (pj && btn && !pj.classList.contains('hidden') && !btn.disabled) {
        const nm = document.querySelector('#name');
        if (nm && boot.name && !nm.value.trim()) nm.value = boot.name;
        btn.click();
        return;
      }
      if (Date.now() - t0 < 30000) setTimeout(tryJoin, 150);
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => setTimeout(tryJoin, 200));
    else setTimeout(tryJoin, 200);
  }

  // звонок завершён (из адреса пропал k=) → сообщить хосту: окно звонка закрывается
  let inCall = false;
  const hasK = () => /(^#|&)k=/.test(location.hash);
  const check = () => {
    if (hasK()) {
      inCall = true;
      return;
    }
    if (inCall) {
      inCall = false;
      window.__zvIpc.call('host_call_done', {}).catch(() => {});
    }
  };
  for (const fn of ['pushState', 'replaceState']) {
    const o = history[fn].bind(history);
    history[fn] = function (...a) {
      const r = o(...a);
      setTimeout(check, 0);
      return r;
    };
  }
  addEventListener('hashchange', check);
  check();
})();
