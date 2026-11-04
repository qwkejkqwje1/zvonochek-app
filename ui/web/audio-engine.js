// audio-engine.js — Аудио-движок (Web Audio: громкость 0–200 %, VAD, компрессор, проверка микрофона) и эхоподавление «Авто»
// v44: вынесено из app.js без изменения логики (строки 450–1020 v43).
import { audioRoute, echoWanted } from './media-policy.js?v=44';
import { $, S, audioC, log, route, setBtnIcon, setUse, switchDevice, toast } from './app.js?v=44';

// ---------- Аудио-движок Discord (Web Audio API: 0-200% Gain, VAD, Compressor, Loopback) ----------
export function ensureAudioEngine() {
  if (!S.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    S.audioCtx = new Ctx();
  }
  if (S.audioCtx.state === 'suspended') {
    S.audioCtx.resume().catch(() => {});
  }
  if (!S.audioCtx.onstatechange) {
    // iOS/Android усыпляют AudioContext при звонке на телефон, блокировке
    // экрана и после долгой тишины. Весь входящий звук у нас идёт через этот
    // граф (у <video id="remote"> громкость выставлена в 0), поэтому
    // suspended == полная тишина при живом WebRTC-соединении.
    S.audioCtx.onstatechange = () => {
      log('AudioContext: ' + S.audioCtx.state);
      if (S.audioCtx.state !== 'running') {
        S.audioCtx.resume().catch(() => {});
        updateRemoteAudibility();
      } else {
        updateRemoteAudibility();
      }
    };
  }
  if (!S.procDest) {
    const ctx = S.audioCtx;
    S.hpFilter = ctx.createBiquadFilter();
    S.hpFilter.type = 'highpass';
    S.hpFilter.frequency.value = S.audio.noise ? 85 : 20;

    S.micGainNode = ctx.createGain();
    S.micGainNode.gain.value = S.audio.micVol / 100;

    S.micAnalyser = ctx.createAnalyser();
    S.micAnalyser.fftSize = 512;
    S.micAnalyser.smoothingTimeConstant = 0.55;

    S.gateGainNode = ctx.createGain();
    S.gateGainNode.gain.value = 1;

    S.procDest = monoDest(ctx);

    S.hpFilter.connect(S.micGainNode);
    S.micGainNode.connect(S.micAnalyser);
    S.micAnalyser.connect(S.gateGainNode);
    S.gateGainNode.connect(S.procDest);

    // Цепочка обработки входящего голоса собеседника (0-200% + компрессор четкости)
    S.remoteCompNode = ctx.createDynamicsCompressor();
    S.remoteCompNode.threshold.value = -26;
    S.remoteCompNode.knee.value = 18;
    S.remoteCompNode.ratio.value = S.audio.comp ? 3.5 : 1;
    S.remoteCompNode.attack.value = 0.005;
    S.remoteCompNode.release.value = 0.18;

    S.remoteGainNode = ctx.createGain();
    S.remoteGainNode.gain.value = S.deafened ? 0 : S.audio.peerVol / 100;

    S.remoteAnalyser = ctx.createAnalyser();
    S.remoteAnalyser.fftSize = 256;

    S.remoteDest = ctx.createMediaStreamDestination();

    S.remoteCompNode.connect(S.remoteGainNode);
    S.remoteGainNode.connect(S.remoteAnalyser);
    S.remoteAnalyser.connect(S.remoteDest);
    // Также подключаем к системному выходу по умолчанию (если не выбран кастомный sinkId)
    if (!VOLUME_LOCKED) S.remoteAnalyser.connect(ctx.destination);
  }
  startMeterLoop();
  return S.audioCtx;
}


