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
function signOut(msg){ TOKEN = ''; data = null; save('pt-token', null); save('pt-cache', null); render(); if (msg) toast(msg.charAt(0).toUpperCase() + msg.slice(1)); }

/* ---------- formatting ---------- */
const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const plus = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const T = () => data ? data.today : '';
const dayName = s => s === T() ? 'Today' : s === plus(T(), 1) ? 'Tomorrow' : pd(s).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const t12 = hm => { if (!hm) return ''; let [h, m] = hm.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + (m ? ':' + String(m).padStart(2, '0') : '') + ap; };
const ago = iso => { if (!iso) return ''; const m = Math.round((Date.now() - new Date(iso)) / 6e4); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const timeOf = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase() : '';
const mgr = () => data && data.me.role === 'Manager', lead = () => data && (data.me.role === 'Lead' || mgr());
function toast(m){ const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => t.style.display = 'none', 3200); }

/* ---------- screens ---------- */
function viewSignIn(){
  const hint = !standalone() ? (isIOS()
    ? `<div class="hint"><b>Put it on your home screen:</b> tap <b>Share</b> <span aria-hidden="true">⬆︎</span> at the bottom of Safari, then <b>Add to Home Screen</b>. Open it from there and sign in.</div>`
    : installEvt ? `<div class="hint"><b>Install the app</b> for one-tap access. <button class="btn sm go" data-install>Install</button></div>`
    : `<div class="hint"><b>Put it on your home screen:</b> in Chrome, tap <b>⋮</b> then <b>Add to Home screen</b> (or <b>Install app</b>).</div>`) : '';
  return `<div class="signin"><img class="logo" src="icons/icon-192.png" alt=""><p class="big">${esc((data && data.name) || load('pt-shop') || 'Peregrine')}</p><p class="sub" style="text-align:center;margin:0 0 18px">Team sign-in</p>
    ${hint}<div class="card"><form class="stack" data-form="signin">
      <label class="f">First name<input name="name" autocomplete="username" autocapitalize="words" spellcheck="false" maxlength="60" value="${esc(load('pt-last') || '')}"></label>
      <label class="f">4-digit code<input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="current-password" class="code" style="text-align:center"></label>
      <button class="btn go">Sign in</button></form></div>
    <p class="sub" style="text-align:center">Don't know your code? Ask a manager.</p></div>`;
}

function myNextShift(){ return (data.shifts || []).find(s => s.name === data.me.name && (s.date > T() || s.end >= new Date().toTimeString().slice(0, 5))); }

function viewToday(){
  const d = data, today = (d.shifts || []).filter(s => s.date === T()), next = myNextShift();
  const unread = (d.announcements || []).filter(a => !a.read);
  const pendingReq = mgr() ? (d.requests || []).filter(q => q.status === 'Pending') : [];
  const mine = (d.requests || []).filter(q => q.from === d.me.name && q.status !== 'Cancelled').slice(0, 3);
  const hour = new Date().getHours(), hi = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `<h1>${hi}, ${esc(d.me.name.split(' ')[0])}</h1>
    ${unread.length ? `<div class="card">${unread.slice(0, 3).map(annRow).join('')}</div>` : ''}
    <h2>Your next shift</h2><div class="card">${next ? `<div class="row mine"><div class="txt"><b>${dayName(next.date)}</b> · ${t12(next.start)}–${t12(next.end)}<div class="sub">${esc(next.position || '')}${next.notes ? ' · ' + esc(next.notes) : ''}</div></div></div>` : '<div class="empty">No shifts on the schedule.</div>'}</div>
    <h2>Working today</h2><div class="card">${today.length ? today.map(s => `<div class="row ${s.name === d.me.name ? 'mine' : ''}"><div class="txt"><b>${esc(s.name)}</b><div class="sub">${t12(s.start)}–${t12(s.end)}${s.position ? ' · ' + esc(s.position) : ''}</div></div></div>`).join('') : '<div class="empty">Nobody scheduled today.</div>'}</div>
    <h2>Checklists</h2><div class="card">${(d.checklists || []).map(c => `<button class="row" data-golist="${esc(c.list)}" style="all:unset;display:flex;width:100%;box-sizing:border-box;padding:12px 14px;border-top:1px solid var(--soft);cursor:pointer"><div class="txt"><b>${esc(c.list)}</b><div class="progress"><i style="width:${c.total ? Math.round(c.done / c.total * 100) : 0}%"></i></div></div><span class="pill ${c.done === c.total && c.total ? 'ok' : 'mute'}">${c.done}/${c.total}</span></button>`).join('') || '<div class="empty">No checklists yet.</div>'}</div>
    ${pendingReq.length ? `<h2>Waiting on you</h2><div class="card"><button class="row" data-more="requests" style="all:unset;display:flex;width:100%;box-sizing:border-box;padding:12px 14px;cursor:pointer"><div class="txt"><b>${pendingReq.length} request${pendingReq.length > 1 ? 's' : ''}</b> to approve</div><span>›</span></button></div>` : ''}
    ${mine.length ? `<h2>Your requests</h2><div class="card">${mine.map(reqRow).join('')}</div>` : ''}`;
}

