// Loads web/engine.wasm in Node for tests and offline renders.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

export async function loadEngine(rate = 44100) {
  const bytes = readFileSync(join(here, '..', 'web', 'engine.wasm'));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  x.sx_init(rate);
  const stride = x.sx_out_stride();
  const api = {
    x, rate,
    mem: () => x.memory.buffer,
    render(frames) {
      const L = new Float32Array(frames), R = new Float32Array(frames);
      for (let o = 0; o < frames; o += 128) {
        const n = Math.min(128, frames - o);
        const p = x.sx_render(n);
        const f = new Float32Array(x.memory.buffer, p, stride * 2);
        L.set(f.subarray(0, n), o); R.set(f.subarray(stride, stride + n), o);
      }
      return [L, R];
    },
    vced(part = 0) { return new Uint8Array(x.memory.buffer, x.sx_vced(part), 156); },
  };
  return api;
}

export function writeWav(path, L, R, rate) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

export function readWav(path) {
  const b = readFileSync(path);
  let o = 12, fmt, data;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, o + 8 + sz);
    o += 8 + sz + (sz & 1);
  }
  const n = data.length / (2 * fmt.ch), L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = data.readInt16LE(i * 2 * fmt.ch) / 32768;
  return { rate: fmt.rate, L };
}

// magnitude of a frequency in a signal window (Goertzel), normalised to sine amplitude
export function tone(sig, rate, f) {
  const w = 2 * Math.PI * f / rate; let re = 0, im = 0;
  for (let i = 0; i < sig.length; i++) {
    const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (sig.length - 1));
    re += sig[i] * h * Math.cos(w * i); im -= sig[i] * h * Math.sin(w * i);
  }
  return 2 * Math.hypot(re, im) / (sig.length * 0.5);
}
export const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
export const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
