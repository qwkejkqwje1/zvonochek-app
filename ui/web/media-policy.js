// ZVONochek v37 — медиа-политика звонка: сколько видео снимать, кодировать и
// принимать на ЭТОМ устройстве, чтобы слабый телефон не грелся, а сильный
// компьютер не терял качества. Здесь только чистые функции без DOM и WebRTC —
// их проверяют тесты (tests/media-policy.test.mjs), а app.js лишь применяет
// результат к камере (applyConstraints) и к кодеру (RTCRtpSender.setParameters).
//
// Откуда берётся нагрев в видеозвонке (по убыванию веса):
//   1) кодирование своей камеры — квадратично от разрешения, линейно от к/с;
//      на бюджетных чипах VP8 часто программный — 1080p@30 их перегревает;
//   2) приём и декодирование чужого 1080p + радиомодуль на 2,5 Мбит/с;
//   3) размытие (backdrop-filter) поверх движущегося видео — GPU каждый кадр;
//   4) всё остальное (статистика, индикаторы) — мелочи.
// Поэтому: потолок захвата по классу устройства, подсказка собеседнику, какое
// видео нам нужно (и не нужно вовсе, когда экран скрыт), и ступени вниз при
// перегрузке процессора, перегреве (Compute Pressure) и низком заряде.

/** Ступени захвата камеры, от лучшей к самой лёгкой. */
export const VTIERS = [
  { id: '1440', w: 2560, h: 1440, fps: 30 },
  { id: '1080', w: 1920, h: 1080, fps: 30 },
  { id: '720', w: 1280, h: 720, fps: 30 },
  { id: '480', w: 854, h: 480, fps: 24 },
  { id: '360', w: 640, h: 360, fps: 20 },
];
const tierIdx = (id) => VTIERS.findIndex((t) => t.id === id);
const clampIdx = (i) => Math.min(VTIERS.length - 1, Math.max(0, i));

/** Ручные варианты в настройках (+ 'auto' по умолчанию). */
export const VQ_CHOICES = ['auto', '1440', '1080', '720', '480'];

/**
 * Класс устройства: 'low' | 'mid' | 'high'.
 * mem — navigator.deviceMemory (есть только в Chromium; округлён ВНИЗ до
 * степени двойки, поэтому телефон на 4 ГБ обычно сообщает 2), cores —
 * navigator.hardwareConcurrency, mobile — телефон/планшет по UA.
 * iPhone/iPad — всегда 'mid': память Safari не сообщает, а аппаратный H.264
 * там есть всегда.
 */
export function deviceClass({ ua = '', mem = 0, cores = 0, mobile = false } = {}) {
  const ios = /iPhone|iPad|iPod/i.test(ua);
  if (ios) return 'mid';
  if (mobile) return (mem && mem <= 2) || (cores && cores <= 4) ? 'low' : 'mid';
  return (mem && mem <= 2) || (cores && cores <= 2) ? 'mid' : 'high';
}

/** Стартовый потолок «Авто» по классу: ПК 1080p@30, телефон 720p@30, слабый 480p@24. */
export const autoTierId = (cls) => (cls === 'high' ? '1080' : cls === 'mid' ? '720' : '480');

/** Подпись класса для статистики и журнала. */
export const CLASS_TEXT = { high: 'компьютер', mid: 'телефон', low: 'слабое устройство' };

/**
 * Потолок захвата камеры.
 * vq   — 'auto' | '1440' | '1080' | '720' | '480' (выбор в настройках);
 * load — { eco, cpu: 0…3 ступени перегрузки, battLow, pressure: 0|1|2 }.
 * Эко-режим (ручной, как в v34) — не выше 720p и не больше 24 к/с.
 * Перегрузка процессора и перегрев снижают и ручной выбор: кодер всё равно
 * не вытянет, а камера продолжала бы снимать полный кадр и греть телефон.
 * Низкий заряд — только в «Авто» (ручной выбор владельца не трогаем).
 */
export function captureTier(vq, cls, { eco = false, cpu = 0, battLow = false, pressure = 0 } = {}) {
  const manual = tierIdx(vq) >= 0 && vq !== 'auto';
  let i = tierIdx(manual ? vq : autoTierId(cls));
  const why = [];
  if (eco) {
    i = Math.max(i + 1, tierIdx('720'));
    why.push('эко');
  }
  if (cpu > 0) {
    i += cpu;
    why.push('нагрузка ЦП');
  }
  if (pressure > 0) {
    i += pressure;
    why.push('перегрев');
  }
  if (battLow && !manual) {
    i += 1;
    why.push('низкий заряд');
  }
  const t = VTIERS[clampIdx(i)];
  return { ...t, fps: eco ? Math.min(t.fps, 24) : t.fps, manual, why };
}

/** Ограничения getUserMedia/applyConstraints для ступени захвата. */
export const tierConstraints = (t) => ({
  width: { ideal: t.w },
  height: { ideal: t.h },
  frameRate: { ideal: t.fps, max: t.fps },
});

const RX_LADDER = [1440, 1080, 720, 480, 360];
/**
 * Какое видео нам полезно ПРИНИМАТЬ: { h, fps }, h — короткая сторона кадра.
 * h = 0 — видео сейчас не нужно вовсе (вкладка скрыта, экран звонка
 * заблокирован): собеседник выключает кодер, оба телефона отдыхают.
 * Компьютер — без ограничений (1440), телефон — 1080, слабый — 720;
 * дальше — те же ступени нагрузки, что и для захвата.
 */
