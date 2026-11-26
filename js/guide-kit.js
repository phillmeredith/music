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
