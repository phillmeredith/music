/* Sixop effects chain: Filter, Reverb, Delay, Distortion, Chorus, Phaser.
 * Six slots, any order, each on/off with a 5 ms crossfade. Written for this
 * project and tuned to measurements of the stock FM-1 V15 firmware
 * (fm1-capture). The reverb and delay run at 1/8 rate, like the hardware's
 * small shared memory, for the same short, grainy character. */
#include "synth.h"
#include "fm_math.h"

enum { FX_FILTER, FX_REVERB, FX_DELAY, FX_DIST, FX_CHORUS, FX_PHASER, FX_N };

static int prm[FX_N][4];          /* [0]=on, [1..3]=params */
static int order[FX_N] = { 0, 1, 2, 3, 4, 5 };
static float mixe[FX_N];           /* crossfade 0..1 */
static const float XF = 1.0f / (0.005f * SX_RATE);
static const double PI = 3.14159265358979323846;

static inline float fsin01(u32 phase) { return (float)k_sin_q24((int)(phase >> 8)) * (1.0f / 16777216.0f); }
static inline float softclip(float x) { /* tanh-like, odd only */
  if (x > 3.0f) return 1.0f; if (x < -3.0f) return -1.0f;
  float x2 = x * x; return x * (27.0f + x2) / (27.0f + 9.0f * x2);
}
static double dtan(double x) { return fm_sind(x) / fm_sind(x + PI / 2); }

/* ---------------- Filter: 2-pole state-variable (TPT) ---------------- */
static const float cut_pts[][2] = { {0,100},{20,279},{25,365},{40,812},{50,1373},{60,2285},{75,4777},{80,6065},{100,15104},{107,20000} };
static float cutoff_label(int c)
{
  for (int i = 0; i < 9; i++) {
    if (c <= cut_pts[i + 1][0]) {
      float t = (c - cut_pts[i][0]) / (cut_pts[i + 1][0] - cut_pts[i][0]);
      return (float)fm_exp2d(fm_log2d(cut_pts[i][1]) * (1 - t) + fm_log2d(cut_pts[i + 1][1]) * t);
    }
  }
  return 20000.0f;
}
typedef struct { float ic1[2], ic2[2], g, k, a1, a2, a3; int mode; } svf_t;
static svf_t flt;
static void filter_update(void)
{
  int type = prm[FX_FILTER][1], c = prm[FX_FILTER][2], q = prm[FX_FILTER][3];
  float label = cutoff_label(c);
  /* measured: LP/BP corner sits ~4.6x below the label, HP close to it */
  float fc = type == 2 ? label : label / 4.6f;
  if (fc < 60.0f) fc = 60.0f;
  if (fc > 0.45f * SX_RATE) fc = 0.45f * SX_RATE;
  float k = 1.75f * (1.0f - q / 100.0f);
  if (k < 0.3f) k = 0.3f;
  flt.g = (float)dtan(PI * fc / SX_RATE);
  flt.k = k;
  flt.a1 = 1.0f / (1.0f + flt.g * (flt.g + k));
  flt.a2 = flt.g * flt.a1;
  flt.a3 = flt.g * flt.a2;
  flt.mode = type;
}
static inline float filter_tick(int ch, float v0)
{
  float v3 = v0 - flt.ic2[ch];
  float v1 = flt.a1 * flt.ic1[ch] + flt.a2 * v3;
  float v2 = flt.ic2[ch] + flt.a2 * flt.ic1[ch] + flt.a3 * v3;
  flt.ic1[ch] = 2 * v1 - flt.ic1[ch];
  flt.ic2[ch] = 2 * v2 - flt.ic2[ch];
  if (flt.mode == 0) return v2;
  if (flt.mode == 1) return v1 * flt.k;
  return v0 - flt.k * v1 - v2;
}

/* ---------------- Reverb: 1/8-rate comb network ---------------- */
#define RV_DIV 8
#define RV_LEN 4096
static float rv_buf[RV_LEN];
static int rv_w;
static float rv_lp1, rv_lp2, rv_acc, rv_prev_out[2], rv_cur_out[2];
static int rv_phase;
static float rv_comb_state[4], rv_comb_g[4], rv_damp;
static int rv_comb_len[4], rv_comb_base[4];
static float ap_buf[2][512]; static int ap_len[2], ap_w[2];
static float rv_wet, rv_dry, rv_early;

