/**
 * team-chat – live messages for the Peregrine Team app and Bellah Family HQ.
 *
 * Each app is a "space" (family, peregrine) with its own Durable Object and SQLite database:
 * channels, groups and private messages, read marks, who-has-read, search, photos (R2).
 * Apps connect over a WebSocket and get every change within a second.
 *
 * Trust: the app's Google Sheet (Apps Script) signs a short-lived chat pass ("ticket") for each signed-in
 * person, and pushes the list of people + roles ("roster") here, signed with the same per-space secret.
 * Notifications go back out through the sheet (it knows everyone's notification settings and phones).
 */
const SPACES = { family: 'SECRET_FAMILY', peregrine: 'SECRET_PEREGRINE' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-sig' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...CORS } });
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
function same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
/** ticket = base64url(json) + "." + base64url(HMAC-SHA256(secret, base64url(json))) */
async function readTicket(env, space, t) {
  const secret = env[SPACES[space]]; if (!secret || !t) return null;
  const [body, sig] = String(t).split('.'); if (!body || !sig) return null;
  if (!same(await hmac(secret, body), sig)) return null;
  let p; try { p = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))); } catch (_) { return null; }
  if (p.s !== space || !p.u || !(p.e > Date.now() / 1000)) return null;
  return p;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url), m = url.pathname.match(/^\/s\/(family|peregrine)\/(ws|roster|system|photo)(?:\/([\w.-]+))?$/);
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'team-chat' });
    if (!m) return json({ error: 'not found' }, 404);
    const [, space, what, arg] = m, secret = env[SPACES[space]];
    if (!secret) return json({ error: 'This space has no secret set yet' }, 503);
    const stub = env.SPACE.get(env.SPACE.idFromName(space));
    // signed calls from the sheet
    if (what === 'roster' || what === 'system') {
      const body = await req.text();
      if (!same(await hmac(secret, body), req.headers.get('x-sig') || '')) return json({ error: 'bad signature' }, 401);
      return stub.fetch(new Request('https://do/' + what, { method: 'POST', body, headers: { 'x-space': space } }));
    }
    const who = await readTicket(env, space, url.searchParams.get('t'));
    if (!who) return json({ error: 'expired' }, 401);
    const hdr = { 'x-space': space, 'x-who': JSON.stringify(who) };
    if (what === 'ws') {
      if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected a WebSocket' }, 426);
      return stub.fetch(new Request('https://do/ws', { headers: { ...hdr, upgrade: 'websocket' } }));
    }
    if (what === 'photo' && req.method === 'POST') {           // upload first, then send the message with the returned key
      const type = req.headers.get('content-type') || '';
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'That photo couldn\'t be read – try another' }, 400);
      const bytes = await req.arrayBuffer(); if (bytes.byteLength > 5 * 1024 * 1024) return json({ error: 'That photo is too big' }, 413);
      const key = space + '/' + who.u + '/' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
      return json({ ok: true, key });
    }
    if (what === 'photo' && arg) {                              // a message's photo, only for people who can see that conversation
      const r = await stub.fetch(new Request('https://do/photo?id=' + encodeURIComponent(arg), { headers: hdr }));
      if (!r.ok) return r;
      const { key } = await r.json(), obj = await env.PHOTOS.get(key);
      if (!obj) return json({ error: 'That photo has expired' }, 404);
      return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata && obj.httpMetadata.contentType || 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', ...CORS } });
    }
    return json({ error: 'not found' }, 404);
  }
};

