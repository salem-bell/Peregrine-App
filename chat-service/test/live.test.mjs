// End-to-end test against `wrangler dev` (local): signed roster, tickets, live delivery, permissions, photos.
import { createHmac } from 'node:crypto';
import http from 'node:http';
const BASE = process.env.BASE || 'http://localhost:8799', WSB = BASE.replace(/^http/, 'ws');
const SECRET = 'test-family-secret', SPACE = 'family';
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const b64u = b => Buffer.from(b).toString('base64url');
const sign = text => createHmac('sha256', SECRET).update(text).digest('base64url');
const ticket = (u, n, t, ro = false, e = Date.now() / 1000 + 3600) => { const body = b64u(JSON.stringify({ s: SPACE, u, n, t, ro, e })); return body + '.' + sign(body); };
// a little "sheet" that records push relays
const pushes = []; const relay = http.createServer((q, r) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { pushes.push(JSON.parse(b)); r.end('{"ok":true}'); }); }).listen(8798);
const people = [{ id: 'pS', name: 'Salem', tier: 2, active: 1 }, { id: 'pB', name: 'Ben', tier: 1, active: 1 }, { id: 'pT', name: 'Tobias', tier: 1, active: 1 }, { id: 'pG', name: 'Grandpa', tier: 1, ro: 1, active: 1 }, { id: 'pX', name: 'Old', tier: 1, active: 0 }];
const rules = { makeChannel: 2, editChannel: 2, deleteAny: 2, deleteOwn: true, whoLabels: { 0: 'Everyone', 2: 'Organizers' } };
async function roster(extra = {}) { const body = JSON.stringify(Object.assign({ space: SPACE, people, rules, relay: 'http://localhost:8798/', photoDays: 60, channels: [{ id: 'general', name: 'Everyone', kind: 'channel', who: 'Everyone' }, { id: 'orgs', name: 'Organizers', kind: 'channel', who: 'Organizers' }] }, extra));
  return (await fetch(BASE + '/s/family/roster', { method: 'POST', body, headers: { 'x-sig': sign(body) } })).json(); }
