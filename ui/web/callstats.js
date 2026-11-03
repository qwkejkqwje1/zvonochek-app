// ZVONochek v37 — статистика звонка без DOM: разбор getStats(), оценка MOS,
// запись хода звонка и сводка журнала. Модуль чистый — тестируется в Node.

/** Человеческие названия маршрутов медиа. */
export const ROUTE_LABELS = {
  p2p: 'Напрямую (P2P)',
  lan: 'Локальная сеть',
  turn: 'Через TURN',
  bridge: 'Мост через сигнал',
};

/** Короткие подписи маршрута — для плашки качества и строк журнала. */
export const ROUTE_SHORT = { p2p: 'P2P', lan: 'LAN', turn: 'TURN', bridge: 'Мост' };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

function pickSelectedPair(byId) {
  for (const s of byId.values()) {
    if (s.type === 'transport' && s.selectedCandidatePairId) {
      const pair = byId.get(s.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  // Firefox: transport-записи без selectedCandidatePairId, но пара помечена.
  for (const s of byId.values()) {
    if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) return s;
  }
  return null;
}

function routeOf(local, remote) {
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'turn';
  if (local?.candidateType === 'host' && remote?.candidateType === 'host') return 'lan';
  return 'p2p';
}

/**
 * Снимок накопительных счётчиков из RTCStatsReport (или любого Map-подобного
 * объекта с forEach). Ничего не вычисляет по времени — см. deriveSample().
 */
export function readCounters(report, now = Date.now()) {
  const byId = new Map();
  report.forEach((s) => byId.set(s.id, s));
  const pair = pickSelectedPair(byId);
  const local = pair ? byId.get(pair.localCandidateId) : null;
  const remote = pair ? byId.get(pair.remoteCandidateId) : null;
  const c = {
    ts: now,
    connected: !!pair,
    route: pair ? routeOf(local, remote) : null,
    proto: local
      ? (local.protocol || '').toUpperCase() + (local.relayProtocol ? '/' + local.relayProtocol.toUpperCase() : '')
      : '',
    rtt: pair ? num(pair.currentRoundTripTime) : null,
    availOut: pair ? num(pair.availableOutgoingBitrate) : null,
    bytesIn: 0,
    bytesOut: 0,
    audioBytesIn: 0,
    packetsIn: 0,
    lostIn: 0,
    jitter: null,
    remoteLoss: { audio: null, video: null },
    remoteRtt: null,
    codec: '',
    videoIn: null,
    videoOut: null,
    limitation: '',
    // v37: каким кодеком и чем (железо/программа) кодируется и декодируется видео
    vcodecOut: null,
    vcodecIn: null,
  };
  const vcodec = (s, impl, pe) => {
    const codec = s.codecId ? byId.get(s.codecId) : null;
    const name = codec?.mimeType ? codec.mimeType.split('/')[1] || codec.mimeType : '';
    if (!name && !s[impl]) return null;
    return { name: name.toUpperCase(), impl: s[impl] || '', hw: typeof s[pe] === 'boolean' ? s[pe] : null };
  };
  for (const s of byId.values()) {
    const kind = s.kind || s.mediaType;
    if (s.type === 'inbound-rtp') {
      c.bytesIn += s.bytesReceived || 0;
      c.packetsIn += s.packetsReceived || 0;
      c.lostIn += Math.max(0, s.packetsLost || 0);
      if (kind === 'audio') {
        c.audioBytesIn += s.bytesReceived || 0;
        if (num(s.jitter) !== null) c.jitter = s.jitter;
        const codec = s.codecId ? byId.get(s.codecId) : null;
        if (codec?.mimeType) c.codec = codec.mimeType.split('/')[1] || codec.mimeType;
      } else if (kind === 'video' && s.frameWidth) {
        c.videoIn = { w: s.frameWidth, h: s.frameHeight || 0, fps: Math.round(s.framesPerSecond || 0) };
        c.vcodecIn = vcodec(s, 'decoderImplementation', 'powerEfficientDecoder');
      }
    } else if (s.type === 'outbound-rtp') {
      c.bytesOut += s.bytesSent || 0;
      if (kind === 'video' && s.frameWidth) {
        c.videoOut = { w: s.frameWidth, h: s.frameHeight || 0, fps: Math.round(s.framesPerSecond || 0) };
        c.vcodecOut = vcodec(s, 'encoderImplementation', 'powerEfficientEncoder');
        if (s.qualityLimitationReason && s.qualityLimitationReason !== 'none') c.limitation = s.qualityLimitationReason;
      }
    } else if (s.type === 'remote-inbound-rtp') {
      if (num(s.fractionLost) !== null && (kind === 'audio' || kind === 'video')) {
        c.remoteLoss[kind] = Math.max(c.remoteLoss[kind] ?? 0, s.fractionLost * 100);
      }
      if (num(s.roundTripTime) !== null) c.remoteRtt = s.roundTripTime;
    }
  }
  return c;
}

/**
 * Упрощённая E-модель (ITU-T G.107) → MOS 1…4.5.
 * rtt и jitter в мс, loss в процентах. Для Opus с FEC это консервативная оценка.
 */
export function mosOf(rttMs, jitterMs, lossPct) {
  const latency = Math.max(0, rttMs || 0) / 2 + 2 * Math.max(0, jitterMs || 0) + 10;
  let r = 93.2 - (latency < 160 ? latency / 40 : (latency - 120) / 10);
  r -= 2.5 * Math.max(0, lossPct || 0);
  r = clamp(r, 0, 100);
  const mos = 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r);
  return round1(clamp(mos, 1, 4.5));
}

/** Уровень качества для индикатора: good | mid | bad (пороги как до v36). */
export function levelOf({ rtt, loss }) {
  const r = rtt ?? 0;
  const l = loss ?? 0;
  if (r < 200 && l < 2) return 'good';
  if (r < 450 && l < 7) return 'mid';
  return 'bad';
}

/** Словесная оценка MOS. */
export function mosLabel(mos) {
  if (mos == null) return { level: 'mid', text: 'нет данных' };
  if (mos >= 4.0) return { level: 'good', text: 'отлично' };
  if (mos >= 3.6) return { level: 'good', text: 'хорошо' };
  if (mos >= 3.1) return { level: 'mid', text: 'терпимо' };
  return { level: 'bad', text: 'плохо' };
}

/**
 * Точка графика из двух снимков счётчиков (текущий и предыдущий).
 * Все величины — за интервал между снимками, кроме rtt/jitter (мгновенные).
 */
export function deriveSample(cur, prev) {
  const dt = prev && cur.ts > prev.ts ? (cur.ts - prev.ts) / 1000 : 0;
  let loss = null;
  let kbpsIn = null;
  let kbpsOut = null;
  if (dt > 0) {
    const lost = Math.max(0, cur.lostIn - prev.lostIn);
    const got = Math.max(0, cur.packetsIn - prev.packetsIn);
    loss = lost + got > 0 ? (100 * lost) / (lost + got) : 0;
    kbpsIn = Math.max(0, cur.bytesIn - prev.bytesIn) * 8 / 1000 / dt;
    kbpsOut = Math.max(0, cur.bytesOut - prev.bytesOut) * 8 / 1000 / dt;
  }
  const rttS = cur.rtt ?? cur.remoteRtt;
  const rtt = rttS == null ? null : Math.round(rttS * 1000);
  const jitter = cur.jitter == null ? null : round1(cur.jitter * 1000);
  const sample = {
    t: cur.ts,
    route: cur.route,
    proto: cur.proto,
    codec: cur.codec,
    rtt,
    jitter,
    loss: loss == null ? null : round1(loss),
    outLoss: Math.max(cur.remoteLoss.audio ?? 0, cur.remoteLoss.video ?? 0),
    videoOutLoss: cur.remoteLoss.video ?? 0,
    kbpsIn: kbpsIn == null ? null : Math.round(kbpsIn),
    kbpsOut: kbpsOut == null ? null : Math.round(kbpsOut),
    videoIn: cur.videoIn,
    videoOut: cur.videoOut,
    limitation: cur.limitation,
    vcodecOut: cur.vcodecOut || null,
    vcodecIn: cur.vcodecIn || null,
  };
  sample.mos = rtt == null ? null : mosOf(rtt, jitter ?? 0, sample.loss ?? 0);
  sample.level = levelOf(sample);
  return sample;
}

/** Точка графика для моста через сигнал: WebRTC-метрик нет, только маршрут. */
export const bridgeSample = (t = Date.now()) => ({ t, route: 'bridge', rtt: null, jitter: null, loss: null, mos: null });

function avgOf(acc) {
  return acc.n ? acc.sum / acc.n : null;
}

/**
 * Запись хода звонка: кольцевой буфер последних точек (для графиков)
 * и накопительные агрегаты за весь звонок (для журнала).
 */
export class CallRecorder {
  constructor({ capacity = 150, startedAt = Date.now() } = {}) {
    this.capacity = capacity;
    this.startedAt = startedAt;
    this.buf = [];
    this.last = null;
    this.routeSec = {};
    this.agg = {
      rtt: { sum: 0, n: 0, max: 0 },
      jitter: { sum: 0, n: 0, max: 0 },
      loss: { sum: 0, n: 0, max: 0 },
      mos: { sum: 0, n: 0, min: 5 },
      kbpsIn: { sum: 0, n: 0, max: 0 },
      kbpsOut: { sum: 0, n: 0, max: 0 },
    };
    this.routeChanges = 0;
  }

  push(sample) {
    if (!sample) return;
    if (this.last) {
      const dt = clamp((sample.t - this.last.t) / 1000, 0, 10);
      const r = this.last.route || 'p2p';
      this.routeSec[r] = (this.routeSec[r] || 0) + dt;
      if (sample.route && this.last.route && sample.route !== this.last.route) this.routeChanges++;
    }
    for (const key of Object.keys(this.agg)) {
      const v = sample[key];
      if (v == null) continue;
      const a = this.agg[key];
      a.sum += v;
      a.n++;
      if ('max' in a) a.max = Math.max(a.max, v);
      if ('min' in a) a.min = Math.min(a.min, v);
    }
    this.buf.push(sample);
    if (this.buf.length > this.capacity) this.buf.shift();
    this.last = sample;
  }

  /** Значения одной метрики по порядку (null — пропуск на графике). */
  series(key) {
    return this.buf.map((s) => (s[key] == null ? null : s[key]));
  }

  /** Маршрут, на котором прошла бо́льшая часть звонка. */
  dominantRoute() {
    let best = this.last?.route || null;
    let bestSec = -1;
    for (const [r, sec] of Object.entries(this.routeSec)) {
      if (sec > bestSec) {
        best = r;
        bestSec = sec;
      }
    }
    return best;
  }

  /** Компактная сводка для журнала звонков (без сырых точек). */
  summary(endedAt = Date.now()) {
    const a = this.agg;
    const pick = (acc, digits = 0) => {
      const v = avgOf(acc);
      return v == null ? null : digits ? round1(v) : Math.round(v);
    };
    return {
      dur: Math.max(0, Math.round((endedAt - this.startedAt) / 1000)),
      route: this.dominantRoute(),
      routeChanges: this.routeChanges,
      rtt: pick(a.rtt),
      rttMax: a.rtt.n ? Math.round(a.rtt.max) : null,
      jitter: pick(a.jitter, 1),
      loss: pick(a.loss, 1),
      lossMax: a.loss.n ? round1(a.loss.max) : null,
      mos: pick(a.mos, 1),
      mosMin: a.mos.n ? round1(a.mos.min) : null,
      kbpsIn: pick(a.kbpsIn),
      kbpsOut: pick(a.kbpsOut),
      samples: a.rtt.n,
    };
  }
}

/**
 * SVG-путь линии графика в прямоугольнике w×h. null разрывает линию.
 * Возвращает { line, area } — area замкнута по нижнему краю (для заливки).
 */
export function sparkPath(values, w = 120, h = 32, { min = 0, max = null, pad = 2 } = {}) {
  const pts = values.filter((v) => v != null);
  if (!pts.length) return { line: '', area: '' };
  const hi = max ?? Math.max(...pts, min + 1e-9);
  const lo = min;
  const span = hi - lo || 1;
  const step = values.length > 1 ? (w - 2 * pad) / (values.length - 1) : 0;
  const y = (v) => (h - pad - ((clamp(v, lo, hi) - lo) / span) * (h - 2 * pad)).toFixed(1);
  let line = '';
  let area = '';
  let seg = [];
  const flush = () => {
    if (!seg.length) return;
    const d = seg.map(([x, yy], i) => `${i ? 'L' : 'M'}${x},${yy}`).join('');
    line += d;
    area += `${d}L${seg[seg.length - 1][0]},${h}L${seg[0][0]},${h}Z`;
    seg = [];
  };
  values.forEach((v, i) => {
    if (v == null) flush();
    else seg.push([(pad + i * step).toFixed(1), y(v)]);
  });
  flush();
  return { line, area };
}

/** 1:05 · 12:30 · 1:02:03 */
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Длительность словами для сводок: «2 ч 05 мин», «14 мин», «40 с». */
export function fmtDurWords(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s} с`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${m} мин`;
}

