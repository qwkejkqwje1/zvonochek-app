// ZVONochek для ПК — preload: выполняется раньше скриптов страницы в каждом окне
// (Tauri: initialization_script; zv-devhost: вставляется первым <script> в web/index.html).
//  • window.__zvIpc — мост к ядру: call(cmd, args) → Promise, on(префикс события, fn) → отписка.
//  • Во встроенном веб-клиенте (ui/web): fetch и WebSocket к Worker/TURN — через ядро (Worker отвергает чужой Origin),
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
    const ORDERED = new Set(['room_send', 'room_join', 'room_leave', 'room_bye', 'ws_open', 'ws_send', 'ws_close', 'ws_keep']);
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

  // service worker: не нужен (файлы локальные) и опасен — закэшировал бы старую версию приложения.
  // `ready` без него не наступил бы никогда — веб-чат ждал бы его вечно (подписка на push).
  try {
    if (navigator.serviceWorker) {
      const off = () => Promise.reject(new Error('service worker отключён в приложении'));
      navigator.serviceWorker.register = off;
      Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, get: off });
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

  // WebSocket к Worker (веб-чаты `#chat=`) — через ядро (ws_open/ws_send/ws_close, события ws:*):
  // заголовок Origin у сокета WebView не убрать, а Worker пускает только сайт и запросы без Origin.
  const OrigWS = window.WebSocket;
  const wsProxied = (u) =>
    /^wss:\/\/([^/]+\.)?workers\.dev(\/|$|\?)/.test(u) ||
    (!!boot.proxyLocal && /^ws:\/\/(127\.0\.0\.1|localhost):\d+\//.test(u) && !u.startsWith('ws://' + location.host + '/'));
  if (OrigWS) {
    const socks = new Map();
    let subscribed = false;
    const rid = () => {
      const a = crypto.getRandomValues(new Uint8Array(12));
      return 'w' + Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
    };
    const ST = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
    class ZvSocket extends EventTarget {
      constructor(url, protocols) {
        super();
        this.url = url;
        this.readyState = 0;
        this.protocol = '';
        this.extensions = '';
        this.bufferedAmount = 0;
        this.binaryType = 'blob';
        this.onopen = this.onmessage = this.onerror = this.onclose = null;
        this._id = rid();
        this._chain = Promise.resolve();
        socks.set(this._id, this);
        if (!subscribed) {
          subscribed = true;
          window.__zvIpc.on('ws:', (ev, p) => {
            const sock = p && socks.get(p.id);
            if (sock) sock._ev(ev, p);
          });
        }
        const list = protocols == null ? [] : [].concat(protocols).map(String);
        window.__zvIpc
          .call('ws_open', { id: this._id, url, protocols: list })
          .catch(() => this._ev('ws:close', { code: 1006, reason: '', clean: false }));
      }
      _fire(type, ev) {
        const h = this['on' + type];
        if (typeof h === 'function') {
          try {
            h.call(this, ev);
          } catch (e) {
            console.error('[zv] WebSocket on' + type, e);
          }
        }
        this.dispatchEvent(ev);
      }
      _ev(ev, p) {
        if (ev === 'ws:open') {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.protocol = p.protocol || '';
          this._fire('open', new Event('open'));
        } else if (ev === 'ws:msg') {
          if (this.readyState !== 1) return;
          let data = p.text;
          if (p.b64 != null) {
            const u8 = b64.dec(p.b64);
            data = this.binaryType === 'arraybuffer' ? u8.buffer : new Blob([u8]);
          }
          this._fire('message', new MessageEvent('message', { data, origin: new URL(this.url).origin }));
        } else if (ev === 'ws:close') {
          if (this.readyState === 3) return;
          this.readyState = 3;
          socks.delete(this._id);
          if (!p.clean) this._fire('error', new Event('error'));
          this._fire('close', new CloseEvent('close', { code: p.code || 1006, reason: p.reason || '', wasClean: !!p.clean }));
        }
      }
      send(data) {
        if (this.readyState === 0) throw new DOMException('WebSocket ещё подключается', 'InvalidStateError');
        if (this.readyState !== 1) return;
        const id = this._id;
        this._chain = this._chain
          .then(async () => {
            const a =
              typeof data === 'string'
                ? { id, text: data }
                : { id, b64: b64.enc(data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : bytesOf(data)) };
            return window.__zvIpc.call('ws_send', a);
          })
          .catch(() => {});
      }
      close(code, reason) {
        if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999))
          throw new DOMException('Недопустимый код закрытия', 'InvalidAccessError');
        if (this.readyState >= 2) return;
        this.readyState = 2;
        window.__zvIpc.call('ws_close', { id: this._id, code: code || 1000, reason: String(reason || '') }).catch(() => {});
      }
    }
    Object.assign(ZvSocket, ST);
    Object.assign(ZvSocket.prototype, ST);
    const WS = function WebSocket(url, protocols) {
      if (!new.target) throw new TypeError("WebSocket: нужен 'new'");
      let abs;
      try {
        abs = new URL(url, location.href).href;
      } catch {
        abs = String(url);
      }
      if (wsProxied(abs)) return new ZvSocket(abs, protocols);
      return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    };
    WS.prototype = OrigWS.prototype;
    Object.assign(WS, ST);
    window.WebSocket = WS;
    // ядро закрывает сокеты, которые страница перестала подтверждать (окно закрыли)
    setInterval(() => {
      if (socks.size) window.__zvIpc.call('ws_keep', { ids: [...socks.keys()] }).catch(() => {});
    }, 30000);
    addEventListener('pagehide', () => {
      for (const id of socks.keys()) window.__zvIpc.call('ws_close', { id, code: 1000 }).catch(() => {});
    });
  }

  // окно веб-чатов (ссылки `#chat=` сайта): только раздел «Чаты» веб-клиента
  if (boot.chat) {
    const css = document.createElement('style');
    css.textContent = '.tabbar{display:none!important}';
    (document.head || document.documentElement).appendChild(css);
    const toChats = () => {
      if (!/(^#|&)chat=/.test(location.hash)) document.querySelector('[data-home-tab="chats"]')?.click();
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => setTimeout(toChats, 0));
    else setTimeout(toChats, 0);
    // Android «Назад»: из открытого чата — к списку, из списка — в оболочку
    window.__zvBack = () => {
      const back = document.querySelector('#chatBack');
      if (/(^#|&)chat=/.test(location.hash) && back && back.offsetParent !== null) {
        back.click();
        return true;
      }
      window.__zvIpc.call('host_call_done', {}).catch(() => {});
      return true;
    };
  }

  // звонок контакту без видео: первый запрос «микрофон + камера» — только микрофон
  // (веб-клиент сам выключит кнопку камеры, если видеодорожки нет; включить её можно в звонке)
  if (boot.video === false && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = function (c) {
      if (c && c.audio && c.video) c = Object.assign({}, c, { video: false });
      return orig(c);
    };
  }

  // звонок контакту: «звоним…», итог вызова (ядро: ring:ringing/accepted/ended, contact_call_state)
  // и завершение, когда собеседник положил трубку (комната контакта — только на этот звонок)
  if (boot.contact) {
    const who = String(boot.contact);
    const out = boot.dir === 'out';
    let pill = null;
    let hideT = null;
    let ended = false;
    let byeT = null;
    const show = (text, kind, ms) => {
      if (!pill) {
        pill = document.createElement('div');
        pill.id = 'zvRing';
        pill.setAttribute('role', 'status');
        pill.style.cssText =
          'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483000;pointer-events:none;' +
          'padding:9px 16px;border-radius:999px;font:600 14px/1.3 "Segoe UI",system-ui,sans-serif;color:#fff;' +
          'box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:calc(100vw - 40px);' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .25s';
        (document.body || document.documentElement).appendChild(pill);
      }
      pill.textContent = text;
      pill.style.background =
        kind === 'bad' ? 'rgba(198,40,40,.94)' : kind === 'ok' ? 'rgba(46,125,50,.94)' : 'rgba(23,33,43,.92)';
      pill.style.opacity = '1';
      clearTimeout(hideT);
      if (ms) hideT = setTimeout(() => pill && (pill.style.opacity = '0'), ms);
    };
    const hangup = (delay) =>
      setTimeout(() => {
        const hang = document.querySelector('#cHang');
        if (hang && hang.offsetParent !== null) hang.click();
        else window.__zvIpc.call('host_call_done', {}).catch(() => {});
      }, delay);
    const finish = (reason) => {
      if (ended) return;
      ended = true;
      show(
        reason === 'declined'
          ? `«${who}» отклонил(а) звонок`
          : reason === 'dnd'
            ? `У «${who}» «Не беспокоить»`
            : reason === 'hangup'
              ? `«${who}» завершил(а) звонок`
              : `«${who}» не отвечает`,
        reason === 'hangup' ? '' : 'bad'
      );
      // собеседник не придёт — завершаем звонок (окно приложения закроется само)
      hangup(reason === 'hangup' ? 1500 : 2600);
    };
    const apply = (state, reason) => {
      if (ended || !out) return;
      if (state === 'calling') show(`Звоним «${who}»…`);
      else if (state === 'ringing') show(`У «${who}» звонит…`);
      else if (state === 'accepted') show(`«${who}» отвечает`, 'ok', 3000);
      else if (state === 'ended') finish(reason);
    };
    const start = () => {
      if (out) apply('calling');
      // события могли прийти, пока окно открывалось
      const k = (location.hash.match(/(?:^#|&)k=([^&]+)/) || [])[1];
      if (k)
        window.__zvIpc
          .call('contact_call_state', { secret: decodeURIComponent(k) })
          .then((st) => st && apply(st.state, st.reason))
          .catch(() => {});
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start);
    else start();
    window.__zvIpc.on('ring:', (ev, p) => {
      if (ev === 'ring:ringing') apply('ringing');
      else if (ev === 'ring:accepted') apply('accepted');
      else if (ev === 'ring:ended') apply('ended', p && p.reason);
    });
    window.__zvIpc.on('room:msg', (_, p) => {
      const m = p && p.msg;
      if (!m || ended) return;
      if (m.type === 'bye') {
        clearTimeout(byeT);
        byeT = setTimeout(() => finish('hangup'), 1200);
      } else if (m.type === 'hello' || m.type === 'hi') {
        clearTimeout(byeT);
      }
    });
  }

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
