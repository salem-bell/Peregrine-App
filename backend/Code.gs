/**
 * Peregrine Team – server (Google Apps Script, bound to the "Peregrine Team" Google Sheet).
 *
 * The phone app (salem-bell.github.io/Peregrine-App) talks to this script. All data lives in the Sheet.
 *
 * Install:
 *  1. In the Sheet: Extensions › Apps Script. Replace Code.gs with this file. Save.
 *  2. Reload the Sheet, then menu Team › 1. Set up (approve the permissions).
 *  3. Deploy › New deployment › Web app. Execute as: Me. Who has access: Anyone. Deploy.
 *  4. Copy the Web app URL (ends in /exec) into Settings › Server address.
 *  Later updates: paste the new Code.gs, then Deploy › Manage deployments › pencil › New version.
 */

const VERSION = '1.1';
const ROLES = ['Manager', 'Lead', 'Staff'];

const TABS = {
  'Users':         ['Name', 'Role', 'Code', 'Active', 'Phone', 'Email', 'User ID (do not edit)', 'Sign-in version (do not edit)', 'Added'],
  'Checklists':    ['List', 'Task', 'Order', 'Active', 'Notes', 'Days (blank = every day)', 'Section'],
  'Checklist log': ['Date', 'List', 'Task', 'Done by', 'Done at'],
  'Announcements': ['ID', 'Posted', 'From', 'Title', 'Message', 'Pinned', 'Active'],
  'Reads':         ['Announcement ID', 'Name', 'Read at'],
  'Shifts':        ['Date', 'Start', 'End', 'Name', 'Position', 'Notes'],
  'Requests':      ['ID', 'Created', 'From', 'Type', 'Date', 'Details', 'Status', 'Decided by', 'Decided at', 'Note'],
  'Links':         ['Name', 'Link', 'Who sees it', 'Order'],
  'Audit':         ['When', 'Who', 'What'],
};

const SETTINGS = [
  ['Shop name',                    'Peregrine Coffee Roasters', 'Shown at the top of the app.'],
  ['Checklist lists',              'Opening, Mid, Closing, Side work', 'Names of the shift checklists, in order, separated by commas. Tasks go on the Checklists tab.'],
  ['Positions',                    'Bar, Register, Lead',       'Positions for the schedule, separated by commas.'],
  ['Ask for the code again every', '60',                        'Days before a phone asks for the name and code again (0 = never).'],
  ['Schedule days shown',          '14',                        'How many days ahead the schedule shows.'],
  ['Server address',               '',                          'Paste the Web app URL from Deploy › Manage deployments (ends in /exec). The menu uses it.'],
  ['App address',                  'https://salem-bell.github.io/Peregrine-App/', 'Where staff open the app and add it to their home screen.'],
];

/* ============================================================
   Menu + setup
   ============================================================ */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Team')
    .addItem('1. Set up', 'setup')
    .addItem('2. Show sign-in codes', 'showCodes')
    .addSeparator()
    .addItem('Sign the selected person out everywhere', 'signOutSelected')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  const isCopy = props.getProperty('SHEET_ID') !== ss.getId();
  writeStartHere_(ss);
  buildSettings_(ss);
  Object.keys(TABS).forEach(t => buildTab_(ss, t));
  if (isCopy) props.setProperties({ SHEET_ID: ss.getId(), SECRET: newId_(40) });
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', newId_(40));
  fixUsers_(ss, isCopy);
  ['Start Here', 'Settings', 'Users'].forEach((n, i) => move_(ss, n, i + 1));
  ['Checklist log', 'Reads', 'Audit'].forEach(n => { const s = ss.getSheetByName(n); if (s) { move_(ss, n, ss.getSheets().length); s.setTabColor('#bbbbbb'); } });
  const blank = ss.getSheetByName('Sheet1'); if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  ss.setActiveSheet(ss.getSheetByName('Start Here'));
  SpreadsheetApp.getUi().alert('Set up done', 'Next: add your team on the Users tab, then follow Step 3 on the Start Here tab.', SpreadsheetApp.getUi().ButtonSet.OK);
}

