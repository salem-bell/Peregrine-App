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

const VERSION = '2.8';
const ROLES = ['Manager', 'Lead', 'Staff'];
const REMIND_ = ['Night before', 'Before shift', 'Both', 'Off'];

const TABS = {
  'Users':         ['Name', 'Role', 'Code', 'Active', 'Phone', 'Email', 'User ID (do not edit)', 'Sign-in version (do not edit)', 'Added', 'Reminders (blank = default)', 'Hourly wage (managers only)', 'On schedule (blank = yes)', 'Schedule order', 'Notifications (blank = all on)'],
  'Checklists':    ['List', 'Task', 'Order', 'Active', 'Notes', 'Days (blank = every day)', 'Section'],
  'Checklist log': ['Date', 'List', 'Task', 'Done by', 'Done at'],
  'Announcements': ['ID', 'Posted', 'From', 'Title', 'Message', 'Pinned', 'Active', 'Must acknowledge'],
  'Reads':         ['Announcement ID', 'Name', 'Read at'],
  'Shifts':        ['Date', 'Start', 'End', 'Name', 'Position', 'Notes', 'ID (do not edit)', 'Published as (do not edit)', 'Remove when published'],
  'Availability':  ['ID', 'Name', 'Day or date', 'From', 'To', 'Note', 'Updated'],
  'Time clock':    ['ID', 'Name', 'Date', 'In', 'Out', 'Shift ID', 'Clock-in place', 'Clock-out place', 'Note', 'Edited by'],
  'Channels':      ['ID', 'Name', 'Kind', 'Members (user IDs; blank = everyone)', 'Who sees it', 'Created by', 'Created'],
  'Messages':      ['ID', 'Channel ID', 'From ID', 'From', 'Sent', 'Text', 'Photo (Drive file)'],
  'Chat reads':    ['User ID', 'Channel ID', 'Read at'],
  'Tests':         ['Test', 'Link (full address, or ?level=… to add to Settings › Test portal)', 'Results tab', 'Must have passed first', 'Who sees it', 'Order'],
  'Requests':      ['ID', 'Created', 'From', 'Type', 'Date', 'Details', 'Status', 'Decided by', 'Decided at', 'Note'],
  'Links':         ['Name', 'Link', 'Who sees it', 'Order'],
  'Audit':         ['When', 'Who', 'What'],
  'Reminder log':  ['Key', 'Name', 'Kind', 'Sent'],
  'Push':          ['User ID', 'Name', 'Endpoint', 'Keys (do not edit)', 'Device', 'Added', 'Last sent'],
  'Prep':          ['ID', 'Item', 'Details', 'For date', 'For', 'For people', 'Added by', 'Added at', 'Done by', 'Done at'],
};

