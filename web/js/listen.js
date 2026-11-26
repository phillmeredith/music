// Listen to a YouTube video while it plays in the app. The video plays in
// YouTube's own embedded player; the app hears it through the microphone
// (iPad) or, on a computer, by sharing this tab's sound, which is cleaner.
// Nothing is downloaded from YouTube.

export function youtubeId(url) {
  const m = String(url).trim().match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/) || String(url).trim().match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

let apiReady = null;
function loadApi() {
  if (apiReady) return apiReady;
  apiReady = new Promise((res, rej) => {
    if (window.YT && window.YT.Player) return res(window.YT);
    window.onYouTubeIframeAPIReady = () => res(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiReady = null; rej(new Error('Could not reach YouTube. Are you online?')); };
    document.head.appendChild(s);
  });
  return apiReady;
}

export async function makePlayer(el, id, onState) {
  const YT = await loadApi();
  return await new Promise((res) => {
    const p = new YT.Player(el, {
      videoId: id, width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: { onReady: () => res(p), onStateChange: (e) => onState && onState(e.data) },
    });
  });
}

// can this browser capture the tab's own sound?
export const canShareTab = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !/iPad|iPhone|iPod/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

// record from the mic or the shared tab into an AudioBuffer
export class Recorder {
  constructor(ctx) { this.ctx = ctx; this.chunks = []; this.level = 0; }
  async start(useTab) {
    if (useTab) {
      this.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, preferCurrentTab: true, selfBrowserSurface: 'include' });
      if (!this.stream.getAudioTracks().length) { this.stop(); throw new Error('No sound was shared. Choose this tab and turn on “Share tab audio”.'); }
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(x));
      let m = 0; for (let i = 0; i < x.length; i += 16) m = Math.max(m, Math.abs(x[i]));
      this.level = this.level * 0.7 + m * 0.3;
    };
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.src.connect(this.proc); this.proc.connect(mute); mute.connect(this.ctx.destination);
    this.t0 = performance.now();
  }
  get seconds() { return this.t0 ? (performance.now() - this.t0) / 1000 : 0; }
  stop() {
    try { this.proc && this.proc.disconnect(); this.src && this.src.disconnect(); } catch { /* gone */ }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.proc = null;
    const n = this.chunks.reduce((s, c) => s + c.length, 0);
    if (!n) return null;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    let o = 0; for (const c of this.chunks) { ch.set(c, o); o += c.length; }
    this.chunks = [];
    return buf;
  }
}