function buildSettings_(ss) {
  let sh = ss.getSheetByName('Settings');
  if (!sh) { sh = ss.insertSheet('Settings'); sh.getRange(1, 1, 1, 3).setValues([['Setting', 'Your choice', 'What it means']]); }
  const have = sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), 1).getValues().flat().map(String) : [];
  SETTINGS.forEach(([l, d, h]) => { if (have.indexOf(l) < 0) sh.appendRow([l, d, h]); });
  head_(sh, 3); sh.setColumnWidth(1, 220); sh.setColumnWidth(2, 360); sh.setColumnWidth(3, 520);
  sh.getRange(2, 2, sh.getLastRow() - 1, 1).setBackground('#fff8e1');
}

function buildTab_(ss, name) {
  const header = TABS[name];
  let sh = ss.getSheetByName(name);
  if (sh) { const n = sh.getLastColumn(); if (n < header.length) { sh.getRange(1, n + 1, 1, header.length - n).setValues([header.slice(n)]); head_(sh, header.length); } return; }
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, header.length).setValues([header]); head_(sh, header.length);
  const text = c => sh.getRange(2, c, 999, 1).setNumberFormat('@');
  const list = (c, items) => sh.getRange(2, c, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(items, true).setAllowInvalid(false).build());
  const box = c => sh.getRange(2, c, 999, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  if (name === 'Users') { list(2, ROLES); text(3); box(4); sh.getRange(2, 7, 999, 2).setFontColor('#888888'); }
  if (name === 'Shifts') { text(1); text(2); text(3); }
  if (name === 'Requests') { text(5); list(4, ['Time off', 'Swap', 'Cover']); list(7, ['Pending', 'Approved', 'Denied', 'Cancelled']); }
  if (name === 'Checklists') box(4);
  if (name === 'Announcements') { box(6); box(7); sh.getRange(2, 5, 999, 1).setWrap(true); }
  if (name === 'Links') list(3, ['Everyone', 'Leads and managers', 'Managers']);
  const ex = examples_(name);
  if (ex.length) sh.getRange(2, 1, ex.length, header.length).setValues(ex.map(r => header.map((_, i) => r[i] === undefined ? '' : r[i])));
  sh.autoResizeColumns(1, header.length);
}

function examples_(name) {
  const tz = Session.getScriptTimeZone(), d = n => Utilities.formatDate(new Date(Date.now() + n * 864e5), tz, 'yyyy-MM-dd');
  switch (name) {
    case 'Users': return [['Salem', 'Manager', '', true, '', '', '', 1, new Date()]];
    case 'Checklists': return [
      ['Opening', 'Turn on espresso machine and grinders', 1, true], ['Opening', 'Dial in espresso – log the recipe', 2, true], ['Opening', 'Stock milk, cups, lids', 3, true], ['Opening', 'Count the drawer', 4, true],
      ['Mid', 'Wipe down bar and condiment station', 1, true], ['Mid', 'Restock pastries and cups', 2, true],
      ['Closing', 'Backflush and clean group heads', 1, true], ['Closing', 'Clean grinders and empty hoppers', 2, true], ['Closing', 'Close the drawer', 3, true], ['Closing', 'Take out trash and recycling', 4, true]];
    case 'Announcements': return [['a01', new Date(), 'Salem', 'Welcome to the team app', 'Check your checklists, the schedule and announcements here. Tap "Got it" so I know you saw this.', true, true]];
    case 'Shifts': return [[d(0), '06:30', '12:30', 'Salem', 'Lead'], [d(1), '12:00', '18:00', 'Salem', 'Bar']];
    case 'Links': return [['Employee manual', 'https://drive.google.com', 'Everyone', 1], ['Drink build menu', 'https://drive.google.com', 'Everyone', 2], ['Payroll & admin', 'https://drive.google.com', 'Managers', 3]];
  }
  return [];
}

/** Every person gets an ID, a sign-in version and a unique 4-digit code. */
function fixUsers_(ss, regenerate) {
  const sh = ss.getSheetByName('Users'), rows = vals_(sh);
  const used = {}; rows.forEach(r => { if (!regenerate && /^\d{4}$/.test(String(r[2]))) used[String(r[2])] = 1; });
  rows.forEach((r, i) => {
    if (!String(r[0]).trim()) return;
    const row = i + 2;
    if (!r[1]) sh.getRange(row, 2).setValue('Staff');
    if (r[3] === '' || r[3] === null) sh.getRange(row, 4).setValue(true);
    if (!r[6] || regenerate) sh.getRange(row, 7).setValue(newId_(16));
    if (!r[7]) sh.getRange(row, 8).setValue(1);
    if (!r[8]) sh.getRange(row, 9).setValue(new Date());
    if (regenerate || !/^\d{4}$/.test(String(r[2]))) { const c = newCode_(used); used[c] = 1; sh.getRange(row, 3).setNumberFormat('@').setValue(c); }
  });
}

