/* Sixop parameter IDs shared by the engine and the web app.
 * tools/gen-params.mjs turns this file into web/js/params.js, so keep the
 * "NAME = value," layout. */
#ifndef SIXOP_PARAMS_H
#define SIXOP_PARAMS_H

enum {
  /* global */
  P_MASTER = 0,        /* 0..100 */
  P_HW_CHAR = 1,       /* 0/1 hardware character stage */
  P_QUANT16 = 2,       /* 0/1 16-bit quantise before FX */
  P_DRIVE = 3,         /* 0/1 "Drive -6" */
  P_GLIDE_MODE = 4,    /* 0 full time, 1 fingered */
  P_MIDI_CH = 5,       /* 0 = ALL, 1..16 (panel and MIDI notes) */
  P_FX_CH = 6,         /* 1..16 effect channel */
  P_POLY = 7,          /* voice pool size 1..20 */
  P_EXT_CC7 = 8,       /* 0/1 CC7 sets master */
  P_TEMPO = 9,         /* 30..300 BPM */
  P_DETUNE_MODE = 10,  /* 0 V16/Dexed curve (vendor default), reserved */
  P_SCOPE_PART = 11,

  /* arpeggiator */
  P_ARP_ON = 20,
  P_ARP_MODE = 21,     /* 0 Up 1 Down 2 Inclusive 3 Exclusive 4 Random 5 Order 6 Repeat */
  P_ARP_OCT = 22,      /* 1..4 */
  P_ARP_RATE = 23,     /* index into rate table */
  P_ARP_GATE = 24,     /* 20..100 % */
  P_ARP_SWING = 25,    /* 50..75 % */
  P_ARP_LATCH = 26,
  P_ARP_SYNC = 27,

  /* sequencer */
  P_SEQ_ON = 30,       /* sequencer mode engaged */
  P_SEQ_PLAY = 31,     /* transport running */
  P_SEQ_REC = 32,
  P_SEQ_PATTERN = 33,  /* 0..15 (queued at end of cycle while playing) */
  P_SEQ_STEPS = 34,    /* 1..64 for the current pattern */
  P_SEQ_PART = 35,     /* part the current pattern plays, 0..7 */
  P_SEQ_RATE = 36,     /* rate index for the current pattern */
  P_SEQ_GATE = 37,     /* 10..100 % */
  P_SEQ_SWING = 38,    /* 50..75 */
  P_SEQ_SYNC = 39,
  P_SEQ_TRANSPOSE = 40,/* -12..12 */
  P_SEQ_CURSOR = 41,   /* selected step 0..63 */
  P_SEQ_ARRANGE = 42,  /* 0 pattern mode, 1 arrangement playback */
  P_SEQ_ARR_LEN = 43,  /* 1..8 columns */

  /* effects: base + effect*8 + slot. effect order: filter reverb delay dist chorus phaser */
  P_FX_BASE = 100,     /* +0 on, +1 p1, +2 p2, +3 p3 */
  P_FX_ORDER = 150,    /* +0..5: effect index in chain position */

  /* parts: base + part*32 + k */
  P_PART_BASE = 200,
  PP_ON = 0,
  PP_CH = 1,           /* 0 = ALL, 1..16 */
  PP_LEVEL = 2,        /* 0..100 */
  PP_PAN = 3,          /* 0..100, 50 centre */
  PP_BEND_UP = 4,      /* 1..24 */
  PP_BEND_DN = 5,      /* 1..24 */
  PP_GLIDE = 6,        /* 0..100 (x10 ms) */
  PP_FINE = 7,         /* -100..100 cents */
  PP_MONO = 8,
  PP_ENV_ON = 9,
  PP_ENV_A = 10,       /* 0..100 */
  PP_ENV_D = 11,
  PP_ENV_S = 12,
  PP_ENV_R = 13,
  PP_OPMASK = 14,      /* bit n = OPn+1 audible (UI numbering) */
  PP_TRANSPOSE = 15,   /* -24..24 extra semitones (Oct/transpose) */
  PP_COUNT = 32,

  P_COUNT = 200 + 8 * 32
};

#endif
