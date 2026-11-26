/* Sixop engine core: voice allocation, parts, controllers, ENV overlay, glide,
 * output stage and resampler. Clean-room code written for this project from
 * the FM-1 build spec; the DX7 operator, envelope, LFO and note maths come
 * from vendor/fm1open (Apache-2.0). */
#include "synth.h"
#include "fm_math.h"
#include "../vendor/fm1open/dx7pitchenv.h"

static sx_voice voices[SX_MAX_VOICES];
static sx_part parts[SX_PARTS];
sx_status g_status;

static int poly = SX_MAX_VOICES;
static u32 age_counter = 1;
static int master = 100, hw_char = 1, quant16 = 1, drive = 0, glide_mode = 0;
static int midi_ch = 0, fx_ch = 1, ext_cc7 = 1, tempo = 120, scope_part = -1;
static int out_boost = 2; /* 0,+6,+12,+18 dB after the FM-1 chain */

/* ---------- small helpers ---------- */
static inline float clampf(float x, float lo, float hi) { return x < lo ? lo : (x > hi ? hi : x); }
static inline int clampi(int x, int lo, int hi) { return x < lo ? lo : (x > hi ? hi : x); }

void *memcpy(void *dst, const void *src, size_t n)
{
  u8 *d = (u8 *)dst; const u8 *s = (const u8 *)src;
  while (n--) *d++ = *s++;
  return dst;
}
void *memset(void *dst, int c, size_t n)
{
  u8 *d = (u8 *)dst;
  while (n--) *d++ = (u8)c;
  return dst;
}
int abs(int x) { return x < 0 ? -x : x; }

/* ---------- MIDI out ring ---------- */
static u8 mo_buf[3 * 256];
static int mo_w, mo_r;
void synth_midiout_push(int s, int d1, int d2)
{
  int n = (mo_w + 1) & 255;
  if (n == mo_r) return;
  mo_buf[mo_w * 3] = (u8)s; mo_buf[mo_w * 3 + 1] = (u8)d1; mo_buf[mo_w * 3 + 2] = (u8)d2;
  mo_w = n;
}
int synth_midiout(u8 *dst, int max)
{
  int c = 0;
  while (mo_r != mo_w && c < max) {
    dst[c * 3] = mo_buf[mo_r * 3]; dst[c * 3 + 1] = mo_buf[mo_r * 3 + 1]; dst[c * 3 + 2] = mo_buf[mo_r * 3 + 2];
    mo_r = (mo_r + 1) & 255; c++;
  }
  return c;
}

/* ---------- init voice (DX7 VCED) ---------- */
static void init_vced(u8 *v)
{
  memset(v, 0, SX_VCED);
  for (int op = 0; op < 6; op++) {
    u8 *o = v + op * 21;
    o[0] = o[1] = o[2] = o[3] = 99;      /* rates */
    o[4] = o[5] = o[6] = 99; o[7] = 0;   /* levels */
    o[8] = 39;                            /* break point C3 */
    o[11] = 0; o[12] = 3;                 /* -LIN / +LIN curves (DX7 init) */
    o[16] = op == 5 ? 99 : 0;             /* OP1 (last in memory) carrier */
    o[17] = 0; o[18] = 1; o[19] = 0; o[20] = 7;
  }
  for (int i = 0; i < 4; i++) { v[126 + i] = 99; v[130 + i] = 50; }
  v[134] = 0; v[135] = 0; v[136] = 1;
  v[137] = 35; v[138] = 0; v[139] = 0; v[140] = 0; v[141] = 1; v[142] = 0; v[143] = 3;
  v[144] = 24;
  const char *nm = "INIT VOICE";
  for (int i = 0; i < 10; i++) v[145 + i] = (u8)nm[i];
}

/* ---------- controllers ---------- */
static void ctrl_refresh(sx_part *p)
{
  t_dx7ctrl *c = &p->ctrl;
  int pm = 0, am = 0, em = 0, eg_any = 0;
  ctrl_mod *src[4] = { &c->wheel, &c->foot, &c->breath, &c->aftertouch };
  int val[4] = { c->modwheel_cc, c->foot_cc, c->breath_cc, c->aftertouch_cc };
  for (int i = 0; i < 4; i++) {
    int total = val[i] * src[i]->range / 99;
    if (src[i]->pitchswitch && total > pm) pm = total;
    if (src[i]->ampswitch && total > am) am = total;
    if (src[i]->egswitch) { eg_any = 1; if (total > em) em = total; }
  }
  c->pitch_mod = (u8)clampi(pm, 0, 127);
  c->amp_mod = (u8)clampi(am, 0, 127);
  c->eg_mod = eg_any ? (u8)clampi(em, 0, 127) : 127;
}

