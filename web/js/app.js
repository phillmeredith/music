// Sixop controller: modes, pages, knob maps, combos, LEDs and screen.
// Behaviour follows the FM-1 behaviour spec and the stock V15 measurements.
import { Engine } from './audio.js';
import { Feedback } from './feedback.js';
import { Store, FX_NAMES } from './store.js';
import { Panel, KEY_COUNT, EDIT_KEY_LABELS } from './panel.js';
import { Screen, SCREEN_THEMES } from './screen.js';
import { Midi } from './midi.js';
import { P } from './params.js';
import { OPF, G, opOff, voiceName, setVoiceName, parseSysex, parseRawBank, buildBankSysex, vcedToVmem, vmemToVced } from './dx7.js';
import { makeVoice } from './presets.js';
import { Guide } from './guide.js';

export const RATE_NAMES = ['1/1', '1/2', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
const RATE_TICKS = [96, 48, 24, 16, 12, 8, 6, 4, 3];
const ARP_MODES = ['Up', 'Down', 'Inclusive', 'Exclusive', 'Random', 'Order', 'Repeat'];
const WAVES = ['Triangle', 'Saw Down', 'Saw Up', 'Square', 'Sine', 'S&H'];
const CURVES = ['-LN', '-EX', '+EX', '+LN'];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => NOTE[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
const CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-+./&#!'()";
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const APP_VERSION = 'v18';
const BASE_NOTE = 53; // lowest key is F3 on the stock unit
const CUT_PTS = [[0, 100], [20, 279], [25, 365], [40, 812], [50, 1373], [60, 2285], [75, 4777], [80, 6065], [100, 15104], [107, 20000]];
const cutoffHz = (c) => {
  for (let i = 0; i < CUT_PTS.length - 1; i++) if (c <= CUT_PTS[i + 1][0]) {
    const [a, fa] = CUT_PTS[i], [b, fb] = CUT_PTS[i + 1], t = (c - a) / (b - a);
    return Math.round(Math.exp(Math.log(fa) * (1 - t) + Math.log(fb) * t));
  }
  return 20000;
};

export class App {
  constructor(root) {
    this.engine = new Engine();
    this.fb = new Feedback();
    this.store = new Store(this.engine);
    this.midi = new Midi(this);
    this.mode = 'HOME';
    this.edit = { target: 'OP', op: 1 };
    this.pageIdx = {};
    this.overlay = null;
    this.toastMsg = null;
    this.flash = null;           // footer "Param: value" for 1 s
    this.heldButtons = new Set();
    this.heldKeys = new Map();   // key idx -> note
    this.fxSel = 0; this.fxGrab = false;
    this.seqView = 'steps'; this.arrSel = { row: 0, col: 0 };
    this.status = null;
    this.lastBeat = 0;
    this.powered = false;
    this.panel = new Panel(root, {
      onPress: (k, n, ev, x) => this.onPress(k, n, ev, x),
      onTurn: (n, s, sp) => this.onTurn(n, s, sp),
      onPot: (n, v, edge) => this.onPot(n, v, edge),
      onResizeScreen: () => this.draw(),
    });
    this.screen = new Screen(this.panel.canvas);
    this.applyLook();
    this.panel.setPot(this.store.s.global.master);
    this.edit.op = this.s.ui.edOp || 1;
    this.engine.onstatus = (s) => this.onStatus(s);
    this.panel.canvas.addEventListener('click', () => this.onScreenTap());
    this.setupFileDrop();
    this.guide = new Guide(this);
    const loop = () => { this.draw(); this.updateLeds(); this.guide.tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // a lesson or preview is about to play notes on the current voice: make sure
  // nothing (arp, sequencer, a switched-off voice, a suspended context) eats them
  readyToPlay() {
    const c = this.engine.ctx; if (c && c.state !== 'running') c.resume().catch(() => {});
    this.arpOff();
    if (this.seqVals[P.P_SEQ_PLAY]) this.setSeqPlay(0);
    this.seqOff();
    const pt = this.part();
    if (!pt.on) { pt.on = 1; this.store.partParam(this.cur, P.PP_ON, 1); }
  }

  // ---------------------------------------------------------------- power
  async powerOn() {
    if (this.powered) return;
    this.powered = true;
    await this.engine.start();
    this.fb.attach(this.engine.ctx);
    this.applyLook();
    this.store.syncAll();
    this.toast('Ready', 800);
  }

  applyLook() {
    const g = this.store.s.global;
    this.screen.setTheme(g.screenTheme || 0);
    document.documentElement.dataset.theme = g.theme ? 'dark' : 'light';
    this.panel.backlight = !!g.btnBL;
    this.panel.keyBacklight = !!g.keyBL;
    this.fb.enabled = !!g.clicks;
    this.fb.setVolume(g.clickVol);
  }

  // ---------------------------------------------------------------- helpers
  get s() { return this.store.s; }
  get cur() { return this.s.ui.curPart; }
  vced() { return this.store.vced(this.cur); }
  part() { return this.store.part(this.cur); }
  patchChanged(live = true) {
    this.part().edited = true;
    this.engine.vced(this.cur, this.vced(), live);
    this.store.touch();
  }
  toast(msg, ms = 1000) { this.toastMsg = { msg, until: performance.now() + ms }; }
  showFlash(label, value) { this.flash = { text: `${label}: ${value}`, until: performance.now() + 1000 }; }
  blocked(msg) { this.fb.blocked(); this.toast(msg); }
  bumpIfEdge(old, v, min, max) { if (v === old && (v === min || v === max)) this.fb.bump(); }

  // ---------------------------------------------------------------- params
  vp(off, label, max, fmt = (v) => v, min = 0, opts = {}) {
    return { label, min, max, get: () => this.vced()[off], set: (v) => { this.vced()[off] = v; this.patchChanged(); }, fmt, ...opts };
  }
  opp(field, label, max, fmt, min = 0, opts = {}) {
    const self = this;
    return {
      label, min, max, fmt: fmt || ((v) => v), ...opts,
      get: () => self.vced()[opOff(self.edit.op) + OPF[field]],
      set: (v) => { self.vced()[opOff(self.edit.op) + OPF[field]] = v; self.patchChanged(); },
    };
  }
  pp(key, label, min, max, fmt = (v) => v, k = null, opts = {}) {
    return {
      label, min, max, fmt, ...opts,
      get: () => this.part()[key],
      set: (v) => { this.part()[key] = v; if (k != null) this.store.partParam(this.cur, k, v); this.store.touch(); },
    };
  }
  envp(key, label, k) {
    return {
      label, min: 0, max: 100, fmt: (v) => v + '%',
      get: () => this.part().env[key],
      set: (v) => {
        const env = this.part().env;
        env[key] = v;
        if (!env.on) { env.on = 1; this.store.partParam(this.cur, P.PP_ENV_ON, 1); } // changing ENV makes it active
        this.store.partParam(this.cur, k, v); this.part().edited = true; this.store.touch();
      },
    };
  }
  gp(key, label, min, max, fmt = (v) => v, id = null, after = null) {
    return {
      label, min, max, fmt,
      get: () => this.s.global[key],
      set: (v) => { this.s.global[key] = v; if (id != null) this.engine.set(id, v); if (after) after(v); this.s.dirty.globe = true; this.store.touch(); },
    };
  }
  ap(key, label, min, max, fmt, id) {
    return { label, min, max, fmt, get: () => this.s.arp[key], set: (v) => { this.s.arp[key] = v; this.engine.set(id, v); this.store.touch(); } };
  }
  action(label, fn, hint = 'turn') { return { label, action: fn, fmt: () => hint === 'turn' ? '▸' : hint, get: () => 0 }; }

  ratioText(v, b) {
    const mode = v[b + OPF.MODE], c = v[b + OPF.COARSE], f = v[b + OPF.FINE];
    if (mode) { const hz = Math.pow(10, c & 3) * Math.pow(10, f / 100); return hz >= 1000 ? (hz / 1000).toFixed(2) + 'k' : hz.toFixed(hz < 10 ? 2 : hz < 100 ? 1 : 0); }
    const r = (c === 0 ? 0.5 : c) * (1 + f / 100);
    return r.toFixed(2);
  }

  pagesFor(key) {
    const v = () => this.vced();
    switch (key) {
      case 'EDIT-OP': {
        const b = () => opOff(this.edit.op);
        return [
          { title: 'Tune&Lvl', params: [
            this.opp('DET', 'Detune', 14, (x) => (x - 7 > 0 ? '+' : '') + (x - 7), 0, { bipolar: true }),
            this.opp('COARSE', 'FreqCoarse', 31, () => this.ratioText(v(), b())),
            this.opp('FINE', 'FreqFine', 99, () => this.ratioText(v(), b())),
            this.opp('OL', 'Out Level', 99)] },
          { title: 'Envelope', params: [this.opp('R1', 'Rate 1', 99), this.opp('R2', 'Rate 2', 99), this.opp('R3', 'Rate 3', 99), this.opp('R4', 'Rate 4', 99)] },
          { title: 'Envelope', params: [this.opp('L1', 'Level 1', 99), this.opp('L2', 'Level 2', 99), this.opp('L3', 'Level 3', 99), this.opp('L4', 'Level 4', 99)] },
          { title: 'Sens&Osc', params: [this.opp('AMS', 'A ModSens', 3), this.opp('KVS', 'KeyVelocity', 7), this.opp('MODE', 'OscMode', 1, (x) => x ? 'Fixed' : 'Ratio'), null] },
          { title: 'Scaling', params: [this.opp('LD', 'L Depth', 99), this.opp('RD', 'R Depth', 99), this.opp('BP', 'BreakPoint', 99, (x) => noteName(x + 21)), null] },
          { title: 'Scaling', params: [this.opp('LC', 'L Curve', 3, (x) => CURVES[x]), this.opp('RC', 'R Curve', 3, (x) => CURVES[x]), this.opp('RS', 'Rate Scale', 7), null] },
        ];
      }
      case 'EDIT-PIT': return [
        { title: 'PitchEnvelope', params: [0, 1, 2, 3].map((i) => this.vp(G.PR1 + i, 'Rate ' + (i + 1), 99)) },
        { title: 'PitchEnvelope', params: [0, 1, 2, 3].map((i) => this.vp(G.PL1 + i, 'Level ' + (i + 1), 99, (x) => (x - 50 > 0 ? '+' : '') + (x - 50), 0, { bipolar: true })) },
      ];
      case 'EDIT-GLO': return [
        { title: 'Globe', params: [
          { ...this.vp(G.ALG, 'Algorithm', 31, (x) => x + 1), onSet: () => this.showAlgo() },
          this.vp(G.FB, 'Feedback', 7), this.vp(G.OKS, 'Osc Sync', 1, (x) => x ? 'ON' : 'OFF'),
          this.vp(G.TRNP, 'Transpose', 48, (x) => (x - 24 > 0 ? '+' : '') + (x - 24), 0, { bipolar: true })] },
        { title: 'Globe', params: [
          this.action('Init Voice', () => this.confirm('Init voice?', () => this.initVoice())),
          this.action('Rename', () => this.startRename('voice')),
          this.action('Copy Voice', () => this.copyVoiceMenu()),
          this.action('Reset', () => this.confirm('Reset to imported?', () => this.resetImported()))] },
      ];
      case 'ENV': return [
        { title: 'ENV', params: [this.envp('a', 'Attack', P.PP_ENV_A), this.envp('d', 'Decay', P.PP_ENV_D), this.envp('s', 'Sustain', P.PP_ENV_S), this.envp('r', 'Release', P.PP_ENV_R)] },
        { title: 'ENV', params: [{ label: 'Env', min: 0, max: 1, fmt: (x) => x ? 'ON' : 'OFF', get: () => this.part().env.on, set: (x) => { this.part().env.on = x; this.store.partParam(this.cur, P.PP_ENV_ON, x); this.store.touch(); } }, null, null, null] },
      ];
      case 'LFO': return [
        { title: 'LFO', params: [this.vp(G.WAVE, 'Wave', 5, (x) => WAVES[x]), this.vp(G.LFS, 'Speed', 99), this.vp(G.PMD, 'PMD', 99), this.vp(G.AMD, 'AMD', 99)] },
        { title: 'LFO', params: [this.vp(G.LFD, 'Delay', 99), this.vp(G.PMS, 'Pitch Sens', 7), this.vp(G.LKS, 'Lfo Sync', 1, (x) => x ? 'ON' : 'OFF'), this.vp(G.OKS, 'Osc Sync', 1, (x) => x ? 'ON' : 'OFF')] },
      ];
      case 'ARP': return [
        { title: 'Arpeggio', params: [
          this.ap('mode', 'Mode', 0, 6, (x) => ARP_MODES[x], P.P_ARP_MODE), this.ap('oct', 'Octave', 1, 4, (x) => x, P.P_ARP_OCT),
          this.ap('rate', 'Rate', 0, 8, (x) => RATE_NAMES[x], P.P_ARP_RATE), this.gp('tempo', 'Tempo', 30, 300, (x) => x, P.P_TEMPO)] },
        { title: 'Arpeggio', params: [
          this.ap('gate', 'Gate', 20, 100, (x) => x + '%', P.P_ARP_GATE), this.ap('swing', 'Swing', 50, 75, (x) => x + '%', P.P_ARP_SWING),
          this.ap('latch', 'Latch', 0, 1, (x) => x ? 'ON' : 'OFF', P.P_ARP_LATCH), this.ap('sync', 'Sync', 0, 1, (x) => x ? 'ON' : 'OFF', P.P_ARP_SYNC)] },
      ];
      case 'SEQ': {
        const sp = (id, label, min, max, fmt = (x) => x) => ({
          label, min, max, fmt, get: () => this.seqVals[id] ?? 0,
          set: (x) => {
            this.seqVals[id] = x; this.engine.set(id, x); this.s.dirty.pattern = true;
            if (id === P.P_SEQ_PART) this.followSeqVoice(x);
            if (id === P.P_SEQ_PATTERN) this.refreshSeqVals().then(() => this.followSeqVoice(this.seqVals[P.P_SEQ_PART] || 0));
            this.captureSeqSoon();
          },
        });
        return [
          { title: 'Sequencer', params: [sp(P.P_SEQ_PATTERN, 'Pattern', 0, 15, (x) => x + 1),
            this.action('Clear', () => this.clearMenu()),
            this.action('Chain', () => { this.seqView = this.seqView === 'arr' ? 'steps' : 'arr'; }, this.seqView === 'arr' ? 'ON' : 'OFF'),
            sp(P.P_SEQ_STEPS, 'Step', 1, 64)] },
          { title: 'Sequencer', params: [sp(P.P_SEQ_PART, 'Voice', 0, 7, (x) => 'V' + (x + 1)), sp(P.P_SEQ_RATE, 'Rate', 0, 8, (x) => RATE_NAMES[x]),
            sp(P.P_SEQ_GATE, 'Gate', 10, 100, (x) => x + '%'), this.gp('tempo', 'Tempo', 30, 300, (x) => x, P.P_TEMPO)] },
          { title: 'Sequencer', params: [sp(P.P_SEQ_SWING, 'Swing', 50, 75, (x) => x + '%'),
            { label: 'Sync', min: 0, max: 1, fmt: (x) => x ? 'ON' : 'OFF', get: () => this.s.seqSettings.sync, set: (x) => { this.s.seqSettings.sync = x; this.engine.set(P.P_SEQ_SYNC, x); this.store.touch(); } },
            { label: 'Transpose', min: -12, max: 12, bipolar: true, fmt: (x) => (x > 0 ? '+' : '') + x, get: () => this.s.seqSettings.transpose, set: (x) => { this.s.seqSettings.transpose = x; this.engine.set(P.P_SEQ_TRANSPOSE, x); this.store.touch(); } },
            { label: 'Ratchet', min: 1, max: 4, fmt: (x) => 'x' + x, get: () => this.stepRatchet(), set: (x) => { this.engine.seqCmd(8, this.seqVals[P.P_SEQ_CURSOR] || 0, x); this.s.dirty.pattern = true; this.captureSeqSoon(); } }] },
        ];
      }
      case 'GLOBE': {
        const g = this.s.global;
        return [
          { title: 'GLOBE', params: [
            this.gp('midiCh', 'Midi Chn', 0, 16, (x) => x ? x : 'ALL', P.P_MIDI_CH),
            this.gp('fxCh', 'Effect Chn', 1, 16, (x) => x, P.P_FX_CH),
            this.pp('bendUp', 'Pitch Up', 1, 24, (x) => x, P.PP_BEND_UP),
            this.pp('bendDn', 'Pitch Dn', 1, 24, (x) => -x, P.PP_BEND_DN)] },
          { title: 'GLOBE', params: [
            this.action('Reset Patches', () => this.confirm('Reset all patches?', () => this.resetPatches())),
            this.gp('velocity', 'Velocity', 1, 127),
            this.gp('glideMode', 'Glide', 0, 1, (x) => x ? 'Fingered' : 'Full Time', P.P_GLIDE_MODE),
            { ...this.pp('glide', 'Glide Val', 0, 100, (x) => x, P.PP_GLIDE), active: () => !!this.part().mono }] },
          { title: 'Voices', params: [
            { label: 'Voice', min: 0, max: 7, fmt: (x) => 'V' + (x + 1), get: () => this.cur, set: (x) => { this.s.ui.curPart = x; this.store.touch(); } },
            this.pp('on', 'On/Off', 0, 1, (x) => x ? 'ON' : 'OFF', P.PP_ON),
            this.pp('ch', 'Midi Ch', 0, 16, (x) => x ? x : 'ALL', P.PP_CH),
            this.pp('level', 'Level', 0, 100, (x) => x, P.PP_LEVEL)] },
          { title: 'Voices', params: [
            this.pp('pan', 'Pan', 0, 100, (x) => x === 50 ? 'C' : x < 50 ? 'L' + (50 - x) : 'R' + (x - 50), P.PP_PAN, { bipolar: true }),
            this.pp('fine', 'Fine Tune', -100, 100, (x) => (x > 0 ? '+' : '') + x + 'c', P.PP_FINE, { bipolar: true }),
            this.pp('mono', 'Mode', 0, 1, (x) => x ? 'MONO' : 'POLY', P.PP_MONO),
            this.gp('poly', 'Polyphony', 1, 20, (x) => x, P.P_POLY)] },
          { title: 'Display', params: [
            this.gp('screenTheme', 'Colours', 0, SCREEN_THEMES.length - 1, (x) => SCREEN_THEMES[x].name, null, () => this.applyLook()),
            this.gp('btnBL', 'Btn BL', 0, 1, (x) => x ? 'ON' : 'OFF', null, () => this.applyLook()),
            this.gp('keyBL', 'Key BL', 0, 1, (x) => x ? 'ON' : 'OFF', null, () => this.applyLook()),
            this.gp('theme', 'Panel', 0, 1, (x) => x ? 'Night' : 'Day', null, () => this.applyLook())] },
          { title: 'Feel', params: [
            this.gp('clicks', 'Clicks', 0, 1, (x) => x ? 'ON' : 'OFF', null, () => this.applyLook()),
            { ...this.gp('clickVol', 'Click Vol', 0, 10, (x) => x, null, () => this.applyLook()), get: () => Math.round(g.clickVol * 10), set: (x) => { g.clickVol = x / 10; this.applyLook(); this.store.touch(); } },
            this.gp('touchVel', 'Touch Vel', 0, 1, (x) => x ? 'ON' : 'OFF'),
            this.gp('beatTick', 'Beat Tick', 0, 1, (x) => x ? 'ON' : 'OFF')] },
          { title: 'Sound', params: [
            this.gp('hwChar', 'HW Char', 0, 1, (x) => x ? 'ON' : 'OFF', P.P_HW_CHAR),
            this.gp('quant16', '16-bit', 0, 1, (x) => x ? 'ON' : 'OFF', P.P_QUANT16),
            this.gp('drive', 'Drive -6', 0, 1, (x) => x ? 'ON' : 'OFF', P.P_DRIVE),
            this.gp('boost', 'Out Boost', 0, 3, (x) => '+' + x * 6 + 'dB', P.P_DETUNE_MODE)] },
          { title: 'Data', params: [
            this.action('Import', () => this.importFile()),
            this.action('Export', () => this.exportBankMenu()),
            this.action('Backup', () => this.backup()),
            this.action('Factory', () => this.confirm('Erase everything?', () => this.factoryReset()))] },
        ];
      }
    }
    return [];
  }

  modeKey() {
    if (this.mode === 'EDIT') return 'EDIT-' + this.edit.target;
    return this.mode;
  }
  pages() { return this.pagesFor(this.modeKey()); }
  page() {
    const ps = this.pages(); if (!ps.length) return null;
    const k = this.modeKey(); const i = clamp(this.pageIdx[k] || 0, 0, ps.length - 1);
    return { ...ps[i], index: i, count: ps.length };
  }

  // ---------------------------------------------------------------- input
  onPress(kind, name, ev, x) {
    if (!this.powered) { if (ev === 'down') this.powerOn(); return; }
    if (kind === 'button') return this.onButton(name, ev, x);
    if (kind === 'key') return this.onKey(name, ev, x);
  }

  onButton(name, ev, x) {
    const held = this.heldButtons;
    if (ev === 'down') {
      held.add(name);
      this.fb.press();
      // combos are evaluated on the second control's down
      if ((name === 'OCTDN' && held.has('OCTUP')) || (name === 'OCTUP' && held.has('OCTDN'))) {
        this.s.ui.octave = 0; this.s.ui.transpose = 0; this.comboUsed = true;
        this.toast('Octave & transpose reset'); this.store.touch();
        return;
      }
      if (this.overlay && this.overlay.type !== 'presets' && this.overlay.type !== 'algo' && name !== 'SAVE' && name !== 'SEL' && this.overlay.type !== 'algo') {
        if (name === 'HOME' || this.overlay.type !== 'rename') { this.overlay = null; if (name === 'HOME') return; }
      }
      this.comboUsed = false;
      return;
    }
    if (ev === 'long') {
      this.fb.holdReached();
      this.longFired = name;
      switch (name) {
        case 'HOME': this.toggleMidi(); break;
        case 'PLAY': this.engine.panic(); this.setSeqPlay(0); this.toast('Panic'); break;
        case 'SEL': if (this.mode === 'FX') this.startRename('fx'); break;
        case 'ENV': break; // a long press on ENV does nothing on the stock unit
      }
      return;
    }
    if (ev === 'repeat') return;
    if (ev !== 'up') return;
    held.delete(name);
    this.fb.release();
    if (x.long || this.comboUsed) { if (!held.size) this.comboUsed = false; return; }
    this.buttonTap(name);
  }

  buttonTap(name) {
    const ov = this.overlay;
    if (ov && ov.type === 'rename') {
      if (name === 'SAVE') return this.finishRename();
      if (name === 'HOME') { this.overlay = null; return; }
      return;
    }
    if (ov && ov.type === 'menu') {
      if (name === 'SAVE' || name === 'SEL') { const it = ov.items[ov.sel]; if (it && !it.dim) { this.overlay = null; it.run(); } else this.fb.blocked(); return; }
      this.overlay = null; return;
    }
    switch (name) {
      case 'HOME': this.setMode('HOME'); break;
      case 'FX': this.setMode(this.mode === 'FX' ? 'HOME' : 'FX'); break;
      case 'ENV': this.setMode(this.mode === 'ENV' ? 'HOME' : 'ENV'); break;
      case 'LFO': this.setMode(this.mode === 'LFO' ? 'HOME' : 'LFO'); break;
      case 'EDIT': this.setMode(this.mode === 'EDIT' ? 'HOME' : 'EDIT'); break;
      case 'GLO': this.setMode(this.mode === 'GLOBE' ? 'HOME' : 'GLOBE'); break;
      case 'SEL':
        if (this.overlay && this.overlay.type === 'presets') { this.overlay = null; this.fb.engage(); break; }
        if (this.seqOn && this.seqVals[P.P_SEQ_REC]) { this.seqRest(); break; }
        if (this.mode === 'FX') { this.fxGrab = !this.fxGrab; this.fxGrab ? this.fb.engage() : this.fb.disengage(); }
        break;
      case 'SAVE': this.saveMenu(); break;
      case 'ARP': this.toggleArp(); break;
      case 'SEQ': this.toggleSeq(); break;
      case 'PLAY':
        if (this.s.arp.on) return this.blocked('Disable ARP to enter');
        if (!this.seqOn) { this.toggleSeq(); }
        this.setSeqPlay(this.seqVals[P.P_SEQ_PLAY] ? 0 : 1);
        break;
      case 'REC':
        if (!this.seqOn) return this.blocked('Enter SEQ to record');
        this.seqVals[P.P_SEQ_REC] = this.seqVals[P.P_SEQ_REC] ? 0 : 1;
        this.engine.set(P.P_SEQ_REC, this.seqVals[P.P_SEQ_REC]);
        this.seqVals[P.P_SEQ_REC] ? this.fb.engage() : this.fb.disengage();
        if (!this.seqVals[P.P_SEQ_REC]) this.captureSeqSoon();
        break;
      case 'OCTDN': case 'OCTUP': {
        const d = name === 'OCTUP' ? 1 : -1, o = this.s.ui.octave;
        const n = clamp(o + d, -3, 3);
        if (n === o) this.fb.bump();
        this.s.ui.octave = n; this.store.touch();
        break;
      }
    }
  }

  setMode(m) {
    if (this.mode === m) return;
    this.mode = m;
    this.fxGrab = false;
    if (m === 'EDIT') this.edit.target = this.edit.target || 'OP';
    this.flash = null;
  }

  // ARP and SEQ are mutually exclusive
  arpOff() {
    const a = this.s.arp; if (!a.on) return;
    a.on = 0; this.engine.set(P.P_ARP_ON, 0); this.fb.disengage();
    if (this.mode === 'ARP') this.setMode('HOME');
  }
  toggleArp() {
    const a = this.s.arp;
    if (this.seqOn) return this.blocked('Disable SEQ to enter');
    if (!a.on) { a.on = 1; this.engine.set(P.P_ARP_ON, 1); this.fb.engage(); this.setMode('ARP'); }
    else if (this.mode === 'ARP') { a.on = 0; this.engine.set(P.P_ARP_ON, 0); this.fb.disengage(); this.setMode('HOME'); }
    else this.setMode('ARP');
  }
  // leave the sequencer whatever page is showing (toggleSeq only leaves from the SEQ page)
  seqOff() {
    if (!this.seqOn) return;
    this.seqOn = 0; this.engine.set(P.P_SEQ_ON, 0); this.fb.disengage();
    this.seqVals[P.P_SEQ_PLAY] = 0; this.seqVals[P.P_SEQ_REC] = 0;
    if (this.mode === 'SEQ') this.setMode('HOME');
    this.captureSeqSoon();
  }
  toggleSeq() {
    if (this.s.arp.on) return this.blocked('Disable ARP to enter');
    if (!this.seqOn) { this.seqOn = 1; this.engine.set(P.P_SEQ_ON, 1); this.fb.engage(); this.setMode('SEQ'); this.refreshSeqVals(); }
    else if (this.mode === 'SEQ') {
      this.seqOn = 0; this.engine.set(P.P_SEQ_ON, 0); this.fb.disengage();
      this.seqVals[P.P_SEQ_PLAY] = 0; this.seqVals[P.P_SEQ_REC] = 0; this.setMode('HOME'); this.captureSeqSoon();
    } else this.setMode('SEQ');
  }
  // the pattern's voice becomes the current voice, and is switched on, so the
  // keys, the PRESETS knob and the screen header all follow the track you're on
  followSeqVoice(p) {
    this.s.ui.curPart = p;
    const pt = this.s.parts[p];
    if (!pt.on) { pt.on = 1; this.store.partParam(p, P.PP_ON, 1); this.toast('V' + (p + 1) + ' on'); }
    this.store.touch();
  }
  // REC + SEL: leave this step empty and move on
  seqRest() {
    const len = this.seqVals[P.P_SEQ_STEPS] || 16;
    this.engine.seqCmd(4, 0, 0);
    this.seqVals[P.P_SEQ_CURSOR] = ((this.seqVals[P.P_SEQ_CURSOR] || 0) + 1) % len;
    this.fb.detent(); this.toast('Rest · step ' + (this.seqVals[P.P_SEQ_CURSOR] + 1), 600);
  }
  setSeqPlay(v) {
    this.seqVals[P.P_SEQ_PLAY] = v;
    this.engine.set(P.P_SEQ_PLAY, v);
    v ? this.fb.engage() : this.fb.disengage();
  }
  seqVals = {};
  async refreshSeqVals() {
    const ids = [P.P_SEQ_PLAY, P.P_SEQ_REC, P.P_SEQ_PATTERN, P.P_SEQ_STEPS, P.P_SEQ_PART, P.P_SEQ_RATE, P.P_SEQ_GATE, P.P_SEQ_SWING, P.P_SEQ_CURSOR];
    const vals = await this.engine.get(ids);
    ids.forEach((id, i) => { this.seqVals[id] = vals[i]; });
    this.seqDump = await this.engine.seqDump();
  }
  captureSeqSoon() {
    clearTimeout(this._seqT);
    this._seqT = setTimeout(async () => { await this.store.captureSeq(); await this.refreshSeqVals(); }, 300);
  }
  stepRatchet() {
    const d = this.seqDump; if (!d) return 1;
    const pat = this.seqVals[P.P_SEQ_PATTERN] || 0, step = this.seqVals[P.P_SEQ_CURSOR] || 0;
    return d[pat * 1032 + step * 16 + 12] || 1;
  }

  onKey(idx, ev, x) {
    const keyIsFunction = this.mode === 'EDIT' && x.black && x.blackN < EDIT_KEY_LABELS.length;
    if (keyIsFunction) return this.editKey(EDIT_KEY_LABELS[x.blackN], ev);
    if (ev === 'down') {
      if (this.overlay && this.overlay.type === 'arrrec') return;
      if (this.guide && this.guide.blockKey(idx)) return; // a lesson's "your turn": wrong keys only flash
      const note = BASE_NOTE + idx + 12 * this.s.ui.octave + this.s.ui.transpose;
      if (note < 0 || note > 127) return;
      let vel = this.s.global.velocity;
      if (this.s.global.touchVel && x.h) vel = clamp(Math.round(30 + 97 * (x.y / x.h)), 1, 127);
      this.heldKeys.set(idx, note);
      if (this.guide && this.guide.songLesson) this.guide.songLesson.onKey(idx, 'down', note, vel);
      this.engine.key(note, vel);
      // in a lesson the key's click sound would colour the note, so it's touch only there
      if (this.guide && this.guide.quietKeys()) this.fb.vibrate(6); else this.fb.key(vel);
      if (this.seqOn && this.seqVals[P.P_SEQ_REC]) { this.recKeyStep = this.seqVals[P.P_SEQ_CURSOR] || 0; this.s.dirty.pattern = true; }
    } else if (ev === 'up') {
      const note = this.heldKeys.get(idx);
      if (note == null) return;
      this.heldKeys.delete(idx);
      this.engine.key(note, 0);
      if (this.seqOn && this.seqVals[P.P_SEQ_REC]) {
        if (this.longNoteEnd != null) { this.engine.seqCmd(3, this.recKeyStep, this.longNoteEnd); this.longNoteEnd = null; }
        this.captureSeqSoon();
      }
    }
  }

  editKey(label, ev) {
    const op = /^OP(\d)$/.exec(label);
    if (ev === 'long' && op) {
      const n = +op[1], pt = this.part();
      pt.opmask ^= 1 << (n - 1);
      this.store.partParam(this.cur, P.PP_OPMASK, pt.opmask);
      this.toast(`OP${n} ${pt.opmask & (1 << (n - 1)) ? 'on' : 'muted'}`);
      this.fb.holdReached();
      return;
    }
    if (ev === 'down') { this.fb.press(); return; }
    if (ev !== 'up') return;
    if (op) { this.edit.target = 'OP'; this.edit.op = +op[1]; this.s.ui.edOp = this.edit.op; }
    else if (label === 'PIT') this.edit.target = 'PIT';
    else if (label === 'GLO') this.edit.target = 'GLO';
    else if (label === 'MONO' || label === 'POLY') {
      const m = label === 'MONO' ? 1 : 0;
      this.part().mono = m; this.store.partParam(this.cur, P.PP_MONO, m); this.part().edited = true; this.store.touch();
      this.fb.engage();
    }
    this.fb.release();
  }

  onTurn(name, steps, speed) {
    if (!this.powered) return;
    const dir = steps;
    const held = this.heldButtons;
    // hold OCT + turn ALGORITHM: transpose -12..+12
    if (name === 'ALGO' && (held.has('OCTDN') || held.has('OCTUP'))) {
      const t = this.s.ui.transpose, n = clamp(t + dir, -12, 12);
      if (n === t) this.fb.bump(); else this.fb.detent();
      this.s.ui.transpose = n; this.comboUsed = true; this.toast('Transpose ' + (n > 0 ? '+' : '') + n); this.store.touch();
      return;
    }
    const ov = this.overlay;
    if (ov && ov.type === 'rename') {
      if (name === 'SELECT') { ov.cursor = clamp(ov.cursor + dir, 0, 9); this.fb.detent(); }
      if (name === 'K1') {
        const s = ov.name.padEnd(10, ' ').split('');
        const i = CHARS.indexOf(s[ov.cursor]);
        s[ov.cursor] = CHARS[(i + dir + CHARS.length) % CHARS.length];
        ov.name = s.join(''); this.fb.detent();
      }
      return;
    }
    if (ov && ov.type === 'menu' && (name === 'SELECT' || name === 'PRESETS')) {
      const n = clamp(ov.sel + dir, 0, ov.items.length - 1);
      if (n === ov.sel) this.fb.bump(); else this.fb.detent();
      ov.sel = n; return;
    }
    if (name === 'PRESETS') return this.turnPresets(dir);
    if (name === 'ALGO') return this.turnAlgo(dir);
    if (name === 'SELECT') return this.turnSelect(dir);
    if (/^K\d$/.test(name)) return this.turnKnob(+name[1], dir, speed);
  }

  turnSelect(dir) {
    // SEQ record: hold key + SELECT = long note end; hold REC + SELECT = move step to replace
    if (this.seqOn && this.heldKeys.size && this.seqVals[P.P_SEQ_REC]) {
      const len = this.seqVals[P.P_SEQ_STEPS] || 16;
      this.longNoteEnd = clamp((this.longNoteEnd ?? this.recKeyStep) + dir, this.recKeyStep, len - 1);
      this.fb.detent(); this.toast('Long note to ' + (this.longNoteEnd + 1)); return;
    }
    if (this.seqOn && this.heldButtons.has('REC')) {
      const len = this.seqVals[P.P_SEQ_STEPS] || 16;
      const c = ((this.seqVals[P.P_SEQ_CURSOR] || 0) + dir + len) % len;
      this.seqVals[P.P_SEQ_CURSOR] = c; this.engine.set(P.P_SEQ_CURSOR, c); this.comboUsed = true;
      this.fb.detent(); this.toast('Step ' + (c + 1)); return;
    }
    if (this.mode === 'FX') {
      const n = clamp(this.fxSel + dir, 0, 5);
      if (n === this.fxSel) { this.fb.bump(); return; }
      if (this.fxGrab) {
        const o = this.s.fx.order; [o[this.fxSel], o[n]] = [o[n], o[this.fxSel]];
        this.store.syncFx(); this.s.dirty.globe = true; this.store.touch();
      }
      this.fxSel = n; this.fb.detent(); return;
    }
    if (this.mode === 'SEQ' && this.seqView === 'arr') {
      const a = this.arrSel, idx = clamp(a.row * 8 + a.col + dir, 0, 63);
      a.row = idx >> 3; a.col = idx & 7; this.fb.detent(); return;
    }
    const pg = this.page(); if (!pg) { this.fb.bump(); return; }
    const k = this.modeKey(), n = clamp(pg.index + dir, 0, pg.count - 1);
    if (n === pg.index) { this.fb.bump(); return; }
    this.pageIdx[k] = n; this.fb.detent(); this.flash = null;
  }

  turnPresets(dir) {
    // list: FX, Voice 1..8, then presets 001..128 for the current voice
    const ov = this.overlay && this.overlay.type === 'presets' ? this.overlay : null;
    let sel = ov ? ov.sel : 9 + this.part().preset;
    sel = clamp(sel + dir, 0, 9 + 127);
    if (ov && sel === ov.sel) this.fb.bump(); else this.fb.detent();
    this.overlay = { type: 'presets', sel, until: performance.now() + 3000 };
    if (sel >= 9) {
      this.store.loadPreset(this.cur, sel - 9);
    } else if (sel >= 1) {
      this.s.ui.curPart = sel - 1;
    }
  }

  turnAlgo(dir) {
    if (this.mode === 'FX') {
      const n = clamp(this.s.fxGroup + dir, 0, 127);
      if (n === this.s.fxGroup) return this.fb.bump();
      this.fb.detent();
      this.loadFxGroup(n);
      return;
    }
    if (this.mode === 'SEQ' && !this.seqVals[P.P_SEQ_PLAY]) {
      const len = this.seqVals[P.P_SEQ_STEPS] || 16;
      const c = clamp((this.seqVals[P.P_SEQ_CURSOR] || 0) + dir, 0, len - 1);
      if (c === this.seqVals[P.P_SEQ_CURSOR]) return this.fb.bump();
      this.seqVals[P.P_SEQ_CURSOR] = c; this.engine.set(P.P_SEQ_CURSOR, c); this.fb.detent();
      return;
    }
    const v = this.vced(), o = v[G.ALG], n = clamp(o + dir, 0, 31);
    if (n === o) return this.fb.bump();
    v[G.ALG] = n; this.patchChanged(); this.fb.detent();
    this.showAlgo();
  }
  showAlgo() { this.overlay = { type: 'algo', until: performance.now() + 1000 }; }

  turnKnob(i, dir, speed) {
    // quick controls while the presets popup is on a voice
    if (this.overlay && this.overlay.type === 'presets' && this.overlay.sel >= 1 && this.overlay.sel <= 8) {
      const p = this.overlay.sel - 1, pt = this.s.parts[p];
      this.overlay.until = performance.now() + 3000;
      const map = { 1: ['ch', 0, 16, P.PP_CH], 2: ['level', 0, 100, P.PP_LEVEL], 3: ['pan', 0, 100, P.PP_PAN], 4: ['on', 0, 1, P.PP_ON] };
      const [key, lo, hi, k] = map[i];
      const n = clamp(pt[key] + dir * (i === 4 ? 1 : speed), lo, hi);
      if (n === pt[key]) return this.fb.bump();
      pt[key] = n; this.store.partParam(p, k, n); this.store.touch(); this.fb.detent();
      return;
    }
    if (this.mode === 'FX') return this.turnFxKnob(i, dir, speed);
    if (this.mode === 'SEQ' && this.seqView === 'arr') return this.turnArrKnob(i, dir);
    if (this.mode === 'HOME') { this.setMode('EDIT'); }
    const pg = this.page(); if (!pg) return;
    const prm = pg.params[i - 1];
    if (!prm) return this.fb.bump();
    if (prm.active && !prm.active()) return this.blocked('Mono only');
    if (prm.action) { if (!this._actT || performance.now() - this._actT > 600) { this._actT = performance.now(); this.fb.engage(); prm.action(); } return; }
    const old = prm.get();
    const range = prm.max - prm.min;
    const step = range > 50 ? speed : 1;
    const v = clamp(old + dir * step, prm.min, prm.max);
    if (v === old) return this.fb.bump();
    prm.set(v);
    if (prm.onSet) prm.onSet(v);
    this.fb.detent();
    this.showFlash(prm.label, prm.fmt(v));
  }

  fxLabels(e) {
    return [
      [['Type', 0, 2, (x) => ['Low Pass', 'Band Pass', 'High Pass'][x]], ['CutOff', 0, 107, (x) => cutoffHz(x) + 'Hz'], ['Q', 0, 100, (x) => x]],
      [['Type', 0, 2, (x) => ['Room', 'Hall', 'Plate'][x]], ['Decay', 0, 100, (x) => x], ['Mix', 0, 100, (x) => x]],
      [['Decay', 0, 100, (x) => x], ['Rate', 0, 100, (x) => (800 - 7 * x) + 'ms'], ['Mix', 0, 100, (x) => x]],
      [['Gain', 0, 100, (x) => x], ['Tone', 0, 100, (x) => x], ['Level', 0, 100, (x) => x]],
      [['Freq', 0, 100, (x) => x], ['Depth', 0, 100, (x) => x], ['Mix', 0, 100, (x) => x]],
      [['Freq', 0, 100, (x) => x], ['Depth', 0, 100, (x) => x], ['Mix', 0, 100, (x) => x]],
    ][e];
  }
  turnFxKnob(i, dir, speed) {
    const e = this.s.fx.order[this.fxSel], ps = this.s.fx.params[e];
    if (i === 4) {
      const n = clamp(ps[0] + dir, 0, 1);
      if (n === ps[0]) return this.fb.bump();
      ps[0] = n; n ? this.fb.engage() : this.fb.disengage();
      this.engine.set(P.P_FX_BASE + e * 8, n);
      this.showFlash(FX_NAMES[e], n ? 'ON' : 'OFF');
    } else {
      const [label, lo, hi, fmt] = this.fxLabels(e)[i - 1];
      const step = e === 0 && i === 3 ? 10 : (hi > 2 ? speed : 1); // Q moves in tens
      const n = clamp(ps[i] + dir * step, lo, hi);
      if (n === ps[i]) return this.fb.bump();
      ps[i] = n; this.engine.set(P.P_FX_BASE + e * 8 + i, n); this.fb.detent();
      this.showFlash(label, fmt(n));
    }
    this.s.dirty.globe = true; this.store.touch();
  }
  loadFxGroup(n) {
    this.s.fxGroup = n;
    const g = this.s.fxGroups[n];
    this.s.fx = { params: g.params.map((p) => [...p]), order: [...g.order] };
    this.store.syncFx(); this.store.touch();
    this.toast(g.name, 700);
  }

  turnArrKnob(i, dir) {
    const a = this.arrSel, d = this.seqDump;
    if (!d) return;
    const base = 16 * 1032;
    if (i === 1) {
      const cur = (d[base + a.row * 8 + a.col] << 24) >> 24;
      const n = clamp(cur + dir, -1, 15);
      if (n === cur) return this.fb.bump();
      d[base + a.row * 8 + a.col] = n & 255;
      this.engine.seqLoad(d); this.fb.detent(); this.s.dirty.pattern = true; this.captureSeqSoon();
    } else if (i === 2) {
      const cur = d[base + 64] || 4, n = clamp(cur + dir, 1, 8);
      if (n === cur) return this.fb.bump();
      this.engine.set(P.P_SEQ_ARR_LEN, n); d[base + 64] = n; this.fb.detent(); this.captureSeqSoon();
    } else if (i === 3) {
      const cur = this.seqVals[P.P_SEQ_ARRANGE] || 0, n = clamp(cur + dir, 0, 1);
      if (n === cur) return this.fb.bump();
      this.seqVals[P.P_SEQ_ARRANGE] = n; this.engine.set(P.P_SEQ_ARRANGE, n); this.fb.detent();
    } else if (i === 4) { this.seqView = 'steps'; this.fb.disengage(); }
  }

  onPot(name, v, edge) {
    if (name === 'MASTER') {
      this.s.global.master = v; this.engine.set(P.P_MASTER, v); this.store.touch();
      if (edge) this.fb.play('detent', 0.4);
      this.showFlash('Master', v);
    }
  }

  // ---------------------------------------------------------------- menus
  menu(title, items, onCancel) { this.overlay = { type: 'menu', title, items, sel: Math.max(0, items.findIndex((i) => !i.dim)), onCancel }; }
  confirm(q, fn) { this.menu(q, [{ label: 'No', run: () => {} }, { label: 'Yes', run: fn }]); this.overlay.sel = 0; }

  saveMenu() {
    const pt = this.part(), d = this.s.dirty;
    const voiceDirty = this.s.parts.some((p) => p.edited);
    const items = [
      { label: 'ALL', dim: !(voiceDirty || d.globe || d.pattern), run: () => { this.s.parts.forEach((p, i) => p.edited && this.store.savePreset(i)); this.saveGlobe(); this.savePattern(); this.done(); } },
      { label: 'Globe', dim: !d.globe, run: () => { this.saveGlobe(); this.done(); } },
      { label: `Preset ${String(pt.preset + 1).padStart(3, '0')}`, dim: !pt.edited, run: () => { this.store.savePreset(this.cur); this.done(); } },
      { label: 'Preset to…', run: () => this.saveToSlotMenu() },
      { label: 'Pattern', dim: !d.pattern, run: () => { this.savePattern(); this.done(); } },
      { label: `FX Group ${String(this.s.fxGroup + 1).padStart(3, '0')}`, run: () => { this.saveFxGroup(); this.done(); } },
    ];
    if (items.every((i) => i.dim || i.label.startsWith('Preset to') || i.label.startsWith('FX'))) {
      // no dialog if nothing changed (still allow "save to" via the menu)
    }
    this.menu('SAVE', items);
  }
  saveToSlotMenu() {
    const items = [];
    for (let i = 0; i < 128; i++) items.push({ label: `${String(i + 1).padStart(3, '0')} ${this.store.presetName(i)}`, run: () => { this.store.savePreset(this.cur, i); this.done(); } });
    this.menu('SAVE TO', items); this.overlay.sel = this.part().preset;
  }
  saveGlobe() { this.s.dirty.globe = false; this.store.touch(true); }
  async savePattern() { await this.store.captureSeq(); this.s.dirty.pattern = false; this.store.touch(true); }
  saveFxGroup() { const g = this.s.fxGroups[this.s.fxGroup]; g.params = this.s.fx.params.map((p) => [...p]); g.order = [...this.s.fx.order]; this.store.touch(true); }
  done() { this.fb.saved(); this.toast('Saved'); }

  clearMenu() {
    const pat = this.seqVals[P.P_SEQ_PATTERN] || 0, step = this.seqVals[P.P_SEQ_CURSOR] || 0;
    this.menu('CLEAR', [
      { label: 'Cancel', run: () => {} },
      { label: `Step ${step + 1}`, run: () => { this.engine.seqCmd(1, pat, step); this.s.dirty.pattern = true; this.captureSeqSoon(); } },
      { label: `Pattern ${pat + 1}`, run: () => { this.engine.seqCmd(2, pat); this.s.dirty.pattern = true; this.captureSeqSoon(); } },
    ]);
  }

  copyVoiceMenu() {
    const items = [];
    for (let p = 0; p < 8; p++) if (p !== this.cur) items.push({ label: `To voice V${p + 1}`, run: () => { this.s.edit[p] = new Uint8Array(this.vced()); this.s.parts[p].edited = true; this.store.syncPart(p); this.toast('Copied'); } });
    this.menu('COPY VOICE', items);
  }

  initVoice() {
    this.s.edit[this.cur] = makeVoice('INIT VOICE', 1, 0, [{ ol: 99, kvs: 0 }, { kvs: 0 }, { kvs: 0 }, { kvs: 0 }, { kvs: 0 }, { kvs: 0 }]);
    const pt = this.part(); pt.env = { on: 0, a: 0, d: 50, s: 100, r: 20 }; pt.opmask = 63;
    this.part().edited = true; this.store.syncPart(this.cur); this.toast('Init voice');
  }
  resetImported() {
    const idx = this.part().preset;
    this.s.edit[this.cur] = vmemToVced(this.s.imported[idx >> 5][idx & 31]);
    this.part().edited = true; this.store.syncPart(this.cur); this.toast('Reset');
  }
  resetPatches() {
    const fresh = new Store({ sets() {}, vced() {}, set() {} }).s;
    this.s.library = fresh.library; this.s.imported = fresh.imported;
    for (let p = 0; p < 8; p++) this.store.loadPreset(p, this.s.parts[p].preset);
    this.store.touch(true); this.toast('Patches reset');
  }
  factoryReset() { this.store.factoryReset(); this.store.syncAll(); this.applyLook(); this.panel.setPot(this.s.global.master); this.toast('Factory reset'); }

  startRename(what) {
    const name = what === 'fx' ? this.s.fxGroups[this.s.fxGroup].name : voiceName(this.vced());
    this.overlay = { type: 'rename', what, name: name.padEnd(10, ' '), cursor: 0 };
  }
  finishRename() {
    const ov = this.overlay; this.overlay = null;
    const name = ov.name.replace(/\s+$/, '');
    if (ov.what === 'fx') this.s.fxGroups[this.s.fxGroup].name = name;
    else { setVoiceName(this.vced(), name); this.patchChanged(false); }
    this.store.touch(); this.fb.saved(); this.toast('Renamed');
  }

  // ---------------------------------------------------------------- data in/out
  importFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.syx,.SYX,application/octet-stream';
    inp.onchange = async () => { const f = inp.files[0]; if (f) this.importBytes(new Uint8Array(await f.arrayBuffer()), f.name); };
    inp.click();
  }
  importBytes(bytes, name = '') {
    const found = parseSysex(bytes);
    if (!found.length) { const raw = parseRawBank(bytes); if (raw) found.push(raw); }
    const bank = found.find((f) => f.type === 'bank'), voice = found.find((f) => f.type === 'voice');
    if (bank) {
      const items = ['A', 'B', 'C', 'D'].map((b, i) => ({
        label: `Write to bank ${b}`, run: () => {
          bank.voices.forEach((m, k) => { this.s.library[i][k].vmem = m; this.s.imported[i][k] = new Uint8Array(m); });
          this.store.touch(true); this.store.loadPreset(this.cur, i * 32); this.fb.saved();
          this.toast(`Bank ${b} loaded${bank.checksumOk ? '' : ' (bad sum)'}`);
        },
      }));
      this.menu(`BANK ${voiceName(bank.voices[0], 118)}…`, items);
      return;
    }
    if (voice) { this.receiveVoice(voice.vced); return; }
    this.blocked(name ? 'Not a DX7 file' : 'Unknown SysEx');
  }
  receiveVoice(vced) {
    // the stock unit writes a received single voice straight into the selected slot
    this.s.edit[this.cur] = vced;
    this.store.savePreset(this.cur);
    this.store.syncPart(this.cur);
    this.toast(voiceName(vced));
  }
  onSysex(m) {
    const found = parseSysex(m);
    for (const f of found) {
      if (f.type === 'param' && f.group >= 0) {
        if (f.addr < 155) { this.vced()[f.addr] = f.value; this.patchChanged(); }
      }
    }
    if (found.some((f) => f.type !== 'param')) this.importBytes(m);
  }
  onProgramChange(ch, prog) {
    for (let p = 0; p < 8; p++) {
      const pt = this.s.parts[p];
      if (pt.on && (pt.ch === 0 || pt.ch === ch + 1)) this.store.loadPreset(p, prog);
    }
  }
  exportBankMenu() {
    this.menu('EXPORT', ['A', 'B', 'C', 'D'].map((b, i) => ({
      label: `Bank ${b} (.syx)`, run: () => {
        const syx = buildBankSysex(this.s.library[i].map((v) => v.vmem));
        this.download(syx, `sixop-bank-${b}.syx`, 'application/octet-stream');
        if (this.midi.connected) this.midi.send(syx);
        this.toast('Exported');
      },
    })));
  }
  backup() { this.download(new TextEncoder().encode(this.store.exportAll()), 'sixop-backup.json', 'application/json'); this.toast('Backup saved'); }
  download(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  setupFileDrop() {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (/\.json$/i.test(f.name)) { localStorage.setItem('sixop.v1', await f.text()); location.reload(); return; }
      this.importBytes(new Uint8Array(await f.arrayBuffer()), f.name);
    });
  }
  onScreenTap() {
    if (this.overlay && this.overlay.type === 'rename') {
      const n = prompt('Name (10 characters)', this.overlay.name.trim());
      if (n != null) { this.overlay.name = n.slice(0, 10).padEnd(10, ' '); this.finishRename(); }
    }
  }

  async toggleMidi() {
    if (!this.midi.supported) return this.blocked('No MIDI in this browser');
    if (this.midi.enabled) { this.midi.disable(); this.toast('MIDI off'); this.fb.disengage(); return; }
    const ok = await this.midi.enable();
    this.toast(ok ? (this.midi.connected ? 'MIDI connected' : 'MIDI on') : (this.midi.supported ? 'MIDI not allowed' : 'No MIDI in this browser'));
    ok ? this.fb.engage() : this.fb.blocked();
  }
  onMidiState() { this.toast(this.midi.connected ? 'MIDI connected' : 'MIDI on', 700); }

  // ---------------------------------------------------------------- engine status
  onStatus(st) {
    const prevBeat = this.status ? this.status.sixteenth : st.sixteenth;
    this.status = st;
    if (st.midiout && this.midi.connected) {
      for (let i = 0; i < st.midiout.length; i += 3) this.midi.send([st.midiout[i], st.midiout[i + 1], st.midiout[i + 2]]);
    }
    if (st.clock && st.sixteenth !== prevBeat) {
      const sixteenthMs = 60000 / this.s.global.tempo / 4;
      if (st.sixteenth % 4 === 0) {
        this.panel.beat(st.sixteenth % 16 === 0, sixteenthMs);
        if (this.s.global.beatTick) this.fb.beat();
      }
    }
    // follow pattern switches made by the engine while playing a single pattern
    if (this.seqOn && this.seqVals[P.P_SEQ_PLAY] && !this.seqVals[P.P_SEQ_ARRANGE] && st.seqPattern >= 0) {
      this.seqVals[P.P_SEQ_PATTERN] = st.seqPattern;
    }
  }

  // ---------------------------------------------------------------- LEDs
  updateLeds() {
    const pn = this.panel, m = this.mode, st = this.status;
    const modeLed = (name, on) => pn.setLed(name, on ? 'on' : 'dim');
    modeLed('FX', m === 'FX'); modeLed('ENV', m === 'ENV'); modeLed('LFO', m === 'LFO');
    modeLed('EDIT', m === 'EDIT'); modeLed('GLO', m === 'GLOBE');
    pn.setLed('SEL', m === 'FX' && this.fxGrab ? 'fast' : (m === 'FX' ? 'half' : 'dim'));
    pn.setLed('SAVE', this.overlay && this.overlay.type === 'menu' && this.overlay.title === 'SAVE' ? 'on' : (this.s.parts.some((p) => p.edited) ? 'half' : 'dim'));
    pn.setLed('HOME', this.midi.enabled ? (this.midi.connected ? 'on' : 'bt') : (m === 'HOME' ? 'half' : 'dim'));
    const arpOn = !!this.s.arp.on;
    pn.setLed('ARP', arpOn ? (st && st.clock ? 'pulse' : 'on') : 'dim');
    pn.setLatched('ARP', arpOn);
    pn.setLed('SEQ', this.seqOn ? 'on' : 'dim'); pn.setLatched('SEQ', !!this.seqOn);
    const playing = !!this.seqVals[P.P_SEQ_PLAY];
    pn.setLed('PLAY', playing ? 'pulse' : 'dim'); pn.setLatched('PLAY', playing);
    const rec = !!this.seqVals[P.P_SEQ_REC];
    pn.setLed('REC', rec ? 'fast' : 'dim'); pn.setLatched('REC', rec);
    const o = this.s.ui.octave, octState = (a) => a === 0 ? 'dim' : a === 1 ? 'slow' : a === 2 ? 'fast' : 'on';
    pn.setLed('OCTDN', o < 0 ? octState(-o) : 'dim'); pn.setLed('OCTUP', o > 0 ? octState(o) : 'dim');

    // keys
    const edit = m === 'EDIT';
    const pt = this.part();
    for (let i = 0; i < KEY_COUNT; i++) {
      const k = pn.keyEls[i];
      let state = pn.keyBacklight ? 'dim' : 'off', label = '';
      const note = BASE_NOTE + i + 12 * this.s.ui.octave + this.s.ui.transpose;
      if (edit && k.black && k.blackN < EDIT_KEY_LABELS.length) {
        label = EDIT_KEY_LABELS[k.blackN];
        const op = /^OP(\d)$/.exec(label);
        if (op) {
          const n = +op[1], audible = pt.opmask & (1 << (n - 1));
          state = this.edit.target === 'OP' && this.edit.op === n ? 'on' : audible ? 'half' : 'off';
        } else if (label === 'PIT') state = this.edit.target === 'PIT' ? 'on' : 'dim';
        else if (label === 'GLO') state = this.edit.target === 'GLO' ? 'on' : 'dim';
        else if (label === 'MONO') state = pt.mono ? 'on' : 'slow';
        else if (label === 'POLY') state = pt.mono ? 'slow' : 'on';
      } else {
        // in a lesson the guide's own glows say which keys matter, so the
        // sequencer's step chase and other voices' notes stay dark
        const quiet = this.guide && (this.guide.lesson || this.guide.songLesson);
        if (!quiet && st && st.notes[note]) state = 'on';
        if (this.heldKeys.has(i)) state = 'on';
        if (!quiet && this.seqOn && st && st.seqStep >= 0 && i === st.seqStep % 16) state = 'on';
        if (!quiet && st && st.leds[i]) state = 'on';
      }
      pn.setLed('KEY' + i, state);
      if (k.labelCache !== label) { k.labelCache = label; pn.setKeyLabel(i, label); }
    }
  }

  // ---------------------------------------------------------------- screen
  draw() {
    const sc = this.screen;
    if (!sc) return; // panel can ask for a redraw before the screen exists
    if (this.guide) this.guide.screenBtn.hidden = this.powered;
    if (!this.powered) {
      const t = sc.theme; sc.begin();
      sc.text('SIXOP', 120, 92, 30, t.accent, 'center', 900);
      sc.text('six-operator FM', 120, 116, 11, t.dim, 'center', 600);
      sc.rrect(60, 140, 120, 34, 17, t.widgetOn);
      sc.g.textBaseline = 'middle';
      sc.text('Learn', 120, 158, 15, t.textOn, 'center', 800);
      sc.g.textBaseline = 'alphabetic';
      sc.text('or tap any key to power on', 120, 204, 10, t.dim, 'center');
      sc.text(APP_VERSION, 232, 232, 8, t.dim, 'right');
      return;
    }
    sc.begin();
    const pt = this.part(), now = performance.now();
    const icons = [];
    if (this.midi.enabled) icons.push(this.midi.connected ? 'MIDI' : 'midi');
    if (this.s.arp.on) icons.push('ARP');
    if (this.seqOn) icons.push(this.seqVals[P.P_SEQ_REC] ? 'REC' : 'SEQ');
    icons.push('V' + (this.cur + 1));
    sc.header({ num: pt.preset + 1, name: voiceName(this.vced()), edited: pt.edited, icons });

    let footer = '', sub = '';
    const m = this.mode;
    if (m === 'HOME') {
      sc.scope(this.status && this.status.scope, this.status ? `${this.status.voices} voice${this.status.voices === 1 ? '' : 's'}` : '');
      footer = 'OSC';
      const o = this.s.ui.octave, t = this.s.ui.transpose;
      if (o || t) sub = `${o ? 'Oct ' + (o > 0 ? '+' : '') + o : ''}${t ? ' Tr ' + (t > 0 ? '+' : '') + t : ''}`;
    } else if (m === 'FX') {
      sc.fxGrid(this.s.fx, this.fxSel, this.fxGrab, FX_NAMES, `${String(this.s.fxGroup + 1).padStart(3, '0')} ${this.s.fxGroups[this.s.fxGroup].name}`);
      const e = this.s.fx.order[this.fxSel];
      footer = FX_NAMES[e];
    } else if (m === 'SEQ') {
      this.drawSeq();
      const pg = this.page(); footer = this.seqView === 'arr' ? 'Arrangement' : `${pg.index + 1}/${pg.count} ${pg.title}`;
    } else {
      const pg = this.page();
      if (pg) {
        sc.tiles(pg.params.map((p) => p && this.tile(p)));
        const head = m === 'EDIT' ? (this.edit.target === 'OP' ? `OP${this.edit.op} ` : this.edit.target === 'PIT' ? '' : '') : '';
        footer = `${pg.index + 1}/${pg.count} ${head}${pg.title}`;
      }
    }
    if (this.flash && this.flash.until > now) footer = this.flash.text;
    sc.footer(footer, sub);

    const ov = this.overlay;
    if (ov) {
      if (ov.until && ov.until < now) this.overlay = null;
      else if (ov.type === 'algo') { sc.algo(this.vced()[G.ALG], pt.opmask, this.mode === 'EDIT' && this.edit.target === 'OP' ? this.edit.op : 0); }
      else if (ov.type === 'presets') {
        const items = [{ label: 'FX ' + this.s.fxGroups[this.s.fxGroup].name }];
        for (let p = 0; p < 8; p++) items.push({ label: `V${p + 1}  ${this.s.parts[p].on ? 'ON ' : 'off'} ch${this.s.parts[p].ch || 'A'} L${this.s.parts[p].level}`, dim: !this.s.parts[p].on });
        for (let i = 0; i < 128; i++) items.push(`${'ABCD'[i >> 5]}${String((i & 31) + 1).padStart(2, '0')} ${String(i + 1).padStart(3, '0')} ${this.store.presetName(i)}`);
        sc.list(ov.sel >= 1 && ov.sel <= 8 ? 'VOICE · K1 ch K2 lvl K3 pan K4 on' : 'PRESETS · V' + (this.cur + 1), items, ov.sel);
      } else if (ov.type === 'menu') sc.list(ov.title, ov.items, ov.sel);
      else if (ov.type === 'rename') sc.rename(ov.name, ov.cursor, ov.what === 'fx' ? 'RENAME FX GROUP' : 'RENAME VOICE');
    }
    if (this.toastMsg) { if (this.toastMsg.until < now) this.toastMsg = null; else sc.toast(this.toastMsg.msg); }
  }

  tile(p) {
    const v = p.get();
    const active = p.active ? p.active() : true;
    const bar = p.action ? null : (p.max > p.min ? (v - p.min) / (p.max - p.min) : 0);
    return { label: p.label, value: p.fmt(v), bar, bipolar: p.bipolar, active };
  }

  drawSeq() {
    const sc = this.screen, d = this.seqDump, st = this.status;
    if (this.seqView === 'arr') {
      const cells = [], rowOn = [];
      for (let r = 0; r < 8; r++) { cells.push([]); rowOn.push(!!this.s.parts[r].on || true); for (let c = 0; c < 8; c++) cells[r].push(d ? ((d[16 * 1032 + r * 8 + c] << 24) >> 24) : -1); }
      const a = this.arrSel;
      sc.arrangement({ cells, rowOn, len: d ? d[16 * 1032 + 64] || 4 : 4, selRow: a.row, selCol: a.col, row0: clamp(a.row - 1, 0, 4), col0: clamp(a.col - 1, 0, 4), playCol: st && this.seqVals[P.P_SEQ_ARRANGE] ? st.arrCol : -1 });
      sc.text('K1 pattern  K2 length  K3 play ' + (this.seqVals[P.P_SEQ_ARRANGE] ? 'ARR' : 'PAT') + '  K4 back', 120, 206, 7, sc.theme.dim, 'center');
      return;
    }
    const pat = this.seqVals[P.P_SEQ_PATTERN] || 0, len = this.seqVals[P.P_SEQ_STEPS] || 16;
    const steps = [];
    let tieLeft = 0;
    for (let i = 0; i < len; i++) {
      const o = pat * 1032 + i * 16;
      const notes = [], s = { notes, ratchet: d ? d[o + 12] : 1, tied: tieLeft > 0 };
      if (d) for (let n = 0; n < 4; n++) if (d[o + n] && d[o + 8 + n]) { notes.push(d[o + n]); tieLeft = Math.max(tieLeft, d[o + 8 + n]); }
      if (tieLeft > 0) tieLeft--;
      steps.push(s);
    }
    const playing = st && this.seqVals[P.P_SEQ_PLAY] ? st.seqStep : -1;
    const cur = this.seqVals[P.P_SEQ_CURSOR] || 0;
    const q = st && st.seqQueued >= 0 ? ` → P${st.seqQueued + 1}` : '';
    sc.seqGrid({ length: len, steps, play: playing, cursor: cur, info: `P${pat + 1}${q} · step ${cur + 1}${steps[cur] && steps[cur].notes.length ? ' ' + steps[cur].notes.map(noteName).join(' ') : ''}` });
    // compact parameter strip
    const pg = this.page();
    if (pg) pg.params.forEach((p, i) => {
      if (!p) return;
      const t = this.tile(p), x = 8 + i * 57;
      sc.rrect(x, 150, 53, 56, 6, sc.theme.widget, sc.theme.border);
      sc.text(t.label, x + 26, 162, 8, sc.theme.dim, 'center', 700);
      sc.text(String(t.value), x + 26, 186, String(t.value).length > 5 ? 10 : 13, sc.theme.text, 'center', 800);
    });
  }
}