static const float rt_room[][2] = { {0,0.45f},{10,1.08f},{50,2.8f},{100,5.61f} };
static float reverb_t60(int type, int d)
{
  float t = 0;
  for (int i = 0; i < 3; i++) if (d <= rt_room[i + 1][0]) {
    float u = (d - rt_room[i][0]) / (rt_room[i + 1][0] - rt_room[i][0]);
    t = rt_room[i][1] + (rt_room[i + 1][1] - rt_room[i][1]) * u; break;
  }
  if (type == 1) t *= 0.92f;       /* hall: measured 5.18 s at 100 */
  else if (type == 2) t *= 1.17f;  /* plate: 6.54 s at 100 */
  return t;
}
static void reverb_update(void)
{
  int type = prm[FX_REVERB][1], d = prm[FX_REVERB][2], mix = prm[FX_REVERB][3];
  static const int lens[3][4] = { {149, 211, 263, 293}, {179, 241, 307, 349}, {113, 157, 199, 233} };
  float t60 = reverb_t60(type, d);
  float lrate = (float)SX_RATE / RV_DIV;
  int base = 0;
  for (int i = 0; i < 4; i++) {
    rv_comb_len[i] = lens[type][i];
    rv_comb_base[i] = base; base += 512;
    float dsec = rv_comb_len[i] / lrate;
    rv_comb_g[i] = (float)fm_exp2d(-3.0 * dsec / t60 * 3.32192809488736234787);
  }
  ap_len[0] = type == 0 ? 41 : 67; ap_len[1] = type == 0 ? 97 : 131;
  rv_damp = type == 2 ? 0.15f : (type == 1 ? 0.3f : 0.4f);
  rv_early = type == 0 ? 0.6f : 0.15f;
  rv_wet = mix / 100.0f; rv_dry = 1.0f - mix / 100.0f;
}
static void reverb_lowrate(float in, float *ol, float *or_)
{
  float l = 0, r = 0;
  for (int i = 0; i < 4; i++) {
    float *buf = rv_buf + rv_comb_base[i];
    int ri = (rv_w - rv_comb_len[i]) & 511;
    float y = buf[ri];
    rv_comb_state[i] = y * (1 - rv_damp) + rv_comb_state[i] * rv_damp;
    buf[rv_w & 511] = in + rv_comb_state[i] * rv_comb_g[i];
    if (i & 1) { l += y; r -= y; } else { l += y; r += y; }
  }
  rv_w++;
  float s[2] = { l * 0.25f, r * 0.25f };
  for (int a = 0; a < 2; a++) {
    int L = ap_len[a];
    float *b = ap_buf[a];
    float d = b[(ap_w[a] - L) & 511];
    float x = s[0] + s[1];
    float v = x * 0.5f + d * 0.6f;
    b[ap_w[a] & 511] = v;
    ap_w[a]++;
    float y = d - 0.6f * v;
    s[0] = s[0] * (1 - 0.5f) + y * 0.5f;
    s[1] = s[1] * (1 - 0.5f) - y * 0.5f;
  }
  *ol = s[0] + in * rv_early * 0.3f;
  *or_ = s[1] + in * rv_early * 0.3f;
}
static inline void reverb_tick(float *l, float *r)
{
  float x = 0.5f * (*l + *r);
  rv_lp1 += (x - rv_lp1) * 0.22f;
  rv_lp2 += (rv_lp1 - rv_lp2) * 0.22f;
  rv_acc += rv_lp2;
  if (++rv_phase >= RV_DIV) {
    rv_phase = 0;
    rv_prev_out[0] = rv_cur_out[0]; rv_prev_out[1] = rv_cur_out[1];
    reverb_lowrate(rv_acc * (1.0f / RV_DIV) * 2.0f, &rv_cur_out[0], &rv_cur_out[1]);
    rv_acc = 0;
  }
  float t = (float)rv_phase / RV_DIV;
  float wl = rv_prev_out[0] + (rv_cur_out[0] - rv_prev_out[0]) * t;
  float wr = rv_prev_out[1] + (rv_cur_out[1] - rv_prev_out[1]) * t;
  *l = *l * rv_dry + wl * rv_wet;
  *r = *r * rv_dry + wr * rv_wet;
}