static void part_defaults(sx_part *p, int idx)
{
  memset(p, 0, sizeof(*p));
  init_vced(p->vced);
  p->on = idx == 0;
  p->ch = 0; p->level = 100; p->pan = 50; p->bend_up = 12; p->bend_dn = 12;
  p->glide = 0; p->fine = 0; p->mono = 0; p->transpose = 0;
  p->env_on = 0; p->env_a = 0; p->env_d = 50; p->env_s = 100; p->env_r = 20;
  p->opmask = 0x3F; p->expression = 127;
  p->ctrl.pitchbend = 0x2000;
  p->ctrl.pitchrangeup = 12; p->ctrl.pitchrangedn = 12; p->ctrl.pitchrange = 12;
  p->ctrl.opswitch = 0x3F;
  p->ctrl.wheel.range = 99; p->ctrl.wheel.pitchswitch = true;
  p->ctrl.aftertouch.range = 99; p->ctrl.aftertouch.pitchswitch = true; /* stock: strong vibrato */
  p->ctrl.breath.range = 0; p->ctrl.foot.range = 0;
  p->ctrl.breath_cc = 127; p->ctrl.foot_cc = 127;
  ctrl_refresh(p);
  dx7lfo_reset(&p->lfo, p->vced + 137, SX_RATE, SX_BLOCK);
  p->gl = p->gr = 1.0f;
}

static void part_gains(sx_part *p)
{
  float lev = p->level / 100.0f;
  lev = lev * lev;
  float ex = p->expression / 127.0f;
  float pan = p->pan / 100.0f;
  float l = 2.0f * (1.0f - pan), r = 2.0f * pan;
  p->gl = lev * ex * (l > 1.0f ? 1.0f : l);
  p->gr = lev * ex * (r > 1.0f ? 1.0f : r);
}

/* ---------- ENV overlay (FM-1 ENV page), times from the spec ---------- */
static void env_start(sx_voice *v, sx_part *p)
{
  env_overlay *e = &v->env;
  float blocks_per_ms = SX_RATE / 1000.0f / SX_BLOCK;
  float at = 8.0f * p->env_a, dt = 100.0f + 8.0f * p->env_d;
  e->s = (100.0f + 7.0f * p->env_s) / 1000.0f;
  e->a = at <= 0 ? 1.0f : 1.0f / (at * blocks_per_ms);
  e->d = (1.0f - e->s) / (dt * blocks_per_ms);
  e->r = 1.0f / ((100.0f + 19.0f * p->env_r) * blocks_per_ms); /* per block, scaled by level at release */
  e->stage = 1;
  e->target = 0.0f;
  e->value = 0.0f;
  e->smooth = 0.0f;
}
static void env_release(sx_voice *v)
{
  env_overlay *e = &v->env;
  if (e->stage == 0 || e->stage == 4) return;
  e->r = e->r * (e->target > 0.001f ? e->target : 0.001f);
  e->stage = 4;
}
/* advance one block; returns the smoothed multiplier */
static float env_block(env_overlay *e)
{
  switch (e->stage) {
  case 1: e->target += e->a; if (e->target >= 1.0f) { e->target = 1.0f; e->stage = 2; } break;
  case 2: e->target -= e->d; if (e->target <= e->s) { e->target = e->s; e->stage = 3; } break;
  case 3: e->target = e->s; break;
  case 4: e->target -= e->r; if (e->target <= 0) { e->target = 0; } break;
  default: break;
  }
  float k = e->stage == 1 ? 0.5f : (e->stage == 4 ? 0.125f : 0.35f);
  e->smooth += (e->target - e->smooth) * k;
  return e->smooth;
}

/* ---------- voices ---------- */
static int engine_note(sx_part *p, int key)
{
  int n = key + p->transpose + (int)p->vced[144] - 24;
  return n;
}

static int alloc_voice(void)
{
  int best = -1; u32 best_age = 0xFFFFFFFF;
  for (int i = 0; i < poly; i++)
    if (!voices[i].active) return i;
  /* steal: oldest released first, then oldest held */
  for (int i = 0; i < poly; i++)
    if (!voices[i].keydown && !voices[i].sustained && voices[i].age < best_age) { best = i; best_age = voices[i].age; }
  if (best >= 0) return best;
  for (int i = 0; i < poly; i++)
    if (voices[i].age < best_age) { best = i; best_age = voices[i].age; }
  return best;
}

