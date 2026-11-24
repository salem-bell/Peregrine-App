/**
 * Peregrine Team – the Training tab's server side (everything except tests and study guides, which stay in the
 * test portal). Lives next to Code.gs in the same Apps Script project, in both location sheets.
 *
 *  - Employee Manual: read it in the app, then sign (Manual progress, Manual acks tabs).
 *  - Resources: searchable reference library (content in TrainingContent.gs).
 *  - Forms: food handler certificate (+ reimbursement on the pay period's payroll workbook), confidential concerns,
 *    Lead reports, Manager write-ups (signed by the employee in the app). PDFs go to Settings › HR folder › <name>.
 *  - Dashboards for Leads and Managers, level badges, recipe change alerts.
 * Everyone is identified by their app sign-in; there are no extra codes.
 */

const TR_ROLES_LEAD_ = ['Lead', 'Manager'];
const trLead_ = (me) => me.role === 'Lead' || me.role === 'Manager';
/** Read-only rows of a tab: memoized per request and cached between requests (writes call dirty_ on the tab). */
function trRows_(ss, name) {
  if (!ss.getSheetByName(name)) buildTab_(ss, name);
  return rv_(ss, name);
}
function trTab_(ss, name) {
  if (!ss.getSheetByName(name)) buildTab_(ss, name);
  return ss.getSheetByName(name);
}
function trPerson_(ss, name) {
  const k = String(name || '').trim().toLowerCase();
  const r = rv_(ss, 'Users').find((x) => String(x[0]).trim().toLowerCase() === k && truthy_(x[3]) && !isShop_(x));
  return r ? { name: String(r[0]).trim(), role: role_(r[1]), added: r[8] instanceof Date ? r[8] : null, id: String(r[6]) } : null;
}
function trWhen_(ss, d) {
  return Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), "EEE, MMM d 'at' h:mm a");
}
function trDay_(ss, d) {
  return Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), 'EEE, MMM d');
}

/** One entry point for the Training tab: post({ fn: 'hr', token, call, args }). */
function hr_(token, call, a) {
  const ss = SpreadsheetApp.getActive(),
    me = who_(ss, token);
  a = a || {};
  if (me.role === 'Shop') throw new Error('Open Training on your own phone');
  needFeature_({ manual: 'manual', manualStep: 'manual', manualAck: 'manual', resources: 'library', recipeAck: 'recipeAlerts', sign: 'hr', form: 'hr', food: 'foodhandler', dash: 'progress', ackProf: 'progress', voidReimb: 'payroll' }[String(call)]);
  const needLead = () => {
    if (!trLead_(me)) throw new Error('Only leads and managers can do that');
  };
  const needMgr = () => {
    if (me.role !== 'Manager') throw new Error('Only managers can do that');
  };
  switch (String(call)) {
    case 'home':
      return trHome_(ss, me);
    case 'manual':
      return trManual_(ss, me);
    case 'manualStep':
      return trManualStep_(ss, me, String(a.id || ''));
    case 'manualAck':
      return trManualAck_(ss, me, a);
    case 'resources':
      return {
        ok: true,
        resources: trResourcesLive_().filter((r) => r.who !== 'lead' || trLead_(me)),
        manual: trManualLive_().map((c) => ({ title: c.title, sections: c.sections })),
      };
    case 'recipeAck':
      return trRecipeAck_(ss, me, a.ids || []);
    case 'sign':
      return trSign_(ss, me, a);
    case 'food':
      return trFood_(ss, me, a);
    case 'form':
      if (a.type === 'leadreport') needLead();
      if (a.type === 'corrective') needMgr();
      return trForm_(ss, me, a);
    case 'dash':
      needLead();
      return trDash_(ss, me);
    case 'ackProf':
      needLead();
      return trAckProf_(ss, me, a);
    case 'voidReimb':
      needMgr();
      return trVoidReimb_(ss, a.id);
  }
  throw new Error('Unknown request');
}

/* ---------------- home: what the Training tab shows at the top ---------------- */
function trHome_(ss, me) {
  const mv = trManualVersion_(ss);
  return {
    ok: true,
    me: { name: me.name, role: me.role },
    level: (trLevels_(ss)[me.name] || null),
    manual: feat_('manual') ? trManualStatus_(ss, me, mv) : { acked: 'n/a', gates: false, done: 0, total: 0 },
    alerts: feat_('recipeAlerts') ? trRecipeAlerts_(ss, me) : [],
    docs: feat_('hr') ? trMyDocs_(ss, me) : [],
    food: feat_('foodhandler') ? trMyFood_(ss, me) : { onFile: { uploaded: '', expires: '' } },
    owner: setting_(ss, 'Owner contact') || 'the owner',
  };
}
/** For the app's own data load: small counts for the Training tab badge. */
function trBadge_(ss, me) {
  try {
    if (me.role === 'Shop') return null;
    const m = feat_('manual') ? trManualStatus_(ss, me, trManualVersion_(ss)) : { acked: 'n/a' };
    const f = feat_('foodhandler') ? trMyFood_(ss, me) : { onFile: true };
    return { manual: m.acked ? 0 : 1, recipes: feat_('recipeAlerts') ? trRecipeAlerts_(ss, me).length : 0, sign: feat_('hr') ? trMyDocs_(ss, me).length : 0, food: f.onFile ? '' : f.overdue ? 'overdue' : f.due ? 'due ' + f.due : '', foodOn: !!f.onFile };
  } catch (e) {
    return null;
  }
}

