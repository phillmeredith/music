/* Sixop arpeggiator and step sequencer, clocked inside the audio render.
 * Written for this project from the FM-1 behaviour and build specs. Delay,
 * arp mode names and rate lists are not yet measured on hardware: these are
 * the spec's best readings and are marked to be tuned. */
#include "synth.h"

seq_data g_seq;

/* rate table in 24 ppqn ticks; names live in web/js/constants.js */
static const int rate_ticks[] = { 96, 48, 24, 16, 12, 8, 6, 4, 3 };
#define N_RATES 9

static int tempo = 120;
static double tick_pos;          /* running clock position in ticks */
static int clock_running;        /* anything that needs the clock */
static int ext_ticks_pending;
static u32 rng = 0x1234567;
static inline u32 rnd(void) { rng = rng * 1664525u + 1013904223u; return rng >> 8; }
static inline int clampi(int x, int lo, int hi) { return x < lo ? lo : (x > hi ? hi : x); }

/* ---------- scheduled note-offs ---------- */
typedef struct { double at; s8 part; u8 note; u8 used; u8 route; int ch; int panel; } noff_t;
static noff_t noffs[96];
static void route_note(int ch, int panel, int note, int vel);

static void schedule_off(double at, int part, int note, int route, int ch, int panel)
{
  for (int i = 0; i < 96; i++) if (!noffs[i].used) {
    noffs[i].used = 1; noffs[i].at = at; noffs[i].part = (s8)part; noffs[i].note = (u8)note;
    noffs[i].route = (u8)route; noffs[i].ch = ch; noffs[i].panel = panel; return;
  }
}
static void fire_offs(double now, int all)
{
  for (int i = 0; i < 96; i++) if (noffs[i].used && (all || noffs[i].at <= now)) {
    noffs[i].used = 0;
    if (noffs[i].route) route_note(noffs[i].ch, noffs[i].panel, noffs[i].note, 0);
    else { synth_note_off(noffs[i].part, noffs[i].note); synth_midiout_push(0x80, noffs[i].note, 64); }
  }
}

/* ---------- arpeggiator ---------- */
static int arp_on, arp_mode, arp_oct = 1, arp_rate = 6, arp_gate = 80, arp_swing = 50, arp_latch, arp_sync;
static u8 held[32]; static int held_n;            /* press order */
static int keys_down;                              /* physical keys down (for latch) */
static u8 seqn[32 * 4 * 2]; static int seqn_len;   /* built sequence */
static int arp_idx, arp_running;
static double arp_next;
static int arp_count;
static int arp_ch = 1, arp_panel = 1;

static void route_note(int ch, int panel, int note, int vel)
{
  extern void synth_route_note(int ch, int note, int vel, int from_panel);
  if (vel > 0) synth_midiout_push(0x90, note, vel); else synth_midiout_push(0x80, note, 64);
  synth_route_note(ch, note, vel, panel);
}

static void arp_build(void)
{
  u8 base[32]; int n = held_n;
  for (int i = 0; i < n; i++) base[i] = held[i];
  int sorted = !(arp_mode == 5 || arp_mode == 6);
  if (sorted)
    for (int i = 1; i < n; i++) { u8 k = base[i]; int j = i - 1; while (j >= 0 && base[j] > k) { base[j + 1] = base[j]; j--; } base[j + 1] = k; }
  u8 ext[128]; int m = 0;
  for (int o = 0; o < arp_oct; o++) for (int i = 0; i < n; i++) { int v = base[i] + 12 * o; if (v < 128 && m < 128) ext[m++] = (u8)v; }
  seqn_len = 0;
  switch (arp_mode) {
  case 0: case 4: case 5: for (int i = 0; i < m; i++) seqn[seqn_len++] = ext[i]; break;      /* up, random, order */
  case 1: for (int i = m - 1; i >= 0; i--) seqn[seqn_len++] = ext[i]; break;                /* down */
  case 2: for (int i = 0; i < m; i++) seqn[seqn_len++] = ext[i];                             /* inclusive */
          for (int i = m - 1; i >= 0; i--) seqn[seqn_len++] = ext[i]; break;
  case 3: for (int i = 0; i < m; i++) seqn[seqn_len++] = ext[i];                             /* exclusive */
          for (int i = m - 2; i >= 1; i--) seqn[seqn_len++] = ext[i]; break;
  case 6: for (int i = 0; i < m; i++) { seqn[seqn_len++] = ext[i]; seqn[seqn_len++] = ext[i]; } break; /* repeat */
  }
  if (arp_idx >= seqn_len) arp_idx = 0;
}

