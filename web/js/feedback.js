// Control feel: synthesized mechanical clicks (iPads have no haptic motor),
// plus real vibration where the browser offers it. One vocabulary drives both.
// Patterns follow the behaviour spec section 10.

const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1; })();

function makeBuf(ctx, ms, fn) {
  const n = Math.max(1, Math.round(ctx.sampleRate * ms / 1000));
  const b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = fn(i / ctx.sampleRate, i, n);
  return b;
}

// a short resonant "tick": noise burst through a ringing resonator
function tick(ctx, { f = 3500, q = 0.9997, ms = 14, noiseMs = 1.2, gain = 1, body = 0, bodyF = 180 }) {
  let y1 = 0, y2 = 0;
  const w = 2 * Math.PI * f / ctx.sampleRate, r = Math.pow(q, 48000 / ctx.sampleRate);
  const a1 = 2 * r * Math.cos(w), a2 = -r * r;
  return makeBuf(ctx, ms, (t) => {
    const x = t < noiseMs / 1000 ? rnd() * (1 - t / (noiseMs / 1000)) : 0;
    const y = x + a1 * y1 + a2 * y2; y2 = y1; y1 = y;
    const env = Math.exp(-t * 1000 / (ms * 0.35));
    const b = body ? body * Math.sin(2 * Math.PI * bodyF * t) * Math.exp(-t * 1000 / (ms * 0.5)) : 0;
    return (y * 0.08 + b) * env * gain;
  });
}

export class Feedback {
  constructor() {
    this.enabled = true; this.volume = 0.5; this.ctx = null; this.bufs = {};
    this.lastDetent = 0;
    this.canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;
  }

  attach(ctx) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(ctx.destination);
    const B = this.bufs;
    B.down = tick(ctx, { f: 3800, ms: 12, gain: 1.0, body: 0.25, bodyF: 260 });
    B.up = tick(ctx, { f: 2600, ms: 9, gain: 0.45, body: 0.1, bodyF: 300 });
    B.hold = tick(ctx, { f: 2200, ms: 10, gain: 0.7, body: 0.2 });
    B.rumble = makeBuf(ctx, 80, (t) => Math.sin(2 * Math.PI * 70 * t) * 0.18 * (1 - t / 0.08));
    B.thunk = tick(ctx, { f: 1400, ms: 40, gain: 1.0, body: 0.6, bodyF: 120 });
    B.unthunk = tick(ctx, { f: 1700, ms: 28, gain: 0.6, body: 0.35, bodyF: 150 });
    B.detent = tick(ctx, { f: 5200, ms: 4, noiseMs: 0.4, gain: 0.35 });
    B.bump = tick(ctx, { f: 900, ms: 26, gain: 0.9, body: 0.5, bodyF: 200 });
    B.key = tick(ctx, { f: 900, ms: 22, gain: 0.5, body: 0.6, bodyF: 140 });
    B.dull = tick(ctx, { f: 500, ms: 24, gain: 0.8, body: 0.5, bodyF: 110 });
    B.save1 = makeBuf(ctx, 70, (t) => Math.sin(2 * Math.PI * 880 * t) * 0.12 * Math.exp(-t * 40));
    B.save2 = makeBuf(ctx, 120, (t) => Math.sin(2 * Math.PI * 1320 * t) * 0.16 * Math.exp(-t * 30));
    B.beat = tick(ctx, { f: 4200, ms: 6, gain: 0.25 });
  }

  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }

  play(name, gain = 1, delayMs = 0) {
    if (!this.enabled || !this.ctx || !this.bufs[name]) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.bufs[name];
    let node = s;
    if (gain !== 1) { const g = this.ctx.createGain(); g.gain.value = gain; s.connect(g); node = g; }
    node.connect(this.gain);
    s.start(this.ctx.currentTime + delayMs / 1000);
  }

  vibrate(p) { if (this.enabled && this.canVibrate) try { navigator.vibrate(p); } catch { /* not allowed */ } }

  // ---- the vocabulary ----
  press() { this.play('down'); this.vibrate(8); }
  release() { this.play('up', 1, 35); }
  holdReached() { this.play('hold'); this.play('hold', 1, 45); this.play('rumble', 1, 60); this.vibrate([10, 30, 10, 20, 40]); }
  engage() { this.play('thunk'); this.vibrate(18); }
  disengage() { this.play('unthunk'); this.vibrate(10); }
  detent() {
    const now = performance.now();
    if (now - this.lastDetent < 33) return; // rate-limited to ~30/s
    this.lastDetent = now;
    this.play('detent'); this.vibrate(3);
  }
  bump() { this.play('bump'); this.vibrate(20); }
  key(vel = 90) { this.play('key', 0.4 + 0.6 * vel / 127); this.vibrate(6); }
  blocked() { this.play('dull'); this.play('dull', 1, 90); this.vibrate([15, 60, 15]); }
  saved() { this.play('save1'); this.play('save2', 1, 90); this.vibrate([12, 70, 24]); }
  beat() { this.play('beat'); }
}
