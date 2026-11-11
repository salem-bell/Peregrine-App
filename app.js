/* Peregrine Team – phone app. Talks to the Apps Script server in config.js; all data lives in the Google Sheet. */
'use strict';
const API = window.PEREGRINE_API || '';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Each location (Richardson, Westcliffe) is its own copy of the app on the same web address, so everything this phone keeps
// is named per location (config.js sets PT_NS, e.g. "wc-"): someone who works at both stays signed in to both, separately.
const NS = window.PT_NS || '';
const load = k => { try { return localStorage.getItem(NS + k); } catch (_) { return null; } };
const save = (k, v) => { try { v === null ? localStorage.removeItem(NS + k) : localStorage.setItem(NS + k, v); } catch (_) {} };
const WIDE = window.matchMedia('(min-width: 1000px)'); const wide = () => WIDE.matches;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let TOKEN = load('pt-token') || '', data = null, offline = false, tab = load('pt-tab') || 'today';
let inviteFor = '', listTab = '', schedMine = load('pt-mine') === '1', moreView = '', busy = {}, installEvt = null, showCode = {}, editUser = null, justAdded = null;
let week = '', sheet = null, chat = { open: '', msgs: [], timer: null, sending: false, compose: '' }, tsWeek = '', tsPerson = '', viewer = null, tsMode = load('pt-tsmode') || 'week', tsDate = '';
try { const c = load('pt-cache'); if (c && TOKEN) data = JSON.parse(c); } catch (_) {}

/* ---------- server ---------- */
/* ===== Live chat connection (shared by Bellah Family HQ and Peregrine Team) =====
 * One WebSocket to the chat service. Asks get an answer (promise); everything else the service sends
 * (new messages, read marks, "seen", deletes, list changes, who's online) goes to on(msg).
 * Reconnects on its own with a growing wait, fetches a fresh chat pass when the old one runs out,
 * and pauses while the app is hidden for a while so phones don't keep a connection open in a pocket.
 */
function LiveChat(o){   // o: { url, space, ticket: () => Promise<{ticket, exp}>, on(msg), onUp(), onDown() }
  let ws = null, pass = null, tries = 0, wait = 0, ping = 0, idle = 0, up = false, stopped = false, n = 0;
  const pend = {}, queue = [];
  const base = () => String(o.url).replace(/\/+$/, '');
  async function getPass(){
    if (pass && pass.exp * 1000 - Date.now() > 5 * 60000) return pass.ticket;
    pass = await o.ticket();
    // kept where the notification handler can reach it, so a notification arriving counts as "Delivered"
    try { const c = await caches.open(NS + 'chat-pass'); await c.put('/chat-pass', new Response(JSON.stringify({ url: base(), space: o.space, ticket: pass.ticket, exp: pass.exp }))); } catch (_) {}
    return pass.ticket;
  }
  async function connect(){
    if (stopped || ws || document.hidden) return;
    clearTimeout(wait);
    let t; try { t = await getPass(); } catch (e) { if (/unauthorized|^signin/.test(String(e && e.message))) { stop(); return; } return later(); }
    if (stopped || ws) return;
    let opened = false;
    const s = ws = new WebSocket(base().replace(/^http/, 'ws') + '/s/' + o.space + '/ws?t=' + encodeURIComponent(t));
    s.onopen = () => { opened = true; };
    s.onmessage = e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d.t === 'hello'){ up = true; tries = 0; clearInterval(ping); ping = setInterval(() => raw({ t: 'ping' }), 25000); queue.splice(0).forEach(x => s.send(x)); }
      if (d.t === 'err' && d.code === 'expired'){ pass = null; }
      if (d.rid && pend[d.rid]){ const p = pend[d.rid]; delete pend[d.rid]; clearTimeout(p.to); if (d.t === 'err') p.no(new Error(d.msg || 'Something went wrong')); else p.yes(d); return; }
      if (d.t === 'pong') return;
      try { o.on(d); } catch (err) { console.error(err); }
      if (d.t === 'hello' && o.onUp) try { o.onUp(); } catch (err) { console.error(err); }
    };
    s.onclose = ev => {
      if (ws === s) ws = null; const was = up; up = false; clearInterval(ping);
      if (!opened || ev.code === 4001) pass = null;           // refused at the door: usually an old pass
      Object.keys(pend).forEach(k => { const p = pend[k]; delete pend[k]; clearTimeout(p.to); p.no(new Error('The connection dropped – try again')); });
      if (was && o.onDown) try { o.onDown(); } catch (_) {}
      if (!stopped) later();
    };
    s.onerror = () => {};
  }
  function later(){ clearTimeout(wait); const ms = Math.min(30000, 800 * Math.pow(2, tries++)) * (0.7 + Math.random() * 0.6); wait = setTimeout(connect, ms); }
  function raw(x){ const s = JSON.stringify(x); if (ws && up) { try { ws.send(s); } catch (_) {} } else { queue.push(s); if (queue.length > 50) queue.shift(); connect(); } }
  /** Fire and forget (read marks, acks, leaving a conversation). */
  function send(x){ raw(x); }
  /** A question with an answer: open, send, search, new/edit channel, delete. */
  function ask(x, ms){
    const rid = 'r' + (++n) + Math.random().toString(36).slice(2, 6);
    return new Promise((yes, no) => { pend[rid] = { yes, no, to: setTimeout(() => { if (pend[rid]) { delete pend[rid]; no(new Error('No answer from the chat – check your connection')); } }, ms || 15000) }; raw(Object.assign({ rid }, x)); });
  }
  /** Photos: uploaded first, then sent as part of the message. */
  async function upload(dataUrl){
    const blob = await (await fetch(dataUrl)).blob(), t = await getPass();
    const r = await fetch(base() + '/s/' + o.space + '/photo?t=' + encodeURIComponent(t), { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'image/jpeg' } });
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.key) { if (r.status === 401) pass = null; throw new Error(j.error || 'The photo didn\'t upload'); }
    return j.key;
  }
  async function photo(id){
    const t = await getPass(), r = await fetch(base() + '/s/' + o.space + '/photo/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(t));
    if (!r.ok) { const j = await r.json().catch(() => ({})); if (r.status === 401) pass = null; throw new Error(j.error || 'Couldn\'t load the photo'); }
    const b = await r.blob();
    return await new Promise((yes, no) => { const f = new FileReader(); f.onload = () => yes(f.result); f.onerror = () => no(new Error('Couldn\'t read the photo')); f.readAsDataURL(b); });
  }
  function stop(){ try { caches.delete(NS + 'chat-pass'); } catch (_) {} stopped = true; clearTimeout(wait); clearTimeout(idle); clearInterval(ping); if (ws) try { ws.close(1000); } catch (_) {} ws = null; up = false; }
  document.addEventListener('visibilitychange', () => {
    if (stopped) return;
    clearTimeout(idle);
    if (document.hidden) idle = setTimeout(() => { if (document.hidden && ws) try { ws.close(1000); } catch (_) {} }, 60000);
    else { tries = 0; connect(); }
  });
  window.addEventListener('online', () => { if (!stopped) { tries = 0; connect(); } });
  connect();
  return { send, ask, upload, photo, stop, get up(){ return up; } };
}

/* Requests out right now. A phone that sleeps mid-request (locked screen, app switched away) can leave a fetch hanging
   with no answer ever coming – the app then sat on "Saving…" or old data until you closed it. When the app comes back,
   anything that has been waiting more than a few seconds is cancelled and loads are tried again straight away. */
const INFLIGHT = new Set();
async function post(body, o){
  if (!API) throw new Error('This app isn\'t connected to its server yet (config.js).');
  const isRead = body.fn === 'api' && !(body.p && (body.p.action || body.p.actions));
  const ctl = new AbortController(), rec = { ctl, at: Date.now(), read: isRead }, t = setTimeout(() => ctl.abort(), isRead ? 20000 : 45000);
  INFLIGHT.add(rec);
  try {
    const res = await fetch(API, { method: 'POST', body: JSON.stringify(body), signal: ctl.signal, redirect: 'follow' });   // text/plain: no CORS preflight
    const out = await res.json();
    if (out && out.error) throw new Error(out.error);
    return out;
  } catch (e) {
    const m = e.name === 'AbortError' ? 'timeout' : String(e.message || e);
    // a load that timed out, got cut off, or was cancelled after the phone slept: one quick retry (never for saves, which might already have gone through)
    if (isRead && !(o && o.retried) && !/^signin/.test(m) && (m === 'timeout' || /fetch|network|load/i.test(m))) return post(body, { retried: true });
    throw new Error(m);
  }
  finally { clearTimeout(t); INFLIGHT.delete(rec); }
}
/* Fast loading: the Sheet keeps a ready-made copy of everyone's data on Cloudflare (data.edge), refreshed within a minute
   of any change. Loads come from there; saves always go to the Sheet. After you save something, a copy older than
   your save is ignored, so your own change never seems to vanish. Anything odd – no copy, too old, can't reach it –
   and the app asks the Sheet as before. */
let EDGE = load('pt-edge') || '', lastWriteAt = Number(load('pt-lastwrite') || 0);
function wrote(got){ const t = Date.parse(got && got.updated) || Date.now(); if (t > lastWriteAt){ lastWriteAt = t; save('pt-lastwrite', String(t)); } }
async function edgeLoad(){
  if (!EDGE || !TOKEN) return null;
  const ctl = new AbortController(), rec = { ctl, at: Date.now(), read: true }, t0 = Date.now(), t = setTimeout(() => ctl.abort(), 6000);
  INFLIGHT.add(rec);
  try {
    const r = await fetch(EDGE + '/s/' + ((data && data.space) || window.PT_SPACE || 'peregrine') + '/state', { method: 'POST', body: JSON.stringify({ token: TOKEN }), signal: ctl.signal });
    if (!r.ok) return null;
    const at = Number(r.headers.get('x-pushed-at') || 0), out = await r.json();
    if (!out || !out.ok || at < lastWriteAt) return null;
    console.info('[Peregrine] loaded from Cloudflare in ' + (Date.now() - t0) + 'ms (data from ' + Math.round((Date.now() - at) / 1000) + 's ago)');
    return out;
  } catch (_) { return null; }
  finally { clearTimeout(t); INFLIGHT.delete(rec); }
}
function unstick(){ const now = Date.now(); INFLIGHT.forEach(r => { if (now - r.at > (r.read ? 4000 : 15000)) r.ctl.abort(); }); }
// Answers can arrive out of order: show only the newest, and never let a background refresh overwrite a change that is still saving.
let seqStarted = 0, seqShown = 0, pending = 0, lastAct = 0;
// Batched saves (server 2.6+): edits queue up while one request is out, then go together in one request.
// New shifts carry their temporary id (cid) so later edits to them work before the server has answered.
let queue = [], flying = false, flushT = null;
const idMap = {}, SLIM = /^(saveShift|addShift|deleteShift|restoreShift|copyWeek|clearWeek|scheduleOrder|setOnSchedule|setWage)$/;
const canBatch = () => !!(data && Number(data.version) >= 2.6);
function act(action, params){
  if (!canBatch()){ const pr = refresh(Object.assign({ action }, params || {})); saving(); pr.finally(saving); return pr; }
  return new Promise(res => {
    queue.push({ p: Object.assign({ action }, params || {}), res }); pending++; saving();
    if (!flying){ clearTimeout(flushT); flushT = setTimeout(flush, 120); }
  });
}
async function flush(){
  if (flying || !queue.length || !TOKEN) return;
  const batch = queue.splice(0), actions = batch.map(b => { const a = Object.assign({}, b.p); if (a.id && idMap[a.id]) a.id = idMap[a.id]; return a; });
  flying = true;
  let got = null, err = null;
  try { got = await post({ fn: 'api', token: TOKEN, p: { actions, slim: actions.every(a => SLIM.test(a.action)) } }); } catch (e) { err = e; }
  flying = false; pending -= batch.length;
  if (err){
    const m = String(err.message || err);
    batch.forEach(b => b.res(null));
    if (/^signin/.test(m)){ queue = []; pending = 0; saving(); signOut(m.replace(/^signin:\s*/, '')); return; }
    toast(m === 'timeout' ? 'That took too long – check it saved' : m);
    if (queue.length) flush(); else { saving(); setTimeout(() => refresh(), 300); }
    return;
  }
  wrote(got);
  const res = got.results || [];
  actions.forEach((a, i) => { if (a.cid && res[i] && res[i].id) idMap[a.cid] = res[i].id; });
  const bad = res.find(x => x && x.error); if (bad) toast(bad.error);
  if (typeof got.ms === 'number') console.info('[Peregrine] saved ' + batch.length + ' change' + (batch.length === 1 ? '' : 's') + ' – server ' + (got.ms / 1000).toFixed(1) + 's');
  if (!queue.length){   // nothing newer waiting: show the server's copy (a newer edit would otherwise be wiped from the screen)
    seqShown = ++seqStarted; busy = {}; offline = false;
    const keep = data; data = got.partial ? Object.assign({}, keep, got) : got; delete data.results; delete data.partial; liveSync();
    save('pt-cache', JSON.stringify(data)); render();
  }
  batch.forEach((b, i) => b.res(res[i] && res[i].error ? null : Object.assign({}, data, { result: res[i] })));
  saving();
  if (queue.length) flush();
}
async function refresh(p, o){
  if (!TOKEN){ data = null; render(); return; }
  const isAct = !!(p && p.action), seq = ++seqStarted;
  if (isAct){ pending++; lastAct = seq; }
  let got = null, err = null;
  try { got = (!isAct && !(o && o.fresh) && await edgeLoad()) || await post({ fn: 'api', token: TOKEN, p: p || {} }); } catch (e) { err = e; }
  if (got && got.edge !== undefined && got.edge !== EDGE){ EDGE = got.edge; save('pt-edge', EDGE); }
  if (isAct && got) wrote(got);
  if (isAct) pending--;
  if (!err && (seq < seqShown || (!isAct && pending) || (isAct && seq !== lastAct))) return got;
  seqShown = seq; busy = {};
  if (err){
    const m = String(err.message || err);
    if (/^signin/.test(m)){ signOut(m.replace(/^signin:\s*/, '')); return; }
    if (isAct) toast(m === 'timeout' ? 'That took too long – check it saved' : m);
    else { offline = true; if (m !== 'timeout' && !/fetch|network|load/i.test(m)) toast(m); }
    if (isAct && !pending) setTimeout(() => refresh(), 300);
    render(); return null;
  }
  data = got; offline = false; liveSync(); save('pt-cache', JSON.stringify(data)); render(); pushCheck(); if (pendingGo){ const g = pendingGo; pendingGo = ''; goTo(g); } return got;
}
function saving(){ const el = $('#saving'); if (el) el.hidden = !pending; }
function signOut(msg){ lastWriteAt = 0; save('pt-lastwrite', null); stopChat(); liveEnd(); TOKEN = ''; data = null; save('pt-token', null); save('pt-cache', null); render(); if (msg) toast(msg.charAt(0).toUpperCase() + msg.slice(1)); }

