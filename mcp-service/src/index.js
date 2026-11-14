/**
 * peregrine-mcp – a private connector so Claude can read and send Peregrine Team messages from anywhere
 * (phone, voice mode, a cloud session) without the app open on a computer.
 *
 * - Sign-in: OAuth 2.1 (claude.ai adds it as a custom connector). The sign-in page asks for the same first name and
 *   4-digit code as the app, checked by each location's Google Sheet. Only managers get in.
 * - Messages: talks straight to the team-chat Worker's Durable Objects (binding SPACE → team-chat's Space class),
 *   acting as the person who signed in. Sending works exactly like sending from the app: live delivery, notifications.
 */
import { OAuthProvider, AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';

const LOCATIONS = [
  { key: 'richardson', space: 'peregrine', name: 'Richardson', tz: 'America/Chicago',
    api: 'https://script.google.com/macros/s/AKfycbz5Dy_OZRdEPfPWR72e268ZviaBpBJLKvAVTaQGXc41fC7Y_wlgQOhRrIcqyDWYHEaw/exec' },
  { key: 'westcliffe', space: 'westcliffe', name: 'Westcliffe', tz: 'America/Denver',
    api: 'https://script.google.com/macros/s/AKfycbzquvYZLp2-oRIXMbMFxbCbuSLqeEixgEzf7jAKgA0SyJvFX34nSKwBtPtkQ7hk7K3vPQ/exec' },
];
const VERSION = '0.1.2';
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');

/* ============================================================
   Sign-in page (/authorize)
   ============================================================ */
function apiFor(env, loc) {                       // tests point sign-in at a stand-in sheet
  try { const o = JSON.parse(env.SIGNIN_OVERRIDE || '{}'); if (o[loc.key]) return o[loc.key]; } catch (_) {}
  return loc.api;
}
/* Last sign-in attempt, for troubleshooting: where it stopped and how long each step took. No names, codes or tokens.
   Visible at /diag for a day. */
async function diag(env, d) { try { await env.OAUTH_KV.put('diag:last', JSON.stringify(Object.assign({ at: new Date().toISOString(), version: VERSION }, d)), { expirationTtl: 86400 }); } catch (_) {} }
/** Apps Script answers a POST with a redirect to a second Google address that serves the result: follow it by hand,
   with a time limit on each step, so a slow or odd answer shows up as a clear message instead of a hung page. */
async function sheetCall(env, loc, body, steps) {
  const t0 = Date.now(), lim = ms => AbortSignal.timeout(ms);
  let r;
  try { r = await fetch(apiFor(env, loc), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain;charset=utf-8' }, redirect: 'manual', signal: lim(25000) }); }
  catch (e) { steps.push({ loc: loc.key, step: 'post', ms: Date.now() - t0, err: String(e && e.name || e) }); throw new Error(loc.name + ': the sheet didn\'t answer in time – try again in a minute'); }
  steps.push({ loc: loc.key, step: 'post', ms: Date.now() - t0, status: r.status, to: r.headers.get('location') ? new URL(r.headers.get('location')).host : '' });
  for (let hop = 0; hop < 3 && r.status >= 300 && r.status < 400 && r.headers.get('location'); hop++) {
    const next = r.headers.get('location'), t1 = Date.now();
    try { r = await fetch(next, { method: 'GET', redirect: 'manual', signal: lim(20000) }); }
    catch (e) { steps.push({ loc: loc.key, step: 'result', ms: Date.now() - t1, err: String(e && e.name || e) }); throw new Error(loc.name + ': the sheet didn\'t answer in time – try again in a minute'); }
    steps.push({ loc: loc.key, step: 'result', ms: Date.now() - t1, status: r.status, type: r.headers.get('content-type') || '' });
  }
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  if (!j) { steps.push({ loc: loc.key, step: 'parse', status: r.status, start: text.slice(0, 120).replace(/\s+/g, ' ') }); throw new Error(loc.name + ': the sheet sent back something unexpected (' + r.status + ')'); }
  steps.push({ loc: loc.key, step: 'parse', keys: Object.keys(j), error: j.error || '' });
  return j;
}
async function sheetSignIn(env, loc, name, code, steps) {
  const j = await sheetCall(env, loc, { fn: 'signIn', name, code }, steps);
  if (j.error || !j.token) throw new Error(loc.name + ': ' + (j.error || 'sign-in failed'));
  if (j.role !== 'Manager') throw new Error(loc.name + ': only managers can connect Claude to the team app');
  const uid = String(j.token).split('.')[1];
  if (!uid) throw new Error(loc.name + ': unexpected answer from the sheet');
  return { u: uid, n: String(j.name), t: 2 };
}
function page(title, body, status = 200, headers) {
  const h = headers || new Headers();
  h.set('content-type', 'text/html; charset=utf-8'); h.set('x-frame-options', 'DENY'); h.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.45 -apple-system,system-ui,sans-serif;background:#f6f3ee;color:#222;margin:0;padding:24px}main{max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:22px;box-shadow:0 1px 6px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 6px}p{margin:8px 0}.muted{color:#666;font-size:14px}.err{background:#fde8e8;color:#8a1c1c;padding:10px;border-radius:8px}fieldset{border:1px solid #e3ddd3;border-radius:10px;margin:14px 0;padding:10px 12px}
legend{font-weight:600;padding:0 4px}label{display:block;font-size:14px;margin:8px 0 3px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:16px}
button{font-size:16px;padding:11px 16px;border-radius:10px;border:0;cursor:pointer}.go{background:#1f3a2e;color:#fff}.no{background:#eee;margin-left:8px}</style></head><body><main>${body}</main></body></html>`, { status, headers: h });
}
function signInForm(details, handle, error, values = {}) {
  return `<h1>Connect Claude to Peregrine Team</h1>
<p><strong>${esc(details.clientName)}</strong> wants to read and send team messages as you.${details.clientDomain ? ' Published by <strong>' + esc(details.clientDomain) + '</strong>.' : ''}</p>
<p class="muted">Access goes to <strong>${esc(details.redirectHost)}</strong>. Lasts 30 days, then you sign in again.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<label>First name (as in the app)</label><input type="text" name="name" autocomplete="username" value="${esc(values.name || '')}" required>
${LOCATIONS.map(l => `<fieldset><legend>${esc(l.name)}</legend><label>Your 4-digit code for ${esc(l.name)}${l.key === 'richardson' ? '' : ' (leave blank to skip)'}</label>
<input type="password" name="code_${l.key}" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off"></fieldset>`).join('')}
<p><button class="go" name="decision" value="approve">Connect</button><button class="no" name="decision" value="deny" formnovalidate>Cancel</button></p></form>
<p class="muted">Press Connect once – checking with the shop's Google Sheet can take up to 20 seconds. Managers only; your code isn't stored.</p>`;
}
function allowedRedirect(env, host) {
  const ok = String(env.ALLOWED_REDIRECT_HOSTS || 'claude.ai,claude.com').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  host = String(host || '').toLowerCase();
  return ok.some(h => host === h || host.endsWith('.' + h));
}
/* The sign-in page keeps its place on the server (KV, 15 minutes) under a random ID in the form, not in a browser
   cookie: some sign-in windows (in-app browsers, strict privacy settings) drop cookies, which broke the first version.
   The manager's own name + code is what proves it's them, so the form can't be forged into anything useful. */
const PENDING_TTL = 900;
const rid = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
async function savePending(env, request) { const id = rid(); await env.OAUTH_KV.put('signin:' + id, JSON.stringify({ request, at: Date.now() }), { expirationTtl: PENDING_TTL }); return id; }
async function loadPending(env, id) { if (!/^[0-9a-f]{48}$/.test(String(id || ''))) return null; const v = await env.OAUTH_KV.get('signin:' + id); try { return v ? JSON.parse(v) : null; } catch (_) { return null; } }
function denied(request) {
  const u = new URL(request.redirectUri); u.searchParams.set('error', 'access_denied'); if (request.state) u.searchParams.set('state', request.state);
  return Response.redirect(u.toString(), 302);
}
const expiredPage = () => page('Try again', '<h1>That page expired</h1><p>Go back to Claude and press Connect again.</p>', 400);
const defaultHandler = {
  async fetch(req, env) {
    const url = new URL(req.url), oauth = env.OAUTH_PROVIDER;
    if (url.pathname === '/' || url.pathname === '/health') return Response.json({ ok: true, service: 'peregrine-mcp', version: VERSION, mcp: url.origin + '/mcp' });
    if (url.pathname === '/diag') { const v = await env.OAUTH_KV.get('diag:last'); return new Response(v || '{"stage":"nothing yet"}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
    if (url.pathname !== '/authorize') return new Response('Not found', { status: 404 });
    try {
      if (req.method === 'GET') {
        const request = await oauth.parseAuthRequest(req);
        await diag(env, { stage: 'page shown' });
        const details = await oauth.describeConsent(request);
        if (!allowedRedirect(env, details.redirectHost)) return page('Not allowed', '<h1>Not allowed</h1><p>This connector only works with Claude.</p>', 403);
        return page('Connect Claude', signInForm(details, await savePending(env, request)));
      }
      if (req.method === 'POST') {
        const form = await req.formData(), handle = String(form.get('handle') || ''), pending = await loadPending(env, handle);
        if (!pending) return expiredPage();
        const request = pending.request;
        if (form.get('decision') !== 'approve') { await env.OAUTH_KV.delete('signin:' + handle); return denied(request); }
        const name = String(form.get('name') || '').trim(), spaces = {}, errors = [], steps = [], t0 = Date.now();
        const tries = LOCATIONS.filter(l => String(form.get('code_' + l.key) || '').trim());
        await Promise.all(tries.map(async l => {                         // both shops at once
          try { spaces[l.space] = await sheetSignIn(env, l, name, String(form.get('code_' + l.key)).trim(), steps); } catch (e) { errors.push(e.message); }
        }));
        await diag(env, { stage: errors.length ? 'sign-in failed' : 'signed in', ms: Date.now() - t0, tried: tries.map(l => l.key), errors, steps });
        if (errors.length || !Object.keys(spaces).length) {
          const details = await oauth.describeConsent(request);
          return page('Connect Claude', signInForm(details, handle, errors.join(' · ') || 'Type at least one code.', { name }));
        }
        await env.OAUTH_KV.delete('signin:' + handle);                    // works once
        const first = spaces.peregrine || spaces.westcliffe;
        const { redirectTo } = await oauth.completeAuthorization({
          request, userId: 'pt-' + first.u, metadata: { name: first.n, at: new Date().toISOString() },
          scope: ['mcp'], props: { name: first.n, spaces },
        });
        return new Response(null, { status: 302, headers: { location: redirectTo, 'cache-control': 'no-store' } });
      }
      return new Response('Method not allowed', { status: 405 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return page('Try again', `<h1>Couldn't connect</h1><p>${esc(error instanceof AuthorizationError ? error.description : 'This app could not be verified.')}</p><p class="muted">Go back to Claude and press Connect again.</p>`, 400);
      }
      throw error;
    }
  },
};

/* ============================================================
   Talking to the chat service (team-chat Durable Objects)
   ============================================================ */
async function chat(env, props, loc, msg) {
  const who = props.spaces[loc.space];
  const stub = env.SPACE.get(env.SPACE.idFromName(loc.space));
  const r = await stub.fetch(new Request('https://do/api', { method: 'POST', body: JSON.stringify(msg), headers: { 'x-space': loc.space, 'x-who': JSON.stringify({ s: loc.space, u: who.u, n: who.n, t: who.t, ro: false }) } }));
  const j = await r.json().catch(() => ({}));
  if (j.t === 'err' || !r.ok) throw new Error(j.msg || j.error || 'The chat service answered ' + r.status);
  return j;
}
function pickLocation(props, key) {
  const k = String(key || '').toLowerCase().trim();
  const mine = LOCATIONS.filter(l => props.spaces && props.spaces[l.space]);
  if (!mine.length) throw new Error('No location is connected – reconnect the connector.');
  if (!k) return mine[0];
  const l = mine.find(x => x.key === k || x.space === k || x.name.toLowerCase() === k);
  if (!l) throw new Error((LOCATIONS.find(x => x.key === k) ? 'You didn\'t connect ' + k + ' – reconnect and add its code.' : 'Unknown location "' + key + '".') + ' Connected: ' + mine.map(x => x.key).join(', '));
  return l;
}
const when = (iso, tz) => { try { return new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return iso; } };
const norm = s => String(s || '').toLowerCase().replace(/^[#@]/, '').trim();

/** A conversation by ID, channel/group name, or a person's name (their private conversation). */
async function resolve(env, props, loc, query, forSending) {
  const q = norm(query); if (!q) throw new Error('Say which conversation (a channel, a group, or a person).');
  const me = props.spaces[loc.space];
  if (/^(c[0-9a-f]{8}|dm-[\w]+-[\w]+|[a-z0-9_-]+)$/.test(String(query).trim())) {
    const { channels } = await chat(env, props, loc, { t: 'list' });
    const byId = channels.find(c => c.id === String(query).trim()); if (byId) return byId;
  }
  const { channels } = await chat(env, props, loc, { t: 'list' });
  const named = channels.filter(c => c.kind !== 'dm' && norm(c.name) === q);
  if (named.length === 1) return named[0];
  const { people } = await chat(env, props, loc, { t: 'people' });
  let hit = people.filter(p => p.id !== me.u && norm(p.name) === q);
  if (!hit.length) hit = people.filter(p => p.id !== me.u && norm(p.name).split(/\s+/)[0] === q);
  if (hit.length === 1) {
    const id = 'dm-' + [me.u, hit[0].id].sort().join('-');
    return channels.find(c => c.id === id) || { id, name: hit[0].name, kind: 'dm', unread: 0, last: null, isNew: true };
  }
  if (hit.length > 1) throw new Error('More than one person matches "' + query + '": ' + hit.map(p => p.name).join(', ') + '. Use the full name.');
  const loose = channels.filter(c => norm(c.name).indexOf(q) >= 0);
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new Error('"' + query + '" matches several conversations: ' + loose.map(c => c.name + ' (' + c.id + ')').join(', '));
  throw new Error('No conversation or person called "' + query + '" at ' + loc.name + '.' + (forSending ? '' : ' Use list_conversations to see them.'));
}
function fmtMsg(m, tz) {
  const bits = [when(m.at, tz) + ' – ' + m.from + ':'];
  if (m.reply) bits.push('(replying to ' + (m.reply.from || 'a message') + ': "' + m.reply.text + '")');
  bits.push(m.text || '');
  if (m.photo) bits.push('[photo]'); if (m.expired) bits.push('[photo expired]');
  if (m.acks && m.acks.length) bits.push('✓✓ ' + m.acks.join(', '));
  return bits.join(' ').trim() + '  [id ' + m.id + ']';
}
const kindLabel = c => c.kind === 'dm' ? 'private' : c.kind === 'group' ? 'group' : 'channel' + (c.who && c.who !== 'Everyone' ? ', ' + c.who : '');

/* ============================================================
   MCP tools
   ============================================================ */
const LOC_PROP = { type: 'string', enum: LOCATIONS.map(l => l.key), description: 'Which shop. Defaults to Richardson (or the only connected one).' };
const TOOLS = [
  { name: 'list_conversations', title: 'List conversations',
    description: 'Lists the Peregrine Team Messages conversations the signed-in manager can see – channels, groups and private messages – newest first, with unread counts and the latest message.',
    inputSchema: { type: 'object', properties: { location: LOC_PROP, unread_only: { type: 'boolean', description: 'Only conversations with unread messages.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'read_conversation', title: 'Read a conversation',
    description: 'Reads recent messages in one conversation (a channel or group by name, a person\'s first or full name for private messages, or an ID). Does not mark it read or show "Seen" to staff – use mark_read for that.',
    inputSchema: { type: 'object', required: ['conversation'], properties: { location: LOC_PROP, conversation: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 150, description: 'How many recent messages (default 30).' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'search_messages', title: 'Search messages',
    description: 'Searches message text and sender names across every conversation the manager can see (at least 2 characters).',
    inputSchema: { type: 'object', required: ['query'], properties: { location: LOC_PROP, query: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'list_people', title: 'List the team',
    description: 'Lists active team members at a location (names and roles), for addressing private messages or @mentions.',
    inputSchema: { type: 'object', properties: { location: LOC_PROP } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'send_message', title: 'Send a message',
    description: 'Sends a message as the signed-in manager to a channel, a group, or one person (private message, by name), exactly like sending from the app: it shows up live and notifies people. Send only text the user has approved word for word. @FirstName mentions a person; @team tags everyone in the conversation.',
    inputSchema: { type: 'object', required: ['conversation', 'text'], properties: { location: LOC_PROP, conversation: { type: 'string', description: 'Channel or group name, a person\'s name, or a conversation ID.' }, text: { type: 'string', maxLength: 2000 }, reply_to: { type: 'string', description: 'Optional message ID to reply to.' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'mark_read', title: 'Mark as read',
    description: 'Marks a conversation as read for the manager (staff in it will see "Seen").',
    inputSchema: { type: 'object', required: ['conversation'], properties: { location: LOC_PROP, conversation: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

async function callTool(env, props, name, args = {}) {
  const loc = pickLocation(props, args.location);
  if (name === 'list_conversations') {
    let { channels } = await chat(env, props, loc, { t: 'list' });
    if (args.unread_only) channels = channels.filter(c => c.unread);
    if (!channels.length) return loc.name + ': ' + (args.unread_only ? 'nothing unread.' : 'no conversations.');
    return loc.name + ' – ' + channels.length + ' conversations:\n' + channels.map(c => '• ' + (c.kind === 'channel' ? '#' : '') + c.name + ' (' + kindLabel(c) + ', id ' + c.id + ')' + (c.unread ? ' – ' + c.unread + ' unread' : '') + (c.last ? '\n   last: ' + when(c.last.at, loc.tz) + ' ' + c.last.from + ': ' + c.last.text : '')).join('\n');
  }
  if (name === 'read_conversation') {
    const c = await resolve(env, props, loc, args.conversation);
    if (c.isNew) return 'No private messages with ' + c.name + ' yet at ' + loc.name + '.';
    const h = await chat(env, props, loc, { t: 'peek', ch: c.id }), n = Math.max(1, Math.min(150, Number(args.limit) || 30));
    const msgs = h.messages.slice(-n);
    const seen = (h.seen || []).map(s => s.name + ' ' + when(s.at, loc.tz)).join(', ');
    return loc.name + ' · ' + (c.kind === 'channel' ? '#' : '') + c.name + ' (' + kindLabel(c) + ', id ' + c.id + ')' + (c.unread ? ' – ' + c.unread + ' unread for you' : '') + '\n' +
      (msgs.length ? msgs.map(m => fmtMsg(m, loc.tz)).join('\n') : '(no messages)') + (h.messages.length > n || h.more ? '\n(older messages not shown)' : '') + (seen ? '\nLast seen by: ' + seen : '');
  }
  if (name === 'search_messages') {
    const { results } = await chat(env, props, loc, { t: 'search', q: String(args.query || '') });
    if (!results.length) return 'No messages match "' + args.query + '" at ' + loc.name + '.';
    return results.length + ' matches at ' + loc.name + ':\n' + results.map(r => '• ' + when(r.at, loc.tz) + ' in ' + (r.kind === 'channel' ? '#' : '') + r.name + ' – ' + r.from + ': ' + r.text + '  [conversation ' + r.channel + ', id ' + r.id + ']').join('\n');
  }
  if (name === 'list_people') {
    const { people } = await chat(env, props, loc, { t: 'people' });
    return loc.name + ' team (' + people.length + '):\n' + people.map(p => '• ' + p.name + ' – ' + (p.tier >= 2 ? 'Manager' : p.tier === 1 ? 'Lead' : 'Staff')).join('\n');
  }
  if (name === 'send_message') {
    const text = String(args.text || '').trim(); if (!text) throw new Error('The message is empty.');
    const c = await resolve(env, props, loc, args.conversation, true);
    const r = await chat(env, props, loc, { t: 'send', ch: c.id, text, reply: String(args.reply_to || ''), tmp: 'mcp' });
    return 'Sent to ' + (c.kind === 'channel' ? '#' : '') + c.name + ' at ' + loc.name + ' (' + when(r.m.at, loc.tz) + ', id ' + r.m.id + ').';
  }
  if (name === 'mark_read') {
    const c = await resolve(env, props, loc, args.conversation);
    await chat(env, props, loc, { t: 'read', ch: c.id });
    return 'Marked ' + c.name + ' as read at ' + loc.name + '.';
  }
  throw new Error('Unknown tool: ' + name);
}

/* ============================================================
   MCP over Streamable HTTP (stateless JSON responses)
   ============================================================ */
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Peregrine Team (Peregrine Coffee Roasters staff app) Messages for Richardson and Westcliffe. Before send_message, show the user the exact text and recipient and get a yes. Reading never marks messages read; use mark_read only when asked.';
async function rpc(env, props, m) {
  const ok = result => ({ jsonrpc: '2.0', id: m.id, result }), err = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion;
      return ok({ protocolVersion: PROTOCOLS.indexOf(want) >= 0 ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'peregrine-team', title: 'Peregrine Team', version: VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const p = m.params || {};
      if (!TOOLS.some(t => t.name === p.name)) return err(-32602, 'Unknown tool: ' + p.name);
      try { return ok({ content: [{ type: 'text', text: await callTool(env, props, p.name, p.arguments || {}) }] }); }
      catch (e) { return ok({ content: [{ type: 'text', text: String(e && e.message || e) }], isError: true }); }
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default: return err(-32601, 'Method not found: ' + m.method);
  }
}
const apiHandler = {
  async fetch(req, env, ctx) {
    if (req.method !== 'POST') return new Response('Use POST', { status: 405, headers: { allow: 'POST' } });
    let body; try { body = await req.json(); } catch (_) { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 }); }
    const props = ctx.props || {}, list = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(list.map(m => m && m.method && m.id !== undefined && m.id !== null ? rpc(env, props, m) : null))).filter(Boolean);
    if (!out.length) return new Response(null, { status: 202 });            // notifications only
    return Response.json(Array.isArray(body) ? out : out[0]);
  },
};

/* ============================================================
   The Worker: OAuth around everything (built on first request, from PUBLIC_URL)
   ============================================================ */
let provider = null, built = '';
function getProvider(env) {
  const base = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (provider && built === base) return provider;
  provider = new OAuthProvider({
    apiRoute: '/mcp', apiHandler, defaultHandler,
    authorizeEndpoint: '/authorize', tokenEndpoint: '/token', clientRegistrationEndpoint: '/register',
    scopesSupported: ['mcp', 'offline_access'],
    resourceMetadata: { resource: base + '/mcp', authorization_servers: [base], resource_name: 'Peregrine Team' },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400,
  });
  built = base; return provider;
}
export default { fetch: (req, env, ctx) => getProvider(env).fetch(req, env, ctx) };
