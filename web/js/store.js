// App state, persistence and engine sync.
import { P } from './params.js';
import { vmemToVced, vcedToVmem, voiceName } from './dx7.js';
import { factoryBanks, DEFAULT_EXTRAS } from './presets.js';

const KEY = 'sixop.v1';
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const clone = (o) => JSON.parse(JSON.stringify(o));

export const FX_NAMES = ['Filter', 'Reverb', 'Delay', 'Distortion', 'Chorus', 'Phaser'];
const FX_DEFAULT = () => ({
  params: [[0, 0, 60, 0], [0, 0, 50, 30], [0, 30, 50, 30], [0, 25, 50, 50], [0, 30, 50, 50], [0, 30, 50, 50]],
  order: [0, 1, 2, 3, 4, 5],
});

function defaultPart(i) {
  return {
    on: i === 0 ? 1 : 0, ch: i === 0 ? 0 : i + 1, level: 100, pan: 50, bendUp: 12, bendDn: 12,
    glide: 0, fine: 0, mono: 0, opmask: 63, preset: i === 0 ? 0 : i, edited: false,
    env: { on: 0, a: 0, d: 50, s: 100, r: 20 },
  };
}

export function defaultState() {
  const banks = factoryBanks();
  return {
    version: 1,
    library: banks.map((b) => b.map((v) => ({ vmem: v.vmem, extras: v.extras }))), // 4 x 32
    imported: banks.map((b) => b.map((v) => v.vmem)), // "reset to imported" copies
    parts: Array.from({ length: 8 }, (_, i) => defaultPart(i)),
    edit: [], // per part VCED edit buffers (filled at load)
    global: {
      midiCh: 0, fxCh: 1, velocity: 90, glideMode: 0, tempo: 120, master: 100,
      btnBL: 1, keyBL: 1, theme: 0, clicks: 1, clickVol: 0.5, hwChar: 1, quant16: 1, drive: 0,
      boost: 2, touchVel: 0, poly: 20, extCC7: 1, beatTick: 0, screenTheme: 0,
    },
    fx: FX_DEFAULT(),
    fxGroup: 0,
    fxGroups: Array.from({ length: 128 }, (_, i) => ({ name: 'FX' + String(i + 1).padStart(3, '0'), ...FX_DEFAULT() })),
    arp: { mode: 0, oct: 1, rate: 6, gate: 80, swing: 50, latch: 0, sync: 0 },
    seqData: null, // base64 dump of the engine's sequencer memory
    seqSettings: { transpose: 0, sync: 0 },
    ui: { curPart: 0, octave: 0, transpose: 0, edOp: 1, pages: {} },
    dirty: { globe: false, pattern: false },
  };
}

export class Store {
  constructor(engine) {
    this.engine = engine;
    this.s = this.load() || defaultState();
    for (let p = 0; p < 8; p++) if (!this.s.edit[p]) this.s.edit[p] = this.presetVced(this.s.parts[p].preset);
    this.saveTimer = null;
  }

  // ---- library ----
  presetEntry(idx) { return this.s.library[(idx >> 5) & 3][idx & 31]; }
  presetVced(idx) { return vmemToVced(this.presetEntry(idx).vmem); }
  presetName(idx) { return voiceName(this.presetEntry(idx).vmem, 118); }
  vced(p = this.s.ui.curPart) { return this.s.edit[p]; }
  part(p = this.s.ui.curPart) { return this.s.parts[p]; }

  loadPreset(part, idx) {
    idx = ((idx % 128) + 128) % 128;
    const pt = this.s.parts[part];
    pt.preset = idx; pt.edited = false; pt.opmask = 63;
    this.s.edit[part] = this.presetVced(idx);
    const ex = this.presetEntry(idx).extras || DEFAULT_EXTRAS();
    pt.env = clone(ex.env || DEFAULT_EXTRAS().env);
    pt.mono = ex.mono ? 1 : 0;
    pt.glide = ex.glide || 0;
    this.syncPart(part, false);
    this.touch();
  }

  savePreset(part, idx = this.s.parts[part].preset) {
    const pt = this.s.parts[part];
    const entry = this.presetEntry(idx);
    entry.vmem = vcedToVmem(this.s.edit[part]);
    entry.extras = { env: clone(pt.env), mono: pt.mono, glide: pt.glide };
    pt.edited = false; pt.preset = idx;
    this.touch(true);
  }

