// Guided lessons: a light overlay that glows around the control to use next,
// says in one short line what to do, shows the live value against the goal,
// and moves on by itself the moment the instrument is in the right state.
// Steps check what the synth is doing, not which button was pressed, so any
// route to the right result counts, and a wrong turn shows how to get back.
import { LESSONS } from './lessons.js';


const el = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};
const SVGNS = 'http://www.w3.org/2000/svg';

export class Guide {
  constructor(app) {
    this.app = app;
    this.lesson = null; this.i = 0; this.doneAt = 0; this.okUntil = 0;
    this.layer = el('div', 'guide-layer', document.body);
    this.layer.hidden = true;
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'guide-dim');
    this.layer.appendChild(this.svg);
    this.rings = el('div', 'guide-rings', this.layer);
    this.card = el('div', 'guide-card', this.layer);
    this.card.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.launcher = el('button', 'guide-launch', document.body, '<span>?</span><b>Learn</b>');
    this.launcher.setAttribute('aria-label', 'Open lessons');
    this.launcher.addEventListener('click', () => (this.lesson ? this.stop() : this.menu()));
    window.addEventListener('resize', () => { this.lastKey = ''; });
    if (new URLSearchParams(location.search).get('guide')) setTimeout(() => this.menu(), 300);
  }

  // ------------------------------------------------------------ lifecycle
  menu() {
    this.lesson = null;
    this.layer.hidden = false; this.layer.classList.add('modal');
    this.clearHighlights();
    const items = LESSONS.map((l, n) => `
      <button class="g-lesson" data-n="${n}">
        <b>${l.title}</b><span>${l.blurb}</span><small>About ${l.minutes} minutes</small>
      </button>`).join('');
    this.card.className = 'guide-card centre';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">Lessons</span><button class="g-x" aria-label="Close">✕</button></div>
      <h2>Learn by making something</h2>
      <p>Pick a lesson. A glow shows what to touch, and it moves on by itself when you get it right.</p>
      ${items}`;
    this.card.querySelector('.g-x').onclick = () => this.stop();
    this.card.querySelectorAll('.g-lesson').forEach((b) => { b.onclick = () => this.intro(LESSONS[+b.dataset.n]); });
  }

  intro(lesson) {
    const busy = this.app.seqDump && this.app.seqDump.some((v, i) => i < 16 * 1032 && v !== 0 && (i % 16) < 4);
    this.card.className = 'guide-card centre';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">${lesson.title}</span><button class="g-x" aria-label="Close">✕</button></div>
      <h2>${lesson.title}</h2>
      <p>${lesson.intro}</p>
      ${busy ? '<p class="g-warn">This starts the sequencer from blank, so patterns already in it will be cleared.</p>' : ''}
      <div class="g-row"><button class="g-go">Start</button></div>`;
    this.card.querySelector('.g-x').onclick = () => this.stop();
    this.card.querySelector('.g-go').onclick = () => this.begin(lesson);
  }

  async begin(lesson) {
    this.lesson = lesson; this.i = 0;
    this.layer.classList.remove('modal');
    this.launcher.classList.add('on');
    if (lesson.setup) await lesson.setup(this.app);
    this.enter();
  }

  stop() {
    this.lesson = null;
    this.layer.hidden = true; this.layer.classList.remove('modal');
    this.launcher.classList.remove('on');
    this.clearHighlights();
  }

  enter() {
    const st = this.step();
    this.doneAt = 0; this.okUntil = 0; this.lastKey = ''; this.wrongShown = false;
    if (st && st.onEnter) st.onEnter(this.app, this);
    this.renderCard(true);
  }
  step() { return this.lesson && this.lesson.steps[this.i]; }
  go(d) {
    if (!this.lesson) return;
    this.i = Math.max(0, Math.min(this.lesson.steps.length - 1, this.i + d));
    this.enter();
  }

  // ------------------------------------------------------------ per frame
  tick() {
    if (!this.lesson) return;
    const st = this.step(), app = this.app, now = performance.now();
    if (!st) return;
    if (st.final) { this.place(this.targetsFor(st), st); return; }
    // the first unmet requirement takes over the card until it's put right
    const req = (st.requires || []).find((r) => !r.ok(app));
    const active = req || st;
    const ok = !req && st.done(app);
    this.active = active; this.activeReq = req;
    if (ok && !this.doneAt) {
      this.doneAt = now;
      this.okUntil = now + (st.quick ? 250 : 750);
      app.fb.saved && app.fb.saved();
    }
    if (!ok && this.doneAt && now < this.okUntil) { this.doneAt = 0; }
    if (this.doneAt && now >= this.okUntil) { this.i++; this.enter(); return; }
    this.renderCard(false, active, req, ok);
    this.place(this.targetsFor(active), active, ok);
  }

  targetsFor(st) {
    const sel = typeof st.target === 'function' ? st.target(this.app) : st.target;
    const list = [].concat(sel || []);
    return list.map((s) => document.querySelector(s)).filter(Boolean);
  }

  // ------------------------------------------------------------ drawing
  renderCard(force, active = this.step(), req = null, ok = false) {
    const st = this.step(); if (!st) return;
    const app = this.app;
    const live = active.now ? active.now(app) : '';
    const wrong = !ok && st.wrong && !req ? st.wrong(app) : '';
    const key = [this.i, req ? req.text : '', live, wrong, ok].join('|');
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const n = this.lesson.steps.length, pct = Math.round((this.i / (n - 1)) * 100);
    const text = typeof active.text === 'function' ? active.text(app) : active.text;
    const why = !req && st.why ? `<p class="g-why">${st.why}</p>` : '';
    const goal = !req && st.goal ? `<div class="g-goal"><span>Goal</span>${st.goal}</div>` : '';
    const nowLine = live ? `<div class="g-now ${ok ? 'ok' : ''}"><span>Now</span>${live}</div>` : '';
    const redo = st.redo && !req ? '<button class="g-redo">Redo this step</button>' : '';
    this.card.className = 'guide-card' + (ok ? ' ok' : '') + (req ? ' fix' : '') + (st.final ? ' centre' : '');
    this.card.innerHTML = `
      <div class="g-head">
        <span class="g-sec">${st.section || ''}</span>
        <span class="g-count">${this.i + 1} / ${n}</span>
        <button class="g-x" aria-label="Close lesson">✕</button>
      </div>
      <div class="g-bar"><i style="width:${pct}%"></i></div>
      ${req ? '<div class="g-oops">First:</div>' : ''}
      <h3>${ok ? '✓ ' : ''}${text}</h3>
      ${nowLine}${goal}${why}
      ${wrong ? `<p class="g-warn">${wrong}</p>` : ''}
      <div class="g-row">
        <button class="g-back" ${this.i === 0 ? 'disabled' : ''}>Back</button>
        ${redo}
        ${st.final ? '<button class="g-go g-end">Done</button>' : '<button class="g-skip">Skip</button>'}
      </div>`;
    this.card.querySelector('.g-x').onclick = () => this.stop();
    this.card.querySelector('.g-back').onclick = () => this.go(-1);
    const sk = this.card.querySelector('.g-skip'); if (sk) sk.onclick = () => this.go(1);
    const end = this.card.querySelector('.g-end'); if (end) end.onclick = () => this.stop();
    const rd = this.card.querySelector('.g-redo'); if (rd) rd.onclick = () => { st.redo(app); this.lastKey = ''; };
  }

  clearHighlights() { this.svg.innerHTML = ''; this.rings.innerHTML = ''; this.ringKey = ''; }

  // dim everything except the targets, ring each target, and park the card
  // where it covers neither the targets nor the screen
  place(targets, st, ok = false) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const rects = targets.map((t) => t.getBoundingClientRect());
    const hint = st.hint ? (typeof st.hint === 'function' ? st.hint(this.app) : st.hint) : '';
    const rk = rects.map((r) => [r.x, r.y, r.width, r.height].map(Math.round).join(',')).join(';') + '|' + hint + ok + vw + vh;
    if (rk !== this.ringKey) {
      this.ringKey = rk;
      const pad = 8;
      let holes = '';
      const scrEl = document.querySelector('.bezel');
      if (scrEl) { const r = scrEl.getBoundingClientRect(); holes += `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="24" fill="#000"/>`; }
      for (const r of rects) holes += `<rect x="${r.x - pad}" y="${r.y - pad}" width="${r.width + pad * 2}" height="${r.height + pad * 2}" rx="${Math.min(r.width, r.height) / 2 + pad}" fill="#000"/>`;
      this.svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
      this.svg.innerHTML = `<defs><mask id="g-mask"><rect width="${vw}" height="${vh}" fill="#fff"/>${holes}</mask></defs>
        <rect width="${vw}" height="${vh}" fill="rgba(20,14,8,.42)" mask="url(#g-mask)"/>`;
      this.rings.innerHTML = '';
      rects.forEach((r, n) => {
        const g = el('div', 'g-ring' + (ok ? ' ok' : ''), this.rings);
        g.style.left = r.x - pad + 'px'; g.style.top = r.y - pad + 'px';
        g.style.width = r.width + pad * 2 + 'px'; g.style.height = r.height + pad * 2 + 'px';
        g.style.borderRadius = Math.min(r.width, r.height) / 2 + pad + 'px';
        if (hint && n === 0) el('span', 'g-hint', g, hint);
      });
    }
    if (this.card.classList.contains('centre')) { this.card.style.left = ''; this.card.style.top = ''; return; }
    // card: try the corners and edges, keep clear of targets and the screen
    const cw = this.card.offsetWidth, ch = this.card.offsetHeight, m = 10, top = 52; // clear of the Learn button
    const scr = document.querySelector('.bezel');
    const lb = this.launcher.getBoundingClientRect();
    const avoid = rects.concat(scr ? [scr.getBoundingClientRect()] : [], [lb]);
    const spots = [
      [vw - cw - m, top], [m, top], [vw - cw - m, vh - ch - m], [m, vh - ch - m],
      [(vw - cw) / 2, vh - ch - m], [(vw - cw) / 2, top],
    ];
    const overlap = (x, y) => avoid.reduce((s, r) => {
      const ox = Math.max(0, Math.min(x + cw, r.right + 6) - Math.max(x, r.left - 6));
      const oy = Math.max(0, Math.min(y + ch, r.bottom + 6) - Math.max(y, r.top - 6));
      return s + ox * oy;
    }, 0);
    let best = spots[0], bestO = Infinity;
    for (const s of spots) { const o = overlap(s[0], s[1]); if (o < bestO) { bestO = o; best = s; } if (o === 0) break; }
    this.card.style.left = Math.max(m, best[0]) + 'px';
    this.card.style.top = Math.max(m, best[1]) + 'px';
  }
}

