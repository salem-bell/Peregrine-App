// Keeps the app shell on the phone so it opens instantly and works offline.
// Bump VERSION whenever app files change so phones pick up the new version.
// Another location (westcliffe/sw.js) loads this file after setting PT_NS (its cache names), PT_ROOT (where the shared files are) and PT_SHELL.
const NS = self.PT_NS || '', ROOT = self.PT_ROOT || '';
const VERSION = NS + 'pt-3.4.8';
const SHELL = self.PT_SHELL || ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'locations.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'brand/bird-gold.png', 'brand/falcon.png', 'brand/branch.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));   // straight from the server, never the browser's cache
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.indexOf(NS + 'pt-') === 0 && k !== VERSION && k !== NS + 'pt-files').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// App files: try the network first (so updates show up), fall back to the saved copy when offline.
// Requests to the server (Google) are never cached here.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // A 404 or server error (e.g. while GitHub Pages is down) falls back to the saved copy too, so installed phones keep working.
  const saved = () => caches.match(e.request).then(r => r || caches.match('index.html'));
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => {   // always ask the server (a quick "unchanged" when nothing's new)
    if (!res.ok) return saved().then(r => r || res);
    const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res;
  }).catch(saved));
});

// Push notifications (sent by the shop's Cloudflare Worker). Tapping one opens the right screen.
/* A message notification reached this phone: tell the chat service it was delivered. */
/* A message arrived while the app was closed: one more on the icon badge. (The app sets the exact number when it opens.) */
async function chatBadge(url){
  if (!/^\?go=chat:/.test(String(url || '')) || !self.navigator || !('setAppBadge' in self.navigator)) return;
  try {
    const c = await caches.open(NS + 'chat-pass'), r = await c.match('/badge'), n = (r ? Number(await r.text()) || 0 : 0) + 1;
    await c.put('/badge', new Response(String(n))); await self.navigator.setAppBadge(n);
  } catch (_) {}
}
async function chatDelivered(url){
  const m = /^\?go=chat:(.+)$/.exec(String(url || '')); if (!m) return;
  try {
    const c = await caches.open(NS + 'chat-pass'), r = await c.match('/chat-pass'); if (!r) return;
    const p = await r.json(); if (!p.ticket || p.exp * 1000 < Date.now()) return;
    await fetch(p.url + '/s/' + p.space + '/dlv?t=' + encodeURIComponent(p.ticket), { method: 'POST', body: JSON.stringify({ ch: decodeURIComponent(m[1]) }) });
  } catch (_) {}
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(Promise.all([self.registration.showNotification(d.title || 'Peregrine', { body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: ROOT + 'icons/icon-192.png', data: { go: String(d.url || '').replace(/^\?go=/, '') } }), chatDelivered(d.url), chatBadge(d.url)]));
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