/* ---------- formatting ---------- */
const pad = n => String(n).padStart(2, '0');
const ymdOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const plus = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ymdOf(d); };
const T = () => data ? data.today : ymdOf(new Date());
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monday = s => plus(s, -((pd(s).getDay() + 6) % 7));
const dayName = s => s === T() ? 'Today' : s === plus(T(), 1) ? 'Tomorrow' : s === plus(T(), -1) ? 'Yesterday' : pd(s).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const shortDay = s => pd(s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const t12s = hm => t12(hm).replace(/([ap])m$/, '$1');   // 5:30a – compact, for the week grid
const t12 = hm => { if (!hm) return ''; let [h, m] = hm.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + (m ? ':' + pad(m) : '') + ap; };
const mins = hm => { const [h, m] = (hm || '0:0').split(':').map(Number); return h * 60 + m; };
const hrs = m => (Math.round(m / 6) / 10).toFixed(1).replace(/\.0$/, '') + 'h';
const ago = iso => { if (!iso) return ''; const m = Math.round((Date.now() - new Date(iso)) / 6e4); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const timeOf = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase() : '';
const hmOf = iso => { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const mgr = () => data && data.me.role === 'Manager', lead = () => data && (data.me.role === 'Lead' || mgr());
const first = n => String(n || '').split(' ')[0];
function toast(m){ const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => t.style.display = 'none', 3200); }
const rowBtn = (attrs, inner) => { let cls = ''; attrs = attrs.replace(/\s*class="([^"]*)"/, (_, c) => { cls = ' ' + c; return ''; }); return `<button class="row rb${cls}" ${attrs}>${inner}</button>`; };

/* ---------- schedule logic ---------- */
const shiftsOn = d => (data.shifts || []).filter(s => s.date === d);
/** Shifts as the team sees them (managers and leads also get drafts and pending changes, marked by status). */
const live = s => !s.status || s.status === 'published' || s.status === 'changed';
const notGone = s => s.status !== 'removed';
const STATUS = { draft: ['mute', 'Draft'], changed: ['warn', 'Not published'], removed: ['warn', 'Removing'] };
const statusPill = s => STATUS[s.status] ? `<span class="pill ${STATUS[s.status][0]}">${STATUS[s.status][1]}</span>` : '';
const weekPending = wk => (data.shifts || []).filter(s => s.date >= wk && s.date <= plus(wk, 6) && s.status && s.status !== 'published');
const approvedOff = (name, d) => (data.requests || []).some(q => q.from === name && q.type === 'Time off' && q.date === d && q.status === 'Approved');
const pendingOff = (name, d) => (data.requests || []).some(q => q.from === name && q.type === 'Time off' && q.date === d && q.status === 'Pending');
function unavail(name, d, start, end){       // the availability rule that clashes with this time, if any
  return (data.availability || []).find(a => a.name === name && (a.day === d || a.day === DOW[pd(d).getDay()]) &&
    (!a.from || !start || (mins(start) < mins(a.to) && mins(end || '23:59') > mins(a.from))));
}
function conflicts(s){
  const out = [];
  if (approvedOff(s.name, s.date)) out.push(['warn', 'Time off']);
  else if (pendingOff(s.name, s.date)) out.push(['mute', 'Asked for off']);
  const u = unavail(s.name, s.date, s.start, s.end); if (u) out.push(['warn', u.from ? 'Unavailable ' + t12(u.from) + '–' + t12(u.to) : 'Unavailable']);
  if (s.status !== 'removed' && (data.shifts || []).some(x => x !== s && x.id !== s.id && notGone(x) && x.name === s.name && x.date === s.date && mins(x.start) < mins(s.end) && mins(x.end) > mins(s.start))) out.push(['warn', 'Double-booked']);
  return out;
}

/* ---------- scheduling lineup: who shows on the schedule, in what order ---------- */
const ROLE_ORDER = { Manager: 0, Lead: 1, Staff: 2 };
function lineup(){       // active people, manager-chosen order first, then by role and name
  const src = mgr() ? (data.users || []).filter(u => u.active) : (data.people || []);
  return src.slice().sort((a, b) => ((a.order || 9999) - (b.order || 9999)) || ((ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3)) || a.name.localeCompare(b.name));
}
const shown = p => p.onSchedule !== false;

/* ---------- wage estimates (managers only; wages never reach staff phones) ---------- */
const wageOf = n => { const u = (data.users || []).find(x => x.name === n); return u ? Number(u.wage) || 0 : (data.myPay && n === data.me.name ? Number(data.myPay.wage) || 0 : 0); };
const money = (x, cents) => '$' + (cents ? (Math.round(x * 100) / 100).toFixed(2) : Math.round(x).toLocaleString());
/** items: [{key, name, date, sort, h}] within one Mon–Sun week. Overtime past the weekly threshold, in time order, at the overtime rate. */
function labor(items, o){
  const P = data.pay || data.myPay || { ot: 40, otRate: 1.5, extra: 0 }, k = o && o.noExtra ? 1 : 1 + (Number(P.extra) || 0) / 100;
  const out = { byKey: {}, otByKey: {}, byPerson: {}, byDay: {}, hoursByPerson: {}, ot: {}, total: 0, missing: [] }, groups = {};
  items.forEach(i => (groups[i.name] = groups[i.name] || []).push(i));
  Object.keys(groups).forEach(n => {
    const w = wageOf(n); if (!w) out.missing.push(n);
    let acc = 0;
    groups[n].sort((a, b) => a.sort.localeCompare(b.sort)).forEach(i => {
      const reg = Math.max(0, Math.min(i.h, P.ot - acc)), over = i.h - reg; acc += i.h;
      const c = (reg * w + over * w * P.otRate) * k;
      out.byKey[i.key] = c; out.byPerson[n] = (out.byPerson[n] || 0) + c; out.byDay[i.date] = (out.byDay[i.date] || 0) + c; out.total += c;
      out.hoursByPerson[n] = acc; if (over > 0){ out.ot[n] = (out.ot[n] || 0) + over; out.otByKey[i.key] = over; }
    });
  });
  return out;
}
const shiftItems = list => list.map(s => ({ key: s.id, name: s.name, date: s.date, sort: s.date + s.start, h: Math.max(0, mins(s.end) - mins(s.start)) / 60 }));
const punchItems = list => list.filter(p => p.in && p.out).map(p => ({ key: p.id, name: p.name, date: p.date, sort: p.in, h: Math.max(0, new Date(p.out) - new Date(p.in)) / 36e5 }));
const weekShifts = wk => (data.shifts || []).filter(s => notGone(s) && s.date >= wk && s.date <= plus(wk, 6));
/** Punches with any open one counted up to right now (older than 16h = a missed clock-out, left out). */
const punchesNow = name => (data.punches || []).filter(p => p.in && (!name || p.name === name))
  .map(p => p.out ? p : Date.now() - new Date(p.in) < 16 * 36e5 ? Object.assign({}, p, { out: new Date().toISOString(), running: true }) : null).filter(Boolean);
/** Hours and cost for the days from..to. Each Mon–Sun week is worked out whole (so overtime lands on the right days), then only the days in range are added up. */
function costIn(items, from, to, o){
  const out = { total: 0, hours: 0, byPerson: {}, byDay: {}, hoursByPerson: {}, hoursByDay: {}, ot: {}, missing: [] };
  [...new Set(items.filter(i => i.date >= from && i.date <= to).map(i => monday(i.date)))].forEach(wk => {
    const inWk = items.filter(i => i.date >= wk && i.date <= plus(wk, 6)), L = labor(inWk, o);
    inWk.filter(i => i.date >= from && i.date <= to).forEach(i => { const c = L.byKey[i.key] || 0, n = i.name;
      out.total += c; out.hours += i.h; out.byPerson[n] = (out.byPerson[n] || 0) + c; out.byDay[i.date] = (out.byDay[i.date] || 0) + c;
      out.hoursByPerson[n] = (out.hoursByPerson[n] || 0) + i.h; out.hoursByDay[i.date] = (out.hoursByDay[i.date] || 0) + i.h;
      if (L.otByKey[i.key]) out.ot[n] = (out.ot[n] || 0) + L.otByKey[i.key]; });
    L.missing.forEach(n => { if (out.missing.indexOf(n) < 0) out.missing.push(n); });
  });
  return out;
}
/** The pay period a date falls in: Weekly, Every 2 weeks (from the "Pay period starts on" date) or Twice a month (1st–15th, 16th–end). */
function periodOf(d){
  const P = data.period || { kind: 'biweek', start: '' };
  if (P.kind === 'semi'){ const ym = d.slice(0, 8), [y, m, dd] = d.split('-').map(Number); return dd <= 15 ? [ym + '01', ym + '15'] : [ym + '16', ym + pad(new Date(y, m, 0).getDate())]; }
  const len = P.kind === 'week' ? 7 : 14, anchor = P.start || '2026-01-05', off = ((Math.round((pd(d) - pd(anchor)) / 864e5) % len) + len) % len, from = plus(d, -off);
  return [from, plus(from, len - 1)];
}
const rangeOf = (mode, d) => mode === 'day' ? [d, d] : mode === 'period' ? periodOf(d) : [monday(d), plus(monday(d), 6)];
/** Live estimate for the shift being edited, counting the rest of that person's week (so overtime shows up). */
function shiftEstimate(f){
  const g = n => (f.elements.namedItem(n) || {}).value || '', name = g('name'), date = g('date'), start = g('start'), end = g('end');
  if (!mgr() || !name || !date || !start || !end || end <= start) return '';
  const w = wageOf(name); if (!w) return `<span class="sub">No wage set for ${esc(first(name))} – add it in Team to see an estimate.</span>`;
  const wk = monday(date), others = weekShifts(wk).filter(s => s.id !== (sheet && sheet.id));
  const L = labor(shiftItems(others.concat([{ id: '_this', name, date, start, end }])));
  const h = (mins(end) - mins(start)) / 60, c = L.byKey._this || 0, regCost = h * w * (1 + (Number((data.pay || {}).extra) || 0) / 100);
  return `<b>Est. ${money(c, true)}</b> <span class="sub">· ${hrs(h * 60)} × ${money(w, true)}/h${c > regCost + 0.005 ? ' · includes overtime' : ''} · ${esc(first(name))}'s week: ${hrs(L.hoursByPerson[name] * 60)}${L.ot[name] ? ' (' + hrs(L.ot[name] * 60) + ' overtime)' : ''}, ${money(L.byPerson[name] || 0)}</span>`;
}

/* ---------- time sheet logic ---------- */
function weekReport(wk, name){ return rangeReport(wk, plus(wk, 6), name); }
function rangeReport(from, to, name){
  const days = [], now = new Date(); for (let d = from; d <= to; d = plus(d, 1)) days.push(d);
  const people = name ? [name] : [...new Set((data.shifts || []).filter(s => days.includes(s.date)).map(s => s.name).concat((data.punches || []).filter(p => days.includes(p.date)).map(p => p.name)))].sort();
  const late = data.lateAfter || 5;
  return people.map(n => {
    const sh = (data.shifts || []).filter(s => live(s) && s.name === n && days.includes(s.date)), pu = (data.punches || []).filter(p => p.name === n && days.includes(p.date));
    let sched = 0, worked = 0, lates = 0, noShow = 0, missingOut = 0, running = false; const lines = [];
    sh.forEach(s => {
      sched += mins(s.end) - mins(s.start);
      const p = pu.find(x => x.shift === s.id) || pu.find(x => !x.shift && x.date === s.date);
      const started = new Date(pd(s.date).getTime() + mins(s.end) * 6e4) < now;
      const lateBy = p && p.in ? Math.round((new Date(p.in) - new Date(pd(s.date).getTime() + mins(s.start) * 6e4)) / 6e4) : 0;
      if (p && lateBy > late) lates++;
      if (!p && started && !approvedOff(n, s.date)) noShow++;
      lines.push({ date: s.date, shift: s, punch: p, lateBy, noShow: !p && started && !approvedOff(n, s.date) });
    });
    pu.forEach(p => {
      if (p.in && p.out) worked += (new Date(p.out) - new Date(p.in)) / 6e4;
      else if (p.in && !p.out && (now - new Date(p.in)) <= 16 * 36e5){ worked += (now - new Date(p.in)) / 6e4; running = true; }
      else if (p.in && !p.out && (now - new Date(p.in)) > 16 * 36e5) missingOut++;
      if (!lines.some(l => l.punch === p)) lines.push({ date: p.date, shift: null, punch: p, unscheduled: true });
    });
    lines.sort((a, b) => (a.date + (a.shift ? a.shift.start : hmOf(a.punch.in))).localeCompare(b.date + (b.shift ? b.shift.start : hmOf(b.punch.in))));
    return { name: n, sched, worked, running, lates, noShow, missingOut, unscheduled: lines.filter(l => l.unscheduled).length, lines };
  });
}

/* ---------- locations: managers switch between shops with the shop name at the top (locations.js) ---------- */
const LOCS = window.PT_LOCATIONS || [], HOME = window.PT_HOME || 'richardson', HERE = window.PT_LOC || HOME;
const locName = k => (LOCS.find(l => l.key === k) || {}).name || k;
const canSwitch = () => LOCS.length > 1 && (HERE !== HOME || (data && mgr()));
function switchTo(k){ try { k === HOME ? localStorage.removeItem('pt-loc@' + HOME) : localStorage.setItem('pt-loc@' + HOME, k); } catch (_) {} location.replace(location.pathname + location.search); }
function locSheet(){
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">Location</h1><button class="btn sm" data-closesheet>Close</button></div>
    <div class="card" style="margin-top:12px">${LOCS.map(l => { let signed = false; try { signed = !!localStorage.getItem(l.ns + 'pt-token'); } catch (_) {}
      return rowBtn(`data-loc="${esc(l.key)}"`, `<div class="txt"><b>${esc(l.name)}</b><div class="sub">${l.key === HERE ? 'You\'re here' : signed ? 'Signed in' : 'Sign in once, then switch any time'}</div></div>${l.key === HERE ? '<span class="pill ok">✓</span>' : '<span>›</span>'}`); }).join('')}</div>
    <p class="sub">Each location is its own team, schedule and time clock. You stay signed in to each one on this ${deviceKind()}.</p></div></div>`;
}

/* ---------- invite links: a manager adds someone and sends them their link. The person opens it, types their phone and
   email, and that creates their account – their code is the last 4 digits of their phone, and they're signed in.
   The link is the app address + #join=<id.signature>; it holds no code, and it works once. ---------- */
const appHome = () => window.PT_APPURL || location.origin + location.pathname.replace(/index\.html$/, '');
const inviteLink = u => appHome() + '#join=' + u.invite;
const inviteText = u => `Hi ${first(u.name)}! Here's the Peregrine team app – schedule, time clock, messages and checklists.\n\nOpen this link on your phone to set up your account: ${inviteLink(u)}\n\nYou'll add your phone number and email, and your sign-in code will be the last 4 digits of your phone.`;
let invite = null, joined = null;   // invite: { key, first, name, shop, err } while setting up; joined: { first, code } right after
{ const m = location.hash.match(/^#join=([\w]+\.[0-9a-f]{24})$/); if (m) invite = { key: m[1] }; }
function loadInvite(){
  post({ fn: 'joinInfo', invite: invite.key }).then(r => { if (invite){ Object.assign(invite, { first: r.first, name: r.name, shop: r.shop }); render(); } })
    .catch(e => { if (invite){ invite.err = String(e.message || e) === 'timeout' ? 'The server took too long – reload to try again.' : String(e.message || e); render(); } });
}

/* ---------- screens ---------- */
function viewSignIn(){
  if (invite && !invite.err) return viewWelcome();
  const hint = !standalone() ? (isIOS()
    ? `<div class="hint"><b>Put it on your home screen:</b> tap <b>Share</b> <span aria-hidden="true">⬆︎</span> at the bottom of Safari, then <b>Add to Home Screen</b>. Open it from there and sign in.</div>`
    : installEvt ? `<div class="hint"><b>Install the app</b> for one-tap access. <button class="btn sm go" data-install>Install</button></div>`
    : `<div class="hint"><b>Put it on your home screen:</b> in Chrome, tap <b>⋮</b> then <b>Add to Home screen</b> (or <b>Install app</b>).</div>`) : '';
  return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">${esc((data && data.name) || load('pt-shop') || window.PT_NAME || 'Peregrine')}</p><p class="sub" style="text-align:center;margin:0 0 18px">Team sign-in</p>
    ${HERE !== HOME ? `<div class="hint">Signing in to <b>${esc(locName(HERE))}</b>. Your ${esc(locName(HOME))} sign-in stays as it is. <button class="btn sm" data-loc="${esc(HOME)}" style="margin-top:8px">‹ Back to ${esc(locName(HOME))}</button></div>` : ''}${invite && invite.err ? `<div class="hint">${esc(invite.err)}</div>` : ''}${HERE !== HOME ? '' : hint}<div class="card"><form class="stack" data-form="signin">
      <label class="f">First name<input name="name" autocomplete="username" autocapitalize="words" spellcheck="false" maxlength="60" value="${esc(load('pt-last') || '')}"></label>
      <label class="f">4-digit code<input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="current-password" class="code" style="text-align:center"></label>
      <button class="btn go">Sign in</button></form></div>
    <p class="sub" style="text-align:center">Don't know your code? Ask a manager.</p><i class="sprig" aria-hidden="true"></i></div>`;
}

/** What someone sees when they open their invite link: add phone + email, and the account is made. */
function viewWelcome(){
  const i = invite, shop = esc(i.shop || (data && data.name) || load('pt-shop') || window.PT_NAME || 'Peregrine');
  if (!i.first) return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">Welcome</p><div class="empty">Opening your invite…</div></div>`;
  return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">Welcome, ${esc(i.first)}</p><p class="sub" style="text-align:center;margin:0 0 18px">Set up your ${shop} team account</p>
    <div class="card"><form class="stack" data-form="join">
      <label class="f">Your name<input value="${esc(i.name)}" disabled></label>
      <label class="f">Mobile phone<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="(214) 555-0123" required></label>
      <label class="f">Email<input name="email" type="email" autocomplete="email" maxlength="120" placeholder="you@example.com" required></label>
      <p class="sub" style="margin:0">Your sign-in code will be the <b>last 4 digits of your phone number</b>. Your email is for shift reminders.</p>
      <button class="btn go">Create my account</button></form></div>
    <p class="sub" style="text-align:center">Wrong name? Ask a manager for a new link.</p><i class="sprig" aria-hidden="true"></i></div>`;
}
/** Right after setting up: how to put the app on the home screen (on iPhone the home-screen app needs signing in once more). */
function viewJoined(){
  const j = joined, ios = isIOS() && !standalone();
  return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">You're all set, ${esc(j.first)}</p>
    <div class="card"><div class="row" style="display:block"><b>Your sign-in</b><div class="sub" style="margin-top:4px">First name <b>${esc(j.first)}</b> · code <span class="code">${esc(j.code)}</span> (the last 4 digits of your phone)</div></div>
      ${standalone() ? '' : ios ? `<div class="row" style="display:block"><b>Put the app on your home screen</b><div class="sub" style="margin-top:4px">Tap <b>Share</b> <span aria-hidden="true">⬆︎</span> at the bottom of Safari, then <b>Add to Home Screen</b>, then <b>Add</b>. Open Peregrine from your home screen and sign in with the name and code above.</div></div>`
        : `<div class="row" style="display:block"><b>Install the app</b><div class="sub" style="margin-top:4px">${installEvt ? '<button class="btn sm go" data-install>Install</button>' : 'In Chrome, tap <b>⋮</b> then <b>Add to Home screen</b> (or <b>Install app</b>).'}</div></div>`}</div>
    <button class="btn go" data-joindone style="width:100%">${ios ? 'Keep using it in Safari' : 'Open the app'}</button><i class="sprig" aria-hidden="true"></i></div>`;
}

/** Must-read announcements cover the app until each one is acknowledged. */
function mustRead(){ return (data.announcements || []).filter(a => a.mustAck && !a.read); }
function viewMustRead(a, left){
  return `<div class="gate"><div class="gate-in"><img class="mark" src="brand/bird-gold.png" alt=""><p class="sub" style="margin:0 0 6px">${left > 1 ? `1 of ${left} · ` : ''}Please read before you continue</p>
    <h1 style="margin-bottom:8px">${esc(a.title)}</h1><div class="msg" style="font-size:1.05rem">${esc(a.message)}</div>
    <p class="sub">From ${esc(a.from)} · ${ago(a.posted)}</p><button class="btn go" data-ack="${esc(a.id)}" style="width:100%;margin-top:14px">I've read this</button></div></div>`;
}

function myNextShift(){ const now = new Date(); return (data.shifts || []).find(s => live(s) && s.name === data.me.name && (s.date > T() || (s.date === T() && mins(s.end) > now.getHours() * 60 + now.getMinutes()))); }

function clockCard(){
  const o = data.open, next = myNextShift();
  if (o) { const s = (data.shifts || []).find(x => x.id === o.shift);
    const w = wageOf(data.me.name), h = (Date.now() - new Date(o.in)) / 36e5;
    return `<div class="card clock on"><div class="row"><div class="txt"><b>Clocked in · ${timeOf(o.in)}</b><div class="sub">${s ? 'Shift ' + t12(s.start) + '–' + t12(s.end) : 'Not on the schedule'}${o.inPlace && o.inPlace !== 'at the shop' ? ' · ' + esc(o.inPlace) : ''}</div></div><button class="btn warn" data-clock="out">Clock out</button></div>
      <div class="row clockrun"><div class="txt"><span class="runclock" data-clocksince="${esc(o.in)}">${elapsed(o.in)}</span><div class="sub">on the clock${w ? ` · about <span data-paysince="${esc(o.in)}" data-pw="${w}">${money(h * w, true)}</span> so far` : ''}</div></div><button class="btn sm" data-more="time">My time ›</button></div></div>`; }
  const soon = next && next.date === T();
  return `<div class="card clock"><div class="row"><div class="txt"><b>${soon ? 'Your shift today · ' + t12(next.start) + '–' + t12(next.end) : 'Not clocked in'}</b><div class="sub">${soon ? esc(next.position || '') : next ? 'Next: ' + dayName(next.date) + ' ' + t12(next.start) : 'No shifts coming up'}</div></div><button class="btn go" data-clock="in">Clock in</button></div></div>`;
}

/* ---------- Labor now (leads + managers): who is on the clock and today's running wage cost ---------- */
function laborCard(){
  const F = data.floor; if (!F || !lead()) return '';
  const M = mgr(), k = 1 + (Number(F.extra) || 0) / 100, now = new Date(), cur = now.getHours() * 60 + now.getMinutes();
  const todays = shiftsOn(T()).filter(live), shiftFor = x => todays.find(s => s.id === x.shift) || todays.find(s => s.name === x.name && mins(s.start) <= cur + 60 && mins(s.end) >= mins(hmOf(x.in)));
  const punched = new Set(F.on.concat(F.done).map(x => x.name));
  const notIn = todays.filter(s => !punched.has(s.name) && cur > mins(s.start) + (data.lateAfter || 5) && cur < mins(s.end));
  const onRow = x => { const s = shiftFor(x), over = s && cur > mins(s.end) + 10;
    return `<div class="row"><div class="txt"><b>${esc(x.name)}</b><div class="sub">In ${timeOf(x.in)} · <span data-hsince="${esc(x.in)}">${hrs((now - new Date(x.in)) / 6e4)}</span>${s ? ' · until ' + t12(s.end) : ' · no shift today'}</div></div>${over ? '<span class="pill warn">Past end</span>' : ''}${M ? `<span class="money">${x.wage ? `<span data-psince="${esc(x.in)}" data-pw="${x.wage * k}">${money((now - new Date(x.in)) / 36e5 * x.wage * k, true)}</span>` : '<span class="sub">no wage</span>'}</span>` : ''}</div>`; };
  const doneLine = F.done.length ? `<div class="row"><div class="txt"><b>Clocked out today</b><div class="sub">${F.done.map(x => `${esc(first(x.name))} ${hrs((new Date(x.out) - new Date(x.in)) / 6e4)}${M && x.wage ? ' · ' + money(x.cost, true) : ''}`).join(' &nbsp;·&nbsp; ')}</div></div></div>` : '';
  const miss = M ? (F.missing || []).length : (F.missing || 0);
  return `<h2>Labor now</h2><div class="card laborcard">
    <div class="row lc-top"><div class="lc-stat"><b>${F.on.length}</b><span class="sub">on the clock</span></div>
      <div class="lc-stat"><b data-labor>${money(F.cost + F.rate * Math.max(0, now - new Date(F.at)) / 36e5, true)}</b><span class="sub">labor today</span></div>
      <div class="lc-stat"><b>${money(F.rate, true)}</b><span class="sub">per hour now</span></div></div>
    ${F.on.map(onRow).join('') || '<div class="empty">Nobody is clocked in.</div>'}
    ${notIn.length ? `<div class="row"><div class="txt"><b>Scheduled, not clocked in</b><div class="sub">${notIn.map(s => `${esc(first(s.name))} (${t12(s.start)})`).join(', ')}</div></div><span class="pill warn">${notIn.length}</span></div>` : ''}
    ${doneLine}
    ${rowBtn(`data-tsday="${T()}"`, '<div class="txt"><b>Labor by day</b><div class="sub">Yesterday, tomorrow, any week</div></div><span>›</span>')}</div>
  <p class="sub">Estimate: hours × wage${k > 1 ? ' + ' + Math.round((k - 1) * 100) + '% extra' : ''}, no overtime. Payroll decides.${miss ? ` ${M ? 'No wage set for ' + F.missing.map(first).map(esc).join(', ') + '.' : miss + (miss > 1 ? ' people have' : ' person has') + ' no wage set, so the total is low.'}` : ''}</p>`;
}
function tickLabor(){       // keep the running numbers moving between refreshes, without redrawing the page
  const F = data && data.floor; if (!F || tab !== 'today') return;
  const now = Date.now(), el = document.querySelector('[data-labor]');
  if (el) el.textContent = money(F.cost + F.rate * Math.max(0, now - new Date(F.at)) / 36e5, true);
  document.querySelectorAll('[data-hsince]').forEach(e => { e.textContent = hrs((now - new Date(e.dataset.hsince)) / 6e4); });
  document.querySelectorAll('[data-psince]').forEach(e => { e.textContent = money((now - new Date(e.dataset.psince)) / 36e5 * Number(e.dataset.pw), true); });
}
setInterval(tickLabor, 15000);
const elapsed = iso => { const t = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000)); return Math.floor(t / 3600) + ':' + pad(Math.floor(t / 60) % 60) + ':' + pad(t % 60); };
setInterval(() => {      // the live clock-in timer, every second, without redrawing the page
  document.querySelectorAll('[data-clocksince]').forEach(e => { e.textContent = elapsed(e.dataset.clocksince); });
  document.querySelectorAll('[data-paysince]').forEach(e => { e.textContent = money((Date.now() - new Date(e.dataset.paysince)) / 36e5 * Number(e.dataset.pw), true); });
}, 1000);
setInterval(() => {      // time sheets: keep hours and pay moving while someone is on the clock
  if (!data || tab !== 'more' || moreView !== 'time' || sheet || viewer || document.hidden) return;
  if ((data.punches || []).some(p => p.in && !p.out && Date.now() - new Date(p.in) < 16 * 36e5)) render();
}, 30000);

function viewToday(){
  const d = data, today = shiftsOn(T()).filter(live), next = myNextShift();
  const unread = (d.announcements || []).filter(a => !a.read);
  const pendingReq = mgr() ? (d.requests || []).filter(q => q.status === 'Pending' && q.from !== d.me.name) : [];
  const mine = (d.requests || []).filter(q => q.from === d.me.name && q.status !== 'Cancelled').slice(0, 3);
  const chatN = (d.channels || []).reduce((n, c) => n + c.unread, 0);
  const hour = new Date().getHours(), hi = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const att = mgr() ? weekReport(monday(T())).reduce((a, r) => ({ late: a.late + r.lates, no: a.no + r.noShow, miss: a.miss + r.missingOut }), { late: 0, no: 0, miss: 0 }) : null;
  const remindHint = d.reminders && d.reminders.on && d.reminders.by && d.reminders.by !== 'push' && !d.me.email && d.me.reminders !== 'Off' && load('pt-nohint') !== '1'
    ? `<div class="hint"><b>Get a reminder before your shifts.</b> Add your email and pick when. <div class="btns" style="margin-top:8px"><button class="btn sm go" data-more="reminders">Set up reminders</button><button class="btn sm" data-nohint>Not now</button></div></div>` : '';
  const pubHint = lead() && d.unpublished ? `<div class="hint"><b>${d.unpublished} schedule change${d.unpublished > 1 ? 's' : ''} not published yet.</b> The team can't see ${d.unpublished > 1 ? 'them' : 'it'} until you publish. <div class="btns" style="margin-top:8px"><button class="btn sm go" data-tab="schedule">Review & publish</button></div></div>` : '';
  const pm = prepMine();
  const prepCard = pm.length ? `<h2>Prep for your shift</h2><div class="card">${pm.map(prepRow).join('')}</div>` : '';
  const pushHint = d.push && d.push.ready && !pushOn_() && load('pt-nopush') !== '1' && (pushNeedsHome() || (pushOK() && Notification.permission !== 'denied'))
    ? `<div class="hint"><b>Get notifications on this ${deviceKind()}.</b> ${pushNeedsHome() ? 'On iPhone, add the app to your Home Screen first, then turn them on.' : 'New messages, schedule changes and prep for your shift.'}
      <div class="btns" style="margin-top:8px">${pushNeedsHome() ? '<button class="btn sm go" data-more="push">Show me how</button>' : '<button class="btn sm go" data-pushon>Turn on</button>'}<button class="btn sm" data-nopush>Not now</button></div></div>` : '';
  return `<h1>${hi}, ${esc(first(d.me.name))}</h1>${pubHint}${pushHint}${remindHint}${clockCard()}${laborCard()}${prepCard}
    ${unread.length ? `<div class="card">${unread.slice(0, 3).map(annRow).join('')}</div>` : ''}
    ${chatN ? `<div class="card">${rowBtn('data-tab="chat"', `<div class="txt"><b>${chatN} unread message${chatN > 1 ? 's' : ''}</b></div><span>›</span>`)}</div>` : ''}
    <h2>Working today</h2><div class="card">${today.length ? today.map(s => `<div class="row ${s.name === d.me.name ? 'mine' : ''}"><div class="txt"><b>${esc(s.name)}</b><div class="sub">${t12(s.start)}–${t12(s.end)}${s.position ? ' · ' + esc(s.position) : ''}</div></div>${mgr() ? clockState(s) : ''}</div>`).join('') : '<div class="empty">Nobody scheduled today.</div>'}</div>
    <h2>Checklists</h2><div class="card">${(d.checklists || []).map(c => rowBtn(`data-golist="${esc(c.list)}"`, `<div class="txt"><b>${esc(c.list)}</b><div class="progress"><i style="width:${c.total ? Math.round(c.done / c.total * 100) : 0}%"></i></div></div><span class="pill ${c.done === c.total && c.total ? 'ok' : 'mute'}">${c.done}/${c.total}</span>`)).join('') || '<div class="empty">No checklists today.</div>'}</div>
    ${pendingReq.length || (att && (att.late || att.no || att.miss)) ? `<h2>Waiting on you</h2><div class="card">
      ${pendingReq.length ? rowBtn('data-more="requests"', `<div class="txt"><b>${pendingReq.length} request${pendingReq.length > 1 ? 's' : ''}</b> to approve</div><span>›</span>`) : ''}
      ${att && (att.late || att.no || att.miss) ? rowBtn('data-more="time"', `<div class="txt"><b>This week's time sheet</b><div class="sub">${[att.late ? att.late + ' late' : '', att.no ? att.no + ' no-show' : '', att.miss ? att.miss + ' missing clock-out' : ''].filter(Boolean).join(' · ')}</div></div><span>›</span>`) : ''}</div>` : ''}
    ${mine.length ? `<h2>Your requests</h2><div class="card">${mine.map(reqRow).join('')}</div>` : ''}`;
}
function clockState(s){       // managers: is this person clocked in for today's shift?
  const p = (data.punches || []).find(x => x.shift === s.id) || (data.punches || []).find(x => x.name === s.name && x.date === s.date && !x.shift);
  const now = new Date(), start = mins(s.start), cur = now.getHours() * 60 + now.getMinutes();
  if (p && p.out) return `<span class="pill ok">Done ${timeOf(p.out)}</span>`;
  if (p) { const lateBy = Math.round((new Date(p.in) - new Date(pd(s.date).getTime() + start * 6e4)) / 6e4); return `<span class="pill ${lateBy > (data.lateAfter || 5) ? 'warn' : 'ok'}">In ${timeOf(p.in)}</span>`; }
  return cur > start + (data.lateAfter || 5) ? '<span class="pill warn">Not in</span>' : '';
}

