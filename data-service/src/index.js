/**
 * team-data – fast loads for the Peregrine Team app.
 *
 * The Google Sheet (Apps Script) is still where everything lives and where every save goes.
 * After changes it builds each person's app data (exactly what the app would get from the Sheet)
 * and pushes it here, signed with DATA_SECRET. The app then loads its data from here instead of
 * waiting on Google: one small read from Cloudflare instead of a cold start plus a dozen sheet reads.
 *
 * Sign-in: the app's token is checked here the same way the Sheet checks it (HMAC of user id, code,
 * sign-in version and issue time), using the people list and signing key the Sheet pushes.
 * Anything this service can't answer (no data yet, stale data, unknown token) it refuses, and the
 * app quietly asks the Sheet instead – so nothing breaks if this service is down or out of date.
 */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-sig', 'access-control-expose-headers': 'x-pushed-at' };
const json = (o, status = 200, extra) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...(extra || {}) } });
const enc = new TextEncoder();
const b64u = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
async function mac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(text));
}
function same(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
const MAX_AGE = 20 * 60000;        // data older than this is refused (the Sheet pushes at least every 15 minutes)

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'team-data' });
    if (!env.DATA_SECRET) return json({ error: 'DATA_SECRET is not set' }, 503);
    const stub = env.STORE.get(env.STORE.idFromName('peregrine'));
    if (url.pathname === '/push' && req.method === 'POST') {      // from the Sheet
      const body = await req.text();
      if (!same(b64u(await mac(env.DATA_SECRET, body)), req.headers.get('x-sig') || '')) return json({ error: 'bad signature' }, 401);
      return stub.fetch('https://do/push', { method: 'POST', body });
    }
    if (url.pathname === '/state' && req.method === 'POST') {     // from the app (text/plain body, so no CORS preflight)
      let token = ''; try { token = String(JSON.parse(await req.text()).token || ''); } catch (_) {}
      return stub.fetch('https://do/state', { method: 'POST', body: JSON.stringify({ token }) });
    }
    return json({ error: 'not found' }, 404);
  }
};

export class Store {
  constructor(ctx) {
    this.ctx = ctx; this.sql = ctx.storage.sql; this.seen = {}; this.seenDirty = false;
    this.sql.exec('CREATE TABLE IF NOT EXISTS states (id TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    this.meta = null;
  }
  getMeta() {
    if (!this.meta) { const r = [...this.sql.exec("SELECT v FROM meta WHERE k = 'm'")][0]; this.meta = r ? JSON.parse(r.v) : null; }
    return this.meta;
  }
  async fetch(req) {
    const url = new URL(req.url), b = JSON.parse(await req.text());
    if (url.pathname === '/push') return this.push(b);
    if (url.pathname === '/state') return this.state(b.token);
    return json({ error: 'not found' }, 404);
  }
  /** b: { at, tz, today, tokenKey, reauthDays, roster: [{id, code, ver}], states: {id: json}, drop: [ids], full } */
  push(b) {
    if (!b || !Array.isArray(b.roster) || !b.tokenKey) return json({ error: 'bad push' }, 400);
    const meta = { at: Number(b.at) || Date.now(), tz: String(b.tz || 'America/Chicago'), today: String(b.today || ''), tokenKey: String(b.tokenKey), reauthDays: Number(b.reauthDays) || 0,
      roster: Object.fromEntries(b.roster.map(r => [String(r.id), { code: String(r.code), ver: Number(r.ver) || 1 }])) };
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('m', ?)", JSON.stringify(meta));
      Object.entries(b.states || {}).forEach(([id, s]) => this.sql.exec('INSERT OR REPLACE INTO states (id, json, at) VALUES (?, ?, ?)', id, typeof s === 'string' ? s : JSON.stringify(s), meta.at));
      // anyone no longer on the list (turned off, removed) loses their copy; everyone else's copy is marked as checked just now
      const ids = Object.keys(meta.roster);
      [...this.sql.exec('SELECT id FROM states')].forEach(r => { if (ids.indexOf(r.id) < 0) this.sql.exec('DELETE FROM states WHERE id = ?', r.id); });
      this.sql.exec('UPDATE states SET at = ?', meta.at);
    });
    this.meta = meta; this.flushSeen();
    const seen = Object.fromEntries([...this.sql.exec('SELECT id, at FROM seen')].map(r => [r.id, r.at]));
    const have = [...this.sql.exec('SELECT id FROM states')].map(r => r.id);
    return json({ ok: true, stored: Object.keys(b.states || {}).length, ms: Date.now() - now, seen, have });
  }
  async state(token) {
    const meta = this.getMeta(); if (!meta) return json({ error: 'no data yet', fallback: true }, 409);
    const [t, id, issued, sig] = String(token || '').split('.'), r = meta.roster[id];
    if (t !== 'T' || !id || !r || !issued || !sig) return json({ error: 'unknown', fallback: true }, 401);
    if (!same(hex(await mac(meta.tokenKey, [id, r.code, r.ver, issued].join('|'))).slice(0, 32), sig)) return json({ error: 'unknown', fallback: true }, 401);
    if (meta.reauthDays > 0 && Date.now() - Number(issued) > meta.reauthDays * 864e5) return json({ error: 'expired', fallback: true }, 401);
    const row = [...this.sql.exec('SELECT json, at FROM states WHERE id = ?', id)][0];
    if (!row) return json({ error: 'no data for you yet', fallback: true }, 409);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: meta.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (Date.now() - row.at > MAX_AGE || (meta.today && meta.today !== today)) return json({ error: 'stale', fallback: true }, 409);
    this.markSeen(id);
    return json(row.json, 200, { 'x-pushed-at': String(row.at) });
  }
  /** "last active": kept in memory, written at most every 30 seconds, handed back to the Sheet on each push. */
  markSeen(id) {
    const now = Date.now(); if (now - (this.seen[id] || 0) < 30000) return;
    this.seen[id] = now; this.seenDirty = true;
    if (!this.seenTimer) this.seenTimer = setTimeout(() => { this.seenTimer = null; this.flushSeen(); }, 30000);
  }
  flushSeen() {
    if (!this.seenDirty) return; this.seenDirty = false;
    Object.entries(this.seen).forEach(([id, at]) => this.sql.exec('INSERT INTO seen (id, at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET at = MAX(at, excluded.at)', id, at));
  }
}