// Куда реально звучит собеседник: через WebAudio-граф (громкость 0-200%),
// а если граф недоступен/уснул — напрямую через элемент <video id="remote">
// (громкость до 100%). Раньше при уснувшем AudioContext звук пропадал
// полностью и навсегда: элемент был заглушён, а граф молчал.
// v40: на iOS volume медиаэлемента только для чтения (всегда 1), поэтому
// «volume = 0» не глушил <video id="remote">: голос звучал дважды — из
// элемента и из WebAudio-графа, с разной задержкой (эффект эха), а ползунок
// громкости не работал. Глушим через muted, а на таких устройствах играем
// только через элемент (граф остаётся для индикаторов, без выхода в динамик).
export const VOLUME_LOCKED = (() => {
  try {
    const a = document.createElement('audio');
    a.volume = 0.5;
    return a.volume !== 0.5;
  } catch {
    return false;
  }
})();
export function updateRemoteAudibility() {
  const vid = $('#remote');
  if (!vid) return;
  const viaEngine = !VOLUME_LOCKED && !!(S.audioCtx && S.audioCtx.state === 'running' && S.remoteSource);
  vid.muted = viaEngine || !!S.deafened;
  if (!vid.muted) vid.volume = Math.min(1, S.audio.peerVol / 100);
}

// Видео собеседника. На вертикальном экране вертикальное видео близких
// пропорций заполняет экран (cover, срезаются лишь края) — как в Telegram;
// в остальных случаях (горизонтальная камера, демонстрация экрана, десктоп)
// кадр показывается целиком. Двойной клик/тап переключает режим вручную.
export function fitRemoteVideo() {
  const v = $('#remote');
  if (!v || !v.videoWidth || !v.videoHeight) return;
  if (v.dataset.fit) return v.classList.toggle('fill', v.dataset.fit === 'fill');
  const ratio = v.videoWidth / v.videoHeight / (innerWidth / innerHeight);
  const portrait = innerHeight > innerWidth && v.videoHeight > v.videoWidth;
  v.classList.toggle('fill', portrait && ratio > 0.75 && ratio < 1.33);
}

// Попытка оживить входящий звук без пересоздания звонка.
export function recoverRemoteAudio(reason) {
  const now = Date.now();
  if (now - (S.lastAudioRecoverAt || 0) < 45000) return;
  S.lastAudioRecoverAt = now;
  log('Восстанавливаем входящий звук: ' + reason);
  const ctx = ensureAudioEngine();
  ctx?.resume?.().catch(() => {});
  attachRemoteToEngine();
  updateRemoteAudibility();
  $('#remote')?.play().catch(() => {});
}

// v40: обработанный трек микрофона — единственный трек MediaStreamDestination
// на всё время жизни страницы, его получают и звонок, и мост. До v40 его
// останавливали stopLocal() (выход в лобби, «Назад», «Положить трубку») и
// switchDevice() (смена микрофона), а attachMicToEngine() потом возвращал
// ТОТ ЖЕ остановленный трек (readyState 'ended'): со второго звонка без
// перезагрузки или после смены микрофона собеседнику уходило 0 байт звука.
// Теперь трек не останавливаем (микрофон освобождает stop() сырого трека),
// а если он всё-таки умер — пересоздаём destination.
// v42: обработанный микрофон — моно. MediaStreamDestination по умолчанию
// стерео (channelCount 2): голосу это не нужно, а кодер моста 2.0 (моно)
// падал на первом же кадре — мост 2.0 не работал ни разу.
export function monoDest(ctx) {
  const d = ctx.createMediaStreamDestination();
  try {
    d.channelCount = 1;
    d.channelCountMode = 'explicit';
  } catch {}
  return d;
}
export const isProcTrack = (t) => !!t && !!S.procDest && S.procDest.stream.getAudioTracks().includes(t);
export function liveProcTrack() {
  if (!S.audioCtx || !S.gateGainNode || !S.procDest) return null;
  let t = S.procDest.stream.getAudioTracks()[0];
  if (!t || t.readyState === 'ended') {
    try { S.gateGainNode.disconnect(S.procDest); } catch {}
    S.procDest = monoDest(S.audioCtx);
    S.gateGainNode.connect(S.procDest);
    t = S.procDest.stream.getAudioTracks()[0];
    log('Трек микрофона был остановлен — пересоздан');
  }
  return t || null;
}