/* ---------------- Employee Manual ---------------- */
/** A manual version as plain text. Sheets turns "2026-11" into a date, so dates (or their text) become yyyy-MM again. */
function trVer_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, 'UTC', 'yyyy-MM');
  const t = String(v == null ? '' : v).trim();
  if (/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4}/.test(t) && !isNaN(Date.parse(t))) return Utilities.formatDate(new Date(Date.parse(t)), 'UTC', 'yyyy-MM');
  return t;
}
function trManualVersion_(ss) {
  return trVer_(setting_(ss, 'Manual version')) || '2026-11';
}
function trManualSteps_() {
  if (MEMO_.trSteps) return MEMO_.trSteps;
  const out = (MEMO_.trSteps = []);
  trManualLive_().forEach((c, i) => {
    c.sections.forEach((s, j) => out.push('c' + (i + 1) + 's' + (j + 1)));
    if (c.check && c.check.length) out.push('c' + (i + 1) + 'q');
  });
  return out;
}
function trManualProgress_(ss, name, live) {
  const v = live ? vals_(trTab_(ss, 'Manual progress')) : trRows_(ss, 'Manual progress'),
    i = v.findIndex((r) => String(r[0]).trim() === name);
  const done = {};
  if (i >= 0)
    String(v[i][1] || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((x) => (done[x] = true));
  return { done, row: i >= 0 ? i + 2 : 0, completed: i >= 0 && !!v[i][2] };
}
function trManualStatus_(ss, me, mv) {
  const steps = trManualSteps_(),
    p = trManualProgress_(ss, me.name),
    got = steps.filter((s) => p.done[s]).length;
  const ack = trRows_(ss, 'Manual acks').filter((r) => String(r[0]).trim() === me.name && trVer_(r[1]) === mv).pop();
  return {
    version: mv,
    done: got,
    total: steps.length,
    complete: p.completed || got === steps.length,
    acked: ack ? trWhen_(ss, ack[3] instanceof Date ? ack[3] : new Date()) : '',
    gates: feat_('manual') && !/^off$/i.test(setting_(ss, 'Lock tests until the manual is signed')),
  };
}
function trManual_(ss, me) {
  const p = trManualProgress_(ss, me.name);
  const chapters = trManualLive_().map((c, i) => ({
    id: 'c' + (i + 1),
    title: c.title,
    intro: c.intro || '',
    sections: c.sections.map((s, j) => ({ id: 'c' + (i + 1) + 's' + (j + 1), title: s.title, b: s.b })),
    check: (c.check || []).map((q) => {
      const right = q[1][0],
        o = q[1].slice().sort(() => Math.random() - 0.5);
      return { p: q[0], o, a: o.indexOf(right), why: q[2] || '' };
    }),
  }));
  return { ok: true, chapters, done: Object.keys(p.done), status: trManualStatus_(ss, me, trManualVersion_(ss)) };
}
function trManualStep_(ss, me, id) {
  const steps = trManualSteps_();
  if (steps.indexOf(id) < 0) throw new Error('Unknown section');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = trTab_(ss, 'Manual progress'),
      p = trManualProgress_(ss, me.name, true);
    p.done[id] = true;
    const ids = Object.keys(p.done),
      complete = p.completed || steps.every((s) => p.done[s]);
    const row = [me.name, ids.join(', '), complete ? new Date() : '', new Date()];
    if (p.row) {
      const old = sh.getRange(p.row, 3).getValue();
      if (old) row[2] = old;
      sh.getRange(p.row, 1, 1, 4).setValues([row]);
    } else sh.appendRow(row);
    dirty_('Manual progress');
    return { ok: true, done: ids.length, total: steps.length, complete };
  } finally {
    lock.releaseLock();
  }
}
function trManualAck_(ss, me, a) {
  const sig = clean_(a.signature, 80);
  if (!a.agree) throw new Error('Check the box to agree');
  if (sig.toLowerCase().replace(/\s+/g, ' ') !== me.name.toLowerCase()) throw new Error('Type your full name exactly: ' + me.name);
  const st = trManualStatus_(ss, me, trManualVersion_(ss));
  if (!st.complete) throw new Error('Finish every section of the manual first');
  if (!st.acked) trTab_(ss, 'Manual acks').appendRow([me.name, st.version, sig, new Date()]);
  dirty_('Manual acks');
  return { ok: true, acked: trWhen_(ss, new Date()) };
}

/* ---------------- levels (the name badges) ---------------- */
/** name → { code, label, iv }. T Trainee, L1 Level I, L2P passed Level II + Coffee Knowledge but not acknowledged,
    L2 Level II, LD Lead, MG Manager; iv = passed Level IV. From the test results and the Proficiency tab. Cached 10 min. */
function trLevels_(ss) {
  if (MEMO_.trLevels) return MEMO_.trLevels;
  const c = CacheService.getScriptCache(),
    k = 'TRLV:' + gen_('Proficiency') + ':' + gen_('Users'),
    hit = c.get(k);
  if (hit)
    try {
      return (MEMO_.trLevels = JSON.parse(hit));
    } catch (e) {}
  const out = (MEMO_.trLevels = {});
  let T = null;
  try {
    T = testTeam_(ss);
  } catch (e) {}
  const tests = rv_(ss, 'Tests').filter((r) => String(r[0]).trim());
  const find = (re, nameRe) => {
    const r = tests.find((x) => re.test(String(x[1]))) || tests.find((x) => nameRe.test(String(x[0])));
    return r ? String(r[0]).trim() : '';
  };
  const n1 = find(/[?&]level=1\b/, /level\s*(i|1)\b(?!i|v)/i),
    n2 = find(/[?&]level=2\b/, /level\s*(ii|2)\b/i),
    nc = find(/[?&]level=coffee\b/, /^coffee knowledge/i),
    n4 = find(/[?&]level=4\b/, /level\s*(iv|4)\b/i);
  const prof = {};
  trRows_(ss, 'Proficiency').forEach((r) => {
    if (String(r[0]).trim()) prof[String(r[0]).trim()] = true;
  });
  const pass = (p, t) => !!(t && p.r && p.r[t] && p.r[t].s === 'pass');
  rv_(ss, 'Users')
    .filter((r) => String(r[0]).trim() && truthy_(r[3]) && !isShop_(r))
    .forEach((r) => {
      const name = String(r[0]).trim(),
        role = role_(r[1]),
        p = (T && T.people.find((x) => x.name === name)) || { r: {} };
      let lv = { code: 'T', label: 'Trainee' };
      if (pass(p, n1)) lv = { code: 'L1', label: 'Level I' };
      if (pass(p, n2) && pass(p, nc)) lv = prof[name] ? { code: 'L2', label: 'Level II' } : { code: 'L2P', label: 'Level II · needs acknowledgment' };
      if (role === 'Lead') lv = { code: 'LD', label: 'Lead' };
      if (role === 'Manager') lv = { code: 'MG', label: 'Manager' };
      lv.iv = pass(p, n4);
      out[name] = lv;
    });
  try {
    c.put(k, JSON.stringify(out), 600);
  } catch (e) {}
  return out;
}
function trAckProf_(ss, me, a) {
  const t = trPerson_(ss, a.who);
  if (!t) throw new Error('Pick someone on the team');
  const lv = trLevels_(ss)[t.name];
  if (!lv || lv.code !== 'L2P') throw new Error(t.name + ' needs to pass both the Level II and Coffee Knowledge tests first');
  trTab_(ss, 'Proficiency').appendRow([t.name, me.name, new Date(), clean_(a.note, 500)]);
  dirty_('Proficiency');
  trLog_(ss, 'Level II proficiency acknowledged', t.name, me.name, 'Done', '');
  return { ok: true };
}

