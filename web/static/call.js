// Calls: WebRTC (P2P media, perfect for most networks) with automatic
// fallback to the audio bridge through the libp2p connection.
import { h, icon, api, toast, avatar, gradFor, fmtDur, menu, clear } from './lib.js';
import { tones, Bridge, canOpus, levelMeter, setOutputDevice } from './audio.js';

let app = null;
let C = null; // current call
let pendingMedia = null;
let root = null;

export function initCalls(a) {
  app = a;
  root = h('div#call-root');
  document.body.appendChild(root);
}

export const currentCall = () => C;

const ui = () => (app.S.settings && app.S.settings.ui) || {};

function audioConstraints() {
  const u = ui();
  return {
    echoCancellation: true,
    noiseSuppression: u.ns !== '0',
    autoGainControl: u.agc !== '0',
    channelCount: 1,
    deviceId: u.mic ? { ideal: u.mic } : undefined,
  };
}

function videoConstraints() {
  const u = ui();
  return { deviceId: u.cam ? { ideal: u.cam } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
}

function mediaError(e, what) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return `Нет доступа к ${what}. Разрешите доступ в запросе браузера (значок камеры в адресной строке окна).`;
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return `${what === 'микрофону' ? 'Микрофон' : 'Камера'} не найден(а).`;
  if (n === 'NotReadableError') return `${what === 'микрофону' ? 'Микрофон' : 'Камера'} занят(а) другой программой.`;
  return `Ошибка доступа к ${what}: ${e && e.message ? e.message : e}`;
}

async function getMedia(video) {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: video ? videoConstraints() : false });
  } catch (e) {
    if (video) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
        toast(mediaError(e, 'камере') + ' Звонок продолжится без видео.', 'warn', 6000);
      } catch (e2) {
        toast(mediaError(e2, 'микрофону') + ' Собеседник вас не услышит.', 'err', 7000);
      }
    } else {
      toast(mediaError(e, 'микрофону') + ' Собеседник вас не услышит.', 'err', 7000);
    }
  }
  return stream;
}

function sig(data) {
  if (!C) return;
  app.wsSend({ type: 'rtc', cid: C.id, data });
}

function sendState() {
  if (!C) return;
  sig({ k: 'state', mic: C.micOn, cam: !!C.camTrack, screen: !!C.screenTrack });
}

// ---------------------------------------------------------------- lifecycle

function newCall(cv) {
  C = {
    id: cv.id, peer: cv.peer, out: cv.out, video: cv.video, state: cv.state, mode: cv.mode || 'webrtc',
    started: cv.started, answered: cv.answered || 0,
    local: null, micTrack: null, camTrack: null, screenTrack: null, micOn: true,
    pc: null, gen: 0, pendingIce: {}, remote: null, remoteState: { mic: true, cam: cv.video, screen: false },
    connected: false, everConnected: false, restarts: 0, minimized: false, stats: null, statsOpen: false,
    notice: '', bridge: null, peerOpus: false, timers: [],
  };
  return C;
}

function setLocal(stream) {
  if (!C) { if (stream) stream.getTracks().forEach((t) => t.stop()); return; }
  C.local = stream;
  C.micTrack = stream ? stream.getAudioTracks()[0] || null : null;
  C.camTrack = stream ? stream.getVideoTracks()[0] || null : null;
  if (C.micTrack) C.micTrack.enabled = C.micOn;
}

export function onCallEvent(cv) {
  if (!cv || !cv.id) return;
  if (cv.state === 'ended') {
    if (C && C.id === cv.id) finish(cv.reason || '');
    return;
  }
  if (C && C.id !== cv.id) cleanup();
  const fresh = !C;
  if (fresh) {
    newCall(cv);
    if (cv.state === 'outgoing' && pendingMedia) {
      const p = pendingMedia;
      pendingMedia = null;
      p.then((s) => { if (C && C.id === cv.id) { setLocal(s); render(); } else if (s) s.getTracks().forEach((t) => t.stop()); });
    }
    if (cv.state === 'incoming') {
      tones.ring();
      app.attention(true, cv);
    } else if (cv.state === 'outgoing') {
      tones.ringback();
    } else if (cv.state === 'active') {
      // window (re)opened during a call
      resumeActive();
    }
  }
  const prevState = C.state;
  const prevMode = C.mode;
  C.state = cv.state;
  C.mode = cv.mode || C.mode;
  if (cv.answered) C.answered = cv.answered;
  if (!fresh && prevState !== 'active' && C.state === 'active') onActive();
  else if (!fresh && C.state === 'active' && prevMode !== C.mode) onModeChange();
  render();
}