function viewLists(){
  const cl = data.checklists || [];
  if (!cl.length) return '<h1>Checklists</h1><div class="card"><div class="empty">A manager can add tasks on the Checklists tab of the sheet.</div></div>';
  if (!cl.some(c => c.list === listTab)) listTab = (cl.find(c => c.done < c.total) || cl[0]).list;
  const c = cl.find(x => x.list === listTab);
  const hist = lead() && data.history ? `<h2>Last 7 days</h2><div class="card">${data.history.map(h => { const miss = h.lists.reduce((n, l) => n + (l.total - l.done), 0);
      return `<div class="row"><div class="txt"><b>${dayName(h.date)}</b><div class="sub">${h.lists.map(l => esc(l.list) + ' ' + l.done + '/' + l.total).join(' · ')}</div>${miss ? `<details class="more"><summary>${miss} missed</summary><div class="sub">${h.lists.filter(l => l.missed.length).map(l => '<b>' + esc(l.list) + ':</b> ' + l.missed.map(esc).join(', ')).join('<br>')}</div></details>` : ''}</div><span class="pill ${miss ? 'warn' : 'ok'}">${miss ? 'Missed ' + miss : 'All done'}</span></div>`; }).join('')}</div>` : '';
  return `<h1>Checklists</h1><div class="seg">${cl.map(x => `<button data-list="${esc(x.list)}" aria-pressed="${x.list === listTab}">${esc(x.list)} ${x.done}/${x.total}</button>`).join('')}</div>
    <div class="card">${c.items.map((i, n) => { const k = 'c|' + c.list + '|' + i.task, on = busy[k] !== undefined ? busy[k] : !!i.by;
      const head = i.section && (n === 0 || c.items[n - 1].section !== i.section) ? `<div class="sec">${esc(i.section)}</div>` : '';
      return head + `<div class="row ${on ? 'done' : ''}"><button class="chk ${on ? 'on' : ''}" data-check="${esc(i.task)}" data-on="${on ? 1 : 0}" aria-label="${on ? 'Undo' : 'Done'}: ${esc(i.task)}">${on ? '✓' : ''}</button>
        <div class="txt"><b>${esc(i.task)}</b>${i.notes ? `<div class="sub">${esc(i.notes)}</div>` : ''}${i.by ? `<div class="sub">${esc(i.by)} · ${timeOf(i.at)}</div>` : ''}</div></div>`; }).join('')}</div>${hist}`;
}

function viewSchedule(){
  const all = data.shifts || [], shown = schedMine ? all.filter(s => s.name === data.me.name) : all, days = {};
  shown.forEach(s => (days[s.date] = days[s.date] || []).push(s));
  const add = mgr() ? `<h2>Add a shift</h2><div class="card"><form class="stack" data-form="shift">
      <label class="f">Who<select name="name">${(data.team || []).map(n => `<option>${esc(n)}</option>`).join('')}</select></label>
      <label class="f">Date<input name="date" type="date" value="${T()}"></label>
      <div class="two"><label class="f">Start<input name="start" type="time" value="07:00"></label><label class="f">End<input name="end" type="time" value="13:00"></label></div>
      ${(data.positions || []).length ? `<label class="f">Position<select name="position"><option value=""></option>${data.positions.map(p => `<option>${esc(p)}</option>`).join('')}</select></label>` : ''}
      <button class="btn go">Add shift</button></form></div>` : '';
  return `<h1>Schedule</h1><div class="seg"><button data-mine="0" aria-pressed="${!schedMine}">Everyone</button><button data-mine="1" aria-pressed="${schedMine}">My shifts</button></div>
    ${Object.keys(days).sort().map(d => `<h2>${dayName(d)}</h2><div class="card">${days[d].map(s => `<div class="row ${s.name === data.me.name ? 'mine' : ''}"><div class="txt"><b>${esc(s.name)}</b><div class="sub">${t12(s.start)}–${t12(s.end)}${s.position ? ' · ' + esc(s.position) : ''}${s.notes ? ' · ' + esc(s.notes) : ''}</div></div>
      ${mgr() ? `<button class="btn sm" data-delshift="${esc(s.date)}|${esc(s.start)}|${esc(s.name)}" aria-label="Remove shift">✕</button>` : ''}</div>`).join('')}</div>`).join('') || '<div class="card"><div class="empty">Nothing on the schedule yet.</div></div>'}
    <div class="btns" style="margin-top:8px"><button class="btn" data-more="requests">Request time off or a swap</button></div>${add}`;
}

