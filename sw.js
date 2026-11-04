// Keeps the app shell on the phone so it opens instantly and works offline.
// Bump VERSION whenever app files change so phones pick up the new version.
const VERSION = 'pt-2.5.0';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'brand/bird-gold.png', 'brand/falcon.png', 'brand/branch.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'pt-files').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// App files: try the network first (so updates show up), fall back to the saved copy when offline.
// Requests to the server (Google) are never cached here.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // A 404 or server error (e.g. while GitHub Pages is down) falls back to the saved copy too, so installed phones keep working.
  const saved = () => caches.match(e.request).then(r => r || caches.match('index.html'));
  e.respondWith(fetch(e.request).then(res => {
    if (!res.ok) return saved().then(r => r || res);
    const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res;
  }).catch(saved));
});
