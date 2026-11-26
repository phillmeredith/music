// Shared helpers for the guide and the lesson scripts.
import { P } from './params.js';

// selectors for every control a lesson can point at
export const T = {
  btn: (n) => `.btn[data-name="${n}"]`,
  knob: (label) => `.enc[aria-label="${label}"], .pot-knob[aria-label="${label}"]`,
  key: (i) => `.key[data-idx="${i}"]`,
  screen: () => '.bezel',
};

export const H = {
  sv: (app, id) => app.seqVals[id] ?? 0,
  stepNotes(app, pat, step) {
    const d = app.seqDump; if (!d) return [];
    const o = pat * 1032 + step * 16, out = [];
    for (let n = 0; n < 4; n++) if (d[o + n] && d[o + 8 + n]) out.push(d[o + n]);
    return out.sort((a, b) => a - b);
  },
  cell(app, r, c) { const d = app.seqDump; return d ? ((d[16 * 1032 + r * 8 + c] << 24) >> 24) : -1; },
  arrLen(app) { const d = app.seqDump; return d ? d[16 * 1032 + 64] || 4 : 4; },
  P,
};

// kind words for a wrong key: never a telling-off
export const TRY_AGAIN = [
  'Oops, not that one. Try a yellow key 🙂',
  'So close! Have another go.',
  'No worries. Look for the yellow glow.',
  'Nearly! Try again, you’ve got this.',
  'That’s OK, mistakes help you learn. Try again!',
];
export const tryAgain = () => TRY_AGAIN[Math.floor(Math.random() * TRY_AGAIN.length)];

// play several sequencer patterns together, each on its own voice, once
// through the longest one (so "everything so far" can be heard before the
// song view exists). Returns a stop function.
const TICKS = [96, 48, 24, 16, 12, 8, 6, 4, 3];
export async function playPatterns(app, pats, onEnd) {
  await app.refreshSeqVals();
  const d = app.seqDump; if (!d) return () => {};
  const beat = 60000 / (app.s.global.tempo || 90), timers = [], on = [];
  const parts = pats.map((p) => {
    const h = p * 1032 + 1024;
    return { p, len: d[h] || 16, part: d[h + 1], ms: (TICKS[d[h + 2]] || 6) / 24 * beat, gate: (d[h + 3] || 80) / 100, swing: d[h + 4] || 50 };
  });
  const total = Math.min(24000, Math.max(...parts.map((x) => x.len * x.ms)));
  for (const x of parts) {
    for (let loop = 0; loop * x.len * x.ms < total; loop++) {
      for (let s = 0; s < x.len; s++) {
        let t = (loop * x.len + s) * x.ms; if (s % 2) t += ((x.swing - 50) / 50) * x.ms;
        if (t >= total) break;
        const o = x.p * 1032 + s * 16;
        for (let n = 0; n < 4; n++) {
          if (!d[o + n] || !d[o + 8 + n]) continue;
          const note = d[o + n], vel = d[o + 4 + n] || 90;
          timers.push(setTimeout(() => { app.engine.noteOn(x.part, note, vel); on.push([x.part, note]); }, t + 60));
          timers.push(setTimeout(() => app.engine.noteOff(x.part, note), t + 60 + Math.max(60, x.ms * x.gate)));
        }
      }
    }
  }
  timers.push(setTimeout(() => onEnd && onEnd(), total + 400));
  return () => { timers.forEach(clearTimeout); on.forEach(([pt, n]) => app.engine.noteOff(pt, n)); app.engine.panic(); };
}
