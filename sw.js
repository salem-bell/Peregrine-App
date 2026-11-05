// Keeps the app shell on the phone so it opens instantly and works offline.
// Bump VERSION whenever app files change so phones pick up the new version.
const VERSION = 'pt-3.1.1';
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

// Push notifications (sent by the shop's Cloudflare Worker). Tapping one opens the right screen.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Peregrine', { body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: 'icons/icon-192.png', data: { go: String(d.url || '').replace(/^\?go=/, '') } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const go = (e.notification.data && e.notification.data.go) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(x => x.url.indexOf(self.registration.scope) === 0);
    if (c) { c.postMessage({ go }); return c.focus(); }
    return self.clients.openWindow(self.registration.scope + (go ? '?go=' + encodeURIComponent(go) : ''));
  }));
});