const SETTINGS = [
  ['Shop name',                    'Peregrine Coffee Roasters', 'Shown at the top of the app.'],
  ['Checklist lists',              'Opening, Mid, Closing, Side work', 'Names of the shift checklists, in order, separated by commas. Tasks go on the Checklists tab.'],
  ['Positions',                    'Bar, Register, Lead',       'Positions for the schedule, separated by commas.'],
  ['Ask for the code again every', '60',                        'Days before a phone asks for the name and code again (0 = never).'],
  ['Schedule days shown',          '14',                        'How many days ahead the schedule shows.'],
  ['Server address',               '',                          'Paste the Web app URL from Deploy › Manage deployments (ends in /exec). The menu uses it.'],
  ['App address',                  'https://salem-bell.github.io/Peregrine-App/', 'Where staff open the app and add it to their home screen.'],
  ['Shift presets',                'Open 06:30-12:30, Mid 10:00-15:00, Close 12:00-18:05', 'One-tap shift times on the schedule editor: Name HH:MM-HH:MM, separated by commas.'],
  ['Late after (minutes)',         '5',                         'Clock-ins this many minutes after the shift start count as late.'],
  ['Shop location (lat, lng)',     '',                          'Optional. e.g. 32.9483, -96.7299. Clock-ins farther away than the distance below are flagged (not blocked).'],
  ['Clock-in distance (meters)',   '200',                       'How close to the shop counts as "at the shop".'],
  ['Test portal',                  '',                          'The certification test web app address (ends in /exec). Test links that start with ? are added to it.'],
  ['Shift reminder emails',        'On',                        'On or Off. Emails each person before their shifts (they pick when in the app, under More › Reminders). Needs an email on the Users tab.'],
  ['Night-before reminder at',     '19:00',                     'When the night-before email goes out (24-hour time).'],
  ['Hours-before reminder',        '2',                         'How many hours before a shift the second reminder goes out.'],
  ['Default reminders',            'Night before',              'For people who haven\'t chosen: Night before, Before shift, Both or Off.'],
  ['Email schedule changes',       'On',                        'On or Off. When the schedule is published, everyone whose shifts were added, changed or removed gets an email with their week.'],
  ['Overtime after (hours a week)', '40',                        'Wage estimates pay hours past this, Monday to Sunday, at the overtime rate.'],
  ['Overtime rate',                '1.5',                       'Multiplier for overtime hours.'],
  ['Labor cost extra (%)',         '0',                         'Optional. Added on top of wages in estimates, e.g. 10 for employer payroll taxes.'],
  ['Inventory sheet',              'https://docs.google.com/spreadsheets/d/1sSGRYl669jFxZ7-3dLYgNNNnR2QXvwgpBJ28o160szU/edit', 'The Peregrine Inventory & Reorder sheet. Leads and managers count it in the app (Lists › Inventory).'],
  ['Inventory tabs',               'Coffee, In-house, Costco, Paper goods, Other', 'The tabs in that sheet that hold items (same columns: Item, Category, Vendor, Unit, On hand, Par, Case size, Counted on…).'],
  ['Push service address',         '',                          'Your Cloudflare Worker address (https://peregrine-push….workers.dev). Blank = no push notifications.'],
  ['Push service secret',          '',                          'Must match SECRET in the Worker. Don\'t share it.'],
  ['Push public key',              '',                          'Must match VAPID_PUBLIC in the Worker.'],
  ['Delete chat photos after (days)', '60',                     'Photos sent in Messages are deleted from Drive after this many days. The message stays, marked "Photo expired".'],
  ['Test results sheet',           'https://docs.google.com/spreadsheets/d/1dl8gi2SkPfYOjBzX0syp2WkWssg7t-rpZChpeZNm5QQ/edit', 'The sheet the tests write results to. The app shows each person their own results.'],
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
  const hadShifts = !!ss.getSheetByName('Shifts');
  if (hadShifts) ensureShiftIds_(ss);                 // publish what's already there before new columns appear
  buildSettings_(ss);
  Object.keys(TABS).forEach(t => buildTab_(ss, t));
  if (isCopy) props.setProperties({ SHEET_ID: ss.getId(), SECRET: newId_(40) });
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', newId_(40));
  fixUsers_(ss, isCopy);
  if (!hadShifts) props.setProperty('DRAFTS_V', '1');
  dirty_('*');
  ['Start Here', 'Settings', 'Users'].forEach((n, i) => move_(ss, n, i + 1));
  ['Checklist log', 'Reads', 'Audit', 'Messages', 'Chat reads', 'Reminder log', 'Push'].forEach(n => { const s = ss.getSheetByName(n); if (s) { move_(ss, n, ss.getSheets().length); s.setTabColor('#bbbbbb'); } });
  const blank = ss.getSheetByName('Sheet1'); if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendShiftReminders')) ScriptApp.newTrigger('sendShiftReminders').timeBased().everyMinutes(15).create();
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
  if (name === 'Users') { list(2, ROLES); text(3); box(4); sh.getRange(2, 7, 999, 2).setFontColor('#888888'); list(10, REMIND_); sh.getRange(2, 11, 999, 1).setNumberFormat('$#,##0.00'); box(12); }
  if (name === 'Shifts') { text(1); text(2); text(3); }
  if (name === 'Requests') { text(5); list(4, ['Time off', 'Swap', 'Cover']); list(7, ['Pending', 'Approved', 'Denied', 'Cancelled']); }
  if (name === 'Checklists') box(4);
  if (name === 'Announcements') { box(6); box(7); sh.getRange(2, 5, 999, 1).setWrap(true); }
  if (name === 'Links') list(3, ['Everyone', 'Leads and managers', 'Managers']);
  if (name === 'Tests') list(5, ['Everyone', 'Leads and managers', 'Managers']);
  if (name === 'Availability') { text(3); text(4); text(5); }
  if (name === 'Time clock') { text(3); }
  if (name === 'Prep') { text(4); }
  if (name === 'Channels') { list(3, ['channel', 'group', 'dm']); list(5, ['Everyone', 'Leads and managers', 'Managers']); }
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
    case 'Channels': return [['general', 'General', 'channel', '', 'Everyone', 'Setup', new Date()], ['training', 'Training', 'channel', '', 'Everyone', 'Setup', new Date()],
                             ['inventory', 'Inventory', 'channel', '', 'Everyone', 'Setup', new Date()], ['schedule', 'Schedule & swaps', 'channel', '', 'Everyone', 'Setup', new Date()],
                             ['leads', 'Leads & managers', 'channel', '', 'Leads and managers', 'Setup', new Date()]];
    case 'Tests': return [['Barista Level I', '?level=1', 'Barista Level I', '', 'Everyone', 1], ['Barista Level II', '?level=2', 'Barista Level II', 'Barista Level I', 'Everyone', 2],
                          ['Coffee Knowledge', '', 'Coffee Knowledge', 'Barista Level I', 'Everyone', 3], ['Lead (Level III)', '?level=3', 'Lead (Level III)', 'Barista Level II', 'Everyone', 4],
                          ['Level IV – Coffee Knowledge', '?level=4', 'Level IV Coffee Knowledge', 'Lead (Level III)', 'Leads and managers', 5]];
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
function doGet(e) {
  if (e && e.parameter && e.parameter.cal) return calendar_(String(e.parameter.cal));
  return json_({ ok: true, app: 'Peregrine Team', version: VERSION });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (_) { return json_({ error: 'Bad request' }); }
  MEMO_ = {};
  try {
    if (body.fn === 'info') return json_(info_());
    if (body.fn === 'signIn') return json_(signIn_(body.name, body.code));
    if (body.fn === 'api') return json_(api_(body.token, body.p || {}));
    if (body.fn === 'chat') return json_(chat_(body.token, body.channel, body.text, body.photo));
    if (body.fn === 'photo') return json_(photo_(body.token, body.id));
    if (body.fn === 'file') return json_(file_(body.token, body.id));
    if (body.fn === 'inventory') return json_(inventory_(body.token, body.counts));
    if (body.fn === 'tests') { const ss = SpreadsheetApp.getActive(), me = who_(ss, body.token); return json_({ ok: true, tests: tests_(ss, me), results: me.role === 'Manager' ? setting_(ss, 'Test results sheet') : '' }); }
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
  if (vals_(ss.getSheetByName('Users')).some(r => String(r[0]).trim() && (!r[6] || !/^\d{4}$/.test(String(r[2]))))) { fixUsers_(ss, false); dirty_('Users'); }   // people typed straight into the sheet
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
  const rows = rv_(ss, 'Users'), i = rows.findIndex(r => String(r[6]) === id), r = rows[i];
  if (!r || !truthy_(r[3]) || sig_(r, issued) !== sig) throw new Error('signin: please sign in');
  const days = Number(setting_(ss, 'Ask for the code again every') || 60);
  if (days > 0 && Date.now() - Number(issued) > days * 864e5) throw new Error('signin: it has been ' + days + ' days – please sign in again');
  return { name: String(r[0]), role: role_(r[1]), id, row: i + 2 };
}

function api_(token, p) {
  const t0 = Date.now(), ss = SpreadsheetApp.getActive(), me = who_(ss, token);
  // Several edits can arrive in one request (the app batches quick changes): one lock, one rebuild of the data.
  const batch = Array.isArray(p.actions), list = batch ? p.actions.slice(0, 50) : p.action ? [p] : [];
  if (list.length) {
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    const touched = [], ids = {}, results = [];
    try {
      list.forEach(a0 => {
        const a = Object.assign({}, a0);
        if (a.id && ids[a.id]) a.id = ids[a.id];                      // an edit to a shift added earlier in this batch
        try { const r = act_(ss, me, a, touched); if (a.cid && r && r.id) ids[a.cid] = r.id; results.push(r === undefined ? null : r); }
        catch (e) { if (!batch) throw e; results.push({ error: String(e && e.message || e).replace(/^Error:\s*/, '') }); }
      });
      SpreadsheetApp.flush();
    } finally { dirty_(touched); lock.releaseLock(); }
    const out = state_(ss, who_(ss, token), batch && p.slim);
    if (batch) out.results = results; else if (results[0] !== null) out.result = results[0];
    out.ms = Date.now() - t0; return out;
  } else { const lock = LockService.getScriptLock(); if (lock.tryLock(1500)) lock.releaseLock(); }   // don't make readers wait long for someone else's save
  const out = state_(ss, who_(ss, token)); out.ms = Date.now() - t0; return out;
}

/* ============================================================
   Reading
   ============================================================ */
/** slim = schedule edits: skip checklists, announcements, time clock, prep, chat and links (the app keeps what it had). */
function state_(ss, me, slim) {
  const tz = ss.getSpreadsheetTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const isMgr = me.role === 'Manager', isLead = me.role === 'Lead' || isMgr;
  if (isMgr && rv_(ss, 'Users').some(r => String(r[0]).trim() && (!r[6] || !/^\d{4}$/.test(String(r[2]))))) { fixUsers_(ss, false); dirty_('Users'); }
  const users = rv_(ss, 'Users').filter(r => String(r[0]).trim());
  const active = users.filter(r => truthy_(r[3])).map(r => String(r[0]));
  const out = { ok: true, version: VERSION, today, updated: new Date().toISOString(), name: setting_(ss, 'Shop name') || 'Team', me: { name: me.name, role: me.role, id: me.id, email: String(users.find(r => String(r[6]) === me.id)[5] || ''), reminders: remindMode_(ss, users.find(r => String(r[6]) === me.id)), cal: calKey_(users.find(r => String(r[6]) === me.id)) },
    reminders: { on: !/^off$/i.test(setting_(ss, 'Shift reminder emails')), night: setting_(ss, 'Night-before reminder at') || '19:00', hours: Number(setting_(ss, 'Hours-before reminder')) || 2 }, team: active,
    people: users.filter(r => truthy_(r[3]) && r[6]).map(r => ({ id: String(r[6]), name: String(r[0]), role: role_(r[1]), onSchedule: onSched_(r), order: Number(r[12]) || 0 })) };
  out.push = { key: setting_(ss, 'Push public key'), ready: !!(setting_(ss, 'Push service address') && setting_(ss, 'Push public key')),
    prefs: pushPrefs_(users.find(r => String(r[6]) === me.id)), devices: rv_(ss, 'Push').filter(r => String(r[0]) === me.id).map(r => String(r[2])) };

  if (slim) out.partial = true;
  // Checklists (today, plus the last 7 days for leads and managers)
  if (!slim) {
  const lists = splitList_(setting_(ss, 'Checklist lists'));
  const tasks = rv_(ss, 'Checklists').filter(r => r[0] && r[1] && truthy_(r[3])).map(r => ({ list: String(r[0]).trim(), task: String(r[1]).trim(), order: Number(r[2]) || 0, notes: String(r[4] || ''), days: dayset_(r[5]), section: String(r[6] || '').trim() }));
  const log = rv_(ss, 'Checklist log', 2500).map(r => ({ date: ymd_(r[0], tz), list: String(r[1]), task: String(r[2]), by: String(r[3] || ''), at: toIso_(r[4]) }));
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
  const reads = rv_(ss, 'Reads');
  out.announcements = rv_(ss, 'Announcements').filter(r => r[0] && r[3] && truthy_(r[6])).map(r => {
    const id = String(r[0]), readers = reads.filter(x => String(x[0]) === id).map(x => String(x[1]));
    const a = { id, posted: toIso_(r[1]), from: String(r[2] || ''), title: String(r[3]), message: String(r[4] || ''), pinned: truthy_(r[5]), mustAck: truthy_(r[7]) && Date.now() - toMs_(r[1]) < 30 * 864e5, read: readers.indexOf(me.name) >= 0 || String(r[2] || '') === me.name };   // the poster has read their own; must-read lapses after 30 days
    if (isLead) { a.readers = readers.filter(n => active.indexOf(n) >= 0); a.notRead = active.filter(n => readers.indexOf(n) < 0 && n !== a.from); }
    return a;
  }).sort((a, b) => (b.pinned - a.pinned) || String(b.posted).localeCompare(String(a.posted))).slice(0, 40);

  }
  // Schedule
  const days = Math.min(Math.max(Number(setting_(ss, 'Schedule days shown')) || 14, 1), 60);
  const first = addDays_(today, -21), last = addDays_(today, isLead ? 56 : days - 1);   // the past three weeks feed the time sheets
  ensureShiftIds_(ss);
  const srows = rv_(ss, 'Shifts');
  // Staff only ever see the published version. Managers and leads see the working copy, marked draft / changed / removed.
  out.shifts = (isLead ? srows.map(r => { const c = shiftObj_(r, tz), pb = pubObj_(r, tz); c.status = truthy_(r[8]) && pb ? 'removed' : !pb ? 'draft' : samePub_(c, pb) ? 'published' : 'changed'; if (c.status === 'changed') c.was = pb; return c; })
    : srows.map(r => pubObj_(r, tz)).filter(Boolean))
    .filter(s => s.date && s.name && s.date >= first && s.date <= last).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if (!isLead) {   // baristas see their own shifts and the people working with them – not the whole schedule
    const mine = out.shifts.filter(s => s.name === me.name);
    out.shifts = out.shifts.filter(s => s.name === me.name || mine.some(m => m.date === s.date && s.start < m.end && s.end > m.start));
  }
  if (isLead) out.unpublished = out.shifts.filter(s => s.status !== 'published' && s.date >= today).length;
  out.positions = splitList_(setting_(ss, 'Positions'));
  out.presets = presets_(ss, tz);
  out.availability = rv_(ss, 'Availability').filter(r => r[0] && r[1] && (isLead || String(r[1]).trim() === me.name))
    .map(r => ({ id: String(r[0]), name: String(r[1]).trim(), day: /^\d{4}-/.test(ymd_(r[2], tz)) ? ymd_(r[2], tz) : String(r[2] || '').trim().slice(0, 3), from: hhmm_(r[3], tz), to: hhmm_(r[4], tz), note: String(r[5] || '') }))
    .filter(a => !/^\d{4}-/.test(a.day) || a.day >= addDays_(today, -1));

  if (!slim) {
  // Time clock
  out.lateAfter = Number(setting_(ss, 'Late after (minutes)')) || 5;
  out.geo = /\d/.test(setting_(ss, 'Shop location (lat, lng)'));
  out.punches = rv_(ss, 'Time clock').filter(r => r[0] && r[1] && (isMgr || String(r[1]).trim() === me.name))
    .map(r => ({ id: String(r[0]), name: String(r[1]).trim(), date: ymd_(r[2], tz), in: toIso_(r[3]), out: toIso_(r[4]), shift: String(r[5] || ''), inPlace: String(r[6] || ''), outPlace: String(r[7] || ''), note: String(r[8] || ''), edited: String(r[9] || '') }))
    .filter(x => x.date >= first).sort((a, b) => String(a.in).localeCompare(String(b.in)));
  out.open = out.punches.find(x => x.name === me.name && x.in && !x.out && Date.now() - new Date(x.in) < 16 * 36e5) || null;   // older ones are missed clock-outs for a manager to fix

  // Prep requests for upcoming shifts
  out.prep = prepList_(ss, me, tz);

  // Chat (channel list + unread counts; messages load separately)
  out.channels = channels_(ss, me, users);


  }
  // Requests
  const reqs = rv_(ss, 'Requests').filter(r => r[0]).map(r => ({ id: String(r[0]), created: toIso_(r[1]), from: String(r[2] || ''), type: String(r[3] || ''), date: ymd_(r[4], tz) || String(r[4] || ''),
    details: String(r[5] || ''), status: String(r[6] || 'Pending'), by: String(r[7] || ''), at: toIso_(r[8]), note: String(r[9] || '') }));
  out.requests = reqs.filter(q => isMgr || q.from === me.name || (isLead && q.type === 'Time off' && (q.status === 'Approved' || q.status === 'Pending'))).filter(q => q.status === 'Pending' || !q.date || q.date >= addDays_(today, -14)).sort((a, b) => String(b.created).localeCompare(String(a.created)));

  // Links
  if (!slim) {
  const can = w => /^manager/i.test(w) ? isMgr : /lead/i.test(w) ? isLead : true;
  out.links = rv_(ss, 'Links').map((r, i) => ({ r, i })).filter(({ r }) => r[0] && /^https?:\/\//.test(String(r[1])) && can(String(r[2] || 'Everyone')))
    .map(({ r, i }) => ({ id: 'L' + (i + 2), name: String(r[0]), url: String(r[1]), tier: /^manager/i.test(String(r[2])) ? 'Managers' : /lead/i.test(String(r[2])) ? 'Leads and managers' : 'Everyone',
      file: !!driveId_(r[1]), order: Number(r[3]) || 0 })).sort((a, b) => a.order - b.order);
  }

  // Team (managers)
  if (isMgr) out.users = users.map(r => ({ id: String(r[6] || ''), name: String(r[0]), role: role_(r[1]), code: String(r[2] || ''), active: truthy_(r[3]), phone: String(r[4] || ''), email: String(r[5] || ''), reminders: remindMode_(ss, r), wage: Number(r[10]) || 0, onSchedule: onSched_(r), order: Number(r[12]) || 0 }));
  if (isMgr) out.pay = { ot: Number(setting_(ss, 'Overtime after (hours a week)')) || 40, otRate: Number(setting_(ss, 'Overtime rate')) || 1.5, extra: Number(setting_(ss, 'Labor cost extra (%)')) || 0 };
  return out;
}

/* ============================================================
   Writing
   ============================================================ */
function act_(ss, me, p, touched) {
  touched = touched || [];
  const A = String(p.action), isMgr = me.role === 'Manager', isLead = isMgr || me.role === 'Lead';
  const tz = ss.getSpreadsheetTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const tab = n => (touched.push(n), ss.getSheetByName(n)) || (TABS[n] ? (buildTab_(ss, n), ss.getSheetByName(n)) : null) || (() => { throw new Error('The ' + n + ' tab is missing – ask a manager to run Team › 1. Set up.'); })();   // new tabs appear on first use
  const audit = what => tab('Audit').appendRow([new Date(), me.name, what]);
  const needMgr = () => { if (!isMgr) throw new Error('Only managers can do that'); };
  const needLead = () => { if (!isLead) throw new Error('Only managers and leads can do that'); };

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
      const sh = tab('Announcements'); put_(sh, [nextId_(sh, 'a'), new Date(), me.name, title, clean_(p.message, 3000), p.pinned === '1', true, p.mustAck === '1']);
      SpreadsheetApp.flush();
      try { push_(ss, vals_(tab('Users')).filter(r => truthy_(r[3]) && r[6] && String(r[6]) !== me.id).map(r => ({ uid: String(r[6]), kind: 'news', title: '📣 ' + title, body: clean_(p.message, 160) || 'New announcement from ' + me.name.split(' ')[0], url: '?go=more:news', tag: 'news' }))); } catch (e) {}
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
      const row = put_(sh, [name, role_(p.role), code, true, clean_(p.phone, 40), clean_(p.email, 120), newId_(16), 1, new Date(), '', wage_(p.wage), true, rows.reduce((m, x) => Math.max(m, Number(x[12]) || 0), 0) + 1]);
      sh.getRange(row, 3).setNumberFormat('@').setValue(code);
      audit('Added ' + name + ' as ' + role_(p.role));
      return;
    }
    case 'scheduleOrder': {                           // the order people appear on the schedule (drag to arrange)
      needMgr();
      const ids = String(p.ids || '').split(',').filter(Boolean), sh = tab('Users'), rows = vals_(sh);
      if (!ids.length) return;
      if (sh.getLastColumn() < 13) buildTab_(ss, 'Users');
      const pos = {}; ids.forEach((id, k) => { pos[id] = k + 1; });
      let next = ids.length;
      const col = rows.map(r => [pos[String(r[6])] || (String(r[0]).trim() ? ++next : '')]);
      if (col.length) sh.getRange(2, 13, col.length, 1).setValues(col);
      return;
    }
    case 'editUser': case 'newCode': case 'setActive': case 'setWage': case 'setOnSchedule': {
      needMgr();
      const sh = tab('Users'), rows = vals_(sh), i = rows.findIndex(r => String(r[6]) === String(p.id)); if (i < 0) throw new Error('That person was removed');
      const row = i + 2, r = rows[i], name = String(r[0]);
      const managersLeft = rows.filter((x, j) => j !== i && truthy_(x[3]) && role_(x[1]) === 'Manager').length;
      if (A === 'newCode') {
        const used = {}; rows.forEach(x => { used[String(x[2])] = 1; });
        sh.getRange(row, 3).setNumberFormat('@').setValue(newCode_(used)); sh.getRange(row, 8).setValue((Number(r[7]) || 1) + 1);
        audit('New code for ' + name + ' (signed out everywhere)'); return;
      }
      if (A === 'setOnSchedule') { if (sh.getLastColumn() < 13) buildTab_(ss, 'Users'); sh.getRange(row, 12).setValue(p.on === '1'); audit((p.on === '1' ? 'Showed ' : 'Hid ') + name + ' on the schedule'); return; }
      if (A === 'setWage') { sh.getRange(row, 11).setValue(wage_(p.wage)); audit('Set ' + name + '\'s wage'); return; }
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
      if (p.wage !== undefined) sh.getRange(row, 11).setValue(wage_(p.wage));
      if (newName !== name) {                         // keep the schedule pointing at the same person
        [['Shifts', 4], ['Availability', 2], ['Time clock', 2], ['Requests', 3]].forEach(([t, c]) => {
          const sh2 = ss.getSheetByName(t); if (!sh2) return; touched.push(t);
          vals_(sh2).forEach((x, j) => { if (String(x[c - 1]).trim() === name) sh2.getRange(j + 2, c).setValue(newName); });
        });
      }
      audit('Updated ' + name + (newName !== name ? ' → ' + newName : '') + ' (' + role + ')');
      return;
    }
    // ----- schedule (managers) -----
    case 'addShift': case 'saveShift': {
      needLead();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) || !/^\d{2}:\d{2}$/.test(String(p.start || '')) || !/^\d{2}:\d{2}$/.test(String(p.end || ''))) throw new Error('A shift needs a date, a start and an end');
      const name = String(p.name || '');
      if (!vals_(tab('Users')).some(r => String(r[0]) === name && truthy_(r[3]))) throw new Error('Pick someone on the team');
      const sh = tab('Shifts'), row = [p.date, p.start, p.end, name, clean_(p.position, 40), clean_(p.notes, 200)];
      const after = { date: p.date, start: p.start, end: p.end, name, position: row[4], notes: row[5] };
      if (p.id && !/^tmp/.test(String(p.id))) {
        const v = vals_(sh), i = v.findIndex(r => String(r[6]) === String(p.id)); if (i < 0) throw new Error('That shift was removed');
        sh.getRange(i + 2, 1, 1, 6).setValues([row]); if (truthy_(v[i][8])) sh.getRange(i + 2, 9).setValue(false);
        return;   // the team sees it once it's published
      }
      const nid = newId_(10); sh.getRange(sh.getLastRow() + 1, 1, 1, 9).setValues([row.concat([nid, '', false])]); return { id: nid };
    }
    case 'deleteShift': {
      needLead();
      const sh = tab('Shifts'), v = vals_(sh);
      const i = p.id ? v.findIndex(r => String(r[6]) === String(p.id)) : v.findIndex(r => ymd_(r[0], tz) === p.date && hhmm_(r[1], tz) === p.start && String(r[3]).trim() === p.name);
      if (i < 0) return;
      if (pubObj_(v[i], tz)) sh.getRange(i + 2, 9).setValue(true); else sh.deleteRow(i + 2);   // a published shift stays up for the team until the next publish
      return;
    }
    case 'addPrep': {                                 // ask the next shift to make something
      const item = clean_(p.item, 120); if (!item) throw new Error('What needs prepping?');
      const tgt = prepTarget_(ss, p.when, tz), sh = tab('Prep'), id = nextId_(sh, 'x');
      sh.appendRow([id, item, clean_(p.details, 300), tgt.date, tgt.label, tgt.names.join(', '), me.name, new Date(), '', '']);
      let emailed = 0;
      if (p.notify !== '0') {
        const users = vals_(tab('Users')).filter(r => truthy_(r[3]));
        try { push_(ss, tgt.names.filter(n => n !== me.name).map(n => { const u = users.find(r => String(r[0]).trim() === n); return u && u[6] ? { uid: String(u[6]), kind: 'prep', title: '🧾 Prep for your shift', body: item + (tgt.label ? ' · ' + tgt.label : ''), url: '?go=lists:prep', tag: 'prep' } : null; }).filter(Boolean)); } catch (e) {}
        tgt.names.filter(n => n !== me.name).forEach(n => {
          const u = users.find(r => String(r[0]).trim() === n); if (!u || !/@/.test(String(u[5])) || remindMode_(ss, u) === 'Off') return;
          if (mail_(ss, String(u[5]).trim(), 'Prep for your shift: ' + item, 'Hi ' + n.split(' ')[0] + ',', me.name + ' asked your shift (' + tgt.label + ') to prep:', [item + (p.details ? ' – ' + clean_(p.details, 300) : '')])) emailed++;
        });
      }
      return { id, label: tgt.label, names: tgt.names, emailed };
    }
    case 'donePrep': {
      const sh = tab('Prep'), row = findRow_(sh, p.id); if (!row) throw new Error('That prep item was removed');
      sh.getRange(row, 9, 1, 2).setValues([p.done === '1' ? [me.name, new Date()] : ['', '']]); return;
    }
    case 'delPrep': {
      const sh = tab('Prep'), row = findRow_(sh, p.id); if (!row) return;
      if (!isLead && String(sh.getRange(row, 7).getValue()) !== me.name) throw new Error('Only the person who added it, or a lead, can remove it');
      sh.deleteRow(row); return;
    }
    case 'restoreShift': {
      needLead();
      const sh = tab('Shifts'), v = vals_(sh), i = v.findIndex(r => String(r[6]) === String(p.id)); if (i >= 0) sh.getRange(i + 2, 9).setValue(false); return;
    }
    case 'publish': {                                 // put the working schedule for a date range in front of the team
      if (!isLead) throw new Error('Only managers and leads can publish the schedule');
      const from = String(p.from || ''), to = /^\d{4}-\d{2}-\d{2}$/.test(String(p.to || '')) ? String(p.to) : addDays_(from, 6);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || to < from) throw new Error('Pick the week to publish');
      const sh = tab('Shifts'), v = vals_(sh), inR = d => d && d >= from && d <= to;
      const affected = {}, mark = (n, what) => { if (n) (affected[n] = affected[n] || []).push(what); };
      let published = 0, removed = 0, hadBefore = false;
      for (let i = v.length - 1; i >= 0; i--) {
        const c = shiftObj_(v[i], tz), pb = pubObj_(v[i], tz);
        if (!inR(c.date) && !(pb && inR(pb.date))) continue;
        if (pb) hadBefore = true;
        if (truthy_(v[i][8]) && pb) { mark(pb.name, { kind: 'Removed', s: pb }); sh.deleteRow(i + 2); removed++; continue; }
        if (!c.name || !c.date) continue;
        if (pb && samePub_(c, pb)) continue;
        if (!pb) mark(c.name, { kind: 'New', s: c });
        else { if (pb.name !== c.name) { mark(pb.name, { kind: 'Removed', s: pb }); mark(c.name, { kind: 'New', s: c }); } else mark(c.name, { kind: 'Changed', s: c, was: pb }); }
        sh.getRange(i + 2, 8, 1, 2).setValues([[pubJson_(c), false]]); published++;
      }
      SpreadsheetApp.flush();
      const range = from === to ? longDay_(from) : longDay_(from) + ' – ' + longDay_(to);
      let emailed = 0, noEmail = [];
      if (p.notify !== '0' && (published || removed)) {
        // Email: each affected person gets their whole (published) week, with what changed.
        if (!/^off$/i.test(setting_(ss, 'Email schedule changes'))) {
          const now = vals_(sh).map(r => pubObj_(r, tz)).filter(x => x && inR(x.date));
          const users = vals_(tab('Users')).filter(r => truthy_(r[3]));
          Object.keys(affected).forEach(n => {
            const u = users.find(r => String(r[0]).trim() === n); if (!u) return;
            if (!/@/.test(String(u[5]))) { noEmail.push(n); return; }
            if (remindMode_(ss, u) === 'Off') return;
            const desc = x => longDay_(x.date) + ':  ' + t12_(x.start) + '–' + t12_(x.end) + (x.position ? '  (' + x.position + ')' : '') + (x.notes ? ' – ' + x.notes : '');
            const mine = now.filter(x => x.name === n).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map(desc);
            const changes = affected[n].map(c => c.kind === 'Changed' ? 'Changed: ' + desc(c.s) + '  (was ' + t12_(c.was.start) + '–' + t12_(c.was.end) + (c.was.date !== c.s.date ? ' on ' + longDay_(c.was.date) : '') + ')' : c.kind + ': ' + desc(c.s));
            const lines = (mine.length ? ['Your shifts:'].concat(mine) : ['You have no shifts in this period.']).concat(hadBefore ? ['', 'What changed:'].concat(changes) : []);
            if (mail_(ss, String(u[5]).trim(), (hadBefore ? 'Schedule updated: ' : 'Schedule posted: ') + range, 'Hi ' + n.split(' ')[0] + ',', 'The schedule for ' + range + (hadBefore ? ' was updated.' : ' is posted.'), lines)) emailed++;
          });
        }
        // Push: everyone affected
        try {
          const us = vals_(tab('Users'));
          push_(ss, Object.keys(affected).map(n => { const u = us.find(r => String(r[0]).trim() === n && truthy_(r[3])); return u && u[6] ? { uid: String(u[6]), kind: 'schedule', title: hadBefore ? '📅 Schedule updated' : '📅 Schedule posted', body: range + (hadBefore ? ' – your shifts changed. Tap to see them.' : ' – tap to see your shifts.'), url: '?go=schedule', tag: 'schedule' } : null; }).filter(Boolean));
        } catch (e) {}
        // In the app: a note in the schedule channel, so everyone gets an unread badge.
        const ch = vals_(tab('Channels')).find(r => String(r[0]) === 'schedule') || vals_(tab('Channels')).find(r => /schedule/i.test(String(r[1])) && String(r[2] || 'channel') === 'channel');
        if (ch) tab('Messages').appendRow([newId_(12), String(ch[0]), me.id, me.name, new Date(), '📅 The schedule for ' + range + (hadBefore ? ' was updated' : ' is posted') + '. Check the Schedule tab.' + (hadBefore ? ' (' + Object.keys(affected).length + (Object.keys(affected).length === 1 ? ' person' : ' people') + ' affected)' : '')]);
      }
      audit('Published the schedule for ' + range + ' (' + published + ' shifts, ' + removed + ' removed)');
      return { published, removed, emailed, noEmail };
    }
    case 'sendWeek': {                                // email everyone working that week their shifts
      needMgr();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.from || ''))) throw new Error('Pick a week');
      const to = addDays_(p.from, 6), shifts = vals_(tab('Shifts')).map(r => pubObj_(r, tz)).filter(x => x && x.name && x.date >= p.from && x.date <= to);
      const people = vals_(tab('Users')).filter(r => truthy_(r[3]));
      let sent = 0, noEmail = [];
      people.forEach(u => {
        const mine = shifts.filter(x => x.name === String(u[0])).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)); if (!mine.length) return;
        const email = String(u[5] || '').trim(); if (!/@/.test(email)) { noEmail.push(String(u[0])); return; }
        const lines = mine.map(x => longDay_(x.date) + ':  ' + t12_(x.start) + '–' + t12_(x.end) + (x.position ? '  (' + x.position + ')' : '') + (x.notes ? ' – ' + x.notes : ''));
        if (mail_(ss, email, 'Your schedule for the week of ' + longDay_(p.from), 'Hi ' + String(u[0]).split(' ')[0] + ',', 'Here are your shifts for the week of ' + longDay_(p.from) + ':', lines)) sent++;
      });
      audit('Emailed the schedule for the week of ' + p.from + ' to ' + sent + ' people');
      return { sent, noEmail };
    }
    case 'myReminders': {                             // each person sets their own email and reminder choice
      const sh = tab('Users'), email = clean_(p.email, 120), mode = REMIND_.indexOf(String(p.mode)) >= 0 ? String(p.mode) : '';
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That email doesn\'t look right');
      sh.getRange(me.row, 6).setValue(email); sh.getRange(me.row, 10).setValue(mode);
      return;
    }
    case 'testReminder': {
      const u = vals_(tab('Users'))[me.row - 2], email = String(u[5] || '').trim();
      if (!/@/.test(email)) throw new Error('Add your email first');
      if (!mail_(ss, email, 'Test from the ' + (setting_(ss, 'Shop name') || 'team') + ' app', 'Hi ' + me.name.split(' ')[0] + ',', 'Shift reminders will come to this address.', [])) throw new Error('The daily email limit is used up – try tomorrow');
      return { sent: 1 };
    }
    case 'copyWeek': {                                // copy one week's shifts onto another week (skips exact duplicates)
      needLead();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.to || ''))) throw new Error('Pick the weeks');
      const sh = tab('Shifts'), v = vals_(sh).filter(r => !truthy_(r[8])).map(r => ({ date: ymd_(r[0], tz), start: hhmm_(r[1], tz), end: hhmm_(r[2], tz), name: String(r[3]).trim(), pos: String(r[4] || ''), notes: String(r[5] || '') }));
      const shift = (d, n) => addDays_(d, n), off = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 864e5);
      const src = v.filter(x => x.date >= p.from && x.date <= shift(p.from, 6));
      const have = {}; v.forEach(x => { have[x.date + '|' + x.start + '|' + x.name] = 1; });
      const active = vals_(tab('Users')).filter(r => truthy_(r[3])).map(r => String(r[0]));
      const rows = src.filter(x => active.indexOf(x.name) >= 0).map(x => [shift(x.date, off), x.start, x.end, x.name, x.pos, x.notes, newId_(10), '', false]).filter(r => !have[r[0] + '|' + r[1] + '|' + r[3]]);
      if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 9).setValues(rows);   // copies start as drafts
      audit('Copied ' + rows.length + ' shifts from the week of ' + p.from + ' to ' + p.to); return;
    }
    case 'clearWeek': {
      needLead();
      const sh = tab('Shifts'), v = vals_(sh);
      for (let i = v.length - 1; i >= 0; i--) { const d = ymd_(v[i][0], tz); if (d >= p.from && d <= addDays_(p.from, 6)) { if (pubObj_(v[i], tz)) sh.getRange(i + 2, 9).setValue(true); else sh.deleteRow(i + 2); } }
      audit('Cleared the schedule for the week of ' + p.from); return;
    }
    // ----- availability -----
    case 'addAvail': {
      const name = isMgr && p.name ? String(p.name) : me.name;
      const day = String(p.day || ''); if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(day) && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Pick a day of the week or a date');
      const from = /^\d{2}:\d{2}$/.test(p.from || '') ? p.from : '', to = /^\d{2}:\d{2}$/.test(p.to || '') ? p.to : '';
      if ((from && !to) || (!from && to) || (from && to <= from)) throw new Error('Give a start and an end time, or leave both blank for all day');
      tab('Availability').appendRow([nextId_(tab('Availability'), 'u'), name, day, from, to, clean_(p.note, 200), new Date()]); return;
    }
    case 'delAvail': {
      const sh = tab('Availability'), r = findRow_(sh, p.id); if (!r) return;
      if (String(sh.getRange(r, 2).getValue()).trim() !== me.name && !isMgr) throw new Error('That isn\'t yours');
      sh.deleteRow(r); return;
    }
    // ----- time clock -----
    case 'clockIn': {
      const sh = tab('Time clock'), v = vals_(sh);
      if (v.some(r => String(r[1]).trim() === me.name && openPunch_(r))) throw new Error('You\'re already clocked in');
      const now = new Date(), shiftId = matchShift_(ss, me.name, now, tz);
      put_(sh, [nextId_(sh, 'p'), me.name, today, now, '', shiftId, place_(ss, p.lat, p.lng), '', '', '']); return;
    }
    case 'clockOut': {
      const sh = tab('Time clock'), v = vals_(sh), i = v.findIndex(r => String(r[1]).trim() === me.name && openPunch_(r));
      if (i < 0) throw new Error('You aren\'t clocked in');
      sh.getRange(i + 2, 5).setValue(new Date()); sh.getRange(i + 2, 8).setValue(place_(ss, p.lat, p.lng)); return;
    }
    case 'savePunch': {                               // managers fix or add a punch
      needMgr();
      const name = String(p.name || ''), date = String(p.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(p.in || '')) throw new Error('A punch needs a date and a clock-in time');
      if (!vals_(tab('Users')).some(r => String(r[0]) === name)) throw new Error('Pick someone on the team');
      const tIn = atLocal_(date, p.in, tz), tOut = /^\d{2}:\d{2}$/.test(p.out || '') ? atLocal_(p.out < p.in ? addDays_(date, 1) : date, p.out, tz) : '';
      const sh = tab('Time clock');
      if (p.id) {
        const r = findRow_(sh, p.id); if (!r) throw new Error('That punch was removed');
        sh.getRange(r, 2, 1, 4).setValues([[name, date, tIn, tOut]]); sh.getRange(r, 9, 1, 2).setValues([[clean_(p.note, 200), me.name]]);
        audit('Edited ' + name + '\'s punch on ' + date + ' (' + p.in + '–' + (p.out || '…') + ')'); return;
      }
      put_(sh, [nextId_(sh, 'p'), name, date, tIn, tOut, matchShift_(ss, name, tIn, tz), 'added by manager', tOut ? 'added by manager' : '', clean_(p.note, 200), me.name]);
      audit('Added a punch for ' + name + ' on ' + date); return;
    }
    case 'deletePunch': { needMgr(); const sh = tab('Time clock'), r = findRow_(sh, p.id); if (r) { audit('Deleted punch ' + p.id + ' for ' + sh.getRange(r, 2).getValue()); sh.deleteRow(r); } return; }
    // ----- chat -----
    case 'newChannel': {
      const kind = p.kind === 'group' ? 'group' : 'channel';
      if (kind === 'channel' && !isLead) throw new Error('Only leads and managers can make channels – start a group instead');
      const name = clean_(p.name, 40); if (!name) throw new Error('Give it a name');
      const ids = vals_(tab('Users')).filter(r => truthy_(r[3])).map(r => String(r[6]));
      let members = String(p.members || '').split(',').filter(x => ids.indexOf(x) >= 0);
      if (kind === 'group') { if (members.indexOf(me.id) < 0) members.push(me.id); if (members.length < 2) throw new Error('Pick at least one other person'); } else members = [];
      tab('Channels').appendRow(['c' + newId_(8), name, kind, members.join(','), kind === 'channel' && /lead|manager/i.test(p.who || '') ? String(p.who) : 'Everyone', me.name, new Date()]); return;
    }
    case 'pushSub': {                                 // this phone wants push notifications
      let sub; try { sub = JSON.parse(String(p.sub || '')); } catch (e) {}
      if (!sub || !/^https:\/\//.test(String(sub.endpoint || '')) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('This phone didn\'t give a usable notification address');
      const sh = tab('Push'), v = vals_(sh), i = v.findIndex(r => String(r[2]) === sub.endpoint);
      const row = [me.id, me.name, sub.endpoint, JSON.stringify(sub.keys), clean_(p.device, 60), new Date(), i >= 0 ? v[i][6] : ''];
      if (i >= 0) sh.getRange(i + 2, 1, 1, 7).setValues([row]); else sh.appendRow(row);
      return;
    }
    case 'pushUnsub': {
      const sh = tab('Push'), v = vals_(sh);
      for (let i = v.length - 1; i >= 0; i--) if (String(v[i][2]) === String(p.endpoint || '') && String(v[i][0]) === me.id) sh.deleteRow(i + 2);
      return;
    }
    case 'pushPrefs': {                               // msg=all|direct|off; schedule, prep, remind, news = 1 or 0
      const sh = tab('Users'), v = vals_(sh), i = v.findIndex(r => String(r[6]) === me.id); if (i < 0) return;
      const P = Object.assign(pushPrefs_(v[i]), {});
      if (/^(all|direct|off)$/.test(String(p.msg || ''))) P.msg = String(p.msg);
      ['schedule', 'prep', 'remind', 'news'].forEach(k => { if (p[k] === '1' || p[k] === '0') P[k] = p[k] === '1'; });
      sh.getRange(i + 2, 14).setValue('msg=' + P.msg + ';' + ['schedule', 'prep', 'remind', 'news'].map(k => k + '=' + (P[k] ? 1 : 0)).join(';'));
      return;
    }
    case 'pushTest': {
      SpreadsheetApp.flush();
      return push_(ss, [{ uid: me.id, kind: 'test', title: 'Notifications are on', body: 'This is how Peregrine Team messages will show up.', url: '?go=more:push', tag: 'test' }]);
    }
    case 'deleteMessage': {
      const sh = tab('Messages'), r = findRow_(sh, p.id); if (!r) return;
      if (!isMgr) throw new Error('Only managers can delete messages');   // the chat is the shop's record
      const ph = String(sh.getRange(r, 7).getValue() || ''); if (ph && ph !== 'expired') { try { DriveApp.getFileById(ph).setTrashed(true); } catch (e) {} }
      sh.deleteRow(r); return;
    }
  }
  throw new Error('Unknown action');
}

