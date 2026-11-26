// 240 x 240 display renderer. Layout follows the stock screen (header, 2x2
// parameter tiles for Knob 1-4, footer pill), drawn in Sixop's own style.
import { ALGOS } from './dx7.js';

export const SCREEN_THEMES = [
  { name: 'Amber', bg: '#15110c', widget: '#2a2219', widgetOn: '#e8a33d', footer: '#3a2e20', wave: '#ffb347', text: '#f6e6cc', dim: '#8d7a60', border: '#4a3b28', accent: '#ff7a2f', textOn: '#1b130a' },
  { name: 'Ice', bg: '#0b1218', widget: '#16222d', widgetOn: '#7cc8ff', footer: '#1f3040', wave: '#8fe3ff', text: '#e3f2ff', dim: '#6f8799', border: '#2b4155', accent: '#5ad1ff', textOn: '#06121c' },
  { name: 'Moss', bg: '#0e140d', widget: '#1c2619', widgetOn: '#a8d672', footer: '#263421', wave: '#b9f27c', text: '#e8f5dc', dim: '#7b8f6c', border: '#34472d', accent: '#c6f06a', textOn: '#0f170c' },
  { name: 'Paper', bg: '#efe9dc', widget: '#ddd4c2', widgetOn: '#2b2a28', footer: '#cfc4ae', wave: '#c2481e', text: '#2b2724', dim: '#8a8174', border: '#b9ad97', accent: '#d8501f', textOn: '#f3ede1' },
];

const FONT = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';

export class Screen {
  constructor(canvas) { this.c = canvas; this.g = canvas.getContext('2d'); this.theme = SCREEN_THEMES[0]; }
  setTheme(i) { this.theme = SCREEN_THEMES[i % SCREEN_THEMES.length]; }

  begin() {
    const g = this.g, s = this.c.width / 240;
    g.setTransform(s, 0, 0, s, 0, 0);
    g.fillStyle = this.theme.bg; g.fillRect(0, 0, 240, 240);
    g.textBaseline = 'middle';
  }
  text(str, x, y, size = 12, color = this.theme.text, align = 'left', weight = 600) {
    const g = this.g; g.font = `${weight} ${size}px ${FONT}`; g.fillStyle = color; g.textAlign = align; g.fillText(str, x, y);
  }
  rrect(x, y, w, h, r, fill, stroke) {
    const g = this.g; g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  }

  header(h) {
    const t = this.theme;
    this.text(String(h.num).padStart(3, '0'), 8, 14, 13, t.accent, 'left', 700);
    this.text((h.name || '') + (h.edited ? '*' : ''), 38, 14, 13, t.text, 'left', 700);
    let x = 232;
    for (const ic of h.icons || []) {
      this.rrect(x - ic.length * 6 - 6, 6, ic.length * 6 + 6, 15, 4, t.widget, t.border);
      this.text(ic, x - 3, 14, 9, t.dim, 'right', 700);
      x -= ic.length * 6 + 10;
    }
    this.g.fillStyle = t.border; this.g.fillRect(6, 26, 228, 1);
  }

  footer(text, sub) {
    const t = this.theme;
    this.rrect(30, 214, 180, 20, 10, t.footer, t.border);
    this.text(text || '', 120, 224, 11, t.text, 'center', 700);
    if (sub) this.text(sub, 232, 224, 9, t.dim, 'right');
  }

  tiles(list) {
    const t = this.theme;
    const pos = [[8, 34], [122, 34], [8, 124], [122, 124]];
    list.forEach((p, i) => {
      if (!p) return;
      const [x, y] = pos[i], w = 110, h = 84;
      const on = p.active !== false;
      this.rrect(x, y, w, h, 8, on ? t.widget : t.bg, on ? t.border : t.widget);
      this.text(String(i + 1), x + 9, y + 12, 9, t.accent, 'left', 800);
      this.text(p.label || '', x + 20, y + 12, 10, on ? t.dim : t.widget, 'left', 700);
      const val = p.value == null ? '' : String(p.value);
      const size = val.length > 8 ? 13 : val.length > 5 ? 17 : 24;
      this.text(val, x + w / 2, y + 44, size, on ? t.text : t.widget, 'center', 800);
      if (p.bar != null && on) {
        this.rrect(x + 10, y + h - 15, w - 20, 5, 2.5, t.bg);
        if (p.bipolar) {
          const mid = x + w / 2, half = (w - 20) / 2, v = (p.bar - 0.5) * 2;
          this.g.fillStyle = t.wave;
          this.g.fillRect(v >= 0 ? mid : mid + v * half, y + h - 15, Math.abs(v) * half, 5);
          this.g.fillStyle = t.dim; this.g.fillRect(mid - 0.5, y + h - 17, 1, 9);
        } else {
          this.rrect(x + 10, y + h - 15, Math.max(5, (w - 20) * p.bar), 5, 2.5, t.wave);
        }
      }
      if (p.hint) this.text(p.hint, x + w / 2, y + h - 22, 8, t.dim, 'center');
    });
  }