function annRow(a){
  return `<div class="row" style="display:block"><div style="display:flex;gap:8px;align-items:baseline"><b style="flex:1">${a.pinned ? '📌 ' : ''}${esc(a.title)}</b><span class="sub">${ago(a.posted)}</span></div>
    ${a.message ? `<div class="msg">${esc(a.message)}</div>` : ''}<div class="sub">From ${esc(a.from)}</div>
    <div class="btns" style="margin-top:8px">${a.read ? '<span class="pill ok">Seen</span>' : `<button class="btn sm go" data-read="${esc(a.id)}">Got it</button>`}
      ${lead() && a.notRead ? `<span class="sub" style="align-self:center">${a.notRead.length ? 'Not seen: ' + a.notRead.map(esc).join(', ') : 'Everyone has seen it'}</span>` : ''}
      ${lead() ? `<button class="btn sm" data-unann="${esc(a.id)}">Remove</button>` : ''}</div></div>`;
}
function viewNews(){
  const post = lead() ? `<h2>Post an announcement</h2><div class="card"><form class="stack" data-form="announce"><label class="f">Title<input name="title" maxlength="150"></label>
      <label class="f">Message<textarea name="message" maxlength="3000"></textarea></label><label style="display:flex;gap:8px;align-items:center;font-size:.9rem"><input type="checkbox" name="pinned" style="width:auto;min-height:0"> Pin to the top</label><button class="btn go">Post</button></form></div>` : '';
  return `<h1>Announcements</h1><div class="card">${(data.announcements || []).map(annRow).join('') || '<div class="empty">No announcements.</div>'}</div>${post}`;
}

function reqRow(q){
  const cls = q.status === 'Approved' ? 'ok' : q.status === 'Denied' ? 'warn' : 'mute';
  return `<div class="row" style="display:block"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(q.type)} · ${q.date ? dayName(q.date) : ''}</b><span class="pill ${cls}">${esc(q.status)}</span></div>
    <div class="sub">${mgr() && q.from !== data.me.name ? esc(q.from) + ' · ' : ''}${esc(q.details)}${q.note ? ' — ' + esc(q.by) + ': ' + esc(q.note) : ''}</div>
    ${q.status === 'Pending' && mgr() && q.from !== data.me.name ? `<div class="btns" style="margin-top:8px"><button class="btn sm go" data-decide="${esc(q.id)}" data-ok="1">Approve</button><button class="btn sm" data-decide="${esc(q.id)}" data-ok="0">Deny</button></div>` : ''}
    ${q.status === 'Pending' && q.from === data.me.name ? `<div class="btns" style="margin-top:8px"><button class="btn sm" data-cancelreq="${esc(q.id)}">Cancel request</button></div>` : ''}</div>`;
}
function viewRequests(){
  const all = data.requests || [], pend = mgr() ? all.filter(q => q.status === 'Pending' && q.from !== data.me.name) : [];
  const mine = all.filter(q => q.from === data.me.name), others = mgr() ? all.filter(q => q.status !== 'Pending' && q.from !== data.me.name) : [];
  return `${back()}<h1>Requests</h1>
    ${mgr() ? `<h2>Waiting for you</h2><div class="card">${pend.map(reqRow).join('') || '<div class="empty">Nothing to approve.</div>'}</div>` : ''}
    <h2>New request</h2><div class="card"><form class="stack" data-form="request">
      <label class="f">What<select name="type"><option>Time off</option><option>Swap</option><option>Cover</option></select></label>
      <label class="f">Date<input name="date" type="date" min="${T()}" value="${plus(T(), 1)}"></label>
      <label class="f">Details<textarea name="details" maxlength="1000" placeholder="e.g. Swap my Saturday open with Maya"></textarea></label><button class="btn go">Send to managers</button></form></div>
    <h2>Yours</h2><div class="card">${mine.map(reqRow).join('') || '<div class="empty">No requests.</div>'}</div>
    ${others.length ? `<h2>Recently decided</h2><div class="card">${others.map(reqRow).join('')}</div>` : ''}`;
}

