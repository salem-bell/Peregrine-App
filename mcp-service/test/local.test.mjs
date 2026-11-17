// End-to-end test against two local `wrangler dev` sessions:
//   chat-service:  wrangler dev --port 8799                          (.dev.vars: SECRET_PEREGRINE="test-peregrine-secret" …)
//   mcp-service:   wrangler dev -c test/wrangler.test.toml --port 8790
// Sign-in sends no cookies (some sign-in windows drop them). Covers: sign-in page (good code, wrong code, staff refused, foreign redirect refused), tokens, every tool,
// live delivery to a staff phone, private messages, and that the chat service's own routes still behave.
import { createHmac, createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
const MCP = 'http://localhost:8790',
  CHAT = 'http://localhost:8799',
  SECRET = 'test-peregrine-secret',
  SPACE = 'peregrine';
let pass = 0,
  fail = 0;
const ok = (c, m) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL', m);
  }
};
const b64u = (b) => Buffer.from(b).toString('base64url'),
  sign = (t) => createHmac('sha256', SECRET).update(t).digest('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stand-in Google Sheet: sign-in only
const sheet = http
  .createServer((q, r) => {
    let b = '';
    q.on('data', (c) => (b += c));
    q.on('end', () => {
      const { name, code } = JSON.parse(b || '{}'),
        n = String(name || '').toLowerCase();
      let out = { error: "That name and code don't match." };
      if (q.url === '/r' && n === 'salem' && code === '1234')
        out = { token: 'T.pS.1.sig', name: 'Salem', role: 'Manager' };
      if (q.url === '/r' && n === 'ben' && code === '5555') out = { token: 'T.pB.1.sig', name: 'Ben', role: 'Staff' };
      if (q.url === '/w' && n === 'salem' && code === '4321')
        out = { token: 'T.wS.1.sig', name: 'Salem', role: 'Manager' };
      // like Apps Script: the POST answers with a redirect; the result is served at the second address
      if (q.method === 'POST') {
        const id = String(Math.random()).slice(2);
        echo[id] = out;
        r.writeHead(302, { location: 'http://localhost:8797/echo?id=' + id });
        return r.end();
      }
      const id = new URL(q.url, 'http://x').searchParams.get('id');
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify(echo[id] || { error: 'gone' }));
    });
  })
  .listen(8797);
const echo = {};
const pushes = [];
const relay = http
  .createServer((q, r) => {
    let b = '';
    q.on('data', (c) => (b += c));
    q.on('end', () => {
      pushes.push(b);
      r.end('{"ok":true}');
    });
  })
  .listen(8796);

const people = [
  { id: 'pS', name: 'Salem Bellah', tier: 2, active: true },
  { id: 'pB', name: 'Ben Ortiz', tier: 0, active: true },
  { id: 'pA', name: 'Ana Ruiz', tier: 1, active: true },
  { id: 'pA2', name: 'Ana Cole', tier: 0, active: true },
  { id: 'pX', name: 'Old Timer', tier: 0, active: false },
];
const rules = {
  makeChannel: 1,
  editChannel: 1,
  deleteAny: 2,
  deleteOwn: false,
  whoLabels: { 0: 'Everyone', 1: 'Leads and managers', 2: 'Managers' },
};
async function roster(ppl = people) {
  const body = JSON.stringify({
    space: SPACE,
    people: ppl,
    rules,
    relay: 'http://localhost:8796/',
    photoDays: 60,
    channels: [
      { id: 'cgeneral1', name: 'General', kind: 'channel', who: 'Everyone' },
      { id: 'cleads001', name: 'Leads', kind: 'channel', who: 'Leads and managers' },
      { id: 'cmgrs0001', name: 'Managers only', kind: 'channel', who: 'Managers' },
    ],
  });
  return (
    await fetch(CHAT + '/s/' + SPACE + '/roster', { method: 'POST', body, headers: { 'x-sig': sign(body) } })
  ).json();
}
const ticket = (u, n, t) => {
  const body = b64u(JSON.stringify({ s: SPACE, u, n, t, ro: false, e: Date.now() / 1000 + 3600 }));
  return body + '.' + sign(body);
};
function phone(u, n, t) {
  const ws = new WebSocket(CHAT.replace('http', 'ws') + '/s/' + SPACE + '/ws?t=' + encodeURIComponent(ticket(u, n, t))),
    inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  return {
    ws,
    inbox,
    ready: new Promise((r) => {
      ws.onopen = r;
    }),
    wait: async (f, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const i = inbox.findIndex(f);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await sleep(50);
      }
      throw new Error('timeout');
    },
  };
}

