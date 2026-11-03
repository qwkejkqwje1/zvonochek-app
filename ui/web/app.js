import { CONFIG, getWorkerBase, setWorkerBase, normalizeWorkerUrl, DEFAULT_WORKER_URL } from './config.js?v=40';
import { newSecret, deriveRoom, safetyCode, safetyCodeBridge, b64u, seal, open as openSealed, genP256KeyPair, sha256hex } from './crypto.js?v=40';
import { hasPersonal, getPersonal, ensurePersonal, signWithDevice, signWithKey, personalLinkOf, fpOfPubRaw, getChatDeviceEcdh, rotatePersonal, encryptWithVault, decryptWithVault, adminSigner, resetIdentityCache } from './identity.js?v=40';
import { inboxRegister, inboxRing, inboxRingState, inboxAck, inboxAnswer, inboxCancel, inboxMissed, inboxMissedAck, inboxRetire, InboxListener } from './inbox.js?v=40';
import { kvGet, kvPut, kvAll, kvDel, wipeDatabase } from './store.js?v=40';
import { Signaling } from './signaling.js?v=40';
import { ROUTE_SHORT, readCounters, deriveSample, bridgeSample, CallRecorder, journalDigest, plural } from './callstats.js?v=40';
import { renderLiveStats, renderCallsDashboard, renderCallsList, renderContactsList } from './stats-ui.js?v=40';
import { anonName, randomAnonName } from './anon-names.js?v=40';
import {
  startDevices,
  hasOtherDevices,
  isLinkedDevice,
  unlinkSelf,
  rotationCandidates,
  rotateWithDevices,
  openAdminLink,
  SYNC_SETTINGS,
} from './devices.js?v=40';
import { VQ_CHOICES, deviceClass, captureTier, tierConstraints, rxCap, parseCap, videoEncoding, QLEVELS, audioCodecOrder, videoCodecOrder, CLASS_TEXT, sdpFirstCodec } from './media-policy.js?v=40';

export const APP_VERSION = 40;
export const APP_BUILD = '2026-11-01';
// Версия разработки пишется из одного места: главная (бейдж и подпись),
// экран подготовки, карточка подключения в начале звонка.
for (const el of document.querySelectorAll('[data-ver]')) el.textContent = 'v' + APP_VERSION;
for (const el of document.querySelectorAll('[data-build]')) el.textContent = APP_BUILD;
const $ = (s, r = document) => r.querySelector(s);
const setUse = (sel, name) => {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.setAttribute('href', '#' + name);
};
const setBtnIcon = (sel, name) => setUse((typeof sel === 'string' ? $(sel) : sel)?.querySelector('use'), name);

// Регистрация Service Worker для быстрого старта и работы PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js?v=40').catch(() => {});
}

// Автообновление: если на сайте вышла новая версия, а браузер держит старую из кэша — перезагружаемся.
fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
  .then((r) => r.json())
  .then(async (j) => {
    if (j.v > APP_VERSION && sessionStorage.zvUpd !== String(j.v)) {
      sessionStorage.zvUpd = String(j.v);
      await fetch(location.pathname, { cache: 'reload' }).catch(() => {});
      location.reload();
    }
  })
  .catch(() => {});

const randHex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const selfId = sessionStorage.zvId || (sessionStorage.zvId = randHex(8));
const inst = randHex(6); // меняется при каждой перезагрузке страницы
const MAX_FILE_BYTES = 256 * 1024 * 1024;

// Миграция настроек v13 (один раз): у пользователей прошлых версий обработка
// звука была сохранена включённой в localStorage — сбрасываем её в «выкл»,
// чтобы новый дефолт сработал и у них, а не только на чистом профиле.
try {
  if (Number(localStorage.zvSettingsV || 0) < 13) {
    localStorage.zvNoise = '0';
    localStorage.zvEcho = '0';
    localStorage.zvAgc = '0';
    localStorage.zvComp = '0';
    localStorage.zvOpusTune = '0';
    if (!localStorage.zvBitrate) localStorage.zvBitrate = '48';
  }
  if (Number(localStorage.zvSettingsV || 0) < 14) {
    // v14: по просьбе владельца убираем VAD-гейт из пути звука по умолчанию.
    // Режим ввода становится «открытый микрофон»: гейт больше не режет голос,
    // VAD/PTT остаются только как ручные опции в настройках.
    localStorage.zvInputMode = 'open';
    localStorage.zvSettingsV = '14';
  }
  if (Number(localStorage.zvSettingsV || 0) < 37) {
    // v37: «1080p — стандарт» больше не навязывается телефонам. Сохранённое
    // «1080» (бывший дефолт) переводим в «Авто»: на компьютере это те же
    // 1080p@30, на телефоне — 720p, на слабом — 480p. 2K/720 — ручной выбор, не трогаем.
    if (localStorage.zvVQ === '1080') localStorage.zvVQ = 'auto';
    localStorage.zvSettingsV = '37';
  }
  if (Number(localStorage.zvSettingsV || 0) < 39) {
    // v39: оформление «ZVON» (красное) удалено по решению владельца —
    // остаётся одно, классическое; сохранённый выбор больше не нужен.
    localStorage.removeItem('zvSkin');
    localStorage.zvSettingsV = '39';
  }
  if (Number(localStorage.zvSettingsV || 0) < 40) {
    // v40: эхоподавление (AEC) снова включено по умолчанию. Без него при
    // громкой связи у собеседника его микрофон ловит ваш голос из динамика,
    // и вы слышите себя с задержкой. Миграция v13 выключила AEC вместе с
    // шумодавом и АРУ, когда тихий голос резала связка DSP + DTX + VAD-гейт;
    // DTX и гейт по умолчанию давно выключены (v13/v14), а AEC голос не режет.
    // Шумодав и АРУ остаются выключенными (выбор владельца), их можно включить.
    localStorage.zvEcho = '1';
    localStorage.zvSettingsV = '40';
  }
} catch {}

const S = {
  secret: null,
  room: null,
  sig: null,
  pc: null,
  peer: null,
  polite: false,
  peerDialect: 'plain', // 'g' — если основной собеседник говорит с нами групповым протоколом (клиент v16)
  makingOffer: false,
  ignoreOffer: false,
  pendingCands: [],
  local: new MediaStream(),
  remote: new MediaStream(),
  rawAudioTrack: null,
  micOn: true,
  deafened: false,
  camOn: true,
  screenTrack: null,
  pttPressed: false,
  isSpeaking: false,
  vadHoldUntil: 0,
  testingMic: false,

  isMobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ''),
  facingMode: localStorage.zvFacing || 'user', // 'user' (фронтальная) | 'environment' (задняя)
  // Правка владельца (v34): Эко-режим — только ручная опция, по умолчанию ВЫКЛ на всех устройствах.
  ecoMode: localStorage.zvEco === '1',
  // Потолок качества видео: 'auto' (v37, по умолчанию) — по классу устройства
  // и его нагрузке; ручной выбор — '1440' (2K), '1080', '720', '480'.
  vq: VQ_CHOICES.includes(localStorage.zvVQ) ? localStorage.zvVQ : 'auto',
  // v37: класс устройства и текущая нагрузка (см. media-policy.js).
  devClass: deviceClass({
    ua: navigator.userAgent || '',
    mem: navigator.deviceMemory || 0,
    cores: navigator.hardwareConcurrency || 0,
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ''),
  }),
  load: { cpu: 0, cpuHits: 0, cpuCalm: 0, cpuLock: false, cpuBackAt: 0, battLow: false, pressure: 0 },
  capTier: null, // текущая ступень захвата камеры
  peerCap: null, // подсказка собеседника: какое видео ему нужно {h, fps}
  rxSent: '', // последняя отправленная собеседнику подсказка (JSON)
  red: localStorage.zvRed !== '0', // v37: RED для голоса (защита от потерь), по умолчанию ВКЛ
  hwPref: '', // 'h264', если аппаратный H.264 энергоэффективнее VP8 (телефоны)
  callLocked: false,
  callDimmed: false,
  lastUnlockTap: 0,

  // Настройки устройств и звука в стиле Discord
  dev: {
    mic: localStorage.zvMic || '',
    cam: localStorage.zvCam || '',
    spk: localStorage.zvSpk || '',
  },
  audio: {
    micVol: Number(localStorage.zvMicVol ?? 100),
    peerVol: Number(localStorage.zvPeerVol ?? 100),
    inputMode: localStorage.zvInputMode || 'open', // 'open' | 'vad' | 'ptt'
    vadGate: Number(localStorage.zvVadGate ?? -45), // -75 .. -15 dB
    // v13: обработка звука и ручная настройка Opus по умолчанию ВЫКЛЮЧЕНЫ.
    // Раньше noise/echo/agc/comp были включены «из коробки» ( !== '0' ), а Opus
    // принудительно переписывался в SDP (FEC + DTX + maxaveragebitrate=24k):
    // связка браузерный DSP + DTX + наш VAD-гейт резала тихий голос и окончания
    // фраз, а после долгой паузы Opus с DTX мог «просыпаться» с задержкой.
    // Теперь чистый тракт: браузерный Opus — авто, DSP — только по явному выбору.
    noise: localStorage.zvNoise === '1',
    echo: localStorage.zvEcho !== '0', // v40: AEC включён по умолчанию (см. миграцию v40)
    agc: localStorage.zvAgc === '1',
    comp: localStorage.zvComp === '1',
    opusTune: localStorage.zvOpusTune === '1',
    bitrate: Number(localStorage.zvBitrate || 48), // 12, 24, 48, 64 kbps (применяется только при opusTune)
    netMode: localStorage.zvNetMode || (localStorage.zvRelay === '1' ? 'relay' : 'auto'), // 'auto' | 'bridge' | 'relay'
  },

  // Web Audio API узлы
  audioCtx: null,
  micSource: null,
  hpFilter: null,
  micGainNode: null,
  micAnalyser: null,
  gateGainNode: null,
  procDest: null,
  remoteSource: null,
  remoteCompNode: null,
  remoteGainNode: null,
  remoteAnalyser: null,
  remoteDest: null,
  meterTimer: null,
  ctxResumeAt: 0,
  audioStallN: 0,
  lastAudioBytes: -1,
  lastAudioRecoverAt: 0,

  // Аварийный аудио-мост через сигналинг (работа без TURN и при блокировке UDP)
  bridgeActive: false,
  bridgeAutoTimer: null,
  bridgeRecorder: null,
  bridgeRecTimer: null,
  bridgeNextPlayTime: 0,
  bridgeSpeakingUntil: 0,

  ice: [],
  hasTurn: false,
  roster: new Map(), // inst -> {id, name, seen} все участники комнаты (для группового режима)
  personal: null, // идентичность коммуникатора (identity.js)
  personalRoom: null, // {topic, key} личной комнаты
  inboxListener: null,
  incoming: null, // активный входящий ring {ringId, payload, fromFp}
  outCall: null, // активный исходящий ring
  linkFp: null, // &d= из открытой ссылки (личная ссылка владельца)
  autoJoinPending: false,
  autoCallPending: false, // v38: звонок контакту — сразу «Позвонить владельцу» после лобби
  pushSub: null,
  groupHook: null, // сюда регистрируется group.js (mesh для 3+ участников)
  ctrl: null,
  fileCh: null,
  sendQueue: [],
  sending: false,
  incomingFile: null,
  restartTimer: null,
  statsTimer: null,
  helloTimer: null,
  callStart: 0,
  prevCounters: null, // v36: прошлый снимок getStats (callstats.readCounters)
  callRec: null, // v36: CallRecorder текущего звонка
  callMeta: null, // v36: { dir, name, key } для записи в журнал
  lastSample: null,
  sigStatus: { mqttUp: 0, mqttTotal: 0, worker: 'off', workerHttp: 'off', nostrUp: 0, nostrTotal: 0, ntfyUp: 0, ntfyTotal: 0 },
  unread: 0,
  wakeLock: null,
  joined: false,
  dead: new Set(),
  gen: 0,
  watchdog: null,
  resendTimer: null,
  ackReceived: false,
  log: [],
  cands: { local: {}, remote: {} },
  via: {},
  pct: 0,
  step: '',
  method: '',
  countedOk: false,
};

// ---------- Утилиты UI ----------
function show(id) {
  ['home', 'prejoin', 'call'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
  document.body.dataset.screen = id;
  if (id === 'home') {
    refreshPersonalUI().catch(() => {});
    renderCalls().catch(() => {});
  }
  syncCallReturnBar();
}
// v38: плашка «Вернуться к звонку», пока звонок идёт, а на экране — чат
// или главная (как в Telegram). Тап — обратно в звонок.
function syncCallReturnBar() {
  const bar = $('#callReturnBar');
  if (!bar) return;
  const on = !!S.joined && $('#call')?.classList.contains('hidden');
  bar.classList.toggle('hidden', !on);
  clearInterval(S.returnBarTimer);
  if (!on) return;
  const tick = () => {
    const t = $('#callReturnTime');
    if (!t) return;
    const sec = Math.max(0, Math.floor((Date.now() - (S.callStart || S.joinedAt || Date.now())) / 1000));
    t.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };
  tick();
  S.returnBarTimer = setInterval(tick, 1000);
}
function returnToCall() {
  if (!S.joined || !S.secret) return;
  history.replaceState(null, '', location.pathname + '#k=' + S.secret);
  $('#chatroom')?.classList.add('hidden');
  show('call');
}
function syncChatOpen() {
  const call = $('#call');
  const chat = $('#chat');
  if (call && chat) call.classList.toggle('chat-open', !chat.classList.contains('hidden'));
}
let toastT;
function toast(t, ms = 3200) {
  const e = $('#toast');
  if (!e) return;
  e.textContent = t;
  e.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => e.classList.add('hidden'), ms);
}
function openModal(tplId) {
  const b = $('#modalBody');
  b.replaceChildren($(tplId).content.cloneNode(true));
  $('#modal').classList.remove('hidden');
  return b;
}
function closeModal() {
  if (S.testingMic) stopMicTest();
  $('#modal').classList.add('hidden');
}
document.addEventListener('click', (e) => {
  if (S.audioCtx && S.audioCtx.state === 'suspended') {
    S.audioCtx.resume().catch(() => {});
  }
  const c = e.target.closest('[data-close]');
  if (!c) return;
  if (c.dataset.close === 'modal') closeModal();
  else {
    $('#' + c.dataset.close)?.classList.add('hidden');
    if (c.dataset.close === 'chat') syncChatOpen();
  }
});
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' МБ' : Math.ceil(b / 1e3) + ' КБ');
const roomLink = () =>
  location.origin + location.pathname + '#k=' + S.secret +
  (S.personal && S.secret === S.personal.secret ? '&d=' + S.personal.fp : '');

function renderQr(el, text) {
  if (typeof qrcode === 'undefined' || !el) return;
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Ссылка скопирована');
  } catch {
    toast('Не удалось скопировать');
  }
}
function beep(freq = 880, dur = 0.14) {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)();
    const o = a.createOscillator();
    const g = a.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.04;
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur);
    setTimeout(() => a.close(), 350);
  } catch {}
}

// ---------- Маршрутизация и Главный экран ----------
function route() {
  const params = new URLSearchParams(location.hash.slice(1));
  // v39: QR нового устройства, открытый камерой телефона: #link=<код>.<bind>.
  // Код — одноразовый доступ к запросу привязки: убираем его из адреса и
  // истории сразу, обрабатывает devices.js на вкладке «Мой номер».
  if (params.get('link')) {
    const raw = location.hash;
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {}
    show('home');
    setTimeout(() => {
      document.querySelector('[data-home-tab="personal"]')?.click();
      openAdminLink(raw).catch(() => {});
    }, 50);
    return;
  }
  // v21: ссылка приватного чата (#chat=<seed>) — обрабатывает chat.js,
  // звонковая маршрутизация ниже её не касается.
  if (params.get('chat')) {
    // v38: во время звонка (переход в чат) секрет звонка не сбрасываем —
    // звонок продолжается, вернуться — плашкой «Вернуться к звонку».
    if (!S.joined) S.secret = null;
    show('home');
    window.ZVChat?.openFromHash?.();
    return;
  }
  const k = params.get('k');
  const d = params.get('d');
  if (S.joined) {
    if (k && k === S.secret) {
      $('#chatroom')?.classList.add('hidden');
      show('call');
    }
    return;
  }
  S.linkFp = d && /^[a-f0-9]{32}$/.test(d) ? d : null;
  if (k && /^[A-Za-z0-9_-]{22,}$/.test(k)) {
    S.secret = k;
    preJoin();
  } else {
    S.secret = null;
    stopLocal();
    show('home');
  }
}
window.addEventListener('hashchange', route);
$('#btnCreate').onclick = () => {
  location.hash = 'k=' + newSecret();
};
$('#btnOpenLink').onclick = () => {
  const raw = ($('#homeLinkInput').value || '').trim();
  if (!raw) return toast('Вставьте ссылку или ключ звонка');
  const m = raw.match(/k=([A-Za-z0-9_-]{22,})/) || raw.match(/^([A-Za-z0-9_-]{22,})$/);
  if (m) {
    const dm = raw.match(/d=([a-f0-9]{32})/);
    location.hash = 'k=' + m[1] + (dm ? '&d=' + dm[1] : '');
  } else {
    toast('Неверный формат ссылки или ключа');
  }
};
$('#btnBackHome').onclick = () => {
  if (S.joined) return;
  S.secret = null;
  stopLocal();
  history.replaceState(null, '', location.pathname);
  show('home');
};