static void voice_start(sx_voice *v, int part, int key, int vel, int glide_from, int legato)
{
  sx_part *p = &parts[part];
  int mn = engine_note(p, key);
  if (mn < 0 || mn > 127) return;
  int ev = (vel * 100) >> 7;
  int cents = p->fine;
  if (legato && v->active) {
    t_dx7note old = v->note;
    dx7note_init(&v->note, p->vced, (u8)mn, (u8)ev, cents);
    dx7note_transfer_state(&v->note, &old);
    v->note.fb_buf[0] = old.fb_buf[0]; v->note.fb_buf[1] = old.fb_buf[1];
  } else {
    dx7note_init(&v->note, p->vced, (u8)mn, (u8)ev, cents);
    v->note.fb_buf[0] = v->note.fb_buf[1] = 0;
    if (p->vced[136]) dx7note_oscsync(&v->note);
    for (int op = 0; op < 6; op++) v->note.params[op].gaindst = 0;
    v->ramp = 0.0f; v->ramp_step = 1.0f / (0.010f * SX_RATE / SX_BLOCK); /* ~10 ms fade in */
    v->quiet_blocks = 0;
    if (p->env_on) env_start(v, p); else v->env.stage = 0;
  }
  int newpitch = (mn << 24) / 12;
  if (glide_from != 0x7FFFFFFF && p->glide > 0) {
    int offset = glide_from - newpitch;
    int blocks = (int)(p->glide * 10.0f * SX_RATE / 1000.0f / SX_BLOCK);
    if (blocks < 1) blocks = 1;
    int step = abs(offset) / blocks;
    if (step < 1) step = 1;
    dx7note_setglide(&v->note, offset, step);
  } else {
    dx7note_setglide(&v->note, 0, 0);
  }
  p->last_pitch = newpitch;
  v->active = 1; v->keydown = 1; v->sustained = 0; v->stealing = 0;
  v->part = (u8)part; v->key = (u8)key; v->midinote = (u8)mn; v->velocity = (u8)vel;
  v->age = age_counter++;
}

/* pending note-ons wait one block while a stolen voice fades out */
typedef struct { u8 used, part, key, vel; int glide_from; } pending_t;
static pending_t pending[SX_MAX_VOICES];

static int current_pitch(sx_voice *v)
{
  return ((int)v->midinote << 24) / 12 + v->note.glide_offset;
}

void synth_note_on(int part, int key, int vel)
{
  if (part < 0 || part >= SX_PARTS) return;
  sx_part *p = &parts[part];
  if (!p->on || key < 0 || key > 127) return;
  if (vel <= 0) { synth_note_off(part, key); return; }
  dx7lfo_keydown(&p->lfo);
  g_status.notes[key]++;
  if (p->mono) {
    /* last-note priority stack */
    int found = -1;
    for (int i = 0; i < p->stack_n; i++) if (p->stack[i] == key) found = i;
    if (found >= 0) { for (int i = found; i < p->stack_n - 1; i++) p->stack[i] = p->stack[i + 1]; p->stack_n--; }
    if (p->stack_n < 16) p->stack[p->stack_n++] = (u8)key;
    sx_voice *v = 0; int vi = -1;
    for (int i = 0; i < poly; i++) if (voices[i].active && voices[i].part == part) { v = &voices[i]; vi = i; break; }
    int legato = v && v->keydown;
    int gfrom = 0x7FFFFFFF;
    if (v && p->glide > 0 && (glide_mode == 0 || legato)) gfrom = current_pitch(v);
    else if (!v && p->glide > 0 && glide_mode == 0 && p->last_pitch) gfrom = p->last_pitch;
    if (v && legato) { voice_start(v, part, key, vel, gfrom, 1); return; }
    if (v) { /* released voice still ringing: retrigger with a short fade */
      v->stealing = 1; pending[vi].used = 1; pending[vi].part = (u8)part; pending[vi].key = (u8)key;
      pending[vi].vel = (u8)vel; pending[vi].glide_from = gfrom; return;
    }
    int i = alloc_voice();
    if (i < 0) return;
    if (voices[i].active) {
      voices[i].stealing = 1; pending[i].used = 1; pending[i].part = (u8)part; pending[i].key = (u8)key;
      pending[i].vel = (u8)vel; pending[i].glide_from = gfrom; return;
    }
    voice_start(&voices[i], part, key, vel, gfrom, 0);
    return;
  }
  int i = alloc_voice();
  if (i < 0) return;
  if (voices[i].active) {
    if (voices[i].keydown && voices[i].key < 128 && g_status.notes[voices[i].key]) g_status.notes[voices[i].key]--;
    voices[i].stealing = 1; voices[i].keydown = 0;
    pending[i].used = 1; pending[i].part = (u8)part; pending[i].key = (u8)key; pending[i].vel = (u8)vel;
    pending[i].glide_from = 0x7FFFFFFF;
    return;
  }
  voice_start(&voices[i], part, key, vel, 0x7FFFFFFF, 0);
}

static void voice_release(sx_voice *v)
{
  dx7note_keyup(&v->note);
  env_release(v);
  v->keydown = 0;
  v->sustained = 0;
}

