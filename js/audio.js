// Main-thread side of the audio engine: AudioContext, worklet, messaging.
export class Engine {
  constructor() {
    this.ctx = null; this.node = null; this.ready = false;
    this.onstatus = null; this.pending = new Map(); this.seq = 1;
  }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    // keep sound on with the iPhone/iPad silent switch, where Safari supports it
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older Safari */ }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const wasm = await (await fetch(new URL('../engine.wasm', import.meta.url))).arrayBuffer();
    await this.ctx.audioWorklet.addModule(new URL('../worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'sixop', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { wasm },
    });
    this.out = this.ctx.createGain();
    this.node.connect(this.out).connect(this.ctx.destination);
    this.readyPromise = new Promise((res) => { this._ready = res; });
    this.node.port.onmessage = (e) => this.onMsg(e.data);
    if (this.ctx.state !== 'running') await this.ctx.resume();
    await this.readyPromise;
  }

  onMsg(m) {
    if (m.t === 'ready') { this.ready = true; this.rate = m.rate; this._ready(); return; }
    if (m.t === 'status') { this.onstatus && this.onstatus(m.s); return; }
    const cb = this.pending.get(m.id);
    if (cb) { this.pending.delete(m.id); cb(m); }
  }

  post(m, transfer) { if (this.node) this.node.port.postMessage(m, transfer || []); }
  set(id, v) { this.post({ t: 'set', id, v: v | 0 }); }
  sets(list) { this.post({ t: 'sets', list }); }
  key(n, v) { this.post({ t: 'key', n, v }); }
  midi(b) { this.post({ t: 'midi', b }); }
  noteOn(p, n, v) { this.post({ t: 'on', p, n, v }); }
  noteOff(p, n) { this.post({ t: 'off', p, n }); }
  panic() { this.post({ t: 'panic' }); }
  vced(p, data, live = true) { this.post({ t: 'vced', p, data: new Uint8Array(data), live }); }
  seqCmd(c, a = 0, b = 0) { this.post({ t: 'seqcmd', c, a, b }); }
  seqLoad(data) { this.post({ t: 'seqload', data: new Uint8Array(data) }); }
  request(m) {
    return new Promise((res) => {
      const id = this.seq++;
      this.pending.set(id, res);
      this.post({ ...m, id });
    });
  }
  async seqDump() { return (await this.request({ t: 'seqdump' })).data; }
  async get(ids) { return (await this.request({ t: 'get', ids })).vals; }
  get latencyMs() {
    if (!this.ctx) return 0;
    return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000;
  }
}
