// DX7 voice data: packed VMEM (128 bytes) <-> unpacked VCED (155 bytes), and SysEx.
// Layouts follow the public DX7 format as described in the build spec (4.1, 4.2, 5.2).

export const VCED_SIZE = 155;
export const VMEM_SIZE = 128;

export function vmemToVced(m) {
  const v = new Uint8Array(156);
  for (let op = 0; op < 6; op++) {
    const s = op * 17, d = op * 21;
    for (let i = 0; i < 11; i++) v[d + i] = m[s + i];
    v[d + 11] = m[s + 11] & 3;            // left curve
    v[d + 12] = (m[s + 11] >> 2) & 3;     // right curve
    v[d + 13] = m[s + 12] & 7;            // rate scaling
    v[d + 14] = m[s + 13] & 3;            // amp mod sens
    v[d + 15] = (m[s + 13] >> 2) & 7;     // key velocity sens
    v[d + 16] = m[s + 14];                // output level
    v[d + 17] = m[s + 15] & 1;            // osc mode
    v[d + 18] = (m[s + 15] >> 1) & 31;    // coarse
    v[d + 19] = m[s + 16];                // fine
    v[d + 20] = (m[s + 12] >> 3) & 15;    // detune
  }
  for (let i = 0; i < 8; i++) v[126 + i] = m[102 + i];
  v[134] = m[110] & 31;
  v[135] = m[111] & 7;
  v[136] = (m[111] >> 3) & 1;
  v[137] = m[112]; v[138] = m[113]; v[139] = m[114]; v[140] = m[115];
  v[141] = m[116] & 1;
  v[142] = (m[116] >> 1) & 7;
  v[143] = (m[116] >> 4) & 7;
  v[144] = m[117];
  for (let i = 0; i < 10; i++) v[145 + i] = m[118 + i];
  return v;
}

export function vcedToVmem(v) {
  const m = new Uint8Array(128);
  for (let op = 0; op < 6; op++) {
    const s = op * 21, d = op * 17;
    for (let i = 0; i < 11; i++) m[d + i] = v[s + i] & 127;
    m[d + 11] = ((v[s + 12] & 3) << 2) | (v[s + 11] & 3);
    m[d + 12] = ((v[s + 20] & 15) << 3) | (v[s + 13] & 7);
    m[d + 13] = ((v[s + 15] & 7) << 2) | (v[s + 14] & 3);
    m[d + 14] = v[s + 16] & 127;
    m[d + 15] = ((v[s + 18] & 31) << 1) | (v[s + 17] & 1);
    m[d + 16] = v[s + 19] & 127;
  }
  for (let i = 0; i < 8; i++) m[102 + i] = v[126 + i] & 127;
  m[110] = v[134] & 31;
  m[111] = ((v[136] & 1) << 3) | (v[135] & 7);
  m[112] = v[137] & 127; m[113] = v[138] & 127; m[114] = v[139] & 127; m[115] = v[140] & 127;
  m[116] = ((v[143] & 7) << 4) | ((v[142] & 7) << 1) | (v[141] & 1);
  m[117] = v[144] & 127;
  for (let i = 0; i < 10; i++) m[118 + i] = v[145 + i] & 127;
  return m;
}

export function voiceName(v, off = 145) {
  let s = '';
  for (let i = 0; i < 10; i++) { const c = v[off + i]; s += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; }
  return s.replace(/\s+$/, '');
}
export function setVoiceName(v, name, off = 145) {
  const n = (name || '').padEnd(10, ' ').slice(0, 10);
  for (let i = 0; i < 10; i++) { let c = n.charCodeAt(i); if (c < 32 || c > 126) c = 32; v[off + i] = c; }
}

export const checksum = (bytes) => {
  let sum = 0; for (const b of bytes) sum += b;
  return (128 - (sum & 0x7f)) & 0x7f;
};

// Find every DX7 bank / single voice inside a .syx file (it may hold several messages).
export function parseSysex(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const found = [];
  for (let i = 0; i < u.length; i++) {
    if (u[i] !== 0xf0) continue;
    let end = i + 1; while (end < u.length && u[end] !== 0xf7) end++;
    const msg = u.subarray(i, end + 1);
    i = end;
    if (msg[1] !== 0x43) continue;
    const fmt = msg[3];
    if (fmt === 0x09 && msg.length >= 4104) {
      const data = msg.subarray(6, 6 + 4096);
      const ok = checksum(data) === msg[6 + 4096];
      const voices = [];
      for (let k = 0; k < 32; k++) voices.push(new Uint8Array(data.subarray(k * 128, k * 128 + 128)));
      found.push({ type: 'bank', voices, checksumOk: ok });
    } else if (fmt === 0x00) {
      // F0 43 0n 00 01 1B <155> cs F7 (the 01 1B byte count, as some tools omit 01)
      const start = msg[4] === 0x01 && msg[5] === 0x1b ? 6 : (msg[4] === 0x1b ? 5 : -1);
      if (start < 0 || msg.length < start + 156) continue;
      const data = msg.subarray(start, start + 155);
      found.push({ type: 'voice', vced: new Uint8Array([...data, 0]), checksumOk: checksum(data) === msg[start + 155] });
    } else if ((msg[2] & 0xf0) === 0x10 && msg.length === 7) {
      found.push({ type: 'param', group: msg[3], addr: ((msg[3] & 3) << 7) | msg[4], value: msg[5] });
    }
  }
  return found;
}

