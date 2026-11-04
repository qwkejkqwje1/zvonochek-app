// call-stats-ui.js — Статистика звонка и панель «Качество связи»
// v44: вынесено из app.js без изменения логики (строки 3225–3402 v43).
import { CLASS_TEXT, QLEVELS, sdpFirstCodec, videoEncoding } from './media-policy.js?v=44';
import { CallRecorder, ROUTE_SHORT, bridgeSample, deriveSample, readCounters } from './callstats.js?v=44';
import { adaptLoad, viewHidden } from './media-load.js?v=44';
import { renderLiveStats } from './stats-ui.js?v=44';
import { $, S, countRoute, localTrack, log, progress, setUse, toast, updateStatus } from './app.js?v=44';
import { recoverRemoteAudio } from './audio-engine.js?v=44';

// ---------- Статистика звонка (v36: callstats.js + панель «Качество связи») ----------
export const ROUTE_TEXT = { p2p: 'напрямую P2P', lan: 'напрямую (LAN)', turn: 'через TURN' };

export function startStats(now) {
  if (S.statsTimer) return;
  S.statsTimer = setInterval(statsTick, 2000);
  if (now) setTimeout(statsTick, 300);
}

export async function statsTick() {
  if (!S.callStart) return;
  const rec = S.callRec || (S.callRec = new CallRecorder({ startedAt: S.callStart }));
  const report = S.pc ? await S.pc.getStats().catch(() => null) : null;
  const cur = report ? readCounters(report) : null;
  if (!cur?.connected) {
    // Мост через сигнал: метрик WebRTC нет, но время и маршрут пишем.
    if (S.bridgeActive) {
      S.lastSample = bridgeSample();
      rec.push(S.lastSample);
      renderStatsPanel();
    }
    return;
  }
  const smp = deriveSample(cur, S.prevCounters);
  S.prevCounters = cur;
  if (S.audioRed && smp.codec) smp.codec = 'red'; // getStats показывает вложенный Opus
  const method = `${ROUTE_TEXT[smp.route]}, ${smp.proto}`;
  if (method !== S.method) {
    S.method = method;
    log('Маршрут медиа: ' + method);
    if (!S.pcRouteCounted) {
      S.pcRouteCounted = true;
      countRoute(smp.route === 'turn' ? 'relay' : 'direct');
    }
  }
  progress(100, 'Соединено: ' + ROUTE_TEXT[smp.route]);
  // «Тихая смерть» звука в долгих звонках: соединение живо, а входящие
  // аудиобайты встали (уснул AudioContext / отвалился remote-трек).
  // DTX выключен, поэтому даже в тишине пакеты идут — полная остановка
  // на ~10 секунд это аномалия, пробуем оживить тракт сами.
  const audioBytes = cur.audioBytesIn;
  if (Date.now() - S.callStart > 45000 && audioBytes > 0) {
    if (S.lastAudioBytes >= 0 && audioBytes === S.lastAudioBytes) S.audioStallN++;
    else S.audioStallN = 0;
    S.lastAudioBytes = audioBytes;
    if (S.audioStallN >= 5) {
      S.audioStallN = 0;
      recoverRemoteAudio('нет входящих аудиобайт ~10 с при живом звонке');
    }
  }
  adaptQuality(smp.videoOutLoss, smp.rtt ?? 0);
  adaptLoad(smp);
  rec.push(smp);
  S.lastSample = smp;
  const q = $('#quality');
  q.classList.remove('good', 'mid', 'bad');
  q.classList.add(smp.level, 'mono-pill');
  if ($('#qualityText')) {
    const loss = smp.loss >= 1 ? ` · ${smp.loss.toFixed(1)}%` : '';
    $('#qualityText').textContent = `${ROUTE_SHORT[smp.route]} · ${smp.rtt ?? '—'} мс${loss}`;
  }
  setUse('#quality use', smp.level === 'bad' ? 'i-warning' : 'i-wifi');
  q.classList.remove('hidden');
  renderStatsPanel();
  updateStatus();
}

export function renderStatsPanel() {
  const panel = $('#callStats');
  if (!panel || panel.classList.contains('hidden')) return;
  renderLiveStats($('#callStatsBody'), {
    rec: S.callRec,
    sample: S.lastSample,
    callSec: S.callStart ? (Date.now() - S.callStart) / 1000 : 0,
    delivery: S.sig?.deliveryStats?.() || null,
    bridgeMode: S.bridgeActive ? S.bridgeMode : '',
    media: mediaModeText(),
  });
}