int arp_active(void) { return arp_on; }

void arp_note(int note, int vel, int on)
{
  extern int sx_route_part(void);
  int rp = sx_route_part();
  arp_ch = rp & 0xFF; arp_panel = rp >> 8;
  if (on) {
    if (keys_down == 0 && arp_latch) held_n = 0; /* new chord replaces a latched one */
    keys_down++;
    for (int i = 0; i < held_n; i++) if (held[i] == note) return;
    if (held_n < 27) held[held_n++] = (u8)note;
    (void)vel;
  } else {
    if (keys_down > 0) keys_down--;
    if (!arp_latch) {
      int f = -1;
      for (int i = 0; i < held_n; i++) if (held[i] == note) f = i;
      if (f >= 0) { for (int i = f; i < held_n - 1; i++) held[i] = held[i + 1]; held_n--; }
    }
  }
  arp_build();
  if (held_n > 0 && !arp_running) {
    arp_running = 1; arp_idx = 0; arp_count = 0;
    arp_next = arp_sync ? tick_pos : tick_pos; /* start now */
  }
  if (held_n == 0) arp_running = 0;
}

static double step_ticks(int rate) { return rate_ticks[clampi(rate, 0, N_RATES - 1)]; }

static void arp_run(double now)
{
  if (!arp_on || !arp_running || seqn_len == 0) return;
  while (arp_next <= now) {
    double st = step_ticks(arp_rate);
    int note;
    if (arp_mode == 4) note = seqn[rnd() % seqn_len];
    else { note = seqn[arp_idx % seqn_len]; arp_idx = (arp_idx + 1) % seqn_len; }
    route_note(arp_ch, arp_panel, note, 100);
    schedule_off(arp_next + st * arp_gate / 100.0, 0, note, 1, arp_ch, arp_panel);
    g_status.arp_step = arp_count;
    /* swing: the second step of each pair is delayed */
    double sw = (arp_swing - 50) / 50.0;
    double next = arp_next + st;
    if ((arp_count & 1) == 0) next += st * sw; else next -= st * sw;
    arp_count++;
    arp_next = next;
  }
}

/* ---------- sequencer ---------- */
static int seq_on, seq_play, seq_rec, seq_pat, seq_queued = -1, seq_sync, seq_transpose, seq_cursor;
static int seq_arr, seq_gate_default = 80;
typedef struct { int pat; int step; double next; int count; int active; } lane_t;
static lane_t lanes[8];
static int arr_col;
static double arr_col_end;
static int rec_keys, rec_wrote, rec_last_step = -1;

static seq_pattern *P(int i) { return &g_seq.pat[i & 15]; }

static void pattern_defaults(seq_pattern *p)
{
  memset(p, 0, sizeof(*p));
  p->length = 16; p->part = 0; p->rate = 6; p->gate = 80; p->swing = 50; p->transpose_plus12 = 12;
  for (int s = 0; s < SEQ_STEPS; s++) p->step[s].ratchet = 1;
}

static double pattern_cycle_ticks(int pi) { seq_pattern *p = P(pi); return p->length * step_ticks(p->rate); }

static void lane_start(int l, int pat, int step, double at)
{
  lanes[l].pat = pat; lanes[l].step = step; lanes[l].next = at; lanes[l].count = 0; lanes[l].active = 1;
}

static void seq_start(double at)
{
  for (int l = 0; l < 8; l++) lanes[l].active = 0;
  if (seq_arr) {
    arr_col = 0;
    double longest = 0;
    for (int r = 0; r < 8; r++) {
      int pi = g_seq.arrange[r][0];
      if (pi >= 0) { lane_start(r, pi, 0, at); if (pattern_cycle_ticks(pi) > longest) longest = pattern_cycle_ticks(pi); }
    }
    arr_col_end = at + (longest > 0 ? longest : 16 * 6);
  } else {
    int start = seq_cursor < P(seq_pat)->length ? seq_cursor : 0;
    lane_start(0, seq_pat, start, at);
  }
  seq_play = 1;
}

static void seq_stop(void)
{
  seq_play = 0;
  for (int l = 0; l < 8; l++) lanes[l].active = 0;
  fire_offs(0, 1);
  g_status.seq_step = -1;
}