  // ---- engine sync ----
  syncPart(p, live = false) {
    const e = this.engine, pt = this.s.parts[p], base = P.P_PART_BASE + p * P.PP_COUNT;
    e.sets([
      [base + P.PP_ON, pt.on], [base + P.PP_CH, pt.ch], [base + P.PP_LEVEL, pt.level], [base + P.PP_PAN, pt.pan],
      [base + P.PP_BEND_UP, pt.bendUp], [base + P.PP_BEND_DN, pt.bendDn], [base + P.PP_GLIDE, pt.glide],
      [base + P.PP_FINE, pt.fine], [base + P.PP_MONO, pt.mono], [base + P.PP_ENV_ON, pt.env.on],
      [base + P.PP_ENV_A, pt.env.a], [base + P.PP_ENV_D, pt.env.d], [base + P.PP_ENV_S, pt.env.s],
      [base + P.PP_ENV_R, pt.env.r], [base + P.PP_OPMASK, pt.opmask],
    ]);
    e.vced(p, this.s.edit[p], live);
  }
  partParam(p, k, v) { this.engine.set(P.P_PART_BASE + p * P.PP_COUNT + k, v); }

  syncFx() {
    const list = [];
    this.s.fx.params.forEach((ps, e) => ps.forEach((v, k) => list.push([P.P_FX_BASE + e * 8 + k, v])));
    this.s.fx.order.forEach((e, pos) => list.push([P.P_FX_ORDER + pos, e]));
    this.engine.sets(list);
  }

  syncGlobal() {
    const g = this.s.global, a = this.s.arp;
    this.engine.sets([
      [P.P_MASTER, g.master], [P.P_HW_CHAR, g.hwChar], [P.P_QUANT16, g.quant16], [P.P_DRIVE, g.drive],
      [P.P_GLIDE_MODE, g.glideMode], [P.P_MIDI_CH, g.midiCh], [P.P_FX_CH, g.fxCh], [P.P_POLY, g.poly],
      [P.P_EXT_CC7, g.extCC7], [P.P_TEMPO, g.tempo], [P.P_DETUNE_MODE, g.boost],
      [P.P_ARP_MODE, a.mode], [P.P_ARP_OCT, a.oct], [P.P_ARP_RATE, a.rate], [P.P_ARP_GATE, a.gate],
      [P.P_ARP_SWING, a.swing], [P.P_ARP_LATCH, a.latch], [P.P_ARP_SYNC, a.sync],
      [P.P_SEQ_TRANSPOSE, this.s.seqSettings.transpose], [P.P_SEQ_SYNC, this.s.seqSettings.sync],
    ]);
  }

  syncAll() {
    this.syncGlobal();
    for (let p = 0; p < 8; p++) this.syncPart(p, false);
    this.syncFx();
    if (this.s.seqData) this.engine.seqLoad(unb64(this.s.seqData));
  }

  async captureSeq() {
    const d = await this.engine.seqDump();
    this.s.seqData = b64(d);
    this.touch();
  }

  // ---- persistence ----
  touch(now = false) {
    clearTimeout(this.saveTimer);
    if (now) this.persist(); else this.saveTimer = setTimeout(() => this.persist(), 600);
  }

  persist() {
    try {
      const s = this.s;
      const out = {
        ...s,
        library: s.library.map((b) => b.map((v) => ({ vmem: b64(v.vmem), extras: v.extras }))),
        imported: s.imported.map((b) => b.map(b64)),
        edit: s.edit.map(b64),
      };
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch (err) { console.warn('save failed', err); }
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (j.version !== 1) return null;
      const d = defaultState();
      const s = { ...d, ...j };
      s.library = j.library.map((b) => b.map((v) => ({ vmem: unb64(v.vmem), extras: v.extras })));
      s.imported = j.imported.map((b) => b.map(unb64));
      s.edit = j.edit.map((x) => { const u = unb64(x); const v = new Uint8Array(156); v.set(u.subarray(0, 156)); return v; });
      s.global = { ...d.global, ...j.global };
      s.ui = { ...d.ui, ...j.ui };
      s.arp = { ...d.arp, ...j.arp };
      return s;
    } catch (err) { console.warn('load failed', err); return null; }
  }

  factoryReset() { localStorage.removeItem(KEY); this.s = defaultState(); for (let p = 0; p < 8; p++) this.s.edit[p] = this.presetVced(this.s.parts[p].preset); }

  exportAll() {
    this.persist();
    return localStorage.getItem(KEY);
  }
}