void synth_note_off(int part, int key)
{
  if (part < 0 || part >= SX_PARTS || key < 0 || key > 127) return;
  sx_part *p = &parts[part];
  if (g_status.notes[key]) g_status.notes[key]--;
  for (int i = 0; i < SX_MAX_VOICES; i++)
    if (pending[i].used && pending[i].part == part && pending[i].key == key) pending[i].used = 0;
  if (p->mono) {
    int found = -1;
    for (int i = 0; i < p->stack_n; i++) if (p->stack[i] == key) found = i;
    if (found < 0) return;
    int was_top = found == p->stack_n - 1;
    for (int i = found; i < p->stack_n - 1; i++) p->stack[i] = p->stack[i + 1];
    p->stack_n--;
    sx_voice *v = 0;
    for (int i = 0; i < poly; i++) if (voices[i].active && voices[i].part == part && voices[i].keydown) { v = &voices[i]; break; }
    if (!v || !was_top) return;
    if (p->stack_n > 0) {
      int back = p->stack[p->stack_n - 1];
      int gfrom = p->glide > 0 ? current_pitch(v) : 0x7FFFFFFF;
      voice_start(v, part, back, v->velocity, gfrom, 1);
    } else if (p->sustain) {
      v->sustained = 1;
    } else {
      voice_release(v);
    }
    return;
  }
  for (int i = 0; i < SX_MAX_VOICES; i++) {
    sx_voice *v = &voices[i];
    if (v->active && v->keydown && v->part == part && v->key == key && !v->stealing) {
      if (p->sustain) { v->sustained = 1; v->keydown = 0; }
      else voice_release(v);
    }
  }
}

static void part_sustain(int part, int on)
{
  sx_part *p = &parts[part];
  p->sustain = on;
  if (!on)
    for (int i = 0; i < SX_MAX_VOICES; i++)
      if (voices[i].active && voices[i].part == part && voices[i].sustained) voice_release(&voices[i]);
}

void synth_panic(void)
{
  for (int i = 0; i < SX_MAX_VOICES; i++) { voices[i].active = 0; voices[i].keydown = 0; pending[i].used = 0; }
  for (int p = 0; p < SX_PARTS; p++) { parts[p].stack_n = 0; parts[p].sustain = 0; }
  memset(g_status.notes, 0, sizeof(g_status.notes));
}

/* ---------- routing: panel/MIDI notes to parts (arp and seq record in between) ---------- */
static int part_listens(int pi, int ch, int from_panel)
{
  sx_part *p = &parts[pi];
  if (from_panel) { int sp = seq_panel_part(); if (sp >= 0) return pi == sp; }
  if (!p->on) return 0;
  if (from_panel) ch = midi_ch == 0 ? 1 : midi_ch;
  if (midi_ch != 0 && !from_panel && ch != midi_ch && p->ch == 0) return 0;
  return p->ch == 0 || p->ch == ch;
}

static int arp_ch = 1;
void synth_route_note(int ch, int note, int vel, int from_panel)
{
  for (int pi = 0; pi < SX_PARTS; pi++)
    if (part_listens(pi, ch, from_panel)) {
      if (vel > 0) synth_note_on(pi, note, vel); else synth_note_off(pi, note);
    }
}
static int arp_from_panel = 1;
int sx_route_part(void) { return arp_ch | (arp_from_panel << 8); }

void synth_input_note(int ch, int note, int vel, int from_panel)
{
  seq_record_note(note, vel, vel > 0);
  if (arp_active()) {
    arp_ch = ch; arp_from_panel = from_panel;
    arp_note(note, vel, vel > 0);
    return;
  }
  if (vel > 0) synth_midiout_push(0x90, note, vel);
  else synth_midiout_push(0x80, note, 64);
  synth_route_note(ch, note, vel, from_panel);
}

/* ---------- MIDI in (short messages; SysEx is handled in JS) ---------- */
static void fx_cc(int cc, int val)
{
  int blk = (cc - 70) / 4, k = (cc - 70) % 4;
  if (blk < 0 || blk > 5) return;
  if (k == 0) { fx_set(blk, 0, val != 0); return; }
  int typed = (blk == 0 || blk == 1) && k == 1; /* filter / reverb type */
  int v = typed ? clampi(val, 0, 2) : (val * 100 + 64) >> 7;
  if (blk == 0 && k == 2) v = (val * 107 + 64) >> 7; /* cutoff runs to 107 */
  fx_set(blk, k, v);
}

void synth_midi(int status, int d1, int d2)
{
  int type = status & 0xF0, ch = (status & 15) + 1;
  if (type == 0x90 || type == 0x80) {
    int vel = type == 0x80 ? 0 : d2;
    if (ch == fx_ch && d1 <= 26) { g_status.keys_led[d1] = vel > 0; return; }
    synth_input_note(ch, d1, vel, 0);
    return;
  }
  if (type == 0xB0 && ch == fx_ch && d1 >= 70 && d1 <= 93) { fx_cc(d1, d2); return; }
  for (int pi = 0; pi < SX_PARTS; pi++) {
    sx_part *p = &parts[pi];
    if (!(p->ch == 0 || p->ch == ch)) continue;
    if (midi_ch != 0 && p->ch == 0 && ch != midi_ch) continue;
    switch (type) {
    case 0xB0:
      switch (d1) {
      case 1: p->ctrl.modwheel_cc = d2; ctrl_refresh(p); break;
      case 2: p->ctrl.breath_cc = d2; ctrl_refresh(p); break;
      case 4: p->ctrl.foot_cc = d2; ctrl_refresh(p); break;
      case 7: if (ext_cc7) master = (d2 * 100 + 64) >> 7; break;
      case 11: p->expression = d2; part_gains(p); break;
      case 64: part_sustain(pi, d2 >= 64); break;
      case 120: case 123: synth_panic(); break;
      case 121: p->expression = 127; part_gains(p); break;
      default: break;
      }
      break;
    case 0xD0: p->ctrl.aftertouch_cc = d1; ctrl_refresh(p); break;
    case 0xE0: p->ctrl.pitchbend = (s16)(d1 | (d2 << 7)); break;
    default: break;
    }
  }
}