/* ----- checklists ----- */
const PREP = '__prep', INV = '__inv';
/* ----- inventory (leads and managers): counts go straight into the Inventory & Reorder sheet ----- */
let inv = null, invTab = load('pt-invtab') || '', invQ = '', invQueue = {}, invTimer = null, invBusy = false;
const invStatus = x => x.onHand === '' || x.onHand == null ? 'Not counted' : x.onHand <= 0 ? 'Out' : x.par === '' || x.par == null ? 'OK' : x.onHand < x.par ? 'Below par' : 'OK';
const invOrder = x => { if (x.onHand === '' || x.onHand == null || x.par === '' || x.par == null || !(x.onHand < x.par)) return 0; const c = Number(x.caseSize) || 1; return Math.ceil((x.par - x.onHand) / c) * c; };
async function loadInv(force){
  if (invBusy) return; invBusy = true;
  try { const r = await post({ fn: 'inventory', token: TOKEN }); inv = r; if (!invTab || (invTab !== 'Reorder' && r.tabs.indexOf(invTab) < 0)) invTab = r.tabs[0]; }
  catch (e) { toast(String(e.message || e)); }
  invBusy = false; if (tab === 'lists' && listTab === INV) render();
}
function queueCount(x, field, val){
  x[field] = val === '' ? '' : Number(val); if (field === 'onHand') x.counted = val === '' ? '' : T();
  const k = x.tab + '|' + x.row; invQueue[k] = Object.assign(invQueue[k] || { tab: x.tab, row: x.row, item: x.item }, { onHand: x.onHand }, field === 'par' ? { par: val } : {}, field === 'caseSize' ? { caseSize: val } : {});
  clearTimeout(invTimer); invTimer = setTimeout(flushCounts, 1200);
}
async function flushCounts(){
  const counts = Object.values(invQueue); if (!counts.length) return; invQueue = {};
  try { await post({ fn: 'inventory', token: TOKEN, counts }); } catch (e) { counts.forEach(c => { invQueue[c.tab + '|' + c.row] = c; }); toast('Counts not saved yet – ' + String(e.message || e)); clearTimeout(invTimer); invTimer = setTimeout(flushCounts, 5000); }
}
function viewInventory(cl){
  if (!inv){ loadInv(); return `<h1>Checklists</h1>${listSeg(cl)}<div class="card"><div class="empty">Loading inventory…</div></div>`; }
  const items = inv.items, need = items.filter(x => ['Out', 'Below par'].includes(invStatus(x))), out = items.filter(x => invStatus(x) === 'Out'), notC = items.filter(x => invStatus(x) === 'Not counted');
  const cost = need.reduce((n, x) => n + invOrder(x) * (x.cost || 0), 0);
  const tabs = inv.tabs.concat(['Reorder']);
  const q = invQ.trim().toLowerCase();
  const pill = x => { const st = invStatus(x); return `<span class="pill ${st === 'OK' ? 'ok' : st === 'Not counted' ? 'mute' : 'warn'}">${st}</span>`; };
  let body;
  if (invTab === 'Reorder') {
    const byV = {}; need.forEach(x => (byV[x.vendor || 'Other'] = byV[x.vendor || 'Other'] || []).push(x));
    body = Object.keys(byV).sort().map(v => `<h2>${esc(v)}</h2><div class="card">${byV[v].map(x => `<div class="row"><div class="txt"><b>${esc(x.item)}</b><div class="sub">${x.onHand === '' ? '–' : x.onHand} on hand · par ${x.par}${x.unit ? ' · ' + esc(x.unit) : ''}</div></div>${pill(x)}<div class="money"><b>${invOrder(x)}</b><div class="sub">${x.cost ? money(invOrder(x) * x.cost, true) : ''}</div></div></div>`).join('')}</div>`).join('') || '<div class="card"><div class="empty">Nothing needs ordering.</div></div>';
  } else {
    const list = items.filter(x => (q ? (x.item + ' ' + x.cat + ' ' + x.vendor).toLowerCase().includes(q) : x.tab === invTab));
    let lastCat = '';
    body = `<div class="card">${list.map(x => { const head = !q && x.cat !== lastCat ? `<div class="sec">${esc(x.cat || 'Other')}</div>` : ''; lastCat = x.cat;
      return head + `<div class="row inv"><div class="txt"><b>${esc(x.item)}</b>${pill(x)}<div class="sub">${esc(x.unit || '')}${x.par !== '' ? ' · par ' + x.par : ''}${x.caseSize > 1 ? ' · case of ' + x.caseSize : ''}${x.counted ? ' · counted ' + (x.counted === T() ? 'today' : esc(x.counted)) : ''}${q ? ' · ' + esc(x.tab) : ''}</div>
        ${inv.canEditPar ? `<div class="invmeta"><label>Par <input data-invf="par" data-invk="${esc(x.tab)}|${x.row}" inputmode="decimal" value="${x.par}"></label><label>Case <input data-invf="caseSize" data-invk="${esc(x.tab)}|${x.row}" inputmode="decimal" value="${x.caseSize}"></label></div>` : ''}</div>
        <div class="stepper"><button class="mini" data-invstep="-1" data-invk="${esc(x.tab)}|${x.row}" aria-label="One less">–</button><input class="cnt" data-invf="onHand" data-invk="${esc(x.tab)}|${x.row}" inputmode="decimal" value="${x.onHand}" placeholder="–" aria-label="${esc(x.item)} on hand"><button class="mini" data-invstep="1" data-invk="${esc(x.tab)}|${x.row}" aria-label="One more">+</button></div></div>`; }).join('') || '<div class="empty">No items.</div>'}</div>`;
  }
  return `<h1>Checklists</h1>${listSeg(cl)}
    <div class="card"><div class="row"><div class="txt"><b>${need.length} to order</b><div class="sub">${out.length} out · ${notC.length} not counted · about ${money(cost)} at known costs</div></div><a class="btn sm" href="${esc(inv.url)}" target="_blank" rel="noopener">Open sheet ↗</a></div></div>
    <input class="search" data-invsearch placeholder="Search all items" value="${esc(invQ)}" aria-label="Search inventory">
    ${q ? '' : `<div class="seg">${tabs.map(t => `<button data-invtab="${esc(t)}" aria-pressed="${t === invTab}">${esc(t)}${t === 'Reorder' && need.length ? ' ' + need.length : ''}</button>`).join('')}</div>`}
    ${body}
    <p class="sub">Counts save to the Inventory & Reorder sheet as you type, with today's date. Blank = not counted.${inv.canEditPar ? ' Par and case size are editable by managers.' : ''}</p>`;
}
const prepOpen = () => (data.prep || []).filter(x => !x.doneAt);
const prepMine = () => prepOpen().filter(x => x.mine);
/* Prep pop-up: on the day of their shift, the people it was sent to see it pop up when they open the app – once per item. */
const prepSeen = () => { try { return JSON.parse(load('pt-prepseen') || '[]'); } catch (_) { return []; } };
const prepPopItems = () => prepMine().filter(x => x.date && x.date <= T() && prepSeen().indexOf(x.id) < 0 && !/^tmp/.test(x.id));
function prepSeenAll(){ const ids = prepSeen().concat(prepMine().map(x => x.id)); save('pt-prepseen', JSON.stringify([...new Set(ids)].slice(-200))); }
function prepPopSheet(){
  const items = prepMine().filter(x => x.date && x.date <= T());
  return `<div class="sheet" role="dialog" aria-label="Prep for your shift"><div class="sheet-in"><h1 style="margin:0 0 4px">🧾 Prep for your shift</h1>
    <p class="sub" style="margin:0 0 10px">${items.length ? 'Asked for your shift today:' : 'All done – thank you!'}</p>
    ${items.length ? `<div class="card">${items.map(x => `<div class="row"><button class="chk" data-prepdone="${esc(x.id)}" data-on="0" aria-label="Done: ${esc(x.item)}"></button>
      <div class="txt"><b>${esc(x.item)}</b>${x.details ? `<div class="sub">${esc(x.details)}</div>` : ''}<div class="sub">From ${esc(first(x.by))} · ${esc(x.label || 'your shift')}</div></div></div>`).join('')}</div>` : ''}
    <div class="btns" style="margin-top:12px"><button class="btn go" data-prepok>Got it</button><button class="btn" data-prepok data-golist="${PREP}">Open the prep list</button></div></div></div>`;
}
function listSeg(cl){
  const n = prepOpen().length;
  return `<div class="seg">${cl.map(x => `<button data-list="${esc(x.list)}" aria-pressed="${x.list === listTab}">${esc(x.list)} ${x.done}/${x.total}</button>`).join('')}<button data-list="${PREP}" aria-pressed="${listTab === PREP}">Prep${n ? ' ' + n : ''}</button>${lead() ? `<button data-list="${INV}" aria-pressed="${listTab === INV}">Inventory</button>` : ''}</div>`;
}
function prepRow(x){
  const on = !!x.doneAt, canDel = x.by === data.me.name || lead();
  return `<div class="row ${on ? 'done' : ''}"><button class="chk ${on ? 'on' : ''}" data-prepdone="${esc(x.id)}" data-on="${on ? 1 : 0}" aria-label="${on ? 'Undo' : 'Done'}: ${esc(x.item)}">${on ? '✓' : ''}</button>
    <div class="txt"><b>${esc(x.item)}</b>${x.mine && !on ? ' <span class="pill warn">Your shift</span>' : ''}${x.details ? `<div class="sub">${esc(x.details)}</div>` : ''}
      <div class="sub">For ${esc(x.label || 'next shift')}${x.for.length ? ' · ' + x.for.map(n => esc(first(n))).join(', ') : ''} · from ${esc(first(x.by))} ${ago(x.at)}</div>
      ${on ? `<div class="sub">Done by ${esc(first(x.doneBy))} · ${timeOf(x.doneAt)}</div>` : ''}</div>
    ${canDel ? `<button class="btn sm" data-prepdel="${esc(x.id)}" aria-label="Remove">✕</button>` : ''}</div>`;
}
function viewPrep(cl){
  const items = data.prep || [], open = items.filter(x => !x.doneAt), done = items.filter(x => x.doneAt);
  const opts = ['<option value="next">Next shift (whoever comes in next)</option>'].concat([0, 1, 2].flatMap(k => { const d = plus(T(), k);
    return (data.presets || []).map(p => `<option value="${d}|${esc(p.name)}">${k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : shortDay(d)} · ${esc(p.name)} (${t12(p.start)})</option>`); }));
  return `<h1>Checklists</h1>${listSeg(cl)}
    <div class="card"><form class="stack" data-form="prep">
      <label class="f">What needs prepping<input name="item" maxlength="120" placeholder="e.g. Batch cold brew" autocomplete="off"></label>
      <label class="f">Details (optional)<input name="details" maxlength="300" placeholder="e.g. 2 gallons, we're out of concentrate"></label>
      <label class="f">For<select name="when">${opts.join('')}</select></label>
      <label class="opt"><input type="checkbox" name="notify" checked> Also send them a notification</label>
      <button class="btn go">Send to the shift</button></form></div>
    <h2>To prep</h2><div class="card">${open.map(prepRow).join('') || '<div class="empty">Nothing to prep.</div>'}</div>
    ${done.length ? `<h2>Done recently</h2><div class="card">${done.map(prepRow).join('')}</div>` : ''}
    <p class="sub">The people on that shift get a pop-up when they open the app on that day, and see it on their Today screen until it's done. No email is sent.</p>`;
}
function viewLists(){
  const cl = data.checklists || [];
  if (listTab === PREP) return viewPrep(cl);
  if (listTab === INV && lead()) return viewInventory(cl);
  if (!cl.length) return '<h1>Checklists</h1>' + listSeg(cl) + '<div class="card"><div class="empty">Nothing on the checklists today.</div></div>';
  if (!cl.some(c => c.list === listTab)) listTab = (cl.find(c => c.done < c.total) || cl[0]).list;
  const c = cl.find(x => x.list === listTab);
  const hist = lead() && data.history && data.history.length ? `<h2>Last 7 days</h2><div class="card">${data.history.map(h => { const miss = h.lists.reduce((n, l) => n + (l.total - l.done), 0);
      return `<div class="row"><div class="txt"><b>${dayName(h.date)}</b><div class="sub">${h.lists.map(l => esc(l.list) + ' ' + l.done + '/' + l.total).join(' · ')}</div>${miss ? `<details class="more"><summary>${miss} missed</summary><div class="sub">${h.lists.filter(l => l.missed.length).map(l => '<b>' + esc(l.list) + ':</b> ' + l.missed.map(esc).join(', ')).join('<br>')}</div></details>` : ''}</div><span class="pill ${miss ? 'warn' : 'ok'}">${miss ? 'Missed ' + miss : 'All done'}</span></div>`; }).join('')}</div>` : '';
  return `<h1>Checklists</h1>${listSeg(cl)}
    <div class="card">${c.items.map((i, n) => { const k = 'c|' + c.list + '|' + i.task, on = busy[k] !== undefined ? busy[k] : !!i.by;
      const head = i.section && (n === 0 || c.items[n - 1].section !== i.section) ? `<div class="sec">${esc(i.section)}</div>` : '';
      return head + `<div class="row ${on ? 'done' : ''}"><button class="chk ${on ? 'on' : ''}" data-check="${esc(i.task)}" data-on="${on ? 1 : 0}" aria-label="${on ? 'Undo' : 'Done'}: ${esc(i.task)}">${on ? '✓' : ''}</button>
        <div class="txt"><b>${esc(i.task)}</b>${i.notes ? `<div class="sub">${esc(i.notes)}</div>` : ''}${i.by ? `<div class="sub">${esc(i.by)} · ${timeOf(i.at)}</div>` : ''}</div></div>`; }).join('')}</div>${hist}`;
}