async function resumeActive() {
  const s = await getMedia(false);
  if (!C) { if (s) s.getTracks().forEach((t) => t.stop()); return; }
  setLocal(s);
  C.answered = C.answered || Date.now();
  sig({ k: 'caps', opus: await canOpus() });
  if (C.mode === 'bridge') startBridge();
  else if (C.out) startOffer();
  else sig({ k: 'restart', fresh: true });
  startStats();
  render();
}

function onActive() {
  tones.stop();
  tones.connected();
  app.attention(false);
  C.answered = C.answered || Date.now();
  canOpus().then((o) => sig({ k: 'caps', opus: o }));
  if (C.mode === 'bridge') startBridge();
  else if (C.out) startOffer();
  else if (C.earlyOffer) { const d = C.earlyOffer; C.earlyOffer = null; onOffer(d); }
  watchdog();
  startStats();
}

function onModeChange() {
  C.notice = '';
  if (C.mode === 'bridge') {
    closePC();
    startBridge();
  } else {
    stopBridge();
    C.restarts = 0;
    if (C.out) startOffer();
    watchdog();
  }
  render();
}

function later(fn, ms) {
  const t = setTimeout(fn, ms);
  if (C) C.timers.push(t);
  return t;
}

function watchdog() {
  const id = C.id;
  later(() => {
    if (!C || C.id !== id || C.mode !== 'webrtc' || C.connected) return;
    switchMode('bridge', 'Прямое соединение не установилось — звонок переведён на мост через Звоночек (только звук).');
  }, C.out ? 13000 : 18000);
}

async function switchMode(mode, why) {
  if (!C || C.mode === mode || C.switching) return;
  C.switching = true;
  try {
    await api('/api/call/mode', { cid: C.id, mode });
    if (why) toast(why, 'warn', 6500);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    if (C) C.switching = false;
  }
}

function finish(reason) {
  if (!C) return;
  const c = C;
  const dur = c.answered && c.state === 'active' ? (Date.now() - c.answered) / 1000 : 0;
  const text = endText(reason, c, dur);
  if (reason === 'remote:busy') tones.busy();
  else tones.hangup();
  cleanup();
  app.attention(false);
  showEnded(c, text);
}

function endText(reason, c, dur) {
  const r = String(reason || '');
  if (r === 'remote:declined') return 'Собеседник отклонил звонок';
  if (r === 'remote:busy') return 'Абонент занят';
  if (r === 'remote:no_answer' || (r === 'timeout' && c.out)) return 'Нет ответа';
  if (r === 'timeout') return 'Пропущенный звонок';
  if (r === 'remote:canceled') return 'Вызов отменён';
  if (r === 'remote:shutdown') return 'Собеседник закрыл Звоночек';
  if (r === 'remote:window_closed' || r === 'window_closed') return 'Окно звонка было закрыто';
  if (r === 'lost' || r === 'remote:lost') return 'Связь с собеседником потеряна';
  if (r === 'failed') return 'Не удалось ответить — связь потеряна';
  return dur ? `Звонок завершён · ${fmtDur(dur)}` : 'Звонок завершён';
}

function cleanup() {
  if (!C) return;
  tones.stop();
  for (const t of C.timers) clearTimeout(t);
  clearInterval(C.statsTimer);
  clearInterval(C.clock);
  if (C.stopMeter) C.stopMeter();
  if (C.stopLocalMeter) C.stopLocalMeter();
  closePC();
  stopBridge();
  for (const t of [C.micTrack, C.camTrack, C.screenTrack]) if (t) t.stop();
  if (C.local) C.local.getTracks().forEach((t) => t.stop());
  C = null;
  render();
}

export function shutdownCall() { cleanup(); }

// ---------------------------------------------------------------- actions

export async function startCall(peer, video) {
  if (C) { toast('Сначала завершите текущий звонок', 'warn'); return; }
  pendingMedia = getMedia(video);
  try {
    const cv = await api('/api/call/start', { peer, video });
    onCallEvent(cv);
  } catch (e) {
    const p = pendingMedia;
    pendingMedia = null;
    if (p) p.then((s) => s && s.getTracks().forEach((t) => t.stop()));
    toast(e.message, 'err', 6000);
  }
}

