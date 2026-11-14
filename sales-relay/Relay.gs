/**
 * Peregrine sales relay – runs in the salem@peregrineroasters.com Google account (script.google.com › New project).
 *
 * SkyTab's Lighthouse emails the daily sales report (CSV) to the Peregrine inbox. Every hour this finds new ones and
 * drops each report onto the Richardson Team App sheet's "Sales import" tab. The sheet's own hourly import reads them
 * into the Sales tab, and the app shows managers yesterday's sales next to labor.
 *
 * Needs: the Richardson sheet shared with salem@peregrineroasters.com as an editor, and the sheet on Code.gs 4.97+.
 * Setup: paste this file, Save, choose "setup" in the toolbar and press Run, approve. That's it.
 * Nothing else in the inbox is touched: only emails matching SEARCH with a CSV attached are read, and only the CSV is copied.
 */
const SHEET_ID = '1U7DjMrpCFido4bXj6vy-gcjd08JdIF0z7DbIMjRZBww';   // Richardson Team App
const SEARCH = 'has:attachment newer_than:3d (lighthouse OR skytab OR shift4 OR harbortouch)';

function setup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'relaySales').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('relaySales').timeBased().everyHours(1).create();
  const n = relaySales();
  console.log('Set up. Checking every hour. Sent ' + n + ' report(s) just now.');
}

function relaySales() {
  const ss = SpreadsheetApp.openById(SHEET_ID), sh = ss.getSheetByName('Sales import');
  if (!sh) throw new Error('The Richardson sheet has no "Sales import" tab yet – update its Code.gs to 4.97 and run Team › 1. Set up there first.');
  const last = sh.getLastRow(), seen = {};
  if (last > 1) sh.getRange(2, 6, last - 1, 1).getValues().forEach(r => { seen[String(r[0]).split('#')[0]] = 1; });
  const rows = [];
  GmailApp.search(SEARCH, 0, 20).forEach(th => th.getMessages().forEach(m => {
    const id = 'peregrine:' + m.getId(); if (seen[id]) return;
    const files = m.getAttachments().filter(a => /\.csv$/i.test(a.getName()) || /csv|comma-separated/i.test(a.getContentType()));
    if (!files.length) { rows.push([m.getDate(), m.getSubject(), '', 'No CSV attached – set the report\'s export type to CSV in Lighthouse', '', id]); return; }
    files.forEach((f, i) => rows.push([m.getDate(), m.getSubject(), f.getName(), '', f.getDataAsString().slice(0, 45000), files.length > 1 ? id + '#' + i : id]));
    seen[id] = 1;
  }));
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
  return rows.length;
}
