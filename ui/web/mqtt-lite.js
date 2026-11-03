// ZVONochek v36 — mqtt-lite: минимальный клиент MQTT 3.1.1 поверх WebSocket.
//
// Зачем свой клиент вместо vendor/mqtt.min.js (342 КБ):
//   · старые мобильные браузеры: бандл mqtt.js использует поля классов
//     (ES2022) и на движках до Chrome 72 / Safari 14 падал целиком — MQTT-канал
//     пропадал молча; этот файл — ES2017, классический скрипт;
//   · −340 КБ на первой загрузке через медленную или фильтруемую сеть;
//   · аудит: ~300 строк, которые можно прочитать, вместо минифицированного бандла.
//
// Реализовано ровно то, что используют signaling.js и chat-transport.js:
//   mqtt.connect(url, {username, password, clientId, clean, keepalive,
//                      connectTimeout, reconnectPeriod})
//   client.on('connect' | 'message' | 'close' | 'offline' | 'error' | 'reconnect', fn)
//   client.subscribe(topic, {qos})   client.publish(topic, payload, {qos})
//   client.connected                 client.end(force)
// QoS 0 и 1 (входящий QoS 1 подтверждается PUBACK; исходящий QoS 1 без
// повторной отправки — сессия всегда clean, как и раньше). Переподписка —
// делом вызывающего кода в обработчике 'connect' (так и было).
// Переподключение: reconnectPeriod, при подряд идущих неудачах — рост до 30 с
// (раньше мёртвый брокер дёргался каждые 3,5 с бесконечно и тратил батарею).
(function (root) {
  'use strict';

  var CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, SUBSCRIBE = 8, SUBACK = 9,
    PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;
  var MAX_BACKOFF_MS = 30000;
  var te = new TextEncoder();
  var td = new TextDecoder();

  function utf8(str) {
    var b = te.encode(String(str));
    var out = new Uint8Array(2 + b.length);
    out[0] = (b.length >> 8) & 0xff;
    out[1] = b.length & 0xff;
    out.set(b, 2);
    return out;
  }

  function concat(parts) {
    var len = 0, i;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var out = new Uint8Array(len), off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  // Remaining Length: 7 бит на байт, старший бит — «есть продолжение».
  function encodeLength(n) {
    var bytes = [];
    do {
      var d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d |= 0x80;
      bytes.push(d);
    } while (n > 0);
    return new Uint8Array(bytes);
  }

  function packet(type, flags, body) {
    body = body || new Uint8Array(0);
    return concat([new Uint8Array([(type << 4) | (flags & 0x0f)]), encodeLength(body.length), body]);
  }

  function u16(n) {
    return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
  }

  // Разбор потока: в один WebSocket-кадр может прийти несколько пакетов
  // или часть пакета — копим буфер и режем по заголовкам.
  function takePacket(buf) {
    if (buf.length < 2) return null;
    var mult = 1, len = 0, i = 1, d;
    do {
      if (i >= buf.length) return null;
      if (i > 4) throw new Error('mqtt: bad remaining length');
      d = buf[i++];
      len += (d & 0x7f) * mult;
      mult *= 128;
    } while (d & 0x80);
    if (buf.length < i + len) return null;
    return {
      type: buf[0] >> 4,
      flags: buf[0] & 0x0f,
      body: buf.subarray(i, i + len),
      rest: buf.subarray(i + len),
    };
  }

  function encodeConnect(o) {
    var flags = o.clean === false ? 0 : 0x02;
    var payload = [utf8(o.clientId)];
    if (o.username != null) {
      flags |= 0x80;
      payload.push(utf8(o.username));
      if (o.password != null) {
        flags |= 0x40;
        payload.push(utf8(o.password));
      }
    }
    var head = concat([utf8('MQTT'), new Uint8Array([4, flags]), u16(o.keepalive)]);
    return packet(CONNECT, 0, concat([head].concat(payload)));
  }

  function encodePublish(topic, payload, qos, id) {
    var data = typeof payload === 'string' ? te.encode(payload) : new Uint8Array(payload);
    var parts = [utf8(topic)];
    if (qos > 0) parts.push(u16(id));
    parts.push(data);
    return packet(PUBLISH, (qos & 3) << 1, concat(parts));
  }

  function encodeSubscribe(topic, qos, id) {
    return packet(SUBSCRIBE, 0x02, concat([u16(id), utf8(topic), new Uint8Array([qos & 1])]));
  }

  function decodePublish(p) {
    var b = p.body;
    var tlen = (b[0] << 8) | b[1];
    var topic = td.decode(b.subarray(2, 2 + tlen));
    var qos = (p.flags >> 1) & 3;
    var off = 2 + tlen, id = 0;
    if (qos > 0) {
      id = (b[off] << 8) | b[off + 1];
      off += 2;
    }
    var payload = b.slice(off);
    // Совместимость с mqtt.js: вызывающий код делает payload.toString().
    payload.toString = function () {
      return td.decode(this);
    };
    return { topic: topic, qos: qos, id: id, payload: payload };
  }

  function Client(url, opts) {
    opts = opts || {};
    this.url = url;
    this.opts = {
      clientId: opts.clientId || 'zv_' + Math.random().toString(16).slice(2, 12),
      username: opts.username,
      password: opts.password,
      clean: opts.clean !== false,
      keepalive: opts.keepalive > 0 ? opts.keepalive : 30,
      connectTimeout: opts.connectTimeout > 0 ? opts.connectTimeout : 7000,
      reconnectPeriod: opts.reconnectPeriod >= 0 ? opts.reconnectPeriod : 3500,
    };
    this.connected = false;
    this.ended = false;
    this.handlers = {};
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.nextId = 1;
    this.failures = 0;
    this.timers = { connect: null, ping: null, reconnect: null };
    this.lastRx = 0;
    this._open();
  }

  Client.prototype.on = function (ev, fn) {
    (this.handlers[ev] || (this.handlers[ev] = [])).push(fn);
    return this;
  };

  Client.prototype._emit = function (ev) {
    var list = this.handlers[ev];
    if (!list) return;
    var args = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].apply(this, args);
      } catch (e) {
        // Ошибка обработчика не должна ронять транспорт.
        if (root.console) root.console.warn('[mqtt-lite] handler error', e);
      }
    }
  };

  Client.prototype._id = function () {
    var id = this.nextId;
    this.nextId = id >= 65535 ? 1 : id + 1;
    return id;
  };

  Client.prototype._send = function (bytes) {
    var ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(bytes);
    return true;
  };

  Client.prototype._clearTimers = function () {
    clearTimeout(this.timers.connect);
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.reconnect);
    this.timers.connect = this.timers.ping = this.timers.reconnect = null;
  };

  Client.prototype._open = function () {
    var self = this;
    if (self.ended) return;
    var ws;
    try {
      ws = new WebSocket(self.url, 'mqtt');
    } catch (e) {
      self._emit('error', e);
      self._scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    self.ws = ws;
    self.buf = new Uint8Array(0);
    self.timers.connect = setTimeout(function () {
      if (!self.connected) self._drop(new Error('mqtt: connect timeout'));
    }, self.opts.connectTimeout);
    ws.onopen = function () {
      self._send(encodeConnect(self.opts));
    };
    ws.onmessage = function (ev) {
      if (!(ev.data instanceof ArrayBuffer)) return;
      self.lastRx = Date.now();
      self.buf = self.buf.length ? concat([self.buf, new Uint8Array(ev.data)]) : new Uint8Array(ev.data);
      try {
        var p;
        while ((p = takePacket(self.buf))) {
          self.buf = p.rest;
          self._handle(p);
        }
      } catch (e) {
        self._drop(e);
      }
    };
    ws.onerror = function () {
      self._emit('error', new Error('mqtt: websocket error'));
    };
    ws.onclose = function () {
      if (self.ws === ws) self._lost();
    };
  };

  Client.prototype._handle = function (p) {
    var self = this;
    if (p.type === CONNACK) {
      var rc = p.body[1];
      if (rc !== 0) {
        self._drop(new Error('mqtt: connection refused, code ' + rc));
        return;
      }
      clearTimeout(self.timers.connect);
      self.connected = true;
      self.failures = 0;
      var ka = self.opts.keepalive * 1000;
      clearInterval(self.timers.ping);
      self.timers.ping = setInterval(function () {
        // Нет ответа дольше полутора keepalive — соединение мёртвое (NAT,
        // фильтр, спящий телефон): рвём сами, не дожидаясь TCP.
        if (Date.now() - self.lastRx > ka * 1.5) {
          self._drop(new Error('mqtt: keepalive timeout'));
          return;
        }
        self._send(packet(PINGREQ, 0));
      }, ka);
      self._emit('connect', { cmd: 'connack', returnCode: 0 });
    } else if (p.type === PUBLISH) {
      var m = decodePublish(p);
      if (m.qos === 1) self._send(packet(PUBACK, 0, u16(m.id)));
      self._emit('message', m.topic, m.payload, m);
    }
    // PUBACK, SUBACK, PINGRESP: факт получения уже учтён в lastRx.
  };

  // Принудительно закрыть текущий сокет; onclose запустит переподключение.
  Client.prototype._drop = function (err) {
    if (err) this._emit('error', err);
    var ws = this.ws;
    if (!ws) return;
    try {
      ws.close();
    } catch (e) {}
    // Некоторые движки не присылают onclose для зависшего сокета.
    if (this.ws === ws) this._lost();
  };

  Client.prototype._lost = function () {
    var wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    this._clearTimers();
    if (!wasConnected) this.failures++;
    this._emit('close');
    if (this.ended) return;
    this._emit('offline');
    this._scheduleReconnect();
  };

  Client.prototype._scheduleReconnect = function () {
    var self = this;
    if (self.ended || self.opts.reconnectPeriod === 0 || self.timers.reconnect) return;
    var base = self.opts.reconnectPeriod;
    var delay = Math.min(MAX_BACKOFF_MS, base * Math.pow(2, Math.max(0, self.failures - 1)));
    delay = Math.round(delay * (0.85 + Math.random() * 0.3));
    self.timers.reconnect = setTimeout(function () {
      self.timers.reconnect = null;
      if (self.ended) return;
      self._emit('reconnect');
      self._open();
    }, delay);
  };

  Client.prototype.subscribe = function (topic, opts, cb) {
    var qos = opts && opts.qos ? 1 : 0;
    var ok = this._send(encodeSubscribe(topic, qos, this._id()));
    if (typeof cb === 'function') cb(ok ? null : new Error('mqtt: not connected'));
    return this;
  };

  Client.prototype.publish = function (topic, payload, opts, cb) {
    var qos = opts && opts.qos ? 1 : 0;
    var ok = this.connected && this._send(encodePublish(topic, payload, qos, qos ? this._id() : 0));
    if (typeof cb === 'function') cb(ok ? null : new Error('mqtt: not connected'));
    return this;
  };

  Client.prototype.end = function () {
    if (this.ended) return this;
    this.ended = true;
    this._send(packet(DISCONNECT, 0));
    var ws = this.ws;
    this._clearTimers();
    if (ws) {
      try {
        ws.close();
      } catch (e) {}
    } else {
      this.connected = false;
      this._emit('close');
    }
    return this;
  };

  var api = {
    connect: function (url, opts) {
      return new Client(url, opts);
    },
    // Для тестов: кодеки пакетов без сети.
    _codec: {
      encodeConnect: encodeConnect,
      encodePublish: encodePublish,
      encodeSubscribe: encodeSubscribe,
      decodePublish: decodePublish,
      takePacket: takePacket,
      encodeLength: encodeLength,
    },
  };
  root.mqtt = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