function newCode_(used) {
  let c;
  do { c = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); }
  while (used[c] || /^(\d)\1{3}$/.test(c) || '0123456789'.indexOf(c) >= 0 || '9876543210'.indexOf(c) >= 0);
  return c;
}
function newId_(n) { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, n); }

function showCodes() {
  const ss = SpreadsheetApp.getActive(); fixUsers_(ss, false);
  const app = setting_(ss, 'App address') || '(set Settings › App address)';
  const list = vals_(ss.getSheetByName('Users')).filter(r => r[0] && truthy_(r[3])).map(r => '<li><b>' + esc_(r[0]) + '</b> (' + esc_(r[1]) + ') · code <b>' + esc_(r[2]) + '</b></li>').join('');
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput('<div style="font:14px/1.5 sans-serif"><p><b>Everyone opens:</b> <a href="' + esc_(app) + '" target="_blank">' + esc_(app) + '</a> and adds it to their home screen.</p><p>Each person signs in with their first name and <b>their own code</b>. Tell each person only theirs.</p><ul>' + list + '</ul><p style="color:#a33">A code got out? Managers can give someone a new code in the app (Team › person › New code), which signs them out everywhere.</p></div>').setWidth(560).setHeight(420), 'Sign-in codes');
}

function signOutSelected() {
  const ss = SpreadsheetApp.getActive(), sh = ss.getActiveSheet(), ui = SpreadsheetApp.getUi();
  if (sh.getName() !== 'Users' || sh.getActiveRange().getRow() < 2) { ui.alert('Select a person on the Users tab first.'); return; }
  const r = sh.getActiveRange().getRow();
  sh.getRange(r, 8).setValue((Number(sh.getRange(r, 8).getValue()) || 1) + 1);
  ui.alert(sh.getRange(r, 1).getValue() + ' is signed out on every phone.');
}

function writeStartHere_(ss) {
  let sh = ss.getSheetByName('Start Here'); if (!sh) sh = ss.insertSheet('Start Here', 0);
  sh.clear();
  const L = [
    ['Peregrine Team app – start here'], [''],
    ['Step 1 – the team'], ['   Users tab: one row per person – first name and role (Manager, Lead or Staff). Codes are made for you.'],
    ['   Managers can also add people, change roles, give new codes and turn people off from the app itself.'], [''],
    ['Step 2 – what shows in the app'], ['   Checklists: the tasks for each shift checklist. Shifts: the schedule. Announcements, Links: optional.'], [''],
    ['Step 3 – turn on the server (once)'], ['   Extensions › Apps Script › Deploy › New deployment › Web app. Execute as: Me. Who has access: Anyone. Deploy.'],
    ['   Copy the Web app URL into Settings › Server address, and send it to whoever set up the app (it goes into the app\'s config.js).'], [''],
    ['Step 4 – tell the team'], ['   Team › 2. Show sign-in codes. Everyone opens the app address on their phone, signs in with first name + code, and adds it to the home screen.'], [''],
    ['Grey tabs (Checklist log, Reads, Audit) are written by the app. Leave them alone.'],
  ];
  sh.getRange(1, 1, L.length, 1).setValues(L); sh.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  [3, 7, 10, 14].forEach(r => sh.getRange(r, 1).setFontWeight('bold')); sh.setColumnWidth(1, 900);
}

/* ============================================================
   Web API (the phone app posts JSON here)
   ============================================================ */
function doGet() { return json_({ ok: true, app: 'Peregrine Team', version: VERSION }); }

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) { return json_({ error: 'Bad request' }); }
  try {
    if (body.fn === 'info') return json_(info_());
    if (body.fn === 'signIn') return json_(signIn_(body.name, body.code));
    if (body.fn === 'api') return json_(api_(body.token, body.p || {}));
    return json_({ error: 'Unknown request' });
  } catch (err) {
    return json_({ error: String(err && err.message || err).replace(/^Error:\s*/, '') });
  }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function info_() { const ss = SpreadsheetApp.getActive(); return { ok: true, name: setting_(ss, 'Shop name') || 'Team', version: VERSION }; }

