// ZVONochek — групповой режим (mesh): дополнительные участники комнаты сверх
// основного собеседника. Каждый дополнительный участник = отдельное
// RTCPeerConnection (mesh), своя видеоплитка и свой аудиопоток в общий тракт.
// Групповой чат идёт через сигналинг (g_chat, обрабатывает app.js).
// Мост в группе не работает: при 3+ участниках app.js его отключает.
//
// Протокол поверх существующего сигналинга (все сообщения зашифрованы AES-GCM):
//   hello / hi  — app.js маршрутизирует сюда всё, что не от основного пира
//   g_hi        — наш ответ на чужой hello
//   desc / cand — SDP и ICE групповой сессии (с v18 — те же типы, что у
//                 основного движка: единый протокол, приёму также понятны
//                 устаревшие g_desc / g_cand от клиентов v16/v17)
const API = window.ZVGroupAPI;
if (API) {
  const $ = (s, r = document) => r.querySelector(s);
  const sessions = new Map(); // inst -> session

  const tilesEl = () => $('#tiles');

  function ensureTile(sess) {
    const box = tilesEl();
    if (!box) return null;
    box.classList.remove('hidden');
    if (sess.tile) return sess.tile;
    const tile = document.createElement('div');
    tile.className = 'tile';
    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true; // звук идёт через общий аудиотракт (или фолбэк ниже)
    const label = document.createElement('span');
    label.className = 'tile-name';
    label.textContent = sess.name || 'Участник';
    tile.append(vid, label);
    box.append(tile);
    sess.tile = tile;
    sess.videoEl = vid;
    return tile;
  }

  function dropTile(sess) {
    sess.tile?.remove();
    sess.tile = null;
    sess.videoEl = null;
    if (!sessions.size) tilesEl()?.classList.add('hidden');
  }

  function createSession(m) {
    const sess = {
      key: m.inst,
      id: m.from,
      inst: m.inst,
      name: m.name || 'Участник',
      pc: null,
      remote: new MediaStream(),
      polite: API.selfId < m.from,
      makingOffer: false,
      ignoreOffer: false,
      pending: [],
      tile: null,
      videoEl: null,
      audioSrc: null,
      dead: false,
    };
    sessions.set(sess.inst, sess);
    const pc = (sess.pc = new RTCPeerConnection(API.pcConfig()));
    for (const t of API.local.getTracks()) {
      try { pc.addTrack(t, API.local); } catch {}
    }
    pc.ontrack = ({ track }) => {
      sess.remote.addTrack(track);
      ensureTile(sess);
      if (track.kind === 'video' && sess.videoEl) {
        sess.videoEl.srcObject = new MediaStream(sess.remote.getVideoTracks());
      }
      if (track.kind === 'audio') {
        sess.audioSrc = API.attachGroupAudio(track);
        if (!sess.audioSrc && sess.videoEl) {
          // Фолбэк: звук прямо из плитки, если аудиотракт недоступен
          sess.videoEl.muted = false;
          sess.videoEl.volume = API.isDeafened() ? 0 : Math.min(1, API.peerVol() / 100);
          sess.videoEl.srcObject = sess.remote;
        }
      }
      API.log(`Группа: медиа от ${sess.name}`);
    };
    pc.onnegotiationneeded = async () => {
      if (sess.polite && !pc.currentRemoteDescription) return; // offer делает старшая сторона
      try {
        sess.makingOffer = true;
        const offer = await pc.createOffer();
        offer.sdp = API.tuneOpusSdp(offer.sdp);
        await pc.setLocalDescription(offer);
        sendDesc(sess);
      } catch (e) {
        API.log('Группа: ошибка offer: ' + e.message);
      } finally {
        sess.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        API.sig?.send({ type: 'cand', to: sess.id, toInst: sess.inst, cand: candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      API.log(`Группа: ${sess.name} — ${pc.connectionState}`);
      clearTimeout(sess.discTimer);
      if (pc.connectionState === 'connected') {
        sess.fails = 0;
        applyMeshCaps();
      }
      if (pc.connectionState === 'failed') {
        // v38: TURN — только теперь (крайнее средство) и ДЕЙСТВИТЕЛЬНО
        // применяется к этому соединению: раньше restartIce шёл со старой
        // конфигурацией без TURN и групповое соединение не поднималось.
        sess.fails = (sess.fails || 0) + 1;
        if (sess.fails > 3) {
          API.log(`Группа: ${sess.name} — соединение не восстановилось, сессия закрыта`);
          closeSession(sess);
          return;
        }
        API.ensureTurnLoaded('групповое соединение не встало').finally(() => {
          try { pc.setConfiguration(API.pcConfig()); } catch {}
          try { pc.restartIce(); } catch {}
        });
      }
      if (pc.connectionState === 'disconnected') {
        // Мобильная сеть «моргнула»: даём ICE 6 с восстановиться самому.
        sess.discTimer = setTimeout(() => {
          if (!sess.dead && pc.connectionState === 'disconnected') {
            try { pc.restartIce(); } catch {}
          }
        }, 6000);
      }
      if (pc.connectionState === 'closed') closeSession(sess);
    };
    ensureTile(sess);
    API.log(`Группа: участник ${sess.name} (mesh)`);
    return sess;
  }

  function sendDesc(sess) {
    const pc = sess.pc;
    if (!pc?.localDescription) return;
    API.sig?.send({
      type: 'desc',
      to: sess.id,
      toInst: sess.inst,
      desc: { type: pc.localDescription.type, sdp: API.tuneOpusSdp(pc.localDescription.sdp) },
    });
  }

  async function onDesc(sess, desc) {
    const pc = sess.pc;
    if (!pc) return;
    const collision = desc.type === 'offer' && (sess.makingOffer || pc.signalingState !== 'stable');
    sess.ignoreOffer = !sess.polite && collision;
    if (sess.ignoreOffer) return;
    try {
      await pc.setRemoteDescription(desc);
      for (const c of sess.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (desc.type === 'offer') {
        const answer = await pc.createAnswer();
        answer.sdp = API.tuneOpusSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        sendDesc(sess);
      }
    } catch (e) {
      API.log('Группа: ошибка SDP: ' + e.message);
    }
  }

  // v38: в mesh каждый участник отправляет своё видео КАЖДОМУ — без
  // потолков 3–4 человека с камерами забивали аплинк телефона, и
  // разваливались все соединения сразу. Потолок битрейта/кадров/размера
  // видео — по числу собеседников; звук не трогаем (Opus сам по себе лёгкий).
  function applyMeshCaps() {
    const peers = sessions.size + 1; // + основной собеседник
    const maxBitrate = peers >= 4 ? 250000 : peers >= 3 ? 380000 : 650000;
    const maxFramerate = peers >= 3 ? 20 : 24;
    const scale = peers >= 4 ? 2 : peers >= 3 ? 1.5 : 1;
    for (const sess of sessions.values()) {
      for (const sender of sess.pc?.getSenders?.() || []) {
        if (sender.track?.kind !== 'video') continue;
        try {
          const prm = sender.getParameters();
          if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
          prm.encodings[0].maxBitrate = maxBitrate;
          prm.encodings[0].maxFramerate = maxFramerate;
          prm.encodings[0].scaleResolutionDownBy = scale;
          sender.setParameters(prm).catch(() => {});
        } catch {}
      }
    }
  }

  function closeSession(sess) {
    if (sess.dead) return;
    sess.dead = true;
    clearTimeout(sess.discTimer);
    try { sess.audioSrc?.disconnect(); } catch {}
    try { sess.pc?.close(); } catch {}
    sessions.delete(sess.inst);
    dropTile(sess);
    API.log(`Группа: ${sess.name} отключился`);
    applyMeshCaps();
  }

  function onSignal(m) {
    if (!API.joined) return;
    switch (m.type) {
      case 'hello':
      case 'hi':
      case 'g_hi': {
        let sess = sessions.get(m.inst);
        if (!sess) sess = createSession(m);
        else if (m.name) {
          sess.name = m.name;
          const lbl = sess.tile?.querySelector('.tile-name');
          if (lbl) lbl.textContent = m.name;
        }
        if (m.type === 'hello') {
          API.sig?.send({ type: 'g_hi', to: m.from, toInst: m.inst, name: API.myName() });
        }
        break;
      }
      case 'desc':
      case 'g_desc': {
        const sess = sessions.get(m.inst) || createSession(m);
        onDesc(sess, m.desc);
        break;
      }
      case 'cand':
      case 'g_cand': {
        const sess = sessions.get(m.inst);
        if (!sess || !m.cand) return;
        if (!sess.pc?.remoteDescription) {
          sess.pending.push(m.cand);
          return;
        }
        sess.pc.addIceCandidate(m.cand).catch(() => {});
        break;
      }
    }
  }

  function refreshTracks() {
    for (const sess of sessions.values()) {
      if (!sess.pc) continue;
      for (const sender of sess.pc.getSenders()) {
        const kind = sender.track?.kind;
        if (!kind) continue;
        const fresh = API.local.getTracks().find((t) => t.kind === kind) || null;
        if (sender.track !== fresh) sender.replaceTrack(fresh).catch(() => {});
      }
    }
    applyMeshCaps();
  }

  API.registerHook({
    onSignal,
    onPeerBye: (m) => {
      const sess = sessions.get(m.inst);
      if (sess) closeSession(sess);
    },
    refreshTracks,
    // Для отладки из консоли
    _sessions: sessions,
  });
}