/* ============================================================
   Schedule, time clock, chat, tests, files
   ============================================================ */
function ensureShiftIds_(ss) {
  const sh = ss.getSheetByName('Shifts'); if (!sh) return;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('DRAFTS_V') !== '1') {        // upgrading from before drafts: everything already on the schedule counts as published
    if (String(sh.getRange(1, 8).getValue()) !== TABS.Shifts[7]) { sh.getRange(1, 8, 1, 2).setValues([TABS.Shifts.slice(7)]); head_(sh, 9); }
    const tz = ss.getSpreadsheetTimeZone(), v0 = vals_(sh);
    v0.forEach((r, i) => { if (r[0] && r[3] && !r[7]) sh.getRange(i + 2, 8, 1, 2).setValues([[pubJson_(shiftObj_(r, tz)), false]]); });
    props.setProperty('DRAFTS_V', '1'); dirty_('Shifts');
  }
  const v = rv_(ss, 'Shifts');
  if (v.some(r => r[0] && r[3] && !r[6])) {           // rows typed straight into the sheet need an ID
    vals_(sh).forEach((r, i) => { if (r[0] && r[3] && !r[6]) sh.getRange(i + 2, 7).setValue(newId_(10)); }); dirty_('Shifts');
  }
}
function atLocal_(ymd, hm, tz) { return Utilities.parseDate(ymd + ' ' + hm, tz, 'yyyy-MM-dd HH:mm'); }
/** The shift this clock-in belongs to: same person, same day, starting within 3 hours (or already running). */
function matchShift_(ss, name, when, tz) {
  const d = Utilities.formatDate(when, tz, 'yyyy-MM-dd'), t = when.getTime();
  let best = '', gap = Infinity;
  vals_(ss.getSheetByName('Shifts')).forEach(r => {
    const x = pubObj_(r, tz); if (!x || x.name !== name || x.date !== d || !x.id) return;
    const s = atLocal_(d, x.start || '00:00', tz).getTime(), e = atLocal_(d, x.end || '23:59', tz).getTime();
    const g = t >= s && t <= e ? 0 : Math.abs(t - s);
    if (g < gap && g <= 3 * 36e5) { gap = g; best = x.id; }
  });
  return best;
}
/** "at the shop" / "away (1.2 km)" / "no location" – a flag for managers, never a block. */
function place_(ss, lat, lng) {
  const m = setting_(ss, 'Shop location (lat, lng)').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return lat !== undefined && lat !== '' ? 'location shared' : '';
  if (lat === undefined || lat === '' || isNaN(Number(lat))) return 'no location';
  const R = 6371000, rad = x => x * Math.PI / 180, a1 = rad(Number(m[1])), a2 = rad(Number(lat)), dl = rad(Number(lng) - Number(m[2])), da = a2 - a1;
  const dist = 2 * R * Math.asin(Math.sqrt(Math.sin(da / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2));
  const max = Number(setting_(ss, 'Clock-in distance (meters)')) || 200;
  return dist <= max ? 'at the shop' : 'away (' + (dist < 1000 ? Math.round(dist) + ' m' : (dist / 1000).toFixed(1) + ' km') + ')';
}

const tierOk_ = (me, w) => /^manager/i.test(w) ? me.role === 'Manager' : /lead/i.test(w) ? me.role !== 'Staff' : true;
/** Channels this person can see, with unread counts and the last message. DMs are 'dm-<id>-<id>'. */
function channels_(ss, me, users) {
  const byId = {}; users.forEach(r => { byId[String(r[6])] = String(r[0]); });
  const reads = {}; rv_(ss, 'Chat reads').forEach(r => { if (String(r[0]) === me.id) reads[String(r[1])] = toMs_(r[2]); });
  const msgs = rv_(ss, 'Messages', 3000);
  const list = rv_(ss, 'Channels').filter(r => r[0] && r[1]).map(r => ({ id: String(r[0]), name: String(r[1]), kind: String(r[2] || 'channel'), members: String(r[3] || '').split(',').filter(Boolean), who: String(r[4] || 'Everyone') }))
    .filter(c => c.kind === 'channel' ? tierOk_(me, c.who) : c.members.indexOf(me.id) >= 0);
  // DMs exist as soon as there is a message
  const dms = {}; msgs.forEach(m => { const c = String(m[1]); if (/^dm-/.test(c) && c.split('-').indexOf(me.id) > 0) dms[c] = 1; });
  Object.keys(dms).forEach(c => { if (!list.some(x => x.id === c)) { const other = c.split('-').slice(1).find(x => x !== me.id) || me.id; list.push({ id: c, name: byId[other] || 'Former teammate', kind: 'dm', members: c.split('-').slice(1), who: '' }); } });
  return list.map(c => {
    const ms = msgs.filter(m => String(m[1]) === c.id), last = ms[ms.length - 1];
    const seen = reads[c.id] || 0;
    return { id: c.id, name: c.kind === 'group' && !c.name ? c.members.map(x => byId[x]).join(', ') : c.name, kind: c.kind, who: c.who,
      members: c.kind === 'channel' ? [] : c.members.map(x => byId[x]).filter(Boolean),
      unread: ms.filter(m => toMs_(m[4]) > seen && String(m[2]) !== me.id).length,
      last: last ? { from: String(last[3]), text: String(last[5]).slice(0, 80) || (last[6] ? '📷 Photo' : ''), at: toIso_(last[4]) } : null };
  }).sort((a, b) => (a.kind === 'channel' ? 0 : 1) - (b.kind === 'channel' ? 0 : 1) || String((b.last || {}).at || '').localeCompare(String((a.last || {}).at || '')));
}
/** Opens a channel (and marks it read), optionally sending a message first. Light: doesn't rebuild the whole app state. */
function chat_(token, channel, text, photo) {
  const ss = SpreadsheetApp.getActive(), me = who_(ss, token), users = rv_(ss, 'Users').filter(r => String(r[0]).trim());
  channel = String(channel || '');
  let ok = channels_(ss, me, users).some(c => c.id === channel);
  if (!ok && /^dm-/.test(channel)) {                 // a brand-new DM: both people must be active teammates
    const ids = channel.split('-').slice(1), act = users.filter(r => truthy_(r[3])).map(r => String(r[6]));
    ok = ids.length === 2 && ids.indexOf(me.id) >= 0 && ids.every(x => act.indexOf(x) >= 0) && channel === 'dm-' + ids.slice().sort().join('-');
  }
  if (!ok) throw new Error('You can\'t see that conversation');
  const pid = photo ? savePhoto_(photo, channel) : '';   // Drive upload happens before the lock, so it never holds anyone else up
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    if ((text !== undefined && String(text).trim()) || pid) {
      if (pid) buildTab_(ss, 'Messages');            // adds the Photo column to older sheets
      const sh = ss.getSheetByName('Messages'); sh.appendRow([newId_(12), channel, me.id, me.name, new Date(), clean_(text || '', 2000)].concat(pid ? [pid] : []));
    }
    const rs = ss.getSheetByName('Chat reads'), rv = vals_(rs), i = rv.findIndex(r => String(r[0]) === me.id && String(r[1]) === channel);
    if (i >= 0) rs.getRange(i + 2, 3).setValue(new Date()); else rs.appendRow([me.id, channel, new Date()]);
    dirty_(['Chat reads', 'Messages']);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
  if ((text !== undefined && String(text).trim()) || pid) { try { pushChat_(ss, me, users, channel, String(text || '').trim(), !!pid); } catch (e) {} }
  const msgs = rv_(ss, 'Messages', 3000).filter(m => String(m[1]) === channel).slice(-150)
    .map(m => { const ph = String(m[6] || ''); return { id: String(m[0]), fromId: String(m[2]), from: String(m[3]), at: toIso_(m[4]), text: String(m[5]), photo: ph && ph !== 'expired' ? 1 : 0, expired: ph === 'expired' ? 1 : 0 }; });
  return { ok: true, channel, me: me.id, messages: msgs, channels: channels_(ss, me, users) };
}

/* ----- chat photos: one per message, kept in a private Drive folder, deleted after the set number of days ----- */
function photoFolder_() {
  const pr = PropertiesService.getScriptProperties(), id = pr.getProperty('PHOTO_FOLDER');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const f = DriveApp.createFolder('Peregrine Team photos'); f.setDescription('Photos sent in the Peregrine Team app. Deleted automatically (Settings › Delete chat photos after).');
  pr.setProperty('PHOTO_FOLDER', f.getId()); return f;
}
function savePhoto_(dataUrl, channel) {
  const m = String(dataUrl).match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/); if (!m) throw new Error('That photo couldn\'t be read – try another');
  const bytes = Utilities.base64Decode(m[3]); if (bytes.length > 5 * 1024 * 1024) throw new Error('That photo is too big');
  const name = 'chat ' + channel + ' ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmmss') + '.' + (m[2] === 'jpeg' ? 'jpg' : m[2]);
  return photoFolder_().createFile(Utilities.newBlob(bytes, m[1], name)).getId();
}
/** A message's photo, only for people who can see that conversation. */
function photo_(token, id) {
  const ss = SpreadsheetApp.getActive(), me = who_(ss, token), users = rv_(ss, 'Users').filter(r => String(r[0]).trim());
  const m = rv_(ss, 'Messages', 3000).find(x => String(x[0]) === String(id)); if (!m) throw new Error('That message is gone');
  if (!channels_(ss, me, users).some(c => c.id === String(m[1]))) throw new Error('You can\'t see that conversation');
  const ph = String(m[6] || ''); if (!ph || ph === 'expired') throw new Error('That photo has expired');
  const b = DriveApp.getFileById(ph).getBlob();
  return { ok: true, id: String(id), mime: b.getContentType(), data: Utilities.base64Encode(b.getBytes()) };
}
/** Once a day (from the reminder check): delete photos older than the setting and mark their messages. */
function cleanPhotos_(ss) {
  const tz = ss.getSpreadsheetTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), pr = PropertiesService.getScriptProperties();
  if (pr.getProperty('PHOTO_CLEANED') === today) return; pr.setProperty('PHOTO_CLEANED', today);
  const days = Number(setting_(ss, 'Delete chat photos after (days)')) || 60, cut = Date.now() - days * 864e5;
  const sh = ss.getSheetByName('Messages'); if (!sh || sh.getLastColumn() < 7) return;
  const v = vals_(sh); let n = 0;
  v.forEach((r, i) => { const ph = String(r[6] || ''); if (ph && ph !== 'expired' && toMs_(r[4]) && toMs_(r[4]) < cut) { try { DriveApp.getFileById(ph).setTrashed(true); } catch (e) {} sh.getRange(i + 2, 7).setValue('expired'); n++; } });
  try { const it = photoFolder_().getFiles(); while (it.hasNext()) { const f = it.next(); if (f.getDateCreated().getTime() < cut) f.setTrashed(true); } } catch (e) {}   // strays from unsent messages
  if (n) dirty_('Messages');
}