/* ---------------- Delay: 1/8 rate, ~800 - 7*Rate ms ---------------- */
#define DL_DIV 8
#define DL_LEN 8192
static float dl_buf[DL_LEN];
static int dl_w, dl_phase;
static float dl_acc, dl_prev, dl_cur, dl_fb, dl_mix, dl_time, dl_lp, dl_smooth_time;
static void delay_update(void)
{
  int decay = prm[FX_DELAY][1], rate = prm[FX_DELAY][2], mix = prm[FX_DELAY][3];
  float ms = 800.0f - 7.0f * rate;
  dl_time = ms / 1000.0f * SX_RATE / DL_DIV;
  dl_fb = decay / 100.0f * 0.92f;
  dl_mix = mix / 100.0f;
}
static inline void delay_tick(float *l, float *r)
{
  float x = 0.5f * (*l + *r);
  dl_lp += (x - dl_lp) * 0.3f;
  dl_acc += dl_lp;
  if (++dl_phase >= DL_DIV) {
    dl_phase = 0;
    dl_smooth_time += (dl_time - dl_smooth_time) * 0.01f;
    float rp = (float)dl_w - dl_smooth_time;
    int i0 = (int)rp; float fr = rp - i0;
    if (fr < 0) { i0 -= 1; fr += 1; }
    float y = dl_buf[i0 & (DL_LEN - 1)] * (1 - fr) + dl_buf[(i0 + 1) & (DL_LEN - 1)] * fr;
    dl_buf[dl_w & (DL_LEN - 1)] = dl_acc * (1.0f / DL_DIV) + y * dl_fb;
    dl_w++;
    dl_acc = 0;
    dl_prev = dl_cur; dl_cur = y;
  }
  float t = (float)dl_phase / DL_DIV;
  float w = dl_prev + (dl_cur - dl_prev) * t;
  *l = *l * (1.0f - dl_mix * 0.5f) + w * dl_mix;
  *r = *r * (1.0f - dl_mix * 0.5f) + w * dl_mix;
}

/* ---------------- Distortion: symmetric soft clipper + tone ---------------- */
static float ds_pre, ds_out, ds_g, ds_k, ds_a1, ds_a2, ds_a3, ds_ic1[2], ds_ic2[2], ds_bright;
static void dist_update(void)
{
  int gain = prm[FX_DIST][1], tone = prm[FX_DIST][2], level = prm[FX_DIST][3];
  float g1 = gain < 25 ? gain : 25, g2 = gain > 25 ? gain - 25 : 0;
  ds_pre = 7.0f * (float)fm_exp2d(3.32192809488736234787 * (g1 / 25.0 * 0.85 + g2 / 75.0 * 0.5));
  float comp = (float)fm_exp2d(-3.32192809488736234787 * (g2 / 75.0 * 5.0 / 20.0));
  ds_out = 0.028f * (level / 50.0f) * comp / 0.05f; /* relative to a -26 dBFS input */
  ds_out *= 0.05f;
  float fc = 400.0f * (float)fm_exp2d(tone / 100.0 * 6.0);
  if (fc > 0.45f * SX_RATE) fc = 0.45f * SX_RATE;
  ds_g = (float)dtan(PI * fc / SX_RATE); ds_k = 1.4f;
  ds_a1 = 1.0f / (1.0f + ds_g * (ds_g + ds_k)); ds_a2 = ds_g * ds_a1; ds_a3 = ds_g * ds_a2;
  ds_bright = tone > 80 ? (tone - 80) / 20.0f * 0.6f : 0.0f;
}
static inline float dist_tick(int ch, float x)
{
  float y = softclip(x * ds_pre);
  float v3 = y - ds_ic2[ch];
  float v1 = ds_a1 * ds_ic1[ch] + ds_a2 * v3;
  float v2 = ds_ic2[ch] + ds_a2 * ds_ic1[ch] + ds_a3 * v3;
  ds_ic1[ch] = 2 * v1 - ds_ic1[ch];
  ds_ic2[ch] = 2 * v2 - ds_ic2[ch];
  float hp = y - v2;
  return (v2 + hp * ds_bright) * ds_out;
}