// ---------- Аудио-движок Discord (Web Audio API: 0-200% Gain, VAD, Compressor, Loopback) ----------
function ensureAudioEngine() {
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

    S.procDest = ctx.createMediaStreamDestination();

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
const VOLUME_LOCKED = (() => {
  try {
    const a = document.createElement('audio');
    a.volume = 0.5;
    return a.volume !== 0.5;
  } catch {
    return false;
  }
})();
function updateRemoteAudibility() {
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
function fitRemoteVideo() {
  const v = $('#remote');
  if (!v || !v.videoWidth || !v.videoHeight) return;
  if (v.dataset.fit) return v.classList.toggle('fill', v.dataset.fit === 'fill');
  const ratio = v.videoWidth / v.videoHeight / (innerWidth / innerHeight);
  const portrait = innerHeight > innerWidth && v.videoHeight > v.videoWidth;
  v.classList.toggle('fill', portrait && ratio > 0.75 && ratio < 1.33);
}
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

// Попытка оживить входящий звук без пересоздания звонка.
function recoverRemoteAudio(reason) {
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
const isProcTrack = (t) => !!t && !!S.procDest && S.procDest.stream.getAudioTracks().includes(t);
function liveProcTrack() {
  if (!S.audioCtx || !S.gateGainNode || !S.procDest) return null;
  let t = S.procDest.stream.getAudioTracks()[0];
  if (!t || t.readyState === 'ended') {
    try { S.gateGainNode.disconnect(S.procDest); } catch {}
    S.procDest = S.audioCtx.createMediaStreamDestination();
    S.gateGainNode.connect(S.procDest);
    t = S.procDest.stream.getAudioTracks()[0];
    log('Трек микрофона был остановлен — пересоздан');
  }
  return t || null;
}

function attachMicToEngine(rawTrack) {
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

function attachRemoteToEngine() {
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

let persistTimer = 0;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    try {
      localStorage.zvMicVol = String(S.audio.micVol);
      localStorage.zvPeerVol = String(S.audio.peerVol);
      localStorage.zvInputMode = S.audio.inputMode;
      localStorage.zvVadGate = String(S.audio.vadGate);
      localStorage.zvNoise = S.audio.noise ? '1' : '0';
      localStorage.zvEcho = S.audio.echo ? '1' : '0';
      localStorage.zvAgc = S.audio.agc ? '1' : '0';
      localStorage.zvComp = S.audio.comp ? '1' : '0';
      localStorage.zvOpusTune = S.audio.opusTune ? '1' : '0';
      localStorage.zvBitrate = String(S.audio.bitrate);
      localStorage.zvNetMode = S.audio.netMode;
      localStorage.zvRelay = S.audio.netMode === 'relay' ? '1' : '0';
    } catch {}
  }, 250);
}

function syncAudioParams() {
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

function stopMeterLoop() {
  if (S.meterTimer) {
    clearInterval(S.meterTimer);
    S.meterTimer = null;
  }
}

// v34: анти-перегрев — цикл анализатора работает в 3.5 раза реже (220 мс вместо 65 мс),
// останавливается при выходе из звонка/лобби, не крутит FFT и перерисовку DOM при
// заблокированном экране звонка (callLocked) или скрытой вкладке, если не нужен VAD/мост.
function startMeterLoop() {
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

function toggleMicTest(btnEl) {
  const ctx = ensureAudioEngine();
  if (!ctx || !S.gateGainNode) return;
  S.testingMic = !S.testingMic;
  try {
    if (S.testingMic) {
      S.gateGainNode.connect(ctx.destination);
      toast('Проверка микрофона включена — говорите');
    } else {
      S.gateGainNode.disconnect(ctx.destination);
    }
  } catch {}
  paintMicTest();
  if (btnEl) btnEl.setAttribute('aria-pressed', String(S.testingMic));
}
function paintMicTest() {
  const labels = { '#pTestMic': ['Проверить микрофон', 'Стоп тест'], '#sTestMic': ['Проверить', 'Стоп'] };
  for (const [id, [idle, active]] of Object.entries(labels)) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle('active-test', S.testingMic);
    b.setAttribute('aria-pressed', String(S.testingMic));
    const lbl = b.querySelector('.lbl');
    if (lbl) lbl.textContent = S.testingMic ? active : idle;
    setBtnIcon(b, S.testingMic ? 'i-stop' : 'i-volume');
  }
}
function stopMicTest() {
  if (!S.testingMic) return;
  S.testingMic = false;
  try {
    S.gateGainNode?.disconnect(S.audioCtx.destination);
  } catch {}
  paintMicTest();
}

// ---------- Медиа и переключение устройств ----------
const audioC = () => ({
  deviceId: S.dev.mic ? { ideal: S.dev.mic } : undefined,
  echoCancellation: S.audio.echo,
  noiseSuppression: S.audio.noise,
  autoGainControl: S.audio.agc,
});
// v37: разрешение захвата — по классу устройства и его нагрузке (media-policy.js).
// «Авто» (по умолчанию): компьютер 1080p@30 (стандарт владельца v34), телефон
// 720p@30, слабый телефон 480p@24; ручной выбор в настройках — потолок.
// Эко-режим (только вручную) — не выше 720p@24. Перегрузка процессора,
// перегрев и низкий заряд снижают ступень сами (adaptLoad), сеть — adaptQuality.
const loadOpts = () => ({
  eco: !!S.ecoMode,
  cpu: S.load.cpu,
  battLow: S.load.battLow,
  pressure: S.load.pressure,
});
const videoC = (forceFacing = false) => {
  const t = (S.capTier = captureTier(S.vq, S.devClass, loadOpts()));
  const base = tierConstraints(t);
  if (!forceFacing && S.dev.cam) {
    return { ...base, deviceId: { exact: S.dev.cam } };
  }
  return { ...base, facingMode: { ideal: S.facingMode || 'user' } };
};

function stopLocal() {
  stopMicTest();
  stopMeterLoop();
  if (S.rawAudioTrack) {
    try { S.rawAudioTrack.stop(); } catch {}
    S.rawAudioTrack = null;
  }
  S.local.getTracks().forEach((t) => {
    if (!isProcTrack(t)) t.stop(); // v40: обработанный трек живёт всю сессию
    S.local.removeTrack(t);
  });
}
function localTrack(kind) {
  return S.local.getTracks().find((t) => t.kind === kind) || null;
}

async function getTrack(kind) {
  try {
    const st = await navigator.mediaDevices.getUserMedia(
      kind === 'audio' ? { audio: audioC() } : { video: videoC() }
    );
    return st.getTracks()[0];
  } catch (e) {
    console.warn(kind, e);
    return null;
  }
}

async function startLocal() {
  stopLocal();
  let st = null;
  try {
    st = await navigator.mediaDevices.getUserMedia({
      audio: audioC(),
      video: S.camOn ? videoC() : false,
    });
  } catch {
    try {
      st = await navigator.mediaDevices.getUserMedia({ audio: audioC() });
      toast('Камера недоступна — включён аудио-режим');
    } catch {
      toast('Нет доступа к микрофону и камере');
    }
  }
  if (st) {
    for (const t of st.getTracks()) {
      if (t.kind === 'audio') {
        const proc = attachMicToEngine(t);
        proc.enabled = S.micOn && !S.deafened;
        S.local.addTrack(proc);
      } else {
        S.local.addTrack(t);
      }
    }
  }
  if (!localTrack('video')) S.camOn = false;
  syncAudioParams();
  await fillDevices();
}

async function fillDevices(prefix = 'p') {
  const list = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const fill = (sel, kind, cur) => {
    if (!sel) return;
    sel.replaceChildren(
      ...list
        .filter((d) => d.kind === kind)
        .map((d, i) => {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || `${kind === 'audioinput' ? 'Микрофон' : kind === 'videoinput' ? 'Камера' : 'Динамик'} ${i + 1}`;
          return o;
        })
    );
    if (cur) sel.value = cur;
  };
  const a = S.rawAudioTrack?.getSettings().deviceId || localTrack('audio')?.getSettings().deviceId;
  const v = localTrack('video')?.getSettings().deviceId;
  if (prefix === 'p') {
    fill($('#pMicSel'), 'audioinput', a);
    fill($('#pCamSel'), 'videoinput', v);
  } else {
    fill($('#sMic'), 'audioinput', a);
    fill($('#sCam'), 'videoinput', v);
    fill($('#sSpk'), 'audiooutput', S.dev.spk);
  }
}

async function setSendTrack(kind, track) {
  S.groupHook?.refreshTracks?.();
  if (!S.pc) return;
  const tr = S.pc.getTransceivers().find((t) => !t.stopped && t.receiver.track?.kind === kind);
  if (tr) {
    await tr.sender.replaceTrack(track);
    if (track && (tr.direction === 'recvonly' || tr.direction === 'inactive')) tr.direction = 'sendrecv';
    try {
      tr.sender.setStreams?.(S.local);
    } catch {}
  } else if (track) {
    S.pc.addTrack(track, S.local);
  }
}

async function switchDevice(kind, id) {
  if (kind === 'mic') S.dev.mic = localStorage.zvMic = id;
  else S.dev.cam = localStorage.zvCam = id;
  const k = kind === 'mic' ? 'audio' : 'video';
  if (k === 'video' && (!S.camOn || S.screenTrack)) return;
  const old = localTrack(k);
  const raw = await getTrack(k);
  if (!raw) return toast('Не удалось переключить устройство');
  if (k === 'audio' && S.rawAudioTrack && S.rawAudioTrack !== raw) {
    try { S.rawAudioTrack.stop(); } catch {}
  }
  if (old) {
    if (!isProcTrack(old)) old.stop(); // v40: см. liveProcTrack()
    S.local.removeTrack(old);
  }
  const finalTrack = k === 'audio' ? attachMicToEngine(raw) : raw;
  if (k === 'audio') finalTrack.enabled = S.micOn && !S.deafened;
  S.local.addTrack(finalTrack);
  await setSendTrack(k, finalTrack);
  refreshLocalView();
}

async function toggleMic() {
  S.micOn = !S.micOn;
  if (S.micOn && S.deafened) S.deafened = false;
  let a = localTrack('audio');
  if (!a && S.micOn) {
    const raw = await getTrack('audio');
    if (raw) {
      a = attachMicToEngine(raw);
      S.local.addTrack(a);
      await setSendTrack('audio', a);
    } else S.micOn = false;
  }
  if (a) a.enabled = S.micOn && !S.deafened;
  syncAudioParams();
  syncButtons();
  sendCtrl({ t: 'state', mic: S.micOn, cam: S.camOn || !!S.screenTrack });
}

function toggleDeafen() {
  S.deafened = !S.deafened;
  const a = localTrack('audio');
  if (a) a.enabled = S.micOn && !S.deafened;
  syncAudioParams();
  syncButtons();
  toast(S.deafened ? 'Звук и микрофон отключены (Deafen)' : 'Звук включён');
}

async function toggleCam() {
  S.camOn = !S.camOn;
  if (!S.screenTrack) {
    const old = localTrack('video');
    if (!S.camOn && old) {
      old.stop();
      S.local.removeTrack(old);
      await setSendTrack('video', null);
    }
    if (S.camOn) {
      const t = await getTrack('video');
      if (t) {
        S.local.addTrack(t);
        await setSendTrack('video', t);
      } else {
        S.camOn = false;
        toast('Камера недоступна');
      }
    }
  }
  refreshLocalView();
  syncButtons();
  sendCtrl({ t: 'state', mic: S.micOn, cam: S.camOn || !!S.screenTrack });
}

async function toggleScreen() {
  if (S.screenTrack) return stopScreen();
  try {
    const st = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    S.screenTrack = st.getVideoTracks()[0];
    S.screenTrack.contentHint = 'detail';
    S.screenTrack.onended = stopScreen;
    const cam = localTrack('video');
    if (cam) {
      cam.stop();
      S.local.removeTrack(cam);
    }
    await setSendTrack('video', S.screenTrack);
    $('#local').srcObject = new MediaStream([S.screenTrack]);
    $('#local').classList.add('screen');
    syncButtons();
    sendCtrl({ t: 'state', mic: S.micOn, cam: true });
  } catch (e) {
    console.warn(e);
  }
}
async function stopScreen() {
  if (!S.screenTrack) return;
  S.screenTrack.onended = null;
  S.screenTrack.stop();
  S.screenTrack = null;
  $('#local').classList.remove('screen');
  let t = null;
  if (S.camOn) {
    t = await getTrack('video');
    if (t) S.local.addTrack(t);
    else S.camOn = false;
  }
  await setSendTrack('video', t);
  refreshLocalView();
  syncButtons();
  sendCtrl({ t: 'state', mic: S.micOn, cam: S.camOn });
}

function refreshLocalView() {
  const v = localTrack('video');
  const settings = v?.getSettings?.() || {};
  // Определяем, задняя ли это камера: по настройке трека или нашему S.facingMode
  const isRear = !S.screenTrack && (settings.facingMode === 'environment' || (!settings.facingMode && S.facingMode === 'environment'));
  for (const el of [$('#preview'), $('#local')]) {
    if (!el) continue;
    if (el.id === 'local' && S.screenTrack) continue;
    el.srcObject = v ? new MediaStream([v]) : null;
    // v34: зеркалим только фронтальную камеру; заднюю камеру показывать зеркально нельзя!
    el.classList.toggle('rear-cam', isRear);
  }
  $('#previewOff')?.classList.toggle('hidden', !!v);
  $('#local')?.classList.toggle('hidden', !v && !S.screenTrack);
}

// v34: Полноценный свап фронтальной и задней камеры (Android / iOS / ноутбуки с 2 камерами)
let flippingCam = false;
async function flipCamera() {
  if (flippingCam) return;
  if (S.screenTrack) return toast('Сначала остановите демонстрацию экрана');
  flippingCam = true;
  try {
    const nextFacing = S.facingMode === 'environment' ? 'user' : 'environment';
    S.facingMode = nextFacing;
    try { localStorage.zvFacing = nextFacing; } catch {}
    // Сбрасываем жёстко привязанный deviceId, чтобы браузер переключил объектив по facingMode
    const prevTrack = localTrack('video');
    const prevDevId = prevTrack?.getSettings?.().deviceId || S.dev.cam || '';
    S.dev.cam = '';
    try { localStorage.removeItem('zvCam'); } catch {}

    // Если камера была выключена — включаем её сразу на выбранной стороне
    if (!S.camOn) S.camOn = true;

    // На многих Android-устройствах второй объектив не открывается, пока старый видео-трек не остановлен!
    if (prevTrack) {
      prevTrack.stop();
      S.local.removeTrack(prevTrack);
    }

    let newTrack = null;
    // Попытка 1: через facingMode (exact -> ideal)
    try {
      const st = await navigator.mediaDevices.getUserMedia({
        video: { ...videoC(true), facingMode: { exact: nextFacing } },
      });
      newTrack = st.getVideoTracks()[0];
    } catch {
      try {
        const st = await navigator.mediaDevices.getUserMedia({
          video: videoC(true),
        });
        newTrack = st.getVideoTracks()[0];
      } catch {}
    }

    // Попытка 2: если браузер вернул тот же самый объектив (бывает в некоторых WebView на Android),
    // перебираем список видеокамер enumerateDevices() и выбираем следующую
    const allDevs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const videoDevs = allDevs.filter((d) => d.kind === 'videoinput');
    if (newTrack && prevDevId && newTrack.getSettings?.().deviceId === prevDevId && videoDevs.length > 1) {
      newTrack.stop();
      newTrack = null;
    }
    if (!newTrack && videoDevs.length > 0) {
      const wantBack = nextFacing === 'environment';
      const byLabel = videoDevs.find((d) =>
        wantBack ? /back|rear|environment|задн|тыл/i.test(d.label) : /front|user|selfie|фронт|передн/i.test(d.label)
      );
      const curIdx = videoDevs.findIndex((d) => d.deviceId === prevDevId);
      const targetDev = byLabel && byLabel.deviceId !== prevDevId
        ? byLabel
        : videoDevs[(curIdx + 1) % videoDevs.length];
      if (targetDev) {
        try {
          const st = await navigator.mediaDevices.getUserMedia({
            video: { ...videoC(true), facingMode: undefined, deviceId: { exact: targetDev.deviceId } },
          });
          newTrack = st.getVideoTracks()[0];
          S.dev.cam = targetDev.deviceId;
        } catch {}
      }
    }

    if (!newTrack) {
      toast('Не удалось переключить камеру');
      S.camOn = false;
      syncButtons();
      refreshLocalView();
      return;
    }

    const actualFacing = newTrack.getSettings?.().facingMode;
    if (actualFacing === 'user' || actualFacing === 'environment') {
      S.facingMode = actualFacing;
      try { localStorage.zvFacing = actualFacing; } catch {}
    }

    S.local.addTrack(newTrack);
    await setSendTrack('video', newTrack);
    refreshLocalView();
    syncButtons();
    await fillDevices();
    await fillDevices('s');
    applyQuality();
    toast(S.facingMode === 'environment' ? '📷 Включена задняя камера' : '🤳 Включена фронтальная камера');
  } finally {
    flippingCam = false;
  }
}
function syncButtons() {
  const micOff = !S.micOn || S.deafened;
  for (const id of ['#pMic', '#cMic']) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle('off', micOff);
    b.setAttribute('aria-pressed', String(!micOff));
    b.title = micOff ? 'Микрофон выключен' : 'Микрофон включён';
    setBtnIcon(b, micOff ? 'i-mic-off' : 'i-mic');
  }
  for (const id of ['#pCam', '#cCam']) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle('off', !S.camOn);
    b.setAttribute('aria-pressed', String(S.camOn));
    b.title = S.camOn ? 'Камера включена' : 'Камера выключена';
    setBtnIcon(b, S.camOn ? 'i-cam' : 'i-cam-off');
  }
  const deaf = $('#cDeaf');
  if (deaf) {
    deaf.classList.toggle('off', S.deafened);
    deaf.setAttribute('aria-pressed', String(S.deafened));
    setBtnIcon(deaf, S.deafened ? 'i-headphones-off' : 'i-headphones');
  }
  const scr = $('#cScreen');
  if (scr) {
    scr.classList.toggle('on', !!S.screenTrack);
    scr.setAttribute('aria-pressed', String(!!S.screenTrack));
    setBtnIcon(scr, S.screenTrack ? 'i-stop' : 'i-screen');
  }
}

// ---------- Управление Рацией (Push-To-Talk: кнопка + клавиша Пробел) ----------
function setPtt(active) {
  if (S.pttPressed === active) return;
  S.pttPressed = active;
  const btn = $('#cPtt');
  if (btn) {
    btn.classList.toggle('tx', active);
    btn.setAttribute('aria-pressed', String(active));
    const lbl = $('#pttLabel');
    if (lbl) lbl.textContent = active ? 'Передача речи…' : 'Держите для речи';
  }
  if (active && navigator.vibrate) navigator.vibrate(18);
}
const pttBtn = $('#cPtt');
if (pttBtn) {
  pttBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setPtt(true);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    pttBtn.addEventListener(ev, () => setPtt(false))
  );
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && S.joined && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    if (S.audio.inputMode === 'ptt' || S.bridgeActive) {
      e.preventDefault();
      setPtt(true);
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && S.pttPressed) {
    setPtt(false);
  }
});

// ---------- Экран подготовки (Лобби) ----------
async function preJoin() {
  show('prejoin');
  // v38: звонок из чата — имя в звонке = ник этого чата (не сохраняется
  // глобально: у разных чатов могут быть разные ники, анонимность).
  $('#name').value = S.callNameOverride || localStorage.zvName || '';
  $('#name').placeholder = S.callNameOverride || myAnon();
  $('#link').value = roomLink();
  $('#callOwnerBox')?.classList.toggle('hidden', !S.linkFp || (S.personal && S.secret === S.personal.secret));
  $('#qr').classList.add('hidden');
  $('#btnShare').classList.toggle('hidden', !navigator.share);
  syncAudioParams();
  if (!window.isSecureContext || !navigator.mediaDevices) {
    $('#preMsg').textContent = 'Нужен HTTPS-адрес для доступа к микрофону.';
    return;
  }
  await startLocal();
  refreshLocalView();
  syncButtons();
  if (S.autoJoinPending) {
    S.autoJoinPending = false;
    join();
  } else if (S.autoCallPending) {
    // v38: «Позвонить» из контактов/журнала — сразу дозвон владельцу ссылки.
    S.autoCallPending = false;
    if (S.linkFp && !(S.personal && S.secret === S.personal.secret)) startOutgoingCall();
  }
}
$('#nameDice') &&
  ($('#nameDice').onclick = () => {
    const n = randomAnonName();
    $('#name').value = n;
    if (!S.callNameOverride) {
      try {
        localStorage.zvAnonName = n;
      } catch {}
    }
  });
$('#pMic').onclick = toggleMic;
$('#pCam').onclick = toggleCam;
$('#pFlipCam') && ($('#pFlipCam').onclick = flipCamera);
$('#cFlipCam') && ($('#cFlipCam').onclick = flipCamera);
$('#local') && ($('#local').onclick = () => {
  if (!S.screenTrack && S.camOn) flipCamera();
});
$('#pTestMic').onclick = () => toggleMicTest($('#pTestMic'));
$('#pOpenSettings').onclick = openSettingsModal;
$('#pMicSel').onchange = (e) => switchDevice('mic', e.target.value);
$('#pCamSel').onchange = (e) => switchDevice('cam', e.target.value);
$('#pMicVol').oninput = (e) => {
  S.audio.micVol = Number(e.target.value);
  syncAudioParams();
};
$('#pPeerVol').oninput = (e) => {
  S.audio.peerVol = Number(e.target.value);
  syncAudioParams();
};
$('#btnCopy').onclick = () => copy(roomLink());
$('#btnShare').onclick = () =>
  navigator.share({ title: 'ZVONochek', text: 'Заходи в защищённый звонок:', url: roomLink() }).catch(() => {});
$('#btnQr').onclick = () => {
  const q = $('#qr');
  q.classList.toggle('hidden');
  renderQr(q, roomLink());
};
$('#btnJoin').onclick = join;

// ---------- Вход в звонок и загрузка ICE/STUN/TURN ----------
async function fetchJson(url, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } finally {
    clearTimeout(t);
  }
}
const isTurn = (s) => [].concat(s?.urls || []).some((u) => /^turns?:/.test(u));

// v38: статический TURN из config.js — КРАЙНЕЕ средство (решение владельца:
// беречь бесплатные лимиты). Старт звонка — только STUN (direct); TURN
// добавляется лестницей ensureTurnLoaded: direct не встал за 6 с, ICE failed,
// смена сети без direct или ручной режим «только TURN». Пока прямой путь
// работает, к TURN-серверам нет даже аллокаций.
const staticTurn = () => (CONFIG.EXTRA_ICE_SERVERS || []).filter(isTurn);

async function loadIce() {
  const servers = [{ urls: CONFIG.STUN }];
  const st = staticTurn();
  S.stunOnlyIce = servers;
  S.baseIce = servers;
  S.turnLoaded = false;
  S.turnDyn = false;
  S.hasTurn = false;
  S.turnInfo = st.length
    ? `TURN в резерве: ${st.length} ${plural(st.length, 'сервер', 'сервера', 'серверов')} из config — включится, только если прямой путь не встанет`
    : 'TURN не запрашивался (экономия квоты)';
  return S.baseIce;
}

