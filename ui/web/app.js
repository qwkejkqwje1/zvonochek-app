import { CONFIG, getWorkerBase, setWorkerBase, normalizeWorkerUrl, DEFAULT_WORKER_URL } from './config.js?v=44';
import { newSecret, deriveRoom, safetyCode, safetyCodeBridge, b64u, seal, open as openSealed, genP256KeyPair, sha256hex } from './crypto.js?v=44';
import { hasPersonal, getPersonal, ensurePersonal, signWithDevice, signWithKey, personalLinkOf, fpOfPubRaw, getChatDeviceEcdh, rotatePersonal, encryptWithVault, decryptWithVault, adminSigner, resetIdentityCache } from './identity.js?v=44';
import { inboxRegister, inboxRing, inboxRingState, inboxAck, inboxAnswer, inboxCancel, inboxMissed, inboxMissedAck, inboxRetire, InboxListener } from './inbox.js?v=44';
import { kvGet, kvPut, kvAll, kvDel, wipeDatabase } from './store.js?v=44';
import { Signaling } from './signaling.js?v=44';
import { ROUTE_SHORT, readCounters, deriveSample, bridgeSample, CallRecorder, journalDigest, plural } from './callstats.js?v=44';
import { renderLiveStats, renderCallsDashboard, renderCallsList, renderContactsList } from './stats-ui.js?v=44';
import { anonName, randomAnonName } from './anon-names.js?v=44';
import {
  startDevices,
  hasOtherDevices,
  isLinkedDevice,
  unlinkSelf,
  rotationCandidates,
  rotateWithDevices,
  openAdminLink,
  SYNC_SETTINGS,
} from './devices.js?v=44';
import { VQ_CHOICES, deviceClass, captureTier, tierConstraints, rxCap, parseCap, videoEncoding, QLEVELS, audioCodecOrder, videoCodecOrder, CLASS_TEXT, sdpFirstCodec, audioRoute, echoWanted } from './media-policy.js?v=44';
import { ensurePushSub, loadMissed, updatePushUI, initPushUi } from './push-ui.js?v=44';
import { refreshPersonalUI, startInboxListener, initNumberAdmin } from './number-admin.js?v=44';
import { callPeer, contactsLoad, openContactMenu, peerName, rememberPeer, renderContacts, shareBackOn, syncLocal, touchPeer, initContacts } from './contacts.js?v=44';
import { adaptLoad, applyCodecPrefs, onViewChange, reapplyMediaLoad, sendRxCap, showBridgeSafety, showSafety, viewHidden, watchDeviceLoad, initMediaLoad } from './media-load.js?v=44';
import { applyQuality, noteCodecs, startStats, initCallStatsUi } from './call-stats-ui.js?v=44';
import { activateBridge, playBridgeVoice, playBridgeVoice2, stopBridge, upgradeBridge2, initBridge } from './bridge.js?v=44';
import { applyMicProcessing, attachMicToEngine, attachRemoteToEngine, ensureAudioEngine, isProcTrack, paintEchoState, paintMicTest, recoverRemoteAudio, refreshAudioRoute, setEchoMode, stopMeterLoop, stopMicTest, syncAudioParams, toggleMicTest, initAudioEngine } from './audio-engine.js?v=44';

export const APP_VERSION = 44;
export const APP_BUILD = '2026-11-01';
// Версия разработки пишется из одного места: главная (бейдж и подпись),
// экран подготовки, карточка подключения в начале звонка.
for (const el of document.querySelectorAll('[data-ver]')) el.textContent = 'v' + APP_VERSION;
for (const el of document.querySelectorAll('[data-build]')) el.textContent = APP_BUILD;
export const $ = (s, r = document) => r.querySelector(s);
export const setUse = (sel, name) => {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.setAttribute('href', '#' + name);
};
export const setBtnIcon = (sel, name) => setUse((typeof sel === 'string' ? $(sel) : sel)?.querySelector('use'), name);

