// ZVONochek для ПК — мост вместо signaling.js веба (ADR-0001).
// Тот же интерфейс, что у веба: new Signaling({topic, key, selfId, inst, onMessage, onStatus, onPeerJoined}),
// start(), send(msg, opts), sendByeBeacon(), deliveryStats(), close(), onTransportUp.
// Конверт, шифрование, каналы (MQTT WSS/TCP, Worker WS/HTTP, Nostr, ntfy, P2P) и дедупликация — в ядре (Rust).
import { ntfyTopic } from './ntfy.js?v=44';

const ipc = () => window.__zvIpc;

export const ntfyTopicForSignaling = (topic) => ntfyTopic('zv1-', topic);

const NTFY_TYPES = new Set(['hello', 'hi', 'g_hi', 'full', 'desc', 'g_desc', 'cand', 'g_cand', 'ack', 'reset', 'bye']);
const NTFY_HELLO_EVERY = 30000;
export function ntfyWanted(type, state, now = Date.now()) {
  if (!NTFY_TYPES.has(type)) return false;
  if (type !== 'hello') return true;
  if (now - (state.helloAt || 0) < NTFY_HELLO_EVERY) return false;
  state.helloAt = now;
  return true;
}

// Секрет комнаты: из адреса (#k=) и все сырые ключи HKDF, импортированные страницей (их ловит preload).
function secretCandidates() {
  const out = [];
  try {
    const k = new URLSearchParams(location.hash.slice(1)).get('k');
    if (k) out.push(k);
  } catch {}
  for (const s of window.__zvHkdfSecrets || []) if (!out.includes(s)) out.push(s);
  return out;
}

export class Signaling {
  constructor({ topic, key, selfId, inst, onMessage, onStatus, onPeerJoined }) {
    Object.assign(this, { topic, key, selfId, inst, onMessage, onStatus, onPeerJoined });
    this.roomId = topic;
    this.closed = false;
    this.onTransportUp = () => {};
    this._stats = { first: {}, dup: {} };
    this._off = null;
    this._ready = null;
    this._statsTimer = null;
  }

  start() {
    const bus = ipc();
    if (!bus) {
      console.error('[zv] нет моста к ядру');
      return;
    }
    this._off = bus.on('room:', (ev, p) => {
      if (this.closed || !p || p.roomId !== this.roomId) return;
      switch (ev) {
        case 'room:msg':
          try {
            this.onMessage?.(p.msg);
          } catch (e) {
            console.error('[zv] onMessage', e);
          }
          break;
        case 'room:status':
          this.onStatus?.(p.status);
          break;
        case 'room:up':
          this.onTransportUp?.();
          break;
        case 'room:peer_joined':
          this.onPeerJoined?.();
          break;
      }
    });
    this._ready = bus
      .call('room_join', { secrets: secretCandidates(), topic: this.topic, selfId: this.selfId, inst: this.inst })
      .then((r) => {
        if (r && r.roomId) this.roomId = r.roomId;
        if (this.closed) bus.call('room_leave', { roomId: this.roomId }).catch(() => {});
        return true;
      })
      .catch((e) => {
        console.error('[zv] room_join', e);
        return false;
      });
    this._statsTimer = setInterval(() => this._pullStats(), 5000);
  }

  async _pullStats() {
    if (this.closed) return;
    try {
      const s = await ipc().call('room_stats', { roomId: this.roomId });
      if (s && s.first) this._stats = s;
    } catch {}
  }

  async send(msg, opts = {}) {
    if (this.closed) return;
    if (this._ready && !(await this._ready)) return;
    const voice = !!(opts.voice || msg.type === 'voice');
    try {
      await ipc().call('room_send', { roomId: this.roomId, msg, voice });
    } catch (e) {
      if (!this.closed) console.warn('[zv] send', e);
    }
  }

  async sendByeBeacon() {
    if (this.closed) return;
    try {
      await ipc().call('room_bye', { roomId: this.roomId });
    } catch {}
  }

  deliveryStats() {
    return { first: { ...this._stats.first }, dup: { ...this._stats.dup } };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._statsTimer);
    try {
      this._off?.();
    } catch {}
    const leave = () => ipc()?.call('room_leave', { roomId: this.roomId }).catch(() => {});
    if (this._ready) this._ready.then(leave);
    else leave();
  }
}
