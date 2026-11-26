// Built-in song lessons. These tunes are original, written for Sixop.
const B = 60 / 70; // seconds per beat at 70 BPM
// [beat, length in beats, note]
const EVENING = [
  // melody
  [0, 1.5, 76], [1.5, 0.5, 74], [2, 2, 72],
  [4, 1, 67], [5, 1, 69], [6, 2, 72],
  [8, 1.5, 74], [9.5, 0.5, 76], [10, 1, 74], [11, 1, 72],
  [12, 4, 69],
  [16, 1.5, 76], [17.5, 0.5, 79], [18, 1, 76], [19, 1, 74],
  [20, 1, 72], [21, 1, 74], [22, 2, 76],
  [24, 1, 74], [25, 1, 72], [26, 1, 69], [27, 1, 67],
  [28, 4, 72],
  // one low note per bar: C, A, F, G, C, A, F, C
  [0, 4, 60], [4, 4, 57], [8, 4, 53], [12, 4, 55], [16, 4, 60], [20, 4, 57], [24, 4, 53], [28, 4, 60],
];

export const BUILTIN_SONGS = [
  {
    title: 'Blocky Evening',
    blurb: 'A slow, calm piano tune, like sunset in a block world.',
    bpm: 70,
    voice: 0, // Glass Tine
    notes: EVENING.map(([b, l, n]) => ({ t: b * B, d: l * B * 0.95, n, v: n < 62 ? 70 : 90 })),
  },
];
