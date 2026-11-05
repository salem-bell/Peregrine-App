/* Peregrine Team – phone app. Talks to the Apps Script server in config.js; all data lives in the Google Sheet. */
'use strict';
const API = window.PEREGRINE_API || '';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const save = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} };
const WIDE = window.matchMedia('(min-width: 1000px)'); const wide = () => WIDE.matches;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let TOKEN = load('pt-token') || '', data = null, offline = false, tab = load('pt-tab') || 'today';
let listTab = '', schedMine = load('pt-mine') === '1', moreView = '', busy = {}, installEvt = null, showCode = {}, editUser = null, justAdded = null;
let week = '', sheet = null, chat = { open: '', msgs: [], timer: null, sending: false, compose: '' }, tsWeek = '', tsPerson = '', viewer = null;
try { const c = load('pt-cache'); if (c && TOKEN) data = JSON.parse(c); } catch (_) {}

/* ---------- server ---------- */
async function post(body){
  if (!API) throw new Error('This app isn\'t connected to its server yet (config.js).');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(API, { method: 'POST', body: JSON.stringify(body), signal: ctl.signal, redirect: 'follow' });   // text/plain: no CORS preflight
    const out = await res.json();
    if (out && out.error) throw new Error(out.error);
    return out;
  } catch (e) { if (e.name === 'AbortError') throw new Error('timeout'); throw e; }
  finally { clearTimeout(t); }
}
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
  const res = got.results || [];
  actions.forEach((a, i) => { if (a.cid && res[i] && res[i].id) idMap[a.cid] = res[i].id; });
  const bad = res.find(x => x && x.error); if (bad) toast(bad.error);
  if (typeof got.ms === 'number') console.info('[Peregrine] saved ' + batch.length + ' change' + (batch.length === 1 ? '' : 's') + ' – server ' + (got.ms / 1000).toFixed(1) + 's');
  if (!queue.length){   // nothing newer waiting: show the server's copy (a newer edit would otherwise be wiped from the screen)
    seqShown = ++seqStarted; busy = {}; offline = false;
    const keep = data; data = got.partial ? Object.assign({}, keep, got) : got; delete data.results; delete data.partial;
    save('pt-cache', JSON.stringify(data)); render();
  }
  batch.forEach((b, i) => b.res(res[i] && res[i].error ? null : Object.assign({}, data, { result: res[i] })));
  saving();
  if (queue.length) flush();
}
async function refresh(p){
  if (!TOKEN){ data = null; render(); return; }
  const isAct = !!(p && p.action), seq = ++seqStarted;
  if (isAct){ pending++; lastAct = seq; }
  let got = null, err = null;
  try { got = await post({ fn: 'api', token: TOKEN, p: p || {} }); } catch (e) { err = e; }
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
  data = got; offline = false; save('pt-cache', JSON.stringify(data)); render(); pushCheck(); if (pendingGo){ const g = pendingGo; pendingGo = ''; goTo(g); } return got;
}
function saving(){ const el = $('#saving'); if (el) el.hidden = !pending; }
function signOut(msg){ TOKEN = ''; data = null; save('pt-token', null); save('pt-cache', null); stopChat(); render(); if (msg) toast(msg.charAt(0).toUpperCase() + msg.slice(1)); }

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
const wageOf = n => { const u = (data.users || []).find(x => x.name === n); return u ? Number(u.wage) || 0 : 0; };
const money = (x, cents) => '$' + (cents ? (Math.round(x * 100) / 100).toFixed(2) : Math.round(x).toLocaleString());
/** items: [{key, name, date, sort, h}] within one Mon–Sun week. Overtime past the weekly threshold, in time order, at the overtime rate. */
function labor(items){
  const P = data.pay || { ot: 40, otRate: 1.5, extra: 0 }, k = 1 + (Number(P.extra) || 0) / 100;
  const out = { byKey: {}, byPerson: {}, byDay: {}, hoursByPerson: {}, ot: {}, total: 0, missing: [] }, groups = {};
  items.forEach(i => (groups[i.name] = groups[i.name] || []).push(i));
  Object.keys(groups).forEach(n => {
    const w = wageOf(n); if (!w) out.missing.push(n);
    let acc = 0;
    groups[n].sort((a, b) => a.sort.localeCompare(b.sort)).forEach(i => {
      const reg = Math.max(0, Math.min(i.h, P.ot - acc)), over = i.h - reg; acc += i.h;
      const c = (reg * w + over * w * P.otRate) * k;
      out.byKey[i.key] = c; out.byPerson[n] = (out.byPerson[n] || 0) + c; out.byDay[i.date] = (out.byDay[i.date] || 0) + c; out.total += c;
      out.hoursByPerson[n] = acc; if (over > 0) out.ot[n] = (out.ot[n] || 0) + over;
    });
  });
  return out;
}
const shiftItems = list => list.map(s => ({ key: s.id, name: s.name, date: s.date, sort: s.date + s.start, h: Math.max(0, mins(s.end) - mins(s.start)) / 60 }));
const punchItems = list => list.filter(p => p.in && p.out).map(p => ({ key: p.id, name: p.name, date: p.date, sort: p.in, h: Math.max(0, new Date(p.out) - new Date(p.in)) / 36e5 }));
const weekShifts = wk => (data.shifts || []).filter(s => notGone(s) && s.date >= wk && s.date <= plus(wk, 6));
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
function weekReport(wk, name){
  const days = Array.from({ length: 7 }, (_, i) => plus(wk, i)), now = new Date();
  const people = name ? [name] : [...new Set((data.shifts || []).filter(s => days.includes(s.date)).map(s => s.name).concat((data.punches || []).filter(p => days.includes(p.date)).map(p => p.name)))].sort();
  const late = data.lateAfter || 5;
  return people.map(n => {
    const sh = (data.shifts || []).filter(s => live(s) && s.name === n && days.includes(s.date)), pu = (data.punches || []).filter(p => p.name === n && days.includes(p.date));
    let sched = 0, worked = 0, lates = 0, noShow = 0, missingOut = 0; const lines = [];
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
      else if (p.in && !p.out && (now - new Date(p.in)) > 16 * 36e5) missingOut++;
      if (!lines.some(l => l.punch === p)) lines.push({ date: p.date, shift: null, punch: p, unscheduled: true });
    });
    lines.sort((a, b) => (a.date + (a.shift ? a.shift.start : hmOf(a.punch.in))).localeCompare(b.date + (b.shift ? b.shift.start : hmOf(b.punch.in))));
    return { name: n, sched, worked, lates, noShow, missingOut, unscheduled: lines.filter(l => l.unscheduled).length, lines };
  });
}