/* ----- schedule ----- */
let schedView = load('pt-sview') || 'build';
/** What the team actually sees of a shift (leads and managers get drafts too). */
function pubView(s){ if (s.status === 'draft') return null; if (s.status === 'changed' && s.was) return Object.assign({}, s, s.was, { status: '' }); return s; }
function viewMyShifts(){
  const vis = (data.shifts || []).map(pubView).filter(Boolean), now = new Date();
  const mine = vis.filter(s => s.name === data.me.name && (s.date > T() || (s.date === T() && mins(s.end) > now.getHours() * 60 + now.getMinutes())));
  const past = vis.filter(s => s.name === data.me.name && s.date < T() && s.date >= plus(T(), -7));
  const crew = s => vis.filter(o => o !== s && o.name !== s.name && o.date === s.date && mins(o.start) < mins(s.end) && mins(o.end) > mins(s.start));
  const card = s => { const c = crew(s);
    return `<div class="card shiftcard ${s.date === T() ? 'today' : ''}"><div class="row" style="display:block">
      <div style="display:flex;align-items:baseline;gap:8px"><b style="flex:1;font:400 1.05rem/1.2 var(--head);letter-spacing:.06em;text-transform:uppercase">${dayName(s.date)}</b><span class="sub">${shortDay(s.date)}</span></div>
      <div class="big2">${t12(s.start)} – ${t12(s.end)} <span class="sub">${hrs(mins(s.end) - mins(s.start))}${s.position ? ' · ' + esc(s.position) : ''}</span></div>
      ${s.notes ? `<div class="sub">${esc(s.notes)}</div>` : ''}
      <div class="crew">${c.length ? '<span class="sub">Working with</span> ' + c.map(o => `<span class="pill mute">${esc(first(o.name))} ${t12(o.start)}–${t12(o.end)}</span>`).join(' ') : '<span class="sub">No one else on yet</span>'}</div></div></div>`; };
  const wk = mine.filter(s => s.date <= plus(monday(T()), 6)).reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
  return `<div class="mywrap">${mine.length ? `<p class="sub" style="margin:0 4px 10px">${mine.length} upcoming shift${mine.length > 1 ? 's' : ''}${wk ? ' · ' + hrs(wk) + ' left this week' : ''}</p>${mine.map(card).join('')}` : '<div class="card"><div class="empty">No upcoming shifts on the published schedule.</div></div>'}
    ${past.length ? `<details class="more" style="margin:12px 4px"><summary>Last 7 days</summary>${past.map(card).join('')}</details>` : ''}
    <div class="btns" style="margin-top:14px"><button class="btn" data-more="requests">Time off & swaps</button><button class="btn" data-more="avail">My availability</button><button class="btn" data-more="reminders">Reminders & calendar</button></div></div>`;
}
function weekBounds(){ return [monday(plus(T(), -21)), monday(plus(T(), lead() ? 49 : 7))]; }
function viewSchedule(){
  const seg = lead() ? `<div class="seg" style="max-width:420px;margin-left:0"><button data-sview="build" aria-pressed="${schedView !== 'mine'}">Build schedule</button><button data-sview="mine" aria-pressed="${schedView === 'mine'}">My shifts</button></div>` : '';
  if (!lead() || schedView === 'mine') { document.body.classList.remove('wide'); return `<h1>${lead() ? 'Schedule' : 'My shifts'}</h1>${seg}${viewMyShifts()}`; }
  return viewScheduleBuild(seg);
}
function viewScheduleBuild(seg){
  const [lo, hi] = weekBounds();
  if (!week || week < lo || week > hi) week = monday(T());
  if (wide()) return viewScheduleGrid(seg);
  const days = Array.from({ length: 7 }, (_, i) => plus(week, i));
  const label = week === monday(T()) ? 'This week' : week === plus(monday(T()), 7) ? 'Next week' : week === plus(monday(T()), -7) ? 'Last week' : 'Week of ' + shortDay(week);
  const nav = `<div class="weeknav"><button class="btn sm" data-week="-7" ${week <= lo ? 'disabled' : ''} aria-label="Previous week">‹</button><div><b>${label}</b><div class="sub">${shortDay(days[0])} – ${shortDay(days[6])}</div></div><button class="btn sm" data-week="7" ${week >= hi ? 'disabled' : ''} aria-label="Next week">›</button></div>`;
  const mineOnly = schedMine && !mgr();
  const dayCard = d => {
    const list = shiftsOn(d).filter(s => !mineOnly || s.name === data.me.name);
    const offs = lead() ? (data.requests || []).filter(q => q.type === 'Time off' && q.date === d && q.status === 'Approved').map(q => first(q.from)) : [];
    return `<h2 ${d === T() ? 'id="todayh" class="today-h"' : ''}>${dayName(d)}${d !== T() && d !== plus(T(), 1) ? '' : ' · ' + shortDay(d)}</h2><div class="card">
      ${list.map(s => { const cf = lead() ? conflicts(s) : [];
        const inner = `<div class="txt ${s.status === 'removed' ? 'gone' : ''}"><b>${esc(s.name)}</b> ${statusPill(s)}<div class="sub">${t12(s.start)}–${t12(s.end)} · ${hrs(mins(s.end) - mins(s.start))}${s.position ? ' · ' + esc(s.position) : ''}${s.notes ? ' · ' + esc(s.notes) : ''}</div>${cf.length ? `<div style="margin-top:4px">${cf.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>${mgr() ? '<span class="sub">Edit</span>' : ''}`;
        return lead() ? rowBtn(`data-editshift="${esc(s.id)}" class="${s.name === data.me.name ? 'mine' : ''}"`, inner) : `<div class="row ${s.name === data.me.name ? 'mine' : ''}">${inner}</div>`; }).join('') || '<div class="empty" style="padding:14px">No shifts.</div>'}
      ${offs.length ? `<div class="row"><div class="txt sub">Off: ${offs.map(esc).join(', ')}</div></div>` : ''}
      ${lead() ? rowBtn(`data-addshift="${d}"`, '<div class="txt accent"><b>+ Add shift</b></div>') : ''}</div>`;
  };
  const totals = mgr() ? (() => { const t = {}; days.forEach(d => shiftsOn(d).filter(notGone).forEach(s => { t[s.name] = (t[s.name] || 0) + mins(s.end) - mins(s.start); }));
    const L = labor(shiftItems(weekShifts(week)));
    const names = Object.keys(t).sort(); return names.length ? `<h2>Hours & estimated wages</h2><div class="card">${names.map(n => `<div class="row"><div class="txt">${esc(n)}${L.ot[n] ? ` <span class="pill warn">OT ${hrs(L.ot[n] * 60)}</span>` : ''}</div><b>${hrs(t[n])}</b><span class="money">${wageOf(n) ? money(L.byPerson[n] || 0) : '<span class="sub">no wage</span>'}</span></div>`).join('')}
      <div class="row"><div class="txt"><b>Total</b></div><b>${hrs(Object.values(t).reduce((a, b) => a + b, 0))}</b><span class="money"><b>${money(L.total)}</b></span></div></div>` : ''; })() : '';
  const pend = weekPending(week).length;
  const pubBtn = lead() ? (pend ? `<button class="btn sm go" data-publish>Publish week (${pend})</button>` : '<span class="pill ok">Published</span>') : '';
  const tools = lead() ? `<div class="btns" style="margin:10px 0 4px">${pubBtn}${lead() ? '<button class="btn sm" data-copyweek>Copy last week here</button><button class="btn sm" data-clearweek>Clear this week</button>' : ''}</div>` : '';
  return `<h1>Schedule</h1>${seg || ''}${nav}${lead() && pend ? '<p class="sub" style="margin:0 4px 6px">Drafts and changes stay hidden from the team until you publish.</p>' : ''}${mgr() ? '' : `<div class="seg"><button data-mine="0" aria-pressed="${!schedMine}">Everyone</button><button data-mine="1" aria-pressed="${schedMine}">My shifts</button></div>`}
    ${tools}${days.map(dayCard).join('')}${totals}
    <div class="btns" style="margin-top:14px"><button class="btn" data-more="requests">Time off & swaps</button><button class="btn" data-more="avail">My availability</button></div>`;
}

/** Desktop: the whole week as a grid, people down the side. Click a cell to add, click a shift to edit, drag to move (hold Alt/Option to copy). */
function viewScheduleGrid(seg){
  const [lo, hi] = weekBounds(), days = Array.from({ length: 7 }, (_, i) => plus(week, i)), M = mgr(), E = lead();
  const label = week === monday(T()) ? 'This week' : week === plus(monday(T()), 7) ? 'Next week' : week === plus(monday(T()), -7) ? 'Last week' : 'Week of ' + shortDay(week);
  const inWeek = (data.shifts || []).filter(s => days.includes(s.date)), inWeekLive = inWeek.filter(notGone);
  const everyone = lineup(), hasShift = n => inWeek.some(s => s.name === n && notGone(s));
  // Hidden people drop off the grid – unless they still have a shift this week, so nothing goes missing.
  const roster = everyone.filter(p => shown(p) || hasShift(p.name)).map(p => ({ id: p.id, name: p.name, role: p.role, wage: p.wage, hidden: !shown(p) }));
  const hiddenOut = everyone.filter(p => !shown(p) && !hasShift(p.name));
  inWeek.forEach(s => { if (!roster.some(p => p.name === s.name)) roster.push({ name: s.name, role: 'Former' }); });
  const dayMins = d => inWeekLive.filter(s => s.date === d).reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
  const L = M ? labor(shiftItems(inWeekLive)) : null;
  const cell = (p, d) => {
    const list = inWeek.filter(s => s.name === p.name && s.date === d);
    const off = approvedOff(p.name, d), ask = pendingOff(p.name, d), un = unavail(p.name, d);
    const note = off ? '<div class="cnote warn">Time off</div>' : ask ? '<div class="cnote">Asked off</div>' : un ? `<div class="cnote">${un.from ? 'Can\'t ' + t12(un.from) + '–' + t12(un.to) : 'Unavailable'}</div>` : '';
    const chips = list.map(s => { const cf = E ? conflicts(s) : [];
      const tip = cf.map(c => c[1]).concat(s.status === 'changed' && s.was ? ['Team still sees ' + (s.was.name !== s.name ? s.was.name + ' ' : '') + t12(s.was.start) + '–' + t12(s.was.end) + (s.was.date !== s.date ? ' on ' + shortDay(s.was.date) : '')] : []).join(' · ');
      return `<button class="chip ${cf.some(c => c[0] === 'warn') ? 'bad' : ''} ${s.name === data.me.name ? 'me' : ''} st-${s.status || 'published'}" ${E ? `data-editshift="${esc(s.id)}" ${s.status === 'removed' ? '' : `draggable="true" data-drag="${esc(s.id)}"`}` : 'tabindex="-1"'} title="${esc(tip)}">
        ${STATUS[s.status] ? `<i class="tag">${STATUS[s.status][1]}</i>` : ''}<b>${t12s(s.start)}–${t12s(s.end)}</b>${s.position ? `<span>${esc(s.position)}</span>` : ''}${s.notes ? `<span class="n2">${esc(s.notes)}</span>` : ''}</button>`; }).join('');
    return `<td class="${d === T() ? 'today' : ''} ${off ? 'off' : un && !un.from ? 'un' : ''}" ${E ? `data-cell="${esc(p.name)}|${d}"` : ''}>${note}${chips}${E ? `<button class="addc" data-addshift="${d}" data-who="${esc(p.name)}" aria-label="Add a shift for ${esc(p.name)} on ${shortDay(d)}">+</button>` : ''}</td>`;
  };
  const rows = roster.map(p => { const m = inWeek.filter(s => s.name === p.name).reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
    const m2 = inWeekLive.filter(s => s.name === p.name).reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
    const wageIn = M && p.id ? `<label class="wagef"><span>$</span><input class="wage" inputmode="decimal" data-wage="${esc(p.id)}" value="${p.wage ? Number(p.wage).toFixed(2) : ''}" placeholder="wage" aria-label="${esc(p.name)} hourly wage"><span>/h</span></label>` : '';
    const handle = M && p.id ? `<span class="handle" data-rowdrag title="Drag to reorder" aria-label="Drag to reorder ${esc(p.name)}">⠿</span>` : '';
    const hideBtn = M && p.id ? `<button class="mini" data-onsched="${esc(p.id)}" data-to="${p.hidden ? 1 : 0}" title="${p.hidden ? 'Show on the schedule' : 'Hide from the schedule'}">${p.hidden ? 'Show' : 'Hide'}</button>` : '';
    return `<tr class="${p.name === data.me.name ? 'mine-row' : ''} ${p.hidden ? 'hid' : ''}" ${p.id ? `data-rid="${esc(p.id)}"` : ''}><th scope="row"><div class="who">${handle}<div><b>${esc(p.name)}</b><span class="sub">${esc(p.role || '')}${p.hidden ? ' · hidden' : ''}</span></div>${wageIn}${hideBtn}</div></th>${days.map(d => cell(p, d)).join('')}<td class="tot">${m2 ? hrs(m2) : ''}${M && m2 ? `<div class="money">${p.wage ? money(L.byPerson[p.name] || 0) : '<span class="sub">no wage</span>'}</div>${L.ot[p.name] ? `<span class="pill warn">OT ${hrs(L.ot[p.name] * 60)}</span>` : ''}` : ''}</td></tr>`; }).join('');
  const total = inWeekLive.reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
  return `${seg || ''}<div class="gridhead"><h1 style="margin:0">Schedule</h1>
      <div class="weeknav" style="margin:0"><button class="btn sm" data-week="-7" ${week <= lo ? 'disabled' : ''} aria-label="Previous week">‹</button><div style="min-width:170px"><b>${label}</b><div class="sub">${shortDay(days[0])} – ${shortDay(days[6])}</div></div><button class="btn sm" data-week="7" ${week >= hi ? 'disabled' : ''} aria-label="Next week">›</button>${week !== monday(T()) ? '<button class="btn sm" data-thisweek>Today</button>' : ''}</div>
      ${M ? `<div class="labor"><span class="sub">Est. wages</span><b>${money(L.total)}</b><span class="sub">${hrs(total)}${data.pay && data.pay.extra ? ' · incl. ' + data.pay.extra + '% extra' : ''}</span></div>` : ''}
      <div class="btns">${E ? '<button class="btn sm" data-copyweek>Copy last week</button><button class="btn sm" data-clearweek>Clear week</button>' : ''}${lead() ? (weekPending(week).length ? `<button class="btn sm go" data-publish>Publish week (${weekPending(week).length})</button>` : '<span class="pill ok">Published</span>') : ''}<button class="btn sm" data-print>Print</button></div></div>
    <div class="gridwrap"><table class="grid"><thead><tr><th class="corner">${E ? '<span class="sub">Click a box to add. Drag to move, Alt-drag to copy.</span>' : ''}</th>${days.map(d => `<th class="${d === T() ? 'today' : ''}"><b>${DOW[pd(d).getDay()]}</b> ${pd(d).getDate()}<span class="sub">${hrs(dayMins(d))}</span></th>`).join('')}<th class="tot">Hours</th></tr></thead>
      <tbody data-reorder>${rows || `<tr><td colspan="9" class="empty">No one on the team yet.</td></tr>`}</tbody>
      <tfoot><tr><th scope="row">Total${M ? '<span class="sub">Estimated wages</span>' : ''}</th>${days.map(d => `<td class="tot">${inWeekLive.filter(s => s.date === d).length} shift${inWeekLive.filter(s => s.date === d).length === 1 ? '' : 's'}${M ? `<div class="money">${money(L.byDay[d] || 0)}</div>` : ''}</td>`).join('')}<td class="tot"><b>${hrs(total)}</b>${M ? `<div class="money"><b>${money(L.total)}</b></div>` : ''}</td></tr></tfoot></table></div>
    ${M && hiddenOut.length ? `<p class="sub">Hidden from the schedule: ${hiddenOut.map(p => `${esc(p.name)} <button class="mini" data-onsched="${esc(p.id)}" data-to="1">Show</button>`).join(' · ')}</p>` : ''}
    ${M && L.missing.length ? `<p class="sub warn-t">No wage set for ${L.missing.map(n => esc(first(n))).join(', ')} – type it next to their name to include them.</p>` : ''}
    <p class="sub">Red outline = a problem (time off, unavailable or double-booked) – hover to see it. ${M && data.reminders && data.reminders.on ? 'People with an email get reminders before their shifts, and an email when a shift in the next 7 days changes.' : ''}</p>`;
}
function publishSheet(){
  const list = weekPending(week), c = k => list.filter(s => s.status === k).length, people = [...new Set(list.map(s => s.name).concat(list.filter(s => s.was).map(s => s.was.name)))];
  return `<div class="sheet" role="dialog" aria-label="Publish"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">Publish the week</h1><button class="btn sm" data-closesheet>Close</button></div>
    <p class="sub">${shortDay(week)} – ${shortDay(plus(week, 6))}</p>
    <div class="card">${[['draft', 'new shifts'], ['changed', 'changed shifts'], ['removed', 'shifts to remove']].filter(([k]) => c(k)).map(([k, n]) => `<div class="row"><div class="txt">${n}</div><b>${c(k)}</b></div>`).join('')}
      <div class="row"><div class="txt sub">Affects ${people.map(n => esc(first(n))).join(', ')}</div></div></div>
    <form class="stack" data-form="publish" style="padding:0"><label class="opt"><input type="checkbox" name="notify" checked> Notify the team – email the people affected and post in Schedule & swaps</label>
      <button class="btn go">Publish</button></form></div></div>`;
}
function shiftSheet(){
  const s = sheet, d = s.date, lu = lineup(), team = lu.filter(shown).map(u => u.name), hiddenTeam = lu.filter(u => !shown(u)).map(u => u.name);
  const status = n => { if (approvedOff(n, d)) return ' – time off'; const u = unavail(n, d); if (u) return u.from ? ' – unavailable ' + t12(u.from) + '–' + t12(u.to) : ' – unavailable'; if (pendingOff(n, d)) return ' – asked for off'; const b = shiftsOn(d).filter(x => notGone(x) && x.name === n && x.id !== s.id); return b.length ? ' – already ' + b.map(x => t12(x.start) + '–' + t12(x.end)).join(', ') : ''; };
  return `<div class="sheet" role="dialog" aria-label="Shift"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${s.id ? 'Edit shift' : 'New shift'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <p class="sub">${/^(Today|Tomorrow|Yesterday)$/.test(dayName(d)) ? dayName(d) + ' · ' + shortDay(d) : dayName(d)}</p>
    <form class="stack" data-form="shift" style="padding:0">
      <label class="f">Who<select name="name" required>${s.name ? '' : '<option value="">Pick someone…</option>'}${team.map(n => `<option value="${esc(n)}" ${n === s.name ? 'selected' : ''}>${esc(n)}${esc(status(n))}</option>`).join('')}${hiddenTeam.length ? `<optgroup label="Hidden from the schedule">${hiddenTeam.map(n => `<option value="${esc(n)}" ${n === s.name ? 'selected' : ''}>${esc(n)}${esc(status(n))}</option>`).join('')}</optgroup>` : ''}</select></label>
      ${(data.presets || []).length ? `<div class="btns">${data.presets.map(p => `<button type="button" class="btn sm" data-preset="${p.start}|${p.end}">${esc(p.name)} ${t12(p.start)}–${t12(p.end)}</button>`).join('')}</div>` : ''}
      <div class="two"><label class="f">Start<input name="start" type="time" value="${esc(s.start || '07:00')}"></label><label class="f">End<input name="end" type="time" value="${esc(s.end || '13:00')}"></label></div>
      <label class="f">Position<select name="position"><option value=""></option>${(data.positions || []).map(p => `<option ${p === s.position ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="f">Notes<input name="notes" maxlength="200" value="${esc(s.notes || '')}"></label>
      <label class="f">Date<input name="date" type="date" value="${esc(d)}"></label>
      <div class="est" id="est" aria-live="polite"></div>
      <p class="sub" style="margin:0">${!s.id || s.status === 'draft' ? 'Draft – the team sees it after you publish the week.' : s.status === 'changed' && s.was ? 'Not published – the team still sees ' + esc(s.was.name) + ' ' + t12(s.was.start) + '–' + t12(s.was.end) + ' on ' + shortDay(s.was.date) + '.' : s.status === 'removed' ? 'This shift will be removed when you publish. The team still sees it until then.' : 'Published. Changes stay hidden from the team until you publish again.'}</p>
      <div class="btns">${s.status === 'removed' ? `<button type="button" class="btn go" data-restore="${esc(s.id)}">Keep this shift</button>` : `<button class="btn go">${s.id ? 'Save' : 'Add shift'}</button>${s.id ? `<button type="button" class="btn" data-delshift="${esc(s.id)}">Delete</button>` : ''}`}</div></form></div></div>`;
}

/* ----- availability ----- */
function viewAvail(){
  const all = data.availability || [], mineL = all.filter(a => a.name === data.me.name);
  const row = a => `<div class="row"><div class="txt"><b>${/^\d{4}-/.test(a.day) ? dayName(a.day) : 'Every ' + ({ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' })[a.day]}</b><div class="sub">${a.from ? t12(a.from) + '–' + t12(a.to) : 'All day'}${a.note ? ' · ' + esc(a.note) : ''}</div></div>${a.name === data.me.name || mgr() ? `<button class="btn sm" data-delavail="${esc(a.id)}">Remove</button>` : ''}</div>`;
  const others = mgr() ? [...new Set(all.filter(a => a.name !== data.me.name).map(a => a.name))].sort() : [];
  return `${back()}<h1>Availability</h1><p class="sub">Times you <b>can't</b> work. Managers see these when building the schedule. For one-off days off, send a time-off request instead.</p>
    <div class="card">${mineL.map(row).join('') || '<div class="empty">You haven\'t added any.</div>'}</div>
    <h2>Add a time you can't work</h2><div class="card"><form class="stack" data-form="avail">
      <label class="f">When<select name="day">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<option value="${x}">Every ${({ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' })[x]}</option>`).join('')}<option value="date">One date…</option></select></label>
      <label class="f" data-onlydate hidden>Date<input name="date" type="date" min="${T()}"></label>
      <div class="two"><label class="f">From (blank = all day)<input name="from" type="time"></label><label class="f">To<input name="to" type="time"></label></div>
      <label class="f">Note (optional)<input name="note" maxlength="200" placeholder="e.g. Class"></label><button class="btn go">Add</button></form></div>
    ${others.length ? `<h2>The team</h2>${others.map(n => `<div class="card"><div class="sec">${esc(n)}</div>${all.filter(a => a.name === n).map(row).join('')}</div>`).join('')}` : ''}`;
}

/* ----- time sheet: day, week or pay period; a person's hours and pay, or (managers) everyone's labor ----- */
function viewTime(){
  if (!tsDate) tsDate = T();
  const [from, to] = rangeOf(tsMode, tsDate), lo = plus(T(), mgr() ? -70 : -35), hi = plus(T(), mgr() ? 55 : 13), today = T();
  const span = from === to ? '' : shortDay(from) + ' – ' + shortDay(to);
  const title = tsMode === 'day' ? dayName(from) : tsMode === 'week' ? (from === monday(today) ? 'This week' : from === monday(plus(today, -7)) ? 'Last week' : from === monday(plus(today, 7)) ? 'Next week' : 'Week of ' + shortDay(from))
    : (today >= from && today <= to ? 'This pay period' : to < today ? 'Past pay period' : 'Next pay period');
  const nav = `<div class="seg">${[['day', 'Day'], ['week', 'Week'], ['period', 'Pay period']].map(([k, n]) => `<button data-tsmode="${k}" aria-pressed="${tsMode === k}">${n}</button>`).join('')}</div>
    <div class="weeknav"><button class="btn sm" data-tsstep="-1" ${from <= lo ? 'disabled' : ''} aria-label="Earlier">‹</button><div><b>${title}</b><div class="sub">${tsMode === 'day' ? (dayName(from) === shortDay(from) ? '' : shortDay(from)) : span}${(tsMode === 'day' ? from : to) !== today && !(today >= from && today <= to) ? ` · <button class="linkbtn" data-tsjump>Back to today</button>` : ''}</div></div><button class="btn sm" data-tsstep="1" ${to >= hi ? 'disabled' : ''} aria-label="Later">›</button></div>`;
  const line = (l, canEdit) => { const p = l.punch, s = l.shift, run = p && !p.out && (Date.now() - new Date(p.in)) <= 16 * 36e5;
    const flags = [l.noShow ? ['warn', 'No-show'] : null, l.lateBy > (data.lateAfter || 5) ? ['warn', 'Late ' + l.lateBy + ' min'] : null, l.unscheduled ? ['mute', 'Not scheduled'] : null, run ? ['ok', 'On the clock'] : null,
      p && !p.out && !run ? ['warn', 'No clock-out'] : null, p && p.inPlace && /^away/.test(p.inPlace) ? ['mute', 'Clocked in ' + p.inPlace] : null, p && p.edited ? ['mute', 'Edited by ' + first(p.edited)] : null, p && p.type ? ['mute', p.type] : null].filter(Boolean);
    const inner = `<div class="txt"><b>${shortDay(l.date)}</b><div class="sub">${s ? 'Scheduled ' + t12(s.start) + '–' + t12(s.end) : ''}${s && p ? ' · ' : ''}${p ? 'Worked ' + timeOf(p.in) + '–' + (p.out ? timeOf(p.out) : run ? 'now' : '…') + (p.out || run ? ' (' + hrs(((p.out ? new Date(p.out) : new Date()) - new Date(p.in)) / 6e4) + ')' : '') : ''}${p && p.note ? ' · ' + esc(p.note) : ''}</div>${flags.length ? `<div style="margin-top:4px">${flags.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>`;
    return canEdit ? rowBtn(`data-editpunch="${p ? esc(p.id) : ''}" data-pdate="${l.date}" data-pname="${esc(tsPerson)}" data-pstart="${s ? s.start : ''}" data-pend="${s ? s.end : ''}"`, inner + '<span class="sub">Fix</span>') : `<div class="row">${inner}</div>`; };
  const shiftsIn = name => (data.shifts || []).filter(s => notGone(s) && (!name || s.name === name));

  if (!mgr() || tsPerson){      // one person: hours and estimated pay (what they take home before taxes, no employer extras)
    const who = mgr() ? tsPerson : data.me.name, r = rangeReport(from, to, who)[0] || { sched: 0, worked: 0, lines: [] }, w = wageOf(who);
    const PW = costIn(punchItems(punchesNow(who)), from, to, { noExtra: true }), PS = costIn(shiftItems(shiftsIn(who)), from, to, { noExtra: true });
    const future = from > today, ot = PW.ot[who];
    return `${back(mgr() ? 'time' : '')}<h1>${mgr() ? esc(who) : 'My time'}</h1>${nav}
      <div class="card laborcard"><div class="row lc-top">
        <div class="lc-stat"><b>${future ? '–' : hrs(r.worked)}</b><span class="sub">worked</span></div>
        ${w ? `<div class="lc-stat"><b>${future ? '–' : money(PW.total, true)}</b><span class="sub">est. pay</span></div>` : ''}
        <div class="lc-stat"><b>${hrs(r.sched)}</b><span class="sub">scheduled${w ? ' · ' + money(PS.total) : ''}</span></div></div>
        ${r.running ? '<div class="row"><div class="txt sub">On the clock now – this keeps counting until you clock out.</div><span class="pill ok">Live</span></div>' : ''}
        <div class="row"><div class="txt sub">${w ? `At ${money(w, true)}/h${ot ? ' · includes ' + hrs(ot * 60) + ' overtime at ' + ((data.pay || data.myPay || {}).otRate || 1.5) + '×' : ''}. Before taxes – an estimate, payroll decides.` : mgr() ? `No wage set for ${esc(first(who))} – add it in Team to see pay.` : 'Your wage isn\'t in the app yet, so pay can\'t be estimated. Ask a manager to add it.'}</div></div></div>
      <div class="card">${r.lines.map(l => line(l, mgr() && l.date <= today)).join('') || `<div class="empty">Nothing ${tsMode === 'day' ? 'this day' : 'in this ' + (tsMode === 'week' ? 'week' : 'pay period')}.</div>`}</div>
      ${mgr() ? `<button class="btn" data-editpunch="" data-pdate="${from <= today && to >= today ? today : from}" data-pname="${esc(who)}">+ Add a missed punch</button>` : '<p class="sub">Something wrong? Tell a manager – they can fix punches.</p>'}`;
  }

  // Managers: everyone's labor for the day / week / pay period – worked so far (live today) vs. scheduled
  const rep = rangeReport(from, to), LW = costIn(punchItems(punchesNow()), from, to), LS = costIn(shiftItems(shiftsIn()), from, to);
  const tot = { s: LS.hours * 60, w: rep.reduce((a, r) => a + r.worked, 0) }, future = from > today, k = 1 + (Number((data.pay || {}).extra) || 0) / 100;
  const days = []; for (let d = from; d <= to; d = plus(d, 1)) days.push(d);
  const byDay = tsMode === 'day' ? '' : `<h2>By day</h2><div class="card">${days.map(d => { const past = d <= today, wh = (LW.hoursByDay[d] || 0) * 60, sh = (LS.hoursByDay[d] || 0) * 60;
      return rowBtn(`data-tsday="${d}" class="${d === today ? 'mine' : ''}"`, `<div class="txt"><b>${d === today ? 'Today' : shortDay(d)}</b><div class="sub">${past ? hrs(wh) + ' worked of ' + hrs(sh) + ' scheduled' : hrs(sh) + ' scheduled'}</div></div><span class="money">${past ? money(LW.byDay[d] || 0) : '<span class="sub">' + money(LS.byDay[d] || 0) + ' sched.</span>'}</span><span>›</span>`); }).join('')}</div>`;
  const ppl = rep.filter(r => LS.hoursByPerson[r.name] || r.worked || r.lines.length);
  return `${back()}<h1>Time sheets</h1>${nav}
    <div class="card laborcard"><div class="row lc-top">
      <div class="lc-stat"><b>${future ? '–' : hrs(tot.w)}</b><span class="sub">worked</span></div>
      <div class="lc-stat"><b>${future ? '–' : money(LW.total)}</b><span class="sub">labor cost</span></div>
      <div class="lc-stat"><b>${hrs(tot.s)}</b><span class="sub">scheduled · ${money(LS.total)}</span></div></div>
      ${rep.some(r => r.running) && from <= today && to >= today ? `<div class="row"><div class="txt sub">${rep.filter(r => r.running).length} on the clock now – worked hours and cost keep counting.</div><span class="pill ok">Live</span></div>` : ''}
      ${!future ? `<div class="row"><div class="txt sub">${to < today && LS.total ? money(Math.abs(LW.total - LS.total)) + (LW.total >= LS.total ? ' over' : ' under') + ' the schedule. ' : ''}Hours × wage${k > 1 ? ' + ' + Math.round((k - 1) * 100) + '%' : ''}, overtime included. Estimate.${LW.missing.length || LS.missing.length ? ' No wage set for ' + [...new Set(LW.missing.concat(LS.missing))].map(first).map(esc).join(', ') + '.' : ''}</div></div>` : ''}</div>
    ${byDay}
    <h2>People</h2><div class="card">${ppl.map(r => rowBtn(`data-tsperson="${esc(r.name)}"`, `<div class="txt"><b>${esc(r.name)}${r.running ? ' <span class="pill ok">On</span>' : ''}</b><div class="sub">${future ? hrs((LS.hoursByPerson[r.name] || 0) * 60) + ' scheduled' : hrs(r.worked) + ' worked of ' + hrs((LS.hoursByPerson[r.name] || 0) * 60) + ' scheduled'}${wageOf(r.name) ? ` · ${future ? money(LS.byPerson[r.name] || 0) + ' sched.' : money(LW.byPerson[r.name] || 0) + ' of ' + money(LS.byPerson[r.name] || 0)}${LW.ot[r.name] ? ' · ' + hrs(LW.ot[r.name] * 60) + ' OT' : ''}` : ' · no wage set'}</div>
      ${r.lates || r.noShow || r.missingOut || r.unscheduled ? `<div style="margin-top:4px">${[r.lates ? ['warn', r.lates + ' late'] : null, r.noShow ? ['warn', r.noShow + ' no-show'] : null, r.missingOut ? ['warn', r.missingOut + ' no clock-out'] : null, r.unscheduled ? ['mute', r.unscheduled + ' unscheduled'] : null].filter(Boolean).map(([c, t]) => `<span class="pill ${c}">${t}</span>`).join(' ')}</div>` : ''}</div><span>›</span>`)).join('') || '<div class="empty">No shifts or punches.</div>'}</div>
    <p class="sub">Late means clocking in more than ${data.lateAfter || 5} minutes after the shift start. Approved time off never counts as a no-show.</p>`;
}
function punchSheet(){
  const s = sheet, p = s.id ? (data.punches || []).find(x => x.id === s.id) : null;
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${p ? 'Fix punch' : 'Add punch'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <form class="stack" data-form="punch" style="padding:0">
      <label class="f">Who<select name="name">${(data.users || []).map(u => `<option ${u.name === s.name ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label class="f">Date<input name="date" type="date" value="${esc(p ? p.date : s.date)}"></label>
      <div class="two"><label class="f">In<input name="in" type="time" value="${esc(p && p.in ? hmOf(p.in) : s.start || '')}"></label><label class="f">Out<input name="out" type="time" value="${esc(p && p.out ? hmOf(p.out) : s.end || '')}"></label></div>
      ${(data.shiftTypes || []).length ? `<label class="f">Shift type (for payroll)<select name="type">${data.shiftTypes.map((t, i) => `<option value="${esc(t)}" ${(p && p.type ? p.type === t : i === 0) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
      <label class="f">Note<input name="note" maxlength="200" value="${esc(p ? p.note : '')}" placeholder="e.g. Forgot to clock out"></label>
      <div class="btns"><button class="btn go">Save</button>${p ? `<button type="button" class="btn" data-delpunch="${esc(p.id)}">Delete</button>` : ''}</div></form></div></div>`;
}

/* ----- chat ----- */
const AV = ['#1E5662', '#2B7A8A', '#9A6514', '#5E6666'];
const initials = n => { const w = String(n || '?').trim().split(/\s+/); return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); };
const avColor = k => { let h = 0; for (const ch of String(k)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AV[h % AV.length]; };
/* "Last active": the server knows when each person last used the app (to within a minute or so). Under 5 minutes counts as active now. */
const otherId = c => c && c.kind === 'dm' ? String(c.id).split('-').slice(1).find(x => x !== data.meId) : c && !c.kind ? c.id : '';
const activeMs = id => liveOnline.has(id) && data.active && id in data.active ? Date.now() : Number((data.active || {})[id] || 0);
const isActive = id => !!id && id !== data.meId && Date.now() - activeMs(id) < 5 * 60000;
function activeLabel(id){
  const ms = activeMs(id); if (!ms || id === data.meId) return ''; const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 5) return 'Active now'; if (m < 60) return `Active ${m} min ago`; if (m < 24 * 60 && ymdOf(new Date(ms)) === T()) return `Active ${Math.floor(m / 60)} h ago`;
  if (ymdOf(new Date(ms)) === plus(T(), -1)) return 'Active yesterday'; if (m < 7 * 1440) return 'Active ' + new Date(ms).toLocaleDateString([], { weekday: 'long' });
  return m < 60 * 1440 ? 'Active ' + new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
}
function avatar(c, size){
  const st = `style="--av:${avColor(c.id || c.name)}${size ? ';--sz:' + size + 'px' : ''}"`;
  if (isActive(otherId(c))) return avatar0(c, size).replace('class="av', 'class="av on');
  return avatar0(c, size, st);
}
function avatar0(c, size, st){
  st = st || `style="--av:${avColor(c.id || c.name)}${size ? ';--sz:' + size + 'px' : ''}"`;
  if (c.kind === 'channel') return `<span class="av ch" ${st} aria-hidden="true">#</span>`;
  if (c.kind === 'group') return `<span class="av grp" ${st} aria-hidden="true"><svg viewBox="0 0 24 24" width="55%" height="55%" fill="currentColor"><circle cx="9" cy="8" r="3.2"/><circle cx="16.5" cy="9" r="2.6"/><path d="M2.5 19c.4-3.6 3.1-5.6 6.5-5.6s6.1 2 6.5 5.6z"/><path d="M15.2 13.6c2.9-.3 5.6 1.3 6.3 5.4h-4.4c-.2-2.2-.9-4-1.9-5.4z"/></svg></span>`;
  return `<span class="av" ${st} aria-hidden="true">${esc(initials(c.name))}</span>`;
}
const shortWhen = iso => { if (!iso) return ''; const d = new Date(iso), day = ymdOf(d), diff = (Date.now() - d) / 864e5;
  return day === T() ? timeOf(iso) : day === plus(T(), -1) ? 'Yesterday' : diff < 6 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const v3 = () => Number(data && data.version) >= 3;
const SVG_READ = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12.5l4.5 4.5L15 8"/><path d="M11 16l1 1 9.5-9.5"/></svg>';
// Status marks bring their own style (an old cached page may not have it)
(function(){ if (document.getElementById('mstat-css')) return; const st = document.createElement('style'); st.id = 'mstat-css'; st.textContent = '.mstat{align-self:flex-end;display:flex;align-items:center;gap:3px;font-size:.68rem;line-height:1;color:var(--muted);margin:-1px 6px 8px;opacity:.85;font-style:italic;letter-spacing:.01em}.mstat svg{flex:none}.mstat.st-seen{color:var(--accent);opacity:1}.mstat.st-sending{opacity:.6}.mstat .lnk{font-size:inherit;font-style:normal}'; document.head.appendChild(st); })();
const STAT_IC = {   // small status marks under your newest message
  sending: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  sent: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  delivered: '<svg viewBox="0 0 20 16" width="17" height="14" aria-hidden="true"><path d="M1.8 8.5l3 3 6-7M8.3 10.6l.9.9 6-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
STAT_IC.seen = STAT_IC.delivered;
const SVG_REPLY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** How to @mention someone: first name, or full name when two people share it. */
function mentionLabel(p){ const f = first(p.name).toLowerCase(); return (data.people || []).filter(x => first(x.name).toLowerCase() === f).length > 1 ? p.name : first(p.name); }
function audience(c){
  const ppl = (data.people || []).filter(p => p.id !== data.meId);
  if (!c || c.kind === 'dm') return [];
  if (c.kind === 'group') return ppl.filter(p => (c.memberIds || []).indexOf(p.id) >= 0);
  return ppl.filter(p => c.who === 'Managers' ? p.role === 'Manager' : /lead/i.test(c.who) ? p.role !== 'Staff' : true);
}
let mentRe = null, mentKey = '';
function fmtMsg(text){
  let h = esc(text); if (h.indexOf('@') < 0) return h;
  const key = (data.people || []).map(p => p.id + p.name).join('|');
  if (key !== mentKey){ mentKey = key; const labels = []; (data.people || []).forEach(p => { labels.push({ l: p.name, id: p.id }); if (mentionLabel(p) === p.name) return; labels.push({ l: first(p.name), id: p.id }); });
    labels.sort((a, b) => b.l.length - a.l.length); mentRe = labels.length ? { re: new RegExp('@(' + labels.map(x => escRe(esc(x.l))).join('|') + ')(?![\\w])', 'gi'), labels } : null; }
  if (!mentRe) return h;
  return h.replace(mentRe.re, (m, n) => { const hit = mentRe.labels.find(x => esc(x.l).toLowerCase() === n.toLowerCase()); return `<span class="ment ${hit && hit.id === data.meId ? 'me' : ''}">${m}</span>`; });
}
const SVG_EDIT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
function viewChat(){
  if (chat.open) return viewConversation();
  const ch = (data.channels || []).slice().sort((a, b) => String((b.last || {}).at || '').localeCompare(String((a.last || {}).at || '')) || (a.kind === 'channel' ? -1 : 1));
  const row = c => { const l = c.last, mine = l && first(l.from) === first(data.me.name) && l.from === data.me.name;
    const pre = !l ? (c.kind === 'group' ? esc(c.members.join(', ')) : 'No messages yet') : (mine ? 'You: ' : c.kind === 'dm' ? '' : esc(first(l.from)) + ': ') + esc(l.text);
    return `<button class="crow ${c.unread ? 'unread' : ''}" data-openchat="${esc(c.id)}">${avatar(c)}<span class="cbody"><span class="ctop"><b>${esc(c.name)}</b><span class="cwhen">${l ? shortWhen(l.at) : ''}</span></span><span class="cbot"><span class="cpre">${pre}</span>${c.unread ? `<span class="cn">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</span></span></button>`; };
  const q = chat.q || '', searching = v3() && q.trim().length >= 2;
  const hl = t => { const h = esc(t), i = h.toLowerCase().indexOf(esc(q.trim()).toLowerCase()); return i < 0 ? h : h.slice(0, i) + '<mark>' + h.slice(i, i + esc(q.trim()).length) + '</mark>' + h.slice(i + esc(q.trim()).length); };
  const res = r => `<button class="crow" data-openfind="${esc(r.channel)}|${esc(r.id)}">${avatar({ id: r.channel, name: r.name, kind: r.kind })}<span class="cbody"><span class="ctop"><b>${esc(r.kind === 'dm' ? r.name : r.name)}</b><span class="cwhen">${shortWhen(r.at)}</span></span><span class="cpre wrap"><span class="sub">${esc(first(r.from))}:</span> ${hl(r.text)}</span></span></button>`;
  const body = searching ? (chat.results ? chat.results.map(res).join('') || '<div class="empty">No messages match.</div>' : '<div class="empty">Searching…</div>')
    : ch.map(row).join('') || '<div class="empty">No conversations yet. Tap the pencil to start one.</div>';
  const unreadN = ch.reduce((n, c) => n + (Number(c.unread) || 0), 0);
  return `<div class="chathead"><h1>Messages</h1>${unreadN && LIVE ? '<button class="btn sm" data-readall style="margin-left:auto;margin-right:8px">Mark all read</button>' : ''}<button class="iconbtn" data-newdm aria-label="New message">${SVG_EDIT}</button></div>
    ${v3() ? `<div class="csearch"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input type="search" data-csearch placeholder="Search messages" value="${esc(q)}" aria-label="Search messages" autocomplete="off">${q ? '<button class="cx" data-clearsearch aria-label="Clear search">×</button>' : ''}</div>` : ''}
    <div class="clist">${body}</div>`;
}
function convName(){ const c = (data.channels || []).find(x => x.id === chat.open); if (c) return c.name; const other = chat.open.split('-').slice(1).find(x => x !== data.meId), p = (data.people || []).find(x => x.id === other); return p ? p.name : chat.dmName || 'Message'; }
function convSub(c){ if (!c) return ''; if (c.kind === 'channel') return c.who === 'Everyone' ? '' : c.who; if (c.kind === 'group') { const on = (c.memberIds || []).filter(isActive).map(id => first(((data.people || []).find(p => p.id === id) || {}).name)); return c.members.map(first).join(', ') + (on.length ? ' · ' + on.join(', ') + ' active now' : ''); } return activeLabel(otherId(c)); }
function viewConversation(){
  const msgs = chat.msgs || [], c = curChat() || { id: chat.open, name: convName(), kind: 'dm' }, multi = c.kind !== 'dm';
  const gap = (a, b) => Math.abs(new Date(b.at) - new Date(a.at)) / 6e4;
  const body = msgs.map((m, i) => {
    const prev = msgs[i - 1], next = msgs[i + 1], mine = m.id === 'tmp' || m.fromId === (chat.me || data.meId);
    const sep = !prev || ymdOf(new Date(m.at)) !== ymdOf(new Date(prev.at)) || gap(prev, m) > 60;
    const firstR = sep || prev.fromId !== m.fromId || gap(prev, m) > 5;
    const nextSep = next && (ymdOf(new Date(next.at)) !== ymdOf(new Date(m.at)) || gap(m, next) > 60);
    const lastR = !next || nextSep || next.fromId !== m.fromId || gap(m, next) > 5;
    const pic = m.photo ? picTag(m) : m.expired ? '<div class="msg exp"><i>Photo expired</i></div>' : '';
    const real = m.id !== 'tmp', acks = m.acks || [];
    const meta = chat.meta === m.id ? `<div class="meta ${mine ? 'me' : ''}">${timeOf(m.at)}${v3() && real ? ` · <button class="lnk" data-reply="${esc(m.id)}">Reply</button>` : ''}${v3() && real && !mine ? ` · <button class="lnk" data-ack="${esc(m.id)}">${m.ackMine ? 'Unmark read' : 'Mark read'}</button>` : ''}${mgr() && real ? ` · <button class="lnk" data-delmsg="${esc(m.id)}">Delete</button>` : ''}</div>` : '';
    const quote = m.reply ? `<button type="button" class="quote" data-jump="${esc(m.reply.id)}"><b>${esc(m.reply.from ? (m.reply.from === data.me.name ? 'You' : first(m.reply.from)) : '')}</b><span>${m.reply.photo && !m.reply.text ? '📷 Photo' : esc(m.reply.text)}</span></button>` : '';
    const ackPill = acks.length ? `<div class="ackrow ${mine ? 'me' : ''}"><button class="ackp ${m.ackMine ? 'mine' : ''}" data-acks="${esc(m.id)}" aria-label="Read by ${esc(acks.join(', '))}">${SVG_READ}${acks.length > 1 ? `<span>${acks.length}</span>` : ''}</button></div>` : '';
    // Under your newest message: Sending… → Sent → Delivered → Seen
    const isLastMine = mine && i === msgs.length - 1 && v3();
    const after = x => x.at && new Date(x.at) >= new Date(m.at);
    const seenAll = isLastMine && real ? (chat.seen || []).filter(after) : [], seenBy = seenAll.map(x => first(x.name));
    const kind = !isLastMine ? '' : !real ? 'sending' : seenBy.length ? 'seen' : (chat.dlv || []).some(after) ? 'delivered' : 'sent';
    const label = kind === 'seen' ? (!multi ? 'Seen ' + timeOf(seenAll[0].at) : 'Seen by ' + esc(seenBy.slice(0, 3).join(', ')) + (seenBy.length > 3 ? ` <button class="lnk" data-cseen>+${seenBy.length - 3}</button>` : ''))
      : { sending: 'Sending', sent: 'Sent', delivered: 'Delivered' }[kind];
    const seen = kind ? `<div class="mstat st-${kind}">${STAT_IC[kind]}<span>${label}</span></div>` : '';
    return (sep ? `<div class="daysep"><b>${dayName(ymdOf(new Date(m.at)))}</b> ${timeOf(m.at)}</div>` : '')
      + (multi && !mine && firstR ? `<div class="from">${esc(first(m.from))}</div>` : '')
      + `<div class="mrow ${mine ? 'me' : ''} ${lastR ? 'last' : ''}">`
      + `<div class="bub ${mine ? 'me' : ''} ${firstR || m.reply ? 'first' : ''} ${lastR || acks.length ? 'last' : ''} ${m.photo && !m.reply ? 'photo' : ''} ${!real ? 'tmp' : ''} ${chat.flash === m.id ? 'flash' : ''}" data-bub="${esc(m.id)}" data-mine="${mine ? 1 : 0}">${quote}${pic}${m.text ? `<div class="msg">${fmtMsg(m.text)}</div>` : ''}</div><span class="swipeic" aria-hidden="true">${SVG_REPLY}</span></div>` + ackPill + meta + seen;
  }).join('');
  return `<div class="convo"><div class="chatbar"><button class="iconbtn back" data-closechat aria-label="Back"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="who">${avatar(c, 32)}<div class="wtxt"><b>${esc(convName())}</b>${convSub(c) ? `<span>${esc(convSub(c))}</span>` : ''}</div></div>
      ${canEditChat() ? '<button class="lnk edit" data-editchat>Edit</button>' : '<span class="edit"></span>'}</div>
    <div class="msgs" id="msgs">${body || `<div class="hello">${avatar(c, 64)}<b>${esc(convName())}</b><span>No messages yet. Say hello 👋</span></div>`}</div>
    <div class="mentbox" id="ment" hidden></div>
    ${chat.reply ? `<div class="replybar"><span class="ri">${SVG_REPLY}</span><div><b>Replying to ${esc(chat.reply.from === data.me.name ? 'yourself' : first(chat.reply.from))}</b><span>${esc(chat.reply.text || '📷 Photo')}</span></div><button type="button" class="cx" data-unreply aria-label="Cancel reply">×</button></div>` : ''}
    ${chat.photo ? `<div class="pv"><img src="${chat.photo}" alt="Photo to send"><button type="button" class="pvx" data-unphoto aria-label="Remove photo">×</button></div>` : ''}
    <form class="composer" data-form="send">${Number(data.version) >= 2.7 ? `<label class="picbtn" title="Add a photo" aria-label="Add a photo"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><input type="file" accept="image/*" data-photo hidden onchange="pickPhoto(this)"></label>` : ''}<textarea name="text" rows="1" maxlength="2000" placeholder="${chat.photo ? 'Add a caption' : 'Message'}" aria-label="Message">${esc(chat.compose)}</textarea><button class="send" aria-label="Send" ${chat.sending ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5.5 11.5L12 5l6.5 6.5"/></svg></button></form></div>`;
}
function curChat(){ return (data.channels || []).find(x => x.id === chat.open); }
function canEditChat(){ const c = curChat(); return !!c && Number(data.version) >= 2.9 && (c.kind === 'group' || (c.kind === 'channel' && lead())); }
function editChatSheet(){
  const c = curChat(); if (!c) return '';
  const people = (data.people || []).filter(p => p.id !== data.meId), ids = c.memberIds || [];
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${c.kind === 'group' ? 'Edit group' : 'Edit channel'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <form class="stack" data-form="editchat" style="padding:0"><label class="f">Name<input name="name" maxlength="40" value="${esc(c.name)}"></label>
      ${c.kind === 'group' ? `<h2 style="margin:4px 0 0">People</h2><div class="card">${people.map(p => `<label class="row" style="gap:10px"><input type="checkbox" name="m" value="${esc(p.id)}" ${ids.indexOf(p.id) >= 0 ? 'checked' : ''} style="width:auto;min-height:0"> ${esc(p.name)}</label>`).join('')}</div>`
        : `<label class="f">Who sees it<select name="who">${['Everyone', 'Leads and managers', 'Managers'].map(o => `<option ${o === c.who ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`}
      <button class="btn go">Save</button></form></div></div>`;
}
async function openChat(id, name, text, photo, opt){
  chat.open = id; chat.dmName = name || chat.dmName; if (text === undefined && chat.loaded !== id) { chat.msgs = []; chat.seen = []; chat.dlv = []; }
  render(); scrollChat();
  if (LIVE) return liveOpen(id, text, photo, opt);
  try {
    const r = await post(Object.assign({ fn: 'chat', token: TOKEN, channel: id, text }, photo ? { photo } : {}, opt || {}));
    if (photo){ const mine = r.messages.filter(m => m.fromId === r.me && m.photo).pop(); if (mine && !picCache[mine.id]){ picCache[mine.id] = photo; idbPut(mine.id, photo); } }
    if (chat.open !== id) return;
    chat.msgs = r.messages; chat.seen = r.seen || []; chat.me = r.me; chat.loaded = id; data.channels = r.channels; if (r.active) data.active = r.active; save('pt-cache', JSON.stringify(data));
    const near = isNearBottom(); render(); if (opt && opt.find) jumpTo(opt.find); else if (near || text !== undefined) scrollChat();
  } catch (e) { const m = String(e.message || e); if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, '')); if (text !== undefined) { chat.compose = text; if (photo) chat.photo = photo; if (opt && opt.replyTo && opt.reply) chat.reply = opt.reply; chat.msgs = (chat.msgs || []).filter(x => x.id !== 'tmp'); toast('Not sent: ' + m); render(); } }
  clearTimeout(chat.timer); chat.timer = setTimeout(() => { if (chat.open === id && tab === 'chat' && !document.hidden) openChat(id); }, 7000);
}
function stopChat(){ if (LIVE && chat.open) LIVE.send({ t: 'close' }); clearTimeout(chat.timer); chat.open = ''; chat.reply = null; chat.meta = ''; chat.flash = ''; }
function jumpTo(id){ const el = document.querySelector(`[data-bub="${CSS.escape(id)}"]`);
  if (!el){ if (chat.open) openChat(chat.open, null, undefined, undefined, { find: id }); return; }
  chat.flash = id; el.classList.add('flash'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => { if (chat.flash === id) chat.flash = ''; el.classList.remove('flash'); }, 1600); }
function toggleAck(id){ const m = (chat.msgs || []).find(x => x.id === id); if (!m || m.fromId === chat.me) return;
  m.ackMine = m.ackMine ? 0 : 1; m.acks = (m.acks || []).filter(n => n !== data.me.name).concat(m.ackMine ? [data.me.name] : []);
  chat.meta = ''; render(); if (navigator.vibrate) try { navigator.vibrate(12); } catch (_) {}
  if (LIVE){ LIVE.send({ t: 'ack', id }); return; }
  openChat(chat.open, null, undefined, undefined, { ack: id }); }
function startReply(id){ const m = (chat.msgs || []).find(x => x.id === id); if (!m) return;
  chat.reply = { id: m.id, from: m.from, text: m.text ? m.text.slice(0, 90) : '' }; chat.meta = ''; render(); const t = $('.composer textarea'); if (t) t.focus(); }
let searchT = 0, searchN = 0;
function keepSearch(fn){ const a = document.activeElement, keep = a && a.dataset && a.dataset.csearch !== undefined, pos = keep ? a.selectionStart : 0; fn(); if (keep){ const el = $('[data-csearch]'); if (el){ el.focus(); try { el.setSelectionRange(pos, pos); } catch (_) {} } } }
function runSearch(){ const q = (chat.q || '').trim(); clearTimeout(searchT); chat.results = null; if (q.length < 2) return;
  const n = ++searchN; searchT = setTimeout(() => (LIVE ? LIVE.ask({ t: 'search', q }) : post({ fn: 'chatSearch', token: TOKEN, q })).then(r => { if (n !== searchN || tab !== 'chat' || chat.open) return; chat.results = r.results; keepSearch(render); }).catch(e => { if (n === searchN){ chat.results = []; toast(e.message); } }), 350); }

/* ----- live chat: when the sheet's Settings has a Chat service address, messages go straight to the chat service ----- */
let LIVE = null, liveList = null, liveMe = '', liveOnline = new Set(), paintT = 0, paintAfter = [];
function liveSync(){
  const url = data && data.chat && data.chat.url;
  if (!url){ liveEnd(); return; }
  if (liveList) data.channels = liveList;          // the sheet no longer sends the list; the service does
  if (LIVE) return;
  LIVE = LiveChat({ url, space: data.space || 'peregrine', ticket: () => post({ fn: 'chatTicket', token: TOKEN }), on: liveOn,
    onUp: () => { if (chat.open && tab === 'chat' && !document.hidden) openChat(chat.open); } });
}
function liveEnd(){ if (LIVE){ LIVE.stop(); LIVE = null; } liveList = null; liveOnline = new Set(); }
function paint(after){ if (after) paintAfter.push(after); clearTimeout(paintT); paintT = setTimeout(() => { if (!data) return; const near = isNearBottom(); render(); paintAfter.splice(0).forEach(f => f(near)); }, 40); }
const byLast = (a, b) => String((b.last || {}).at || '').localeCompare(String((a.last || {}).at || '')) || (a.kind === 'channel' ? -1 : 1);
const liveMsg = m => Object.assign(m, { ackMine: (m.ackIds || []).indexOf(liveMe) >= 0 ? 1 : 0 });
function setLiveList(list){ liveList = (list || []).slice().sort(byLast); if (data){ data.channels = liveList; save('pt-cache', JSON.stringify(data)); } }
function lastOf(m){ return { from: m.from, text: (m.text || '').slice(0, 80) || (m.photo ? '📷 Photo' : ''), at: m.at }; }
function liveOn(d){
  if (!data) return;
  if (d.t === 'hello'){ liveMe = chat.me = d.me; setLiveList(d.channels); liveOnline = new Set(d.online || []); paint(); return; }
  if (d.t === 'channels'){ setLiveList(d.channels); paint(); return; }
  if (d.t === 'online'){ liveOnline = new Set(d.online || []); paint(); return; }
  const here = !!d.ch && d.ch === chat.open && chat.loaded === d.ch && tab === 'chat' && !document.hidden;
  if (d.t === 'msg'){
    const m = liveMsg(d.m), c = (liveList || []).find(x => x.id === d.ch);
    if (!c) LIVE.send({ t: 'list' });                 // a brand-new private message or group
    else { c.last = lastOf(m); if (!here && m.fromId !== liveMe) c.unread = (c.unread || 0) + 1; liveList.sort(byLast); }
    if (here){ if (!chat.msgs.some(x => x.id === m.id)) chat.msgs = chat.msgs.concat(m); LIVE.send({ t: 'read', ch: d.ch }); paint(near => { if (near) scrollChat(); }); return; }
    paint(); return;
  }
  if (!here) return;
  if (d.t === 'acks'){ const m = chat.msgs.find(x => x.id === d.id); if (m){ m.acks = d.acks; m.ackIds = d.ackIds; liveMsg(m); paint(); } return; }
  if (d.t === 'seen'){ chat.seen = (chat.seen || []).filter(x => x.id !== d.id).concat({ id: d.id, name: d.name, at: d.at }); paint(); return; }
  if (d.t === 'dlv'){ chat.dlv = (chat.dlv || []).filter(x => x.id !== d.id).concat({ id: d.id, name: d.name, at: d.at }); paint(); return; }
  if (d.t === 'deleted'){ chat.msgs = chat.msgs.filter(x => x.id !== d.id); paint(); return; }
}
async function liveOpen(id, text, photo, opt){
  opt = opt || {};
  try {
    if (text !== undefined){
      const key = photo ? await LIVE.upload(photo) : '';
      const r = await LIVE.ask({ t: 'send', ch: id, text: text || '', photo: key, reply: opt.replyTo || '', tmp: 'tmp' }), m = liveMsg(r.m);
      if (photo){ picCache[m.id] = photo; idbPut(m.id, photo); }
      const c = (liveList || []).find(x => x.id === id); if (c){ c.last = lastOf(m); liveList.sort(byLast); } else LIVE.send({ t: 'list' });
      if (chat.open !== id) return;
      const i = chat.msgs.findIndex(x => x.id === 'tmp'); if (i >= 0) chat.msgs.splice(i, 1);
      if (!chat.msgs.some(x => x.id === m.id)) chat.msgs.push(m);
      render(); scrollChat(); return;
    }
    const r = await LIVE.ask({ t: 'open', ch: id, find: opt.find || '' });
    if (chat.open !== id) return;
    chat.msgs = r.messages.map(liveMsg); chat.seen = r.seen || []; chat.dlv = r.dlv || []; chat.me = liveMe || chat.me; chat.loaded = id;
    const c = (liveList || []).find(x => x.id === id); if (c) c.unread = 0;
    const near = isNearBottom(); render(); if (opt.find) jumpTo(opt.find); else if (near) scrollChat();
  } catch (e) {
    const m = String(e && e.message || e).replace(/^(Error|Exception):\s*/, '');
    if (text !== undefined){ chat.compose = text || ''; if (photo) chat.photo = photo; if (opt.reply) chat.reply = opt.reply; const i = (chat.msgs || []).findIndex(x => x.id === 'tmp'); if (i >= 0) chat.msgs.splice(i, 1); toast('Not sent: ' + m); render(); }
    else if (chat.loaded !== id) toast(m);
  }
}
function liveMake(p, done){ LIVE.ask(Object.assign({ t: 'newch' }, p)).then(r => { toast(done); if (r.id) openChat(r.id); }, e => toast(e.message)); }

/* ---------- chat photos: shrunk on the phone before sending, cached on each phone after the first load ---------- */
const picCache = {}, picLoading = {};
let picQueue = [], picActive = 0;
const idb = (() => { let p = null; return () => p || (p = new Promise((res, rej) => { const q = indexedDB.open('pt-photos', 1); q.onupgradeneeded = () => q.result.createObjectStore('p'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })); })();
async function idbGet(k){ try { const db = await idb(); return await new Promise(res => { const q = db.transaction('p').objectStore('p').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (_) { return null; } }
async function idbPut(k, v){ try { const db = await idb(); db.transaction('p', 'readwrite').objectStore('p').put(v, k); } catch (_) {} }
function picTag(m){
  const src = m.local || picCache[m.id];
  if (!src && m.id !== 'tmp') loadPic(m.id);
  return `<button type="button" class="pic ${src ? '' : 'loading'}" data-pic="${esc(m.id)}" aria-label="Open photo">${src ? `<img src="${src}" alt="Photo from ${esc(m.from)}">` : '<span>Loading photo…</span>'}</button>`;
}
function showPic(id, src){ document.querySelectorAll(`[data-pic="${CSS.escape(id)}"]`).forEach(b => { const near = isNearBottom(); b.classList.remove('loading'); b.innerHTML = `<img src="${src}" alt="Photo">`; const img = b.querySelector('img'); if (near && img) img.onload = scrollChat; }); }
function loadPic(id){
  if (picLoading[id] || picCache[id]) return; picLoading[id] = 1;
  idbGet(id).then(hit => { if (hit){ picCache[id] = hit; showPic(id, hit); return; } picQueue.push(id); pumpPics(); });
}
function pumpPics(){
  while (picActive < 2 && picQueue.length){
    const id = picQueue.shift(); picActive++;
    (LIVE ? LIVE.photo(id) : post({ fn: 'photo', token: TOKEN, id }).then(r => 'data:' + r.mime + ';base64,' + r.data)).then(src => { picCache[id] = src; idbPut(id, src); showPic(id, src); })
      .catch(e => { delete picLoading[id]; document.querySelectorAll(`[data-pic="${CSS.escape(id)}"] span`).forEach(x => { x.textContent = /expired|gone/i.test(String(e.message)) ? 'Photo expired' : 'Couldn\'t load – tap to retry'; }); })
      .finally(() => { picActive--; pumpPics(); });
  }
}
/** Shrink a picked photo to fit 1600px and re-encode as JPEG (about 200–500 KB). */
function shrinkPhoto(file){
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.82)); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That photo couldn\'t be opened – try a JPEG or PNG')); };
    img.src = url;
  });
}
function zoomPic(src){
  const box = document.createElement('div'); box.className = 'lightbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Photo');
  box.innerHTML = `<img src="${src}" alt="Photo"><button type="button" class="btn sm">Close</button>`;
  box.addEventListener('click', () => box.remove()); document.addEventListener('keydown', function k(e){ if (e.key === 'Escape'){ box.remove(); document.removeEventListener('keydown', k); } });
  document.body.appendChild(box);
}
// The handler sits on the input itself: the chat redraws every few seconds, and a redraw while the photo picker is open
// swaps out the input, so a page-level listener would never hear about the photo that was picked.
async function pickPhoto(inp){
  if (!inp || !inp.files || !inp.files[0]) return;
  const file = inp.files[0]; inp.value = '';
  const t = $('.composer textarea'); if (t) chat.compose = t.value;
  try { chat.photo = await shrinkPhoto(file); render(); const t2 = $('.composer textarea'); if (t2) t2.focus(); scrollChat(); } catch (err) { toast(err.message); }
}
window.pickPhoto = pickPhoto;
const isNearBottom = () => { const m = $('#msgs'); return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 80; };
const scrollChat = () => { const m = $('#msgs'); if (m) m.scrollTop = m.scrollHeight; };
function pickSheet(kind){
  const people = (data.people || []).filter(p => p.id !== data.meId);
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${kind === 'dm' ? 'New message' : kind === 'group' ? 'New group' : 'New channel'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    ${kind === 'dm' ? `<div class="card"><button class="row rb" data-newgroup><span class="av grp sm" style="--av:#2B7A8A" aria-hidden="true">+</span><div class="txt"><b>New group</b></div><span>›</span></button>${lead() ? '<button class="row rb" data-newchannel><span class="av ch sm" style="--av:#1E5662" aria-hidden="true">#</span><div class="txt"><b>New channel</b></div><span>›</span></button>' : ''}</div><h2>People</h2><div class="card">${people.map(p => rowBtn(`data-dm="${esc(p.id)}" data-dmname="${esc(p.name)}"`, `${avatar({ id: p.id, name: p.name }, 36)}<div class="txt"><b>${esc(p.name)}</b>${activeLabel(p.id) ? `<div class="sub">${activeLabel(p.id)}</div>` : ''}</div><span>›</span>`)).join('')}</div>`
      : `<form class="stack" data-form="${kind}" style="padding:0"><label class="f">Name<input name="name" maxlength="40" placeholder="${kind === 'group' ? 'e.g. Weekend crew' : 'e.g. Catering'}"></label>
        ${kind === 'group' ? `<div class="card">${people.map(p => `<label class="row" style="gap:10px"><input type="checkbox" name="m" value="${esc(p.id)}" style="width:auto;min-height:0"> ${esc(p.name)}</label>`).join('')}</div>`
          : `<label class="f">Who sees it<select name="who"><option>Everyone</option><option>Leads and managers</option><option>Managers</option></select></label>`}
        <button class="btn go">Create</button></form>`}</div></div>`;
}


/* ----- reminders ----- */
/* ---------- push notifications ---------- */
const pushOK = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushNeedsHome = () => isIOS() && !standalone();
const deviceKind = () => /iphone/i.test(navigator.userAgent) ? 'iPhone' : /ipad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /android/i.test(navigator.userAgent) ? 'phone' : 'computer';
const deviceName = () => { const ua = navigator.userAgent; return (/iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : 'Device') + ' · ' + (/edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Browser') + (standalone() ? ' app' : ''); };
const b64u8 = b => { b = String(b).replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; return Uint8Array.from(atob(b), c => c.charCodeAt(0)); };
let pushSub = null, pushChecked = false;
const pushOn_ = () => !!(pushSub && pushOK() && Notification.permission === 'granted');
/** After the data loads: find this device's subscription, and make sure the server has it (covers renewed subscriptions). */
async function pushCheck(){
  if (pushChecked || !pushOK() || !data || !data.push) return; pushChecked = true;
  try {
    const reg = await navigator.serviceWorker.getRegistration(); pushSub = reg ? await reg.pushManager.getSubscription() : null;
    if (pushSub && data.push.ready && Notification.permission === 'granted' && (data.push.devices || []).indexOf(pushSub.endpoint) < 0) act('pushSub', { sub: JSON.stringify(pushSub), device: deviceName() });
    render();
  } catch (_) {}
}
async function pushTurnOn(){
  if (pushNeedsHome()){ moreView = 'push'; tab = 'more'; render(); return; }
  if (!pushOK()){ toast('This browser can\'t get notifications'); return; }
  const perm = await Notification.requestPermission();   // first thing in the tap, so the browser allows the prompt
  if (perm !== 'granted'){ toast(perm === 'denied' ? 'Notifications are blocked – allow them in Settings for this app' : 'Notifications not turned on'); render(); return; }
  try {
    const reg = await navigator.serviceWorker.ready, key = b64u8(data.push.key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey){ const old = new Uint8Array(sub.options.applicationServerKey); if (old.length !== key.length || old.some((x, i) => x !== key[i])){ await sub.unsubscribe(); sub = null; } }
    sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    pushSub = sub; render();
    const r = await act('pushSub', { sub: JSON.stringify(sub), device: deviceName() });
    if (r) toast('Notifications on');
  } catch (e) { toast('Couldn\'t turn on notifications: ' + (e.message || e)); }
}
async function pushTurnOff(){
  const sub = pushSub; pushSub = null; render();
  if (sub){ act('pushUnsub', { endpoint: sub.endpoint }); try { await sub.unsubscribe(); } catch (_) {} }
  toast('Notifications off on this ' + deviceKind());
}
function viewPush(){
  const P = data.push || {}, pr = P.prefs || {}, on = pushOn_(), back = '<button class="btn sm" data-more="settings">‹ Settings</button>';
  let top;
  if (!P.ready) top = `<div class="empty">Push notifications aren't set up for the shop yet.${mgr() ? ' Fill in the Push settings in the sheet.' : ' Ask a manager.'}</div>`;
  else if (pushNeedsHome()) top = `<div class="row"><div class="txt"><b>First, add the app to your Home Screen</b><div class="sub">iPhones only send notifications to apps on the Home Screen.<br>1. Tap the Share button <b>⎋</b> at the bottom of Safari.<br>2. Tap <b>Add to Home Screen</b>, then <b>Add</b>.<br>3. Open Peregrine from your Home Screen and come back here.</div></div></div>`;
  else if (!pushOK()) top = '<div class="empty">This browser can\'t get notifications. On iPhone you need iOS 16.4 or newer.</div>';
  else if (Notification.permission === 'denied') top = `<div class="row"><div class="txt"><b>Notifications are blocked</b><div class="sub">${isIOS() ? 'Open iPhone Settings › Notifications › Peregrine and allow them, then come back.' : 'Allow notifications for this site in the browser\'s site settings, then reload.'}</div></div></div>`;
  else top = on ? `<div class="row"><div class="txt"><b>On for this ${deviceKind()}</b><div class="sub">${esc(deviceName())}</div></div><span class="pill ok">On</span></div>
      <div class="row"><div class="btns" style="margin:0"><button class="btn sm" data-pushtest>Send a test</button><button class="btn sm" data-pushoff>Turn off here</button></div></div>`
    : `<div class="row"><div class="txt"><b>Off on this ${deviceKind()}</b><div class="sub">Get notified about new messages, schedule changes and prep, even when the app is closed.</div></div></div>
      <div class="row"><button class="btn go" data-pushon>Turn on notifications</button></div>`;
  const tog = (k, label, sub) => `<div class="row"><div class="txt"><b>${label}</b><div class="sub">${sub}</div></div><button class="btn sm ${pr[k] !== false ? 'go' : ''}" data-pushpref="${k}" data-v="${pr[k] !== false ? 0 : 1}" aria-pressed="${pr[k] !== false}">${pr[k] !== false ? 'On' : 'Off'}</button></div>`;
  const n = (P.devices || []).length;
  return `<div class="weeknav" style="margin-bottom:8px">${back}<b>Notifications</b><span style="width:60px"></span></div>
    <div class="card">${top}</div>
    ${P.ready ? `<h2>What to send me</h2><div class="card">
      <div class="row"><div class="txt"><b>Messages</b><div class="sub">Direct only = DMs and groups, not channels</div></div></div>
      <div class="row"><div class="seg" style="flex:1;margin:0">${[['all', 'All'], ['direct', 'Direct only'], ['off', 'Off']].map(([k, l]) => `<button data-pushpref="msg" data-v="${k}" aria-pressed="${(pr.msg || 'all') === k}">${l}</button>`).join('')}</div></div>
      ${tog('schedule', 'Schedule', 'When a schedule you\'re on is posted or changed')}
      ${tog('prep', 'Prep', 'When someone asks your shift to prep something')}
      ${tog('remind', 'Shift reminders', 'At the times you picked under Shift reminders')}
      ${tog('news', 'Announcements', 'New posts from managers and leads')}</div>
      <p class="sub">These apply to every device you've turned notifications on (${n} so far).</p>` : ''}
    <h2>Privacy</h2><div class="card">${tog('active', 'Show when I\'m active', 'Others see "Active now" or "Active 20 min ago" next to your name in Messages')}</div>`;
}
/** Open the screen a notification (or a ?go= link) points at. */
function goTo(go){
  go = String(go || ''); if (!go || !data) return;
  const [where, arg] = go.split(':'); sheet = null; viewer = null;
  if (where === 'chat'){ tab = 'chat'; save('pt-tab', tab); if (arg) openChat(arg); else render(); return; }
  stopChat();
  if (where === 'more'){ tab = 'more'; moreView = arg || ''; }
  else if (where === 'lists'){ tab = 'lists'; if (arg === 'prep') listTab = PREP; }
  else if (/^(schedule|today|tests)$/.test(where)) tab = where;
  save('pt-tab', tab); window.scrollTo(0, 0); render();
}
function viewReminders(){
  const me = data.me, R = data.reminders || {}, cal = API && me.cal ? API + '?cal=' + encodeURIComponent(me.cal) : '';
  const webcal = cal.replace(/^https?:/, 'webcal:');
  const modes = [['Night before', 'Night before at ' + t12(R.night || '19:00')], ['Before shift', R.hours + ' hours before'], ['Both', 'Both'], ['Off', 'Off']];
  return `${back('settings')}<h1>Shift reminders</h1>
    ${R.on ? '' : '<div class="hint">Shift reminders are turned off for the shop right now. A manager can turn them on in the sheet\'s Settings.</div>'}
    ${R.on && R.by !== 'email' ? (pushOn_() ? '<div class="hint">Reminders come as a notification on this ' + deviceKind() + '.</div>'
      : `<div class="hint"><b>Turn on notifications to get your reminders</b>${R.by === 'push' ? ' – they don\'t go by email.' : '.'} <div class="btns" style="margin-top:8px"><button class="btn sm go" data-more="push">Turn on notifications</button></div></div>`) : ''}
    <div class="card"><form class="stack" data-form="reminders">
      ${R.by && R.by !== 'push' ? `<label class="f">Email for reminders<input name="email" type="email" autocomplete="email" maxlength="120" value="${esc(me.email || '')}" placeholder="you@example.com"></label>` : ''}
      <div class="f" style="display:grid;gap:6px;font-size:.8rem;color:var(--muted)">When to remind me
        ${modes.map(([k, n]) => `<label class="opt"><input type="radio" name="mode" value="${k}" ${me.reminders === k ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>
      <div class="btns"><button class="btn go">Save</button>${me.email && R.by && R.by !== 'push' ? '<button type="button" class="btn" data-testmail>Send me a test</button>' : ''}</div></form></div>
    ${cal ? `<h2>Put your shifts in your calendar</h2><div class="card"><div class="row" style="display:block">
      <p style="margin:0 0 10px">Your shifts show up in your phone's calendar and update by themselves, with an alert 1 hour before each one.</p>
      <div class="btns"><a class="btn go" href="${esc(webcal)}">iPhone / Mac calendar</a><button class="btn" data-copycal="${esc(cal)}">Copy link for Google Calendar</button></div>
      <details class="more" style="margin-top:10px"><summary>How to set it up</summary><div class="sub">
        <b>iPhone:</b> tap the first button, then Subscribe. To get the 1-hour alerts: Settings › Calendar › Accounts › Subscribed Calendars › this calendar › turn off <i>Remove Alerts</i>.<br>
        <b>Google Calendar:</b> copy the link, then on a computer go to calendar.google.com › Other calendars › + › From URL, and paste it. Google refreshes it every few hours, so last-minute changes can show up late – the emails are faster.<br>
        This link is private to you. If you get a new sign-in code, the old link stops working and you'll need to add it again.</div></details></div></div>` : ''}`;
}
/* ----- announcements ----- */
function annRow(a){
  return `<div class="row" style="display:block"><div style="display:flex;gap:8px;align-items:baseline"><b style="flex:1">${a.pinned ? '📌 ' : ''}${esc(a.title)}</b><span class="sub">${ago(a.posted)}</span></div>
    ${a.message ? `<div class="msg">${esc(a.message)}</div>` : ''}<div class="sub">From ${esc(a.from)}${a.mustAck ? ' · must acknowledge' : ''}</div>
    <div class="btns" style="margin-top:8px">${a.read ? '<span class="pill ok">Seen</span>' : `<button class="btn sm go" data-read="${esc(a.id)}">Got it</button>`}
      ${lead() && a.notRead ? `<span class="sub" style="align-self:center">${a.notRead.length ? 'Not seen: ' + a.notRead.map(esc).join(', ') : 'Everyone has seen it'}</span>` : ''}
      ${lead() ? `<button class="btn sm" data-unann="${esc(a.id)}">Remove</button>` : ''}</div></div>`;
}
function viewNews(){
  const postF = lead() ? `<h2>Post an announcement</h2><div class="card"><form class="stack" data-form="announce"><label class="f">Title<input name="title" maxlength="150"></label>
      <label class="f">Message<textarea name="message" maxlength="3000"></textarea></label>
      <label style="display:flex;gap:8px;align-items:center;font-size:.9rem"><input type="checkbox" name="mustAck" ${mgr() ? 'checked' : ''} style="width:auto;min-height:0"> Everyone must read it before using the app</label>
      <label style="display:flex;gap:8px;align-items:center;font-size:.9rem"><input type="checkbox" name="pinned" style="width:auto;min-height:0"> Pin to the top</label><button class="btn go">Post</button></form></div>` : '';
  return `${back()}<h1>Announcements</h1><div class="card">${(data.announcements || []).map(annRow).join('') || '<div class="empty">No announcements.</div>'}</div>${postF}`;
}

/* ----- requests ----- */
function reqRow(q){
  const cls = q.status === 'Approved' ? 'ok' : q.status === 'Denied' ? 'warn' : 'mute';
  return `<div class="row" style="display:block"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(q.type)} · ${q.date ? dayName(q.date) : ''}</b><span class="pill ${cls}">${esc(q.status)}</span></div>
    <div class="sub">${mgr() && q.from !== data.me.name ? esc(q.from) + ' · ' : ''}${esc(q.details)}${q.note ? ' — ' + esc(q.by) + ': ' + esc(q.note) : ''}</div>
    ${q.status === 'Pending' && mgr() && q.from !== data.me.name ? `<div class="btns" style="margin-top:8px"><button class="btn sm go" data-decide="${esc(q.id)}" data-ok="1">Approve</button><button class="btn sm" data-decide="${esc(q.id)}" data-ok="0">Deny</button>${shiftsOn(q.date).some(s => s.name === q.from) ? '<span class="pill warn" style="align-self:center">Scheduled that day</span>' : ''}</div>` : ''}
    ${q.status === 'Pending' && q.from === data.me.name ? `<div class="btns" style="margin-top:8px"><button class="btn sm" data-cancelreq="${esc(q.id)}">Cancel request</button></div>` : ''}</div>`;
}
function viewRequests(){
  const all = data.requests || [], pend = mgr() ? all.filter(q => q.status === 'Pending' && q.from !== data.me.name) : [];
  const mine = all.filter(q => q.from === data.me.name), others = mgr() ? all.filter(q => q.status !== 'Pending' && q.from !== data.me.name) : [];
  return `${back()}<h1>Time off & swaps</h1>
    ${mgr() ? `<h2>Waiting for you</h2><div class="card">${pend.map(reqRow).join('') || '<div class="empty">Nothing to approve.</div>'}</div>` : ''}
    <h2>New request</h2><div class="card"><form class="stack" data-form="request">
      <label class="f">What<select name="type"><option>Time off</option><option>Swap</option><option>Cover</option></select></label>
      <label class="f">Date<input name="date" type="date" min="${T()}" value="${plus(T(), 1)}"></label>
      <label class="f">Details<textarea name="details" maxlength="1000" placeholder="e.g. Swap my Saturday open with Kelsey"></textarea></label><button class="btn go">Send to managers</button></form></div>
    <h2>Yours</h2><div class="card">${mine.map(reqRow).join('') || '<div class="empty">No requests.</div>'}</div>
    ${others.length ? `<h2>Recently decided</h2><div class="card">${others.map(reqRow).join('')}</div>` : ''}
    <p class="sub">Regular times you can't work go under <button class="lnk" data-more="avail">Availability</button>.</p>`;
}

/* ----- resources (in-app PDFs) ----- */
function viewResources(){
  const tiers = ['Everyone', 'Leads and managers', 'Managers'], ls = data.links || [];
  return `${back()}<h1>Resources</h1>${tiers.map(t => { const xs = ls.filter(l => l.tier === t); return xs.length ? `<h2>${t === 'Everyone' ? 'Everyone' : t}</h2><div class="card">${xs.map(l =>
    l.file && !/\/spreadsheets\//.test(l.url) ? rowBtn(`data-pdf="${esc(l.id)}"`, `<div class="txt"><b>${esc(l.name)}</b><div class="sub">Opens in the app</div></div><span>›</span>`)
      : `<a class="row" href="${esc(l.url)}" target="_blank" rel="noopener" style="text-decoration:none"><div class="txt"><b>${esc(l.name)}</b>${/\/spreadsheets\//.test(l.url) ? '<div class="sub">Opens in Google Sheets</div>' : ''}</div><span>↗</span></a>`).join('')}</div>` : ''; }).join('') || '<div class="card"><div class="empty">No resources yet.</div></div>'}`;
}
async function openPdf(id){
  const l = (data.links || []).find(x => x.id === id); if (!l) return;
  viewer = { id, name: l.name, state: 'loading' }; render();
  const key = 'https://pt-files/' + id;
  let bytes = null, fromCache = false;
  try {
    const r = await post({ fn: 'file', token: TOKEN, id });
    const bin = atob(r.data); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try { const c = await caches.open(NS + 'pt-files'); await c.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } })); } catch (_) {}
  } catch (e) {
    const m = String(e.message || e); if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, ''));
    try { const c = await caches.open(NS + 'pt-files'), hit = await c.match(key); if (hit) { bytes = new Uint8Array(await hit.arrayBuffer()); fromCache = true; } } catch (_) {}
    if (!bytes) { viewer = null; render(); toast(m === 'timeout' ? 'That file took too long – try again' : m); return; }
  }
  if (!viewer || viewer.id !== id) return;
  viewer.state = 'ready'; viewer.cached = fromCache; render();
  try {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: bytes }).promise, box = $('#pages');
    for (let n = 1; n <= doc.numPages && viewer && viewer.id === id; n++) {
      const page = await doc.getPage(n), w = Math.min(box.clientWidth || 360, 900), vp = page.getViewport({ scale: 1 }), scale = w / vp.width, dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const v = page.getViewport({ scale: scale * dpr }), cv = document.createElement('canvas');
      cv.width = v.width; cv.height = v.height; cv.style.width = w + 'px'; cv.style.height = (v.height / dpr) + 'px';
      box.appendChild(cv); await page.render({ canvasContext: cv.getContext('2d'), viewport: v }).promise;
    }
  } catch (e) {       // no PDF viewer available: let the phone's own viewer open it
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const box = $('#pages'); if (box) box.innerHTML = `<div class="empty">This phone couldn't show it here. <a href="${url}" target="_blank">Open the PDF</a></div>`;
  }
}
function viewViewer(){
  return `<div class="viewer"><div class="vbar"><button class="btn sm" data-closeviewer>‹ Back</button><b>${esc(viewer.name)}</b><span style="width:52px"></span></div>
    ${viewer.cached ? '<div class="offline" style="margin:8px">Offline – showing the saved copy</div>' : ''}
    <div id="pages" class="pages">${viewer.state === 'loading' ? '<div class="empty">Opening…</div>' : ''}</div></div>`;
}