/** Each test with this person's latest result (from the results sheet) and whether it's unlocked. */
function tests_(ss, me) {
  const portal = setting_(ss, 'Test portal').replace(/[?#].*$/, '');
  let book = null; try { const id = driveId_(setting_(ss, 'Test results sheet')); if (id) book = SpreadsheetApp.openById(id); } catch (_) {}
  const mine = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const meN = mine(me.name), first = meN.split(' ')[0];
  const results = {};
  const rows = vals_(ss.getSheetByName('Tests')).filter(r => r[0] && tierOk_(me, String(r[4] || 'Everyone'))).sort((a, b) => (Number(a[5]) || 0) - (Number(b[5]) || 0));
  rows.forEach(r => {
    const tabName = String(r[2] || ''); if (!book || !tabName) return;
    const sh = book.getSheetByName(tabName); if (!sh) return;
    const v = vals_(sh).filter(x => { const n = mine(x[1]); return n === meN || (meN.indexOf(' ') < 0 && n.split(' ')[0] === first); });
    const passed = v.some(x => /pass/i.test(String(x[4])) && !/not/i.test(String(x[4])));
    const last = v[v.length - 1];
    results[String(r[0])] = { taken: v.length, passed, last: last ? { when: toIso_(last[0]) || String(last[0]), score: String(last[2] || ''), outOf: String(last[3] || ''), result: String(last[4] || '') } : null };
  });
  return rows.map(r => {
    const name = String(r[0]), link = String(r[1] || '').trim(), need = String(r[3] || '').trim(), res = results[name] || { taken: 0, passed: false, last: null };
    const url = /^https?:\/\//.test(link) ? link : link && portal ? portal + (link.charAt(0) === '?' ? link : '?' + link) : '';
    return { name, url, need, unlocked: !need || !!(results[need] && results[need].passed) || me.role === 'Manager', passed: res.passed, taken: res.taken, last: res.last };
  });
}

function driveId_(url) { const m = String(url || '').match(/\/d\/([\w-]{20,})/) || String(url || '').match(/[?&]id=([\w-]{20,})/); return m ? m[1] : ''; }
/** A resource as a PDF (Google Docs/Sheets/Slides are converted), only for people whose tier can see it. */
function file_(token, id) {
  const ss = SpreadsheetApp.getActive(), me = who_(ss, token);
  const row = Number(String(id || '').replace(/^L/, '')); if (!(row >= 2)) throw new Error('Unknown file');
  const r = ss.getSheetByName('Links').getRange(row, 1, 1, 4).getValues()[0];
  if (!r[0] || !tierOk_(me, String(r[2] || 'Everyone'))) throw new Error('You don\'t have access to that');
  const fid = driveId_(r[1]); if (!fid) throw new Error('That link isn\'t a Drive file');
  const f = DriveApp.getFileById(fid), mime = f.getMimeType();
  const blob = /^application\/vnd\.google-apps\./.test(mime) ? f.getAs('application/pdf') : f.getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > 20 * 1024 * 1024) throw new Error('That file is too big to open in the app');
  return { ok: true, name: String(r[0]), mime: blob.getContentType(), updated: f.getLastUpdated().toISOString(), data: Utilities.base64Encode(bytes) };
}

/* ============================================================
   Helpers
   ============================================================ */
/** Writes a row into the first row whose first cell is empty (checkbox columns make appendRow jump to the bottom). */
/* ============================================================
   Shift reminders, schedule-change emails and the calendar feed
   ============================================================ */
/** '$16.50' or '16.5' → 16.5. Blank → ''. Rejects nonsense. */
function wage_(v) { const t = String(v == null ? '' : v).replace(/[$,\s]/g, ''); if (!t) return ''; const n = Number(t); if (!(n >= 0 && n < 1000)) throw new Error('Wage should be dollars an hour, like 16.50'); return Math.round(n * 100) / 100; }
/* ----- inventory: the Peregrine Inventory & Reorder sheet, counted in the app by leads and managers ----- */
function invBook_(ss) { const id = driveId_(setting_(ss, 'Inventory sheet')); if (!id) throw new Error('Add the inventory sheet link in Settings › Inventory sheet'); return SpreadsheetApp.openById(id); }
function inventory_(token, counts) {
  const ss = SpreadsheetApp.getActive(), me = who_(ss, token), isMgr = me.role === 'Manager';
  if (me.role !== 'Lead' && !isMgr) throw new Error('Only managers and leads can see inventory');
  const tz = ss.getSpreadsheetTimeZone(), book = invBook_(ss), tabs = splitList_(setting_(ss, 'Inventory tabs'));
  const cache = CacheService.getScriptCache(), ck = 'INV:' + (isMgr ? 'm' : 'l') + ':' + (cache.get('G:INV') || '0');
  if (counts && counts.length) {                      // save counts: [{tab, row, item, onHand, par?, caseSize?}]
    const lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      const today = atLocal_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), '00:00', tz);
      counts.slice(0, 200).forEach(c => {
        const sh = book.getSheetByName(String(c.tab)); if (!sh || tabs.indexOf(sh.getName()) < 0) return;
        const row = Number(c.row); if (!(row >= 2) || row > sh.getLastRow()) return;
        if (String(sh.getRange(row, 1).getValue()).trim() !== String(c.item).trim()) return;   // the sheet changed under us; skip, the reload fixes it
        const n = String(c.onHand == null ? '' : c.onHand).trim();
        if (n !== '' && !(Number(n) >= 0 && Number(n) < 100000)) return;
        sh.getRange(row, 5).setValue(n === '' ? '' : Number(n));
        sh.getRange(row, 8).setValue(n === '' ? '' : today);
        if (isMgr && c.par !== undefined) { const v = String(c.par).trim(); if (v === '' || Number(v) >= 0) sh.getRange(row, 6).setValue(v === '' ? '' : Number(v)); }
        if (isMgr && c.caseSize !== undefined) { const v = String(c.caseSize).trim(); if (v === '' || Number(v) > 0) sh.getRange(row, 7).setValue(v === '' ? '' : Number(v)); }
      });
      SpreadsheetApp.flush(); cache.put('G:INV', String(Date.now()), 21600);
    } finally { lock.releaseLock(); }
    return { ok: true, saved: counts.length };
  }
  const hit = cache.get(ck); if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const items = [];
  tabs.forEach(t => {
    const sh = book.getSheetByName(t); if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, 12).getValues().forEach((r, i) => {
      if (!String(r[0]).trim()) return;
      items.push({ tab: t, row: i + 2, item: String(r[0]).trim(), cat: String(r[1] || ''), vendor: String(r[2] || ''), unit: String(r[3] || ''),
        onHand: r[4] === '' ? '' : Number(r[4]), par: r[5] === '' ? '' : Number(r[5]), caseSize: r[6] === '' ? '' : Number(r[6]),
        counted: r[7] instanceof Date ? Utilities.formatDate(r[7], tz, 'yyyy-MM-dd') : String(r[7] || ''), cost: Number(r[10]) || 0 });
    });
  });
  const out = { ok: true, tabs, items, url: setting_(ss, 'Inventory sheet'), canEditPar: isMgr };
  try { const t = JSON.stringify(out); if (t.length < 95000) cache.put(ck, t, 60); } catch (e) {}
  return out;
}