/** First name + 4-digit code → a signed sign-in token. 5 wrong tries locks that name 15 min; 25 in an hour pauses everyone for an hour. */
function signIn_(name, code) {
  const ss = SpreadsheetApp.getActive();
  if (PropertiesService.getScriptProperties().getProperty('SHEET_ID') !== ss.getId()) throw new Error('The app isn\'t set up yet. Ask your manager.');
  const n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60), c = String(code || '').trim();
  if (!n || !/^\d{4}$/.test(c)) throw new Error('Type your first name and your 4-digit code.');
  const cache = CacheService.getScriptCache(), k1 = 'pin_' + Utilities.base64EncodeWebSafe(n).slice(0, 80);
  if (Number(cache.get('pin_all') || 0) >= 25) throw new Error('Too many wrong codes. Sign-in is paused for an hour.');
  if (Number(cache.get(k1) || 0) >= 5) throw new Error('Too many wrong codes for that name. Try again in 15 minutes.');
  if (vals_(ss.getSheetByName('Users')).some(r => String(r[0]).trim() && (!r[6] || !/^\d{4}$/.test(String(r[2]))))) fixUsers_(ss, false);   // people typed straight into the sheet
  const users = vals_(ss.getSheetByName('Users')).filter(r => String(r[0]).trim() && truthy_(r[3]) && r[6]);
  let match = users.filter(r => String(r[0]).trim().toLowerCase().replace(/\s+/g, ' ') === n);
  if (!match.length) match = users.filter(r => String(r[0]).trim().toLowerCase().split(/\s+/)[0] === n);
  const hit = match.find(r => String(r[2]).trim() === c);
  if (!hit) {
    cache.put(k1, String(Number(cache.get(k1) || 0) + 1), 900);
    cache.put('pin_all', String(Number(cache.get('pin_all') || 0) + 1), 3600);
    throw new Error(match.length > 1 ? 'More than one person has that first name – type your full name.' : 'That name and code don\'t match.');
  }
  cache.remove(k1);
  const issued = String(Date.now());
  return { token: 'T.' + hit[6] + '.' + issued + '.' + sig_(hit, issued), name: String(hit[0]), role: role_(hit[1]) };
}

function sig_(r, issued) {
  return Utilities.computeHmacSha256Signature([r[6], String(r[2]).trim(), Number(r[7]) || 1, issued].join('|'), PropertiesService.getScriptProperties().getProperty('SECRET') || 'x')
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('').slice(0, 32);
}
function role_(v) { return ROLES.indexOf(String(v)) >= 0 ? String(v) : 'Staff'; }

/** Token → the signed-in person, or an error the app turns into the sign-in screen. */
function who_(ss, token) {
  const [t, id, issued, sig] = String(token || '').split('.');
  if (t !== 'T' || !id || PropertiesService.getScriptProperties().getProperty('SHEET_ID') !== ss.getId()) throw new Error('signin: please sign in');
  const sh = ss.getSheetByName('Users'), rows = vals_(sh), i = rows.findIndex(r => String(r[6]) === id), r = rows[i];
  if (!r || !truthy_(r[3]) || sig_(r, issued) !== sig) throw new Error('signin: please sign in');
  const days = Number(setting_(ss, 'Ask for the code again every') || 60);
  if (days > 0 && Date.now() - Number(issued) > days * 864e5) throw new Error('signin: it has been ' + days + ' days – please sign in again');
  return { name: String(r[0]), role: role_(r[1]), id, row: i + 2 };
}