export function attachMicToEngine(rawTrack) {
  S.rawAudioTrack = rawTrack;
  const ctx = ensureAudioEngine();
  if (!ctx || !rawTrack) return rawTrack;
  try {
    if (S.micSource) {
      try { S.micSource.disconnect(); } catch {}
    }
    S.micSource = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
    S.micSource.connect(S.hpFilter);
    const procTrack = liveProcTrack();
    return procTrack || rawTrack;
  } catch {
    return rawTrack;
  }
}

export function attachRemoteToEngine() {
  const ctx = ensureAudioEngine();
  const audioTracks = S.remote.getAudioTracks();
  if (!ctx || !audioTracks.length) return;
  try {
    if (S.remoteSource) {
      try { S.remoteSource.disconnect(); } catch {}
    }
    S.remoteSource = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    S.remoteSource.connect(S.remoteCompNode);

    const outEl = $('#remoteAudioOut');
    if (outEl && S.dev.spk && 'setSinkId' in HTMLMediaElement.prototype) {
      // Если выбран конкретный динамик через setSinkId — выводим через remoteAudioOut
      try { S.remoteAnalyser.disconnect(ctx.destination); } catch {}
      outEl.srcObject = S.remoteDest.stream;
      outEl.setSinkId(S.dev.spk).catch(() => {});
      outEl.play().catch(() => {});
    } else if (!VOLUME_LOCKED) {
      try { S.remoteAnalyser.connect(ctx.destination); } catch {}
    }
    // Приглушаем прямой звук из <video id="remote">, пока граф жив,
    // чтобы громкость регулировалась через GainNode (0-200%)
    updateRemoteAudibility();
  } catch (e) {
    console.warn('remote audio graph', e);
  }
}

export let persistTimer = 0;
export function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    try {
      localStorage.zvMicVol = String(S.audio.micVol);
      localStorage.zvPeerVol = String(S.audio.peerVol);
      localStorage.zvInputMode = S.audio.inputMode;
      localStorage.zvVadGate = String(S.audio.vadGate);
      localStorage.zvNoise = S.audio.noise ? '1' : '0';
      localStorage.zvEchoMode = S.audio.echoMode;
      localStorage.zvEcho = S.audio.echoMode === 'off' ? '0' : '1'; // для отката на v40
      localStorage.zvAgc = S.audio.agc ? '1' : '0';
      localStorage.zvComp = S.audio.comp ? '1' : '0';
      localStorage.zvOpusTune = S.audio.opusTune ? '1' : '0';
      localStorage.zvBitrate = String(S.audio.bitrate);
      localStorage.zvNetMode = S.audio.netMode;
      localStorage.zvRelay = S.audio.netMode === 'relay' ? '1' : '0';
    } catch {}
  }, 250);
}

