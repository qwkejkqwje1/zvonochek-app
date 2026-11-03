// ZVONochek — общие правила публичного ntfy.sh: «слепой» pub/sub без
// регистрации для сигналинга звонков (signaling.js) и резервного канала
// чата (chat-transport.js). Наружу уходит только шифротекст, а имя топика —
// усечённый SHA-256 внутреннего идентификатора.
import { sha256hex } from './crypto.js?v=41';

// Лимиты сервера ntfy (server.go). Имя топика — /^[-_A-Za-z0-9]{1,64}$/:
// на более длинное сервер отвечает 404 (так молчал ntfy-канал v35). Тело
// длиннее 4096 байт сервер превращает во вложение, и подписчик получает
// уже не наш пакет, — такие пакеты несут остальные каналы.
export const NTFY_TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
export const NTFY_MAX_BODY = 4096;

// prefix + 48 hex (192 бита хэша): коллизий нет, имя укладывается в лимит.
export async function ntfyTopic(prefix, id) {
  return prefix + (await sha256hex(String(id))).slice(0, 48);
}

export const fitsNtfy = (body) => new TextEncoder().encode(String(body)).length <= NTFY_MAX_BODY;

// URL подписки: WebSocket + since (unix-время, окно 30 с). Публичный сервер
// хранит сообщения 12 часов — без since каждое (пере)подключение получало
// бы весь кэш топика. Значение пересчитывается на каждое подключение;
// давность внутри окна добивает дедуп получателя (mid / хэш blob).
export function ntfySubscribeUrl(base, topic, nowSec = Math.floor(Date.now() / 1000)) {
  const b = String(base || '').replace(/\/$/, '').replace(/^http/, 'ws');
  return b + '/' + topic + '/ws?since=' + Math.max(0, Math.floor(nowSec) - 30);
}

// Кадр подписки — JSON {id, time, event, topic, message}. Нужны только
// кадры event === 'message' со строкой message; служебные open/keepalive —
// null.
export function parseNtfyFrame(data) {
  try {
    const j = typeof data === 'string' ? JSON.parse(data) : data;
    if (!j || typeof j !== 'object' || j.event !== 'message' || typeof j.message !== 'string') return null;
    return { id: j.id || '', time: j.time || 0, message: j.message };
  } catch {
    return null;
  }
}
