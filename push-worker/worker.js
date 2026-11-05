/**
 * Peregrine Team – push sender (Cloudflare Worker).
 * The Google Sheet server can't do the encryption Web Push needs, so it posts here and this Worker sends the notifications.
 * Setup: paste this whole file into a new Worker, then fill in the three values below (from the setup steps).
 */
const SECRET = '__PUSH_SECRET__';            // must match Settings › Push service secret in the sheet
const VAPID_PUBLIC = '__VAPID_PUBLIC__';      // must match Settings › Push public key
const VAPID_PRIVATE = '__VAPID_PRIVATE__';    // keep private – only lives here
const CONTACT = 'mailto:salem@comorantcoffee.com';

export default {
  async fetch(req) {
    if (req.method === 'GET') return new Response('Peregrine push service is running.', { headers: { 'content-type': 'text/plain' } });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let body; try { body = await req.json(); } catch (_) { return json({ error: 'bad json' }, 400); }
    if (!body || body.secret !== SECRET) return json({ error: 'not allowed' }, 403);
    const list = Array.isArray(body.pushes) ? body.pushes.slice(0, 500) : [];
    const results = await Promise.all(list.map(async (p, i) => {
      try { const r = await sendPush(p.sub, JSON.stringify(p.data || {}), p.ttl || 86400, p.urgency || 'high'); return { i, status: r.status }; }
      catch (e) { return { i, status: 0, error: String(e && e.message || e) }; }
    }));
    return json({ ok: true, results });
  }
};
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } });

/* ---------- Web Push: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291) ---------- */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; }); return out; };
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }

let signKey = null;
async function vapidKey() {
  if (signKey) return signKey;
  const pub = unb64u(VAPID_PUBLIC);   // 65 bytes: 0x04 || x || y
  signKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: VAPID_PRIVATE, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return signKey;
}
async function vapidJwt(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey(), enc.encode(head + '.' + claims));   // raw r||s, as JWS wants
  return head + '.' + claims + '.' + b64u(sig);
}
async function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}
async function sendPush(sub, payload, ttl, urgency) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error('bad subscription');
  const body = await encrypt(sub, payload);
  return fetch(sub.endpoint, { method: 'POST', body, headers: {
    'Authorization': 'vapid t=' + (await vapidJwt(sub.endpoint)) + ', k=' + VAPID_PUBLIC,
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': String(ttl), 'Urgency': urgency } });
}