/* ---------------- HR records: PDFs in Settings › HR folder › <name> ---------------- */
function trLog_(ss, type, about, by, status, link, id) {
  id = id || 'h' + newId_(8);
  trTab_(ss, 'HR log').appendRow([id, new Date(), type, about, by, status, link]);
  dirty_('HR log');
  return id;
}
function trHrFolder_(ss, person) {
  const id = driveId_2(setting_(ss, 'HR folder'));
  if (!id) throw new Error('A manager needs to add the Drive folder in Settings › HR folder first');
  const root = DriveApp.getFolderById(id),
    it = root.getFoldersByName(person);
  return it.hasNext() ? it.next() : root.createFolder(person);
}
function trPdf_(ss, folder, name, title, sub, fields, extra) {
  const e = (s) =>
    String(s == null ? '' : s)
      .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
      .replace(/\n/g, '<br>');
  const html =
    '<html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:11pt;color:#222;margin:28px}h1{font-size:18pt;margin:0;color:#1e5662}' +
    '.sub{color:#666;margin:4px 0 18px}.brand{font-size:9pt;letter-spacing:2px;color:#1e5662}table{width:100%;border-collapse:collapse}' +
    'td{border:1px solid #ccc;padding:7px 9px;vertical-align:top}td.k{width:32%;background:#f3f0ea;font-weight:bold}.sig{margin-top:22px;padding:10px;border:1px solid #ccc}' +
    '.foot{margin-top:24px;font-size:8.5pt;color:#777}</style></head><body><div class="brand">' +
    e((setting_(ss, 'Shop name') || 'Peregrine').toUpperCase()) +
    '</div><h1>' +
    e(title) +
    '</h1><div class="sub">' +
    e(sub) +
    '</div><table>' +
    fields
      .filter((f) => f[1] !== '' && f[1] != null)
      .map((f) => '<tr><td class="k">' + e(f[0]) + '</td><td>' + e(f[1]) + '</td></tr>')
      .join('') +
    '</table>' +
    (extra || '') +
    '<div class="foot">Filed from the Peregrine Team app. Electronic signatures are recorded with the signer\'s app sign-in.</div></body></html>';
  const blob = Utilities.newBlob(html, 'text/html', name + '.html').getAs(MimeType.PDF).setName(name + '.pdf');
  return folder.createFile(blob);
}
const trStamp_ = (ss) => Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');

function trForm_(ss, me, a) {
  const d = a.data || {},
    c = (k, n) => clean_(d[k] || '', n || 3000),
    filed = trWhen_(ss, new Date());
  if (!String(d.details || '').trim()) throw new Error('Describe what happened');
  if (a.type === 'leadreport') {
    const about = c('about', 80),
      who = about ? trPerson_(ss, about) : null;
    if (about && !who) throw new Error('No active team member named ' + about);
    const f = trPdf_(ss, trHrFolder_(ss, who ? who.name : 'Lead Reports'), trStamp_(ss) + ' Lead Report – ' + c('category', 60), 'Lead Report', c('category', 120), [
      ['Report type', c('category', 120)],
      ['About', who ? who.name : '(not about one person)'],
      ['Date of event', c('date', 40)],
      ['Policy', c('policy', 120)],
      ['What happened', c('details')],
      ['Action taken', c('action')],
      ['Filed by', me.name + ' (' + me.role + ')'],
      ['Filed', filed],
    ]);
    trLog_(ss, 'Lead Report · ' + c('category', 60), who ? who.name : '—', me.name, 'Filed', f.getUrl());
    return { ok: true, msg: 'Report filed for the manager.' };
  }
  if (a.type === 'corrective') {
    const emp = trPerson_(ss, c('employee', 80));
    if (!emp) throw new Error('Pick someone on the team');
    const id = 'h' + newId_(8),
      w = {
        id,
        employee: emp.name,
        step: c('step', 80),
        date: c('date', 40),
        policy: c('policy', 160),
        details: c('details'),
        prior: c('prior', 1000),
        expect: c('expect', 2000),
        consequence: c('consequence', 1000),
        probation: c('probation', 200),
        by: me.name,
        filed,
      };
    const f = trPdf_(ss, trHrFolder_(ss, emp.name), trStamp_(ss) + ' Corrective Action – ' + w.step, 'Corrective Action', w.step + ' · ' + w.employee, trWuFields_(w), trWuSig_(w, null));
    w.fileId = f.getId();
    PropertiesService.getScriptProperties().setProperty('HRDOC_' + id, JSON.stringify(w));
    trLog_(ss, 'Corrective Action · ' + w.step, emp.name, me.name, 'Awaiting employee signature', f.getUrl(), id);
    return { ok: true, msg: 'Saved to ' + emp.name + "'s HR folder. They'll be asked to sign it in the app." };
  }
  if (a.type === 'concern') {
    if (d.involvesManager) return { ok: false, redirect: true, msg: 'Please report this directly to the owner: ' + (setting_(ss, 'Owner contact') || 'the owner') + '. Concerns that involve the Manager are not submitted through the app.' };
    const f = trPdf_(ss, trHrFolder_(ss, me.name), trStamp_(ss) + ' Confidential Concern Report', 'Confidential Concern Report', 'Handled as privately as possible. Retaliation against anyone who reports in good faith is not allowed.', [
      ['Kind of concern', c('kind', 120)],
      ['Reported by', me.name],
      ['People involved', c('involved', 500)],
      ['When', c('date', 80)],
      ['Where', c('where', 200)],
      ['What happened', c('details')],
      ['Witnesses', c('witnesses', 500)],
      ['Reported before?', c('before', 300)],
      ['Submitted', filed],
    ]);
    trLog_(ss, 'Confidential report', me.name, me.name, 'New', f.getUrl());
    return { ok: true, msg: 'Submitted privately to the manager.' };
  }
  throw new Error('Unknown form');
}
function trWuFields_(w) {
  return [
    ['Employee', w.employee],
    ['Step', w.step],
    ['Date of incident', w.date],
    ['Policy or standard', w.policy],
    ['What happened', w.details],
    ['Previous steps', w.prior],
    ['What must change', w.expect],
    ['If it happens again', w.consequence],
    ['Probation', w.probation],
  ];
}
function trWuSig_(w, sig) {
  const e = (s) => String(s || '').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  return (
    '<div class="sig"><b>Issued by:</b> ' + e(w.by) + ' · ' + e(w.filed) + '</div><div class="sig"><b>Employee acknowledgment.</b> Signing means I received this, not that I agree. I may add my side in writing.<br><br>' +
    (sig ? '<b>Signed:</b> ' + e(sig.name) + ' · ' + e(sig.when) + (sig.comment ? "<br><b>Employee's comments:</b><br>" + e(sig.comment) : '') : "<i>Awaiting the employee's signature.</i>") +
    '</div>'
  );
}
function trMyDocs_(ss, me) {
  const props = PropertiesService.getScriptProperties();
  return trRows_(ss, 'HR log')
    .filter((r) => String(r[5]) === 'Awaiting employee signature' && String(r[3]).trim() === me.name)
    .map((r) => {
      const raw = props.getProperty('HRDOC_' + r[0]);
      if (!raw) return null;
      const w = JSON.parse(raw);
      return { id: w.id, title: 'Corrective Action · ' + w.step, by: w.by, filed: w.filed, fields: trWuFields_(w).filter((f) => f[1] && f[0] !== 'Employee') };
    })
    .filter(Boolean);
}
function trSign_(ss, me, a) {
  const props = PropertiesService.getScriptProperties(),
    raw = props.getProperty('HRDOC_' + a.id);
  if (!raw) throw new Error("That document isn't waiting for a signature");
  const w = JSON.parse(raw);
  if (w.employee !== me.name) throw new Error("This document isn't yours to sign");
  const sig = { name: me.name, when: trWhen_(ss, new Date()), comment: clean_(a.comment, 3000) };
  try {
    DriveApp.getFileById(w.fileId).setTrashed(true);
  } catch (e) {}
  const f = trPdf_(ss, trHrFolder_(ss, w.employee), trStamp_(ss) + ' Corrective Action – ' + w.step + ' (signed)', 'Corrective Action', w.step + ' · ' + w.employee, trWuFields_(w), trWuSig_(w, sig));
  const sh = trTab_(ss, 'HR log'),
    v = vals_(sh),
    i = v.findIndex((r) => String(r[0]) === w.id);
  if (i >= 0) sh.getRange(i + 2, 6, 1, 2).setValues([['Signed by employee', f.getUrl()]]);
  props.deleteProperty('HRDOC_' + a.id);
  dirty_('HR log');
  return { ok: true };
}

