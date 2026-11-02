// AudioWorklet processors for the audio bridge (used when WebRTC media
// cannot get through). Capture slices the microphone into 20 ms frames;
// playback is a small adaptive jitter buffer that never lets latency grow.

class ZvCapture extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.frame = (opts && opts.processorOptions && opts.processorOptions.frame) || 960;
    this.buf = new Float32Array(this.frame);
    this.n = 0;
    this.muted = false;
    this.port.onmessage = (e) => { if (e.data && 'muted' in e.data) this.muted = !!e.data.muted; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = this.muted ? 0 : ch[i];
      if (this.n === this.frame) {
        let sum = 0;
        for (let j = 0; j < this.frame; j++) sum += this.buf[j] * this.buf[j];
        const out = this.buf;
        this.port.postMessage({ pcm: out, rms: Math.sqrt(sum / this.frame) }, [out.buffer]);
        this.buf = new Float32Array(this.frame);
        this.n = 0;
      }
    }
    return true;
  }
}

class ZvPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];
    this.off = 0;
    this.queued = 0;
    this.playing = false;
    this.target = 2880; // 60 ms @48k before (re)starting
    this.max = 9600; // 200 ms: drop above this
    this.under = 0;
    this.level = 0;
    this.tick = 0;
    this.port.onmessage = (e) => {
      const f = e.data;
      if (!(f instanceof Float32Array) || !f.length) return;
      this.q.push(f);
      this.queued += f.length;
      while (this.queued > this.max && this.q.length > 1) {
        const d = this.q.shift();
        this.queued -= d.length - this.off;
        this.off = 0;
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    if (!this.playing && this.queued >= this.target) this.playing = true;
    let sum = 0;
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || !this.q.length) {
        out[i] = 0;
        continue;
      }
      const cur = this.q[0];
      const v = cur[this.off++];
      out[i] = v;
      sum += v * v;
      this.queued--;
      if (this.off >= cur.length) { this.q.shift(); this.off = 0; }
    }
    if (this.playing && this.queued <= 0) {
      this.playing = false;
      this.under++;
      this.target = Math.min(4800, this.target + 480); // adapt to jitter
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    this.level = Math.max(Math.sqrt(sum / out.length), this.level * 0.9);
    if (++this.tick % 25 === 0) this.port.postMessage({ level: this.level, buffered: this.queued, underruns: this.under });
    return true;
  }
}

registerProcessor('zv-capture', ZvCapture);
registerProcessor('zv-playback', ZvPlayback);
