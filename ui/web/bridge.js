// bridge.js — Аварийный аудио-мост через сигналинг (1.0 MediaRecorder, 2.0 WebCodecs Opus)
// v44: вынесено из app.js без изменения логики (строки 1829–2199 v43).
import { b64u } from './crypto.js?v=44';
import { showBridgeSafety, showSafety } from './media-load.js?v=44';
import { startStats } from './call-stats-ui.js?v=44';
import { $, APP_VERSION, S, beep, countRoute, log, rosterCount, sysMsg, toast, updateStatus, webCodecsBridgeSupported } from './app.js?v=44';
import { ensureAudioEngine, liveProcTrack, syncAudioParams } from './audio-engine.js?v=44';

// ---------- Аварийный Аудио-Мост через Сигналинг (работает вообще без TURN и без UDP!) ----------
export function activateBridge(reason = 'Активирован аудио-мост через сигналинг') {
  if (!S.peer || S.bridgeActive) return;
  if (rosterCount() > 1) {
    log('Мост недоступен в групповом звонке (3+ участника)');
    return;
  }
  S.bridgeActive = true;
  S.bridgeNextPlayTime = 0;
  clearTimeout(S.bridgeAutoTimer);
  log(reason);
  // v42: progress() при активном мосте молчит — без этого под именем
  // собеседника весь звонок висело «Обмен ключами шифрования…».
  if ($('#connStep')) $('#connStep').textContent = 'Голос идёт через мост — прямой путь ищем в фоне';
  toast('Включён мост без TURN: голос идёт через зашифрованный сигнал. Видео появится, когда соединение станет прямым', 6000);
  if (!S.bridgeCounted) {
    S.bridgeCounted = true;
    countRoute('bridge');
  }
  if (!S.callStart) {
    S.callStart = Date.now();
    beep(660, 0.16);
    sysMsg(`Звонок начат · ваша версия ZVONochek v${APP_VERSION} · маршрут: мост без TURN`);
  }
  $('#bridgeBadge')?.classList.remove('hidden');
  $('#cPtt')?.classList.remove('hidden');
  showBridgeSafety();
  startBridgeRecorder();
  startStats();
  updateStatus();
}

export function stopBridge() {
  stopBridge2();
  if (S.bridgeDec) S.bridgeDec.nextPlay = 0;
  clearTimeout(S.bridgeAutoTimer);
  clearInterval(S.bridgeRecTimer);
  S.bridgeRecTimer = null;
  if (S.bridgeRecorder && S.bridgeRecorder.state !== 'inactive') {
    try { S.bridgeRecorder.stop(); } catch {}
  }
  S.bridgeRecorder = null;
  const wasActive = S.bridgeActive;
  S.bridgeActive = false;
  S.bridgeNextPlayTime = 0;
  S.bridgeSpeakingUntil = 0;
  $('#bridgeBadge')?.classList.add('hidden');
  syncAudioParams();
  // Код сверки зависел от режима моста — возвращаем код прямого P2P-соединения.
  if (S.pc?.connectionState === 'connected') {
    showSafety();
    if (wasActive && !S.leaving) toast('Прямое P2P-соединение установлено — мост отключён');
  }
}

export function getSupportedAudioMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

// ---------- Мост 2.0: WebCodecs Opus (альтернативный метод, v14) ----------
// Вместо кусков MediaRecorder по ~0,7 с кодируем звук настоящими Opus-кадрами
// по 20 мс (AudioEncoder) и шлём пачками ~120 мс. Задержка моста падает в разы.
// Работает только там, где есть WebCodecs + MediaStreamTrackProcessor
// (Chromium). Собеседник без WebCodecs честно получает мост 1.0: формат
// выбирается по флагу bc из hello/hi, а не по нашему желанию.
export function startBridgeRecorder() {
  if (!S.bridgeCounted) {
    S.bridgeCounted = true;
    countRoute('bridge');
  }
  if (S.peer?.bridgeCodecs && webCodecsBridgeSupported() && startBridge2()) {
    S.bridgeMode = 'webcodecs';
    return;
  }
  S.bridgeMode = 'mediarecorder';
  startBridgeRecorderV1();
}

export function upgradeBridge2() {
  if (!webCodecsBridgeSupported()) return;
  clearInterval(S.bridgeRecTimer);
  S.bridgeRecTimer = null;
  startBridgeRecorder();
}