const back = () => `<button class="btn sm" data-more="" style="margin-bottom:6px">‹ More</button>`;
function viewTeam(){
  const us = (data.users || []).slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  const added = justAdded && us.find(u => u.name === justAdded);
  const addedCard = added ? `<div class="hint"><b>${esc(added.name)} is on the team.</b> Their code is <span class="code">${esc(added.code)}</span><br>Send them the app link and this code.
      <div class="btns" style="margin-top:8px">${added.phone ? `<a class="btn sm go" href="sms:${esc(added.phone.replace(/[^\d+]/g, ''))}${isIOS() ? '&' : '?'}body=${encodeURIComponent('Peregrine team app: ' + location.href.split('#')[0] + '\nFirst name: ' + added.name.split(' ')[0] + '\nCode: ' + added.code + '\nOpen it, then add it to your home screen.')}">Text it</a>` : ''}<button class="btn sm" data-dismiss>Done</button></div></div>` : '';
  const form = u => `<form class="stack" data-form="user" ${u ? `data-id="${esc(u.id)}"` : ''}>
      <label class="f">Name<input name="name" maxlength="60" value="${esc(u ? u.name : '')}" placeholder="First name (add an initial if two share it)"></label>
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
  if (moreView === 'requests') return viewRequests();
  if (moreView === 'team' && mgr()) return viewTeam();
  const pendN = mgr() ? (data.requests || []).filter(q => q.status === 'Pending' && q.from !== data.me.name).length : 0;
  const item = (k, label, extra) => `<button class="row" data-more="${k}" style="all:unset;display:flex;width:100%;box-sizing:border-box;padding:14px;border-top:1px solid var(--soft);cursor:pointer;min-height:52px"><div class="txt"><b>${label}</b></div>${extra || ''}<span>›</span></button>`;
  return `<h1>More</h1><div class="card">${item('requests', 'Requests', pendN ? `<span class="pill warn" style="margin-right:8px">${pendN}</span>` : '')}${mgr() ? item('team', 'Team & sign-in codes') : ''}</div>
    ${(data.links || []).length ? `<h2>Links</h2><div class="card">${data.links.map(l => `<a class="row" href="${esc(l.url)}" target="_blank" rel="noopener" style="text-decoration:none"><div class="txt"><b>${esc(l.name)}</b></div><span>↗</span></a>`).join('')}</div>` : ''}
    <h2>${esc(data.me.name)} · ${esc(data.me.role)}</h2><div class="card"><div class="row"><div class="txt sub">Signed in on this phone.${!standalone() ? ' Tip: add this app to your home screen.' : ''}</div><button class="btn sm" data-signout>Sign out</button></div></div>
    <p class="sub" style="text-align:center">Peregrine Team · server ${esc(data.version || '')}</p>`;
}

const TABS = [['today', 'Today', '☀︎'], ['lists', 'Lists', '✓'], ['schedule', 'Schedule', '▦'], ['news', 'News', '✉︎'], ['more', 'More', '☰']];
function render(){
  $('#offline').hidden = !offline;
  if (!TOKEN || !data){ $('#tabs').hidden = true; $('#refresh').hidden = true; $('#shop').textContent = load('pt-shop') || 'Peregrine'; $('#main').innerHTML = TOKEN ? '<div class="empty">Loading…</div>' : viewSignIn(); return; }
  $('#shop').textContent = data.name; save('pt-shop', data.name); $('#refresh').hidden = false;
  const badge = { today: 0, lists: (data.checklists || []).reduce((n, c) => n + (c.total - c.done), 0), news: (data.announcements || []).filter(a => !a.read).length,
    more: mgr() ? (data.requests || []).filter(q => q.status === 'Pending' && q.from !== data.me.name).length : 0, schedule: 0 };
  badge.lists = 0;   // a full list of to-dos isn't "news"; keep the dot for things that need you
  $('#tabs').hidden = false;
  $('#tabs').innerHTML = TABS.map(([k, n, ic]) => `<button data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${n}${badge[k] ? `<span class="n">${badge[k]}</span>` : ''}</button>`).join('');
  $('#main').innerHTML = tab === 'lists' ? viewLists() : tab === 'schedule' ? viewSchedule() : tab === 'news' ? viewNews() : tab === 'more' ? viewMore() : viewToday();
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('button, a[data-x]'); if (!b) return;
  const d = b.dataset;
  if (b.id === 'refresh'){ refresh().then(r => { if (r) toast('Up to date'); }); return; }
  if (d.install !== undefined && installEvt){ installEvt.prompt(); installEvt = null; return; }
  if (d.tab){ tab = d.tab; save('pt-tab', tab); if (tab === 'more') moreView = ''; window.scrollTo(0, 0); render(); return; }
  if (d.golist){ listTab = d.golist; tab = 'lists'; save('pt-tab', tab); window.scrollTo(0, 0); render(); return; }
  if (d.more !== undefined){ tab = 'more'; moreView = d.more; editUser = null; window.scrollTo(0, 0); render(); return; }
  if (d.list){ listTab = d.list; render(); return; }
  if (d.mine !== undefined){ schedMine = d.mine === '1'; save('pt-mine', schedMine ? '1' : '0'); render(); return; }
  if (d.signout !== undefined){ if (confirm('Sign out on this phone?')) signOut(); return; }
  if (d.showcode){ showCode[d.showcode] = !showCode[d.showcode]; render(); return; }
  if (d.edit){ editUser = d.edit; render(); return; }
  if (d.canceledit !== undefined){ editUser = null; render(); return; }
  if (d.dismiss !== undefined){ justAdded = null; render(); return; }
  if (!data) return;
  if (d.check){
    const on = d.on !== '1', k = 'c|' + listTab + '|' + d.check; busy[k] = on; render();
    if (on && navigator.vibrate) navigator.vibrate(10);
    act('check', { list: listTab, task: d.check, done: on ? '1' : '0' }); return;
  }
  if (d.read){ const a = data.announcements.find(x => x.id === d.read); if (a) a.read = true; render(); act('read', { id: d.read }); return; }
  if (d.unann){ if (!confirm('Remove this announcement for everyone?')) return; data.announcements = data.announcements.filter(x => x.id !== d.unann); render(); act('unannounce', { id: d.unann }); return; }
  if (d.decide){ const note = d.ok === '1' ? '' : (prompt('Reason (optional) – they will see it') || ''); act('decide', { id: d.decide, approve: d.ok, note }).then(r => { if (r) toast(d.ok === '1' ? 'Approved' : 'Denied'); }); return; }
  if (d.cancelreq){ act('cancelRequest', { id: d.cancelreq }); return; }
  if (d.delshift){ const [date, start, name] = d.delshift.split('|'); if (!confirm('Remove ' + name + '\'s shift on ' + dayName(date) + '?')) return; data.shifts = data.shifts.filter(s => !(s.date === date && s.start === start && s.name === name)); render(); act('deleteShift', { date, start, name }); return; }
  if (d.newcode){ if (!confirm('Give ' + d.name + ' a new code? Their old code stops working and they are signed out everywhere.')) return; showCode[d.newcode] = true; act('newCode', { id: d.newcode }).then(r => { if (r) toast('New code made – tell ' + d.name.split(' ')[0]); }); return; }
  if (d.active){ if (d.to === '0' && !confirm('Turn off ' + d.name + '? They are signed out right away and cannot sign in.')) return; act('setActive', { id: d.active, active: d.to }); return; }
});

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
  if (kind === 'shift'){ act('addShift', { name: v('name'), date: v('date'), start: v('start'), end: v('end'), position: v('position') }).then(r => { if (r) toast('Shift added'); }); return; }
  if (kind === 'announce'){ if (!v('title')){ toast('Add a title'); return; } act('announce', { title: v('title'), message: f.elements.namedItem('message').value, pinned: v('pinned') }).then(r => { if (r) toast('Posted'); }); f.reset(); return; }
  if (kind === 'request'){ act('request', { type: v('type'), date: v('date'), details: v('details') }).then(r => { if (r) toast('Sent to managers'); }); f.reset(); return; }
  if (kind === 'user'){
    if (!v('name')){ toast('Add a name'); return; }
    const p = { name: v('name'), role: v('role'), phone: v('phone'), email: v('email') };
    if (f.dataset.id){ editUser = null; act('editUser', Object.assign({ id: f.dataset.id }, p)).then(r => { if (r) toast('Saved'); }); }
    else { act('addUser', p).then(r => { if (r){ justAdded = p.name; render(); window.scrollTo(0, 0); } }); f.reset(); }
  }
});

const typing = () => { const a = document.activeElement; return a && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && TOKEN && !pending && !typing()) refresh(); });
setInterval(() => { if (!document.hidden && TOKEN && !pending && !typing()) refresh(); }, 120000);
window.addEventListener('online', () => { if (TOKEN) refresh(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (!TOKEN) render(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

render();
if (TOKEN) refresh();
