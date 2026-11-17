/**
 * Peregrine sales relay – a second file (Relay.gs) in the Richardson Team App sheet's Apps Script. Its trigger must be
 * owned by salem@peregrineroasters.com (an editor of the sheet), because GmailApp reads the inbox of the trigger's owner.
 *
 * SkyTab's Lighthouse emails the daily sales report (CSV) to the Peregrine inbox. Every 10 minutes this takes the newest one
 * (older reports are ignored), drops it onto the sheet's "Sales import" tab and imports it into the Sales tab straight away, and the app
 * shows managers yesterday's sales next to labor.
 *
 * Needs: the Richardson sheet shared with salem@peregrineroasters.com as an editor, and the sheet on Code.gs 4.97+.
 * Setup (or after updating this file): signed in as salem@peregrineroasters.com, open the sheet › Extensions › Apps Script,
 * choose "setupRelay" in the toolbar and press Run, approve. (Named setupRelay so it doesn't replace Code.gs's setup.)
 * Nothing else in the inbox is touched: only the newest email matching SEARCH with a CSV attached is read, and only the CSV is copied.
 */
const SHEET_ID = '1U7DjMrpCFido4bXj6vy-gcjd08JdIF0z7DbIMjRZBww'; // Richardson Team App
const SEARCH = 'has:attachment newer_than:3d (lighthouse OR skytab OR shift4 OR harbortouch)';

function setupRelay() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'relaySales')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('relaySales').timeBased().everyMinutes(10).create();
  const n = relaySales();
  console.log('Set up. Checking every 10 minutes. Sent ' + n + ' report(s) just now.');
}

function relaySales() {
  const ss = SpreadsheetApp.openById(SHEET_ID),
    sh = ss.getSheetByName('Sales import');
  if (!sh)
    throw new Error(
      'The Richardson sheet has no "Sales import" tab yet – update its Code.gs to 4.97 and run Team › 1. Set up there first.'
    );
  const last = sh.getLastRow(),
    seen = {};
  if (last > 1)
    sh.getRange(2, 6, last - 1, 1)
      .getValues()
      .forEach((r) => {
        seen[String(r[0]).split('#')[0]] = 1;
      });
  const rows = [];
  // Only the newest report: the latest matching email that has a CSV. Older ones are left alone.
  const msgs = [];
  GmailApp.search(SEARCH, 0, 20).forEach((th) => th.getMessages().forEach((m) => msgs.push(m)));
  msgs.sort((a, b) => b.getDate() - a.getDate());
  const m = msgs.find((x) =>
    x.getAttachments().some((a) => /\.csv$/i.test(a.getName()) || /csv|comma-separated/i.test(a.getContentType()))
  );
  if (m && !seen['peregrine:' + m.getId()]) {
    const id = 'peregrine:' + m.getId();
    const files = m
      .getAttachments()
      .filter((a) => /\.csv$/i.test(a.getName()) || /csv|comma-separated/i.test(a.getContentType()));
    files.forEach((f, i) =>
      rows.push([
        m.getDate(),
        m.getSubject(),
        f.getName(),
        '',
        f.getDataAsString().slice(0, 45000),
        files.length > 1 ? id + '#' + i : id,
      ])
    );
  }
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
    if (typeof importSales_ === 'function') {
      SpreadsheetApp.flush();
      importSales_(ss);
    } // same project as Code.gs: import now
  }
  return rows.length;
}