/* ----- tests ----- */
/* ----- tests: a tab of its own. Taken right in the app (signed in, so no typing your name); results go to the results sheet. ----- */
let tdata = null, tAt = 0, runner = null;
async function loadTests(){
  try { const r = await post({ fn: 'tests', token: TOKEN }); tdata = r; tAt = Date.now(); } catch (e) { const m = String(e.message || e); if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, '')); toast(m); }
  if (tab === 'tests') render();
}
function viewTests(){
  if (!tdata || Date.now() - tAt > 60000) loadTests();
  if (!tdata) return '<h1>Tests</h1><div class="card"><div class="empty">Loading your tests…</div></div>';
  const ts = tdata.tests || [];
  const row = t => { const st = t.passed ? '<span class="pill ok">Passed</span>' : t.pending ? '<span class="pill mute">Being scored</span>' : t.last ? `<span class="pill warn">${esc(t.last.result || 'Not yet')}${t.last.score !== '' && t.last.score != null ? ' ' + esc(t.last.score) + '/' + esc(t.last.outOf) : ''}</span>` : !t.unlocked ? '<span class="pill mute">Locked</span>' : '';
    const go = t.unlocked ? (t.inApp ? `<button class="btn sm ${t.passed ? '' : 'go'}" data-taketest="${esc(t.level)}">${t.passed ? 'Retake' : t.taken ? 'Try again' : 'Start the test'}</button>` : t.url ? `<a class="btn sm ${t.passed ? '' : 'go'}" href="${esc(t.url)}" target="_blank" rel="noopener">${t.passed ? 'Retake' : 'Take the test'} ↗</a>` : '<span class="sub">Not set up yet – ask a manager.</span>') : '';
    return `<div class="row" style="display:block"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(t.name)}</b>${st}</div>
      <div class="sub">${!t.unlocked ? 'Pass ' + esc(t.need) + ' first' : (t.info ? esc(t.info) + ' · ' : '') + (t.taken ? 'Taken ' + t.taken + ' time' + (t.taken > 1 ? 's' : '') + (t.last && t.last.when ? ' · last ' + ago(t.last.when) : '') : 'Not taken yet')}</div>
      ${go ? `<div class="btns" style="margin-top:8px">${go}</div>` : ''}</div>`; };
  return `<h1>Tests</h1>
    ${tdata.results ? `<div class="card"><div class="row"><div class="txt"><b>Test results</b><div class="sub">Everyone's scores and written answers live in the results sheet.</div></div><a class="btn sm" href="${esc(tdata.results)}" target="_blank" rel="noopener">Open sheet ↗</a></div></div>` : ''}
    <h2>Certification</h2><div class="card">${ts.map(row).join('') || '<div class="empty">No tests set up.</div>'}</div>
    <p class="sub">Each level unlocks when you pass the one before it. You can retake a test; your best result counts.</p>`;
}
async function startTest(level){
  runner = { level, loading: true }; render();
  try { const t = await post({ fn: 'getTest', token: TOKEN, level }); runner = { level, t, i: 0, a: load('pt-test-' + level) ? JSON.parse(load('pt-test-' + level)) : {}, started: Date.now() }; }
  catch (e) { runner = null; toast(String(e.message || e)); }
  render();
}
function viewRunner(){
  if (runner.loading) return '<div class="runner"><div class="empty">Opening the test…</div></div>';
  if (runner.done) { const d = runner.done;
    return `<div class="runner"><div class="runner-in"><h1>${esc(runner.t.title)}</h1>
      ${runner.t.written ? '<p>Submitted. Your Manager will score it and you\'ll see the result here.</p>' : `<div class="score ${d.result === 'Pass' ? 'ok' : ''}">${esc(d.score)} / ${esc(d.outOf)}</div><p><b>${d.result === 'Pass' ? 'You passed.' : 'Not yet.'}</b> ${d.result === 'Pass' ? '' : 'You need ' + esc(d.needed) + ' to pass. Review the material and try again.'}</p>${d.missed && d.missed.length ? `<p class="sub">Questions to review: ${d.missed.join(', ')}</p>` : ''}`}
      <button class="btn go" data-closetest style="width:100%">Done</button></div></div>`; }
  const t = runner.t, q = t.q[runner.i], n = t.q.length, ans = runner.a[runner.i], answered = Object.keys(runner.a).filter(k => String(runner.a[k]).trim()).length;
  const sec = q.s && (runner.i === 0 || t.q[runner.i - 1].s !== q.s) ? `<div class="sub" style="margin-bottom:6px">${esc(q.s)}</div>` : `<div class="sub" style="margin-bottom:6px">${esc(q.s || '')}</div>`;
  return `<div class="runner"><div class="runner-in">
    <div class="rhead"><button class="btn sm" data-closetest>Close</button><span class="sub">${runner.i + 1} of ${n}</span></div>
    <div class="progress" style="margin:10px 0 16px"><i style="width:${Math.round(answered / n * 100)}%"></i></div>
    ${sec}<h2 class="q">${esc(q.p)}</h2>
    ${t.written ? `<textarea data-wans rows="7" placeholder="Type your answer">${esc(ans || '')}</textarea><p class="sub">Saved on this phone as you type.</p>`
      : `<div class="opts">${q.o.map((o, k) => `<button class="opt2 ${ans === o ? 'on' : ''}" data-pick="${k}">${esc(o)}</button>`).join('')}</div>`}
    <div class="btns rfoot"><button class="btn" data-tq="-1" ${runner.i === 0 ? 'disabled' : ''}>Back</button>
      ${runner.i < n - 1 ? `<button class="btn go" data-tq="1">Next</button>` : `<button class="btn go" data-submittest ${answered < n ? 'title="Some questions are blank"' : ''}>Submit</button>`}</div>
    ${runner.i === n - 1 && answered < n ? `<p class="sub warn-t">${n - answered} question${n - answered > 1 ? 's are' : ' is'} blank.</p>` : ''}
  </div></div>`;
}
async function submitTest(){
  const t = runner.t, answers = t.q.map((_, k) => runner.a[k] == null ? '' : runner.a[k]);
  if (!confirm(answers.some(a => !String(a).trim()) ? 'Some answers are blank. Submit anyway?' : 'Submit your answers?')) return;
  runner.sending = true; render();
  try { const d = await post({ fn: 'submitTest', token: TOKEN, level: runner.level, answers }); save('pt-test-' + runner.level, null); runner.done = d; tdata = null; }
  catch (e) { toast('Not submitted – ' + String(e.message || e)); }
  runner.sending = false; render();
}
/* ----- team ----- */
const back = to => !to && wide() ? '' : `<button class="btn sm" data-more="${to || ''}" style="margin-bottom:6px">‹ ${to ? (to === 'settings' ? 'Settings' : 'Back') : 'More'}</button>`;   // desktop: the sidebar is the menu
function viewTeam(){
  const us = (data.users || []).slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  const added = justAdded && us.find(u => u.name === justAdded), inv = added || (inviteFor && us.find(u => u.id === inviteFor));
  const addedCard = inv && inv.invite ? `<div class="hint" id="invite"><b>${added ? esc(inv.name) + ' is on the team.' : 'Invite ' + esc(inv.name)}</b>
      <div class="sub" style="margin:4px 0 8px">${inv.joined && !added ? `${esc(first(inv.name))} is already set up (code: last 4 digits of their phone). This link lets them set it up again – it changes their code to match the phone they type and signs them out on other phones.`
        : `Send this link. ${esc(first(inv.name))} opens it, adds their phone number and email, and that creates their account – their code is the last 4 digits of their phone.`}</div>
      <input class="linkbox" readonly value="${esc(inviteLink(inv))}" aria-label="Invite link" onclick="this.select()">
      <div class="btns" style="margin-top:8px">${navigator.share ? `<button class="btn sm go" data-shareinvite="${esc(inv.id)}">Share…</button>` : ''}<button class="btn sm ${navigator.share ? '' : 'go'}" data-copyinvite="${esc(inv.id)}">Copy</button>
        ${inv.phone ? `<a class="btn sm" href="sms:${esc(inv.phone.replace(/[^\d+]/g, ''))}${isIOS() ? '&' : '?'}body=${encodeURIComponent(inviteText(inv))}">Text it</a>` : ''}
        ${inv.email ? `<a class="btn sm" href="mailto:${esc(inv.email)}?subject=${encodeURIComponent('Your Peregrine team app')}&body=${encodeURIComponent(inviteText(inv))}">Email it</a>` : ''}
        <button class="btn sm" data-dismiss>Done</button></div>
      <div class="sub" style="margin-top:6px">Each link works once.</div></div>`
    : inv ? `<div class="hint" id="invite"><b>${esc(inv.name)} is on the team.</b> Their invite link appears here once the server is updated (paste the new Code.gs). <button class="btn sm" data-dismiss>Done</button></div>` : '';
  const form = u => `<form class="stack" data-form="user" ${u ? `data-id="${esc(u.id)}"` : ''}>
      <label class="f">Name<input name="name" maxlength="60" value="${esc(u ? u.name : '')}" placeholder="First and last name"></label>
      <label class="f">Role<select name="role">${['Staff', 'Lead', 'Manager'].map(r => `<option ${u && u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <div class="two"><label class="f">Phone${u ? '' : ' (optional)'}<input name="phone" type="tel" maxlength="40" value="${esc(u ? u.phone : '')}"></label><label class="f">Email${u ? '' : ' (optional)'}<input name="email" type="email" maxlength="120" value="${esc(u ? u.email : '')}"></label></div>
      ${u ? '' : '<p class="sub" style="margin:0">Leave these blank and they\'ll add them from their invite link. Their code is always the last 4 digits of their phone.</p>'}
      <label class="f">Hourly wage ($) – only managers see this<input name="wage" inputmode="decimal" maxlength="8" value="${u && u.wage ? Number(u.wage).toFixed(2) : ''}" placeholder="e.g. 15.50"></label>
      <div class="btns"><button class="btn go">${u ? 'Save' : 'Add to the team'}</button>${u ? '<button type="button" class="btn" data-canceledit>Cancel</button>' : ''}</div></form>`;
  const row = u => editUser === u.id ? `<div class="row" style="display:block;padding:0">${form(u)}</div>` : `<div class="row" style="display:block;${u.active ? '' : 'opacity:.55'}">
      <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(u.name)}</b><span class="pill ${u.role === 'Manager' ? 'warn' : u.role === 'Lead' ? 'ok' : 'mute'}">${esc(u.role)}</span>${u.active ? '' : '<span class="pill mute">Off</span>'}${u.active && u.invite && !u.joined ? '<span class="pill warn">Not set up yet</span>' : ''}</div>
      <div class="sub">${u.wage ? money(u.wage, true) + '/h · ' : ''}${u.email ? (u.reminders === 'Off' ? 'Reminders off' : 'Reminders: ' + esc(u.reminders)) : 'No email – no reminders'}</div><div class="sub">${u.phone ? esc(u.phone) + ' · ' : ''}Code ${showCode[u.id] ? `<b>${esc(u.code)}</b>` : '••••'} <button class="btn sm" data-showcode="${esc(u.id)}" style="padding:4px 8px;min-height:0">${showCode[u.id] ? 'Hide' : 'Show'}</button></div>
      <div class="btns" style="margin-top:8px">${u.active ? `<button class="btn sm go" data-invite="${esc(u.id)}">Invite link</button>` : ''}<button class="btn sm" data-edit="${esc(u.id)}">Edit</button><button class="btn sm" data-newcode="${esc(u.id)}" data-name="${esc(u.name)}">New code</button>
        <button class="btn sm" data-active="${esc(u.id)}" data-to="${u.active ? 0 : 1}" data-name="${esc(u.name)}">${u.active ? 'Turn off' : 'Turn on'}</button></div></div>`;
  return `${back()}<h1>Team</h1>${addedCard}<div class="card">${us.map(row).join('')}</div>
    <h2>Schedule lineup</h2><p class="sub" style="margin:0 4px 8px">Drag ⠿ to set the order people appear on the schedule. Hidden people stay on the team (they can still sign in); they just don't take up a row.</p>
    <div class="card" data-reorder>${lineup().map(u => `<div class="row" data-rid="${esc(u.id)}"><span class="handle" data-rowdrag aria-label="Drag to reorder ${esc(u.name)}">⠿</span><div class="txt ${shown(u) ? '' : 'muted'}"><b>${esc(u.name)}</b><div class="sub">${esc(u.role)}${shown(u) ? '' : ' · hidden from the schedule'}</div></div><button class="btn sm" data-onsched="${esc(u.id)}" data-to="${shown(u) ? 0 : 1}">${shown(u) ? 'Hide' : 'Show'}</button></div>`).join('')}</div>
    <h2>Add someone</h2><div class="card">${form(null)}</div>
    <p class="sub">Turning someone off or giving a new code signs them out on every phone right away. Everything here is also on the Users tab of the sheet.</p>`;
}

function viewMore(){
  const views = { settings: viewSettings, push: viewPush, reminders: viewReminders, requests: viewRequests, avail: viewAvail, time: viewTime, news: viewNews, resources: viewResources, team: () => mgr() ? viewTeam() : viewMoreList() };
  if (!views[moreView] && wide()) moreView = 'settings';   // desktop has no More list – the sidebar lists everything
  return views[moreView] ? views[moreView]() : viewMoreList();
}
function viewMoreList(){
  const pendN = mgr() ? (data.requests || []).filter(q => q.status === 'Pending' && q.from !== data.me.name).length : 0;
  const unreadN = (data.announcements || []).filter(a => !a.read).length;
  const item = (k, label, sub, extra) => rowBtn(`data-more="${k}"`, `<div class="txt"><b>${label}</b>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${extra || ''}<span>›</span>`);
  const pill = n => n ? `<span class="pill warn" style="margin-right:8px">${n}</span>` : '';
  return `<h1>More</h1><div class="card">
      ${item('news', 'Announcements', '', pill(unreadN))}
      ${item('time', mgr() ? 'Time sheets' : 'My time', mgr() ? 'Labor by day, week or pay period' : 'Your hours and estimated pay')}
      ${item('requests', 'Time off & swaps', '', pill(pendN))}
      ${item('avail', 'Availability', 'When you can\'t work')}
      ${rowBtn('data-tab="tests" class="mobonly"', '<div class="txt"><b>Tests</b><div class="sub">Training & certification</div></div><span>›</span>')}
      ${item('resources', 'Resources', 'Recipes, guides, handbooks')}
      ${mgr() ? item('team', 'Team & sign-in codes') : ''}</div>
    <div class="card">${item('settings', 'Settings', 'Notifications, reminders, look, sign out')}</div>
    <p class="sub" style="text-align:center">Peregrine Team · server ${esc(data.version || '')}</p>`;
}
/** Settings: everything about this person and this phone, in one place (phone: from More; desktop: in the sidebar). */
function viewSettings(){
  const item = (k, label, sub) => rowBtn(`data-more="${k}"`, `<div class="txt"><b>${label}</b>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span>›</span>`), R = data.reminders || {};
  const remindSub = data.me.reminders === 'Off' ? 'Off' : R.by === 'push' ? data.me.reminders + ' · by notification' : data.me.email ? data.me.reminders + ' · ' + esc(data.me.email) : 'Off – no email';
  return `${back()}<h1>Settings</h1><div class="card">
      ${data.push && data.push.ready ? item('push', 'Notifications', pushOn_() ? 'On for this ' + deviceKind() : 'Off on this ' + deviceKind()) : ''}
      ${item('reminders', 'Shift reminders', remindSub)}
      ${canSwitch() ? rowBtn('data-locs', `<div class="txt"><b>Location</b><div class="sub">${esc(locName(HERE))}</div></div><span>›</span>`) : ''}</div>
    <h2>Look</h2><div class="seg">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, n]) => `<button data-theme="${k}" aria-pressed="${theme() === k}">${n}</button>`).join('')}</div>
    <h2>${esc(data.me.name)} · ${esc(data.me.role)}</h2><div class="card"><div class="row"><div class="txt sub">Signed in on this ${deviceKind()}.${!standalone() && !wide() ? ' Tip: add this app to your home screen.' : ''}</div><button class="btn sm" data-signout>Sign out</button></div></div>
    <p class="sub" style="text-align:center">Peregrine Team · server ${esc(data.version || '')}</p>`;
}

// Phone: Schedule · Chat · [Today] · Lists · More (Today raised in the middle; Tests lives under More).
// Desktop sidebar: Today first, Tests shown (see .home / .deskonly in app.css).
const TABS = [['schedule', 'Schedule', '▦'], ['chat', 'Chat', '✉︎'], ['today', 'Today', '☀︎', 'home'], ['lists', 'Lists', '✓'], ['tests', 'Tests', '✎', 'deskonly'], ['more', 'More', '☰']];
let lastView = '';
/* ----- icon badge: unread messages as a number on the app icon (installed apps; iPhone needs notifications on) ----- */
let lastBadge = -1;
document.addEventListener('visibilitychange', () => { if (!document.hidden){ lastBadge = -1; syncBadge(); } });
function syncBadge(){
  const n = data && data.channels ? data.channels.reduce((a, c) => a + (Number(c.unread) || 0), 0) : 0;
  if (n === lastBadge) return; lastBadge = n;
  try { if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch (_) {}
  try { caches.open(NS + 'chat-pass').then(c => c.put('/badge', new Response(String(n)))).catch(() => {}); } catch (_) {}   // the notification handler counts up from here
}
/** Desktop sidebar: the More pages listed out, with Settings at the bottom (the phone keeps them under More). */
function deskMore(){
  if (!wide() || !data) return '';
  const pendN = mgr() ? (data.requests || []).filter(q => q.status === 'Pending' && q.from !== data.me.name).length : 0, unreadN = (data.announcements || []).filter(a => !a.read).length;
  const it = (k, n, ic, badge) => `<button data-more="${k}" class="deskonly" ${tab === 'more' && (moreView === k || (k === 'settings' && /^(push|reminders)$/.test(moreView))) ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${n}${badge ? `<span class="n">${badge}</span>` : ''}</button>`;
  return `<div class="tabsep deskonly" aria-hidden="true"></div>${it('news', 'Announcements', '⚑', unreadN)}${it('time', mgr() ? 'Time sheets' : 'My time', '⏱')}${it('requests', 'Time off & swaps', '⇄', pendN)}${it('avail', 'Availability', '◷')}${it('resources', 'Resources', '❏')}${mgr() ? it('team', 'Team', '☺') : ''}
    <div class="tabspacer deskonly" aria-hidden="true"></div>${it('settings', 'Settings', '⚙︎')}`;
}
function setShop(t){ const el = $('#shop'); if (canSwitch()) el.innerHTML = `<button class="locbtn" data-locs aria-label="Switch location">${esc(locName(HERE))} <span aria-hidden="true">▾</span></button>`; else el.textContent = t; }   // with the switcher, the bar names the location
function render(){
  syncBadge();
  if (rowDrag){ rowDrag.later = true; return; }       // don't redraw under a finger mid-drag
  $('#offline').hidden = !offline;
  if (joined && TOKEN){ $('#tabs').hidden = true; $('#refresh').hidden = true; $('#overlay').innerHTML = ''; $('#main').innerHTML = viewJoined(); return; }
  if (!TOKEN || !data){ $('#tabs').hidden = true; $('#refresh').hidden = true; $('#overlay').innerHTML = ''; setShop(load('pt-shop') || window.PT_NAME || 'Peregrine'); $('#main').innerHTML = TOKEN ? '<div class="empty">Loading…</div>' : viewSignIn(); return; }
  data.meId = data.me.id;
  const short = String(data.name || 'Peregrine').replace(/\s+(coffee|roasters?|roastery|co\.?)\b.*$/i, '') || data.name; setShop(short); save('pt-shop', short); $('#refresh').hidden = false;
  const gate = mustRead();
  if (gate.length){ $('#tabs').hidden = true; $('#overlay').innerHTML = ''; $('#main').innerHTML = viewMustRead(gate[0], gate.length); return; }
  const chatN = (data.channels || []).reduce((n, c) => n + c.unread, 0);
  const badge = { lists: prepMine().length, chat: chatN, more: (mgr() ? (data.requests || []).filter(q => q.status === 'Pending' && q.from !== data.me.name).length : 0) + (data.announcements || []).filter(a => !a.read).length };
  $('#tabs').hidden = false;
  $('#tabs').innerHTML = TABS.map(([k, n, ic, cls]) => `<button data-tab="${k}" class="${cls || ''}${k === 'more' ? ' mobonly' : ''}${k === 'more' && tab === 'tests' ? ' cur-m' : ''}" ${tab === k && !(k === 'more' && wide()) ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${n}${badge[k] ? `<span class="n">${badge[k]}</span>` : ''}</button>`).join('') + deskMore();
  const ae = document.activeElement, keepWage = ae && ae.dataset && (ae.dataset.wage || ae.dataset.invf) ? [ae.dataset.wage ? `[data-wage="${ae.dataset.wage}"]` : `[data-invf="${ae.dataset.invf}"][data-invk="${ae.dataset.invk}"]`, ae.value, ae.selectionStart] : null;
  const typingIn = document.activeElement && document.activeElement.closest && document.activeElement.closest('.composer');
  const draft = typingIn ? document.activeElement.value : null;
  document.body.classList.toggle('inchat', tab === 'chat' && !!chat.open);
  document.body.classList.toggle('wide', wide() && tab === 'schedule' && lead() && schedView !== 'mine');
  const vkey = tab + '|' + schedView + '|' + week + '|' + moreView, same = vkey === lastView, gw = $('.gridwrap'), keep = same && gw ? [gw.scrollTop, gw.scrollLeft] : null, wy = window.scrollY; lastView = vkey;
  const ms0 = $('#msgs'), keepMs = ms0 && tab === 'chat' && chat.open ? [chat.open, ms0.scrollTop, ms0.scrollHeight - ms0.scrollTop - ms0.clientHeight] : null;
  $('#main').innerHTML = tab === 'tests' ? viewTests() : tab === 'lists' ? viewLists() : tab === 'schedule' ? viewSchedule() : tab === 'chat' ? viewChat() : tab === 'more' ? viewMore() : viewToday();
  if (keepMs && chat.open === keepMs[0]){ const ms = $('#msgs'); if (ms) ms.scrollTop = keepMs[2] < 80 ? ms.scrollHeight : keepMs[1]; }
  if (same && tab !== 'chat'){ const g2 = $('.gridwrap'); if (keep && g2){ g2.scrollTop = keep[0]; g2.scrollLeft = keep[1]; } if (window.scrollY !== wy) window.scrollTo(0, wy); }   // a save or refresh redraws the page; stay where you were
  if (draft !== null){ const t = $('.composer textarea'); if (t){ t.value = draft; t.focus(); } }
  if (!sheet && !viewer && !runner && !joined && prepPopItems().length) sheet = { kind: 'preppop' };
  $('#overlay').innerHTML = runner ? viewRunner() : viewer ? viewViewer() : sheet ? (sheet.kind === 'shift' ? shiftSheet() : sheet.kind === 'publish' ? publishSheet() : sheet.kind === 'punch' ? punchSheet() : sheet.kind === 'editchat' ? editChatSheet() : sheet.kind === 'loc' ? locSheet() : sheet.kind === 'preppop' ? prepPopSheet() : pickSheet(sheet.kind)) : '';
  document.body.classList.toggle('noscroll', !!(viewer || sheet || runner));
  if (keepWage){ const el = document.querySelector(keepWage[0]); if (el){ el.value = keepWage[1]; el.focus(); try { el.setSelectionRange(keepWage[2], keepWage[2]); } catch (_) {} } }
  const sf = document.querySelector('form[data-form=shift]'), est = $('#est'); if (sf && est) est.innerHTML = shiftEstimate(sf);
}

/* ---------- events ---------- */
const theme = () => load('pt-theme') || 'auto';
function setTheme(t){ save('pt-theme', t === 'auto' ? null : t); if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name=theme-color]').forEach(m => { m.content = dark ? '#0E1111' : '#1E5662'; }); }
function scrollToday(){ const h = $('#todayh'); if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 70); }
function getPos(){
  if (!data.geo || !navigator.geolocation) return Promise.resolve({});
  return new Promise(res => navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({}), { timeout: 7000, maximumAge: 60000, enableHighAccuracy: true }));
}
document.addEventListener('click', async e => {
  const b = e.target.closest('button, a[data-x]');
  if (!b){ const td = e.target.closest && e.target.closest('td[data-cell]'); if (td && lead()){ const [who, date] = td.dataset.cell.split('|'); sheet = { kind: 'shift', date, name: who, start: (data.presets[0] || {}).start, end: (data.presets[0] || {}).end }; render(); } return; }
  const d = b.dataset;
  if (d.prepok !== undefined){ prepSeenAll(); sheet = null; if (d.golist === undefined){ render(); return; } }   // prep pop-up: Got it / Open the prep list
  if (b.id === 'refresh'){ if (chat.open) { openChat(chat.open); return; } refresh(undefined, { fresh: true }).then(r => { if (r) toast('Up to date'); }); return; }   // the refresh button always asks the Sheet itself
  if (d.install !== undefined && installEvt){ installEvt.prompt(); installEvt = null; return; }
  if (d.ack){ const a = data.announcements.find(x => x.id === d.ack); if (a) a.read = true; render(); act('read', { id: d.ack }); return; }
  if (d.tab){ tab = d.tab; save('pt-tab', tab); sheet = null; viewer = null; editUser = null; tsPerson = ''; if (tab === 'more') moreView = ''; stopChat(); window.scrollTo(0, 0); /* a tab always opens on its main screen: backs out of a DM, a More page, etc. */ render(); if (tab === 'schedule') scrollToday(); return; }
  if (d.golist){ listTab = d.golist; tab = 'lists'; save('pt-tab', tab); window.scrollTo(0, 0); render(); return; }
  if (d.more !== undefined){ tab = 'more'; moreView = d.more; editUser = null; if (d.more !== 'time') tsPerson = ''; if (d.more === 'time' && b.textContent.includes('Back')) tsPerson = ''; window.scrollTo(0, 0); render(); return; }
  if (d.list){ listTab = d.list; if (d.list === INV) loadInv(); render(); return; }
  if (d.invtab){ invTab = d.invtab; save('pt-invtab', invTab); render(); return; }
  if (d.invstep){ const x = inv && inv.items.find(i => i.tab + '|' + i.row === d.invk); if (!x) return; const v = Math.max(0, (Number(x.onHand) || 0) + Number(d.invstep)); queueCount(x, 'onHand', String(v)); render(); return; }
  if (d.prepdone){ const x = (data.prep || []).find(p => p.id === d.prepdone), on = d.on !== '1'; if (x){ x.doneAt = on ? new Date().toISOString() : ''; x.doneBy = on ? data.me.name : ''; } render(); act('donePrep', { id: d.prepdone, done: on ? '1' : '0' }); return; }
  if (d.prepdel){ if (!confirm('Remove this prep item?')) return; data.prep = (data.prep || []).filter(p => p.id !== d.prepdel); render(); act('delPrep', { id: d.prepdel }); return; }
  if (d.theme){ setTheme(d.theme); render(); return; }
  if (d.sview){ schedView = d.sview; save('pt-sview', schedView); render(); if (schedView === 'build') scrollToday(); return; }
  if (d.mine !== undefined){ schedMine = d.mine === '1'; save('pt-mine', schedMine ? '1' : '0'); render(); return; }
  if (d.week){ week = plus(week, Number(d.week)); render(); window.scrollTo(0, 0); scrollToday(); return; }
  if (d.tsmode){ tsMode = d.tsmode; save('pt-tsmode', tsMode); render(); return; }
  if (d.tsstep){ const [f, t] = rangeOf(tsMode, tsDate || T()); tsDate = tsMode === 'day' ? plus(f, Number(d.tsstep)) : Number(d.tsstep) < 0 ? (tsMode === 'period' ? plus(f, -1) : plus(f, -7)) : plus(t, 1); render(); return; }
  if (d.tsjump !== undefined){ tsDate = T(); render(); return; }
  if (d.tsday){ tab = 'more'; save('pt-tab', tab); moreView = 'time'; tsMode = 'day'; tsDate = d.tsday; tsPerson = ''; window.scrollTo(0, 0); render(); return; }
  if (d.tsperson){ tsPerson = d.tsperson; window.scrollTo(0, 0); render(); return; }
  if (d.signout !== undefined){ if (confirm('Sign out on this phone?')) signOut(); return; }
  if (d.showcode){ showCode[d.showcode] = !showCode[d.showcode]; render(); return; }
  if (d.edit){ editUser = d.edit; render(); return; }
  if (d.canceledit !== undefined){ editUser = null; render(); return; }
  if (d.readall !== undefined){ (data.channels || []).forEach(c => { if (c.unread){ c.unread = 0; try { LIVE && LIVE.send({ t: 'read', ch: c.id }); } catch (_) {} } }); lastBadge = -1; render(); toast('All caught up'); return; }
  if (d.locs !== undefined){ sheet = { kind: 'loc' }; render(); return; }
  if (d.loc){ if (d.loc === HERE){ sheet = null; render(); return; } switchTo(d.loc); return; }
  if (d.joindone !== undefined){ joined = null; render(); return; }
  if (d.dismiss !== undefined){ justAdded = null; inviteFor = ''; render(); return; }
  if (d.invite){ inviteFor = d.invite; justAdded = null; render(); const el = $('#invite'); if (el) el.scrollIntoView({ block: 'start' }); return; }
  if (d.shareinvite || d.copyinvite){ const u = (data.users || []).find(x => x.id === (d.shareinvite || d.copyinvite)); if (!u) return;
    if (d.shareinvite){ navigator.share({ title: 'Peregrine team app', text: inviteText(u).replace(inviteLink(u), '').replace(/\n\n\n/, '\n\n'), url: inviteLink(u) }).catch(() => {}); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(inviteText(u)) : Promise.reject()).then(() => toast('Invite copied – paste it in a text'), () => { const i = $('#invite .linkbox'); if (i){ i.select(); document.execCommand('copy'); toast('Link copied'); } }); return; }
  if (d.closesheet !== undefined){ sheet = null; render(); return; }
  if (d.taketest){ startTest(d.taketest); return; }
  if (d.closetest !== undefined){ if (runner && !runner.done && Object.keys(runner.a || {}).length && !confirm('Leave the test? Your answers stay saved on this phone.')) return; runner = null; render(); if (tab === 'tests') loadTests(); return; }
  if (d.pick !== undefined && runner){ runner.a[runner.i] = runner.t.q[runner.i].o[Number(d.pick)]; save('pt-test-' + runner.level, JSON.stringify(runner.a)); render(); return; }
  if (d.tq && runner){ runner.i = Math.max(0, Math.min(runner.t.q.length - 1, runner.i + Number(d.tq))); render(); const o = document.querySelector('.runner'); if (o) o.scrollTop = 0; return; }
  if (d.submittest !== undefined && runner && !runner.sending){ submitTest(); return; }
  if (d.closeviewer !== undefined){ viewer = null; render(); return; }
  if (d.pdf){ openPdf(d.pdf); return; }
  if (d.openchat){ openChat(d.openchat); return; }
  if (d.closechat !== undefined){ stopChat(); render(); return; }
  if (d.newdm !== undefined){ sheet = { kind: 'dm' }; render(); return; }
  if (d.newgroup !== undefined){ sheet = { kind: 'group' }; render(); return; }
  if (d.reply){ startReply(d.reply); return; }
  if (d.unreply !== undefined){ chat.reply = null; render(); return; }
  if (d.ack){ if (chat.open) toggleAck(d.ack); return; }
  if (d.acks){ const m = (chat.msgs || []).find(x => x.id === d.acks); if (m) toast('Read by ' + (m.acks || []).map(n => n === data.me.name ? 'you' : first(n)).join(', ')); return; }
  if (d.seenall !== undefined){ const c = curChat(), last = (chat.msgs || []).filter(m => m.fromId === chat.me).pop(); toast('Seen by ' + (chat.seen || []).filter(x => last && new Date(x.at) >= new Date(last.at)).map(x => first(x.name)).join(', ')); return; }
  if (d.jump){ jumpTo(d.jump); return; }
  if (d.openfind){ const [c, id] = d.openfind.split('|'); chat.msgs = []; openChat(c, null, undefined, undefined, { find: id }); return; }
  if (d.clearsearch !== undefined){ chat.q = ''; chat.results = null; render(); const el = $('[data-csearch]'); if (el) el.focus(); return; }
  if (d.ment){ const t = $('.composer textarea'); if (t){ const pos = t.selectionStart, before = t.value.slice(0, pos).replace(/@[\w]*$/, '@' + d.ment + ' '); t.value = before + t.value.slice(pos); t.focus(); t.setSelectionRange(before.length, before.length); } $('#ment').hidden = true; return; }
  if (d.editchat !== undefined){ sheet = { kind: 'editchat' }; render(); return; }
  if (d.newchannel !== undefined){ sheet = { kind: 'channel' }; render(); return; }
  if (d.dm){ sheet = null; const id = 'dm-' + [data.meId, d.dm].sort().join('-'); chat.msgs = []; openChat(id, d.dmname); return; }
  if (d.preset){ const [s, en] = d.preset.split('|'), f = b.closest('form'); f.elements.namedItem('start').value = s; f.elements.namedItem('end').value = en; const e2 = $('#est'); if (e2) e2.innerHTML = shiftEstimate(f); return; }
  if (!data) return;
  if (d.clock){
    b.disabled = true; b.textContent = d.clock === 'in' ? 'Clocking in…' : 'Clocking out…';
    const pos = await getPos();
    act(d.clock === 'in' ? 'clockIn' : 'clockOut', pos).then(r => { if (r) toast(d.clock === 'in' ? 'Clocked in · ' + timeOf(new Date().toISOString()) : 'Clocked out · have a good one'); }); return;
  }
  if (d.check){
    const on = d.on !== '1', k = 'c|' + listTab + '|' + d.check; busy[k] = on; render();
    if (on && navigator.vibrate) navigator.vibrate(10);
    act('check', { list: listTab, task: d.check, done: on ? '1' : '0' }); return;
  }
  if (d.read){ const a = data.announcements.find(x => x.id === d.read); if (a) a.read = true; render(); act('read', { id: d.read }); return; }
  if (d.unann){ if (!confirm('Remove this announcement for everyone?')) return; data.announcements = data.announcements.filter(x => x.id !== d.unann); render(); act('unannounce', { id: d.unann }); return; }
  if (d.decide){ const note = d.ok === '1' ? '' : (prompt('Reason (optional) – they will see it') || ''); act('decide', { id: d.decide, approve: d.ok, note }).then(r => { if (r) toast(d.ok === '1' ? 'Approved' : 'Denied'); }); return; }
  if (d.cancelreq){ act('cancelRequest', { id: d.cancelreq }); return; }
  if (d.addshift){ sheet = { kind: 'shift', date: d.addshift, name: d.who || '', start: (data.presets[0] || {}).start, end: (data.presets[0] || {}).end }; render(); return; }
  if (d.editshift){ const s = data.shifts.find(x => x.id === d.editshift); if (s) { sheet = Object.assign({ kind: 'shift' }, s); render(); } return; }
  if (d.delshift){ if (!confirm('Delete this shift?')) return; const x = data.shifts.find(s => s.id === d.delshift);
    if (x && x.status && x.status !== 'draft') x.status = 'removed'; else data.shifts = data.shifts.filter(s => s.id !== d.delshift);
    sheet = null; render(); act('deleteShift', { id: d.delshift }); return; }
  if (d.restore){ const x = data.shifts.find(s => s.id === d.restore); if (x) x.status = 'changed'; sheet = null; render(); act('restoreShift', { id: d.restore }); return; }
  if (d.onsched){ const u = (data.users || []).find(x => x.id === d.onsched); if (u) u.onSchedule = d.to === '1'; render(); act('setOnSchedule', { id: d.onsched, on: d.to }).then(r => { if (r && u) toast(first(u.name) + (d.to === '1' ? ' is back on the schedule' : ' is hidden from the schedule')); }); return; }
  if (d.publish !== undefined){ sheet = { kind: 'publish' }; render(); return; }
  if (d.sendweek !== undefined){ if (!confirm('Email everyone working the week of ' + shortDay(week) + ' their shifts?')) return; b.disabled = true;
    act('sendWeek', { from: week }).then(r => { if (r && r.result) toast('Sent to ' + r.result.sent + (r.result.noEmail.length ? ' · no email for ' + r.result.noEmail.map(first).join(', ') : '')); }); return; }
  if (d.testmail !== undefined){ b.disabled = true; act('testReminder').then(r => { if (r) toast('Sent – check your inbox (and spam)'); }); return; }
  if (d.copycal){ (navigator.clipboard ? navigator.clipboard.writeText(d.copycal) : Promise.reject()).then(() => toast('Link copied'), () => prompt('Copy this link', d.copycal)); return; }
  if (d.nohint !== undefined){ save('pt-nohint', '1'); render(); return; }
  if (d.thisweek !== undefined){ week = monday(T()); render(); return; }
  if (d.print !== undefined){ window.print(); return; }
  if (d.copyweek !== undefined){ if (!confirm('Copy last week\'s shifts into this week? Shifts already here stay; exact duplicates are skipped.')) return; act('copyWeek', { from: plus(week, -7), to: week }).then(r => { if (r) toast('Copied'); }); return; }
  if (d.clearweek !== undefined){ if (!confirm('Delete every shift this week?')) return; act('clearWeek', { from: week }).then(r => { if (r) toast('Week cleared'); }); return; }
  if (d.delavail){ data.availability = data.availability.filter(a => a.id !== d.delavail); render(); act('delAvail', { id: d.delavail }); return; }
  if (d.editpunch !== undefined){ sheet = { kind: 'punch', id: d.editpunch, date: d.pdate, name: d.pname || tsPerson, start: d.pstart, end: d.pend }; render(); return; }
  if (d.delpunch){ if (!confirm('Delete this punch?')) return; sheet = null; act('deletePunch', { id: d.delpunch }); return; }
  if (d.pushon !== undefined){ pushTurnOn(); return; }
  if (d.pushoff !== undefined){ pushTurnOff(); return; }
  if (d.nopush !== undefined){ save('pt-nopush', '1'); render(); return; }
  if (d.pushtest !== undefined){ const r = await act('pushTest'); const x = r && r.result; if (x) toast(x.sent ? 'Sent – it should arrive in a few seconds' : x.off ? 'Push isn\'t set up in the sheet yet' : 'Nothing was sent – try turning notifications off and on'); return; }
  if (d.pushpref){ const P = data.push.prefs = data.push.prefs || {}; const v = d.v; if (d.pushpref === 'msg') P.msg = v; else P[d.pushpref] = v === '1'; render(); act('pushPrefs', { [d.pushpref]: v }); return; }
  if (d.pic){ const m = (chat.msgs || []).find(x => x.id === d.pic), src = (m && m.local) || picCache[d.pic]; if (src) zoomPic(src); else loadPic(d.pic); return; }
  if (d.unphoto !== undefined){ const t = $('.composer textarea'); if (t) chat.compose = t.value; chat.photo = ''; render(); return; }
  if (d.delmsg){ if (!confirm('Delete this message?')) return; chat.msgs = chat.msgs.filter(m => m.id !== d.delmsg); render(); if (LIVE){ LIVE.ask({ t: 'del', id: d.delmsg }).catch(e => { toast(e.message); openChat(chat.open); }); return; } await act('deleteMessage', { id: d.delmsg }); openChat(chat.open); return; }
  if (d.newcode){ if (!confirm('Give ' + d.name + ' a new code? Their old code stops working and they are signed out everywhere.')) return; showCode[d.newcode] = true; act('newCode', { id: d.newcode }).then(r => { if (r) toast('New code made – tell ' + first(d.name)); }); return; }
  if (d.active){ if (d.to === '0' && !confirm('Turn off ' + d.name + '? They are signed out right away and cannot sign in.')) return; act('setActive', { id: d.active, active: d.to }); return; }
});
let wageTimer = {};
document.addEventListener('input', e => {
  const t = e.target; if (!t.dataset) return;
  if (t.dataset.wans !== undefined && runner){ runner.a[runner.i] = t.value; save('pt-test-' + runner.level, JSON.stringify(runner.a)); return; }
  if (t.dataset.invsearch !== undefined){ invQ = t.value; const pos = t.selectionStart; render(); const el = document.querySelector('[data-invsearch]'); if (el){ el.focus(); try { el.setSelectionRange(pos, pos); } catch (_) {} } return; }
  if (t.dataset.invf){ const x = inv && inv.items.find(i => i.tab + '|' + i.row === t.dataset.invk); const v = t.value.trim();
    if (x && (v === '' || (!isNaN(+v) && +v >= 0))) queueCount(x, t.dataset.invf, v); }
});
document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.invf && tab === 'lists') render(); });
window.addEventListener('pagehide', () => { if (Object.keys(invQueue).length) flushCounts(); });
document.addEventListener('input', e => {
  const f = e.target.closest && e.target.closest('form[data-form=shift]'); if (f){ const el = $('#est'); if (el) el.innerHTML = shiftEstimate(f); }
  const w = e.target.dataset && e.target.dataset.wage;
  if (w){ const u = (data.users || []).find(x => x.id === w), val = e.target.value.replace(/[$,\s]/g, '');
    if (u && (val === '' || (!isNaN(+val) && +val >= 0 && +val < 1000))){ u.wage = val === '' ? 0 : +val; render();
      clearTimeout(wageTimer[w]); wageTimer[w] = setTimeout(() => act('setWage', { id: w, wage: val }), 900); } }
});
document.addEventListener('change', e => { if (e.target.name === 'day' && e.target.closest('form[data-form=avail]')){ const f = e.target.closest('form'); f.querySelector('[data-onlydate]').hidden = e.target.value !== 'date'; } });
let tch = null, noTap = 0;
document.addEventListener('touchstart', e => { const b = e.target.closest && e.target.closest('[data-bub]'); if (!b || !v3() || b.dataset.bub === 'tmp' || e.touches.length > 1) { tch = null; return; }
  const t = e.touches[0]; tch = { b, row: b.closest('.mrow'), x: t.clientX, y: t.clientY, dx: 0, h: false };
  if (b.dataset.mine !== '1') tch.lp = setTimeout(() => { if (tch && !tch.h){ noTap = Date.now(); const id = b.dataset.bub; tch = null; toggleAck(id); } }, 450); }, { passive: true });