export function rxCap(cls, { eco = false, cpu = 0, battLow = false, pressure = 0, hidden = false } = {}) {
  if (hidden) return { h: 0, fps: 0 };
  let i = cls === 'high' ? 0 : cls === 'mid' ? 1 : 2;
  if (eco) i = Math.max(i, 2);
  i += cpu + pressure + (battLow ? 1 : 0);
  const h = RX_LADDER[Math.min(RX_LADDER.length - 1, i)];
  return { h, fps: h >= 720 ? 30 : h >= 480 ? 24 : 20 };
}

/** Санитайзер подсказки собеседника (приходит по сети — не доверяем). */
export function parseCap(m) {
  const h = Math.round(Number(m?.h));
  const fps = Math.round(Number(m?.fps));
  if (!Number.isFinite(h) || h < 0 || h > 4320) return null;
  return { h, fps: Number.isFinite(fps) && fps > 0 ? Math.min(60, fps) : h ? 30 : 0 };
}

/**
 * Сетевая лестница видео (adaptQuality в app.js шагает по ней при потерях и
 * задержке). h — потолок короткой стороны кадра; уровень 0 — «как снимаем».
 * При захвате 1080p ступени совпадают с v34–v36: 1080/720/540/360/270.
 */
export const QLEVELS = [
  { h: 4320, fps: 30, bps: Infinity },
  { h: 720, fps: 30, bps: 1200000 },
  { h: 540, fps: 24, bps: 600000 },
  { h: 360, fps: 15, bps: 250000 },
  { h: 270, fps: 10, bps: 120000 },
];

/** Разумный потолок битрейта для высоты кадра (2K — 5,5 Мбит/с, решение владельца v34). */
export const bpsForHeight = (h) =>
  h > 1080 ? 5500000 : h > 720 ? 2500000 : h > 540 ? 1500000 : h > 360 ? 900000 : h > 270 ? 400000 : 200000;

/**
 * Параметры кодера видео: min(сетевая ступень, подсказка собеседника).
 * src — фактический кадр трека {w, h}; cap — подсказка собеседника {h, fps}
 * или null (старый клиент); eco — не выше ступени 1; srcFps — к/с захвата.
 */
export function videoEncoding(level, src, cap, { eco = false, srcFps = 30 } = {}) {
  const L = QLEVELS[Math.min(QLEVELS.length - 1, Math.max(eco ? 1 : 0, level | 0))];
  const short = Math.max(1, Math.min(src?.w || 0, src?.h || 0) || 720);
  let target = Math.min(short, L.h);
  if (cap && cap.h > 0) target = Math.min(target, cap.h);
  const scale = Math.max(1, short / Math.max(90, target));
  const h = Math.round(short / scale);
  let fps = Math.min(L.fps, srcFps > 0 ? srcFps : 30);
  if (cap && cap.fps > 0) fps = Math.min(fps, cap.fps);
  return {
    active: !(cap && cap.h === 0),
    scaleResolutionDownBy: Math.round(scale * 100) / 100,
    maxFramerate: fps,
    maxBitrate: Math.min(L.bps, bpsForHeight(h)),
    h,
  };
}

// ---------- Порядок кодеков (setCodecPreferences) ----------
const mime = (c) => String(c?.mimeType || '').toLowerCase();
export const isRed = (c) => mime(c) === 'audio/red';
export const isH264 = (c) => mime(c) === 'video/h264';

/** Стабильная перестановка: сначала подходящие под pred, остальные — как были. */
export function preferCodecs(codecs, pred) {
  const a = [];
  const b = [];
  for (const c of codecs || []) (pred(c) ? a : b).push(c);
  return [...a, ...b];
}

/**
 * Аудио: RED (RFC 2198) первым — каждый пакет несёт и копию предыдущего
 * кадра Opus, поэтому одиночные потери (типичные для мобильной сети) не
 * слышны. Цена — ещё ~30–40 кбит/с. null — менять нечего (RED нет).
 */
export function audioCodecOrder(codecs, red = true) {
  if (!red || !(codecs || []).some(isRed) || !(codecs || []).some((c) => mime(c) === 'audio/opus')) return null;
  return preferCodecs(codecs, isRed);
}

/**
 * Видео: аппаратный H.264 первым (если он энергоэффективнее VP8 на этом
 * телефоне или его попросил собеседник). Внутри H.264 — сначала
 * packetization-mode=1 и Constrained Baseline (42e0..), его умеют все.
 * null — менять нечего.
 */
export function videoCodecOrder(codecs, wantH264) {
  if (!wantH264 || !(codecs || []).some(isH264)) return null;
  const rank = (c) => {
    if (!isH264(c)) return 3;
    const f = String(c.sdpFmtpLine || '');
    const pm1 = /packetization-mode=1/.test(f);
    const cb = /profile-level-id=42e0/i.test(f);
    return pm1 && cb ? 0 : pm1 ? 1 : 2;
  };
  return (codecs || [])
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => x.c);
}

/**
 * Первый (рабочий) кодек секции m=audio|video в SDP: 'red', 'opus', 'vp8', 'h264'…
 * getStats() для RED показывает вложенный Opus, поэтому факт RED берём из
 * согласованного answer.
 */
export function sdpFirstCodec(sdp, kind = 'audio') {
  const lines = String(sdp || '').split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith('m=' + kind + ' '));
  if (at < 0) return '';
  const pt = lines[at].split(' ')[3];
  for (let i = at + 1; i < lines.length && !lines[i].startsWith('m='); i++) {
    const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(lines[i]);
    if (m && m[1] === pt) return m[2].toLowerCase();
  }
  return '';
}