export function syncAudioParams() {
  persistSoon();

  if (S.hpFilter) S.hpFilter.frequency.value = S.audio.noise ? 85 : 20;
  if (S.micGainNode) S.micGainNode.gain.value = S.audio.micVol / 100;
  if (S.remoteCompNode) S.remoteCompNode.ratio.value = S.audio.comp ? 3.5 : 1;
  if (S.remoteGainNode) S.remoteGainNode.gain.value = S.deafened ? 0 : S.audio.peerVol / 100;

  updateRemoteAudibility();

  // Обновляем подписи и ползунки во всех открытых панелях
  const gatePct = Math.max(0, Math.min(100, ((S.audio.vadGate + 75) / 60) * 100));
  for (const id of ['#pVadGateMark', '#qaVadGateMark', '#sVadGateMark']) {
    const el = $(id);
    if (el) el.style.left = gatePct + '%';
  }
  if ($('#pMicVol')) $('#pMicVol').value = S.audio.micVol;
  if ($('#pMicVolTxt')) $('#pMicVolTxt').textContent = S.audio.micVol + '%';
  if ($('#pPeerVol')) $('#pPeerVol').value = S.audio.peerVol;
  if ($('#pPeerVolTxt')) $('#pPeerVolTxt').textContent = S.audio.peerVol + '%';
  if ($('#qaPeerVol')) $('#qaPeerVol').value = S.audio.peerVol;
  if ($('#qaPeerVolTxt')) $('#qaPeerVolTxt').textContent = S.audio.peerVol + '%';
  if ($('#qaMicVol')) $('#qaMicVol').value = S.audio.micVol;
  if ($('#qaMicVolTxt')) $('#qaMicVolTxt').textContent = S.audio.micVol + '%';
  if ($('#quickVolLabel')) $('#quickVolLabel').textContent = S.deafened ? 'ВЫКЛ' : S.audio.peerVol + '%';
  setBtnIcon('#btnQuickAudio', S.deafened ? 'i-volume-x' : 'i-volume');
  if ($('#preInputModeText')) {
    $('#preInputModeText').textContent =
      S.audio.inputMode === 'ptt'
        ? 'Рация (нажми и говори)'
        : S.audio.inputMode === 'vad'
        ? `По голосу (${S.audio.vadGate} дБ)`
        : 'Открытый микрофон';
  }
  setUse('#preInputModeTag use', S.audio.inputMode === 'ptt' ? 'i-radio' : 'i-mic');
  if ($('#preCodecTag')) {
    $('#preCodecTag').textContent = S.audio.opusTune
      ? `Opus ${S.audio.bitrate} kbps · FEC, без DTX`
      : 'Opus · авто (настройки браузера)';
  }
  // Показываем кнопку PTT на экране звонка, если включен режим рации или активен мост
  $('#cPtt')?.classList.toggle('hidden', S.audio.inputMode !== 'ptt' && !S.bridgeActive);
}

export function stopMeterLoop() {
  if (S.meterTimer) {
    clearInterval(S.meterTimer);
    S.meterTimer = null;
  }
}