static void lane_fire(int l, int row_part)
{
  lane_t *ln = &lanes[l];
  seq_pattern *p = P(ln->pat);
  seq_step *s = &p->step[ln->step];
  double st = step_ticks(p->rate);
  int part = seq_arr ? row_part : p->part;
  int tr = seq_transpose + (int)p->transpose_plus12 - 12;
  int rat = s->ratchet < 1 ? 1 : (s->ratchet > 4 ? 4 : s->ratchet);
  for (int n = 0; n < SEQ_NOTES; n++) {
    if (!s->note[n] || !s->len[n]) continue;
    int note = clampi(s->note[n] + tr, 0, 127);
    int vel = s->vel[n] ? s->vel[n] : 100;
    if (rat > 1 && s->len[n] == 1) {
      double sub = st / rat;
      /* first hit now; ratchet_schedule() queues the rest */
      synth_note_on(part, note, vel); synth_midiout_push(0x90, note, vel);
      schedule_off(ln->next + sub * p->gate / 100.0, part, note, 0, 0, 0);
    } else {
      synth_note_on(part, note, vel);
      synth_midiout_push(0x90, note, vel);
      double len = (s->len[n] - 1) * st + st * p->gate / 100.0;
      schedule_off(ln->next + len, part, note, 0, 0, 0);
    }
  }
}

/* ratchet retriggers are handled here: a hit list per lane */
typedef struct { double at; s8 part; u8 note, vel, used; double off; } rhit_t;
static rhit_t rhits[64];
static void ratchet_schedule(int l, int row_part)
{
  lane_t *ln = &lanes[l];
  seq_pattern *p = P(ln->pat);
  seq_step *s = &p->step[ln->step];
  int rat = s->ratchet;
  if (rat <= 1) return;
  double st = step_ticks(p->rate), sub = st / rat;
  int part = seq_arr ? row_part : p->part;
  int tr = seq_transpose + (int)p->transpose_plus12 - 12;
  for (int n = 0; n < SEQ_NOTES; n++) {
    if (!s->note[n] || s->len[n] != 1) continue;
    for (int r = 1; r < rat; r++)
      for (int i = 0; i < 64; i++) if (!rhits[i].used) {
        rhits[i].used = 1; rhits[i].at = ln->next + sub * r; rhits[i].part = (s8)part;
        rhits[i].note = (u8)clampi(s->note[n] + tr, 0, 127); rhits[i].vel = s->vel[n] ? s->vel[n] : 100;
        rhits[i].off = ln->next + sub * r + sub * p->gate / 100.0; break;
      }
  }
}
static void ratchet_run(double now)
{
  for (int i = 0; i < 64; i++) if (rhits[i].used && rhits[i].at <= now) {
    rhits[i].used = 0;
    synth_note_on(rhits[i].part, rhits[i].note, rhits[i].vel);
    synth_midiout_push(0x90, rhits[i].note, rhits[i].vel);
    schedule_off(rhits[i].off, rhits[i].part, rhits[i].note, 0, 0, 0);
  }
}

static void seq_run(double now)
{
  if (!seq_play) return;
  for (int l = 0; l < 8; l++) {
    lane_t *ln = &lanes[l];
    if (!ln->active) continue;
    while (ln->active && ln->next <= now) {
      seq_pattern *p = P(ln->pat);
      if (ln->step >= p->length) ln->step = 0;
      lane_fire(l, l);
      ratchet_schedule(l, l);
      if (l == 0 || seq_arr) { if (l == 0 || !lanes[0].active) { g_status.seq_step = ln->step; g_status.seq_pattern = ln->pat; } }
      double st = step_ticks(p->rate);
      double sw = (p->swing - 50) / 50.0;
      double next = ln->next + st + (((ln->count & 1) == 0) ? st * sw : -st * sw);
      ln->count++;
      ln->step++;
      if (ln->step >= p->length) {
        ln->step = 0;
        if (!seq_arr && seq_queued >= 0) { ln->pat = seq_queued; seq_pat = seq_queued; seq_queued = -1; }
        if (seq_arr) ln->active = 0; /* waits for column change */
      }
      ln->next = next;
    }
  }
  if (seq_arr && now >= arr_col_end) {
    int len = g_seq.arr_len < 1 ? 1 : (g_seq.arr_len > 8 ? 8 : g_seq.arr_len);
    arr_col = (arr_col + 1) % len;
    double longest = 0, at = arr_col_end;
    for (int r = 0; r < 8; r++) {
      lanes[r].active = 0;
      int pi = g_seq.arrange[r][arr_col];
      if (pi >= 0) { lane_start(r, pi, 0, at); if (pattern_cycle_ticks(pi) > longest) longest = pattern_cycle_ticks(pi); }
    }
    arr_col_end = at + (longest > 0 ? longest : 16 * 6);
  }
  g_status.arr_col = arr_col;
}

