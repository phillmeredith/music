// AudioWorklet processor hosting the Sixop wasm engine.
class SixopProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.queue = [];
    this.statusEvery = Math.max(1, Math.round(sampleRate / 128 / 60)); // ~60 Hz
    this.tick = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
    const bytes = options.processorOptions.wasm;
    WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
      this.x = instance.exports;
      this.x.sx_init(sampleRate);
      this.stride = this.x.sx_out_stride();
      this.ready = true;
      for (const m of this.queue) this.onMsg(m);
      this.queue = [];
      this.port.postMessage({ t: 'ready', rate: sampleRate });
    });
  }
  onMsg(m) {
    if (!this.ready) { this.queue.push(m); return; }
    const x = this.x;
    switch (m.t) {
      case 'set': x.sx_set(m.id, m.v); break;
      case 'sets': for (const [id, v] of m.list) x.sx_set(id, v); break;
      case 'key': x.sx_key(m.n, m.v); break;
      case 'midi': x.sx_midi(m.b[0], m.b[1] || 0, m.b[2] || 0); break;
      case 'on': x.sx_note_on(m.p, m.n, m.v); break;
      case 'off': x.sx_note_off(m.p, m.n); break;
      case 'panic': x.sx_panic(); break;
      case 'vced': {
        const p = x.sx_vced(m.p);
        new Uint8Array(x.memory.buffer, p, 156).set(m.data.subarray(0, 156));
        x.sx_patch_changed(m.p, m.live ? 1 : 0);
        break;
      }
      case 'seqcmd': x.sx_seq_cmd(m.c, m.a || 0, m.b || 0); break;
      case 'seqload': new Uint8Array(x.memory.buffer, x.sx_seq(), x.sx_seq_size()).set(m.data); break;
      case 'seqdump': {
        const d = new Uint8Array(x.memory.buffer, x.sx_seq(), x.sx_seq_size()).slice();
        this.port.postMessage({ t: 'seqdump', id: m.id, data: d }, [d.buffer]);
        break;
      }
      case 'get': {
        const vals = m.ids.map((id) => x.sx_get(id));
        this.port.postMessage({ t: 'got', id: m.id, vals });
        break;
      }
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.ready) return true;
    const n = out[0].length;
    const p = this.x.sx_render(n);
    const f = new Float32Array(this.x.memory.buffer, p, this.stride * 2);
    out[0].set(f.subarray(0, n));
    if (out[1]) out[1].set(f.subarray(this.stride, this.stride + n));
    if (++this.tick >= this.statusEvery) {
      this.tick = 0;
      const x = this.x, buf = x.memory.buffer;
      const sp = x.sx_status();
      const st = new DataView(buf, sp, x.sx_status_size());
      // layout must match sx_status in engine/src/synth.h
      const notes = new Uint8Array(buf, sp + 4, 128).slice();
      const leds = new Uint8Array(buf, sp + 132, 32).slice();
      let o = 164;
      const i32 = () => { const v = st.getInt32(o, true); o += 4; return v; };
      const status = {
        frame: st.getUint32(0, true), notes, leds,
        seqStep: i32(), seqPattern: i32(), seqQueued: i32(), arrCol: i32(), beat: i32(), sixteenth: i32(),
        voices: i32(), arpStep: i32(), clock: i32(),
      };
      status.peak = st.getFloat32(o, true); o += 4;
      status.scope = new Float32Array(buf, sp + o, 256).slice();
      const nmo = x.sx_midiout();
      if (nmo) status.midiout = new Uint8Array(buf, x.sx_midiout_buf(), nmo * 3).slice();
      this.port.postMessage({ t: 'status', s: status });
    }
    return true;
  }
}
registerProcessor('sixop', SixopProcessor);