const MAX_HISTORY = 150;
export class Space {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT, tier INTEGER, ro INTEGER, active INTEGER);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT, kind TEXT, members TEXT, who INTEGER, by TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, ch TEXT, uid TEXT, name TEXT, at INTEGER, text TEXT, photo TEXT, reply TEXT);
      CREATE INDEX IF NOT EXISTS messages_ch_at ON messages (ch, at);
      CREATE TABLE IF NOT EXISTS acks (mid TEXT, uid TEXT, PRIMARY KEY (mid, uid));
      CREATE TABLE IF NOT EXISTS reads (uid TEXT, ch TEXT, at INTEGER, PRIMARY KEY (uid, ch));`);
  }
  /* ---------- small helpers ---------- */
  q(sql, ...a) { return [...this.sql.exec(sql, ...a)]; }
  one(sql, ...a) { return this.q(sql, ...a)[0] || null; }
  meta(k, d) { const r = this.one('SELECT v FROM meta WHERE k = ?', k); try { return r ? JSON.parse(r.v) : d; } catch (_) { return d; } }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }
  rules() { return Object.assign({ makeChannel: 2, editChannel: 2, deleteAny: 2, deleteOwn: true, whoLabels: { 0: 'Everyone', 2: 'Organizers' } }, this.meta('rules', {})); }
  person(id) { return this.one('SELECT * FROM people WHERE id = ?', id); }
  whoLabel(n) { const L = this.rules().whoLabels || {}; return L[n] || L[String(n)] || 'Everyone'; }
  whoTier(label) { const L = this.rules().whoLabels || {}; const k = Object.keys(L).find(k => String(L[k]).toLowerCase() === String(label || '').toLowerCase()); return k ? Number(k) : 0; }
  /** The person behind a connection, refreshed from the roster (so a role change or switch-off applies at once). */
  me(who) { const p = this.person(who.u); return p ? { id: p.id, name: p.name, tier: p.tier, ro: !!p.ro, active: !!p.active } : { id: who.u, name: who.n, tier: Number(who.t) || 0, ro: !!who.ro, active: true }; }
  canSee(me, ch) {
    if (!me.active) return false;
    if (/^dm-/.test(ch)) { const ids = ch.split('-').slice(1); if (ids.length !== 2 || ids.indexOf(me.id) < 0 || ch !== 'dm-' + ids.slice().sort().join('-')) return false;
      return !!this.one('SELECT 1 FROM messages WHERE ch = ? LIMIT 1', ch) || ids.every(x => { const p = this.person(x); return p && p.active; }); }
    const c = this.one('SELECT * FROM channels WHERE id = ?', ch); if (!c) return false;
    return c.kind === 'channel' ? me.tier >= (c.who || 0) : String(c.members || '').split(',').indexOf(me.id) >= 0;
  }
  memberIds(ch) {
    if (/^dm-/.test(ch)) return ch.split('-').slice(1);
    const c = this.one('SELECT * FROM channels WHERE id = ?', ch); if (!c) return [];
    if (c.kind !== 'channel') return String(c.members || '').split(',').filter(Boolean);
    return this.q('SELECT id FROM people WHERE active = 1 AND tier >= ?', c.who || 0).map(r => r.id);
  }
  /** The conversation list for one person: newest first, with unread counts and the last message. */
  channelsFor(me) {
    const out = [], names = {}; this.q('SELECT id, name FROM people').forEach(p => { names[p.id] = p.name; });
    const unread = {}; this.q(`SELECT m.ch AS ch, COUNT(*) AS n FROM messages m LEFT JOIN reads r ON r.uid = ? AND r.ch = m.ch WHERE m.uid != ? AND m.at > COALESCE(r.at, 0) GROUP BY m.ch`, me.id, me.id).forEach(r => { unread[r.ch] = r.n; });
    const last = ch => { const m = this.one('SELECT name, text, photo, at FROM messages WHERE ch = ? ORDER BY at DESC LIMIT 1', ch); return m ? { from: m.name, text: String(m.text || '').slice(0, 80) || (m.photo && m.photo !== 'expired' ? '📷 Photo' : ''), at: new Date(m.at).toISOString() } : null; };
    this.q('SELECT * FROM channels ORDER BY created').forEach(c => {
      if (!this.canSee(me, c.id)) return;
      const ids = String(c.members || '').split(',').filter(Boolean);
      out.push({ id: c.id, name: c.name, kind: c.kind, who: c.kind === 'channel' ? this.whoLabel(c.who || 0) : '', members: c.kind === 'channel' ? [] : ids.map(x => names[x]).filter(Boolean), memberIds: c.kind === 'group' ? ids.filter(x => names[x]) : [], unread: unread[c.id] || 0, last: last(c.id) });
    });
    this.q("SELECT DISTINCT ch FROM messages WHERE ch LIKE 'dm-%' AND (ch LIKE ? OR ch LIKE ?)", '%-' + me.id, '%-' + me.id + '-%').forEach(({ ch }) => {
      if (ch.split('-').indexOf(me.id) < 1) return; const other = ch.split('-').slice(1).find(x => x !== me.id) || me.id;
      out.push({ id: ch, name: names[other] || 'Former member', kind: 'dm', who: '', members: ch.split('-').slice(1).map(x => names[x]).filter(Boolean), memberIds: [], unread: unread[ch] || 0, last: last(ch) });
    });
    return out.sort((a, b) => String((b.last || {}).at || '').localeCompare(String((a.last || {}).at || '')) || (a.kind === 'channel' ? -1 : 1));
  }
  shape(m, names) {
    const acks = this.q('SELECT uid FROM acks WHERE mid = ?', m.id).map(r => r.uid).filter(u => names[u]);
    let reply = null;
    if (m.reply) { const o = this.one('SELECT id, name, text, photo FROM messages WHERE id = ?', m.reply); reply = o ? { id: o.id, from: o.name, text: String(o.text || '').slice(0, 90), photo: o.photo && o.photo !== 'expired' ? 1 : 0 } : { id: m.reply, from: '', text: 'Older message', photo: 0 }; }
    return { id: m.id, fromId: m.uid, from: m.name, at: new Date(m.at).toISOString(), text: m.text || '', photo: m.photo && m.photo !== 'expired' ? 1 : 0, expired: m.photo === 'expired' ? 1 : 0, reply, acks: acks.map(u => names[u]), ackIds: acks };
  }
  names() { const n = {}; this.q('SELECT id, name FROM people').forEach(p => { n[p.id] = p.name; }); return n; }
  history(me, ch, find) {
    const names = this.names(), total = this.one('SELECT COUNT(*) AS n FROM messages WHERE ch = ?', ch).n;
    let limit = MAX_HISTORY;
    if (find) { const f = this.one('SELECT at FROM messages WHERE id = ? AND ch = ?', find, ch); if (f) { const newer = this.one('SELECT COUNT(*) AS n FROM messages WHERE ch = ? AND at >= ?', ch, f.at).n; limit = Math.min(400, Math.max(limit, newer + 20)); } }
    const rows = this.q('SELECT * FROM messages WHERE ch = ? ORDER BY at DESC LIMIT ?', ch, limit).reverse();
    return { ch, messages: rows.map(m => this.shape(m, names)), seen: this.seen(me, ch), more: total > rows.length ? 1 : 0 };
  }
  seen(me, ch) { return this.q('SELECT r.uid AS uid, r.at AS at, p.name AS name FROM reads r JOIN people p ON p.id = r.uid WHERE r.ch = ? AND r.uid != ? AND p.active = 1', ch, me.id).map(r => ({ id: r.uid, name: r.name, at: new Date(r.at).toISOString() })); }
  markRead(me, ch) { const now = Date.now(); this.sql.exec('INSERT INTO reads (uid, ch, at) VALUES (?, ?, ?) ON CONFLICT(uid, ch) DO UPDATE SET at = excluded.at', me.id, ch, now); return now; }
  /* ---------- live connections ---------- */
  sockets() { return this.ctx.getWebSockets().map(ws => { let a = null; try { a = ws.deserializeAttachment(); } catch (_) {} return { ws, a }; }).filter(x => x.a); }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (_) {} }
  /** Tell everyone who can see the conversation; everyone else's lists are untouched. */
  fanout(ch, build) {
    this.sockets().forEach(({ ws, a }) => { const me = this.me(a.who); if (this.canSee(me, ch)) { const o = build(me, a); if (o) this.send(ws, o); } });
  }
  refreshLists() { this.sockets().forEach(({ ws, a }) => { const me = this.me(a.who); this.send(ws, { t: 'channels', channels: me.active ? this.channelsFor(me) : [] }); }); }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/roster') return this.roster(await req.json());
    if (url.pathname === '/system') return this.system(await req.json());
    const who = JSON.parse(req.headers.get('x-who') || '{}');
    if (url.pathname === '/photo') {
      const me = this.me(who), m = this.one('SELECT ch, photo FROM messages WHERE id = ?', url.searchParams.get('id'));
      if (!m) return json({ error: 'That message is gone' }, 404);
      if (!this.canSee(me, m.ch)) return json({ error: 'You can\'t see that conversation' }, 403);
      if (!m.photo || m.photo === 'expired') return json({ error: 'That photo has expired' }, 404);
      return json({ key: m.photo });
    }
    if (url.pathname === '/ws') {
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [who.u]);
      server.serializeAttachment({ who, open: '', sid: crypto.randomUUID() });
      const me = this.me(who);
      this.send(server, { t: 'hello', me: me.id, channels: me.active ? this.channelsFor(me) : [], online: this.online() });
      this.presence();
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'not found' }, 404);
  }
  online() { return [...new Set(this.sockets().map(x => x.a.who.u))]; }
  presence() { const on = this.online(); this.sockets().forEach(({ ws }) => this.send(ws, { t: 'online', online: on })); }
  async webSocketClose(ws) { try { ws.close(); } catch (_) {} setTimeout(() => this.presence(), 0); }
  async webSocketError(ws) { try { ws.close(); } catch (_) {} }
  async webSocketMessage(ws, raw) {
    let a, msg; try { a = ws.deserializeAttachment(); msg = JSON.parse(raw); } catch (_) { return; }
    if (!a || !msg || !msg.t) return;
    if (a.who.e && a.who.e < Date.now() / 1000) { this.send(ws, { t: 'err', code: 'expired', msg: 'expired' }); try { ws.close(4001, 'expired'); } catch (_) {} return; }
    const me = this.me(a.who), reply = (o) => this.send(ws, Object.assign({ rid: msg.rid }, o)), fail = (text) => reply({ t: 'err', tmp: msg.tmp, msg: text });
    if (!me.active) return fail('This sign-in is switched off');
    try { await this.handle(ws, a, me, msg, reply, fail); } catch (e) { fail(String(e && e.message || e)); }
  }
  async handle(ws, a, me, msg, reply, fail) {
    const R = this.rules(), ch = String(msg.ch || '');
    switch (msg.t) {
      case 'ping': return reply({ t: 'pong' });
      case 'list': return reply({ t: 'channels', channels: this.channelsFor(me) });
      case 'close': ws.serializeAttachment(Object.assign(a, { open: '' })); return;      // left the conversation (or put the phone down): notify again
      case 'open': {
        if (!this.canSee(me, ch)) return fail('You can\'t see that conversation');
        ws.serializeAttachment(Object.assign(a, { open: ch }));
        const at = this.markRead(me, ch);
        reply(Object.assign({ t: 'history' }, this.history(me, ch, msg.find)));
        this.fanout(ch, (them, ta) => ta.who.u !== me.id && ta.open === ch ? { t: 'seen', ch, id: me.id, name: me.name, at: new Date(at).toISOString() } : null);
        return;
      }
      case 'read': { if (!this.canSee(me, ch)) return; const at = this.markRead(me, ch); this.fanout(ch, (them, ta) => ta.who.u !== me.id && ta.open === ch ? { t: 'seen', ch, id: me.id, name: me.name, at: new Date(at).toISOString() } : null); return; }
      case 'send': {
        if (me.ro) return fail('This sign-in is view-only');
        if (!this.canSee(me, ch)) return fail('You can\'t see that conversation');
        const text = String(msg.text || '').replace(/\u0000/g, '').trim().slice(0, 2000);
        const photo = msg.photo && String(msg.photo).indexOf(this.space() + '/' + me.id + '/') === 0 ? String(msg.photo) : '';
        if (!text && !photo) return;
        const replyTo = msg.reply && this.one('SELECT 1 FROM messages WHERE id = ? AND ch = ?', String(msg.reply), ch) ? String(msg.reply) : '';
        const id = 'm' + crypto.randomUUID().replace(/-/g, '').slice(0, 12), at = Date.now();
        this.sql.exec('INSERT INTO messages (id, ch, uid, name, at, text, photo, reply) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, ch, me.id, me.name, at, text, photo, replyTo);
        this.markRead(me, ch);
        const m = this.shape(this.one('SELECT * FROM messages WHERE id = ?', id), this.names());
        reply({ t: 'sent', tmp: msg.tmp, ch, m });
        this.fanout(ch, (them, ta) => ta.sid === a.sid ? null : { t: 'msg', ch, m });
        this.ctx.waitUntil(this.relayPush(me, ch, text, !!photo));
        return;
      }
      case 'ack': {
        if (me.ro) return fail('This sign-in is view-only');
        const m = this.one('SELECT * FROM messages WHERE id = ?', String(msg.id)); if (!m || !this.canSee(me, m.ch) || m.uid === me.id) return;
        if (this.one('SELECT 1 FROM acks WHERE mid = ? AND uid = ?', m.id, me.id)) this.sql.exec('DELETE FROM acks WHERE mid = ? AND uid = ?', m.id, me.id);
        else this.sql.exec('INSERT INTO acks (mid, uid) VALUES (?, ?)', m.id, me.id);
        const names = this.names(), ids = this.q('SELECT uid FROM acks WHERE mid = ?', m.id).map(r => r.uid).filter(u => names[u]);
        this.fanout(m.ch, () => ({ t: 'acks', ch: m.ch, id: m.id, acks: ids.map(u => names[u]), ackIds: ids }));
        return;
      }
      case 'del': {
        const m = this.one('SELECT * FROM messages WHERE id = ?', String(msg.id)); if (!m) return reply({ t: 'ok' });
        if (!(me.tier >= R.deleteAny || (R.deleteOwn && m.uid === me.id)) || me.ro) return fail(R.deleteOwn ? 'You can only delete your own messages' : 'Only managers can delete messages');
        if (m.photo && m.photo !== 'expired') this.ctx.waitUntil(this.env.PHOTOS.delete(m.photo));
        this.sql.exec('DELETE FROM messages WHERE id = ?', m.id); this.sql.exec('DELETE FROM acks WHERE mid = ?', m.id);
        this.fanout(m.ch, () => ({ t: 'deleted', ch: m.ch, id: m.id }));
        return reply({ t: 'ok' });
      }
      case 'search': {
        const q = String(msg.q || '').trim().toLowerCase(); if (q.length < 2) return reply({ t: 'results', results: [] });
        const vis = {}; this.channelsFor(me).forEach(c => { vis[c.id] = c; });
        const like = '%' + q.replace(/[%_]/g, '') + '%';
        const rows = this.q('SELECT * FROM messages WHERE (LOWER(text) LIKE ? OR LOWER(name) LIKE ?) ORDER BY at DESC LIMIT 300', like, q.replace(/[%_]/g, '') + '%');
        return reply({ t: 'results', results: rows.filter(m => vis[m.ch]).slice(0, 60).map(m => ({ id: m.id, channel: m.ch, name: vis[m.ch].name, kind: vis[m.ch].kind, from: m.name, at: new Date(m.at).toISOString(), text: String(m.text || '').slice(0, 160) || (m.photo ? '📷 Photo' : '') })) });
      }
      case 'newch': {
        if (me.ro) return fail('This sign-in is view-only');
        const kind = msg.kind === 'group' ? 'group' : 'channel', name = String(msg.name || '').trim().slice(0, 40); if (!name) return fail('Give it a name');
        if (kind === 'channel' && me.tier < R.makeChannel) return fail(R.channelHint || 'Only organizers can make channels – start a group instead');
        const act = this.q('SELECT id FROM people WHERE active = 1').map(r => r.id);
        let members = String(msg.members || '').split(',').filter((x, i, arr) => act.indexOf(x) >= 0 && arr.indexOf(x) === i);
        if (kind === 'group') { if (members.indexOf(me.id) < 0) members.push(me.id); if (members.length < 2) return fail('Pick at least one other person'); } else members = [];
        const id = 'c' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
        this.sql.exec('INSERT INTO channels (id, name, kind, members, who, by, created) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, kind, members.join(','), kind === 'channel' ? Math.min(me.tier, this.whoTier(msg.who)) : 0, me.name, Date.now());
        reply({ t: 'ok', id }); this.refreshLists(); return;
      }
      case 'editch': {
        const c = this.one('SELECT * FROM channels WHERE id = ?', String(msg.id)); if (!c) return fail('That conversation was removed');
        if (me.ro) return fail('This sign-in is view-only');
        if (c.kind === 'channel' ? me.tier < R.editChannel : String(c.members || '').split(',').indexOf(me.id) < 0) return fail(c.kind === 'channel' ? 'You can\'t edit channels' : 'Only people in this group can edit it');
        const name = String(msg.name || '').trim().slice(0, 40); if (!name) return fail('Give it a name');
        let members = c.members, who = c.who;
        if (c.kind === 'group' && msg.members !== undefined) {
          const act = this.q('SELECT id FROM people WHERE active = 1').map(r => r.id);
          const list = String(msg.members || '').split(',').filter((x, i, arr) => act.indexOf(x) >= 0 && arr.indexOf(x) === i);
          if (list.length < 2) return fail('A group needs at least two people'); members = list.join(',');
        }
        if (c.kind === 'channel' && msg.who !== undefined) who = Math.min(me.tier, this.whoTier(msg.who));
        this.sql.exec('UPDATE channels SET name = ?, members = ?, who = ? WHERE id = ?', name, members, who, c.id);
        reply({ t: 'ok' }); this.refreshLists(); return;
      }
    }
  }
  space() { return this.meta('space', ''); }
  /** The sheet sends who's who (and, once, the channels it already had). */
  roster(b) {
    if (!b || !Array.isArray(b.people)) return json({ error: 'bad roster' }, 400);
    this.setMeta('space', b.space || ''); this.setMeta('rules', b.rules || {}); this.setMeta('relay', b.relay || ''); this.setMeta('photoDays', Number(b.photoDays) || 60);
    this.sql.exec('DELETE FROM people');
    b.people.forEach(p => { if (p && p.id) this.sql.exec('INSERT INTO people (id, name, tier, ro, active) VALUES (?, ?, ?, ?, ?)', String(p.id), String(p.name || ''), Number(p.tier) || 0, p.ro ? 1 : 0, p.active ? 1 : 0); });
    if (Array.isArray(b.channels) && !this.one('SELECT 1 FROM channels LIMIT 1'))
      b.channels.forEach((c, i) => { if (c && c.id && c.name) this.sql.exec('INSERT OR IGNORE INTO channels (id, name, kind, members, who, by, created) VALUES (?, ?, ?, ?, ?, ?, ?)', String(c.id), String(c.name).slice(0, 40), c.kind === 'group' ? 'group' : 'channel', String(c.members || ''), this.whoTier(c.who), String(c.by || 'Setup'), Date.now() - 1e6 + i); });
    if (!this.one('SELECT 1 FROM channels LIMIT 1')) this.sql.exec("INSERT INTO channels (id, name, kind, members, who, by, created) VALUES ('general', 'Everyone', 'channel', '', 0, 'Setup', ?)", Date.now());
    this.ctx.storage.getAlarm().then(t => { if (!t) this.ctx.storage.setAlarm(Date.now() + 3600e3); });
    this.refreshLists();
    return json({ ok: true, people: b.people.length, channels: this.one('SELECT COUNT(*) AS n FROM channels').n });
  }
  /** A note from the sheet itself (e.g. "the schedule is posted") into a channel. */
  system(b) {
    const c = this.one('SELECT * FROM channels WHERE id = ?', String(b.ch || '')) || (b.match ? this.q("SELECT * FROM channels WHERE kind = 'channel'").find(x => new RegExp(String(b.match), 'i').test(x.name)) : null);
    if (!c) return json({ ok: false, error: 'no such channel' });
    const id = 'm' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    this.sql.exec('INSERT INTO messages (id, ch, uid, name, at, text, photo, reply) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, c.id, String(b.uid || 'system'), String(b.name || 'Dashboard'), Date.now(), String(b.text || '').slice(0, 2000), '', '');
    const m = this.shape(this.one('SELECT * FROM messages WHERE id = ?', id), this.names());
    this.fanout(c.id, () => ({ t: 'msg', ch: c.id, m }));
    return json({ ok: true, id });
  }
  /** Ask the sheet to send notifications (it knows everyone's settings and phones). */
  async relayPush(me, ch, text, photo) {
    const relay = this.meta('relay', ''), secret = this.env[SPACES[this.space()]]; if (!relay || !secret) return;
    const c = /^dm-/.test(ch) ? { id: ch, kind: 'dm', name: me.name } : this.one('SELECT id, kind, name FROM channels WHERE id = ?', ch); if (!c) return;
    const viewing = new Set(this.sockets().filter(x => x.a.open === ch).map(x => x.a.who.u));      // already looking at it: no buzz
    const to = this.memberIds(ch).filter(id => id !== me.id && !viewing.has(id));
    if (!to.length) return;
    const payload = JSON.stringify({ ch, kind: c.kind, name: c.name, from: { id: me.id, name: me.name }, text: String(text || '').slice(0, 200), photo, to, at: Date.now() });
    try { await fetch(relay, { method: 'POST', body: JSON.stringify({ fn: 'chatPush', args: [payload, await hmac(secret, payload)] }), redirect: 'follow' }); } catch (_) {}
  }
  /** Hourly: delete photos past the sheet's "Delete chat photos after" setting. */
  async alarm() {
    const days = this.meta('photoDays', 60), cut = Date.now() - days * 864e5;
    const old = this.q("SELECT id, photo FROM messages WHERE photo != '' AND photo != 'expired' AND at < ? LIMIT 500", cut);
    for (const m of old) { try { await this.env.PHOTOS.delete(m.photo); } catch (_) {} this.sql.exec("UPDATE messages SET photo = 'expired' WHERE id = ?", m.id); }
    this.ctx.storage.setAlarm(Date.now() + 3600e3);
  }
}