export function startBridge2() {
  stopBridge2();
  const track = liveProcTrack();
  if (!track) return false;
  // sampleRate/ch — формат входных кадров (настройка кодера), outRate/outCh —
  // формат самого Opus-потока из decoderConfig: его и сообщаем собеседнику.
  const st = { running: true, sampleRate: 0, ch: 0, outRate: 48000, outCh: 1, frames: [], flushTimer: null, enc: null, reader: null };
  S.bridge2 = st;
  const fail = (e) => {
    if (S.bridge2 !== st) return;
    log(`Мост 2.0: ошибка кодировщика (${e?.name || 'Error'}: ${e?.message || e}) — переходим на мост 1.0`);
    stopBridge2();
    if (S.bridgeActive) {
      S.bridgeMode = 'mediarecorder';
      startBridgeRecorderV1();
    }
  };
  try {
    st.enc = new AudioEncoder({
      output: (chunk, meta) => {
        // v42: у AudioContext на 44,1 кГц (частые Windows/Android) раньше
        // уходило sr: 44100 — Opus так не декодируется, и у собеседника
        // AudioDecoder падал на каждом пакете. Поток Opus всегда 48 кГц.
        const dc = meta?.decoderConfig;
        if (dc) {
          st.outRate = dc.sampleRate || 48000;
          st.outCh = dc.numberOfChannels || 1;
        }
        try {
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buf);
          st.frames.push(new Uint8Array(buf));
        } catch {}
      },
      error: fail,
    });
    const processor = new MediaStreamTrackProcessor({ track });
    st.reader = processor.readable.getReader();
    st.flushTimer = setInterval(flushBridge2Frames, 120);
    (async () => {
      try {
        while (st.running) {
          const { value, done } = await st.reader.read();
          if (done) break;
          if (!value) continue;
          // v42: кодер настраиваем по настоящему кадру (частота и число
          // каналов), а не по getSettings(): несовпадение с конфигом — это
          // EncodingError на первом encode и тихий откат на мост 1.0.
          if (value.sampleRate !== st.sampleRate || value.numberOfChannels !== st.ch) {
            try {
              st.enc.configure({ codec: 'opus', sampleRate: value.sampleRate, numberOfChannels: value.numberOfChannels, bitrate: 24000 });
              st.sampleRate = value.sampleRate;
              st.ch = value.numberOfChannels;
            } catch (e) {
              value.close();
              fail(e);
              break;
            }
          }
          // Кодируем только реальную речь: тишина не жжёт трафик сигналинга.
          if (S.micOn && !S.deafened && S.isSpeaking && st.enc.state === 'configured') {
            try { st.enc.encode(value); } catch {}
          }
          value.close();
        }
      } catch {}
    })();
    log('Мост 2.0 (WebCodecs Opus, кадры 20 мс) включён');
    return true;
  } catch (e) {
    console.warn('bridge2 start', e);
    stopBridge2();
    return false;
  }
}

export function flushBridge2Frames() {
  const st = S.bridge2;
  if (!st || !st.frames.length || !S.peer) return;
  const frames = st.frames.splice(0);
  let total = 0;
  for (const f of frames) total += 2 + f.length;
  if (total < 10 || total > 60000) return;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const f of frames) {
    dv.setUint16(o, f.length);
    o += 2;
    out.set(f, o);
    o += f.length;
  }
  S.sig?.send(
    { type: 'voice2', to: S.peer.id, toInst: S.peer.inst, sr: st.outRate, ch: st.outCh > 1 ? st.outCh : undefined, b64: b64u.enc(out), _noZip: true },
    { voice: true }
  );
}

export function stopBridge2() {
  const st = S.bridge2;
  if (!st) return;
  st.running = false;
  clearInterval(st.flushTimer);
  try { st.reader?.cancel(); } catch {}
  try { st.enc?.close(); } catch {}
  if (S.bridge2 === st) S.bridge2 = null;
}

export function ensureBridgeDecoder(sr, ch = 1) {
  const ctx = ensureAudioEngine();
  if (!ctx || typeof AudioDecoder === 'undefined') return null;
  let d = S.bridgeDec;
  if (d && d.sampleRate === sr && d.ch === ch && d.dec.state !== 'closed') return d;
  if (d) {
    try { d.dec.close(); } catch {}
  }
  d = S.bridgeDec = { sampleRate: sr, ch, nextPlay: 0, ts: 0, dec: null };
  d.dec = new AudioDecoder({
    output: (data) => {
      try { scheduleDecodedBridgeFrame(data); } catch {}
      try { data.close(); } catch {}
    },
    error: (e) => console.warn('bridge2 dec', e),
  });
  d.dec.configure({ codec: 'opus', sampleRate: sr, numberOfChannels: ch });
  return d;
}

