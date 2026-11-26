// The instrument panel: layout, multi-touch input layer and LED renderer.
// Every control emits the spec's event vocabulary (6.3): down, up, long, repeat
// for buttons and keys; turn(steps, speed) for encoders; value for the pot.

export const LONG_MS = 880;    // measured on stock firmware: 850 ms no, 900 ms yes
export const RING_MS = 600;    // hold ring appears, completes at LONG_MS
const REPEAT_MS = 100;

export const BUTTONS = [
  ['FX', 'FX'], ['SEL', 'SEL'], ['ENV', 'ENV'], ['LFO', 'LFO'], ['EDIT', 'EDIT'], ['GLO', 'GLOBE'], ['HOME', 'HOME'],
  ['SAVE', 'SAVE'], ['ARP', 'ARP'], ['SEQ', 'SEQ'], ['PLAY', 'PLAY'], ['REC', 'REC'], ['OCTDN', 'OCT −'], ['OCTUP', 'OCT +'],
];
const ENCODERS = [['SELECT', 'select'], ['PRESETS', 'presets'], ['ALGO', 'algorithm']];
export const KEY_COUNT = 27;
// 27 keys from F: semitone index -> is black
const BLACK = (i) => [1, 3, 6, 8, 10].includes((i + 5) % 12);
export const EDIT_KEY_LABELS = ['OP1', 'OP2', 'OP3', 'OP4', 'OP5', 'OP6', 'PIT', 'GLO', 'MONO', 'POLY'];

const el = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};

export class Panel {
  constructor(root, handlers) {
    this.h = handlers;
    this.leds = new Map();     // name -> {el, state}
    this.keyEls = [];
    this.encAngles = {};
    this.build(root);
    this.fit();
    window.addEventListener('resize', () => this.fit());
    this.raf = () => { this.renderLeds(performance.now()); requestAnimationFrame(this.raf); };
    requestAnimationFrame(this.raf);
  }

  build(root) {
    const stage = this.stage = el('div', 'stage', root);
    stage.setAttribute('role', 'application');
    stage.setAttribute('aria-label', 'Sixop FM synthesizer');

    // screen
    const bez = el('div', 'bezel', stage);
    this.canvas = el('canvas', 'screen', bez);
    this.canvas.setAttribute('aria-label', 'Display');
    el('div', 'bezel-label', bez, '<span>SIXOP</span><small>six-operator FM</small>');

    // encoders
    const encRow = el('div', 'enc-row', stage);
    for (const [name, label] of ENCODERS) this.makeEncoder(encRow, name, label, 'big');
    const knobRow = el('div', 'knob-row', stage);
    for (let i = 1; i <= 4; i++) this.makeEncoder(knobRow, 'K' + i, String(i), 'small');

    // master pot
    const pot = el('div', 'pot-wrap', stage);
    this.makePot(pot, 'MASTER', 'master');

    // brand plate
    el('div', 'plate', stage, '<b>SIXOP</b><span>FM · 6 OP · 32 ALG</span>');

    // buttons
    const bgrid = el('div', 'btn-grid', stage);
    for (const [name, label] of BUTTONS) this.makeButton(bgrid, name, label);

    // keyboard
    const kb = el('div', 'keys', stage);
    const top = el('div', 'krow black', kb), bot = el('div', 'krow white', kb);
    let whiteIdx = 0;
    const blacks = [];
    for (let i = 0; i < KEY_COUNT; i++) {
      if (BLACK(i)) blacks.push({ i, after: whiteIdx });
      else { this.makeKey(bot, i, whiteIdx, false); whiteIdx++; }
    }
    this.whiteCount = whiteIdx;
    blacks.forEach((b, n) => this.makeKey(top, b.i, b.after, true, n));
  }

