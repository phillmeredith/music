// Engine tests: run with `node --test tests/*.test.mjs`. They load web/engine.wasm, so
// rebuild with engine/build.sh first after changing C code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, tone, db, peak } from './engine-lib.mjs';
import { P } from '../web/js/params.js';

const RATE = 44100;
const ST_VOICES = 164 + 6 * 4, ST_ARP_STEP = 164 + 7 * 4;
const status = (e) => new DataView(e.mem(), e.x.sx_status());
const finite = (a) => a.every(Number.isFinite);

test('silent after init', async () => {
  const e = await loadEngine(RATE);
  const [L, R] = e.render(4096);
  assert.equal(peak(L), 0); assert.equal(peak(R), 0);
});

test('init voice is a clean sine at the right pitch', async () => {
  const e = await loadEngine(RATE);
  e.x.sx_note_on(0, 69, 100);
  e.render(8192);
  const [L] = e.render(16384);
  const f0 = tone(L, RATE, 440), off = tone(L, RATE, 446);
  assert.ok(db(f0) - db(off) > 30, 'energy sits on 440 Hz');
  assert.ok(db(tone(L, RATE, 880)) - db(f0) < -50, 'H2 below -50 dB');
  assert.ok(db(tone(L, RATE, 1320)) - db(f0) < -50, 'H3 below -50 dB');
});

test('level matches the stock capture (F3, velocity 90, no boost)', async () => {
  const e = await loadEngine(RATE);
  e.x.sx_set(P.P_DETUNE_MODE, 0);
  e.x.sx_key(53, 90);
  e.render(8192);
  const [L] = e.render(16384);
  const p = db(peak(L));
  // stock FM-1 V15 capture: -26.7 dBFS
  assert.ok(Math.abs(p - -26.7) < 1.5, `peak ${p.toFixed(1)} dBFS`);
});

test('note off releases to silence', async () => {
  const e = await loadEngine(RATE);
  e.x.sx_note_on(0, 60, 100);
  e.render(4096);
  e.x.sx_note_off(0, 60);
  e.render(RATE * 3);
  const [L] = e.render(4096);
  assert.ok(db(peak(L)) < -80, 'silent 3 s after release');
  assert.equal(status(e).getInt32(ST_VOICES, true), 0);
});

test('voice stealing caps polyphony and stays finite', async () => {
  const e = await loadEngine(RATE);
  e.x.sx_set(P.P_POLY, 20);
  for (let n = 40; n < 80; n++) { e.x.sx_note_on(0, n, 100); e.render(256); }
  const [L, R] = e.render(8192);
  assert.ok(finite(L) && finite(R));
  assert.ok(status(e).getInt32(ST_VOICES, true) <= 20);
  assert.ok(peak(L) <= 1 && peak(R) <= 1);
});

test('all six effects at extreme settings stay stable', async () => {
  const e = await loadEngine(RATE);
  for (let fx = 0; fx < 6; fx++) {
    e.x.sx_set(P.P_FX_BASE + fx * 8, 1);
    for (let k = 1; k <= 3; k++) e.x.sx_set(P.P_FX_BASE + fx * 8 + k, 100);
  }
  e.x.sx_set(P.P_DETUNE_MODE, 3); // +18 dB output boost
  for (const n of [36, 48, 55, 60, 64, 67, 72]) e.x.sx_note_on(0, n, 127);
  let max = 0;
  for (let i = 0; i < 40; i++) {
    const [L, R] = e.render(4410);
    assert.ok(finite(L) && finite(R), 'no NaN or Inf');
    max = Math.max(max, peak(L), peak(R));
  }
  assert.ok(max <= 1, `peak ${max}`);
  assert.ok(max > 0.01, 'still audible');
});

test('arpeggiator steps at the set tempo', async () => {
  const e = await loadEngine(RATE);
  e.x.sx_set(P.P_TEMPO, 120);
  e.x.sx_set(P.P_ARP_RATE, 6); // 1/16
  e.x.sx_set(P.P_ARP_ON, 1);
  for (const n of [60, 64, 67]) e.x.sx_key(n, 90);
  const s0 = status(e).getInt32(ST_ARP_STEP, true);
  e.render(RATE * 2); // 2 s at 120 BPM = 16 sixteenths
  const steps = status(e).getInt32(ST_ARP_STEP, true) - s0;
  assert.ok(steps >= 15 && steps <= 17, `${steps} steps in 2 s`);
});

test('sequencer plays a recorded step', async () => {
  const e = await loadEngine(RATE);
  const seq = new Uint8Array(e.mem(), e.x.sx_seq(), e.x.sx_seq_size());
  seq[0] = 60; seq[4] = 100; seq[8] = 1; seq[12] = 1; // pattern 1, step 1: C4
  e.x.sx_set(P.P_SEQ_ON, 1);
  e.x.sx_set(P.P_SEQ_PLAY, 1);
  const [L] = e.render(4410);
  assert.ok(peak(L) > 0.005, 'step 1 sounds');
});