export function scheduleDecodedBridgeFrame(data) {
  const ctx = S.audioCtx;
  if (!ctx || !S.bridgeDec) return;
  const frames = data.numberOfFrames;
  if (!frames) return;
  const buf = ctx.createBuffer(1, frames, data.sampleRate);
  const tmp = new Float32Array(frames);
  try {
    data.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
  } catch {
    try { data.copyTo(tmp, { planeIndex: 0 }); } catch { return; }
  }
  buf.copyToChannel(tmp, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(S.remoteCompNode || ctx.destination);
  // Маленький джиттер-буфер: не копим отставание больше ~0,35 с.
  if (S.bridgeDec.nextPlay - ctx.currentTime > 0.35) S.bridgeDec.nextPlay = 0;
  const startAt = Math.max(ctx.currentTime + 0.04, S.bridgeDec.nextPlay || 0);
  src.start(startAt);
  S.bridgeDec.nextPlay = startAt + buf.duration;
}

export async function playBridgeVoice2(m) {
  if (S.deafened || !m.b64) return;
  if (typeof AudioDecoder === 'undefined') return; // мы бы и не заявили bc=1
  if (!S.bridgeActive && S.pc?.connectionState !== 'connected') {
    activateBridge('Получен голос WebCodecs от собеседника по мосту 2.0');
  }
  S.bridgeSpeakingUntil = Date.now() + 400;
  $('#peerAvatarRing')?.classList.add('speaking');
  // Opus декодируется только в 8/12/16/24/48 кГц; v41 мог прислать 44100.
  const sr = [8000, 12000, 16000, 24000, 48000].includes(m.sr) ? m.sr : 48000;
  const d = ensureBridgeDecoder(sr, m.ch === 2 ? 2 : 1);
  if (!d) return;
  const bytes = b64u.dec(m.b64);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  while (o + 2 <= bytes.byteLength) {
    const len = dv.getUint16(o);
    o += 2;
    if (len <= 0 || o + len > bytes.byteLength) break;
    const pkt = bytes.slice(o, o + len);
    o += len;
    d.ts += 20000; // кадры по 20 мс
    try {
      d.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: d.ts, duration: 20000, data: pkt }));
    } catch {}
  }
}

export function startBridgeRecorderV1() {
  if (typeof MediaRecorder === 'undefined') return;
  clearInterval(S.bridgeRecTimer);
  const mime = getSupportedAudioMime();

  // Каждые ~420 мс записываем и отправляем голосовой фрагмент, если пользователь говорит
  const recordSlice = () => {
    if (!S.bridgeActive || !S.joined || !S.peer) return;
    // Если прямое P2P WebRTC-соединение уже поднялось и пользователь не форсировал режим моста — уступаем P2P
    if (S.pc?.connectionState === 'connected' && S.audio.netMode !== 'bridge') {
      stopBridge();
      return;
    }
    if (!S.micOn || S.deafened || !S.isSpeaking) return;

    const stream = (liveProcTrack() && S.procDest?.stream) || S.local;
    if (!stream || !stream.getAudioTracks().length) return;
    try {
      const rec = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 16000, // 16 Кбит/с, куски короче (400 мс) — меньше задержка моста 1.0
      });
      const chunks = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      rec.onstop = async () => {
        if (!chunks.length || !S.bridgeActive || !S.peer) return;
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        if (buf.byteLength < 60 || buf.byteLength > 45000) return;
        S.sig?.send(
          {
            type: 'voice',
            to: S.peer.id,
            toInst: S.peer.inst,
            mime: blob.type,
            b64: b64u.enc(buf),
            _noZip: true,
          },
          { voice: true }
        );
      };
      rec.start();
      setTimeout(() => {
        if (rec.state === 'recording') {
          try { rec.stop(); } catch {}
        }
      }, 400);
    } catch (e) {
      console.warn('bridge recorder', e);
    }
  };

  S.bridgeRecTimer = setInterval(recordSlice, 420);
}

export async function playBridgeVoice(m) {
  if (S.deafened || !m.b64) return;
  // Если мы получили голосовой пакет по мосту, значит собеседник говорит через мост
  if (!S.bridgeActive && S.pc?.connectionState !== 'connected') {
    activateBridge('Получен голос от собеседника по каналу сигналинга');
  }
  S.bridgeSpeakingUntil = Date.now() + 750;
  $('#peerAvatarRing')?.classList.add('speaking');
  $('#voiceWave')?.classList.remove('hidden');

  const bytes = b64u.dec(m.b64);
  const ctx = ensureAudioEngine();
  if (ctx && ctx.state === 'running') {
    try {
      const copyBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const audioBuf = await ctx.decodeAudioData(copyBuf);
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(S.remoteCompNode || ctx.destination);
      // Не даём очереди расти: при лагах сети сбрасываем накопленное опережение.
      if (S.bridgeNextPlayTime - ctx.currentTime > 0.6) S.bridgeNextPlayTime = 0;
      const startAt = Math.max(ctx.currentTime + 0.03, S.bridgeNextPlayTime || 0);
      src.start(startAt);
      S.bridgeNextPlayTime = startAt + audioBuf.duration;
      return;
    } catch {}
  }
  // Фоллбэк для браузеров, где decodeAudioData не декодирует фрагмент контейнера напрямую
  try {
    const blob = new Blob([bytes], { type: m.mime || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.volume = Math.min(1, S.audio.peerVol / 100);
    a.onended = () => URL.revokeObjectURL(url);
    a.play().catch(() => URL.revokeObjectURL(url));
  } catch {}
}

// Код, который в app.js выполнялся при загрузке: вызывается оттуда же, на прежнем месте.
export function initBridge() {
  $('#btnForceBridge').onclick = () => {
    if (!S.peer) return toast('Дождитесь подключения собеседника к комнате');
    activateBridge('Мост без TURN включён вручную');
  };
}
