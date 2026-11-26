# Sixop

A six-operator FM synthesizer that runs in the browser and installs to an iPad
or desktop home screen as a PWA. It is modelled on the M-Vave FM-1: the same
engine family, page layout, button behaviour, effects chain, arpeggiator,
sequencer and MIDI handling, and a panel laid out like the hardware (cream
case, black encoders, brown pads, light-blue LCD). The presets are original.

## Run it

It is a static site with no build step for the web side.

```sh
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

Tap any key to power on (browsers only start audio after a touch).
Service workers need `https` or `localhost`.

### Install on an iPad

1. Open the hosted URL in Safari.
2. Share → Add to Home Screen.
3. Launch it from the icon. It opens full screen in landscape and works offline.

What iPad Safari can't do: there is no Web MIDI, so no USB or Bluetooth MIDI in
or out, and no AUv3. Latency is a little higher than a native app. Turn the
silent switch off if you hear nothing on older iPadOS versions.

Desktop Chrome, Edge and Firefox get MIDI in and out, including SysEx (long-press
HOME to enable).

## Layout

```
engine/            C engine compiled to WebAssembly
  src/             synth, voices, ENV overlay, effects, arp/sequencer, API
  src/fm_math.c    clean-room log-sine / exp tables
  vendor/fm1open/  Apache-2.0 FM core from fm1_open (see NOTICE.md)
  build.sh         clang → web/engine.wasm (no emscripten)
tools/gen-params.mjs  generates web/js/params.js from engine/src/params.h
tests/             node tests against the built wasm
web/               the PWA
  worklet.js       AudioWorklet that hosts the wasm engine
  js/app.js        modes, pages, knob maps, combos, LEDs, screen
  js/panel.js      panel layout, multi-touch, long-press, encoders, LED timing
  js/screen.js     240x240 display renderer
  js/feedback.js   synthesized click sounds and haptics
  js/store.js      state and localStorage persistence
  js/dx7.js        DX7 VMEM/VCED and SysEx import/export
  js/presets.js    the 128 original presets
  js/midi.js       Web MIDI
  js/guide.js      the Learn overlay: lesson menu, step cards, add-a-song
  js/lessons.js    the lofi beat lesson
  js/song.js       follow-the-lights song lessons, MIDI parser, song to sequencer
  js/transcribe.js audio file to notes, on the device (Basic Pitch)
  js/listen.js     YouTube player and mic / tab-audio recorder
  vendor/          Basic Pitch + TensorFlow.js bundle and model (see NOTICE.md)
  sw.js            offline cache (bump VERSION when files change)
```

## Build the engine

Needs clang with the wasm32 target (any recent LLVM).

```sh
engine/build.sh                # writes web/engine.wasm
node tools/gen-params.mjs      # only after editing engine/src/params.h
node --test tests/*.test.mjs   # engine tests
```

After changing anything under `web/`, bump `VERSION` in `web/sw.js` so
installed copies pick up the update.

## How close it is to the hardware

Measured from the stock V15 firmware and matched:

- Tone and level: harmonics and peak level of the init voice (F3, velocity 90,
  -26.7 dBFS), 44,118 Hz internal rate, 16-bit output quantising, the gentle
  high-shelf and soft saturation of the output stage.
- Filter cutoff/Q curves, reverb decay times, chorus and phaser LFO rates.
- ENV overlay times, constant-time glide (Full Time / Fingered), voice stealing.
- Panel timing: 880 ms long press, LED blink rates for octave and MIDI states,
  20% backlight, fixed panel velocity 90, lowest key F3.

Built to the spec but **not yet measured**, so expect tuning:

- Delay time curve and feedback.
- Arpeggiator gate and swing feel.
- MIDI CC numbering on the effect channel (CC70-93).

Differences on purpose:

- 20 voices instead of 12 (Globe page lets you set it lower).
- Output boost (0/+6/+12/+18 dB, default +12) because tablet speakers are quiet.
- Presets are original. No Yamaha or M-Vave factory sounds are included; you can
  import any DX7 `.syx` bank (drop it on the window, or GLOBE → Data → Import).

## Controls cheat sheet

- **PRESETS** encoder: browse presets; turn past the top for the FX group and
  the eight voice slots (V1-V8).
- **SELECT**: page through the current mode. **ALGORITHM**: algorithm, FX group
  or step cursor depending on mode. **K1-K4**: the four tiles on screen.
- **EDIT**: black keys pick OP1-6, PIT, GLO, MONO, POLY. Long-press an operator
  key to mute it.
- **OCT − / OCT +**: octave shift (LED blinks slow for ±1, fast for ±2). Press
  both to reset. Hold one and turn ALGORITHM to transpose.
- **ARP** and **SEQ** are mutually exclusive. In SEQ, REC step-records (hold
  keys for chords), PLAY starts and stops; long-press PLAY is panic.
- **SAVE**: all, globals, preset, preset to slot, pattern or FX group.
- **GLOBE → Data**: import `.syx`, export a bank, back up everything as JSON,
  factory reset. GLOBE → Look/Sound has themes, click volume and output boost.
- Long-press **HOME** turns MIDI on or off.

## Licence

Code in `engine/vendor/fm1open/` is Apache-2.0 (see its NOTICE.md). The rest of
this repository has no licence chosen yet. `web/vendor/` holds Basic Pitch and
TensorFlow.js, both Apache-2.0 (see `web/vendor/NOTICE.md`).

## Lessons

Tap **? Learn** on the panel. "Make a beat" walks through a lofi beat step by
step. "Learn a song" lights up the keys phrase by phrase. "Add a song" turns an
MP3 or other audio file, a MIDI file, a YouTube video (heard through the mic or
shared tab audio) or the current sequencer beat into a new song lesson. Note
detection runs on the device; nothing is uploaded.

## Deploy (music.phillm.dev)

The live site is a small Cloudflare Worker called `music` on the phillm.dev
zone. It serves the files on this repo's `gh-pages` branch (fetched from
raw.githubusercontent.com, cached for two minutes) with the right content types.

To publish, copy `web/` onto `gh-pages` and push:

```sh
git worktree add /tmp/ghp gh-pages
rsync -a --delete --exclude .git --exclude CNAME --exclude .nojekyll web/ /tmp/ghp/
cd /tmp/ghp && git add -A && git commit -m "Publish" && git push
```

Bump `VERSION` in `web/sw.js` first so installed copies update.