// v34: анти-перегрев — цикл анализатора работает в 3.5 раза реже (220 мс вместо 65 мс),
// останавливается при выходе из звонка/лобби, не крутит FFT и перерисовку DOM при
// заблокированном экране звонка (callLocked) или скрытой вкладке, если не нужен VAD/мост.
export function startMeterLoop() {
  if (S.meterTimer) return;
  const buf = new Float32Array(256);
  const rBuf = new Uint8Array(64);
  S.meterTimer = setInterval(() => {
    // 0. Сторож AudioContext (раз в секунду будит контекст, если мобильная ОС усыпила его)
    if (S.audioCtx && S.audioCtx.state !== 'running' && Date.now() - (S.ctxResumeAt || 0) > 1000) {
      S.ctxResumeAt = Date.now();
      S.audioCtx.resume().catch(() => {});
      updateRemoteAudibility();
    }
    const hiddenOrLocked = document.hidden || S.callLocked;
    const prejoinVis = !$('#prejoin')?.classList.contains('hidden');
    const qaVis = !$('#quickAudioPop')?.classList.contains('hidden');
    const modalVis = !$('#modal')?.classList.contains('hidden');
    const barsVis = !hiddenOrLocked && (prejoinVis || qaVis || modalVis);
    const needVadOrBridge = S.audio.inputMode !== 'open' || S.bridgeActive || S.testingMic;

    // 1. Анализ локального микрофона
    if (S.micAnalyser && S.rawAudioTrack && S.rawAudioTrack.readyState === 'live') {
      if (!barsVis && !needVadOrBridge) {
        // В режиме открытого микрофона во время звонка без открытых шкал не тратим CPU на FFT
        S.isSpeaking = S.micOn && !S.deafened;
        if (S.gateGainNode && S.audioCtx) {
          S.gateGainNode.gain.setTargetAtTime(S.isSpeaking ? 1 : 0, S.audioCtx.currentTime, 0.07);
        }
      } else {
        S.micAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const db = rms > 0.00001 ? Math.max(-75, Math.min(0, 20 * Math.log10(rms))) : -75;
        const pct = Math.max(0, Math.min(100, ((db + 75) / 60) * 100));

        if (barsVis) {
          for (const id of ['#pVadBar', '#qaVadBar', '#sVadBar']) {
            const el = $(id);
            if (el) el.style.width = (S.micOn && !S.deafened ? pct : 0) + '%';
          }
          if (prejoinVis && $('#pDbVal')) {
            $('#pDbVal').textContent = db <= -74 ? '-∞ дБ' : Math.round(db) + ' дБ';
          }
        }

        const now = Date.now();
        let pass = false;
        if (!S.micOn || S.deafened) {
          pass = false;
        } else if (S.audio.inputMode === 'open') {
          pass = true;
          S.isSpeaking = db > -55;
        } else if (S.audio.inputMode === 'ptt') {
          pass = S.pttPressed;
        } else {
          if (db >= S.audio.vadGate) {
            S.vadHoldUntil = now + 900;
          } else if (db >= S.audio.vadGate - 7 && now < S.vadHoldUntil) {
            S.vadHoldUntil = now + 300;
          }
          pass = now < S.vadHoldUntil;
        }
        if (S.audio.inputMode !== 'open') S.isSpeaking = pass;
        if (S.gateGainNode && S.audioCtx) {
          S.gateGainNode.gain.setTargetAtTime(pass ? 1 : 0, S.audioCtx.currentTime, 0.07);
        }
        if (!hiddenOrLocked) {
          $('#cMic')?.classList.toggle('speaking', S.isSpeaking && S.micOn && !S.deafened);
          if (prejoinVis) $('#preAvatarRing')?.classList.toggle('speaking', S.isSpeaking);
        }
      }
    }

    // 2. Индикация голоса собеседника (только когда аватар собеседника реально виден на экране!)
    if (!hiddenOrLocked && !$('#remoteOff')?.classList.contains('hidden')) {
      let peerTalking = Date.now() < S.bridgeSpeakingUntil;
      if (!peerTalking && S.remoteAnalyser && S.pc?.connectionState === 'connected') {
        S.remoteAnalyser.getByteFrequencyData(rBuf);
        let rSum = 0;
        for (let i = 0; i < rBuf.length; i++) rSum += rBuf[i];
        if (rSum / rBuf.length > 14) peerTalking = true;
      }
      $('#peerAvatarRing')?.classList.toggle('speaking', peerTalking);
      $('#voiceWave')?.classList.toggle('hidden', !peerTalking && !S.bridgeActive);
    }
  }, 220);
}