document.addEventListener('touchmove', e => { if (!tch) return; const t = e.touches[0], dx = t.clientX - tch.x, dy = t.clientY - tch.y;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(tch.lp);
  if (!tch.h && Math.abs(dy) > Math.abs(dx)) { if (Math.abs(dy) > 8) tch = null; return; }
  if (dx > 6) { tch.h = true; tch.dx = Math.min(dx, 80); tch.row.style.transform = `translateX(${tch.dx}px)`; tch.row.classList.toggle('armed', tch.dx > 55); } }, { passive: true });
document.addEventListener('touchend', () => { if (!tch) return; clearTimeout(tch.lp); const { row, dx, b } = tch; tch = null;
  if (row){ row.style.transition = 'transform .18s'; row.style.transform = ''; row.classList.remove('armed'); setTimeout(() => { row.style.transition = ''; }, 200); }
  if (dx > 55){ noTap = Date.now(); if (navigator.vibrate) try { navigator.vibrate(10); } catch (_) {} startReply(b.dataset.bub); } }, { passive: true });
document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('[data-bub]') && v3()) e.preventDefault(); });
document.addEventListener('dblclick', e => { const b = e.target.closest && e.target.closest('[data-bub]'); if (b && v3() && b.dataset.mine !== '1' && b.dataset.bub !== 'tmp' && !('ontouchstart' in window)) { e.preventDefault(); toggleAck(b.dataset.bub); } });
document.addEventListener('input', e => { const t = e.target;
  if (t.dataset && t.dataset.csearch !== undefined){ chat.q = t.value; runSearch(); keepSearch(render); return; }
  if (t.tagName === 'TEXTAREA' && t.closest && t.closest('.composer')){ const box = $('#ment'); if (!box) return;
    const m = t.value.slice(0, t.selectionStart).match(/(?:^|\s)@([\w]*)$/), ppl = m ? audience(curChat()).filter(p => !m[1] || p.name.toLowerCase().split(' ').some(w => w.indexOf(m[1].toLowerCase()) === 0)).slice(0, 6) : [];
    box.hidden = !ppl.length; box.innerHTML = ppl.map(p => `<button type="button" data-ment="${esc(mentionLabel(p))}">${avatar({ id: p.id, name: p.name }, 24)}${esc(p.name)}</button>`).join(''); } });
