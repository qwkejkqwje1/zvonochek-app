// Проверка сети звонков. Звонок с сайтом идёт через WebRTC окна звонка (WebView2 / WebView), а не через ядро,
// поэтому проверяем именно здесь: получает ли это окружение внешний адрес (STUN) и путь через ретранслятор (TURN).
// Серверы — те же, что у встроенного веб-клиента (ui/web/config.js). IP-адреса в результат не попадают.
import { CONFIG } from '../web/config.js';

const isTurn = (s) => [].concat(s?.urls || []).some((u) => /^turns?:/.test(u));
const protoOf = (c, url) => {
  if (c.relayProtocol) return c.relayProtocol;
  const u = String(url || '');
  return /^turns:/.test(u) ? 'tls' : /transport=tcp/.test(u) ? 'tcp' : u ? 'udp' : '';
};

// Сбор кандидатов одного RTCPeerConnection: { host, srflx, relay, relayProto[], ms, done, error }.
export function gather(cfg, ms) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const res = { host: 0, srflx: 0, prflx: 0, relay: 0, relayProto: [], ms: 0, firstMs: {}, done: false, error: null };
    let pc = null;
    let timer = 0;
    const finish = (done) => {
      if (!pc) return;
      res.done = done;
      res.ms = Math.round(performance.now() - t0);
      clearTimeout(timer);
      try {
        pc.close();
      } catch {}
      pc = null;
      resolve(res);
    };
    try {
      pc = new RTCPeerConnection(cfg);
      timer = setTimeout(() => finish(false), ms);
      pc.onicecandidate = (ev) => {
        const c = ev.candidate;
        if (!c) return finish(true);
        if (!c.candidate) return;
        const type = c.type || (/ typ (\w+)/.exec(c.candidate) || [])[1];
        if (type in res && typeof res[type] === 'number') res[type]++;
        if (type && res.firstMs[type] == null) res.firstMs[type] = Math.round(performance.now() - t0);
        if (type === 'relay') {
          const p = protoOf(c, ev.url);
          if (p && !res.relayProto.includes(p)) res.relayProto.push(p);
        }
      };
      pc.createDataChannel('zv-nettest');
      pc.createOffer()
        .then((o) => pc && pc.setLocalDescription(o))
        .catch((e) => {
          res.error = e.message || String(e);
          finish(false);
        });
    } catch (e) {
      res.error = e.message || String(e);
      clearTimeout(timer);
      try {
        pc && pc.close();
      } catch {}
      pc = null;
      resolve(res);
    }
  });
}

// Обе проверки параллельно (≈ 1–10 с). TURN — однократные аллокации без трафика (квоту почти не тратят).
export async function runNetTest() {
  if (typeof RTCPeerConnection === 'undefined') return { error: 'WebRTC недоступен', at: Date.now() };
  const turn = (CONFIG.EXTRA_ICE_SERVERS || []).filter(isTurn);
  const [stun, relay] = await Promise.all([
    gather({ iceServers: [{ urls: CONFIG.STUN }] }, 8000),
    turn.length ? gather({ iceServers: turn, iceTransportPolicy: 'relay' }, 10000) : null,
  ]);
  return { at: Date.now(), stun, relay, turnServers: turn.length };
}

// Вывод для карточки и отчёта: [{ ok, text }] + итог.
export function describeNetTest(r) {
  if (!r) return null;
  if (r.error) return { lines: [{ ok: false, text: r.error }], verdict: 'Звонки через WebRTC в этом окне невозможны.' };
  const s = r.stun || {};
  const t = r.relay;
  const sec = (ms) => (ms / 1000).toFixed(1).replace('.', ',') + ' с';
  const lines = [
    s.srflx
      ? { ok: true, text: `Внешний адрес (STUN): есть · ${sec(s.firstMs.srflx ?? s.ms)}` }
      : { ok: false, text: `Внешний адрес (STUN): нет${s.error ? ' — ' + s.error : ''}` },
    !t
      ? { ok: null, text: 'Ретранслятор (TURN): не настроен' }
      : t.relay
        ? { ok: true, text: `Ретранслятор (TURN): есть · ${t.relayProto.map((p) => p.toUpperCase()).join(', ') || '?'} · ${sec(t.firstMs.relay ?? t.ms)}` }
        : { ok: false, text: `Ретранслятор (TURN): нет${t.error ? ' — ' + t.error : ''}` },
    { ok: s.host > 0 ? null : false, text: `Локальных адресов: ${s.host}` },
  ];
  const verdict = s.srflx
    ? 'Сеть в порядке: прямые звонки возможны.'
    : t && t.relay
      ? 'Прямой путь закрыт — звонки пойдут через ретранслятор (TURN).'
      : 'Наружу не проходит ни STUN, ни TURN: звонок соединится только в одной сети, иначе — голосом через «Мост». ' +
        'Проверьте брандмауэр или антивирус (разрешите ZVONochek и Microsoft Edge WebView2), VPN и прокси.';
  return { lines, verdict };
}
