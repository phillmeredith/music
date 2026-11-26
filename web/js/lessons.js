// Lesson scripts for the guide. Each step names what to touch (target), says
// what to do in one short line (text), and checks the synth's state (done).
// `requires` lists things that must be true first; when one isn't, the card
// shows how to put it right before carrying on.
import { P } from './params.js';
import { T, H } from './guide-kit.js';

const sv = H.sv;
const RATE = ['1/1', '1/2', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
const turn = (cur, goal) => (cur < goal ? 'turn right ↻' : 'turn left ↺');
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nn = (n) => NOTE[n % 12] + (Math.floor(n / 12) - 1);

// ---------- things a step can need first
const R = {
  seq: { ok: (a) => a.seqOn && a.mode === 'SEQ', text: 'Press SEQ to get back to the sequencer', target: T.btn('SEQ') },
  steps: { ok: (a) => a.seqView !== 'arr', text: 'Turn KNOB4 to leave the song view', target: T.knob('KNOB4') },
  arr: { ok: (a) => a.seqView === 'arr', text: 'Turn KNOB3 (Chain) to open the song view', target: T.knob('KNOB3'), requires: [] },
  noArp: { ok: (a) => !a.s.arp.on, text: 'Press ARP to switch the arpeggiator off', target: T.btn('ARP') },
  stopped: { ok: (a) => !sv(a, P.P_SEQ_PLAY), text: 'Press PLAY/STOP to stop playing', target: T.btn('PLAY') },
  recOn: { ok: (a) => !!sv(a, P.P_SEQ_REC), text: 'Press REC to start recording', target: T.btn('REC') },
  recOff: { ok: (a) => !sv(a, P.P_SEQ_REC), text: 'Press REC to stop recording', target: T.btn('REC') },
  page: (n) => ({
    ok: (a) => (a.pageIdx[a.modeKey()] || 0) === n,
    text: `Turn SELECT to page ${n + 1}`,
    target: T.knob('SELECT'),
    hint: (a) => turn(a.pageIdx[a.modeKey()] || 0, n),
    now: (a) => `page ${(a.pageIdx[a.modeKey()] || 0) + 1}`,
  }),
  pattern: (n) => ({
    ok: (a) => sv(a, P.P_SEQ_PATTERN) === n,
    text: `Turn KNOB1 to Pattern ${n + 1}`,
    target: T.knob('KNOB1'),
    hint: (a) => turn(sv(a, P.P_SEQ_PATTERN), n),
    now: (a) => `Pattern ${sv(a, P.P_SEQ_PATTERN) + 1}`,
  }),
  octave: (o) => ({
    ok: (a) => a.s.ui.octave === o && a.s.ui.transpose === 0,
    text: o === 0 ? 'Press OCT- and OCT+ together to reset the octave' : `Press ${o < 0 ? 'OCT-' : 'OCT+'} until the screen says Oct ${o}`,
    target: o === 0 ? [T.btn('OCTDN'), T.btn('OCTUP')] : T.btn(o < 0 ? 'OCTDN' : 'OCTUP'),
  }),
  fx: { ok: (a) => a.mode === 'FX', text: 'Press FX', target: T.btn('FX') },
  fxSel: (n, name) => ({ ok: (a) => a.s.fx.order[a.fxSel] === n, text: `Turn SELECT to ${name}`, target: T.knob('SELECT'),
    hint: (a) => turn(a.fxSel, a.s.fx.order.indexOf(n)) }),
};
// the page a sequencer knob lives on
const seqPage = (n) => [R.noArp, R.seq, R.steps, R.page(n)];

// ---------- step builders
// turn a sequencer knob to a value
function seqKnob(section, { page, knob, label, id, goal, fmt = (x) => x, why, extra = [] }) {
  return {
    section, why,
    text: `Turn KNOB${knob} until ${label} is ${fmt(goal)}`,
    target: T.knob('KNOB' + knob),
    requires: [...seqPage(page), ...extra],
    done: (a) => sv(a, id) === goal,
    now: (a) => `${label}: ${fmt(sv(a, id))}`,
    goal: `${label}: ${fmt(goal)}`,
    hint: (a) => turn(sv(a, id), goal),
    quick: true,
  };
}
// choose a sound for the current voice with PRESETS
function preset(section, voice, idx, name, why) {
  return {
    section, why,
    text: `Turn PRESETS until the screen says ${String(idx + 1).padStart(3, '0')} ${name}`,
    target: T.knob('PRESETS'),
    requires: [R.noArp, R.seq,
      { ok: (a) => a.cur === voice, text: `Turn PRESETS to “V${voice + 1}” and tap SEL`, target: [T.knob('PRESETS'), T.btn('SEL')] }],
    done: (a) => a.s.parts[voice].preset === idx,
    now: (a) => `${String(a.s.parts[voice].preset + 1).padStart(3, '0')} ${a.store.presetName(a.s.parts[voice].preset)}`,
    goal: `${String(idx + 1).padStart(3, '0')} ${name}`,
    hint: (a) => turn(a.s.parts[voice].preset, idx),
  };
}
// record a chord or a note on one step
function rec(section, pat, step, keys, notes, oct, text, why) {
  return {
    section, why,
    text,
    target: keys.map(T.key),
    demo: { keys, oct },   // the guide plays it first (white), then it's his turn (green); other keys are blocked
    requires: [...seqPage(0), R.pattern(pat), R.octave(oct), R.recOn],
    onEnter: (a) => { a.engine.set(P.P_SEQ_CURSOR, step); a.seqVals[P.P_SEQ_CURSOR] = step; },
    done: (a) => (notes ? eq(H.stepNotes(a, pat, step), notes) : H.stepNotes(a, pat, step).length > 0) && a.heldKeys.size === 0,
    now: (a) => { const n = H.stepNotes(a, pat, step); return `Step ${step + 1}: ${n.length ? n.map(nn).join(' ') : 'empty'}`; },
    goal: notes ? `Step ${step + 1}: ${notes.map(nn).join(' ')}` : '',
    wrong: (a) => {
      if (!notes || a.heldKeys.size) return '';
      const n = H.stepNotes(a, pat, step);
      return n.length && !eq(n, notes) ? 'Not quite the right keys. Tap Redo and have another go.' : '';
    },
    redo: (a) => { a.engine.seqCmd(1, pat, step); a.engine.set(P.P_SEQ_CURSOR, step); a.seqVals[P.P_SEQ_CURSOR] = step; a.captureSeqSoon(); },
  };
}
// skip to a step with SEL (rests)
function skipTo(section, pat, step, why) {
  return {
    section, why,
    text: (a) => { const left = step - sv(a, P.P_SEQ_CURSOR); return left > 0 ? `Tap SEL ${left} more time${left === 1 ? '' : 's'} to skip to step ${step + 1}` : `Skip to step ${step + 1}`; },
    target: T.btn('SEL'),
    requires: [...seqPage(0), R.pattern(pat), R.recOn],
    done: (a) => sv(a, P.P_SEQ_CURSOR) === step,
    now: (a) => `On step ${sv(a, P.P_SEQ_CURSOR) + 1}`,
    goal: `Step ${step + 1}`,
    wrong: (a) => (sv(a, P.P_SEQ_CURSOR) > step ? 'Gone past it. Tap Redo to jump back.' : ''),
    redo: (a) => { a.engine.set(P.P_SEQ_CURSOR, step); a.seqVals[P.P_SEQ_CURSOR] = step; },
    quick: true,
  };
}
// put a pattern into a song cell
function cell(section, r, c, pat, why) {
  return {
    section, why,
    text: `Turn KNOB1 until this box says P${pat + 1}`,
    target: T.knob('KNOB1'),
    requires: [R.noArp, R.seq, R.page(0), R.arr,
      { ok: (a) => a.arrSel.row === r && a.arrSel.col === c,
        text: `Turn SELECT to the V${r + 1} row, column ${c + 1}`, target: T.knob('SELECT'),
        hint: (a) => turn(a.arrSel.row * 8 + a.arrSel.col, r * 8 + c),
        now: (a) => `V${a.arrSel.row + 1}, column ${a.arrSel.col + 1}` }],
    done: (a) => H.cell(a, r, c) === pat,
    now: (a) => { const v = H.cell(a, r, c); return `V${r + 1} · ${v < 0 ? 'empty' : 'P' + (v + 1)}`; },
    goal: `V${r + 1} plays P${pat + 1}`,
    hint: (a) => turn(H.cell(a, r, c), pat),
    quick: true,
  };
}
function fxOn(section, n, name, why) {
  return {
    section, why, text: `Turn KNOB4 to switch ${name} on`, target: T.knob('KNOB4'),
    requires: [R.fx, R.fxSel(n, name)],
    done: (a) => a.s.fx.params[n][0] === 1,
    now: (a) => `${name}: ${a.s.fx.params[n][0] ? 'ON' : 'OFF'}`,
    hint: 'turn right ↻',
  };
}
const playHere = (section, text, why) => ({
  section, why, text, target: T.btn('PLAY'),
  requires: [R.noArp, R.seq, R.recOff],
  done: (a) => !!sv(a, P.P_SEQ_PLAY),
});
const stopHere = (section) => ({
  section, text: 'Have a listen. Press PLAY/STOP when you’re ready to move on', target: T.btn('PLAY'),
  done: (a) => !sv(a, P.P_SEQ_PLAY),
});

// after each part: it plays what was just recorded, then Continue, or Start over
// (clears that pattern and goes back to the start of the part)
const checkpoint = (section, pat, why) => ({
  section, check: { pat }, text: 'Listen to what you made', target: T.btn('PLAY'),
  why: why || 'Happy with it? Press Continue. Want another go? Press Start over.',
  onEnter: (a) => { if (a.seqOn && !sv(a, P.P_SEQ_REC) && sv(a, P.P_SEQ_PATTERN) === pat) a.setSeqPlay(1); },
  done: () => false,
});

// ---------- the lofi lesson
const S1 = '1 · Get ready', S2 = '2 · Chords', S3 = '3 · Bass', S4 = '4 · Kick drum', S5 = '5 · Snare', S6 = '6 · Hi-hats', S7 = '7 · Make it a song', S8 = '8 · Lofi sound';
const CHORDS = [
  { name: 'F major 7', keys: [0, 4, 7, 11], notes: [53, 57, 60, 64] },
  { name: 'E minor 7', keys: [2, 6, 9, 11], notes: [55, 59, 62, 64] },
  { name: 'D minor 7', keys: [0, 4, 7, 9], notes: [53, 57, 60, 62] },
  { name: 'C major 7', keys: [2, 6, 7, 11], notes: [55, 59, 60, 64] },
];
const BASS = [{ key: 12, note: 41 }, { key: 11, note: 40 }, { key: 9, note: 38 }, { key: 7, note: 36 }];

const lofi = {
  title: 'Make a lofi beat',
  blurb: 'Dreamy chords, a deep bass, a lazy drum groove.',
  minutes: 15,
  intro: 'You’ll build a slow, chilled beat one layer at a time: four jazzy chords, a bass line, kick, snare and hi-hats. Then you’ll stack them into a song and make it sound warm and dusty. Each step glows; just do what the box says.',
  async setup(a) {
    if (!a.powered) await a.powerOn();
    if (a.s.arp.on) a.toggleArp();
    a.engine.panic();
    a.engine.seqCmd(9, 0, 0);                      // blank sequencer
    a.s.ui.octave = 0; a.s.ui.transpose = 0;
    // a starting mix so the chords don't drown the drums
    const lv = [65, 100, 100, 90, 70];
    lv.forEach((l, p) => { a.s.parts[p].level = l; a.store.partParam(p, P.PP_LEVEL, l); });
    a.s.ui.curPart = 0;
    a.setMode('HOME'); a.seqView = 'steps'; a.pageIdx = {};
    a.captureSeqSoon();
  },
  steps: [
    // 1 get ready
    { section: S1, text: 'Press SEQ to open the sequencer', target: T.btn('SEQ'), requires: [R.noArp],
      why: 'The sequencer remembers what you play, so you can build a beat one part at a time.',
      done: (a) => a.seqOn && a.mode === 'SEQ' },
    { section: S1, text: 'Turn SELECT to page 2', target: T.knob('SELECT'), requires: [R.seq],
      why: 'SELECT flips between pages. The four boxes on the screen match KNOB1 to KNOB4.',
      done: (a) => (a.pageIdx.SEQ || 0) === 1, hint: 'turn right ↻', quick: true },
    { section: S1, text: 'Turn KNOB4 to slow the tempo down to about 75', target: T.knob('KNOB4'), requires: seqPage(1),
      why: 'Lofi is slow and relaxed. Turn faster to move in bigger jumps.',
      done: (a) => Math.abs(a.s.global.tempo - 75) <= 3, now: (a) => `Tempo ${a.s.global.tempo}`, goal: 'Tempo 72 to 78',
      hint: (a) => turn(a.s.global.tempo, 75) },

    // 2 chords: pattern 1 on voice 1, one chord per bar
    preset(S2, 0, 33, 'Dusty K Sf', 'A soft electric piano: the classic lofi sound.'),
    seqKnob(S2, { page: 1, knob: 2, label: 'Rate', id: P.P_SEQ_RATE, goal: 0, fmt: (x) => RATE[x], extra: [R.pattern(0)],
      why: 'Rate is how long each step lasts. 1/1 means one whole bar, so each chord rings out.' }),
    seqKnob(S2, { page: 0, knob: 4, label: 'Step', id: P.P_SEQ_STEPS, goal: 4, extra: [R.pattern(0)],
      why: 'Four steps, one for each chord. Then it loops.' }),
    { section: S2, text: 'Press REC to start recording', target: T.btn('REC'), requires: [R.seq, R.steps],
      why: 'While REC is on, whatever you play is written into the current step, then it moves to the next one.',
      done: (a) => !!sv(a, P.P_SEQ_REC) },
    ...CHORDS.map((c, i) => rec(S2, 0, i, c.keys, c.notes, 0,
      `Chord ${i + 1}: hold the 4 glowing keys together, then let go`,
      i === 0 ? `This is ${c.name}. Keep all four keys down at once, then lift your hand.` : `${c.name}. Same again: all four, then let go.`)),
    { section: S2, text: 'Press REC to stop recording', target: T.btn('REC'), done: (a) => !sv(a, P.P_SEQ_REC) },
    checkpoint(S2, 0, 'Four chords that slide down step by step. That’s the heart of the song.'),

    // 3 bass: pattern 2 on voice 2
    seqKnob(S3, { page: 0, knob: 1, label: 'Pattern', id: P.P_SEQ_PATTERN, goal: 1, fmt: (x) => x + 1, extra: [R.stopped, R.recOff],
      why: 'Each instrument gets its own pattern. Pattern 2 is for the bass.' }),
    seqKnob(S3, { page: 1, knob: 1, label: 'Voice', id: P.P_SEQ_PART, goal: 1, fmt: (x) => 'V' + (x + 1), extra: [R.pattern(1)],
      why: 'Voice 2 will be the bass. The keys now play this voice.' }),
    preset(S3, 1, 4, 'Round Bass', 'A deep, round bass sound.'),
    seqKnob(S3, { page: 1, knob: 2, label: 'Rate', id: P.P_SEQ_RATE, goal: 0, fmt: (x) => RATE[x], extra: [R.pattern(1)],
      why: 'One long bass note per bar, under each chord.' }),
    seqKnob(S3, { page: 0, knob: 4, label: 'Step', id: P.P_SEQ_STEPS, goal: 4, extra: [R.pattern(1)] }),
    { section: S3, text: 'Press OCT- twice to go down two octaves', target: T.btn('OCTDN'), requires: [R.seq],
      why: 'Bass lives low. Each press drops the keyboard by an octave; the LED blinks to show you’re shifted.',
      done: (a) => a.s.ui.octave === -2 && a.s.ui.transpose === 0, now: (a) => `Octave ${a.s.ui.octave}` },
    { section: S3, text: 'Press REC to start recording', target: T.btn('REC'), requires: [R.seq, R.steps, R.pattern(1)], done: (a) => !!sv(a, P.P_SEQ_REC) },
    ...BASS.map((b, i) => rec(S3, 1, i, [b.key], [b.note], -2, `Bass note ${i + 1}: tap the glowing key`,
      i === 0 ? 'Each bass note is the bottom note of its chord.' : '')),
    { section: S3, text: 'Press REC to stop recording', target: T.btn('REC'), done: (a) => !sv(a, P.P_SEQ_REC) },
    { section: S3, text: 'Press OCT- and OCT+ together to reset the octave', target: [T.btn('OCTDN'), T.btn('OCTUP')],
      why: 'Pressing both at once is a shortcut back to normal.', done: (a) => a.s.ui.octave === 0 && a.s.ui.transpose === 0 },
    checkpoint(S3, 1, 'The bass follows the chords, one deep note each.'),

    // 4 kick: pattern 3 on voice 3, 16 steps of 1/16
    seqKnob(S4, { page: 0, knob: 1, label: 'Pattern', id: P.P_SEQ_PATTERN, goal: 2, fmt: (x) => x + 1, extra: [R.stopped, R.recOff],
      why: 'Pattern 3 is for the kick drum.' }),
    seqKnob(S4, { page: 1, knob: 1, label: 'Voice', id: P.P_SEQ_PART, goal: 2, fmt: (x) => 'V' + (x + 1), extra: [R.pattern(2)] }),
    preset(S4, 2, 25, 'FM Kick', 'The kick is the big “boom”.'),
    seqKnob(S4, { page: 1, knob: 2, label: 'Rate', id: P.P_SEQ_RATE, goal: 6, fmt: (x) => RATE[x], extra: [R.pattern(2)],
      why: 'Drums use small steps: 16 of them make one bar.' }),
    seqKnob(S4, { page: 0, knob: 4, label: 'Step', id: P.P_SEQ_STEPS, goal: 16, extra: [R.pattern(2)] }),
    { section: S4, text: 'Press REC to start recording', target: T.btn('REC'), requires: [R.seq, R.steps, R.pattern(2)], done: (a) => !!sv(a, P.P_SEQ_REC) },
    rec(S4, 2, 0, [0], null, 0, 'Tap the glowing key for a kick on step 1', 'Count “1 e and a 2 e and a…”: the kick lands on 1.'),
    skipTo(S4, 2, 7, 'SEL leaves a step empty. Empty steps are the gaps that make a groove.'),
    rec(S4, 2, 7, [0], null, 0, 'Tap the key again: kick on step 8', ''),
    skipTo(S4, 2, 10, ''),
    rec(S4, 2, 10, [0], null, 0, 'And one more: kick on step 11', 'That off-beat kick gives it the lazy bounce.'),
    { section: S4, text: 'Press REC to stop recording', target: T.btn('REC'), done: (a) => !sv(a, P.P_SEQ_REC) },
    checkpoint(S4, 2, 'Boom … boom-boom. The kick is the heartbeat.'),

    // 5 snare: pattern 4 on voice 4
    seqKnob(S5, { page: 0, knob: 1, label: 'Pattern', id: P.P_SEQ_PATTERN, goal: 3, fmt: (x) => x + 1, extra: [R.stopped, R.recOff] }),
    seqKnob(S5, { page: 1, knob: 1, label: 'Voice', id: P.P_SEQ_PART, goal: 3, fmt: (x) => 'V' + (x + 1), extra: [R.pattern(3)] }),
    preset(S5, 3, 27, 'Noise Snr', 'The snare is the “crack” on beats 2 and 4.'),
    { section: S5, text: 'Press REC to start recording', target: T.btn('REC'), requires: [R.seq, R.steps, R.pattern(3)], done: (a) => !!sv(a, P.P_SEQ_REC) },
    skipTo(S5, 3, 4, 'Leave the first four steps empty.'),
    rec(S5, 3, 4, [7], null, 0, 'Tap the glowing key: snare on step 5', 'Step 5 is beat 2.'),
    skipTo(S5, 3, 12, ''),
    rec(S5, 3, 12, [7], null, 0, 'Snare on step 13', 'Step 13 is beat 4.'),
    { section: S5, text: 'Press REC to stop recording', target: T.btn('REC'), done: (a) => !sv(a, P.P_SEQ_REC) },
    checkpoint(S5, 3, 'The snare answers the kick on beats 2 and 4.'),

    // 6 hats: pattern 5 on voice 5, eighth notes with swing
    seqKnob(S6, { page: 0, knob: 1, label: 'Pattern', id: P.P_SEQ_PATTERN, goal: 4, fmt: (x) => x + 1, extra: [R.stopped, R.recOff] }),
    seqKnob(S6, { page: 1, knob: 1, label: 'Voice', id: P.P_SEQ_PART, goal: 4, fmt: (x) => 'V' + (x + 1), extra: [R.pattern(4)] }),
    preset(S6, 4, 26, 'Metal Hit', 'A metallic tick for the hi-hat.'),
    seqKnob(S6, { page: 1, knob: 2, label: 'Rate', id: P.P_SEQ_RATE, goal: 4, fmt: (x) => RATE[x], extra: [R.pattern(4)],
      why: '1/8 steps: one hi-hat every half beat.' }),
    seqKnob(S6, { page: 0, knob: 4, label: 'Step', id: P.P_SEQ_STEPS, goal: 8, extra: [R.pattern(4)] }),
    { section: S6, text: 'Press REC to start recording', target: T.btn('REC'), requires: [R.seq, R.steps, R.pattern(4)], done: (a) => !!sv(a, P.P_SEQ_REC) },
    { section: S6, text: (a) => { const n = [0, 1, 2, 3, 4, 5, 6, 7].filter((s) => H.stepNotes(a, 4, s).length).length; return n ? `Keep tapping: ${8 - n} to go` : 'Tap the glowing key 8 times'; },
      target: T.key(14), requires: [...seqPage(0), R.pattern(4), R.octave(0), R.recOn],
      onEnter: (a) => { a.engine.set(P.P_SEQ_CURSOR, 0); a.seqVals[P.P_SEQ_CURSOR] = 0; },
      why: 'Steady taps. The sequencer keeps them perfectly in time.',
      done: (a) => [0, 1, 2, 3, 4, 5, 6, 7].every((s) => H.stepNotes(a, 4, s).length) && !a.heldKeys.size,
      now: (a) => `${[0, 1, 2, 3, 4, 5, 6, 7].filter((s) => H.stepNotes(a, 4, s).length).length} of 8` },
    { section: S6, text: 'Press REC to stop recording', target: T.btn('REC'), done: (a) => !sv(a, P.P_SEQ_REC) },
    { ...seqKnob(S6, { page: 2, knob: 1, label: 'Swing', id: P.P_SEQ_SWING, goal: 60, fmt: (x) => x + '%', extra: [R.pattern(4)],
      why: 'Swing makes every second hi-hat a little late. That’s the lazy, head-nodding feel.' }),
    done: (a) => sv(a, P.P_SEQ_SWING) >= 58 && sv(a, P.P_SEQ_SWING) <= 64, goal: 'Swing: 58% to 64%' },
    checkpoint(S6, 4, 'Ticking hi-hats with a lazy swing.'),

    // 7 song: arrangement rows are voices, columns are sections
    { section: S7, text: 'Turn SELECT back to page 1', target: T.knob('SELECT'), requires: [R.seq, R.steps],
      done: (a) => (a.pageIdx.SEQ || 0) === 0, hint: 'turn left ↺', quick: true },
    { section: S7, text: 'Turn KNOB3 (Chain) to open the song view', target: T.knob('KNOB3'), requires: [R.seq, R.page(0)],
      why: 'The song view is a grid. Each row is a voice, each column is a section of the song. Put a pattern in a box to make that voice play.',
      done: (a) => a.seqView === 'arr', hint: 'turn right ↻' },
    cell(S7, 0, 0, 0, 'Column 1 is the intro: just chords and hi-hats.'),
    cell(S7, 4, 0, 4, ''),
    cell(S7, 0, 1, 0, 'Column 2 is the full beat: everything plays.'),
    cell(S7, 1, 1, 1, ''),
    cell(S7, 2, 1, 2, ''),
    cell(S7, 3, 1, 3, ''),
    cell(S7, 4, 1, 4, ''),
    { section: S7, text: 'Turn KNOB2 until the song is 2 columns long', target: T.knob('KNOB2'), requires: [R.seq, R.arr],
      why: 'Only the first two columns play, then it loops.',
      done: (a) => H.arrLen(a) === 2, now: (a) => `Length ${H.arrLen(a)}`, hint: (a) => turn(H.arrLen(a), 2), quick: true },
    { section: S7, text: 'Turn KNOB3 so PLAY uses the song (ARR)', target: T.knob('KNOB3'), requires: [R.seq, R.arr],
      done: (a) => !!sv(a, P.P_SEQ_ARRANGE), now: (a) => (sv(a, P.P_SEQ_ARRANGE) ? 'ARR' : 'PAT'), hint: 'turn right ↻', quick: true },
    playHere(S7, 'Press PLAY/STOP. Here’s your song!', 'The intro plays first, then the full beat comes in.'),

    // 8 lofi sound: effects while it plays
    { section: S8, text: 'Press FX while it plays', target: T.btn('FX'),
      why: 'Effects change the sound of everything at once. Lofi sounds warm and a bit worn out.',
      done: (a) => a.mode === 'FX' },
    fxOn(S8, 0, 'Filter', 'The filter cuts the bright top end, like an old tape.'),
    { section: S8, text: 'Turn KNOB2 to bring the CutOff down to about 1400 Hz', target: T.knob('KNOB2'),
      requires: [R.fx, R.fxSel(0, 'Filter')],
      done: (a) => a.s.fx.params[0][2] >= 45 && a.s.fx.params[0][2] <= 54,
      now: (a) => `CutOff ${a.fxLabels(0)[1][3](a.s.fx.params[0][2])}`, goal: 'about 1200 to 1800 Hz',
      hint: (a) => turn(a.s.fx.params[0][2], 50), why: 'Hear it get darker and softer as you turn.' },
    fxOn(S8, 4, 'Chorus', 'Chorus adds a gentle wobble, like a warped record.'),
    fxOn(S8, 1, 'Reverb', 'Reverb puts it in a room.'),
    { section: S8, final: true,
      text: 'You made a lofi beat!',
      why: 'It’s saved automatically. Things to try next: change a chord’s keys, pick other presets for each voice, move a kick to a different step, or add more columns to the song.',
      done: () => false },
  ],
};

export const LESSONS = [lofi];
