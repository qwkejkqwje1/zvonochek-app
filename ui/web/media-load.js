// media-load.js — Нагрузка устройства → ступени видео, порядок кодеков, код сверки
// v44: вынесено из app.js без изменения логики (строки 3402–3584 v43).
import { audioCodecOrder, captureTier, rxCap, tierConstraints, videoCodecOrder } from './media-policy.js?v=44';
import { safetyCode, safetyCodeBridge } from './crypto.js?v=44';
import { $, S, loadOpts, localTrack, log, openModal, selfId, sendCtrl, toast } from './app.js?v=44';
import { applyQuality } from './call-stats-ui.js?v=44';

// ---------- v37: нагрузка устройства → ступени видео (против нагрева) ----------
// Chrome сообщает qualityLimitationReason='cpu', когда кодер не успевает.
// 3 тика подряд (≈6 с) — снижаем захват камеры на ступень (до трёх);
// 90 с спокойствия — возвращаем одну. Если после возврата перегрузка
// вернулась в течение 2 минут — ступень фиксируется до конца звонка:
// телефон уже прогрет, качели «вверх-вниз» только мешают смотреть.
export function adaptLoad(smp) {
  const L = S.load;
  if (!smp?.videoOut || S.screenTrack) {
    L.cpuHits = 0;
    return;
  }
  if (smp.limitation === 'cpu') {
    L.cpuHits++;
    L.cpuCalm = 0;
  } else {
    L.cpuHits = 0;
    L.cpuCalm++;
  }
  if (L.cpuHits >= 3 && L.cpu < 3) {
    L.cpuHits = 0;
    if (L.cpuBackAt && Date.now() - L.cpuBackAt < 120000) L.cpuLock = true;
    L.cpu++;
    log(`Процессор не успевает кодировать видео — снижаем захват (ступень ${L.cpu})`);
    if (!L.cpuToast) {
      L.cpuToast = true;
      toast('Устройство перегружено — видео облегчено, чтобы не грелось', 5000);
    }
    reapplyMediaLoad();
  } else if (L.cpu > 0 && !L.cpuLock && L.cpuCalm >= 45) {
    L.cpuCalm = 0;
    L.cpu--;
    L.cpuBackAt = Date.now();
    log(`Нагрузка спала — возвращаем ступень видео (${L.cpu})`);
    reapplyMediaLoad();
  }
}

// Пересчитать ступень захвата и подсказку собеседнику после любой смены
// нагрузки (ЦП, перегрев, заряд, эко, ручной выбор качества).
export async function reapplyMediaLoad() {
  const prev = S.capTier;
  const t = (S.capTier = captureTier(S.vq, S.devClass, loadOpts()));
  const v = localTrack('video');
  if (v && !S.screenTrack && (!prev || prev.id !== t.id || prev.fps !== t.fps)) {
    try {
      await v.applyConstraints(tierConstraints(t));
      log(`Камера: ${t.h}p @ ${t.fps} к/с${t.why.length ? ' (' + t.why.join(', ') + ')' : ''}`);
    } catch {}
  }
  sendRxCap();
  applyQuality();
}

// Подсказка собеседнику, какое видео нам нужно (DataChannel 'ctrl', тип
// 'vcap'). Старые клиенты её просто игнорируют. h=0 — экран скрыт или звонок
// заблокирован: собеседник выключает кодер (обе стороны не греются).
export const viewHidden = () => document.visibilityState === 'hidden' || !!S.callLocked;
export const myRxCap = () => rxCap(S.devClass, { ...loadOpts(), hidden: viewHidden() });
export function sendRxCap(force = false) {
  if (S.ctrl?.readyState !== 'open') return; // уйдёт при открытии канала
  const c = myRxCap();
  const j = JSON.stringify(c);
  if (!force && j === S.rxSent) return;
  S.rxSent = j;
  sendCtrl({ t: 'vcap', ...c });
}
// Скрытие — с задержкой 1,5 с (быстрое переключение приложений не дёргает
// кодер собеседника), возврат — сразу.
export function onViewChange() {
  clearTimeout(S.viewTimer);
  if (viewHidden()) S.viewTimer = setTimeout(() => sendRxCap(), 1500);
  else sendRxCap();
}