/* ---------------- food handler certificate + reimbursement on payroll ---------------- */
function trMyFood_(ss, me) {
  const r = trRows_(ss, 'Food handler').find((x) => String(x[0]).trim() === me.name);
  const p = trPerson_(ss, me.name),
    days = Number(setting_(ss, 'Food handler due (days after added)')) || 14,
    due = p && p.added ? new Date(p.added.getTime() + days * 864e5) : null;
  return {
    onFile: r ? { uploaded: r[1] instanceof Date ? trDay_(ss, r[1]) : String(r[1]), expires: String(r[2] || '') } : null,
    due: due ? trDay_(ss, due) : '',
    overdue: !r && !!due && due < new Date(),
    max: Number(setting_(ss, 'Food handler reimbursement (max $)')) || 15,
  };
}
function trFood_(ss, me, a) {
  if (vals_(trTab_(ss, 'Food handler')).some((x) => String(x[0]).trim() === me.name)) throw new Error('Your certificate is already on file. Ask a manager if it needs replacing.');
  if (!a.file || !a.file.data) throw new Error('Attach a photo or PDF of your certificate');
  const folder = trHrFolder_(ss, me.name);
  const put = (f, label) => {
    if (!f || !f.data) return null;
    const bytes = Utilities.base64Decode(String(f.data));
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Files must be under 10 MB');
    const ext = (String(f.name || '').match(/\.[a-z0-9]{1,5}$/i) || [''])[0];
    return folder.createFile(Utilities.newBlob(bytes, String(f.type || 'application/octet-stream'), trStamp_(ss) + ' ' + label + ext));
  };
  const cert = put(a.file, 'Food Handler Certificate'),
    rcpt = put(a.receipt, 'Food Handler Receipt');
  const max = Number(setting_(ss, 'Food handler reimbursement (max $)')) || 15,
    cost = Math.max(0, Math.round((parseFloat(a.cost) || 0) * 100) / 100),
    amt = Math.min(cost, max);
  const tz = ss.getSpreadsheetTimeZone(),
    period = payPeriod_(ss, Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
  trTab_(ss, 'Food handler').appendRow([me.name, new Date(), clean_(a.expires, 40), cost, amt, period[0], cert.getUrl(), rcpt ? rcpt.getUrl() : '']);
  trLog_(ss, 'Food handler certificate', me.name, me.name, 'On file', cert.getUrl());
  trFoodSkill_(ss, me.name);
  if (amt > 0) trTab_(ss, 'Reimbursements').appendRow(['m' + newId_(8), me.name, 'Food handler certificate', amt, period[0], new Date(), 'Queued', '']);
  dirty_(['Food handler', 'Reimbursements']);
  return { ok: true, amount: amt, period: longDay_(period[0]) + ' – ' + longDay_(period[1]) };
}
function trVoidReimb_(ss, id) {
  const sh = trTab_(ss, 'Reimbursements'),
    v = vals_(sh),
    i = v.findIndex((r) => String(r[0]) === String(id));
  if (i < 0) throw new Error('Not found');
  if (String(v[i][6]) !== 'Queued') throw new Error("It's already on a payroll workbook – remove it from that workbook's Reimbursements tab");
  sh.getRange(i + 2, 7).setValue('Voided');
  dirty_('Reimbursements');
  return { ok: true };
}
/** Called by payrollMake_ for each pay period's workbook: writes that period's reimbursements into its Reimbursements tab
    and adds Reimbursement and Total Payout columns to Summary. Rebuilding the workbook rewrites them. */
function trPayroll_(ss, x, from) {
  if (!feat_('payroll')) return 0;
  const sh = trTab_(ss, 'Reimbursements'),
    v = vals_(sh),
    tz = ss.getSpreadsheetTimeZone();
  const mine = v.map((r, i) => ({ r, i })).filter(({ r }) => ymd_(r[4], tz) === from && String(r[6]) !== 'Voided');
  let t = x.getSheetByName('Reimbursements');
  if (!t) t = x.insertSheet('Reimbursements');
  t.clearContents();
  t.getRange(1, 1, 1, 4).setValues([['Employee', 'Type', 'Amount', 'Added']]).setFontWeight('bold');
  if (mine.length) {
    t.getRange(2, 1, mine.length, 4).setValues(mine.map(({ r }) => [String(r[1]), String(r[2]), Number(r[3]) || 0, r[5]]));
    t.getRange(2, 3, mine.length, 1).setNumberFormat('$#,##0.00');
  }
  const s = x.getSheetByName('Summary');
  if (s) {
    const sv = s.getDataRange().getValues();
    let hr = -1,
      tot = -1;
    for (let i = 0; i < sv.length && hr < 0; i++) {
      const c = sv[i].indexOf('Total Pay');
      if (String(sv[i][0]).trim() === 'Employee' && c >= 0) {
        hr = i;
        tot = c;
      }
    }
    if (hr >= 0) {
      let col = sv[hr].indexOf('Reimbursement') + 1;
      if (!col) {
        col = sv[hr].filter((c) => String(c) !== '').length + 1;
        s.getRange(hr + 1, col, 1, 2).setValues([['Reimbursement', 'Total Payout']]).setFontWeight('bold');
      }
      const L = (n) => {
          let o = '';
          while (n > 0) {
            const m = (n - 1) % 26;
            o = String.fromCharCode(65 + m) + o;
            n = Math.floor((n - 1) / 26);
          }
          return o;
        },
        rc = L(col),
        tl = L(tot + 1),
        first = hr + 2;
      for (let j = hr + 1; j < sv.length; j++) {
        const nm = String(sv[j][0] || '').trim();
        if (!nm) break;
        if (/grand total/i.test(nm)) {
          s.getRange(j + 1, col, 1, 2).setFormulas([['=SUM(' + rc + first + ':' + rc + j + ')', '=SUM(' + L(col + 1) + first + ':' + L(col + 1) + j + ')']]);
          break;
        }
        s.getRange(j + 1, col, 1, 2).setFormulas([['=IFERROR(SUMIF(Reimbursements!$A:$A,$A' + (j + 1) + ',Reimbursements!$C:$C),0)', '=N(' + tl + (j + 1) + ')+' + rc + (j + 1)]]);
      }
      s.getRange(first, col, sv.length, 2).setNumberFormat('$#,##0.00');
    }
  }
  mine.forEach(({ i }) => sh.getRange(i + 2, 7, 1, 2).setValues([['On payroll', x.getUrl()]]));
  if (mine.length) dirty_('Reimbursements');
  return mine.length;
}

/* ---------------- recipe change alerts ---------------- */
function trRecipeText_(r) {
  return [r[3] ? 'Size: ' + r[3] : '', String(r[6] || '').trim(), String(r[7] || '').trim() ? 'Steps:\n' + String(r[7]).trim() : '', String(r[8] || '').trim() ? 'Notes: ' + String(r[8]).trim() : '']
    .filter(Boolean)
    .join('\n');
}
/** Every 15 minutes (from the reminders trigger): compares the Recipes tab with the last snapshot and logs changes to
    recipes everyone sees. Edits in the app and by hand in the sheet are both caught. */
function trRecipeWatch_(ss) {
  if (!ss.getSheetByName('Recipes')) return;
  const alerts = feat_('recipeAlerts');
  const cur = {};
  vals_(ss.getSheetByName('Recipes')).forEach((r) => {
    if (!String(r[0]).trim() || !(r[10] === '' || truthy_(r[10])) || /lead|manager/i.test(String(r[11] || ''))) return;
    cur[(/^prep/i.test(String(r[1])) ? 'Prep' : 'Drink') + ' · ' + String(r[0]).trim()] = trRecipeText_(r);
  });
  const snap = trTab_(ss, 'Recipe snapshot'),
    sv = vals_(snap),
    old = {};
  sv.forEach((r) => (old[String(r[0])] = String(r[1])));
  const first = !sv.length,
    log = trTab_(ss, 'Recipe changes'),
    now = new Date(),
    rows = [];
  const split = (k) => [k.split(' · ')[0], k.split(' · ').slice(1).join(' · ')];
  if (!first) {
    Object.keys(cur).forEach((k) => {
      if (!(k in old)) rows.push(['r' + newId_(8), now, split(k)[1], split(k)[0], 'Added', '', cur[k]]);
      else if (old[k] !== cur[k]) rows.push(['r' + newId_(8), now, split(k)[1], split(k)[0], 'Changed', old[k], cur[k]]);
    });
    Object.keys(old).forEach((k) => {
      if (!(k in cur)) rows.push(['r' + newId_(8), now, split(k)[1], split(k)[0], 'Removed', old[k], '']);
    });
  }
  if (rows.length && alerts) log.getRange(log.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
  if (first || rows.length) {
    try {
      trMenuDoc_(ss);
    } catch (e) {
      console.warn('drink menu doc: ' + e);
    }
    if (snap.getLastRow() > 1) snap.getRange(2, 1, snap.getLastRow() - 1, 2).clearContent();
    const keys = Object.keys(cur);
    if (keys.length) snap.getRange(2, 1, keys.length, 2).setValues(keys.map((k) => [k, cur[k]]));
    dirty_(['Recipe changes', 'Recipe snapshot']);
  }
  if (rows.length && alerts) {
    try {
      const users = vals_(ss.getSheetByName('Users')).filter((r) => truthy_(r[3]) && r[6] && !isShop_(r));
      push_(
        ss,
        users.map((u) => ({
          uid: String(u[6]),
          kind: 'news',
          title: 'Peregrine · recipe ' + (rows.length === 1 ? 'change: ' + rows[0][2] : 'changes: ' + rows.length),
          body: 'Read the new build in Training before your next shift.',
          url: '?go=tests',
          tag: 'recipes',
        }))
      );
    } catch (e) {}
  }
}
function trRecipeAlerts_(ss, me) {
  const cut = Date.now() - 30 * 864e5,
    tz = ss.getSpreadsheetTimeZone();
  const read = {},
    rr = trRows_(ss, 'Recipe change reads').find((r) => String(r[0]).trim() === me.name);
  if (rr)
    String(rr[1] || '')
      .split(',')
      .forEach((x) => {
        if (x.trim()) read[x.trim()] = true;
      });
  return trRows_(ss, 'Recipe changes')
    .filter((r) => r[0] && r[1] instanceof Date && r[1].getTime() >= cut && !read[String(r[0])])
    .reverse()
    .map((r) => ({ id: String(r[0]), date: Utilities.formatDate(r[1], tz, 'MMM d'), recipe: String(r[2]), type: String(r[3]), change: String(r[4]), before: String(r[5]), after: String(r[6]) }));
}
function trRecipeAck_(ss, me, ids) {
  const sh = trTab_(ss, 'Recipe change reads'),
    v = vals_(sh),
    i = v.findIndex((r) => String(r[0]).trim() === me.name);
  const have = i >= 0 ? String(v[i][1] || '').split(',').map((x) => x.trim()).filter(Boolean) : [];
  ids.map(String).forEach((x) => {
    if (have.indexOf(x) < 0) have.push(x);
  });
  const keep = have.slice(-400).join(', ');
  if (i >= 0) sh.getRange(i + 2, 2, 1, 2).setValues([[keep, new Date()]]);
  else sh.appendRow([me.name, keep, new Date()]);
  dirty_('Recipe change reads');
  return { ok: true };
}

/* ---------------- dashboards ---------------- */
function trDash_(ss, me) {
  const mgr = me.role === 'Manager',
    tz = ss.getSpreadsheetTimeZone(),
    mv = trManualVersion_(ss);
  const L = trLevels_(ss);
  let T = null;
  try {
    T = testTeam_(ss);
  } catch (e) {}
  const acks = {};
  trRows_(ss, 'Manual acks').forEach((r) => {
    if (trVer_(r[1]) === mv) acks[String(r[0]).trim()] = true;
  });
  const prof = {};
  trRows_(ss, 'Proficiency').forEach((r) => {
    if (String(r[0]).trim()) prof[String(r[0]).trim()] = String(r[1]);
  });
  const food = {};
  trRows_(ss, 'Food handler').forEach((r) => {
    if (String(r[0]).trim()) food[String(r[0]).trim()] = { uploaded: r[1] instanceof Date ? trDay_(ss, r[1]) : '', amount: Number(r[4]) || 0 };
  });
  const changes = trRows_(ss, 'Recipe changes').filter((r) => r[1] instanceof Date && r[1].getTime() > Date.now() - 30 * 864e5);
  const reads = {};
  trRows_(ss, 'Recipe change reads').forEach((r) => {
    reads[String(r[0]).trim()] = String(r[1] || '');
  });
  const days = Number(setting_(ss, 'Food handler due (days after added)')) || 14;
  const team = rv_(ss, 'Users')
    .filter((r) => String(r[0]).trim() && truthy_(r[3]) && !isShop_(r))
    .map((r) => {
      const name = String(r[0]).trim(),
        added = r[8] instanceof Date ? r[8] : null,
        due = added ? new Date(added.getTime() + days * 864e5) : null;
      const p = (T && T.people.find((x) => x.name === name)) || { r: {} };
      const f = food[name];
      return {
        name,
        role: role_(r[1]),
        level: L[name] || { code: 'T', label: 'Trainee' },
        manual: !!acks[name],
        tests: p.r,
        prof: prof[name] || '',
        food: f ? { on: true, uploaded: f.uploaded, amount: mgr ? f.amount : undefined } : { on: false, due: due ? trDay_(ss, due) : '', overdue: !!due && due < new Date() },
        unread: changes.filter((c) => (reads[name] || '').indexOf(String(c[0])) < 0).length,
      };
    });
  const out = {
    ok: true,
    manager: mgr,
    tests: T ? T.tests : [],
    team,
    changes: changes.reverse().slice(0, 20).map((c) => ({ date: Utilities.formatDate(c[1], tz, 'MMM d'), recipe: String(c[2]), type: String(c[3]), change: String(c[4]) })),
  };
  if (mgr) {
    out.hr = trRows_(ss, 'HR log')
      .slice(-60)
      .reverse()
      .map((r) => ({ date: r[1] instanceof Date ? trWhen_(ss, r[1]) : '', type: String(r[2]), about: String(r[3]), by: String(r[4]), status: String(r[5]), link: String(r[6] || '') }));
    out.reimb = trRows_(ss, 'Reimbursements')
      .slice(-40)
      .reverse()
      .map((r) => ({ id: String(r[0]), name: String(r[1]), type: String(r[2]), amount: Number(r[3]) || 0, period: ymd_(r[4], tz), status: String(r[6]), link: String(r[7] || '') }));
    out.hrFolder = setting_(ss, 'HR folder');
  }
  return out;
}

/* ======================================================================================
   EDITABLE CONTENT: the Employee Manual and the resource pages live in sheet tabs.
   Manual: one row per section. Manual checks: one row per question. Resource pages: one row per section.
   The Text column uses simple formatting (also explained on the Start Here tab):
     ## Heading            - bullet            1. numbered step        [ ] tap-to-check item
     Note: …  Tip: …  Warning: …  (a box)      | a | b | (table row; the first row is the header)
     ?? Question | Answer  (tap to reveal)     **bold**   *italic*     {{deposit}} drawer calculator
     {{list Drawer close}} button that opens that checklist in Lists
   Blank line = new paragraph. If a tab is empty it is filled once from TrainingContent.gs.
   ====================================================================================== */
function trInline_(s) {
  return esc_(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>');
}
/** The sheet formatting → the HTML the app shows. */
function trMd_(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n'),
    out = [];
  let list = null,
    para = [],
    table = null;
  const flushPara = () => {
    if (para.length) out.push('<p>' + para.map(trInline_).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (list) out.push('<' + list.tag + (list.cls ? ' class="' + list.cls + '"' : '') + '>' + list.items.map((x) => '<li>' + trInline_(x) + '</li>').join('') + '</' + list.tag + '>');
    list = null;
  };
  const flushTable = () => {
    if (table) {
      out.push('<table>' + table.map((r, i) => '<tr>' + r.map((c) => (i ? '<td>' : '<th>') + trInline_(c) + (i ? '</td>' : '</th>')).join('') + '</tr>').join('') + '</table>');
      table = null;
    }
  };
  const flush = () => {
    flushPara();
    flushList();
    flushTable();
  };
  const addItem = (tag, cls, txt) => {
    flushPara();
    flushTable();
    if (!list || list.tag !== tag || list.cls !== cls) {
      flushList();
      list = { tag, cls, items: [] };
    }
    list.items.push(txt);
  };
  lines.forEach((raw) => {
    const l = raw.trim();
    let m;
    if (!l) return flush();
    if ((m = l.match(/^##\s+(.*)$/))) {
      flush();
      return out.push('<h3>' + trInline_(m[1]) + '</h3>');
    }
    if ((m = l.match(/^\[\s?\]\s+(.*)$/))) return addItem('ul', 'tick', m[1]);
    if ((m = l.match(/^[-•]\s+(.*)$/))) return addItem('ul', '', m[1]);
    if ((m = l.match(/^\d+[.)]\s+(.*)$/))) return addItem('ol', 'steps', m[1]);
    if ((m = l.match(/^(Note|Tip|Warning|Key):\s*(.*)$/i))) {
      flush();
      const k = m[1].toLowerCase();
      return out.push('<div class="' + (k === 'key' ? 'key' : k === 'warning' ? 'warn' : k) + '">' + trInline_(m[2]) + '</div>');
    }
    if ((m = l.match(/^\?\?\s*(.*?)\s*\|\s*(.*)$/))) {
      flush();
      return out.push('<details class="reveal"><summary>' + trInline_(m[1]) + '</summary><p>' + trInline_(m[2]) + '</p></details>');
    }
    if (/^\|.*\|$/.test(l)) {
      flushPara();
      flushList();
      const cells = l.slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return; // a |---|---| divider line
      (table = table || []).push(cells);
      return;
    }
    if ((m = l.match(/^\{\{\s*deposit\s*\}\}$/i))) {
      flush();
      return out.push('{{live:deposit}}');
    }
    if ((m = l.match(/^\{\{\s*list\s+(.+?)\s*\}\}$/i))) {
      flush();
      return out.push('{{live:list:' + m[1] + '}}');
    }
    flushList();
    flushTable();
    para.push(l);
  });
  flush();
  // live blocks become their own entries so the app can make them interactive
  const html = out.join('');
  return html.split(/(\{\{live:[^}]+\}\})/).filter(Boolean).map((p) => {
    const m = p.match(/^\{\{live:(deposit|list):?(.*)\}\}$/);
    return m ? (m[1] === 'deposit' ? { live: 'deposit' } : { live: 'list', list: m[2] }) : p;
  });
}
/** HTML (as written in TrainingContent.gs) → the sheet formatting. Used once, to fill the tabs. */
function trToMd_(html) {
  let h = String(html || '').replace(/\r/g, '').replace(/\n\s*/g, ' ');
  const txt = (s) =>
    String(s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(b|strong)>(.*?)<\/\1>/gi, '**$2**')
      .replace(/<(i|em)>(.*?)<\/\1>/gi, '*$2*')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  const out = [];
  const re = /<(h3|p|ul|ol|table|div|details)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(h))) {
    const tag = m[1].toLowerCase(),
      attrs = m[2],
      inner = m[3];
    if (tag === 'h3') out.push('## ' + txt(inner));
    else if (tag === 'p') out.push(txt(inner));
    else if (tag === 'ul' || tag === 'ol') {
      const pre = /tick/.test(attrs) ? '[ ] ' : tag === 'ol' ? null : '- ';
      const items = [],
        li = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let x,
        n = 0;
      while ((x = li.exec(inner))) items.push((pre || ++n + '. ') + txt(x[1]).replace(/\n+/g, ' '));
      out.push(items.join('\n'));
    } else if (tag === 'table') {
      const rows = [],
        tr = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let x;
      while ((x = tr.exec(inner))) {
        const cells = [],
          td = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
        let y;
        while ((y = td.exec(x[1]))) cells.push(txt(y[1]).replace(/\n+/g, ' ').replace(/\|/g, '/'));
        rows.push('| ' + cells.join(' | ') + ' |');
      }
      out.push(rows.join('\n'));
    } else if (tag === 'div') {
      const k = (attrs.match(/class="(\w+)"/) || [])[1] || 'note';
      out.push((k === 'warn' ? 'Warning' : k === 'tip' ? 'Tip' : k === 'key' ? 'Key' : 'Note') + ': ' + txt(inner).replace(/\n+/g, ' '));
    } else if (tag === 'details') {
      const s = (inner.match(/<summary>([\s\S]*?)<\/summary>/i) || [])[1] || '';
      out.push('?? ' + txt(s) + ' | ' + txt(inner.replace(/<summary>[\s\S]*?<\/summary>/i, '')).replace(/\n+/g, ' '));
    }
  }
  return out.join('\n\n');
}
function trSeedTab_(ss, name, rows) {
  const sh = trTab_(ss, name);
  if (sh.getLastRow() > 1 || !rows.length) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(2, 1, rows.length, rows[0].length).setWrap(true).setVerticalAlignment('top');
  dirty_(name);
}
/** Fills the Manual, Manual checks and Resource pages tabs from TrainingContent.gs, only where a tab is empty. */
function trSeedContent_(ss) {
  const man = [],
    chk = [];
  trManualChapters_().forEach((c, ci) => {
    c.sections.forEach((s, si) => man.push([c.title, si === 0 ? c.intro || '' : '', s.title, trToMd_(s.b.filter((b) => typeof b === 'string').join('')), (ci + 1) * 10 + si, true]));
    (c.check || []).forEach((q) => chk.push([c.title, q[0], q[1][0], q[1][1] || '', q[1][2] || '', q[1][3] || '', q[2] || '', true]));
  });
  trSeedTab_(ss, 'Manual', man);
  trSeedTab_(ss, 'Manual checks', chk);
  const pages = [];
  trResources_()
    .filter((r) => r.sections && r.id !== 'cleaning' && r.id !== 'sidework')
    .forEach((r, ri) =>
      r.sections.forEach((s, si) => {
        let text = s.b.map((b) => (typeof b === 'string' ? trToMd_(b) : b.live === 'deposit' ? '{{deposit}}' : '')).filter(Boolean).join('\n\n');
        if (r.id === 'drawer' && si === 0) text += '\n\n{{list Drawer close}}';
        pages.push([r.title, r.who === 'lead' ? 'Leads and managers' : 'Everyone', r.icon || '❏', r.blurb || '', s.title, text, (ri + 1) * 100 + si, true]);
      })
    );
  trSeedTab_(ss, 'Resource pages', pages);
}
const trOn_ = (v) => v === '' || v === null || v === undefined || truthy_(v);
/** The manual as the app shows it: from the Manual and Manual checks tabs (filled from the code the first time). */
function trManualLive_() {
  if (MEMO_.trManual) return MEMO_.trManual;
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName('Manual') || ss.getSheetByName('Manual').getLastRow() < 2) trSeedContent_(ss);
  const rows = rv_(ss, 'Manual')
    .filter((r) => String(r[0]).trim() && String(r[2]).trim() && trOn_(r[5]))
    .sort((a, b) => (Number(a[4]) || 0) - (Number(b[4]) || 0));
  if (!rows.length) return trManualChapters_();
  const chapters = [];
  rows.forEach((r) => {
    const t = String(r[0]).trim();
    let c = chapters.find((x) => x.title === t);
    if (!c) chapters.push((c = { title: t, intro: '', sections: [], check: [] }));
    if (String(r[1]).trim()) c.intro = String(r[1]).trim();
    c.sections.push({ title: String(r[2]).trim(), b: trMd_(r[3]) });
  });
  rv_(ss, 'Manual checks')
    .filter((r) => String(r[0]).trim() && String(r[1]).trim() && String(r[2]).trim() && trOn_(r[7]))
    .forEach((r) => {
      const c = chapters.find((x) => x.title === String(r[0]).trim());
      if (c) c.check.push([String(r[1]).trim(), [r[2], r[3], r[4], r[5]].map((x) => String(x).trim()).filter(Boolean), String(r[6] || '')]);
    });
  return (MEMO_.trManual = chapters);
}
/** The library: app links (recipes, lists) plus the pages from the Resource pages tab. */
function trResourcesLive_() {
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName('Resource pages') || ss.getSheetByName('Resource pages').getLastRow() < 2) trSeedContent_(ss);
  const fixed = [
    { id: 'drinks', title: 'Drink Build Menu', icon: '❦', who: 'all', blurb: "Every drink, in the app's recipe book.", more: 'recipes' },
    { id: 'prep', title: 'Prep Recipe Book', icon: '❧', who: 'all', blurb: 'Syrups, concentrates and batches, in the recipe book.', more: 'recipes' },
    { id: 'shifts', title: 'Shift Checklists', icon: '✓', who: 'all', blurb: 'Opening, mid and closing, in Lists.', golist: 'Opening' },
    { id: 'sidework', title: 'Side Work', icon: '▦', who: 'all', blurb: "Today's deep-clean tasks, in Lists.", golist: 'Side work' },
    { id: 'cleaning', title: 'Espresso Machine Cleaning', icon: '◇', who: 'all', blurb: 'Backflush, screens, steam wands and carafes, in Lists.', golist: 'Machine cleaning' },
  ];
  const pages = [];
  rv_(ss, 'Resource pages')
    .filter((r) => String(r[0]).trim() && String(r[4]).trim() && trOn_(r[7]))
    .sort((a, b) => (Number(a[6]) || 0) - (Number(b[6]) || 0))
    .forEach((r) => {
      const t = String(r[0]).trim();
      let p = pages.find((x) => x.title === t);
      if (!p)
        pages.push(
          (p = {
            id: 'pg-' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            title: t,
            who: /lead|manager/i.test(String(r[1])) ? 'lead' : 'all',
            icon: String(r[2] || '❏').trim() || '❏',
            blurb: String(r[3] || ''),
            sections: [],
          })
        );
      p.sections.push({ title: String(r[4]).trim(), b: trMd_(r[5]) });
    });
  return fixed.concat(pages);
}