/* ---------- screens ---------- */
function viewSignIn(){
  const hint = !standalone() ? (isIOS()
    ? `<div class="hint"><b>Put it on your home screen:</b> tap <b>Share</b> <span aria-hidden="true">⬆︎</span> at the bottom of Safari, then <b>Add to Home Screen</b>. Open it from there and sign in.</div>`
    : installEvt ? `<div class="hint"><b>Install the app</b> for one-tap access. <button class="btn sm go" data-install>Install</button></div>`
    : `<div class="hint"><b>Put it on your home screen:</b> in Chrome, tap <b>⋮</b> then <b>Add to Home screen</b> (or <b>Install app</b>).</div>`) : '';
  return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">${esc((data && data.name) || load('pt-shop') || 'Peregrine')}</p><p class="sub" style="text-align:center;margin:0 0 18px">Team sign-in</p>
    ${hint}<div class="card"><form class="stack" data-form="signin">
      <label class="f">First name<input name="name" autocomplete="username" autocapitalize="words" spellcheck="false" maxlength="60" value="${esc(load('pt-last') || '')}"></label>
      <label class="f">4-digit code<input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="current-password" class="code" style="text-align:center"></label>
      <button class="btn go">Sign in</button></form></div>
    <p class="sub" style="text-align:center">Don't know your code? Ask a manager.</p><i class="sprig" aria-hidden="true"></i></div>`;
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
    return `<div class="card clock on"><div class="row"><div class="txt"><b>Clocked in · ${timeOf(o.in)}</b><div class="sub">${s ? 'Shift ' + t12(s.start) + '–' + t12(s.end) : 'Not on the schedule'}${o.inPlace && o.inPlace !== 'at the shop' ? ' · ' + esc(o.inPlace) : ''}</div></div><button class="btn warn" data-clock="out">Clock out</button></div></div>`; }
  const soon = next && next.date === T();
  return `<div class="card clock"><div class="row"><div class="txt"><b>${soon ? 'Your shift today · ' + t12(next.start) + '–' + t12(next.end) : 'Not clocked in'}</b><div class="sub">${soon ? esc(next.position || '') : next ? 'Next: ' + dayName(next.date) + ' ' + t12(next.start) : 'No shifts coming up'}</div></div><button class="btn go" data-clock="in">Clock in</button></div></div>`;
}