// Регистрация Service Worker для быстрого старта и работы PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js?v=44').catch(() => {});
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
export const selfId = sessionStorage.zvId || (sessionStorage.zvId = randHex(8));
// Экземпляр участника. v41: новый на каждый вход в звонок (раньше — на загрузку
// страницы). При быстром перезвоне без перезагрузки собеседник видел «того же»
// участника и держал соединение от прошлого звонка (~20 с до сторожевого
// таймера), а опоздавшие сообщения прошлого сеанса (Nostr-реле повторяют
// события за последнюю минуту) принимались как свежие. Теперь собеседник
// видит «переподключился», а адресованное старому экземпляру отбрасывается.
let inst = randHex(6);
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
  if (Number(localStorage.zvSettingsV || 0) < 41) {
    // v41: эхоподавление — режим «Авто» (zvEchoMode): в наушниках и гарнитуре
    // выключено, на динамике включено (media-policy.js audioRoute). v40
    // включал AEC всем и всегда, а в наушниках он только ухудшает голос: на
    // телефоне включает «режим разговора» с обработкой производителя, в
    // Chrome на компьютере приглушает голос, когда говорят оба. Кто после v40
    // выключил AEC вручную, у того остаётся «Выключено».
    localStorage.zvEchoMode = localStorage.zvEcho === '0' ? 'off' : 'auto';
    localStorage.zvSettingsV = '41';
  }
} catch {}