/* ---------------- Chorus ---------------- */
#define CH_LEN 2048
static float ch_buf[CH_LEN]; static int ch_w;
static u32 ch_phase, ch_inc; static float ch_depth, ch_wet, ch_dry;
static void chorus_update(void)
{
  int freq = prm[FX_CHORUS][1], depth = prm[FX_CHORUS][2], mix = prm[FX_CHORUS][3];
  float hz = 0.18f + 0.0187f * freq; /* measured beating 0.37..4.1 Hz = 2x LFO */
  ch_inc = (u32)(hz / SX_RATE * 4294967296.0f);
  ch_depth = depth / 100.0f * 0.0045f * SX_RATE;
  ch_wet = mix / 100.0f * 0.7f; ch_dry = 1.0f - mix / 100.0f * 0.3f;
}
static inline float ch_read(float d)
{
  float rp = (float)ch_w - d;
  int i0 = (int)rp; float fr = rp - i0;
  return ch_buf[i0 & (CH_LEN - 1)] * (1 - fr) + ch_buf[(i0 + 1) & (CH_LEN - 1)] * fr;
}
static inline void chorus_tick(float *l, float *r)
{
  ch_buf[ch_w & (CH_LEN - 1)] = 0.5f * (*l + *r);
  ch_phase += ch_inc;
  float base = 0.007f * SX_RATE;
  float ml = fsin01(ch_phase), mr = fsin01(ch_phase + 0x40000000u);
  float wl = ch_read(base + ch_depth * (1 + ml));
  float wr = ch_read(base + ch_depth * (1 + mr));
  ch_w++;
  *l = *l * ch_dry + wl * ch_wet;
  *r = *r * ch_dry + wr * ch_wet;
}

/* ---------------- Phaser: 4 all-pass stages ---------------- */
static float ph_z[2][4], ph_fb[2]; static u32 ph_phase, ph_inc; static float ph_depth, ph_wet, ph_dry;
static void phaser_update(void)
{
  int freq = prm[FX_PHASER][1], depth = prm[FX_PHASER][2], mix = prm[FX_PHASER][3];
  float hz = 0.75f + 0.0825f * freq; /* measured beating 1.5..18 Hz = 2x LFO */
  ph_inc = (u32)(hz / SX_RATE * 4294967296.0f);
  ph_depth = depth / 100.0f;
  ph_wet = mix / 100.0f * 0.7f; ph_dry = 1.0f - mix / 100.0f * 0.3f;
}
static inline float phaser_ch(int ch, float x, float a)
{
  float y = x + ph_fb[ch] * 0.4f;
  for (int s = 0; s < 4; s++) {
    float o = -a * y + ph_z[ch][s];
    ph_z[ch][s] = y + a * o;
    y = o;
  }
  ph_fb[ch] = y;
  return y;
}
static inline void phaser_tick(float *l, float *r)
{
  ph_phase += ph_inc;
  float ml = fsin01(ph_phase), mr = fsin01(ph_phase + 0x40000000u);
  /* sweep the all-pass corner between ~300 Hz and ~3 kHz */
  float fl = 300.0f * (1.0f + 9.0f * ph_depth * 0.5f * (1 + ml));
  float fr = 300.0f * (1.0f + 9.0f * ph_depth * 0.5f * (1 + mr));
  float tl = 3.14159265f * fl / SX_RATE, tr = 3.14159265f * fr / SX_RATE;
  float al = (1 - tl) / (1 + tl), ar = (1 - tr) / (1 + tr);
  float yl = phaser_ch(0, *l, al), yr = phaser_ch(1, *r, ar);
  *l = *l * ph_dry + yl * ph_wet;
  *r = *r * ph_dry + yr * ph_wet;
}

