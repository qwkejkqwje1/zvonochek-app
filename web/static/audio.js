// Tones (ringtone, ringback, notification) and the audio bridge engine.

let ctx = null;
let sink = '';

export function audioCtx() {
  if (!ctx || ctx.state === 'closed') {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (sink && ctx.setSinkId) ctx.setSinkId(sink).catch(() => {});
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function setOutputDevice(id) {
  sink = id || '';
  if (ctx && ctx.setSinkId) ctx.setSinkId(sink).catch(() => {});
}

for (const ev of ['pointerdown', 'keydown']) {
  addEventListener(ev, () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }, { capture: true });
}

function note(c, t0, freqs, dur, vol, type = 'sine') {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.connect(c.destination);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(g);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
}

function flat(c, t0, freq, dur, vol) {
  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
  g.gain.setValueAtTime(vol, t0 + dur - 0.03);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  g.connect(c.destination);
  const o = c.createOscillator();
  o.frequency.value = freq;
  o.connect(g);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

let loop = null;
export const tones = {
  enabled: true,
  ring() {
    this.stop();
    if (!this.enabled) return;
    const play = () => {
      const c = audioCtx();
      const t = c.currentTime + 0.03;
      const seq = [[659.25, 0], [830.61, 0.16], [987.77, 0.32], [1318.5, 0.48]];
      for (const [f, d] of seq) note(c, t + d, [f, f * 2], 0.42, 0.11, 'sine');
      for (const [f, d] of seq) note(c, t + 1.0 + d, [f, f * 2], 0.42, 0.09, 'sine');
    };
    play();
    loop = setInterval(play, 3200);
  },
  ringback() {
    this.stop();
    const play = () => { const c = audioCtx(); flat(c, c.currentTime + 0.03, 425, 1.0, 0.06); };
    play();
    loop = setInterval(play, 4000);
  },
  stop() {
    if (loop) clearInterval(loop);
    loop = null;
  },
  busy() {
    this.stop();
    const c = audioCtx();
    const t = c.currentTime + 0.03;
    for (let i = 0; i < 3; i++) flat(c, t + i * 0.5, 425, 0.25, 0.06);
  },
  hangup() {
    this.stop();
    const c = audioCtx();
    const t = c.currentTime + 0.03;
    note(c, t, [784], 0.18, 0.08);
    note(c, t + 0.16, [523.25], 0.3, 0.08);
  },
  connected() {
    const c = audioCtx();
    const t = c.currentTime + 0.03;
    note(c, t, [523.25], 0.14, 0.07);
    note(c, t + 0.11, [784], 0.22, 0.07);
  },
  message() {
    if (!this.enabled) return;
    const c = audioCtx();
    const t = c.currentTime + 0.02;
    note(c, t, [1046.5], 0.16, 0.06);
    note(c, t + 0.09, [1568], 0.24, 0.05);
  },
};

// ---------------------------------------------------------------------------
// Audio bridge: Opus (WebCodecs) or PCM16 frames over a local WebSocket to the
// daemon, which forwards them over the libp2p connection (direct or relay).
// Packet: [codec u8][seq u32 BE][payload]; codec 1 = Opus 48 kHz, 2 = PCM16 16 kHz.

const ENC = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 };
const DEC = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
let opusSupport = null;

export async function canOpus() {
  if (opusSupport !== null) return opusSupport;
  try {
    opusSupport = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' &&
      !!(await AudioEncoder.isConfigSupported(ENC)).supported && !!(await AudioDecoder.isConfigSupported(DEC)).supported;
  } catch (e) {
    opusSupport = false;
  }
  return opusSupport;
}

export class Bridge {
  constructor({ cid, stream, sinkId }) {
    this.cid = cid;
    this.stream = stream;
    this.sinkId = sinkId || '';
    this.peerOpus = false;
    this.seq = 0;
    this.ts = 0;
    this.closed = false;
    this.muted = false;
    this.level = 0;
    this.remoteLevel = 0;
    this.play = null;
    this.stats = { net: null, play: null, codec: 'pcm', route: '' };
  }

  async start() {
    const c = (this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }));
    if (c.state === 'suspended') c.resume().catch(() => {});
    await c.audioWorklet.addModule('/worklet.js');
    this.opus = await canOpus();
    this.play = new AudioWorkletNode(c, 'zv-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    this.play.port.onmessage = (e) => { this.stats.play = e.data; this.remoteLevel = e.data.level || 0; };
    await this.routeOutput();
    const track = this.stream && this.stream.getAudioTracks()[0];
    if (track) {
      this.src = c.createMediaStreamSource(new MediaStream([track]));
      this.cap = new AudioWorkletNode(c, 'zv-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { frame: 960 } });
      const zero = c.createGain();
      zero.gain.value = 0;
      this.src.connect(this.cap);
      this.cap.connect(zero).connect(c.destination);
      this.cap.port.onmessage = (e) => this.onFrame(e.data.pcm, e.data.rms);
      if (this.muted) this.cap.port.postMessage({ muted: true });
    }
    if (this.opus) this.setupCodec();
    this.connect();
  }

  setupCodec() {
    try {
      this.enc = new AudioEncoder({
        output: (chunk) => {
          const b = new Uint8Array(5 + chunk.byteLength);
          b[0] = 1;
          new DataView(b.buffer).setUint32(1, this.seq++ >>> 0);
          chunk.copyTo(b.subarray(5));
          this.send(b);
        },
        error: (e) => { console.warn('opus encoder', e); this.opus = false; },
      });
      this.enc.configure({ ...ENC, opus: { frameDuration: 20000, complexity: 8, useinbandfec: true, packetlossperc: 10 } });
    } catch (e) {
      try { this.enc.configure(ENC); } catch (e2) { this.opus = false; }
    }
    try {
      this.dec = new AudioDecoder({
        output: (ad) => this.onDecoded(ad),
        error: (e) => { console.warn('opus decoder', e); this.resetDecoder(); },
      });
      this.dec.configure(DEC);
    } catch (e) {
      this.dec = null;
    }
  }

  resetDecoder() {
    try { this.dec && this.dec.close(); } catch (e) { /* ignore */ }
    this.dec = null;
    if (this.closed) return;
    try {
      this.dec = new AudioDecoder({ output: (ad) => this.onDecoded(ad), error: () => this.resetDecoder() });
      this.dec.configure(DEC);
    } catch (e) {
      this.dec = null;
    }
  }

  async routeOutput() {
    const c = this.ctx;
    this.audioEl = new Audio();
    this.audioEl.autoplay = true;
    if (this.sinkId && this.audioEl.setSinkId) this.audioEl.setSinkId(this.sinkId).catch(() => {});
    // Play through a local WebRTC loopback so Chromium's echo canceller hears it.
    try {
      const dest = c.createMediaStreamDestination();
      this.play.connect(dest);
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();
      this.loop = [pc1, pc2];
      pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
      pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});
      const got = new Promise((res, rej) => {
        pc2.ontrack = (e) => res(e.streams[0] || new MediaStream([e.track]));
        setTimeout(() => rej(new Error('loopback timeout')), 4000);
      });
      pc1.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const ans = await pc2.createAnswer();
      await pc2.setLocalDescription(ans);
      await pc1.setRemoteDescription(ans);
      this.audioEl.srcObject = await got;
      await this.audioEl.play().catch(() => {});
      this.stats.route = 'aec';
    } catch (e) {
      console.warn('bridge: loopback output unavailable, playing directly', e);
      this.closeLoop();
      try { this.play.disconnect(); } catch (e2) { /* ignore */ }
      this.play.connect(c.destination);
      if (this.sinkId && c.setSinkId) c.setSinkId(this.sinkId).catch(() => {});
      this.stats.route = 'direct';
    }
  }

  closeLoop() {
    if (this.loop) for (const pc of this.loop) { try { pc.close(); } catch (e) { /* ignore */ } }
    this.loop = null;
  }

  connect() {
    if (this.closed) return;
    const ws = (this.ws = new WebSocket(`ws://${location.host}/ws/voice?cid=${encodeURIComponent(this.cid)}`));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'stats') this.stats.net = m.stats;
        } catch (err) { /* ignore */ }
        return;
      }
      this.onPacket(new Uint8Array(e.data));
    };
    ws.onclose = () => { if (!this.closed) setTimeout(() => this.connect(), 700); };
  }

  send(b) {
    const ws = this.ws;
    if (ws && ws.readyState === 1 && ws.bufferedAmount < 48000) ws.send(b);
  }

  onFrame(pcm, rms) {
    this.level = rms || 0;
    if (this.closed) return;
    if (this.opus && this.peerOpus && this.enc && this.enc.state === 'configured') {
      this.stats.codec = 'opus';
      try {
        const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: this.ts, data: pcm });
        this.ts += 20000;
        this.enc.encode(ad);
        ad.close();
        return;
      } catch (e) {
        console.warn('encode', e);
      }
    }
    this.stats.codec = 'pcm';
    const n = Math.floor(pcm.length / 3);
    const b = new Uint8Array(5 + n * 2);
    const dv = new DataView(b.buffer);
    b[0] = 2;
    dv.setUint32(1, this.seq++ >>> 0);
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      let s = (pcm[j] * 0.25 + pcm[j + 1] * 0.5 + pcm[j + 2] * 0.25);
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      dv.setInt16(5 + i * 2, s * 32767, true);
    }
    this.send(b);
  }

  onPacket(u8) {
    if (u8.length < 6 || !this.play) return;
    const codec = u8[0];
    const seq = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1);
    const payload = u8.subarray(5);
    if (codec === 1) {
      if (!this.dec) return;
      try {
        this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: seq * 20000, data: payload }));
      } catch (e) {
        this.resetDecoder();
      }
    } else if (codec === 2) {
      const n = payload.length >> 1;
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const out = new Float32Array(n * 3);
      let prev = this.lastPcm || 0;
      for (let i = 0; i < n; i++) {
        const v = dv.getInt16(i * 2, true) / 32768;
        out[i * 3] = prev + (v - prev) / 3;
        out[i * 3 + 1] = prev + ((v - prev) * 2) / 3;
        out[i * 3 + 2] = v;
        prev = v;
      }
      this.lastPcm = prev;
      this.play.port.postMessage(out, [out.buffer]);
    }
  }

  onDecoded(ad) {
    try {
      const n = ad.numberOfFrames;
      const ch = ad.numberOfChannels;
      let out = new Float32Array(n);
      try {
        ad.copyTo(out, { planeIndex: 0, format: 'f32-planar' });
      } catch (e) {
        if (ad.format === 'f32' && ch > 1) {
          const tmp = new Float32Array(n * ch);
          ad.copyTo(tmp, { planeIndex: 0 });
          for (let i = 0; i < n; i++) out[i] = tmp[i * ch];
        } else if (ad.format && ad.format.startsWith('s16')) {
          const tmp = new Int16Array(ad.format === 's16' ? n * ch : n);
          ad.copyTo(tmp, { planeIndex: 0 });
          const step = ad.format === 's16' ? ch : 1;
          for (let i = 0; i < n; i++) out[i] = tmp[i * step] / 32768;
        } else {
          ad.copyTo(out, { planeIndex: 0 });
        }
      }
      if (ad.sampleRate && ad.sampleRate !== 48000) {
        const ratio = 48000 / ad.sampleRate;
        const res = new Float32Array(Math.round(n * ratio));
        for (let i = 0; i < res.length; i++) {
          const x = i / ratio;
          const k = Math.floor(x);
          const f = x - k;
          res[i] = (out[k] || 0) * (1 - f) + (out[k + 1] || out[k] || 0) * f;
        }
        out = res;
      }
      this.play.port.postMessage(out, [out.buffer]);
    } finally {
      ad.close();
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.cap) this.cap.port.postMessage({ muted: m });
  }

  setSink(id) {
    this.sinkId = id || '';
    if (this.audioEl && this.audioEl.setSinkId) this.audioEl.setSinkId(this.sinkId).catch(() => {});
    if (this.stats.route === 'direct' && this.ctx && this.ctx.setSinkId) this.ctx.setSinkId(this.sinkId).catch(() => {});
  }

  stop() {
    this.closed = true;
    try { this.ws && this.ws.close(); } catch (e) { /* ignore */ }
    try { this.enc && this.enc.state !== 'closed' && this.enc.close(); } catch (e) { /* ignore */ }
    try { this.dec && this.dec.state !== 'closed' && this.dec.close(); } catch (e) { /* ignore */ }
    this.closeLoop();
    if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl = null; }
    try { this.ctx && this.ctx.close(); } catch (e) { /* ignore */ }
  }
}

// level meter for a MediaStream (mic test, speaking indicator)
export function levelMeter(stream, cb) {
  const c = audioCtx();
  const track = stream.getAudioTracks()[0];
  if (!track) return () => {};
  const src = c.createMediaStreamSource(new MediaStream([track]));
  const an = c.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let raf = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    cb(Math.sqrt(s / buf.length));
    raf = setTimeout(tick, 60);
  };
  tick();
  return () => { stopped = true; clearTimeout(raf); try { src.disconnect(); } catch (e) { /* ignore */ } };
}
