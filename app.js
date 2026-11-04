/* Peregrine Team – phone app. Talks to the Apps Script server in config.js; all data lives in the Google Sheet. */
'use strict';
const API = window.PEREGRINE_API || '';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const save = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} };
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
  data = got; offline = false; save('pt-cache', JSON.stringify(data)); render(); return got;
}
const act = (action, params) => refresh(Object.assign({ action }, params || {}));
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
  if ((data.shifts || []).some(x => x !== s && x.id !== s.id && x.name === s.name && x.date === s.date && mins(x.start) < mins(s.end) && mins(x.end) > mins(s.start))) out.push(['warn', 'Double-booked']);
  return out;
}

/* ---------- time sheet logic ---------- */
function weekReport(wk, name){
  const days = Array.from({ length: 7 }, (_, i) => plus(wk, i)), now = new Date();
  const people = name ? [name] : [...new Set((data.shifts || []).filter(s => days.includes(s.date)).map(s => s.name).concat((data.punches || []).filter(p => days.includes(p.date)).map(p => p.name)))].sort();
  const late = data.lateAfter || 5;
  return people.map(n => {
    const sh = (data.shifts || []).filter(s => s.name === n && days.includes(s.date)), pu = (data.punches || []).filter(p => p.name === n && days.includes(p.date));
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

function myNextShift(){ const now = new Date(); return (data.shifts || []).find(s => s.name === data.me.name && (s.date > T() || (s.date === T() && mins(s.end) > now.getHours() * 60 + now.getMinutes()))); }

function clockCard(){
  const o = data.open, next = myNextShift();
  if (o) { const s = (data.shifts || []).find(x => x.id === o.shift);
    return `<div class="card clock on"><div class="row"><div class="txt"><b>Clocked in · ${timeOf(o.in)}</b><div class="sub">${s ? 'Shift ' + t12(s.start) + '–' + t12(s.end) : 'Not on the schedule'}${o.inPlace && o.inPlace !== 'at the shop' ? ' · ' + esc(o.inPlace) : ''}</div></div><button class="btn warn" data-clock="out">Clock out</button></div></div>`; }
  const soon = next && next.date === T();
  return `<div class="card clock"><div class="row"><div class="txt"><b>${soon ? 'Your shift today · ' + t12(next.start) + '–' + t12(next.end) : 'Not clocked in'}</b><div class="sub">${soon ? esc(next.position || '') : next ? 'Next: ' + dayName(next.date) + ' ' + t12(next.start) : 'No shifts coming up'}</div></div><button class="btn go" data-clock="in">Clock in</button></div></div>`;
}

function viewToday(){
  const d = data, today = shiftsOn(T()), next = myNextShift();
  const unread = (d.announcements || []).filter(a => !a.read);
  const pendingReq = mgr() ? (d.requests || []).filter(q => q.status === 'Pending' && q.from !== d.me.name) : [];
  const mine = (d.requests || []).filter(q => q.from === d.me.name && q.status !== 'Cancelled').slice(0, 3);
  const chatN = (d.channels || []).reduce((n, c) => n + c.unread, 0);
  const hour = new Date().getHours(), hi = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const att = mgr() ? weekReport(monday(T())).reduce((a, r) => ({ late: a.late + r.lates, no: a.no + r.noShow, miss: a.miss + r.missingOut }), { late: 0, no: 0, miss: 0 }) : null;
  return `<h1>${hi}, ${esc(first(d.me.name))}</h1>${clockCard()}
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
function viewLists(){
  const cl = data.checklists || [];
  if (!cl.length) return '<h1>Checklists</h1><div class="card"><div class="empty">Nothing on the checklists today.</div></div>';
  if (!cl.some(c => c.list === listTab)) listTab = (cl.find(c => c.done < c.total) || cl[0]).list;
  const c = cl.find(x => x.list === listTab);
  const hist = lead() && data.history && data.history.length ? `<h2>Last 7 days</h2><div class="card">${data.history.map(h => { const miss = h.lists.reduce((n, l) => n + (l.total - l.done), 0);
      return `<div class="row"><div class="txt"><b>${dayName(h.date)}</b><div class="sub">${h.lists.map(l => esc(l.list) + ' ' + l.done + '/' + l.total).join(' · ')}</div>${miss ? `<details class="more"><summary>${miss} missed</summary><div class="sub">${h.lists.filter(l => l.missed.length).map(l => '<b>' + esc(l.list) + ':</b> ' + l.missed.map(esc).join(', ')).join('<br>')}</div></details>` : ''}</div><span class="pill ${miss ? 'warn' : 'ok'}">${miss ? 'Missed ' + miss : 'All done'}</span></div>`; }).join('')}</div>` : '';
  return `<h1>Checklists</h1><div class="seg">${cl.map(x => `<button data-list="${esc(x.list)}" aria-pressed="${x.list === listTab}">${esc(x.list)} ${x.done}/${x.total}</button>`).join('')}</div>
    <div class="card">${c.items.map((i, n) => { const k = 'c|' + c.list + '|' + i.task, on = busy[k] !== undefined ? busy[k] : !!i.by;
      const head = i.section && (n === 0 || c.items[n - 1].section !== i.section) ? `<div class="sec">${esc(i.section)}</div>` : '';
      return head + `<div class="row ${on ? 'done' : ''}"><button class="chk ${on ? 'on' : ''}" data-check="${esc(i.task)}" data-on="${on ? 1 : 0}" aria-label="${on ? 'Undo' : 'Done'}: ${esc(i.task)}">${on ? '✓' : ''}</button>
        <div class="txt"><b>${esc(i.task)}</b>${i.notes ? `<div class="sub">${esc(i.notes)}</div>` : ''}${i.by ? `<div class="sub">${esc(i.by)} · ${timeOf(i.at)}</div>` : ''}</div></div>`; }).join('')}</div>${hist}`;
}

/* ----- schedule ----- */
function viewSchedule(){
  const lo = monday(plus(T(), -21)), hi = monday(plus(T(), mgr() ? 49 : 7));
  if (!week || week < lo || week > hi) week = monday(T());
  const days = Array.from({ length: 7 }, (_, i) => plus(week, i));
  const label = week === monday(T()) ? 'This week' : week === plus(monday(T()), 7) ? 'Next week' : week === plus(monday(T()), -7) ? 'Last week' : 'Week of ' + shortDay(week);
  const nav = `<div class="weeknav"><button class="btn sm" data-week="-7" ${week <= lo ? 'disabled' : ''} aria-label="Previous week">‹</button><div><b>${label}</b><div class="sub">${shortDay(days[0])} – ${shortDay(days[6])}</div></div><button class="btn sm" data-week="7" ${week >= hi ? 'disabled' : ''} aria-label="Next week">›</button></div>`;
  const mineOnly = schedMine && !mgr();
  const dayCard = d => {
    const list = shiftsOn(d).filter(s => !mineOnly || s.name === data.me.name);
    const offs = mgr() ? (data.requests || []).filter(q => q.type === 'Time off' && q.date === d && q.status === 'Approved').map(q => first(q.from)) : [];
    return `<h2 ${d === T() ? 'id="todayh" class="today-h"' : ''}>${dayName(d)}${d !== T() && d !== plus(T(), 1) ? '' : ' · ' + shortDay(d)}</h2><div class="card">
      ${list.map(s => { const cf = mgr() ? conflicts(s) : [];
        const inner = `<div class="txt"><b>${esc(s.name)}</b><div class="sub">${t12(s.start)}–${t12(s.end)} · ${hrs(mins(s.end) - mins(s.start))}${s.position ? ' · ' + esc(s.position) : ''}${s.notes ? ' · ' + esc(s.notes) : ''}</div>${cf.length ? `<div style="margin-top:4px">${cf.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>${mgr() ? '<span class="sub">Edit</span>' : ''}`;
        return mgr() ? rowBtn(`data-editshift="${esc(s.id)}" class="${s.name === data.me.name ? 'mine' : ''}"`, inner) : `<div class="row ${s.name === data.me.name ? 'mine' : ''}">${inner}</div>`; }).join('') || '<div class="empty" style="padding:14px">No shifts.</div>'}
      ${offs.length ? `<div class="row"><div class="txt sub">Off: ${offs.map(esc).join(', ')}</div></div>` : ''}
      ${mgr() ? rowBtn(`data-addshift="${d}"`, '<div class="txt accent"><b>+ Add shift</b></div>') : ''}</div>`;
  };
  const totals = mgr() ? (() => { const t = {}; days.forEach(d => shiftsOn(d).forEach(s => { t[s.name] = (t[s.name] || 0) + mins(s.end) - mins(s.start); }));
    const names = Object.keys(t).sort(); return names.length ? `<h2>Hours this week</h2><div class="card">${names.map(n => `<div class="row"><div class="txt">${esc(n)}</div><b>${hrs(t[n])}</b></div>`).join('')}</div>` : ''; })() : '';
  const tools = mgr() ? `<div class="btns" style="margin:10px 0 4px"><button class="btn sm" data-copyweek>Copy last week here</button><button class="btn sm" data-clearweek>Clear this week</button></div>` : '';
  return `<h1>Schedule</h1>${nav}${mgr() ? '' : `<div class="seg"><button data-mine="0" aria-pressed="${!schedMine}">Everyone</button><button data-mine="1" aria-pressed="${schedMine}">My shifts</button></div>`}
    ${tools}${days.map(dayCard).join('')}${totals}
    <div class="btns" style="margin-top:14px"><button class="btn" data-more="requests">Time off & swaps</button><button class="btn" data-more="avail">My availability</button></div>`;
}
function shiftSheet(){
  const s = sheet, d = s.date, team = (data.users || []).filter(u => u.active).map(u => u.name);
  const status = n => { if (approvedOff(n, d)) return ' – time off'; const u = unavail(n, d); if (u) return u.from ? ' – unavailable ' + t12(u.from) + '–' + t12(u.to) : ' – unavailable'; if (pendingOff(n, d)) return ' – asked for off'; const b = shiftsOn(d).filter(x => x.name === n && x.id !== s.id); return b.length ? ' – already ' + b.map(x => t12(x.start) + '–' + t12(x.end)).join(', ') : ''; };
  return `<div class="sheet" role="dialog" aria-label="Shift"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${s.id ? 'Edit shift' : 'New shift'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <p class="sub">${/^(Today|Tomorrow|Yesterday)$/.test(dayName(d)) ? dayName(d) + ' · ' + shortDay(d) : dayName(d)}</p>
    <form class="stack" data-form="shift" style="padding:0">
      <label class="f">Who<select name="name" required>${s.name ? '' : '<option value="">Pick someone…</option>'}${team.map(n => `<option value="${esc(n)}" ${n === s.name ? 'selected' : ''}>${esc(n)}${esc(status(n))}</option>`).join('')}</select></label>
      ${(data.presets || []).length ? `<div class="btns">${data.presets.map(p => `<button type="button" class="btn sm" data-preset="${p.start}|${p.end}">${esc(p.name)} ${t12(p.start)}–${t12(p.end)}</button>`).join('')}</div>` : ''}
      <div class="two"><label class="f">Start<input name="start" type="time" value="${esc(s.start || '07:00')}"></label><label class="f">End<input name="end" type="time" value="${esc(s.end || '13:00')}"></label></div>
      <label class="f">Position<select name="position"><option value=""></option>${(data.positions || []).map(p => `<option ${p === s.position ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="f">Notes<input name="notes" maxlength="200" value="${esc(s.notes || '')}"></label>
      <label class="f">Date<input name="date" type="date" value="${esc(d)}"></label>
      <div class="btns"><button class="btn go">${s.id ? 'Save' : 'Add shift'}</button>${s.id ? `<button type="button" class="btn" data-delshift="${esc(s.id)}">Delete</button>` : ''}</div></form></div></div>`;
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
    return `${back(mgr() ? 'time' : '')}<h1>${mgr() ? esc(who) : 'My time'}</h1>${nav}
      <div class="card"><div class="row"><div class="txt">Scheduled</div><b>${hrs(r.sched)}</b></div><div class="row"><div class="txt">Worked</div><b>${hrs(r.worked)}</b></div></div>
      <div class="card">${r.lines.map(l => line(l, mgr() && l.date <= T())).join('') || '<div class="empty">Nothing this week.</div>'}</div>
      ${mgr() ? `<button class="btn" data-editpunch="" data-pdate="${T()}" data-pname="${esc(who)}">+ Add a missed punch</button>` : '<p class="sub">Something wrong? Tell a manager – they can fix punches.</p>'}`;
  }
  const rep = weekReport(tsWeek), tot = rep.reduce((a, r) => ({ s: a.s + r.sched, w: a.w + r.worked }), { s: 0, w: 0 });
  return `${back()}<h1>Time sheets</h1>${nav}
    <div class="card"><div class="row"><div class="txt">Scheduled</div><b>${hrs(tot.s)}</b></div><div class="row"><div class="txt">Worked</div><b>${hrs(tot.w)}</b></div></div>
    <div class="card">${rep.map(r => rowBtn(`data-tsperson="${esc(r.name)}"`, `<div class="txt"><b>${esc(r.name)}</b><div class="sub">${hrs(r.worked)} worked of ${hrs(r.sched)} scheduled</div>
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
    return sep + `<div class="bub ${mine ? 'me' : ''}">${mine ? '' : `<div class="from">${esc(m.from)}</div>`}<div class="msg">${esc(m.text)}</div><div class="when">${timeOf(m.at)}${mine || mgr() ? ` · <button class="lnk" data-delmsg="${esc(m.id)}">Delete</button>` : ''}</div></div>`; }).join('');
  return `<div class="convo"><div class="weeknav" style="margin-bottom:8px"><button class="btn sm" data-closechat>‹ Back</button><div><b>${esc(convName())}</b></div><span style="width:44px"></span></div>
    <div class="msgs" id="msgs">${body || '<div class="empty">Say hello 👋</div>'}</div>
    <form class="composer" data-form="send"><textarea name="text" rows="1" maxlength="2000" placeholder="Message" aria-label="Message">${esc(chat.compose)}</textarea><button class="btn go" ${chat.sending ? 'disabled' : ''}>Send</button></form></div>`;
}
async function openChat(id, name, text){
  chat.open = id; chat.dmName = name || chat.dmName; if (text === undefined) { chat.msgs = chat.msgs && chat.loaded === id ? chat.msgs : []; }
  render(); scrollChat();
  try {
    const r = await post({ fn: 'chat', token: TOKEN, channel: id, text });
    if (chat.open !== id) return;
    chat.msgs = r.messages; chat.me = r.me; chat.loaded = id; data.channels = r.channels; save('pt-cache', JSON.stringify(data));
    const near = isNearBottom(); render(); if (near || text !== undefined) scrollChat();
  } catch (e) { const m = String(e.message || e); if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, '')); if (text !== undefined) { chat.compose = text; toast('Not sent: ' + m); render(); } }
  clearTimeout(chat.timer); chat.timer = setTimeout(() => { if (chat.open === id && tab === 'chat' && !document.hidden) openChat(id); }, 7000);
}
function stopChat(){ clearTimeout(chat.timer); chat.open = ''; }
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
    l.file ? rowBtn(`data-pdf="${esc(l.id)}"`, `<div class="txt"><b>${esc(l.name)}</b><div class="sub">Opens in the app</div></div><span>›</span>`) : `<a class="row" href="${esc(l.url)}" target="_blank" rel="noopener" style="text-decoration:none"><div class="txt"><b>${esc(l.name)}</b></div><span>↗</span></a>`).join('')}</div>` : ''; }).join('') || '<div class="card"><div class="empty">No resources yet.</div></div>'}`;
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
function viewTests(){
  const ts = data.tests || [];
  const row = t => { const st = t.passed ? '<span class="pill ok">Passed</span>' : t.last ? `<span class="pill warn">${esc(t.last.result || 'Not yet')} ${esc(t.last.score)}/${esc(t.last.outOf)}</span>` : !t.unlocked ? '<span class="pill mute">Locked</span>' : '';
    return `<div class="row" style="display:block"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(t.name)}</b>${st}</div>
      <div class="sub">${!t.unlocked ? 'Pass ' + esc(t.need) + ' first' : t.taken ? 'Taken ' + t.taken + ' time' + (t.taken > 1 ? 's' : '') + (t.last && t.last.when ? ' · last ' + ago(t.last.when) : '') : 'Not taken yet'}</div>
      ${t.unlocked && t.url ? `<div class="btns" style="margin-top:8px"><a class="btn sm ${t.passed ? '' : 'go'}" href="${esc(t.url)}" target="_blank" rel="noopener">${t.passed ? 'Retake' : 'Take the test'} ↗</a></div>` : t.unlocked && !t.url ? '<div class="sub">The link isn\'t set up yet – ask a manager.</div>' : ''}</div>`; };
  return `${back()}<h1>Training & tests</h1><div class="card">${ts.map(row).join('') || '<div class="empty">No tests set up.</div>'}</div>
    <p class="sub">Tests open in your browser. Use your first and last name exactly as you sign in. Results show here a minute after you submit – pull down or tap ↻.</p>`;
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
      <div class="btns"><button class="btn go">${u ? 'Save' : 'Add to the team'}</button>${u ? '<button type="button" class="btn" data-canceledit>Cancel</button>' : ''}</div></form>`;
  const row = u => editUser === u.id ? `<div class="row" style="display:block;padding:0">${form(u)}</div>` : `<div class="row" style="display:block;${u.active ? '' : 'opacity:.55'}">
      <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(u.name)}</b><span class="pill ${u.role === 'Manager' ? 'warn' : u.role === 'Lead' ? 'ok' : 'mute'}">${esc(u.role)}</span>${u.active ? '' : '<span class="pill mute">Off</span>'}</div>
      <div class="sub">${u.phone ? esc(u.phone) + ' · ' : ''}Code ${showCode[u.id] ? `<b>${esc(u.code)}</b>` : '••••'} <button class="btn sm" data-showcode="${esc(u.id)}" style="padding:4px 8px;min-height:0">${showCode[u.id] ? 'Hide' : 'Show'}</button></div>
      <div class="btns" style="margin-top:8px"><button class="btn sm" data-edit="${esc(u.id)}">Edit</button><button class="btn sm" data-newcode="${esc(u.id)}" data-name="${esc(u.name)}">New code</button>
        <button class="btn sm" data-active="${esc(u.id)}" data-to="${u.active ? 0 : 1}" data-name="${esc(u.name)}">${u.active ? 'Turn off' : 'Turn on'}</button></div></div>`;
  return `${back()}<h1>Team</h1>${addedCard}<div class="card">${us.map(row).join('')}</div>
    <h2>Add someone</h2><div class="card">${form(null)}</div>
    <p class="sub">Turning someone off or giving a new code signs them out on every phone right away. Everything here is also on the Users tab of the sheet.</p>`;
}

function viewMore(){
  const views = { requests: viewRequests, avail: viewAvail, time: viewTime, news: viewNews, resources: viewResources, tests: viewTests, team: () => mgr() ? viewTeam() : viewMoreList() };
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
      ${item('resources', 'Resources', 'Recipes, guides, handbooks')}
      ${item('tests', 'Training & tests', 'Certification tests and your results')}
      ${mgr() ? item('team', 'Team & sign-in codes') : ''}</div>
    <h2>Look</h2><div class="seg">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, n]) => `<button data-theme="${k}" aria-pressed="${theme() === k}">${n}</button>`).join('')}</div>
    <h2>${esc(data.me.name)} · ${esc(data.me.role)}</h2><div class="card"><div class="row"><div class="txt sub">Signed in on this phone.${!standalone() ? ' Tip: add this app to your home screen.' : ''}</div><button class="btn sm" data-signout>Sign out</button></div></div>
    <p class="sub" style="text-align:center">Peregrine Team · server ${esc(data.version || '')}</p>`;
}

const TABS = [['today', 'Today', '☀︎'], ['schedule', 'Schedule', '▦'], ['chat', 'Chat', '✉︎'], ['lists', 'Lists', '✓'], ['more', 'More', '☰']];
function render(){
  $('#offline').hidden = !offline;
  if (!TOKEN || !data){ $('#tabs').hidden = true; $('#refresh').hidden = true; $('#overlay').innerHTML = ''; $('#shop').textContent = load('pt-shop') || 'Peregrine'; $('#main').innerHTML = TOKEN ? '<div class="empty">Loading…</div>' : viewSignIn(); return; }
  data.meId = data.me.id;
  const short = String(data.name || 'Peregrine').replace(/\s+(coffee|roasters?|roastery|co\.?)\b.*$/i, '') || data.name; $('#shop').textContent = short; save('pt-shop', short); $('#refresh').hidden = false;
  const gate = mustRead();
  if (gate.length){ $('#tabs').hidden = true; $('#overlay').innerHTML = ''; $('#main').innerHTML = viewMustRead(gate[0], gate.length); return; }
  const chatN = (data.channels || []).reduce((n, c) => n + c.unread, 0);
  const badge = { chat: chatN, more: (mgr() ? (data.requests || []).filter(q => q.status === 'Pending' && q.from !== data.me.name).length : 0) + (data.announcements || []).filter(a => !a.read).length };
  $('#tabs').hidden = false;
  $('#tabs').innerHTML = TABS.map(([k, n, ic]) => `<button data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${n}${badge[k] ? `<span class="n">${badge[k]}</span>` : ''}</button>`).join('');
  const typingIn = document.activeElement && document.activeElement.closest && document.activeElement.closest('.composer');
  const draft = typingIn ? document.activeElement.value : null;
  $('#main').innerHTML = tab === 'lists' ? viewLists() : tab === 'schedule' ? viewSchedule() : tab === 'chat' ? viewChat() : tab === 'more' ? viewMore() : viewToday();
  if (draft !== null){ const t = $('.composer textarea'); if (t){ t.value = draft; t.focus(); } }
  $('#overlay').innerHTML = viewer ? viewViewer() : sheet ? (sheet.kind === 'shift' ? shiftSheet() : sheet.kind === 'punch' ? punchSheet() : pickSheet(sheet.kind)) : '';
  document.body.classList.toggle('noscroll', !!(viewer || sheet));
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
  const b = e.target.closest('button, a[data-x]'); if (!b) return;
  const d = b.dataset;
  if (b.id === 'refresh'){ if (chat.open) { openChat(chat.open); return; } refresh().then(r => { if (r) toast('Up to date'); }); return; }
  if (d.install !== undefined && installEvt){ installEvt.prompt(); installEvt = null; return; }
  if (d.ack){ const a = data.announcements.find(x => x.id === d.ack); if (a) a.read = true; render(); act('read', { id: d.ack }); return; }
  if (d.tab){ tab = d.tab; save('pt-tab', tab); if (tab === 'more') moreView = ''; if (tab !== 'chat') stopChat(); window.scrollTo(0, 0); render(); if (tab === 'schedule') scrollToday(); return; }
  if (d.golist){ listTab = d.golist; tab = 'lists'; save('pt-tab', tab); window.scrollTo(0, 0); render(); return; }
  if (d.more !== undefined){ tab = 'more'; moreView = d.more; editUser = null; if (d.more !== 'time') tsPerson = ''; if (d.more === 'time' && b.textContent.includes('Back')) tsPerson = ''; window.scrollTo(0, 0); render(); return; }
  if (d.list){ listTab = d.list; render(); return; }
  if (d.theme){ setTheme(d.theme); render(); return; }
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
  if (d.closeviewer !== undefined){ viewer = null; render(); return; }
  if (d.pdf){ openPdf(d.pdf); return; }
  if (d.openchat){ openChat(d.openchat); return; }
  if (d.closechat !== undefined){ stopChat(); render(); return; }
  if (d.newdm !== undefined){ sheet = { kind: 'dm' }; render(); return; }
  if (d.newgroup !== undefined){ sheet = { kind: 'group' }; render(); return; }
  if (d.newchannel !== undefined){ sheet = { kind: 'channel' }; render(); return; }
  if (d.dm){ sheet = null; const id = 'dm-' + [data.meId, d.dm].sort().join('-'); chat.msgs = []; openChat(id, d.dmname); return; }
  if (d.preset){ const [s, en] = d.preset.split('|'), f = b.closest('form'); f.elements.namedItem('start').value = s; f.elements.namedItem('end').value = en; return; }
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
  if (d.addshift){ sheet = { kind: 'shift', date: d.addshift, name: '', start: (data.presets[0] || {}).start, end: (data.presets[0] || {}).end }; render(); return; }
  if (d.editshift){ const s = data.shifts.find(x => x.id === d.editshift); if (s) { sheet = Object.assign({ kind: 'shift' }, s); render(); } return; }
  if (d.delshift){ if (!confirm('Delete this shift?')) return; data.shifts = data.shifts.filter(s => s.id !== d.delshift); sheet = null; render(); act('deleteShift', { id: d.delshift }); return; }
  if (d.copyweek !== undefined){ if (!confirm('Copy last week\'s shifts into this week? Shifts already here stay; exact duplicates are skipped.')) return; act('copyWeek', { from: plus(week, -7), to: week }).then(r => { if (r) toast('Copied'); }); return; }
  if (d.clearweek !== undefined){ if (!confirm('Delete every shift this week?')) return; act('clearWeek', { from: week }).then(r => { if (r) toast('Week cleared'); }); return; }
  if (d.delavail){ data.availability = data.availability.filter(a => a.id !== d.delavail); render(); act('delAvail', { id: d.delavail }); return; }
  if (d.editpunch !== undefined){ sheet = { kind: 'punch', id: d.editpunch, date: d.pdate, name: d.pname || tsPerson, start: d.pstart, end: d.pend }; render(); return; }
  if (d.delpunch){ if (!confirm('Delete this punch?')) return; sheet = null; act('deletePunch', { id: d.delpunch }); return; }
  if (d.delmsg){ if (!confirm('Delete this message?')) return; chat.msgs = chat.msgs.filter(m => m.id !== d.delmsg); render(); await act('deleteMessage', { id: d.delmsg }); openChat(chat.open); return; }
  if (d.newcode){ if (!confirm('Give ' + d.name + ' a new code? Their old code stops working and they are signed out everywhere.')) return; showCode[d.newcode] = true; act('newCode', { id: d.newcode }).then(r => { if (r) toast('New code made – tell ' + first(d.name)); }); return; }
  if (d.active){ if (d.to === '0' && !confirm('Turn off ' + d.name + '? They are signed out right away and cannot sign in.')) return; act('setActive', { id: d.active, active: d.to }); return; }
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
  if (kind === 'send'){ const text = f.elements.namedItem('text').value.trim(); if (!text) return;
    chat.compose = ''; chat.msgs = (chat.msgs || []).concat({ id: 'tmp', fromId: chat.me || data.meId, from: data.me.name, at: new Date().toISOString(), text }); render(); scrollChat();
    const t = $('.composer textarea'); if (t) t.focus(); openChat(chat.open, null, text); return; }
  if (kind === 'shift'){ if (!v('name')){ toast('Pick who is working'); return; } const p = { id: sheet && sheet.id || '', name: v('name'), date: v('date'), start: v('start'), end: v('end'), position: v('position'), notes: v('notes') };
    if (p.end <= p.start){ toast('The end has to be after the start'); return; }
    sheet = null; act('saveShift', p).then(r => { if (r) toast(p.id ? 'Shift saved' : 'Shift added'); }); return; }
  if (kind === 'punch'){ const p = { id: sheet && sheet.id || '', name: v('name'), date: v('date'), in: v('in'), out: v('out'), note: v('note') }; sheet = null; act('savePunch', p).then(r => { if (r) toast('Saved'); }); return; }
  if (kind === 'avail'){ const day = v('day') === 'date' ? v('date') : v('day'); if (!day){ toast('Pick a date'); return; } act('addAvail', { day, from: v('from'), to: v('to'), note: v('note') }).then(r => { if (r) toast('Added'); }); f.reset(); return; }
  if (kind === 'group'){ const members = [...f.querySelectorAll('input[name=m]:checked')].map(x => x.value).join(','); sheet = null; act('newChannel', { kind: 'group', name: v('name'), members }).then(r => { if (r) toast('Group made'); }); return; }
  if (kind === 'channel'){ sheet = null; act('newChannel', { kind: 'channel', name: v('name'), who: v('who') }).then(r => { if (r) toast('Channel made'); }); return; }
  if (kind === 'announce'){ if (!v('title')){ toast('Add a title'); return; } act('announce', { title: v('title'), message: f.elements.namedItem('message').value, pinned: v('pinned'), mustAck: v('mustAck') }).then(r => { if (r) toast('Posted'); }); f.reset(); return; }
  if (kind === 'request'){ act('request', { type: v('type'), date: v('date'), details: v('details') }).then(r => { if (r) toast('Sent to managers'); }); f.reset(); return; }
  if (kind === 'user'){
    if (!v('name')){ toast('Add a name'); return; }
    const p = { name: v('name'), role: v('role'), phone: v('phone'), email: v('email') };
    if (f.dataset.id){ editUser = null; act('editUser', Object.assign({ id: f.dataset.id }, p)).then(r => { if (r) toast('Saved'); }); }
    else { act('addUser', p).then(r => { if (r){ justAdded = p.name; render(); window.scrollTo(0, 0); } }); f.reset(); }
  }
});

const typing = () => { const a = document.activeElement; return a && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };
document.addEventListener('visibilitychange', () => { if (document.hidden || !TOKEN) return; if (chat.open && tab === 'chat') openChat(chat.open); else if (!pending && !typing() && !sheet) refresh(); });
setInterval(() => { if (!document.hidden && TOKEN && !pending && !typing() && !sheet && !viewer && !chat.open) refresh(); }, 90000);
window.addEventListener('online', () => { if (TOKEN) refresh(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (!TOKEN) render(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

if (theme() !== 'auto') setTheme(theme());
render();
if (TOKEN) refresh();