  fit() {
    const W = 1200, H = 800;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pad = Math.min(vw, vh) > 500 ? 12 : 0; // keep the case edge visible
    const s = Math.min((vw - pad * 2) / W, (vh - pad * 2) / H);
    this.scale = s;
    this.stage.style.transform = `translate(${(vw - W * s) / 2}px, ${(vh - H * s) / 2}px) scale(${s})`;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * s * 1.2);
    const px = Math.round(240 * Math.max(1, dpr));
    if (this.canvas.width !== px) { this.canvas.width = px; this.canvas.height = px; this.h.onResizeScreen && this.h.onResizeScreen(); }
  }

  // ---------- generic press handling for buttons and keys ----------
  bindPress(node, name, kind, extra = {}) {
    const st = { pointers: new Set(), down: false, timer: 0, repeat: 0, long: false };
    const fireDown = (e) => {
      st.down = true; st.long = false; st.t0 = performance.now();
      node.classList.add('down');
      node.style.setProperty('--ring', '0');
      this.h.onPress(kind, name, 'down', { ...extra, y: e && e.offsetY, h: node.clientHeight });
      st.ring = setTimeout(() => node.classList.add('holding'), RING_MS);
      st.timer = setTimeout(() => {
        st.long = true;
        node.classList.add('held');
        this.h.onPress(kind, name, 'long', extra);
        st.repeat = setInterval(() => this.h.onPress(kind, name, 'repeat', extra), REPEAT_MS);
      }, LONG_MS);
    };
    const fireUp = () => {
      if (!st.down) return;
      st.down = false;
      clearTimeout(st.timer); clearTimeout(st.ring); clearInterval(st.repeat);
      node.classList.remove('down', 'holding', 'held');
      node.classList.add('release');
      setTimeout(() => node.classList.remove('release'), 120);
      this.h.onPress(kind, name, 'up', { ...extra, long: st.long, ms: performance.now() - st.t0 });
    };
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { node.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      st.pointers.add(e.pointerId);
      if (st.pointers.size === 1) fireDown(e);
    });
    const end = (e) => { st.pointers.delete(e.pointerId); if (st.pointers.size === 0) fireUp(); };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    node.addEventListener('lostpointercapture', end);
    node.addEventListener('contextmenu', (e) => e.preventDefault());
    // keyboard access
    node.tabIndex = 0;
    node.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && !st.down) { e.preventDefault(); fireDown(); } });
    node.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fireUp(); } });
    return st;
  }

  makeButton(parent, name, label) {
    const b = el('div', 'btn', parent);
    b.dataset.name = name;
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', label);
    const cap = el('div', 'cap', b);
    const led = el('i', 'led', cap);
    el('span', 'lbl', cap, label);
    el('div', 'ring', b);
    this.leds.set(name, { el: led, node: b, state: 'dim' });
    this.bindPress(b, name, 'button');
  }

  makeKey(parent, idx, slot, black, blackN) {
    const k = el('div', 'key ' + (black ? 'k-black' : 'k-white'), parent);
    k.dataset.idx = idx;
    k.setAttribute('role', 'button');
    k.setAttribute('aria-label', 'Key ' + (idx + 1));
    if (black) k.style.left = `calc(${slot} * var(--kw) - var(--kw) * 0.5 + var(--kgap) * 0.5)`;
    else k.style.left = `calc(${slot} * var(--kw))`;
    const led = el('i', 'kled', k);
    const lab = el('span', 'klbl', k);
    if (black) k.dataset.edit = blackN;
    this.keyEls[idx] = { node: k, led, lab, black, blackN };
    this.leds.set('KEY' + idx, { el: led, node: k, state: 'dim' });
    this.bindPress(k, idx, 'key', { black, blackN });
  }

  makeEncoder(parent, name, label, size) {
    const w = el('div', 'enc-wrap ' + size, parent);
    const e = el('div', 'enc', w);
    e.setAttribute('role', 'slider');
    e.setAttribute('aria-label', label);
    e.tabIndex = 0;
    el('div', 'enc-grip', e);
    const ind = el('div', 'enc-ind', e);
    el('div', 'enc-lbl', w, label);
    this.encAngles[name] = 0;
    const turn = (steps, speed) => {
      this.encAngles[name] += steps * 15;
      ind.parentElement.style.setProperty('--a', this.encAngles[name] + 'deg');
      this.h.onTurn(name, steps, speed);
    };
    // drag: vertical or circular; 1 detent per ~12 px
    const DET = 12;
    let ptr = null, acc = 0, lastY = 0, lastX = 0, times = [];
    e.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      if (ptr !== null) return;
      ptr = ev.pointerId; try { e.setPointerCapture(ptr); } catch { /* synthetic */ }
      lastY = ev.clientY; lastX = ev.clientX; acc = 0;
      e.classList.add('touched');
      this.h.onEncTouch && this.h.onEncTouch(name, true);
    });
    e.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== ptr) return;
      const s = this.scale || 1;
      const dy = (lastY - ev.clientY) / s, dx = (ev.clientX - lastX) / s;
      lastY = ev.clientY; lastX = ev.clientX;
      acc += dy + dx * 0.6;
      while (Math.abs(acc) >= DET) {
        const dir = acc > 0 ? 1 : -1; acc -= dir * DET;
        const now = performance.now();
        times = times.filter((t) => now - t < 100); times.push(now);
        // acceleration: x1 below 4 detents/100 ms, x4 to 10, x10 above (spec 6.3)
        const rate = times.length;
        turn(dir, rate > 10 ? 10 : rate >= 4 ? 4 : 1);
      }
    });
    const end = (ev) => { if (ev.pointerId !== ptr) return; ptr = null; e.classList.remove('touched'); this.h.onEncTouch && this.h.onEncTouch(name, false); };
    e.addEventListener('pointerup', end);
    e.addEventListener('pointercancel', end);
    e.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this._wheel = (this._wheel || 0) + ev.deltaY;
      while (Math.abs(this._wheel) >= 40) { const d = this._wheel > 0 ? -1 : 1; this._wheel += d * 40; turn(d, 1); }
    }, { passive: false });
    e.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') { ev.preventDefault(); turn(1, 1); }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') { ev.preventDefault(); turn(-1, 1); }
    });
  }

  makePot(parent, name, label) {
    const w = el('div', 'pot ' + name.toLowerCase(), parent);
    const knob = el('div', 'pot-knob', w);
    el('div', 'pot-ind', knob);
    el('div', 'pot-scale', w);
    el('div', 'enc-lbl', parent, label);
    knob.setAttribute('role', 'slider');
    knob.setAttribute('aria-label', label);
    knob.tabIndex = 0;
    this.pot = { knob, value: 100 };
    let ptr = null, lastY = 0;
    const setV = (v, emit = true) => {
      v = Math.max(0, Math.min(100, v));
      const old = this.pot.value;
      this.pot.value = v;
      knob.style.setProperty('--a', (-150 + v * 3) + 'deg');
      knob.setAttribute('aria-valuenow', Math.round(v));
      if (emit && Math.round(v) !== Math.round(old)) this.h.onPot(name, Math.round(v), (v === 0 || v === 100) && old !== v);
    };
    this.setPot = (v) => setV(v, false);
    knob.addEventListener('pointerdown', (e) => { e.preventDefault(); ptr = e.pointerId; lastY = e.clientY; try { knob.setPointerCapture(ptr); } catch { /* synthetic */ } });
    knob.addEventListener('pointermove', (e) => {
      if (e.pointerId !== ptr) return;
      const dy = (lastY - e.clientY) / (this.scale || 1); lastY = e.clientY;
      setV(this.pot.value + dy * 0.5);
    });
    const end = (e) => { if (e.pointerId === ptr) ptr = null; };
    knob.addEventListener('pointerup', end); knob.addEventListener('pointercancel', end);
    knob.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setV(this.pot.value + 2);
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setV(this.pot.value - 2);
    });
    setV(100, false);
  }

  // ---------- LEDs ----------
  setLed(name, state) { const l = this.leds.get(name); if (l) l.state = state; }
  setKeyLabel(idx, text) { const k = this.keyEls[idx]; if (k) k.lab.textContent = text || ''; }
  setLatched(name, on) { const l = this.leds.get(name); if (l) l.node.classList.toggle('latched', !!on); }
  setDisabled(name, on) { const l = this.leds.get(name); if (l) l.node.classList.toggle('disabled', !!on); }

  // state -> brightness 0..1 at time t (ms). Timings from the V15 capture:
  // octave +-1 period 750 ms, +-2 400 ms, Bluetooth-style 1250 ms; dim 20%.
  level(state, t, isKey = false) {
    const bl = isKey ? this.keyBacklight : this.backlight;
    const blink = (period, on) => ((t % period) < on ? 1 : 0);
    switch (state) {
      case 'off': return 0;
      case 'dim': return bl ? 0.2 : 0;
      case 'on': return 1;
      case 'half': return 0.45;
      case 'slow': return blink(750, 370) || (bl ? 0.2 : 0);
      case 'fast': return blink(400, 230) || (bl ? 0.2 : 0);
      case 'bt': return blink(1250, 640) || (bl ? 0.2 : 0);
      case 'blink2': return blink(500, 250);
      case 'pulse': return this.pulse(t);
      default: return 0;
    }
  }
  pulse(t) {
    const d = t - (this.beatAt || -1e9);
    if (d < 0) return 0.2;
    const len = this.beatLen || 125;
    return d < len ? (this.downbeat ? 1 : 0.75) : 0.2;
  }
  beat(isDown, sixteenthMs) { this.beatAt = performance.now(); this.downbeat = isDown; this.beatLen = sixteenthMs; }

  renderLeds(t) {
    for (const [name, l] of this.leds) {
      const v = this.level(l.state, t, name.startsWith('KEY'));
      if (l.v !== v) { l.v = v; l.el.style.opacity = v.toFixed(2); l.node.classList.toggle('lit', v > 0.5); }
    }
  }
}