export const S = {
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
    // v41: режим эхоподавления 'auto' | 'on' | 'off' (см. миграцию v41);
    // echo — действующее значение (в «Авто» — по наушникам/динамику, route).
    echoMode: ['auto', 'on', 'off'].includes(localStorage.zvEchoMode) ? localStorage.zvEchoMode : 'auto',
    echo: localStorage.zvEchoMode !== 'off',
    route: 'unknown', // 'headset' | 'speaker' | 'unknown'
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
export function show(id) {
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
export function toast(t, ms = 3200) {
  const e = $('#toast');
  if (!e) return;
  e.textContent = t;
  e.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => e.classList.add('hidden'), ms);
}
export function openModal(tplId) {
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

export function renderQr(el, text) {
  if (typeof qrcode === 'undefined' || !el) return;
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Ссылка скопирована');
  } catch {
    toast('Не удалось скопировать');
  }
}
export function beep(freq = 880, dur = 0.14) {
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
export function route() {
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

// Аудио-движок (Web Audio: громкость 0–200 %, VAD, компрессор, проверка микрофона) и эхоподавление «Авто» — audio-engine.js (v44)
initAudioEngine();

// ---------- Медиа и переключение устройств ----------
export const audioC = () => ({
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
export const loadOpts = () => ({
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
export function localTrack(kind) {
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
  await refreshAudioRoute({ useTrack: false });
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
  // v41: до первого разрешения на микрофон названия устройств скрыты —
  // уточняем маршрут сейчас и, если нужен другой режим AEC, переоткрываем.
  if (await refreshAudioRoute()) await applyMicProcessing();
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

export async function switchDevice(kind, id) {
  const micChanged = kind === 'mic' && id !== S.dev.mic;
  if (kind === 'mic') S.dev.mic = localStorage.zvMic = id;
  else S.dev.cam = localStorage.zvCam = id;
  // v41: другой микрофон — возможно, гарнитура: режим AEC до открытия.
  if (micChanged) await refreshAudioRoute({ useTrack: false });
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
  if (S.camOn) bridgeVideoHint('Камера включена');
}

// v43: мост передаёт только голос. Видео (камера, экран) уже подключено к
// WebRTC и само появится у собеседника, когда прямой путь или TURN встанет, —
// говорим об этом, чтобы включённую камеру не принимали за поломку.
function bridgeVideoHint(what) {
  if (!S.bridgeActive || S.pc?.connectionState === 'connected') return;
  toast(`${what}. Через мост идёт только голос — собеседник увидит видео, когда соединение станет прямым`, 6000);
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
    bridgeVideoHint('Показ экрана включён');
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
export async function preJoin() {
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
$('#pTestMic').onclick = () => toggleMicTest();
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
export async function fetchJson(url, ms = 4000) {
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
  // v41: остатки прошлого звонка. Опоздавшее сообщение сигналинга (Nostr-реле
  // доставляют с задержкой в секунды) после «Положить трубку» создавало
  // соединение без микрофона, и при быстром перезвоне в ту же комнату оно
  // подхватывалось: собеседник нас не слышал (tests/e2e «перезвон»).
  if (S.pc || S.bridgeActive) {
    log('Сброшено соединение, оставшееся от прошлого звонка');
    clearTimeout(S.turnTimer);
    resetPC(true); // true: S.callMeta нового звонка уже заполнен — не трогаем
    stopBridge();
  }
  S.peer = null;
  S.roster.clear();
  S.joined = true;
  show('call');
  refreshLocalView();
  syncButtons();
  syncAudioParams();
  $('#cScreen').classList.toggle('hidden', !navigator.mediaDevices.getDisplayMedia);
  $('#remote').srcObject = S.remote;
  if (!S.remoteFrameWatch) {
    S.remoteFrameWatch = true;
    watchRemoteFrames();
  }
  if (S.dev.spk) $('#remote').setSinkId?.(S.dev.spk).catch(() => {});

  // v41: сообщения принимает только сигналинг текущего звонка — закрытый
  // экземпляр (прошлый звонок) больше ничего не создаёт.
  inst = randHex(6);
  const sig = (S.sig = new Signaling({
    topic: S.room.topic,
    key: S.room.key,
    selfId,
    inst,
    brokers: CONFIG.MQTT_BROKERS,
    workerUrl: getWorkerBase(),
    relays: CONFIG.NOSTR_RELAYS,
    ntfyBase: CONFIG.NTFY_BASE,
    onMessage: (m) => {
      if (S.sig === sig && S.joined) return onSignal(m);
    },
    onStatus: (st) => {
      S.sigStatus = st;
      updateStatus();
    },
    onPeerJoined: () => {
      // Воркер сообщил, что второй участник открыл комнату — мгновенно шлём приветствие!
      hello();
    },
  }));
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
export const webCodecsBridgeSupported = () =>
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

// Аварийный аудио-мост через сигналинг (1.0 MediaRecorder, 2.0 WebCodecs Opus) — bridge.js (v44)
initBridge();

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
export function countRoute(kind) {
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
export function rosterCount() {
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
      if (S.peer && typeof m.bc === 'number') {
        const had = S.peer.bridgeCodecs;
        S.peer.bridgeCodecs = !!m.bc;
        // v42: мост уже идёт как 1.0, а собеседник умеет 2.0 — переключаемся.
        if (!had && S.peer.bridgeCodecs && S.bridgeActive && S.bridgeMode === 'mediarecorder') upgradeBridge2();
      }
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
  // v42: bc (умеет ли собеседник мост 2.0) берём сразу из того же hello/hi.
  // В режиме «только мост» activateBridge() вызывается прямо отсюда — раньше,
  // чем обработчик hello успевал записать bc, и мост всегда шёл как 1.0.
  S.peer = { id: m.from, inst: m.inst, name: m.name || 'Собеседник', seen: Date.now(), vc: m.vc === 'h264' ? 'h264' : '', bridgeCodecs: m.bc === 1 };
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
  S.renegPending = null;
  S.pendingCands = [];
  S.ackReceived = false;
  S.cands = { local: {}, remote: {} };
  S.remoteCandSeen = new Set();
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
  S.remoteFrameAt = 0; // кадры прошлой попытки не считаются
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
  // v42: первый offer (его делает невежливая сторона) всегда несёт и аудио,
  // и видео — без своего трека как recvonly. Камера собеседника встаёт в
  // ответ сразу, без пересогласования посреди рукопожатия (это и ломало
  // звонки с камерой только у одной стороны, в том числе со старыми v41).
  // Вежливой стороне так делать нельзя: addTransceiver не сопоставляется
  // с m-строками чужого offer и сам потребовал бы пересогласования.
  if (!S.polite) {
    for (const kind of ['audio', 'video']) {
      if (!pc.getTransceivers().some((t) => t.receiver.track?.kind === kind)) {
        try { pc.addTransceiver(kind, { direction: 'recvonly' }); } catch {}
      }
    }
  }

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
  pc.onnegotiationneeded = () => {
    if (S.polite && !pc.currentRemoteDescription) {
      log('Ожидаем offer от собеседника');
      return;
    }
    // v42: вежливая сторона не начинает пересогласование, пока соединение не
    // поднялось: её offer мог прийти раньше её же answer (каналы сигнала
    // разные) и был бы отброшен как встречный. Догоняем по «connected».
    if (S.polite && pc.connectionState !== 'connected') {
      if (S.renegPending !== pc) log('Пересогласование (своя камера/экран) — после соединения');
      S.renegPending = pc;
      return;
    }
    makeOffer(pc);
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

// v42: какое описание реально отправлять. Пока sendDesc ждёт сбор кандидатов,
// может начаться пересогласование: новый offer затирает localDescription, но
// answer всё равно обязан уйти — иначе собеседник навсегда застревает в
// have-local-offer. Живой звонок v41: камера была только у «вежливой»
// стороны, вместо answer дважды ушёл offer, 7 попыток, 0 RTP — только мост.
function descToSend(pc, type) {
  const ld = pc.localDescription;
  if (ld && ld.type === type) return ld;
  if (type === 'answer' && pc.currentLocalDescription?.type === 'answer') return pc.currentLocalDescription;
  return null; // наш offer откатили (встречный offer) — он больше не нужен
}

async function makeOffer(pc) {
  if (pc !== S.pc || pc.signalingState === 'closed') return;
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
}

async function sendDesc(pc) {
  const type = pc.localDescription?.type;
  if (!type) return;
  await waitGathering(pc, 450);
  const ld = pc === S.pc ? descToSend(pc, type) : null;
  if (!ld) return;
  const desc = {
    type: ld.type,
    sdp: tuneOpusSdp(ld.sdp),
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
    const full = pc === S.pc && pc.connectionState !== 'connected' ? descToSend(pc, type) : null;
    if (full) {
      const fullDesc = {
        type: full.type,
        sdp: tuneOpusSdp(full.sdp),
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
    const ld = descToSend(pc, desc.type);
    const latestDesc = ld ? { type: ld.type, sdp: tuneOpusSdp(ld.sdp) } : desc;
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
    for (const line of sdpCands(desc.sdp || '')) countRemoteCand(line);
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

// v43: один и тот же маршрут собеседника приходит и отдельным сообщением
// (trickle), и внутри SDP, и в каждой повторной отправке — раньше каждый раз
// считался заново («локальных 30» при ~16 настоящих). Считаем по адресу.
function countRemoteCand(line) {
  const p = String(line || '').replace(/^a=/, '').split(/\s+/);
  const t = / typ (\w+)/.exec(line || '')?.[1];
  if (!t || p.length < 6) return;
  const key = `${p[2]}|${p[4]}|${p[5]}|${t}`.toLowerCase(); // протокол|адрес|порт|тип
  if (!S.remoteCandSeen) S.remoteCandSeen = new Set();
  if (S.remoteCandSeen.has(key)) return;
  S.remoteCandSeen.add(key);
  S.cands.remote[t] = (S.cands.remote[t] || 0) + 1;
}

async function onCand(c) {
  if (!c || !S.pc) return;
  countRemoteCand(c.candidate);
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
    if (S.renegPending === pc) {
      S.renegPending = null;
      if (pc.signalingState === 'stable') {
        log('Соединение есть — досогласуем отложенное (камера/экран)');
        makeOffer(pc);
      }
    }
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

export function log(t) {
  const line = new Date().toLocaleTimeString('ru-RU') + '  ' + t;
  S.log.push(line);
  if (S.log.length > 350) S.log.shift();
  const el = $('#diagLog');
  if (el) {
    el.textContent = S.log.join('\n');
    el.scrollTop = 1e9;
  }
}

export function progress(pct, step) {
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
// v44: флагу muted входящей видеодорожки верить нельзя. Если оба включают
// камеру одновременно, вежливая сторона откатывает свой offer (rollback), и
// Chromium оставляет дорожку muted навсегда, хотя кадры идут и рисуются (до
// v44 у одного из двоих видео собеседника пряталось под заглушкой с
// аватаркой). Поэтому смотрим ещё и на реально показанные кадры элемента
// #remote (requestVideoFrameCallback): кадр был меньше секунды назад —
// видео есть.
const REMOTE_FRAME_FRESH_MS = 1000;
function remoteFramesFresh() {
  return performance.now() - (S.remoteFrameAt || 0) < REMOTE_FRAME_FRESH_MS;
}
function watchRemoteFrames() {
  const el = $('#remote');
  if (!el || typeof el.requestVideoFrameCallback !== 'function') return;
  const onFrame = () => {
    const wasFresh = remoteFramesFresh();
    S.remoteFrameAt = performance.now();
    if (!wasFresh) updateRemoteView();
    S.remoteFrameCb = el.requestVideoFrameCallback(onFrame);
  };
  const arm = () => {
    if (S.remoteFrameCb != null) {
      try { el.cancelVideoFrameCallback(S.remoteFrameCb); } catch {}
    }
    S.remoteFrameCb = el.requestVideoFrameCallback(onFrame);
  };
  el.addEventListener('playing', arm);
  el.addEventListener('loadedmetadata', arm);
  arm();
}

function updateRemoteView() {
  const fresh = remoteFramesFresh();
  const v = S.remote.getVideoTracks().find((t) => t.readyState === 'live' && (!t.muted || fresh));
  const camState = S.peer?.cam !== false;
  $('#remoteOff').classList.toggle('hidden', !!(v && camState && S.pc?.connectionState === 'connected'));
  // Видео держится только на свежих кадрах — перепроверим, когда они устареют
  // (собеседник выключил камеру, а дорожка так и осталась muted).
  clearTimeout(S.remoteViewTimer);
  if (v?.muted && fresh) S.remoteViewTimer = setTimeout(updateRemoteView, REMOTE_FRAME_FRESH_MS + 100);
}

export function updateStatus() {
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
    ? 'Голос идёт через мост. Видео появится, когда соединение станет прямым'
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

// Статистика звонка и панель «Качество связи» — call-stats-ui.js (v44)
initCallStatsUi();

// Нагрузка устройства → ступени видео, порядок кодеков, код сверки — media-load.js (v44)
initMediaLoad();

// ---------- Чат (DataChannel + автоматический фоллбэк через Сигналинг) и Файлы ----------
export function sendCtrl(o) {
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
export function sysMsg(text) {
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
  paintEchoState();
  syncAudioParams();
};
// v41: эхоподавление одним касанием прямо в звонке — удобно сравнить, как
// вас слышит собеседник. Ручной выбор; «Авто» — в «Все настройки звука».
$('#qaEcho').onchange = (e) => {
  setEchoMode(e.target.checked ? 'on' : 'off').catch(() => {});
  toast(e.target.checked ? 'Эхоподавление включено' : 'Эхоподавление выключено — без наушников собеседник может слышать эхо');
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
  $('#sSpk', b).onchange = async (e) => {
    S.dev.spk = localStorage.zvSpk = e.target.value;
    $('#remote').setSinkId?.(e.target.value).catch(() => {});
    $('#remoteAudioOut')?.setSinkId?.(e.target.value).catch(() => {});
    attachRemoteToEngine();
    // v41: выбрали наушники или колонки — пересчитать эхоподавление.
    if (await refreshAudioRoute()) {
      syncAudioParams();
      await applyMicProcessing();
    }
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

  // Кнопка проверки микрофона (v41: запись и воспроизведение)
  $('#sTestMic', b).onclick = () => toggleMicTest();
  paintMicTest();

  // Обработка звука
  const sNoise = $('#sNoise', b),
    sEchoMode = $('#sEchoMode', b),
    sAgc = $('#sAgc', b),
    sComp = $('#sComp', b);
  sNoise.checked = S.audio.noise;
  sEchoMode.value = S.audio.echoMode;
  sAgc.checked = S.audio.agc;
  sComp.checked = S.audio.comp;
  refreshAudioRoute().catch(() => {});

  const rebuildMicConstraints = async () => {
    S.audio.noise = sNoise.checked;
    S.audio.agc = sAgc.checked;
    syncAudioParams();
    await applyMicProcessing();
  };
  sNoise.onchange = rebuildMicConstraints;
  sEchoMode.onchange = () => setEchoMode(sEchoMode.value);
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

export async function hangup() {
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
export function startRingtone() {
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
export function stopRingtone() {
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
export function journalAdd(dir, name, outcome, extra = null, key = newJournalKey()) {
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

export async function renderCalls() {
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

// Адресная книга: контакты и «обратные номера» — contacts.js (v44)
initContacts();

// «Сменить номер» и «Стереть всё» — number-admin.js (v44)
initNumberAdmin();

// Web Push: автоподписка, кнопки уведомлений и пропущенные звонки — push-ui.js (v44)
initPushUi();

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
export function parseCallLink(linkOrSecret) {
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
export async function chatDialTopic(masterPub) {
  return 'chatdial-' + (await sha256hex(b64u.dec(masterPub)));
}
export async function chatDialKey(myPriv, peerPubRaw, topic) {
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