// v41: проверка микрофона — запись 5 секунд и воспроизведение (как эхо-тест
// Skype и проверка звука в Google Meet). До v41 это была живая петля
// «микрофон → динамик»: с эхоподавлением браузер принимал ваш же голос из
// динамика за эхо и вырезал его, и проверка звучала заметно хуже, чем вас
// слышит собеседник (в звонке AEC сравнивает микрофон с голосом собеседника,
// а не с вашим). Без AEC на динамике петля могла засвистеть. Запись берётся
// после всей обработки — ровно то, что уходит собеседнику.
export const MIC_TEST_MS = 5000;
export function toggleMicTest() {
  if (S.testingMic) return stopMicTest();
  const ctx = ensureAudioEngine();
  if (!ctx || !S.gateGainNode) return;
  if (!S.rawAudioTrack || S.rawAudioTrack.readyState !== 'live') return toast('Микрофон не включён');
  if (typeof MediaRecorder === 'undefined') return toast('Этот браузер не умеет записывать звук — проверка недоступна');
  const dest = ctx.createMediaStreamDestination();
  let rec;
  try {
    S.gateGainNode.connect(dest);
    rec = new MediaRecorder(dest.stream);
  } catch {
    try { S.gateGainNode.disconnect(dest); } catch {}
    return toast('Проверка микрофона недоступна в этом браузере');
  }
  const t = { rec, dest, chunks: [], left: MIC_TEST_MS / 1000, timer: 0, tick: 0, audio: null, src: null, url: '' };
  S.micTest = t;
  S.testingMic = 'rec';
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) t.chunks.push(e.data);
  };
  rec.onstop = () => {
    try { S.gateGainNode?.disconnect(dest); } catch {}
    dest.stream.getTracks().forEach((x) => x.stop());
    if (S.micTest !== t) return; // остановили вручную
    playMicTest(t, new Blob(t.chunks, { type: rec.mimeType || t.chunks[0]?.type || 'audio/webm' }));
  };
  rec.start(250);
  t.tick = setInterval(() => {
    t.left = Math.max(1, t.left - 1);
    paintMicTest();
  }, 1000);
  t.timer = setTimeout(() => {
    clearInterval(t.tick);
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch {}
  }, MIC_TEST_MS);
  toast('Скажите пару фраз — через 5 секунд запись прозвучит');
  paintMicTest();
}
export function playMicTest(t, blob) {
  S.testingMic = 'play';
  paintMicTest();
  const done = () => {
    if (S.micTest === t) stopMicTest();
  };
  // Запасной путь — через уже запущенный AudioContext (не нужен новый жест).
  const viaCtx = async () => {
    try {
      const buf = await S.audioCtx.decodeAudioData(await blob.arrayBuffer());
      if (S.micTest !== t) return;
      const src = (t.src = S.audioCtx.createBufferSource());
      src.buffer = buf;
      src.connect(S.audioCtx.destination);
      src.onended = done;
      src.start();
    } catch {
      toast('Не удалось воспроизвести запись');
      done();
    }
  };
  try {
    t.url = URL.createObjectURL(blob);
    const a = (t.audio = new Audio(t.url));
    if (S.dev.spk && a.setSinkId) a.setSinkId(S.dev.spk).catch(() => {});
    a.onended = done;
    a.play().catch(() => {
      t.audio = null;
      viaCtx();
    });
  } catch {
    viaCtx();
  }
}
export function paintMicTest() {
  const left = S.micTest?.left || 0;
  const labels = {
    '#pTestMic': ['Проверить микрофон', `Говорите… ${left}`, 'Слушайте…'],
    '#sTestMic': ['Проверить', `Запись ${left}`, 'Слушайте'],
  };
  for (const [id, [idle, rec, play]] of Object.entries(labels)) {
    const b = $(id);
    if (!b) continue;
    const on = !!S.testingMic;
    b.classList.toggle('active-test', on);
    b.setAttribute('aria-pressed', String(on));
    const lbl = b.querySelector('.lbl');
    if (lbl) lbl.textContent = S.testingMic === 'rec' ? rec : S.testingMic === 'play' ? play : idle;
    setBtnIcon(b, on ? 'i-stop' : 'i-volume');
  }
}
export function stopMicTest() {
  const t = S.micTest;
  const was = S.testingMic;
  S.micTest = null;
  S.testingMic = false;
  if (t) {
    clearTimeout(t.timer);
    clearInterval(t.tick);
    try {
      if (t.rec.state !== 'inactive') t.rec.stop();
    } catch {}
    try { S.gateGainNode?.disconnect(t.dest); } catch {}
    try { t.audio?.pause(); } catch {}
    try { t.src?.stop(); } catch {}
    if (t.url) URL.revokeObjectURL(t.url);
  }
  if (was) paintMicTest();
}

