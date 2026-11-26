/* Sixop FM maths: lookup tables and fixed-point helpers used by the DX7 core.
 *
 * Written from the build spec (section 2.3) for this project. It does not use
 * M-VAVE's GPL dx7math.c. The design follows the DX7's own log-sine/exp
 * approach: a 1,024-entry quarter-wave table of -log2(sin) in 1/1024-octave
 * units, plus a 1,024-entry 16-bit exp2 table, no interpolation in the
 * operator path. The LFO sine is interpolated.
 */
#include "shim/engine.h"
#include "fm_math.h"

static u16 logsin_tab[1024];   /* -log2(sin) * 1024, quarter wave */
static u16 exp_tab[1024];      /* 2^(15 - i/1024) */
static int32_t sin_tab[4097];  /* full-cycle sine in Q24, for the LFO */
static uint32_t exp2_tab[1025];/* 2^(i/1024) in Q30 */
static uint32_t freq_k_q16;    /* 2^24 / sample rate, Q16 */
static int g_rate = 44118;

/* ---- tiny double maths for table building (no libm in the wasm build) ---- */
static double d_exp2(double x)
{
    /* 2^x = 2^n * e^(f ln2) */
    int n = (int)x;
    if ((double)n > x) n--;
    double f = (x - n) * 0.69314718055994530942;
    double term = 1.0, sum = 1.0;
    for (int i = 1; i < 30; i++) { term *= f / i; sum += term; }
    while (n > 0) { sum *= 2.0; n--; }
    while (n < 0) { sum *= 0.5; n++; }
    return sum;
}

static double d_ln(double x)
{
    /* x = m * 2^e, m in [1,2); ln(m) via atanh series */
    int e = 0;
    while (x >= 2.0) { x *= 0.5; e++; }
    while (x < 1.0) { x *= 2.0; e--; }
    double y = (x - 1.0) / (x + 1.0), y2 = y * y, term = y, sum = 0.0;
    for (int i = 1; i < 80; i += 2) { sum += term / i; term *= y2; }
    return 2.0 * sum + e * 0.69314718055994530942;
}

double fm_log2d(double x) { return d_ln(x) * 1.44269504088896340736; }
double fm_exp2d(double x) { return d_exp2(x); }

static double d_sin(double x)
{
    const double PI = 3.14159265358979323846;
    while (x > PI) x -= 2 * PI;
    while (x < -PI) x += 2 * PI;
    double term = x, sum = x, x2 = x * x;
    for (int i = 1; i < 20; i++) { term *= -x2 / ((2 * i) * (2 * i + 1)); sum += term; }
    return sum;
}
double fm_sind(double x) { return d_sin(x); }

static int iround(double x) { return x >= 0 ? (int)(x + 0.5) : -(int)(-x + 0.5); }

void fm_math_init(int sample_rate)
{
    const double PI = 3.14159265358979323846;
    g_rate = sample_rate;
    for (int i = 0; i < 1024; i++) {
        /* index i covers sin(i/1024 * pi/2) with no half-step offset, so the
         * quarter-wave mirror is slightly off-centre. That gives the stock
         * engine's small odd harmonics (H3 about -64 dB on a pure sine). */
        double s = d_sin(i / 1024.0 * PI * 0.5);
        double v = i == 0 ? 65535.0 : -fm_log2d(s) * 1024.0;
        if (v > 65535.0) v = 65535.0;
        logsin_tab[i] = (u16)iround(v);
        exp_tab[i] = (u16)iround(d_exp2(15.0 - i / 1024.0));
    }
    for (int i = 0; i <= 4096; i++)
        sin_tab[i] = iround(d_sin(i / 4096.0 * 2 * PI) * (1 << 24));
    for (int i = 0; i <= 1024; i++)
        exp2_tab[i] = (uint32_t)(d_exp2(i / 1024.0) * 1073741824.0 + 0.5);
    freq_k_q16 = (uint32_t)((double)(1 << 24) / sample_rate * 65536.0 + 0.5);
}

/* Operator sine with log-domain gain. phase: 2^24 per cycle (wraps mod 2^32).
 * gain: attenuation, 1024 per halving (0 = full scale). Output: Q24. */
int mk_sin(int phase, unsigned short gain)
{
    u32 ix = ((u32)phase >> 12) & 0xFFF;
    u32 quad = ix >> 10;
    u32 i = ix & 0x3FF;
    if (quad & 1) i = 1023 - i;
    u32 x = (u32)logsin_tab[i] + gain;
    u32 shift = x >> 10;
    if (shift > 24) return 0;
    int y = (int)(((u32)exp_tab[x & 1023] << 9) >> shift);
    return (quad & 2) ? -y : y;
}

/* Interpolated sine. x: 2^24 per cycle. Returns Q24. */
int k_sin_q24(int x)
{
    u32 p = (u32)x & 0xFFFFFF;
    u32 i = p >> 12, f = p & 0xFFF;
    int a = sin_tab[i], b = sin_tab[i + 1];
    return a + (int)(((int64_t)(b - a) * f) >> 12);
}

/* 2^(x / 2^24), result in Q30 mantissa form plus integer exponent */
static uint32_t exp2_mant(uint32_t frac24)
{
    uint32_t i = frac24 >> 14, f = frac24 & 0x3FFF;
    uint32_t a = exp2_tab[i], b = exp2_tab[i + 1];
    return a + (uint32_t)(((uint64_t)(b - a) * f) >> 14);
}

/* Phase increment per sample (2^24 per cycle) for a log2 frequency in Q24. */
int freqlut_qx(int logfreq)
{
    if (logfreq < 0) logfreq = 0;
    int n = logfreq >> 24;
    uint32_t mant = exp2_mant((uint32_t)logfreq & 0xFFFFFF);
    uint64_t v = (uint64_t)mant * freq_k_q16; /* Q46 * 2^n */
    int shift = 46 - n;
    if (shift <= 0) return 0x7FFFFFFF;
    uint64_t r = v >> shift;
    return r > 0x7FFFFFFF ? 0x7FFFFFFF : (int)r;
}

int k_log2_q24(unsigned int x)
{
    if (x == 0) return -(31 << 24);
    return iround(fm_log2d((double)x / 16777216.0) * 16777216.0);
}

int dx7_outlvl(int outlevel)
{
    if (outlevel >= 20) return 28 + outlevel;
    if (outlevel < 0) return 0;
    return dx7_lvllut[outlevel];
}

/* 2^(x/2^24) * 2^out_frac_bits, saturating to u32. */
uint32_t fm_exp2_fixed(int32_t x_q24, int out_frac_bits)
{
    int n = x_q24 >> 24; /* floor */
    uint32_t mant = exp2_mant((uint32_t)x_q24 & 0xFFFFFF); /* Q30 */
    int sh = n + out_frac_bits - 30;
    if (sh >= 2) return 0xFFFFFFFFu;
    if (sh >= 0) {
        uint64_t r = (uint64_t)mant << sh;
        return r > 0xFFFFFFFFull ? 0xFFFFFFFFu : (uint32_t)r;
    }
    if (sh <= -32) return 0;
    return (uint32_t)(((uint64_t)mant + ((uint64_t)1 << (-sh - 1))) >> (-sh));
}