async function accept(withVideo) {
  if (!C || C.state !== 'incoming') return;
  tones.stop();
  C.accepting = true;
  render();
  const s = await getMedia(withVideo);
  if (!C) { if (s) s.getTracks().forEach((t) => t.stop()); return; }
  setLocal(s);
  try {
    const cv = await api('/api/call/accept', { cid: C.id });
    if (C) C.accepting = false;
    onCallEvent(cv);
  } catch (e) {
    toast(e.message, 'err');
    cleanup();
  }
}

async function hangup(reason) {
  if (!C) return;
  const id = C.id;
  api('/api/call/end', { cid: id, reason: reason || 'hangup' }).catch(() => {});
  finish('local');
}

function toggleMic() {
  if (!C) return;
  C.micOn = !C.micOn;
  if (C.micTrack) C.micTrack.enabled = C.micOn;
  if (C.bridge) C.bridge.setMuted(!C.micOn);
  sendState();
  render();
}

async function toggleCam() {
  if (!C || C.mode === 'bridge') return;
  if (C.camTrack) {
    C.camTrack.stop();
    C.camTrack = null;
    await setVideoTrack(C.screenTrack);
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
      if (!C) { s.getTracks().forEach((t) => t.stop()); return; }
      C.camTrack = s.getVideoTracks()[0];
      C.camTrack.contentHint = 'motion';
      if (!C.screenTrack) await setVideoTrack(C.camTrack);
    } catch (e) {
      toast(mediaError(e, 'камере'), 'err');
    }
  }
  sendState();
  render();
}

async function toggleScreen() {
  if (!C || C.mode === 'bridge') return;
  if (C.screenTrack) {
    stopScreen();
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false });
    if (!C) { s.getTracks().forEach((t) => t.stop()); return; }
    const t = s.getVideoTracks()[0];
    t.contentHint = 'detail';
    t.onended = () => { if (C && C.screenTrack === t) stopScreen(); };
    C.screenTrack = t;
    await setVideoTrack(t);
    sendState();
    render();
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') toast('Не удалось показать экран: ' + e.message, 'err');
  }
}

async function stopScreen() {
  if (!C || !C.screenTrack) return;
  C.screenTrack.stop();
  C.screenTrack = null;
  await setVideoTrack(C.camTrack);
  sendState();
  render();
}

async function setVideoTrack(track) {
  if (!C || !C.videoTx) return;
  try {
    await C.videoTx.sender.replaceTrack(track || null);
    applyBitrates();
  } catch (e) {
    console.warn('replaceTrack', e);
  }
}