/* step entry: the first key writes the cursor step, more keys held add a chord,
 * releasing every key moves the cursor on */
/* In SEQ mode the panel keys play the current pattern's voice, so each
   track can be auditioned and recorded with its own sound. */
int seq_panel_part(void) { return seq_on ? P(seq_pat)->part : -1; }

void seq_record_note(int note, int vel, int on)
{
  if (!seq_on || !seq_rec) return;
  seq_pattern *p = P(seq_pat);
  if (on) {
    seq_step *s = &p->step[seq_cursor];
    if (rec_keys == 0) { memset(s->note, 0, sizeof(s->note)); memset(s->len, 0, sizeof(s->len)); rec_wrote = 0; }
    if (rec_wrote < SEQ_NOTES) {
      s->note[rec_wrote] = (u8)note; s->vel[rec_wrote] = (u8)(vel > 0 ? vel : 100); s->len[rec_wrote] = 1; rec_wrote++;
    }
    if (s->ratchet < 1) s->ratchet = 1;
    rec_last_step = seq_cursor;
    rec_keys++;
  } else {
    if (rec_keys > 0) rec_keys--;
    if (rec_keys == 0) seq_cursor = (seq_cursor + 1) % (p->length ? p->length : 16);
  }
}

void seq_cmd(int cmd, int a, int b)
{
  switch (cmd) {
  case 1: if (a >= 0 && a < 16 && b >= 0 && b < 64) { seq_step *s = &P(a)->step[b]; memset(s, 0, sizeof(*s)); s->ratchet = 1; } break; /* clear step */
  case 2: if (a >= 0 && a < 16) { int part = P(a)->part; pattern_defaults(P(a)); P(a)->part = (u8)part; } break; /* clear pattern */
  case 3: { /* long note: extend the note(s) at step a to end step b (inclusive) */
    seq_pattern *p = P(seq_pat);
    if (a < 0 || a >= p->length) break;
    int len = b - a + 1; if (len < 1) len = 1; if (a + len > p->length) len = p->length - a;
    for (int n = 0; n < SEQ_NOTES; n++) if (p->step[a].note[n]) p->step[a].len[n] = (u8)len;
    seq_cursor = (a + len) % p->length;
    break;
  }
  case 4: { seq_pattern *p = P(seq_pat); seq_cursor = (seq_cursor + 1) % (p->length ? p->length : 16); break; } /* rest */
  case 5: if (a >= 0 && a < 8 && b >= 0 && b < 8) {} break;
  case 6: if (a >= 0 && a < 16 && b >= 0 && b < 16) memcpy(P(b), P(a), sizeof(seq_pattern)); break; /* copy */
  case 7: fire_offs(0, 1); break;
  case 8: if (a >= 0 && a < 64) { seq_step *s = &P(seq_pat)->step[a]; s->ratchet = (u8)clampi(b, 1, 4); } break; /* ratchet */
  case 9: for (int i = 0; i < 16; i++) pattern_defaults(P(i));
          memset(g_seq.arrange, 0xFF, sizeof(g_seq.arrange)); g_seq.arr_len = 4; break; /* reset all */
  default: break;
  }
}

/* ---------- clock ---------- */
void seqarp_clock_tick(void) { ext_ticks_pending++; }
void seqarp_transport(int start)
{
  if (start) {
    tick_pos = 0; fire_offs(0, 1);
    if (seq_on) { seq_cursor = 0; seq_start(0); }
    if (arp_running) { arp_next = 0; arp_idx = 0; arp_count = 0; }
  } else {
    if (seq_play) seq_stop();
  }
}

void seqarp_block(int nsamples)
{
  int sync = (seq_on && seq_sync) || (arp_on && arp_sync);
  double before = tick_pos;
  if (sync) { tick_pos += ext_ticks_pending; ext_ticks_pending = 0; }
  else tick_pos += nsamples * (tempo * 24.0 / 60.0) / SX_RATE;
  clock_running = seq_play || (arp_on && arp_running);
  g_status.clock_running = clock_running;
  if (clock_running) {
    if ((long)(tick_pos / 24) != (long)(before / 24)) g_status.beat++;
    if ((long)(tick_pos / 6) != (long)(before / 6)) g_status.sixteenth++;
  }
  ratchet_run(tick_pos);
  fire_offs(tick_pos, 0);
  arp_run(tick_pos);
  seq_run(tick_pos);
  g_status.seq_queued = seq_queued;
}

