// Tiny synthesized sound effects (no audio files needed).
export class Sound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  tone(freq, dur, type = 'sine', gain = 0.15, slide = 0) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur);
  }

  noise(dur, gain, freq) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime, n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    const src = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    src.buffer = buf;
    f.type = 'lowpass';
    f.frequency.value = freq;
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.ctx.destination);
    src.start(t);
  }

  select() { this.tone(660, 0.06, 'triangle', 0.06); }
  tap() { this.tone(180, 0.09, 'triangle', 0.25, 0.6); this.noise(0.04, 0.15, 2500); }
  crash() {
    this.noise(0.6, 0.5, 1800);
    this.tone(90, 0.35, 'sawtooth', 0.12, 0.4);
    // A few clattering voxels landing.
    for (let i = 0; i < 6; i++) setTimeout(() => this.tone(900 + Math.random() * 900, 0.03, 'square', 0.03), 250 + i * 70 + Math.random() * 60);
  }
  check() { this.tone(880, 0.12, 'square', 0.05); setTimeout(() => this.tone(660, 0.16, 'square', 0.05), 120); }
  promote() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.15, 'triangle', 0.08), i * 80)); }
}
