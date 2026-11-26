# Vendored FM core (Apache-2.0)

These files come from M-VAVE's open FM-1 web engine, `web/synth/` in
https://github.com/m-vave/fm1_open at commit `4c7496daac04a95ff10d1afdcc8f9ead2dbabc41`:

`dx7core.c/h`, `dx7env.c/h`, `dx7lfo.c/h`, `dx7note.c/h`, `dx7pitchenv.c/h`, `dx7ctrl.h`

They are an adaptation of Google's Music Synthesizer for Android (MSFA) and the
Dexed msfa note model, and are licensed under the Apache License 2.0. The full
licence text and upstream copyright notices are in
[LICENSE-APACHE-2.0.md](LICENSE-APACHE-2.0.md). The `THIRD_PARTY.md` named in
the file headers is that upstream file; the part that covers these files is
reproduced there.

Copyright 2012, 2013 Google Inc.
Copyright 2016-2025 Pascal Gauthier (Dexed msfa note-model changes).
Modified by M-VAVE, 2026: C port, fixed-point arithmetic, block processing, voice management and MIDI controls.

## Changes made for Sixop (2026)

- `dx7env.c/h`: added `dx7env_update()` so envelope rates and levels can be
  changed while a note sounds.
- `dx7note.c/h`: added `dx7note_update()` for live patch edits.
- Include paths point at small shims in `engine/src/shim/` instead of the
  upstream headers.

Only the Apache-licensed files above were copied. The rest of fm1_open
(GPL-3.0 app code, the binary SDK and the factory DX7 bank) is not included.
The maths tables (`engine/src/fm_math.c`) are a clean-room implementation.
