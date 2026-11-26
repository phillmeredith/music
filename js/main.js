// Entry point: build the instrument and register the offline service worker.
import { App } from './app.js';

const app = new App(document.getElementById('app'));
window.sixop = app; // handy for debugging from the console

// iOS: stop double-tap zoom and the rubber-band scroll while playing
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || e.target.closest('.stage')) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

// resume audio when returning to the app (iOS suspends the context in the background)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.engine.ctx && app.engine.ctx.state !== 'running') app.engine.ctx.resume();
  if (document.visibilityState === 'hidden') app.store.persist();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('service worker failed', err));
}