// a cookie jar for the browser side of the sign-in
function jar() {
  const c = {};
  return {
    set(res) {
      (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((s) => {
        const [kv] = s.split(';');
        const i = kv.indexOf('=');
        c[kv.slice(0, i)] = kv.slice(i + 1);
      });
    },
    get: () =>
      Object.entries(c)
        .map(([k, v]) => k + '=' + v)
        .join('; '),
  };
}
async function register(redirect = 'http://localhost:9999/cb') {
  return (
    await fetch(MCP + '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
  ).json();
}
async function authorize(client, form, redirect = 'http://localhost:9999/cb') {
  const verifier = b64u(randomBytes(32)),
    challenge = b64u(createHash('sha256').update(verifier).digest()),
    j = jar();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st8',
    scope: 'mcp',
    resource: MCP + '/mcp',
  });
  let res = await fetch(MCP + '/authorize?' + q, { redirect: 'manual' });
  j.set(res);
  let html = await res.text();
  const steps = [];
  for (const f of [].concat(form)) {
    const handle = (html.match(/name="handle" value="([^"]+)"/) || [])[1];
    if (!handle) return { status: res.status, html, steps };
    res = await fetch(MCP + '/authorize?' + q, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({ handle }, f)),
    });
    j.set(res);
    html = res.status === 302 ? '' : await res.text();
    steps.push(res.status);
  }
  const loc = res.headers.get('location') || '';
  if (res.status !== 302 || !/code=/.test(loc)) return { status: res.status, html, loc, steps };
  const code = new URL(loc).searchParams.get('code');
  const tok = await (
    await fetch(MCP + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: MCP + '/mcp',
      }),
    })
  ).json();
  return { status: 302, loc, tok, steps };
}
let rid = 0;
async function mcp(token, method, params) {
  const r = await fetch(MCP + '/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }),
  });
  return r.status === 200 ? r.json() : { status: r.status };
}
const tool = async (token, name, args) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  return { text: r.result && r.result.content[0].text, err: !!(r.result && r.result.isError), raw: r };
};