// v37: строка «Режим видео» в панели качества — почему видео такое, какое есть.
export function mediaModeText() {
  const t = S.capTier;
  if (!t) return '';
  const parts = [`${S.vq === 'auto' ? 'Авто' : 'Вручную'} · ${CLASS_TEXT[S.devClass] || ''}`];
  if (localTrack('video') && !S.screenTrack) parts.push(`камера ${t.h}p @ ${t.fps}${t.why.length ? ' (' + t.why.join(', ') + ')' : ''}`);
  if (S.peerCap) parts.push(S.peerCap.h === 0 ? 'собеседник свернул — видео ему на паузе' : `собеседнику ≤${S.peerCap.h}p`);
  if (viewHidden()) parts.push('у вас экран скрыт — входящее видео на паузе');
  return parts.join(' · ');
}

export function toggleStatsPanel() {
  const panel = $('#callStats');
  if (!panel) return;
  panel.classList.toggle('hidden');
  $('#quickAudioPop')?.classList.add('hidden');
  renderStatsPanel();
}

// Сетевая лестница QLEVELS — в media-policy.js (по высоте кадра, а не по
// множителю: одинаково работает для захвата 1080p, 720p и 480p).
export async function applyQuality() {
  if (!S.pc) return;
  const audioBps = (S.audio.bitrate || 48) * 1000;
  for (const snd of S.pc.getSenders()) {
    if (!snd.track) continue;
    const p = snd.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (snd.track.kind === 'audio') {
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      // Не упираем звук в потолок, пока ручная настройка Opus выключена.
      if (S.audio.opusTune) p.encodings[0].maxBitrate = audioBps;
      else delete p.encodings[0].maxBitrate;
    } else {
      // v37: min(сетевая ступень, подсказка собеседника, эко). Собеседник со
      // скрытым экраном просит h=0 — выключаем кодер совсем (active=false):
      // не тратим ни процессор, ни его батарею, ни трафик.
      const st = snd.track.getSettings?.() || {};
      const e = videoEncoding(S.qLevel || 0, { w: st.width, h: st.height }, S.peerCap, {
        eco: !!S.ecoMode,
        srcFps: st.frameRate || S.capTier?.fps || 30,
      });
      p.encodings[0].active = e.active;
      p.encodings[0].maxBitrate = e.maxBitrate;
      p.encodings[0].scaleResolutionDownBy = e.scaleResolutionDownBy;
      p.encodings[0].maxFramerate = e.maxFramerate;
      S.encInfo = e;
    }
    try {
      await snd.setParameters(p);
    } catch {}
  }
}
export function adaptQuality(outLoss, rtt) {
  S.qLevel = S.qLevel ?? 0;
  S.qBad = S.qBad ?? 0;
  S.qGood = S.qGood ?? 0;
  if (outLoss > 6 || rtt > 700) {
    S.qBad++;
    S.qGood = 0;
  } else if (outLoss < 2 && rtt < 350) {
    S.qGood++;
    S.qBad = 0;
  }
  if (S.qBad >= 2 && S.qLevel < QLEVELS.length - 1) {
    S.qLevel++;
    S.qBad = 0;
    log(`Адаптация под сеть: снижаем видео (уровень ${S.qLevel})`);
    applyQuality();
  }
  if (S.qGood >= 8 && S.qLevel > 0) {
    S.qLevel--;
    S.qGood = 0;
    log(`Сеть стабильна: повышаем видео (уровень ${S.qLevel})`);
    applyQuality();
  }
  if (S.qLevel === QLEVELS.length - 1 && S.qBad >= 3 && !S.qHinted) {
    S.qHinted = true;
    toast('Слабая сеть — выключите камеру для идеального звука', 6500);
  }
}

// v37: какие кодеки реально согласованы (по answer) — в журнал и панель.
export function noteCodecs(pc) {
  const ans = [pc.currentLocalDescription, pc.currentRemoteDescription].find((d) => d?.type === 'answer');
  if (!ans) return;
  const a = sdpFirstCodec(ans.sdp, 'audio');
  const v = sdpFirstCodec(ans.sdp, 'video');
  S.audioRed = a === 'red';
  const key = a + '/' + v;
  if (key === S.codecsLogged) return;
  S.codecsLogged = key;
  log(`Кодеки: голос ${S.audioRed ? 'Opus + RED (защита от потерь)' : a || '—'}, видео ${v ? v.toUpperCase() : '—'}`);
}

// Код, который в app.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initCallStatsUi() {
  $('#quality') && ($('#quality').onclick = toggleStatsPanel);
  $('#bridgeBadge') && ($('#bridgeBadge').onclick = toggleStatsPanel);
}