/** Keeps the Drink Build Menu Google Doc (Settings › Drink Build Menu doc) matched to the Recipes tab. */
function trMenuDoc_(ss) {
  const id = driveId_2(setting_(ss, 'Drink Build Menu doc'));
  if (!id || !ss.getSheetByName('Recipes')) return;
  const rows = vals_(ss.getSheetByName('Recipes'))
    .filter((r) => String(r[0]).trim() && /^drink/i.test(String(r[1])) && (r[10] === '' || truthy_(r[10])) && !/lead|manager/i.test(String(r[11] || '')))
    .sort((a, b) => (Number(a[9]) || 0) - (Number(b[9]) || 0));
  const doc = DocumentApp.openById(id),
    b = doc.getBody(),
    H = DocumentApp.ParagraphHeading;
  b.clear();
  b.getParagraphs()[0].setText((setting_(ss, 'Shop name') || 'Peregrine') + ' · Drink Build Menu').setHeading(H.TITLE);
  b.appendParagraph('Kept in step with the Recipes tab in the Peregrine Team app. Updated ' + trDay_(ss, new Date()) + '. Edit recipes in the app, not here: this document is rewritten whenever a recipe changes.').setItalic(true);
  b.appendParagraph('Syrup families: clear syrups (vanilla, lavender, juniper, Honey Simple) 32g · dark syrups (mocha, brown sugar, caramel, maple, white chocolate) 40g. Same grams hot or iced unless a recipe says otherwise. Espresso: house 17.5g, single origin 18g, 20–24 sec, 1.5oz.').setItalic(false);
  let cat = '';
  rows.forEach((r) => {
    const c = String(r[2] || 'Other').trim();
    if (c !== cat) {
      cat = c;
      b.appendParagraph(c).setHeading(H.HEADING1);
    }
    b.appendParagraph(String(r[0]).trim()).setHeading(H.HEADING2);
    const meta = [String(r[3] || '').trim(), String(r[4] || '').trim()].filter(Boolean).join(' · ');
    if (meta) b.appendParagraph(meta).setItalic(true);
    lines_(r[6]).forEach((l) => (/:$/.test(l) ? b.appendParagraph(l).setBold(true).setItalic(false) : b.appendListItem(l).setGlyphType(DocumentApp.GlyphType.BULLET).setBold(false).setItalic(false)));
    lines_(r[7]).forEach((l, i) => b.appendListItem((l.charAt(0) === '!' ? 'Caution: ' + l.slice(1) : l)).setGlyphType(DocumentApp.GlyphType.NUMBER).setBold(false).setItalic(false));
    if (String(r[8] || '').trim()) b.appendParagraph('Good to know: ' + String(r[8]).trim()).setItalic(true).setBold(false);
  });
  doc.saveAndClose();
}

/** The food handler skill on someone's Level I checklist, checked off when they upload their certificate. */
function trFoodSkill_(ss, name) {
  try {
    const item = vals_(trTab_(ss, 'Training items')).find((r) => /food handler/i.test(String(r[1])));
    if (!item) return;
    const t = vals_(trTab_(ss, 'Trainees')).find((r) => String(r[1]).trim() === name && !r[7]);
    if (!t) return;
    const lg = trTab_(ss, 'Training log');
    if (vals_(lg).some((r) => String(r[0]) === String(t[0]) && String(r[1]).trim() === String(item[1]).trim())) return;
    lg.appendRow([t[0], String(item[1]).trim(), 'Food handler upload', new Date(), 'Certificate uploaded in the app']);
    dirty_('Training log');
  } catch (e) {
    console.warn('food skill: ' + e);
  }
}