document.addEventListener('pointerdown', e => { if (e.target.closest && e.target.closest('#ment')) e.preventDefault(); });
document.addEventListener('click', e => { if (Date.now() - noTap < 500 && e.target.closest && e.target.closest('[data-bub]')) return; const b = e.target.closest && e.target.closest('[data-bub]'); if (!b || e.target.closest('button')) return; chat.meta = chat.meta === b.dataset.bub ? '' : b.dataset.bub; const near = isNearBottom(); render(); if (near) scrollChat(); });
document.addEventListener('input', e => { const t = e.target; if (t.closest && t.closest('.composer') && t.tagName === 'TEXTAREA'){ t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; } });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && e.target.closest && e.target.closest('.composer') && !isIOS()){ e.preventDefault(); e.target.closest('form').requestSubmit(); } });

document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
  const v = n => { const el = f.elements.namedItem(n); return el ? (el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value.trim()) : ''; };
  const kind = f.dataset.form, btn = f.querySelector('button.go');
  if (kind === 'join'){
    if (!/\d{3}\D*\d{4}\s*$/.test(v('phone')) || v('phone').replace(/\D/g, '').length < 10){ toast('Type your whole phone number, area code first'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))){ toast('Type your email address'); return; }
    btn.disabled = true; btn.textContent = 'Setting up…';
    try { const r = await post({ fn: 'join', invite: invite.key, phone: v('phone'), email: v('email') });
      TOKEN = r.token; save('pt-token', TOKEN); save('pt-last', first(r.name)); history.replaceState(null, '', location.pathname + location.search);
      joined = { first: first(r.name), code: r.code }; invite = null; data = null; tab = 'today'; render(); refresh(); }
    catch (err) { btn.disabled = false; btn.textContent = 'Create my account'; toast(String(err.message || err) === 'timeout' ? 'The server took too long – try again' : String(err.message || err)); }
    return;
  }
  if (kind === 'signin'){
    const name = v('name'), code = v('code');
    if (!name || !/^\d{4}$/.test(code)){ toast('Type your first name and your 4-digit code'); return; }
    btn.disabled = true; btn.textContent = 'Signing in…';
    try { const r = await post({ fn: 'signIn', name, code }); TOKEN = r.token; save('pt-token', TOKEN); save('pt-last', name); if (/^#join=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); invite = null; data = null; tab = 'today'; render(); refresh(); }
    catch (err) { btn.disabled = false; btn.textContent = 'Sign in'; toast(String(err.message || err) === 'timeout' ? 'The server took too long – try again' : String(err.message || err)); }
    return;
  }
  if (kind === 'send'){ const text = f.elements.namedItem('text').value.trim(), photo = chat.photo || ''; if (!text && !photo) return;
    const reply = chat.reply; chat.reply = null; $('#ment') && ($('#ment').hidden = true);
    chat.compose = ''; chat.photo = ''; chat.msgs = (chat.msgs || []).concat({ id: 'tmp', fromId: chat.me || data.meId, from: data.me.name, at: new Date().toISOString(), text, photo: photo ? 1 : 0, local: photo, reply: reply ? { id: reply.id, from: reply.from, text: reply.text } : null }); render(); scrollChat();
    const t = $('.composer textarea'); if (t){ t.value = ''; t.focus(); t.style.height = ''; } openChat(chat.open, null, text, photo || undefined, reply ? { replyTo: reply.id, reply } : undefined); return; }
  if (kind === 'shift'){ if (!v('name')){ toast('Pick who is working'); return; } const p = { id: sheet && sheet.id || '', name: v('name'), date: v('date'), start: v('start'), end: v('end'), position: v('position'), notes: v('notes') };
    if (p.end <= p.start){ toast('The end has to be after the start'); return; }
    const ex = p.id && (data.shifts || []).find(x => x.id === p.id);
    if (ex) Object.assign(ex, p, { status: ex.status === 'draft' ? 'draft' : 'changed' }); else { p.cid = 'tmp' + Date.now() + Math.random().toString(36).slice(2, 5); data.shifts.push(Object.assign({}, p, { id: p.cid, status: 'draft' })); }
    data.shifts.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    sheet = null; render(); act('saveShift', p).then(r => { if (r) toast(p.id ? 'Shift saved' : 'Shift added'); }); return; }
  if (kind === 'publish'){ const notify = f.elements.namedItem('notify').checked ? '1' : '0'; sheet = null; render();
    act('publish', { from: week, to: plus(week, 6), notify }).then(r => { if (r && r.result) toast('Published' + (notify === '1' ? ' · emailed ' + r.result.emailed + (r.result.noEmail.length ? ' · no email: ' + r.result.noEmail.map(first).join(', ') : '') : '')); }); return; }
  if (kind === 'prep'){ if (!v('item')){ toast('What needs prepping?'); return; } const notify = f.elements.namedItem('notify').checked ? '1' : '0';
    (data.prep = data.prep || []).unshift({ id: 'tmp' + Date.now(), item: v('item'), details: v('details'), label: 'Sending…', for: [], by: data.me.name, at: new Date().toISOString(), doneAt: '', mine: false }); render();
    act('addPrep', { item: v('item'), details: v('details'), when: v('when'), notify }).then(r => { if (r && r.result){ const x = r.result;
      toast(x.names.length ? 'Sent to ' + x.label + ' · ' + x.names.map(first).join(', ') + '' : 'Added – nobody is scheduled for that shift yet'); } }); f.reset(); return; }
  if (kind === 'punch'){ const p = { id: sheet && sheet.id || '', name: v('name'), date: v('date'), in: v('in'), out: v('out'), note: v('note') }; if (f.elements.namedItem('type')) p.type = v('type'); sheet = null; act('savePunch', p).then(r => { if (r) toast('Saved'); }); return; }
  if (kind === 'reminders'){ const mode = (f.querySelector('input[name=mode]:checked') || {}).value || '';
    const em = f.elements.namedItem('email') ? v('email') : (data.me.email || ''), push = data.reminders && data.reminders.by === 'push';
    act('myReminders', { email: em, mode }).then(r => { if (r) toast(mode === 'Off' ? 'Reminders off' : push ? (pushOn_() ? 'Saved' : 'Saved – turn on notifications to get them') : em ? 'Saved' : 'Saved – add an email to get them'); }); return; }
  if (kind === 'avail'){ const day = v('day') === 'date' ? v('date') : v('day'); if (!day){ toast('Pick a date'); return; }
    (data.availability = data.availability || []).push({ id: 'tmp' + Date.now(), name: data.me.name, day, from: v('from'), to: v('to'), note: v('note') }); render(); act('addAvail', { day, from: v('from'), to: v('to'), note: v('note') }).then(r => { if (r) toast('Added'); }); f.reset(); return; }
  if (kind === 'editchat'){ const c = curChat(); if (!c) { sheet = null; render(); return; } if (!v('name')){ toast('Give it a name'); return; }
    const p = { id: c.id, name: v('name') };
    if (c.kind === 'group'){ const m = [...f.querySelectorAll('input[name=m]:checked')].map(x => x.value); if (!m.length){ toast('Pick at least one other person'); return; } p.members = m.concat(data.meId).join(','); }
    else p.who = v('who');
    c.name = p.name; if (p.who) c.who = p.who; sheet = null; render();
    if (LIVE){ LIVE.ask(Object.assign({ t: 'editch' }, p)).then(() => toast('Saved'), e => { toast(e.message); LIVE.send({ t: 'list' }); }); return; }
    act('editChannel', p).then(r => { if (r) { toast('Saved'); if (chat.open === c.id) openChat(c.id); } }); return; }
  if (kind === 'group'){ const members = [...f.querySelectorAll('input[name=m]:checked')].map(x => x.value).join(','); sheet = null; if (LIVE){ render(); liveMake({ kind: 'group', name: v('name'), members }, 'Group made'); return; } act('newChannel', { kind: 'group', name: v('name'), members }).then(r => { if (r) toast('Group made'); }); return; }
  if (kind === 'channel'){ sheet = null; if (LIVE){ render(); liveMake({ kind: 'channel', name: v('name'), who: v('who') }, 'Channel made'); return; } act('newChannel', { kind: 'channel', name: v('name'), who: v('who') }).then(r => { if (r) toast('Channel made'); }); return; }
  if (kind === 'announce'){ if (!v('title')){ toast('Add a title'); return; } act('announce', { title: v('title'), message: f.elements.namedItem('message').value, pinned: v('pinned'), mustAck: v('mustAck') }).then(r => { if (r) toast('Posted'); }); f.reset(); return; }
  if (kind === 'request'){ (data.requests = data.requests || []).unshift({ id: 'tmp' + Date.now(), from: data.me.name, type: v('type'), date: v('date'), details: v('details'), status: 'Pending', created: new Date().toISOString() }); render(); act('request', { type: v('type'), date: v('date'), details: v('details') }).then(r => { if (r) toast('Sent to managers'); }); f.reset(); return; }
  if (kind === 'user'){
    if (!v('name')){ toast('Add a name'); return; }
    const p = { name: v('name'), role: v('role'), phone: v('phone'), email: v('email'), wage: v('wage') };
    if (f.dataset.id){ editUser = null; act('editUser', Object.assign({ id: f.dataset.id }, p)).then(r => { if (r) toast('Saved'); }); }
    else { act('addUser', p).then(r => { if (r){ justAdded = p.name; render(); window.scrollTo(0, 0); } }); f.reset(); }
  }
});