/* ---------- parameters ---------- */
static void part_set(int pi, int k, int v)
{
  sx_part *p = &parts[pi];
  switch (k) {
  case PP_ON: p->on = v != 0;
    if (!p->on) for (int i = 0; i < SX_MAX_VOICES; i++) if (voices[i].active && voices[i].part == pi) voice_release(&voices[i]);
    break;
  case PP_CH: p->ch = clampi(v, 0, 16); break;
  case PP_LEVEL: p->level = clampi(v, 0, 100); part_gains(p); break;
  case PP_PAN: p->pan = clampi(v, 0, 100); part_gains(p); break;
  case PP_BEND_UP: p->bend_up = clampi(v, 0, 24); p->ctrl.pitchrangeup = (u8)p->bend_up; break;
  case PP_BEND_DN: p->bend_dn = clampi(v, 0, 24); p->ctrl.pitchrangedn = (u8)p->bend_dn; break;
  case PP_GLIDE: p->glide = clampi(v, 0, 100); break;
  case PP_FINE: p->fine = clampi(v, -100, 100); break;
  case PP_MONO: p->mono = v != 0; p->stack_n = 0; break;
  case PP_ENV_ON: p->env_on = v != 0; break;
  case PP_ENV_A: p->env_a = clampi(v, 0, 100); break;
  case PP_ENV_D: p->env_d = clampi(v, 0, 100); break;
  case PP_ENV_S: p->env_s = clampi(v, 0, 100); break;
  case PP_ENV_R: p->env_r = clampi(v, 0, 100); break;
  case PP_OPMASK: {
    u8 m = 0; /* UI bit n = OP(n+1); engine bit0 = OP6 */
    for (int n = 0; n < 6; n++) if (v & (1 << n)) m |= (u8)(1 << (5 - n));
    p->opmask = m; p->ctrl.opswitch = m; break;
  }
  case PP_TRANSPOSE: p->transpose = clampi(v, -48, 48); break;
  default: break;
  }
}
static int part_get(int pi, int k)
{
  sx_part *p = &parts[pi];
  switch (k) {
  case PP_ON: return p->on; case PP_CH: return p->ch; case PP_LEVEL: return p->level;
  case PP_PAN: return p->pan; case PP_BEND_UP: return p->bend_up; case PP_BEND_DN: return p->bend_dn;
  case PP_GLIDE: return p->glide; case PP_FINE: return p->fine; case PP_MONO: return p->mono;
  case PP_ENV_ON: return p->env_on; case PP_ENV_A: return p->env_a; case PP_ENV_D: return p->env_d;
  case PP_ENV_S: return p->env_s; case PP_ENV_R: return p->env_r;
  case PP_OPMASK: { int m = 0; for (int n = 0; n < 6; n++) if (p->opmask & (1 << (5 - n))) m |= 1 << n; return m; }
  case PP_TRANSPOSE: return p->transpose;
  default: return 0;
  }
}