function api_(token, p) {
  const ss = SpreadsheetApp.getActive(), me = who_(ss, token);
  if (p.action) {
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try { act_(ss, me, p); SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  } else { const lock = LockService.getScriptLock(); if (lock.tryLock(8000)) lock.releaseLock(); }
  return state_(ss, who_(ss, token));
}

/* ============================================================
   Reading
   ============================================================ */
function state_(ss, me) {
  const tz = ss.getSpreadsheetTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const isMgr = me.role === 'Manager', isLead = me.role === 'Lead' || isMgr;
  if (isMgr && vals_(ss.getSheetByName('Users')).some(r => String(r[0]).trim() && (!r[6] || !/^\d{4}$/.test(String(r[2]))))) fixUsers_(ss, false);
  const users = vals_(ss.getSheetByName('Users')).filter(r => String(r[0]).trim());
  const active = users.filter(r => truthy_(r[3])).map(r => String(r[0]));
  const out = { ok: true, version: VERSION, today, updated: new Date().toISOString(), name: setting_(ss, 'Shop name') || 'Team', me: { name: me.name, role: me.role }, team: active };

  // Checklists (today, plus the last 7 days for leads and managers)
  const lists = splitList_(setting_(ss, 'Checklist lists'));
  const tasks = vals_(ss.getSheetByName('Checklists')).filter(r => r[0] && r[1] && truthy_(r[3])).map(r => ({ list: String(r[0]).trim(), task: String(r[1]).trim(), order: Number(r[2]) || 0, notes: String(r[4] || ''), days: dayset_(r[5]), section: String(r[6] || '').trim() }));
  const log = vals_(ss.getSheetByName('Checklist log')).map(r => ({ date: ymd_(r[0], tz), list: String(r[1]), task: String(r[2]), by: String(r[3] || ''), at: toIso_(r[4]) }));
  const listNames = lists.length ? lists.filter(l => tasks.some(t => t.list === l)).concat([...new Set(tasks.map(t => t.list))].filter(l => lists.indexOf(l) < 0)) : [...new Set(tasks.map(t => t.list))];
  const dayLists = date => listNames.map(l => {
    const dow = weekday_(date);
    const ts = tasks.filter(t => t.list === l && (!t.days || t.days.indexOf(dow) >= 0)).sort((a, b) => a.order - b.order);
    const items = ts.map(t => { const d = log.find(x => x.date === date && x.list === l && x.task === t.task); return { task: t.task, notes: t.notes, section: t.section, by: d ? d.by : '', at: d ? d.at : '' }; });
    return { list: l, items, done: items.filter(x => x.by).length, total: items.length };
  }).filter(x => x.total);
  out.checklists = dayLists(today);
  const firstLog = log.reduce((m, x) => x.date && (!m || x.date < m) ? x.date : m, '');   // don't count days before anyone used the app
  if (isLead) out.history = [1, 2, 3, 4, 5, 6, 7].map(n => addDays_(today, -n)).filter(d => firstLog && d >= firstLog).map(d => { return { date: d, lists: dayLists(d).map(x => ({ list: x.list, done: x.done, total: x.total, missed: x.items.filter(i => !i.by).map(i => i.task) })) }; });

  // Announcements
  const reads = vals_(ss.getSheetByName('Reads'));
  out.announcements = vals_(ss.getSheetByName('Announcements')).filter(r => r[0] && r[3] && truthy_(r[6])).map(r => {
    const id = String(r[0]), readers = reads.filter(x => String(x[0]) === id).map(x => String(x[1]));
    const a = { id, posted: toIso_(r[1]), from: String(r[2] || ''), title: String(r[3]), message: String(r[4] || ''), pinned: truthy_(r[5]), read: readers.indexOf(me.name) >= 0 };
    if (isLead) { a.readers = readers.filter(n => active.indexOf(n) >= 0); a.notRead = active.filter(n => readers.indexOf(n) < 0 && n !== a.from); }
    return a;
  }).sort((a, b) => (b.pinned - a.pinned) || String(b.posted).localeCompare(String(a.posted))).slice(0, 40);

  // Schedule
  const days = Math.min(Math.max(Number(setting_(ss, 'Schedule days shown')) || 14, 1), 60), last = addDays_(today, days - 1);
  out.shifts = vals_(ss.getSheetByName('Shifts')).map(r => ({ date: ymd_(r[0], tz), start: hhmm_(r[1], tz), end: hhmm_(r[2], tz), name: String(r[3] || '').trim(), position: String(r[4] || ''), notes: String(r[5] || '') }))
    .filter(s => s.date && s.name && s.date >= today && s.date <= last).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  out.positions = splitList_(setting_(ss, 'Positions'));

  // Requests
  const reqs = vals_(ss.getSheetByName('Requests')).filter(r => r[0]).map(r => ({ id: String(r[0]), created: toIso_(r[1]), from: String(r[2] || ''), type: String(r[3] || ''), date: ymd_(r[4], tz) || String(r[4] || ''),
    details: String(r[5] || ''), status: String(r[6] || 'Pending'), by: String(r[7] || ''), at: toIso_(r[8]), note: String(r[9] || '') }));
  out.requests = reqs.filter(q => isMgr || q.from === me.name).filter(q => q.status === 'Pending' || !q.date || q.date >= addDays_(today, -14)).sort((a, b) => String(b.created).localeCompare(String(a.created)));

  // Links
  const can = w => /^manager/i.test(w) ? isMgr : /lead/i.test(w) ? isLead : true;
  out.links = vals_(ss.getSheetByName('Links')).filter(r => r[0] && /^https?:\/\//.test(String(r[1])) && can(String(r[2] || 'Everyone')))
    .map(r => ({ name: String(r[0]), url: String(r[1]), order: Number(r[3]) || 0 })).sort((a, b) => a.order - b.order);

  // Team (managers)
  if (isMgr) out.users = users.map(r => ({ id: String(r[6] || ''), name: String(r[0]), role: role_(r[1]), code: String(r[2] || ''), active: truthy_(r[3]), phone: String(r[4] || ''), email: String(r[5] || '') }));
  return out;
}

/* ============================================================
   Writing
   ============================================================ */
function act_(ss, me, p) {
  const A = String(p.action), isMgr = me.role === 'Manager', isLead = isMgr || me.role === 'Lead';
  const tz = ss.getSpreadsheetTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const tab = n => ss.getSheetByName(n) || (() => { throw new Error('The ' + n + ' tab is missing – ask a manager to run Team › 1. Set up.'); })();
  const audit = what => tab('Audit').appendRow([new Date(), me.name, what]);
  const needMgr = () => { if (!isMgr) throw new Error('Only managers can do that'); };

  switch (A) {
    case 'check': {                                   // tick or untick a checklist task (today only)
      const list = String(p.list), task = String(p.task);
      const exists = vals_(tab('Checklists')).some(r => String(r[0]).trim() === list && String(r[1]).trim() === task && truthy_(r[3]) && (!dayset_(r[5]) || dayset_(r[5]).indexOf(weekday_(today)) >= 0));
      if (!exists) throw new Error('That task changed – pull down to refresh');
      const sh = tab('Checklist log'), v = vals_(sh);
      const i = v.findIndex(r => ymd_(r[0], tz) === today && String(r[1]) === list && String(r[2]) === task);
      if (p.done === '1') { if (i < 0) sh.appendRow([today, list, task, me.name, new Date()]); }
      else if (i >= 0) { if (String(v[i][3]) !== me.name && !isLead) throw new Error(v[i][3] + ' checked that one'); sh.deleteRow(i + 2); }
      return;
    }
    case 'read': {
      const id = String(p.id), sh = tab('Reads');
      if (!vals_(sh).some(r => String(r[0]) === id && String(r[1]) === me.name)) sh.appendRow([id, me.name, new Date()]);
      return;
    }
    case 'announce': {
      if (!isLead) throw new Error('Only leads and managers can post announcements');
      const title = clean_(p.title, 150); if (!title) throw new Error('Add a title');
      const sh = tab('Announcements'); put_(sh, [nextId_(sh, 'a'), new Date(), me.name, title, clean_(p.message, 3000), p.pinned === '1', true]);
      return;
    }
    case 'unannounce': {
      if (!isLead) throw new Error('Only leads and managers can do that');
      const sh = tab('Announcements'), r = findRow_(sh, p.id); if (r) sh.getRange(r, 7).setValue(false); return;
    }
    case 'request': {
      const type = ['Time off', 'Swap', 'Cover'].indexOf(String(p.type)) >= 0 ? String(p.type) : 'Time off';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || ''))) throw new Error('Pick a date');
      if (p.date < today) throw new Error('That date has passed');
      const sh = tab('Requests'); sh.appendRow([nextId_(sh, 'r'), new Date(), me.name, type, p.date, clean_(p.details, 1000), 'Pending', '', '', '']);
      return;
    }
    case 'cancelRequest': {
      const sh = tab('Requests'), r = findRow_(sh, p.id); if (!r) return;
      if (String(sh.getRange(r, 3).getValue()) !== me.name) throw new Error('That isn\'t your request');
      if (String(sh.getRange(r, 7).getValue()) === 'Pending') sh.getRange(r, 7).setValue('Cancelled'); return;
    }
    case 'decide': {
      needMgr();
      const sh = tab('Requests'), r = findRow_(sh, p.id); if (!r) throw new Error('That request was removed');
      const st = p.approve === '1' ? 'Approved' : 'Denied';
      sh.getRange(r, 7, 1, 4).setValues([[st, me.name, new Date(), clean_(p.note, 300)]]);
      audit(st + ' ' + sh.getRange(r, 4).getValue() + ' request from ' + sh.getRange(r, 3).getValue() + ' for ' + sh.getRange(r, 5).getValue());
      return;
    }
    // ----- team management (managers) -----
    case 'addUser': {
      needMgr();
      const name = clean_(p.name, 60); if (!name) throw new Error('Add a name');
      const sh = tab('Users'), rows = vals_(sh);
      if (rows.some(r => String(r[0]).trim().toLowerCase() === name.toLowerCase())) throw new Error('Someone called ' + name + ' is already on the team – add a last name or initial');
      const used = {}; rows.forEach(r => { used[String(r[2])] = 1; });
      const code = newCode_(used);
      const row = put_(sh, [name, role_(p.role), code, true, clean_(p.phone, 40), clean_(p.email, 120), newId_(16), 1, new Date()]);
      sh.getRange(row, 3).setNumberFormat('@').setValue(code);
      audit('Added ' + name + ' as ' + role_(p.role));
      return;
    }
    case 'editUser': case 'newCode': case 'setActive': {
      needMgr();
      const sh = tab('Users'), rows = vals_(sh), i = rows.findIndex(r => String(r[6]) === String(p.id)); if (i < 0) throw new Error('That person was removed');
      const row = i + 2, r = rows[i], name = String(r[0]);
      const managersLeft = rows.filter((x, j) => j !== i && truthy_(x[3]) && role_(x[1]) === 'Manager').length;
      if (A === 'newCode') {
        const used = {}; rows.forEach(x => { used[String(x[2])] = 1; });
        sh.getRange(row, 3).setNumberFormat('@').setValue(newCode_(used)); sh.getRange(row, 8).setValue((Number(r[7]) || 1) + 1);
        audit('New code for ' + name + ' (signed out everywhere)'); return;
      }
      if (A === 'setActive') {
        const on = p.active === '1';
        if (!on && role_(r[1]) === 'Manager' && !managersLeft) throw new Error('You can\'t turn off the last manager');
        sh.getRange(row, 4).setValue(on); if (!on) sh.getRange(row, 8).setValue((Number(r[7]) || 1) + 1);
        audit((on ? 'Turned on ' : 'Turned off ') + name); return;
      }
      const role = role_(p.role);
      if (role_(r[1]) === 'Manager' && role !== 'Manager' && !managersLeft) throw new Error('The team needs at least one manager');
      const newName = clean_(p.name, 60) || name;
      if (newName.toLowerCase() !== name.toLowerCase() && rows.some((x, j) => j !== i && String(x[0]).trim().toLowerCase() === newName.toLowerCase())) throw new Error('Someone called ' + newName + ' is already on the team');
      sh.getRange(row, 1, 1, 2).setValues([[newName, role]]);
      sh.getRange(row, 5, 1, 2).setValues([[clean_(p.phone, 40), clean_(p.email, 120)]]);
      if (newName !== name) {                         // keep the schedule pointing at the same person
        const shifts = tab('Shifts'), sv = vals_(shifts);
        sv.forEach((x, j) => { if (String(x[3]).trim() === name) shifts.getRange(j + 2, 4).setValue(newName); });
      }
      audit('Updated ' + name + (newName !== name ? ' → ' + newName : '') + ' (' + role + ')');
      return;
    }
    // ----- schedule (managers) -----
    case 'addShift': {
      needMgr();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) || !/^\d{2}:\d{2}$/.test(String(p.start || '')) || !/^\d{2}:\d{2}$/.test(String(p.end || ''))) throw new Error('A shift needs a date, a start and an end');
      const name = String(p.name || '');
      if (!vals_(tab('Users')).some(r => String(r[0]) === name && truthy_(r[3]))) throw new Error('Pick someone on the team');
      tab('Shifts').appendRow([p.date, p.start, p.end, name, clean_(p.position, 40), clean_(p.notes, 200)]);
      return;
    }
    case 'deleteShift': {
      needMgr();
      const sh = tab('Shifts'), v = vals_(sh);
      const i = v.findIndex(r => ymd_(r[0], tz) === p.date && hhmm_(r[1], tz) === p.start && String(r[3]).trim() === p.name);
      if (i >= 0) sh.deleteRow(i + 2); return;
    }
  }
  throw new Error('Unknown action');
}

