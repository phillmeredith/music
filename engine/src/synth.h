/* Sixop engine: voices, parts, controllers, effects, arp, sequencer.
 * Clean-room implementation for this project from the FM-1 build and
 * behaviour specs. Only the files in vendor/fm1open are third-party
 * (Apache-2.0). */
#ifndef SIXOP_SYNTH_H
#define SIXOP_SYNTH_H
#include "shim/engine.h"
#include "params.h"
#include "../vendor/fm1open/dx7note.h"
#include "../vendor/fm1open/dx7lfo.h"

#define SX_RATE 44118
#define SX_BLOCK 64
#define SX_PARTS 8
#define SX_MAX_VOICES 20
#define SX_VCED 156
#define SX_OUT_MAX 1024
#define SX_SCOPE 256

typedef struct {
  float a, d, s, r;     /* per-sample increments / sustain level */
  float value, target, smooth;
  int stage;            /* 0 off,1 attack,2 decay,3 sustain,4 release */
} env_overlay;

typedef struct {
  t_dx7note note;
  u8 active, keydown, sustained, stealing;
  u8 part, key, midinote, velocity;
  u32 age;
  int quiet_blocks;
  env_overlay env;
  float ramp, ramp_step;
} sx_voice;

typedef struct {
  u8 vced[SX_VCED];
  t_dx7lfo lfo;
  t_dx7ctrl ctrl;
  t_dx7_mod_cache modcache;
  int on, ch, level, pan, bend_up, bend_dn, glide, fine, mono, transpose;
  int env_on, env_a, env_d, env_s, env_r;
  u8 opmask;            /* engine bit order: bit0 = OP6 */
  u8 held[128];         /* keys currently held (mono stack order) */
  u8 stack[16];
  int stack_n;
  int last_pitch;       /* log-pitch of last mono note, for glide */
  int sustain;
  int expression;       /* 0..127 */
  int lfo_dirty;
  float gl, gr;
} sx_part;

/* sequencer data, laid out for direct save/load from JS */
#define SEQ_PATTERNS 16
#define SEQ_STEPS 64
#define SEQ_NOTES 4
typedef struct {
  u8 note[SEQ_NOTES];   /* 0 = empty */
  u8 vel[SEQ_NOTES];
  u8 len[SEQ_NOTES];    /* in steps, 1 = normal, >1 long note, 0 = tied continuation */
  u8 ratchet;           /* 1..4 */
  u8 pad[3];
} seq_step;             /* 16 bytes */

typedef struct {
  seq_step step[SEQ_STEPS];
  u8 length, part, rate, gate, swing, transpose_plus12, pad[2];
} seq_pattern;          /* 1024 + 8 bytes */

typedef struct {
  seq_pattern pat[SEQ_PATTERNS];
  s8 arrange[8][8];     /* [row=part][col] pattern index or -1 */
  u8 arr_len, pad[7];
} seq_data;

/* status block read by the UI ~60 times a second */
typedef struct {
  u32 frame;            /* engine block counter */
  u8 notes[128];        /* sounding count per MIDI note (any part) */
  u8 keys_led[32];      /* external LED state from effect channel notes 0..26 */
  int seq_step;         /* playing step, -1 when stopped */
  int seq_pattern;
  int seq_queued;
  int arr_col;
  int beat;             /* increments every quarter note while running */
  int sixteenth;        /* increments every 1/16 while running */
  int voices;
  int arp_step;
  int clock_running;
  float peak;
  float scope[SX_SCOPE];
  int ext_tempo_x10;
} sx_status;

void synth_init(int out_rate);
void synth_set(int id, int value);
int synth_get(int id);
void synth_note_on(int part, int note, int vel);
void synth_note_off(int part, int note);
void synth_input_note(int ch, int note, int vel, int from_panel); /* routing incl. arp */
void synth_midi(int status, int d1, int d2);
void synth_panic(void);
void synth_patch_changed(int part, int live);
float *synth_render(int frames);
u8 *synth_vced(int part);
sx_status *synth_status(void);
seq_data *synth_seq(void);
void synth_seq_cmd(int cmd, int a, int b);

/* midi out ring (notes played), 3 bytes per event */
int synth_midiout(u8 *dst, int max);
void synth_midiout_push(int s, int d1, int d2);

/* effects (fx.c) */
void fx_init(void);
void fx_set(int effect, int slot, int value);
int fx_get(int effect, int slot);
void fx_set_order(int pos, int effect);
int fx_get_order(int pos);
void fx_process(float *l, float *r, int n);
void fx_reset(void);

/* arp + sequencer (seqarp.c) */
void seqarp_init(void);
void seqarp_set(int id, int value);
int seqarp_get(int id);
void seqarp_block(int nsamples);    /* advance clocks; emits notes */
void arp_note(int note, int vel, int on);
int arp_active(void);
void seq_record_note(int note, int vel, int on);
int seq_panel_part(void);
void seq_cmd(int cmd, int a, int b);
void seqarp_clock_tick(void);       /* MIDI clock F8 */
void seqarp_transport(int start);   /* FA/FB start=1, FC stop=0 */
extern seq_data g_seq;
extern sx_status g_status;
int sx_route_part(void);            /* part the arp plays */

#endif