void synth_set(int id, int v)
{
  if (id >= P_PART_BASE && id < P_COUNT) { part_set((id - P_PART_BASE) / PP_COUNT, (id - P_PART_BASE) % PP_COUNT, v); return; }
  if (id >= P_FX_ORDER && id < P_FX_ORDER + 6) { fx_set_order(id - P_FX_ORDER, v); return; }
  if (id >= P_FX_BASE && id < P_FX_BASE + 48) { fx_set((id - P_FX_BASE) / 8, (id - P_FX_BASE) % 8, v); return; }
  if (id >= P_ARP_ON && id <= P_SEQ_ARR_LEN) { seqarp_set(id, v); return; }
  switch (id) {
  case P_MASTER: master = clampi(v, 0, 100); break;
  case P_HW_CHAR: hw_char = v != 0; break;
  case P_QUANT16: quant16 = v != 0; break;
  case P_DRIVE: drive = v != 0; break;
  case P_GLIDE_MODE: glide_mode = v != 0; break;
  case P_MIDI_CH: midi_ch = clampi(v, 0, 16); break;
  case P_FX_CH: fx_ch = clampi(v, 1, 16); break;
  case P_POLY: synth_panic(); poly = clampi(v, 1, SX_MAX_VOICES); break;
  case P_EXT_CC7: ext_cc7 = v != 0; break;
  case P_TEMPO: tempo = clampi(v, 30, 300); seqarp_set(P_TEMPO, tempo); break;
  case P_SCOPE_PART: scope_part = v; break;
  case P_DETUNE_MODE: out_boost = clampi(v, 0, 3); break; /* reused as output boost */
  default: break;
  }
}
int synth_get(int id)
{
  if (id >= P_PART_BASE && id < P_COUNT) return part_get((id - P_PART_BASE) / PP_COUNT, (id - P_PART_BASE) % PP_COUNT);
  if (id >= P_FX_ORDER && id < P_FX_ORDER + 6) return fx_get_order(id - P_FX_ORDER);
  if (id >= P_FX_BASE && id < P_FX_BASE + 48) return fx_get((id - P_FX_BASE) / 8, (id - P_FX_BASE) % 8);
  if (id >= P_ARP_ON && id <= P_SEQ_ARR_LEN) return seqarp_get(id);
  switch (id) {
  case P_MASTER: return master; case P_HW_CHAR: return hw_char; case P_QUANT16: return quant16;
  case P_DRIVE: return drive; case P_GLIDE_MODE: return glide_mode; case P_MIDI_CH: return midi_ch;
  case P_FX_CH: return fx_ch; case P_POLY: return poly; case P_EXT_CC7: return ext_cc7;
  case P_TEMPO: return tempo; case P_SCOPE_PART: return scope_part; case P_DETUNE_MODE: return out_boost;
  default: return 0;
  }
}

u8 *synth_vced(int part) { return parts[part & 7].vced; }

void synth_patch_changed(int part, int live)
{
  sx_part *p = &parts[part & 7];
  dx7lfo_reset(&p->lfo, p->vced + 137, SX_RATE, SX_BLOCK);
  for (int i = 0; i < SX_MAX_VOICES; i++) {
    sx_voice *v = &voices[i];
    if (!v->active || v->part != (part & 7)) continue;
    if (live) {
      int mn = engine_note(p, v->key);
      if (mn < 0 || mn > 127) continue;
      v->midinote = (u8)mn;
      dx7note_update(&v->note, p->vced, (u8)mn, (u8)((v->velocity * 100) >> 7), p->fine);
    } else {
      voice_release(v);
    }
  }
}

/* ---------- output stage ---------- */
typedef struct { float b0, b1, b2, a1, a2, z1, z2; } biquad;
static biquad shelf_l, shelf_r;
static inline float bq(biquad *f, float x)
{
  float y = f->b0 * x + f->z1;
  f->z1 = f->b1 * x - f->a1 * y + f->z2;
  f->z2 = f->b2 * x - f->a2 * y;
  return y;
}
static void make_high_shelf(biquad *f, float fs, float f0, float gain_db)
{
  /* RBJ high shelf, S = 0.7 */
  const double PI = 3.14159265358979323846;
  double A = fm_exp2d(gain_db / 40.0 * 3.32192809488736234787);
  double w0 = 2 * PI * f0 / fs;
  double cw = fm_sind(w0 + PI / 2), sw = fm_sind(w0);
  double S = 0.7;
  double alpha = sw / 2 * __builtin_sqrt((A + 1 / A) * (1 / S - 1) + 2);
  double sa = 2 * __builtin_sqrt(A) * alpha;
  double b0 = A * ((A + 1) + (A - 1) * cw + sa);
  double b1 = -2 * A * ((A - 1) + (A + 1) * cw);
  double b2 = A * ((A + 1) + (A - 1) * cw - sa);
  double a0 = (A + 1) - (A - 1) * cw + sa;
  double a1 = 2 * ((A - 1) - (A + 1) * cw);
  double a2 = (A + 1) - (A - 1) * cw - sa;
  f->b0 = (float)(b0 / a0); f->b1 = (float)(b1 / a0); f->b2 = (float)(b2 / a0);
  f->a1 = (float)(a1 / a0); f->a2 = (float)(a2 / a0); f->z1 = f->z2 = 0;
}

/* ---------- block render at 44,118 Hz ---------- */
static int vbuf[SX_BLOCK], scratch[SX_BLOCK * 2];
static float blk_l[SX_BLOCK], blk_r[SX_BLOCK];
static float scope_hist[1024];
static int scope_w;
/* overall gain: voice out (Q24 >> 4) to float, calibrated so the Init Voice at
 * full level peaks near -26 dBFS as measured on stock firmware */
#define VOICE_SCALE (1.0f / 8388608.0f * 0.74f)