try {
  ok((await roster()).ok, 'roster');
  const d0 = await (await fetch(MCP + '/diag')).json();
  ok(d0.stage, 'diag answers');
  ok((await fetch(MCP + '/mcp', { method: 'POST', body: '{}' })).status === 401, 'no token → 401');

  // a redirect that isn't Claude's is refused on the sign-in page
  const evil = await register('https://evil.example/cb');
  const ev = await authorize(evil, [], 'https://evil.example/cb');
  ok(ev.status === 403 && /only works with Claude/.test(ev.html), 'foreign redirect refused: ' + ev.status);

  const client = await register();
  ok(client.client_id, 'client registered');
  // wrong code first, then the right one on the re-shown page
  const bad = await authorize(client, [{ name: 'Salem', code_richardson: '9999', decision: 'approve' }]);
  ok(
    bad.status === 200 && /don&#39;t match|don't match/.test(bad.html) && /name="handle"/.test(bad.html),
    'wrong code shows the form again: ' + bad.status + ' ' + (bad.html || '').slice(0, 0)
  );
  const staff = await authorize(client, [{ name: 'Ben', code_richardson: '5555', decision: 'approve' }]);
  ok(staff.status === 200 && /only managers/.test(staff.html), 'staff refused');
  const retry = await authorize(client, [
    { name: 'Salem', code_richardson: '0000', decision: 'approve' },
    { name: 'Salem', code_richardson: '1234', code_westcliffe: '4321', decision: 'approve' },
  ]);
  ok(
    retry.status === 302 && retry.tok && retry.tok.access_token && retry.tok.refresh_token,
    'retry then sign in → tokens: ' +
      JSON.stringify(retry.steps) +
      ' ' +
      JSON.stringify(retry.tok || retry.html).slice(0, 200)
  );
  const deny = await authorize(client, [{ decision: 'deny' }]);
  ok(deny.status === 302 && /error=access_denied/.test(deny.loc), 'cancel → access_denied');
  const T = retry.tok.access_token;
  const dg = await (await fetch(MCP + '/diag')).json();
  ok(dg.stage === 'page shown' || dg.stage === 'signed in', 'diag after sign-in: ' + JSON.stringify(dg).slice(0, 300));
  ok(!JSON.stringify(dg).includes('1234') && !JSON.stringify(dg).includes('T.pS'), 'diag holds no codes or tokens');

  const init = await mcp(T, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  ok(
    init.result && init.result.protocolVersion === '2025-06-18' && init.result.serverInfo.name === 'peregrine-team',
    'initialize'
  );
  ok(
    (
      await fetch(MCP + '/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      })
    ).status === 202,
    'notification → 202'
  );
  const tl = await mcp(T, 'tools/list', {});
  ok(tl.result.tools.length === 6, 'six tools');

  const ppl = await tool(T, 'list_people', {});
  ok(/Ben Ortiz – Staff/.test(ppl.text) && !/Old Timer/.test(ppl.text), 'list_people: ' + ppl.text);
  const lc = await tool(T, 'list_conversations', {});
  ok(/#General/.test(lc.text) && /#Managers only/.test(lc.text), 'list_conversations (manager sees managers channel)');

  // Ben's phone is open; Salem (through Claude) messages General and Ben privately
  const ben = phone('pB', 'Ben Ortiz', 0);
  await ben.ready;
  await ben.wait((m) => m.t === 'hello');
  const s1 = await tool(T, 'send_message', {
    conversation: '#general',
    text: 'Morning crew – @team new pastry order lands at 7.',
  });
  ok(!s1.err && /Sent to #General at Richardson/.test(s1.text), 'send to channel: ' + s1.text);
  const got = await ben.wait((m) => m.t === 'msg' && m.ch === 'cgeneral1').catch(() => null);
  ok(got && got.m.from === 'Salem Bellah' && /pastry/.test(got.m.text), 'Ben gets it live');
  const s2 = await tool(T, 'send_message', { conversation: 'Ben', text: 'Can you open Saturday?' });
  ok(!s2.err && /Sent to Ben Ortiz/.test(s2.text), 'private message by first name: ' + s2.text);
  const dm = await ben.wait((m) => m.t === 'msg' && /^dm-/.test(m.ch)).catch(() => null);
  ok(dm && dm.ch === 'dm-pB-pS', 'Ben gets the private message');
  await sleep(300);
  ok(pushes.length >= 1, 'notifications relayed to the sheet (' + pushes.length + ')');
  const amb = await tool(T, 'send_message', { conversation: 'Ana', text: 'hi' });
  ok(amb.err && /More than one person/.test(amb.text), 'ambiguous name refused');
  const nobody = await tool(T, 'send_message', { conversation: 'Zed', text: 'hi' });
  ok(nobody.err, 'unknown recipient refused');

  // Ben replies; reading doesn't mark read, mark_read does
  ben.ws.send(JSON.stringify({ rid: 'x1', t: 'send', ch: 'dm-pB-pS', text: 'Yes I can open' }));
  await ben.wait((m) => m.rid === 'x1');
  const unread = await tool(T, 'list_conversations', { unread_only: true });
  ok(/Ben Ortiz \(private/.test(unread.text) && /1 unread/.test(unread.text), 'unread shows: ' + unread.text);
  const rd = await tool(T, 'read_conversation', { conversation: 'Ben Ortiz' });
  ok(/Yes I can open/.test(rd.text) && /Can you open Saturday/.test(rd.text), 'read_conversation: ' + rd.text);
  ok(/1 unread/.test((await tool(T, 'list_conversations', { unread_only: true })).text), 'reading did not mark read');
  ok(!(await tool(T, 'mark_read', { conversation: 'Ben' })).err, 'mark_read');
  ok(/nothing unread/.test((await tool(T, 'list_conversations', { unread_only: true })).text), 'now nothing unread');
  const sr = await tool(T, 'search_messages', { query: 'pastry' });
  ok(/1 matches/.test(sr.text) && /#General/.test(sr.text), 'search: ' + sr.text);

  // locations
  const wc = await tool(T, 'list_people', { location: 'westcliffe' });
  ok(!wc.err, 'westcliffe connected: ' + wc.text);
  const client2 = await register();
  const only = await authorize(client2, [{ name: 'Salem', code_richardson: '1234', decision: 'approve' }]);
  const nowc = await tool(only.tok.access_token, 'list_people', { location: 'westcliffe' });
  ok(nowc.err && /didn't connect westcliffe/.test(nowc.text), 'westcliffe not connected when skipped');

  // switched off in the sheet → the connector stops working at once
  await roster(people.map((p) => (p.id === 'pS' ? Object.assign({}, p, { active: false }) : p)));
  const off = await tool(T, 'list_conversations', {});
  ok(off.err && /switched off/.test(off.text), 'switched-off manager blocked: ' + off.text);
  await roster();

  // refresh token works
  const rf = await (
    await fetch(MCP + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: retry.tok.refresh_token,
        client_id: client.client_id,
      }),
    })
  ).json();
  ok(rf.access_token && !(await tool(rf.access_token, 'list_people', {})).err, 'refreshed token works');

  // the chat service's public side: /api isn't reachable from outside
  ok((await fetch(CHAT + '/s/peregrine/api', { method: 'POST', body: '{}' })).status === 404, 'chat /api not public');
} catch (e) {
  fail++;
  console.log('ERROR', e);
}
console.log(pass + ' passed, ' + fail + ' failed');
sheet.close();
relay.close();
process.exit(fail ? 1 : 0);