  scope(data, label) {
    const t = this.theme, g = this.g;
    this.rrect(8, 34, 224, 172, 8, t.widget, t.border);
    g.strokeStyle = t.border; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(8 + i * 56, 38); g.lineTo(8 + i * 56, 202); g.stroke(); }
    g.beginPath(); g.moveTo(12, 120); g.lineTo(228, 120); g.stroke();
    if (data) {
      let pk = 0; for (const v of data) pk = Math.max(pk, Math.abs(v));
      const gain = pk > 0.0005 ? Math.min(70 / pk, 1400) : 1;
      g.strokeStyle = t.wave; g.lineWidth = 1.6; g.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = 12 + (i / (data.length - 1)) * 216, y = 120 - data[i] * gain;
        if (i) g.lineTo(x, Math.max(38, Math.min(202, y))); else g.moveTo(x, y);
      }
      g.stroke();
    }
    if (label) this.text(label, 14, 46, 9, t.dim);
  }

  fxGrid(fx, sel, grabbed, names, group) {
    const t = this.theme;
    for (let pos = 0; pos < 6; pos++) {
      const e = fx.order[pos];
      const x = 8 + (pos % 3) * 76, y = 40 + Math.floor(pos / 3) * 80, w = 70, h = 66;
      const on = fx.params[e][0];
      this.rrect(x, y, w, h, 8, on ? t.widgetOn : t.widget, pos === sel ? t.accent : t.border);
      if (grabbed && pos === sel) { this.g.setLineDash([3, 3]); this.rrect(x - 3, y - 3, w + 6, h + 6, 10, null, t.accent); this.g.setLineDash([]); }
      this.text(names[e].slice(0, 6), x + w / 2, y + 26, 11, on ? t.textOn : t.text, 'center', 800);
      this.text(on ? 'ON' : 'OFF', x + w / 2, y + 46, 9, on ? t.textOn : t.dim, 'center', 700);
      this.text(String(pos + 1), x + 7, y + 10, 8, on ? t.textOn : t.dim);
      if (pos === sel) { this.g.fillStyle = '#e04a3a'; this.g.beginPath(); this.g.arc(x + w / 2, y + h + 6, 3, 0, 7); this.g.fill(); }
    }
    this.text(group, 120, 34, 9, t.dim, 'center', 700);
  }

  algo(n, opmask = 63, sel = 0) {
    const t = this.theme, g = this.g, a = ALGOS[n];
    this.rrect(8, 34, 224, 172, 8, t.widget, t.border);
    this.text('ALG ' + (n + 1), 16, 46, 11, t.accent, 'left', 800);
    // lay out: carriers on the bottom row, modulators stacked above their targets
    const level = {}; const posX = {};
    const depth = (op, seen = new Set()) => {
      if (seen.has(op)) return 0; seen.add(op);
      const outs = a.e.filter((e) => e[0] === op).map((e) => e[1]);
      if (!outs.length) return 0;
      return 1 + Math.max(...outs.map((o) => depth(o, seen)));
    };
    for (let op = 1; op <= 6; op++) level[op] = depth(op);
    const rows = {}; for (let op = 1; op <= 6; op++) (rows[level[op]] = rows[level[op]] || []).push(op);
    const maxL = Math.max(...Object.keys(rows).map(Number));
    for (const L in rows) {
      const ops = rows[L].sort((p, q) => p - q);
      ops.forEach((op, i) => { posX[op] = 120 + (i - (ops.length - 1) / 2) * 34; });
    }
    const Y = (op) => 182 - level[op] * (120 / Math.max(maxL, 1)) * (maxL > 3 ? 1 : 0.8);
    g.strokeStyle = t.dim; g.lineWidth = 1.5;
    for (const [m, c] of a.e) { g.beginPath(); g.moveTo(posX[m], Y(m) + 9); g.lineTo(posX[c], Y(c) - 9); g.stroke(); }
    const fbs = Array.isArray(a.fb) ? a.fb : [a.fb, a.fb];
    g.strokeStyle = t.accent;
    g.beginPath(); g.moveTo(posX[fbs[0]] + 12, Y(fbs[0])); g.lineTo(posX[fbs[0]] + 18, Y(fbs[0]));
    g.lineTo(posX[fbs[0]] + 18, Y(fbs[1]) - 15); g.lineTo(posX[fbs[1]], Y(fbs[1]) - 15); g.lineTo(posX[fbs[1]], Y(fbs[1]) - 9); g.stroke();
    for (let op = 1; op <= 6; op++) {
      const on = opmask & (1 << (op - 1));
      const carrier = a.c.includes(op);
      this.rrect(posX[op] - 12, Y(op) - 9, 24, 18, 4, carrier ? t.widgetOn : t.bg, op === sel ? t.accent : t.border);
      this.text(String(op), posX[op], Y(op), 11, carrier ? t.textOn : (on ? t.text : t.dim), 'center', 800);
      if (!on) { g.strokeStyle = '#e04a3a'; g.beginPath(); g.moveTo(posX[op] - 10, Y(op) + 7); g.lineTo(posX[op] + 10, Y(op) - 7); g.stroke(); }
    }
    g.strokeStyle = t.dim; g.beginPath(); g.moveTo(40, 196); g.lineTo(200, 196); g.stroke();
  }

  list(title, items, sel, opts = {}) {
    const t = this.theme;
    this.rrect(14, 32, 212, 176, 10, t.widget, t.accent);
    this.text(title, 24, 46, 10, t.accent, 'left', 800);
    const rows = opts.rows || 7, start = Math.max(0, Math.min(sel - Math.floor(rows / 2), items.length - rows));
    for (let r = 0; r < rows && start + r < items.length; r++) {
      const i = start + r, y = 66 + r * 20, it = items[i];
      const label = typeof it === 'string' ? it : it.label;
      const dim = typeof it === 'object' && it.dim;
      if (i === sel) this.rrect(20, y - 9, 200, 18, 5, t.widgetOn);
      this.text(label, 28, y, 11, i === sel ? t.textOn : (dim ? t.dim : t.text), 'left', 700);
    }
  }

  seqGrid(v) {
    const t = this.theme;
    const n = v.length, cols = 16, rows = Math.ceil(n / cols);
    const cw = 13, ch = Math.min(30, Math.floor(150 / Math.max(rows, 1)));
    const x0 = 120 - (cols * cw) / 2, y0 = 44;
    for (let i = 0; i < n; i++) {
      const x = x0 + (i % cols) * cw, y = y0 + Math.floor(i / cols) * (ch + 4);
      const s = v.steps[i];
      const has = s && s.notes.length, tied = s && s.tied;
      const fill = i === v.play ? t.accent : has ? t.widgetOn : tied ? t.dim : t.widget;
      this.rrect(x + 1, y, cw - 2, ch, 2, fill, i === v.cursor ? t.text : null);
      if (s && s.ratchet > 1) this.text('×' + s.ratchet, x + cw / 2, y + ch - 5, 6, t.textOn, 'center');
    }
    if (v.info) this.text(v.info, 120, 34, 9, t.dim, 'center', 700);
  }

  arrangement(v) {
    const t = this.theme;
    this.text('ARRANGE', 14, 40, 9, t.accent, 'left', 800);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const row = v.row0 + r, col = v.col0 + c;
      const x = 34 + c * 50, y = 52 + r * 38;
      const cell = v.cells[row][col];
      const beyond = col >= v.len, rowOff = !v.rowOn[row];
      const selected = row === v.selRow && col === v.selCol;
      const playing = col === v.playCol;
      this.rrect(x, y, 46, 32, 5, beyond || rowOff ? t.bg : (cell >= 0 ? t.widgetOn : t.widget), selected ? t.accent : (playing ? t.wave : t.border));
      if (cell >= 0) this.text('P' + (cell + 1), x + 23, y + 16, 11, beyond || rowOff ? t.dim : t.textOn, 'center', 800);
      if (c === 0) this.text('V' + (row + 1), 14, y + 16, 9, t.dim);
    }
  }

  rename(name, cursor, title) {
    const t = this.theme;
    this.rrect(14, 60, 212, 100, 10, t.widget, t.accent);
    this.text(title || 'RENAME', 24, 76, 10, t.accent, 'left', 800);
    const s = name.padEnd(10, ' ');
    for (let i = 0; i < 10; i++) {
      const x = 30 + i * 18;
      if (i === cursor) this.rrect(x - 7, 98, 16, 24, 3, t.widgetOn);
      this.text(s[i] === ' ' ? '·' : s[i], x + 1, 111, 15, i === cursor ? t.textOn : t.text, 'center', 800);
    }
    this.text('SELECT moves · Knob 1 letter · SAVE ok', 120, 146, 8, t.dim, 'center');
  }

  toast(msg) {
    const t = this.theme;
    this.g.fillStyle = 'rgba(0,0,0,0.45)'; this.g.fillRect(0, 0, 240, 240);
    const w = Math.min(220, 24 + msg.length * 7.4);
    this.rrect(120 - w / 2, 100, w, 40, 10, t.widgetOn);
    this.text(msg, 120, 120, 12, t.textOn, 'center', 800);
  }

  boot(progress) {
    const t = this.theme;
    this.begin();
    this.text('SIXOP', 120, 104, 30, t.accent, 'center', 900);
    this.text('six-operator FM', 120, 132, 11, t.dim, 'center', 600);
    this.rrect(60, 156, 120, 6, 3, t.widget);
    this.rrect(60, 156, Math.max(6, 120 * progress), 6, 3, t.wave);
  }
}
