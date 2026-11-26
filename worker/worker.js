// Serves the Sixop PWA from the gh-pages branch of github.com/phillmeredith/music,
// plus a small shared song library (KV) that only paired devices can use.
const ORIGIN = 'https://raw.githubusercontent.com/phillmeredith/music/gh-pages';
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  wasm: 'application/wasm', json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml',
  png: 'image/png', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', mjs: 'text/javascript; charset=utf-8', bin: 'application/octet-stream' };
const COOKIE = 'sixop_dev';

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function token(env) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sixop-device:' + norm(env.PAIR_CODE)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
const clean = (s, n) => String(s || '').replace(/[<>"&\u0000-\u001f]/g, '').trim().slice(0, n);
const num = (x, lo, hi) => { x = Number(x); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; };

function tidy(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.notes) || !b.notes.length) return null;
  const notes = b.notes.slice(0, 8000).map((x) => ({
    t: Math.round(num(x.t, 0, 900) * 1000) / 1000, d: Math.round(num(x.d, 0.01, 30) * 1000) / 1000,
    n: Math.round(num(x.n, 0, 127)), v: Math.round(num(x.v == null ? 90 : x.v, 1, 127)) }));
  const s = { title: clean(b.title, 60) || 'Song', bpm: Math.round(num(b.bpm, 30, 300)), notes };
  if (b.source) s.source = clean(b.source, 40);
  if (b.blurb) s.blurb = clean(b.blurb, 120);
  if (b.voice != null) s.voice = Math.round(num(b.voice, 0, 127));
  return s;
}

async function api(req, env, path) {
  if (path === '/api/unlock' && req.method === 'POST') {
    let code = '';
    try { code = (await req.json()).code; } catch { /* bad body */ }
    if (!env.PAIR_CODE || norm(code) !== norm(env.PAIR_CODE)) return json({ ok: false }, 403);
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${await token(env)}; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Strict` });
  }
  if (cookie(req, COOKIE) !== (await token(env))) return json({ locked: true }, 401);
  if (path === '/api/songs' && req.method === 'GET') {
    const keys = [];
    let cursor;
    do { const l = await env.SONGS.list({ prefix: 'song:', cursor }); keys.push(...l.keys); cursor = l.list_complete ? null : l.cursor; } while (cursor);
    const songs = (await Promise.all(keys.map((k) => env.SONGS.get(k.name, 'json')))).filter(Boolean);
    songs.sort((a, b) => (b.added || 0) - (a.added || 0));
    return json({ songs });
  }
  if (path === '/api/songs' && req.method === 'POST') {
    if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'json only' }, 415);
    const text = await req.text();
    if (text.length > 1500000) return json({ error: 'too big' }, 413);
    let body; try { body = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
    const s = tidy(body);
    if (!s) return json({ error: 'no notes' }, 400);
    s.id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    s.added = Date.now();
    await env.SONGS.put('song:' + s.id, JSON.stringify(s));
    return json({ song: s }, 201);
  }
  const m = path.match(/^\/api\/songs\/([a-z0-9]{6,32})$/);
  if (m && req.method === 'DELETE') { await env.SONGS.delete('song:' + m[1]); return json({ ok: true }); }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.startsWith('/api/')) return api(req, env, path);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (path.includes('..')) return new Response('Bad path', { status: 400 });
    if (path.endsWith('/')) path += 'index.html';
    const ext = (path.split('.').pop() || '').toLowerCase();
    const r = await fetch(ORIGIN + path, { cf: { cacheTtl: 120, cacheEverything: true } });
    if (!r.ok) return new Response('Not found', { status: 404 });
    const h = new Headers();
    h.set('content-type', TYPES[ext] || 'application/octet-stream');
    h.set('cache-control', path === '/sw.js' || ext === 'html' ? 'no-cache' : 'public, max-age=300');
    h.set('x-content-type-options', 'nosniff');
    if (path === '/sw.js') h.set('service-worker-allowed', '/');
    return new Response(req.method === 'HEAD' ? null : r.body, { status: 200, headers: h });
  },
};