function applyBitrates() {
  if (!C || !C.videoTx) return;
  const s = C.videoTx.sender;
  try {
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    const screen = !!C.screenTrack;
    p.encodings[0].maxBitrate = screen ? 2500000 : 1500000;
    p.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
    s.setParameters(p).catch(() => {});
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- WebRTC

function closePC() {
  if (!C || !C.pc) return;
  const pc = C.pc;
  C.pc = null;
  C.audioTx = C.videoTx = null;
  C.connected = false;
  try { pc.close(); } catch (e) { /* ignore */ }
  if (C.stopMeter) { C.stopMeter(); C.stopMeter = null; }
  C.remote = null;
}

function newPC(gen) {
  closePC();
  const pc = new RTCPeerConnection({ iceServers: app.S.ice || [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  C.pc = pc;
  C.gen = gen;
  C.remote = new MediaStream();
  pc.onicecandidate = (e) => { if (e.candidate && C && C.pc === pc) sig({ k: 'ice', gen, c: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    if (!C || C.pc !== pc) return;
    C.remote.addTrack(e.track);
    e.track.onunmute = () => render();
    e.track.onmute = () => render();
    if (e.track.kind === 'audio') startRemoteMeter();
    render();
  };
  pc.onconnectionstatechange = () => onConnState(pc);
  return pc;
}

function onConnState(pc) {
  if (!C || C.pc !== pc) return;
  const s = pc.connectionState;
  if (s === 'connected') {
    C.connected = true;
    C.everConnected = true;
    C.notice = '';
    clearTimeout(C.discTimer);
    sendState();
  } else if (s === 'disconnected') {
    C.connected = false;
    C.notice = 'Связь прервалась — восстанавливаю…';
    clearTimeout(C.discTimer);
    C.discTimer = later(() => { if (C && C.pc === pc && pc.connectionState !== 'connected') restartIce(); }, 2500);
  } else if (s === 'failed') {
    C.connected = false;
    restartIce();
  }
  render();
}

function restartIce() {
  if (!C || !C.pc || C.mode !== 'webrtc') return;
  C.restarts++;
  if (C.restarts > 2) {
    switchMode('bridge', 'Прямое соединение не восстанавливается — звонок переведён на мост через Звоночек.');
    return;
  }
  C.notice = 'Переподключение…';
  if (C.out) {
    try { C.pc.restartIce(); } catch (e) { /* ignore */ }
    makeOffer(true);
  } else {
    sig({ k: 'restart', gen: C.gen });
  }
  const pc = C.pc;
  later(() => {
    if (C && C.pc === pc && pc.connectionState !== 'connected' && C.mode === 'webrtc') {
      switchMode('bridge', 'Прямое соединение не восстанавливается — звонок переведён на мост через Звоночек.');
    }
  }, 12000);
}

function currentVideoTrack() {
  return C.screenTrack || C.camTrack || null;
}

async function startOffer() {
  if (!C) return;
  const pc = newPC(Date.now());
  const streams = C.local ? [C.local] : [];
  C.audioTx = pc.addTransceiver(C.micTrack || 'audio', { direction: 'sendrecv', streams });
  C.videoTx = pc.addTransceiver(currentVideoTrack() || 'video', { direction: 'sendrecv', streams });
  await makeOffer(false);
}

async function makeOffer(iceRestart) {
  const pc = C && C.pc;
  if (!pc) return;
  const gen = C.gen;
  try {
    const offer = await pc.createOffer({ iceRestart: !!iceRestart });
    if (!C || C.pc !== pc) return;
    await pc.setLocalDescription(offer);
    sig({ k: 'offer', gen, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  } catch (e) {
    console.warn('offer', e);
  }
}

async function onOffer(d) {
  if (!C || C.mode !== 'webrtc') return;
  if (C.state !== 'active') { C.earlyOffer = d; return; } // processed in onActive
  let pc = C.pc;
  if (!pc || d.gen > C.gen) pc = newPC(d.gen);
  else if (d.gen < C.gen) return;
  try {
    await pc.setRemoteDescription(d.sdp);
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver && t.receiver.track && t.receiver.track.kind;
      if (kind === 'audio' && !C.audioTx) {
        C.audioTx = t;
        t.direction = 'sendrecv';
        await t.sender.replaceTrack(C.micTrack || null);
        if (C.local && t.sender.setStreams) t.sender.setStreams(C.local);
      } else if (kind === 'video' && !C.videoTx) {
        C.videoTx = t;
        t.direction = 'sendrecv';
        await t.sender.replaceTrack(currentVideoTrack());
        if (C.local && t.sender.setStreams) t.sender.setStreams(C.local);
      }
    }
    const ans = await pc.createAnswer();
    if (!C || C.pc !== pc) return;
    await pc.setLocalDescription(ans);
    sig({ k: 'answer', gen: d.gen, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    flushIce(d.gen);
    applyBitrates();
  } catch (e) {
    console.warn('answer', e);
  }
}

async function onAnswer(d) {
  const pc = C && C.pc;
  if (!pc || d.gen !== C.gen || pc.signalingState !== 'have-local-offer') return;
  try {
    await pc.setRemoteDescription(d.sdp);
    flushIce(d.gen);
    applyBitrates();
  } catch (e) {
    console.warn('setRemote(answer)', e);
  }
}

async function onRemoteIce(d) {
  if (!C) return;
  if (!C.pc || d.gen !== C.gen || !C.pc.remoteDescription) {
    if (d.gen >= C.gen) (C.pendingIce[d.gen] = C.pendingIce[d.gen] || []).push(d.c);
    return;
  }
  try { await C.pc.addIceCandidate(d.c); } catch (e) { /* stale */ }
}

function flushIce(gen) {
  const list = C.pendingIce[gen] || [];
  delete C.pendingIce[gen];
  for (const k of Object.keys(C.pendingIce)) if (+k < gen) delete C.pendingIce[k];
  for (const c of list) C.pc.addIceCandidate(c).catch(() => {});
}

export function onRTC(ev) {
  if (!C || ev.cid !== C.id || !ev.data) return;
  const d = ev.data;
  switch (d.k) {
    case 'offer': onOffer(d); break;
    case 'answer': onAnswer(d); break;
    case 'ice': onRemoteIce(d); break;
    case 'restart':
      if (C.out && C.mode === 'webrtc' && C.state === 'active') {
        if (d.fresh || !C.pc) startOffer();
        else { try { C.pc.restartIce(); } catch (e) { /* ignore */ } makeOffer(true); }
      }
      break;
    case 'state':
      C.remoteState = { mic: d.mic !== false, cam: !!d.cam, screen: !!d.screen };
      render();
      break;
    case 'caps':
      C.peerOpus = !!d.opus;
      if (C.bridge) C.bridge.peerOpus = C.peerOpus;
      break;
  }
}

function startRemoteMeter() {
  if (!C || !C.remote || C.stopMeter) return;
  try {
    C.stopMeter = levelMeter(C.remote, (lvl) => {
      const on = lvl > 0.02;
      if (C && on !== C.speaking) { C.speaking = on; const r = root.querySelector('.ring'); if (r) r.classList.toggle('speaking', on); }
    });
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- bridge

async function startBridge() {
  if (!C || C.bridge) return;
  if (C.camTrack) { C.camTrack.stop(); C.camTrack = null; }
  if (C.screenTrack) { C.screenTrack.stop(); C.screenTrack = null; }
  const b = new Bridge({ cid: C.id, stream: C.local, sinkId: ui().spk });
  b.peerOpus = C.peerOpus;
  b.setMuted(!C.micOn);
  C.bridge = b;
  try {
    await b.start();
  } catch (e) {
    console.error('bridge', e);
    toast('Не удалось запустить аудиомост: ' + e.message, 'err');
  }
  sendState();
  render();
}

function stopBridge() {
  if (!C || !C.bridge) return;
  C.bridge.stop();
  C.bridge = null;
}

// ---------------------------------------------------------------- stats

function startStats() {
  clearInterval(C.statsTimer);
  clearInterval(C.clock);
  C.clock = setInterval(() => { const el = root.querySelector('.call-timer'); if (el && C && C.answered) el.textContent = fmtDur((Date.now() - C.answered) / 1000); const bar = document.querySelector('.callbar .call-timer'); if (bar && C) bar.textContent = fmtDur((Date.now() - C.answered) / 1000); }, 1000);
  C.statsTimer = setInterval(collectStats, 1500);
}

async function collectStats() {
  if (!C) return;
  if (C.bridge) {
    const b = C.bridge.stats;
    const p = app.S.contacts.get(C.peer);
    C.stats = { mode: 'bridge', codec: b.codec, net: b.net, play: b.play, route: b.route, link: p && p.presence ? p.presence : null };
    C.speaking = (C.bridge.remoteLevel || 0) > 0.02;
    updateStatsUI();
    return;
  }
  const pc = C.pc;
  if (!pc) return;
  try {
    const rep = await pc.getStats();
    let pair = null;
    let inA = null;
    let inV = null;
    let outV = null;
    rep.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = rep.get(r.selectedCandidatePairId) || pair;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') inA = r;
      if (r.type === 'inbound-rtp' && r.kind === 'video') inV = r;
      if (r.type === 'outbound-rtp' && r.kind === 'video') outV = r;
    });
    if (!pair) rep.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const lc = pair ? rep.get(pair.localCandidateId) : null;
    const rc = pair ? rep.get(pair.remoteCandidateId) : null;
    const prev = C.prevStats || {};
    const now = Date.now();
    const dt = prev.t ? (now - prev.t) / 1000 : 0;
    const lost = inA ? inA.packetsLost || 0 : 0;
    const recv = inA ? inA.packetsReceived || 0 : 0;
    const dl = lost - (prev.lost || 0);
    const dr = recv - (prev.recv || 0);
    const loss = dl + dr > 0 ? (100 * dl) / (dl + dr) : 0;
    const bytesIn = (inA ? inA.bytesReceived : 0) + (inV ? inV.bytesReceived : 0);
    const kbpsIn = dt ? ((bytesIn - (prev.bytesIn || 0)) * 8) / 1000 / dt : 0;
    C.prevStats = { t: now, lost, recv, bytesIn };
    C.stats = {
      mode: 'webrtc',
      rtt: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      local: lc ? lc.candidateType : '', remote: rc ? rc.candidateType : '',
      proto: lc ? lc.protocol || '' : '', relayProto: lc && lc.relayProtocol ? lc.relayProtocol : '',
      loss: Math.max(0, loss), jitter: inA && inA.jitter != null ? Math.round(inA.jitter * 1000) : null,
      kbpsIn: Math.round(Math.max(0, kbpsIn)),
      video: inV && inV.frameWidth ? `${inV.frameWidth}×${inV.frameHeight} · ${Math.round(inV.framesPerSecond || 0)} к/с` : '',
      sendVideo: outV && outV.frameWidth ? `${outV.frameWidth}×${outV.frameHeight} · ${Math.round(outV.framesPerSecond || 0)} к/с` : '',
    };
    updateStatsUI();
  } catch (e) { /* closed */ }
}

function routeChip() {
  if (!C || C.state !== 'active') return null;
  if (C.mode === 'bridge') {
    const link = C.stats && C.stats.link;
    const via = link && link.conn === 'relay' ? 'через relay' : 'напрямую';
    return h('span.chip.warn', { title: 'Звук идёт через соединение Звоночка (' + via + ')' }, icon('server', 'xs'), 'Мост · ' + via);
  }
  if (!C.connected) return h('span.chip', icon('activity', 'xs'), 'Соединение…');
  const s = C.stats || {};
  const relay = s.local === 'relay' || s.remote === 'relay';
  const rtt = s.rtt;
  const cls = (rtt != null && rtt > 400) || s.loss > 8 ? 'bad' : (rtt != null && rtt > 180) || s.loss > 3 ? 'warn' : 'ok';
  return h('span.chip.' + cls, { title: 'Нажмите, чтобы увидеть подробности' }, icon(relay ? 'server' : 'zap', 'xs'),
    (relay ? 'TURN' : 'P2P') + (rtt != null ? ` · ${rtt} мс` : ''));
}

const candName = { host: 'локальный', srflx: 'через NAT (STUN)', prflx: 'через NAT', relay: 'TURN-сервер' };

function statsPanel() {
  const s = C.stats || {};
  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push(h('div', k), h('div', String(v))); };
  if (s.mode === 'bridge') {
    add('Режим', 'Мост через Звоночек');
    add('Кодек', s.codec === 'opus' ? 'Opus 32 кбит/с' : 'PCM 16 кГц');
    add('Соединение', s.link ? (s.link.conn === 'relay' ? 'через relay' : 'прямое') + (s.link.rtt ? ` · ${s.link.rtt} мс` : '') : '');
    if (s.net) add('Пакеты', `↑ ${s.net.sent} · ↓ ${s.net.recv} · потеряно ${s.net.dropped}`);
    if (s.play) add('Буфер', `${Math.round((s.play.buffered || 0) / 48)} мс · провалов ${s.play.underruns || 0}`);
    add('Эхоподавление', s.route === 'aec' ? 'включено' : 'нет (используйте наушники)');
  } else {
    add('Режим', 'WebRTC (P2P)');
    add('Маршрут', s.local ? `${candName[s.local] || s.local} ↔ ${candName[s.remote] || s.remote}` : 'устанавливается…');
    add('Протокол', s.proto ? s.proto.toUpperCase() + (s.relayProto ? ` (TURN ${s.relayProto})` : '') : '');
    add('Задержка', s.rtt != null ? `${s.rtt} мс` : '');
    add('Потери', s.loss != null ? `${s.loss.toFixed(1)} %` : '');
    add('Джиттер', s.jitter != null ? `${s.jitter} мс` : '');
    add('Входящий поток', s.kbpsIn ? `${s.kbpsIn} кбит/с` : '');
    add('Видео ↓', s.video);
    add('Видео ↑', s.sendVideo);
  }
  return h('div.stats-panel', h('div.kv', rows));
}

function updateStatsUI() {
  if (!C) return;
  const chip = root.querySelector('.route-chip');
  if (chip) clear(chip).append(routeChip() || '');
  const p = root.querySelector('.stats-panel');
  if (p) p.replaceWith(statsPanel());
  const ring = root.querySelector('.ring');
  if (ring) ring.classList.toggle('speaking', !!C.speaking);
}

// ---------------------------------------------------------------- UI

function showEnded(c, text) {
  const name = app.displayName(c.peer);
  clear(root);
  root.appendChild(h('div.call', { style: { background: '#06080d' } },
    h('div.bgglow', { style: { background: gradFor(c.peer) } }),
    h('div.stage', h('div.who', avatar(c.peer, name, 's128'), h('div.nm', name), h('div.state', text)))));
  setTimeout(() => { if (!C) clear(root); }, 1800);
}

// persistent <video> elements (recreating them on every render would flash black)
const videos = {};
function videoEl(key, stream, cls) {
  let v = videos[key];
  if (!v) {
    v = videos[key] = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true; // audio is played by a separate element
  }
  v.className = cls;
  if (v.srcObject !== stream) v.srcObject = stream;
  setTimeout(() => v.play().catch(() => {}), 0);
  return v;
}

let localStreamCache = null;
function localPreviewStream(track) {
  if (!localStreamCache || localStreamCache.getVideoTracks()[0] !== track) localStreamCache = new MediaStream([track]);
  return localStreamCache;
}

function remoteHasVideo() {
  if (!C || !C.remote || C.mode === 'bridge') return false;
  const t = C.remote.getVideoTracks()[0];
  return !!(t && t.readyState === 'live' && !t.muted && (C.remoteState.cam || C.remoteState.screen));
}

let audioOut = null;
function ensureRemoteAudio() {
  if (!C || !C.remote || C.mode === 'bridge') {
    if (audioOut) { audioOut.srcObject = null; }
    return;
  }
  if (!audioOut) {
    audioOut = new Audio();
    audioOut.autoplay = true;
  }
  const tracks = C.remote.getAudioTracks();
  const cur = audioOut.srcObject;
  if (!cur || cur.getAudioTracks()[0] !== tracks[0]) {
    audioOut.srcObject = tracks.length ? new MediaStream(tracks) : null;
    const spk = ui().spk;
    if (spk && audioOut.setSinkId) audioOut.setSinkId(spk).catch(() => {});
    audioOut.play().catch(() => {});
  }
}

export function setSpeaker(id) {
  setOutputDevice(id);
  if (audioOut && audioOut.setSinkId) audioOut.setSinkId(id || '').catch(() => {});
  if (C && C.bridge) C.bridge.setSink(id);
}

function cbtn(iconName, label, on, cls = '', disabled = false, title = '') {
  return h('button.cbtn' + (cls ? '.' + cls : ''), { title: title || label, disabled, on: { click: (e) => { e.stopPropagation(); on(e); } } }, icon(iconName), label ? h('span.lbl', label) : null);
}

async function deviceMenu(e) {
  const items = [];
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    const spks = devs.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
    const curMic = C && C.micTrack ? C.micTrack.getSettings().deviceId : '';
    for (const d of mics) items.push({ icon: d.deviceId === curMic ? 'check' : 'mic', label: d.label || 'Микрофон', onClick: () => switchMic(d.deviceId) });
    if (spks.length && 'setSinkId' in HTMLMediaElement.prototype) {
      items.push('sep');
      const cur = ui().spk || 'default';
      for (const d of spks) items.push({ icon: d.deviceId === cur ? 'check' : 'volume', label: d.label || 'Динамик', onClick: () => { app.saveUI({ spk: d.deviceId }); setSpeaker(d.deviceId); } });
    }
  } catch (err) { /* ignore */ }
  items.push('sep');
  items.push({ icon: 'activity', label: C.statsOpen ? 'Скрыть статистику' : 'Статистика соединения', onClick: () => { C.statsOpen = !C.statsOpen; render(); } });
  if (C.mode === 'webrtc') items.push({ icon: 'server', label: 'Перейти на мост (если плохо слышно)', onClick: () => switchMode('bridge') });
  else items.push({ icon: 'zap', label: 'Попробовать P2P снова', onClick: () => switchMode('webrtc') });
  menu(e, items);
}

async function switchMic(id) {
  if (!C) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { ...audioConstraints(), deviceId: { exact: id } } });
    const t = s.getAudioTracks()[0];
    t.enabled = C.micOn;
    if (C.micTrack) C.micTrack.stop();
    C.micTrack = t;
    if (!C.local) C.local = new MediaStream();
    for (const old of C.local.getAudioTracks()) C.local.removeTrack(old);
    C.local.addTrack(t);
    if (C.audioTx) await C.audioTx.sender.replaceTrack(t);
    if (C.bridge) {
      const b = C.bridge;
      stopBridge();
      startBridge();
      void b;
    }
    app.saveUI({ mic: id });
  } catch (e) {
    toast(mediaError(e, 'микрофону'), 'err');
  }
}

export function render() {
  app.renderCallBar && app.renderCallBar();
  if (!C) {
    if (!root.querySelector('.call .stage .who .state')) clear(root);
    ensureRemoteAudio();
    return;
  }
  ensureRemoteAudio();
  if (C.minimized && C.state === 'active') { clear(root); return; }
  const name = app.displayName(C.peer);
  const callEl = h('div.call');
  callEl.appendChild(h('div.bgglow', { style: { background: gradFor(C.peer) } }));
  const stage = h('div.stage');
  callEl.appendChild(stage);

  if (C.state === 'incoming') {
    stage.appendChild(h('div.who',
      h('div.ring', avatar(C.peer, name, 's128')),
      h('div.nm', name),
      h('div.state', C.accepting ? 'Подключение…' : C.video ? 'Входящий видеозвонок' : 'Входящий звонок'),
      h('div.incoming-btns',
        cbtn('hangup', 'Отклонить', () => hangup('declined'), 'red'),
        cbtn('phone', 'Ответить', () => accept(false), 'green', !!C.accepting),
        C.video ? cbtn('video', 'С видео', () => accept(true), 'green', !!C.accepting) : null)));
  } else {
    const showRemote = remoteHasVideo();
    if (showRemote) {
      stage.appendChild(videoEl('remote', C.remote, 'remote' + (C.remoteState.screen ? '' : ' cover')));
    } else {
      stage.appendChild(h('div.who',
        h('div.ring' + (C.state === 'active' ? '.static' : '') + (C.speaking ? '.speaking' : ''), avatar(C.peer, name, 's128')),
        h('div.nm', name),
        h('div.state', C.state === 'outgoing' ? (C.video ? 'Видеовызов…' : 'Вызов…') :
          C.answered ? h('span.call-timer', fmtDur((Date.now() - C.answered) / 1000)) : 'Соединение…')));
    }
    const vt = currentVideoTrack();
    if (vt) stage.appendChild(videoEl('local', localPreviewStream(vt), 'local' + (C.screenTrack ? ' screen' : '')));
    if (C.state === 'active') {
      const rs = [];
      if (!C.remoteState.mic) rs.push(h('span.chip.bad', icon('micOff', 'xs'), `${name}: микрофон выключен`));
      if (C.remoteState.screen) rs.push(h('span.chip', icon('screen', 'xs'), `${name} показывает экран`));
      if (rs.length) stage.appendChild(h('div.remote-state', rs));
    }
    if (C.notice) stage.appendChild(h('div.notice', C.notice));

    const top = h('div.top',
      avatar(C.peer, name, 's40'),
      h('div.grow',
        h('div.nm', name),
        h('div.sub', C.state === 'active' && showRemote && C.answered ? h('span.call-timer', fmtDur((Date.now() - C.answered) / 1000)) : null,
          h('span.route-chip', { style: { cursor: 'pointer' }, on: { click: () => { C.statsOpen = !C.statsOpen; render(); } } }, routeChip() || ''))),
      C.state === 'active' ? h('button.ibtn', { title: 'Свернуть (вернуться к чату)', style: { color: '#fff' }, on: { click: () => { C.minimized = true; render(); app.openChat(C.peer); } } }, icon('minimize')) : null);
    callEl.appendChild(top);
    if (C.statsOpen && C.state === 'active') callEl.appendChild(statsPanel());

    const bridge = C.mode === 'bridge';
    callEl.appendChild(h('div.controls',
      cbtn(C.micOn ? 'mic' : 'micOff', C.micOn ? 'Микрофон' : 'Включить', toggleMic, C.micOn ? '' : 'off'),
      cbtn(C.camTrack ? 'video' : 'videoOff', C.camTrack ? 'Камера' : 'Камера', toggleCam, C.camTrack ? '' : 'off', bridge || C.state !== 'active', bridge ? 'В режиме моста видео недоступно' : ''),
      cbtn('screen', C.screenTrack ? 'Стоп показ' : 'Экран', toggleScreen, C.screenTrack ? 'off' : '', bridge || C.state !== 'active', bridge ? 'В режиме моста видео недоступно' : 'Показать экран'),
      cbtn('more', 'Ещё', deviceMenu, '', C.state !== 'active'),
      cbtn('hangup', 'Завершить', () => hangup(), 'red')));
  }
  clear(root).appendChild(callEl);
}

export function restore() {
  if (C) { C.minimized = false; render(); }
}

export function hangupCurrent() { hangup(); }
export function toggleMicCurrent() { toggleMic(); }