void seqarp_init(void)
{
  memset(&g_seq, 0, sizeof(g_seq));
  seq_cmd(9, 0, 0);
  memset(noffs, 0, sizeof(noffs));
  memset(rhits, 0, sizeof(rhits));
  tick_pos = 0;
}

void seqarp_set(int id, int v)
{
  switch (id) {
  case P_TEMPO: tempo = clampi(v, 30, 300); break;
  case P_ARP_ON:
    arp_on = v != 0;
    if (!arp_on) { arp_running = 0; held_n = 0; keys_down = 0; fire_offs(0, 1); }
    break;
  case P_ARP_MODE: arp_mode = clampi(v, 0, 6); arp_build(); break;
  case P_ARP_OCT: arp_oct = clampi(v, 1, 4); arp_build(); break;
  case P_ARP_RATE: arp_rate = clampi(v, 0, N_RATES - 1); break;
  case P_ARP_GATE: arp_gate = clampi(v, 20, 100); break;
  case P_ARP_SWING: arp_swing = clampi(v, 50, 75); break;
  case P_ARP_LATCH:
    arp_latch = v != 0;
    if (!arp_latch && keys_down == 0) { held_n = 0; arp_running = 0; }
    break;
  case P_ARP_SYNC: arp_sync = v != 0; break;
  case P_SEQ_ON: seq_on = v != 0; if (!seq_on) { seq_stop(); seq_rec = 0; } break;
  case P_SEQ_PLAY: if (v && !seq_play) seq_start(tick_pos); else if (!v && seq_play) seq_stop(); break;
  case P_SEQ_REC: seq_rec = v != 0; rec_keys = 0; break;
  case P_SEQ_PATTERN:
    v = clampi(v, 0, 15);
    if (seq_play && !seq_arr) seq_queued = v; else { seq_pat = v; seq_cursor = 0; }
    break;
  case P_SEQ_STEPS: P(seq_pat)->length = (u8)clampi(v, 1, 64); if (seq_cursor >= v) seq_cursor = 0; break;
  case P_SEQ_PART: P(seq_pat)->part = (u8)clampi(v, 0, 7); break;
  case P_SEQ_RATE: P(seq_pat)->rate = (u8)clampi(v, 0, N_RATES - 1); break;
  case P_SEQ_GATE: P(seq_pat)->gate = (u8)clampi(v, 10, 100); break;
  case P_SEQ_SWING: P(seq_pat)->swing = (u8)clampi(v, 50, 75); break;
  case P_SEQ_SYNC: seq_sync = v != 0; break;
  case P_SEQ_TRANSPOSE: seq_transpose = clampi(v, -12, 12); break;
  case P_SEQ_CURSOR: seq_cursor = clampi(v, 0, 63); break;
  case P_SEQ_ARRANGE: seq_arr = v != 0; break;
  case P_SEQ_ARR_LEN: g_seq.arr_len = (u8)clampi(v, 1, 8); break;
  default: break;
  }
  (void)seq_gate_default;
}

int seqarp_get(int id)
{
  switch (id) {
  case P_TEMPO: return tempo;
  case P_ARP_ON: return arp_on; case P_ARP_MODE: return arp_mode; case P_ARP_OCT: return arp_oct;
  case P_ARP_RATE: return arp_rate; case P_ARP_GATE: return arp_gate; case P_ARP_SWING: return arp_swing;
  case P_ARP_LATCH: return arp_latch; case P_ARP_SYNC: return arp_sync;
  case P_SEQ_ON: return seq_on; case P_SEQ_PLAY: return seq_play; case P_SEQ_REC: return seq_rec;
  case P_SEQ_PATTERN: return seq_pat; case P_SEQ_STEPS: return P(seq_pat)->length;
  case P_SEQ_PART: return P(seq_pat)->part; case P_SEQ_RATE: return P(seq_pat)->rate;
  case P_SEQ_GATE: return P(seq_pat)->gate; case P_SEQ_SWING: return P(seq_pat)->swing;
  case P_SEQ_SYNC: return seq_sync; case P_SEQ_TRANSPOSE: return seq_transpose;
  case P_SEQ_CURSOR: return seq_cursor; case P_SEQ_ARRANGE: return seq_arr;
  case P_SEQ_ARR_LEN: return g_seq.arr_len;
  default: return 0;
  }
}
