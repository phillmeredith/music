// Guided lessons: a light overlay that glows around the control to use next,
// says in one short line what to do, shows the live value against the goal,
// and moves on by itself the moment the instrument is in the right state.
// Steps check what the synth is doing, not which button was pressed, so any
// route to the right result counts, and a wrong turn shows how to get back.
import { LESSONS } from './lessons.js';
import { P } from './params.js';
import { tryAgain, playPatterns } from './guide-kit.js';
import { SongLesson, makeSong, events, parseMidi, sequencerToSong, loadSongs, saveSong, deleteSong, syncSongs, unlockLibrary, libraryState } from './song.js';
import { BUILTIN_SONGS } from './songs-builtin.js';
import { decodeFile, transcribe } from './transcribe.js';
import { youtubeId, makePlayer, canShareTab, Recorder } from './listen.js';


const el = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};
const SVGNS = 'http://www.w3.org/2000/svg';

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
    // each new card starts at the top of the screen
    new MutationObserver(() => { this.card.scrollTop = 0; }).observe(this.card, { childList: true });
    // hold the eye to see the real screen under the card
    this.peek = el('button', 'g-peek', this.layer, '👁');
    this.peek.setAttribute('aria-label', 'Hold to see the screen');
    const peek = (on) => (e) => { e.preventDefault(); e.stopPropagation(); this.card.classList.toggle('peeking', on); };
    this.peek.addEventListener('pointerdown', peek(true));
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => this.peek.addEventListener(t, peek(false)));
    this.launcher = el('button', 'guide-launch', document.body, '<b>Learn</b>');
    this.launcher.setAttribute('aria-label', 'Open lessons');
    this.launcher.addEventListener('click', () => (this.lesson || this.songLesson ? this.stop() : this.menu()));
    // the same Learn button, drawn on the device screen before power-on (app.draw paints it)
    const bez = document.querySelector('.bezel');
    this.screenBtn = el('button', 'screen-learn', bez || document.body);
    this.screenBtn.setAttribute('aria-label', 'Learn: open lessons');
    this.screenBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.screenBtn.addEventListener('click', () => this.menu());
    window.addEventListener('resize', () => { this.lastKey = ''; });
    if (new URLSearchParams(location.search).get('guide')) setTimeout(() => this.menu(), 300);
  }

  // ------------------------------------------------------------ lifecycle
  menu(sync = true) {
    if (sync) syncSongs().then((changed) => { if (this.onMenu() && (changed || libraryState !== this.shownState)) this.menu(false); });
    this.endSong();
    this.lesson = null;
    this.layer.hidden = false; this.layer.classList.add('modal');
    this.clearHighlights();
    const songs = [...BUILTIN_SONGS.map((x) => ({ ...x, builtin: true })), ...loadSongs()];
    const lessons = LESSONS.map((l, n) => `
      <button class="g-lesson" data-n="${n}">
        <b>${l.title}</b><span>${l.blurb}</span><small>About ${l.minutes} minutes</small>
      </button>`).join('');
    const songItems = songs.map((x, n) => `
      <div class="g-songrow"><button class="g-lesson g-song" data-n="${n}">
        <b>${esc(x.title)}</b><span>${esc(x.blurb || (x.source ? 'From ' + x.source : 'Your song'))}${x.pending ? ' · not shared yet' : ''}</span>
      </button>${x.builtin ? '' : `<button class="g-del" data-n="${n}" aria-label="Delete ${esc(x.title)}">🗑</button>`}</div>`).join('');
    this.shownState = libraryState;
    const lib = libraryState === 'locked'
      ? `<div class="g-lock"><b>Shared songs</b><span>Enter the family code once on this device to see everyone's songs.</span>
          <div class="g-row"><input class="g-code" placeholder="code" autocomplete="off" autocapitalize="off"><button class="g-go g-unlock">Unlock</button></div></div>`
      : libraryState === 'offline' ? '<p class="g-why">Offline: showing the songs saved on this iPad.</p>' : '';
    this.card.className = 'guide-card centre';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">Lessons</span><button class="g-x" aria-label="Close">✕</button></div>
      <h2>Learn by making something</h2>
      <p class="g-why">A glow shows what to touch, and it moves on by itself when you get it right.</p>
      <h4>Make a beat</h4>${lessons}
      <h4>Learn a song</h4>${lib}${songItems}
      <h4>Add a song</h4>
      <div class="g-add">
        <button data-a="audio">🎵<b>Music file</b><small>MP3, M4A, WAV</small></button>
        <button data-a="youtube">▶︎<b>YouTube</b><small>paste a link</small></button>
        <button data-a="midi">🎹<b>MIDI file</b><small>exact notes</small></button>
        <button data-a="seq">▦<b>My beat</b><small>from the sequencer</small></button>
      </div>`;
    this.card.querySelector('.g-x').onclick = () => this.stop();
    this.card.querySelectorAll('.g-lesson:not(.g-song)').forEach((b) => { b.onclick = () => this.intro(LESSONS[+b.dataset.n]); });
    this.card.querySelectorAll('.g-song').forEach((b) => { b.onclick = () => this.startSong(songs[+b.dataset.n]); });
    this.card.querySelectorAll('.g-del').forEach((b) => {
      b.onclick = async () => {
        const song = songs[+b.dataset.n];
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sure?'; b.classList.add('sure'); return; }
        b.disabled = true;
        if (!(await deleteSong(song))) { b.textContent = '!'; return; }
        this.menu();
      };
    });
    const ub = this.card.querySelector('.g-unlock');
    if (ub) ub.onclick = async () => {
      const inp = this.card.querySelector('.g-code'); ub.disabled = true;
      if (await unlockLibrary(inp.value)) this.menu();
      else { ub.disabled = false; inp.value = ''; inp.placeholder = 'not right, try again'; }
    };
    this.card.querySelectorAll('.g-add button').forEach((b) => { b.onclick = () => this.add(b.dataset.a); });
  }

  onMenu() { return !this.layer.hidden && !this.lesson && !this.songLesson && !!this.card.querySelector('.g-add'); }

  // ------------------------------------------------------------ songs
  async ensurePower() { if (!this.app.powered) await this.app.powerOn(); }
  async startSong(song) {
    await this.ensurePower();
    this.endSong();
    this.lesson = null;
    this.layer.hidden = false; this.layer.classList.remove('modal');
    this.clearHighlights();
    this.launcher.classList.add('on');
    if (song.voice != null) this.app.store.loadPreset(this.app.cur, song.voice);
    this.songLesson = new SongLesson(this.app, this.card, song, () => this.stop());
    this.songLesson.start();
  }
  endSong() { if (this.songLesson) { this.songLesson.stop(); this.songLesson = null; } }

  working(title, text, pct, cancel) {
    this.layer.hidden = false; this.layer.classList.add('modal');
    this.card.className = 'guide-card centre';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">${title}</span><button class="g-x" aria-label="Close">✕</button></div>
      <h3>${text}</h3>
      ${pct != null ? `<div class="g-bar big"><i style="width:${Math.round(pct * 100)}%"></i></div>` : ''}
      <p class="g-why">Working this out on the iPad. Nothing is uploaded.</p>`;
    this.card.querySelector('.g-x').onclick = cancel || (() => this.menu());
  }
  fail(err) {
    this.card.className = 'guide-card centre';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">Add a song</span><button class="g-x" aria-label="Close">✕</button></div>
      <h3>That didn't work</h3><p class="g-warn">${(err && err.message) || err}</p>
      <div class="g-row"><button class="g-go">Back</button></div>`;
    this.card.querySelector('.g-x').onclick = () => this.menu();
    this.card.querySelector('.g-go').onclick = () => this.menu();
  }

  pickFile(accept) {
    return new Promise((res) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = accept;
      inp.onchange = () => res(inp.files[0] || null);
      inp.click();
    });
  }
  niceTitle(name) { return String(name || 'My song').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 40); }

  async add(kind) {
    const power = this.ensurePower(); // start sound inside this tap, then open the picker in the same tap
    try {
      if (kind === 'audio') {
        const pick = this.pickFile('audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac');
        await power;
        const f = await pick; if (!f) return;
        this.working('Music file', 'Reading the file…');
        const buf = await decodeFile(this.app.engine.ctx, f);
        return this.fromAudio(buf, this.niceTitle(f.name), 'a music file');
      }
      if (kind === 'midi') {
        const pick = this.pickFile('.mid,.midi,audio/midi,audio/x-midi');
        await power;
        const f = await pick; if (!f) return;
        const m = parseMidi(await f.arrayBuffer());
        if (!m.tracks.length) throw new Error('No notes found in that MIDI file.');
        return this.pickTrack(m, this.niceTitle(f.name));
      }
      await power;
      if (kind === 'seq') {
        await this.app.refreshSeqVals();
        const song = sequencerToSong(this.app, 'My beat ' + new Date().toLocaleDateString());
        if (!song) throw new Error('The sequencer is empty. Record something first.');
        return this.review(song);
      }
      if (kind === 'youtube') return this.youtube();
    } catch (err) { this.fail(err); }
  }

  pickTrack(m, title) {
    const tracks = m.tracks.map((t, i) => ({ ...t, i })).sort((a, b) => b.notes.length - a.notes.length);
    this.card.className = 'guide-card centre';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">MIDI file</span><button class="g-x" aria-label="Close">✕</button></div>
      <h3>Which part do you want to learn?</h3>
      ${tracks.map((t) => `<button class="g-lesson g-tr" data-i="${t.i}"><b>${t.name}</b><small>${t.notes.length} notes</small></button>`).join('')}
      <button class="g-lesson g-tr" data-i="all"><b>Everything together</b><small>all parts at once</small></button>`;
    this.card.querySelector('.g-x').onclick = () => this.menu();
    this.card.querySelectorAll('.g-tr').forEach((b) => {
      b.onclick = () => {
        const notes = b.dataset.i === 'all' ? m.tracks.flatMap((t) => t.notes) : m.tracks[+b.dataset.i].notes;
        const song = makeSong(title, notes, m.bpm, 'a MIDI file');
        if (!song) return this.fail('That part has no notes.');
        this.review(song);
      };
    });
  }

  async fromAudio(buf, title, source) {
    let cancelled = false;
    this.working(title, 'Listening for notes…', 0, () => { cancelled = true; this.menu(); });
    const notes = await transcribe(buf, {
      melodyOnly: this.melodyOnly !== false,
      onProgress: (p) => { if (!cancelled) { const i = this.card.querySelector('.g-bar i'); if (i) i.style.width = Math.round(p * 100) + '%'; } },
    });
    if (cancelled) return;
    const song = makeSong(title, notes, null, source);
    if (!song) throw new Error('No notes could be heard. Try a song with a clear tune, like a piano version.');
    song.audio = buf; // kept for "try again with chords"
    this.review(song);
  }

  // check the result, name it, keep it
  review(song) {
    const ev = events(song);
    const len = song.notes.length ? song.notes[song.notes.length - 1].t : 0;
    this.card.className = 'guide-card centre';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">New song</span><button class="g-x" aria-label="Close">✕</button></div>
      <h3>Found ${ev.length} notes to play</h3>
      <p class="g-why">${Math.round(len)} seconds of music at about ${song.bpm} beats a minute.</p>
      <label class="g-field">Name<input class="g-name" maxlength="40" value="${song.title.replace(/"/g, '')}"></label>
      ${song.audio ? `<label class="g-check"><input type="checkbox" class="g-chords" ${this.melodyOnly === false ? 'checked' : ''}> Include chords (harder)</label>` : ''}
      <div class="g-row"><button class="g-hear">Hear it</button><button class="g-go g-keep">Learn it</button></div>`;
    const name = this.card.querySelector('.g-name');
    this.card.querySelector('.g-x').onclick = () => { this.app.engine.panic(); this.menu(); };
    const ch = this.card.querySelector('.g-chords');
    if (ch) ch.onchange = () => { this.melodyOnly = !ch.checked; this.fromAudio(song.audio, name.value || song.title, song.source).catch((e) => this.fail(e)); };
    this.card.querySelector('.g-hear').onclick = () => this.preview(song);
    this.card.querySelector('.g-keep').onclick = () => {
      this.app.engine.panic(); clearTimeout(this.prevT);
      const keep = { title: (name.value || song.title).trim() || 'My song', bpm: song.bpm, notes: song.notes, source: song.source };
      saveSong(keep);
      syncSongs();
      this.startSong(keep);
    };
  }
  preview(song) {
    const a = this.app; a.readyToPlay(); a.engine.panic();
    (this.prevTimers || []).forEach(clearTimeout); this.prevTimers = [];
    const first = song.notes.filter((x) => x.t < 15);
    for (const x of first) {
      this.prevTimers.push(setTimeout(() => a.engine.noteOn(a.cur, x.n, a.s.global.velocity), x.t * 1000));
      this.prevTimers.push(setTimeout(() => a.engine.noteOff(a.cur, x.n), (x.t + Math.min(x.d, 1)) * 1000));
    }
  }

  async youtube() {
    const tab = canShareTab();
    this.layer.hidden = false; this.layer.classList.add('modal');
    this.card.className = 'guide-card centre wide';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">YouTube</span><button class="g-x" aria-label="Close">✕</button></div>
      <h3>Paste a YouTube link</h3>
      <label class="g-field"><input class="g-url" placeholder="https://www.youtube.com/watch?v=…" inputmode="url"></label>
      <div class="g-video"><div class="g-yt"></div></div>
      <p class="g-why">${tab ? 'When you press Listen, choose <b>this tab</b> and switch on <b>Share tab audio</b>.' : 'Turn the volume up. The iPad listens through its microphone while the video plays, so keep the room quiet.'} Piano or melody versions of a song work best.</p>
      <div class="g-row"><button class="g-go g-listen" disabled>Listen</button></div>`;
    const url = this.card.querySelector('.g-url'), go = this.card.querySelector('.g-listen');
    let player = null, rec = null, timer = 0, ended = false;
    const cleanup = () => { clearInterval(timer); if (rec) { rec.stop(); rec = null; } try { player && player.destroy(); } catch { /* gone */ } };
    this.card.querySelector('.g-x').onclick = () => { cleanup(); this.menu(); };
    url.oninput = async () => {
      const id = youtubeId(url.value);
      go.disabled = !id;
      if (!id) return;
      try {
        if (player) player.loadVideoById ? player.cueVideoById(id) : null;
        else player = await makePlayer(this.card.querySelector('.g-yt'), id, (st) => { if (st === 0) ended = true; });
      } catch (e) { this.fail(e); }
    };
    go.onclick = async () => {
      if (rec) { finish(); return; }
      try {
        rec = new Recorder(this.app.engine.ctx);
        await rec.start(tab);
        player.playVideo();
        go.textContent = 'Stop and work it out';
        url.disabled = true;
        timer = setInterval(() => {
          const s = Math.round(rec.seconds);
          this.card.querySelector('h3').textContent = `Listening… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}  ${'▮'.repeat(Math.min(10, Math.round(rec.level * 30)))}`;
          if (ended || s >= 300) finish();
        }, 250);
      } catch (e) { cleanup(); this.fail(e.name === 'NotAllowedError' ? 'The app needs permission to listen. Allow the microphone (or tab sharing) and try again.' : e); }
    };
    const finish = () => {
      clearInterval(timer);
      try { player.pauseVideo(); } catch { /* gone */ }
      const buf = rec.stop(); rec = null;
      const title = (player.getVideoData && player.getVideoData().title) || 'YouTube song';
      cleanup();
      if (!buf || buf.duration < 2) return this.fail('That was too short to hear anything.');
      this.fromAudio(buf, this.niceTitle(title), 'YouTube').catch((e) => this.fail(e));
    };
  }

  intro(lesson) {
    const saved = this.savedProgress(lesson);
    const busy = this.app.seqDump && this.app.seqDump.some((v, i) => i < 16 * 1032 && v !== 0 && (i % 16) < 4);
    this.card.className = 'guide-card centre';
    this.card.innerHTML = `
      <div class="g-head"><span class="g-sec">${lesson.title}</span><button class="g-x" aria-label="Close">✕</button></div>
      <h2>${lesson.title}</h2>
      <p>${lesson.intro}</p>
      ${saved ? `<p class="g-why">You got as far as <b>${esc(saved.section)}</b>.</p>` : busy ? '<p class="g-warn">This starts the sequencer from blank, so patterns already in it will be cleared.</p>' : ''}
      <div class="g-row">${saved ? '<button class="g-restart">Start again</button><button class="g-go">Carry on</button>' : '<button class="g-go">Start</button>'}</div>`;
    this.card.querySelector('.g-x').onclick = () => this.stop();
    this.card.querySelector('.g-go').onclick = () => (saved ? this.begin(lesson, saved.at) : this.begin(lesson));
    const rs = this.card.querySelector('.g-restart'); if (rs) rs.onclick = () => this.begin(lesson);
  }
  // where he got to last time (start of that part), kept on the device
  savedProgress(lesson) {
    try {
      const p = JSON.parse(localStorage.getItem('sixop.lessonProgress') || 'null');
      if (!p || p.title !== lesson.title || !(p.i > 0) || p.i >= lesson.steps.length - 1) return null;
      const sec = lesson.steps[p.i] && lesson.steps[p.i].section;
      const at = lesson.steps.findIndex((x) => x.section === sec);
      return at > 0 ? { at, section: sec } : null;
    } catch { return null; }
  }
  saveProgress() {
    try {
      if (!this.lesson) return;
      const st = this.step();
      if (!st || st.final) localStorage.removeItem('sixop.lessonProgress');
      else localStorage.setItem('sixop.lessonProgress', JSON.stringify({ title: this.lesson.title, i: this.i }));
    } catch { /* private mode */ }
  }

  async begin(lesson, at = 0) {
    this.lesson = lesson; this.i = at;
    // how many times each kind of fiddly step has come up: 1st he watches, 2nd he does it, then it's done for him
    const seen = {};
    this.occ = lesson.steps.map((x) => (x.kind ? (seen[x.kind] = (seen[x.kind] || 0) + 1) : 0));
    this.layer.classList.remove('modal');
    this.launcher.classList.add('on');
    if (lesson.setup && !at) await lesson.setup(this.app);
    else if (!this.app.powered) await this.app.powerOn();
    this.enter();
  }

  stop() {
    clearInterval(this.moveT); this.moving = false; this.forI = -1;
    this.stopAll();
    this.endSong();
    this.lesson = null;
    this.layer.hidden = true; this.layer.classList.remove('modal');
    this.launcher.classList.remove('on');
    this.clearHighlights();
  }

  enter() {
    const st = this.step();
    this.doneAt = 0; this.okUntil = 0; this.lastKey = ''; this.wrongShown = false;
    if (st && st.onEnter) st.onEnter(this.app, this);
    this.stopAll(); this.oops = ''; this.demoing = false; clearTimeout(this.demoT);
    if (st && st.demo) this.startDemo(st);
    const n = st && st.doIt ? this.occ[this.i] : 0;
    this.autoMode = n === 1 ? 'watch' : n >= 3 ? 'auto' : null;
    this.yourTurn = n === 2;
    this.autoAt = performance.now() + (this.autoMode === 'watch' ? 2200 : 700); this.autoDone = false;
    this.stepT0 = performance.now(); this.progKey = ''; this.helpLevel = 0;
    this.layer.classList.remove('g-urge');
    if (st && st.check) this.celebrate();
    if (st && st.final) { this.celebrate(true); }
    this.saveProgress();
    this.renderCard(true);
  }

  // a burst of confetti over the screen and a happy sound
  celebrate(big = false) {
    this.app.fb.saved && this.app.fb.saved();
    const cv = document.querySelector('.bezel .screen'); if (!cv) return;
    const r = cv.getBoundingClientRect(), box = el('div', 'g-party', this.layer);
    box.style.left = r.x + 'px'; box.style.top = r.y + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    const bits = ['🎉', '⭐', '🎵', '✨', '🎶', '💫'];
    for (let k = 0; k < (big ? 26 : 14); k++) {
      const b = el('span', '', box, bits[k % bits.length]);
      b.style.left = (Math.random() * 90 + 5) + '%';
      b.style.animationDelay = Math.random() * 300 + 'ms';
      b.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
    }
    setTimeout(() => box.remove(), 2000);
  }

  // "Do it for me": what the guide can do itself for the current step
  btnName(t) { const m = typeof t === 'string' && /^\.btn\[data-name="(\w+)"\]$/.exec(t); return m ? m[1] : null; }
  pressBtn(name) { const a = this.app; a.onButton(name, 'down', {}); setTimeout(() => a.onButton(name, 'up', {}), 120); }
  doFor(run = true) {
    const a = this.app, st = this.step(), req = this.activeReq;
    if (!st || st.final || st.check) return false;
    const cur = req || st;
    let act = null;
    if (req && req.fix) act = () => req.fix(a);
    else if (!req && st.doIt) act = () => st.doIt(a);
    else if (!req && st.demo) act = () => { st.demo.keys.forEach((k) => a.onKey(k, 'down', {})); setTimeout(() => st.demo.keys.forEach((k) => a.onKey(k, 'up', {})), 1000); };
    else { const one = this.oneMove(cur); if (one) act = () => this.repeatMove(cur, one); }
    if (act && run) {
      act(); this.stepT0 = performance.now(); this.helpLevel = 0; this.layer.classList.remove('g-urge');
      // keep going through any "first:" fixes until the whole step is done
      if (this.forI !== this.i) { this.forI = this.i; this.forUntil = performance.now() + 25000; } this.forNext = performance.now() + 1300;
    }
    return !!act;
  }
  // one small move toward the goal on the control the step points at
  oneMove(cur) {
    const a = this.app, sel = typeof cur.target === 'function' ? cur.target(a) : cur.target;
    const list = [].concat(sel || []);
    if (!list.length) return null;
    const btns = list.map((x) => this.btnName(x));
    if (btns.every(Boolean)) {
      const f = () => { btns.forEach((n) => a.onButton(n, 'down', {})); setTimeout(() => btns.slice().reverse().forEach((n) => a.onButton(n, 'up', {})), 90); };
      f.gap = 550; // let the press land (sequencer state comes back a moment later) before checking again
      return f;
    }
    if (list.length !== 1) return null;
    const m = /^\.enc\[aria-label="(\w+)"\]/.exec(list[0]);
    if (m) {
      const name = m[1] === 'ALGORITHM' ? 'ALGO' : m[1].replace(/^KNOB(\d)$/, 'K$1');
      return () => {
        const h = typeof cur.hint === 'function' ? cur.hint(a) : cur.hint;
        const d = h && typeof h.d === 'number' ? Math.sign(h.d) : /left/.test(String(h || '')) ? -1 : 1;
        if (d) a.onTurn(name, d, h && typeof h.d === 'number' ? Math.min(4, Math.ceil(Math.abs(h.d) / 8)) : 1);
      };
    }
    const k = /^\.key\[data-idx="(\d+)"\]$/.exec(list[0]);
    if (k) { const f = () => { a.onKey(+k[1], 'down', {}); setTimeout(() => a.onKey(+k[1], 'up', {}), 110); }; f.gap = 600; return f; }
    return null;
  }
  repeatMove(cur, one) {
    const a = this.app, i = this.i, isReq = cur !== this.step();
    let n = 0;
    clearInterval(this.moveT);
    this.moving = true;
    this.moveT = setInterval(() => {
      const fin = isReq ? cur.ok(a) : cur.done(a);
      if (fin || this.i !== i || !this.lesson || ++n > 200) { clearInterval(this.moveT); this.moving = false; return; }
      one();
    }, one.gap || 140);
  }
  step() { return this.lesson && this.lesson.steps[this.i]; }
  quietKeys() { const st = this.step(); return !!this.songLesson || !!(st && st.demo); }
  stopAll() { if (this.allStop) { this.allStop(); this.allStop = null; this.lastKey = ''; } }

  // play the step's keys with a white glow, then hand over with a yellow one (green once pressed)
  startDemo(st) {
    const a = this.app, notes = st.demo.keys.map((k) => 53 + k + 12 * st.demo.oct);
    const c = a.engine.ctx; if (c && c.state !== 'running') c.resume().catch(() => {});
    this.demoing = true; this.ringKey = ''; this.lastKey = '';
    clearTimeout(this.demoT); clearTimeout(this.demoOffT); clearTimeout(this.demoEnd);
    this.demoT = setTimeout(() => notes.forEach((n) => a.engine.noteOn(a.cur, n, a.s.global.velocity)), 350);
    this.demoOffT = setTimeout(() => notes.forEach((n) => a.engine.noteOff(a.cur, n)), 1450);
    this.demoEnd = setTimeout(() => { this.demoing = false; this.ringKey = ''; this.lastKey = ''; }, 1900);
  }
  // a key press during a "your turn" step: wrong keys flash red and aren't played
  blockKey(idx) {
    const st = this.step();
    if (!this.lesson || !st || !st.demo || this.activeReq) return false;
    if (st.demo.keys.includes(idx)) { if (this.oops) { this.oops = ''; this.lastKey = ''; } return false; }
    const k = document.querySelector(`.key[data-idx="${idx}"]`);
    if (k) { k.classList.remove('g-bad'); void k.offsetWidth; k.classList.add('g-bad'); setTimeout(() => k.classList.remove('g-bad'), 450); }
    this.oops = tryAgain(); this.lastKey = '';
    return true;
  }
  go(d) {
    if (!this.lesson) return;
    this.i = Math.max(0, Math.min(this.lesson.steps.length - 1, this.i + d));
    this.enter();
  }

  // ------------------------------------------------------------ per frame
  // the Learn interface lives on the device screen: lay the card exactly over
  // the display, scaled with the panel, and in menus dim all but the screen
  fitCard() {
    if (this.layer.hidden) return;
    const cv = document.querySelector('.bezel .screen');
    if (!cv) return;
    const r = cv.getBoundingClientRect(), k = r.width / 221;
    const key = [r.x, r.y, k].map((v) => v.toFixed(2)).join(',');
    if (key !== this.fitKey) {
      this.fitKey = key;
      this.card.style.setProperty('--gx', r.x + 'px');
      this.card.style.setProperty('--gy', r.y + 'px');
      this.card.style.setProperty('--gs', k);
      const b = document.querySelector('.bezel').getBoundingClientRect();
      this.peek.style.left = b.right - 34 * k + 'px'; this.peek.style.top = r.bottom + 2 * k + 'px';
      this.peek.style.transform = `scale(${k})`;
    }
    if (this.layer.classList.contains('modal')) {
      const vw = window.innerWidth, vh = window.innerHeight, b = document.querySelector('.bezel').getBoundingClientRect();
      const mk = 'modal' + vw + vh + key;
      if (this.ringKey !== mk) {
        this.ringKey = mk; this.rings.innerHTML = '';
        this.svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
        this.svg.innerHTML = `<defs><mask id="g-mask"><rect width="${vw}" height="${vh}" fill="#fff"/><rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${40 * k}" fill="#000"/></mask></defs>
          <rect width="${vw}" height="${vh}" fill="rgba(20,14,8,.55)" mask="url(#g-mask)"/>`;
      }
    }
  }

  tick() {
    this.fitCard();
    if (!this.lesson) return;
    const st = this.step(), app = this.app, now = performance.now();
    if (!st) return;
    if (st.final) { this.place(this.targetsFor(st), st); return; }
    // the first unmet requirement takes over the card until it's put right
    let req = (st.requires || []).find((r) => !r.ok(app));
    // a "watch me" or "done for you" step fixes its own small requirements (like the page)
    const unmet = (st.requires || []).filter((r) => !r.ok(app));
    const selfFix = this.autoMode && !this.autoDone && unmet.every((r) => r.fix);
    if (selfFix) req = null;
    if (selfFix && now >= this.autoAt && !st.done(app)) {
      unmet.forEach((r) => r.fix(app)); st.doIt(app); this.autoDone = true; this.lastKey = ''; this.ringKey = '';
    }
    const active = req || st;
    const ok = !req && st.done(app);
    if (this.forI === this.i && !ok && !this.moving && now < this.forUntil && now >= this.forNext) {
      this.forNext = now + 1300; this.activeReq = req; this.doFor();
    }
    // help that steps up while nothing changes: bigger glow at 8 s, a demo at 15 s, "Do it for me" at 30 s
    const pk = (req ? req.text : '') + '|' + (active.now ? active.now(app) : '') + '|' + app.heldKeys.size;
    if (pk !== this.progKey) { this.progKey = pk; this.stepT0 = now; }
    const idle = now - this.stepT0;
    const lvl = ok || (this.autoMode && !this.autoDone) || st.check ? 0 : idle > 30000 ? 3 : idle > 15000 ? 2 : idle > 8000 ? 1 : 0;
    if (lvl !== this.helpLevel) {
      this.helpLevel = lvl; this.lastKey = '';
      this.layer.classList.toggle('g-urge', lvl >= 1);
      if (lvl === 2 && !req && st.demo && !this.demoing) this.startDemo(st);
    }
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
    const key = [this.i, req ? req.text : '', live, wrong, ok, st.check ? app.seqVals[P.P_SEQ_PLAY] : '', this.demoing, this.oops, !!this.allStop, this.autoMode, this.autoDone, this.helpLevel].join('|');
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const n = this.lesson.steps.length, pct = Math.round((this.i / (n - 1)) * 100);
    const text = typeof active.text === 'function' ? active.text(app) : active.text;
    const why = !req && st.why ? `<p class="g-why">${st.why}</p>` : '';
    const goal = !req && st.goal ? `<div class="g-goal"><span>Goal</span>${st.goal}</div>` : '';
    const nowLine = live ? `<div class="g-now ${ok ? 'ok' : ''}"><span>Now</span>${live}</div>` : '';
    const redo = st.redo && !req ? '<button class="g-redo">Redo</button>' : '';
    const demo = st.demo && !req;
    const watching = this.autoMode && !this.autoDone && !req && !ok;
    let shown = demo ? (this.demoing ? '👀 Watch and listen…' : 'Now your turn! ' + text.replace(/glowing/g, 'yellow')) : text;
    if (watching) shown = this.autoMode === 'watch' ? '👀 Watch me do this one' : '⚡ I’ll do this bit for you';
    else if (this.yourTurn && !req && !ok) shown = 'Your turn! ' + text;
    const sections = [...new Set(this.lesson.steps.map((x) => x.section))], si = sections.indexOf(st.section);
    const map = sections.map((x, k) => `<i class="${k < si ? 'done' : k === si ? 'now' : ''}"></i>`).join('');
    const dofor = this.helpLevel >= 3 && !ok && this.doFor(false) ? '<button class="g-go g-dofor">Do it for me</button>' : '';
    this.card.className = 'guide-card' + (ok ? ' ok' : '') + (req ? ' fix' : '') + (st.final ? ' centre' : '');
    this.card.innerHTML = `
      <div class="g-head">
        <span class="g-sec">${st.section || ''}</span>
        <span class="g-map" aria-label="Part ${si + 1} of ${sections.length}">${map}</span>
        <button class="g-x" aria-label="Close lesson">✕</button>
      </div>
      <div class="g-bar"><i style="width:${pct}%"></i></div>
      ${req ? '<div class="g-oops">First:</div>' : ''}
      <h3>${ok ? '✓ ' : ''}${shown}</h3>
      ${watching ? `<p class="g-why">${text}.${this.autoMode === 'watch' ? ' Next time it’s your turn.' : ''}</p>` : ''}
      ${demo && this.oops && !ok ? `<p class="g-try">${this.oops}</p>` : ''}
      ${nowLine}${goal}${watching ? '' : why}
      ${dofor ? `<div class="g-row">${dofor}</div>` : ''}
      ${wrong ? `<p class="g-warn">${wrong}</p>` : ''}
      ${st.check ? `<div class="g-row"><button class="g-hearme">${app.seqVals[P.P_SEQ_PLAY] ? 'Stop' : 'Hear this part'}</button>${st.check.pat > 0 ? `<button class="g-hearall">${this.allStop ? 'Stop' : 'Hear it all'}</button>` : ''}</div>
      <div class="g-row"><button class="g-again">Start over</button><button class="g-go g-cont">Continue</button></div>` : `<div class="g-row">
        <button class="g-back" ${this.i === 0 ? 'disabled' : ''}>Back</button>
        ${demo ? '<button class="g-showme">Show me</button>' : ''}${redo}
        ${st.final ? '<button class="g-go g-end">Done</button>' : '<button class="g-skip">Skip</button>'}
      </div>`}`;
    this.card.querySelector('.g-x').onclick = () => this.stop();
    const bk = this.card.querySelector('.g-back'); if (bk) bk.onclick = () => this.go(-1);
    const df = this.card.querySelector('.g-dofor'); if (df) df.onclick = () => { this.doFor(); this.lastKey = ''; };
    const sm = this.card.querySelector('.g-showme'); if (sm) sm.onclick = () => { this.oops = ''; this.startDemo(st); };
    if (st.check) {
      const pat = st.check.pat;
      const ha = this.card.querySelector('.g-hearall');
      if (ha) ha.onclick = async () => {
        if (this.allStop) { this.stopAll(); return; }
        app.setSeqPlay(0);
        const pats = Array.from({ length: pat + 1 }, (_, n) => n);
        this.allStop = () => {}; this.lastKey = '';
        this.allStop = await playPatterns(app, pats, () => { this.allStop = null; this.lastKey = ''; });
      };
      this.card.querySelector('.g-hearme').onclick = () => {
        this.stopAll();
        if (app.seqVals[P.P_SEQ_PLAY]) app.setSeqPlay(0);
        else { if (!app.seqOn) app.toggleSeq(); app.setSeqPlay(1); }
        this.lastKey = ''; this.renderCard(true);
      };
      this.card.querySelector('.g-cont').onclick = () => { this.stopAll(); app.setSeqPlay(0); this.go(1); };
      this.card.querySelector('.g-again').onclick = () => {
        this.stopAll(); app.setSeqPlay(0);
        if (app.seqVals[P.P_SEQ_REC]) { app.engine.set(P.P_SEQ_REC, 0); app.seqVals[P.P_SEQ_REC] = 0; }
        app.engine.seqCmd(2, pat); app.s.dirty.pattern = true; app.captureSeqSoon && app.captureSeqSoon();
        const first = this.lesson.steps.findIndex((x) => x.section === st.section);
        this.i = Math.max(0, first); this.enter();
      };
    }
    const sk = this.card.querySelector('.g-skip'); if (sk) sk.onclick = () => this.go(1);
    const end = this.card.querySelector('.g-end'); if (end) end.onclick = () => this.stop();
    const rd = this.card.querySelector('.g-redo'); if (rd) rd.onclick = () => { st.redo(app); this.lastKey = ''; };
  }

  // an arc of light round a knob. A faint track shows the whole turn from
  // where he started; it fills up as the value gets closer to the goal, and
  // turns red the further he turns the wrong way. The arrowhead shows the way.
  arc(hint, size, key) {
    const right = String(hint).includes('↻'), d = hint.d, SPAN = 250;
    let prog = 0, bad = 0;
    if (d != null) {
      if (this.arcKey !== key) { this.arcKey = key; this.arcD0 = Math.max(1, Math.abs(d)); }
      const d0 = this.arcD0, ad = Math.abs(d);
      prog = Math.max(0, Math.min(1, 1 - ad / d0));
      bad = Math.max(0, Math.min(1, (ad - d0) / Math.max(2, d0 * 0.5)));
    }
    const R = size / 2 + 9, c = R + 8, a0 = -90, sg = right ? 1 : -1;
    const pt = (a, r = R) => [c + r * Math.cos(a * Math.PI / 180), c + r * Math.sin(a * Math.PI / 180)];
    const path = (from, sweep) => {
      const [x0, y0] = pt(from), [x1, y1] = pt(from + sg * sweep);
      return `M${x0} ${y0} A${R} ${R} 0 ${sweep > 180 ? 1 : 0} ${right ? 1 : 0} ${x1} ${y1}`;
    };
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    // orange to start, easing to green as it nears the goal, red past the start the wrong way
    const col = `rgb(${(bad > 0 ? mix([255, 181, 98], [255, 60, 50], bad) : mix([255, 181, 98], [95, 224, 122], prog * prog)).join(',')})`;
    const end = a0 + sg * SPAN, tip = pt(end + sg * 10), b0 = pt(end, R + 8), b1 = pt(end, R - 8);
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'g-arc'); svg.setAttribute('width', 2 * c); svg.setAttribute('height', 2 * c);
    const B = 3; // the ring's border: children are placed from inside it
    svg.style.left = (size / 2 - c - B) + 'px'; svg.style.top = (size / 2 - c - B) + 'px';
    svg.style.filter = `drop-shadow(0 0 6px ${col})`;
    svg.innerHTML = `<path d="${path(a0, SPAN)}" fill="none" stroke="${col}" stroke-opacity="${0.28 + bad * 0.5}" stroke-width="5" stroke-linecap="round"/>
      ${prog > 0.01 ? `<path d="${path(a0, SPAN * prog)}" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round"/>` : ''}
      <path d="M${b0[0]} ${b0[1]} L${tip[0]} ${tip[1]} L${b1[0]} ${b1[1]} Z" fill="${col}"/>`;
    return svg;
  }

  clearHighlights() { this.svg.innerHTML = ''; this.rings.innerHTML = ''; this.ringKey = ''; }

  // dim everything except the targets, ring each target, and park the card
  // where it covers neither the targets nor the screen
  place(targets, st, ok = false) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const rects = targets.map((t) => t.getBoundingClientRect());
    const hint = st.hint ? (typeof st.hint === 'function' ? st.hint(this.app) : st.hint) : '';
    const rk = rects.map((r) => [r.x, r.y, r.width, r.height].map(Math.round).join(',')).join(';') + '|' + hint + (hint && hint.d != null ? hint.d : '') + ok + vw + vh + (this.autoMode && !this.autoDone) + [...this.app.heldKeys.keys()].join(',') + this.demoing + !!this.activeReq;
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
        const keyStep = st.demo && !this.activeReq;
        const watchingNow = this.autoMode && !this.autoDone && !this.activeReq && !ok;
        const held = keyStep && !this.demoing && this.app.heldKeys.has(+targets[n].dataset.idx);
        const g = el('div', 'g-ring' + (ok || held ? ' ok' : watchingNow ? ' demo' : keyStep ? (this.demoing ? ' demo' : ' turn') : ''), this.rings);
        targets[n].classList.toggle('g-twist', !!watchingNow && targets[n].matches('.enc, .pot-knob'));
        g.style.left = r.x - pad + 'px'; g.style.top = r.y - pad + 'px';
        g.style.width = r.width + pad * 2 + 'px'; g.style.height = r.height + pad * 2 + 'px';
        g.style.borderRadius = Math.min(r.width, r.height) / 2 + pad + 'px';
        if (hint && n === 0) el('span', 'g-hint', g, String(hint));
        if (hint && n === 0 && !ok && targets[0].matches('.enc, .pot-knob')) g.appendChild(this.arc(hint, r.width + pad * 2, this.i + '|' + (this.activeReq ? this.activeReq.text : '')));
      });
    }
  }
}