function viewToday(){
  const d = data, today = shiftsOn(T()).filter(live), next = myNextShift();
  const unread = (d.announcements || []).filter(a => !a.read);
  const pendingReq = mgr() ? (d.requests || []).filter(q => q.status === 'Pending' && q.from !== d.me.name) : [];
  const mine = (d.requests || []).filter(q => q.from === d.me.name && q.status !== 'Cancelled').slice(0, 3);
  const chatN = (d.channels || []).reduce((n, c) => n + c.unread, 0);
  const hour = new Date().getHours(), hi = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const att = mgr() ? weekReport(monday(T())).reduce((a, r) => ({ late: a.late + r.lates, no: a.no + r.noShow, miss: a.miss + r.missingOut }), { late: 0, no: 0, miss: 0 }) : null;
  const remindHint = d.reminders && d.reminders.on && !d.me.email && d.me.reminders !== 'Off' && load('pt-nohint') !== '1'
    ? `<div class="hint"><b>Get a reminder before your shifts.</b> Add your email and pick when. <div class="btns" style="margin-top:8px"><button class="btn sm go" data-more="reminders">Set up reminders</button><button class="btn sm" data-nohint>Not now</button></div></div>` : '';
  const pubHint = lead() && d.unpublished ? `<div class="hint"><b>${d.unpublished} schedule change${d.unpublished > 1 ? 's' : ''} not published yet.</b> The team can't see ${d.unpublished > 1 ? 'them' : 'it'} until you publish. <div class="btns" style="margin-top:8px"><button class="btn sm go" data-tab="schedule">Review & publish</button></div></div>` : '';
  const pm = prepMine();
  const prepCard = pm.length ? `<h2>Prep for your shift</h2><div class="card">${pm.map(prepRow).join('')}</div>` : '';
  const pushHint = d.push && d.push.ready && !pushOn_() && load('pt-nopush') !== '1' && (pushNeedsHome() || (pushOK() && Notification.permission !== 'denied'))
    ? `<div class="hint"><b>Get notifications on this ${deviceKind()}.</b> ${pushNeedsHome() ? 'On iPhone, add the app to your Home Screen first, then turn them on.' : 'New messages, schedule changes and prep for your shift.'}
      <div class="btns" style="margin-top:8px">${pushNeedsHome() ? '<button class="btn sm go" data-more="push">Show me how</button>' : '<button class="btn sm go" data-pushon>Turn on</button>'}<button class="btn sm" data-nopush>Not now</button></div></div>` : '';
  return `<h1>${hi}, ${esc(first(d.me.name))}</h1>${pubHint}${pushHint}${remindHint}${clockCard()}${prepCard}
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
      <label class="opt"><input type="checkbox" name="notify" checked> Email the people on that shift</label>
      <button class="btn go">Send to the shift</button></form></div>
    <h2>To prep</h2><div class="card">${open.map(prepRow).join('') || '<div class="empty">Nothing to prep.</div>'}</div>
    ${done.length ? `<h2>Done recently</h2><div class="card">${done.map(prepRow).join('')}</div>` : ''}
    <p class="sub">The people on that shift see it on their Today screen, and in their night-before reminder email.</p>`;
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

/* ----- time sheet ----- */
function viewTime(){
  if (!tsWeek) tsWeek = monday(T());
  const lo = monday(plus(T(), -21));
  const nav = `<div class="weeknav"><button class="btn sm" data-tsweek="-7" ${tsWeek <= lo ? 'disabled' : ''}>‹</button><div><b>${tsWeek === monday(T()) ? 'This week' : 'Week of ' + shortDay(tsWeek)}</b><div class="sub">${shortDay(tsWeek)} – ${shortDay(plus(tsWeek, 6))}</div></div><button class="btn sm" data-tsweek="7" ${tsWeek >= monday(T()) ? 'disabled' : ''}>›</button></div>`;
  const line = (l, canEdit) => { const p = l.punch, s = l.shift;
    const flags = [l.noShow ? ['warn', 'No-show'] : null, l.lateBy > (data.lateAfter || 5) ? ['warn', 'Late ' + l.lateBy + ' min'] : null, l.unscheduled ? ['mute', 'Not scheduled'] : null,
      p && !p.out && (Date.now() - new Date(p.in)) > 16 * 36e5 ? ['warn', 'No clock-out'] : null, p && p.inPlace && /^away/.test(p.inPlace) ? ['mute', 'Clocked in ' + p.inPlace] : null, p && p.edited ? ['mute', 'Edited by ' + first(p.edited)] : null].filter(Boolean);
    const inner = `<div class="txt"><b>${shortDay(l.date)}</b><div class="sub">${s ? 'Scheduled ' + t12(s.start) + '–' + t12(s.end) : ''}${s && p ? ' · ' : ''}${p ? 'Worked ' + timeOf(p.in) + '–' + (p.out ? timeOf(p.out) : '…') + (p.out ? ' (' + hrs((new Date(p.out) - new Date(p.in)) / 6e4) + ')' : '') : ''}${p && p.note ? ' · ' + esc(p.note) : ''}</div>${flags.length ? `<div style="margin-top:4px">${flags.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>`;
    return canEdit ? rowBtn(`data-editpunch="${p ? esc(p.id) : ''}" data-pdate="${l.date}" data-pname="${esc(tsPerson)}" data-pstart="${s ? s.start : ''}" data-pend="${s ? s.end : ''}"`, inner + '<span class="sub">Fix</span>') : `<div class="row">${inner}</div>`; };
  if (!mgr() || tsPerson){
    const who = mgr() ? tsPerson : data.me.name, r = weekReport(tsWeek, who)[0] || { sched: 0, worked: 0, lines: [] };
    const pay = mgr() && wageOf(who) ? [labor(shiftItems(weekShifts(tsWeek).filter(s => s.name === who))), labor(punchItems((data.punches || []).filter(p => p.name === who && p.date >= tsWeek && p.date <= plus(tsWeek, 6))))] : null;
    return `${back(mgr() ? 'time' : '')}<h1>${mgr() ? esc(who) : 'My time'}</h1>${nav}
      <div class="card"><div class="row"><div class="txt">Scheduled</div><b>${hrs(r.sched)}</b>${pay ? `<span class="money">${money(pay[0].total)}</span>` : ''}</div><div class="row"><div class="txt">Worked</div><b>${hrs(r.worked)}</b>${pay ? `<span class="money">${money(pay[1].total)}</span>` : ''}</div>
      ${pay ? `<div class="row"><div class="txt sub">At ${money(wageOf(who), true)}/h${pay[1].ot[who] ? ' · ' + hrs(pay[1].ot[who] * 60) + ' overtime' : ''}. Estimate only – payroll decides.</div></div>` : ''}</div>
      <div class="card">${r.lines.map(l => line(l, mgr() && l.date <= T())).join('') || '<div class="empty">Nothing this week.</div>'}</div>
      ${mgr() ? `<button class="btn" data-editpunch="" data-pdate="${T()}" data-pname="${esc(who)}">+ Add a missed punch</button>` : '<p class="sub">Something wrong? Tell a manager – they can fix punches.</p>'}`;
  }
  const rep = weekReport(tsWeek), tot = rep.reduce((a, r) => ({ s: a.s + r.sched, w: a.w + r.worked }), { s: 0, w: 0 });
  const LS = labor(shiftItems(weekShifts(tsWeek))), LW = labor(punchItems((data.punches || []).filter(p => p.date >= tsWeek && p.date <= plus(tsWeek, 6))));
  return `${back()}<h1>Time sheets</h1>${nav}
    <div class="card"><div class="row"><div class="txt">Scheduled</div><b>${hrs(tot.s)}</b><span class="money">${money(LS.total)}</span></div><div class="row"><div class="txt">Worked</div><b>${hrs(tot.w)}</b><span class="money">${money(LW.total)}</span></div></div>
    <div class="card">${rep.map(r => rowBtn(`data-tsperson="${esc(r.name)}"`, `<div class="txt"><b>${esc(r.name)}</b><div class="sub">${hrs(r.worked)} worked of ${hrs(r.sched)} scheduled${wageOf(r.name) ? ` · ${money(LW.byPerson[r.name] || 0)} of ${money(LS.byPerson[r.name] || 0)} est.` : ' · no wage set'}</div>
      ${r.lates || r.noShow || r.missingOut || r.unscheduled ? `<div style="margin-top:4px">${[r.lates ? ['warn', r.lates + ' late'] : null, r.noShow ? ['warn', r.noShow + ' no-show'] : null, r.missingOut ? ['warn', r.missingOut + ' no clock-out'] : null, r.unscheduled ? ['mute', r.unscheduled + ' unscheduled'] : null].filter(Boolean).map(([c, t]) => `<span class="pill ${c}">${t}</span>`).join(' ')}</div>` : ''}</div><span>›</span>`)).join('') || '<div class="empty">No shifts or punches this week.</div>'}</div>
    <p class="sub">Late means clocking in more than ${data.lateAfter || 5} minutes after the shift start. Approved time off never counts as a no-show.</p>`;
}
function punchSheet(){
  const s = sheet, p = s.id ? (data.punches || []).find(x => x.id === s.id) : null;
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${p ? 'Fix punch' : 'Add punch'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <form class="stack" data-form="punch" style="padding:0">
      <label class="f">Who<select name="name">${(data.users || []).map(u => `<option ${u.name === s.name ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label class="f">Date<input name="date" type="date" value="${esc(p ? p.date : s.date)}"></label>
      <div class="two"><label class="f">In<input name="in" type="time" value="${esc(p && p.in ? hmOf(p.in) : s.start || '')}"></label><label class="f">Out<input name="out" type="time" value="${esc(p && p.out ? hmOf(p.out) : s.end || '')}"></label></div>
      <label class="f">Note<input name="note" maxlength="200" value="${esc(p ? p.note : '')}" placeholder="e.g. Forgot to clock out"></label>
      <div class="btns"><button class="btn go">Save</button>${p ? `<button type="button" class="btn" data-delpunch="${esc(p.id)}">Delete</button>` : ''}</div></form></div></div>`;
}

/* ----- chat ----- */
function viewChat(){
  if (chat.open) return viewConversation();
  const ch = data.channels || [], chans = ch.filter(c => c.kind === 'channel'), convos = ch.filter(c => c.kind !== 'channel');
  const item = c => rowBtn(`data-openchat="${esc(c.id)}"`, `<div class="txt"><b>${c.kind === 'channel' ? '# ' : ''}${esc(c.name)}</b><div class="sub">${c.last ? esc(first(c.last.from)) + ': ' + esc(c.last.text) : c.kind === 'group' ? esc(c.members.join(', ')) : 'No messages yet'}</div></div>${c.unread ? `<span class="pill warn">${c.unread}</span>` : c.last ? `<span class="sub">${ago(c.last.at)}</span>` : ''}`);
  return `<h1>Messages</h1><h2>Channels</h2><div class="card">${chans.map(item).join('') || '<div class="empty">No channels.</div>'}</div>
    <h2>Direct & groups</h2><div class="card">${convos.map(item).join('') || '<div class="empty">No conversations yet.</div>'}</div>
    <div class="btns"><button class="btn go" data-newdm>New message</button><button class="btn" data-newgroup>New group</button>${lead() ? '<button class="btn" data-newchannel>New channel</button>' : ''}</div>`;
}
function convName(){ const c = (data.channels || []).find(x => x.id === chat.open); if (c) return (c.kind === 'channel' ? '# ' : '') + c.name; const other = chat.open.split('-').slice(1).find(x => x !== data.meId), p = (data.people || []).find(x => x.id === other); return p ? p.name : chat.dmName || 'Message'; }
function viewConversation(){
  const msgs = chat.msgs || [];
  let lastDay = '';
  const body = msgs.map(m => { const day = ymdOf(new Date(m.at)), mine = m.fromId === chat.me; const sep = day !== lastDay ? `<div class="daysep">${dayName(day)}</div>` : ''; lastDay = day;
    return sep + `<div class="bub ${mine ? 'me' : ''}">${mine ? '' : `<div class="from">${esc(m.from)}</div>`}${m.photo ? picTag(m) : m.expired ? '<div class="sub"><i>Photo expired</i></div>' : ''}${m.text ? `<div class="msg">${esc(m.text)}</div>` : ''}<div class="when">${timeOf(m.at)}${mgr() ? ` · <button class="lnk" data-delmsg="${esc(m.id)}">Delete</button>` : ''}</div></div>`; }).join('');
  return `<div class="convo"><div class="weeknav" style="margin-bottom:8px"><button class="btn sm" data-closechat>‹ Back</button><div><b>${esc(convName())}</b></div><span style="width:44px"></span></div>
    <div class="msgs" id="msgs">${body || '<div class="empty">Say hello 👋</div>'}</div>
    ${chat.photo ? `<div class="pv"><img src="${chat.photo}" alt="Photo to send"><button type="button" class="pvx" data-unphoto aria-label="Remove photo">×</button></div>` : ''}
    <form class="composer" data-form="send">${Number(data.version) >= 2.7 ? `<label class="btn picbtn" title="Add a photo" aria-label="Add a photo"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><input type="file" accept="image/*" data-photo hidden onchange="pickPhoto(this)"></label>` : ''}<textarea name="text" rows="1" maxlength="2000" placeholder="${chat.photo ? 'Add a caption' : 'Message'}" aria-label="Message">${esc(chat.compose)}</textarea><button class="btn go" ${chat.sending ? 'disabled' : ''}>Send</button></form></div>`;
}
async function openChat(id, name, text, photo){
  chat.open = id; chat.dmName = name || chat.dmName; if (text === undefined) { chat.msgs = chat.msgs && chat.loaded === id ? chat.msgs : []; }
  render(); scrollChat();
  try {
    const r = await post(Object.assign({ fn: 'chat', token: TOKEN, channel: id, text }, photo ? { photo } : {}));
    if (photo){ const mine = r.messages.filter(m => m.fromId === r.me && m.photo).pop(); if (mine && !picCache[mine.id]){ picCache[mine.id] = photo; idbPut(mine.id, photo); } }
    if (chat.open !== id) return;
    chat.msgs = r.messages; chat.me = r.me; chat.loaded = id; data.channels = r.channels; save('pt-cache', JSON.stringify(data));
    const near = isNearBottom(); render(); if (near || text !== undefined) scrollChat();
  } catch (e) { const m = String(e.message || e); if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, '')); if (text !== undefined) { chat.compose = text; if (photo) chat.photo = photo; chat.msgs = (chat.msgs || []).filter(x => x.id !== 'tmp'); toast('Not sent: ' + m); render(); } }
  clearTimeout(chat.timer); chat.timer = setTimeout(() => { if (chat.open === id && tab === 'chat' && !document.hidden) openChat(id); }, 7000);
}
function stopChat(){ clearTimeout(chat.timer); chat.open = ''; }

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
    post({ fn: 'photo', token: TOKEN, id }).then(r => { const src = 'data:' + r.mime + ';base64,' + r.data; picCache[id] = src; idbPut(id, src); showPic(id, src); })
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
    ${kind === 'dm' ? `<div class="card">${people.map(p => rowBtn(`data-dm="${esc(p.id)}" data-dmname="${esc(p.name)}"`, `<div class="txt"><b>${esc(p.name)}</b></div><span>›</span>`)).join('')}</div>`
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
  const P = data.push || {}, pr = P.prefs || {}, on = pushOn_(), back = '<button class="btn sm" data-more="">‹ More</button>';
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
      <p class="sub">These apply to every device you've turned notifications on (${n} so far).</p>` : ''}`;
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
  return `${back()}<h1>Shift reminders</h1>
    ${R.on ? '' : '<div class="hint">Reminder emails are turned off for the shop right now. A manager can turn them on in the sheet\'s Settings.</div>'}
    <div class="card"><form class="stack" data-form="reminders">
      <label class="f">Email for reminders<input name="email" type="email" autocomplete="email" maxlength="120" value="${esc(me.email || '')}" placeholder="you@example.com"></label>
      <div class="f" style="display:grid;gap:6px;font-size:.8rem;color:var(--muted)">When to remind me
        ${modes.map(([k, n]) => `<label class="opt"><input type="radio" name="mode" value="${k}" ${me.reminders === k ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>
      <div class="btns"><button class="btn go">Save</button>${me.email ? '<button type="button" class="btn" data-testmail>Send me a test</button>' : ''}</div>
      <p class="sub" style="margin:0">You'll also get an email if a manager adds, moves or removes one of your shifts in the next 7 days (unless reminders are Off).</p></form></div>
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
    try { const c = await caches.open('pt-files'); await c.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } })); } catch (_) {}
  } catch (e) {
    const m = String(e.message || e); if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, ''));
    try { const c = await caches.open('pt-files'), hit = await c.match(key); if (hit) { bytes = new Uint8Array(await hit.arrayBuffer()); fromCache = true; } } catch (_) {}
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
const back = to => `<button class="btn sm" data-more="${to || ''}" style="margin-bottom:6px">‹ ${to ? 'Back' : 'More'}</button>`;
function viewTeam(){
  const us = (data.users || []).slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  const added = justAdded && us.find(u => u.name === justAdded);
  const addedCard = added ? `<div class="hint"><b>${esc(added.name)} is on the team.</b> Their code is <span class="code">${esc(added.code)}</span><br>Send them the app link and this code.
      <div class="btns" style="margin-top:8px">${added.phone ? `<a class="btn sm go" href="sms:${esc(added.phone.replace(/[^\d+]/g, ''))}${isIOS() ? '&' : '?'}body=${encodeURIComponent('Peregrine team app: ' + location.href.split('#')[0] + '\nFirst name: ' + first(added.name) + '\nCode: ' + added.code + '\nOpen it, then add it to your home screen.')}">Text it</a>` : ''}<button class="btn sm" data-dismiss>Done</button></div></div>` : '';
  const form = u => `<form class="stack" data-form="user" ${u ? `data-id="${esc(u.id)}"` : ''}>
      <label class="f">Name<input name="name" maxlength="60" value="${esc(u ? u.name : '')}" placeholder="First and last name"></label>
      <label class="f">Role<select name="role">${['Staff', 'Lead', 'Manager'].map(r => `<option ${u && u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <div class="two"><label class="f">Phone<input name="phone" type="tel" maxlength="40" value="${esc(u ? u.phone : '')}"></label><label class="f">Email<input name="email" type="email" maxlength="120" value="${esc(u ? u.email : '')}"></label></div>
      <label class="f">Hourly wage ($) – only managers see this<input name="wage" inputmode="decimal" maxlength="8" value="${u && u.wage ? Number(u.wage).toFixed(2) : ''}" placeholder="e.g. 15.50"></label>
      <div class="btns"><button class="btn go">${u ? 'Save' : 'Add to the team'}</button>${u ? '<button type="button" class="btn" data-canceledit>Cancel</button>' : ''}</div></form>`;
  const row = u => editUser === u.id ? `<div class="row" style="display:block;padding:0">${form(u)}</div>` : `<div class="row" style="display:block;${u.active ? '' : 'opacity:.55'}">
      <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(u.name)}</b><span class="pill ${u.role === 'Manager' ? 'warn' : u.role === 'Lead' ? 'ok' : 'mute'}">${esc(u.role)}</span>${u.active ? '' : '<span class="pill mute">Off</span>'}</div>
      <div class="sub">${u.wage ? money(u.wage, true) + '/h · ' : ''}${u.email ? (u.reminders === 'Off' ? 'Reminders off' : 'Reminders: ' + esc(u.reminders)) : 'No email – no reminders'}</div><div class="sub">${u.phone ? esc(u.phone) + ' · ' : ''}Code ${showCode[u.id] ? `<b>${esc(u.code)}</b>` : '••••'} <button class="btn sm" data-showcode="${esc(u.id)}" style="padding:4px 8px;min-height:0">${showCode[u.id] ? 'Hide' : 'Show'}</button></div>
      <div class="btns" style="margin-top:8px"><button class="btn sm" data-edit="${esc(u.id)}">Edit</button><button class="btn sm" data-newcode="${esc(u.id)}" data-name="${esc(u.name)}">New code</button>
        <button class="btn sm" data-active="${esc(u.id)}" data-to="${u.active ? 0 : 1}" data-name="${esc(u.name)}">${u.active ? 'Turn off' : 'Turn on'}</button></div></div>`;
  return `${back()}<h1>Team</h1>${addedCard}<div class="card">${us.map(row).join('')}</div>
    <h2>Schedule lineup</h2><p class="sub" style="margin:0 4px 8px">Drag ⠿ to set the order people appear on the schedule. Hidden people stay on the team (they can still sign in); they just don't take up a row.</p>
    <div class="card" data-reorder>${lineup().map(u => `<div class="row" data-rid="${esc(u.id)}"><span class="handle" data-rowdrag aria-label="Drag to reorder ${esc(u.name)}">⠿</span><div class="txt ${shown(u) ? '' : 'muted'}"><b>${esc(u.name)}</b><div class="sub">${esc(u.role)}${shown(u) ? '' : ' · hidden from the schedule'}</div></div><button class="btn sm" data-onsched="${esc(u.id)}" data-to="${shown(u) ? 0 : 1}">${shown(u) ? 'Hide' : 'Show'}</button></div>`).join('')}</div>
    <h2>Add someone</h2><div class="card">${form(null)}</div>
    <p class="sub">Turning someone off or giving a new code signs them out on every phone right away. Everything here is also on the Users tab of the sheet.</p>`;
}

function viewMore(){
  const views = { push: viewPush, reminders: viewReminders, requests: viewRequests, avail: viewAvail, time: viewTime, news: viewNews, resources: viewResources, team: () => mgr() ? viewTeam() : viewMoreList() };
  return views[moreView] ? views[moreView]() : viewMoreList();
}
function viewMoreList(){
  const pendN = mgr() ? (data.requests || []).filter(q => q.status === 'Pending' && q.from !== data.me.name).length : 0;
  const unreadN = (data.announcements || []).filter(a => !a.read).length;
  const item = (k, label, sub, extra) => rowBtn(`data-more="${k}"`, `<div class="txt"><b>${label}</b>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${extra || ''}<span>›</span>`);
  const pill = n => n ? `<span class="pill warn" style="margin-right:8px">${n}</span>` : '';
  return `<h1>More</h1><div class="card">
      ${item('news', 'Announcements', '', pill(unreadN))}
      ${item('time', mgr() ? 'Time sheets' : 'My time', mgr() ? 'Hours, late arrivals, missed punches' : 'Your hours vs. the schedule')}
      ${item('requests', 'Time off & swaps', '', pill(pendN))}
      ${item('avail', 'Availability', 'When you can\'t work')}
      ${data.push && data.push.ready ? item('push', 'Notifications', pushOn_() ? 'On for this ' + deviceKind() : 'Off on this ' + deviceKind()) : ''}
      ${item('reminders', 'Shift reminders', data.me.reminders === 'Off' || !data.me.email ? 'Off' : data.me.reminders + ' · ' + esc(data.me.email))}
      ${item('resources', 'Resources', 'Recipes, guides, handbooks')}
      ${mgr() ? item('team', 'Team & sign-in codes') : ''}</div>
    <h2>Look</h2><div class="seg">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, n]) => `<button data-theme="${k}" aria-pressed="${theme() === k}">${n}</button>`).join('')}</div>
    <h2>${esc(data.me.name)} · ${esc(data.me.role)}</h2><div class="card"><div class="row"><div class="txt sub">Signed in on this phone.${!standalone() ? ' Tip: add this app to your home screen.' : ''}</div><button class="btn sm" data-signout>Sign out</button></div></div>
    <p class="sub" style="text-align:center">Peregrine Team · server ${esc(data.version || '')}</p>`;
}

const TABS = [['today', 'Today', '☀︎'], ['schedule', 'Schedule', '▦'], ['chat', 'Chat', '✉︎'], ['lists', 'Lists', '✓'], ['tests', 'Tests', '✎'], ['more', 'More', '☰']];
let lastView = '';
function render(){
  if (rowDrag){ rowDrag.later = true; return; }       // don't redraw under a finger mid-drag
  $('#offline').hidden = !offline;
  if (!TOKEN || !data){ $('#tabs').hidden = true; $('#refresh').hidden = true; $('#overlay').innerHTML = ''; $('#shop').textContent = load('pt-shop') || 'Peregrine'; $('#main').innerHTML = TOKEN ? '<div class="empty">Loading…</div>' : viewSignIn(); return; }
  data.meId = data.me.id;
  const short = String(data.name || 'Peregrine').replace(/\s+(coffee|roasters?|roastery|co\.?)\b.*$/i, '') || data.name; $('#shop').textContent = short; save('pt-shop', short); $('#refresh').hidden = false;
  const gate = mustRead();
  if (gate.length){ $('#tabs').hidden = true; $('#overlay').innerHTML = ''; $('#main').innerHTML = viewMustRead(gate[0], gate.length); return; }
  const chatN = (data.channels || []).reduce((n, c) => n + c.unread, 0);
  const badge = { lists: prepMine().length, chat: chatN, more: (mgr() ? (data.requests || []).filter(q => q.status === 'Pending' && q.from !== data.me.name).length : 0) + (data.announcements || []).filter(a => !a.read).length };
  $('#tabs').hidden = false;
  $('#tabs').innerHTML = TABS.map(([k, n, ic]) => `<button data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${n}${badge[k] ? `<span class="n">${badge[k]}</span>` : ''}</button>`).join('');
  const ae = document.activeElement, keepWage = ae && ae.dataset && (ae.dataset.wage || ae.dataset.invf) ? [ae.dataset.wage ? `[data-wage="${ae.dataset.wage}"]` : `[data-invf="${ae.dataset.invf}"][data-invk="${ae.dataset.invk}"]`, ae.value, ae.selectionStart] : null;
  const typingIn = document.activeElement && document.activeElement.closest && document.activeElement.closest('.composer');
  const draft = typingIn ? document.activeElement.value : null;
  document.body.classList.toggle('wide', wide() && tab === 'schedule' && lead() && schedView !== 'mine');
  const vkey = tab + '|' + schedView + '|' + week + '|' + moreView, same = vkey === lastView, gw = $('.gridwrap'), keep = same && gw ? [gw.scrollTop, gw.scrollLeft] : null, wy = window.scrollY; lastView = vkey;
  $('#main').innerHTML = tab === 'tests' ? viewTests() : tab === 'lists' ? viewLists() : tab === 'schedule' ? viewSchedule() : tab === 'chat' ? viewChat() : tab === 'more' ? viewMore() : viewToday();
  if (same && tab !== 'chat'){ const g2 = $('.gridwrap'); if (keep && g2){ g2.scrollTop = keep[0]; g2.scrollLeft = keep[1]; } if (window.scrollY !== wy) window.scrollTo(0, wy); }   // a save or refresh redraws the page; stay where you were
  if (draft !== null){ const t = $('.composer textarea'); if (t){ t.value = draft; t.focus(); } }
  $('#overlay').innerHTML = runner ? viewRunner() : viewer ? viewViewer() : sheet ? (sheet.kind === 'shift' ? shiftSheet() : sheet.kind === 'publish' ? publishSheet() : sheet.kind === 'punch' ? punchSheet() : pickSheet(sheet.kind)) : '';
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
  if (b.id === 'refresh'){ if (chat.open) { openChat(chat.open); return; } refresh().then(r => { if (r) toast('Up to date'); }); return; }
  if (d.install !== undefined && installEvt){ installEvt.prompt(); installEvt = null; return; }
  if (d.ack){ const a = data.announcements.find(x => x.id === d.ack); if (a) a.read = true; render(); act('read', { id: d.ack }); return; }
  if (d.tab){ tab = d.tab; save('pt-tab', tab); if (tab === 'more') moreView = ''; if (tab !== 'chat') stopChat(); window.scrollTo(0, 0); render(); if (tab === 'schedule') scrollToday(); return; }
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
  if (d.tsweek){ tsWeek = plus(tsWeek, Number(d.tsweek)); render(); return; }
  if (d.tsperson){ tsPerson = d.tsperson; window.scrollTo(0, 0); render(); return; }
  if (d.signout !== undefined){ if (confirm('Sign out on this phone?')) signOut(); return; }
  if (d.showcode){ showCode[d.showcode] = !showCode[d.showcode]; render(); return; }
  if (d.edit){ editUser = d.edit; render(); return; }
  if (d.canceledit !== undefined){ editUser = null; render(); return; }
  if (d.dismiss !== undefined){ justAdded = null; render(); return; }
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
  if (d.delmsg){ if (!confirm('Delete this message?')) return; chat.msgs = chat.msgs.filter(m => m.id !== d.delmsg); render(); await act('deleteMessage', { id: d.delmsg }); openChat(chat.open); return; }
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
document.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && e.target.closest && e.target.closest('.composer') && !isIOS()){ e.preventDefault(); e.target.closest('form').requestSubmit(); } });

document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
  const v = n => { const el = f.elements.namedItem(n); return el ? (el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value.trim()) : ''; };
  const kind = f.dataset.form, btn = f.querySelector('button.go');
  if (kind === 'signin'){
    const name = v('name'), code = v('code');
    if (!name || !/^\d{4}$/.test(code)){ toast('Type your first name and your 4-digit code'); return; }
    btn.disabled = true; btn.textContent = 'Signing in…';
    try { const r = await post({ fn: 'signIn', name, code }); TOKEN = r.token; save('pt-token', TOKEN); save('pt-last', name); data = null; tab = 'today'; render(); refresh(); }
    catch (err) { btn.disabled = false; btn.textContent = 'Sign in'; toast(String(err.message || err) === 'timeout' ? 'The server took too long – try again' : String(err.message || err)); }
    return;
  }
  if (kind === 'send'){ const text = f.elements.namedItem('text').value.trim(), photo = chat.photo || ''; if (!text && !photo) return;
    chat.compose = ''; chat.photo = ''; chat.msgs = (chat.msgs || []).concat({ id: 'tmp', fromId: chat.me || data.meId, from: data.me.name, at: new Date().toISOString(), text, photo: photo ? 1 : 0, local: photo }); render(); scrollChat();
    const t = $('.composer textarea'); if (t) t.focus(); openChat(chat.open, null, text, photo || undefined); return; }
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
      toast(x.names.length ? 'Sent to ' + x.label + ' · ' + x.names.map(first).join(', ') + (x.emailed ? ' (emailed ' + x.emailed + ')' : '') : 'Added – nobody is scheduled for that shift yet'); } }); f.reset(); return; }
  if (kind === 'punch'){ const p = { id: sheet && sheet.id || '', name: v('name'), date: v('date'), in: v('in'), out: v('out'), note: v('note') }; sheet = null; act('savePunch', p).then(r => { if (r) toast('Saved'); }); return; }
  if (kind === 'reminders'){ const mode = (f.querySelector('input[name=mode]:checked') || {}).value || '';
    act('myReminders', { email: v('email'), mode }).then(r => { if (r) toast(mode === 'Off' ? 'Reminders off' : v('email') ? 'Saved' : 'Saved – add an email to get them'); }); return; }
  if (kind === 'avail'){ const day = v('day') === 'date' ? v('date') : v('day'); if (!day){ toast('Pick a date'); return; }
    (data.availability = data.availability || []).push({ id: 'tmp' + Date.now(), name: data.me.name, day, from: v('from'), to: v('to'), note: v('note') }); render(); act('addAvail', { day, from: v('from'), to: v('to'), note: v('note') }).then(r => { if (r) toast('Added'); }); f.reset(); return; }
  if (kind === 'group'){ const members = [...f.querySelectorAll('input[name=m]:checked')].map(x => x.value).join(','); sheet = null; act('newChannel', { kind: 'group', name: v('name'), members }).then(r => { if (r) toast('Group made'); }); return; }
  if (kind === 'channel'){ sheet = null; act('newChannel', { kind: 'channel', name: v('name'), who: v('who') }).then(r => { if (r) toast('Channel made'); }); return; }
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
document.addEventListener('visibilitychange', () => { if (document.hidden || !TOKEN) return; if (chat.open && tab === 'chat') openChat(chat.open); else if (!pending && !typing() && !sheet) refresh(); });
setInterval(() => { if (!document.hidden && TOKEN && !pending && !typing() && !sheet && !viewer && !chat.open) refresh(); }, 90000);
window.addEventListener('online', () => { if (TOKEN) refresh(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (!TOKEN) render(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

if (theme() !== 'auto') setTheme(theme());
let pendingGo = new URLSearchParams(location.search).get('go') || '';
if (pendingGo) history.replaceState(null, '', location.pathname);
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.go !== undefined) goTo(e.data.go); });
render();
if (TOKEN) refresh();