/** The version of a shift the team sees (set when it's published), or null for a draft. */
function pubObj_(r, tz) {
  const t = String(r[7] || ''); if (!t) return null;
  try { const o = JSON.parse(t); return { id: String(r[6] || ''), date: o.d, start: o.s, end: o.e, name: o.n, position: o.p || '', notes: o.o || '' }; } catch (e) { return null; }
}
function pubJson_(c) { return JSON.stringify({ d: c.date, s: c.start, e: c.end, n: c.name, p: c.position || '', o: c.notes || '' }); }
function samePub_(a, b) { return a.date === b.date && a.start === b.start && a.end === b.end && a.name === b.name && (a.position || '') === (b.position || '') && (a.notes || '') === (b.notes || ''); }
function presets_(ss, tz) { return splitList_(setting_(ss, 'Shift presets')).map(x => { const m = x.match(/^(.*?)\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/); return m ? { name: m[1].trim(), start: hhmm_(m[2], tz), end: hhmm_(m[3], tz) } : null; }).filter(Boolean); }

/* ----- prep for the next shift ----- */
/** Who a prep request goes to: 'next' = the next people to start a (published) shift; 'YYYY-MM-DD|Open' = whoever works that preset that day. */
function prepTarget_(ss, when, tz) {
  const now = new Date(), today = Utilities.formatDate(now, tz, 'yyyy-MM-dd'), hm = Utilities.formatDate(now, tz, 'HH:mm');
  const pub = vals_(ss.getSheetByName('Shifts')).filter(r => !truthy_(r[8])).map(r => pubObj_(r, tz)).filter(x => x && x.name && x.date >= today && x.date <= addDays_(today, 14));
  const sorted = pub.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const m = String(when || 'next').match(/^(\d{4}-\d{2}-\d{2})\|(.+)$/);
  if (m) {
    const pr = presets_(ss, tz).find(x => x.name === m[2]), date = m[1];
    const hit = sorted.filter(x => x.date === date && (!pr || (x.start >= addMin_(pr.start, -60) && x.start <= addMin_(pr.start, 60))));
    return { date, label: shortDay_(date) + (pr ? ' ' + pr.name : ''), names: [...new Set(hit.map(x => x.name))] };
  }
  const next = sorted.find(x => x.date > today || x.start > hm);
  if (!next) return { date: today, label: 'Next shift', names: [] };
  const grp = sorted.filter(x => x.date === next.date && x.start >= next.start && x.start <= addMin_(next.start, 60));
  return { date: next.date, label: shortDay_(next.date) + ' ' + t12_(next.start) + ' shift', names: [...new Set(grp.map(x => x.name))] };
}
function addMin_(hm, n) { const [h, m] = hm.split(':').map(Number), t = Math.max(0, Math.min(1439, h * 60 + m + n)); return pad_(Math.floor(t / 60)) + ':' + pad_(t % 60); }
function shortDay_(ymd) { const [y, m, d] = ymd.split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d)); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x.getUTCDay()] + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] + ' ' + d; }
function prepList_(ss, me, tz) {
  const cutoff = Date.now() - 36 * 36e5;
  return rv_(ss, 'Prep').filter(r => r[0] && r[1] && (!r[9] || toMs_(r[9]) > cutoff)).map(r => {
    const names = String(r[5] || '').split(',').map(x => x.trim()).filter(Boolean);
    return { id: String(r[0]), item: String(r[1]), details: String(r[2] || ''), date: ymd_(r[3], tz), label: String(r[4] || ''), for: names, by: String(r[6] || ''), at: toIso_(r[7]), doneBy: String(r[8] || ''), doneAt: toIso_(r[9]), mine: names.indexOf(me.name) >= 0 };
  }).sort((a, b) => (!!a.doneAt - !!b.doneAt) || String(a.date).localeCompare(String(b.date)) || String(b.at).localeCompare(String(a.at)));
}