/* ============================================================
   Helpers
   ============================================================ */
/** Writes a row into the first row whose first cell is empty (checkbox columns make appendRow jump to the bottom). */
function put_(sh, row) {
  const n = Math.max(sh.getLastRow(), 1), col = sh.getRange(1, 1, n, 1).getValues();
  let r = col.findIndex((x, i) => i > 0 && String(x[0]).trim() === '') + 1;
  if (r < 2) r = n + 1;
  sh.getRange(r, 1, 1, row.length).setValues([row]);
  return r;
}
const DAYS_ = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekday_(ymd) { const [y, m, d] = ymd.split('-').map(Number); return DAYS_[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; }
/** "Mon, Thu" / "Monday" / "weekdays" / "weekends" → ['Mon','Thu']; blank → null (every day). */
function dayset_(v) {
  const s = String(v || '').trim().toLowerCase(); if (!s || /^(every ?day|daily|all)$/.test(s)) return null;
  const out = [];
  s.split(/[,\/&]+|\band\b/).map(x => x.trim()).forEach(x => {
    if (/^weekdays?$/.test(x)) out.push('Mon', 'Tue', 'Wed', 'Thu', 'Fri');
    else if (/^weekends?$/.test(x)) out.push('Sat', 'Sun');
    else { const i = DAYS_.findIndex(d => x.startsWith(d.toLowerCase())); if (i >= 0) out.push(DAYS_[i]); }
  });
  return out.length ? out : null;
}
function vals_(sh) { if (!sh || sh.getLastRow() < 2) return []; return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues(); }
function setting_(ss, label) { const r = vals_(ss.getSheetByName('Settings')).find(x => String(x[0]).trim() === label); return r ? String(r[1]).trim() : ''; }
function head_(sh, n) { sh.getRange(1, 1, 1, n).setFontWeight('bold').setBackground('#eeeeee'); sh.setFrozenRows(1); }
function move_(ss, name, pos) { const s = ss.getSheetByName(name); if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(Math.min(pos, ss.getSheets().length)); } }
function splitList_(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function truthy_(v) { return v === true || /^(true|yes|y|x|1)$/i.test(String(v).trim()); }
function pad_(n) { return ('0' + n).slice(-2); }
function addDays_(s, n) { const [y, m, d] = s.split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d + n)); return x.getUTCFullYear() + '-' + pad_(x.getUTCMonth() + 1) + '-' + pad_(x.getUTCDate()); }
function ymd_(v, tz) {
  if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const s = String(v || '').trim(); if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + pad_(m[1]) + '-' + pad_(m[2]) : '';
}
function hhmm_(v, tz) {
  if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, tz, 'HH:mm');
  const m = String(v || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/); if (!m) return '';
  let h = Number(m[1]); const mi = Number(m[2] || 0); if (m[3]) { if (h === 12) h = 0; if (m[3][0] === 'p') h += 12; }
  return h < 24 && mi < 60 ? pad_(h) + ':' + pad_(mi) : '';
}
function toIso_(v) { if (v instanceof Date && !isNaN(v)) return v.toISOString(); const n = Number(v); return n > 1e11 ? new Date(n).toISOString() : ''; }
function clean_(v, max) { let t = String(v == null ? '' : v).slice(0, max).trim(); return /^[=+\-@]/.test(t) ? "'" + t : t; }
function esc_(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function nextId_(sh, prefix) {
  let n = 0; vals_(sh).forEach(r => { const m = String(r[0]).match(new RegExp('^' + prefix + '(\\d+)$')); if (m) n = Math.max(n, Number(m[1])); });
  return prefix + pad_(n + 1);
}
function findRow_(sh, id) { const v = vals_(sh); for (let i = 0; i < v.length; i++) if (String(v[i][0]) === String(id)) return i + 2; return 0; }