function client(tk) {
  const ws = new WebSocket(WSB + '/s/family/ws?t=' + encodeURIComponent(tk)), inbox = [], waiters = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); inbox.push(m); waiters.slice().forEach(w => { if (w.f(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); } }); };
  const c = { ws, inbox, send: o => ws.send(JSON.stringify(o)),
    wait: (f, ms = 3000) => new Promise((res, rej) => { const hit = inbox.find(f); if (hit) { inbox.splice(inbox.indexOf(hit), 1); return res(hit); } const w = { f, res: m => { inbox.splice(inbox.indexOf(m), 1); res(m); } }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout waiting')); } }, ms); }),
    ready: new Promise(r => { ws.onopen = r; }) };
  c.ask = (o, f) => { const rid = Math.random().toString(36).slice(2); c.send(Object.assign({ rid }, o)); return c.wait(m => m.rid === rid && (!f || f(m))); };
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  // signatures
  ok((await fetch(BASE + '/s/family/roster', { method: 'POST', body: '{}', headers: { 'x-sig': 'nope' } })).status === 401, 'unsigned roster refused');
  const r = await roster(); ok(r.ok && r.people === 5 && r.channels === 2, 'roster + channel seed: ' + JSON.stringify(r));
  const refused = tk => new Promise(res => { const w = new WebSocket(WSB + '/s/family/ws?t=' + encodeURIComponent(tk)); w.onopen = () => { w.close(); res(false); }; w.onerror = () => res(true); });
  ok(await refused('bad.sig'), 'bad ticket refused');
  ok(await refused(ticket('pS', 'Salem', 2, false, Date.now() / 1000 - 5)), 'expired ticket refused');
  ok((await fetch(BASE + '/s/family/ws?t=bad.sig')).status === 401, 'bad ticket: 401');
  const S = client(ticket('pS', 'Salem', 2)), B = client(ticket('pB', 'Ben', 1)), T = client(ticket('pT', 'Tobias', 1)), G = client(ticket('pG', 'Grandpa', 1, true));
  await Promise.all([S.ready, B.ready, T.ready, G.ready]);
  const hs = await S.wait(m => m.t === 'hello'), hb = await B.wait(m => m.t === 'hello');
  ok(hs.channels.length === 2 && hb.channels.length === 1 && hb.channels[0].name === 'Everyone', 'organizer sees Organizers channel, member does not');
  // live delivery
  await S.ask({ t: 'open', ch: 'general' }, m => m.t === 'history'); await B.ask({ t: 'open', ch: 'general' }, m => m.t === 'history');
  const t0 = Date.now(); S.send({ t: 'send', ch: 'general', text: 'Hi everyone, @Tobias bring chairs', tmp: 'x1' });
  const sent = await S.wait(m => m.t === 'sent' && m.tmp === 'x1'), gotB = await B.wait(m => m.t === 'msg'), gotT = await T.wait(m => m.t === 'msg');
  ok(sent.m.id && gotB.m.id === sent.m.id && gotT.m.text.includes('chairs'), 'message reaches others live (' + (Date.now() - t0) + ' ms)');
  await sleep(300); const rel = pushes.pop(); const pl = rel && JSON.parse(rel.args[0]);
  ok(rel && rel.fn === 'chatPush' && createHmac('sha256', SECRET).update(rel.args[0]).digest('base64url') === rel.args[1], 'push relayed to the sheet, signed');
  ok(pl && pl.to.sort().join() === 'pG,pT' && pl.text.includes('Tobias'), 'push goes to people not looking at the chat (Ben had it open): ' + (pl && pl.to));
  // seen + unread
  const listT = await T.ask({ t: 'list' }); ok(listT.channels[0].unread === 1, 'unread count for Tobias');
  await T.ask({ t: 'open', ch: 'general' }, m => m.t === 'history'); const seen = await S.wait(m => m.t === 'seen' && m.name === 'Tobias'); ok(!!seen, 'sender sees "seen by Tobias" live');
  // reply + ack
  B.send({ t: 'send', ch: 'general', text: 'Yes!', reply: sent.m.id, tmp: 'x2' }); const r2 = await B.wait(m => m.t === 'sent' && m.tmp === 'x2'); ok(r2.m.reply && r2.m.reply.id === sent.m.id, 'reply quote');
  B.send({ t: 'ack', id: sent.m.id }); const ak = await S.wait(m => m.t === 'acks'); ok(ak.acks.join() === 'Ben', 'read mark shows live');
  S.send({ t: 'ack', id: sent.m.id }); await sleep(200); ok(!S.inbox.some(m => m.t === 'acks' && m.acks.length > 1), 'no read mark on own message');
  // viewer
  const gv = await G.ask({ t: 'send', ch: 'general', text: 'hi', tmp: 'g' }, m => m.t === 'err'); ok(/view-only/.test(gv.msg), 'viewer cannot send');
  // DMs
  const dm = 'dm-' + ['pS', 'pB'].sort().join('-');
  await S.ask({ t: 'open', ch: dm }, m => m.t === 'history'); S.send({ t: 'send', ch: dm, text: 'private', tmp: 'd' }); await S.wait(m => m.t === 'sent' && m.tmp === 'd');
  const bdm = await B.wait(m => m.t === 'msg' && m.ch === dm); ok(!!bdm, 'DM reaches Ben');
  await sleep(200); ok(!T.inbox.some(m => m.ch === dm), 'Tobias gets nothing from Salem–Ben DM');
  const td = await T.ask({ t: 'open', ch: dm }, m => m.t === 'err'); ok(/can't see/.test(td.msg), 'Tobias cannot open it');
  const tx = await T.ask({ t: 'open', ch: 'dm-pT-pX' }, m => m.t === 'err'); ok(!!tx, 'cannot start a DM with a switched-off person');
  // channels and groups
  const nc = await B.ask({ t: 'newch', kind: 'channel', name: 'Cousins' }, m => m.t === 'err' || m.t === 'ok'); ok(nc.t === 'err', 'member cannot make channels');
  const ng = await B.ask({ t: 'newch', kind: 'group', name: 'Reunion crew', members: 'pT' }, m => m.t === 'ok'); ok(!!ng.id, 'member makes a group');
  const tl = await T.wait(m => m.t === 'channels' && m.channels.some(c => c.name === 'Reunion crew')); ok(!!tl, 'group shows up for Tobias live');
  await sleep(200); const sl = S.inbox.filter(m => m.t === 'channels').pop(); ok(sl && !sl.channels.some(c => c.name === 'Reunion crew'), 'Salem not in the group, does not see it');
  const eg = await T.ask({ t: 'editch', id: ng.id, name: 'Reunion 2027', members: 'pB,pT,pS' }, m => m.t === 'ok' || m.t === 'err'); ok(eg.t === 'ok', 'group member renames + adds Salem');
  const sl2 = await S.wait(m => m.t === 'channels' && m.channels.some(c => c.name === 'Reunion 2027')); ok(!!sl2, 'Salem now sees the group');
  // delete
  const del1 = await B.ask({ t: 'del', id: sent.m.id }, m => m.t === 'err' || m.t === 'ok'); ok(del1.t === 'err', 'member cannot delete others');
  const del2 = await B.ask({ t: 'del', id: r2.m.id }, m => m.t === 'ok'); const gone = await S.wait(m => m.t === 'deleted' && m.id === r2.m.id); ok(!!gone, 'own message deleted, everyone told');
  // search
  const sr = await T.ask({ t: 'search', q: 'chairs' }, m => m.t === 'results'), sr2 = await T.ask({ t: 'search', q: 'private' }, m => m.t === 'results');
  ok(sr.results.length === 1 && sr2.results.length === 0, 'search respects access');
  // photos
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const up = await (await fetch(BASE + '/s/family/photo?t=' + encodeURIComponent(ticket('pS', 'Salem', 2)), { method: 'POST', body: jpg, headers: { 'content-type': 'image/jpeg' } })).json();
  ok(up.ok && /^family\/pS\//.test(up.key), 'photo upload');
  S.send({ t: 'send', ch: dm, text: '', photo: up.key, tmp: 'p' }); const pm = await S.wait(m => m.t === 'sent' && m.tmp === 'p'); ok(pm.m.photo === 1, 'photo message');
  const bp = await fetch(BASE + '/s/family/photo/' + pm.m.id + '?t=' + encodeURIComponent(ticket('pB', 'Ben', 1))); ok(bp.ok && Buffer.from(await bp.arrayBuffer()).equals(jpg), 'Ben can load the photo');
  const tp = await fetch(BASE + '/s/family/photo/' + pm.m.id + '?t=' + encodeURIComponent(ticket('pT', 'Tobias', 1))); ok(tp.status === 403, 'Tobias cannot load a photo from a DM he is not in');
  B.send({ t: 'send', ch: 'general', text: 'stolen', photo: up.key, tmp: 'st' }); const st = await B.wait(m => m.t === 'sent' && m.tmp === 'st'); ok(st.m.photo === 0, 'cannot attach someone else\'s upload');
  // roster change applies at once: Tobias switched off
  await roster({ people: people.map(p => p.id === 'pT' ? Object.assign({}, p, { active: 0 }) : p) });
  const off = await T.ask({ t: 'send', ch: 'general', text: 'still here?', tmp: 'o' }, m => m.t === 'err'); ok(/switched off/.test(off.msg), 'switched-off person is cut off immediately');
  // system note
  const sys = JSON.stringify({ ch: 'general', text: '📅 The schedule is posted', name: 'Salem', uid: 'pS' });
  const sr3 = await (await fetch(BASE + '/s/family/system', { method: 'POST', body: sys, headers: { 'x-sig': sign(sys) } })).json(); const sm = await B.wait(m => m.t === 'msg' && /schedule/.test(m.m.text)); ok(sr3.ok && !!sm, 'note from the sheet appears live');
  [S, B, T, G].forEach(c => c.ws.close());
} catch (e) { fail++; console.log('ERROR', e.message); }
relay.close();
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