/** On the scheduling lineup unless a manager hid them (blank = yes). */
function onSched_(r) { const v = r[11]; return v === '' || v === null || v === undefined ? true : truthy_(v); }
function shiftObj_(r, tz) { return { id: String(r[6] || ''), date: ymd_(r[0], tz), start: hhmm_(r[1], tz), end: hhmm_(r[2], tz), name: String(r[3] || '').trim(), position: String(r[4] || ''), notes: String(r[5] || '') }; }
function remindMode_(ss, r) { const v = r && String(r[9] || '').trim(); return REMIND_.indexOf(v) >= 0 ? v : (REMIND_.indexOf(setting_(ss, 'Default reminders')) >= 0 ? setting_(ss, 'Default reminders') : 'Night before'); }
function t12_(hm) { let [h, m] = String(hm).split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + (m ? ':' + pad_(m) : '') + ap; }
function longDay_(ymd) { const [y, m, d] = ymd.split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d)); return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][x.getUTCDay()] + ', ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] + ' ' + d; }
function appUrl_(ss) { return setting_(ss, 'App address') || ''; }

/** Sends one plain email from the shop. Returns false (never throws) when mail can't go out. */
function mail_(ss, to, subject, hello, intro, lines) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) return false;
    const shop = setting_(ss, 'Shop name') || 'Team', app = appUrl_(ss);
    const text = [hello, '', intro].concat(lines.length ? [''].concat(lines) : []).concat(['', app ? 'Open the app: ' + app : '', 'Change your reminders in the app: More › Reminders.']).join('\n');
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#231F20">' + '<p>' + esc_(hello) + '</p><p>' + esc_(intro) + '</p>' +
      (lines.length ? '<p style="border-left:4px solid #D29229;padding-left:12px">' + lines.map(esc_).join('<br>') + '</p>' : '') +
      (app ? '<p><a href="' + esc_(app) + '" style="color:#1E5662">Open the app</a></p>' : '') + '<p style="color:#6B6661;font-size:13px">Change your reminders in the app: More › Reminders.</p></div>';
    MailApp.sendEmail({ to, subject, body: text, htmlBody: html, name: shop });
    return true;
  } catch (e) { return false; }
}