// ---------- v41: эхоподавление «Авто» ----------
// Куда идёт звук (наушники / динамик) — по названиям устройств; в «Авто»
// AEC выключается в наушниках и включается на динамике. Маршрут
// пересчитывается перед открытием микрофона, после первого разрешения
// (до него названия скрыты), при смене микрофона/динамика и при
// подключении/отключении наушников (devicechange).
export async function refreshAudioRoute({ useTrack = true } = {}) {
  let route = 'unknown';
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const live = useTrack && S.rawAudioTrack?.readyState === 'live' ? S.rawAudioTrack.label || '' : '';
    route = audioRoute(list, { micId: S.dev.mic, spkId: S.dev.spk, micLabel: live });
  } catch {}
  S.audio.route = route;
  const want = echoWanted(S.audio.echoMode, route);
  const changed = want !== S.audio.echo;
  S.audio.echo = want;
  paintEchoState();
  return changed;
}
// Применить эхоподавление/шумодав/АРУ к живому микрофону. v40: Chrome молча
// принимает applyConstraints для обработки, но на живом треке её не меняет
// (getSettings остаётся прежним) — проверяем результат и при расхождении
// переоткрываем микрофон (обработанный трек при этом не умирает).
export async function applyMicProcessing() {
  if (!S.rawAudioTrack || S.rawAudioTrack.readyState !== 'live') return;
  let applied = false;
  try {
    await S.rawAudioTrack.applyConstraints(audioC());
    const st = S.rawAudioTrack.getSettings?.() || {};
    const same = (v, want) => v === undefined || (v !== false) === want;
    applied =
      same(st.echoCancellation, S.audio.echo) &&
      same(st.noiseSuppression, S.audio.noise) &&
      same(st.autoGainControl, S.audio.agc);
  } catch {}
  if (!applied) await switchDevice('mic', S.dev.mic);
}
export async function setEchoMode(mode) {
  S.audio.echoMode = ['auto', 'on', 'off'].includes(mode) ? mode : 'auto';
  await refreshAudioRoute();
  syncAudioParams();
  await applyMicProcessing();
}
export const AUDIO_ROUTE_TEXT = { headset: 'наушники или гарнитура', speaker: 'звук из динамика', unknown: 'не удалось понять, наушники или динамик' };
export function paintEchoState() {
  const qa = $('#qaEcho');
  if (qa) qa.checked = !!S.audio.echo;
  const el = $('#sEchoState');
  if (!el) return;
  const on = S.audio.echo ? 'включено' : 'выключено';
  el.textContent =
    S.audio.echoMode === 'auto'
      ? `Сейчас: ${AUDIO_ROUTE_TEXT[S.audio.route] || AUDIO_ROUTE_TEXT.unknown} — эхоподавление ${on}.` +
        (S.audio.route === 'unknown' ? ' Если вы в наушниках, выберите «Выключено» — голос будет чище.' : '')
      : `Эхоподавление ${on} вручную.` +
        (S.audio.echo ? '' : ' Без наушников собеседник может слышать себя эхом.');
}

// Код, который в app.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initAudioEngine() {
  {
    const v = $('#remote');
    v?.addEventListener('resize', fitRemoteVideo);
    v?.addEventListener('loadedmetadata', fitRemoteVideo);
    v?.addEventListener('dblclick', () => {
      v.dataset.fit = v.classList.contains('fill') ? 'fit' : 'fill';
      fitRemoteVideo();
    });
    addEventListener('resize', fitRemoteVideo);
  }
  {
    let routeTimer = 0;
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      clearTimeout(routeTimer);
      routeTimer = setTimeout(async () => {
        if (!(await refreshAudioRoute())) return;
        syncAudioParams();
        if (S.rawAudioTrack?.readyState !== 'live') return;
        await applyMicProcessing();
        toast(S.audio.echo ? 'Звук из динамика — эхоподавление включено' : 'Наушники — эхоподавление выключено, голос чище');
      }, 800);
    });
  }
}
