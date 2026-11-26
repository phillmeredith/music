// Web MIDI (desktop Chrome/Edge/Firefox; iPad Safari has none). Notes, CCs,
// clock and bends go to the engine; SysEx and program changes are handled here.
export class Midi {
  constructor(app) { this.app = app; this.access = null; this.enabled = false; this.inputs = []; this.outputs = []; this.sysexBuf = null; }
  get supported() { return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess; }
  get connected() { return this.enabled && this.inputs.length + this.outputs.length > 0; }

  async enable() {
    if (!this.supported) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
    } catch {
      try { this.access = await navigator.requestMIDIAccess(); } catch { return false; }
    }
    this.enabled = true;
    this.access.onstatechange = () => this.scan();
    this.scan();
    return true;
  }
  disable() {
    for (const i of this.inputs) i.onmidimessage = null;
    this.enabled = false; this.inputs = []; this.outputs = [];
  }
  scan() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()];
    this.outputs = [...this.access.outputs.values()];
    for (const i of this.inputs) i.onmidimessage = (e) => this.onMessage(e.data);
    this.app.onMidiState && this.app.onMidiState();
  }
  onMessage(d) {
    if (!this.enabled) return;
    if (d[0] === 0xf0 || this.sysexBuf) {
      // some browsers deliver a SysEx message in pieces
      this.sysexBuf = this.sysexBuf ? concat(this.sysexBuf, d) : new Uint8Array(d);
      if (this.sysexBuf[this.sysexBuf.length - 1] === 0xf7) { const m = this.sysexBuf; this.sysexBuf = null; this.app.onSysex(m); }
      return;
    }
    for (let i = 0; i < d.length;) {
      const s = d[i];
      if (s >= 0xf8) { this.app.engine.midi([s]); i++; continue; }
      const type = s & 0xf0;
      const len = type === 0xc0 || type === 0xd0 ? 2 : 3;
      const msg = Array.from(d.subarray(i, i + len));
      i += len;
      if (type === 0xc0) { this.app.onProgramChange(s & 15, msg[1]); continue; }
      this.app.engine.midi(msg);
    }
  }
  send(bytes) { for (const o of this.outputs) try { o.send(bytes); } catch { /* port went away */ } }
}
const concat = (a, b) => { const u = new Uint8Array(a.length + b.length); u.set(a); u.set(b, a.length); return u; };