/** Runs every 15 minutes (set up by Team › 1. Set up). Night-before and hours-before emails, each sent once per shift and time. */
function sendShiftReminders() {
  const ss = SpreadsheetApp.getActive();
  try { cleanPhotos_(ss); } catch (e) {}
  if (/^off$/i.test(setting_(ss, 'Shift reminder emails'))) return;
  const tz = ss.getSpreadsheetTimeZone(), now = new Date(), today = Utilities.formatDate(now, tz, 'yyyy-MM-dd'), hm = Utilities.formatDate(now, tz, 'HH:mm');
  const night = /^\d{1,2}:\d{2}$/.test(setting_(ss, 'Night-before reminder at')) ? hhmm_(setting_(ss, 'Night-before reminder at'), tz) : '19:00';
  const hours = Number(setting_(ss, 'Hours-before reminder')) || 2;
  const users = vals_(ss.getSheetByName('Users')).filter(r => String(r[0]).trim() && truthy_(r[3]));
  const log = ss.getSheetByName('Reminder log') || (buildTab_(ss, 'Reminder log'), ss.getSheetByName('Reminder log'));
  const sent = {}; vals_(log).forEach(r => { sent[String(r[0])] = 1; });
  const shifts = vals_(ss.getSheetByName('Shifts')).map(r => pubObj_(r, tz)).filter(x => x && x.name && (x.date === today || x.date === addDays_(today, 1)));
  const rows = [], pushes = [], pushers = {}; try { vals_(ss.getSheetByName('Push')).forEach(r => { pushers[String(r[0])] = 1; }); } catch (e) {}
  shifts.forEach(x => {
    const u = users.find(r => String(r[0]).trim() === x.name); if (!u) return;
    const hasMail = /@/.test(String(u[5])), hasPush = !!(pushers[String(u[6])] && pushPrefs_(u).remind); if (!hasMail && !hasPush) return;
    const mode = remindMode_(ss, u); if (mode === 'Off') return;
    const startAt = atLocal_(x.date, x.start, tz).getTime(), left = (startAt - now.getTime()) / 36e5;
    const want = [];
    if ((mode === 'Night before' || mode === 'Both') && x.date === addDays_(today, 1) && hm >= night) want.push('night');
    if ((mode === 'Before shift' || mode === 'Both') && left > 0 && left <= hours) want.push('soon');
    want.forEach(kind => {
      const key = [x.id || x.date, kind, x.date, x.start].join('|'); if (sent[key]) return;
      const crew = shifts.filter(o => o !== x && o.date === x.date && o.start < x.end && o.end > x.start).map(o => o.name.split(' ')[0]);
      const when = kind === 'night' ? 'tomorrow' : 'today';
      const prep = vals_(ss.getSheetByName('Prep')).filter(r => r[1] && !r[9] && ymd_(r[3], tz) === x.date && String(r[5] || '').split(',').map(n => n.trim()).indexOf(x.name) >= 0).map(r => '• ' + r[1] + (r[2] ? ' – ' + r[2] : ''));
      const lines = [longDay_(x.date) + ':  ' + t12_(x.start) + '–' + t12_(x.end) + (x.position ? '  (' + x.position + ')' : '')].concat(x.notes ? ['Note: ' + x.notes] : []).concat(crew.length ? ['Working with: ' + crew.join(', ')] : []).concat(prep.length ? ['', 'Prep asked for your shift:'].concat(prep) : []);
      if (hasPush) pushes.push({ uid: String(u[6]), kind: 'remind', title: '☕ You work ' + when + ' at ' + t12_(x.start), body: t12_(x.start) + '–' + t12_(x.end) + (x.position ? ' · ' + x.position : '') + (crew.length ? ' · with ' + crew.join(', ') : '') + (prep.length ? ' · ' + prep.length + ' prep item' + (prep.length === 1 ? '' : 's') : ''), url: '?go=today', tag: 'remind' });
      if (hasPush && !hasMail) { rows.push([key, x.name, kind, new Date()]); sent[key] = 1; return; }
      if (mail_(ss, String(u[5]).trim(), 'Reminder: you work ' + when + ' at ' + t12_(x.start), 'Hi ' + x.name.split(' ')[0] + ',', 'A reminder that you work ' + when + '.', lines) || hasPush) { rows.push([key, x.name, kind, new Date()]); sent[key] = 1; }
    });
  });
  if (rows.length) log.getRange(log.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
  if (pushes.length) try { push_(ss, pushes); } catch (e) {}
  const v = vals_(log); if (v.length > 2000) log.deleteRows(2, v.length - 1500);   // keep the log small
}

/* ----- push notifications: the Sheet decides who gets what; the Cloudflare Worker does the sending ----- */
function pushPrefs_(r) {
  const P = { msg: 'all', schedule: true, prep: true, remind: true, news: true };
  String(r && r[13] || '').split(';').forEach(kv => { const [k, v] = kv.split('='); if (k === 'msg' && /^(all|direct|off)$/.test(v)) P.msg = v; else if (k in P && k !== 'msg') P[k] = v === '1'; });
  return P;
}
/** items: [{uid, kind, title, body, url, tag}] – kind is checked against each person's settings. Returns { sent, failed }. */
function push_(ss, items) {
  const addr = setting_(ss, 'Push service address'), secret = setting_(ss, 'Push service secret');
  if (!addr || !secret || !items || !items.length) return { sent: 0, failed: 0, off: !addr };
  const sh = ss.getSheetByName('Push'); if (!sh) return { sent: 0, failed: 0 };
  const subs = vals_(sh), users = vals_(ss.getSheetByName('Users')), out = [], rows = [];
  items.forEach(it => {
    const u = users.find(r => String(r[6]) === it.uid); if (!u || !truthy_(u[3])) return;
    const P = pushPrefs_(u);
    if (it.kind === 'msg' ? (P.msg === 'off' || (P.msg === 'direct' && !it.direct)) : it.kind !== 'test' && P[it.kind] === false) return;
    subs.forEach((s, i) => { if (String(s[0]) !== it.uid) return; let keys; try { keys = JSON.parse(String(s[3])); } catch (e) { return; }
      out.push({ sub: { endpoint: String(s[2]), keys }, data: { title: String(it.title).slice(0, 120), body: String(it.body || '').slice(0, 240), url: it.url || '', tag: it.tag || '' }, urgency: it.kind === 'msg' || it.kind === 'remind' ? 'high' : 'normal' }); rows.push(i); });
  });
  if (!out.length) return { sent: 0, failed: 0, none: true };
  const res = UrlFetchApp.fetch(addr, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ secret, pushes: out }), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Push service answered ' + res.getResponseCode() + ' – check Settings › Push service address and secret');
  const r = JSON.parse(res.getContentText()).results || [];
  const dead = [], now = new Date(); let sent = 0;
  r.forEach(x => { const row = rows[x.i]; if (x.status >= 200 && x.status < 300) { sent++; sh.getRange(row + 2, 7).setValue(now); } else if (x.status === 404 || x.status === 410) dead.push(row); });
  dead.sort((a, b) => b - a).forEach(row => sh.deleteRow(row + 2));   // phones that turned notifications off or reinstalled
  if (dead.length || sent) dirty_('Push');
  return { sent, failed: r.length - sent - dead.length, expired: dead.length };
}
/** A chat message → everyone else who can see that conversation. */
function pushChat_(ss, me, users, channel, text, photo) {
  const c = channels_(ss, me, users).find(x => x.id === channel); if (!c) return;
  const active = users.filter(r => truthy_(r[3]) && r[6] && String(r[6]) !== me.id);
  let ids;
  if (/^dm-/.test(channel)) ids = channel.split('-').slice(1).filter(x => x !== me.id);
  else if (c.kind === 'channel') ids = active.filter(r => tierOk_({ role: role_(r[1]) }, c.who)).map(r => String(r[6]));
  else { const row = rv_(ss, 'Channels').find(r => String(r[0]) === channel); ids = String(row && row[3] || '').split(',').filter(x => x && x !== me.id); }
  const direct = c.kind !== 'channel', who = me.name.split(' ')[0];
  push_(ss, ids.map(uid => ({ uid, kind: 'msg', direct, title: direct ? (c.kind === 'group' ? who + ' · ' + c.name : me.name) : '# ' + c.name + ' · ' + who, body: text ? text.slice(0, 200) : '📷 Photo', url: '?go=chat:' + channel, tag: 'chat-' + channel })));
}

