/* Sixop: build shim that lets M-VAVE's Apache-2.0 DX7 files compile on their own.
 * Written for this project (not taken from the GPL FM1 sources). */
#ifndef SIXOP_ENGINE_SHIM_H
#define SIXOP_ENGINE_SHIM_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

typedef uint8_t u8;
typedef int8_t s8;
typedef int16_t s16;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int32_t s32;
typedef int64_t s64;
typedef uint64_t u64;

#define FM1_DSP_CODE
#define FM1_DSP_DATA
#define FM_OP_CNT 6
#define SYNTH_DX7_BLOCK_SAMPLES 64
#define BIT(n) (1u << (n))
#define DSP_MIN(a, b) ((a) < (b) ? (a) : (b))
#define DSP_MAX(a, b) ((a) > (b) ? (a) : (b))

void *memcpy(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
int abs(int x);

/* Maths provided by src/fm_math.c (clean-room tables, see that file). */
int mk_sin(int phase, unsigned short gain);
int k_sin_q24(int x);
int freqlut_qx(int logfreq);
int k_log2_q24(unsigned int x);
int dx7_outlvl(int outlevel);
extern const u8 dx7_lvllut[];
uint32_t fm_exp2_fixed(int32_t x_q24, int out_frac_bits);
#define FM_Q30_ONE (1 << 30)
#endif
