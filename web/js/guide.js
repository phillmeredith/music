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
    this.renderCard(true);
  }
  step() { return this.lesson && this.lesson.steps[this.i]; }
  stopAll() { if (this.allStop) { this.allStop(); this.allStop = null; this.lastKey = ''; } }

  // play the step's keys with a white glow, then hand over with a green one
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
    const key = [this.i, req ? req.text : '', live, wrong, ok, st.check ? app.seqVals[P.P_SEQ_PLAY] : '', this.demoing, this.oops, !!this.allStop].join('|');
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const n = this.lesson.steps.length, pct = Math.round((this.i / (n - 1)) * 100);
    const text = typeof active.text === 'function' ? active.text(app) : active.text;
    const why = !req && st.why ? `<p class="g-why">${st.why}</p>` : '';
    const goal = !req && st.goal ? `<div class="g-goal"><span>Goal</span>${st.goal}</div>` : '';
    const nowLine = live ? `<div class="g-now ${ok ? 'ok' : ''}"><span>Now</span>${live}</div>` : '';
    const redo = st.redo && !req ? '<button class="g-redo">Redo</button>' : '';
    const demo = st.demo && !req;
    const shown = demo ? (this.demoing ? '👀 Watch and listen…' : 'Now your turn! ' + text.replace(/glowing/g, 'green')) : text;
    this.card.className = 'guide-card' + (ok ? ' ok' : '') + (req ? ' fix' : '') + (st.final ? ' centre' : '');
    this.card.innerHTML = `
      <div class="g-head">
        <span class="g-sec">${st.section || ''}</span>
        <span class="g-count">${this.i + 1} / ${n}</span>
        <button class="g-x" aria-label="Close lesson">✕</button>
      </div>
      <div class="g-bar"><i style="width:${pct}%"></i></div>
      ${req ? '<div class="g-oops">First:</div>' : ''}
      <h3>${ok ? '✓ ' : ''}${shown}</h3>
      ${demo && this.oops && !ok ? `<p class="g-try">${this.oops}</p>` : ''}
      ${nowLine}${goal}${why}
      ${wrong ? `<p class="g-warn">${wrong}</p>` : ''}
      ${st.check ? `<div class="g-row"><button class="g-hearme">${app.seqVals[P.P_SEQ_PLAY] ? 'Stop' : 'Hear this part'}</button>${st.check.pat > 0 ? `<button class="g-hearall">${this.allStop ? 'Stop' : 'Hear it all'}</button>` : ''}</div>
      <div class="g-row"><button class="g-again">Start over</button><button class="g-go g-cont">Continue</button></div>` : `<div class="g-row">
        <button class="g-back" ${this.i === 0 ? 'disabled' : ''}>Back</button>
        ${demo ? '<button class="g-showme">Show me</button>' : ''}${redo}
        ${st.final ? '<button class="g-go g-end">Done</button>' : '<button class="g-skip">Skip</button>'}
      </div>`}`;
    this.card.querySelector('.g-x').onclick = () => this.stop();
    const bk = this.card.querySelector('.g-back'); if (bk) bk.onclick = () => this.go(-1);
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

  clearHighlights() { this.svg.innerHTML = ''; this.rings.innerHTML = ''; this.ringKey = ''; }

  // dim everything except the targets, ring each target, and park the card
  // where it covers neither the targets nor the screen
  place(targets, st, ok = false) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const rects = targets.map((t) => t.getBoundingClientRect());
    const hint = st.hint ? (typeof st.hint === 'function' ? st.hint(this.app) : st.hint) : '';
    const rk = rects.map((r) => [r.x, r.y, r.width, r.height].map(Math.round).join(',')).join(';') + '|' + hint + ok + vw + vh + this.demoing + !!this.activeReq;
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
        const g = el('div', 'g-ring' + (ok ? ' ok' : keyStep ? (this.demoing ? ' demo' : ' turn') : ''), this.rings);
        g.style.left = r.x - pad + 'px'; g.style.top = r.y - pad + 'px';
        g.style.width = r.width + pad * 2 + 'px'; g.style.height = r.height + pad * 2 + 'px';
        g.style.borderRadius = Math.min(r.width, r.height) / 2 + pad + 'px';
        if (hint && n === 0) el('span', 'g-hint', g, hint);
      });
    }
  }
}

