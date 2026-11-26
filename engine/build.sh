#!/bin/sh
# Builds engine/sixop.wasm (freestanding wasm32, no emscripten) into web/engine.wasm.
set -e
cd "$(dirname "$0")"
OUT=../web/engine.wasm
SRC="src/fm_math.c src/synth.c src/fx.c src/seqarp.c src/api.c \
  vendor/fm1open/dx7core.c vendor/fm1open/dx7env.c vendor/fm1open/dx7lfo.c \
  vendor/fm1open/dx7note.c vendor/fm1open/dx7pitchenv.c"
clang --target=wasm32 -O3 -ffreestanding -nostdlib -fno-builtin-memcpy -fno-builtin-memset \
  -Isrc/shim -Isrc -fvisibility=hidden -Wall -Wno-unused-function \
  -Wl,--no-entry -Wl,--export-memory -Wl,--initial-memory=4194304 -Wl,-z,stack-size=131072 \
  -o "$OUT" $SRC
echo "built $OUT ($(wc -c < "$OUT") bytes)"