/** A private calendar address per person. A new sign-in code changes it, so an old address stops working. */
function calKey_(r) {
  if (!r || !r[6]) return '';
  const sig = Utilities.computeHmacSha256Signature(['cal', r[6], String(r[2]).trim(), Number(r[7]) || 1].join('|'), PropertiesService.getScriptProperties().getProperty('SECRET') || 'x')
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('').slice(0, 24);
  return r[6] + '.' + sig;
}
function calendar_(key) {
  const ss = SpreadsheetApp.getActive(), tz = ss.getSpreadsheetTimeZone(), id = key.split('.')[0];
  const u = vals_(ss.getSheetByName('Users')).find(r => String(r[6]) === id && truthy_(r[3]));
  if (!u || calKey_(u) !== key) return ContentService.createTextOutput('Not found').setMimeType(ContentService.MimeType.TEXT);
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), shop = setting_(ss, 'Shop name') || 'Work';
  const stamp = d => Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'"), icsEsc = t => String(t).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Peregrine Team//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsEsc(shop + ' shifts'), 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  vals_(ss.getSheetByName('Shifts')).map(r => pubObj_(r, tz)).filter(x => x && x.name === String(u[0]).trim() && x.date >= addDays_(today, -14) && x.date <= addDays_(today, 60)).forEach(x => {
    const a = atLocal_(x.date, x.start, tz), b = atLocal_(x.end < x.start ? addDays_(x.date, 1) : x.date, x.end, tz);
    L.push('BEGIN:VEVENT', 'UID:' + (x.id || x.date + x.start) + '@peregrine-team', 'DTSTAMP:' + stamp(new Date()), 'DTSTART:' + stamp(a), 'DTEND:' + stamp(b),
      'SUMMARY:' + icsEsc(shop + (x.position ? ' – ' + x.position : ' shift')), 'LOCATION:' + icsEsc(shop), x.notes ? 'DESCRIPTION:' + icsEsc(x.notes) : null,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc('Shift at ' + t12_(x.start)), 'TRIGGER:-PT1H', 'END:VALARM', 'END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return ContentService.createTextOutput(L.filter(Boolean).join('\r\n')).setMimeType(ContentService.MimeType.ICAL);
}

/** Clocked in, not out, within the last 16 hours. An older open punch is a forgotten clock-out and doesn't block a new clock-in. */
function openPunch_(r) { return r[3] && !r[4] && Date.now() - toMs_(r[3]) < 16 * 36e5; }
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
/** Only the last n rows (logs that grow forever: messages, checklist log). */
function tail_(sh, n) { if (!sh || sh.getLastRow() < 2) return []; const last = sh.getLastRow(), from = Math.max(2, last - n + 1); return sh.getRange(from, 1, last - from + 1, sh.getLastColumn()).getValues(); }

/* ----- speed: reads are memoized per request and cached for a minute between requests.
   Every write through the app marks its tab dirty, and onEdit does the same for edits made by hand in the sheet,
   so nothing stale is shown. ----- */
let MEMO_ = {};
const CACHE_TTL_ = 90;
function gen_(n) { return CacheService.getScriptCache().get('G:' + n) || '0'; }
function dirty_(names) {
  const c = CacheService.getScriptCache();
  [].concat(names).filter(Boolean).forEach(n => { Object.keys(MEMO_).forEach(k => { if (n === '*' || k === n || k.indexOf(n + '#') === 0) delete MEMO_[k]; }); c.put('G:' + n, String(Date.now()) + Math.random().toString(36).slice(2, 6), 21600); });
}
function pack_(v) { return v.map(r => r.map(x => x instanceof Date ? { $d: x.getTime() } : x)); }
function unpack_(v) { return v.map(r => r.map(x => x && typeof x === 'object' && '$d' in x ? new Date(x.$d) : x)); }
/** Cached read of a whole tab (by name). Use for reading only – writes need vals_ on the live sheet. */
function rv_(ss, n, tailRows) {
  const k = n + (tailRows ? '#' + tailRows : '');
  if (MEMO_[k]) return MEMO_[k];
  const c = CacheService.getScriptCache(), key = 'V' + VERSION + ':' + k + ':' + gen_(n) + ':' + gen_('*');
  const hit = c.get(key);
  if (hit) { try { return (MEMO_[k] = unpack_(JSON.parse(hit))); } catch (e) {} }
  const sh = ss.getSheetByName(n), v = tailRows ? tail_(sh, tailRows) : vals_(sh);
  MEMO_[k] = v;
  try { const t = JSON.stringify(pack_(v)); if (t.length < 95000) c.put(key, t, CACHE_TTL_); } catch (e) {}
  return v;
}
/** Simple trigger: edits made by hand in the sheet clear that tab's cache right away. */
function onEdit(e) { try { dirty_(e.range.getSheet().getName()); } catch (err) {} }
function setting_(ss, label) { const r = rv_(ss, 'Settings').find(x => String(x[0]).trim() === label); return r ? String(r[1]).trim() : ''; }
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
function toMs_(v) { if (v instanceof Date) return v.getTime(); const n = Number(v); return n > 1e11 ? n : (v ? Date.parse(v) || 0 : 0); }
function toIso_(v) { if (v instanceof Date && !isNaN(v)) return v.toISOString(); const n = Number(v); return n > 1e11 ? new Date(n).toISOString() : ''; }
function clean_(v, max) { let t = String(v == null ? '' : v).slice(0, max).trim(); return /^[=+\-@]/.test(t) ? "'" + t : t; }
function esc_(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function nextId_(sh, prefix) {
  let n = 0; vals_(sh).forEach(r => { const m = String(r[0]).match(new RegExp('^' + prefix + '(\\d+)$')); if (m) n = Math.max(n, Number(m[1])); });
  return prefix + pad_(n + 1);
}
function findRow_(sh, id) { const v = vals_(sh); for (let i = 0; i < v.length; i++) if (String(v[i][0]) === String(id)) return i + 2; return 0; }
