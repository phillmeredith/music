// Audio to notes, on the device, with Spotify's Basic Pitch model (Apache-2.0,
// web/vendor). The model and TensorFlow.js load only when first used.
let lib = null;
async function load() {
  if (!lib) lib = await import('../vendor/basic-pitch.mjs');
  return lib;
}

// decode any audio file the browser can play (mp3, m4a, wav, ogg…)
export async function decodeFile(ctx, file) {
  const buf = await file.arrayBuffer();
  return await new Promise((res, rej) => ctx.decodeAudioData(buf, res, (e) => rej(e || new Error('Could not read that audio file'))));
}

// mono 22.05 kHz, as the model expects; optionally just a section
async function resample(buffer, from = 0, to = buffer.duration) {
  const sr = 22050, len = Math.max(1, Math.ceil((to - from) * sr));
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OC(1, len, sr);
  const src = off.createBufferSource();
  src.buffer = buffer; src.connect(off.destination); src.start(0, from, to - from);
  return await off.startRendering();
}

// returns [{t, d, n, v}]; melodyOnly keeps the top note of anything played together
export async function transcribe(buffer, { from = 0, to, melodyOnly = true, onProgress } = {}) {
  const { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } = await load();
  to = Math.min(to || buffer.duration, buffer.duration, from + 300);
  const audio = await resample(buffer, from, to);
  const bp = new BasicPitch(new URL('../vendor/basic-pitch-model/model.json', import.meta.url).href);
  const frames = [], onsets = [], contours = [];
  await bp.evaluateModel(audio, (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, (p) => onProgress && onProgress(p));
  const raw = noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.45, 0.3, 8)));
  let notes = raw.map((x) => ({ t: x.startTimeSeconds, d: x.durationSeconds, n: x.pitchMidi, v: Math.round(40 + 87 * Math.min(1, x.amplitude)) }))
    .filter((x) => x.d >= 0.06)
    .sort((a, b) => a.t - b.t || b.n - a.n);
  if (melodyOnly) {
    const out = [];
    for (const x of notes) {
      const last = out[out.length - 1];
      if (last && x.t - last.t < 0.08) { if (x.n > last.n) out[out.length - 1] = x; continue; }
      out.push(x);
    }
    notes = out;
  }
  return notes;
}