// Заряд и Compute Pressure — только как сигналы «облегчить». Оба API
// необязательны: где их нет (Safari, Firefox), работает только ЦП-адаптация.
export function watchDeviceLoad() {
  if (S.loadWatch) return;
  S.loadWatch = true;
  navigator
    .getBattery?.()
    .then((b) => {
      const upd = () => {
        const low = !b.charging && b.level <= 0.15;
        if (low === S.load.battLow) return;
        S.load.battLow = low;
        if (S.joined) {
          log(low ? 'Заряд ниже 15% — облегчаем видео (режим «Авто»)' : 'Заряд в норме — видео без ограничения по батарее');
          reapplyMediaLoad();
        }
      };
      b.addEventListener?.('levelchange', upd);
      b.addEventListener?.('chargingchange', upd);
      upd();
    })
    .catch(() => {});
  if (typeof PressureObserver === 'function') {
    try {
      const po = new PressureObserver((recs) => {
        const st = recs[recs.length - 1]?.state;
        const p = st === 'critical' ? 2 : st === 'serious' ? 1 : 0;
        if (p === S.load.pressure) return;
        S.load.pressure = p;
        if (S.joined) {
          log(`Нагрузка процессора (Compute Pressure): ${st}`);
          reapplyMediaLoad();
        }
      });
      po.observe('cpu', { sampleInterval: 4000 })?.catch?.(() => {});
    } catch {}
  }
}

// ---------- v37: порядок кодеков (RED для голоса, аппаратный H.264) ----------
// Применяется перед каждым offer/answer. RED — защита голоса от потерь
// (настройка «Защита голоса от потерь», по умолчанию ВКЛ). H.264 первым —
// только если на телефоне он аппаратный, а VP8 нет (или так попросил
// собеседник): обе стороны выбирают одинаково, и кодек сходится.
export function applyCodecPrefs(pc) {
  if (typeof RTCRtpTransceiver === 'undefined' || !RTCRtpTransceiver.prototype.setCodecPreferences) return;
  const wantH264 = S.hwPref === 'h264' || S.peer?.vc === 'h264';
  for (const tr of pc.getTransceivers()) {
    if (tr.stopped) continue;
    const kind = tr.receiver?.track?.kind;
    const caps = kind && RTCRtpReceiver.getCapabilities?.(kind)?.codecs;
    if (!caps) continue;
    const order = kind === 'audio' ? audioCodecOrder(caps, S.red) : videoCodecOrder(caps, wantH264);
    try {
      if (order) {
        tr.setCodecPreferences(order);
        tr._zvPref = true;
      } else if (tr._zvPref) {
        tr.setCodecPreferences([]); // вернуть порядок браузера
        tr._zvPref = false;
      }
    } catch {}
  }
}

// Аппаратный ли H.264/VP8 на этом телефоне (MediaCapabilities, тип webrtc).
// Отключить: localStorage.zvHwPref = '0'.
export async function detectHwVideo() {
  try {
    if (localStorage.zvHwPref === '0' || !S.isMobile || !navigator.mediaCapabilities?.encodingInfo) return;
    const q = (contentType) =>
      navigator.mediaCapabilities
        .encodingInfo({ type: 'webrtc', video: { contentType, width: 1280, height: 720, bitrate: 1500000, framerate: 30 } })
        .catch(() => null);
    const [vp8, h264] = await Promise.all([q('video/VP8'), q('video/H264')]);
    if (h264?.supported && h264.powerEfficient && !(vp8?.supported && vp8.powerEfficient)) S.hwPref = 'h264';
  } catch {}
}

export async function showSafety() {
  const pc = S.pc;
  const a = pc?.currentLocalDescription?.sdp,
    b = pc?.currentRemoteDescription?.sdp;
  if (!a || !b) return;
  S.safety = await safetyCode(a, b);
  const el = $('#safety');
  const pill = $('#safetyPill');
  if (pill) pill.textContent = S.safety.emoji;
  el.classList.remove('hidden');
}

export async function showBridgeSafety() {
  if (!S.room || !S.peer) return;
  S.safety = await safetyCodeBridge(S.room.topic, selfId, S.peer.id);
  const el = $('#safety');
  const pill = $('#safetyPill');
  if (pill) pill.textContent = S.safety.emoji;
  el.classList.remove('hidden');
}

// Код, который в app.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initMediaLoad() {
  detectHwVideo();
  $('#safety').onclick = () => {
    if (!S.safety) return;
    const b = openModal('#tplSafety');
    $('#safetyEmoji', b).textContent = S.safety.emoji;
    $('#safetyDigits', b).textContent = S.safety.digits;
  };
}
