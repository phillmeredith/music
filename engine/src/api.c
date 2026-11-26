/* Sixop WebAssembly exports. */
#include "synth.h"

#define EXPORT(name) __attribute__((export_name(#name)))

EXPORT(sx_init) void sx_init(int rate) { synth_init(rate); }
EXPORT(sx_render) float *sx_render(int frames) { return synth_render(frames); }
EXPORT(sx_out_stride) int sx_out_stride(void) { return SX_OUT_MAX; }
EXPORT(sx_set) void sx_set(int id, int v) { synth_set(id, v); }
EXPORT(sx_get) int sx_get(int id) { return synth_get(id); }
EXPORT(sx_note_on) void sx_note_on(int part, int note, int vel) { synth_note_on(part, note, vel); }
EXPORT(sx_note_off) void sx_note_off(int part, int note) { synth_note_off(part, note); }
EXPORT(sx_key) void sx_key(int note, int vel) { synth_input_note(1, note, vel, 1); }
EXPORT(sx_midi) void sx_midi(int s, int d1, int d2)
{
  if (s == 0xF8) { seqarp_clock_tick(); return; }
  if (s == 0xFA || s == 0xFB) { seqarp_transport(1); return; }
  if (s == 0xFC) { seqarp_transport(0); return; }
  if (s >= 0x80 && s < 0xF0) synth_midi(s, d1 & 127, d2 & 127);
}
EXPORT(sx_panic) void sx_panic(void) { synth_panic(); seq_cmd(7, 0, 0); }
EXPORT(sx_vced) u8 *sx_vced(int part) { return synth_vced(part); }
EXPORT(sx_patch_changed) void sx_patch_changed(int part, int live) { synth_patch_changed(part, live); }
EXPORT(sx_status) sx_status *sx_status_ptr(void) { return synth_status(); }
EXPORT(sx_status_size) int sx_status_size(void) { return (int)sizeof(sx_status); }
EXPORT(sx_seq) seq_data *sx_seq(void) { return &g_seq; }
EXPORT(sx_seq_size) int sx_seq_size(void) { return (int)sizeof(seq_data); }
EXPORT(sx_seq_cmd) void sx_seq_cmd(int c, int a, int b) { seq_cmd(c, a, b); }
static u8 mo[3 * 64];
EXPORT(sx_midiout_buf) u8 *sx_midiout_buf(void) { return mo; }
EXPORT(sx_midiout) int sx_midiout(void) { return synth_midiout(mo, 64); }