/* drag ⠿ to reorder people (works with mouse and touch) */
let rowDrag = null;
document.addEventListener('pointerdown', e => {
  const h = e.target.closest && e.target.closest('[data-rowdrag]'); if (!h || !mgr()) return;
  const row = h.closest('[data-rid]'), box = row && row.closest('[data-reorder]'); if (!box) return;
  e.preventDefault(); try { h.setPointerCapture(e.pointerId); } catch (_) {}
  rowDrag = { row, box, before: [...box.querySelectorAll(':scope > [data-rid]')].map(x => x.dataset.rid).join(',') }; row.classList.add('lifting');
});
document.addEventListener('pointermove', e => {
  if (!rowDrag) return; e.preventDefault();
  const { row, box } = rowDrag, y = e.clientY, sibs = [...box.querySelectorAll(':scope > [data-rid]')].filter(x => x !== row);
  const next = sibs.find(x => { const b = x.getBoundingClientRect(); return y < b.top + b.height / 2; });
  if (next) { if (row.nextElementSibling !== next) box.insertBefore(row, next); } else { const last = sibs[sibs.length - 1]; if (last && last.nextElementSibling !== row) last.after(row); }
});
const endRowDrag = () => {
  if (!rowDrag) return;
  const { row, box, before, later } = rowDrag; row.classList.remove('lifting');
  const ids = [...box.querySelectorAll(':scope > [data-rid]')].map(x => x.dataset.rid); rowDrag = null;
  if (ids.join(',') !== before) {
    // Keep people not shown here (e.g. hidden ones off the grid) after the ones that were dragged.
    const all = lineup().map(u => u.id), full = ids.concat(all.filter(id => ids.indexOf(id) < 0));
    full.forEach((id, k) => { const u = (data.users || []).find(x => x.id === id); if (u) u.order = k + 1; });
    render(); act('scheduleOrder', { ids: full.join(',') });
  } else if (later) render();
};
document.addEventListener('pointerup', endRowDrag); document.addEventListener('pointercancel', endRowDrag);

let dragId = '';
document.addEventListener('dragstart', e => { const c = e.target.closest && e.target.closest('[data-drag]'); if (!c) return; dragId = c.dataset.drag; e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', dragId); c.classList.add('dragging'); });
document.addEventListener('dragend', e => { dragId = ''; document.querySelectorAll('.dragging,.drop').forEach(x => x.classList.remove('dragging', 'drop')); });
document.addEventListener('dragover', e => { const td = dragId && e.target.closest && e.target.closest('[data-cell]'); if (!td) return; e.preventDefault(); e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
  document.querySelectorAll('.drop').forEach(x => x !== td && x.classList.remove('drop')); td.classList.add('drop'); });
document.addEventListener('drop', e => {
  const td = dragId && e.target.closest && e.target.closest('[data-cell]'); if (!td) return; e.preventDefault();
  const s = (data.shifts || []).find(x => x.id === dragId); dragId = ''; if (!s) return;
  const [name, date] = td.dataset.cell.split('|'), copy = e.altKey;
  if (!copy && name === s.name && date === s.date) return render();
  const p = { id: copy ? '' : s.id, name, date, start: s.start, end: s.end, position: s.position, notes: s.notes };
  if (copy){ p.cid = 'tmp' + Date.now() + Math.random().toString(36).slice(2, 5); data.shifts.push(Object.assign({}, s, { id: p.cid, name, date, status: 'draft' })); } else Object.assign(s, { name, date, status: s.status === 'draft' ? 'draft' : 'changed', was: s.was || (s.status === 'published' || !s.status ? { date: s.date, start: s.start, end: s.end, name: s.name } : s.was) });
  render(); act('saveShift', p).then(r => { if (r) toast(copy ? 'Copied to ' + first(name) + ', ' + shortDay(date) : 'Moved to ' + first(name) + ', ' + shortDay(date)); });
});
WIDE.addEventListener && WIDE.addEventListener('change', () => { if (data) render(); });
const typing = () => { const a = document.activeElement; return (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) || !!runner; };
document.addEventListener('visibilitychange', () => { if (LIVE && chat.open && tab === 'chat' && document.hidden) LIVE.send({ t: 'close' }); if (document.hidden || !TOKEN) return; unstick(); if (chat.open && tab === 'chat') openChat(chat.open); else if (!pending && !typing() && !sheet) refresh(); });
setInterval(() => { if (!document.hidden && TOKEN && !pending && !typing() && !sheet && !viewer && !chat.open) refresh(); }, 90000);
window.addEventListener('online', () => { unstick(); if (TOKEN) refresh(); });
window.addEventListener('pageshow', e => { if (e.persisted && TOKEN){ unstick(); refresh(); } });   // reopened from the phone's app switcher
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (!TOKEN) render(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register(window.PT_SW || 'sw.js').catch(() => {});

if (theme() !== 'auto') setTheme(theme());
let pendingGo = new URLSearchParams(location.search).get('go') || '';
if (pendingGo) history.replaceState(null, '', location.pathname);
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.go !== undefined) goTo(e.data.go); });
if (invite && TOKEN){ invite = null; history.replaceState(null, '', location.pathname + location.search); setTimeout(() => toast('That invite link is for someone new – sign out first to use it on this phone'), 600); }
else if (invite) loadInvite();
render();
if (TOKEN) refresh();
