// Song lessons ("follow the lights"). A song is a list of timed notes from a
// MIDI file, from listening to a recording, from the sequencer, or built in.
// The lesson splits it into short phrases. For each one it plays the phrase
// while lighting the keys, then lights the next key(s) and waits for Harry to
// press them, flashing a wrong key red. At the end it can write the song into
// the sequencer as a beat.
import { P } from './params.js';

const LOW = 53, KEYS = 27;                       // F3, 27 keys
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n) => NOTE[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
const STORE = 'sixop.songs';

// ---------------------------------------------------------------- song model
// notes: [{ t: start seconds, d: duration seconds, n: midi note, v: 1..127 }]
export function makeSong(title, notes, bpm, source) {
  notes = notes.filter((x) => x.n >= 21 && x.n <= 108 && x.d > 0.02).sort((a, b) => a.t - b.t || a.n - b.n);
  if (!notes.length) return null;
  const t0 = notes[0].t;
  notes = notes.map((x) => ({ ...x, t: +(x.t - t0).toFixed(4) }));
  return { title, bpm: bpm || estimateBpm(notes), notes, source: source || '' };
}

// group notes that start together (within 60 ms) into events: one "press"
export function events(song) {
  const ev = [];
  for (const x of song.notes) {
    const last = ev[ev.length - 1];
    if (last && x.t - last.t < 0.06) { if (!last.notes.includes(x.n) && last.notes.length < 4) last.notes.push(x.n); last.d = Math.max(last.d, x.d); }
    else ev.push({ t: x.t, d: x.d, notes: [x.n] });
  }
  ev.forEach((e) => e.notes.sort((a, b) => a - b));
  return ev;
}

// short phrases: break at a long gap, or after 8 presses
export function phrases(ev) {
  if (!ev.length) return [];
  const gaps = ev.slice(1).map((e, i) => e.t - ev[i].t).sort((a, b) => a - b);
  const med = gaps.length ? gaps[gaps.length >> 1] : 0.5;
  const out = [[]];
  ev.forEach((e, i) => {
    const cur = out[out.length - 1];
    const gap = i ? e.t - ev[i - 1].t : 0;
    if (cur.length && (cur.length >= 8 || (gap > med * 1.9 && cur.length >= 3))) out.push([]);
    out[out.length - 1].push(i);
  });
  return out;
}

// best octave shift so the notes sit on the 27 keys
export function fitOctave(song) {
  let best = 0, bestIn = -1;
  for (let o = -3; o <= 3; o++) {
    const lo = LOW + 12 * o, hi = lo + KEYS - 1;
    const inside = song.notes.filter((x) => x.n >= lo && x.n <= hi).length;
    if (inside > bestIn || (inside === bestIn && Math.abs(o) < Math.abs(best))) { best = o; bestIn = inside; }
  }
  return best;
}
// notes that still fall off the keyboard are moved by octaves onto it
export function foldSong(song, oct) {
  const lo = LOW + 12 * oct, hi = lo + KEYS - 1;
  const fold = (n) => { while (n < lo) n += 12; while (n > hi) n -= 12; return n; };
  return { ...song, notes: song.notes.map((x) => ({ ...x, n: fold(x.n) })) };
}

export function estimateBpm(notes) {
  const on = [...new Set(notes.map((x) => Math.round(x.t * 50) / 50))];
  if (on.length < 4) return 90;
  let best = 90, bestS = -1;
  for (let bpm = 60; bpm <= 160; bpm++) {
    const per = 60 / bpm / 2; // eighth note
    let re = 0, im = 0;
    for (const t of on) { const a = (2 * Math.PI * t) / per; re += Math.cos(a); im += Math.sin(a); }
    const s = Math.hypot(re, im) / on.length - Math.abs(bpm - 100) * 0.0006; // light pull to the middle
    if (s > bestS) { bestS = s; best = bpm; }
  }
  return best;
}

// ---------------------------------------------------------------- MIDI files
export function parseMidi(buf) {
  const d = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer);
  let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); p += n; return s; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 127); } while (b & 128); return v; };
  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hl = u32(); u16(); const ntr = u16(); const div = u16(); p += hl - 6;
  if (div & 0x8000) throw new Error('SMPTE timing is not supported');
  const tempos = [{ tick: 0, us: 500000 }];
  const tracks = [];
  for (let t = 0; t < ntr && p < d.byteLength; t++) {
    if (str(4) !== 'MTrk') break;
    const len = u32(), end = p + len;
    let tick = 0, run = 0, name = '';
    const open = new Map(), notes = [];
    let drums = 0, total = 0;
    while (p < end) {
      tick += vlq();
      let s = d.getUint8(p);
      if (s & 0x80) p++; else s = run;
      if (s === 0xff) {
        const type = d.getUint8(p++), l = vlq();
        if (type === 0x51) tempos.push({ tick, us: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
        if (type === 0x03) { const q = p; name = str(l); p = q; }
        p += l; continue;
      }
      if (s === 0xf0 || s === 0xf7) { p += vlq(); continue; }
      run = s;
      const hi = s & 0xf0, ch = s & 15;
      const a = d.getUint8(p++), b = hi === 0xc0 || hi === 0xd0 ? 0 : d.getUint8(p++);
      if (hi === 0x90 && b > 0) { open.set(ch * 128 + a, { tick, v: b }); total++; if (ch === 9) drums++; }
      else if (hi === 0x80 || (hi === 0x90 && b === 0)) {
        const o = open.get(ch * 128 + a);
        if (o) { open.delete(ch * 128 + a); if (ch !== 9) notes.push({ tick: o.tick, end: tick, n: a, v: o.v }); }
      }
    }
    p = end;
    if (notes.length) tracks.push({ name: name.trim() || 'Track ' + (t + 1), notes, drums: drums === total });
  }
  tempos.sort((a, b) => a.tick - b.tick);
  const sec = (tick) => {
    let s = 0, last = 0, us = 500000;
    for (const tp of tempos) { if (tp.tick > tick) break; s += ((tp.tick - last) * us) / div / 1e6; last = tp.tick; us = tp.us; }
    return s + ((tick - last) * us) / div / 1e6;
  };
  const bpm = Math.round(60e6 / (tempos.find((x) => x.tick > 0 || tempos.length === 1) || tempos[tempos.length - 1]).us);
  return {
    bpm,
    tracks: tracks.map((tr) => ({
      name: tr.name,
      notes: tr.notes.map((x) => ({ t: sec(x.tick), d: Math.max(0.05, sec(x.end) - sec(x.tick)), n: x.n, v: x.v })),
    })),
  };
}

// ---------------------------------------------------------------- sequencer
// write a song into the sequencer: V1, patterns 1.., chained in the song view
export function songToSequencer(app, song) {
  const bpm = song.bpm || 100, eighth = 60 / bpm / 2;
  const onGrid = song.notes.filter((x) => Math.abs(x.t / eighth - Math.round(x.t / eighth)) < 0.2).length / song.notes.length;
  const sixteenth = onGrid < 0.85;
  const grid = sixteenth ? eighth / 2 : eighth, rate = sixteenth ? 6 : 4;
  const d = new Uint8Array(16 * 1032 + 66);
  d.fill(0xff, 16 * 1032, 16 * 1032 + 64);
  let maxStep = 0;
  for (const x of song.notes) {
    const st = Math.round(x.t / grid);
    const pat = st >> 6, s = st & 63;
    if (pat > 7) continue;                                // 8 patterns = 8 song columns
    const o = pat * 1032 + s * 16;
    let k = 0; while (k < 4 && d[o + k]) k++;
    if (k === 4) continue;
    d[o + k] = x.n; d[o + 4 + k] = Math.max(40, x.v || 100); d[o + 8 + k] = Math.max(1, Math.min(64 - s, Math.round(x.d / grid)));
    d[o + 12] = 1;
    maxStep = Math.max(maxStep, st);
  }
  const nPat = Math.min(8, (maxStep >> 6) + 1);
  for (let pat = 0; pat < 16; pat++) {
    const b = pat * 1032 + 1024;
    const len = pat < nPat - 1 ? 64 : pat === nPat - 1 ? Math.max(4, Math.ceil(((maxStep & 63) + 1) / 4) * 4) : 16;
    d[b] = len; d[b + 1] = 0; d[b + 2] = pat < nPat ? rate : 6; d[b + 3] = 85; d[b + 4] = 50; d[b + 5] = 12;
    for (let s = 0; s < 64; s++) if (!d[pat * 1032 + s * 16 + 12]) d[pat * 1032 + s * 16 + 12] = 1;
  }
  for (let c = 0; c < nPat; c++) d[16 * 1032 + c] = c;   // row V1, columns 1..n
  d[16 * 1032 + 64] = nPat;
  app.engine.seqLoad(d);
  app.s.global.tempo = Math.max(30, Math.min(300, Math.round(bpm)));
  app.engine.set(P.P_TEMPO, app.s.global.tempo);
  app.engine.set(P.P_SEQ_ARRANGE, nPat > 1 ? 1 : 0);
  app.seqVals[P.P_SEQ_ARRANGE] = nPat > 1 ? 1 : 0;
  app.captureSeqSoon();
  return { patterns: nPat, rate: sixteenth ? '1/16' : '1/8' };
}

// read the sequencer back as a song (all voices' patterns as played in pattern 1..)
export function sequencerToSong(app, title) {
  const d = app.seqDump; if (!d) return null;
  const RT = [96, 48, 24, 16, 12, 8, 6, 4, 3];
  const tick = 60 / (app.s.global.tempo || 120) / 24;
  const notes = [];
  // song view order if it has cells on row 1, else pattern 1 only
  const cols = [];
  const alen = d[16 * 1032 + 64] || 4;
  for (let c = 0; c < alen; c++) { const v = (d[16 * 1032 + c] << 24) >> 24; if (v >= 0) cols.push(v); }
  const order = cols.length ? cols : [0];
  let t = 0;
  for (const pat of order) {
    const b = pat * 1032, len = d[b + 1024] || 16, st = RT[d[b + 1026]] * tick;
    for (let s = 0; s < len; s++) for (let k = 0; k < 4; k++) {
      const n = d[b + s * 16 + k], l = d[b + s * 16 + 8 + k];
      if (n && l) notes.push({ t: t + s * st, d: l * st * 0.9, n, v: d[b + s * 16 + 4 + k] || 100 });
    }
    t += len * st;
  }
  return makeSong(title, notes, app.s.global.tempo, 'sequencer');
}

// ---------------------------------------------------------------- saved songs
export function loadSongs() { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; } }
export function saveSong(song) {
  const all = loadSongs();
  const base = song.title; let n = 2;
  while (all.some((x) => x.title === song.title)) song.title = `${base} ${n++}`;
  all.unshift(song);
  try { localStorage.setItem(STORE, JSON.stringify(all.slice(0, 40))); } catch { /* full */ }
}
export function deleteSong(title) {
  try { localStorage.setItem(STORE, JSON.stringify(loadSongs().filter((s) => s.title !== title))); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- the lesson
export class SongLesson {
  constructor(app, card, song, onExit) {
    this.app = app; this.card = card; this.onExit = onExit;
    this.oct = fitOctave(song);
    this.song = foldSong(song, this.oct);
    this.ev = events(this.song);
    this.ph = phrases(this.ev);
    this.p = 0; this.k = 0; this.hit = new Set();
    this.mode = 'listen'; this.slow = false; this.whole = false;
    this.timers = [];
    this.marks = new Set();
  }

  start() {
    const a = this.app;
    if (a.s.arp.on) a.toggleArp();
    if (a.seqVals[P.P_SEQ_PLAY]) a.setSeqPlay(0);
    if (a.seqOn) a.toggleSeq();
    a.setMode('HOME');
    a.s.ui.octave = this.oct; a.s.ui.transpose = 0;
    a.engine.panic();
    this.listen();
  }
  stop() { this.clearTimers(); this.clearMarks(); this.app.engine.panic(); }

  // ----- phrase playback
  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }
  listen() {
    this.clearTimers(); this.mode = 'listen'; this.k = 0; this.hit.clear();
    const idx = this.ph[this.p], sp = this.slow ? 1.6 : 1;
    const t0 = this.ev[idx[0]].t;
    idx.forEach((i) => {
      const e = this.ev[i], at = (e.t - t0) * sp * 1000 + 300;
      this.timers.push(setTimeout(() => {
        e.notes.forEach((n) => this.app.engine.noteOn(this.app.cur, n, 90));
        this.mark(e.notes, 'g-play');
      }, at));
      this.timers.push(setTimeout(() => {
        e.notes.forEach((n) => this.app.engine.noteOff(this.app.cur, n));
        this.unmark('g-play');
      }, at + Math.min(e.d, 1.2) * sp * 1000));
    });
    const last = this.ev[idx[idx.length - 1]];
    this.timers.push(setTimeout(() => { this.mode = 'play'; this.show(); }, (last.t - t0) * sp * 1000 + Math.min(last.d, 1.2) * sp * 1000 + 500));
    this.show();
  }

  // ----- keys
  keyIdx(n) { return n - LOW - 12 * this.app.s.ui.octave - this.app.s.ui.transpose; }
  keyEl(n) { return document.querySelector(`.key[data-idx="${this.keyIdx(n)}"]`); }
  mark(notes, cls) { for (const n of notes) { const k = this.keyEl(n); if (k) { k.classList.add(cls); this.marks.add(k); } } }
  unmark(cls) { for (const k of this.marks) k.classList.remove(cls); }
  clearMarks() { for (const k of this.marks) k.classList.remove('g-next', 'g-soon', 'g-play', 'g-bad', 'g-got'); this.marks.clear(); }
  cur() { const idx = this.ph[this.p]; return idx && this.ev[idx[this.k]]; }
  showKeys() {
    this.clearMarks();
    if (this.mode !== 'play') return;
    const e = this.cur(); if (!e) return;
    this.mark(e.notes.filter((n) => !this.hit.has(n)), 'g-next');
    this.mark(e.notes.filter((n) => this.hit.has(n)), 'g-got');
    const idx = this.ph[this.p], nx = idx[this.k + 1] != null ? this.ev[idx[this.k + 1]] : null;
    if (nx) this.mark(nx.notes.filter((n) => !e.notes.includes(n)), 'g-soon');
  }

  // called by the app for every key press while a song lesson runs
  onKey(idx, ev, note) {
    if (ev !== 'down' || this.mode !== 'play') return;
    const e = this.cur(); if (!e) return;
    if (e.notes.includes(note)) {
      this.hit.add(note);
      if (e.notes.every((n) => this.hit.has(n))) this.advance();
      else this.showKeys();
    } else {
      const k = document.querySelector(`.key[data-idx="${idx}"]`);
      if (k) { k.classList.add('g-bad'); this.marks.add(k); setTimeout(() => k.classList.remove('g-bad'), 350); }
      this.misses = (this.misses || 0) + 1;
    }
  }
  advance() {
    this.hit.clear();
    this.k++;
    if (this.k < this.ph[this.p].length) { this.showKeys(); this.show(); return; }
    // phrase done
    this.mode = 'done'; this.clearMarks();
    this.app.fb.saved && this.app.fb.saved();
    this.show();
    this.timers.push(setTimeout(() => this.nextPhrase(), 1100));
  }
  nextPhrase() {
    if (this.whole) { this.p++; if (this.p >= this.ph.length) return this.finish(); this.k = 0; this.mode = 'play'; this.show(); return; }
    this.p++;
    if (this.p >= this.ph.length) return this.finish();
    this.listen();
  }
  finish() { this.mode = 'end'; this.clearMarks(); this.show(); }

  // ----- card
  show() {
    this.showKeys();
    const n = this.ph.length, pct = Math.round(((this.p + (this.mode === 'done' ? 1 : 0)) / n) * 100);
    const e = this.cur();
    const titles = {
      listen: '👂 Listen…',
      play: this.whole ? 'Play along: press the glowing keys' : 'Your turn: press the glowing keys',
      done: '✓ Nice!',
      end: this.whole ? 'You played the whole song!' : 'You learned every part!',
    };
    let body = '';
    if (this.mode === 'listen') body = '<p class="g-why">Watch the keys light up as it plays.</p>';
    if (this.mode === 'play' && e) body = `<div class="g-now"><span>Next</span>${e.notes.map(noteName).join(' + ')}${e.notes.length > 1 ? ' together' : ''}</div><p class="g-why">The faint glow shows what comes after.</p>`;
    if (this.mode === 'end') body = '<p class="g-why">Play it all the way through with the lights, or turn it into a beat in the sequencer and build drums around it.</p>';
    const row = this.mode === 'end'
      ? `<div class="g-row"><button class="g-whole">Play all</button><button class="g-seq g-go">Make it a beat</button></div>`
      : `<div class="g-row"><button class="g-back" ${this.p === 0 ? 'disabled' : ''}>Back</button><button class="g-again">Hear it</button><button class="g-slow">${this.slow ? 'Normal' : 'Slow'}</button><button class="g-skip">Skip</button></div>`;
    this.card.className = 'guide-card song' + (this.mode === 'done' || this.mode === 'end' ? ' ok' : '');
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">${this.song.title}</span><span class="g-count">${this.whole ? 'Whole song' : `Part ${Math.min(this.p + 1, n)} / ${n}`}</span><button class="g-x" aria-label="Close">✕</button></div>
      <div class="g-bar"><i style="width:${this.mode === 'end' ? 100 : pct}%"></i></div>
      <h3>${titles[this.mode]}</h3>${body}${row}`;
    const on = (sel, fn) => { const b = this.card.querySelector(sel); if (b) b.onclick = fn; };
    on('.g-x', () => this.onExit());
    on('.g-back', () => { this.p = Math.max(0, this.p - 1); this.whole = false; this.listen(); });
    on('.g-again', () => { this.whole = false; this.listen(); });
    on('.g-slow', () => { this.slow = !this.slow; this.listen(); });
    on('.g-skip', () => { this.clearTimers(); this.nextPhrase(); });
    on('.g-whole', () => { this.whole = true; this.p = 0; this.k = 0; this.mode = 'play'; this.show(); });
    on('.g-seq', () => {
      const r = songToSequencer(this.app, this.song);
      if (!this.app.seqOn) this.app.toggleSeq();
      this.app.toast(`Saved as ${r.patterns} pattern${r.patterns > 1 ? 's' : ''}`, 1500);
      this.onExit();
    });
  }
}