static void render_block(void)
{
  for (int j = 0; j < SX_BLOCK; j++) blk_l[j] = blk_r[j] = 0.0f;
  int lfo_val[SX_PARTS], lfo_delay[SX_PARTS];
  for (int pi = 0; pi < SX_PARTS; pi++) {
    lfo_val[pi] = dx7lfo_getsample(&parts[pi].lfo);
    lfo_delay[pi] = dx7lfo_getdelay(&parts[pi].lfo);
  }
  int active = 0;
  for (int i = 0; i < SX_MAX_VOICES; i++) {
    sx_voice *v = &voices[i];
    if (!v->active) {
      if (pending[i].used) {
        pending[i].used = 0;
        voice_start(v, pending[i].part, pending[i].key, pending[i].vel, pending[i].glide_from, 0);
      }
      if (!v->active) continue;
    }
    active++;
    sx_part *p = &parts[v->part];
    dx7note_compute_64(&v->note, vbuf, scratch, lfo_val[v->part], lfo_delay[v->part], &p->ctrl, &p->modcache);
    float e0 = 1.0f, e1 = 1.0f;
    if (v->env.stage) { e0 = v->env.smooth; e1 = env_block(&v->env); }
    float r0 = v->ramp, r1;
    if (v->stealing) { r1 = 0.0f; }
    else { r1 = v->ramp + v->ramp_step; if (r1 > 1.0f) r1 = 1.0f; }
    v->ramp = r1;
    float g0 = e0 * r0, g1 = e1 * r1, dg = (g1 - g0) * (1.0f / SX_BLOCK), g = g0;
    float gl = p->gl * VOICE_SCALE, gr = p->gr * VOICE_SCALE;
    int peak = 0;
    for (int j = 0; j < SX_BLOCK; j++) {
      int s = vbuf[j] >> 4;
      int a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      g += dg;
      float f = (float)s * g;
      blk_l[j] += f * gl;
      blk_r[j] += f * gr;
    }
    if (v->stealing) {
      v->active = 0; v->stealing = 0;
      if (pending[i].used) {
        pending[i].used = 0;
        voice_start(v, pending[i].part, pending[i].key, pending[i].vel, pending[i].glide_from, 0);
      }
      continue;
    }
    if (!v->keydown && !v->sustained) {
      int done = 1;
      for (int op = 0; op < 6; op++) if (v->note.env[op].ix < 4) { done = 0; break; }
      if (v->env.stage == 4 && v->env.smooth < 0.0005f) done = 1;
      if (peak * (v->env.stage ? v->env.smooth : 1.0f) < 48) { if (++v->quiet_blocks > 64) done = 1; }
      else v->quiet_blocks = 0;
      if (done && peak * (v->env.stage ? v->env.smooth : 1.0f) < 4096) v->active = 0;
    }
  }
  g_status.voices = active;

  if (quant16) {
    for (int j = 0; j < SX_BLOCK; j++) {
      float l = clampf(blk_l[j], -1.0f, 0.99997f) * 32768.0f;
      float r = clampf(blk_r[j], -1.0f, 0.99997f) * 32768.0f;
      blk_l[j] = (float)(int)(l + (l >= 0 ? 0.5f : -0.5f)) * (1.0f / 32768.0f);
      blk_r[j] = (float)(int)(r + (r >= 0 ? 0.5f : -0.5f)) * (1.0f / 32768.0f);
    }
  }
  fx_process(blk_l, blk_r, SX_BLOCK);

  float mg = master / 100.0f; mg *= mg;
  if (drive) mg *= 0.5f;
  float pk = g_status.peak * 0.97f;
  for (int j = 0; j < SX_BLOCK; j++) {
    float l = blk_l[j], r = blk_r[j];
    if (drive) { l *= 2.0f; r *= 2.0f; }
    if (hw_char) {
      l = l - 0.005f * l * l * l; r = r - 0.005f * r * r * r;
      l = bq(&shelf_l, l); r = bq(&shelf_r, r);
    }
    l *= mg; r *= mg;
    blk_l[j] = l; blk_r[j] = r;
    float a = l < 0 ? -l : l;
    if (a > pk) pk = a;
    scope_hist[scope_w] = 0.5f * (l + r);
    scope_w = (scope_w + 1) & 1023;
  }
  g_status.peak = pk;
  g_status.frame++;
  seqarp_block(SX_BLOCK);
}

static void scope_snapshot(void)
{
  /* find a rising zero crossing in the older half, then copy 256 samples at 2:1 */
  int start = (scope_w - 1024 + 1024) & 1023;
  int found = -1;
  for (int k = 0; k < 480; k++) {
    int i0 = (start + k) & 1023, i1 = (start + k + 1) & 1023;
    if (scope_hist[i0] <= 0.0f && scope_hist[i1] > 0.0f) { found = k + 1; break; }
  }
  if (found < 0) found = 0;
  for (int k = 0; k < SX_SCOPE; k++) g_status.scope[k] = scope_hist[(start + found + k * 2) & 1023];
}