/* ---------------- chain ---------------- */
static void update(int e)
{
  switch (e) {
  case FX_FILTER: filter_update(); break; case FX_REVERB: reverb_update(); break;
  case FX_DELAY: delay_update(); break; case FX_DIST: dist_update(); break;
  case FX_CHORUS: chorus_update(); break; case FX_PHASER: phaser_update(); break;
  }
}

void fx_reset(void)
{
  memset(rv_buf, 0, sizeof(rv_buf)); memset(ap_buf, 0, sizeof(ap_buf));
  memset(dl_buf, 0, sizeof(dl_buf)); memset(ch_buf, 0, sizeof(ch_buf));
  memset(ph_z, 0, sizeof(ph_z)); memset(&flt, 0, sizeof(flt));
  memset(rv_comb_state, 0, sizeof(rv_comb_state));
  ds_ic1[0] = ds_ic1[1] = ds_ic2[0] = ds_ic2[1] = 0;
  for (int e = 0; e < FX_N; e++) update(e);
}

void fx_init(void)
{
  /* defaults as found on the stock unit: everything off */
  int def[FX_N][4] = {
    {0, 0, 60, 0},   /* filter: LP, cutoff 60, Q 0 */
    {0, 0, 50, 30},  /* reverb: room, decay 50, mix 30 */
    {0, 30, 50, 30}, /* delay: decay 30, rate 50, mix 30 */
    {0, 25, 50, 50}, /* distortion: gain 25, tone 50, level 50 */
    {0, 30, 50, 50}, /* chorus */
    {0, 30, 50, 50}, /* phaser */
  };
  memcpy(prm, def, sizeof(prm));
  for (int e = 0; e < FX_N; e++) { order[e] = e; mixe[e] = 0; }
  dl_smooth_time = 0;
  fx_reset();
  dl_smooth_time = dl_time;
}

void fx_set(int e, int slot, int v)
{
  if (e < 0 || e >= FX_N || slot < 0 || slot > 3) return;
  if (slot == 0) v = v != 0;
  else if (e == FX_FILTER && slot == 1) v = v < 0 ? 0 : (v > 2 ? 2 : v);
  else if (e == FX_REVERB && slot == 1) v = v < 0 ? 0 : (v > 2 ? 2 : v);
  else if (e == FX_FILTER && slot == 2) v = v < 0 ? 0 : (v > 107 ? 107 : v);
  else v = v < 0 ? 0 : (v > 100 ? 100 : v);
  prm[e][slot] = v;
  update(e);
}
int fx_get(int e, int slot) { return (e >= 0 && e < FX_N && slot >= 0 && slot < 4) ? prm[e][slot] : 0; }
void fx_set_order(int pos, int e) { if (pos >= 0 && pos < FX_N && e >= 0 && e < FX_N) order[pos] = e; }
int fx_get_order(int pos) { return (pos >= 0 && pos < FX_N) ? order[pos] : 0; }

void fx_process(float *l, float *r, int n)
{
  for (int pos = 0; pos < FX_N; pos++) {
    int e = order[pos];
    float target = (float)prm[e][0];
    if (mixe[e] == 0.0f && target == 0.0f) continue;
    for (int j = 0; j < n; j++) {
      float m = mixe[e];
      if (m != target) { m += target > m ? XF : -XF; if (m > 1) m = 1; if (m < 0) m = 0; mixe[e] = m; }
      float il = l[j], ir = r[j], ol = il, or_ = ir;
      switch (e) {
      case FX_FILTER: ol = filter_tick(0, il); or_ = filter_tick(1, ir); break;
      case FX_REVERB: reverb_tick(&ol, &or_); break;
      case FX_DELAY: delay_tick(&ol, &or_); break;
      case FX_DIST: ol = dist_tick(0, il); or_ = dist_tick(1, ir); break;
      case FX_CHORUS: chorus_tick(&ol, &or_); break;
      case FX_PHASER: phaser_tick(&ol, &or_); break;
      }
      l[j] = il + (ol - il) * m;
      r[j] = ir + (or_ - ir) * m;
    }
  }
}