// raw bank files with no SysEx wrapper (4096 bytes)
export function parseRawBank(buf) {
  const u = new Uint8Array(buf);
  if (u.length !== 4096) return null;
  const voices = [];
  for (let k = 0; k < 32; k++) voices.push(new Uint8Array(u.subarray(k * 128, k * 128 + 128)));
  return { type: 'bank', voices, checksumOk: true };
}

export function buildBankSysex(vmems, channel = 0) {
  const data = new Uint8Array(4096);
  vmems.forEach((m, k) => data.set(m.subarray(0, 128), k * 128));
  const out = new Uint8Array(4104);
  out.set([0xf0, 0x43, channel & 15, 0x09, 0x20, 0x00]);
  out.set(data, 6);
  out[4102] = checksum(data);
  out[4103] = 0xf7;
  return out;
}

export function buildVoiceSysex(vced, channel = 0) {
  const data = vced.subarray(0, 155);
  const out = new Uint8Array(163);
  out.set([0xf0, 0x43, channel & 15, 0x00, 0x01, 0x1b]);
  out.set(data, 6);
  out[161] = checksum(data);
  out[162] = 0xf7;
  return out;
}

// VCED offsets used by the editor
export const OPF = { R1: 0, R2: 1, R3: 2, R4: 3, L1: 4, L2: 5, L3: 6, L4: 7, BP: 8, LD: 9, RD: 10, LC: 11, RC: 12, RS: 13, AMS: 14, KVS: 15, OL: 16, MODE: 17, COARSE: 18, FINE: 19, DET: 20 };
export const G = { PR1: 126, PL1: 130, ALG: 134, FB: 135, OKS: 136, LFS: 137, LFD: 138, PMD: 139, AMD: 140, LKS: 141, WAVE: 142, PMS: 143, TRNP: 144 };
// UI operator n (1..6) lives at memory index 6-n
export const opOff = (n) => (6 - n) * 21;

// Algorithm graphs for the screen: for each algorithm, carriers and modulation edges (1-based ops)
export const ALGOS = [
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 4], [6, 5]], fb: 6 },
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 4], [6, 5]], fb: 2 },
  { c: [1, 4], e: [[2, 1], [3, 2], [5, 4], [6, 5]], fb: 6 },
  { c: [1, 4], e: [[2, 1], [3, 2], [5, 4], [6, 5]], fb: [6, 4] },
  { c: [1, 3, 5], e: [[2, 1], [4, 3], [6, 5]], fb: 6 },
  { c: [1, 3, 5], e: [[2, 1], [4, 3], [6, 5]], fb: [6, 5] },
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 3], [6, 5]], fb: 6 },
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 3], [6, 5]], fb: 4 },
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 3], [6, 5]], fb: 2 },
  { c: [1, 4], e: [[2, 1], [3, 2], [5, 4], [6, 4]], fb: 3 },
  { c: [1, 4], e: [[2, 1], [3, 2], [5, 4], [6, 4]], fb: 6 },
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 3], [6, 3]], fb: 2 },
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 3], [6, 3]], fb: 6 },
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 4], [6, 4]], fb: 6 },
  { c: [1, 3], e: [[2, 1], [4, 3], [5, 4], [6, 4]], fb: 2 },
  { c: [1], e: [[2, 1], [3, 1], [4, 3], [5, 1], [6, 5]], fb: 6 },
  { c: [1], e: [[2, 1], [3, 1], [4, 3], [5, 1], [6, 5]], fb: 2 },
  { c: [1], e: [[2, 1], [3, 1], [4, 1], [5, 4], [6, 5]], fb: 3 },
  { c: [1, 4, 5], e: [[2, 1], [3, 2], [6, 4], [6, 5]], fb: 6 },
  { c: [1, 2, 4], e: [[3, 1], [3, 2], [5, 4], [6, 4]], fb: 3 },
  { c: [1, 2, 4, 5], e: [[3, 1], [3, 2], [6, 4], [6, 5]], fb: 3 },
  { c: [1, 3, 4, 5], e: [[2, 1], [6, 3], [6, 4], [6, 5]], fb: 6 },
  { c: [1, 2, 4, 5], e: [[3, 2], [6, 4], [6, 5]], fb: 6 },
  { c: [1, 2, 3, 4, 5], e: [[6, 3], [6, 4], [6, 5]], fb: 6 },
  { c: [1, 2, 3, 4, 5], e: [[6, 4], [6, 5]], fb: 6 },
  { c: [1, 2, 4], e: [[3, 2], [5, 4], [6, 4]], fb: 6 },
  { c: [1, 2, 4], e: [[3, 2], [5, 4], [6, 4]], fb: 3 },
  { c: [1, 3, 6], e: [[2, 1], [4, 3], [5, 4]], fb: 5 },
  { c: [1, 2, 3, 5], e: [[4, 3], [6, 5]], fb: 6 },
  { c: [1, 2, 3, 6], e: [[4, 3], [5, 4]], fb: 5 },
  { c: [1, 2, 3, 4, 5], e: [[6, 5]], fb: 6 },
  { c: [1, 2, 3, 4, 5, 6], e: [], fb: 6 },
];