/** Русское множественное число: plural(5, 'разговор', 'разговора', 'разговоров') → «разговоров». */
export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  return m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** Компактно для плиток KPI: 45 с · 12 мин · 2,1 ч · 14 ч */
export function fmtDurShort(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  const hrs = s / 3600;
  return hrs < 10 ? `${hrs.toFixed(1).replace('.', ',')} ч` : `${Math.round(hrs)} ч`;
}

/** 850 Кбит/с · 1,2 Мбит/с */
export function fmtKbps(kbps) {
  if (kbps == null) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1).replace('.', ',')} Мбит/с` : `${Math.round(kbps)} Кбит/с`;
}

const DAY = 86400000;
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Исход звонка считается состоявшимся, если был разговор. */
export const isTalk = (e) => e && (e.outcome === 'completed' || e.outcome === 'accepted' || e.dur > 0);

/**
 * Сводка журнала звонков за последние `days` дней: KPI для вкладки «Звонки».
 * entries — массив значений из хранилища 'calls'.
 */
export function journalDigest(entries, now = Date.now(), days = 30, chartDays = 14) {
  const since = now - days * DAY;
  const recent = entries.filter((e) => e && e.ts >= since && e.ts <= now + 60000);
  let talk = 0;
  let talkSec = 0;
  let missed = 0;
  let mosW = 0;
  let mosSec = 0;
  let rttSum = 0;
  let rttN = 0;
  const routes = { p2p: 0, lan: 0, turn: 0, bridge: 0 };
  for (const e of recent) {
    if (isTalk(e)) {
      talk++;
      talkSec += e.dur || 0;
      if (e.route && e.route in routes) routes[e.route]++;
      if (e.mos != null) {
        const w = Math.max(1, e.dur || 1);
        mosW += e.mos * w;
        mosSec += w;
      }
      if (e.rtt != null) {
        rttSum += e.rtt;
        rttN++;
      }
    } else if (e.outcome === 'missed' || e.outcome === 'expired' || e.outcome === 'declined') {
      missed++;
    }
  }
  const perDay = [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (let i = chartDays - 1; i >= 0; i--) {
    const ts = start.getTime() - i * DAY;
    perDay.push({ day: dayKey(ts), n: 0, sec: 0 });
  }
  const idx = new Map(perDay.map((d, i) => [d.day, i]));
  for (const e of recent) {
    const i = idx.get(dayKey(e.ts));
    if (i === undefined || !isTalk(e)) continue;
    perDay[i].n++;
    perDay[i].sec += e.dur || 0;
  }
  return {
    total: recent.length,
    talk,
    missed,
    talkSec,
    avgMos: mosSec ? round1(mosW / mosSec) : null,
    avgRtt: rttN ? Math.round(rttSum / rttN) : null,
    routes,
    perDay,
  };
}
