// Offline cache. Bump VERSION whenever any cached file changes.
const VERSION = 'sixop-1';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'engine.wasm', 'worklet.js',
  'js/main.js', 'js/app.js', 'js/audio.js', 'js/dx7.js', 'js/feedback.js', 'js/midi.js', 'js/panel.js',
  'js/params.js', 'js/presets.js', 'js/screen.js', 'js/store.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// cache first, so the instrument starts instantly and works with no network
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