/* ---------- resampler 44,118 Hz -> device rate (windowed sinc) ---------- */
#define RS_TAPS 16
#define RS_PHASES 256
static float rs_table[(RS_PHASES + 1) * RS_TAPS];
static float ring_l[2048], ring_r[2048];
static u32 ring_end;      /* number of internal samples produced */
static double rs_pos;     /* read position in internal samples */
static double rs_ratio = 1.0;
static int out_rate = 48000;
static float out_buf[SX_OUT_MAX * 2];

static void rs_init(void)
{
  const double PI = 3.14159265358979323846;
  double cutoff = out_rate < SX_RATE ? (double)out_rate / SX_RATE : 1.0;
  cutoff *= 0.91; /* keep the passband to ~20 kHz */
  for (int ph = 0; ph <= RS_PHASES; ph++) {
    double frac = (double)ph / RS_PHASES;
    double sum = 0;
    for (int t = 0; t < RS_TAPS; t++) {
      double x = (t - (RS_TAPS / 2 - 1)) - frac; /* tap offset from read point */
      double sinc = x == 0 ? 1.0 : fm_sind(PI * x * cutoff) / (PI * x * cutoff);
      double w = 0.42 + 0.5 * fm_sind(PI * (x / (RS_TAPS / 2)) + PI / 2) + 0.08 * fm_sind(2 * PI * (x / (RS_TAPS / 2)) + PI / 2);
      if (x <= -RS_TAPS / 2 || x >= RS_TAPS / 2) w = 0;
      double v = sinc * w * cutoff;
      rs_table[ph * RS_TAPS + t] = (float)v;
      sum += v;
    }
    for (int t = 0; t < RS_TAPS; t++) rs_table[ph * RS_TAPS + t] = (float)(rs_table[ph * RS_TAPS + t] / sum);
  }
}

float *synth_render(int frames)
{
  if (frames > SX_OUT_MAX) frames = SX_OUT_MAX;
  for (int i = 0; i < frames; i++) {
    u32 ip = (u32)rs_pos;
    while (ring_end < ip + RS_TAPS / 2 + 1) {
      render_block();
      for (int j = 0; j < SX_BLOCK; j++) {
        ring_l[(ring_end + j) & 2047] = blk_l[j];
        ring_r[(ring_end + j) & 2047] = blk_r[j];
      }
      ring_end += SX_BLOCK;
    }
    double frac = rs_pos - ip;
    float fp = (float)(frac * RS_PHASES);
    int ph = (int)fp; float pf = fp - ph;
    const float *c0 = rs_table + ph * RS_TAPS, *c1 = c0 + RS_TAPS;
    float l = 0, r = 0;
    u32 base = ip - (RS_TAPS / 2 - 1);
    for (int t = 0; t < RS_TAPS; t++) {
      float c = c0[t] + (c1[t] - c0[t]) * pf;
      u32 k = (base + t) & 2047;
      l += ring_l[k] * c; r += ring_r[k] * c;
    }
    /* output boost with a gentle safety clip */
    static const float boost_tab[4] = { 1.0f, 1.9953f, 3.9811f, 7.9433f };
    float b = boost_tab[out_boost];
    l *= b; r *= b;
    if (l > 0.9f) l = 0.9f + 0.1f * (1.0f - 1.0f / (1.0f + (l - 0.9f) * 10.0f));
    if (l < -0.9f) l = -0.9f - 0.1f * (1.0f - 1.0f / (1.0f + (-l - 0.9f) * 10.0f));
    if (r > 0.9f) r = 0.9f + 0.1f * (1.0f - 1.0f / (1.0f + (r - 0.9f) * 10.0f));
    if (r < -0.9f) r = -0.9f - 0.1f * (1.0f - 1.0f / (1.0f + (-r - 0.9f) * 10.0f));
    out_buf[i] = l;
    out_buf[SX_OUT_MAX + i] = r;
    rs_pos += rs_ratio;
  }
  scope_snapshot();
  return out_buf;
}

sx_status *synth_status(void) { return &g_status; }

void synth_init(int rate)
{
  out_rate = rate > 8000 ? rate : 48000;
  fm_math_init(SX_RATE);
  dx7pitchenv_init(SX_BLOCK, SX_RATE);
  memset(voices, 0, sizeof(voices));
  memset(pending, 0, sizeof(pending));
  memset(&g_status, 0, sizeof(g_status));
  for (int i = 0; i < SX_PARTS; i++) { part_defaults(&parts[i], i); part_gains(&parts[i]); }
  make_high_shelf(&shelf_l, SX_RATE, 11000.0f, -3.5f);
  make_high_shelf(&shelf_r, SX_RATE, 11000.0f, -3.5f);
  rs_ratio = (double)SX_RATE / out_rate;
  rs_init();
  ring_end = 0;
  rs_pos = RS_TAPS; /* start a little in so the first taps are valid zeros */
  memset(ring_l, 0, sizeof(ring_l)); memset(ring_r, 0, sizeof(ring_r));
  fx_init();
  seqarp_init();
  g_status.seq_step = -1;
}