// TURN по требованию: свой Worker (/turn, если в нём настроены секреты TURN),
// динамический Metered API (CONFIG.METERED) и статический TURN из config.js.
// Вызывается только из лестницы ensureTurnLoaded — не на старте звонка.
async function fetchTurnServers() {
  const out = [];
  const info = [];
  const jobs = [];
  if (getWorkerBase()) {
    jobs.push(
      fetchJson(getWorkerBase().replace(/\/$/, '') + '/turn')
        .then((j) => {
          const l = (j?.iceServers || []).filter(isTurn);
          out.push(...l);
          info.push(l.length ? 'Worker TURN: есть' : 'Worker: без TURN (только сигнал)');
        })
        .catch(() => info.push('Worker: офлайн'))
    );
  }
  const M = CONFIG.METERED;
  if (M?.domain && M?.apiKey) {
    jobs.push(
      fetchJson(`https://${M.domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(M.apiKey)}`)
        .then((j) => {
          const l = []
            .concat(j || [])
            .filter(isTurn)
            .map((sv) => ({ ...sv, urls: [].concat(sv.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
          out.push(...l);
          info.push(l.length ? 'Metered: есть' : 'Metered: пусто');
        })
        .catch(() => info.push('Metered недоступен'))
    );
  }
  await Promise.all(jobs);
  S.turnDyn = out.length > 0;
  const stat = staticTurn();
  if (stat.length) {
    out.push(...stat);
    info.push('статический из config: есть');
  }
  S.turnInfo = info.join(', ') || 'источники TURN не настроены';
  return out;
}

// Ленивая догрузка TURN: вызываем, только когда direct не встал вовремя,
// соединение упало или пользователь сам выбрал режим «только TURN».
// Звук в этот момент уже держит мост, поэтому медленный подъём TURN
// не создаёт тишины. Повторные вызовы безопасны.
async function ensureTurnLoaded(reason = '') {
  if (S.audio.netMode === 'bridge') return false; // v40: «только мост» — без TURN по определению
  if (S.turnLoaded || S.turnLoading) return S.hasTurn;
  S.turnLoading = true;
  try {
    const turn = await fetchTurnServers();
    if (!turn.length) {
      S.turnLoaded = true; // не дёргаем источники впустую каждый раз
      log('TURN недоступен (' + S.turnInfo + ') — остаёмся на direct + мост');
      return false;
    }
    S.turnLoaded = true;
    S.hasTurn = true;
    const next = [...(S.stunOnlyIce || [{ urls: CONFIG.STUN }]), ...turn];
    // Тот же набор уже в ICE (повторная эскалация) — ICE не перезапускаем:
    // это сбросило бы идущие проверки relay-пар.
    if (JSON.stringify(next) === JSON.stringify(S.ice || [])) return true;
    S.ice = next;
    if (S.pc) {
      try {
        S.pc.setConfiguration(mainPcConfig());
        S.pc.restartIce();
      } catch {}
    }
    log('Лениво добавлен TURN (' + (reason || 'по требованию') + '): ' + S.turnInfo);
    return true;
  } finally {
    S.turnLoading = false;
  }
}

const pcConfig = () => ({
  iceServers: S.ice,
  iceTransportPolicy: S.audio.netMode === 'relay' && S.hasTurn ? 'relay' : 'all',
  bundlePolicy: 'max-bundle',
  // Предсбор кандидатов до offer. С max-bundle нужен ровно один набор:
  // после эскалации на TURN каждый лишний набор — лишние relay-аллокации.
  iceCandidatePoolSize: 1,
});
// v40: «Только мост» обещает скрыть IP (README), но основной PC собирался с
// policy 'all' и рассылал host/srflx-кандидаты — собеседник видел ваш IP, а
// при живом P2P голос шёл дважды (P2P + мост, мост с задержкой = эхо).
// В режиме моста основной 1:1 PC живёт без ICE-серверов и с policy 'relay':
// кандидатов нет, IP не уходит, голос — только мостом. В групповом звонке
// моста нет, поэтому там (и в mesh из group.js) — обычный pcConfig().
const mainPcConfig = () =>
  S.audio.netMode === 'bridge' && rosterCount() <= 1
    ? { ...pcConfig(), iceServers: [], iceTransportPolicy: 'relay' }
    : pcConfig();

// Ручная настройка Opus в SDP — ТОЛЬКО если пользователь сам включил её в
// настройках (opusTune). По умолчанию SDP не трогаем: браузерный Opus и так
// включает FEC по ситуации и подбирает битрейт лучше фиксированных 24 кбит/с.
// DTX не включаем даже в ручном режиме: usedtx=1 вместе с VAD-гейтом резал
// тихий голос и «съедал» первые слова после паузы в долгих разговорах.
function tuneOpusSdp(sdp) {
  if (!sdp || !S.audio.opusTune) return sdp;
  const bps = (S.audio.bitrate || 48) * 1000;
  return sdp.replace(/a=fmtp:(\d+) (.*)/g, (full, pt, params) => {
    if (!sdp.includes(`a=rtpmap:${pt} opus/48000`)) return full;
    const clean = params
      .split(';')
      .filter((kv) => !/^(useinbandfec|usedtx|maxaveragebitrate|cbr)=/.test(kv.trim()))
      .join(';');
    return `a=fmtp:${pt} ${clean};useinbandfec=1;usedtx=0;cbr=0;maxaveragebitrate=${bps}`;
  });
}

async function join() {
  stopMicTest();
  ensureAudioEngine();
  $('#btnJoin').disabled = true;
  if (S.callNameOverride) S.callNameOverride = $('#name').value.trim() || S.callNameOverride;
  else localStorage.zvName = $('#name').value.trim();
  syncLocal();
  try {
    [S.ice, S.room] = await Promise.all([loadIce(), deriveRoom(S.secret)]);
  } catch {
    $('#btnJoin').disabled = false;
    return toast('Неверная ссылка');
  }
  if (S.audio.netMode === 'relay') await ensureTurnLoaded('режим «только TURN» из прошлых настроек');
  S.joined = true;
  show('call');
  refreshLocalView();
  syncButtons();
  syncAudioParams();
  $('#cScreen').classList.toggle('hidden', !navigator.mediaDevices.getDisplayMedia);
  $('#remote').srcObject = S.remote;
  if (S.dev.spk) $('#remote').setSinkId?.(S.dev.spk).catch(() => {});

  S.sig = new Signaling({
    topic: S.room.topic,
    key: S.room.key,
    selfId,
    inst,
    brokers: CONFIG.MQTT_BROKERS,
    workerUrl: getWorkerBase(),
    relays: CONFIG.NOSTR_RELAYS,
    ntfyBase: CONFIG.NTFY_BASE,
    onMessage: onSignal,
    onStatus: (st) => {
      S.sigStatus = st;
      updateStatus();
    },
    onPeerJoined: () => {
      // Воркер сообщил, что второй участник открыл комнату — мгновенно шлём приветствие!
      hello();
    },
  });
  S.sig.onTransportUp = () => {
    hello();
    if (!S.peer) progress(25, 'Каналы сигнала активны, ждём собеседника');
  };
  log(
    `Вход в комнату. Сигнал: MQTT (${CONFIG.MQTT_BROKERS.length}), ${
      getWorkerBase() ? 'Worker (WS+HTTP), ' : ''
    }Nostr (${CONFIG.NOSTR_RELAYS.length})${CONFIG.NTFY_BASE ? ', ntfy' : ''}; TURN: ${S.hasTurn ? 'есть' : 'нет'} (${S.turnInfo || '—'})`
  );
  progress(10, 'Подключение к каналам сигналинга…');
  S.sig.start();
  S.joinedAt = Date.now();
  // v37: ступени нагрузки — заново на каждый звонок; заряд и перегрев — живые.
  Object.assign(S.load, { cpu: 0, cpuHits: 0, cpuCalm: 0, cpuLock: false, cpuBackAt: 0, cpuToast: false });
  watchDeviceLoad();
  reapplyMediaLoad();
  // TURN-креды Worker живут 6 часов: в долгом звонке обновляем ICE-серверы
  // каждый час, иначе после истечения TTL первое же переподключение ICE
  // теряет relay-путь и звонок умирает «сам по себе».
  clearInterval(S.iceRefreshTimer);
  S.iceRefreshTimer = setInterval(async () => {
    if (!S.joined || !S.turnLoaded || !S.turnDyn) return; // статическому TURN обновлять нечего
    const turn = await fetchTurnServers().catch(() => null);
    if (!turn || !turn.length || !S.joined) return;
    S.ice = [...(S.stunOnlyIce || [{ urls: CONFIG.STUN }]), ...turn];
    if (S.pc) {
      try { S.pc.setConfiguration(mainPcConfig()); } catch {}
      log('TURN-креды обновлены (профилактика истечения TTL)');
    }
  }, 60 * 60 * 1000);
  S.helloTimer = setInterval(() => {
    if (!S.pc || (S.pc.connectionState !== 'connected' && !S.bridgeActive)) hello();
    if (!S.peer && !S.waitHinted && Date.now() - S.joinedAt > 25000) {
      S.waitHinted = true;
      log('Собеседник пока не найден. Если он уже открыл ссылку — попросите его обновить страницу');
      $('#waitText').textContent =
        'Собеседник пока не найден. Если он уже в звонке — попросите его обновить страницу';
    }
  }, 4500);
  try {
    S.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
  setupMediaSession();
  updateStatus();
  $('#btnJoin').disabled = false;
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Защищённый звонок ZVONochek',
      artist: S.peer?.name || 'На связи',
    });
    navigator.mediaSession.setActionHandler('hangup', () => hangup());
  } catch {}
}

// v38: без введённого имени — постоянное анонимное «Тихий Маяк» (одно на
// устройство; 🎲 в лобби — другое). Раньше — безликое «Гость».
function myAnon() {
  let n = '';
  try {
    n = localStorage.zvAnonName || '';
    if (!n) localStorage.zvAnonName = n = randomAnonName();
  } catch {
    n = n || randomAnonName();
  }
  return n;
}
const myName = () => S.callNameOverride || localStorage.zvName || myAnon();
const webCodecsBridgeSupported = () =>
  typeof AudioEncoder !== 'undefined' &&
  typeof AudioDecoder !== 'undefined' &&
  typeof MediaStreamTrackProcessor !== 'undefined';
// v40: «у меня только мост» — собеседник не тратит попытки P2P и TURN на
// соединение, которое мы сами не поднимем (наш PC без кандидатов, см.
// mainPcConfig). Старые версии поле просто игнорируют.
const bridgeOnlyFlag = () => (S.audio.netMode === 'bridge' ? 1 : undefined);

function hello() {
  // bc: умеем ли мы в мост 2.0 (WebCodecs) — собеседник выберет формат под нас
  // vc: 'h264' — нам выгоден аппаратный H.264 (собеседник поставит его первым)
  S.sig?.send({ type: 'hello', name: myName(), ver: APP_VERSION, bc: webCodecsBridgeSupported() ? 1 : 0, vc: S.hwPref || undefined, br: bridgeOnlyFlag() });
}

// ---------- Аварийный Аудио-Мост через Сигналинг (работает вообще без TURN и без UDP!) ----------
function activateBridge(reason = 'Активирован аудио-мост через сигналинг') {
  if (!S.peer || S.bridgeActive) return;
  if (rosterCount() > 1) {
    log('Мост недоступен в групповом звонке (3+ участника)');
    return;
  }
  S.bridgeActive = true;
  S.bridgeNextPlayTime = 0;
  clearTimeout(S.bridgeAutoTimer);
  log(reason);
  toast('Включён мост без TURN: голос идёт через зашифрованный сигнал', 5000);
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

function stopBridge() {
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

function getSupportedAudioMime() {
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
function startBridgeRecorder() {
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

function startBridge2() {
  stopBridge2();
  const track = liveProcTrack();
  if (!track) return false;
  const sampleRate = track.getSettings?.().sampleRate || 48000;
  const st = { running: true, sampleRate, frames: [], flushTimer: null, enc: null, reader: null };
  S.bridge2 = st;
  try {
    st.enc = new AudioEncoder({
      output: (chunk) => {
        try {
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(buf);
          st.frames.push(new Uint8Array(buf));
        } catch {}
      },
      error: (e) => {
        console.warn('bridge2 enc', e);
        if (S.bridgeActive) {
          stopBridge2();
          S.bridgeMode = 'mediarecorder';
          startBridgeRecorderV1();
        }
      },
    });
    st.enc.configure({ codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 24000 });
    const processor = new MediaStreamTrackProcessor({ track });
    st.reader = processor.readable.getReader();
    st.flushTimer = setInterval(flushBridge2Frames, 120);
    (async () => {
      try {
        while (st.running) {
          const { value, done } = await st.reader.read();
          if (done) break;
          if (!value) continue;
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

function flushBridge2Frames() {
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
    { type: 'voice2', to: S.peer.id, toInst: S.peer.inst, sr: st.sampleRate, b64: b64u.enc(out), _noZip: true },
    { voice: true }
  );
}

function stopBridge2() {
  const st = S.bridge2;
  if (!st) return;
  st.running = false;
  clearInterval(st.flushTimer);
  try { st.reader?.cancel(); } catch {}
  try { st.enc?.close(); } catch {}
  if (S.bridge2 === st) S.bridge2 = null;
}

function ensureBridgeDecoder(sr) {
  const ctx = ensureAudioEngine();
  if (!ctx || typeof AudioDecoder === 'undefined') return null;
  let d = S.bridgeDec;
  if (d && d.sampleRate === sr && d.dec.state !== 'closed') return d;
  if (d) {
    try { d.dec.close(); } catch {}
  }
  d = S.bridgeDec = { sampleRate: sr, nextPlay: 0, ts: 0, dec: null };
  d.dec = new AudioDecoder({
    output: (data) => {
      try { scheduleDecodedBridgeFrame(data); } catch {}
      try { data.close(); } catch {}
    },
    error: (e) => console.warn('bridge2 dec', e),
  });
  d.dec.configure({ codec: 'opus', sampleRate: sr, numberOfChannels: 1 });
  return d;
}

function scheduleDecodedBridgeFrame(data) {
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

async function playBridgeVoice2(m) {
  if (S.deafened || !m.b64) return;
  if (typeof AudioDecoder === 'undefined') return; // мы бы и не заявили bc=1
  if (!S.bridgeActive && S.pc?.connectionState !== 'connected') {
    activateBridge('Получен голос WebCodecs от собеседника по мосту 2.0');
  }
  S.bridgeSpeakingUntil = Date.now() + 400;
  $('#peerAvatarRing')?.classList.add('speaking');
  const d = ensureBridgeDecoder(m.sr || 48000);
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

function startBridgeRecorderV1() {
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

async function playBridgeVoice(m) {
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

$('#btnForceBridge').onclick = () => {
  if (!S.peer) return toast('Дождитесь подключения собеседника к комнате');
  activateBridge('Мост без TURN включён вручную');
};

// ---------- Обработка сигналинга и ускоренное рукопожатие ----------
const stats = (() => {
  try {
    return JSON.parse(localStorage.zvStats) || { tries: 0, ok: 0 };
  } catch {
    return { tries: 0, ok: 0 };
  }
})();
const saveStats = () => {
  localStorage.zvStats = JSON.stringify(stats);
};
// Счётчики маршрутов за всё время: видно, как часто реально нужен TURN.
const routeStats = (() => {
  try {
    return JSON.parse(localStorage.zvRoutes) || { direct: 0, relay: 0, bridge: 0 };
  } catch {
    return { direct: 0, relay: 0, bridge: 0 };
  }
})();
function countRoute(kind) {
  routeStats[kind] = (routeStats[kind] || 0) + 1;
  try {
    localStorage.zvRoutes = JSON.stringify(routeStats);
  } catch {}
}
const viaName = (v) =>
  ({ mqtt: 'MQTT', worker: 'Worker WS', 'worker-http': 'Worker HTTP', nostr: 'Nostr' }[v] || v);
const to = () => ({ to: S.peer.id, toInst: S.peer.inst, gen: S.gen });

const MAX_REMOTE_PEERS = 5; // комната: я + основной собеседник + до 4 групповых (mesh)
const groupVerWarned = new Set(); // inst участников, которым уже показали предупреждение о версии
function rosterCount() {
  const now = Date.now();
  let n = 0;
  for (const [k, v] of S.roster) {
    if (now - v.seen > 90000) S.roster.delete(k);
    else n++;
  }
  return n;
}

async function onSignal(m) {
  if (S.dead.has(m.inst)) return;
  S.via[m.via] = (S.via[m.via] || 0) + 1;
  // Ростер комнаты: запоминаем всех, кого слышим (нужно для группового режима,
  // группового чата и отключения моста при 3+ участниках).
  if (m.from && m.inst && m.from !== selfId) {
    const prev = S.roster.get(m.inst);
    S.roster.set(m.inst, { id: m.from, name: m.name || prev?.name || 'Участник', seen: Date.now() });
    if (S.bridgeActive && rosterCount() > 1) {
      log('В комнате больше двух участников — мост отключён (групповой режим)');
      stopBridge();
      if (S.audio.netMode === 'bridge' && S.pc) {
        // v40: в режиме моста основной PC жил без кандидатов, а в группе
        // моста нет — возвращаем обычный ICE, иначе основной собеседник онемеет.
        try {
          S.pc.setConfiguration(mainPcConfig());
          restartIce();
        } catch {}
        toast('Групповой звонок: моста нет — соединение напрямую, ваш IP виден участникам', 6000);
      }
    }
  }
  // Групповой трафик: сообщения не от основного собеседника уходят в group.js.
  const isPrimaryPeer = S.peer && S.peer.id === m.from && S.peer.inst === m.inst;
  const primaryStale =
    S.peer && !isPrimaryPeer && S.pc?.connectionState !== 'connected' && !S.bridgeActive && Date.now() - S.peer.seen > 30000;
  if (S.peer && !isPrimaryPeer && !primaryStale && ['hello', 'hi', 'g_hi', 'g_desc', 'g_cand', 'desc', 'cand'].includes(m.type)) {
    if ((m.type === 'hello' || m.type === 'hi') && m.ver && m.ver !== APP_VERSION && !groupVerWarned.has(m.inst)) {
      groupVerWarned.add(m.inst);
      log(`Участник ${m.name || ''} на версии v${m.ver}, у вас v${APP_VERSION} — для групповых звонков лучше обновиться всем`);
    }
    if (m.type === 'hello' && !S.roster.has(m.inst)) return;
    if (m.type === 'hello' && rosterCount() > MAX_REMOTE_PEERS) {
      S.sig?.send({ type: 'full', to: m.from, toInst: m.inst });
      return;
    }
    S.groupHook?.onSignal?.(m);
    return;
  }
  // Рассинхрон ролей при одновременном входе троих: собеседник может считать
  // нас «лишним» и говорить групповым протоколом (g_desc/g_cand) с нами как
  // с основным — переводим в основной протокол и обрабатываем как обычно.
  if (isPrimaryPeer && (m.type === 'g_desc' || m.type === 'g_cand')) {
    noteGDialect();
    m = { ...m, type: m.type === 'g_desc' ? 'desc' : 'cand' };
  }
  // (v18: обратный перевод не нужен — group.js говорит и понимает desc/cand.)
  switch (m.type) {
    case 'hello':
    case 'hi':
      if (!acceptPeer(m)) return;
      if (S.peer && typeof m.bc === 'number') S.peer.bridgeCodecs = !!m.bc;
      if (S.peer) S.peer.vc = m.vc === 'h264' ? 'h264' : '';
      if (m.type === 'hello') {
        S.sig?.send({ type: 'hi', to: m.from, toInst: m.inst, name: myName(), ver: APP_VERSION, bc: webCodecsBridgeSupported() ? 1 : 0, vc: S.hwPref || undefined, br: bridgeOnlyFlag() });
      }
      if ((m.ver || 0) !== APP_VERSION && !S.verWarned && (m.type === 'hello' || m.ver)) {
        S.verWarned = true;
        const old = (m.ver || 0) < APP_VERSION;
        const t = old
          ? 'У собеседника старая версия ZVONochek — пусть обновит страницу (Ctrl+F5)'
          : 'Доступна новая версия ZVONochek — обновите страницу (Ctrl+F5)';
        log(`Версии разные: у меня v${APP_VERSION}, у собеседника v${m.ver || '?'}`);
        toast(t, 8000);
        sysMsg(t);
      }
      break;
    case 'ack':
      if (S.peer && m.from === S.peer.id) {
        S.ackReceived = true;
        clearTimeout(S.resendTimer);
      }
      break;
    case 'reset':
      if (acceptPeer(m) && m.gen > S.gen) {
        log(`Собеседник начал попытку №${m.gen + 1}`);
        newAttempt(m.gen);
      }
      break;
    case 'desc':
    case 'cand':
      if (!acceptPeer(m)) return;
      if (typeof m.gen === 'number' && m.gen > S.gen) {
        log(`Собеседник перешёл к попытке №${m.gen + 1}`);
        newAttempt(m.gen);
      }
      if (typeof m.gen === 'number' && m.gen < S.gen) return;
      if (m.type === 'desc') await onDesc(m.desc, m.via);
      else await onCand(m.cand);
      break;
    case 'voice':
      if (acceptPeer(m)) await playBridgeVoice(m);
      break;
    case 'voice2':
      if (acceptPeer(m)) await playBridgeVoice2(m);
      break;
    case 'sig_chat':
      if (acceptPeer(m) && typeof m.text === 'string') {
        onIncomingChat(m.text);
      }
      break;
    case 'g_hi':
      // Основной собеседник отвечает групповым протоколом (у него клиент,
      // где мы — mesh-участник): запоминаем диалект и отвечаем тем же.
      if (S.peer?.id === m.from && S.peer.inst === m.inst) noteGDialect();
      break;
    case 'g_chat':
      if (typeof m.text === 'string') onIncomingChat(m.text, m.name);
      break;
    case 'bye':
      S.roster.delete(m.inst);
      S.groupHook?.onPeerBye?.(m);
      if (S.peer?.id === m.from && S.peer.inst === m.inst) peerLeft();
      break;
    case 'full':
      if (!S.peer) {
        toast('В комнате уже двое участников — звонок 1:1', 6000);
        log('Комната занята');
      }
      break;
  }
}

function acceptPeer(m) {
  const p = S.peer;
  if (p && p.id === m.from && p.inst === m.inst) {
    p.seen = Date.now();
    if (m.name && m.name !== p.name) setPeerName(m.name);
    return true;
  }
  if (p && p.id === m.from) {
    log('Собеседник переподключился');
    S.dead.add(p.inst);
    resetPC();
    setPeer(m);
    return true;
  }
  if (p) {
    const alive = S.pc?.connectionState === 'connected' || S.bridgeActive || Date.now() - p.seen < 30000;
    if (alive) {
      // Групповой режим: лишних не выгоняем, пока в комнате есть место —
      // их подберёт group.js (mesh). 'full' только при переполнении.
      if (rosterCount() <= MAX_REMOTE_PEERS) return false;
      S.sig?.send({ type: 'full', to: m.from, toInst: m.inst });
      return false;
    }
    resetPC();
  }
  setPeer(m);
  return true;
}

function setPeer(m) {
  S.peer = { id: m.from, inst: m.inst, name: m.name || 'Собеседник', seen: Date.now(), vc: m.vc === 'h264' ? 'h264' : '' };
  S.polite = selfId < m.from;
  S.peerBridgeOnly = m.br === 1;
  S.peerDialect = 'plain';
  S.gen = 0;
  S.countedOk = false;
  stats.tries++;
  saveStats();
  setPeerName(S.peer.name);
  log(`Собеседник найден: ${S.peer.name} (канал: ${viaName(m.via)})`);
  progress(40, 'Собеседник найден, рукопожатие…');
  createPC();

  // Если выбран режим «Только Мост без TURN» — включаем голосовой мост мгновенно!
  // В режиме «Авто» даём WebRTC 10 секунд: за это время обычный звонок успевает подняться,
  // а при блокировке UDP/отсутствии TURN автоматически включается мост через сигналинг.
  // Лестница маршрутов v14: direct сразу, TURN — лениво через 6 секунд,
  // если прямое соединение не встало. Мост при этом уже на подходе (10 с
  // для зависшего checking, мгновенно при failed), поэтому тишины не будет.
  clearTimeout(S.turnTimer);
  if (S.audio.netMode === 'relay') {
    ensureTurnLoaded('режим «только TURN» выбран заранее');
  } else if (S.audio.netMode !== 'bridge') {
    armTurnTimer('direct не встал за 6 секунд');
  }
  clearTimeout(S.bridgeAutoTimer);
  if (S.audio.netMode === 'bridge') {
    activateBridge('Выбран режим прямого моста через сигнал (без TURN)');
  } else {
    S.bridgeAutoTimer = setTimeout(() => {
      if (!S.joined || !S.peer || S.bridgeActive) return;
      const cs = S.pc?.connectionState;
      const ice = S.pc?.iceConnectionState;
      if (cs !== 'connected' && (cs === 'failed' || cs === 'disconnected' || ice === 'checking' || ice === 'failed')) {
        activateBridge('Прямой P2P заблокирован или нет TURN — включён авто-мост через сигнал');
      }
    }, 10000);
  }
}

// v40: лестница TURN смотрит на прогресс ICE, а не только на часы. До v40
// через 6 с после «собеседник найден» TURN добавлялся, если connectionState
// ещё не 'connected', — даже когда ICE уже нашёл прямую пару и шёл DTLS
// или SDP собеседника ещё не доехал по медленному сигналингу. ICE restart
// с TURN в этот момент рвал почти готовый direct, давал встречные offer'ы
// и маршрут «TURN» там, где прямой путь работал. Теперь ждём, пока есть
// прогресс, но не дольше deadline — потом TURN, как раньше.
function armTurnTimer(reason, ms = 6000, deadline = Date.now() + ms + 8000, lastWhy = '') {
  clearTimeout(S.turnTimer);
  S.turnTimer = setTimeout(async () => {
    const pc = S.pc;
    if (!S.joined || !S.peer || !pc || pc.connectionState === 'connected') return;
    if (S.peerBridgeOnly) {
      log('TURN не включён: у собеседника режим «только мост»');
      return;
    }
    const why = Date.now() < deadline ? await directInProgress(pc) : '';
    if (S.pc !== pc || pc.connectionState === 'connected') return;
    if (why) {
      if (why !== lastWhy) log('TURN подождёт: ' + why);
      armTurnTimer(reason, 2000, deadline, why);
      return;
    }
    if (!remoteCandCount()) {
      // Ни одного адреса собеседника (у него «только мост» или кандидаты
      // потерялись): ICE не с кем проверять, и наш TURN ничего не даст.
      log('TURN не включён: собеседник не прислал ни одного маршрута');
      return;
    }
    ensureTurnLoaded(reason);
  }, ms);
}
const remoteCandCount = () => Object.values(S.cands?.remote || {}).reduce((a, b) => a + b, 0);

// Причина подождать с TURN (строка) или '' — прямой путь действительно не идёт.
async function directInProgress(pc) {
  if (!pc.remoteDescription) return 'SDP собеседника ещё не пришёл — TURN тут не поможет';
  if (!remoteCandCount()) return 'от собеседника ещё нет ни одного маршрута';
  const ice = pc.iceConnectionState;
  if (ice === 'connected' || ice === 'completed') return 'ICE уже соединён, идёт DTLS';
  try {
    const st = await pc.getStats();
    for (const r of st.values()) {
      if (r.type === 'candidate-pair' && r.state === 'succeeded') return 'прямая пара уже прошла проверку';
    }
  } catch {}
  return '';
}

function setPeerName(n) {
  S.peer.name = n;
  $('#peerAvatar').textContent = (n[0] || '?').toUpperCase();
  if ($('#peerNameTitle')) $('#peerNameTitle').textContent = n;
  setupMediaSession();
  updateStatus();
}
function newAttempt(gen) {
  resetPC(true);
  S.gen = gen;
  createPC();
  if (S.bridgeActive) startStats();
}

function createPC() {
  const pc = (S.pc = new RTCPeerConnection(mainPcConfig()));
  S.makingOffer = false;
  S.ignoreOffer = false;
  S.pendingCands = [];
  S.ackReceived = false;
  S.cands = { local: {}, remote: {} };
  S.route = '';
  S.method = '';
  S.pcRouteCounted = false;
  S.qLevel = 0;
  S.qBad = 0;
  S.qGood = 0;
  S.qHinted = false;
  S.peerCap = null; // собеседник пришлёт свою подсказку при открытии ctrl
  S.rxSent = '';
  log(
    `Попытка WebRTC №${S.gen + 1}: STUN (${CONFIG.STUN.length}), TURN: ${
      S.hasTurn ? 'есть' : 'нет'
    }${S.audio.netMode === 'relay' && S.hasTurn ? ' (только TURN)' : ''}`
  );
  S.remote = new MediaStream();
  $('#remote').srcObject = S.remote;
  S.ctrl = pc.createDataChannel('ctrl', { negotiated: true, id: 0 });
  S.fileCh = pc.createDataChannel('file', { negotiated: true, id: 1 });
  S.fileCh.binaryType = 'arraybuffer';
  S.fileCh.bufferedAmountLowThreshold = 1 << 20;
  S.ctrl.onopen = () => {
    sendCtrl({ t: 'state', mic: S.micOn, cam: S.camOn || !!S.screenTrack, name: myName() });
    sendRxCap(true);
  };
  S.ctrl.onmessage = (e) => onCtrl(e.data);
  S.fileCh.onmessage = (e) => onFileData(e.data);
  S.fileCh.onclose = () => {
    if (S.incomingFile) {
      S.incomingFile.el.querySelector('.who').textContent = 'Передача прервана';
      S.incomingFile = null;
    }
  };

  for (const t of S.local.getTracks()) pc.addTrack(t, S.local);
  if (S.screenTrack) pc.addTrack(S.screenTrack, S.local);

  pc.ontrack = ({ track }) => {
    S.remote.addTrack(track);
    if (track.kind === 'audio') {
      attachRemoteToEngine();
      track.addEventListener('mute', () => log('Входящий аудиотрек замьючен (сеть/источник)'));
      track.addEventListener('unmute', () => {
        log('Входящий аудиотрек снова активен');
        recoverRemoteAudio('unmute входящего трека');
      });
    }
    const upd = () => updateRemoteView();
    track.onmute = upd;
    track.onunmute = upd;
    track.onended = upd;
    upd();
    $('#remote')
      .play()
      .catch((e) => {
        if (e.name === 'NotAllowedError') $('#unmuteHint').classList.remove('hidden');
      });
  };
  pc.onnegotiationneeded = async () => {
    if (S.polite && !pc.currentRemoteDescription) {
      log('Ожидаем offer от собеседника');
      return;
    }
    try {
      S.makingOffer = true;
      applyCodecPrefs(pc);
      const offer = await pc.createOffer();
      offer.sdp = tuneOpusSdp(offer.sdp);
      await pc.setLocalDescription(offer);
    } catch (e) {
      log('Ошибка offer: ' + e.message);
      return;
    } finally {
      S.makingOffer = false;
    }
    sendDesc(pc);
  };
  pc.onicecandidate = ({ candidate }) => {
    if (pc !== S.pc) return;
    if (!candidate) {
      log(`Сбор маршрутов завершён: ${candText(S.cands.local)}`);
      return;
    }
    S.cands.local[candidate.type] = (S.cands.local[candidate.type] || 0) + 1;
    S.sig?.send({ type: candMsgType(), ...to(), cand: candidate.toJSON() });
    progressDetail();
  };
  pc.oniceconnectionstatechange = () => {
    if (pc !== S.pc) return;
    const s = pc.iceConnectionState;
    if (s === 'checking') progress(75, 'Пробиваем NAT и проверяем маршруты…');
    log('ICE: ' + s);
  };
  pc.onconnectionstatechange = () => onPcState(pc);
  armWatchdog(pc, S.polite ? 19000 : 13500);
  updateStatus();
}

function armWatchdog(pc, ms) {
  clearTimeout(S.watchdog);
  S.watchdog = setTimeout(() => {
    if (pc !== S.pc || pc.connectionState === 'connected') return;
    if (!pc._extended && ['checking', 'connected'].includes(pc.iceConnectionState)) {
      pc._extended = true;
      log('Маршрут почти согласован — ждём ещё 7 с');
      armWatchdog(pc, 7000);
      return;
    }
    // Если уже активно общаемся через Мост в режиме 'bridge', не перезапускаем PC впустую
    // (v40: и когда «только мост» у собеседника — его PC без кандидатов)
    if (S.bridgeActive && (S.audio.netMode === 'bridge' || S.peerBridgeOnly)) return;
    const g = S.gen + 1;
    log(`WebRTC P2P не соединился за ${Math.round(ms / 1000)} с — фоновая попытка №${g + 1}`);
    hintIfNeeded();
    newAttempt(g);
    S.sig?.send({ type: 'reset', ...to() });
  }, ms);
}

function waitGathering(pc, ms) {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener('icegatheringstatechange', chk);
      res();
    };
    const chk = () => pc.iceGatheringState === 'complete' && done();
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', chk);
  });
}
const sdpCands = (sdp) => sdp.match(/^a=candidate:.*$/gm) || [];

// Двухэтапная отправка SDP: быстрый старт через 450 мс + полный пакет кандидатов после досбора
// Собеседник на клиенте v16 считает нас mesh-участником и говорит со своим
// group.js (g_desc/g_cand), а наши обычные desc/cand его маршрутизация просто
// выбрасывает. Заметив его диалект, отвечаем тем же — иначе пара висит в
// цикле offer'ов без единого answer (полевые тесты v16–v18).
function noteGDialect() {
  if (S.peerDialect === 'g') return;
  S.peerDialect = 'g';
  log('Собеседник говорит групповым протоколом — отвечаем g_desc/g_cand');
  const pc = S.pc;
  if (pc?.localDescription && pc.signalingState === 'have-local-offer') {
    const d = { type: pc.localDescription.type, sdp: tuneOpusSdp(pc.localDescription.sdp) };
    S.sig?.send({ type: 'g_desc', ...to(), desc: d });
  }
}
const descMsgType = () => (S.peerDialect === 'g' ? 'g_desc' : 'desc');
const candMsgType = () => (S.peerDialect === 'g' ? 'g_cand' : 'cand');

async function sendDesc(pc) {
  await waitGathering(pc, 450);
  if (pc !== S.pc || !pc.localDescription) return;
  const desc = {
    type: pc.localDescription.type,
    sdp: tuneOpusSdp(pc.localDescription.sdp),
  };
  S.ackReceived = false;
  S.sig?.send({ type: descMsgType(), ...to(), desc });
  log(
    `Отправлен ${desc.type === 'offer' ? 'запрос (offer)' : 'ответ (answer)'} (${
      sdpCands(desc.sdp).length
    } маршр.)`
  );
  progress(55, 'Обмен ключами шифрования…');
  scheduleResend(pc, desc, 1);

  // Если сбор кандидатов ещё продолжался — через 1.8 с досылаем консолидированный SDP со всеми STUN/TURN маршрутами
  if (pc.iceGatheringState !== 'complete') {
    await waitGathering(pc, 1800);
    if (pc === S.pc && pc.localDescription && pc.connectionState !== 'connected') {
      const fullDesc = {
        type: pc.localDescription.type,
        sdp: tuneOpusSdp(pc.localDescription.sdp),
      };
      if (sdpCands(fullDesc.sdp).length > sdpCands(desc.sdp).length) {
        S.sig?.send({ type: descMsgType(), ...to(), desc: fullDesc });
      }
    }
  }
}

function scheduleResend(pc, desc, n) {
  clearTimeout(S.resendTimer);
  if (n > 5) return;
  S.resendTimer = setTimeout(() => {
    if (pc !== S.pc || pc.connectionState === 'connected' || S.ackReceived) return;
    if (desc.type === 'offer' && pc.signalingState !== 'have-local-offer') return;
    const latestDesc = pc.localDescription
      ? { type: pc.localDescription.type, sdp: tuneOpusSdp(pc.localDescription.sdp) }
      : desc;
    log(`Повтор отправки ${latestDesc.type} (#${n})`);
    S.sig?.send({ type: descMsgType(), ...to(), desc: latestDesc });
    scheduleResend(pc, latestDesc, n + 1);
  }, 2300);
}

// v40: копии SDP. scheduleResend повторяет описание каждые 2,3 с до ack, а
// sendDesc досылает «полный» SDP после досбора кандидатов; плюс каждое
// сообщение идёт сразу по нескольким каналам. Копия приходила, когда
// оригинал уже применён: answer в stable давал InvalidStateError → «Ошибка
// SDP» → watchdog 1,5 с → лишняя попытка, а копия offer'а запускала новое
// пересогласование и ещё один answer. Копию узнаём по строке o= (версия
// сессии растёт при каждом новом описании, а при досборе кандидатов — нет).
const sdpOrigin = (sdp) => /^o=.*$/m.exec(sdp || '')?.[0] || '';
function sdpCandInits(sdp) {
  const out = [];
  let idx = -1;
  for (const line of String(sdp || '').split(/\r?\n/)) {
    if (line.startsWith('m=')) idx++;
    else if (idx >= 0 && line.startsWith('a=candidate:')) out.push({ candidate: line.slice(2), sdpMLineIndex: idx });
  }
  return out;
}

async function onDesc(desc, via) {
  const pc = S.pc;
  if (!pc) return;
  // Мгновенно подтверждаем получение SDP, чтобы собеседник знал, что канал жив
  S.sig?.send({ type: 'ack', ...to(), ackType: desc.type });

  const rd = pc.remoteDescription;
  if (rd && rd.type === desc.type && sdpOrigin(desc.sdp) && sdpOrigin(rd.sdp) === sdpOrigin(desc.sdp)) {
    // Копия уже применённого описания: только добираем кандидатов из «полного» SDP.
    for (const c of sdpCandInits(desc.sdp)) await pc.addIceCandidate(c).catch(() => {});
    if (desc.type === 'offer' && pc.signalingState === 'stable' && pc.localDescription?.type === 'answer') {
      // Собеседник повторяет offer — значит, наш answer мог потеряться: шлём его ещё раз.
      S.sig?.send({ type: descMsgType(), ...to(), desc: { type: 'answer', sdp: tuneOpusSdp(pc.localDescription.sdp) } });
    }
    return;
  }
  if (desc.type === 'answer' && pc.signalingState !== 'have-local-offer') {
    log('Устаревший answer пропущен (состояние ' + pc.signalingState + ')');
    return;
  }

  const collision = desc.type === 'offer' && (S.makingOffer || pc.signalingState !== 'stable');
  S.ignoreOffer = !S.polite && collision;
  if (S.ignoreOffer) {
    log('Встречный offer — уступает вежливая сторона');
    return;
  }
  try {
    await pc.setRemoteDescription(desc);
    for (const line of sdpCands(desc.sdp || '')) {
      const t = / typ (\w+)/.exec(line)?.[1];
      if (t) S.cands.remote[t] = (S.cands.remote[t] || 0) + 1;
    }
    log(`Получен ${desc.type === 'offer' ? 'запрос (offer)' : 'ответ (answer)'} через ${viaName(via)}`);
    for (const c of S.pendingCands.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    if (desc.type === 'offer') {
      applyCodecPrefs(pc);
      const answer = await pc.createAnswer();
      answer.sdp = tuneOpusSdp(answer.sdp);
      await pc.setLocalDescription(answer);
      sendDesc(pc);
    } else {
      clearTimeout(S.resendTimer);
    }
    if (pc.connectionState === 'connected') noteCodecs(pc); // пересогласование посреди звонка
    progress(68, 'Ключи согласованы, пробиваем маршрут…');
    progressDetail();
  } catch (e) {
    log('Ошибка SDP: ' + e.message);
    if (S.pc === pc && !S.polite) armWatchdog(pc, 1500);
  }
}

async function onCand(c) {
  if (!c || !S.pc) return;
  const t = / typ (\w+)/.exec(c.candidate || '')?.[1];
  if (t) S.cands.remote[t] = (S.cands.remote[t] || 0) + 1;
  if (!S.pc.remoteDescription) {
    S.pendingCands.push(c);
    return;
  }
  try {
    await S.pc.addIceCandidate(c);
  } catch (e) {
    if (!S.ignoreOffer) console.warn('cand', e);
  }
  progressDetail();
}

function onPcState(pc) {
  if (pc !== S.pc) return;
  const s = pc.connectionState;
  log('WebRTC соединение: ' + s);
  clearTimeout(S.restartTimer);
  if (s === 'connected') {
    clearTimeout(S.watchdog);
    clearTimeout(S.bridgeAutoTimer);
    if (S.bridgeActive && S.audio.netMode !== 'bridge') {
      log('Прямой P2P WebRTC установлен — переключаемся с моста на прямой поток');
      stopBridge();
    }
    if (!S.callStart) {
      S.callStart = Date.now();
      beep();
      sysMsg(`Звонок начат · ваша версия ZVONochek v${APP_VERSION}`);
    }
    if (S.outCall) {
      // Собеседник и так в комнате (ждал по-старому) — ring больше не нужен
      const oc = S.outCall;
      inboxCancel(getWorkerBase(), oc.topic, oc.ringId, oc.signFn, oc.fromDevicePub).catch(() => {});
      finishOutCall('connected', true);
    }
    if (!S.countedOk) {
      S.countedOk = true;
      stats.ok++;
      saveStats();
    }
    showSafety();
    noteCodecs(pc);
    startStats(true);
    applyQuality();
  } else if (s === 'disconnected') {
    progress(80, 'Связь моргнула, восстанавливаем маршрут…');
    S.restartTimer = setTimeout(
      () => S.pc === pc && pc.connectionState !== 'connected' && restartIce(),
      2200
    );
  } else if (s === 'failed') {
    progress(80, 'Перезапуск ICE-маршрутов…');
    if (S.peer && !S.bridgeActive) {
      activateBridge('WebRTC P2P оборвался — включён резервный аудио-мост');
    }
    // Звук уже держит мост — спокойно догружаем TURN и только потом restart.
    ensureTurnLoaded('ICE failed').finally(() => {
      if (S.pc === pc) restartIce();
    });
  }
  updateStatus();
}

function restartIce() {
  if (!S.pc) return;
  log('Выполняем ICE restart');
  try {
    S.pc.restartIce();
  } catch {}
  armWatchdog(S.pc, S.polite ? 17000 : 11500);
}
// De-escalation при смене сети: новая сеть (Wi-Fi <-> LTE) может дать прямой
// маршрут. v38: догруженный TURN (любой, в т. ч. статический) сбрасываем и
// пробуем снова только direct; TURN вернётся лениво через 6 секунд, если
// direct не встанет. Лимиты TURN тратятся только когда без него никак.
function deescalateToDirect() {
  if (!S.pc) return;
  if (S.turnLoaded && S.audio.netMode !== 'relay') {
    S.turnLoaded = false;
    S.turnDyn = false;
    S.ice = S.stunOnlyIce || [{ urls: CONFIG.STUN }];
    S.hasTurn = false;
    try { S.pc.setConfiguration(mainPcConfig()); } catch {}
    log('Смена сети: сначала снова пробуем напрямую, TURN — только если direct не встанет');
    armTurnTimer('после смены сети direct не встал');
  }
  restartIce();
}
window.addEventListener('online', () => S.pc && S.callStart && deescalateToDirect());
if (navigator.connection) {
  // v40: 'change' приходит и на любое колебание rtt/downlink/effectiveType
  // (в мобильной сети — постоянно), а каждый вызов делал ICE restart и
  // сбрасывал TURN посреди рабочего звонка. Реагируем только на смену типа
  // сети (Wi-Fi ↔ сотовая); где type не отдаётся (ПК), разрыв ловит сам ICE.
  let netType = navigator.connection.type;
  navigator.connection.addEventListener?.('change', () => {
    const t = navigator.connection.type;
    if (t === netType) return;
    netType = t;
    if (S.pc && S.callStart) {
      log('Смена типа сети (' + (t || '?') + ') — обновляем ICE маршруты');
      deescalateToDirect();
    }
  });
}

function resetPC(keepBridge = false) {
  if (!keepBridge) finishCallRecord();
  S.bridgeCounted = false;
  clearTimeout(S.restartTimer);
  clearTimeout(S.watchdog);
  clearTimeout(S.resendTimer);
  clearInterval(S.statsTimer);
  S.statsTimer = null;
  if (!keepBridge) stopBridge();
  try {
    S.pc?.close();
  } catch {}
  S.pc = null;
  S.ctrl = null;
  S.fileCh = null;
  if (!keepBridge) S.callStart = 0;
  S.prevCounters = null;
  S.remote.getTracks().forEach((t) => S.remote.removeTrack(t));
  if (!keepBridge) {
    $('#safety').classList.add('hidden');
    $('#quality').classList.add('hidden');
  }
  updateRemoteView();
}

function peerLeft() {
  const n = S.peer?.name || 'Собеседник';
  resetPC(false);
  S.peer = null;
  if ($('#peerNameTitle')) $('#peerNameTitle').textContent = 'Ожидаем собеседника…';
  sysMsg(`${n} больше не в звонке`);
  toast(`${n} больше не в звонке`);
  log(`${n}: выход из звонка`);
  progress(25, 'Ожидаем собеседника');
  updateStatus();
}

// ---------- Прогресс и диагностика ----------
const CT = {
  host: 'локальных',
  srflx: 'внешних (STUN)',
  prflx: 'пробивных (PRFLX)',
  relay: 'через TURN',
};
const candText = (o) =>
  Object.keys(o).length
    ? Object.entries(o)
        .map(([k, v]) => `${CT[k] || k} ${v}`)
        .join(', ')
    : 'нет';

function log(t) {
  const line = new Date().toLocaleTimeString('ru-RU') + '  ' + t;
  S.log.push(line);
  if (S.log.length > 350) S.log.shift();
  const el = $('#diagLog');
  if (el) {
    el.textContent = S.log.join('\n');
    el.scrollTop = 1e9;
  }
}

function progress(pct, step) {
  if ((S.pc?.connectionState === 'connected' || S.bridgeActive) && pct < 100) return;
  S.pct = pct;
  S.step = step;
  $('#connPct').textContent = pct + '%';
  $('#connStep').textContent = step;
  $('#connBar').style.width = pct + '%';
  updateStatus();
}

function progressDetail() {
  const sg = S.sigStatus;
  const workerTag = getWorkerBase()
    ? `Worker ${sg.worker === 'up' ? 'WS: есть' : sg.workerHttp === 'up' ? 'HTTP: есть' : 'нет'}`
    : null;
  const ways = [
    `MQTT ${sg.mqttUp}/${sg.mqttTotal}`,
    workerTag,
    `Nostr ${sg.nostrUp || 0}/${sg.nostrTotal || 0}`,
    sg.ntfyTotal ? `ntfy ${sg.ntfyUp || 0}/${sg.ntfyTotal}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  $('#connMethod').textContent =
    `Сигнал: ${ways}\nМои маршруты: ${candText(S.cands?.local || {})}\nМаршруты собеседника: ${candText(
      S.cands?.remote || {}
    )}` +
    (S.peer ? `\nПопытка №${S.gen + 1}` : '') +
    (S.method ? `\nСпособ: ${S.method}` : '');
}

function hintIfNeeded() {
  const l = S.cands.local,
    r = S.cands.remote;
  let h = '';
  if (!l.srflx && !l.relay)
    h = 'Провайдер блокирует UDP/STUN — автоматически используем Мост через Сигналинг.';
  else if (!S.hasTurn)
    h = 'Симметричный NAT без TURN — голос идёт через зашифрованный Мост сигналинга.';
  else if (!r.relay && !l.relay) h = 'TURN недоступен — используем обход через Мост.';
  if (h) log('Инфо: ' + h);
}

function diagText() {
  const pct = stats.tries ? Math.round((100 * stats.ok) / stats.tries) : 0;
  return (
    `ZVONochek v${APP_VERSION} — диагностика\nБраузер: ${navigator.userAgent}\n` +
    `Успешных P2P соединений: ${stats.ok} из ${stats.tries} (${pct}%)\n` +
    `Маршруты за всё время: напрямую ${routeStats.direct || 0} · через TURN ${routeStats.relay || 0} · через мост ${routeStats.bridge || 0}\n` +
    transportText() +
    `\nМои маршруты: ${candText(S.cands?.local || {})}\nМаршруты собеседника: ${candText(
      S.cands?.remote || {}
    )}\n` +
    `Сигналы получены: ${
      Object.entries(S.via)
        .map(([k, v]) => `${viaName(k)} ${v}`)
        .join(', ') || '—'
    }\n\nЖурнал:\n` +
    S.log.join('\n')
  );
}

function openDiag() {
  const b = openModal('#tplDiag');
  const pct = stats.tries ? Math.round((100 * stats.ok) / stats.tries) : 0;
  $('#diagStats', b).textContent =
    `Успешных P2P соединений: ${stats.ok} из ${stats.tries} (${pct}%)\n` +
    `Маршруты за всё время: напрямую ${routeStats.direct || 0} · через TURN ${routeStats.relay || 0} · через мост ${routeStats.bridge || 0}\n` +
    transportText() +
    `\nМои маршруты: ${candText(S.cands?.local || {})}\nМаршруты собеседника: ${candText(
      S.cands?.remote || {}
    )}`;
  $('#diagLog', b).textContent = S.log.join('\n');
  $('#diagCopy', b).onclick = async () => {
    try {
      await navigator.clipboard.writeText(diagText());
      toast('Отчёт диагностики скопирован');
    } catch {
      toast('Не удалось скопировать');
    }
  };
}
$('#btnDiag').onclick = openDiag;

// ---------- Статус, Качество, Код безопасности ----------
function updateRemoteView() {
  const v = S.remote.getVideoTracks().find((t) => t.readyState === 'live' && !t.muted);
  const camState = S.peer?.cam !== false;
  $('#remoteOff').classList.toggle('hidden', !!(v && camState && S.pc?.connectionState === 'connected'));
}

function updateStatus() {
  const st = $('#status');
  if (!st) return;
  const s = S.pc?.connectionState;
  const sg = S.sigStatus;
  const sigUp = sg.mqttUp > 0 || sg.worker === 'up' || sg.workerHttp === 'up' || sg.nostrUp > 0;
  let text;
  let iconName;
  if (!sigUp) {
    text = 'Подключение к сети…';
    iconName = 'i-loader';
  } else if (!S.peer) {
    text = 'Ожидаем собеседника';
    iconName = 'i-users';
  } else if (s === 'connected') {
    text = S.peer.name;
    iconName = 'i-check';
  } else if (S.bridgeActive) {
    text = S.peer.name;
    iconName = 'i-shield';
  } else {
    text = `${S.pct}% · ${S.step}`;
    iconName = 'i-loader';
  }
  const statusText = $('#statusText');
  if (statusText) statusText.textContent = text;
  setUse('#statusIcon', iconName);

  const isLive = s === 'connected' || S.bridgeActive;
  $('#waitText').textContent = !S.peer
    ? S.waitHinted
      ? 'Собеседник пока не найден. Если он уже в звонке — попросите его обновить страницу'
      : 'Отправьте ссылку собеседнику'
    : s === 'connected'
    ? S.peer.cam === false
      ? 'Голосовой звонок (камера выключена)'
      : 'Защищённое P2P-соединение активно'
    : S.bridgeActive
    ? 'Голосовой мост через зашифрованный сигнал активен (без TURN/UDP)'
    : `Соединяемся с ${S.peer.name}…`;

  $('#conn').classList.toggle('hidden', isLive);
  progressDetail();
  $('#timer').classList.toggle('hidden', !S.callStart);
  const tr = $('#sTransports');
  if (tr) tr.textContent = transportText();
}

function transportText() {
  const sg = S.sigStatus;
  const wText = getWorkerBase()
    ? sg.worker === 'up'
      ? 'WebSocket на связи'
      : sg.workerHttp === 'up'
      ? 'HTTP-поллинг на связи (обход блока WS)'
      : 'подключение…'
    : 'не настроен';
  return (
    `Канал 1 — MQTT-брокеры: ${sg.mqttUp}/${sg.mqttTotal} на связи\n` +
    `Канал 2 — Cloudflare Worker: ${wText}\n` +
    `Канал 3 — Nostr-реле (порт 443): ${sg.nostrUp || 0}/${sg.nostrTotal || 0} на связи\n` +
    `Канал 4 — ntfy: ${sg.ntfyTotal ? (sg.ntfyUp ? 'на связи' : 'подключение…') : 'не настроен'}\n` +
    `TURN-ретранслятор: ${
      S.hasTurn
        ? (S.turnDyn ? 'включён (Worker/Metered + config)' : 'включён (config) — прямой путь не встал') +
          ` (${S.turnInfo || '—'})`
        : S.turnLoaded
          ? `недоступен — работаем без него (${S.turnInfo || '—'})`
          : staticTurn().length
            ? `в резерве (${staticTurn().length} ${plural(staticTurn().length, 'сервер', 'сервера', 'серверов')} из config) — только если прямой путь не встанет`
            : 'не настроен — звонки через «жёсткий» NAT пойдут мостом'
    }\n` +
    `Маршрут звонка: ${S.bridgeActive ? 'Зашифрованный Мост через Сигналинг (без TURN)' : S.method || '—'}\n` +
    `Мост: ${S.bridgeActive ? (S.bridgeMode === 'webcodecs' ? '2.0 WebCodecs Opus' : '1.0 MediaRecorder') : 'выключен'} · WebCodecs в этом браузере: ${webCodecsBridgeSupported() ? 'есть' : 'нет'}`
  );
}

setInterval(() => {
  if (!S.callStart) return;
  const sec = Math.floor((Date.now() - S.callStart) / 1000);
  const txt = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  if ($('#timerText')) $('#timerText').textContent = txt;
  if (S.callLocked && $('#callLockTimer')) $('#callLockTimer').textContent = txt;
}, 1000);

// ---------- Статистика звонка (v36: callstats.js + панель «Качество связи») ----------
const ROUTE_TEXT = { p2p: 'напрямую P2P', lan: 'напрямую (LAN)', turn: 'через TURN' };

function startStats(now) {
  if (S.statsTimer) return;
  S.statsTimer = setInterval(statsTick, 2000);
  if (now) setTimeout(statsTick, 300);
}

async function statsTick() {
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

function renderStatsPanel() {
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
function mediaModeText() {
  const t = S.capTier;
  if (!t) return '';
  const parts = [`${S.vq === 'auto' ? 'Авто' : 'Вручную'} · ${CLASS_TEXT[S.devClass] || ''}`];
  if (localTrack('video') && !S.screenTrack) parts.push(`камера ${t.h}p @ ${t.fps}${t.why.length ? ' (' + t.why.join(', ') + ')' : ''}`);
  if (S.peerCap) parts.push(S.peerCap.h === 0 ? 'собеседник свернул — видео ему на паузе' : `собеседнику ≤${S.peerCap.h}p`);
  if (viewHidden()) parts.push('у вас экран скрыт — входящее видео на паузе');
  return parts.join(' · ');
}

function toggleStatsPanel() {
  const panel = $('#callStats');
  if (!panel) return;
  panel.classList.toggle('hidden');
  $('#quickAudioPop')?.classList.add('hidden');
  renderStatsPanel();
}
$('#quality') && ($('#quality').onclick = toggleStatsPanel);
$('#bridgeBadge') && ($('#bridgeBadge').onclick = toggleStatsPanel);

// Сетевая лестница QLEVELS — в media-policy.js (по высоте кадра, а не по
// множителю: одинаково работает для захвата 1080p, 720p и 480p).
async function applyQuality() {
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
function adaptQuality(outLoss, rtt) {
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
function noteCodecs(pc) {
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

// ---------- v37: нагрузка устройства → ступени видео (против нагрева) ----------
// Chrome сообщает qualityLimitationReason='cpu', когда кодер не успевает.
// 3 тика подряд (≈6 с) — снижаем захват камеры на ступень (до трёх);
// 90 с спокойствия — возвращаем одну. Если после возврата перегрузка
// вернулась в течение 2 минут — ступень фиксируется до конца звонка:
// телефон уже прогрет, качели «вверх-вниз» только мешают смотреть.
function adaptLoad(smp) {
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
async function reapplyMediaLoad() {
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
const viewHidden = () => document.visibilityState === 'hidden' || !!S.callLocked;
const myRxCap = () => rxCap(S.devClass, { ...loadOpts(), hidden: viewHidden() });
function sendRxCap(force = false) {
  if (S.ctrl?.readyState !== 'open') return; // уйдёт при открытии канала
  const c = myRxCap();
  const j = JSON.stringify(c);
  if (!force && j === S.rxSent) return;
  S.rxSent = j;
  sendCtrl({ t: 'vcap', ...c });
}
// Скрытие — с задержкой 1,5 с (быстрое переключение приложений не дёргает
// кодер собеседника), возврат — сразу.
function onViewChange() {
  clearTimeout(S.viewTimer);
  if (viewHidden()) S.viewTimer = setTimeout(() => sendRxCap(), 1500);
  else sendRxCap();
}

// Заряд и Compute Pressure — только как сигналы «облегчить». Оба API
// необязательны: где их нет (Safari, Firefox), работает только ЦП-адаптация.
function watchDeviceLoad() {
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
function applyCodecPrefs(pc) {
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
async function detectHwVideo() {
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
detectHwVideo();

async function showSafety() {
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

async function showBridgeSafety() {
  if (!S.room || !S.peer) return;
  S.safety = await safetyCodeBridge(S.room.topic, selfId, S.peer.id);
  const el = $('#safety');
  const pill = $('#safetyPill');
  if (pill) pill.textContent = S.safety.emoji;
  el.classList.remove('hidden');
}

$('#safety').onclick = () => {
  if (!S.safety) return;
  const b = openModal('#tplSafety');
  $('#safetyEmoji', b).textContent = S.safety.emoji;
  $('#safetyDigits', b).textContent = S.safety.digits;
};

// ---------- Чат (DataChannel + автоматический фоллбэк через Сигналинг) и Файлы ----------
function sendCtrl(o) {
  if (S.ctrl?.readyState === 'open') S.ctrl.send(JSON.stringify(o));
}
function onIncomingChat(text, nameOverride) {
  addMsg(nameOverride || S.peer?.name || 'Собеседник', String(text).slice(0, 5000), false);
  if ($('#chat').classList.contains('hidden')) {
    S.unread++;
    $('#unread').textContent = S.unread;
    $('#unread').classList.remove('hidden');
    beep();
  }
}
function onCtrl(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.t === 'chat' && typeof m.text === 'string') {
    onIncomingChat(m.text);
  } else if (m.t === 'state') {
    if (S.peer) {
      S.peer.cam = !!m.cam;
      S.peer.mic = !!m.mic;
      if (m.name) setPeerName(String(m.name).slice(0, 40));
    }
    updateRemoteView();
    updateStatus();
  } else if (m.t === 'vcap') {
    const c = parseCap(m);
    if (!c) return;
    const was = S.peerCap;
    S.peerCap = c;
    if (was && was.h === c.h && was.fps === c.fps) return;
    if (c.h === 0) log('Собеседник свернул звонок — видео ему не шлём (экономия батареи)');
    else if (was?.h === 0) log('Собеседник вернулся — видео снова идёт');
    else log(`Собеседнику нужно видео до ${c.h}p @ ${c.fps} к/с`);
    applyQuality();
  }
}
function hideChatEmpty() {
  ($('#callChatEmpty') || $('#call #chatEmpty'))?.remove();
}
function addMsg(who, text, me) {
  hideChatEmpty();
  const d = document.createElement('div');
  d.className = 'm' + (me ? ' me' : '');
  const w = document.createElement('div');
  w.className = 'who';
  w.textContent = who;
  const t = document.createElement('div');
  t.textContent = text;
  d.append(w, t);
  $('#msgs').append(d);
  $('#msgs').scrollTop = 1e9;
  return d;
}
function sysMsg(text) {
  hideChatEmpty();
  const d = document.createElement('div');
  d.className = 'm sys';
  d.textContent = text;
  $('#msgs').append(d);
  $('#msgs').scrollTop = 1e9;
}
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const inp = $('#callChatInput') || $('#call #chatInput');
  const v = (inp?.value || '').trim();
  if (!v) return;
  if (rosterCount() > 1 && S.sig) {
    // Групповой чат: одно сообщение всем участникам через E2EE-сигналинг.
    S.sig?.send({ type: 'g_chat', text: v, name: myName() });
    addMsg('Вы', v, true);
    if (inp) inp.value = '';
    return;
  }
  if (S.ctrl?.readyState === 'open') {
    sendCtrl({ t: 'chat', text: v });
  } else if (S.peer && S.sig) {
    // Если DataChannel ещё не открыт или заблокирован — отправляем сообщение через E2EE сигналинг!
    S.sig?.send({ type: 'sig_chat', to: S.peer.id, toInst: S.peer.inst, text: v });
  } else {
    return toast('Собеседник ещё не вошёл в комнату');
  }
  addMsg('Вы', v, true);
  if (inp) inp.value = '';
};

$('#fileInput').onchange = (e) => {
  if (S.fileCh?.readyState !== 'open') {
    toast('Передача крупных файлов требует прямого P2P-соединения');
    e.target.value = '';
    return;
  }
  for (const f of e.target.files) {
    if (f.size > MAX_FILE_BYTES) {
      toast(`Файл больше ${fmtSize(MAX_FILE_BYTES)} — передача отменена`);
      continue;
    }
    S.sendQueue.push(f);
  }
  e.target.value = '';
  pumpFiles();
};
function fileBubble(who, name, size, me) {
  const d = addMsg(who, '', me);
  const row = document.createElement('div');
  row.className = 'file-row';
  const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ic.setAttribute('class', 'ic');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-attach');
  ic.append(use);
  const label = document.createElement('span');
  label.textContent = `${name} · ${fmtSize(size)}`;
  row.append(ic, label);
  d.lastElementChild?.append(row);
  const p = document.createElement('div');
  p.className = 'prog';
  p.append(document.createElement('i'));
  d.append(p);
  return d;
}
const setProg = (el, v) => {
  el.querySelector('.prog i').style.width = Math.min(100, v * 100) + '%';
};
async function pumpFiles() {
  if (S.sending) return;
  S.sending = true;
  while (S.sendQueue.length) {
    const f = S.sendQueue.shift(),
      ch = S.fileCh;
    if (!ch || ch.readyState !== 'open') break;
    const el = fileBubble('Вы', f.name, f.size, true);
    const CH = Math.min(64 * 1024, S.pc.sctp?.maxMessageSize || 16384);
    ch.send(JSON.stringify({ t: 'start', name: f.name, size: f.size, mime: f.type }));
    try {
      for (let o = 0; o < f.size; o += CH) {
        if (ch.bufferedAmount > 4 << 20)
          await new Promise((r) => ch.addEventListener('bufferedamountlow', r, { once: true }));
        if (ch.readyState !== 'open') throw new Error('closed');
        ch.send(await f.slice(o, o + CH).arrayBuffer());
        setProg(el, (o + CH) / f.size);
      }
      ch.send(JSON.stringify({ t: 'end' }));
      setProg(el, 1);
    } catch {
      el.querySelector('.who').textContent = 'Отправка прервана';
    }
  }
  S.sending = false;
}
function onFileData(d) {
  if (typeof d === 'string') {
    let m;
    try {
      m = JSON.parse(d);
    } catch {
      return;
    }
    if (m.t === 'start') {
      const name = String(m.name || 'file').slice(0, 200),
        size = Number(m.size) || 0;
      if (size > MAX_FILE_BYTES) {
        S.incomingFile = null;
        sysMsg(`Собеседник пытался отправить файл больше ${fmtSize(MAX_FILE_BYTES)}`);
        return;
      }
      S.incomingFile = {
        name,
        size,
        mime: String(m.mime || ''),
        parts: [],
        got: 0,
        el: fileBubble(S.peer?.name || 'Собеседник', name, size, false),
      };
    } else if (m.t === 'end' && S.incomingFile) {
      const f = S.incomingFile;
      S.incomingFile = null;
      if (f.got !== f.size) {
        f.el.querySelector('.who').textContent = 'Передача прервана';
        return;
      }
      setProg(f.el, 1);
      const url = URL.createObjectURL(new Blob(f.parts, { type: f.mime || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.className = 'dl';
      a.href = url;
      a.download = f.name;
      a.innerHTML = '<svg class="ic"><use href="#i-download"></use></svg><span>Скачать</span>';
      a.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 120000), { once: true });
      f.el.append(a);
      if ($('#chat').classList.contains('hidden')) {
        S.unread++;
        $('#unread').textContent = S.unread;
        $('#unread').classList.remove('hidden');
        beep();
      }
    }
  } else if (S.incomingFile) {
    if (S.incomingFile.got + d.byteLength > S.incomingFile.size + 1024) {
      S.incomingFile.el.querySelector('.who').textContent = 'Передача прервана';
      S.incomingFile = null;
      return;
    }
    S.incomingFile.parts.push(d);
    S.incomingFile.got += d.byteLength;
    setProg(S.incomingFile.el, S.incomingFile.got / (S.incomingFile.size || 1));
  }
}

// ---------- Кнопки звонка и Панель настроек Discord ----------
$('#cMic').onclick = toggleMic;
$('#cDeaf').onclick = toggleDeafen;
$('#cCam').onclick = toggleCam;
$('#cScreen').onclick = toggleScreen;

// ---------- v34: Блокировка экрана звонка от случайных нажатий (Pocket / Ear Lock) ----------
function setCallLock(locked) {
  S.callLocked = !!locked;
  if (!S.callLocked) S.callDimmed = false;
  const ov = $('#callLockOverlay');
  if (ov) {
    ov.classList.toggle('hidden', !S.callLocked);
    ov.classList.toggle('oled-dim', S.callDimmed);
  }
  $('#call')?.classList.toggle('is-locked', S.callLocked);
  onViewChange(); // v37: под блокировкой видео собеседника не видно — просим его не слать
  if (S.callLocked) {
    const peerName = S.peer?.name || 'Активный звонок';
    if ($('#callLockPeer')) $('#callLockPeer').textContent = `${peerName} · экран заблокирован`;
    if ($('#callLockTimer') && $('#timerText')) $('#callLockTimer').textContent = $('#timerText').textContent;
    $('#quickAudioPop')?.classList.add('hidden');
    toast('🔒 Экран заблокирован от случайных нажатий');
  } else {
    toast('🔓 Экран звонка разблокирован');
  }
}

$('#cLock') && ($('#cLock').onclick = () => setCallLock(true));
$('#btnLockTop') && ($('#btnLockTop').onclick = () => setCallLock(true));
$('#btnCallDimToggle') && ($('#btnCallDimToggle').onclick = (e) => {
  e.stopPropagation();
  S.callDimmed = !S.callDimmed;
  $('#callLockOverlay')?.classList.toggle('oled-dim', S.callDimmed);
  const span = $('#btnCallDimToggle span');
  if (span) span.textContent = S.callDimmed ? '☀️ Включить подсветку' : '🌙 Погасить экран (OLED)';
});
$('#btnUnlockCall') && ($('#btnUnlockCall').onclick = (e) => {
  e.stopPropagation();
  const now = Date.now();
  if (now - S.lastUnlockTap < 650) {
    S.lastUnlockTap = 0;
    setCallLock(false);
  } else {
    S.lastUnlockTap = now;
    const span = $('#btnUnlockCall span');
    if (span) {
      span.textContent = 'Ещё одно нажатие для разблокировки…';
      setTimeout(() => {
        if (S.callLocked && span) span.textContent = 'Нажмите дважды для разблокировки';
      }, 700);
    }
  }
});

// ---------- v34: Эко-режим (против нагрева телефона в долгих звонках) ----------
function syncEcoUI() {
  document.body.classList.toggle('eco-mode', !!S.ecoMode);
  const topBtn = $('#btnEcoToggle');
  if (topBtn) {
    topBtn.classList.toggle('good', !!S.ecoMode);
    const lbl = $('#ecoLabel');
    if (lbl) lbl.textContent = S.ecoMode ? 'Эко ВКЛ' : 'Эко';
  }
  if ($('#qaEcoMode')) $('#qaEcoMode').checked = !!S.ecoMode;
  if ($('#sEcoMode')) $('#sEcoMode').checked = !!S.ecoMode;
}
async function setEcoMode(on) {
  S.ecoMode = !!on;
  try { localStorage.zvEco = S.ecoMode ? '1' : '0'; } catch {}
  syncEcoUI();
  await reapplyMediaLoad();
  toast(S.ecoMode ? '❄️ Эко-режим включён: снижен нагрев и расход батареи' : 'Эко-режим выключен (максимальное качество)');
}
syncEcoUI();
$('#btnEcoToggle') && ($('#btnEcoToggle').onclick = () => setEcoMode(!S.ecoMode));
$('#qaEcoMode') && ($('#qaEcoMode').onchange = (e) => setEcoMode(e.target.checked));
$('#cChat').onclick = () => {
  $('#chat').classList.toggle('hidden');
  syncChatOpen();
  S.unread = 0;
  $('#unread').classList.add('hidden');
  if (!$('#chat').classList.contains('hidden')) ($('#callChatInput') || $('#call #chatInput'))?.focus();
};
$('#cInvite').onclick = () => {
  const b = openModal('#tplInvite');
  $('#iLink', b).value = roomLink();
  renderQr($('#iQr', b), roomLink());
  $('#iCopy', b).onclick = () => copy(roomLink());
};

// Быстрый всплывающий аудио-микшер в звонке
$('#btnQuickAudio').onclick = () => {
  const pop = $('#quickAudioPop');
  pop.classList.toggle('hidden');
  $('#qaBoost').checked = S.audio.comp;
  $('#qaBridgeMode').checked = S.audio.netMode === 'bridge' || S.bridgeActive;
  syncAudioParams();
};
$('#qaPeerVol').oninput = (e) => {
  S.audio.peerVol = Number(e.target.value);
  if (S.deafened && S.audio.peerVol > 0) S.deafened = false;
  syncAudioParams();
  syncButtons();
};
$('#qaMicVol').oninput = (e) => {
  S.audio.micVol = Number(e.target.value);
  syncAudioParams();
};
$('#qaBoost').onchange = (e) => {
  S.audio.comp = e.target.checked;
  syncAudioParams();
};
$('#qaBridgeMode').onchange = (e) => {
  if (e.target.checked) {
    S.audio.netMode = 'bridge';
    syncAudioParams();
    if (S.peer) activateBridge('Включён принудительный мост без TURN');
  } else {
    S.audio.netMode = 'auto';
    syncAudioParams();
    if (S.pc?.connectionState === 'connected') stopBridge();
  }
};
$('#qaMoreSettings').onclick = () => {
  $('#quickAudioPop').classList.add('hidden');
  openSettingsModal();
};

async function openSettingsModal() {
  const b = openModal('#tplSettings');
  await fillDevices('s');
  $('#sSpkWrap', b).classList.toggle('hidden', !('setSinkId' in HTMLMediaElement.prototype));

  $('#sMic', b).onchange = (e) => switchDevice('mic', e.target.value);
  $('#sCam', b).onchange = (e) => switchDevice('cam', e.target.value);
  if ($('#sFlipCamBtn', b)) $('#sFlipCamBtn', b).onclick = () => flipCamera();
  if ($('#sEcoMode', b)) {
    $('#sEcoMode', b).checked = !!S.ecoMode;
    $('#sEcoMode', b).onchange = (e) => setEcoMode(e.target.checked);
  }
  if ($('#sVideoQ', b)) {
    $('#sVideoQ', b).value = S.vq || 'auto';
    $('#sVideoQ', b).onchange = async (e) => {
      S.vq = VQ_CHOICES.includes(e.target.value) ? e.target.value : 'auto';
      try { localStorage.zvVQ = S.vq; } catch {}
      await reapplyMediaLoad();
      const t = captureTier(S.vq, S.devClass, loadOpts());
      toast(
        'Качество видео: ' +
          (S.vq === 'auto' ? `авто (${CLASS_TEXT[S.devClass]}: ${t.h}p @ ${t.fps})` : S.vq === '1440' ? '2K (1440p)' : S.vq + 'p')
      );
    };
  }
  $('#sSpk', b).onchange = (e) => {
    S.dev.spk = localStorage.zvSpk = e.target.value;
    $('#remote').setSinkId?.(e.target.value).catch(() => {});
    $('#remoteAudioOut')?.setSinkId?.(e.target.value).catch(() => {});
    attachRemoteToEngine();
  };

  // Громкость микрофона и собеседника (0-200%)
  const sMicVol = $('#sMicVol', b),
    sMicVolTxt = $('#sMicVolTxt', b);
  sMicVol.value = S.audio.micVol;
  sMicVolTxt.textContent = S.audio.micVol + '%';
  sMicVol.oninput = () => {
    S.audio.micVol = Number(sMicVol.value);
    sMicVolTxt.textContent = S.audio.micVol + '%';
    syncAudioParams();
  };

  const sPeerVol = $('#sPeerVol', b),
    sPeerVolTxt = $('#sPeerVolTxt', b);
  sPeerVol.value = S.audio.peerVol;
  sPeerVolTxt.textContent = S.audio.peerVol + '%';
  sPeerVol.oninput = () => {
    S.audio.peerVol = Number(sPeerVol.value);
    sPeerVolTxt.textContent = S.audio.peerVol + '%';
    syncAudioParams();
  };

  // Режим ввода (VAD vs PTT)
  const rOpen = $('#sModeOpen', b),
    rVad = $('#sModeVad', b),
    rPtt = $('#sModePtt', b),
    vadWrap = $('#sVadControls', b);
  if (rOpen) rOpen.checked = S.audio.inputMode === 'open';
  rVad.checked = S.audio.inputMode === 'vad';
  rPtt.checked = S.audio.inputMode === 'ptt';
  vadWrap.classList.toggle('hidden', S.audio.inputMode !== 'vad');
  const onModeChange = () => {
    S.audio.inputMode = rPtt.checked ? 'ptt' : rVad.checked ? 'vad' : 'open';
    vadWrap.classList.toggle('hidden', S.audio.inputMode !== 'vad');
    syncAudioParams();
  };
  if (rOpen) rOpen.onchange = onModeChange;
  rVad.onchange = onModeChange;
  rPtt.onchange = onModeChange;

  // Порог чувствительности голоса (VAD Gate)
  const sVadGate = $('#sVadGate', b),
    sVadGateTxt = $('#sVadGateTxt', b);
  sVadGate.value = S.audio.vadGate;
  sVadGateTxt.textContent = S.audio.vadGate + ' дБ';
  sVadGate.oninput = () => {
    S.audio.vadGate = Number(sVadGate.value);
    sVadGateTxt.textContent = S.audio.vadGate + ' дБ';
    syncAudioParams();
  };

  // Кнопка проверки микрофона
  const testBtn = $('#sTestMic', b);
  testBtn.onclick = () => toggleMicTest(testBtn);

  // Обработка звука
  const sNoise = $('#sNoise', b),
    sEcho = $('#sEcho', b),
    sAgc = $('#sAgc', b),
    sComp = $('#sComp', b);
  sNoise.checked = S.audio.noise;
  sEcho.checked = S.audio.echo;
  sAgc.checked = S.audio.agc;
  sComp.checked = S.audio.comp;

  const rebuildMicConstraints = async () => {
    S.audio.noise = sNoise.checked;
    S.audio.echo = sEcho.checked;
    S.audio.agc = sAgc.checked;
    syncAudioParams();
    if (S.rawAudioTrack) {
      // v40: Chrome молча принимает applyConstraints для echoCancellation/
      // noiseSuppression/autoGainControl, но обработку на живом треке не
      // меняет (getSettings остаётся прежним) — переключатель не работал до
      // следующего входа. Проверяем результат и при расхождении переоткрываем
      // микрофон (с v40 это безопасно: обработанный трек не умирает).
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
  };
  sNoise.onchange = rebuildMicConstraints;
  sEcho.onchange = rebuildMicConstraints;
  sAgc.onchange = rebuildMicConstraints;
  sComp.onchange = () => {
    S.audio.comp = sComp.checked;
    syncAudioParams();
  };

  // Ручная настройка Opus: по умолчанию выключена, битрейт недоступен
  const sBitrate = $('#sBitrate', b);
  const sOpusTune = $('#sOpusTune', b);
  sBitrate.value = String(S.audio.bitrate);
  const paintOpus = () => {
    sBitrate.disabled = !S.audio.opusTune;
    sBitrate.closest('label')?.classList.toggle('disabled', !S.audio.opusTune);
  };
  if (sOpusTune) {
    sOpusTune.checked = S.audio.opusTune;
    sOpusTune.onchange = () => {
      S.audio.opusTune = sOpusTune.checked;
      paintOpus();
      syncAudioParams();
      applyQuality();
      toast(
        S.audio.opusTune
          ? 'Ручной Opus применится полностью при следующем подключении'
          : 'Opus — авто: SDP больше не переписываем'
      );
    };
  }
  paintOpus();
  sBitrate.onchange = () => {
    S.audio.bitrate = Number(sBitrate.value);
    syncAudioParams();
    applyQuality();
  };

  // v37: RED — защита голоса от потерь (порядок кодеков при следующем согласовании)
  const sRed = $('#sRed', b);
  if (sRed) {
    sRed.checked = S.red;
    sRed.onchange = () => {
      S.red = sRed.checked;
      try { localStorage.zvRed = S.red ? '1' : '0'; } catch {}
      toast(S.red ? 'Защита голоса от потерь включится при следующем подключении' : 'RED выключен — при следующем подключении голос без копий');
    };
  }

  // Режим сети и обхода блокировок
  const sNetMode = $('#sNetMode', b);
  sNetMode.value = S.audio.netMode;
  sNetMode.onchange = async () => {
    S.audio.netMode = sNetMode.value;
    syncAudioParams();
    if (S.audio.netMode === 'bridge') {
      if (S.peer) activateBridge('Включён режим моста без TURN');
      if (S.pc && rosterCount() <= 1) {
        // v40: гасим прямой путь — иначе голос идёт и по P2P, и мостом
        try {
          S.pc.setConfiguration(mainPcConfig());
          restartIce();
        } catch {}
      }
    } else if (S.audio.netMode === 'relay') {
      // «Только TURN» — единственный случай, когда TURN грузится немедленно.
      const ok = await ensureTurnLoaded('режим «только TURN» включён вручную');
      if (!ok) toast('TURN недоступен: нет серверов в config.js и в Worker. Работаем через direct + мост');
      else if (S.pc) {
        try {
          S.pc.setConfiguration(mainPcConfig());
          restartIce();
        } catch {}
      }
    } else {
      if (S.pc?.connectionState === 'connected') stopBridge();
      if (S.pc) {
        try {
          S.pc.setConfiguration(mainPcConfig());
          restartIce();
        } catch {}
      }
    }
  };

  // v38: проверка рингтона (v39: выбор оформления убран — одно оформление).
  const sTestRing = $('#sTestRing', b);
  if (sTestRing) {
    sTestRing.onclick = () => {
      if (ringCtx) {
        stopRingtone();
        return;
      }
      startRingtone();
      setTimeout(() => {
        if (!S.incoming) stopRingtone();
      }, 4000);
    };
  }
  // v28 (G): «Свой сервер» — адрес собственного Worker. Применяется всеми
  // модулями через getWorkerBase(): новые подключения сразу, слушатель
  // входящих перезапускается; идущий звонок сервер не меняет.
  const sWorkerUrl = $('#sWorkerUrl', b);
  const sWorkerState = $('#sWorkerState', b);
  const renderWorkerState = () => {
    if (sWorkerState) {
      sWorkerState.textContent =
        'Сейчас используется: ' +
        getWorkerBase() +
        (getWorkerBase() === DEFAULT_WORKER_URL ? ' (сервер по умолчанию)' : ' (свой сервер)');
    }
  };
  const restartInboxForWorkerChange = () => {
    try {
      S.inboxListener?.close?.();
    } catch {}
    try {
      S.inboxDialListener?.close?.();
    } catch {}
    S.inboxListener = null;
    S.inboxDialListener = null;
    S.chatDialTopic = null;
    startInboxListener();
  };
  if (sWorkerUrl) {
    try {
      sWorkerUrl.value = localStorage.getItem('zvWorkerUrl') || '';
    } catch {
      sWorkerUrl.value = '';
    }
    sWorkerUrl.placeholder = DEFAULT_WORKER_URL;
    renderWorkerState();
    $('#sWorkerApply', b).onclick = () => {
      const raw = sWorkerUrl.value.trim();
      if (raw && !normalizeWorkerUrl(raw)) {
        toast('Адрес сервера не принят: нужен https://… без пути к конкретному разделу');
        return;
      }
      const applied = setWorkerBase(raw || null);
      sWorkerUrl.value = raw ? applied : '';
      renderWorkerState();
      restartInboxForWorkerChange();
      toast(
        raw
          ? 'Свой сервер сохранён: ' + applied
          : 'Используется сервер по умолчанию'
      );
    };
    $('#sWorkerReset', b).onclick = () => {
      setWorkerBase(null);
      sWorkerUrl.value = '';
      renderWorkerState();
      restartInboxForWorkerChange();
      toast('Сервер сброшен на значение по умолчанию');
    };
  }

  $('#sDiag', b).onclick = openDiag;
  syncAudioParams();
  updateStatus();
}
$('#cSettings').onclick = openSettingsModal;
$('#btnHomeSettings') && ($('#btnHomeSettings').onclick = openSettingsModal);

$('#unmuteHint').onclick = () => {
  ensureAudioEngine();
  $('#remote').play().catch(() => {});
  $('#remoteAudioOut')?.play().catch(() => {});
  $('#unmuteHint').classList.add('hidden');
};
$('#cHang').onclick = hangup;

async function hangup() {
  // v38: звонок из чата — по завершении назад в чат; чат узнаёт о выходе
  // (leave/end группового звонка).
  const endedSecret = S.secret;
  const ret = S.returnTo && S.returnSecret === endedSecret ? S.returnTo : null;
  S.returnTo = null;
  S.returnSecret = null;
  S.callNameOverride = null;
  try {
    S.sig?.send({ type: 'bye' });
    S.sig?.sendByeBeacon();
  } catch {}
  // Даём очереди отправки шанс доставить bye до закрытия сокета.
  await new Promise((r) => setTimeout(r, 200));
  S.leaving = true;
  resetPC(false);
  S.callMeta = null;
  S.sig?.close();
  S.sig = null;
  S.peer = null;
  S.joined = false;
  clearInterval(S.helloTimer);
  clearInterval(S.iceRefreshTimer);
  S.log = [];
  S.via = {};
  if (S.screenTrack) {
    S.screenTrack.onended = null;
    S.screenTrack.stop();
    S.screenTrack = null;
  }
  stopLocal();
  try {
    S.wakeLock?.release();
  } catch {}
  $('#msgs').replaceChildren();
  $('#chat').classList.add('hidden');
  syncChatOpen();
  if (S.callLocked) setCallLock(false);
  $('#quickAudioPop')?.classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  show('home');
  $('#homeMsg').textContent = 'Звонок завершён';
  S.leaving = false;
  try {
    window.ZVChat?.onCallEnded?.(endedSecret);
  } catch {}
  if (ret) location.hash = ret.slice(1);
}

window.addEventListener('pagehide', () => {
  if (S.joined) {
    S.sig?.sendByeBeacon();
    S.sig?.send({ type: 'bye' });
  }
});
document.addEventListener('visibilitychange', async () => {
  if (S.joined) onViewChange();
  if (document.visibilityState === 'visible' && S.joined) {
    if (S.audioCtx && S.audioCtx.state !== 'running') recoverRemoteAudio('возврат на вкладку');
    try {
      S.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {}
    if (S.pc && S.callStart && S.pc.connectionState !== 'connected') restartIce();
  }
});


// ---------- Коммуникатор v20: личная ссылка, дозвон с рингтоном, входящие ----------
let ringCtx = null;
let ringTimer = null;
// v38: громкий рингтон. Раньше — два тихих синуса 440/480 Гц с усилением
// 0.22: маленький динамик телефона почти не воспроизводит 440 Гц, звонок
// пропускали. Теперь «звонок-трель» в полосе 1,4–2,1 кГц (там динамики
// громче всего), богатый гармониками тембр, компрессор поднимает
// воспринимаемую громкость без клиппинга; плюс вибрация в такт (Android).
let ringVibTimer = null;
let ringUnlock = null;
function startRingtone() {
  stopRingtone();
  const vib = () => {
    try {
      navigator.vibrate?.([900, 300, 900]);
    } catch {}
  };
  vib();
  ringVibTimer = setInterval(vib, 3600);
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (ringCtx = new Ctx({ latencyHint: 'interactive' }));
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 4;
    comp.ratio.value = 10;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    const master = ctx.createGain();
    master.gain.value = 1.0;
    master.connect(comp).connect(ctx.destination);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    lp.connect(master);
    // Одна «трель»: частота прыгает между двумя тонами 25 раз в секунду,
    // как у механического звонка.
    const burst = (t0, dur, f1, f2) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.015);
      g.gain.setValueAtTime(0.9, t0 + dur - 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      g.connect(lp);
      const mk = (type, mul, level) => {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = type;
        og.gain.value = level;
        for (let t = t0, i = 0; t < t0 + dur; t += 0.04, i++) {
          o.frequency.setValueAtTime((i % 2 ? f2 : f1) * mul, t);
        }
        o.connect(og).connect(g);
        o.start(t0);
        o.stop(t0 + dur + 0.03);
      };
      mk('square', 1, 0.32);
      mk('sine', 1, 0.6);
      mk('triangle', 2, 0.25);
    };
    const cycle = () => {
      if (!ringCtx || ringCtx !== ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t = ctx.currentTime + 0.05;
      burst(t, 0.9, 1400, 1760);
      burst(t + 1.15, 0.9, 1400, 1760);
      ringTimer = setTimeout(cycle, 3600);
    };
    // Браузер мог создать контекст «приостановленным» (нет жеста на
    // странице) — первый же тап/клавиша его разбудит.
    ringUnlock = () => ctx.resume().catch(() => {});
    document.addEventListener('pointerdown', ringUnlock, { once: true, capture: true });
    document.addEventListener('keydown', ringUnlock, { once: true, capture: true });
    cycle();
  } catch {}
}
function stopRingtone() {
  clearTimeout(ringTimer);
  ringTimer = null;
  clearInterval(ringVibTimer);
  ringVibTimer = null;
  try {
    navigator.vibrate?.(0);
  } catch {}
  if (ringUnlock) {
    document.removeEventListener('pointerdown', ringUnlock, { capture: true });
    document.removeEventListener('keydown', ringUnlock, { capture: true });
    ringUnlock = null;
  }
  if (ringCtx) {
    ringCtx.close().catch(() => {});
    ringCtx = null;
  }
}

// ---------- Журнал звонков (v36: длительность, маршрут и качество) ----------
const JOURNAL_MAX = 200;
const JOURNAL_TTL_MS = 30 * 24 * 3600000;
const newJournalKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Пишет запись журнала и сразу возвращает её ключ (запись — в фоне). */
function journalAdd(dir, name, outcome, extra = null, key = newJournalKey()) {
  const entry = { ts: Date.now(), dir, name: String(name || '').slice(0, 60), outcome, ...(extra || {}) };
  kvPut('calls', key, entry)
    .then(() => {
      renderCalls();
      syncLocal();
    })
    .catch((e) => console.warn('journal', e));
  return key;
}

/** Итог звонка в журнал: вызывается один раз, когда разговор закончился. */
function finishCallRecord() {
  const startedAt = S.callStart;
  const rec = S.callRec;
  const meta = S.callMeta || {};
  S.callRec = null;
  S.callMeta = null;
  S.lastSample = null;
  $('#callStats')?.classList.add('hidden');
  if (!startedAt) return;
  const sum = rec ? rec.summary() : { dur: Math.round((Date.now() - startedAt) / 1000), route: null };
  if (!sum.route && S.bridgeActive) sum.route = 'bridge';
  if (sum.dur < 2) return;
  journalAdd(meta.dir || 'link', S.peer?.name || meta.name, 'completed', { ...sum, ts: startedAt, ...(meta.fp ? { fp: meta.fp } : {}) }, meta.key);
  if (meta.fp) touchPeer(meta.fp, S.peer?.name).catch(() => {});
}

async function renderCalls() {
  let all = [];
  try {
    all = (await kvAll('calls')).filter((x) => x.value).sort((a, b) => b.value.ts - a.value.ts);
  } catch (e) {
    console.warn('journal', e);
  }
  // v38: журнал — не дольше 30 дней (и не больше JOURNAL_MAX записей).
  const cutoff = Date.now() - JOURNAL_TTL_MS;
  const keep = [];
  for (const x of all) {
    if (keep.length >= JOURNAL_MAX || !(x.value.ts > cutoff)) kvDel('calls', x.key).catch(() => {});
    else keep.push(x);
  }
  const entries = keep.map((x) => x.value);
  const book = await contactsLoad();
  renderCallsList($('#callsList'), entries, {
    onCall: (v) => callPeer(v.fp),
    onMenu: (v, el) => openContactMenu(v.fp, el, v),
    nameOf: (v) => (v.fp && book.items[v.fp]?.saved ? book.items[v.fp].name : null),
  });
  renderCallsDashboard($('#callsDash'), journalDigest(entries));
  renderContacts().catch(() => {});
}

// ---------- v38: адресная книга (контакты и «обратные номера») ----------
// identity/contacts: {v:1, items:{[fp]: {fp, name, secretEnc, saved, addedAt, lastAt}}}.
// fp — отпечаток личности собеседника (d=… его личной ссылки), secretEnc —
// секрет его ссылки под vault-ключом устройства (как секреты комнат).
// Номера из журнала, не сохранённые в контакты, забываются через 30 дней
// после последнего звонка — вместе с самим журналом. Контакты не уходят ни
// на сервер, ни в резервную копию: это только локальная записная книжка.
const PEER_TTL_MS = 30 * 24 * 3600000;
let contactsCache = null;
const validFp = (fp) => typeof fp === 'string' && /^[a-f0-9]{32}$/.test(fp);
const validSecret = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{22,}$/.test(k);
const shareBackOn = () => {
  try {
    return localStorage.zvShareBack !== '0';
  } catch {
    return true;
  }
};
/** «Обратный номер» из payload звонка: {k, d}, только если d = отпечаток звонящего. */
function backOf(payload, fromFp) {
  const b = payload && payload.back;
  if (!b || !validSecret(b.k) || !validFp(b.d)) return null;
  if (fromFp && b.d !== fromFp) return null;
  if (S.personal && b.d === S.personal.fp) return null;
  return { k: b.k, d: b.d };
}
async function contactsLoad() {
  if (contactsCache) return contactsCache;
  let rec = null;
  try {
    rec = await kvGet('identity', 'contacts');
  } catch {}
  contactsCache = rec && rec.items && typeof rec.items === 'object' ? rec : { v: 1, items: {} };
  const now = Date.now();
  let changed = false;
  for (const [fp, c] of Object.entries(contactsCache.items)) {
    if (!c || (!c.saved && now - (c.lastAt || c.addedAt || 0) > PEER_TTL_MS)) {
      delete contactsCache.items[fp];
      changed = true;
    }
  }
  if (changed) await contactsSave();
  return contactsCache;
}
async function contactsSave() {
  if (!contactsCache) return;
  try {
    await kvPut('identity', 'contacts', contactsCache);
  } catch (e) {
    console.warn('contacts', e);
  }
  syncLocal();
}
// v39: локальное изменение того, что едет на другие устройства профиля.
function syncLocal() {
  try {
    window.dispatchEvent(new CustomEvent('zv-sync-local'));
  } catch {}
}
// v39: контакты в синхронизации профиля (devices.js): секрет номера —
// в зашифрованной комнате синхронизации, время последнего звонка — до дня
// (чтобы каждый звонок не гонял синхронизацию).
window.__zvAppSync = {
  async contactsView() {
    const book = await contactsLoad();
    const out = {};
    for (const [fp, c] of Object.entries(book.items)) {
      if (!c || !validFp(fp) || !c.secretEnc) continue;
      let secret;
      try {
        secret = await decryptWithVault(c.secretEnc);
      } catch {
        continue;
      }
      out['contact:' + fp] = {
        name: c.name || '',
        secret,
        saved: !!c.saved,
        addedAt: c.addedAt || 0,
        day: Math.floor((c.lastAt || c.addedAt || 0) / 864e5),
      };
    }
    return out;
  },
  async contactApply(fp, v) {
    if (!validFp(fp)) return true;
    const book = await contactsLoad();
    if (v === null) {
      if (book.items[fp]) {
        delete book.items[fp];
        await kvPut('identity', 'contacts', book).catch(() => {});
        renderContacts().catch(() => {});
      }
      return true;
    }
    if (!v || !validSecret(v.secret)) return true;
    if (S.personal && fp === S.personal.fp) return true;
    const prev = book.items[fp];
    let secretEnc = null;
    if (prev?.secretEnc) {
      try {
        if ((await decryptWithVault(prev.secretEnc)) === v.secret) secretEnc = prev.secretEnc;
      } catch {}
    }
    book.items[fp] = {
      fp,
      name: String(v.name || '').slice(0, 40),
      secretEnc: secretEnc || (await encryptWithVault(v.secret)),
      saved: !!v.saved,
      addedAt: Number(v.addedAt) || 0,
      lastAt: Math.max(prev?.lastAt || 0, (Number(v.day) || 0) * 864e5),
    };
    await kvPut('identity', 'contacts', book).catch(() => {});
    renderContacts().catch(() => {});
    return true;
  },
};
/** Запомнить номер собеседника (save — сразу в контакты, с именем). */
async function rememberPeer({ secret, fp, name = '', save = false }) {
  if (!validSecret(secret) || !validFp(fp)) return null;
  if (S.personal && fp === S.personal.fp) return null;
  const book = await contactsLoad();
  const prev = book.items[fp];
  const now = Date.now();
  const nm = String(name || '').trim().slice(0, 40);
  book.items[fp] = {
    fp,
    name: save && nm ? nm : prev?.saved ? prev.name : nm || prev?.name || '',
    secretEnc: await encryptWithVault(secret),
    saved: !!(prev?.saved || save),
    addedAt: prev?.addedAt || now,
    lastAt: now,
  };
  await contactsSave();
  renderContacts().catch(() => {});
  return book.items[fp];
}
async function touchPeer(fp, name) {
  const book = await contactsLoad();
  const c = book.items[fp];
  if (!c) return;
  c.lastAt = Date.now();
  const nm = String(name || '').trim().slice(0, 40);
  if (!c.saved && nm) c.name = nm;
  await contactsSave();
  renderContacts().catch(() => {});
}
async function peerName(fp) {
  if (!validFp(fp)) return '';
  const c = (await contactsLoad()).items[fp];
  return c?.saved ? c.name : '';
}
async function peerSecret(fp) {
  const c = (await contactsLoad()).items[fp];
  if (!c?.secretEnc) return null;
  try {
    return await decryptWithVault(c.secretEnc);
  } catch {
    return null;
  }
}
async function callPeer(fp) {
  if (!validFp(fp)) return;
  if (S.joined) return toast('Сначала завершите текущий звонок');
  const secret = await peerSecret(fp);
  if (!validSecret(secret)) return toast('Номер не найден — попросите ссылку заново');
  hideContactMenu();
  S.autoCallPending = true;
  const hash = 'k=' + secret + '&d=' + fp;
  if (location.hash.slice(1) === hash) route();
  else location.hash = hash;
}
async function renderContacts() {
  const ul = $('#contactsList');
  if (!ul) return;
  const book = await contactsLoad();
  const list = Object.values(book.items)
    .filter((c) => c.saved)
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || String(a.name).localeCompare(String(b.name), 'ru'));
  renderContactsList(ul, list, {
    onCall: (c) => callPeer(c.fp),
    onMenu: (c, el) => openContactMenu(c.fp, el, null),
  });
}

// Меню контакта / записи журнала. Удаление — в два нажатия (как в чатах).
let contactMenuFp = null;
function hideContactMenu() {
  $('#contactMenu')?.classList.add('hidden');
  contactMenuFp = null;
}
async function openContactMenu(fp, anchor, entry) {
  const menu = $('#contactMenu');
  if (!menu || !validFp(fp)) return;
  if (contactMenuFp === fp && !menu.classList.contains('hidden')) return hideContactMenu();
  const c = (await contactsLoad()).items[fp];
  if (!c) return toast('Номер этого звонка не сохранился (истёк срок или звонивший его не передал)');
  contactMenuFp = fp;
  const del = $('#contactActDel');
  if (del) {
    delete del.dataset.armed;
    (del.querySelector('span') || del).textContent = c.saved ? 'Удалить контакт' : 'Забыть номер';
  }
  $('#contactActSave')?.classList.toggle('hidden', !!c.saved);
  $('#contactActRename')?.classList.toggle('hidden', !c.saved);
  menu.dataset.name = (entry && entry.name) || c.name || '';
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 220;
  const mh = menu.offsetHeight || 200;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const top = r.bottom + mh + 8 > vh ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, Math.min(vw - mw - 8, r.right - mw)) + 'px';
}
document.addEventListener(
  'pointerdown',
  (e) => {
    const menu = $('#contactMenu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || e.target.closest?.('.call-li')) return;
    hideContactMenu();
  },
  true
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContactMenu();
});

// Редактор контакта: добавить по ссылке, сохранить номер из журнала, переименовать.
let contactEditFp = null;
function openContactEditor(fp = null, name = '') {
  const box = $('#contactAddBox');
  if (!box) return;
  contactEditFp = fp;
  box.classList.remove('hidden');
  $('#contactAddLink')?.classList.toggle('hidden', !!fp);
  const nm = $('#contactAddName');
  if (nm) {
    nm.value = name || '';
    nm.focus();
  }
  if (!fp && $('#contactAddLink')) $('#contactAddLink').value = '';
  const note = $('#contactAddNote');
  if (note) note.textContent = '';
}
function closeContactEditor() {
  $('#contactAddBox')?.classList.add('hidden');
  contactEditFp = null;
}
$('#btnContactAdd') &&
  ($('#btnContactAdd').onclick = () => {
    if ($('#contactAddBox')?.classList.contains('hidden')) openContactEditor(null, '');
    else closeContactEditor();
  });
$('#contactAddCancel') && ($('#contactAddCancel').onclick = closeContactEditor);
$('#contactAddSave') &&
  ($('#contactAddSave').onclick = async () => {
    const note = $('#contactAddNote');
    const say = (t) => {
      if (note) note.textContent = t;
    };
    const name = ($('#contactAddName')?.value || '').trim().slice(0, 40);
    if (!name) return say('Введите имя — его видите только вы.');
    if (contactEditFp) {
      const book = await contactsLoad();
      const c = book.items[contactEditFp];
      if (!c) return say('Номер не найден.');
      c.name = name;
      c.saved = true;
      await contactsSave();
      closeContactEditor();
      renderCalls().catch(() => {});
      return;
    }
    const raw = ($('#contactAddLink')?.value || '').trim();
    const t = parseCallLink(raw);
    if (!t || !t.fp) return say('Нужна личная ссылка целиком (с частью «&d=…»): её копируют во вкладке «Мой номер».');
    if (S.personal && t.fp === S.personal.fp) return say('Это ваша собственная ссылка.');
    await rememberPeer({ secret: t.secret, fp: t.fp, name, save: true });
    closeContactEditor();
    toast('Контакт сохранён');
    renderCalls().catch(() => {});
  });
$('#contactActCall') &&
  ($('#contactActCall').onclick = () => {
    const fp = contactMenuFp;
    hideContactMenu();
    callPeer(fp);
  });
$('#contactActSave') &&
  ($('#contactActSave').onclick = () => {
    const fp = contactMenuFp;
    const name = $('#contactMenu')?.dataset.name || '';
    hideContactMenu();
    openContactEditor(fp, name);
  });
$('#contactActRename') &&
  ($('#contactActRename').onclick = async () => {
    const fp = contactMenuFp;
    hideContactMenu();
    openContactEditor(fp, (await contactsLoad()).items[fp]?.name || '');
  });
$('#contactActCopy') &&
  ($('#contactActCopy').onclick = async () => {
    const fp = contactMenuFp;
    hideContactMenu();
    const secret = await peerSecret(fp);
    if (!validSecret(secret)) return toast('Номер не найден');
    const link = `${location.origin}${location.pathname}#k=${secret}&d=${fp}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Ссылка скопирована');
    } catch {
      toast('Не удалось скопировать');
    }
  });
$('#contactActDel') &&
  ($('#contactActDel').onclick = async () => {
    const btn = $('#contactActDel');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      (btn.querySelector('span') || btn).textContent = 'Точно удалить?';
      return;
    }
    const fp = contactMenuFp;
    hideContactMenu();
    const book = await contactsLoad();
    delete book.items[fp];
    await contactsSave();
    renderCalls().catch(() => {});
  });

// ---------- v38: «Сменить номер» и «Стереть всё» ----------
// Отзыв Inbox, который не удалось выполнить сразу (нет сети), повторяется
// при следующих запусках: иначе по старой ссылке ещё приходили бы пуши.
const RETIRE_KEY = 'zvRetirePending';
function pendingRetire() {
  try {
    const v = JSON.parse(localStorage.getItem(RETIRE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && /^[a-z0-9-]{16,80}$/.test(t)) : [];
  } catch {
    return [];
  }
}
function setPendingRetire(list) {
  try {
    if (list.length) localStorage.setItem(RETIRE_KEY, JSON.stringify([...new Set(list)].slice(0, 8)));
    else localStorage.removeItem(RETIRE_KEY);
  } catch {}
}
async function retireTopics(topics, bundle) {
  const left = [];
  for (const t of topics) {
    const r = await inboxRetire(getWorkerBase(), t, bundle).catch(() => null);
    // 403: устройства там уже нет (стёрт ранее / не регистрировался) — готово.
    if (!r || (r.status !== 200 && r.status !== 403)) left.push(t);
  }
  return left;
}
let retryingRetire = false;
async function retryPendingRetire() {
  const list = pendingRetire();
  if (!list.length || retryingRetire || !S.personal || !getWorkerBase()) return;
  retryingRetire = true;
  try {
    setPendingRetire(await retireTopics(list, S.personal));
  } finally {
    retryingRetire = false;
  }
}
function stopInboxListeners() {
  try {
    S.inboxListener?.close?.();
  } catch {}
  try {
    S.inboxDialListener?.close?.();
  } catch {}
  S.inboxListener = null;
  S.inboxDialListener = null;
  S.chatDialTopic = null;
}

async function changeNumber(say, keep = []) {
  const prev = S.personal || (await getPersonal());
  if (!prev) throw new Error('номера ещё нет');
  // v39: на подключённом устройстве master-ключа нет — номер меняет основное.
  if (!(await adminSigner().catch(() => null))) {
    throw new Error('сменить номер можно только на основном устройстве профиля (или после восстановления по фразе)');
  }
  if (hasOtherDevices()) {
    return rotateWithDevices(() => changeNumberCore(prev, say), keep);
  }
  return changeNumberCore(prev, say);
}
async function changeNumberCore(prev, say) {
  const oldTopics = [];
  try {
    oldTopics.push((await deriveRoom(prev.secret)).topic);
  } catch {}
  if (prev.masterPub) oldTopics.push(await chatDialTopic(prev.masterPub));
  say('Удаляем старую резервную копию…');
  let bk = null;
  try {
    bk = await window.__zvBackup?.deleteServer?.();
  } catch {}
  say('Создаём новый номер…');
  stopInboxListeners();
  const { next } = await rotatePersonal();
  S.personal = next;
  S.personalRoom = await deriveRoom(next.secret);
  say('Отключаем старую ссылку на сервере…');
  const left = await retireTopics(oldTopics, next);
  setPendingRetire([...pendingRetire(), ...left]);
  await refreshPersonalUI();
  window.ZVChat?.identityChanged?.();
  window.__zvBackup?.render?.()?.catch?.(() => {});
  let msg = 'Готово: новый номер создан. Отправьте новую ссылку тем, кому доверяете.';
  if (left.length) msg += ' Старая ссылка будет отключена на сервере, как только появится связь.';
  if (bk?.had) msg += ' Резервную копию создайте заново — старая фраза больше не подходит.';
  return msg;
}

async function wipeEverything(say, { backupToo = false, revoked = false, query = 'wiped=1' } = {}) {
  say('Стираем…');
  if (S.joined) await Promise.resolve(hangup()).catch(() => {});
  const tasks = [];
  const p = S.personal || (await getPersonal().catch(() => null));
  // v39: у профиля есть другие устройства — номер живёт на них: этот
  // аппарат только отвязывается (сервер входящих забывает его одного),
  // а не гасит номер целиком. Отвязанное (revoked) — уже отвязано.
  const multi = !revoked && hasOtherDevices();
  if (multi) {
    tasks.push(unlinkSelf().catch(() => {}));
  } else if (p && getWorkerBase() && !revoked) {
    tasks.push(
      (async () => {
        const topics = [];
        try {
          topics.push((await deriveRoom(p.secret)).topic);
        } catch {}
        if (p.masterPub) topics.push(await chatDialTopic(p.masterPub));
        await retireTopics([...topics, ...pendingRetire()], p);
      })().catch(() => {})
    );
  }
  if (backupToo) tasks.push(Promise.resolve(window.__zvBackup?.deleteServer?.()).catch(() => {}));
  await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 6000))]);
  stopInboxListeners();
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const sub = await reg?.pushManager?.getSubscription?.();
    await sub?.unsubscribe?.();
  } catch {}
  await wipeDatabase();
  try {
    localStorage.clear();
  } catch {}
  try {
    sessionStorage.clear();
  } catch {}
  try {
    for (const k of await caches.keys()) await caches.delete(k);
  } catch {}
  try {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister();
  } catch {}
  location.replace(location.pathname + '?' + query);
}

let dangerKind = null;
function openDanger(kind) {
  const box = $('#dangerBox');
  if (!box) return;
  dangerKind = kind;
  const title = $('#dangerTitle');
  const text = $('#dangerText');
  const go = $('#dangerGo');
  const note = $('#dangerNote');
  if (note) note.textContent = '';
  $('#wipeBackupOpt')?.classList.toggle('hidden', kind !== 'wipe');
  const wbt = $('#wipeBackupToo');
  if (wbt) wbt.checked = false;
  const keepBox = $('#dangerKeepBox');
  if (keepBox) {
    keepBox.replaceChildren();
    keepBox.classList.add('hidden');
  }
  if (kind === 'number') {
    title.textContent = 'Сменить номер?';
    text.textContent =
      'Будет создана новая личная ссылка — новый крипто-номер. По старой ссылке до вас больше не дозвониться: сервер удалит её вместе с push-подписками и пропущенными. Новую ссылку отправьте заново тем, кому доверяете. Чаты, контакты и журнал останутся. Резервную копию (17 слов) нужно будет создать заново.';
    (go.querySelector('span') || go).textContent = 'Сменить номер';
    // v39: другие устройства профиля — выбрать, какие получат новый номер
    // (остальные отвязываются: как смена номера с потерянным телефоном).
    const cands = hasOtherDevices() ? rotationCandidates() : [];
    if (keepBox && cands.length) {
      const head = document.createElement('p');
      head.className = 'hint';
      head.textContent = 'Новый номер получат отмеченные устройства. Снимите галочку с потерянного или чужого — оно будет отвязано.';
      keepBox.append(head);
      for (const c of cands) {
        const lab = document.createElement('label');
        lab.className = 'check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.keepDev = c.dev;
        lab.append(cb, ` ${c.label} · ключ …${c.dev.slice(-6)}`);
        keepBox.append(lab);
      }
      keepBox.classList.remove('hidden');
    }
    if (isLinkedDevice() || dangerKind === 'number') {
      adminSigner()
        .then((a) => {
          if (a || dangerKind !== 'number') return;
          text.textContent =
            'Номер профиля меняет основное устройство (на нём хранится master-ключ) или устройство, где введена фраза восстановления. Откройте «Мой номер» на основном устройстве.';
          go.disabled = true;
        })
        .catch(() => {});
    }
  } else {
    title.textContent = 'Стереть всё с этого устройства?';
    text.textContent = hasOtherDevices()
      ? 'С этого устройства будут удалены личность, чаты и их ключи, контакты, журнал, настройки и кэш; устройство отвяжется от профиля. Номер продолжит работать на других ваших устройствах.' +
        (isLinkedDevice() ? '' : ' Это основное устройство: после стирания подключать новые устройства и менять номер можно будет только с фразой восстановления.')
      : 'Будут удалены личность и номер, все чаты и их ключи, контакты, журнал звонков, настройки, кэш приложения и push-подписка; сервер забудет ваш номер. Отменить нельзя. Если резервная копия включена и вы оставите её на сервере, личность и список чатов можно вернуть фразой из 17 слов.';
    (go.querySelector('span') || go).textContent = 'Стереть всё';
  }
  delete go.dataset.armed;
  go.disabled = false;
  box.classList.remove('hidden');
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
$('#btnChangeNumber') && ($('#btnChangeNumber').onclick = () => openDanger('number'));
$('#btnWipeAll') && ($('#btnWipeAll').onclick = () => openDanger('wipe'));
$('#dangerCancel') &&
  ($('#dangerCancel').onclick = () => {
    $('#dangerBox')?.classList.add('hidden');
    dangerKind = null;
  });
$('#dangerGo') &&
  ($('#dangerGo').onclick = async () => {
    const go = $('#dangerGo');
    const note = $('#dangerNote');
    const say = (t) => {
      if (note) note.textContent = t;
    };
    // Второе нажатие подтверждает: случайный тап ничего не сотрёт.
    if (!go.dataset.armed) {
      go.dataset.armed = '1';
      (go.querySelector('span') || go).textContent = dangerKind === 'number' ? 'Точно сменить?' : 'Точно стереть?';
      return;
    }
    go.disabled = true;
    try {
      if (dangerKind === 'number') {
        const keep = [...document.querySelectorAll('#dangerKeepBox input[data-keep-dev]')]
          .filter((x) => x.checked)
          .map((x) => x.dataset.keepDev);
        const msg = await changeNumber(say, keep);
        say(msg);
        toast('Номер сменён');
        setTimeout(() => $('#dangerBox')?.classList.add('hidden'), 9000);
      } else if (dangerKind === 'wipe') {
        await wipeEverything(say, { backupToo: !!$('#wipeBackupToo')?.checked });
      }
    } catch (e) {
      say('Не получилось: ' + (e?.message || e));
      go.disabled = false;
      delete go.dataset.armed;
    }
  });
$('#shareBack') &&
  ($('#shareBack').onchange = (e) => {
    try {
      localStorage.zvShareBack = e.target.checked ? '1' : '0';
    } catch {}
    syncLocal();
  });

async function refreshPersonalUI() {
  if (!$('#personalBox')) return;
  let has;
  try {
    has = await hasPersonal();
  } catch (e) {
    // v22: не молчим — владелец должен видеть, что хранилище недоступно.
    const hm = $('#homeMsg');
    if (hm) hm.textContent = 'Не удалось открыть локальное хранилище: ' + (e?.message || e);
    return;
  }
  $('#personalNone')?.classList.toggle('hidden', has);
  $('#personalMain')?.classList.toggle('hidden', !has);
  if (!has) return;
  const p = await getPersonal();
  S.personal = p;
  if (!S.personalRoom) S.personalRoom = await deriveRoom(p.secret);
  const linkEl = $('#personalLink');
  if (linkEl) linkEl.value = personalLinkOf(p);
  startInboxListener();
  loadMissed().catch(() => {});
  updatePushUI();
  ensurePushSub().catch(() => {});
  const sb = $('#shareBack');
  if (sb) sb.checked = shareBackOn();
  retryPendingRetire().catch(() => {});
  // v39: синхронизация с другими устройствами профиля (если они есть).
  startDevices().catch((e) => console.warn('devices', e));
}

// v39: события синхронизации профиля (devices.js).
window.addEventListener('zv-identity-changed', () => {
  // Номер сменён на основном устройстве (или это устройство только что
  // подключено): новый секрет, новый topic, новый сертификат.
  stopInboxListeners();
  resetIdentityCache();
  S.personal = null;
  S.personalRoom = null;
  refreshPersonalUI().catch(() => {});
  window.ZVChat?.identityChanged?.();
  window.__zvBackup?.render?.()?.catch?.(() => {});
});
window.addEventListener('zv-device-revoked', (e) => {
  // Это устройство отвязано (с основного или само): стираем данные
  // профиля локально; номер на сервере не трогаем — он живёт на других.
  const by = e?.detail?.by || '';
  toast(by === 'self' ? 'Устройство отвязано — стираем данные' : 'Это устройство отвязано от профиля — стираем данные', 4000);
  setTimeout(() => {
    wipeEverything(() => {}, { revoked: true, query: 'unlinked=1' }).catch(() => {});
  }, by === 'self' ? 200 : 1500);
});
window.addEventListener('zv-settings-synced', () => {
  const sb = $('#shareBack');
  if (sb) sb.checked = shareBackOn();
  const nm = $('#name');
  if (nm && !S.joined && !S.callNameOverride && document.activeElement !== nm) nm.value = localStorage.zvName || '';
});
window.addEventListener('zv-journal-synced', () => {
  renderCalls();
});
window.addEventListener('zv-devices-changed', () => {
  // Новое устройство в профиле — честное уведомление на всех остальных
  // (урок фишинга через привязку: владелец должен заметить чужое).
  devicesSeenCheck().catch(() => {});
});
let knownDevs = null;
async function devicesSeenCheck() {
  const st = window.ZVDevices?.state?.();
  if (!st?.items) {
    if (knownDevs === null) knownDevs = new Set();
    return;
  }
  const now = Object.keys(st.items).filter((k) => k.startsWith('dev:') && st.items[k] && !st.items[k].del);
  if (knownDevs === null) {
    knownDevs = new Set(now);
    return;
  }
  const me = S.personal?.devicePub || (await getPersonal().catch(() => null))?.devicePub || '';
  for (const k of now) {
    if (knownDevs.has(k)) continue;
    knownDevs.add(k);
    if (k === 'dev:' + me || st.items[k]?.v?.addedBy === me) continue;
    const label = st.items[k]?.v?.label || 'Устройство';
    toast(`К вашему профилю подключено устройство: ${label}. Если это не вы — «Мой номер» → «Мои устройства» → «Отвязать».`, 8000);
  }
}

function inboxStateHandler(m) {
  if (S.incoming && m.ringId === S.incoming.ringId && m.state !== 'ringing') {
    closeIncoming();
    toast(
      m.state === 'accepted'
        ? 'Звонок принят на другом устройстве'
        : m.state === 'declined'
          ? 'Звонок отклонён на другом устройстве'
          : 'Входящий звонок завершён'
    );
  }
}

function startInboxListener() {
  if (S.inboxListener || !getWorkerBase() || !S.personal || !S.personalRoom) return;
  const p = S.personal;
  const topic = S.personalRoom.topic;
  S.inboxRegP = inboxRegister(getWorkerBase(), topic, p, S.pushSub).catch(() => {});
  S.inboxListener = new InboxListener(getWorkerBase(), topic, p, {
    onRing: (m) => handleIncomingRing(m).catch(() => {}),
    onState: inboxStateHandler,
    onStatus: (st) => {
      const el = $('#personalStatus');
      if (el) {
        el.textContent =
          st === 'online'
            ? 'Вы доступны для входящих звонков по личной ссылке'
            : 'Нет связи с сервером входящих — дозвон временно недоступен';
      }
    },
  });
  // v38: слушатель — после регистрации устройства (auth до /register сервер
  // отклоняет; раньше такой сокет молча оставался глухим до перезагрузки).
  const listener = S.inboxListener;
  Promise.resolve(S.inboxRegP).then(() => {
    if (S.inboxListener === listener) listener.connect();
  });
  // v28: второй, аддитивный слушатель дозвонa ИЗ ЧАТА. Его topic выводится
  // из публичного masterPub владельца (chatDialTopic ниже), поэтому личная
  // ссылка в чат не публикуется; payload запечатан ECDH-ключом пары
  // «эфемерный ключ звонящего ↔ ECDH-ключ устройства из чата».
  if (!S.inboxDialListener && p.masterPub) {
    chatDialTopic(p.masterPub)
      .then((dialTopic) => {
        if (S.inboxDialListener) return;
        S.chatDialTopic = dialTopic;
        // v38: с push-подпиской (раньше null — дозвон из чата в закрытую
        // вкладку не доходил никогда).
        const regP = inboxRegister(getWorkerBase(), dialTopic, p, S.pushSub).catch(() => {});
        const dl = new InboxListener(getWorkerBase(), dialTopic, p, {
          onRing: (m) => handleChatDialRing(m).catch(() => {}),
          onState: inboxStateHandler,
        });
        S.inboxDialListener = dl;
        regP.then(() => {
          if (S.inboxDialListener === dl) dl.connect();
        });
      })
      .catch(() => {});
  }
}

async function handleIncomingRing({ ringId, blob, fromFp }) {
  if (S.incoming || S.joined || !S.personalRoom) return;
  let payload = null;
  try {
    payload = await openSealed(S.personalRoom.key, blob, S.personalRoom.topic);
  } catch {}
  presentIncomingRing({ ringId, payload, fromFp, topic: S.personalRoom.topic, viaChat: false });
}

// v28: входящий дозвон из чата. blob — конверт 'ecd1.' + JSON {eph, blob}:
// внутренний blob запечатан ECDH-ключом на ECDH-публичный ключ нашего
// устройства из чата; вне чата такой ring не создать и не прочитать.
async function handleChatDialRing({ ringId, blob, fromFp }) {
  if (S.incoming || S.joined || !S.personal || !S.chatDialTopic) return;
  try {
    if (typeof blob !== 'string' || !(blob.startsWith('ecd1.') || blob.startsWith('ecd2.'))) return;
    const env = JSON.parse(new TextDecoder().decode(b64u.dec(blob.slice(5))));
    const mine = await getChatDeviceEcdh();
    if (!mine?.ecdhPriv) return;
    const key = await chatDialKey(mine.ecdhPriv, b64u.dec(env.eph), S.chatDialTopic);
    let payload = null;
    // v39: 'ecd2.' — завёртки на все устройства человека; наша — одна из них.
    for (const w of blob.startsWith('ecd2.') ? (Array.isArray(env.wraps) ? env.wraps.slice(0, 5) : []) : [env.blob]) {
      try {
        payload = await openSealed(key, w, S.chatDialTopic);
      } catch {
        payload = null;
      }
      if (payload) break;
    }
    if (!payload) return;
    presentIncomingRing({ ringId, payload, fromFp, topic: S.chatDialTopic, viaChat: true });
  } catch {}
}

function presentIncomingRing({ ringId, payload, fromFp, topic, viaChat }) {
  if (S.incoming || S.joined) return;
  // v38: без имени — анонимное из отпечатка звонящего (стабильно для одного
  // и того же человека, но ничего о нём не раскрывает).
  const name = String(payload?.name || '').trim() || anonName(fromFp || ringId);
  const back = backOf(payload, fromFp);
  S.incoming = { ringId, payload, fromFp, topic, name, back };
  if (back) rememberPeer({ secret: back.k, fp: back.d, name }).catch(() => {});
  $('#inName').textContent = name;
  $('#inMeta').textContent = viaChat
    ? `Входящий звонок из чата · отпечаток ${String(fromFp || '').slice(0, 8)}…`
    : `Входящий звонок по личной ссылке · отпечаток ${String(fromFp || '').slice(0, 8)}…`;
  $('#inAvatar').textContent = (name.trim()[0] || '?').toUpperCase();
  $('#incomingCall')?.classList.remove('hidden');
  startRingtone();
  inboxAck(getWorkerBase(), topic, ringId, S.personal).catch(() => {});
  // v38: нажали «Ответить» в уведомлении — принимаем без второго тапа.
  if (S.pendingAccept && S.pendingAccept === ringId) {
    S.pendingAccept = null;
    setTimeout(() => $('#btnAccept')?.click(), 60);
  }
}

function closeIncoming() {
  stopRingtone();
  $('#incomingCall')?.classList.add('hidden');
  S.incoming = null;
}

$('#btnAccept') &&
  ($('#btnAccept').onclick = async () => {
    const inc = S.incoming;
    if (!inc || !S.personal) return;
    closeIncoming();
    await inboxAnswer(getWorkerBase(), inc.topic || S.personalRoom.topic, inc.ringId, 'accepted', {
      devicePub: S.personal.devicePub,
      sign: (t) => signWithDevice(t),
    }).catch(() => {});
    const inName = inc.name || inc.payload?.name;
    const inFp = inc.back?.d || null;
    S.callMeta = { dir: 'in', name: inName, fp: inFp, key: journalAdd('in', inName, 'accepted', inFp ? { fp: inFp } : null) };
    S.autoJoinPending = true;
    let target = `k=${S.personal.secret}&d=${S.personal.fp}`;
    // v28: дозвон из чата несёт в запечатанном payload секрет отдельной
    // звонковой комнаты (1:1 из чата или групповой). Принявший входит именно
    // в неё, а не в личную комнату владельца — иначе чат-дозвон не сойдётся
    // с вызывающим. Обычный дозвон по личной ссылке payload без roomSecret
    // и идёт прежним путём.
    try {
      const ks = inc.payload?.roomSecret;
      if (ks && /^[A-Za-z0-9_-]{22,}$/.test(ks)) target = `k=${ks}`;
    } catch {}
    if (location.hash.slice(1) === target) preJoin();
    else location.hash = target;
  });
$('#btnDecline') &&
  ($('#btnDecline').onclick = async () => {
    const inc = S.incoming;
    if (!inc || !S.personal) return;
    closeIncoming();
    await inboxAnswer(getWorkerBase(), inc.topic || S.personalRoom.topic, inc.ringId, 'declined', {
      devicePub: S.personal.devicePub,
      sign: (t) => signWithDevice(t),
    }).catch(() => {});
    journalAdd('in', inc.name || inc.payload?.name, 'declined', inc.back?.d ? { fp: inc.back.d } : null);
  });

$('#btnCreatePersonal') &&
  ($('#btnCreatePersonal').onclick = async () => {
    try {
      // v38: метка устройства уходит на сервер входящих открытым текстом —
      // не отправляем туда имя пользователя.
      await ensurePersonal('Владелец');
      toast('Личная ссылка создана — отправьте её тем, кто должен вам звонить');
      refreshPersonalUI().catch(() => {});
    } catch (e) {
      // v22: раньше здесь не было try/catch — любая ошибка (например,
      // заблокированная IndexedDB) умирала молча, кнопка «не работала».
      const text = 'Не удалось создать ссылку: ' + (e?.message || e);
      toast(text);
      window.__zvShowDiag?.(text + ' Пришлите этот текст разработчику.');
    }
  });
$('#btnCopyPersonal') &&
  ($('#btnCopyPersonal').onclick = () => S.personal && copy(personalLinkOf(S.personal)));
$('#btnSharePersonal') &&
  ($('#btnSharePersonal').onclick = () =>
    S.personal &&
    navigator
      .share({ title: 'ZVONochek', text: 'Моя личная ссылка для звонков:', url: personalLinkOf(S.personal) })
      .catch(() => {}));

// ---------- v38: Web Push — автоподписка и регистрация везде ----------
// Раньше подписка жила только до перезагрузки (S.pushSub не восстанавливался),
// топик дозвона из чата регистрировался без подписки, а кнопка уведомлений
// чата вообще не подписывалась на push. Теперь: если разрешение уже дано,
// подписка сверяется/создаётся при каждом запуске и регистрируется в Inbox
// (личная ссылка + дозвон из чата) и во всех чатах (событие zv-push-sub).
const pushSupported = () =>
  'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window;
let pushEnsuring = null;
async function ensurePushSub({ interactive = false } = {}) {
  if (!pushSupported()) return null;
  if (Notification.permission === 'denied') return null;
  if (Notification.permission !== 'granted') {
    if (!interactive) return null;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return null;
  }
  if (pushEnsuring) return pushEnsuring;
  pushEnsuring = (async () => {
    // VAPID-ключ — у того же Worker, который подписывает пуши: у «своего
    // сервера» своя пара ключей; подписка на чужой ключ молча не доставлялась бы.
    const key = (await fetchJson(getWorkerBase() + '/push-key').catch(() => null))?.public;
    if (!key) return null;
    const appKey = b64u.dec(key);
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const subKey = sub?.options?.applicationServerKey;
    if (sub && subKey && b64u.enc(new Uint8Array(subKey)) !== b64u.enc(appKey)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const j = sub.toJSON();
    const next = { endpoint: j.endpoint, keys: j.keys };
    let lastEp = '';
    try {
      lastEp = localStorage.getItem('zvPushEp') || '';
    } catch {}
    const changed = !S.pushSub || S.pushSub.endpoint !== next.endpoint || lastEp !== next.endpoint;
    S.pushSub = next;
    if (changed) {
      try {
        localStorage.setItem('zvPushEp', next.endpoint);
      } catch {}
      await registerPushEverywhere().catch(() => {});
    }
    updatePushUI();
    return S.pushSub;
  })();
  try {
    return await pushEnsuring;
  } finally {
    pushEnsuring = null;
  }
}
async function registerPushEverywhere() {
  if (!S.pushSub) return;
  const base = getWorkerBase();
  if (S.personal && S.personalRoom) {
    await inboxRegister(base, S.personalRoom.topic, S.personal, S.pushSub).catch(() => {});
    if (S.chatDialTopic) await inboxRegister(base, S.chatDialTopic, S.personal, S.pushSub).catch(() => {});
  }
  try {
    window.dispatchEvent(new CustomEvent('zv-push-sub', { detail: S.pushSub }));
  } catch {}
}
window.__zvPush = {
  enable: () => ensurePushSub({ interactive: true }),
  ensure: () => ensurePushSub(),
  current: () => S.pushSub,
  supported: pushSupported,
};

function updatePushUI() {
  const b = $('#btnEnablePush');
  const hint = $('#pushHint');
  const set = (text, disabled, showHint) => {
    if (b) {
      b.disabled = disabled;
      (b.querySelector('span') || b).textContent = text;
    }
    hint?.classList.toggle('hidden', !showHint);
  };
  if (!pushSupported()) {
    set('Push-уведомления не поддерживаются браузером', true, false);
  } else if (Notification.permission === 'denied') {
    set('Уведомления запрещены в настройках браузера', true, false);
  } else if (S.pushSub) {
    set('Push включён: звонки приходят и при закрытом приложении', true, false);
  } else {
    set('Включить звонки при закрытом приложении', false, true);
  }
}
$('#btnEnablePush') &&
  ($('#btnEnablePush').onclick = async () => {
    try {
      const sub = await ensurePushSub({ interactive: true });
      if (!sub) {
        if (pushSupported() && Notification.permission !== 'granted') return toast('Разрешение на уведомления не дано');
        return toast('Сервер не поддерживает push (нужен Worker v38). Пока приложение открыто, звонки приходят и так');
      }
      toast('Готово: звонки и сообщения будут приходить и при закрытом приложении');
    } catch (e) {
      toast('Не удалось включить уведомления: ' + e.message);
    }
  });
$('#btnPushHint') && ($('#btnPushHint').onclick = () => $('#btnEnablePush')?.click());

async function loadMissed() {
  if (!S.personal || !S.personalRoom) return;
  // v38: сначала регистрация устройства (иначе первый запрос — 403).
  await Promise.resolve(S.inboxRegP).catch(() => {});
  const r = await inboxMissed(getWorkerBase(), S.personalRoom.topic, S.personal).catch(() => null);
  const items = r?.data?.missed || [];
  S.missedIds = items.map((m) => m.ring_id);
  const box = $('#missedBox');
  const list = $('#missedList');
  if (!box || !list) return;
  box.classList.toggle('hidden', items.length === 0);
  // v36: пропущенные рисуются тем же видом, что и журнал звонков.
  const entries = [];
  for (const m of items) {
    let name = anonName(m.from_fp || m.ring_id);
    let fp = null;
    try {
      const pl = await openSealed(S.personalRoom.key, m.blob, S.personalRoom.topic);
      if (pl?.name) name = String(pl.name).slice(0, 60);
      const back = backOf(pl, m.from_fp);
      if (back) {
        fp = back.d;
        await rememberPeer({ secret: back.k, fp, name }).catch(() => {});
      }
    } catch {}
    entries.push({ ts: m.ts, dir: 'in', name, outcome: 'missed', fp });
  }
  const book = await contactsLoad();
  renderCallsList(list, entries, {
    onCall: (v) => callPeer(v.fp),
    onMenu: (v, el) => openContactMenu(v.fp, el, v),
    nameOf: (v) => (v.fp && book.items[v.fp]?.saved ? book.items[v.fp].name : null),
  });
}
$('#btnMissedClear') &&
  ($('#btnMissedClear').onclick = async () => {
    if (S.missedIds?.length) {
      await inboxMissedAck(getWorkerBase(), S.personalRoom.topic, S.missedIds, S.personal).catch(() => {});
    }
    loadMissed().catch(() => {});
  });

// ---------- Исходящий дозвон владельцу личной ссылки ----------
async function startOutgoingCall() {
  if (S.outCall || !S.secret) return;
  const room = await deriveRoom(S.secret);
  let fromFp, fromDevicePub, signFn;
  if (S.personal) {
    fromFp = S.personal.fp;
    fromDevicePub = S.personal.devicePub;
    signFn = (t) => signWithDevice(t);
  } else {
    const pair = await genP256KeyPair();
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    fromDevicePub = b64u.enc(raw);
    fromFp = await fpOfPubRaw(raw);
    signFn = (t) => signWithKey(pair.privateKey, t);
  }
  const ringId = crypto.randomUUID();
  const payload = { v: 1, ringId, fromFp, fromDevicePub, name: myName(), call: 'video', ts: Date.now() };
  // v38: «обратный номер» — моя личная ссылка внутри запечатанного payload
  // (её прочтут только устройства вызываемого), чтобы мне могли перезвонить
  // из журнала. Отключается галочкой во вкладке «Мой номер».
  if (S.personal && shareBackOn()) payload.back = { k: S.personal.secret, d: S.personal.fp };
  const blob = await seal(room.key, payload, room.topic);
  S.outCall = { ringId, topic: room.topic, signFn, fromDevicePub, poll: null };
  const outFp = S.linkFp;
  if (outFp) rememberPeer({ secret: S.secret, fp: outFp }).catch(() => {});
  const outName = (await peerName(outFp)) || 'Владелец ссылки';
  S.callMeta = { dir: 'out', name: outName, fp: outFp };
  $('#outgoingCall')?.classList.remove('hidden');
  const r = await inboxRing(getWorkerBase(), room.topic, { ringId, fromFp, fromDevicePub, blob }).catch(
    () => null
  );
  if (!r || (r.status !== 201 && r.status !== 200)) {
    // v38: понятные причины вместо общего «сервер недоступен».
    toast(
      r?.status === 404
        ? 'Номер не обслуживается: владелец сменил номер или давно не заходил'
        : r?.status === 403
          ? 'Владелец ограничил звонки с этого номера'
          : r?.status === 429
            ? 'Слишком много звонков подряд — попробуйте позже'
            : 'Не удалось дозвониться: сервер входящих недоступен. Можно просто подождать в комнате',
      5000
    );
    finishOutCall('failed', true);
    return;
  }
  toast('Звоним владельцу…');
  join(); // параллельно занимаем комнату — принявший владелец войдёт сюда же
  S.outCall.poll = setInterval(pollOutCall, 2000);
}
async function pollOutCall() {
  const oc = S.outCall;
  if (!oc) return;
  const r = await inboxRingState(getWorkerBase(), oc.topic, oc.ringId).catch(() => null);
  const st = r?.data?.state;
  if (!st || st === 'ringing') return;
  if (st === 'accepted') {
    toast('Владелец принял звонок — подключаемся');
    finishOutCall('accepted', true);
  } else if (st === 'declined') {
    toast('Владелец отклонил звонок');
    journalAdd('out', S.callMeta?.name || 'Владелец ссылки', 'declined', S.callMeta?.fp ? { fp: S.callMeta.fp } : null);
    finishOutCall('declined', true);
  } else if (st === 'expired') {
    toast('Владелец не ответил — звонок попадёт ему в пропущенные');
    journalAdd('out', S.callMeta?.name || 'Владелец ссылки', 'missed', S.callMeta?.fp ? { fp: S.callMeta.fp } : null);
    finishOutCall('expired', true);
  } else if (st === 'cancelled') {
    finishOutCall('cancelled', true);
  }
}
function finishOutCall(reason, keepRoom = false) {
  const oc = S.outCall;
  if (!oc) return;
  clearInterval(oc.poll);
  S.outCall = null;
  $('#outgoingCall')?.classList.add('hidden');
}
$('#btnCallOwner') && ($('#btnCallOwner').onclick = startOutgoingCall);

// SW сообщает о пуше (приложение открыто) или о тапе по уведомлению:
// активный ring всё равно придёт через listen-WS при подключении слушателя —
// здесь просто будим слушателя, если главная ещё не открывалась.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'incoming-ring-push') {
      // v38: «Ответить» прямо в уведомлении — принять, как только ring
      // будет показан (или сразу, если экран входящего уже открыт).
      if (e.data.act === 'accept' && e.data.ringId) S.pendingAccept = e.data.ringId;
      if (S.incoming && S.pendingAccept && S.pendingAccept === S.incoming.ringId) {
        S.pendingAccept = null;
        $('#btnAccept')?.click();
        return;
      }
      refreshPersonalUI().catch(() => {});
    } else if (e.data?.type === 'open-calls') {
      document.querySelector('[data-home-tab="calls"]')?.click();
    }
  });
}
$('#btnCancelCall') &&
  ($('#btnCancelCall').onclick = async () => {
    const oc = S.outCall;
    if (!oc) return;
    await inboxCancel(getWorkerBase(), oc.topic, oc.ringId, oc.signFn, oc.fromDevicePub).catch(() => {});
    journalAdd('out', S.callMeta?.name || 'Владелец ссылки', 'cancelled', S.callMeta?.fp ? { fp: S.callMeta.fp } : null);
    finishOutCall('cancelled');
    hangup();
  });

// ---------- v28: публичный хук дозвона для чата ----------
// Чат не дублирует Inbox-протокол: он просит app.js (владельца дозвонa)
// зазвонить личной идентичности участника и открыть звонковую ссылку.
// payload ring несёт секрет отдельной звонковой комнаты (roomSecret), и
// принимающая сторона входит в неё (см. обработчик «Принять» выше).
const chatRings = new Map(); // ringId -> {topic, poll, onState, done}
function parseCallLink(linkOrSecret) {
  const raw = String(linkOrSecret || '').trim();
  if (!raw) return null;
  const frag = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw;
  const params = new URLSearchParams(frag);
  const secret = params.get('k') || (/^[A-Za-z0-9_-]{22,}$/.test(raw) ? raw : null);
  if (!secret || !/^[A-Za-z0-9_-]{22,}$/.test(secret)) return null;
  const fp = params.get('d');
  return {
    secret,
    fp: fp && /^[a-f0-9]{32}$/.test(fp) ? fp : null,
    link: `${location.origin}${location.pathname}#k=${secret}${fp && /^[a-f0-9]{32}$/.test(fp) ? '&d=' + fp : ''}`,
  };
}
async function chatDialTopic(masterPub) {
  return 'chatdial-' + (await sha256hex(b64u.dec(masterPub)));
}
async function chatDialKey(myPriv, peerPubRaw, topic) {
  const pub = await crypto.subtle.importKey(
    'raw',
    peerPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, myPriv, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('zv-chat-dial-v1'),
      info: new TextEncoder().encode(topic),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function ringPersonalFromChat(masterPub, link, opts = {}) {
  try {
    const target = parseCallLink(link);
    if (!target) return { ok: false, status: 0, error: 'неверная ссылка звонковой комнаты' };
    if (!masterPub) return { ok: false, status: 0, error: 'нет публичного ключа личности' };
    const expectedFp = await fpOfPubRaw(b64u.dec(masterPub));
    if (target.fp && target.fp !== expectedFp) {
      return { ok: false, status: 0, error: 'отпечаток ссылки не совпадает с личностью участника' };
    }
    // Адрес дозвонa из чата выводится из masterPub вызываемого, а НЕ из
    // секрета его личной ссылки: ссылка — носитель доступа, в чат она не
    // публикуется. Payload запечатан ECDH-ключом на ecdhPub устройства
    // вызываемого (чат публикует его для эпох), поэтому сервер входящих
    // payload прочитать не может.
    if (!opts.ecdhPub) return { ok: false, status: 0, error: 'у участника нет ключа обмена для дозвона' };
    const dialTopic = await chatDialTopic(masterPub);
    let fromFp, fromDevicePub;
    if (S.personal) {
      fromFp = S.personal.fp;
      fromDevicePub = S.personal.devicePub;
    } else {
      const pair = await genP256KeyPair();
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      fromDevicePub = b64u.enc(raw);
      fromFp = await fpOfPubRaw(raw);
    }
    const ringId = crypto.randomUUID();
    const payload = {
      v: 1,
      ringId,
      fromFp,
      fromDevicePub,
      name: opts.name || myName(),
      call: 'video',
      ts: Date.now(),
      roomSecret: target.secret,
      callLink: target.link,
      callKind: opts.callKind || 'single',
    };
    const eph = await genP256KeyPair(['deriveBits'], 'ECDH');
    const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    // v39: у человека несколько устройств — завёртка на каждое ('ecd2.'),
    // звонят все сразу; одно устройство — прежний формат 'ecd1.'.
    const pubs = [...new Set([opts.ecdhPub, ...(opts.ecdhPubs || [])].filter((x) => /^[A-Za-z0-9_-]{87}$/.test(x || '')))];
    let blob;
    if (pubs.length > 1) {
      const wraps = [];
      for (const pub of pubs.slice(0, 5)) {
        const k = await chatDialKey(eph.privateKey, b64u.dec(pub), dialTopic);
        wraps.push(await seal(k, payload, dialTopic));
      }
      blob = 'ecd2.' + b64u.enc(new TextEncoder().encode(JSON.stringify({ eph: b64u.enc(ephRaw), wraps })));
      while (blob.length > 4096 && wraps.length > 1) {
        wraps.pop();
        blob = 'ecd2.' + b64u.enc(new TextEncoder().encode(JSON.stringify({ eph: b64u.enc(ephRaw), wraps })));
      }
    } else {
      const dialKey = await chatDialKey(eph.privateKey, b64u.dec(opts.ecdhPub), dialTopic);
      const inner = await seal(dialKey, payload, dialTopic);
      blob =
        'ecd1.' +
        b64u.enc(
          new TextEncoder().encode(JSON.stringify({ eph: b64u.enc(ephRaw), blob: inner }))
        );
    }
    const r = await inboxRing(getWorkerBase(), dialTopic, {
      ringId,
      fromFp,
      fromDevicePub,
      blob,
    }).catch(() => null);
    if (!r || (r.status !== 201 && r.status !== 200)) {
      return {
        ok: false,
        status: r?.status || 0,
        error: r?.status === 404 ? 'участник сменил номер или давно не заходил' : 'сервер входящих недоступен',
      };
    }
    const rec = { topic: dialTopic, onState: opts.onState, done: false, poll: null };
    chatRings.set(ringId, rec);
    const started = Date.now();
    rec.poll = setInterval(async () => {
      if (rec.done) return;
      const st = await inboxRingState(getWorkerBase(), rec.topic, ringId).catch(() => null);
      const state = st?.data?.state;
      if (state && state !== 'ringing') {
        rec.done = true;
        clearInterval(rec.poll);
        chatRings.delete(ringId);
        rec.onState?.(state, { ringId });
      } else if (Date.now() - started > 90000) {
        rec.done = true;
        clearInterval(rec.poll);
        chatRings.delete(ringId);
        rec.onState?.('expired', { ringId });
      }
    }, 2000);
    return { ok: true, status: r.status, ringId, topic: dialTopic, state: 'ringing' };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
}
// v38: opts {autoJoin, name, returnTo} — из чата сразу в разговор, с ником
// чата и возвратом в чат после звонка.
function openCallLinkFromChat(link, opts = {}) {
  const target = parseCallLink(link);
  if (!target) return false;
  if (S.joined) {
    if (S.secret === target.secret) returnToCall();
    else toast('Сначала завершите текущий звонок');
    return true;
  }
  S.autoJoinPending = !!opts.autoJoin;
  S.callNameOverride = opts.name ? String(opts.name).trim().slice(0, 40) || null : null;
  S.returnTo = typeof opts.returnTo === 'string' && /^#chat=/.test(opts.returnTo) ? opts.returnTo : null;
  S.returnSecret = S.returnTo ? target.secret : null;
  const hash = 'k=' + target.secret + (target.fp ? '&d=' + target.fp : '');
  if (location.hash.slice(1) === hash) {
    route();
  } else {
    location.hash = hash;
  }
  return true;
}
window.__zvDial = {
  ringPersonal: ringPersonalFromChat,
  openCallLink: openCallLinkFromChat,
  activeCallSecret: () => (S.joined ? S.secret : null),
};
$('#callReturnBar') && ($('#callReturnBar').onclick = returnToCall);

// ---------- Групповой режим (group.js): публичный интерфейс ----------
function attachGroupAudio(track) {
  const ctx = ensureAudioEngine();
  if (!ctx || !S.remoteCompNode || !track) return null;
  try {
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(S.remoteCompNode);
    return src;
  } catch {
    return null;
  }
}
window.ZVGroupAPI = {
  get sig() { return S.sig; },
  get local() { return S.local; },
  get selfId() { return selfId; },
  get inst() { return inst; },
  get joined() { return S.joined; },
  myName,
  log,
  toast,
  pcConfig,
  ensureTurnLoaded,
  tuneOpusSdp,
  attachGroupAudio,
  isDeafened: () => S.deafened,
  peerVol: () => S.audio.peerVol,
  registerHook: (h) => {
    S.groupHook = h;
    log('Групповой модуль подключён (mesh до ' + (MAX_REMOTE_PEERS + 1) + ' участников)');
  },
};

// v22: флаг успешной загрузки модуля для watchdog в zvdiag.js — выставляется
// только здесь, в самом конце инициализации, после всех привязок обработчиков.
window.__zvAppBooted = true;

// v38: переходы из уведомлений (SW открывает окно с ?ring=…&act=accept или
// ?tab=calls). Свои параметры убираем из адреса, чужие (?openchat — чат) оставляем.
{
  const sp = new URLSearchParams(location.search);
  const ringQ = sp.get('ring');
  if (ringQ && sp.get('act') === 'accept') S.pendingAccept = ringQ;
  if (ringQ) setTimeout(() => refreshPersonalUI().catch(() => {}), 200);
  if (sp.get('tab') === 'calls') setTimeout(() => document.querySelector('[data-home-tab="calls"]')?.click(), 300);
  if (sp.has('wiped')) setTimeout(() => toast('Все данные ZVONochek на этом устройстве стёрты', 5000), 600);
  if (sp.has('unlinked')) setTimeout(() => toast('Устройство отвязано от профиля, данные ZVONochek на нём стёрты', 6000), 600);
  if (sp.has('linked')) {
    // Вкладку «Мой номер» открывает сохранённый выбор (devices.js кладёт его
    // перед перезагрузкой): отложенный клик перебивал бы уже нажатую вкладку.
    setTimeout(() => toast('Устройство подключено к профилю: тот же номер, чаты и контакты', 6000), 400);
  }
  if (sp.has('ring') || sp.has('act') || sp.has('tab') || sp.has('wiped') || sp.has('unlinked') || sp.has('linked')) {
    sp.delete('ring');
    sp.delete('act');
    sp.delete('tab');
    sp.delete('wiped');
    sp.delete('unlinked');
    sp.delete('linked');
    const q = sp.toString();
    try {
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    } catch {}
  }
}
// v38: push-подписка проверяется при каждом запуске (если разрешение уже есть).
setTimeout(() => {
  updatePushUI();
  ensurePushSub().catch(() => {});
}, 2500);
const action = new URLSearchParams(location.search).get('action');
if (action === 'new' && !location.hash) {
  const k = newSecret();
  history.replaceState(null, '', location.pathname + '#k=' + k);
  S.secret = k;
  preJoin();
} else {
  route();
}

// ---------- v34: Установка PWA на рабочий стол (Android / iOS / Desktop) и кнопка «Назад» Android ----------
let deferredPwaPrompt = null;
const isStandalonePwa = () =>
  window.matchMedia?.('(display-mode: standalone)')?.matches ||
  window.navigator?.standalone === true;

// v36: предлагаем установку, только когда она реально возможна (событие
// beforeinstallprompt или iOS Safari с ручной инструкцией). Баннер — лишь на
// телефоне и не чаще раза в 30 дней после «Скрыть»: раньше он висел в каждой
// сессии и наезжал на список чатов.
const isIosSafari = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const PWA_SNOOZE_MS = 30 * 86400000;
function pwaSnoozed() {
  try {
    return Date.now() - Number(localStorage.getItem('zvPwaDismissedAt') || 0) < PWA_SNOOZE_MS;
  } catch {
    return false;
  }
}
function syncPwaUI() {
  const canOffer = !isStandalonePwa() && (!!deferredPwaPrompt || isIosSafari());
  $('#btnInstallPwaTop')?.classList.toggle('hidden', !canOffer);
  const touch = window.matchMedia?.('(pointer: coarse)')?.matches;
  $('#pwaInstallBanner')?.classList.toggle('hidden', !canOffer || !touch || pwaSnoozed());
}

async function triggerPwaInstall() {
  if (deferredPwaPrompt) {
    try {
      deferredPwaPrompt.prompt();
      const res = await deferredPwaPrompt.userChoice;
      if (res?.outcome === 'accepted') {
        deferredPwaPrompt = null;
        toast('Приложение устанавливается на рабочий стол!');
        $('#pwaInstallBanner')?.classList.add('hidden');
        $('#btnInstallPwaTop')?.classList.add('hidden');
        closeModal();
        return;
      }
    } catch {}
  }
  const b = openModal('#tplPwaInstall');
  const nativeBox = $('#pwaNativeBox', b);
  if (nativeBox) nativeBox.classList.toggle('hidden', !deferredPwaPrompt);
  const modalBtn = $('#btnPwaModalInstall', b);
  if (modalBtn) {
    modalBtn.onclick = async () => {
      if (!deferredPwaPrompt) return;
      deferredPwaPrompt.prompt();
      const r = await deferredPwaPrompt.userChoice.catch(() => null);
      if (r?.outcome === 'accepted') {
        deferredPwaPrompt = null;
        closeModal();
      }
    };
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  syncPwaUI();
});
window.addEventListener('appinstalled', () => {
  deferredPwaPrompt = null;
  syncPwaUI();
  toast('ZVONochek установлен на рабочий стол!');
});
$('#btnInstallPwaTop') && ($('#btnInstallPwaTop').onclick = triggerPwaInstall);
$('#btnInstallPwaBanner') && ($('#btnInstallPwaBanner').onclick = triggerPwaInstall);
$('#btnDismissPwaBanner') && ($('#btnDismissPwaBanner').onclick = () => {
  try { localStorage.setItem('zvPwaDismissedAt', String(Date.now())); } catch {}
  $('#pwaInstallBanner')?.classList.add('hidden');
});
syncPwaUI();

// v34: Поддержка ярлыка PWA ?action=newchat (быстрое создание чата с иконки рабочего стола)
if (action === 'newchat' && !location.hash) {
  history.replaceState(null, '', location.pathname);
  setTimeout(() => $('#btnCreateChat')?.click(), 120);
}
