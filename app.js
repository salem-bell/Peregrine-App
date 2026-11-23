/* Peregrine Team – phone app. Talks to the Apps Script server in config.js; all data lives in the Google Sheet. */
'use strict';
const API = window.PEREGRINE_API || '';
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
// Each location (Richardson, Westcliffe) is its own copy of the app on the same web address, so everything this phone keeps
// is named per location (config.js sets PT_NS, e.g. "wc-"): someone who works at both stays signed in to both, separately.
const NS = window.PT_NS || '';
const load = (k) => {
  try {
    return localStorage.getItem(NS + k);
  } catch (_) {
    return null;
  }
};
const save = (k, v) => {
  try {
    v === null ? localStorage.removeItem(NS + k) : localStorage.setItem(NS + k, v);
  } catch (_) {}
};
const WIDE = window.matchMedia('(min-width: 1000px)');
const wide = () => WIDE.matches;
const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let TOKEN = load('pt-token') || '',
  data = null,
  offline = false,
  tab = load('pt-tab') || 'today';
let inviteFor = '',
  listTab = '',
  schedMine = load('pt-mine') === '1',
  moreView = '',
  busy = {},
  installEvt = null,
  showCode = {},
  editUser = null,
  justAdded = null;
let week = '',
  sheet = null,
  chat = { open: '', msgs: [], timer: null, sending: false, compose: '' },
  tsWeek = '',
  tsPerson = '',
  viewer = null,
  tsMode = load('pt-tsmode') || 'week',
  tsDate = '';
try {
  const c = load('pt-cache');
  if (c && TOKEN) data = JSON.parse(c);
} catch (_) {}

/* ---------- server ---------- */
/* ===== Live chat connection (shared by Bellah Family HQ and Peregrine Team) =====
 * One WebSocket to the chat service. Asks get an answer (promise); everything else the service sends
 * (new messages, read marks, "seen", deletes, list changes, who's online) goes to on(msg).
 * Reconnects on its own with a growing wait, fetches a fresh chat pass when the old one runs out,
 * and pauses while the app is hidden for a while so phones don't keep a connection open in a pocket.
 */
function LiveChat(o) {
  // o: { url, space, ticket: () => Promise<{ticket, exp}>, on(msg), onUp(), onDown() }
  let ws = null,
    pass = null,
    tries = 0,
    wait = 0,
    ping = 0,
    idle = 0,
    up = false,
    stopped = false,
    n = 0;
  const pend = {},
    queue = [];
  const base = () => String(o.url).replace(/\/+$/, '');
  async function getPass() {
    if (pass && pass.exp * 1000 - Date.now() > 5 * 60000) return pass.ticket;
    pass = await o.ticket();
    // kept where the notification handler can reach it, so a notification arriving counts as "Delivered"
    try {
      const c = await caches.open(NS + 'chat-pass');
      await c.put(
        '/chat-pass',
        new Response(JSON.stringify({ url: base(), space: o.space, ticket: pass.ticket, exp: pass.exp }))
      );
    } catch (_) {}
    return pass.ticket;
  }
  async function connect() {
    if (stopped || ws || document.hidden) return;
    clearTimeout(wait);
    let t;
    try {
      t = await getPass();
    } catch (e) {
      if (/unauthorized|^signin/.test(String(e && e.message))) {
        stop();
        return;
      }
      return later();
    }
    if (stopped || ws) return;
    let opened = false;
    const s = (ws = new WebSocket(base().replace(/^http/, 'ws') + '/s/' + o.space + '/ws?t=' + encodeURIComponent(t)));
    s.onopen = () => {
      opened = true;
    };
    s.onmessage = (e) => {
      let d;
      try {
        d = JSON.parse(e.data);
      } catch (_) {
        return;
      }
      if (d.t === 'hello') {
        up = true;
        tries = 0;
        clearInterval(ping);
        ping = setInterval(() => raw({ t: 'ping' }), 25000);
        queue.splice(0).forEach((x) => s.send(x));
      }
      if (d.t === 'err' && d.code === 'expired') {
        pass = null;
      }
      if (d.rid && pend[d.rid]) {
        const p = pend[d.rid];
        delete pend[d.rid];
        clearTimeout(p.to);
        if (d.t === 'err') p.no(new Error(d.msg || 'Something went wrong'));
        else p.yes(d);
        return;
      }
      if (d.t === 'pong') return;
      try {
        o.on(d);
      } catch (err) {
        console.error(err);
      }
      if (d.t === 'hello' && o.onUp)
        try {
          o.onUp();
        } catch (err) {
          console.error(err);
        }
    };
    s.onclose = (ev) => {
      if (ws === s) ws = null;
      const was = up;
      up = false;
      clearInterval(ping);
      if (!opened || ev.code === 4001) pass = null; // refused at the door: usually an old pass
      Object.keys(pend).forEach((k) => {
        const p = pend[k];
        delete pend[k];
        clearTimeout(p.to);
        p.no(new Error('The connection dropped – try again'));
      });
      if (was && o.onDown)
        try {
          o.onDown();
        } catch (_) {}
      if (!stopped) later();
    };
    s.onerror = () => {};
  }
  function later() {
    clearTimeout(wait);
    const ms = Math.min(30000, 800 * Math.pow(2, tries++)) * (0.7 + Math.random() * 0.6);
    wait = setTimeout(connect, ms);
  }
  function raw(x) {
    const s = JSON.stringify(x);
    if (ws && up) {
      try {
        ws.send(s);
      } catch (_) {}
    } else {
      queue.push(s);
      if (queue.length > 50) queue.shift();
      connect();
    }
  }
  /** Fire and forget (read marks, acks, leaving a conversation). */
  function send(x) {
    raw(x);
  }
  /** A question with an answer: open, send, search, new/edit channel, delete. */
  function ask(x, ms) {
    const rid = 'r' + ++n + Math.random().toString(36).slice(2, 6);
    return new Promise((yes, no) => {
      pend[rid] = {
        yes,
        no,
        to: setTimeout(() => {
          if (pend[rid]) {
            delete pend[rid];
            no(new Error('No answer from the chat – check your connection'));
          }
        }, ms || 15000),
      };
      raw(Object.assign({ rid }, x));
    });
  }
  /** Photos: uploaded first, then sent as part of the message. */
  async function upload(src) {
    const blob = src instanceof Blob ? src : await (await fetch(src)).blob(),
      t = await getPass();
    const r = await fetch(base() + '/s/' + o.space + '/photo?t=' + encodeURIComponent(t), {
      method: 'POST',
      body: blob,
      headers: { 'content-type': blob.type || 'image/jpeg' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.key) {
      if (r.status === 401) pass = null;
      throw new Error(j.error || "The photo didn't upload");
    }
    return j.key;
  }
  async function photo(id) {
    const t = await getPass(),
      r = await fetch(base() + '/s/' + o.space + '/photo/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(t));
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) pass = null;
      throw new Error(j.error || "Couldn't load the photo");
    }
    const b = await r.blob();
    return await new Promise((yes, no) => {
      const f = new FileReader();
      f.onload = () => yes(f.result);
      f.onerror = () => no(new Error("Couldn't read the photo"));
      f.readAsDataURL(b);
    });
  }
  /** PDFs: a 6-hour link to just that file, so it opens in the phone's own viewer. */
  async function link(id) {
    const t = await getPass(),
      r = await fetch(
        base() + '/s/' + o.space + '/photo/' + encodeURIComponent(id) + '?link=1&t=' + encodeURIComponent(t)
      );
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) {
      if (r.status === 401) pass = null;
      throw new Error(j.error || "Couldn't open the file");
    }
    return j;
  }
  function stop() {
    try {
      caches.delete(NS + 'chat-pass');
    } catch (_) {}
    stopped = true;
    clearTimeout(wait);
    clearTimeout(idle);
    clearInterval(ping);
    if (ws)
      try {
        ws.close(1000);
      } catch (_) {}
    ws = null;
    up = false;
  }
  document.addEventListener('visibilitychange', () => {
    if (stopped) return;
    clearTimeout(idle);
    if (document.hidden)
      idle = setTimeout(() => {
        if (document.hidden && ws)
          try {
            ws.close(1000);
          } catch (_) {}
      }, 60000);
    else {
      tries = 0;
      connect();
    }
  });
  window.addEventListener('online', () => {
    if (!stopped) {
      tries = 0;
      connect();
    }
  });
  connect();
  return {
    send,
    ask,
    upload,
    photo,
    link,
    stop,
    get up() {
      return up;
    },
  };
}

/* Requests out right now. A phone that sleeps mid-request (locked screen, app switched away) can leave a fetch hanging
   with no answer ever coming – the app then sat on "Saving…" or old data until you closed it. When the app comes back,
   anything that has been waiting more than a few seconds is cancelled and loads are tried again straight away. */
const INFLIGHT = new Set();
async function post(body, o) {
  if (!API) throw new Error("This app isn't connected to its server yet (config.js).");
  const isRead = body.fn === 'api' && !(body.p && (body.p.action || body.p.actions));
  const ctl = new AbortController(),
    rec = { ctl, at: Date.now(), read: isRead },
    t = setTimeout(() => ctl.abort(), isRead ? 20000 : 45000);
  INFLIGHT.add(rec);
  try {
    const res = await fetch(API, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: ctl.signal,
      redirect: 'follow',
    }); // text/plain: no CORS preflight
    const out = await res.json();
    if (out && out.error) throw new Error(out.error);
    return out;
  } catch (e) {
    const m = e.name === 'AbortError' ? 'timeout' : String(e.message || e);
    // a load that timed out, got cut off, or was cancelled after the phone slept: one quick retry (never for saves, which might already have gone through)
    if (isRead && !(o && o.retried) && !/^signin/.test(m) && (m === 'timeout' || /fetch|network|load/i.test(m)))
      return post(body, { retried: true });
    throw new Error(m);
  } finally {
    clearTimeout(t);
    INFLIGHT.delete(rec);
  }
}
/* Fast loading: the Sheet keeps a ready-made copy of everyone's data on Cloudflare (data.edge), refreshed within a minute
   of any change. Loads come from there; saves always go to the Sheet. After you save something, a copy older than
   your save is ignored, so your own change never seems to vanish. Anything odd – no copy, too old, can't reach it –
   and the app asks the Sheet as before. */
let EDGE = load('pt-edge') || '',
  lastWriteAt = Number(load('pt-lastwrite') || 0);
function wrote(got) {
  const t = Date.parse(got && got.updated) || Date.now();
  if (t > lastWriteAt) {
    lastWriteAt = t;
    save('pt-lastwrite', String(t));
  }
}
async function edgeLoad() {
  if (!EDGE || !TOKEN) return null;
  const ctl = new AbortController(),
    rec = { ctl, at: Date.now(), read: true },
    t0 = Date.now(),
    t = setTimeout(() => ctl.abort(), 6000);
  INFLIGHT.add(rec);
  try {
    const r = await fetch(EDGE + '/s/' + ((data && data.space) || window.PT_SPACE || 'peregrine') + '/state', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const at = Number(r.headers.get('x-pushed-at') || 0),
      out = await r.json();
    if (!out || !out.ok || at < lastWriteAt) return null;
    console.info(
      '[Peregrine] loaded from Cloudflare in ' +
        (Date.now() - t0) +
        'ms (data from ' +
        Math.round((Date.now() - at) / 1000) +
        's ago)'
    );
    return out;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
    INFLIGHT.delete(rec);
  }
}
function unstick() {
  const now = Date.now();
  INFLIGHT.forEach((r) => {
    if (r.read && now - r.at > 4000) r.ctl.abort();
  });
}
// Answers can arrive out of order: show only the newest, and never let a background refresh overwrite a change that is still saving.
let seqStarted = 0,
  seqShown = 0,
  pending = 0,
  lastAct = 0;
// Batched saves (server 2.6+): edits queue up while one request is out, then go together in one request.
// New shifts carry their temporary id (cid) so later edits to them work before the server has answered.
let queue = [],
  flying = false,
  flushT = null;
const idMap = {},
  SLIM = /^(saveShift|addShift|deleteShift|restoreShift|copyWeek|clearWeek|scheduleOrder|setOnSchedule|setWage)$/;
const canBatch = () => !!(data && Number(data.version) >= 2.6);
function act(action, params) {
  if (!canBatch()) {
    const pr = refresh(Object.assign({ action }, params || {}));
    saving();
    pr.finally(saving);
    return pr;
  }
  return new Promise((res) => {
    queue.push({ p: Object.assign({ action }, params || {}), res });
    pending++;
    saving();
    if (!flying) {
      clearTimeout(flushT);
      flushT = setTimeout(flush, 120);
    }
  });
}
/* ---------- only what changed, and older weeks on demand ----------
   The server splits its reply into sections and versions each one. The app sends the versions it already holds ("have");
   sections that haven't changed come back listed under "same" and are kept from the copy on this phone.
   A normal load covers this pay period and last week (data.from onward); older weeks are fetched when someone pages back. */
const SECTION_FIELDS = {
  lists: ['checklists', 'history'],
  news: ['announcements'],
  sched: ['shifts', 'unpublished', 'positions', 'presets', 'availability'],
  clock: ['lateAfter', 'overAfter', 'shiftTypes', 'geo', 'punches', 'open', 'floor', 'handoffs', 'handoffRequired', 'clockTypes', 'clockSets', 'onClock'],
  prep: ['prep'],
  chat: ['chat', 'channels'],
  reqs: ['requests'],
  links: ['links'],
  recipes: ['recipes', 'recipeSheet'],
  team: ['users', 'pay', 'period', 'myPay', 'levels', 'trBadge', 'sales'],
  train: ['training', 'myTraining'],
  dial: ['dialin'],
  drawer: ['drawer', 'drawerBase'],
};
const haveNow = () => (data && data.v && data.me ? data.v : undefined);
let HIST = { key: '', from: '', shifts: [], punches: [] },
  histBusy = '';
function mergeGot(keep, got) {
  if (got.partial && keep) {
    const o = Object.assign({}, keep, got);
    delete o.results;
    delete o.partial;
    return o;
  } // an older server's "slim" reply
  delete got.results;
  delete got.partial;
  const sameUser = keep && keep.me && got.me && keep.me.id === got.me.id && keep.me.role === got.me.role;
  let out = got;
  if (sameUser && got.same && got.same.length) {
    out = Object.assign({}, got);
    got.same.forEach((n) =>
      (SECTION_FIELDS[n] || []).forEach((f) => {
        if (f in keep) out[f] = keep[f];
      })
    );
    out.v = Object.assign({}, keep.v || {}, got.v || {});
  }
  if (!sameUser) HIST = { key: '', from: '', shifts: [], punches: [] };
  return withHist(out);
}
/** Older weeks fetched earlier are added back in front of each fresh load. */
function withHist(d) {
  if (!d || !HIST.from || HIST.key !== (d.me && d.me.id + d.me.role)) return d;
  const cut = d.from || T(),
    add = (cur, old) => {
      const ids = {};
      (cur || []).forEach((x) => {
        ids[x.id] = 1;
      });
      return old.filter((x) => x.date < cut && !ids[x.id]).concat(cur || []);
    };
  return Object.assign(d, { shifts: add(d.shifts, HIST.shifts), punches: add(d.punches, HIST.punches) });
}
const loadedFrom = () =>
  HIST.from && HIST.key === data.me.id + data.me.role && HIST.from < (data.from || T())
    ? HIST.from
    : data.from || plus(T(), -70);
/** Make sure the days from `day` on are loaded (a week extra, so overtime adds up). Returns true when they already are. */
function needFrom(day) {
  if (!data || !data.from || day >= loadedFrom()) return true;
  const want = plus(monday(day), -7),
    to = plus(loadedFrom(), -1),
    from = want < plus(to, -119) ? plus(to, -119) : want,
    k = from + to;
  if (histBusy === k) return false;
  histBusy = k;
  post({ fn: 'api', token: TOKEN, p: { hist: { from, to } } })
    .then((r) => {
      const h = r && r.hist;
      histBusy = '';
      if (!h || !data) return;
      const key = data.me.id + data.me.role,
        same = HIST.key === key;
      const ids = (a) => new Set(a.map((x) => x.id));
      HIST = {
        key,
        from: h.from,
        shifts: h.shifts.concat(same ? HIST.shifts.filter((x) => !ids(h.shifts).has(x.id)) : []),
        punches: h.punches.concat(same ? HIST.punches.filter((x) => !ids(h.punches).has(x.id)) : []),
      };
      if (h.from > want) HIST.limit = h.from; // as far back as this role may look
      data = withHist(data);
      render();
    })
    .catch((e) => {
      histBusy = '';
      toast(String(e.message || e) === 'timeout' ? 'Earlier weeks took too long – try again' : String(e.message || e));
    });
  return false;
}

async function flush() {
  if (flying || !queue.length || !TOKEN) return;
  const batch = queue.splice(0),
    actions = batch.map((b) => {
      const a = Object.assign({}, b.p);
      if (a.id && idMap[a.id]) a.id = idMap[a.id];
      return a;
    });
  flying = true;
  let got = null,
    err = null;
  try {
    got = await post({
      fn: 'api',
      token: TOKEN,
      p: { actions, slim: actions.every((a) => SLIM.test(a.action)), have: haveNow() },
    });
  } catch (e) {
    err = e;
  }
  flying = false;
  pending -= batch.length;
  if (err) {
    const m = String(err.message || err);
    batch.forEach((b) => b.res(null));
    if (/^signin/.test(m)) {
      queue = [];
      pending = 0;
      saving();
      signOut(m.replace(/^signin:\s*/, ''));
      return;
    }
    if (m === 'timeout' || /fetch|network|load/i.test(m)) {
      toast('Still saving – checking in a moment…');
      if (queue.length) flush();
      else {
        saving();
        setTimeout(() => {
          if (!pending)
            refresh(undefined, { fresh: true }).then((r) => {
              if (r) toast('Checked – showing what was saved');
            });
        }, 6000);
      }
      return;
    }
    toast(m);
    if (queue.length) flush();
    else {
      saving();
      setTimeout(() => refresh(), 300);
    }
    return;
  }
  wrote(got);
  const res = got.results || [];
  actions.forEach((a, i) => {
    if (a.cid && res[i] && res[i].id) idMap[a.cid] = res[i].id;
  });
  const bad = res.find((x) => x && x.error);
  if (bad) toast(bad.error);
  if (typeof got.ms === 'number')
    console.info(
      '[Peregrine] saved ' +
        batch.length +
        ' change' +
        (batch.length === 1 ? '' : 's') +
        ' – server ' +
        (got.ms / 1000).toFixed(1) +
        's'
    );
  if (!queue.length) {
    // nothing newer waiting: show the server's copy (a newer edit would otherwise be wiped from the screen)
    seqShown = ++seqStarted;
    busy = {};
    offline = false;
    const keep = data;
    data = mergeGot(keep, Object.assign({}, got));
    liveSync();
    save('pt-cache', JSON.stringify(data));
    render();
  }
  batch.forEach((b, i) => b.res(res[i] && res[i].error ? null : Object.assign({}, data, { result: res[i] })));
  saving();
  if (queue.length) flush();
}
async function refresh(p, o) {
  if (!TOKEN) {
    data = null;
    render();
    return;
  }
  const isAct = !!(p && p.action),
    seq = ++seqStarted;
  if (isAct) {
    pending++;
    lastAct = seq;
  }
  let got = null,
    err = null;
  try {
    got =
      (!isAct && !(o && o.fresh) && (await edgeLoad())) ||
      (o && o.edgeOnly
        ? null
        : await post({ fn: 'api', token: TOKEN, p: Object.assign({ have: haveNow() }, p || {}) }));
  } catch (e) {
    err = e;
  }
  if (!got && !err && o && o.edgeOnly) return null;
  if (got && got.edge !== undefined && got.edge !== EDGE) {
    EDGE = got.edge;
    save('pt-edge', EDGE);
  }
  if (isAct && got) wrote(got);
  if (isAct) pending--;
  if (!err && (seq < seqShown || (!isAct && pending) || (isAct && seq !== lastAct))) return got;
  seqShown = seq;
  busy = {};
  if (err) {
    const m = String(err.message || err);
    if (/^signin/.test(m)) {
      signOut(m.replace(/^signin:\s*/, ''));
      return;
    }
    if (isAct) toast(m === 'timeout' ? 'That took too long – check it saved' : m);
    else {
      offline = true;
      if (m !== 'timeout' && !/fetch|network|load/i.test(m)) toast(m);
    }
    if (isAct && !pending) setTimeout(() => refresh(), 300);
    render();
    return null;
  }
  data = mergeGot(data, got);
  offline = false;
  liveSync();
  save('pt-cache', JSON.stringify(data));
  render();
  pushCheck();
  if (pendingGo) {
    const g = pendingGo;
    pendingGo = '';
    goTo(g);
  }
  return got;
}
/* Refresh by hand (the ↻ button or pulling down): show the Cloudflare copy straight away – it's at most a minute old – then
   check with the Sheet itself in the background. The button spins until the Sheet has answered. */
let refreshing = null;
function manualRefresh() {
  if (chat.open) {
    openChat(chat.open);
    return Promise.resolve();
  }
  if (refreshing) return refreshing;
  const btn = $('#refresh');
  if (btn) btn.classList.add('spin');
  refreshing = (async () => {
    try {
      await refresh(undefined, { edgeOnly: true });
    } catch (_) {}
    const r = await refresh(undefined, { fresh: true });
    if (r) toast('Up to date');
  })().finally(() => {
    refreshing = null;
    const b2 = $('#refresh');
    if (b2) b2.classList.remove('spin');
    ptrDone();
  });
  return refreshing;
}
/* Pull down from the top of the page to refresh (phones). */
const PTR = { y0: 0, dy: 0, on: false, el: null };
function ptrEl() {
  if (!PTR.el) {
    PTR.el = document.createElement('div');
    PTR.el.id = 'ptr';
    PTR.el.innerHTML = '<span>↻</span>';
    document.body.appendChild(PTR.el);
  }
  return PTR.el;
}
function ptrDone() {
  const el = PTR.el;
  if (!el) return;
  el.classList.remove('go');
  el.style.transform = '';
  el.style.opacity = '';
}
document.addEventListener(
  'touchstart',
  (e) => {
    PTR.on = false;
    if (e.touches.length !== 1 || !TOKEN || !data || refreshing) return;
    if (window.scrollY > 0 || sheet || viewer || chat.open || tab === 'chat' || $('#overlay').innerHTML.trim()) return;
    const t = e.target;
    if (
      t.closest &&
      (t.closest('input,textarea,select,[contenteditable],.msgs') ||
        (t.closest('.gridwrap') && t.closest('.gridwrap').scrollTop > 0))
    )
      return;
    PTR.on = true;
    PTR.y0 = e.touches[0].clientY;
    PTR.dy = 0;
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (e) => {
    if (!PTR.on) return;
    PTR.dy = e.touches[0].clientY - PTR.y0;
    if (window.scrollY > 0) {
      PTR.on = false;
      ptrDone();
      return;
    }
    if (PTR.dy <= 0) {
      ptrDone();
      return;
    }
    const pull = Math.min(110, PTR.dy * 0.5),
      el = ptrEl();
    el.style.transition = 'none';
    el.style.opacity = String(Math.min(1, pull / 60));
    el.style.transform = `translate(-50%, ${pull}px) rotate(${pull * 4}deg)`;
    el.classList.toggle('ready', pull >= 60);
  },
  { passive: true }
);
document.addEventListener(
  'touchend',
  () => {
    if (!PTR.on) return;
    PTR.on = false;
    const el = PTR.el;
    if (!el) return;
    el.style.transition = '';
    if (Math.min(110, PTR.dy * 0.5) >= 60) {
      el.classList.add('go');
      el.style.transform = 'translate(-50%, 60px)';
      if (navigator.vibrate)
        try {
          navigator.vibrate(10);
        } catch (_) {}
      manualRefresh();
    } else ptrDone();
  },
  { passive: true }
);
function saving() {
  const el = $('#saving');
  if (el) el.hidden = !pending;
}
function signOut(msg) {
  lastWriteAt = 0;
  save('pt-lastwrite', null);
  stopChat();
  liveEnd();
  TOKEN = '';
  data = null;
  save('pt-token', null);
  save('pt-cache', null);
  save('pt-drafts', null);
  render();
  if (msg) toast(msg.charAt(0).toUpperCase() + msg.slice(1));
}

/* ---------- formatting ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const pd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const plus = (s, n) => {
  const d = pd(s);
  d.setDate(d.getDate() + n);
  return ymdOf(d);
};
const T = () => (data ? data.today : ymdOf(new Date()));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monday = (s) => plus(s, -((pd(s).getDay() + 6) % 7));
const dayName = (s) =>
  s === T()
    ? 'Today'
    : s === plus(T(), 1)
      ? 'Tomorrow'
      : s === plus(T(), -1)
        ? 'Yesterday'
        : pd(s).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const shortDay = (s) => pd(s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const t12s = (hm) => t12(hm).replace(/([ap])m$/, '$1'); // 5:30a – compact, for the week grid
const t12 = (hm) => {
  if (!hm) return '';
  let [h, m] = hm.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + (m ? ':' + pad(m) : '') + ap;
};
const mins = (hm) => {
  const [h, m] = (hm || '0:0').split(':').map(Number);
  return h * 60 + m;
};
const hrs = (m) => (Math.round(m / 6) / 10).toFixed(1).replace(/\.0$/, '') + 'h';
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso)) / 6e4);
  return m < 1
    ? 'just now'
    : m < 60
      ? m + ' min ago'
      : m < 1440
        ? Math.round(m / 60) + ' h ago'
        : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const timeOf = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase()
    : '';
const hmOf = (iso) => {
  const d = new Date(iso);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const mgr = () => data && data.me.role === 'Manager',
  lead = () => data && (data.me.role === 'Lead' || mgr()),
  shop = () => !!data && data.me.role === 'Shop'; // the shared counter iPad
const first = (n) => String(n || '').split(' ')[0];
function toast(m) {
  const t = $('#toast');
  t.textContent = m;
  t.style.display = 'block';
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.style.display = 'none'), 3200);
}
const rowBtn = (attrs, inner) => {
  let cls = '';
  attrs = attrs.replace(/\s*class="([^"]*)"/, (_, c) => {
    cls = ' ' + c;
    return '';
  });
  return `<button class="row rb${cls}" ${attrs}>${inner}</button>`;
};

/* ---------- schedule logic ---------- */
const shiftsOn = (d) => (data.shifts || []).filter((s) => s.date === d);
/** Shifts as the team sees them (managers and leads also get drafts and pending changes, marked by status). */
const live = (s) => !s.status || s.status === 'published' || s.status === 'changed';
const notGone = (s) => s.status !== 'removed';
const STATUS = { draft: ['mute', 'Draft'], changed: ['warn', 'Not published'], removed: ['warn', 'Removing'] };
const statusPill = (s) =>
  STATUS[s.status] ? `<span class="pill ${STATUS[s.status][0]}">${STATUS[s.status][1]}</span>` : '';
const weekPending = (wk) =>
  (data.shifts || []).filter((s) => s.date >= wk && s.date <= plus(wk, 6) && s.status && s.status !== 'published');
const offOn = (q, d) => q.type === 'Time off' && q.date && q.date <= d && d <= (q.until || q.date); // time off can run several days
const approvedOff = (name, d) =>
  (data.requests || []).some((q) => q.from === name && offOn(q, d) && q.status === 'Approved');
const pendingOff = (name, d) =>
  (data.requests || []).some((q) => q.from === name && offOn(q, d) && q.status === 'Pending');
const offDays = (q) => (q.until ? Math.round((pd(q.until) - pd(q.date)) / 864e5) + 1 : 1);
const reqWhen = (q) =>
  !q.date ? '' : q.until ? dayName(q.date) + ' – ' + dayName(q.until) + ' (' + offDays(q) + ' days)' : dayName(q.date);
function unavail(name, d, start, end) {
  // the availability rule that clashes with this time, if any
  return (data.availability || []).find(
    (a) =>
      a.name === name &&
      (a.day === d || a.day === DOW[pd(d).getDay()]) &&
      (!a.from || !start || (mins(start) < mins(a.to) && mins(end || '23:59') > mins(a.from)))
  );
}
function conflicts(s) {
  const out = [];
  if (approvedOff(s.name, s.date)) out.push(['warn', 'Time off']);
  else if (pendingOff(s.name, s.date)) out.push(['mute', 'Asked for off']);
  const u = unavail(s.name, s.date, s.start, s.end);
  if (u) out.push(['warn', u.from ? 'Unavailable ' + t12(u.from) + '–' + t12(u.to) : 'Unavailable']);
  if (
    s.status !== 'removed' &&
    (data.shifts || []).some(
      (x) =>
        x !== s &&
        x.id !== s.id &&
        notGone(x) &&
        x.name === s.name &&
        x.date === s.date &&
        mins(x.start) < mins(s.end) &&
        mins(x.end) > mins(s.start)
    )
  )
    out.push(['warn', 'Double-booked']);
  return out;
}

/* ---------- scheduling lineup: who shows on the schedule, in what order ---------- */
const ROLE_ORDER = { Manager: 0, Lead: 1, Staff: 2 };
function lineup() {
  // active people, manager-chosen order first, then by role and name
  const src = mgr() ? (data.users || []).filter((u) => u.active) : data.people || [];
  return src
    .slice()
    .sort(
      (a, b) =>
        (a.order || 9999) - (b.order || 9999) ||
        (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) ||
        a.name.localeCompare(b.name)
    );
}
const shown = (p) => p.onSchedule !== false;

/* ---------- wage estimates (managers only; wages never reach staff phones) ---------- */
const wageOf = (n) => {
  const u = (data.users || []).find((x) => x.name === n);
  return u ? Number(u.wage) || 0 : data.myPay && n === data.me.name ? Number(data.myPay.wage) || 0 : 0;
};
const money = (x, cents) => '$' + (cents ? (Math.round(x * 100) / 100).toFixed(2) : Math.round(x).toLocaleString());
/** items: [{key, name, date, sort, h}] within one Mon–Sun week. Overtime past the weekly threshold, in time order, at the overtime rate. */
function labor(items, o) {
  const P = data.pay || data.myPay || { ot: 40, otRate: 1.5, extra: 0 },
    k = o && o.noExtra ? 1 : 1 + (Number(P.extra) || 0) / 100;
  const out = { byKey: {}, otByKey: {}, byPerson: {}, byDay: {}, hoursByPerson: {}, ot: {}, total: 0, missing: [] },
    groups = {};
  items.forEach((i) => (groups[i.name] = groups[i.name] || []).push(i));
  Object.keys(groups).forEach((n) => {
    const w = wageOf(n);
    if (!w) out.missing.push(n);
    let acc = 0;
    groups[n]
      .sort((a, b) => a.sort.localeCompare(b.sort))
      .forEach((i) => {
        const reg = Math.max(0, Math.min(i.h, P.ot - acc)),
          over = i.h - reg;
        acc += i.h;
        const c = (reg * w + over * w * P.otRate) * k;
        out.byKey[i.key] = c;
        out.byPerson[n] = (out.byPerson[n] || 0) + c;
        out.byDay[i.date] = (out.byDay[i.date] || 0) + c;
        out.total += c;
        out.hoursByPerson[n] = acc;
        if (over > 0) {
          out.ot[n] = (out.ot[n] || 0) + over;
          out.otByKey[i.key] = over;
        }
      });
  });
  return out;
}
const shiftItems = (list) =>
  list.map((s) => ({
    key: s.id,
    name: s.name,
    date: s.date,
    sort: s.date + s.start,
    h: Math.max(0, mins(s.end) - mins(s.start)) / 60,
  }));
const punchItems = (list) =>
  list
    .filter((p) => p.in && p.out)
    .map((p) => ({
      key: p.id,
      name: p.name,
      date: p.date,
      sort: p.in,
      h: Math.max(0, new Date(p.out) - new Date(p.in)) / 36e5,
    }));
const weekShifts = (wk) => (data.shifts || []).filter((s) => notGone(s) && s.date >= wk && s.date <= plus(wk, 6));
/** Punches with any open one counted up to right now (older than 16h = a missed clock-out, left out). */
const punchesNow = (name) =>
  (data.punches || [])
    .filter((p) => p.in && (!name || p.name === name))
    .map((p) =>
      p.out
        ? p
        : Date.now() - new Date(p.in) < 16 * 36e5
          ? Object.assign({}, p, { out: new Date().toISOString(), running: true })
          : null
    )
    .filter(Boolean);
/** Hours and cost for the days from..to. Each Mon–Sun week is worked out whole (so overtime lands on the right days), then only the days in range are added up. */
function costIn(items, from, to, o) {
  const out = { total: 0, hours: 0, byPerson: {}, byDay: {}, hoursByPerson: {}, hoursByDay: {}, ot: {}, missing: [] };
  [...new Set(items.filter((i) => i.date >= from && i.date <= to).map((i) => monday(i.date)))].forEach((wk) => {
    const inWk = items.filter((i) => i.date >= wk && i.date <= plus(wk, 6)),
      L = labor(inWk, o);
    inWk
      .filter((i) => i.date >= from && i.date <= to)
      .forEach((i) => {
        const c = L.byKey[i.key] || 0,
          n = i.name;
        out.total += c;
        out.hours += i.h;
        out.byPerson[n] = (out.byPerson[n] || 0) + c;
        out.byDay[i.date] = (out.byDay[i.date] || 0) + c;
        out.hoursByPerson[n] = (out.hoursByPerson[n] || 0) + i.h;
        out.hoursByDay[i.date] = (out.hoursByDay[i.date] || 0) + i.h;
        if (L.otByKey[i.key]) out.ot[n] = (out.ot[n] || 0) + L.otByKey[i.key];
      });
    L.missing.forEach((n) => {
      if (out.missing.indexOf(n) < 0) out.missing.push(n);
    });
  });
  return out;
}
/** The pay period a date falls in: Weekly, Every 2 weeks (from the "Pay period starts on" date) or Twice a month (1st–15th, 16th–end). */
function periodOf(d) {
  const P = data.period || { kind: 'biweek', start: '' };
  if (P.kind === 'semi') {
    const ym = d.slice(0, 8),
      [y, m, dd] = d.split('-').map(Number);
    return dd <= 15 ? [ym + '01', ym + '15'] : [ym + '16', ym + pad(new Date(y, m, 0).getDate())];
  }
  const len = P.kind === 'week' ? 7 : 14,
    anchor = P.start || '2026-01-05',
    off = ((Math.round((pd(d) - pd(anchor)) / 864e5) % len) + len) % len,
    from = plus(d, -off);
  return [from, plus(from, len - 1)];
}
const rangeOf = (mode, d) =>
  mode === 'day' ? [d, d] : mode === 'period' ? periodOf(d) : [monday(d), plus(monday(d), 6)];
/** Live estimate for the shift being edited, counting the rest of that person's week (so overtime shows up). */
function shiftEstimate(f) {
  const g = (n) => (f.elements.namedItem(n) || {}).value || '',
    name = g('name'),
    date = g('date'),
    start = g('start'),
    end = g('end');
  if (!mgr() || !name || !date || !start || !end || end <= start) return '';
  const w = wageOf(name);
  if (!w) return `<span class="sub">No wage set for ${esc(first(name))} – add it in Team to see an estimate.</span>`;
  const wk = monday(date),
    others = weekShifts(wk).filter((s) => s.id !== (sheet && sheet.id));
  const L = labor(shiftItems(others.concat([{ id: '_this', name, date, start, end }])));
  const h = (mins(end) - mins(start)) / 60,
    c = L.byKey._this || 0,
    regCost = h * w * (1 + (Number((data.pay || {}).extra) || 0) / 100);
  return `<b>Est. ${money(c, true)}</b> <span class="sub">· ${hrs(h * 60)} × ${money(w, true)}/h${c > regCost + 0.005 ? ' · includes overtime' : ''} · ${esc(first(name))}'s week: ${hrs(L.hoursByPerson[name] * 60)}${L.ot[name] ? ' (' + hrs(L.ot[name] * 60) + ' overtime)' : ''}, ${money(L.byPerson[name] || 0)}</span>`;
}

/* ---------- time sheet logic ---------- */
function weekReport(wk, name) {
  return rangeReport(wk, plus(wk, 6), name);
}
function rangeReport(from, to, name) {
  const days = [],
    now = new Date();
  for (let d = from; d <= to; d = plus(d, 1)) days.push(d);
  const people = name
    ? [name]
    : [
        ...new Set(
          (data.shifts || [])
            .filter((s) => days.includes(s.date))
            .map((s) => s.name)
            .concat((data.punches || []).filter((p) => days.includes(p.date)).map((p) => p.name))
        ),
      ].sort();
  const late = data.lateAfter || 5;
  return people.map((n) => {
    const sh = (data.shifts || []).filter((s) => live(s) && s.name === n && days.includes(s.date)),
      pu = (data.punches || []).filter((p) => p.name === n && days.includes(p.date));
    let sched = 0,
      worked = 0,
      lates = 0,
      noShow = 0,
      missingOut = 0,
      overs = 0,
      autos = 0,
      running = false;
    const lines = [];
    sh.forEach((s) => {
      sched += mins(s.end) - mins(s.start);
      const p = pu.find((x) => x.shift === s.id) || pu.find((x) => !x.shift && x.date === s.date);
      const started = new Date(pd(s.date).getTime() + mins(s.end) * 6e4) < now;
      const lateBy =
        p && p.in ? Math.round((new Date(p.in) - new Date(pd(s.date).getTime() + mins(s.start) * 6e4)) / 6e4) : 0;
      if (p && lateBy > late) lates++;
      if (!p && started && !approvedOff(n, s.date)) noShow++;
      const overBy = overOf(s, p, now);
      if (OVER() && overBy > OVER()) overs++;
      lines.push({
        date: s.date,
        shift: s,
        punch: p,
        lateBy,
        overBy,
        noShow: !p && started && !approvedOff(n, s.date),
      });
    });
    pu.forEach((p) => {
      if (p.in && p.out) worked += (new Date(p.out) - new Date(p.in)) / 6e4;
      else if (p.in && !p.out && now - new Date(p.in) <= 16 * 36e5) {
        worked += (now - new Date(p.in)) / 6e4;
        running = true;
      } else if (p.in && !p.out && now - new Date(p.in) > 16 * 36e5) missingOut++;
      if (autoOut(p)) autos++;
      if (!lines.some((l) => l.punch === p)) lines.push({ date: p.date, shift: null, punch: p, unscheduled: true });
    });
    lines.sort((a, b) =>
      (a.date + (a.shift ? a.shift.start : hmOf(a.punch.in))).localeCompare(
        b.date + (b.shift ? b.shift.start : hmOf(b.punch.in))
      )
    );
    return {
      name: n,
      sched,
      worked,
      running,
      lates,
      noShow,
      missingOut,
      overs,
      autos,
      unscheduled: lines.filter((l) => l.unscheduled).length,
      lines,
    };
  });
}
/** Minutes a punch ran past its scheduled shift: the later of "stayed past the end" and "worked longer than scheduled". Live while still clocked in. */
const OVER = () => (data && data.overAfter !== undefined ? Number(data.overAfter) || 0 : 30);
const autoOut = (p) => !!(p && p.outPlace === 'auto clock-out');
function overOf(s, p, now) {
  if (!s || !p || !p.in) return 0;
  const inT = new Date(p.in).getTime(),
    outT = p.out ? new Date(p.out).getTime() : now - inT <= 16 * 36e5 ? now.getTime() : 0;
  if (!outT) return 0;
  const st = pd(s.date).getTime() + mins(s.start) * 6e4,
    en = pd(s.date).getTime() + mins(s.end) * 6e4;
  return Math.max(0, Math.round(Math.max(outT - en, outT - inT - (en - st)) / 6e4));
}
const overTxt = (m) => (m < 60 ? m + ' min' : hrs(m));

/* ---------- locations: managers switch between shops with the shop name at the top (locations.js) ---------- */
const LOCS = window.PT_LOCATIONS || [],
  HOME = window.PT_HOME || 'richardson',
  HERE = window.PT_LOC || HOME;
const locName = (k) => (LOCS.find((l) => l.key === k) || {}).name || k;
const canSwitch = () => LOCS.length > 1 && (HERE !== HOME || (data && mgr()));
function switchTo(k) {
  try {
    k === HOME ? localStorage.removeItem('pt-loc@' + HOME) : localStorage.setItem('pt-loc@' + HOME, k);
  } catch (_) {}
  location.replace(location.pathname + location.search);
}
function locSheet() {
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">Location</h1><button class="btn sm" data-closesheet>Close</button></div>
    <div class="card" style="margin-top:12px">${LOCS.map((l) => {
      let signed = false;
      try {
        signed = !!localStorage.getItem(l.ns + 'pt-token');
      } catch (_) {}
      return rowBtn(
        `data-loc="${esc(l.key)}"`,
        `<div class="txt"><b>${esc(l.name)}</b><div class="sub">${l.key === HERE ? "You're here" : signed ? 'Signed in' : 'Sign in once, then switch any time'}</div></div>${l.key === HERE ? '<span class="pill ok">✓</span>' : '<span>›</span>'}`
      );
    }).join('')}</div>
    <p class="sub">Each location is its own team, schedule and time clock. You stay signed in to each one on this ${deviceKind()}.</p></div></div>`;
}

/* ---------- invite links: a manager adds someone and sends them their link. The person opens it, types their phone and
   email, and that creates their account – their code is the last 4 digits of their phone, and they're signed in.
   The link is the app address + #join=<id.signature>; it holds no code, and it works once. ---------- */
const appHome = () => window.PT_APPURL || location.origin + location.pathname.replace(/index\.html$/, '');
const inviteLink = (u) => appHome() + '#join=' + u.invite;
const inviteText = (u) =>
  `Hi ${first(u.name)}! Here's the Peregrine team app – schedule, time clock, messages and checklists.\n\nOpen this link on your phone to set up your account: ${inviteLink(u)}\n\nYou'll add your phone number and email, and your sign-in code will be the last 4 digits of your phone.`;
let invite = null,
  joined = null; // invite: { key, first, name, shop, err } while setting up; joined: { first, code } right after
{
  const m = location.hash.match(/^#join=([\w]+\.[0-9a-f]{24})$/);
  if (m) invite = { key: m[1] };
}
function loadInvite() {
  post({ fn: 'joinInfo', invite: invite.key })
    .then((r) => {
      if (invite) {
        Object.assign(invite, { first: r.first, name: r.name, shop: r.shop });
        render();
      }
    })
    .catch((e) => {
      if (invite) {
        invite.err =
          String(e.message || e) === 'timeout'
            ? 'The server took too long – reload to try again.'
            : String(e.message || e);
        render();
      }
    });
}

/* ---------- screens ---------- */
function viewSignIn() {
  if (invite && !invite.err) return viewWelcome();
  const hint = !standalone()
    ? isIOS()
      ? `<div class="hint"><b>Put it on your home screen:</b> tap <b>Share</b> <span aria-hidden="true">⬆︎</span> at the bottom of Safari, then <b>Add to Home Screen</b>. Open it from there and sign in.</div>`
      : installEvt
        ? `<div class="hint"><b>Install the app</b> for one-tap access. <button class="btn sm go" data-install>Install</button></div>`
        : `<div class="hint"><b>Put it on your home screen:</b> in Chrome, tap <b>⋮</b> then <b>Add to Home screen</b> (or <b>Install app</b>).</div>`
    : '';
  return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">${esc((data && data.name) || load('pt-shop') || window.PT_NAME || 'Peregrine')}</p><p class="sub" style="text-align:center;margin:0 0 18px">Team sign-in</p>
    ${HERE !== HOME ? `<div class="hint">Signing in to <b>${esc(locName(HERE))}</b>. Your ${esc(locName(HOME))} sign-in stays as it is. <button class="btn sm" data-loc="${esc(HOME)}" style="margin-top:8px">‹ Back to ${esc(locName(HOME))}</button></div>` : ''}${invite && invite.err ? `<div class="hint">${esc(invite.err)}</div>` : ''}${HERE !== HOME ? '' : hint}<div class="card"><form class="stack" data-form="signin">
      <label class="f">First name<input name="name" autocomplete="username" autocapitalize="words" spellcheck="false" maxlength="60" value="${esc(load('pt-last') || '')}"></label>
      <label class="f">4-digit code<input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="current-password" class="code" style="text-align:center"></label>
      <button class="btn go">Sign in</button></form></div>
    <p class="sub" style="text-align:center">Don't know your code? Ask a manager.</p><i class="sprig" aria-hidden="true"></i></div>`;
}

/** What someone sees when they open their invite link: add phone + email, and the account is made. */
function viewWelcome() {
  const i = invite,
    shop = esc(i.shop || (data && data.name) || load('pt-shop') || window.PT_NAME || 'Peregrine');
  if (!i.first)
    return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">Welcome</p><div class="empty">Opening your invite…</div></div>`;
  return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">Welcome, ${esc(i.first)}</p><p class="sub" style="text-align:center;margin:0 0 18px">Set up your ${shop} team account</p>
    <div class="card"><form class="stack" data-form="join">
      <label class="f">Your name<input value="${esc(i.name)}" disabled></label>
      <label class="f">Mobile phone<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="(214) 555-0123" required></label>
      <label class="f">Email<input name="email" type="email" autocomplete="email" maxlength="120" placeholder="you@example.com" required></label>
      <p class="sub" style="margin:0">Your sign-in code will be the <b>last 4 digits of your phone number</b>. Your email is for shift reminders.</p>
      <button class="btn go">Create my account</button></form></div>
    <p class="sub" style="text-align:center">Wrong name? Ask a manager for a new link.</p><i class="sprig" aria-hidden="true"></i></div>`;
}
/** Right after setting up: how to put the app on the home screen (on iPhone the home-screen app needs signing in once more). */
function viewJoined() {
  const j = joined,
    ios = isIOS() && !standalone();
  return `<div class="signin"><img class="logo" src="brand/falcon.png" alt=""><p class="big">You're all set, ${esc(j.first)}</p>
    <div class="card"><div class="row" style="display:block"><b>Your sign-in</b><div class="sub" style="margin-top:4px">First name <b>${esc(j.first)}</b> · code <span class="code">${esc(j.code)}</span> (the last 4 digits of your phone)</div></div>
      ${
        standalone()
          ? ''
          : ios
            ? `<div class="row" style="display:block"><b>Put the app on your home screen</b><div class="sub" style="margin-top:4px">Tap <b>Share</b> <span aria-hidden="true">⬆︎</span> at the bottom of Safari, then <b>Add to Home Screen</b>, then <b>Add</b>. Open Peregrine from your home screen and sign in with the name and code above.</div></div>`
            : `<div class="row" style="display:block"><b>Install the app</b><div class="sub" style="margin-top:4px">${installEvt ? '<button class="btn sm go" data-install>Install</button>' : 'In Chrome, tap <b>⋮</b> then <b>Add to Home screen</b> (or <b>Install app</b>).'}</div></div>`
      }</div>
    <button class="btn go" data-joindone style="width:100%">${ios ? 'Keep using it in Safari' : 'Open the app'}</button><i class="sprig" aria-hidden="true"></i></div>`;
}

/** Must-read announcements cover the app until each one is acknowledged. */
function mustRead() {
  return (data.announcements || []).filter((a) => a.mustAck && !a.read);
}
function viewMustRead(a, left) {
  return `<div class="gate"><div class="gate-in"><img class="mark" src="brand/bird-gold.png" alt=""><p class="sub" style="margin:0 0 6px">${left > 1 ? `1 of ${left} · ` : ''}Please read before you continue</p>
    <h1 style="margin-bottom:8px">${esc(a.title)}</h1><div class="msg" style="font-size:1.05rem">${linkify(esc(a.message))}</div>
    <p class="sub">From ${esc(a.from)} · ${ago(a.posted)}</p><button class="btn go" data-ack="${esc(a.id)}" style="width:100%;margin-top:14px">I've read this</button></div></div>`;
}

function myNextShift() {
  const now = new Date();
  return (data.shifts || []).find(
    (s) =>
      live(s) &&
      s.name === data.me.name &&
      (s.date > T() || (s.date === T() && mins(s.end) > now.getHours() * 60 + now.getMinutes()))
  );
}

/* ----- clock-in types: what someone is clocking in for (Barista, Lead, Training…) ----- */
/** Big buttons, one per type; attrs(t) gives each button's data attributes. */
const ctPicker = (types, attrs) =>
  `<div class="ctgrid">${types
    .map(
      (t, i) =>
        `<button class="ctbtn ${i === 0 ? 'first' : ''}" ${attrs(t)}><b>${esc(t)}</b>${i === 0 ? '<small>Usual shift</small>' : ''}</button>`
    )
    .join('')}</div>`;
function clockTypeSheet() {
  return `<div class="sheet" role="dialog" aria-label="What are you clocking in for?"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">Clocking in for…</h1><button class="btn sm" data-closesheet>Cancel</button></div>
    <p class="sub">Pick the kind of shift you're working.</p>
    ${ctPicker(data.clockTypes || [], (t) => `data-clock="in" data-ctype="${esc(t)}"`)}</div></div>`;
}
function clockCard() {
  const o = data.open,
    next = myNextShift();
  if (o) {
    const s = (data.shifts || []).find((x) => x.id === o.shift);
    const w = wageOf(data.me.name),
      h = (Date.now() - new Date(o.in)) / 36e5;
    return `<div class="card clock on"><div class="row"><div class="txt"><b>Clocked in${o.as ? ' as ' + esc(o.as) : ''} · ${timeOf(o.in)}</b><div class="sub">${s ? 'Shift ' + t12(s.start) + '–' + t12(s.end) : 'Not on the schedule'}${o.inPlace && o.inPlace !== 'at the shop' ? ' · ' + esc(o.inPlace) : ''}</div></div><button class="btn warn" data-clock="out">Clock out</button></div>
      <div class="row clockrun"><div class="txt"><span class="runclock" data-clocksince="${esc(o.in)}">${elapsed(o.in)}</span><div class="sub">on the clock${w ? ` · about <span data-paysince="${esc(o.in)}" data-pw="${w}">${money(h * w, true)}</span> so far` : ''}</div></div><button class="btn sm" data-more="time">My time ›</button></div></div>`;
  }
  const soon = next && next.date === T();
  return `<div class="card clock"><div class="row"><div class="txt"><b>${soon ? 'Your shift today · ' + t12(next.start) + '–' + t12(next.end) : 'Not clocked in'}</b><div class="sub">${soon ? esc(next.position || '') : next ? 'Next: ' + dayName(next.date) + ' ' + t12(next.start) : 'No shifts coming up'}</div></div><button class="btn go" data-clock="in">Clock in</button></div></div>`;
}

/* ---------- Labor now (leads + managers): who is on the clock and today's running wage cost ---------- */
function laborCard() {
  const F = data.floor;
  if (!F || !lead()) return '';
  const M = mgr(),
    k = 1 + (Number(F.extra) || 0) / 100,
    now = new Date(),
    cur = now.getHours() * 60 + now.getMinutes();
  const todays = shiftsOn(T()).filter(live),
    shiftFor = (x) =>
      todays.find((s) => s.id === x.shift) ||
      todays.find((s) => s.name === x.name && mins(s.start) <= cur + 60 && mins(s.end) >= mins(hmOf(x.in)));
  const punched = new Set(F.on.concat(F.done).map((x) => x.name));
  const notIn = todays.filter(
    (s) => !punched.has(s.name) && cur > mins(s.start) + (data.lateAfter || 5) && cur < mins(s.end)
  );
  const onRow = (x) => {
    const s = shiftFor(x),
      over = s && cur > mins(s.end) + 10;
    return `<div class="row"><div class="txt"><b>${esc(x.name)}</b>${levelPill(x.name)}<div class="sub">In ${timeOf(x.in)} · <span data-hsince="${esc(x.in)}">${hrs((now - new Date(x.in)) / 6e4)}</span>${s ? ' · until ' + t12(s.end) : ' · no shift today'}</div></div>${over ? '<span class="pill warn">Past end</span>' : ''}${M ? `<span class="money">${x.wage ? `<span data-psince="${esc(x.in)}" data-pw="${x.wage * k}">${money(((now - new Date(x.in)) / 36e5) * x.wage * k, true)}</span>` : '<span class="sub">no wage</span>'}</span>` : ''}</div>`;
  };
  const doneLine = F.done.length
    ? `<div class="row"><div class="txt"><b>Clocked out today</b><div class="sub">${F.done.map((x) => `${esc(first(x.name))} ${hrs((new Date(x.out) - new Date(x.in)) / 6e4)}${M && x.wage ? ' · ' + money(x.cost, true) : ''}`).join(' &nbsp;·&nbsp; ')}</div></div></div>`
    : '';
  const miss = M ? (F.missing || []).length : F.missing || 0;
  return `<h2>Labor now</h2><div class="card laborcard">
    <div class="row lc-top"><div class="lc-stat"><b>${F.on.length}</b><span class="sub">on the clock</span></div>
      <div class="lc-stat"><b data-labor>${money(F.cost + (F.rate * Math.max(0, now - new Date(F.at))) / 36e5, true)}</b><span class="sub">labor today</span></div>
      <div class="lc-stat"><b>${money(F.rate, true)}</b><span class="sub">per hour now</span></div></div>
    ${F.on.map(onRow).join('') || '<div class="empty">Nobody is clocked in.</div>'}
    ${notIn.length ? `<div class="row"><div class="txt"><b>Scheduled, not clocked in</b><div class="sub">${notIn.map((s) => `${esc(first(s.name))} (${t12(s.start)})`).join(', ')}</div></div><span class="pill warn">${notIn.length}</span></div>` : ''}
    ${doneLine}
    ${rowBtn(`data-tsday="${T()}"`, '<div class="txt"><b>Labor by day</b><div class="sub">Yesterday, tomorrow, any week</div></div><span>›</span>')}</div>
  <p class="sub">Estimate: hours × wage${k > 1 ? ' + ' + Math.round((k - 1) * 100) + '% extra' : ''}, no overtime. Payroll decides.${miss ? ` ${M ? 'No wage set for ' + F.missing.map(first).map(esc).join(', ') + '.' : miss + (miss > 1 ? ' people have' : ' person has') + ' no wage set, so the total is low.'}` : ''}</p>`;
}
/** Sales vs labor (managers): yesterday's SkyTab numbers from the daily Lighthouse email, with labor cost for the same day. */
function salesCard() {
  const S = data.sales;
  if (!S || !mgr()) return '';
  const days = S.days || [];
  if (!days.length)
    return S.search
      ? `<h2>Sales</h2><div class="card"><div class="empty">No SkyTab sales yet. Once the daily report email from Lighthouse arrives (it's checked every hour), yesterday's sales and labor % show here.</div></div>`
      : '';
  const pct = (x) => (x.net > 0 && x.labor ? Math.round((x.labor / x.net) * 1000) / 10 + '%' : '–');
  const last = days[days.length - 1],
    wk = days.filter((x) => x.date > plus(last.date, -7)),
    prev = days.find((x) => x.date === plus(last.date, -7));
  const sum = (l, k) => l.reduce((n, x) => n + (Number(x[k]) || 0), 0),
    wn = sum(wk, 'net'),
    wl = sum(wk, 'labor');
  const avg = last.checks ? last.net / last.checks : 0;
  const vs = prev && prev.net ? Math.round(((last.net - prev.net) / prev.net) * 100) : null;
  return `<h2>Sales</h2><div class="card laborcard">
    <div class="row lc-top"><div class="lc-stat"><b>${money(last.net || last.gross || 0)}</b><span class="sub">${esc(dayName(last.date))} net</span></div>
      <div class="lc-stat"><b>${pct(last)}</b><span class="sub">labor (${money(last.labor || 0)})</span></div>
      <div class="lc-stat"><b>${last.checks ? money(avg, true) : '–'}</b><span class="sub">${last.checks ? last.checks + ' checks' : 'avg check'}</span></div></div>
    ${vs !== null ? `<div class="row"><div class="txt"><b>vs. last ${pd(last.date).toLocaleDateString([], { weekday: 'long' })}</b><div class="sub">${money(prev.net)} net · ${pct(prev)} labor</div></div><span class="pill${vs < 0 ? ' warn' : ''}">${vs > 0 ? '+' : ''}${vs}%</span></div>` : ''}
    <div class="row"><div class="txt"><b>Last ${wk.length} day${wk.length > 1 ? 's' : ''}</b><div class="sub">${money(wn)} net · ${money(wl)} labor · ${wn > 0 ? Math.round((wl / wn) * 1000) / 10 + '%' : '–'} labor${sum(wk, 'tips') ? ' · ' + money(sum(wk, 'tips')) + ' tips' : ''}</div></div></div>
    <div class="row"><div class="txt"><div class="sub">${days
      .slice(-7)
      .reverse()
      .map((x) => `${esc(shortDay(x.date))}: ${money(x.net || 0)} · ${pct(x)}`)
      .join('<br>')}</div></div></div></div>
  <p class="sub">From the SkyTab daily report (comes in each morning). Labor = clocked hours × wage${data.pay && data.pay.extra ? ' + ' + data.pay.extra + '%' : ''}.</p>`;
}
function tickLabor() {
  // keep the running numbers moving between refreshes, without redrawing the page
  const F = data && data.floor;
  if (!F || tab !== 'today') return;
  const now = Date.now(),
    el = document.querySelector('[data-labor]');
  if (el) el.textContent = money(F.cost + (F.rate * Math.max(0, now - new Date(F.at))) / 36e5, true);
  document.querySelectorAll('[data-hsince]').forEach((e) => {
    e.textContent = hrs((now - new Date(e.dataset.hsince)) / 6e4);
  });
  document.querySelectorAll('[data-psince]').forEach((e) => {
    e.textContent = money(((now - new Date(e.dataset.psince)) / 36e5) * Number(e.dataset.pw), true);
  });
}
setInterval(tickLabor, 15000);
const elapsed = (iso) => {
  const t = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  return Math.floor(t / 3600) + ':' + pad(Math.floor(t / 60) % 60) + ':' + pad(t % 60);
};
setInterval(() => {
  // the live clock-in timer, every second, without redrawing the page
  document.querySelectorAll('[data-clocksince]').forEach((e) => {
    e.textContent = elapsed(e.dataset.clocksince);
  });
  document.querySelectorAll('[data-paysince]').forEach((e) => {
    e.textContent = money(((Date.now() - new Date(e.dataset.paysince)) / 36e5) * Number(e.dataset.pw), true);
  });
}, 1000);
setInterval(() => {
  // shop iPad: keep the clock on the clock-in screen current
  if (shop() && tab === 'today' && !sheet && !document.hidden) render();
}, 20000);
setInterval(() => {
  // time sheets: keep hours and pay moving while someone is on the clock
  if (!data || tab !== 'more' || moreView !== 'time' || sheet || viewer || document.hidden) return;
  if ((data.punches || []).some((p) => p.in && !p.out && Date.now() - new Date(p.in) < 16 * 36e5)) render();
}, 30000);

function viewToday() {
  if (shop()) return viewShopHome();
  if (CK.open) return viewClockOutCheck();
  if (HO.open) return viewHandoff();
  if (SRCH.open) return viewSearch();
  const d = data,
    today = shiftsOn(T()).filter(live),
    next = myNextShift();
  const unread = (d.announcements || []).filter((a) => !a.read);
  const pendingReq = mgr() ? (d.requests || []).filter((q) => q.status === 'Pending' && q.from !== d.me.name) : [];
  const mine = (d.requests || []).filter((q) => q.from === d.me.name && q.status !== 'Cancelled').slice(0, 3);
  const chatN = (d.channels || []).reduce((n, c) => n + c.unread, 0);
  const hour = new Date().getHours(),
    hi = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const att = mgr()
    ? weekReport(monday(T())).reduce(
        (a, r) => ({
          late: a.late + r.lates,
          no: a.no + r.noShow,
          miss: a.miss + r.missingOut,
          over: a.over + r.overs,
          auto: a.auto + r.autos,
        }),
        { late: 0, no: 0, miss: 0, over: 0, auto: 0 }
      )
    : null;
  const remindHint =
    d.reminders &&
    d.reminders.on &&
    d.reminders.by &&
    d.reminders.by !== 'push' &&
    !d.me.email &&
    d.me.reminders !== 'Off' &&
    load('pt-nohint') !== '1'
      ? `<div class="hint"><b>Get a reminder before your shifts.</b> Add your email and pick when. <div class="btns" style="margin-top:8px"><button class="btn sm go" data-more="reminders">Set up reminders</button><button class="btn sm" data-nohint>Not now</button></div></div>`
      : '';
  const pubHint =
    lead() && d.unpublished
      ? `<div class="hint"><b>${d.unpublished} schedule change${d.unpublished > 1 ? 's' : ''} not published yet.</b> The team can't see ${d.unpublished > 1 ? 'them' : 'it'} until you publish. <div class="btns" style="margin-top:8px"><button class="btn sm go" data-tab="schedule">Review & publish</button></div></div>`
      : '';
  const pm = prepMine();
  const prepCard = pm.length ? `<h2>Prep for your shift</h2><div class="card">${pm.map(prepRow).join('')}</div>` : '';
  const pushHint =
    d.push &&
    d.push.ready &&
    !pushOn_() &&
    load('pt-nopush') !== '1' &&
    (pushNeedsHome() || (pushOK() && Notification.permission !== 'denied'))
      ? `<div class="hint"><b>Get notifications on this ${deviceKind()}.</b> ${pushNeedsHome() ? 'On iPhone, add the app to your Home Screen first, then turn them on.' : 'New messages, schedule changes and prep for your shift.'}
      <div class="btns" style="margin-top:8px">${pushNeedsHome() ? '<button class="btn sm go" data-more="push">Show me how</button>' : '<button class="btn sm go" data-pushon>Turn on</button>'}<button class="btn sm" data-nopush>Not now</button></div></div>`
      : '';
  return `<h1>${hi}, ${esc(first(d.me.name))}</h1>
    <button class="gsbar" data-gsopen aria-label="Search everything"><span aria-hidden="true">⌕</span>Search recipes, checklists, people…</button>
    ${pubHint}${stage() === 'new' ? '' : pushHint}${remindHint}${on('timeclock') ? clockCard() : ''}${handoffCard()}${firstWeekCard()}${forYouCard()}${on('timeclock') ? laborCard() : ''}${on('sales') ? salesCard() : ''}${on('prep') ? prepCard : ''}${dialCard()}
    ${unread.length ? `<div class="card">${unread.slice(0, 3).map(annRow).join('')}</div>` : ''}
    ${chatN ? `<div class="card">${rowBtn('data-tab="chat"', `<div class="txt"><b>${chatN} unread message${chatN > 1 ? 's' : ''}</b></div><span>›</span>`)}</div>` : ''}
    <h2>Working today</h2><div class="card">${today.length ? today.map((s) => `<div class="row ${s.name === d.me.name ? 'mine' : ''}"><div class="txt"><b>${esc(s.name)}</b>${levelPill(s.name)}<div class="sub">${t12(s.start)}–${t12(s.end)}${s.position ? ' · ' + esc(s.position) : ''}</div></div>${mgr() ? clockState(s) : ''}</div>`).join('') : '<div class="empty">Nobody scheduled today.</div>'}</div>
    ${!on('lists') ? '' : `<h2>Lists</h2><div class="card">${(d.checklists || []).map((c) => rowBtn(`data-golist="${esc(c.list)}"`, `<div class="txt"><b>${esc(c.list)}</b><div class="progress"><i style="width:${c.total ? Math.round((c.done / c.total) * 100) : 0}%"></i></div></div><span class="pill ${c.done === c.total && c.total ? 'ok' : 'mute'}">${c.done}/${c.total}</span>`)).join('') || '<div class="empty">No lists today. A manager sets them up on the Checklists tab in the sheet.</div>'}</div>`}
    ${
      pendingReq.length || (att && (att.late || att.no || att.miss || att.over || att.auto))
        ? `<h2>Waiting on you</h2><div class="card">
      ${pendingReq.length ? rowBtn('data-more="requests"', `<div class="txt"><b>${pendingReq.length} request${pendingReq.length > 1 ? 's' : ''}</b> to approve</div><span>›</span>`) : ''}
      ${att && (att.late || att.no || att.miss || att.over || att.auto) ? rowBtn('data-more="time"', `<div class="txt"><b>This week's time sheet</b><div class="sub">${[att.late ? att.late + ' late' : '', att.no ? att.no + ' no-show' : '', att.over ? att.over + ' over shift' : '', att.auto ? att.auto + ' auto clock-out' : '', att.miss ? att.miss + ' missing clock-out' : ''].filter(Boolean).join(' · ')}</div></div><span>›</span>`) : ''}</div>`
        : ''
    }
    ${mine.length ? `<h2>Your requests</h2><div class="card">${mine.map(reqRow).join('')}</div>` : ''}`;
}
function clockState(s) {
  // managers: is this person clocked in for today's shift?
  const p =
    (data.punches || []).find((x) => x.shift === s.id) ||
    (data.punches || []).find((x) => x.name === s.name && x.date === s.date && !x.shift);
  const now = new Date(),
    start = mins(s.start),
    cur = now.getHours() * 60 + now.getMinutes();
  if (p && p.out) {
    const ob = overOf(s, p, now);
    return autoOut(p)
      ? '<span class="pill warn">Auto clocked out</span>'
      : `<span class="pill ${OVER() && ob > OVER() ? 'warn' : 'ok'}">Done ${timeOf(p.out)}${OVER() && ob > OVER() ? ' · over ' + overTxt(ob) : ''}</span>`;
  }
  if (p) {
    const lateBy = Math.round((new Date(p.in) - new Date(pd(s.date).getTime() + start * 6e4)) / 6e4),
      ob = overOf(s, p, now);
    if (OVER() && ob > OVER()) return `<span class="pill warn">Over ${overTxt(ob)}</span>`;
    return `<span class="pill ${lateBy > (data.lateAfter || 5) ? 'warn' : 'ok'}">In ${timeOf(p.in)}</span>`;
  }
  return cur > start + (data.lateAfter || 5) ? '<span class="pill warn">Not in</span>' : '';
}

/* ----- checklists ----- */
const PREP = '__prep',
  INV = '__inv';
/* ----- inventory (leads and managers): counts go straight into the Inventory & Reorder sheet ----- */
let inv = null,
  invTab = load('pt-invtab') || '',
  invQ = '',
  invQueue = {},
  invTimer = null,
  invBusy = false;
const invStatus = (x) =>
  x.onHand === '' || x.onHand == null
    ? 'Not counted'
    : x.onHand <= 0
      ? 'Out'
      : x.par === '' || x.par == null
        ? 'OK'
        : x.onHand < x.par
          ? 'Below par'
          : 'OK';
const invOrder = (x) => {
  if (x.onHand === '' || x.onHand == null || x.par === '' || x.par == null || !(x.onHand < x.par)) return 0;
  const c = Number(x.caseSize) || 1;
  return Math.ceil((x.par - x.onHand) / c) * c;
};
async function loadInv(force) {
  if (invBusy) return;
  invBusy = true;
  try {
    const r = await post({ fn: 'inventory', token: TOKEN });
    inv = r;
    inv.at = Date.now();
    if (!invTab || (invTab !== 'Reorder' && r.tabs.indexOf(invTab) < 0)) invTab = r.tabs[0];
  } catch (e) {
    toast(String(e.message || e));
  }
  invBusy = false;
  if (tab === 'inventory') render();
}
function queueCount(x, field, val) {
  x[field] = val === '' ? '' : Number(val);
  if (field === 'onHand') x.counted = val === '' ? '' : T();
  const k = x.tab + '|' + x.row;
  invQueue[k] = Object.assign(
    invQueue[k] || { tab: x.tab, row: x.row, item: x.item },
    { onHand: x.onHand },
    field === 'par' ? { par: val } : {},
    field === 'caseSize' ? { caseSize: val } : {}
  );
  clearTimeout(invTimer);
  invTimer = setTimeout(flushCounts, 1200);
}
async function flushCounts() {
  const counts = Object.values(invQueue);
  if (!counts.length) return;
  invQueue = {};
  try {
    await post({ fn: 'inventory', token: TOKEN, counts });
  } catch (e) {
    counts.forEach((c) => {
      invQueue[c.tab + '|' + c.row] = c;
    });
    toast('Counts not saved yet – ' + String(e.message || e));
    clearTimeout(invTimer);
    invTimer = setTimeout(flushCounts, 5000);
  }
}
let invFull = false,
  invTodo = false;
/** Inventory: a simple count screen for everyone; managers can switch to reorder and pars. */
function viewInventory() {
  if (!inv) {
    loadInv();
    return `<h1>Inventory</h1><div class="card"><div class="empty">Loading inventory…</div></div>`;
  }
  if (Date.now() - (inv.at || 0) > 120000 && !Object.keys(invQueue).length) loadInv(); // fresh numbers in the background
  if (!(mgr() && invFull)) return viewInvCount();
  return viewInvFull();
}
function viewInvCount() {
  if (invTab === 'Reorder' || inv.tabs.indexOf(invTab) < 0) invTab = inv.tabs[0];
  const q = invQ.trim().toLowerCase(),
    done = (x) => x.counted === T() && x.onHand !== '' && x.onHand != null;
  const area = inv.items.filter((x) => x.tab === invTab),
    areaDone = area.filter(done).length;
  let list = q ? inv.items.filter((x) => (x.item + ' ' + x.cat).toLowerCase().includes(q)) : area;
  if (invTodo && !q) list = list.filter((x) => !done(x));
  let lastCat = '';
  const rows = list
    .map((x) => {
      const k = esc(x.tab) + '|' + x.row,
        head = !q && x.cat !== lastCat ? `<div class="ic-sec">${esc(x.cat || 'Other')}</div>` : '';
      lastCat = x.cat;
      return `${head}<div class="icount ${done(x) ? 'done' : ''}"><div class="ic-name"><b>${esc(x.item)}</b><small>${esc(x.unit || '')}${q ? (x.unit ? ' · ' : '') + esc(x.tab) : ''}${done(x) ? ' · ✓ counted today' : ''}</small></div>
        <div class="ic-step"><button data-invstep="-1" data-invk="${k}" aria-label="One less">−</button><input class="cnt" data-invf="onHand" data-invk="${k}" inputmode="decimal" value="${x.onHand === '' || x.onHand == null ? '' : x.onHand}" placeholder="–" aria-label="${esc(x.item)} on hand"><button data-invstep="1" data-invk="${k}" aria-label="One more">+</button></div></div>`;
    })
    .join('');
  return `<div class="ic-head"><h1>Inventory</h1>${mgr() ? '<button class="btn sm" data-invfull>Reorder & pars ›</button>' : ''}</div>
    <p class="sub" style="margin-top:0">Count what's on the shelf. Each number saves as you go.</p>
    ${
      q
        ? ''
        : `<div class="seg">${inv.tabs
            .map((t) => {
              const a = inv.items.filter((x) => x.tab === t);
              return `<button data-invtab="${esc(t)}" aria-pressed="${t === invTab}">${esc(t)} ${a.filter(done).length}/${a.length}</button>`;
            })
            .join('')}</div>`
    }
    ${q ? '' : `<div class="ic-prog"><div class="progress"><i style="width:${area.length ? Math.round((areaDone / area.length) * 100) : 0}%"></i></div><span>${areaDone} of ${area.length} counted today</span><button class="btn sm" data-invtodo aria-pressed="${invTodo}">${invTodo ? 'Show all' : 'Only not counted'}</button></div>`}
    <input class="search" data-invsearch placeholder="Find an item" value="${esc(invQ)}" aria-label="Find an item">
    <div class="card ic-list">${rows || `<div class="empty">${invTodo ? 'Everything here is counted ✓' : 'No items.'}</div>`}</div>`;
}
function viewInvFull() {
  const items = inv.items,
    need = items.filter((x) => ['Out', 'Below par'].includes(invStatus(x))),
    out = items.filter((x) => invStatus(x) === 'Out'),
    notC = items.filter((x) => invStatus(x) === 'Not counted');
  const cost = need.reduce((n, x) => n + invOrder(x) * (x.cost || 0), 0);
  const tabs = inv.tabs.concat(['Reorder']);
  const q = invQ.trim().toLowerCase();
  const pill = (x) => {
    const st = invStatus(x);
    return `<span class="pill ${st === 'OK' ? 'ok' : st === 'Not counted' ? 'mute' : 'warn'}">${st}</span>`;
  };
  let body;
  if (invTab === 'Reorder') {
    const byV = {};
    need.forEach((x) => (byV[x.vendor || 'Other'] = byV[x.vendor || 'Other'] || []).push(x));
    body =
      Object.keys(byV)
        .sort()
        .map(
          (v) =>
            `<h2>${esc(v)}</h2><div class="card">${byV[v].map((x) => `<div class="row"><div class="txt"><b>${esc(x.item)}</b><div class="sub">${x.onHand === '' ? '–' : x.onHand} on hand · par ${x.par}${x.unit ? ' · ' + esc(x.unit) : ''}</div></div>${pill(x)}<div class="money"><b>${invOrder(x)}</b><div class="sub">${x.cost ? money(invOrder(x) * x.cost, true) : ''}</div></div></div>`).join('')}</div>`
        )
        .join('') || '<div class="card"><div class="empty">Nothing needs ordering.</div></div>';
  } else {
    const list = items.filter((x) =>
      q ? (x.item + ' ' + x.cat + ' ' + x.vendor).toLowerCase().includes(q) : x.tab === invTab
    );
    let lastCat = '';
    body = `<div class="card">${
      list
        .map((x) => {
          const head = !q && x.cat !== lastCat ? `<div class="sec">${esc(x.cat || 'Other')}</div>` : '';
          lastCat = x.cat;
          return (
            head +
            `<div class="row inv"><div class="txt"><b>${esc(x.item)}</b>${pill(x)}<div class="sub">${esc(x.unit || '')}${x.par !== '' ? ' · par ' + x.par : ''}${x.caseSize > 1 ? ' · case of ' + x.caseSize : ''}${x.counted ? ' · counted ' + (x.counted === T() ? 'today' : esc(x.counted)) : ''}${q ? ' · ' + esc(x.tab) : ''}</div>
        ${inv.canEditPar ? `<div class="invmeta"><label>Par <input data-invf="par" data-invk="${esc(x.tab)}|${x.row}" inputmode="decimal" value="${x.par}"></label><label>Case <input data-invf="caseSize" data-invk="${esc(x.tab)}|${x.row}" inputmode="decimal" value="${x.caseSize}"></label></div>` : ''}</div>
        <div class="stepper"><button class="mini" data-invstep="-1" data-invk="${esc(x.tab)}|${x.row}" aria-label="One less">–</button><input class="cnt" data-invf="onHand" data-invk="${esc(x.tab)}|${x.row}" inputmode="decimal" value="${x.onHand}" placeholder="–" aria-label="${esc(x.item)} on hand"><button class="mini" data-invstep="1" data-invk="${esc(x.tab)}|${x.row}" aria-label="One more">+</button></div></div>`
          );
        })
        .join('') || '<div class="empty">No items.</div>'
    }</div>`;
  }
  return `<div class="ic-head"><h1>Inventory</h1><button class="btn sm" data-invfull>‹ Simple count</button></div>
    <div class="card"><div class="row"><div class="txt"><b>${need.length} to order</b><div class="sub">${out.length} out · ${notC.length} not counted · about ${money(cost)} at known costs</div></div><a class="btn sm" href="${esc(inv.url)}" target="_blank" rel="noopener">Open sheet ↗</a></div></div>
    <input class="search" data-invsearch placeholder="Search all items" value="${esc(invQ)}" aria-label="Search inventory">
    ${q ? '' : `<div class="seg">${tabs.map((t) => `<button data-invtab="${esc(t)}" aria-pressed="${t === invTab}">${esc(t)}${t === 'Reorder' && need.length ? ' ' + need.length : ''}</button>`).join('')}</div>`}
    ${body}
    <p class="sub">Counts save to the Inventory & Reorder sheet as you type, with today's date. Blank = not counted.${inv.canEditPar ? ' Par and case size are editable by managers.' : ''}</p>`;
}
const prepOpen = () => (data.prep || []).filter((x) => !x.doneAt);
const prepMine = () => prepOpen().filter((x) => x.mine);
/* Prep pop-up: on the day of their shift, the people it was sent to see it pop up when they open the app – once per item. */
const prepSeen = () => {
  try {
    return JSON.parse(load('pt-prepseen') || '[]');
  } catch (_) {
    return [];
  }
};
const prepPopItems = () =>
  prepMine().filter((x) => x.date && x.date <= T() && prepSeen().indexOf(x.id) < 0 && !/^tmp/.test(x.id));
function prepSeenAll() {
  const ids = prepSeen().concat(prepMine().map((x) => x.id));
  save('pt-prepseen', JSON.stringify([...new Set(ids)].slice(-200)));
}
function prepPopSheet() {
  const items = prepMine().filter((x) => x.date && x.date <= T());
  return `<div class="sheet" role="dialog" aria-label="Prep for your shift"><div class="sheet-in"><h1 style="margin:0 0 4px">🧾 Prep for your shift</h1>
    <p class="sub" style="margin:0 0 10px">${items.length ? 'Asked for your shift today:' : 'All done – thank you!'}</p>
    ${
      items.length
        ? `<div class="card">${items
            .map(
              (
                x
              ) => `<div class="row"><button class="chk" data-prepdone="${esc(x.id)}" data-on="0" aria-label="Done: ${esc(x.item)}"></button>
      <div class="txt"><b>${esc(x.item)}</b>${x.details ? `<div class="sub">${esc(x.details)}</div>` : ''}<div class="sub">From ${esc(first(x.by))} · ${esc(x.label || 'your shift')}</div></div></div>`
            )
            .join('')}</div>`
        : ''
    }
    <div class="btns" style="margin-top:12px"><button class="btn go" data-prepok>Got it</button><button class="btn" data-prepok data-golist="${PREP}">Open the prep list</button></div></div></div>`;
}
function listSeg(cl) {
  const n = prepOpen().length;
  return `<div class="seg">${cl.map((x) => `<button data-list="${esc(x.list)}" aria-pressed="${x.list === listTab}">${esc(x.list)} ${x.done}/${x.total}</button>`).join('')}<button data-list="${PREP}" aria-pressed="${listTab === PREP}">Prep${n ? ' ' + n : ''}</button></div>`;
}
function prepRow(x) {
  const on = !!x.doneAt,
    canDel = x.by === data.me.name || lead();
  return `<div class="row ${on ? 'done' : ''}"><button class="chk ${on ? 'on' : ''}" data-prepdone="${esc(x.id)}" data-on="${on ? 1 : 0}" aria-label="${on ? 'Undo' : 'Done'}: ${esc(x.item)}">${on ? '✓' : ''}</button>
    <div class="txt">${((r) => (r ? `<button class="prep-rec" data-recipe="${esc(r.id)}"><b>${esc(x.item)}</b> <span class="pill">Recipe ›</span></button>` : `<b>${esc(x.item)}</b>`))(recipeFor(x.item, x.recipe))}${x.mine && !on ? ' <span class="pill warn">Your shift</span>' : ''}${x.details ? `<div class="sub">${esc(x.details)}</div>` : ''}
      <div class="sub">For ${esc(x.label || 'next shift')}${x.for.length ? ' · ' + x.for.map((n) => esc(first(n))).join(', ') : ''} · from ${esc(first(x.by))} ${ago(x.at)}</div>
      ${on ? `<div class="sub">Done by ${esc(first(x.doneBy))} · ${timeOf(x.doneAt)}</div>` : ''}</div>
    ${canDel ? `<button class="btn sm" data-prepdel="${esc(x.id)}" aria-label="Remove">✕</button>` : ''}</div>`;
}
/** Quick picks when adding prep: prep recipes (linked) and the other options from Settings (not linked). */
function prepChoices() {
  const recs = RECIPES().filter((r) => r.type === 'Prep' && !r.hidden),
    other = data.prepOptions || [];
  if (!recs.length && !other.length) return '';
  const chip = (t, rec) =>
    `<button type="button" class="pchip ${rec ? 'rec' : ''}" data-prepfill="${esc(t)}">${esc(t)}</button>`;
  return `<datalist id="prep-choices">${recs
    .map((r) => r.name)
    .concat(other)
    .map((t) => `<option value="${esc(t)}">`)
    .join('')}</datalist>
    ${recs.length ? `<div class="pchips"><span class="sub">Recipes</span>${recs.map((r) => chip(r.name, true)).join('')}</div>` : ''}
    ${other.length ? `<div class="pchips"><span class="sub">Other</span>${other.map((t) => chip(t, false)).join('')}</div>` : ''}`;
}
function viewPrep(cl) {
  const items = data.prep || [],
    open = items.filter((x) => !x.doneAt),
    done = items.filter((x) => x.doneAt);
  const opts = ['<option value="next">Next shift (whoever comes in next)</option>'].concat(
    [0, 1, 2].flatMap((k) => {
      const d = plus(T(), k);
      return (data.presets || []).map(
        (p) =>
          `<option value="${d}|${esc(p.name)}">${k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : shortDay(d)} · ${esc(p.name)} (${t12(p.start)})</option>`
      );
    })
  );
  return `<h1>Checklists</h1>${listSeg(cl)}
    <div class="card"><form class="stack" data-form="prep">
      <label class="f">What needs prepping<input name="item" maxlength="120" placeholder="Pick below or type something new" autocomplete="off" list="prep-choices"></label>
      ${prepChoices()}
      <label class="f">Details (optional)<input name="details" maxlength="300" placeholder="e.g. 2 gallons, we're out of concentrate"></label>
      <label class="f">For<select name="when">${opts.join('')}</select></label>
      <label class="opt"><input type="checkbox" name="notify" checked> Also send them a notification</label>
      <button class="btn go">Send to the shift</button></form></div>
    <h2>To prep</h2><div class="card">${open.map(prepRow).join('') || '<div class="empty">Nothing to prep.</div>'}</div>
    ${done.length ? `<h2>Done recently</h2><div class="card">${done.map(prepRow).join('')}</div>` : ''}
    <p class="sub">The people on that shift get a pop-up when they open the app on that day, and see it on their Today screen until it's done. No email is sent.</p>`;
}
function viewLists() {
  const cl = data.checklists || [];
  if (listTab === PREP) return viewPrep(cl);
  if (listTab === INV) listTab = ''; // inventory has its own tab now
  if (!cl.length)
    return (
      '<h1>Checklists</h1>' +
      listSeg(cl) +
      '<div class="card"><div class="empty">Nothing on the checklists today.</div></div>'
    );
  if (!cl.some((c) => c.list === listTab)) listTab = (cl.find((c) => c.done < c.total) || cl[0]).list;
  const c = cl.find((x) => x.list === listTab);
  const hist =
    lead() && data.history && data.history.length
      ? `<h2>Last 7 days</h2><div class="card">${data.history
          .map((h) => {
            const miss = h.lists.reduce((n, l) => n + (l.total - l.done), 0);
            return `<div class="row"><div class="txt"><b>${dayName(h.date)}</b><div class="sub">${h.lists.map((l) => esc(l.list) + ' ' + l.done + '/' + l.total).join(' · ')}</div>${
              miss
                ? `<details class="more"><summary>${miss} missed</summary><div class="sub">${h.lists
                    .filter((l) => l.missed.length)
                    .map((l) => '<b>' + esc(l.list) + ':</b> ' + l.missed.map(esc).join(', '))
                    .join('<br>')}</div></details>`
                : ''
            }</div><span class="pill ${miss ? 'warn' : 'ok'}">${miss ? 'Missed ' + miss : 'All done'}</span></div>`;
          })
          .join('')}</div>`
      : '';
  return `<h1>Checklists</h1>${listSeg(cl)}
    <div class="card">${c.items
      .map((i, n) => {
        const k = 'c|' + c.list + '|' + i.task,
          on = busy[k] !== undefined ? busy[k] : !!i.by;
        const head =
          i.section && (n === 0 || c.items[n - 1].section !== i.section)
            ? `<div class="sec">${esc(i.section)}</div>`
            : '';
        return (
          head +
          `<div class="row ${on ? 'done' : ''}">${
            !on && isDialTask(i.task)
              ? `<button class="chk" data-dialtask="${esc(c.list)}" aria-label="Log the dial-in: ${esc(i.task)}"></button>`
              : `<button class="chk ${on ? 'on' : ''}" data-check="${esc(i.task)}" data-on="${on ? 1 : 0}" aria-label="${on ? 'Undo' : 'Done'}: ${esc(i.task)}">${on ? '✓' : ''}</button>`
          }
        <div class="txt">${
          !on && isDialTask(i.task)
            ? `<button class="linkbtn" data-dialtask="${esc(c.list)}" style="text-align:left"><b>${esc(i.task)}</b> <span class="pill">Log it ›</span></button>`
            : ((r) => (r ? `<button class="prep-rec" data-recipe="${esc(r.id)}"><b>${esc(i.task)}</b> <span class="pill">Recipe ›</span></button>` : `<b>${esc(i.task)}</b>`))(recipeForTask(i.task))
        }${i.notes ? `<div class="sub">${esc(i.notes)}</div>` : ''}${i.by ? `<div class="sub">${esc(i.by)} · ${timeOf(i.at)}</div>` : ''}</div></div>`
        );
      })
      .join('')}</div>${hist}`;
}

/* ----- schedule ----- */
let schedView = load('pt-sview') || 'build';
/** What the team actually sees of a shift (leads and managers get drafts too). */
function pubView(s) {
  if (s.status === 'draft') return null;
  if (s.status === 'changed' && s.was) return Object.assign({}, s, s.was, { status: '' });
  return s;
}
let myCal = load('pt-mycal') === '1',
  calMonth = '',
  calDay = '';
function viewMyShifts() {
  const seg = `<div class="seg" style="max-width:320px;margin:0 0 12px"><button data-mycal="0" aria-pressed="${!myCal}">List</button><button data-mycal="1" aria-pressed="${myCal}">Calendar</button></div>`;
  return seg + (myCal ? viewMyCalendar() : viewMyList());
}
/* A month calendar of your own shifts: each day shows your shift times (and approved time off); tap a day for who you're working with. */
function viewMyCalendar() {
  const vis = (data.shifts || []).map(pubView).filter(Boolean),
    mineAll = vis.filter((s) => s.name === data.me.name),
    today = T();
  if (!calMonth) calMonth = today.slice(0, 7) + '-01';
  const m0 = calMonth,
    y = +m0.slice(0, 4),
    mo = +m0.slice(5, 7),
    days = new Date(y, mo, 0).getDate(),
    lead0 = (new Date(y, mo - 1, 1).getDay() + 6) % 7;
  const lo = today.slice(0, 7) + '-01';
  const minM = plus(lo, -40).slice(0, 7) + '-01',
    maxM = plus(lo, 70).slice(0, 7) + '-01';
  const short = (t) => {
    const [h, m] = t.split(':').map(Number),
      ap = h < 12 ? 'a' : 'p',
      hh = h % 12 || 12;
    return hh + (m ? ':' + pad(m) : '') + ap;
  };
  let cells = '';
  for (let i = 0; i < lead0; i++) cells += '<div class="cal-d pad"></div>';
  for (let d = 1; d <= days; d++) {
    const ds = m0.slice(0, 8) + pad(d),
      sh = mineAll.filter((s) => s.date === ds).sort((a, b) => mins(a.start) - mins(b.start)),
      off = approvedOff(data.me.name, ds);
    cells += `<button class="cal-d ${ds === today ? 'today' : ''} ${ds < today ? 'past' : ''} ${sh.length ? 'has' : ''} ${ds === calDay ? 'sel' : ''}" data-calday="${ds}" aria-label="${esc(dayName(ds) + ', ' + shortDay(ds) + (sh.length ? ': ' + sh.map((s) => t12(s.start) + ' to ' + t12(s.end)).join(', ') : off ? ': time off' : ': no shift'))}">
      <span class="cal-n">${d}</span>${sh.map((s) => `<span class="cal-s">${short(s.start)}<span class="cal-e">–${short(s.end)}</span></span>`).join('')}${off && !sh.length ? '<span class="cal-off">Off</span>' : ''}</button>`;
  }
  const monthHrs = mineAll
    .filter((s) => s.date.slice(0, 7) === m0.slice(0, 7))
    .reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
  const sel = calDay && calDay.slice(0, 7) === m0.slice(0, 7) ? calDay : '';
  const selShifts = sel ? mineAll.filter((s) => s.date === sel) : [];
  const crew = (s) =>
    vis.filter(
      (o) =>
        o !== s && o.name !== s.name && o.date === s.date && mins(o.start) < mins(s.end) && mins(o.end) > mins(s.start)
    );
  const detail = sel
    ? `<div class="card"><div class="row" style="display:block"><b style="font:400 1.05rem/1.2 var(--head);letter-spacing:.06em;text-transform:uppercase">${dayName(sel)}</b> <span class="sub">${shortDay(sel)}</span>
      ${
        selShifts.length
          ? selShifts
              .map((s) => {
                const c = crew(s);
                return `<div class="big2" style="margin-top:6px">${t12(s.start)} – ${t12(s.end)} <span class="sub">${hrs(mins(s.end) - mins(s.start))}${s.position ? ' · ' + esc(s.position) : ''}</span></div>${s.notes ? `<div class="sub">${esc(s.notes)}</div>` : ''}
        <div class="crew">${c.length ? '<span class="sub">Working with</span> ' + c.map((o) => `<span class="pill mute">${esc(first(o.name))} ${t12(o.start)}–${t12(o.end)}</span>`).join(' ') : '<span class="sub">No one else on yet</span>'}</div>`;
              })
              .join('')
          : `<div class="sub" style="margin-top:6px">${approvedOff(data.me.name, sel) ? 'Time off.' : 'No shift.'}</div>`
      }</div></div>`
    : '<p class="sub" style="margin:4px">Tap a day to see who you\'re working with.</p>';
  return `<div class="mywrap"><div class="weeknav"><button class="btn sm" data-calstep="-1" ${m0 <= minM ? 'disabled' : ''} aria-label="Earlier month">‹</button><div><b>${new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b><div class="sub">${monthHrs ? hrs(monthHrs) + ' scheduled' : 'Nothing scheduled yet'}</div></div><button class="btn sm" data-calstep="1" ${m0 >= maxM ? 'disabled' : ''} aria-label="Later month">›</button></div>
    <div class="cal"><div class="cal-h">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<span>${x}</span>`).join('')}</div><div class="cal-g">${cells}</div></div>
    ${detail}
    <p class="sub" style="margin:8px 4px">Shows your published shifts and approved time off.</p>
    <div class="btns" style="margin-top:14px"><button class="btn" data-more="requests">Requests</button><button class="btn" data-more="avail">My availability</button><button class="btn" data-more="reminders">Reminders & calendar</button></div></div>`;
}
function viewMyList() {
  const vis = (data.shifts || []).map(pubView).filter(Boolean),
    now = new Date();
  const mine = vis.filter(
    (s) =>
      s.name === data.me.name &&
      (s.date > T() || (s.date === T() && mins(s.end) > now.getHours() * 60 + now.getMinutes()))
  );
  const past = vis.filter((s) => s.name === data.me.name && s.date < T() && s.date >= plus(T(), -7));
  const crew = (s) =>
    vis.filter(
      (o) =>
        o !== s && o.name !== s.name && o.date === s.date && mins(o.start) < mins(s.end) && mins(o.end) > mins(s.start)
    );
  const card = (s) => {
    const c = crew(s);
    return `<div class="card shiftcard ${s.date === T() ? 'today' : ''}"><div class="row" style="display:block">
      <div style="display:flex;align-items:baseline;gap:8px"><b style="flex:1;font:400 1.05rem/1.2 var(--head);letter-spacing:.06em;text-transform:uppercase">${dayName(s.date)}</b><span class="sub">${shortDay(s.date)}</span></div>
      <div class="big2">${t12(s.start)} – ${t12(s.end)} <span class="sub">${hrs(mins(s.end) - mins(s.start))}${s.position ? ' · ' + esc(s.position) : ''}</span></div>
      ${s.notes ? `<div class="sub">${esc(s.notes)}</div>` : ''}
      <div class="crew">${c.length ? '<span class="sub">Working with</span> ' + c.map((o) => `<span class="pill mute">${esc(first(o.name))} ${t12(o.start)}–${t12(o.end)}</span>`).join(' ') : '<span class="sub">No one else on yet</span>'}</div></div></div>`;
  };
  const wk = mine.filter((s) => s.date <= plus(monday(T()), 6)).reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
  return `<div class="mywrap">${mine.length ? `<p class="sub" style="margin:0 4px 10px">${mine.length} upcoming shift${mine.length > 1 ? 's' : ''}${wk ? ' · ' + hrs(wk) + ' left this week' : ''}</p>${mine.map(card).join('')}` : '<div class="card"><div class="empty">No upcoming shifts on the published schedule.</div></div>'}
    ${past.length ? `<details class="more" style="margin:12px 4px"><summary>Last 7 days</summary>${past.map(card).join('')}</details>` : ''}
    <div class="btns" style="margin-top:14px"><button class="btn" data-more="requests">Requests</button><button class="btn" data-more="avail">My availability</button><button class="btn" data-more="reminders">Reminders & calendar</button></div></div>`;
}
function weekBounds() {
  return [monday(plus(T(), -21)), monday(plus(T(), lead() ? 49 : 7))];
}
function viewSchedule() {
  if (shop()) return viewShopSchedule();
  const seg = lead()
    ? `<div class="seg" style="max-width:420px;margin-left:0"><button data-sview="build" aria-pressed="${schedView !== 'mine'}">Build schedule</button><button data-sview="mine" aria-pressed="${schedView === 'mine'}">My shifts</button></div>`
    : '';
  if (!lead() || schedView === 'mine') {
    document.body.classList.remove('wide');
    return `<h1>${lead() ? 'Schedule' : 'My shifts'}</h1>${seg}${viewMyShifts()}`;
  }
  return viewScheduleBuild(seg);
}
function viewScheduleBuild(seg) {
  const [lo, hi] = weekBounds();
  if (!week || week < lo || week > hi) week = monday(T());
  needFrom(week); // paging back past what's loaded fetches that week (shifts appear when it arrives)
  if (wide()) return viewScheduleGrid(seg);
  const days = Array.from({ length: 7 }, (_, i) => plus(week, i));
  const label =
    week === monday(T())
      ? 'This week'
      : week === plus(monday(T()), 7)
        ? 'Next week'
        : week === plus(monday(T()), -7)
          ? 'Last week'
          : 'Week of ' + shortDay(week);
  const nav = `<div class="weeknav"><button class="btn sm" data-week="-7" ${week <= lo ? 'disabled' : ''} aria-label="Previous week">‹</button><div><b>${label}</b><div class="sub">${shortDay(days[0])} – ${shortDay(days[6])}</div></div><button class="btn sm" data-week="7" ${week >= hi ? 'disabled' : ''} aria-label="Next week">›</button></div>`;
  const mineOnly = schedMine && !mgr();
  const dayCard = (d) => {
    const list = shiftsOn(d).filter((s) => !mineOnly || s.name === data.me.name);
    const offs = lead()
      ? (data.requests || []).filter((q) => offOn(q, d) && q.status === 'Approved').map((q) => first(q.from))
      : [];
    return `<h2 ${d === T() ? 'id="todayh" class="today-h"' : ''}>${dayName(d)}${d !== T() && d !== plus(T(), 1) ? '' : ' · ' + shortDay(d)}</h2><div class="card">
      ${
        list
          .map((s) => {
            const cf = lead() ? conflicts(s) : [];
            const inner = `<div class="txt ${s.status === 'removed' ? 'gone' : ''}"><b>${esc(s.name)}</b>${levelPill(s.name)} ${statusPill(s)}<div class="sub">${t12(s.start)}–${t12(s.end)} · ${hrs(mins(s.end) - mins(s.start))}${s.position ? ' · ' + esc(s.position) : ''}${s.notes ? ' · ' + esc(s.notes) : ''}</div>${cf.length ? `<div style="margin-top:4px">${cf.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>${mgr() ? '<span class="sub">Edit</span>' : ''}`;
            return lead()
              ? rowBtn(`data-editshift="${esc(s.id)}" class="${s.name === data.me.name ? 'mine' : ''}"`, inner)
              : `<div class="row ${s.name === data.me.name ? 'mine' : ''}">${inner}</div>`;
          })
          .join('') || '<div class="empty" style="padding:14px">No shifts.</div>'
      }
      ${offs.length ? `<div class="row"><div class="txt sub">Off: ${offs.map(esc).join(', ')}</div></div>` : ''}
      ${lead() ? rowBtn(`data-addshift="${d}"`, '<div class="txt accent"><b>+ Add shift</b></div>') : ''}</div>`;
  };
  const totals = mgr()
    ? (() => {
        const t = {};
        days.forEach((d) =>
          shiftsOn(d)
            .filter(notGone)
            .forEach((s) => {
              t[s.name] = (t[s.name] || 0) + mins(s.end) - mins(s.start);
            })
        );
        const L = labor(shiftItems(weekShifts(week)));
        const names = Object.keys(t).sort();
        return names.length
          ? `<h2>Hours & estimated wages</h2><div class="card">${names.map((n) => `<div class="row"><div class="txt">${esc(n)}${L.ot[n] ? ` <span class="pill warn">OT ${hrs(L.ot[n] * 60)}</span>` : ''}</div><b>${hrs(t[n])}</b><span class="money">${wageOf(n) ? money(L.byPerson[n] || 0) : '<span class="sub">no wage</span>'}</span></div>`).join('')}
      <div class="row"><div class="txt"><b>Total</b></div><b>${hrs(Object.values(t).reduce((a, b) => a + b, 0))}</b><span class="money"><b>${money(L.total)}</b></span></div></div>`
          : '';
      })()
    : '';
  const pend = weekPending(week).length;
  const pubBtn = lead()
    ? pend
      ? `<button class="btn sm go" data-publish>Publish week (${pend})</button>`
      : '<span class="pill ok">Published</span>'
    : '';
  const tools = lead()
    ? `<div class="btns" style="margin:10px 0 4px">${pubBtn}${lead() ? '<button class="btn sm" data-copyweek>Copy last week here</button><button class="btn sm" data-clearweek>Clear this week</button>' : ''}</div>`
    : '';
  return `<h1>Schedule</h1>${seg || ''}${nav}${lead() && pend ? '<p class="sub" style="margin:0 4px 6px">Drafts and changes stay hidden from the team until you publish.</p>' : ''}${mgr() ? '' : `<div class="seg"><button data-mine="0" aria-pressed="${!schedMine}">Everyone</button><button data-mine="1" aria-pressed="${schedMine}">My shifts</button></div>`}
    ${tools}${days.map(dayCard).join('')}${totals}
    <div class="btns" style="margin-top:14px"><button class="btn" data-more="requests">Requests</button><button class="btn" data-more="avail">My availability</button></div>`;
}

/** Desktop: the whole week as a grid, people down the side. Click a cell to add, click a shift to edit, drag to move (hold Alt/Option to copy). */
function viewScheduleGrid(seg) {
  const [lo, hi] = weekBounds(),
    days = Array.from({ length: 7 }, (_, i) => plus(week, i)),
    M = mgr(),
    E = lead();
  const label =
    week === monday(T())
      ? 'This week'
      : week === plus(monday(T()), 7)
        ? 'Next week'
        : week === plus(monday(T()), -7)
          ? 'Last week'
          : 'Week of ' + shortDay(week);
  const inWeek = (data.shifts || []).filter((s) => days.includes(s.date)),
    inWeekLive = inWeek.filter(notGone);
  const everyone = lineup(),
    hasShift = (n) => inWeek.some((s) => s.name === n && notGone(s));
  // Hidden people drop off the grid – unless they still have a shift this week, so nothing goes missing.
  const roster = everyone
    .filter((p) => shown(p) || hasShift(p.name))
    .map((p) => ({ id: p.id, name: p.name, role: p.role, wage: p.wage, hidden: !shown(p) }));
  const hiddenOut = everyone.filter((p) => !shown(p) && !hasShift(p.name));
  inWeek.forEach((s) => {
    if (!roster.some((p) => p.name === s.name)) roster.push({ name: s.name, role: 'Former' });
  });
  const dayMins = (d) => inWeekLive.filter((s) => s.date === d).reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
  const L = M ? labor(shiftItems(inWeekLive)) : null;
  const cell = (p, d) => {
    const list = inWeek.filter((s) => s.name === p.name && s.date === d);
    const off = approvedOff(p.name, d),
      ask = pendingOff(p.name, d),
      un = unavail(p.name, d);
    const note = off
      ? '<div class="cnote warn">Time off</div>'
      : ask
        ? '<div class="cnote">Asked off</div>'
        : un
          ? `<div class="cnote">${un.from ? "Can't " + t12(un.from) + '–' + t12(un.to) : 'Unavailable'}</div>`
          : '';
    const chips = list
      .map((s) => {
        const cf = E ? conflicts(s) : [];
        const tip = cf
          .map((c) => c[1])
          .concat(
            s.status === 'changed' && s.was
              ? [
                  'Team still sees ' +
                    (s.was.name !== s.name ? s.was.name + ' ' : '') +
                    t12(s.was.start) +
                    '–' +
                    t12(s.was.end) +
                    (s.was.date !== s.date ? ' on ' + shortDay(s.was.date) : ''),
                ]
              : []
          )
          .join(' · ');
        return `<button class="chip ${cf.some((c) => c[0] === 'warn') ? 'bad' : ''} ${s.name === data.me.name ? 'me' : ''} st-${s.status || 'published'}" ${E ? `data-editshift="${esc(s.id)}" ${s.status === 'removed' ? '' : `draggable="true" data-drag="${esc(s.id)}"`}` : 'tabindex="-1"'} title="${esc(tip)}">
        ${STATUS[s.status] ? `<i class="tag">${STATUS[s.status][1]}</i>` : ''}<b>${t12s(s.start)}–${t12s(s.end)}</b>${s.position ? `<span>${esc(s.position)}</span>` : ''}${s.notes ? `<span class="n2">${esc(s.notes)}</span>` : ''}</button>`;
      })
      .join('');
    return `<td class="${d === T() ? 'today' : ''} ${off ? 'off' : un && !un.from ? 'un' : ''}" ${E ? `data-cell="${esc(p.name)}|${d}"` : ''}>${note}${chips}${E ? `<button class="addc" data-addshift="${d}" data-who="${esc(p.name)}" aria-label="Add a shift for ${esc(p.name)} on ${shortDay(d)}">+</button>` : ''}</td>`;
  };
  const rows = roster
    .map((p) => {
      const m = inWeek.filter((s) => s.name === p.name).reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
      const m2 = inWeekLive.filter((s) => s.name === p.name).reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
      const wageIn =
        M && p.id
          ? `<label class="wagef"><span>$</span><input class="wage" inputmode="decimal" data-wage="${esc(p.id)}" value="${p.wage ? Number(p.wage).toFixed(2) : ''}" placeholder="wage" aria-label="${esc(p.name)} hourly wage"><span>/h</span></label>`
          : '';
      const handle =
        M && p.id
          ? `<span class="handle" data-rowdrag title="Drag to reorder" aria-label="Drag to reorder ${esc(p.name)}">⠿</span>`
          : '';
      const hideBtn =
        M && p.id
          ? `<button class="mini" data-onsched="${esc(p.id)}" data-to="${p.hidden ? 1 : 0}" title="${p.hidden ? 'Show on the schedule' : 'Hide from the schedule'}">${p.hidden ? 'Show' : 'Hide'}</button>`
          : '';
      return `<tr class="${p.name === data.me.name ? 'mine-row' : ''} ${p.hidden ? 'hid' : ''}" ${p.id ? `data-rid="${esc(p.id)}"` : ''}><th scope="row"><div class="who">${handle}<div><b>${esc(p.name)}</b>${levelPill(p.name)}<span class="sub">${esc(p.role || '')}${p.hidden ? ' · hidden' : ''}</span></div>${wageIn}${hideBtn}</div></th>${days.map((d) => cell(p, d)).join('')}<td class="tot">${m2 ? hrs(m2) : ''}${M && m2 ? `<div class="money">${p.wage ? money(L.byPerson[p.name] || 0) : '<span class="sub">no wage</span>'}</div>${L.ot[p.name] ? `<span class="pill warn">OT ${hrs(L.ot[p.name] * 60)}</span>` : ''}` : ''}</td></tr>`;
    })
    .join('');
  const total = inWeekLive.reduce((n, s) => n + mins(s.end) - mins(s.start), 0);
  return `${seg || ''}<div class="gridhead"><h1 style="margin:0">Schedule</h1>
      <div class="weeknav" style="margin:0"><button class="btn sm" data-week="-7" ${week <= lo ? 'disabled' : ''} aria-label="Previous week">‹</button><div style="min-width:170px"><b>${label}</b><div class="sub">${shortDay(days[0])} – ${shortDay(days[6])}</div></div><button class="btn sm" data-week="7" ${week >= hi ? 'disabled' : ''} aria-label="Next week">›</button>${week !== monday(T()) ? '<button class="btn sm" data-thisweek>Today</button>' : ''}</div>
      ${M ? `<div class="labor"><span class="sub">Est. wages</span><b>${money(L.total)}</b><span class="sub">${hrs(total)}${data.pay && data.pay.extra ? ' · incl. ' + data.pay.extra + '% extra' : ''}</span></div>` : ''}
      <div class="btns">${E ? '<button class="btn sm" data-copyweek>Copy last week</button><button class="btn sm" data-clearweek>Clear week</button>' : ''}${lead() ? (weekPending(week).length ? `<button class="btn sm go" data-publish>Publish week (${weekPending(week).length})</button>` : '<span class="pill ok">Published</span>') : ''}<button class="btn sm" data-print>Print</button></div></div>
    <div class="gridwrap"><table class="grid"><thead><tr><th class="corner">${E ? '<span class="sub">Click a box to add. Drag to move, Alt-drag to copy.</span>' : ''}</th>${days.map((d) => `<th class="${d === T() ? 'today' : ''}"><b>${DOW[pd(d).getDay()]}</b> ${pd(d).getDate()}<span class="sub">${hrs(dayMins(d))}</span></th>`).join('')}<th class="tot">Hours</th></tr></thead>
      <tbody data-reorder>${rows || `<tr><td colspan="9" class="empty">No one on the team yet.</td></tr>`}</tbody>
      <tfoot><tr><th scope="row">Total${M ? '<span class="sub">Estimated wages</span>' : ''}</th>${days.map((d) => `<td class="tot">${inWeekLive.filter((s) => s.date === d).length} shift${inWeekLive.filter((s) => s.date === d).length === 1 ? '' : 's'}${M ? `<div class="money">${money(L.byDay[d] || 0)}</div>` : ''}</td>`).join('')}<td class="tot"><b>${hrs(total)}</b>${M ? `<div class="money"><b>${money(L.total)}</b></div>` : ''}</td></tr></tfoot></table></div>
    ${M && hiddenOut.length ? `<p class="sub">Hidden from the schedule: ${hiddenOut.map((p) => `${esc(p.name)} <button class="mini" data-onsched="${esc(p.id)}" data-to="1">Show</button>`).join(' · ')}</p>` : ''}
    ${M && L.missing.length ? `<p class="sub warn-t">No wage set for ${L.missing.map((n) => esc(first(n))).join(', ')} – type it next to their name to include them.</p>` : ''}
    <p class="sub">Red outline = a problem (time off, unavailable or double-booked) – hover to see it. ${M && data.reminders && data.reminders.on ? 'People with an email get reminders before their shifts, and an email when a shift in the next 7 days changes.' : ''}</p>`;
}
function publishSheet() {
  const list = weekPending(week),
    c = (k) => list.filter((s) => s.status === k).length,
    people = [...new Set(list.map((s) => s.name).concat(list.filter((s) => s.was).map((s) => s.was.name)))];
  return `<div class="sheet" role="dialog" aria-label="Publish"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">Publish the week</h1><button class="btn sm" data-closesheet>Close</button></div>
    <p class="sub">${shortDay(week)} – ${shortDay(plus(week, 6))}</p>
    <div class="card">${[
      ['draft', 'new shifts'],
      ['changed', 'changed shifts'],
      ['removed', 'shifts to remove'],
    ]
      .filter(([k]) => c(k))
      .map(([k, n]) => `<div class="row"><div class="txt">${n}</div><b>${c(k)}</b></div>`)
      .join('')}
      <div class="row"><div class="txt sub">Affects ${people.map((n) => esc(first(n))).join(', ')}</div></div></div>
    <form class="stack" data-form="publish" style="padding:0"><label class="opt"><input type="checkbox" name="notify"> Notify the team – email and notify the people affected, and post in Schedule & swaps</label><p class="sub" style="margin:0">Leave it off to publish quietly – the team still sees the new schedule in the app.</p>
      <button class="btn go">Publish</button></form></div></div>`;
}
function shiftSheet() {
  const s = sheet,
    d = s.date,
    lu = lineup(),
    team = lu.filter(shown).map((u) => u.name),
    hiddenTeam = lu.filter((u) => !shown(u)).map((u) => u.name);
  const status = (n) => {
    if (approvedOff(n, d)) return ' – time off';
    const u = unavail(n, d);
    if (u) return u.from ? ' – unavailable ' + t12(u.from) + '–' + t12(u.to) : ' – unavailable';
    if (pendingOff(n, d)) return ' – asked for off';
    const b = shiftsOn(d).filter((x) => notGone(x) && x.name === n && x.id !== s.id);
    return b.length ? ' – already ' + b.map((x) => t12(x.start) + '–' + t12(x.end)).join(', ') : '';
  };
  return `<div class="sheet" role="dialog" aria-label="Shift"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${s.id ? 'Edit shift' : 'New shift'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <p class="sub">${/^(Today|Tomorrow|Yesterday)$/.test(dayName(d)) ? dayName(d) + ' · ' + shortDay(d) : dayName(d)}</p>
    <form class="stack" data-form="shift" style="padding:0">
      <label class="f">Who<select name="name" required>${s.name ? '' : '<option value="">Pick someone…</option>'}${team.map((n) => `<option value="${esc(n)}" ${n === s.name ? 'selected' : ''}>${esc(n)}${esc(status(n))}</option>`).join('')}${hiddenTeam.length ? `<optgroup label="Hidden from the schedule">${hiddenTeam.map((n) => `<option value="${esc(n)}" ${n === s.name ? 'selected' : ''}>${esc(n)}${esc(status(n))}</option>`).join('')}</optgroup>` : ''}</select></label>
      ${(data.presets || []).length ? `<div class="btns">${data.presets.map((p) => `<button type="button" class="btn sm" data-preset="${p.start}|${p.end}">${esc(p.name)} ${t12(p.start)}–${t12(p.end)}</button>`).join('')}</div>` : ''}
      <div class="two"><label class="f">Start<input name="start" type="time" value="${esc(s.start || '07:00')}"></label><label class="f">End<input name="end" type="time" value="${esc(s.end || '13:00')}"></label></div>
      <label class="f">Position<select name="position"><option value=""></option>${(data.positions || []).map((p) => `<option ${p === s.position ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="f">Notes<input name="notes" maxlength="200" value="${esc(s.notes || '')}"></label>
      <label class="f">Date<input name="date" type="date" value="${esc(d)}"></label>
      <div class="est" id="est" aria-live="polite"></div>
      <p class="sub" style="margin:0">${!s.id || s.status === 'draft' ? 'Draft – the team sees it after you publish the week.' : s.status === 'changed' && s.was ? 'Not published – the team still sees ' + esc(s.was.name) + ' ' + t12(s.was.start) + '–' + t12(s.was.end) + ' on ' + shortDay(s.was.date) + '.' : s.status === 'removed' ? 'This shift will be removed when you publish. The team still sees it until then.' : 'Published. Changes stay hidden from the team until you publish again.'}</p>
      <div class="btns">${s.status === 'removed' ? `<button type="button" class="btn go" data-restore="${esc(s.id)}">Keep this shift</button>` : `<button class="btn go">${s.id ? 'Save' : 'Add shift'}</button>${s.id ? `<button type="button" class="btn" data-delshift="${esc(s.id)}">Delete</button>` : ''}`}</div></form></div></div>`;
}

/* ----- availability ----- */
function viewAvail() {
  const all = data.availability || [],
    mineL = all.filter((a) => a.name === data.me.name);
  const row = (a) =>
    `<div class="row"><div class="txt"><b>${/^\d{4}-/.test(a.day) ? dayName(a.day) : 'Every ' + { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }[a.day]}</b><div class="sub">${a.from ? t12(a.from) + '–' + t12(a.to) : 'All day'}${a.note ? ' · ' + esc(a.note) : ''}</div></div>${a.name === data.me.name || mgr() ? (String(a.id).startsWith('tmp') ? '<span class="sub">Saving…</span>' : `<button class="btn sm" data-editavail="${esc(a.id)}">Edit</button><button class="btn sm" data-delavail="${esc(a.id)}">Delete</button>`) : ''}</div>`;
  const others = mgr() ? [...new Set(all.filter((a) => a.name !== data.me.name).map((a) => a.name))].sort() : [];
  return `${back()}<h1>Availability</h1><p class="sub">Times you <b>can't</b> work. Managers see these when building the schedule. For one-off days off, send a time-off request instead.</p>
    <div class="card">${mineL.map(row).join('') || '<div class="empty">You haven\'t added any.</div>'}</div>
    <div class="btns" style="margin:4px 0 14px"><button class="btn go" data-addavail>Add a time you can't work</button></div><!--
    <h2>Add a time you can't work</h2><div class="card"><form class="stack" data-form="avail">
      <label class="f">When<select name="day">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => `<option value="${x}">Every ${{ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }[x]}</option>`).join('')}<option value="date">One date…</option></select></label>
      <label class="f" data-onlydate hidden>Date<input name="date" type="date" min="${T()}"></label>
      <div class="two"><label class="f">From (blank = all day)<input name="from" type="time"></label><label class="f">To<input name="to" type="time"></label></div>
      <label class="f">Note (optional)<input name="note" maxlength="200" placeholder="e.g. Class"></label><button class="btn go">Add</button></form></div>-->
    ${
      others.length
        ? `<h2>The team</h2>${others
            .map(
              (n) =>
                `<div class="card"><div class="sec">${esc(n)}</div>${all
                  .filter((a) => a.name === n)
                  .map(row)
                  .join('')}</div>`
            )
            .join('')}`
        : ''
    }`;
}

/* ----- time sheet: day, week or pay period; a person's hours and pay, or (managers) everyone's labor ----- */
function viewTime() {
  if (!tsDate) tsDate = T();
  const [from, to] = rangeOf(tsMode, tsDate),
    lo = HIST.limit || plus(T(), mgr() ? -399 : -119),
    hi = plus(T(), mgr() ? 55 : 13),
    today = T();
  const ready = needFrom(from),
    wait = ready ? '' : '<div class="hint">Loading earlier weeks…</div>';
  const span = from === to ? '' : shortDay(from) + ' – ' + shortDay(to);
  const title =
    tsMode === 'day'
      ? dayName(from)
      : tsMode === 'week'
        ? from === monday(today)
          ? 'This week'
          : from === monday(plus(today, -7))
            ? 'Last week'
            : from === monday(plus(today, 7))
              ? 'Next week'
              : 'Week of ' + shortDay(from)
        : today >= from && today <= to
          ? 'This pay period'
          : to < today
            ? 'Past pay period'
            : 'Next pay period';
  const nav = `<div class="seg">${[
    ['day', 'Day'],
    ['week', 'Week'],
    ['period', 'Pay period'],
  ]
    .map(([k, n]) => `<button data-tsmode="${k}" aria-pressed="${tsMode === k}">${n}</button>`)
    .join('')}</div>
    <div class="weeknav"><button class="btn sm" data-tsstep="-1" ${from <= lo ? 'disabled' : ''} aria-label="Earlier">‹</button><div><b>${title}</b><div class="sub">${tsMode === 'day' ? (dayName(from) === shortDay(from) ? '' : shortDay(from)) : span}${(tsMode === 'day' ? from : to) !== today && !(today >= from && today <= to) ? ` · <button class="linkbtn" data-tsjump>Back to today</button>` : ''}</div></div><button class="btn sm" data-tsstep="1" ${to >= hi ? 'disabled' : ''} aria-label="Later">›</button></div>`;
  const line = (l, canEdit) => {
    const p = l.punch,
      s = l.shift,
      run = p && !p.out && Date.now() - new Date(p.in) <= 16 * 36e5;
    const flags = [
      l.noShow ? ['warn', 'No-show'] : null,
      l.lateBy > (data.lateAfter || 5) ? ['warn', 'Late ' + l.lateBy + ' min'] : null,
      OVER() && l.overBy > OVER() ? ['warn', 'Over by ' + overTxt(l.overBy)] : null,
      autoOut(p) ? ['warn', 'Auto clocked out'] : null,
      l.unscheduled ? ['mute', 'Not scheduled'] : null,
      run ? ['ok', 'On the clock'] : null,
      p && !p.out && !run ? ['warn', 'No clock-out'] : null,
      p && p.inPlace && /^away/.test(p.inPlace) ? ['mute', 'Clocked in ' + p.inPlace] : null,
      p && p.edited ? ['mute', 'Edited by ' + first(p.edited)] : null,
      p && (p.as || p.type) ? ['mute', p.as || p.type] : null,
    ].filter(Boolean);
    const inner = `<div class="txt"><b>${shortDay(l.date)}</b><div class="sub">${s ? 'Scheduled ' + t12(s.start) + '–' + t12(s.end) : ''}${s && p ? ' · ' : ''}${p ? 'Worked ' + timeOf(p.in) + '–' + (p.out ? timeOf(p.out) : run ? 'now' : '…') + (p.out || run ? ' (' + hrs(((p.out ? new Date(p.out) : new Date()) - new Date(p.in)) / 6e4) + ')' : '') : ''}${p && p.note ? ' · ' + esc(p.note) : ''}</div>${flags.length ? `<div style="margin-top:4px">${flags.map(([c, t]) => `<span class="pill ${c}">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>`;
    return canEdit
      ? rowBtn(
          `data-editpunch="${p ? esc(p.id) : ''}" data-pdate="${l.date}" data-pname="${esc(tsPerson)}" data-pstart="${s ? s.start : ''}" data-pend="${s ? s.end : ''}"`,
          inner + '<span class="sub">Fix</span>'
        )
      : `<div class="row">${inner}</div>`;
  };
  const shiftsIn = (name) => (data.shifts || []).filter((s) => notGone(s) && (!name || s.name === name));

  if (!mgr() || tsPerson) {
    // one person: hours and estimated pay (what they take home before taxes, no employer extras)
    const who = mgr() ? tsPerson : data.me.name,
      r = rangeReport(from, to, who)[0] || { sched: 0, worked: 0, lines: [] },
      w = wageOf(who);
    const PW = costIn(punchItems(punchesNow(who)), from, to, { noExtra: true }),
      PS = costIn(shiftItems(shiftsIn(who)), from, to, { noExtra: true });
    const future = from > today,
      ot = PW.ot[who];
    return `${back(mgr() ? 'time' : '')}<h1>${mgr() ? esc(who) : 'My time'}</h1>${nav}${wait}
      <div class="card laborcard"><div class="row lc-top">
        <div class="lc-stat"><b>${future ? '–' : hrs(r.worked)}</b><span class="sub">worked</span></div>
        ${w ? `<div class="lc-stat"><b>${future ? '–' : money(PW.total, true)}</b><span class="sub">est. pay</span></div>` : ''}
        <div class="lc-stat"><b>${hrs(r.sched)}</b><span class="sub">scheduled${w ? ' · ' + money(PS.total) : ''}</span></div></div>
        ${r.running ? '<div class="row"><div class="txt sub">On the clock now – this keeps counting until you clock out.</div><span class="pill ok">Live</span></div>' : ''}
        <div class="row"><div class="txt sub">${w ? `At ${money(w, true)}/h${ot ? ' · includes ' + hrs(ot * 60) + ' overtime at ' + ((data.pay || data.myPay || {}).otRate || 1.5) + '×' : ''}. Before taxes – an estimate, payroll decides.` : mgr() ? `No wage set for ${esc(first(who))} – add it in Team to see pay.` : "Your wage isn't in the app yet, so pay can't be estimated. Ask a manager to add it."}</div></div></div>
      <div class="card">${r.lines.map((l) => line(l, mgr() && l.date <= today)).join('') || `<div class="empty">Nothing ${tsMode === 'day' ? 'this day' : 'in this ' + (tsMode === 'week' ? 'week' : 'pay period')}.</div>`}</div>
      ${mgr() ? `<button class="btn" data-editpunch="" data-pdate="${from <= today && to >= today ? today : from}" data-pname="${esc(who)}">+ Add a missed punch</button>` : '<p class="sub">Something wrong? Tell a manager – they can fix punches.</p>'}`;
  }

  // Managers: everyone's labor for the day / week / pay period – worked so far (live today) vs. scheduled
  const rep = rangeReport(from, to),
    LW = costIn(punchItems(punchesNow()), from, to),
    LS = costIn(shiftItems(shiftsIn()), from, to);
  const tot = { s: LS.hours * 60, w: rep.reduce((a, r) => a + r.worked, 0) },
    future = from > today,
    k = 1 + (Number((data.pay || {}).extra) || 0) / 100;
  const days = [];
  for (let d = from; d <= to; d = plus(d, 1)) days.push(d);
  const byDay =
    tsMode === 'day'
      ? ''
      : `<h2>By day</h2><div class="card">${days
          .map((d) => {
            const past = d <= today,
              wh = (LW.hoursByDay[d] || 0) * 60,
              sh = (LS.hoursByDay[d] || 0) * 60;
            return rowBtn(
              `data-tsday="${d}" class="${d === today ? 'mine' : ''}"`,
              `<div class="txt"><b>${d === today ? 'Today' : shortDay(d)}</b><div class="sub">${past ? hrs(wh) + ' worked of ' + hrs(sh) + ' scheduled' : hrs(sh) + ' scheduled'}</div></div><span class="money">${past ? money(LW.byDay[d] || 0) : '<span class="sub">' + money(LS.byDay[d] || 0) + ' sched.</span>'}</span><span>›</span>`
            );
          })
          .join('')}</div>`;
  const ppl = rep.filter((r) => LS.hoursByPerson[r.name] || r.worked || r.lines.length);
  return `${back()}<h1>Time sheets</h1>${nav}${wait}
    <div class="card laborcard"><div class="row lc-top">
      <div class="lc-stat"><b>${future ? '–' : hrs(tot.w)}</b><span class="sub">worked</span></div>
      <div class="lc-stat"><b>${future ? '–' : money(LW.total)}</b><span class="sub">labor cost</span></div>
      <div class="lc-stat"><b>${hrs(tot.s)}</b><span class="sub">scheduled · ${money(LS.total)}</span></div></div>
      ${rep.some((r) => r.running) && from <= today && to >= today ? `<div class="row"><div class="txt sub">${rep.filter((r) => r.running).length} on the clock now – worked hours and cost keep counting.</div><span class="pill ok">Live</span></div>` : ''}
      ${!future ? `<div class="row"><div class="txt sub">${to < today && LS.total ? money(Math.abs(LW.total - LS.total)) + (LW.total >= LS.total ? ' over' : ' under') + ' the schedule. ' : ''}Hours × wage${k > 1 ? ' + ' + Math.round((k - 1) * 100) + '%' : ''}, overtime included. Estimate.${LW.missing.length || LS.missing.length ? ' No wage set for ' + [...new Set(LW.missing.concat(LS.missing))].map(first).map(esc).join(', ') + '.' : ''}</div></div>` : ''}</div>
    ${byDay}
    <h2>People</h2><div class="card">${
      ppl
        .map((r) =>
          rowBtn(
            `data-tsperson="${esc(r.name)}"`,
            `<div class="txt"><b>${esc(r.name)}${r.running ? ' <span class="pill ok">On</span>' : ''}</b><div class="sub">${future ? hrs((LS.hoursByPerson[r.name] || 0) * 60) + ' scheduled' : hrs(r.worked) + ' worked of ' + hrs((LS.hoursByPerson[r.name] || 0) * 60) + ' scheduled'}${wageOf(r.name) ? ` · ${future ? money(LS.byPerson[r.name] || 0) + ' sched.' : money(LW.byPerson[r.name] || 0) + ' of ' + money(LS.byPerson[r.name] || 0)}${LW.ot[r.name] ? ' · ' + hrs(LW.ot[r.name] * 60) + ' OT' : ''}` : ' · no wage set'}</div>
      ${
        r.lates || r.noShow || r.missingOut || r.unscheduled || r.overs || r.autos
          ? `<div style="margin-top:4px">${[
              r.lates ? ['warn', r.lates + ' late'] : null,
              r.noShow ? ['warn', r.noShow + ' no-show'] : null,
              r.overs ? ['warn', r.overs + ' over shift'] : null,
              r.autos ? ['warn', r.autos + ' auto clock-out'] : null,
              r.missingOut ? ['warn', r.missingOut + ' no clock-out'] : null,
              r.unscheduled ? ['mute', r.unscheduled + ' unscheduled'] : null,
            ]
              .filter(Boolean)
              .map(([c, t]) => `<span class="pill ${c}">${t}</span>`)
              .join(' ')}</div>`
          : ''
      }</div><span>›</span>`
          )
        )
        .join('') || '<div class="empty">No shifts or punches.</div>'
    }</div>
    <p class="sub">Late means clocking in more than ${data.lateAfter || 5} minutes after the shift start.${OVER() ? ' Over shift means working more than ' + OVER() + ' minutes past the scheduled shift.' : ''} Anyone still clocked in at night is clocked out automatically and flagged. Approved time off never counts as a no-show.</p>`;
}
function punchSheet() {
  const s = sheet,
    p = s.id ? (data.punches || []).find((x) => x.id === s.id) : null;
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${p ? 'Fix punch' : 'Add punch'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <form class="stack" data-form="punch" style="padding:0">
      <label class="f">Who<select name="name">${(data.users || []).map((u) => `<option ${u.name === s.name ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label class="f">Date<input name="date" type="date" value="${esc(p ? p.date : s.date)}"></label>
      <div class="two"><label class="f">In<input name="in" type="time" value="${esc(p && p.in ? hmOf(p.in) : s.start || '')}"></label><label class="f">Out<input name="out" type="time" value="${esc(p && p.out ? hmOf(p.out) : s.end || '')}"></label></div>
      ${p && p.as ? `<p class="sub" style="margin:0">Clocked in as <b>${esc(p.as)}</b>.</p>` : ''}
      ${(data.shiftTypes || []).length ? `<label class="f">Shift type (for payroll)<select name="type">${data.shiftTypes.map((t, i) => `<option value="${esc(t)}" ${(p && p.type ? p.type === t : i === 0) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` : ''}
      <label class="f">Note<input name="note" maxlength="200" value="${esc(p ? p.note : '')}" placeholder="e.g. Forgot to clock out"></label>
      <div class="btns"><button class="btn go">Save</button>${p ? `<button type="button" class="btn" data-delpunch="${esc(p.id)}">Delete</button>` : ''}</div></form></div></div>`;
}

/* ----- chat ----- */
const AV = ['#1E5662', '#2B7A8A', '#9A6514', '#5E6666'];
const initials = (n) => {
  const w = String(n || '?')
    .trim()
    .split(/\s+/);
  return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
};
const avColor = (k) => {
  let h = 0;
  for (const ch of String(k)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV[h % AV.length];
};
/* "Last active": the server knows when each person last used the app (to within a minute or so). Under 5 minutes counts as active now. */
const otherId = (c) =>
  c && c.kind === 'dm'
    ? String(c.id)
        .split('-')
        .slice(1)
        .find((x) => x !== data.meId)
    : c && !c.kind
      ? c.id
      : '';
const activeMs = (id) =>
  liveOnline.has(id) && data.active && id in data.active ? Date.now() : Number((data.active || {})[id] || 0);
const isActive = (id) => !!id && id !== data.meId && Date.now() - activeMs(id) < 5 * 60000;
function activeLabel(id) {
  const ms = activeMs(id);
  if (!ms || id === data.meId) return '';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 5) return 'Active now';
  if (m < 60) return `Active ${m} min ago`;
  if (m < 24 * 60 && ymdOf(new Date(ms)) === T()) return `Active ${Math.floor(m / 60)} h ago`;
  if (ymdOf(new Date(ms)) === plus(T(), -1)) return 'Active yesterday';
  if (m < 7 * 1440) return 'Active ' + new Date(ms).toLocaleDateString([], { weekday: 'long' });
  return m < 60 * 1440 ? 'Active ' + new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
}
function avatar(c, size) {
  const st = `style="--av:${avColor(c.id || c.name)}${size ? ';--sz:' + size + 'px' : ''}"`;
  if (isActive(otherId(c))) return avatar0(c, size).replace('class="av', 'class="av on');
  return avatar0(c, size, st);
}
function avatar0(c, size, st) {
  st = st || `style="--av:${avColor(c.id || c.name)}${size ? ';--sz:' + size + 'px' : ''}"`;
  if (c.kind === 'channel') return `<span class="av ch" ${st} aria-hidden="true">#</span>`;
  if (c.kind === 'group')
    return `<span class="av grp" ${st} aria-hidden="true"><svg viewBox="0 0 24 24" width="55%" height="55%" fill="currentColor"><circle cx="9" cy="8" r="3.2"/><circle cx="16.5" cy="9" r="2.6"/><path d="M2.5 19c.4-3.6 3.1-5.6 6.5-5.6s6.1 2 6.5 5.6z"/><path d="M15.2 13.6c2.9-.3 5.6 1.3 6.3 5.4h-4.4c-.2-2.2-.9-4-1.9-5.4z"/></svg></span>`;
  return `<span class="av" ${st} aria-hidden="true">${esc(initials(c.name))}</span>`;
}
const shortWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso),
    day = ymdOf(d),
    diff = (Date.now() - d) / 864e5;
  return day === T()
    ? timeOf(iso)
    : day === plus(T(), -1)
      ? 'Yesterday'
      : diff < 6
        ? d.toLocaleDateString([], { weekday: 'short' })
        : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const v3 = () => Number(data && data.version) >= 3;
const SVG_READ =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12.5l4.5 4.5L15 8"/><path d="M11 16l1 1 9.5-9.5"/></svg>';
// Status marks bring their own style (an old cached page may not have it)
(function () {
  if (document.getElementById('mstat-css')) return;
  const st = document.createElement('style');
  st.id = 'mstat-css';
  st.textContent =
    '.mstat{align-self:flex-end;display:flex;align-items:center;gap:3px;font-size:.68rem;line-height:1;color:var(--muted);margin:-1px 6px 8px;opacity:.85;font-style:italic;letter-spacing:.01em}.mstat svg{flex:none}.mstat.st-seen{color:var(--accent);opacity:1}.mstat.st-sending{opacity:.6}.mstat .lnk{font-size:inherit;font-style:normal}';
  document.head.appendChild(st);
})();
const STAT_IC = {
  // small status marks under your newest message
  sending:
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  sent: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  delivered:
    '<svg viewBox="0 0 20 16" width="17" height="14" aria-hidden="true"><path d="M1.8 8.5l3 3 6-7M8.3 10.6l.9.9 6-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
STAT_IC.seen = STAT_IC.delivered;
const SVG_REPLY =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** How to @mention someone: first name, or full name when two people share it. */
function mentionLabel(p) {
  const f = first(p.name).toLowerCase();
  return (data.people || []).filter((x) => first(x.name).toLowerCase() === f).length > 1 ? p.name : first(p.name);
}
function audience(c) {
  const ppl = (data.people || []).filter((p) => p.id !== data.meId);
  if (!c || c.kind === 'dm') return [];
  if (c.kind === 'group') return ppl.filter((p) => (c.memberIds || []).indexOf(p.id) >= 0);
  return ppl.filter((p) =>
    c.who === 'Managers' ? p.role === 'Manager' : /lead/i.test(c.who) ? p.role !== 'Staff' : true
  );
}
let mentRe = null,
  mentKey = '';
// Web addresses in messages and announcements become tappable links (only http/https or www.; text is escaped first)
const URL_RE = /((?:https?:\/\/|www\.)[^\s<]+)/i;
function linkParts(h) {
  const out = [];
  h.split(new RegExp(URL_RE.source, 'gi')).forEach((x, i) => {
    if (!(i % 2)) {
      if (x) out.push({ t: x });
      return;
    }
    const tail = (x.match(/(?:[.,!?;:)\]}]|&#39;|&quot;)+$/) || [''])[0],
      u = tail ? x.slice(0, -tail.length) : x;
    if (!/\w\.\w|\/\/\w/.test(u)) {
      out.push({ t: x });
      return;
    }
    out.push({ u });
    if (tail) out.push({ t: tail });
  });
  return out;
}
const linkTag = (u) =>
  `<a class="mlink" href="${/^www\./i.test(u) ? 'https://' + u : u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
const linkify = (h) =>
  linkParts(h)
    .map((p) => (p.u ? linkTag(p.u) : p.t))
    .join('');
function fmtMsg(text) {
  const h = esc(text);
  if (!URL_RE.test(h)) return fmtMent(h);
  return linkParts(h)
    .map((p) => (p.u ? linkTag(p.u) : fmtMent(p.t)))
    .join('');
}
function fmtMent(h) {
  if (h.indexOf('@') < 0) return h;
  const key = (data.people || []).map((p) => p.id + p.name).join('|');
  if (key !== mentKey) {
    mentKey = key;
    const labels = [];
    (data.people || []).forEach((p) => {
      labels.push({ l: p.name, id: p.id });
      if (mentionLabel(p) === p.name) return;
      labels.push({ l: first(p.name), id: p.id });
    });
    labels.sort((a, b) => b.l.length - a.l.length);
    mentRe = labels.length
      ? { re: new RegExp('@(' + labels.map((x) => escRe(esc(x.l))).join('|') + ')(?![\\w])', 'gi'), labels }
      : null;
  }
  h = h.replace(/(^|[^\w@])@team(?![\w])/gi, (m, pre) => pre + '<span class="ment me">@team</span>'); // @team tags everyone in the chat
  if (!mentRe) return h;
  return h.replace(mentRe.re, (m, n) => {
    const hit = mentRe.labels.find((x) => esc(x.l).toLowerCase() === n.toLowerCase());
    return `<span class="ment ${hit && hit.id === data.meId ? 'me' : ''}">${m}</span>`;
  });
}
const SVG_EDIT =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
function viewChat() {
  if (chat.open) return viewConversation();
  // Pinned conversations sit in a compact strip at the top (in the order they were pinned).
  // Everything else: unread first, then newest message first.
  const pins = myPins(),
    all = data.channels || [];
  const pinned = pins.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  const ch = all
    .filter((c) => pins.indexOf(c.id) < 0)
    .sort(
      (a, b) =>
        (Number(b.unread) > 0) - (Number(a.unread) > 0) ||
        String((b.last || {}).at || '').localeCompare(String((a.last || {}).at || '')) ||
        (a.kind === 'channel' ? -1 : 1)
    );
  const chip = (c) =>
    `<button class="pchip ${c.unread ? 'unread' : ''}" data-openchat="${esc(c.id)}" aria-label="${esc(c.name)}${c.unread ? ', ' + c.unread + ' unread' : ''}">${avatar(c, 48)}${c.unread ? `<span class="cn">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}<span class="pname">${esc(c.kind === 'dm' ? first(c.name) : c.name)}</span></button>`;
  const row = (c) => {
    const l = c.last,
      mine = l && first(l.from) === first(data.me.name) && l.from === data.me.name;
    let pre = !l
      ? c.kind === 'group'
        ? esc(c.members.join(', '))
        : 'No messages yet'
      : (mine ? 'You: ' : c.kind === 'dm' ? '' : esc(first(l.from)) + ': ') + esc(l.text);
    const dr = drafts()[c.id];
    if (dr) pre = `<span class="cdraft">Draft:</span> ${esc(dr)}`;
    return `<button class="crow ${c.unread ? 'unread' : ''}" data-openchat="${esc(c.id)}">${avatar(c)}<span class="cbody"><span class="ctop"><b>${esc(c.name)}</b><span class="cwhen">${l ? shortWhen(l.at) : ''}</span></span><span class="cbot"><span class="cpre">${pre}</span>${c.unread ? `<span class="cn">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</span></span></button>`;
  };
  const q = chat.q || '',
    searching = v3() && q.trim().length >= 2;
  const hl = (t) => {
    const h = esc(t),
      i = h.toLowerCase().indexOf(esc(q.trim()).toLowerCase());
    return i < 0
      ? h
      : h.slice(0, i) + '<mark>' + h.slice(i, i + esc(q.trim()).length) + '</mark>' + h.slice(i + esc(q.trim()).length);
  };
  const res = (r) =>
    `<button class="crow" data-openfind="${esc(r.channel)}|${esc(r.id)}">${avatar({ id: r.channel, name: r.name, kind: r.kind })}<span class="cbody"><span class="ctop"><b>${esc(r.kind === 'dm' ? r.name : r.name)}</b><span class="cwhen">${shortWhen(r.at)}</span></span><span class="cpre wrap"><span class="sub">${esc(first(r.from))}:</span> ${hl(r.text)}</span></span></button>`;
  const body = searching
    ? chat.results
      ? chat.results.map(res).join('') || '<div class="empty">No messages match.</div>'
      : '<div class="empty">Searching…</div>'
    : (pinned.length ? `<div class="pins" aria-label="Pinned conversations">${pinned.map(chip).join('')}</div>` : '') +
      (ch.map(row).join('') ||
        (pinned.length ? '' : '<div class="empty">No conversations yet. Tap the pencil to start one.</div>'));
  const unreadN = all.reduce((n, c) => n + (Number(c.unread) || 0), 0);
  return `<div class="chathead"><h1>Messages</h1>${unreadN && LIVE ? '<button class="btn sm" data-readall style="margin-left:auto;margin-right:8px">Mark all read</button>' : ''}${shop() ? '' : `<button class="iconbtn" data-newdm aria-label="New message">${SVG_EDIT}</button>`}</div>
    ${v3() ? `<div class="csearch"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input type="search" data-csearch placeholder="Search messages" value="${esc(q)}" aria-label="Search messages" autocomplete="off">${q ? '<button class="cx" data-clearsearch aria-label="Clear search">×</button>' : ''}</div>` : ''}
    <div class="clist">${body}</div>`;
}
const myPins = () => (data && data.me && Array.isArray(data.me.pins) ? data.me.pins : []);
function convName() {
  const c = (data.channels || []).find((x) => x.id === chat.open);
  if (c) return c.name;
  const other = chat.open
      .split('-')
      .slice(1)
      .find((x) => x !== data.meId),
    p = (data.people || []).find((x) => x.id === other);
  return p ? p.name : chat.dmName || 'Message';
}
function convSub(c) {
  if (!c) return '';
  if (c.kind === 'channel') return c.who === 'Everyone' ? '' : c.who;
  if (c.kind === 'group') {
    const on = (c.memberIds || [])
      .filter(isActive)
      .map((id) => first(((data.people || []).find((p) => p.id === id) || {}).name));
    return c.members.map(first).join(', ') + (on.length ? ' · ' + on.join(', ') + ' active now' : '');
  }
  return activeLabel(otherId(c));
}
function viewConversation() {
  const msgs = chat.msgs || [],
    c = curChat() || { id: chat.open, name: convName(), kind: 'dm' },
    multi = c.kind !== 'dm';
  const gap = (a, b) => Math.abs(new Date(b.at) - new Date(a.at)) / 6e4;
  const body = msgs
    .map((m, i) => {
      const prev = msgs[i - 1],
        next = msgs[i + 1],
        mine = m.id === 'tmp' || m.fromId === (chat.me || data.meId);
      const sep = !prev || ymdOf(new Date(m.at)) !== ymdOf(new Date(prev.at)) || gap(prev, m) > 60;
      const firstR = sep || prev.fromId !== m.fromId || gap(prev, m) > 5;
      const nextSep = next && (ymdOf(new Date(next.at)) !== ymdOf(new Date(m.at)) || gap(m, next) > 60);
      const lastR = !next || nextSep || next.fromId !== m.fromId || gap(m, next) > 5;
      const pic = m.file
        ? fileTag(m)
        : m.photo
          ? picTag(m)
          : m.expired
            ? '<div class="msg exp"><i>Photo expired</i></div>'
            : '';
      const real = m.id !== 'tmp',
        acks = m.acks || [];
      const meta =
        chat.meta === m.id && !chat.sel
          ? `<div class="meta ${mine ? 'me' : ''}">${timeOf(m.at)}${v3() && real ? ` · <button class="lnk" data-reply="${esc(m.id)}">Reply</button>` : ''}${m.text ? ` · <button class="lnk" data-copymsg="${esc(m.id)}">Copy</button>` : ''}${v3() && real && !mine ? ` · <button class="lnk" data-mack="${esc(m.id)}">${m.ackMine ? 'Remove 👍' : '👍'}</button>` : ''}${mgr() && real ? ` · <button class="lnk" data-delmsg="${esc(m.id)}">Delete</button> · <button class="lnk" data-selmsg="${esc(m.id)}">Select</button>` : ''}</div>`
          : '';
      const quote = m.reply
        ? `<button type="button" class="quote" data-jump="${esc(m.reply.id)}"><b>${esc(m.reply.from ? (m.reply.from === data.me.name ? 'You' : first(m.reply.from)) : '')}</b><span>${m.reply.photo && !m.reply.text ? '📷 Photo' : esc(m.reply.text)}</span></button>`
        : '';
      const ackPill = acks.length
        ? `<div class="ackrow ${mine ? 'me' : ''}"><button class="ackp ${m.ackMine ? 'mine' : ''}" data-acks="${esc(m.id)}" aria-label="👍 from ${esc(acks.join(', '))}"><i class="thumb">👍</i>${acks.length > 1 ? `<span>${acks.length}</span>` : ''}</button></div>`
        : '';
      // Under your newest message: Sending… → Sent → Delivered → Seen
      const isLastMine = mine && i === msgs.length - 1 && v3();
      const after = (x) => x.at && new Date(x.at) >= new Date(m.at);
      const seenAll = isLastMine && real ? (chat.seen || []).filter(after) : [],
        seenBy = seenAll.map((x) => first(x.name));
      const kind = !isLastMine
        ? ''
        : !real
          ? 'sending'
          : seenBy.length
            ? 'seen'
            : (chat.dlv || []).some(after)
              ? 'delivered'
              : 'sent';
      const label =
        kind === 'seen'
          ? !multi
            ? 'Seen ' + timeOf(seenAll[0].at)
            : 'Seen by ' +
              esc(seenBy.slice(0, 3).join(', ')) +
              (seenBy.length > 3 ? ` <button class="lnk" data-cseen>+${seenBy.length - 3}</button>` : '')
          : { sending: 'Sending', sent: 'Sent', delivered: 'Delivered' }[kind];
      const seen = kind ? `<div class="mstat st-${kind}">${STAT_IC[kind]}<span>${label}</span></div>` : '';
      return (
        (sep ? `<div class="daysep"><b>${dayName(ymdOf(new Date(m.at)))}</b> ${timeOf(m.at)}</div>` : '') +
        (multi && !mine && firstR ? `<div class="from">${esc(first(m.from))}</div>` : '') +
        `<div class="mrow ${mine ? 'me' : ''} ${lastR ? 'last' : ''} ${chat.sel && chat.sel.indexOf(m.id) >= 0 ? 'sel' : ''}" ${chat.sel && real ? `data-selrow="${esc(m.id)}"` : ''}>${chat.sel ? `<span class="mchk" aria-hidden="true">${chat.sel.indexOf(m.id) >= 0 ? '✓' : ''}</span>` : ''}` +
        `<div class="bub ${mine ? 'me' : ''} ${firstR || m.reply ? 'first' : ''} ${lastR || acks.length ? 'last' : ''} ${m.photo && !m.reply ? 'photo' : ''} ${!real ? 'tmp' : ''} ${chat.flash === m.id ? 'flash' : ''}" data-bub="${esc(m.id)}" data-mine="${mine ? 1 : 0}">${quote}${pic}${m.text ? `<div class="msg">${fmtMsg(m.text)}</div>` : ''}</div><span class="swipeic" aria-hidden="true">${SVG_REPLY}</span></div>` +
        ackPill +
        meta +
        seen
      );
    })
    .join('');
  return `<div class="convo ${chat.sel ? 'selecting' : ''}"><div class="chatbar"><button class="iconbtn back" data-closechat aria-label="Back"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="who">${avatar(c, 32)}<div class="wtxt"><b>${esc(convName())}</b>${convSub(c) ? `<span>${esc(convSub(c))}</span>` : ''}</div></div>
      ${chat.open ? `<button class="iconbtn pinbtn ${myPins().indexOf(chat.open) >= 0 ? 'on' : ''}" data-pinchat="${esc(chat.open)}" aria-pressed="${myPins().indexOf(chat.open) >= 0}" aria-label="${myPins().indexOf(chat.open) >= 0 ? 'Unpin chat' : 'Pin chat to the top'}" title="${myPins().indexOf(chat.open) >= 0 ? 'Unpin' : 'Pin to the top'}">📌</button>` : ''}
      ${canEditChat() ? '<button class="lnk edit" data-editchat>Edit</button>' : '<span class="edit"></span>'}</div>
    <div class="msgs" id="msgs">${body || `<div class="hello">${avatar(c, 64)}<b>${esc(convName())}</b><span>No messages yet. Say hello.</span></div>`}</div>
    <div class="mentbox" id="ment" hidden></div>
    ${chat.reply ? `<div class="replybar"><span class="ri">${SVG_REPLY}</span><div><b>Replying to ${esc(chat.reply.from === data.me.name ? 'yourself' : first(chat.reply.from))}</b><span>${esc(chat.reply.text || '📷 Photo')}</span></div><button type="button" class="cx" data-unreply aria-label="Cancel reply">×</button></div>` : ''}
    ${chat.file ? `<div class="pv pvf">${SVG_DOC}<span><b>${esc(chat.file.name)}</b><small>PDF · ${fileSize(chat.file.blob.size)}</small></span><button type="button" class="pvx" data-unphoto aria-label="Remove PDF">×</button></div>` : ''}
    ${chat.photo ? `<div class="pv"><img src="${chat.photo}" alt="Photo to send"><button type="button" class="pvx" data-unphoto aria-label="Remove photo">×</button></div>` : ''}
    ${chat.sel ? `<div class="selbar"><button type="button" class="lnk" data-selcancel>Cancel</button><span class="sr">${chat.sel.length} selected</span><button type="button" class="btn warn" data-seldel ${chat.sel.length ? '' : 'disabled'}>${chat.sel.length ? 'Delete ' + chat.sel.length : 'Tap messages'}</button></div>` : `<form class="composer" data-form="send">${Number(data.version) >= 2.7 ? `<label class="picbtn" title="${LIVE ? 'Add a photo or PDF' : 'Add a photo'}" aria-label="${LIVE ? 'Add a photo or PDF' : 'Add a photo'}"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2"/></svg><input type="file" accept="${LIVE ? 'image/*,application/pdf,.pdf' : 'image/*'}" data-photo hidden onchange="pickPhoto(this)"></label>` : ''}<textarea name="text" rows="1" maxlength="2000" placeholder="${chat.photo || chat.file ? 'Add a caption' : 'Message'}" aria-label="Message">${esc(chat.compose)}</textarea><button class="send" aria-label="Send" ${chat.sending ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5.5 11.5L12 5l6.5 6.5"/></svg></button></form>`}</div>`;
}
function curChat() {
  return (data.channels || []).find((x) => x.id === chat.open);
}
function canEditChat() {
  const c = curChat();
  return !!c && Number(data.version) >= 2.9 && (c.kind === 'group' || (c.kind === 'channel' && lead()));
}
function editChatSheet() {
  const c = curChat();
  if (!c) return '';
  const people = (data.people || []).filter((p) => p.id !== data.meId),
    ids = c.memberIds || [];
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${c.kind === 'group' ? 'Edit group' : 'Edit channel'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <form class="stack" data-form="editchat" style="padding:0"><label class="f">Name<input name="name" maxlength="40" value="${esc(c.name)}"></label>
      ${
        c.kind === 'group'
          ? `<h2 style="margin:4px 0 0">People</h2><div class="card">${people.map((p) => `<label class="row" style="gap:10px"><input type="checkbox" name="m" value="${esc(p.id)}" ${ids.indexOf(p.id) >= 0 ? 'checked' : ''} style="width:auto;min-height:0"> ${esc(p.name)}</label>`).join('')}</div>`
          : `<label class="f">Who sees it<select name="who">${['Everyone', 'Leads and managers', 'Managers'].map((o) => `<option ${o === c.who ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`
      }
      <button class="btn go">Save</button></form></div></div>`;
}
// Unsent messages are kept per conversation on this phone until sent or cleared
function drafts() {
  try {
    return JSON.parse(load('pt-drafts') || '{}') || {};
  } catch (_) {
    return {};
  }
}
function setDraft(id, t) {
  if (!id || id === 'tmp') return;
  const d = drafts();
  t = String(t || '');
  if (t.trim()) d[id] = t.slice(0, 2000);
  else delete d[id];
  save('pt-drafts', Object.keys(d).length ? JSON.stringify(d) : null);
}
async function openChat(id, name, text, photo, opt) {
  if (text === undefined && id !== chat.open) {
    chat.compose = drafts()[id] || '';
    chat.photo = '';
    chat.file = null;
    chat.reply = null;
  }
  chat.open = id;
  chat.dmName = name || chat.dmName;
  if (text === undefined && chat.loaded !== id) {
    chat.msgs = [];
    chat.seen = [];
    chat.dlv = [];
  }
  render();
  scrollChat();
  if (LIVE) return liveOpen(id, text, photo, opt);
  try {
    const r = await post(
      Object.assign({ fn: 'chat', token: TOKEN, channel: id, text }, photo ? { photo } : {}, opt || {})
    );
    if (photo) {
      const mine = r.messages.filter((m) => m.fromId === r.me && m.photo).pop();
      if (mine && !picCache[mine.id]) {
        picCache[mine.id] = photo;
        idbPut(mine.id, photo);
      }
    }
    if (chat.open !== id) return;
    chat.msgs = r.messages;
    chat.seen = r.seen || [];
    chat.me = r.me;
    chat.loaded = id;
    data.channels = r.channels;
    if (r.active) data.active = r.active;
    save('pt-cache', JSON.stringify(data));
    const near = isNearBottom();
    render();
    if (opt && opt.find) jumpTo(opt.find);
    else if (near || text !== undefined) scrollChat();
  } catch (e) {
    const m = String(e.message || e);
    if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, ''));
    if (text !== undefined) {
      chat.compose = text;
      setDraft(id, text);
      if (photo) chat.photo = photo;
      if (opt && opt.replyTo && opt.reply) chat.reply = opt.reply;
      chat.msgs = (chat.msgs || []).filter((x) => x.id !== 'tmp');
      toast('Not sent: ' + m);
      render();
    }
  }
  clearTimeout(chat.timer);
  chat.timer = setTimeout(() => {
    if (chat.open === id && tab === 'chat' && !document.hidden) openChat(id);
  }, 7000);
}
/** Deletes several messages at once (managers): removed on screen straight away, then on the server; anything that fails comes back. */
async function delMsgs(ids) {
  const ch = chat.open;
  chat.msgs = (chat.msgs || []).filter((m) => ids.indexOf(m.id) < 0);
  chat.sel = null;
  render();
  const res = await Promise.allSettled(
    ids.map((id) => (LIVE ? LIVE.ask({ t: 'del', id }) : act('deleteMessage', { id })))
  );
  const bad = res.filter((r) => r.status === 'rejected');
  if (bad.length)
    toast(
      `${bad.length} of ${ids.length} couldn't be deleted: ${String((bad[0].reason || {}).message || bad[0].reason)}`
    );
  else toast(ids.length === 1 ? 'Message deleted' : `${ids.length} messages deleted`);
  if ((bad.length || !LIVE) && chat.open === ch) openChat(ch);
}
function stopChat() {
  chat.sel = null;
  const ta = $('.composer textarea');
  if (chat.open && ta) setDraft(chat.open, ta.value);
  chat.compose = '';
  if (LIVE && chat.open) LIVE.send({ t: 'close' });
  clearTimeout(chat.timer);
  chat.open = '';
  chat.reply = null;
  chat.meta = '';
  chat.flash = '';
}
function jumpTo(id) {
  const el = document.querySelector(`[data-bub="${CSS.escape(id)}"]`);
  if (!el) {
    if (chat.open) openChat(chat.open, null, undefined, undefined, { find: id });
    return;
  }
  chat.flash = id;
  el.classList.add('flash');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => {
    if (chat.flash === id) chat.flash = '';
    el.classList.remove('flash');
  }, 1600);
}
function toggleAck(id) {
  const m = (chat.msgs || []).find((x) => x.id === id);
  if (!m || m.fromId === chat.me) return;
  m.ackMine = m.ackMine ? 0 : 1;
  m.acks = (m.acks || []).filter((n) => n !== data.me.name).concat(m.ackMine ? [data.me.name] : []);
  chat.meta = '';
  render();
  if (navigator.vibrate)
    try {
      navigator.vibrate(12);
    } catch (_) {}
  if (LIVE) {
    LIVE.send({ t: 'ack', id });
    return;
  }
  openChat(chat.open, null, undefined, undefined, { ack: id });
}
async function copyText(t) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (_) {}
  try {
    const a = document.createElement('textarea');
    a.value = t;
    a.setAttribute('readonly', '');
    a.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(a);
    a.select();
    a.setSelectionRange(0, t.length);
    const ok = document.execCommand('copy');
    a.remove();
    return ok;
  } catch (_) {
    return false;
  }
}
function startReply(id) {
  const m = (chat.msgs || []).find((x) => x.id === id);
  if (!m) return;
  chat.reply = { id: m.id, from: m.from, text: m.text ? m.text.slice(0, 90) : m.file ? '📄 ' + m.file : '' };
  chat.meta = '';
  render();
  const t = $('.composer textarea');
  if (t) t.focus();
}
let searchT = 0,
  searchN = 0;
function keepSearch(fn) {
  const a = document.activeElement,
    keep = a && a.dataset && a.dataset.csearch !== undefined,
    pos = keep ? a.selectionStart : 0;
  fn();
  if (keep) {
    const el = $('[data-csearch]');
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(pos, pos);
      } catch (_) {}
    }
  }
}
function runSearch() {
  const q = (chat.q || '').trim();
  clearTimeout(searchT);
  chat.results = null;
  if (q.length < 2) return;
  const n = ++searchN;
  searchT = setTimeout(
    () =>
      (LIVE ? LIVE.ask({ t: 'search', q }) : post({ fn: 'chatSearch', token: TOKEN, q }))
        .then((r) => {
          if (n !== searchN || tab !== 'chat' || chat.open) return;
          chat.results = r.results;
          keepSearch(render);
        })
        .catch((e) => {
          if (n === searchN) {
            chat.results = [];
            toast(e.message);
          }
        }),
    350
  );
}

/* ----- live chat: when the sheet's Settings has a Chat service address, messages go straight to the chat service ----- */
let LIVE = null,
  liveList = null,
  liveMe = '',
  liveOnline = new Set(),
  paintT = 0,
  paintAfter = [];
function liveSync() {
  const url = data && data.chat && data.chat.url;
  if (!url) {
    liveEnd();
    return;
  }
  if (liveList) data.channels = liveList; // the sheet no longer sends the list; the service does
  if (LIVE) return;
  LIVE = LiveChat({
    url,
    space: data.space || 'peregrine',
    ticket: () => post({ fn: 'chatTicket', token: TOKEN }),
    on: liveOn,
    onUp: () => {
      if (chat.open && tab === 'chat' && !document.hidden) openChat(chat.open);
    },
  });
}
function liveEnd() {
  if (LIVE) {
    LIVE.stop();
    LIVE = null;
  }
  liveList = null;
  liveOnline = new Set();
}
function paint(after) {
  if (after) paintAfter.push(after);
  clearTimeout(paintT);
  paintT = setTimeout(() => {
    if (!data) return;
    const near = isNearBottom();
    render();
    paintAfter.splice(0).forEach((f) => f(near));
  }, 40);
}
const byLast = (a, b) =>
  String((b.last || {}).at || '').localeCompare(String((a.last || {}).at || '')) || (a.kind === 'channel' ? -1 : 1);
const liveMsg = (m) => Object.assign(m, { ackMine: (m.ackIds || []).indexOf(liveMe) >= 0 ? 1 : 0 });
function setLiveList(list) {
  liveList = (list || []).slice().sort(byLast);
  if (data) {
    data.channels = liveList;
    save('pt-cache', JSON.stringify(data));
  }
}
function lastOf(m) {
  return { from: m.from, text: (m.text || '').slice(0, 80) || (m.photo ? '📷 Photo' : ''), at: m.at };
}
function liveOn(d) {
  if (!data) return;
  if (d.t === 'hello') {
    liveMe = chat.me = d.me;
    setLiveList(d.channels);
    liveOnline = new Set(d.online || []);
    paint();
    return;
  }
  if (d.t === 'channels') {
    setLiveList(d.channels);
    paint();
    return;
  }
  if (d.t === 'online') {
    liveOnline = new Set(d.online || []);
    paint();
    return;
  }
  const here = !!d.ch && d.ch === chat.open && chat.loaded === d.ch && tab === 'chat' && !document.hidden;
  if (d.t === 'msg') {
    const m = liveMsg(d.m),
      c = (liveList || []).find((x) => x.id === d.ch);
    if (!c)
      LIVE.send({ t: 'list' }); // a brand-new private message or group
    else {
      c.last = lastOf(m);
      if (!here && m.fromId !== liveMe) c.unread = (c.unread || 0) + 1;
      liveList.sort(byLast);
    }
    if (here) {
      if (!chat.msgs.some((x) => x.id === m.id)) chat.msgs = chat.msgs.concat(m);
      LIVE.send({ t: 'read', ch: d.ch });
      paint((near) => {
        if (near) scrollChat();
      });
      return;
    }
    paint();
    return;
  }
  if (!here) return;
  if (d.t === 'acks') {
    const m = chat.msgs.find((x) => x.id === d.id);
    if (m) {
      m.acks = d.acks;
      m.ackIds = d.ackIds;
      liveMsg(m);
      paint();
    }
    return;
  }
  if (d.t === 'seen') {
    chat.seen = (chat.seen || []).filter((x) => x.id !== d.id).concat({ id: d.id, name: d.name, at: d.at });
    paint();
    return;
  }
  if (d.t === 'dlv') {
    chat.dlv = (chat.dlv || []).filter((x) => x.id !== d.id).concat({ id: d.id, name: d.name, at: d.at });
    paint();
    return;
  }
  if (d.t === 'deleted') {
    chat.msgs = chat.msgs.filter((x) => x.id !== d.id);
    paint();
    return;
  }
}
async function liveOpen(id, text, photo, opt) {
  opt = opt || {};
  try {
    if (text !== undefined) {
      const key = photo ? await LIVE.upload(photo) : opt.file ? await LIVE.upload(opt.file.blob) : '';
      const r = await LIVE.ask(
          Object.assign(
            { t: 'send', ch: id, text: text || '', photo: key, reply: opt.replyTo || '', tmp: 'tmp' },
            opt.file ? { file: opt.file.name } : {}
          ),
          opt.file ? 60000 : undefined
        ),
        m = liveMsg(r.m);
      if (photo) {
        picCache[m.id] = photo;
        idbPut(m.id, photo);
      }
      const c = (liveList || []).find((x) => x.id === id);
      if (c) {
        c.last = lastOf(m);
        liveList.sort(byLast);
      } else LIVE.send({ t: 'list' });
      if (chat.open !== id) return;
      const i = chat.msgs.findIndex((x) => x.id === 'tmp');
      if (i >= 0) chat.msgs.splice(i, 1);
      if (!chat.msgs.some((x) => x.id === m.id)) chat.msgs.push(m);
      render();
      scrollChat();
      return;
    }
    const r = await LIVE.ask({ t: 'open', ch: id, find: opt.find || '' });
    if (chat.open !== id) return;
    chat.msgs = r.messages.map(liveMsg);
    chat.seen = r.seen || [];
    chat.dlv = r.dlv || [];
    chat.me = liveMe || chat.me;
    chat.loaded = id;
    const c = (liveList || []).find((x) => x.id === id);
    if (c) c.unread = 0;
    const near = isNearBottom();
    render();
    if (opt.find) jumpTo(opt.find);
    else if (near) scrollChat();
  } catch (e) {
    const m = String((e && e.message) || e).replace(/^(Error|Exception):\s*/, '');
    if (text !== undefined) {
      chat.compose = text || '';
      setDraft(id, text);
      if (photo) chat.photo = photo;
      if (opt.file) chat.file = opt.file;
      if (opt.reply) chat.reply = opt.reply;
      const i = (chat.msgs || []).findIndex((x) => x.id === 'tmp');
      if (i >= 0) chat.msgs.splice(i, 1);
      toast('Not sent: ' + m);
      render();
    } else if (chat.loaded !== id) toast(m);
  }
}
function liveMake(p, done) {
  LIVE.ask(Object.assign({ t: 'newch' }, p)).then(
    (r) => {
      toast(done);
      if (r.id) openChat(r.id);
    },
    (e) => toast(e.message)
  );
}

/* ---------- chat photos: shrunk on the phone before sending, cached on each phone after the first load ---------- */
const picCache = {},
  picLoading = {};
let picQueue = [],
  picActive = 0;
const idb = (() => {
  let p = null;
  return () =>
    p ||
    (p = new Promise((res, rej) => {
      const q = indexedDB.open('pt-photos', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('p');
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    }));
})();
async function idbGet(k) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction('p').objectStore('p').get(k);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  } catch (_) {
    return null;
  }
}
async function idbPut(k, v) {
  try {
    const db = await idb();
    db.transaction('p', 'readwrite').objectStore('p').put(v, k);
  } catch (_) {}
}
/* ---------- chat PDFs: sent through the live chat, opened with a short-lived link in the phone's own viewer ---------- */
const fileLinks = {};
const fileSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const SVG_DOC =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>';
function fileTag(m) {
  const name = esc(m.file),
    real = m.id !== 'tmp';
  if (m.expired) return `<div class="fcard exp">${SVG_DOC}<span><b>${name}</b><small>File expired</small></span></div>`;
  const l = fileLinks[m.id],
    fresh = l && l.exp * 1000 - Date.now() > 10 * 60000;
  if (real && LIVE && !fresh) loadLink(m.id);
  const sub = !real ? (m.size ? fileSize(m.size) + ' · ' : '') + 'Sending…' : 'PDF · Tap to open';
  return `<a class="fcard" ${fresh ? `href="${esc(l.url)}" target="_blank" rel="noopener"` : 'href="#" role="button"'} data-file="${esc(m.id)}">${SVG_DOC}<span><b>${name}</b><small>${sub}</small></span></a>`;
}
function loadLink(id) {
  if (fileLinks[id] && fileLinks[id].busy) return Promise.resolve(fileLinks[id].busy);
  const p = LIVE.link(id)
    .then((j) => {
      fileLinks[id] = j;
      document.querySelectorAll(`[data-file="${CSS.escape(id)}"]`).forEach((a) => {
        a.href = j.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.removeAttribute('role');
      });
      return j;
    })
    .catch((e) => {
      delete fileLinks[id];
      throw e;
    });
  fileLinks[id] = Object.assign(fileLinks[id] || {}, { busy: p });
  return p;
}
function openFile(e, a) {
  const id = a.dataset.file,
    l = fileLinks[id];
  if (l && l.url && l.exp * 1000 - Date.now() > 60000) return; // a normal link: the phone opens it
  e.preventDefault();
  if (!LIVE || id === 'tmp') return;
  const w = window.open('', '_blank'); // opened during the tap so it isn't blocked, then pointed at the file
  loadLink(id)
    .then((j) => {
      if (w) w.location.href = j.url;
      else toast('Ready – tap the file again to open it');
    })
    .catch((err) => {
      if (w) w.close();
      toast(/expired|gone/i.test(String(err.message)) ? 'That file has expired' : err.message);
    });
}
function picTag(m) {
  const src = m.local || picCache[m.id];
  if (!src && m.id !== 'tmp') loadPic(m.id);
  return `<button type="button" class="pic ${src ? '' : 'loading'}" data-pic="${esc(m.id)}" aria-label="Open photo">${src ? `<img src="${src}" alt="Photo from ${esc(m.from)}">` : '<span>Loading photo…</span>'}</button>`;
}
function showPic(id, src) {
  document.querySelectorAll(`[data-pic="${CSS.escape(id)}"]`).forEach((b) => {
    const near = isNearBottom();
    b.classList.remove('loading');
    b.innerHTML = `<img src="${src}" alt="Photo">`;
    const img = b.querySelector('img');
    if (near && img) img.onload = scrollChat;
  });
}
function loadPic(id) {
  if (picLoading[id] || picCache[id]) return;
  picLoading[id] = 1;
  idbGet(id).then((hit) => {
    if (hit) {
      picCache[id] = hit;
      showPic(id, hit);
      return;
    }
    picQueue.push(id);
    pumpPics();
  });
}
function pumpPics() {
  while (picActive < 2 && picQueue.length) {
    const id = picQueue.shift();
    picActive++;
    (LIVE
      ? LIVE.photo(id)
      : post({ fn: 'photo', token: TOKEN, id }).then((r) => 'data:' + r.mime + ';base64,' + r.data)
    )
      .then((src) => {
        picCache[id] = src;
        idbPut(id, src);
        showPic(id, src);
      })
      .catch((e) => {
        delete picLoading[id];
        document.querySelectorAll(`[data-pic="${CSS.escape(id)}"] span`).forEach((x) => {
          x.textContent = /expired|gone/i.test(String(e.message)) ? 'Photo expired' : "Couldn't load – tap to retry";
        });
      })
      .finally(() => {
        picActive--;
        pumpPics();
      });
  }
}
/** Shrink a picked photo to fit 1600px and re-encode as JPEG (about 200–500 KB). */
function shrinkPhoto(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file),
      img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)),
        c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("That photo couldn't be opened – try a JPEG or PNG"));
    };
    img.src = url;
  });
}
function zoomPic(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Photo');
  box.innerHTML = `<img src="${src}" alt="Photo"><button type="button" class="btn sm">Close</button>`;
  box.addEventListener('click', () => box.remove());
  document.addEventListener('keydown', function k(e) {
    if (e.key === 'Escape') {
      box.remove();
      document.removeEventListener('keydown', k);
    }
  });
  document.body.appendChild(box);
}
// The handler sits on the input itself: the chat redraws every few seconds, and a redraw while the photo picker is open
// swaps out the input, so a page-level listener would never hear about the photo that was picked.
async function pickPhoto(inp) {
  if (!inp || !inp.files || !inp.files[0]) return;
  const file = inp.files[0];
  inp.value = '';
  const t = $('.composer textarea');
  if (t) chat.compose = t.value;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
    if (!LIVE) {
      toast('PDFs need the live chat – try again in a moment');
      return;
    }
    if (file.size > 10 * 1048576) {
      toast('That PDF is too big – 10 MB at most');
      return;
    }
    chat.file = {
      name: file.name || 'Document.pdf',
      blob: file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' }),
    };
    chat.photo = '';
    render();
    const t2 = $('.composer textarea');
    if (t2) t2.focus();
    scrollChat();
    return;
  }
  try {
    chat.file = null;
    chat.photo = await shrinkPhoto(file);
    render();
    const t2 = $('.composer textarea');
    if (t2) t2.focus();
    scrollChat();
  } catch (err) {
    toast(err.message);
  }
}
window.pickPhoto = pickPhoto;
const isNearBottom = () => {
  const m = $('#msgs');
  return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 80;
};
const scrollChat = () => {
  const m = $('#msgs');
  if (m) m.scrollTop = m.scrollHeight;
};
function pickSheet(kind) {
  const people = (data.people || []).filter((p) => p.id !== data.meId);
  return `<div class="sheet" role="dialog"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${kind === 'dm' ? 'New message' : kind === 'group' ? 'New group' : 'New channel'}</h1><button class="btn sm" data-closesheet>Close</button></div>
    ${
      kind === 'dm'
        ? `<div class="card"><button class="row rb" data-newgroup><span class="av grp sm" style="--av:#2B7A8A" aria-hidden="true">+</span><div class="txt"><b>New group</b></div><span>›</span></button>${lead() ? '<button class="row rb" data-newchannel><span class="av ch sm" style="--av:#1E5662" aria-hidden="true">#</span><div class="txt"><b>New channel</b></div><span>›</span></button>' : ''}</div><h2>People</h2><div class="card">${people.map((p) => rowBtn(`data-dm="${esc(p.id)}" data-dmname="${esc(p.name)}"`, `${avatar({ id: p.id, name: p.name }, 36)}<div class="txt"><b>${esc(p.name)}</b>${levelPill(p.name)}${activeLabel(p.id) ? `<div class="sub">${activeLabel(p.id)}</div>` : ''}</div><span>›</span>`)).join('')}</div>`
        : `<form class="stack" data-form="${kind}" style="padding:0"><label class="f">Name<input name="name" maxlength="40" placeholder="${kind === 'group' ? 'e.g. Weekend crew' : 'e.g. Catering'}"></label>
        ${
          kind === 'group'
            ? `<div class="card">${people.map((p) => `<label class="row" style="gap:10px"><input type="checkbox" name="m" value="${esc(p.id)}" style="width:auto;min-height:0"> ${esc(p.name)}</label>`).join('')}</div>`
            : `<label class="f">Who sees it<select name="who"><option>Everyone</option><option>Leads and managers</option><option>Managers</option></select></label>`
        }
        <button class="btn go">Create</button></form>`
    }</div></div>`;
}

/* ----- reminders ----- */
/* ---------- push notifications ---------- */
const pushOK = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushNeedsHome = () => isIOS() && !standalone();
const deviceKind = () =>
  /iphone/i.test(navigator.userAgent)
    ? 'iPhone'
    : /ipad/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /android/i.test(navigator.userAgent)
        ? 'phone'
        : 'computer';
const deviceName = () => {
  const ua = navigator.userAgent;
  return (
    (/iphone/i.test(ua)
      ? 'iPhone'
      : /ipad/i.test(ua)
        ? 'iPad'
        : /android/i.test(ua)
          ? 'Android'
          : /mac/i.test(ua)
            ? 'Mac'
            : /windows/i.test(ua)
              ? 'Windows'
              : 'Device') +
    ' · ' +
    (/edg\//i.test(ua)
      ? 'Edge'
      : /chrome|crios/i.test(ua)
        ? 'Chrome'
        : /firefox|fxios/i.test(ua)
          ? 'Firefox'
          : /safari/i.test(ua)
            ? 'Safari'
            : 'Browser') +
    (standalone() ? ' app' : '')
  );
};
const b64u8 = (b) => {
  b = String(b).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
};
let pushSub = null,
  pushChecked = false;
const pushOn_ = () => !!(pushSub && pushOK() && Notification.permission === 'granted');
/** After the data loads: find this device's subscription, and make sure the server has it (covers renewed subscriptions). */
/* Is this device subscribed? Asked of the app's background worker once it's running (navigator.serviceWorker.ready) –
   asking too early (before the worker has started, which fast loading made common) found nothing and showed Off for good.
   Re-checked whenever the app comes back to the screen and when Settings/Notifications open. */
let pushAt = 0;
async function pushCheck(force) {
  if (!pushOK() || !data || !data.push || pushChecked === 'busy' || shop()) return; // no notifications on the shop iPad
  if (!force && pushChecked && Date.now() - pushAt < 5000) return;
  pushChecked = 'busy';
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((r) => setTimeout(() => r(null), 10000)),
    ]);
    if (!reg) {
      pushChecked = false;
      return;
    } // worker still not running: try again next time
    const was = !!pushSub;
    pushSub = await reg.pushManager.getSubscription();
    pushChecked = true;
    pushAt = Date.now();
    if (
      pushSub &&
      data.push.ready &&
      Notification.permission === 'granted' &&
      (data.push.devices || []).indexOf(pushSub.endpoint) < 0
    )
      act('pushSub', { sub: JSON.stringify(pushSub), device: deviceName() });
    if (was !== !!pushSub) render();
  } catch (_) {
    pushChecked = false;
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pushCheck(true);
});
async function pushTurnOn() {
  if (pushNeedsHome()) {
    moreView = 'push';
    tab = 'more';
    render();
    return;
  }
  if (!pushOK()) {
    toast("This browser can't get notifications");
    return;
  }
  const perm = await Notification.requestPermission(); // first thing in the tap, so the browser allows the prompt
  if (perm !== 'granted') {
    toast(
      perm === 'denied'
        ? 'Notifications are blocked – allow them in Settings for this app'
        : 'Notifications not turned on'
    );
    render();
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready,
      key = b64u8(data.push.key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey) {
      const old = new Uint8Array(sub.options.applicationServerKey);
      if (old.length !== key.length || old.some((x, i) => x !== key[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub = sub || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    pushSub = sub;
    render();
    const r = await act('pushSub', { sub: JSON.stringify(sub), device: deviceName() });
    if (r) toast('Notifications on');
  } catch (e) {
    toast("Couldn't turn on notifications: " + (e.message || e));
  }
}
async function pushTurnOff() {
  const sub = pushSub;
  pushSub = null;
  render();
  if (sub) {
    act('pushUnsub', { endpoint: sub.endpoint });
    try {
      await sub.unsubscribe();
    } catch (_) {}
  }
  toast('Notifications off on this ' + deviceKind());
}
function viewPush() {
  pushCheck(); // re-check this device whenever the screen opens
  const P = data.push || {},
    pr = P.prefs || {},
    on = pushOn_(),
    back = '<button class="btn sm" data-more="settings">‹ Settings</button>';
  let top;
  if (!P.ready)
    top = `<div class="empty">Push notifications aren't set up for the shop yet.${mgr() ? ' Fill in the Push settings in the sheet.' : ' Ask a manager.'}</div>`;
  else if (pushNeedsHome())
    top = `<div class="row"><div class="txt"><b>First, add the app to your Home Screen</b><div class="sub">iPhones only send notifications to apps on the Home Screen.<br>1. Tap the Share button <b>⎋</b> at the bottom of Safari.<br>2. Tap <b>Add to Home Screen</b>, then <b>Add</b>.<br>3. Open Peregrine from your Home Screen and come back here.</div></div></div>`;
  else if (!pushOK())
    top = '<div class="empty">This browser can\'t get notifications. On iPhone you need iOS 16.4 or newer.</div>';
  else if (Notification.permission === 'denied')
    top = `<div class="row"><div class="txt"><b>Notifications are blocked</b><div class="sub">${isIOS() ? 'Open iPhone Settings › Notifications › Peregrine and allow them, then come back.' : "Allow notifications for this site in the browser's site settings, then reload."}</div></div></div>`;
  else
    top = on
      ? `<div class="row"><div class="txt"><b>On for this ${deviceKind()}</b><div class="sub">${esc(deviceName())}</div></div><span class="pill ok">On</span></div>
      <div class="row"><div class="btns" style="margin:0"><button class="btn sm" data-pushtest>Send a test</button><button class="btn sm" data-pushoff>Turn off here</button></div></div>`
      : `<div class="row"><div class="txt"><b>Off on this ${deviceKind()}</b><div class="sub">Get notified about new messages, schedule changes and prep, even when the app is closed.</div></div></div>
      <div class="row"><button class="btn go" data-pushon>Turn on notifications</button></div>`;
  const tog = (k, label, sub) =>
    `<div class="row"><div class="txt"><b>${label}</b><div class="sub">${sub}</div></div><button class="btn sm ${pr[k] !== false ? 'go' : ''}" data-pushpref="${k}" data-v="${pr[k] !== false ? 0 : 1}" aria-pressed="${pr[k] !== false}">${pr[k] !== false ? 'On' : 'Off'}</button></div>`;
  const n = (P.devices || []).length;
  return `<div class="weeknav" style="margin-bottom:8px">${back}<b>Notifications</b><span style="width:60px"></span></div>
    <div class="card">${top}</div>
    ${
      P.ready
        ? `<h2>What to send me</h2><div class="card">
      <div class="row"><div class="txt"><b>Messages</b><div class="sub">Direct only = DMs and groups, not channels</div></div></div>
      <div class="row"><div class="seg" style="flex:1;margin:0">${[
        ['all', 'All'],
        ['direct', 'Direct only'],
        ['off', 'Off'],
      ]
        .map(
          ([k, l]) =>
            `<button data-pushpref="msg" data-v="${k}" aria-pressed="${(pr.msg || 'all') === k}">${l}</button>`
        )
        .join('')}</div></div>
      ${tog('schedule', 'Schedule', "When a schedule you're on is posted or changed")}
      ${tog('prep', 'Prep', 'When someone asks your shift to prep something')}
      ${tog('remind', 'Shift reminders', 'At the times you picked under Shift reminders')}
      ${tog('news', 'Announcements', 'New posts from managers and leads')}</div>
      <p class="sub">These apply to every device you've turned notifications on (${n} so far).</p>`
        : ''
    }
    <h2>Privacy</h2><div class="card">${tog('active', "Show when I'm active", 'Others see "Active now" or "Active 20 min ago" next to your name in Messages')}</div>`;
}
/** Open the screen a notification (or a ?go= link) points at. */
function goTo(go) {
  go = String(go || '');
  if (!go || !data) return;
  const [where, arg] = go.split(':');
  sheet = null;
  viewer = null;
  if (where === 'chat') {
    tab = 'chat';
    save('pt-tab', tab);
    if (arg) openChat(arg);
    else render();
    return;
  }
  stopChat();
  if (where === 'more') {
    tab = 'more';
    moreView = arg || '';
  } else if (where === 'lists') {
    tab = 'lists';
    if (arg === 'prep') listTab = PREP;
  } else if (/^(schedule|today|tests)$/.test(where)) tab = where;
  save('pt-tab', tab);
  window.scrollTo(0, 0);
  render();
}
function viewReminders() {
  const me = data.me,
    R = data.reminders || {},
    cal = API && me.cal ? API + '?cal=' + encodeURIComponent(me.cal) : '';
  const webcal = cal.replace(/^https?:/, 'webcal:');
  const my = me.remind || {},
    night = my.night || hm24(R.night) || '19:00',
    morning = my.morning || '07:00',
    before = my.before || (R.hours || 2) * 60;
  const modes = [
    ['Night before', 'The night before'],
    ['Morning of', 'The morning of'],
    ['Before shift', 'A little before it starts'],
    ['Both', 'Night before + before it starts'],
    ['Morning and before', 'Morning of + before it starts'],
    ['Off', 'Off'],
  ];
  const times = (from, to, step) => {
    const o = [];
    for (let m = from; m <= to; m += step) o.push(pad(Math.floor(m / 60)) + ':' + pad(m % 60));
    return o;
  };
  const sel = (name, list, cur, label) =>
    `<select name="${name}">${(list.indexOf(cur) < 0 ? [cur].concat(list) : list).map((x) => `<option value="${x}" ${x === cur ? 'selected' : ''}>${esc(label(x))}</option>`).join('')}</select>`;
  const lead = (m) => (m < 60 ? m + ' minutes before' : m / 60 + (m === 60 ? ' hour' : ' hours') + ' before');
  const show = remShow(me.reminders);
  return `${back('settings')}<h1>Shift reminders</h1>
    ${R.on ? '' : '<div class="hint">Shift reminders are turned off for the shop right now. A manager can turn them on in the sheet\'s Settings.</div>'}
    ${
      R.on && R.by !== 'email'
        ? pushOn_()
          ? '<div class="hint">Reminders come as a notification on this ' + deviceKind() + '.</div>'
          : `<div class="hint"><b>Turn on notifications to get your reminders</b>${R.by === 'push' ? " – they don't go by email." : '.'} <div class="btns" style="margin-top:8px"><button class="btn sm go" data-more="push">Turn on notifications</button></div></div>`
        : ''
    }
    <div class="card"><form class="stack" data-form="reminders">
      ${R.by && R.by !== 'push' ? `<label class="f">Email for reminders<input name="email" type="email" autocomplete="email" maxlength="120" value="${esc(me.email || '')}" placeholder="you@example.com"></label>` : ''}
      <div class="f" style="display:grid;gap:6px;font-size:.8rem;color:var(--muted)">When to remind me
        ${modes.map(([k, n]) => `<label class="opt"><input type="radio" name="mode" value="${k}" ${me.reminders === k ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>
      <label class="f" data-rem="night" ${show.night ? '' : 'hidden'}>Night-before reminder at${sel('night', times(15 * 60, 23 * 60, 30), night, t12)}</label>
      <label class="f" data-rem="morning" ${show.morning ? '' : 'hidden'}>Morning reminder at${sel('morning', times(4 * 60, 12 * 60, 30), morning, t12)}<span class="sub">If your shift starts before this, you'll get the before-shift one (or none).</span></label>
      <label class="f" data-rem="before" ${show.before ? '' : 'hidden'}>How long before the shift${sel('before', [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720], before, lead)}</label>
      <div class="btns"><button class="btn go">Save</button>${me.email && R.by && R.by !== 'push' ? '<button type="button" class="btn" data-testmail>Send me a test</button>' : ''}</div></form></div>
    ${
      cal
        ? `<h2>Put your shifts in your calendar</h2><div class="card"><div class="row" style="display:block">
      <p style="margin:0 0 10px">Your shifts show up in your phone's calendar and update by themselves, with an alert 1 hour before each one.</p>
      <div class="btns"><a class="btn go" href="${esc(webcal)}">iPhone / Mac calendar</a><button class="btn" data-copycal="${esc(cal)}">Copy link for Google Calendar</button></div>
      <details class="more" style="margin-top:10px"><summary>How to set it up</summary><div class="sub">
        <b>iPhone:</b> tap the first button, then Subscribe. To get the 1-hour alerts: Settings › Calendar › Accounts › Subscribed Calendars › this calendar › turn off <i>Remove Alerts</i>.<br>
        <b>Google Calendar:</b> copy the link, then on a computer go to calendar.google.com › Other calendars › + › From URL, and paste it. Google refreshes it every few hours, so last-minute changes can show up late – the emails are faster.<br>
        This link is private to you. If you get a new sign-in code, the old link stops working and you'll need to add it again.</div></details></div></div>`
        : ''
    }`;
}
const hm24 = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? pad(+m[1]) + ':' + m[2] : '';
};
const remShow = (mode) => ({
  night: /Night before|^Both$/.test(mode || ''),
  morning: /Morning/.test(mode || ''),
  before: /Before shift|Both|and before/.test(mode || ''),
});
document.addEventListener('change', (e) => {
  const f = e.target.closest && e.target.closest('form[data-form=reminders]');
  if (!f || e.target.name !== 'mode') return;
  const s = remShow(e.target.value);
  f.querySelectorAll('[data-rem]').forEach((x) => {
    x.hidden = !s[x.dataset.rem];
  });
});
document.addEventListener('change', (e) => {
  const f = e.target.closest && e.target.closest('form[data-form=request]');
  if (!f) return;
  const thru = f.querySelector('[data-reqthru]'),
    until = f.elements.namedItem('until'),
    first = f.elements.namedItem('date');
  if (e.target.name === 'type' && thru) thru.hidden = e.target.value !== 'Time off';
  if (e.target.name === 'date' && until) {
    until.min = first.value;
    if (until.value && until.value < first.value) until.value = '';
  }
});
/* ----- announcements ----- */
function annRow(a) {
  return `<div class="row" style="display:block"><div style="display:flex;gap:8px;align-items:baseline"><b style="flex:1">${a.pinned ? '📌 ' : ''}${esc(a.title)}</b><span class="sub">${ago(a.posted)}</span></div>
    ${a.message ? `<div class="msg">${linkify(esc(a.message))}</div>` : ''}<div class="sub">From ${esc(a.from)}${a.mustAck ? ' · must acknowledge' : ''}</div>
    <div class="btns" style="margin-top:8px">${a.read ? '<span class="pill ok">Seen</span>' : `<button class="btn sm go" data-read="${esc(a.id)}">Got it</button>`}
      ${lead() && a.notRead ? `<span class="sub" style="align-self:center">${a.notRead.length ? 'Not seen: ' + a.notRead.map(esc).join(', ') : 'Everyone has seen it'}</span>` : ''}
      ${lead() ? `<button class="btn sm" data-unann="${esc(a.id)}">Remove</button>` : ''}</div></div>`;
}
function viewNews() {
  const postF = lead()
    ? `<h2>Post an announcement</h2><div class="card"><form class="stack" data-form="announce"><label class="f">Title<input name="title" maxlength="150"></label>
      <label class="f">Message<textarea name="message" maxlength="3000"></textarea></label>
      <label style="display:flex;gap:8px;align-items:center;font-size:.9rem"><input type="checkbox" name="mustAck" ${mgr() ? 'checked' : ''} style="width:auto;min-height:0"> Everyone must read it before using the app</label>
      <label style="display:flex;gap:8px;align-items:center;font-size:.9rem"><input type="checkbox" name="pinned" style="width:auto;min-height:0"> Pin to the top</label><button class="btn go">Post</button></form></div>`
    : '';
  return `${back()}<h1>Announcements</h1><div class="card">${(data.announcements || []).map(annRow).join('') || '<div class="empty">No announcements.</div>'}</div>${postF}`;
}

/* ----- requests ----- */
function reqRow(q) {
  const cls = q.status === 'Approved' ? 'ok' : q.status === 'Denied' ? 'warn' : 'mute';
  return `<div class="row" style="display:block"><div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(q.type)} · ${reqWhen(q)}</b><span class="pill ${cls}">${esc(q.status)}</span></div>
    <div class="sub">${mgr() && q.from !== data.me.name ? esc(q.from) + ' · ' : ''}${esc(q.details)}${q.note ? ' — ' + esc(q.by) + ': ' + esc(q.note) : ''}</div>
    ${q.type === 'Cover' && q.takenBy ? `<div class="sub"><b>${esc(q.takenBy)}</b> offered to take it${q.status === 'Approved' ? ' · the shift is theirs now' : ''}</div>` : ''}
    ${q.status === 'Pending' && mgr() ? `<div class="btns" style="margin-top:8px"><button class="btn sm go" data-decide="${esc(q.id)}" data-ok="1">${q.type === 'Cover' && q.takenBy && q.shift ? 'Approve · give it to ' + esc(first(q.takenBy)) : 'Approve'}</button><button class="btn sm" data-decide="${esc(q.id)}" data-ok="0">Deny</button>${((n) => (n ? `<span class="pill warn" style="align-self:center">Scheduled ${q.until ? n + (n > 1 ? ' shifts' : ' shift') + ' in this time' : 'that day'}</span>` : ''))(Array.from({ length: offDays(q) }, (_, k) => plus(q.date, k)).reduce((a, d) => a + shiftsOn(d).filter((s) => s.name === q.from).length, 0))}</div>` : ''}
    ${reqCanChange(q) ? `<div class="btns" style="margin-top:8px"><button class="btn sm" data-editreq="${esc(q.id)}">Edit</button><button class="btn sm" data-cancelreq="${esc(q.id)}">${q.status === 'Approved' ? 'Cancel time off' : 'Cancel request'}</button></div>` : ''}</div>`;
}
/** Your own pending or approved request that hasn't finished yet – or anyone's, for a manager. */
const reqCanChange = (q) =>
  !String(q.id).startsWith('tmp') &&
  (q.status === 'Pending' || q.status === 'Approved') &&
  (q.from === data.me.name || mgr()) &&
  (mgr() || (q.until || q.date) >= T());
function reqEditSheet() {
  const q = (data.requests || []).find((x) => x.id === sheet.id);
  if (!q) return '';
  const off = q.type === 'Time off',
    mine = q.from === data.me.name;
  return `<div class="sheet" role="dialog" aria-label="Edit request"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">Edit ${esc(q.type.toLowerCase())}</h1><button class="btn sm" data-closesheet>Close</button></div>
    ${mine ? '' : `<p class="sub" style="margin:0">${esc(q.from)}'s request</p>`}
    <form class="stack" data-form="reqedit" style="padding:0">
      <label class="f">${off ? 'First day' : 'Date'}<input name="date" type="date" ${mgr() ? '' : `min="${T()}"`} value="${esc(q.date)}"></label>
      ${off ? `<label class="f">Last day<input name="until" type="date" min="${esc(q.date)}" value="${esc(q.until || '')}"><span class="sub">Leave blank for one day.</span></label>` : ''}
      <label class="f">Details<textarea name="details" maxlength="1000">${esc(q.details)}</textarea></label>
      ${q.status === 'Approved' && mine && !mgr() ? '<p class="sub" style="margin:0">This is approved. Changing it sends it back to a manager to approve again.</p>' : ''}
      <button class="btn go">Save changes</button></form></div></div>`;
}
const DAYS_ = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday',
};
/** Times for the availability picker: every half hour, 5am–11:30pm, plus whatever is already saved. */
function availTimes(extra) {
  const out = [];
  for (let m = 5 * 60; m <= 23 * 60 + 30; m += 30) out.push(pad(Math.floor(m / 60)) + ':' + pad(m % 60));
  extra.filter(Boolean).forEach((t) => {
    if (out.indexOf(t) < 0) out.push(t);
  });
  return out.sort();
}
/* Adding and editing a time you can't work happen in one pop-up: day, all day or the times, a note, and Save – no
   separate time pickers to open and close (the phone's own time wheel made people leave the pop-up to set the end time). */
function availEditSheet() {
  const isNew = !sheet.id,
    a = isNew
      ? { name: data.me.name, day: sheet.day || 'Mon', from: '', to: '', note: '' }
      : (data.availability || []).find((x) => x.id === sheet.id);
  if (!a) return '';
  const isDate = /^\d{4}-/.test(a.day),
    from = hm24(a.from),
    to = hm24(a.to),
    part = !!(from || to),
    times = availTimes([from, to]);
  const col = (k, cur) =>
    `<div class="tpcol"><div class="tphead">${k === 'from' ? 'Starts' : 'Ends'}</div><div class="tplist" data-tplist="${k}" role="listbox" aria-label="${k === 'from' ? 'Start time' : 'End time'}">${times.map((t) => `<button type="button" class="tpopt ${t === cur ? 'on' : ''}" data-tpick="${k}|${t}" role="option" aria-selected="${t === cur}">${t12(t)}</button>`).join('')}</div></div>`;
  return `<div class="sheet" role="dialog" aria-label="${isNew ? 'Add' : 'Edit'} a time you can't work"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${isNew ? "Add a time you can't work" : "Edit time you can't work"}</h1><button class="btn sm" data-closesheet>Close</button></div>
    ${a.name !== data.me.name ? `<p class="sub" style="margin:0">${esc(a.name)}</p>` : ''}
    <form class="stack" data-form="availedit" style="padding:0">
      <label class="f">When<select name="day">${Object.keys(DAYS_)
        .map((x) => `<option value="${x}" ${a.day === x ? 'selected' : ''}>Every ${DAYS_[x]}</option>`)
        .join('')}<option value="date" ${isDate ? 'selected' : ''}>One date…</option></select></label>
      <label class="f" data-onlydate ${isDate ? '' : 'hidden'}>Date<input name="date" type="date" ${isNew ? `min="${T()}"` : ''} value="${isDate ? esc(a.day) : ''}"></label>
      <div class="seg" role="radiogroup" aria-label="How long"><label class="segopt"><input type="radio" name="span" value="all" ${part ? '' : 'checked'}> All day</label><label class="segopt"><input type="radio" name="span" value="part" ${part ? 'checked' : ''}> Part of the day</label></div>
      <div class="tppick" data-tppick ${part ? '' : 'hidden'}>${col('from', from)}${col('to', to)}</div>
      <input type="hidden" name="from" value="${esc(from)}"><input type="hidden" name="to" value="${esc(to)}">
      <div class="sub" data-tpsum aria-live="polite"></div>
      <label class="f">Note (optional)<input name="note" maxlength="200" value="${esc(a.note || '')}" placeholder="e.g. Class"></label>
      <button class="btn go">${isNew ? 'Add' : 'Save changes'}</button></form></div></div>`;
}
/** Keep the time lists, the summary line and the end times in step with what's picked. */
function syncAvailPick(f) {
  if (!f) return;
  const part = (f.querySelector('input[name=span]:checked') || {}).value === 'part',
    from = f.elements.namedItem('from').value,
    to = f.elements.namedItem('to').value;
  const pick = f.querySelector('[data-tppick]');
  if (pick) pick.hidden = !part;
  f.querySelectorAll('[data-tpick]').forEach((b) => {
    const [k, t] = b.dataset.tpick.split('|'),
      on = (k === 'from' ? from : to) === t;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
    b.disabled = k === 'to' && !!from && t <= from;
  });
  const sum = f.querySelector('[data-tpsum]');
  if (sum)
    sum.textContent = !part
      ? "You can't work any time that day."
      : from && to
        ? "Can't work " + t12(from) + ' – ' + t12(to) + '.'
        : from
          ? 'Now pick when it ends.'
          : 'Pick when it starts and when it ends.';
}
function scrollAvailPick(f) {
  if (!f) return;
  f.querySelectorAll('.tplist').forEach((l) => {
    const on = l.querySelector('.tpopt.on') || l.querySelector('.tpopt:not([disabled])');
    if (on) l.scrollTop = Math.max(0, on.offsetTop - l.offsetTop - 60);
  });
}
document.addEventListener('change', (e) => {
  const f = e.target.closest && e.target.closest('form[data-form=availedit]');
  if (!f || e.target.name !== 'span') return;
  if (e.target.value === 'all') {
    f.elements.namedItem('from').value = '';
    f.elements.namedItem('to').value = '';
  }
  syncAvailPick(f);
  if (e.target.value === 'part') scrollAvailPick(f);
});
/** Open shifts: cover requests from others that anyone can offer to take. */
function openShiftRow(q) {
  const s = (data.shifts || []).find((x) => x.id === q.shift),
    mineOffer = q.takenBy === data.me.name;
  return `<div class="row"><div class="txt"><b>${esc(shortDay(q.date))}${s ? ' · ' + t12(s.start) + '–' + t12(s.end) : ''}</b><div class="sub">${esc(first(q.from))}'s shift${s && s.position ? ' · ' + esc(s.position) : ''}${q.details ? ' · ' + esc(q.details) : ''}</div>${q.takenBy ? `<div class="sub">${mineOffer ? 'You offered to take it · waiting on a manager' : esc(first(q.takenBy)) + ' offered to take it'}</div>` : ''}</div>
    ${q.from === data.me.name || mgr() ? '' : mineOffer ? `<button class="btn sm" data-takeshift="${esc(q.id)}" data-undo="1">Withdraw</button>` : q.takenBy ? '' : `<button class="btn sm go" data-takeshift="${esc(q.id)}">I can take it</button>`}</div>`;
}
function viewRequests() {
  const all = (data.requests || []).filter((q) => q.status !== 'Cancelled'),
    pend = mgr() ? all.filter((q) => q.status === 'Pending' && q.from !== data.me.name) : [];
  const open = all.filter((q) => q.type === 'Cover' && q.status === 'Pending' && q.date >= T() && q.from !== data.me.name && !mgr());
  const myShifts = (data.shifts || []).filter((x) => x.name === data.me.name && x.date >= T() && x.status !== 'draft').slice(0, 20);
  const mine = all.filter((q) => q.from === data.me.name),
    others = mgr() ? all.filter((q) => q.status !== 'Pending' && q.from !== data.me.name) : [];
  return `${back()}<h1>Requests</h1>
    ${mgr() ? `<h2>Waiting for you</h2><div class="card">${pend.map(reqRow).join('') || '<div class="empty">All caught up. Nothing to approve.</div>'}</div>` : ''}
    ${open.length ? `<h2>Open shifts</h2><div class="card">${open.map(openShiftRow).join('')}</div>` : ''}
    <h2>New request</h2><div class="card"><form class="stack" data-form="request">
      <label class="f">What<select name="type"><option>Time off</option><option>Swap</option><option value="Cover">Cover (post my shift for pickup)</option></select></label>
      ${myShifts.length ? `<label class="f" data-reqshift hidden>Which shift<select name="shift"><option value="">Pick a shift</option>${myShifts.map((x) => `<option value="${esc(x.id)}" data-date="${esc(x.date)}">${esc(shortDay(x.date))} · ${t12(x.start)}–${t12(x.end)}</option>`).join('')}</select></label>` : ''}
      <label class="f">First day<input name="date" type="date" min="${T()}" value="${plus(T(), 1)}"></label>
      <label class="f" data-reqthru>Last day<input name="until" type="date" min="${T()}"><span class="sub">Leave blank for one day.</span></label>
      <label class="f">Details<textarea name="details" maxlength="1000" placeholder="e.g. Swap my Saturday open with Kelsey"></textarea></label><button class="btn go">${mgr() ? 'Send' : 'Send to managers'}</button>${mgr() ? '<p class="sub">Your own time off is approved right away.</p>' : ''}</form></div>
    <h2>Yours</h2><div class="card">${mine.map(reqRow).join('') || '<div class="empty">Nothing yet. Need a day off, a swap, or someone to cover? Use the form above.</div>'}</div>
    ${others.length ? `<h2>Recently decided</h2><div class="card">${others.map(reqRow).join('')}</div>` : ''}
    <p class="sub">Regular times you can't work go under <button class="lnk" data-more="avail">Availability</button>.</p>`;
}

/* ----- recipes: the in-app recipe book (Recipes tab in the sheet; costs for managers from the COGS calculators) ----- */
let recSel = '',
  recKind = load('pt-reckind') || 'Drink',
  recScale = 1,
  recEdit = '', // '' | 'new' | a recipe id: managers editing in the app
  recCost = null,
  recCostBusy = false,
  wakeLock = null;
const RECIPES = () => data.recipes || [];
const canEditRec = () => mgr() && Number(data.version) >= 5.05;
const rnorm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const rbase = (s) =>
  rnorm(s)
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim();
const recById = (id) => RECIPES().find((r) => r.id === id);
// "2,000g coffee" → ["2,000g", "coffee"]; "Espresso shot" → ["", "Espresso shot"]
const AMT_RE =
  /^([~≈]?\s*(?:about\s+)?[\d½¼¾⅓⅔⅛][\d.,/½¼¾⅓⅔⅛]*(?:\s*[-–]\s*[\d.,/½¼¾⅓⅔⅛]+)?\s*(?:fl\.?\s?oz|kg|g|ml|l|oz|lb|gal|qt|quarts?|cups?|tsp|tbsp|drops?|shakes?|pumps?|shots?|sticks?|packs?|bottles?)?\.?)(?=\s|$)\s*(.*)$/i;
const splitAmt = (line) => {
  const m = String(line).match(AMT_RE);
  return m && m[2] ? [m[1].trim(), m[2]] : ['', line];
};
const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
/** Multiply the numbers in an amount ("2,000g" ×2 → "4,000g", "½ gal" ×3 → "1.5 gal"). */
function scaleAmt(a, k) {
  if (k === 1 || !a) return a;
  return a.replace(/(\d[\d,]*(?:\.\d+)?(?:\s*\/\s*\d+)?|\d*[½¼¾⅓⅔⅛])/g, (t) => {
    let v;
    if (/\//.test(t)) {
      const [x, y] = t.split('/').map((z) => Number(z.replace(/,/g, '')));
      v = x / y;
    } else {
      const f = t.slice(-1) in FRAC ? FRAC[t.slice(-1)] : 0;
      v = (Number((f ? t.slice(0, -1) : t).replace(/,/g, '')) || 0) + f;
    }
    v *= k;
    return v >= 100
      ? Math.round(v).toLocaleString('en-US')
      : v >= 10
        ? String(Math.round(v * 10) / 10)
        : String(Math.round(v * 100) / 100);
  });
}
const rmoney = (n, d) => (n == null ? '—' : '$' + Number(n).toFixed(d == null ? 2 : d));
async function loadRecCost(force) {
  if (!mgr() || recCostBusy || (!force && recCost && Date.now() - recCost.at < 600000)) return;
  recCostBusy = true;
  try {
    recCost = await post({ fn: 'recipeCosts', token: TOKEN });
    recCost.at = Date.now();
  } catch (e) {
    recCost = { menu: [], prep: [], errs: [String(e.message || e)], at: Date.now() };
  }
  recCostBusy = false;
  if (recSel || isRecView()) render();
}
/** The COGS rows for a recipe: names in its COGS column, else the same name (sizes in brackets ignored). */
function recCosts(r) {
  if (!recCost) return null;
  const pool = r.type === 'Prep' ? recCost.prep || [] : recCost.menu || [],
    names = r.cogs ? r.cogs.split('|').map(rnorm).filter(Boolean) : [rnorm(r.name)];
  let hits = pool.filter((x) => names.indexOf(rnorm(x.item)) >= 0);
  if (!hits.length && !r.cogs) hits = pool.filter((x) => rbase(x.item) === rnorm(r.name));
  return hits;
}
/** Where the recipe book opens: the shop iPad's recipe tab, or More › Recipes. */
function recHome() {
  if (shop()) {
    const g = resGroups().find((x) => /recipe/i.test(x));
    return g ? ['res:' + g, ''] : ['recipes', ''];
  }
  return ['more', 'recipes'];
}
const isRecView = () =>
  (tab === 'more' && moreView === 'recipes') ||
  tab === 'recipes' ||
  (/^res:/.test(tab) && /recipe/i.test(tab) && RECIPES().length > 0);
const recFavs = () => {
  try {
    return JSON.parse(load('pt-recfav') || '[]');
  } catch (e) {
    return [];
  }
};
const recRecent = () => {
  try {
    return JSON.parse(load('pt-recrecent') || '[]');
  } catch (e) {
    return [];
  }
};
let barMode = load('pt-barmode') === '1';
function openRecipe(id) {
  const r = recById(id);
  if (!r) return;
  save('pt-recrecent', JSON.stringify([id].concat(recRecent().filter((x) => x !== id)).slice(0, 8)));
  if (!isRecView()) {
    const [t, mv] = recHome();
    tab = t;
    moreView = mv;
    sheet = null;
    stopChat();
  }
  recSel = id;
  recKind = r.type;
  recScale = 1;
  window.scrollTo(0, 0);
  render();
  loadRecCost();
}
/** A prep item's recipe: the one it was picked from, else the one its name says ("Batch cold brew" → Cold Brew). */
function recipeFor(text, picked) {
  if (picked) {
    const r = RECIPES().find((y) => y.type === 'Prep' && rnorm(y.name) === rnorm(picked));
    if (r) return r;
  }
  const t = rnorm(text);
  if (!t) return null;
  return RECIPES().find((r) => r.type === 'Prep' && rbase(r.name).length >= 4 && t.indexOf(rbase(r.name)) >= 0) || null;
}
/** The prep recipe a checklist task is about: "Batch matcha" finds "Batched Matcha" (every word of the recipe's name, ignoring -s/-ed/-ing). */
const rstem = (w) => w.replace(/(ing|ed|es|s)$/, '');
const rwords = (t) =>
  rnorm(t)
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 3)
    .map(rstem);
function recipeForTask(task) {
  if (!on('recipes')) return null;
  const direct = recipeFor(task);
  if (direct) return direct;
  const have = new Set(rwords(task));
  return (
    RECIPES().find((r) => {
      if (r.type !== 'Prep') return false;
      const ws = rwords(rbase(r.name));
      return ws.length && ws.every((w) => have.has(w));
    }) || null
  );
}
/** Keep the screen on while a recipe is open (someone is following it with their hands full). */
function syncWake() {
  const want = (!!recSel || barMode) && isRecView() && !document.hidden; // bar mode keeps the whole recipe book awake
  try {
    if (want && !wakeLock && navigator.wakeLock)
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          wakeLock = l;
          l.addEventListener('release', () => (wakeLock = null));
        })
        .catch(() => {});
    if (!want && wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  } catch (_) {}
}
document.addEventListener('visibilitychange', syncWake);
function viewRecipes(o) {
  o = o || {};
  const rs = RECIPES();
  if (recEdit && canEditRec()) return viewRecipeEdit(recEdit === 'new' ? null : recById(recEdit), o);
  recEdit = '';
  if (recSel && recById(recSel)) return viewRecipe(recById(recSel), o);
  recSel = '';
  if (mgr()) loadRecCost();
  const head = `${o.back || ''}<div class="rb-hero"><div class="rb-mark" aria-hidden="true"></div><div><div class="rb-eye">Peregrine Coffee Roasters</div><h1>${esc(o.title && !/^recipes?$/i.test(o.title) ? o.title : 'Recipe Book')}</h1><div class="rb-sub">${rs.filter((r) => r.type === 'Drink').length} drinks · ${rs.filter((r) => r.type === 'Prep').length} prep</div></div></div>`;
  const docs = (o.docs || []).length ? `<h2>Documents</h2><div class="card">${o.docs.map(resRow).join('')}</div>` : '';
  if (!rs.length)
    return `${head}<div class="card"><div class="empty">${
      Number(data.version) < 5.04
        ? "The recipe book needs the server update (Code.gs 5.04) in this location's sheet."
        : mgr()
          ? 'No recipes yet. Add one here, or on the <b>Recipes</b> tab in the sheet.'
          : 'No recipes yet. Ask a manager to add the menu to the app.'
    }</div>${canEditRec() ? '<div class="btns" style="padding:0 14px 14px"><button class="btn go" data-recedit="new">+ Add a recipe</button></div>' : ''}${mgr() && data.recipeSheet ? `<div class="btns" style="padding:0 14px 14px"><a class="btn" href="${esc(data.recipeSheet)}" target="_blank" rel="noopener">Open the Recipes tab ↗</a></div>` : ''}</div>${docs}`;
  const kinds = ['Drink', 'Prep'].filter((k) => rs.some((r) => r.type === k));
  if (kinds.indexOf(recKind) < 0) recKind = kinds[0];
  const pct = (r) => {
    const h = mgr() && r.type === 'Drink' && recCosts(r);
    const x = h && h.find((y) => y.pct != null);
    return x ? `<span class="rb-pct ${/over/i.test(x.status) ? 'over' : ''}">${Math.round(x.pct)}%</span>` : '';
  };
  const card = (r) =>
    `<button class="rb-card${pct(r) ? ' has-pct' : ''}" data-recipe="${esc(r.id)}" data-kind="${r.type}" data-q="${esc(rnorm([r.name, r.cat, r.ing.join(' ')].join(' ')))}"><b>${esc(r.name)}</b>${pct(r)}<small>${r.hidden ? '<span class="pill mute">Hidden</span> ' : ''}${esc(r.size || r.serve || '')}</small></button>`;
  const sections = kinds
    .map((k) => {
      const cats = [...new Set(rs.filter((r) => r.type === k).map((r) => r.cat || 'Other'))];
      return cats
        .map(
          (c) =>
            `<section class="rb-cat" data-kind="${k}" ${k === recKind ? '' : 'hidden'}><h2>${esc(c)}</h2><div class="rb-grid">${rs
              .filter((r) => r.type === k && (r.cat || 'Other') === c)
              .map(card)
              .join('')}</div></section>`
        )
        .join('');
    })
    .join('');
  const favs = recFavs().map(recById).filter(Boolean),
    recent = recRecent().map(recById).filter((r) => r && favs.indexOf(r) < 0).slice(0, 6);
  const quick = favs.length || recent.length
    ? `${favs.length ? `<section class="rb-cat"><h2>★ Favorites</h2><div class="rb-grid">${favs.map(card).join('')}</div></section>` : ''}${recent.length ? `<section class="rb-cat"><h2>Recent</h2><div class="rb-grid">${recent.map(card).join('')}</div></section>` : ''}`
    : '';
  return `${head}
    <div class="rb-tools"><button class="btn sm ${barMode ? 'go' : ''}" data-barmode aria-pressed="${barMode}">Bar mode ${barMode ? 'on' : 'off'}</button>${kinds.length > 1 ? `<div class="seg" role="tablist">${kinds.map((k) => `<button data-reckind="${k}" aria-pressed="${k === recKind}">${k === 'Drink' ? 'Drinks' : 'Prep'}</button>`).join('')}</div>` : ''}
    <input type="search" class="rb-search" data-recsearch placeholder="Search recipes or ingredients" autocomplete="off" aria-label="Search recipes">${canEditRec() ? '<button class="btn go" data-recedit="new">+ Add recipe</button>' : ''}</div>
    <div class="rb-none sub" hidden>No recipe matches that.</div>
    ${quick}${sections}${docs}
    ${mgr() ? `<p class="sub">Recipes live on the Recipes tab in the sheet${data.recipeSheet ? ` (<a href="${esc(data.recipeSheet)}" target="_blank" rel="noopener">open it</a>)` : ''}. ${canEditRec() ? 'Edit them here or there; edits made here show for everyone straight away, edits in the sheet within a few minutes.' : 'Edits show up here within a few minutes.'}${recCost && recCost.errs && recCost.errs.length ? ' Costs: ' + esc(recCost.errs.join(' · ')) : ''}</p>` : ''}`;
}
/** Managers: add or change a recipe in the app. Saves to the same Recipes tab row the sheet shows. */
function viewRecipeEdit(r, o) {
  const x = r || {
    name: '',
    type: recKind || 'Drink',
    cat: '',
    size: '',
    serve: '',
    keeps: '',
    ing: [],
    steps: [],
    notes: '',
    tier: 'Everyone',
    cogs: '',
    order: '',
  };
  const cats = [
    ...new Set(
      RECIPES()
        .map((y) => y.cat)
        .filter(Boolean)
    ),
  ].sort();
  const cogsNames = recCost ? (x.type === 'Prep' ? recCost.prep : recCost.menu).map((y) => y.item) : [];
  const f = (label, name, val, extra) =>
    `<label class="f">${label}<input name="${name}" value="${esc(val || '')}" ${extra || ''}></label>`;
  return `<button class="btn sm" data-reccancel style="margin-bottom:8px">‹ ${r ? 'Back to the recipe' : 'Recipes'}</button>
    <h1>${r ? 'Edit recipe' : 'New recipe'}</h1>
    <form class="card stack rc-form" data-form="recipe" data-id="${esc(r ? r.id : 'new')}" style="padding:14px" autocomplete="off">
      ${f('Name', 'name', x.name, 'maxlength="120" required placeholder="e.g. Vanilla Latte"')}
      <div class="f">Type<div class="seg" role="radiogroup">${['Drink', 'Prep']
        .map(
          (k) =>
            `<label class="segopt"><input type="radio" name="type" value="${k}" ${x.type === k ? 'checked' : ''}> ${k === 'Drink' ? 'Drink' : 'Prep'}</label>`
        )
        .join('')}</div></div>
      ${f('Category', 'cat', x.cat, 'maxlength="60" list="rec-cats" placeholder="e.g. Flavored Lattes"')}
      <datalist id="rec-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="rc-two">${f('Size or yield', 'size', x.size, 'maxlength="80" placeholder="e.g. 12oz hot · 16oz iced"')}${f('Serve in / store in', 'serve', x.serve, 'maxlength="80" placeholder="e.g. Latte mug"')}</div>
      ${f('Keeps for (prep)', 'keeps', x.keeps, 'maxlength="60" placeholder="e.g. 24 hours, fridge"')}
      <label class="f">Ingredients<span class="sub">One per line, amount first (“32g vanilla syrup”). A line ending in : is a heading. Amounts are what the batch buttons multiply.</span><textarea name="ing" rows="${Math.max(5, x.ing.length + 1)}" maxlength="5000">${esc(x.ing.join('\n'))}</textarea></label>
      <label class="f">Steps<span class="sub">One per line, in order; the app numbers them. Start a line with ! for a red warning.</span><textarea name="steps" rows="${Math.max(5, x.steps.length + 1)}" maxlength="8000">${esc(x.steps.join('\n'))}</textarea></label>
      <label class="f">Good to know<span class="sub">Optional. Tips, when to make it, how long it keeps.</span><textarea name="notes" rows="3" maxlength="2000">${esc(x.notes)}</textarea></label>
      <label class="f">Who sees it<select name="tier">${['Everyone', 'Leads and managers', 'Managers']
        .map((t) => `<option ${t === (x.tier || 'Everyone') ? 'selected' : ''}>${t}</option>`)
        .join('')}</select></label>
      ${f('COGS name', 'cogs', x.cogs, `maxlength="400" list="rec-cogs" placeholder="Blank = same as the name"`)}
      <datalist id="rec-cogs">${cogsNames.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <p class="sub" style="margin:-6px 0 0">Its name in the COGS sheet, for costs. Several (hot and iced, say) go with | between them.</p>
      ${r ? f('Order in the book', 'order', x.order, 'type="number" inputmode="numeric" min="0" step="1"') : ''}
      <div class="btns"><button class="btn go">${r ? 'Save changes' : 'Add recipe'}</button><button type="button" class="btn" data-reccancel>Cancel</button></div>
    </form>
    ${
      r
        ? `<div class="card"><div class="row"><div class="txt"><b>${r.hidden ? 'Hidden from the team' : 'Hide from the team'}</b><div class="sub">${r.hidden ? 'Only managers see it. Show it to bring it back.' : 'Keeps the recipe for later (a seasonal drink, say) but takes it out of everyone else’s book.'}</div></div><button class="btn sm" data-recshow="${esc(r.id)}" data-on="${r.hidden ? 1 : 0}">${r.hidden ? 'Show it' : 'Hide it'}</button></div>
          <div class="row"><div class="txt"><b>Delete</b><div class="sub">Removes its row from the sheet for good.</div></div><button class="btn sm warn" data-recdel="${esc(r.id)}">Delete</button></div></div>`
        : ''
    }`;
}
/** Open prep items for this recipe: tick them off from here once it's made. */
function recPrepCard(r) {
  if (r.type !== 'Prep') return '';
  const xs = (data.prep || []).filter((x) => !x.doneAt && !/^tmp/.test(x.id) && recipeFor(x.item, x.recipe) === r);
  const ck = [];
  (data.checklists || []).forEach((c) =>
    (c.items || []).forEach((i) => {
      const k = 'c|' + c.list + '|' + i.task;
      if (!(busy[k] !== undefined ? busy[k] : !!i.by) && recipeForTask(i.task) === r) ck.push({ c, i });
    })
  );
  if (!xs.length && !ck.length) return '';
  return `<section class="rc-prep" id="rc-prep"><h2 class="rc-h"><span class="rc-prep-q">${xs.length ? 'On the prep list' : "On today's checklist"}</span></h2>
    ${xs
      .map(
        (x) =>
          `<div class="rc-prow"><div class="txt"><b>${esc(x.item)}</b><div class="sub">For ${esc(x.label || 'next shift')}${x.details ? ' · ' + esc(x.details) : ''}</div></div><button class="btn go sm" data-prepdone="${esc(x.id)}" data-on="0">Mark done</button></div>`
      )
      .join('')}${ck
      .map(
        ({ c, i }) =>
          `<div class="rc-prow"><div class="txt"><b>${esc(i.task)}</b><div class="sub">${esc(c.list)} checklist</div></div><button class="btn go sm" data-recck="${esc(c.list)}" data-task="${esc(i.task)}">Mark done</button></div>`
      )
      .join('')}</section>`;
}
function recCostCard(r) {
  if (!mgr()) return '';
  if (!recCost) return `<div class="rc-cost"><span class="sub">Loading costs…</span></div>`;
  const hits = recCosts(r);
  if (!hits.length)
    return `<div class="rc-cost"><span class="sub">Not found in the ${r.type === 'Prep' ? 'Prep' : 'Menu'} COGS sheet${r.cogs ? ' under “' + esc(r.cogs) + '”' : ''}. Put its name from that sheet in the COGS name column.</span></div>`;
  if (r.type === 'Prep')
    return `<div class="rc-cost">${hits
      .map(
        (x) =>
          `<div class="rc-crow"><span><b>${rmoney(x.batch == null ? null : x.batch * recScale)}</b><small>batch${recScale !== 1 ? ' ×' + recScale : ''}</small></span><span><b>${rmoney(x.perOz, 3)}</b><small>per fl oz</small></span><span><b>${x.yieldOz == null ? '—' : Math.round(x.yieldOz * recScale)}</b><small>fl oz</small></span></div>`
      )
      .join('')}</div>`;
  return `<div class="rc-cost">${hits
    .map(
      (x) =>
        `<div class="rc-crow">${hits.length > 1 ? `<i>${esc(x.item)}</i>` : ''}<span><b>${rmoney(x.cost)}</b><small>cost</small></span><span><b>${rmoney(x.price)}</b><small>price</small></span><span class="${/over/i.test(x.status) ? 'over' : ''}"><b>${x.pct == null ? '—' : Math.round(x.pct * 10) / 10 + '%'}</b><small>${esc(x.status || 'COGS')}</small></span></div>`
    )
    .join('')}</div>`;
}
function viewRecipe(r, o) {
  if (mgr()) loadRecCost();
  const prep = r.type === 'Prep';
  const chips = [
    r.size && ['Yield', r.size].map(esc),
    r.serve && [prep ? 'Store in' : 'Serve in', r.serve].map(esc),
    r.keeps && ['Keeps', r.keeps].map(esc),
  ].filter(Boolean);
  const ing = r.ing
    .map((l) => {
      if (/:\s*$/.test(l)) return `<li class="rc-sub">${esc(l.replace(/:\s*$/, ''))}</li>`;
      const [a, t] = splitAmt(l);
      // a measured amount in brackets scales too: "milk (3 gal)" ×2 → "milk (6 gal)"; "(~2-inch)" is left alone
      const t2 =
        prep && recScale !== 1
          ? t.replace(
              /\(([~≈]?\s*[\d½¼¾⅓⅔⅛][\d.,/½¼¾⅓⅔⅛]*\s*(?:fl\.?\s?oz|gal|qt|quarts?|oz|lb|kg|g|ml|l)\b[^)]*)\)/gi,
              (m, x) => '(' + scaleAmt(x, recScale) + ')'
            )
          : t;
      return `<li><b class="amt">${esc(prep ? scaleAmt(a, recScale) : a)}</b><span>${esc(t2)}</span></li>`;
    })
    .join('');
  let n = 0;
  const steps = r.steps
    .map((l) =>
      /^!/.test(l)
        ? `<li class="rc-warn"><span class="n" aria-hidden="true">!</span><p>${esc(l.replace(/^!\s*/, ''))}</p></li>`
        : `<li><button class="rc-step" data-recstep><span class="n">${++n}</span><p>${esc(l)}</p></button></li>`
    )
    .join('');
  const sib = RECIPES().filter((x) => x.type === r.type && (x.cat || 'Other') === (r.cat || 'Other')),
    at = sib.indexOf(r),
    prev = sib[at - 1],
    next = sib[at + 1],
    fav = recFavs().indexOf(r.id) >= 0;
  return `<div class="rc-nav"><button class="btn sm" data-recback>‹ ${esc(o && o.title && !/^recipes?$/i.test(o.title) ? o.title : 'Recipes')}</button><span style="flex:1"></span>
    <button class="btn sm" data-recfav="${esc(r.id)}" aria-pressed="${fav}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '★' : '☆'}</button>
    ${prev ? `<button class="btn sm" data-recipe="${esc(prev.id)}" data-swipe="prev" aria-label="Previous: ${esc(prev.name)}">‹</button>` : ''}${next ? `<button class="btn sm" data-recipe="${esc(next.id)}" data-swipe="next" aria-label="Next: ${esc(next.name)}">›</button>` : ''}</div>
    ${r.hidden ? `<div class="card rc-hidden"><div class="row"><div class="txt"><b>Hidden from the team</b><div class="sub">Only managers can see this recipe.</div></div>${canEditRec() ? `<button class="btn sm" data-recshow="${esc(r.id)}" data-on="1">Show it</button>` : ''}</div></div>` : ''}
    <article class="rc ${prep ? 'prep' : 'drink'}">
      <header class="rc-head"><div class="rc-brand"><img src="brand/bird-gold.png" alt=""><span>Peregrine${r.cat ? ' · ' + esc(r.cat) : ''}</span></div>
        <h1 class="rc-title">${esc(r.name)}</h1>
        ${chips.length ? `<div class="rc-meta">${chips.map(([k, v]) => `<span><small>${k}</small>${v}</span>`).join('')}</div>` : ''}
      </header>
      ${recCostCard(r)}
      ${prep && r.ing.some((l) => splitAmt(l)[0]) ? `<div class="rc-scale"><span class="sub">Batch</span><div class="seg">${[0.5, 1, 2, 3].map((k) => `<button data-recscale="${k}" aria-pressed="${k === recScale}">${k === 0.5 ? '½' : k}×</button>`).join('')}</div></div>` : ''}
      ${ing ? `<section><h2 class="rc-h">Ingredients${prep && recScale !== 1 ? ` <span class="pill">${recScale === 0.5 ? '½' : recScale}× batch</span>` : ''}</h2><ul class="rc-ing">${ing}</ul></section>` : ''}
      ${steps ? `<section><h2 class="rc-h">${prep ? 'Method' : 'Build'}</h2><ol class="rc-steps">${steps}</ol>${n > 1 ? '<p class="sub rc-hint">Tap a step to tick it off.</p>' : ''}</section>` : ''}
      ${recPrepCard(r)}
      ${r.notes ? `<section class="rc-note"><h2 class="rc-h">Good to know</h2><p>${linkify(esc(r.notes)).replace(/\n/g, '<br>')}</p></section>` : ''}
      <footer class="rc-foot"><span class="rc-branch" aria-hidden="true"></span>Peregrine Coffee Roasters</footer>
    </article>
    ${
      mgr()
        ? `<div class="btns">${canEditRec() ? `<button class="btn go" data-recedit="${esc(r.id)}">Edit recipe</button>` : ''}${data.recipeSheet && r.row ? `<a class="btn" href="${esc(data.recipeSheet)}&range=A${r.row}" target="_blank" rel="noopener">Open in the sheet ↗</a>` : ''}</div>`
        : ''
    }`;
}
document.addEventListener('input', (e) => {
  const q = e.target.closest && e.target.closest('[data-recsearch]');
  if (!q) return;
  const t = rnorm(q.value),
    root = q.closest('#main') || document;
  let any = false;
  root.querySelectorAll('.rb-cat').forEach((sec) => {
    let shown = 0;
    sec.querySelectorAll('.rb-card').forEach((c) => {
      const ok = t ? c.dataset.q.indexOf(t) >= 0 : c.dataset.kind === recKind;
      c.hidden = !ok;
      if (ok) shown++;
    });
    sec.hidden = t ? !shown : sec.dataset.kind !== recKind;
    if (shown && !sec.hidden) any = true;
  });
  const none = root.querySelector('.rb-none');
  if (none) none.hidden = any || !t;
});

/* ----- resources (in-app PDFs) ----- */
const opensIn = (u) =>
  /\/spreadsheets\//.test(u)
    ? '<div class="sub">Opens in Google Sheets</div>'
    : /\/document\//.test(u)
      ? '<div class="sub">Opens in Google Docs</div>'
      : /drive\.google\.com/.test(u)
        ? '<div class="sub">Opens in Google Drive</div>'
        : '';

/* ----- training: a Level I checklist per trainee, for leads and managers ----- */
let trainSel = '';
const TR = () => data.training || { items: [], active: [], filed: [] };
const trDone = (t) => TR().items.filter((it) => t.done && t.done[it.skill]).length;
// Level I test result (filled in from the online test results; a score typed in by hand wins)
const trTest = (t, short) => {
  const r = t.test;
  if (t.score !== '' && t.score != null)
    return `<span class="pill ${Number(t.score) >= 12 ? 'ok' : 'warn'}">Test ${Number(t.score) >= 12 ? 'passed' : 'not passed'} ${esc(t.score)}/15</span>${short ? '' : '<span class="sub"> typed in by hand</span>'}`;
  if (!r) return '';
  const sc = r.score !== '' ? ' ' + esc(r.score) + (r.outOf ? '/' + esc(r.outOf) : '') : '';
  const pill =
    r.s === 'pass'
      ? `<span class="pill ok">Test passed${sc}</span>`
      : r.s === 'wait'
        ? '<span class="pill mute">Test being scored</span>'
        : `<span class="pill warn">Test not passed${sc}</span>`;
  return short
    ? pill
    : pill +
        `<span class="sub"> ${r.at ? shortDay(ymdOf(new Date(r.at))) : ''}${r.tries > 1 ? ' · ' + r.tries + ' tries' : ''}</span>`;
};
const trBar = (t) => {
  const n = TR().items.length,
    d = trDone(t);
  return `<div class="progress"><i style="width:${n ? Math.round((d / n) * 100) : 0}%"></i></div><div class="sub" style="margin-top:4px">${d} of ${n} skills</div>`;
};
function viewTraining(embed) {
  const T = TR(),
    t = trainSel && T.active.find((x) => x.id === trainSel);
  if (t) return viewTrainee(t, embed);
  trainSel = '';
  const leadLinks = (data.links || []).filter((l) => l.tier !== 'Everyone');
  return `${embed ? '' : back() + '<h1>Training</h1>'}
    <div class="btns" style="margin-bottom:10px"><button class="btn go" data-trainnew>Start a trainee checklist</button></div>
    <h2>In training</h2><div class="card">${T.active.map((x) => rowBtn(`data-trainopen="${esc(x.id)}"`, `<div class="txt"><b>${esc(x.name)}</b>${levelPill(x.name)}<div class="sub">${x.trainer ? 'Trainer: ' + esc(first(x.trainer)) + ' · ' : ''}${x.started ? 'Started ' + shortDay(x.started) : ''}</div>${trBar(x)}${trTest(x, true) ? `<div style="margin-top:6px">${trTest(x, true)}</div>` : ''}</div><span>›</span>`)).join('') || '<div class="empty">Nobody in training. Start a checklist when a new barista begins.</div>'}</div>
    ${T.filed.length ? `<h2>Filed</h2><div class="card">${T.filed.map((x) => `<a class="row" href="${esc(x.filed)}" target="_blank" rel="noopener" style="text-decoration:none"><div class="txt"><b>${esc(x.name)}</b><div class="sub">Filed${x.filedAt ? ' ' + shortDay(ymdOf(new Date(x.filedAt))) : ''}${x.filedBy ? ' by ' + esc(first(x.filedBy)) : ''} · opens in Google Docs</div></div><span>↗</span></a>`).join('')}</div>` : ''}
    ${leadLinks.length ? `<h2>Lead resources</h2><div class="card">${leadLinks.map((l) => (l.file && !/\/spreadsheets\//.test(l.url) ? rowBtn(`data-pdf="${esc(l.id)}"`, `<div class="txt"><b>${esc(l.name)}</b><div class="sub">${l.tier === 'Managers' ? 'Managers · ' : ''}Opens in the app</div></div><span>›</span>`) : `<a class="row" href="${esc(l.url)}" target="_blank" rel="noopener" style="text-decoration:none"><div class="txt"><b>${esc(l.name)}</b>${opensIn(l.url)}</div><span>↗</span></a>`)).join('')}</div>` : ''}
    <p class="sub">Leads and managers see every checklist; each barista sees only their own, read-only. The skills come from the Training items tab in the sheet.${T.folder ? '' : ' Add a folder in Settings › Training records folder so managers can file finished checklists.'}</p>`;
}
function viewTrainee(t, embed) {
  const T = TR(),
    secs = [...new Set(T.items.map((x) => x.section))],
    n = T.items.length,
    d = trDone(t);
  const row = (it) => {
    const x = t.done[it.skill];
    return `<div class="row trow ${x ? 'on' : ''}"><button class="tchk" data-traincheck="${esc(it.skill)}" aria-pressed="${x ? 'true' : 'false'}" aria-label="${esc(it.skill)}">${x ? '✓' : ''}</button>
      <div class="txt"><b>${esc(it.skill)}</b><div class="sub">${esc(it.standard)}</div>${x ? `<div class="sub tby">✓ ${esc(first(x.by))}${x.at ? ' · ' + shortDay(ymdOf(new Date(x.at))) : ''}${x.note ? ' · ' + esc(x.note) : ''}</div>` : ''}</div>
      ${x ? `<button class="lnk" data-trainnote="${esc(it.skill)}">${x.note ? 'Edit note' : 'Note'}</button>` : ''}</div>`;
  };
  return `<button class="btn sm" data-trainback style="margin-bottom:6px">‹ ${embed ? 'All trainees' : 'Training'}</button>
    ${embed ? `<h2>${esc(t.name)}</h2>` : `<h1>${esc(t.name)}</h1>`}
    <div class="card"><div class="row"><div class="txt"><div class="sub">Primary trainer: <b>${esc(t.trainer || '—')}</b> · Started ${t.started ? shortDay(t.started) : '—'}</div>${trBar(t)}</div></div></div>
    ${secs
      .map(
        (sec) =>
          `<h2>${esc(sec)}</h2><div class="card">${T.items
            .filter((x) => x.section === sec)
            .map(row)
            .join('')}</div>`
      )
      .join('')}
    <h2>Level I sign-off</h2>
    <div class="card"><div class="row"><div class="txt"><b>Level I test</b><div style="margin-top:4px">${trTest(t) || '<span class="sub">Not taken yet. Results from the online test show up here on their own.</span>'}</div></div></div></div>
    <form class="card stack" data-form="trainedit" style="padding:14px">
      <label class="f">Primary trainer<select name="trainer">${[
        ...new Set([t.trainer].concat((data.people || []).filter((u) => u.role !== 'Staff').map((u) => u.name))),
      ]
        .filter(Boolean)
        .map((nm) => `<option ${nm === t.trainer ? 'selected' : ''}>${esc(nm)}</option>`)
        .join('')}</select></label>
      <label class="f">Start date<input type="date" name="started" value="${esc(t.started || '')}"></label>
      <label class="f">${t.test ? 'Test score typed in by hand (only to replace the online result)' : 'Level I test score, if taken on paper (12 of 15 to pass)'}<input type="number" name="score" min="0" max="15" inputmode="numeric" value="${esc(t.score)}" placeholder="—"></label>
      <label class="f">Anything to keep an eye on<textarea name="watch" rows="3" maxlength="1000">${esc(t.watch)}</textarea></label>
      <button class="btn go">Save</button></form>
    ${
      mgr()
        ? `<div class="card"><div class="row"><div class="txt"><b>File in Drive</b><div class="sub">${d < n ? n - d + ' skill' + (n - d > 1 ? 's' : '') + ' not checked off yet. ' : 'Every skill is checked off. '}Filing saves this checklist as a Google Doc in your HR folder and takes it off this list.</div></div></div>
      <div class="btns" style="padding:0 14px 14px"><button class="btn go" data-trainfile="${esc(t.id)}" ${T.folder ? '' : 'disabled title="Add Settings › Training records folder first"'}>File checklist</button><button class="btn" data-traindel="${esc(t.id)}">Delete</button></div></div>`
        : '<p class="sub">When training is done, a manager files this checklist in Drive.</p>'
    }`;
}
function trainNewSheet() {
  const busy = new Set(TR().active.map((x) => x.name)),
    staff = (data.people || [])
      .filter((u) => u.role === 'Staff' && !busy.has(u.name))
      .map((u) => u.name)
      .sort();
  const trainers = (data.people || [])
    .filter((u) => u.role !== 'Staff')
    .map((u) => u.name)
    .sort();
  return `<div class="sheet" role="dialog" aria-label="New trainee checklist"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">New checklist</h1><button class="btn sm" data-closesheet>Close</button></div>
    <form class="stack" data-form="trainnew" style="padding:0">
      <label class="f">Trainee<select name="who"><option value="">Pick someone…</option>${staff.map((nm) => `<option>${esc(nm)}</option>`).join('')}<option value="*">Someone not in the app yet…</option></select></label>
      <label class="f" data-trainother hidden>Their name<input name="other" maxlength="80" autocomplete="off"></label>
      <label class="f">Primary trainer<select name="trainer">${trainers.map((nm) => `<option ${nm === data.me.name ? 'selected' : ''}>${esc(nm)}</option>`).join('')}</select></label>
      <label class="f">Start date<input type="date" name="started" value="${T()}"></label>
      <button class="btn go">Start checklist</button></form></div></div>`;
}
function trainNoteSheet() {
  const t = TR().active.find((x) => x.id === trainSel),
    x = t && t.done[sheet.skill];
  if (!x) return '';
  return `<div class="sheet" role="dialog" aria-label="Note"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${esc(sheet.skill)}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <form class="stack" data-form="trainnote" style="padding:0"><label class="f">Note<textarea name="note" rows="4" maxlength="300" placeholder="What still needs work, or anything the next trainer should know">${esc(x.note)}</textarea></label><button class="btn go">Save note</button></form></div></div>`;
}
document.addEventListener('change', (e) => {
  const f = e.target.closest && e.target.closest('form[data-form=trainnew]');
  if (!f || e.target.name !== 'who') return;
  const o = f.querySelector('[data-trainother]');
  if (o) o.hidden = e.target.value !== '*';
});
const resRow = (l) =>
  l.file && !/\/spreadsheets\//.test(l.url)
    ? rowBtn(
        `data-pdf="${esc(l.id)}"`,
        `<div class="txt"><b>${esc(l.name)}</b><div class="sub">Opens in the app</div></div><span>›</span>`
      )
    : `<a class="row" href="${esc(l.url)}" target="_blank" rel="noopener" style="text-decoration:none"><div class="txt"><b>${esc(l.name)}</b>${opensIn(l.url)}</div><span>↗</span></a>`;
/** Shop iPad: one resource group as its own tab. */
function viewResGroup(g) {
  const xs = (data.links || []).filter((l) => l.group === g);
  if (/recipe/i.test(g) && RECIPES().length) return viewRecipes({ title: g, docs: xs });
  return `<h1>${esc(g)}</h1><div class="card">${xs.map(resRow).join('') || '<div class="empty">Nothing here yet.</div>'}</div>`;
}
function viewResources() {
  const tiers = ['Everyone', 'Leads and managers', 'Managers'],
    ls = (data.links || []).filter((l) => !shop() || !l.group); // on the shop iPad, grouped ones have their own tabs
  return `${back()}<h1>Resources</h1>${
    tiers
      .map((t) => {
        const xs = ls.filter((l) => l.tier === t);
        return xs.length
          ? `<h2>${t === 'Everyone' ? 'Everyone' : t}</h2><div class="card">${xs.map(resRow).join('')}</div>`
          : '';
      })
      .join('') || '<div class="card"><div class="empty">No resources yet.</div></div>'
  }`;
}
async function openPdf(id) {
  const l = (data.links || []).find((x) => x.id === id);
  if (!l) return;
  viewer = { id, name: l.name, state: 'loading' };
  render();
  const key = 'https://pt-files/' + id;
  let bytes = null,
    fromCache = false;
  try {
    const r = await post({ fn: 'file', token: TOKEN, id });
    const bin = atob(r.data);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      const c = await caches.open(NS + 'pt-files');
      await c.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } }));
    } catch (_) {}
  } catch (e) {
    const m = String(e.message || e);
    if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, ''));
    try {
      const c = await caches.open(NS + 'pt-files'),
        hit = await c.match(key);
      if (hit) {
        bytes = new Uint8Array(await hit.arrayBuffer());
        fromCache = true;
      }
    } catch (_) {}
    if (!bytes) {
      viewer = null;
      render();
      toast(m === 'timeout' ? 'That file took too long – try again' : m);
      return;
    }
  }
  if (!viewer || viewer.id !== id) return;
  viewer.state = 'ready';
  viewer.cached = fromCache;
  render();
  try {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: bytes }).promise,
      box = $('#pages');
    for (let n = 1; n <= doc.numPages && viewer && viewer.id === id; n++) {
      const page = await doc.getPage(n),
        w = Math.min(box.clientWidth || 360, 900),
        vp = page.getViewport({ scale: 1 }),
        scale = w / vp.width,
        dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const v = page.getViewport({ scale: scale * dpr }),
        cv = document.createElement('canvas');
      cv.width = v.width;
      cv.height = v.height;
      cv.style.width = w + 'px';
      cv.style.height = v.height / dpr + 'px';
      box.appendChild(cv);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: v }).promise;
    }
  } catch (e) {
    // no PDF viewer available: let the phone's own viewer open it
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const box = $('#pages');
    if (box)
      box.innerHTML = `<div class="empty">This phone couldn't show it here. <a href="${url}" target="_blank">Open the PDF</a></div>`;
  }
}
function viewViewer() {
  return `<div class="viewer"><div class="vbar"><button class="btn sm" data-closeviewer>‹ Back</button><b>${esc(viewer.name)}</b><span style="width:52px"></span></div>
    ${viewer.cached ? '<div class="offline" style="margin:8px">Offline – showing the saved copy</div>' : ''}
    <div id="pages" class="pages">${viewer.state === 'loading' ? '<div class="empty">Opening…</div>' : ''}</div></div>`;
}

/* ----- tests ----- */
/* ----- tests: a tab of its own. Taken right in the app (signed in, so no typing your name); results go to the results sheet. ----- */
let tdata = null,
  tAt = 0,
  runner = null;
async function loadTests() {
  try {
    const r = await post({ fn: 'tests', token: TOKEN });
    tdata = r;
    tAt = Date.now();
  } catch (e) {
    const m = String(e.message || e);
    if (/^signin/.test(m)) return signOut(m.replace(/^signin:\s*/, ''));
    toast(m);
  }
  if (tab === 'tests') render();
}
/* The training portal (manual, study guides, tests, resources, forms, dashboards) opens right here, signed in with
   this app's sign-in. The address is kept for the session so the page isn't reloaded every time the app refreshes. */
/** A small level pill for a name (from the training portal's Staff Levels tab). */
function levelPill(name) {
  const L = data && data.levels && data.levels[name];
  if (!L || !L.code) return '';
  const t = { T: 'Trainee', L1: 'Level I', L2P: 'Level II · ack', L2: 'Level II', LD: 'Lead', MG: 'Manager' }[L.code] || L.label;
  return `<span class="lvp lvp-${esc(L.code)}" title="${esc(L.label)}">${esc(t)}</span>${L.iv ? '<span class="lvp lvp-IV" title="Passed Level IV">IV</span>' : ''}`;
}
let trainSrc = '',
  trainUntil = 0;
/* ===== Feature switches, Dial-in log, Drawer count ===== */
/** Is this part of the app turned on for this shop? (Everything is on with an older server.) */
const on = (k) => !data || !data.features || data.features[k] !== false;
const DIAL = { open: false, busy: false, list: '' };
/** A checklist task that is really "log the dial-in" (any task with "dial in" in it, while the Dial-in log is on). */
const isDialTask = (t) => on('dialin') && /dial[\s-]?in/i.test(String(t || ''));
const dialToday = () => (on('dialin') && (data.dialin || []).find((d) => d.date === T())) || null;
/** One line for a dial-in: coffee · grind · dose in · yield out · time. */
const dialLine = (x) => [esc(x.coffee) + ' · grind ' + esc(x.grind), x.dose && x.dose + 'g in', x.yield && x.yield + 'g out', x.time && x.time + ' sec'].filter(Boolean).join(' · ');
/** Shown right after someone clocks in: today's espresso settings, or a nudge to log them. */
function dialPopSheet() {
  const x = dialToday(),
    last = (data.dialin || [])[0];
  return `<div class="sheet" role="dialog" aria-label="Today's dial-in"><div class="sheet-in"><h1 style="margin:0 0 4px">◎ Today's dial-in</h1>
    ${
      x
        ? `<div class="card"><div class="row"><div class="txt"><b>${dialLine(x)}</b>${x.note ? `<div class="sub">${esc(x.note)}</div>` : ''}<div class="sub">Logged by ${esc(first(x.by))} · ${timeOf(x.at)}</div></div></div></div>`
        : `<p class="sub" style="margin:0 0 10px">Nobody has dialed in yet today.${last ? ' Last: ' + dialLine(last) + ' (' + esc(shortDay(last.date)) + ').' : ''}</p>`
    }
    <div class="btns" style="margin-top:12px"><button class="btn go" data-dialok>Got it</button>${x ? '' : '<button class="btn" data-dialok data-dialnew>Log it now</button>'}</div></div></div>`;
}
/* ----- clock-out check: the person's shift checklist has to be done (or each open task skipped with a reason) ----- */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-recck]');
  if (!b || !data) return;
  const list = b.dataset.recck,
    task = b.dataset.task;
  busy['c|' + list + '|' + task] = true;
  if (navigator.vibrate) navigator.vibrate(10);
  act('check', { list, task, done: '1' });
  toast('Checked off · ' + task);
  recSel = '';
  listTab = list;
  tab = 'lists';
  save('pt-tab', tab);
  window.scrollTo(0, 0);
  render();
});
const CK = { open: false, pass: false, list: '', skip: {}, note: '' };
/** Open tasks on the checklist for this person's shift today. Empty when there's nothing to hold them to. */
function clockOutOpen() {
  if (!on('lists') || !data.open) return [];
  if (/meeting|training/i.test(data.open.as || '')) return [];
  const L = shiftList();
  if (!L) return [];
  const c = (data.checklists || []).find((x) => x.list === L);
  if (!c) return [];
  CK.list = L;
  return (c.items || []).filter((i) => {
    const k = 'c|' + L + '|' + i.task;
    return !(busy[k] !== undefined ? busy[k] : !!i.by);
  });
}
function viewClockOutCheck() {
  const open = clockOutOpen(),
    ho = on('handoff');
  if (!open.length) {
    CK.open = false;
    return viewToday();
  }
  return `<div class="btns" style="margin-bottom:8px"><button class="btn sm" data-ckcancel>‹ Back</button></div><h1>Before you clock out</h1>
    <p class="sub" style="margin:-4px 4px 10px">${open.length} left on the ${esc(CK.list)} checklist. Finish ${open.length > 1 ? 'them' : 'it'}, or say why you can't${ho ? ' – that goes in your handoff' : ''}.</p>
    <div class="card">${open
      .map(
        (i) => `<div class="row"><div class="txt"><b>${esc(i.task)}</b>
      <input class="ckwhy" data-ckwhy="${esc(i.task)}" placeholder="Can't finish? Why…" value="${esc(CK.skip[i.task] || '')}" aria-label="Why ${esc(i.task)} isn't done" style="margin-top:6px;width:100%"></div></div>`
      )
      .join('')}</div>
    <div class="btns" style="margin-top:12px"><button class="btn go" data-ckgo>Go finish them</button><button class="btn" data-ckskip>Clock out with reasons</button></div>`;
}
document.addEventListener('input', (e) => {
  if (e.target.dataset && e.target.dataset.ckwhy !== undefined) CK.skip[e.target.dataset.ckwhy] = e.target.value;
});
document.addEventListener(
  'click',
  (e) => {
    const b = e.target.closest && e.target.closest('[data-clock="out"], [data-ckcancel], [data-ckgo], [data-ckskip], [data-dialok], [data-dialtask]');
    if (!b || !data) return;
    const d = b.dataset;
    if (d.clock === 'out') {
      if (CK.pass) {
        CK.pass = false; // let it through to the handoff / clock out
        return;
      }
      if (!clockOutOpen().length) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      CK.open = true;
      tab = 'today';
      window.scrollTo(0, 0);
      return render();
    }
    if (d.ckcancel !== undefined) {
      CK.open = false;
      return render();
    }
    if (d.ckgo !== undefined) {
      CK.open = false;
      listTab = CK.list;
      tab = 'lists';
      save('pt-tab', tab);
      window.scrollTo(0, 0);
      return render();
    }
    if (d.ckskip !== undefined) {
      const open = clockOutOpen(),
        miss = open.filter((i) => !String(CK.skip[i.task] || '').trim());
      if (miss.length) return toast('Say why for each one, or go finish ' + (miss.length > 1 ? 'them' : 'it'));
      CK.note = open.length ? 'Not finished (' + CK.list + '):\n' + open.map((i) => '• ' + i.task + ' – ' + String(CK.skip[i.task]).trim()).join('\n') : '';
      CK.open = false;
      CK.pass = true;
      if (CK.note && on('handoff')) {
        HO.open = true; // a skipped task always gets a handoff, even when handoffs aren't required
        tab = 'today';
        window.scrollTo(0, 0);
        CK.pass = false;
        return render();
      }
      render();
      const cb = $('[data-clock="out"]');
      if (cb) cb.click();
      else CK.pass = false;
      return;
    }
    if (d.dialok !== undefined) {
      sheet = null;
      if (d.dialnew === undefined) render();
      return; // "Log it now" carries on to the dial-in form
    }
    if (d.dialtask !== undefined) {
      e.stopImmediatePropagation();
      DIAL.list = d.dialtask;
      tab = 'more';
      moreView = 'dialin';
      window.scrollTo(0, 0);
      return render();
    }
  },
  true
);
const DRAW = { busy: false, last: null };
/** Today: the current dial-in, one tap to log a new one. */
function dialCard() {
  if (!on('dialin') || !data.dialin) return '';
  const x = data.dialin.find((d) => d.date === T());
  return `<h2>Dial-in</h2><div class="card">${
    x
      ? rowBtn('data-more="dialin"', `<div class="txt"><b>${esc(x.coffee)} · grind ${esc(x.grind)}</b><div class="sub">${[x.dose && x.dose + 'g in', x.yield && x.yield + 'g out', x.time && x.time + ' sec'].filter(Boolean).join(' · ')}${x.note ? ' · ' + esc(x.note) : ''}</div><div class="sub">${esc(first(x.by))} · ${timeOf(x.at)}</div></div><span>›</span>`)
      : `<div class="row"><div class="txt"><b>Not dialed in yet today</b><div class="sub">${data.dialin[0] ? 'Last: ' + esc(data.dialin[0].coffee) + ' · grind ' + esc(data.dialin[0].grind) + ' (' + esc(shortDay(data.dialin[0].date)) + ')' : 'Log the first one'}</div></div><button class="btn sm go" data-dialnew>Log it</button></div>`
  }</div>`;
}
function viewDialIn() {
  const L = data.dialin || [],
    last = L[0] || {},
    coffees = [...new Set(L.map((x) => x.coffee).filter(Boolean))];
  const f = (n, label, attrs, val) => `<label class="f">${label}<input name="${n}" ${attrs} value="${esc(val || '')}"></label>`;
  return `${back()}<h1>Dial-in log</h1>
    <h2>Log today's dial-in</h2><div class="card"><form class="stack" data-form="dialin" onsubmit="return false">
      ${f('coffee', 'Coffee', 'list="dialcoffees" placeholder="House"', last.coffee)}<datalist id="dialcoffees">${coffees.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="trtwo">${f('grind', 'Grind setting', 'inputmode="decimal" placeholder="e.g. 4.2"', last.grind)}${f('dose', 'Dose (g)', 'type="number" step="0.1" inputmode="decimal"', last.dose || '17.5')}</div>
      <div class="trtwo">${f('yield', 'Yield (g)', 'type="number" step="0.1" inputmode="decimal"', last.yield || '')}${f('time', 'Time (sec)', 'type="number" step="1" inputmode="numeric"', '')}</div>
      ${f('note', 'Taste / notes', 'placeholder="e.g. balanced, a touch sour – went finer"', '')}
      <button class="btn go" data-dialsave ${DIAL.busy ? 'disabled' : ''}>${DIAL.busy ? 'Saving…' : 'Save'}</button></form></div>
    <h2>History</h2><div class="card">${
      L.map((x) => `<div class="row"><div class="txt"><b>${esc(x.coffee)} · grind ${esc(x.grind)}</b><div class="sub">${[x.dose && x.dose + 'g in', x.yield && x.yield + 'g out', x.time && x.time + ' sec'].filter(Boolean).join(' · ')}${x.note ? ' · ' + esc(x.note) : ''}</div></div><span class="sub" style="text-align:right">${esc(shortDay(x.date))}<br>${esc(first(x.by))}</span></div>`).join('') ||
      '<div class="empty">No dial-ins yet. The opener logs the first one each morning.</div>'
    }</div>`;
}
function viewDrawer() {
  const base = data.drawerBase || 200,
    L = data.drawer || [];
  return `${back()}<h1>Drawer count</h1>
    <h2>Count and close</h2><div class="card"><form class="stack" data-form="drawer" onsubmit="return false">
      <div class="sub">Enter how many of each bill, like Count Bills in the POS. The drawer keeps $${base}.</div>
      <div class="drw">${[100, 50, 20, 10, 5, 1].map((d) => `<label class="f">$${d}s<input type="number" min="0" step="1" inputmode="numeric" data-bill="${d}" placeholder="0"></label>`).join('')}<label class="f">Coins ($)<input type="number" min="0" step="0.01" inputmode="decimal" data-coins placeholder="0.00"></label></div>
      <label class="f">POS expected cash ($)<input type="number" step="0.01" inputmode="decimal" data-expected placeholder="From the Count and Close summary"></label>
      <div id="drwout" class="hint" style="margin:0">Counted $0.00</div>
      <label class="f">Note (optional)<input data-drnote placeholder="Anything about this count"></label>
      <button class="btn go" data-drawersave ${DRAW.busy ? 'disabled' : ''}>${DRAW.busy ? 'Saving…' : 'Save count'}</button></form></div>
    <h2>${lead() ? 'Recent counts' : 'Your counts'}</h2><div class="card">${
      L.map((x) => `<div class="row"><div class="txt"><b>$${x.counted.toFixed(2)} counted · deposit $${x.deposit}</b><div class="sub">${esc(first(x.by))} · ${timeOf(x.at)}${x.note ? ' · ' + esc(x.note) : ''}</div></div>${x.diff == null ? '' : `<span class="pill ${Math.abs(x.diff) > 5 ? 'warn' : Math.abs(x.diff) > 0 ? 'mute' : 'ok'}">${x.diff > 0 ? '+' : x.diff < 0 ? '−' : ''}$${Math.abs(x.diff).toFixed(2)}</span>`}</div>`).join('') ||
      '<div class="empty">No counts yet.</div>'
    }</div>`;
}
function drawerMath() {
  const base = data.drawerBase || 200;
  let t = 0;
  document.querySelectorAll('[data-bill]').forEach((i) => (t += (Number(i.value) || 0) * Number(i.dataset.bill)));
  t += Number(($('[data-coins]') || {}).value) || 0;
  const exp = ($('[data-expected]') || {}).value,
    dep = Math.max(0, Math.round(t) - base),
    diff = exp === '' || exp == null ? null : t - Number(exp);
  const o = $('#drwout');
  if (o)
    o.innerHTML = `<b>Counted $${t.toFixed(2)}</b> · deposit <b>$${dep}</b> · $${(t - dep).toFixed(2)} stays in the drawer${diff == null ? '' : `<br>${Math.abs(diff) < 0.005 ? 'Matches the POS.' : (diff < 0 ? 'Short' : 'Over') + ' $' + Math.abs(diff).toFixed(2) + (Math.abs(diff) > 5 ? ' — recount. If it stands, the manager is told the same day.' : ' — note it with the deposit.')}`}`;
  return { t, exp };
}
/** Master Admin: turn parts of the app on or off for this shop. */
function viewMaster() {
  if (!data.master) return viewMoreList();
  const L = data.featureList || [],
    groups = [...new Set(L.map((f) => f.group))];
  return `${back()}<h1>Master admin</h1><p class="sub" style="margin:-4px 4px 10px">Turn parts of the app on or off for ${esc(data.name || 'this shop')}. Changes reach everyone within a minute. Sign-in, Today, Team and Settings are always on.</p>
    ${groups.map((g) => `<h2>${esc(g)}</h2><div class="card">${L.filter((f) => f.group === g).map((f) => `<div class="row"><div class="txt"><b>${esc(f.name)}</b><div class="sub">${esc(f.desc)}</div></div><button class="tgl" data-feat="${esc(f.key)}" aria-pressed="${on(f.key)}" aria-label="${esc(f.name)}"><i></i></button></div>`).join('')}</div>`).join('')}`;
}
document.addEventListener('input', (e) => {
  if (e.target.matches && e.target.matches('[data-bill], [data-coins], [data-expected]')) drawerMath();
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-dialnew], [data-dialsave], [data-drawersave], [data-feat]');
  if (!b || !data) return;
  const d = b.dataset;
  if (d.dialnew !== undefined) {
    tab = 'more';
    moreView = 'dialin';
    window.scrollTo(0, 0);
    return render();
  }
  if (d.dialsave !== undefined) {
    const f = $('form[data-form="dialin"]'),
      v = (n) => f.elements.namedItem(n).value;
    if (!v('grind').trim()) return toast('Add the grind setting');
    DIAL.busy = true;
    render();
    const r = await act('dialIn', { coffee: v('coffee'), grind: v('grind'), dose: v('dose'), yield: v('yield'), time: v('time'), note: v('note') });
    DIAL.busy = false;
    if (r) {
      (data.checklists || []).forEach((c) =>
        (c.items || []).forEach((i) => {
          if (!i.by && isDialTask(i.task)) {
            busy['c|' + c.list + '|' + i.task] = true;
            act('check', { list: c.list, task: i.task, done: '1' });
          }
        })
      );
      toast('Dial-in saved' + (DIAL.list ? ' · checked off' : ''));
      if (DIAL.list) {
        listTab = DIAL.list;
        tab = 'lists';
        save('pt-tab', tab);
        window.scrollTo(0, 0);
      }
      DIAL.list = '';
    }
    render();
  }
  if (d.drawersave !== undefined) {
    const { t, exp } = drawerMath();
    if (!t) return toast('Enter the bill counts');
    const bills = {};
    document.querySelectorAll('[data-bill]').forEach((i) => (bills[i.dataset.bill] = Number(i.value) || 0));
    if (!confirm('Save a count of $' + t.toFixed(2) + '?')) return;
    DRAW.busy = true;
    render();
    const r = await act('drawerCount', { bills, coins: ($('[data-coins]') || {}).value, expected: exp, note: ($('[data-drnote]') || {}).value });
    DRAW.busy = false;
    if (r) toast('Count saved');
    render();
  }
  if (d.feat) {
    const now = !on(d.feat);
    if (!confirm((now ? 'Turn on ' : 'Turn off ') + b.getAttribute('aria-label') + ' for everyone at this shop?')) return;
    data.features[d.feat] = now;
    render();
    const r = await act('setFeatures', { features: { [d.feat]: now } });
    if (r) toast(b.getAttribute('aria-label') + (now ? ' is on' : ' is off'));
  }
});

/* ===== Drop 3: swipe a list row right to check it off ===== */
let lsw = null;
document.addEventListener(
  'touchstart',
  (e) => {
    const row = e.target.closest && e.target.closest('.row');
    const chk = row && row.querySelector('button.chk[data-check], button.chk[data-prepdone]');
    lsw = chk && !e.target.closest('textarea, input, select') ? { row, chk, x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0 } : null;
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (e) => {
    if (!lsw) return;
    const dx = e.touches[0].clientX - lsw.x,
      dy = e.touches[0].clientY - lsw.y;
    if (Math.abs(dy) > Math.abs(dx)) {
      lsw.row.style.transform = '';
      lsw = null;
      return;
    }
    lsw.dx = Math.max(0, Math.min(dx, 120));
    lsw.row.style.transform = 'translateX(' + lsw.dx + 'px)';
    lsw.row.classList.toggle('swipe-go', lsw.dx > 70);
  },
  { passive: true }
);
document.addEventListener(
  'touchend',
  () => {
    if (!lsw) return;
    const { row, chk, dx } = lsw;
    lsw = null;
    row.style.transform = '';
    row.classList.remove('swipe-go');
    if (dx > 70) {
      if (navigator.vibrate) navigator.vibrate(12);
      chk.click();
    }
  },
  { passive: true }
);
/* ===== Drop 2: bar mode, open shifts, clock in to your checklist ===== */
document.documentElement.classList.toggle('barmode', barMode);
/** The checklist that goes with today's shift: Opening for early starts, Closing for late finishes, Mid otherwise. */
function shiftList() {
  const s = (data.shifts || []).find((x) => x.name === data.me.name && x.date === T() && x.status !== 'removed');
  const names = (data.checklists || []).map((c) => c.list);
  const pick = (re) => names.find((n) => re.test(n));
  if (!s) return '';
  if (mins(s.start) <= 8 * 60) return pick(/^open/i) || '';
  if (mins(s.end) >= 17 * 60) return pick(/^clos/i) || '';
  return pick(/^mid/i) || '';
}
document.addEventListener('change', (e) => {
  const f = e.target.closest && e.target.closest('form[data-form="request"]');
  if (f && e.target.name === 'type') {
    const w = f.querySelector('[data-reqshift]'),
      cover = e.target.value === 'Cover';
    if (w) w.hidden = !cover;
    const thru = f.querySelector('[data-reqthru]');
    if (thru) thru.hidden = e.target.value !== 'Time off';
  }
  if (f && e.target.name === 'shift') {
    const o = e.target.selectedOptions[0];
    if (o && o.dataset.date) f.elements.namedItem('date').value = o.dataset.date;
  }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-takeshift], [data-barmode], [data-recfav]');
  if (!b) return;
  const d = b.dataset;
  if (d.barmode !== undefined) {
    barMode = !barMode;
    save('pt-barmode', barMode ? '1' : '0');
    document.documentElement.classList.toggle('barmode', barMode);
    toast(barMode ? 'Bar mode on: bigger type, and the screen stays on in Recipes' : 'Bar mode off');
    return render();
  }
  if (d.recfav) {
    const f = recFavs(),
      i = f.indexOf(d.recfav);
    if (i >= 0) f.splice(i, 1);
    else f.unshift(d.recfav);
    save('pt-recfav', JSON.stringify(f.slice(0, 24)));
    return render();
  }
  if (d.takeshift) {
    const q = (data.requests || []).find((x) => x.id === d.takeshift);
    if (!d.undo && !confirm('Offer to take ' + (q ? first(q.from) + "'s shift on " + shortDay(q.date) : 'this shift') + '? A manager approves it.')) return;
    if (q) q.takenBy = d.undo ? '' : data.me.name;
    render();
    const r = await act('takeShift', { id: d.takeshift, undo: d.undo ? '1' : '' });
    if (r) toast(d.undo ? 'Withdrawn' : "Sent · we'll let you know when it's approved");
  }
});
/* swipe left or right on a recipe to move through its category */
let swX = null,
  swY = null;
document.addEventListener(
  'touchstart',
  (e) => {
    if (!e.target.closest || !e.target.closest('.rc')) return (swX = null);
    swX = e.touches[0].clientX;
    swY = e.touches[0].clientY;
  },
  { passive: true }
);
document.addEventListener(
  'touchend',
  (e) => {
    if (swX == null) return;
    const dx = e.changedTouches[0].clientX - swX,
      dy = e.changedTouches[0].clientY - swY;
    swX = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const btn = document.querySelector(`[data-swipe="${dx < 0 ? 'next' : 'prev'}"]`);
    if (btn) openRecipe(btn.dataset.recipe);
  },
  { passive: true }
);

/* ===== Drop 1: Today inbox, search everywhere, shift handoff ===== */
/** Where this person is: 'new' (trainee, Level I, or manual not signed), 'staff', or 'lead'. Decides the bottom bar. */
function stage() {
  if (!data || !data.me) return 'staff';
  if (lead()) return 'lead';
  const L = data.levels && data.levels[data.me.name],
    c = L ? L.code : 'T';
  return /^(T|L1)$/.test(c) || (data.trBadge && data.trBadge.manual) ? 'new' : 'staff';
}
const SRCH = { open: false, q: '' };
const HO = { open: false, low: '', prepped: '', issues: '', note: '', nothing: false, busy: false };
/** Everything someone might look for, from what the app already has on this phone. */
function searchIndex() {
  const idx = [];
  if (on('recipes')) (data.recipes || []).forEach((r) => idx.push({ w: r.type === 'Prep' ? 'Prep recipe' : 'Drink', t: r.name, x: [r.cat, r.size, (r.ing || []).join(' '), (r.steps || []).join(' '), r.notes].join(' '), a: `data-recipe="${esc(r.id)}"` }));
  (data.checklists || []).forEach((c) => (c.items || []).forEach((it) => idx.push({ w: 'Checklist · ' + c.list, t: it.task, x: [it.section, it.notes].join(' '), a: `data-golist="${esc(c.list)}"` })));
  if (on('chat')) (data.people || []).filter((p) => p.id !== data.meId).forEach((p) => idx.push({ w: 'Message', t: p.name, x: p.role, a: `data-dm="${esc(p.id)}" data-dmname="${esc(p.name)}"` }));
  (data.announcements || []).forEach((a) => idx.push({ w: 'Announcement', t: a.title, x: a.message, a: 'data-more="news"' }));
  (data.links || []).forEach((l) => idx.push({ w: 'Document', t: l.name, x: l.tier || '', a: `data-tr="doclink" data-id="${esc(l.id)}"` }));
  [['Requests', 'requests', 'request time off swap cover open shift pick up', 'requests'], ['Availability', 'avail', 'availability days', 'availability'], [mgr() ? 'Time sheets' : 'My time', 'time', 'hours pay timecard punches', 'timeclock'], ['Dial-in log', 'dialin', 'espresso grind dose yield dial in', 'dialin'], ['Drawer count', 'drawer', 'drawer count cash deposit close', 'drawer'], ['Reminders', 'reminders', 'notifications email shift reminders', '']].filter((x) => !x[3] || on(x[3])).forEach(([t, k, x]) => idx.push({ w: 'App', t, x, a: `data-more="${k}"` }));
  if (TRN.res) {
    TRN.res.resources.forEach((r) => (r.sections || []).forEach((s, i) => idx.push({ w: r.title, t: s.title, x: s.b.filter((b) => typeof b === 'string').map(trStrip).join(' '), a: `data-tr="doc" data-id="${esc(r.id)}" data-i="${i}"` })));
    TRN.res.manual.forEach((c) => c.sections.forEach((s) => idx.push({ w: 'Employee Manual', t: s.title, x: s.b.filter((b) => typeof b === 'string').map(trStrip).join(' '), a: 'data-trsub="manual"' })));
  }
  return idx;
}
function runSearch() {
  const box = $('#gshits');
  if (!box) return;
  const words = SRCH.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return (box.innerHTML = '<p class="sub" style="margin:10px 4px">Recipes, checklist steps, people, announcements, documents, the manual and resources.</p>');
  const hits = searchIndex()
    .map((e) => {
      const hay = (e.t + ' ' + e.x).toLowerCase();
      return words.every((w) => hay.indexOf(w) >= 0) ? { e, s: words.filter((w) => e.t.toLowerCase().indexOf(w) >= 0).length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.s - a.s)
    .slice(0, 50);
  const snip = (t) => {
    const lo = String(t).toLowerCase();
    let at = -1;
    words.some((w) => (at = lo.indexOf(w)) >= 0);
    const s = Math.max(0, at - 40);
    let o = esc((s ? '…' : '') + String(t).slice(s, s + 140) + (s + 140 < String(t).length ? '…' : ''));
    words.forEach((w) => w.length > 1 && (o = o.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>')));
    return o;
  };
  box.innerHTML = hits.length
    ? `<div class="card">${hits.map(({ e }) => `<button class="row rb trhit" ${e.a} data-gsclose><div class="txt"><div class="trw">${esc(e.w)}</div><b>${snip(e.t)}</b>${e.x ? `<div class="sub">${snip(e.x)}</div>` : ''}</div><span>›</span></button>`).join('')}</div>`
    : '<p class="sub" style="margin:10px 4px">Nothing matches. Try fewer or different words.</p>';
}
function viewSearch() {
  if (!TRN.res && !lead()) trLoadRes();
  else if (!TRN.res) trLoadRes();
  setTimeout(() => {
    const i = $('#gsq');
    if (i && document.activeElement !== i) i.focus();
    runSearch();
  }, 0);
  return `<div class="btns" style="margin-bottom:8px"><button class="btn sm" data-gsclose>‹ Back</button></div><h1>Search</h1>
    <input class="search" id="gsq" type="search" placeholder="Search everything" value="${esc(SRCH.q)}" autocomplete="off" aria-label="Search everything"><div id="gshits"></div>`;
}
/** The handoff the person leaves when they clock out. */
function viewHandoff() {
  const f = (id, label, ph, rows) => `<label class="f">${label}<textarea id="${id}" rows="${rows || 2}" placeholder="${ph}">${esc(HO[id.slice(2)] || '')}</textarea></label>`;
  return `<div class="btns" style="margin-bottom:8px"><button class="btn sm" data-hocancel>‹ Back</button></div><h1>Shift handoff</h1>
    <p class="sub" style="margin:-4px 4px 10px">The next shift sees this on Today. Then you're clocked out.</p>
    ${CK.note ? `<div class="card"><div class="row"><div class="txt"><div class="sub">Goes in with your handoff</div><div>${esc(CK.note).replace(/\n/g, '<br>')}</div></div></div></div>` : ''}
    <div class="card"><form class="stack" onsubmit="return false">
      ${f('holow', 'Ran out or running low', 'e.g. oat milk, 12oz lids, almond croissants')}
      ${f('hoprepped', 'Prepped', 'e.g. chai concentrate, 2 iced teas, matcha')}
      ${f('hoissues', 'Equipment or issues', 'e.g. group 3 dripping, dish machine slow to drain')}
      ${f('honote', 'Anything else the next shift should know', '', 3)}
      <label class="trcheck"><input type="checkbox" id="honothing" ${HO.nothing ? 'checked' : ''}> Nothing to hand off</label>
      <button class="btn go" data-hosubmit ${HO.busy ? 'disabled' : ''}>${HO.busy ? 'Clocking out…' : 'Save handoff and clock out'}</button></form></div>`;
}
/** Handoffs from the last day the person hasn't read yet. */
function handoffCard() {
  const hs = (data.handoffs || []).filter((h) => !h.read);
  if (!hs.length) return '';
  const part = (l, v) => (v ? `<div class="row"><div class="txt"><div class="sub">${l}</div><div>${esc(v).replace(/\n/g, '<br>')}</div></div></div>` : '');
  return `<h2>Shift handoff</h2>${hs
    .map((h) => `<div class="card"><div class="row"><img class="trmark" src="brand/bird-gold.png" alt=""><div class="txt"><b>From ${esc(first(h.name))}</b><div class="sub">${timeOf(h.at)}${h.for !== undefined ? ' · for ' + (h.for ? esc(h.for) : 'managers only (nobody scheduled next)') : ''}</div></div><button class="btn sm go" data-horead="${esc(h.id)}">Got it</button></div>
      ${part('Ran out or running low', h.low)}${part('Prepped', h.prepped)}${part('Equipment or issues', h.issues)}${part('Note', h.note)}</div>`)
    .join('')}`;
}
/** New hires: one guided path through their first week. Disappears once every step is done. */
function firstWeekCard() {
  if (stage() !== 'new' || lead()) return '';
  const d = data,
    b = d.trBadge || {},
    L = d.levels && d.levels[d.me.name],
    code = L ? L.code : 'T',
    M = d.myTraining || {},
    t = M.me,
    items = M.items || [],
    got = t ? items.filter((it) => t.done[it.skill]).length : 0;
  const home = window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone);
  const steps = [
    ['Sign the Employee Manual', 'Training › Manual', !b.manual, 'data-tab="tests" data-trsub="manual"', 'manual'],
    ['Add the app to your Home Screen', 'So it opens like any app', !!home, 'data-more="push"'],
    ['Turn on notifications', 'Shift reminders, schedule changes, messages', typeof pushOn_ === 'function' && pushOn_(), 'data-more="push"'],
    ['Upload your food handler certificate', b.food ? (/overdue/.test(b.food) ? 'Overdue' : 'Due ' + esc(b.food.replace(/^due /, ''))) : 'Due by the end of week 2', !!b.foodOn, 'data-tab="tests" data-trsub="forms"', 'foodhandler'],
    ['Level I study guide and test', 'Within your first 4 shifts', code !== 'T', 'data-tab="tests" data-trsub="study"', 'tests'],
    ['Level I skill checklist', t ? got + ' of ' + items.length + ' skills checked off by your trainer' : 'Your trainer starts it with you', !!t && items.length > 0 && got === items.length, 'data-tab="tests" data-trsub="skills"', 'training'],
  ].filter((x) => !x[4] || on(x[4]));
  const done = steps.filter((x) => x[2]).length;
  if (done === steps.length) return '';
  return `<h2>Your first week</h2><div class="card"><div class="row"><div class="txt"><b>${done} of ${steps.length} done</b><div class="progress" style="margin-top:8px"><i style="width:${Math.round((done / steps.length) * 100)}%"></i></div></div></div>
    ${steps.map(([title, sub, ok, attrs]) => (ok ? `<div class="row fw-done"><span class="fwchk" aria-hidden="true">✓</span><div class="txt"><b>${title}</b></div></div>` : rowBtn(attrs, `<span class="fwchk todo" aria-hidden="true"></span><div class="txt"><b>${title}</b><div class="sub">${sub}</div></div><span>›</span>`))).join('')}</div>`;
}
/** One list of what needs this person, most urgent first. */
function forYouCard() {
  const fw = stage() === 'new' && !lead();
  const d = data,
    b = d.trBadge || {},
    items = [];
  const L = d.levels && d.levels[d.me.name],
    code = L ? L.code : '';
  const add = (attrs, title, sub, tone) => items.push(rowBtn(attrs, `<span class="fydot ${tone || ''}" aria-hidden="true"></span><div class="txt"><b>${title}</b>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span>›</span>`));
  if (b.sign) add('data-tab="tests" data-trsub="forms"', 'A document to sign', 'Training › Forms', 'warn');
  if (b.manual && !fw) add('data-tab="tests" data-trsub="manual"', 'Read and sign the Employee Manual', 'It unlocks the tests', 'warn');
  if (b.food && !fw) add('data-tab="tests" data-trsub="forms"', /overdue/.test(b.food) ? 'Food handler certificate is overdue' : 'Upload your food handler certificate', /overdue/.test(b.food) ? 'Upload it in Training › Forms' : 'Due ' + esc(b.food.replace(/^due /, '')), /overdue/.test(b.food) ? 'warn' : '');
  if (b.recipes) add('data-tab="tests" data-trsub="skills"', b.recipes + ' recipe change' + (b.recipes > 1 ? 's' : '') + ' to read', 'Before your next shift', '');
  const mustAck = (d.announcements || []).filter((a) => !a.read && a.mustAck);
  if (mustAck.length) add('data-more="news"', mustAck.length + ' announcement' + (mustAck.length > 1 ? 's' : '') + ' to acknowledge', esc(mustAck[0].title), 'warn');
  if (!lead()) {
    if (code === 'T' && !fw) add('data-tab="tests" data-trsub="study"', 'Next: the Level I study guide and test', 'Within your first 4 shifts', '');
    else if (code === 'L1') add('data-tab="tests" data-trsub="study"', 'Next: Level II and Coffee Knowledge', 'Study guides first, then the tests', '');
    else if (code === 'L2P') items.push(`<div class="row"><span class="fydot" aria-hidden="true"></span><div class="txt"><b>Level II passed</b><div class="sub">A Lead or Manager acknowledges your proficiency on shift for the raise</div></div></div>`);
  }
  if (lead() && TRN.dash) {
    const ack = TRN.dash.team.filter((p) => p.level.code === 'L2P').length;
    if (ack) add('data-tab="tests" data-trsub="dash"', ack + ' waiting on a Level II acknowledgment', 'Training › Progress', '');
  }
  const swaps = (d.requests || []).filter((q) => q.status === 'Pending' && q.from !== d.me.name && (mgr() || (q.type !== 'Time off' && String(q.details || '').indexOf(d.me.name) >= 0)));
  if (swaps.length) add('data-more="requests"', swaps.length + ' request' + (swaps.length > 1 ? 's' : '') + ' waiting on you', mgr() ? 'To approve' : 'Swaps and covers that name you', '');
  return items.length ? `<h2>For you</h2><div class="card">${items.join('')}</div>` : '';
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'gsq') {
    SRCH.q = e.target.value;
    runSearch();
  }
  if (/^ho(low|prepped|issues|note)$/.test(e.target.id || '')) HO[e.target.id.slice(2)] = e.target.value;
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'honothing') HO.nothing = e.target.checked;
});
document.addEventListener(
  'click',
  async (e) => {
    const b = e.target.closest && e.target.closest('[data-gsopen], [data-gsclose], [data-hocancel], [data-hosubmit], [data-horead], [data-clock="out"]');
    if (!b) return;
    const d = b.dataset;
    if (d.clock === 'out' && data && data.handoffRequired && !HO.done && !CK.open) {
      e.stopImmediatePropagation();
      e.preventDefault();
      HO.open = true;
      tab = 'today';
      window.scrollTo(0, 0);
      return render();
    }
    if (d.gsopen !== undefined) {
      SRCH.open = true;
      tab = 'today';
      window.scrollTo(0, 0);
      return render();
    }
    if (d.gsclose !== undefined) {
      SRCH.open = false;
      if (b.id || b.classList.contains('btn')) return render();
      setTimeout(render, 0); // a result: let its own handler run, then close search
      return;
    }
    if (d.hocancel !== undefined) {
      HO.open = false;
      Object.assign(CK, { note: '', pass: false });
      return render();
    }
    if (d.horead) {
      const h = (data.handoffs || []).find((x) => x.id === d.horead);
      if (h) h.read = true;
      render();
      act('readHandoff', { id: d.horead });
      return;
    }
    if (d.hosubmit !== undefined) {
      if (!(HO.low || HO.prepped || HO.issues || HO.note || CK.note).trim() && !HO.nothing) return toast('Fill in at least one part, or tick "Nothing to hand off"');
      const note = [CK.note, HO.note].filter((x) => String(x || '').trim()).join('\n\n');
      HO.busy = true;
      render();
      const pos = await getPos();
      const r = await act('clockOut', Object.assign({ handoff: { low: HO.low, prepped: HO.prepped, issues: HO.issues, note, nothing: HO.nothing && !CK.note } }, pos));
      HO.busy = false;
      if (r) {
        Object.assign(HO, { open: false, low: '', prepped: '', issues: '', note: '', nothing: false });
        Object.assign(CK, { skip: {}, note: '' });
        toast('Handoff saved · clocked out · have a good one');
      }
      render();
    }
  },
  true
);

/* ===== Training tab =====
   Study & tests: the test portal (study guides and tests), signed in. Everything else lives here and on this app's
   server (Training.gs): the Employee Manual, Resources, Forms and the Lead/Manager dashboards. */
const TRN = { sub: '', home: null, homeAt: 0, man: null, at: 0, checks: {}, res: null, doc: null, q: '', dash: null, filter: '', busy: '' };
async function trCall(call, args) {
  try {
    return await post({ fn: 'hr', token: TOKEN, call, args: args || {} });
  } catch (e) {
    const m = String(e.message || e);
    if (/^signin/.test(m)) signOut(m.replace(/^signin:\s*/, ''));
    throw new Error(m);
  }
}
async function trLoadHome(force) {
  if (TRN.busy === 'home' || (!force && TRN.home && Date.now() - TRN.homeAt < 60000)) return;
  TRN.busy = 'home';
  try {
    TRN.home = await trCall('home');
    TRN.homeAt = Date.now();
  } catch (e) {
    toast(e.message);
  }
  TRN.busy = '';
  if (tab === 'tests') render();
}
const trEsc = (s) => esc(s == null ? '' : s);
function trPillsHtml() {
  const subs = [['skills', 'Checklist', 'training'], ['study', 'Study & tests', 'tests'], ['manual', 'Manual', 'manual'], ['res', 'Resources', 'library'], ['forms', 'Forms', '']]
    .concat(lead() ? [['dash', 'Progress', 'progress']] : [])
    .filter(([k, , f]) => (k === 'forms' ? on('hr') || on('foodhandler') : on(f)));
  const H = TRN.home || {},
    n = { skills: lead() ? ((data.training || {}).active || []).length : 0, manual: H.manual && !H.manual.acked ? 1 : 0, forms: (H.docs || []).length + (H.food && !H.food.onFile ? 1 : 0) };
  return `<div class="seg trseg">${subs.map(([k, l]) => `<button data-trsub="${k}" aria-pressed="${TRN.sub === k}">${l}${n[k] ? ' ' + n[k] : ''}</button>`).join('')}</div>`;
}
function trDiff(a, b) {
  const A = String(a || '').split('\n'),
    B = String(b || '').split('\n');
  return `<div class="trdiff">${A.filter((l) => B.indexOf(l) < 0).map((l) => `<span class="del">− ${trEsc(l)}</span>`).concat(B.map((l) => (A.indexOf(l) < 0 ? `<span class="add">+ ${trEsc(l)}</span>` : trEsc(l)))).join('\n')}</div>`;
}
function trAlertHtml() {
  const al = (TRN.home && TRN.home.alerts) || [];
  if (!al.length) return '';
  return `<h2>Recipe changes</h2><div class="card tralert"><div class="row"><img class="trmark" src="brand/bird-gold.png" alt=""><div class="txt"><b>${al.length} recipe change${al.length > 1 ? 's' : ''} since you last checked</b><div class="sub">Read the new builds before your next shift. Tap one to see what changed.</div></div></div>
    ${al.map((c) => `<details class="row"><summary><b>${trEsc(c.recipe)}</b> <span class="pill mute">${trEsc(c.change)}</span><div class="sub">${trEsc(c.type)} · ${trEsc(c.date)}</div></summary>${c.change === 'Removed' ? '<p class="sub">Taken off the recipe list.</p>' : trDiff(c.before, c.after)}</details>`).join('')}
    <div class="row"><div class="txt"></div><button class="btn sm go" data-tr="recipeok">Got it</button></div></div>`;
}
function viewTests() {
  trLoadHome();
  const okSubs = [['skills', 'training'], ['study', 'tests'], ['manual', 'manual'], ['res', 'library'], ['forms', 'hr'], ['dash', 'progress']].filter(([k, f]) => (k === 'forms' ? on('hr') || on('foodhandler') : on(f)) && (k !== 'dash' || lead())).map((x) => x[0]);
  if (!TRN.sub || okSubs.indexOf(TRN.sub) < 0) TRN.sub = okSubs[0] || '';
  if (!TRN.sub) return '<h1>Training</h1><div class="card"><div class="empty">Training is turned off for this shop.</div></div>';
  const body = TRN.sub === 'skills' ? trSkillsView() : TRN.sub === 'manual' ? trManualView() : TRN.sub === 'res' ? trResView() : TRN.sub === 'forms' ? trFormsView() : TRN.sub === 'dash' && lead() ? trDashView() : trStudyView();
  setTimeout(trAfter, 0);
  return `<div class="trhub"><h1>Training ${levelPill(data.me.name)}</h1>${trPillsHtml()}${trAlertHtml()}${body}</div>`;
}
/* --- Checklist: the Level I skill checklist. Leads and managers: every trainee, editable. Staff: their own, read-only. --- */
function trSkillsView() {
  if (lead()) return viewTraining(true);
  const M = data.myTraining,
    t = M && M.me;
  if (!t) return '<div class="card"><div class="empty">You don\'t have a training checklist right now. Your trainer starts one when you begin, and you\'ll see your progress here.</div></div>';
  const items = M.items || [],
    secs = [...new Set(items.map((x) => x.section))],
    d = items.filter((it) => t.done[it.skill]).length,
    pct = items.length ? Math.round((d / items.length) * 100) : 0;
  const r = t.test,
    test = t.score !== '' && t.score != null ? `<span class="pill ${Number(t.score) >= 12 ? 'ok' : 'warn'}">Test ${esc(t.score)}/15</span>` : r ? `<span class="pill ${r.s === 'pass' ? 'ok' : r.s === 'wait' ? 'mute' : 'warn'}">${r.s === 'pass' ? 'Test passed' : r.s === 'wait' ? 'Test being scored' : 'Test not passed yet'}${r.score !== '' && r.s !== 'wait' ? ' ' + esc(r.score) + (r.outOf ? '/' + esc(r.outOf) : '') : ''}</span>` : '';
  const row = (it) => {
    const x = t.done[it.skill];
    return `<div class="row trow ${x ? 'on' : ''}"><span class="tchk" aria-pressed="${x ? 'true' : 'false'}" aria-hidden="true" style="cursor:default">${x ? '✓' : ''}</span><div class="txt"><b>${esc(it.skill)}</b><div class="sub">${esc(it.standard)}</div>${x ? `<div class="sub tby">✓ ${esc(first(x.by))}${x.at ? ' · ' + shortDay(ymdOf(new Date(x.at))) : ''}${x.note ? ' · ' + esc(x.note) : ''}</div>` : ''}</div></div>`;
  };
  return `<h2>My Level I checklist</h2><div class="card"><div class="row"><div class="txt"><b>${d} of ${items.length} skills checked off</b><div class="progress" style="margin-top:8px"><i style="width:${pct}%"></i></div>
      <div class="sub" style="margin-top:6px">Trainer: ${esc(t.trainer || '—')}${t.started ? ' · started ' + shortDay(t.started) : ''}</div></div>${test}</div></div>
    ${secs.map((sec) => `<h2>${esc(sec)}</h2><div class="card">${items.filter((x) => x.section === sec).map(row).join('')}</div>`).join('')}
    <p class="sub">Your trainer checks skills off as you show them on shift. Ask them if something looks wrong.</p>`;
}
function trStudyView() {
  if (!tdata || Date.now() - tAt > 60000) loadTests();
  const H = TRN.home || {};
  const gate = H.manual && H.manual.gates && !H.manual.acked && !mgr() ? `<div class="hint trlock"><img class="trmark" src="brand/bird-gold.png" alt=""><span>Read and sign the <button class="linkbtn" data-trsub="manual">Employee Manual</button> to unlock the tests.</span></div>` : '';
  if (!tdata) return gate + '<div class="card"><div class="empty">Loading…</div></div>';
  if (!tdata.portal) return gate + '<div class="card"><div class="empty">The study guides and tests aren\'t connected yet. A manager needs to add Settings › Training service secret.</div></div>';
  if (!trainSrc || Date.now() > trainUntil) {
    trainSrc = tdata.portal;
    trainUntil = Date.now() + 10 * 3600e3;
  }
  return gate + `<div class="trainframe"><iframe src="${trEsc(trainSrc)}" title="Study guides and tests" allow="clipboard-write"></iframe></div>`;
}
/* --- Employee Manual --- */
function trPages() {
  const out = [];
  (TRN.man ? TRN.man.chapters : []).forEach((c, ci) => {
    c.sections.forEach((s, si) => out.push({ kind: 'sec', id: s.id, ci, si }));
    if (c.check.length) out.push({ kind: 'check', id: c.id + 'q', ci });
  });
  return out;
}
async function trLoadManual() {
  if (TRN.busy === 'man') return;
  TRN.busy = 'man';
  try {
    TRN.man = await trCall('manual');
    TRN.man.doneSet = {};
    TRN.man.done.forEach((id) => (TRN.man.doneSet[id] = true));
    const P = trPages(),
      i = P.findIndex((p) => !TRN.man.doneSet[p.id]);
    TRN.at = i < 0 ? 0 : i;
  } catch (e) {
    toast(e.message);
  }
  TRN.busy = '';
  if (tab === 'tests') render();
}
function trManualView() {
  if (!TRN.man) {
    trLoadManual();
    return '<div class="card"><div class="empty">Opening the manual…</div></div>';
  }
  const M = TRN.man,
    P = trPages(),
    p = P[TRN.at] || P[0],
    c = M.chapters[p.ci],
    st = M.status,
    n = P.filter((x) => M.doneSet[x.id]).length,
    pct = Math.round((n / P.length) * 100);
  const toc = M.chapters.map((ch, ci) => `<option value="${P.findIndex((x) => x.ci === ci)}" ${ci === p.ci ? 'selected' : ''}>${ci + 1}. ${trEsc(ch.title)}${P.filter((x) => x.ci === ci).every((x) => M.doneSet[x.id]) ? ' ✓' : ''}</option>`).join('');
  let h = `<h2>Employee Manual</h2><div class="card"><div class="row"><div class="txt"><b>${st.acked ? 'Signed ' + trEsc(st.acked) : n === P.length ? 'Ready to sign' : n + ' of ' + P.length + ' done'}</b><div class="progress" style="margin-top:8px"><i style="width:${pct}%"></i></div></div>${st.acked ? '<span class="pill ok">Signed</span>' : ''}</div>
    <form class="stack" onsubmit="return false"><label class="f">Chapter<select data-trchap>${toc}</select></label></form></div>`;
  if (!st.acked && (n === P.length || st.complete))
    h += `<h2>Acknowledgment</h2><div class="card"><form class="stack" onsubmit="return false"><div>You've read every section. Sign below to finish.</div>
      <label class="trcheck"><input type="checkbox" id="trackok"> I have read the Peregrine Employee Manual and agree to follow it.</label>
      <label class="f">Type your full name to sign<input id="tracknm" placeholder="${trEsc(data.me.name)}" autocomplete="off"></label><button class="btn go" data-tr="manack">Sign</button></form></div>`;
  h += `<h2>Chapter ${p.ci + 1} · ${trEsc(c.title)}</h2><div class="card trdoc"><div class="trbody">`;
  if (p.kind === 'sec') {
    const s = c.sections[p.si];
    h += `<div class="trtitle">${trEsc(s.title)}</div>${p.si === 0 && c.intro ? `<p class="sub">${trEsc(c.intro)}</p>` : ''}${s.b.map((b) => (typeof b === 'string' ? b : '')).join('')}
      <div class="btns trnav"><button class="btn" data-tr="manprev" ${TRN.at === 0 ? 'disabled' : ''}>‹ Back</button><button class="btn go" data-tr="mannext">${M.doneSet[p.id] ? 'Next ›' : 'Done reading ›'}</button></div>`;
  } else {
    const ck = TRN.checks[p.id] || (TRN.checks[p.id] = {}),
      solved = M.doneSet[p.id];
    h += `<div class="trtitle">Chapter check</div><p class="sub">Answer each one correctly to finish the chapter. It isn't graded.</p>` +
      c.check.map((q, qi) => {
        const s = ck[qi] || {},
          ok = solved || s.right;
        return `<div class="trq"><b>${qi + 1}. ${trEsc(q.p)}</b>${q.o.map((o, oi) => `<button class="tropt ${ok && oi === q.a ? 'right' : s.tried && s.tried[oi] && oi !== q.a ? 'wrong' : ''}" data-tr="ans" data-q="${qi}" data-o="${oi}" ${ok ? 'disabled' : ''}>${trEsc(o)}</button>`).join('')}${ok ? `<div class="sub" style="color:var(--ok,#3d7a47)">✓ ${trEsc(q.why)}</div>` : s.no ? '<div class="sub" style="color:#b5462b">Not quite. Try another answer.</div>' : ''}</div>`;
      }).join('') +
      `<div class="btns trnav"><button class="btn" data-tr="manprev">‹ Back</button><button class="btn go" data-tr="mannext" ${solved || c.check.every((_, qi) => ck[qi] && ck[qi].right) ? '' : 'disabled'}>Next ›</button></div>`;
  }
  return h + '</div></div>';
}
function trManMark(id) {
  if (TRN.man.doneSet[id]) return;
  TRN.man.doneSet[id] = true;
  trCall('manualStep', { id })
    .then((r) => {
      if (r.complete) TRN.man.status.complete = true;
      if (TRN.home && TRN.home.manual) TRN.home.manual.done = r.done;
    })
    .catch((e) => {
      delete TRN.man.doneSet[id];
      toast('Not saved – ' + e.message);
      render();
    });
}
/* --- Resources --- */
async function trLoadRes() {
  if (TRN.busy === 'res') return;
  TRN.busy = 'res';
  try {
    TRN.res = await trCall('resources');
  } catch (e) {
    toast(e.message);
  }
  TRN.busy = '';
  if (tab === 'tests') render();
}
function trResView() {
  if (!TRN.res) {
    trLoadRes();
    return '<div class="card"><div class="empty">Loading resources…</div></div>';
  }
  if (TRN.doc) {
    const r = TRN.res.resources.find((x) => x.id === TRN.doc.id);
    if (r && r.sections)
      return `<div class="btns" style="margin-bottom:4px"><button class="btn sm" data-tr="resback">‹ Resources</button></div><h2>${trEsc(r.title)}</h2>
        ${r.sections.map((s, i) => `<div class="card trdoc" id="trsec${i}"><div class="trbody">${r.sections.length > 1 ? `<div class="trtitle">${trEsc(s.title)}</div>` : ''}${s.b.map((b) => (typeof b === 'string' ? b : b.live === 'list' ? `<div class="btns" style="margin:12px 0"><button class="btn go" data-golist="${trEsc(b.list)}">Open the ${trEsc(b.list)} checklist ›</button></div>` : `<div data-trlive="${trEsc(b.live)}"></div>`)).join('')}</div></div>`).join('')}`;
  }
  const item = (attrs, ic, t, sub, hue) => rowBtn(attrs, `<span class="tric" style="--hue:${hue}" aria-hidden="true">${ic}︎</span><div class="txt"><b>${t}</b><div class="sub">${sub}</div></div><span>›</span>`);
  return `<input class="search" id="trq" type="search" placeholder="Search a drink, a policy, a cleaning step…" value="${trEsc(TRN.q)}" autocomplete="off" aria-label="Search resources"><div id="trhits"></div>
    <div id="trgrid"><h2>Library</h2><div class="card">${item('data-trsub="manual"', '❏', 'Employee Manual', TRN.home && TRN.home.manual && TRN.home.manual.acked ? 'Signed' : 'Read and sign it', 188)}
    ${TRN.res.resources.map((r, i) => item(r.more ? `data-more="${r.more}"` : r.golist ? `data-golist="${trEsc(r.golist)}"` : r.tab ? `data-tab="${r.tab}"` : `data-tr="doc" data-id="${trEsc(r.id)}"`, trEsc(r.icon), trEsc(r.title) + (r.who === 'lead' ? ' <span class="pill mute">Leads</span>' : ''), trEsc(r.blurb), [28, 340, 150, 210, 260, 100, 188, 36][i % 8])).join('')}</div>
    ${(data.links || []).length ? `<h2>Documents</h2><div class="card">${(data.links || []).map(resRow).join('')}</div>` : ''}</div>`;
}
const trStrip = (h) => {
  const d = document.createElement('div');
  d.innerHTML = String(h).replace(/<[^>]+>/g, ' ');
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
};
function trIndex() {
  if (TRN.idx) return TRN.idx;
  const idx = [];
  TRN.res.resources.forEach((r) => (r.sections || []).forEach((s, i) => idx.push({ w: r.title, t: s.title, x: s.b.filter((b) => typeof b === 'string').map(trStrip).join(' '), go: { doc: r.id, i } })));
  Object.keys(TRN.res.sidework || {}).forEach((d) => TRN.res.sidework[d].forEach((t) => idx.push({ w: 'Side Work · ' + d, t: t[0], x: t[1], go: { doc: 'sidework', i: 0 } })));
  TRN.res.manual.forEach((c) => c.sections.forEach((s) => idx.push({ w: 'Employee Manual · ' + c.title, t: s.title, x: s.b.filter((b) => typeof b === 'string').map(trStrip).join(' '), go: { man: 1 } })));
  (data.links || []).forEach((l) => idx.push({ w: 'Documents', t: l.name, x: l.tier || '', go: { link: l.id } }));
  (data.recipes || []).forEach((r) => idx.push({ w: r.type === 'Prep' ? 'Prep Recipe Book' : 'Drink Build Menu', t: r.name, x: [r.cat, r.size, (r.ing || []).join(' '), (r.steps || []).join(' '), r.notes].join(' '), go: { recipe: r.id } }));
  return (TRN.idx = idx);
}
function trSearch() {
  const box = $('#trhits'),
    grid = $('#trgrid');
  if (!box) return;
  const words = TRN.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (grid) grid.style.display = words.length ? 'none' : '';
  if (!words.length) return (box.innerHTML = '');
  const hits = trIndex()
    .map((e) => {
      const hay = (e.t + ' ' + e.x).toLowerCase();
      if (!words.every((w) => hay.indexOf(w) >= 0)) return null;
      return { e, s: words.filter((w) => e.t.toLowerCase().indexOf(w) >= 0).length };
    })
    .filter(Boolean)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40);
  const snip = (t) => {
    const lo = t.toLowerCase();
    let at = -1;
    words.some((w) => (at = lo.indexOf(w)) >= 0);
    const s = Math.max(0, at - 50);
    let o = trEsc((s ? '…' : '') + t.slice(s, s + 170) + (s + 170 < t.length ? '…' : ''));
    words.forEach((w) => w.length > 1 && (o = o.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>')));
    return o;
  };
  box.innerHTML = hits.length
    ? `<div class="card">${hits.map(({ e }) => `<button class="row rb trhit" ${e.go.recipe ? `data-recipe="${trEsc(e.go.recipe)}"` : e.go.link ? `data-tr="doclink" data-id="${trEsc(e.go.link)}"` : e.go.man ? 'data-trsub="manual"' : `data-tr="doc" data-id="${trEsc(e.go.doc)}" data-i="${e.go.i}"`}><div class="txt"><div class="trw">${trEsc(e.w)}</div><b>${snip(e.t)}</b><div class="sub">${snip(e.x)}</div></div></button>`).join('')}</div>`
    : `<p class="sub">Nothing matches. Try fewer or different words.</p>`;
}
function trToday() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function trAfter() {
  if (tab !== 'tests') return;
  if ($('#trq') && $('#trhits') && !$('#trhits').dataset.done) {
    $('#trhits').dataset.done = '1';
    trSearch();
  }
  // tap-to-check lists, remembered on this phone for the day
  document.querySelectorAll('.trdoc ul.tick').forEach((ul, ui) => {
    const key = 'pt-tick-' + (TRN.doc ? TRN.doc.id : 'x') + '-' + ui + '-' + trToday();
    let st = {};
    try {
      st = JSON.parse(load(key) || '{}');
    } catch (e) {}
    ul.querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('done', !!st[i]);
      li.dataset.tick = key + '|' + i;
    });
  });
  document.querySelectorAll('[data-trlive]').forEach((el) => {
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    if (el.dataset.trlive === 'sidework') trSidework(el, '');
    if (el.dataset.trlive === 'deposit')
      el.innerHTML = `<div class="hint trdep"><b>Deposit calculator</b><label class="f" style="margin-top:8px">Drawer total from Count Bills ($)<input type="number" step="0.01" inputmode="decimal" data-trdep placeholder="242.30"></label><div class="trdepout"></div></div>`;
  });
  if (TRN.jump != null) {
    const s = $('#trsec' + TRN.jump);
    TRN.jump = null;
    if (s) s.scrollIntoView();
  }
}
function trSidework(el, day) {
  const SW = TRN.res.sidework || {},
    days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    now = days[(new Date().getDay() + 6) % 7],
    cur = day || now;
  el.innerHTML = `<div class="seg">${days.map((d) => `<button data-trday="${d}" aria-pressed="${d === cur}">${d.slice(0, 3)}${d === now ? '•' : ''}</button>`).join('')}</div>
    <div class="trtitle">${cur}${cur === now ? ' · today' : ''}</div><ul class="tick">${(SW[cur] || []).map((t) => `<li><span><b>${trEsc(t[0])}</b><br><span class="sub">${trEsc(t[1])}</span></span></li>`).join('')}</ul>`;
  const key = 'pt-tick-sidework-' + cur + '-' + trToday();
  let st = {};
  try {
    st = JSON.parse(load(key) || '{}');
  } catch (e) {}
  el.querySelectorAll('li').forEach((li, i) => {
    li.classList.toggle('done', !!st[i]);
    li.dataset.tick = key + '|' + i;
  });
}
/* --- Forms --- */
function trFormsView() {
  const H = TRN.home;
  if (!H) return '<div class="card"><div class="empty">Loading…</div></div>';
  const F = H.food || {},
    names = (data.people || []).map((p) => `<option value="${trEsc(p.name)}">`).join(''),
    f = (label, inner) => `<label class="f">${label}${inner}</label>`;
  let h = '';
  if ((H.docs || []).length) {
    h += '<h2>Waiting for your signature</h2>';
    H.docs.forEach((d) => {
      h += `<div class="card"><div class="row"><div class="txt"><b>${trEsc(d.title)}</b><div class="sub">From ${trEsc(d.by)} · ${trEsc(d.filed)}</div></div><span class="pill warn">Sign</span></div>
        ${d.fields.map((x) => `<div class="row"><div class="txt"><div class="sub">${trEsc(x[0])}</div><div>${trEsc(x[1]).replace(/\n/g, '<br>')}</div></div></div>`).join('')}
        <form class="stack" onsubmit="return false"><div class="sub">Signing means you received this, not that you agree. You can add your side below.</div>
        ${f('Your comments (optional)', `<textarea rows="3" data-trcomment="${trEsc(d.id)}"></textarea>`)}<button class="btn go" data-tr="sign" data-id="${trEsc(d.id)}">Sign as received</button></form></div>`;
    });
  }
  if (!on('foodhandler')) return h + (on('hr') ? trFormsHr(H, f, names) : '');
  h += '<h2>Food handler certificate</h2><div class="card">';
  h += F.onFile
    ? `<div class="row"><div class="txt"><b>Certificate on file</b><div class="sub">Uploaded ${trEsc(F.onFile.uploaded)}${F.onFile.expires ? ' · expires ' + trEsc(F.onFile.expires) : ''}</div></div><span class="pill ok">Done</span></div>`
    : `<div class="row"><div class="txt"><b>Upload your certificate</b><div class="sub">An accredited Texas food handler certificate. We pay back the course (up to $${F.max}) on your next paycheck.</div></div><span class="pill ${F.overdue ? 'warn' : 'mute'}">${F.overdue ? 'Overdue' : 'Due ' + trEsc(F.due || 'week 2')}</span></div>
      <form class="stack" onsubmit="return false">${f('Certificate (photo or PDF)', '<input type="file" id="trfc" accept="image/*,application/pdf">')}${f('Receipt (optional)', '<input type="file" id="trfr" accept="image/*,application/pdf">')}
      <div class="trtwo">${f('Expiration date', '<input id="trfe" placeholder="MM/DD/YYYY">')}${f('What you paid ($)', '<input id="trfp" type="number" step="0.01" inputmode="decimal" placeholder="7.00">')}</div>
      <button class="btn go" data-tr="food">Upload</button></form>`;
  h += '</div>';
  return h + (on('hr') ? trFormsHr(H, f, names) : '');
}
function trFormsHr(H, f, names) {
  let h = '';
  h += `<h2>Report a concern</h2><div class="card"><div class="row"><div class="txt"><b>Confidential</b><div class="sub">Harassment, discrimination, safety, or anything you aren't comfortable raising on shift. Handled as privately as possible. Retaliation for reporting in good faith is not allowed.</div></div></div>
    <form class="stack" onsubmit="return false">${f('Kind of concern', '<select id="trck"><option>Harassment</option><option>Sexual harassment</option><option>Discrimination</option><option>Threats or violence</option><option>Safety</option><option>Other</option></select>')}
    ${f('Who was involved', '<input id="trci">')}<div class="trtwo">${f('When', '<input id="trcd" placeholder="Date and time">')}${f('Where', '<input id="trcw">')}</div>
    ${f('What happened', '<textarea id="trcx" rows="5"></textarea>')}${f('Witnesses', '<input id="trcv">')}${f('Reported before? To whom?', '<input id="trcb">')}
    <label class="trcheck"><input type="checkbox" id="trcm"> This involves the Manager</label>
    <div class="hint" id="trcmnote" hidden style="margin:0">Please report this directly to the owner: ${trEsc(H.owner)}. Concerns that involve the Manager aren't submitted through the app.</div>
    <button class="btn go" data-tr="concern" id="trcgo">Submit privately</button></form></div>`;
  if (lead())
    h += `<h2>Lead report</h2><div class="card"><div class="row"><div class="txt"><div class="sub">Repeat conduct or performance (Policy 3), cash over $5 (1), safety or equipment (4), call-offs (13), trainee notes (7). Saved as a PDF in the person's HR folder.</div></div></div>
      <form class="stack" onsubmit="return false">${f('Type', '<select id="trlt"><option>Repeat conduct issue</option><option>Repeat performance issue</option><option>Cash discrepancy over $5</option><option>Safety or equipment incident</option><option>Staff called off or sent home</option><option>Trainee progress</option><option>Guest recovery beyond one item</option><option>Other</option></select>')}
      <div class="trtwo">${f('About (one person, if any)', '<input id="trla" list="trnames">')}${f('Date', '<input id="trld">')}</div>${f('Policy', '<input id="trlp" placeholder="e.g. Policy 3">')}
      ${f('What happened', '<textarea id="trlw" rows="4"></textarea>')}${f('Action taken', '<textarea id="trlx" rows="3"></textarea>')}<button class="btn go" data-tr="leadreport">File report</button></form></div>`;
  if (mgr())
    h += `<h2>Corrective action / write-up</h2><div class="card"><div class="row"><div class="txt"><div class="sub">Saved as a PDF in the employee's HR folder. They sign it as received in the app.</div></div></div>
      <form class="stack" onsubmit="return false"><div class="trtwo">${f('Employee', '<input id="trwe" list="trnames">')}${f('Step', '<select id="trws"><option>Coaching (documented)</option><option>Documented verbal warning</option><option>Written warning</option><option>Final written warning</option><option>Suspension</option><option>Termination</option></select>')}</div>
      <div class="trtwo">${f('Date of incident', '<input id="trwd">')}${f('Policy or standard', '<input id="trwp">')}</div>${f('What happened', '<textarea id="trww" rows="4"></textarea>')}
      ${f('Previous steps (dates)', '<textarea id="trwr" rows="2"></textarea>')}${f('What must change', '<textarea id="trwx" rows="3"></textarea>')}
      <div class="trtwo">${f('If it happens again', '<input id="trwc">')}${f('Probation (if any)', '<input id="trwb">')}</div><button class="btn go" data-tr="writeup">Save write-up</button></form></div>`;
  return h + `<datalist id="trnames">${names}</datalist>`;
}
/* --- Dashboard --- */
async function trLoadDash() {
  if (TRN.busy === 'dash') return;
  TRN.busy = 'dash';
  try {
    TRN.dash = await trCall('dash');
    TRN.dashAt = Date.now();
  } catch (e) {
    toast(e.message);
  }
  TRN.busy = '';
  if (tab === 'tests') render();
}
function trDashView() {
  if (!TRN.dash || Date.now() - (TRN.dashAt || 0) > 120000) trLoadDash();
  const D = TRN.dash;
  if (!D) return '<div class="card"><div class="empty">Loading the team…</div></div>';
  const T = D.team,
    groups = {
      train: T.filter((p) => /^(T|L1)$/.test(p.level.code)),
      ack: T.filter((p) => p.level.code === 'L2P'),
      man: T.filter((p) => !p.manual),
      food: T.filter((p) => !p.food.on && p.food.overdue),
      rc: T.filter((p) => p.unread),
    };
  const stat = (k, l) => rowBtn(`data-trfilter="${k}"`, `<div class="txt"><b>${l}</b></div><span class="pill ${TRN.filter === k ? 'ok' : groups[k].length ? '' : 'mute'}">${groups[k].length}</span><span>${TRN.filter === k ? '✕' : '›'}</span>`);
  const order = { T: 0, L1: 1, L2P: 2, L2: 3, LD: 4, MG: 5 },
    list = (groups[TRN.filter] || T).slice().sort((a, b) => order[a.level.code] - order[b.level.code] || a.name.localeCompare(b.name));
  const short = (n) => n.replace(/^Barista\s+/i, '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+[–-]\s+.*$/, '').trim();
  const names = { train: 'Still training', ack: 'Need a Level II acknowledgment', man: "Haven't signed the manual", food: 'Overdue food handler', rc: 'Unread recipe changes' };
  let h = `<h2>Needs attention</h2><div class="card">${Object.keys(names).map((k) => stat(k, names[k])).join('')}</div>`;
  h += `<h2>${TRN.filter ? trEsc(names[TRN.filter]) : 'Team'}</h2><div class="card">${
    list
      .map((p) => {
        const tests = D.tests.map((t) => (p.tests[t] ? `<span class="pill ${p.tests[t].s === 'pass' ? 'ok' : p.tests[t].s === 'wait' ? 'mute' : 'warn'}">${trEsc(short(t))}</span>` : '')).filter(Boolean).join(' ');
        const food = p.food.on ? 'Food handler on file' + (D.manager && p.food.amount ? ' · $' + p.food.amount.toFixed(2) : '') : 'Food handler ' + (p.food.overdue ? 'overdue' : 'due') + (p.food.due ? ' ' + trEsc(p.food.due) : '');
        return `<div class="row trperson"><div class="txt"><b>${trEsc(p.name)}</b>${levelPill(p.name)}
          <div class="trtests">${tests || '<span class="sub">No tests yet</span>'}</div>
          <div class="sub">${p.manual ? 'Manual signed' : '<span style="color:var(--warn)">Manual not signed</span>'} · ${p.food.overdue && !p.food.on ? `<span style="color:var(--warn)">${food}</span>` : food}${p.unread ? ' · ' + p.unread + ' recipe change' + (p.unread > 1 ? 's' : '') + ' unread' : ''}${p.prof ? ' · Level II acknowledged by ' + trEsc(first(p.prof)) : ''}</div></div>
          ${p.level.code === 'L2P' ? `<button class="btn sm go" data-tr="ackprof" data-who="${trEsc(p.name)}">Acknowledge</button>` : ''}</div>`;
      })
      .join('') || '<div class="empty">Nobody here.</div>'
  }</div>`;
  if (D.changes.length) h += `<h2>Recent recipe changes</h2><div class="card">${D.changes.map((c) => `<div class="row"><div class="txt"><b>${trEsc(c.recipe)}</b><div class="sub">${trEsc(c.type)} · ${trEsc(c.date)}</div></div><span class="pill mute">${trEsc(c.change)}</span></div>`).join('')}</div>`;
  if (D.manager) {
    h += `<h2>HR records</h2><div class="card">${D.hrFolder ? `<a class="row rb" href="${trEsc(D.hrFolder)}" target="_blank" rel="noopener" style="text-decoration:none"><div class="txt"><b>Open the HR folder</b><div class="sub">Every PDF, filed by person</div></div><span>↗</span></a>` : ''}${
      D.hr.map((x) => `<div class="row"><div class="txt"><b>${trEsc(x.type)}</b><div class="sub">${trEsc(x.about)} · by ${trEsc(first(x.by))} · ${trEsc(x.date)}</div></div>${x.link ? `<a class="btn sm" href="${trEsc(x.link)}" target="_blank" rel="noopener">PDF</a>` : `<span class="pill mute">${trEsc(x.status)}</span>`}</div>`).join('') || '<div class="empty">Nothing filed yet.</div>'
    }</div>`;
    h += `<h2>Reimbursements</h2><div class="card">${
      D.reimb.map((x) => `<div class="row"><div class="txt"><b>${trEsc(x.name)} · $${x.amount.toFixed(2)}</b><div class="sub">${trEsc(x.type)} · pay period from ${trEsc(x.period)}</div></div>${x.status === 'Queued' ? `<span class="pill mute">Queued</span><button class="btn sm" data-tr="void" data-id="${trEsc(x.id)}">Void</button>` : x.link ? `<a class="btn sm" href="${trEsc(x.link)}" target="_blank" rel="noopener">Payroll</a>` : `<span class="pill mute">${trEsc(x.status)}</span>`}</div>`).join('') || '<div class="empty">None yet.</div>'
    }</div>`;
  }
  return h;
}
function trFile(inp) {
  return new Promise((ok) => {
    const f = inp && inp.files && inp.files[0];
    if (!f) return ok(null);
    const r = new FileReader();
    r.onload = () => ok({ name: f.name, type: f.type, data: String(r.result).split(',')[1] });
    r.readAsDataURL(f);
  });
}
const trv = (id) => ($('#' + id) ? $('#' + id).value : '');
document.addEventListener('input', (e) => {
  if (e.target.id === 'trq') {
    TRN.q = e.target.value;
    trSearch();
  }
  if (e.target.dataset && e.target.dataset.trdep !== undefined) {
    const t = parseFloat(e.target.value),
      out = e.target.closest('.trdep').querySelector('.trdepout');
    if (!(t >= 0)) return (out.innerHTML = '');
    const r = Math.round(t),
      dep = r - 200;
    out.innerHTML =
      dep < 0
        ? `<p><b>No deposit.</b> The drawer is $${(200 - t).toFixed(2)} under $200. Recount first. ${200 - t > 5 ? 'Over $5: log it and tell the manager the same day.' : '$5 or less: note the amount, date, shift and cashier with the deposit.'}</p>`
        : `<p><b>Deposit: $${dep}.</b> Rounds to $${r}. Pull $${dep} and leave $${(t - dep).toFixed(2)} in the drawer.</p>`;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.matches && e.target.matches('[data-trchap]')) {
    TRN.at = Number(e.target.value) || 0;
    render();
    window.scrollTo(0, 0);
  }
  if (e.target.id === 'trcm') {
    $('#trcmnote').hidden = !e.target.checked;
    $('#trcgo').hidden = e.target.checked;
  }
});
document.addEventListener('click', async (e) => {
  const li = e.target.closest && e.target.closest('li[data-tick]');
  if (li) {
    const [key, i] = li.dataset.tick.split('|');
    let st = {};
    try {
      st = JSON.parse(load(key) || '{}');
    } catch (x) {}
    st[i] = !st[i];
    save(key, JSON.stringify(st));
    li.classList.toggle('done', !!st[i]);
    return;
  }
  const b = e.target.closest && e.target.closest('[data-trsub], [data-tr], [data-trfilter], [data-trday]');
  if (!b) return;
  const d = b.dataset;
  if (d.trsub) {
    TRN.sub = d.trsub;
    TRN.doc = null;
    save('pt-trsub', TRN.sub);
    if (tab !== 'tests') tab = 'tests';
    window.scrollTo(0, 0);
    return render();
  }
  if (d.trfilter) {
    TRN.filter = TRN.filter === d.trfilter ? '' : d.trfilter;
    return render();
  }
  if (d.trday) return trSidework(b.closest('[data-trlive]'), d.trday);
  const a = d.tr;
  try {
    if (a === 'recipeok') {
      b.disabled = true;
      await trCall('recipeAck', { ids: TRN.home.alerts.map((c) => c.id) });
      TRN.home.alerts = [];
      if (data.trBadge) data.trBadge.recipes = 0;
      toast('Thanks!');
    } else if (a === 'manprev') {
      TRN.at = Math.max(0, TRN.at - 1);
      window.scrollTo(0, 0);
    } else if (a === 'mannext') {
      const P = trPages(),
        p = P[TRN.at];
      if (p.kind === 'sec') trManMark(p.id);
      if (TRN.at < P.length - 1) TRN.at++;
      window.scrollTo(0, 0);
    } else if (a === 'ans') {
      const P = trPages(),
        p = P[TRN.at],
        q = TRN.man.chapters[p.ci].check[+d.q],
        ck = TRN.checks[p.id],
        s = ck[d.q] || (ck[d.q] = { tried: {} });
      s.tried[d.o] = true;
      if (+d.o === q.a) {
        s.right = true;
        s.no = false;
      } else s.no = true;
      if (TRN.man.chapters[p.ci].check.every((_, qi) => ck[qi] && ck[qi].right)) trManMark(p.id);
    } else if (a === 'manack') {
      b.disabled = true;
      const r = await trCall('manualAck', { agree: $('#trackok').checked, signature: trv('tracknm') });
      TRN.man.status.acked = r.acked;
      if (TRN.home) TRN.home.manual.acked = r.acked;
      if (data.trBadge) data.trBadge.manual = 0;
      toast('Signed. Thank you!');
    } else if (a === 'doc') {
      TRN.doc = { id: d.id };
      TRN.sub = 'res';
      TRN.jump = d.i ? Number(d.i) : null;
      window.scrollTo(0, 0);
    } else if (a === 'doclink') {
      const l = (data.links || []).find((x) => x.id === d.id);
      if (l) l.file ? openPdf(l.id) : window.open(l.url, '_blank', 'noopener');
      return;
    } else if (a === 'resback') {
      TRN.doc = null;
    } else if (a === 'jump') {
      const s = $('#trsec' + d.i);
      if (s) s.scrollIntoView({ behavior: 'smooth' });
      return;
    } else if (a === 'sign') {
      if (!confirm('Sign this as received?')) return;
      b.disabled = true;
      await trCall('sign', { id: d.id, comment: ($('[data-trcomment="' + d.id + '"]') || {}).value || '' });
      toast('Signed.');
      await trLoadHome(true);
    } else if (a === 'food') {
      if (!$('#trfc').files.length) return toast('Attach your certificate');
      b.disabled = true;
      b.textContent = 'Uploading…';
      const [f, r] = await Promise.all([trFile($('#trfc')), trFile($('#trfr'))]);
      const out = await trCall('food', { file: f, receipt: r, expires: trv('trfe'), cost: trv('trfp') });
      toast(out.amount ? '$' + out.amount.toFixed(2) + ' will be on payroll for ' + out.period : 'Uploaded. Thank you!');
      await trLoadHome(true);
    } else if (a === 'concern') {
      if (!trv('trcx').trim()) return toast('Describe what happened');
      if (!confirm('Submit this report privately?')) return;
      b.disabled = true;
      const r = await trCall('form', { type: 'concern', data: { kind: trv('trck'), involved: trv('trci'), date: trv('trcd'), where: trv('trcw'), details: trv('trcx'), witnesses: trv('trcv'), before: trv('trcb'), involvesManager: $('#trcm').checked } });
      alert(r.msg);
      if (r.ok) ['trci', 'trcd', 'trcw', 'trcx', 'trcv', 'trcb'].forEach((i) => ($('#' + i).value = ''));
      b.disabled = false;
      return;
    } else if (a === 'leadreport') {
      b.disabled = true;
      const r = await trCall('form', { type: 'leadreport', data: { category: trv('trlt'), about: trv('trla'), date: trv('trld'), policy: trv('trlp'), details: trv('trlw'), action: trv('trlx') } });
      toast(r.msg);
      ['trla', 'trld', 'trlp', 'trlw', 'trlx'].forEach((i) => ($('#' + i).value = ''));
      b.disabled = false;
      return;
    } else if (a === 'writeup') {
      if (!confirm('Save this write-up to ' + trv('trwe') + "'s HR folder?")) return;
      b.disabled = true;
      const r = await trCall('form', { type: 'corrective', data: { employee: trv('trwe'), step: trv('trws'), date: trv('trwd'), policy: trv('trwp'), details: trv('trww'), prior: trv('trwr'), expect: trv('trwx'), consequence: trv('trwc'), probation: trv('trwb') } });
      toast(r.msg);
      ['trwe', 'trwd', 'trwp', 'trww', 'trwr', 'trwx', 'trwc', 'trwb'].forEach((i) => ($('#' + i).value = ''));
      b.disabled = false;
      return;
    } else if (a === 'ackprof') {
      const note = prompt('Acknowledge ' + d.who + "'s Level II proficiency? This makes them eligible for the raise.\n\nWhat did you observe? (optional)", '');
      if (note === null) return;
      b.disabled = true;
      await trCall('ackProf', { who: d.who, note });
      toast('Acknowledged');
      TRN.dash = null;
    } else if (a === 'void') {
      if (!confirm("Void this reimbursement so it doesn't go on payroll?")) return;
      await trCall('voidReimb', { id: d.id });
      TRN.dash = null;
    } else return;
  } catch (err) {
    b.disabled = false;
    if (a === 'food') b.textContent = 'Upload';
    toast(err.message);
    return;
  }
  render();
});

/* Managers: who has passed which test. ✓ passed · … waiting to be scored · ✗ taken, not passed yet · – not taken. */
let tpFilter = '';
function teamProgress(T) {
  const short = (n) =>
    n
      .replace(/^Barista\s+/i, '')
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\s+-\s+.*$/, '')
      .trim();
  const people = T.people
    .filter((u) => u.role !== 'Manager' || Object.keys(u.r).length)
    .filter((u) => !tpFilter || (tpFilter === 'staff' ? u.role === 'Staff' : u.role === 'Lead'));
  const cell = (u, t) => {
    const x = u.r[t];
    if (!x) return '<td class="tp none" aria-label="Not taken">–</td>';
    const when = x.at ? shortDay(ymdOf(new Date(x.at))) : '',
      sc = x.score !== '' ? x.score + (x.outOf ? '/' + x.outOf : '') : '';
    const tip =
      (x.s === 'pass' ? 'Passed' : x.s === 'wait' ? 'Waiting to be scored' : 'Not passed yet') +
      (sc ? ' · ' + sc : '') +
      (when ? ' · ' + when : '') +
      (x.tries > 1 ? ' · ' + x.tries + ' tries' : '');
    return `<td class="tp ${x.s}"><button class="tpb" data-tptip="${esc(u.name.split(' ')[0] + ' – ' + t + ': ' + tip)}" title="${esc(tip)}" aria-label="${esc(t + ': ' + tip)}">${x.s === 'pass' ? '✓' : x.s === 'wait' ? '…' : '✗'}${x.s !== 'pass' && sc ? `<small>${esc(sc)}</small>` : ''}</button></td>`;
  };
  const passedN = (t) => T.people.filter((u) => u.r[t] && u.r[t].s === 'pass').length;
  return `<h2>Team progress</h2>
    <div class="card"><div class="row" style="flex-wrap:wrap;gap:6px"><span class="sub" style="flex:1;min-width:160px">✓ passed · … waiting to be scored · ✗ not passed yet · – not taken. Tap a mark for the score and date.</span>
      ${[
        ['', 'Everyone'],
        ['staff', 'Staff'],
        ['lead', 'Leads'],
      ]
        .map(([k, l]) => `<button class="btn sm ${tpFilter === k ? 'go' : ''}" data-tpfilter="${k}">${l}</button>`)
        .join('')}</div>
    <div class="tpwrap"><table class="tpgrid"><thead><tr><th scope="col">Name</th>${T.tests.map((t) => `<th scope="col" title="${esc(t)}">${esc(short(t))}<small>${passedN(t)} passed</small></th>`).join('')}</tr></thead>
      <tbody>${people.map((u) => `<tr><th scope="row">${esc(u.name)}${u.role !== 'Staff' ? `<small>${esc(u.role)}</small>` : ''}</th>${T.tests.map((t) => cell(u, t)).join('')}</tr>`).join('') || `<tr><td colspan="${T.tests.length + 1}" class="empty">Nobody here.</td></tr>`}</tbody></table></div>
    ${T.unmatched && T.unmatched.length ? `<div class="row"><div class="sub">Results under names that don't match anyone in the app: ${esc(T.unmatched.join(', '))}. Fix the name in the results sheet or in Users to count them.</div></div>` : ''}</div>`;
}
const accSummary = (t) =>
  [
    t.who === 'Only people picked'
      ? 'Only: ' + (t.allow.length ? t.allow.map(first).join(', ') : 'nobody yet')
      : 'Shown to ' + t.who.toLowerCase(),
    t.need ? 'after ' + t.need : '',
    t.who !== 'Only people picked' && t.allow.length ? 'also ' + t.allow.map(first).join(', ') : '',
    t.block.length ? 'not ' + t.block.map(first).join(', ') : '',
  ]
    .filter(Boolean)
    .join(' · ');
function testAccSheet() {
  const t = ((tdata && tdata.tests) || []).find((x) => x.name === sheet.test);
  if (!t) return '';
  const others = (tdata.tests || []).filter((x) => x.name !== t.name).map((x) => x.name),
    people = (data.people || [])
      .filter((u) => u.role !== 'Manager')
      .map((u) => u.name)
      .sort();
  const st = (n) => (t.block.indexOf(n) >= 0 ? 'block' : t.allow.indexOf(n) >= 0 ? 'allow' : '');
  const def = (n) => {
    const u = (data.people || []).find((x) => x.name === n) || {};
    return t.who === 'Only people picked' || t.who === 'Managers'
      ? 'Hidden'
      : t.who === 'Leads and managers' && u.role !== 'Lead'
        ? 'Hidden'
        : 'Shown';
  };
  return `<div class="sheet" role="dialog" aria-label="Test access"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${esc(t.name)}</h1><button class="btn sm" data-closesheet>Close</button></div>
    <form class="stack" data-form="testacc" style="padding:0">
      <label class="f">Who sees it<select name="who">${['Everyone', 'Leads and managers', 'Managers', 'Only people picked'].map((w) => `<option ${w === t.who ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
      <label class="f">Must pass first<select name="need"><option value="">Nothing – open right away</option>${others.map((n) => `<option ${n === t.need ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <h2 style="margin:6px 0 0">People</h2><p class="sub" style="margin:0">Allow shows it to someone and lets them skip the "must pass first" step. Block hides it from them. The test pages follow these settings too (within a minute).</p>
      <div class="card">${people.map((n) => `<div class="row"><div class="txt">${esc(n)}<div class="sub">Default: ${def(n)}</div></div><select name="p:${esc(n)}" style="width:auto"><option value="" ${!st(n) ? 'selected' : ''}>Default</option><option value="allow" ${st(n) === 'allow' ? 'selected' : ''}>Allow</option><option value="block" ${st(n) === 'block' ? 'selected' : ''}>Block</option></select></div>`).join('')}</div>
      <button class="btn go">Save</button></form></div></div>`;
}
async function startTest(level) {
  runner = { level, loading: true };
  render();
  try {
    const t = await post({ fn: 'getTest', token: TOKEN, level });
    runner = {
      level,
      t,
      i: 0,
      a: load('pt-test-' + level) ? JSON.parse(load('pt-test-' + level)) : {},
      started: Date.now(),
    };
  } catch (e) {
    runner = null;
    toast(String(e.message || e));
  }
  render();
}
function viewRunner() {
  if (runner.loading) return '<div class="runner"><div class="empty">Opening the test…</div></div>';
  if (runner.done) {
    const d = runner.done;
    return `<div class="runner"><div class="runner-in"><h1>${esc(runner.t.title)}</h1>
      ${runner.t.written ? "<p>Submitted. Your Manager will score it and you'll see the result here.</p>" : `<div class="score ${d.result === 'Pass' ? 'ok' : ''}">${esc(d.score)} / ${esc(d.outOf)}</div><p><b>${d.result === 'Pass' ? 'You passed.' : 'Not yet.'}</b> ${d.result === 'Pass' ? '' : 'You need ' + esc(d.needed) + ' to pass. Review the material and try again.'}</p>${d.missed && d.missed.length ? `<p class="sub">Questions to review: ${d.missed.join(', ')}</p>` : ''}`}
      <button class="btn go" data-closetest style="width:100%">Done</button></div></div>`;
  }
  const t = runner.t,
    q = t.q[runner.i],
    n = t.q.length,
    ans = runner.a[runner.i],
    answered = Object.keys(runner.a).filter((k) => String(runner.a[k]).trim()).length;
  const sec =
    q.s && (runner.i === 0 || t.q[runner.i - 1].s !== q.s)
      ? `<div class="sub" style="margin-bottom:6px">${esc(q.s)}</div>`
      : `<div class="sub" style="margin-bottom:6px">${esc(q.s || '')}</div>`;
  return `<div class="runner"><div class="runner-in">
    <div class="rhead"><button class="btn sm" data-closetest>Close</button><span class="sub">${runner.i + 1} of ${n}</span></div>
    <div class="progress" style="margin:10px 0 16px"><i style="width:${Math.round((answered / n) * 100)}%"></i></div>
    ${sec}<h2 class="q">${esc(q.p)}</h2>
    ${
      t.written
        ? `<textarea data-wans rows="7" placeholder="Type your answer">${esc(ans || '')}</textarea><p class="sub">Saved on this phone as you type.</p>`
        : `<div class="opts">${q.o.map((o, k) => `<button class="opt2 ${ans === o ? 'on' : ''}" data-pick="${k}">${esc(o)}</button>`).join('')}</div>`
    }
    <div class="btns rfoot"><button class="btn" data-tq="-1" ${runner.i === 0 ? 'disabled' : ''}>Back</button>
      ${runner.i < n - 1 ? `<button class="btn go" data-tq="1">Next</button>` : `<button class="btn go" data-submittest ${answered < n ? 'title="Some questions are blank"' : ''}>Submit</button>`}</div>
    ${runner.i === n - 1 && answered < n ? `<p class="sub warn-t">${n - answered} question${n - answered > 1 ? 's are' : ' is'} blank.</p>` : ''}
  </div></div>`;
}
async function submitTest() {
  const t = runner.t,
    answers = t.q.map((_, k) => (runner.a[k] == null ? '' : runner.a[k]));
  if (
    !confirm(answers.some((a) => !String(a).trim()) ? 'Some answers are blank. Submit anyway?' : 'Submit your answers?')
  )
    return;
  runner.sending = true;
  render();
  try {
    const d = await post({ fn: 'submitTest', token: TOKEN, level: runner.level, answers });
    save('pt-test-' + runner.level, null);
    runner.done = d;
    tdata = null;
  } catch (e) {
    toast('Not submitted – ' + String(e.message || e));
  }
  runner.sending = false;
  render();
}
/* ----- team ----- */
const back = (to) =>
  !to && wide()
    ? ''
    : `<button class="btn sm" data-more="${to || ''}" style="margin-bottom:6px">‹ ${to ? (to === 'settings' ? 'Settings' : 'Back') : 'More'}</button>`; // desktop: the sidebar is the menu
/** Team › Edit: the clock-in types this person gets on top of their role's list. */
function ctExtraField(u) {
  const sets = data.clockSets || {},
    base = sets[u.role] || sets.Staff || [],
    known = [...new Set([].concat(sets.Staff || [], sets.Lead || [], sets.Manager || [], u.extra || []))],
    can = known.filter((t) => base.indexOf(t) < 0); // extras typed in before show here as boxes too
  return `<div class="f ctextra"><span>Clock-in types</span>
      <span class="sub">As ${esc(u.role.toLowerCase())}: ${esc(base.join(', '))}. Tick any extra ones ${esc(first(u.name))} can also pick.</span>
      <div class="ctchecks">${can
        .map(
          (t) =>
            `<label class="chip"><input type="checkbox" name="extra" value="${esc(t)}" ${(u.extra || []).indexOf(t) >= 0 ? 'checked' : ''}> ${esc(t)}</label>`
        )
        .join('')}</div>
      <input name="extraother" maxlength="120" placeholder="Something else? e.g. Roasting, Catering (commas between)">
    </div>`;
}
function viewTeam() {
  const us = (data.users || []).slice().sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
  const added = justAdded && us.find((u) => u.name === justAdded),
    inv = added || (inviteFor && us.find((u) => u.id === inviteFor));
  const addedCard =
    inv && inv.invite
      ? `<div class="hint" id="invite"><b>${added ? esc(inv.name) + ' is on the team.' : 'Invite ' + esc(inv.name)}</b>
      <div class="sub" style="margin:4px 0 8px">${
        inv.joined && !added
          ? `${esc(first(inv.name))} is already set up (code: last 4 digits of their phone). This link lets them set it up again – it changes their code to match the phone they type and signs them out on other phones.`
          : `Send this link. ${esc(first(inv.name))} opens it, adds their phone number and email, and that creates their account – their code is the last 4 digits of their phone.`
      }</div>
      <input class="linkbox" readonly value="${esc(inviteLink(inv))}" aria-label="Invite link" onclick="this.select()">
      <div class="btns" style="margin-top:8px">${navigator.share ? `<button class="btn sm go" data-shareinvite="${esc(inv.id)}">Share…</button>` : ''}<button class="btn sm ${navigator.share ? '' : 'go'}" data-copyinvite="${esc(inv.id)}">Copy</button>
        ${inv.phone ? `<a class="btn sm" href="sms:${esc(inv.phone.replace(/[^\d+]/g, ''))}${isIOS() ? '&' : '?'}body=${encodeURIComponent(inviteText(inv))}">Text it</a>` : ''}
        ${inv.email ? `<a class="btn sm" href="mailto:${esc(inv.email)}?subject=${encodeURIComponent('Your Peregrine team app')}&body=${encodeURIComponent(inviteText(inv))}">Email it</a>` : ''}
        <button class="btn sm" data-dismiss>Done</button></div>
      <div class="sub" style="margin-top:6px">Each link works once.</div></div>`
      : inv
        ? `<div class="hint" id="invite"><b>${esc(inv.name)} is on the team.</b> Their invite link appears here once the server is updated (paste the new Code.gs). <button class="btn sm" data-dismiss>Done</button></div>`
        : '';
  const form = (u) => `<form class="stack" data-form="user" ${u ? `data-id="${esc(u.id)}"` : ''}>
      <label class="f">Name<input name="name" maxlength="60" value="${esc(u ? u.name : '')}" placeholder="First and last name"></label>
      <label class="f">Role<select name="role">${['Staff', 'Lead', 'Manager', 'Shop'].map((r) => `<option value="${r}" ${u && u.role === r ? 'selected' : ''}>${r === 'Shop' ? 'Shop iPad (shared device)' : r}</option>`).join('')}</select></label>
      <div class="two"><label class="f">Phone${u ? '' : ' (optional)'}<input name="phone" type="tel" maxlength="40" value="${esc(u ? u.phone : '')}"></label><label class="f">Email${u ? '' : ' (optional)'}<input name="email" type="email" maxlength="120" value="${esc(u ? u.email : '')}"></label></div>
      ${u ? '' : '<p class="sub" style="margin:0">Leave these blank and they\'ll add them from their invite link. Their code is always the last 4 digits of their phone.</p>'}
      ${u && data.clockSets && u.role !== 'Shop' ? ctExtraField(u) : ''}
      <label class="f">Hourly wage ($) – only managers see this<input name="wage" inputmode="decimal" maxlength="8" value="${u && u.wage ? Number(u.wage).toFixed(2) : ''}" placeholder="e.g. 15.50"></label>
      <div class="btns"><button class="btn go">${u ? 'Save' : 'Add to the team'}</button>${u ? '<button type="button" class="btn" data-canceledit>Cancel</button>' : ''}</div></form>`;
  const row = (u) =>
    editUser === u.id
      ? `<div class="row" style="display:block;padding:0">${form(u)}</div>`
      : `<div class="row" style="display:block;${u.active ? '' : 'opacity:.55'}">
      <div style="display:flex;gap:8px;align-items:center"><b style="flex:1">${esc(u.name)}</b><span class="pill ${u.role === 'Manager' ? 'warn' : u.role === 'Lead' ? 'ok' : 'mute'}">${esc(u.role)}</span>${u.active ? '' : '<span class="pill mute">Off</span>'}${u.active && u.invite && !u.joined ? '<span class="pill warn">Not set up yet</span>' : ''}</div>
      <div class="sub">${u.wage ? money(u.wage, true) + '/h · ' : ''}${u.email ? (u.reminders === 'Off' ? 'Reminders off' : 'Reminders: ' + esc(u.reminders)) : 'No email – no reminders'}</div><div class="sub">${u.phone ? esc(u.phone) + ' · ' : ''}Code ${showCode[u.id] ? `<b>${esc(u.code)}</b>` : '••••'} <button class="btn sm" data-showcode="${esc(u.id)}" style="padding:4px 8px;min-height:0">${showCode[u.id] ? 'Hide' : 'Show'}</button></div>
      <div class="btns" style="margin-top:8px">${u.active ? `<button class="btn sm go" data-invite="${esc(u.id)}">Invite link</button>` : ''}<button class="btn sm" data-edit="${esc(u.id)}">Edit</button><button class="btn sm" data-newcode="${esc(u.id)}" data-name="${esc(u.name)}">New code</button>
        <button class="btn sm" data-active="${esc(u.id)}" data-to="${u.active ? 0 : 1}" data-name="${esc(u.name)}">${u.active ? 'Turn off' : 'Turn on'}</button></div></div>`;
  return `${back()}<h1>Team</h1>${addedCard}<div class="card">${us.map(row).join('')}</div>
    <h2>Schedule lineup</h2><p class="sub" style="margin:0 4px 8px">Drag ⠿ to set the order people appear on the schedule. Hidden people stay on the team (they can still sign in); they just don't take up a row.</p>
    <div class="card" data-reorder>${lineup()
      .map(
        (u) =>
          `<div class="row" data-rid="${esc(u.id)}"><span class="handle" data-rowdrag aria-label="Drag to reorder ${esc(u.name)}">⠿</span><div class="txt ${shown(u) ? '' : 'muted'}"><b>${esc(u.name)}</b>${levelPill(u.name)}<div class="sub">${esc(u.role)}${shown(u) ? '' : ' · hidden from the schedule'}</div></div><button class="btn sm" data-onsched="${esc(u.id)}" data-to="${shown(u) ? 0 : 1}">${shown(u) ? 'Hide' : 'Show'}</button></div>`
      )
      .join('')}</div>
    <h2>Add someone</h2><div class="card">${form(null)}</div>
    <p class="sub">Turning someone off or giving a new code signs them out on every phone right away. Everything here is also on the Users tab of the sheet.</p>`;
}

function viewMore() {
  const views = {
    settings: viewSettings,
    push: viewPush,
    reminders: viewReminders,
    requests: viewRequests,
    avail: viewAvail,
    time: viewTime,
    news: viewNews,
    resources: viewResources,
    recipes: () => viewRecipes({ back: back() }),
    training: () => (lead() ? viewTraining() : viewMoreList()),
    dialin: () => (on('dialin') ? viewDialIn() : viewMoreList()),
    drawer: () => (on('drawer') ? viewDrawer() : viewMoreList()),
    master: viewMaster,
    team: () => (mgr() ? viewTeam() : viewMoreList()),
  };
  if (shop() && ['news', 'resources', 'settings', 'recipes'].indexOf(moreView) < 0) moreView = wide() ? 'news' : '';
  if (!views[moreView] && wide()) moreView = 'settings'; // desktop has no More list – the sidebar lists everything
  return views[moreView] ? views[moreView]() : viewMoreList();
}
function viewMoreList() {
  if (shop())
    return `<h1>More</h1><div class="card">${rowBtn('data-more="news"', '<div class="txt"><b>Announcements</b></div><span>›</span>')}${(data.links || []).some((l) => !l.group) ? rowBtn('data-more="resources"', '<div class="txt"><b>Other resources</b></div><span>›</span>') : ''}</div>
    <div class="card">${rowBtn('data-more="settings"', '<div class="txt"><b>Settings</b><div class="sub">Look, sign out</div></div><span>›</span>')}</div>`;
  const pendN = mgr()
    ? (data.requests || []).filter((q) => q.status === 'Pending' && q.from !== data.me.name).length
    : 0;
  const unreadN = (data.announcements || []).filter((a) => !a.read).length;
  const item = (k, label, sub, extra) =>
    rowBtn(
      `data-more="${k}"`,
      `<div class="txt"><b>${label}</b>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${extra || ''}<span>›</span>`
    );
  const pill = (n) => (n ? `<span class="pill warn" style="margin-right:8px">${n}</span>` : '');
  return `<h1>More</h1><div class="card">
      ${on('news') ? item('news', 'Announcements', '', pill(unreadN)) : ''}
      ${on('timeclock') ? item('time', mgr() ? 'Time sheets' : 'My time', mgr() ? 'Labor by day, week or pay period' : 'Your hours and estimated pay') : ''}
      ${on('requests') ? item('requests', 'Requests', 'Time off, swaps, covers and open shifts', pill(pendN)) : ''}
      ${on('availability') ? item('avail', 'Availability', "When you can't work") : ''}
      ${on('dialin') ? item('dialin', 'Dial-in log', "Today's espresso settings and history") : ''}
      ${on('drawer') ? item('drawer', 'Drawer count', 'Count and close the drawer') : ''}
      ${['training', 'tests', 'manual', 'library', 'hr', 'foodhandler', 'progress'].some(on) ? rowBtn('data-tab="tests" class="mobonly"', '<div class="txt"><b>Training</b><div class="sub">Manual, study guides, tests, resources and forms</div></div><span>›</span>') : ''}
      ${Number(data.version) >= 5.04 && on('recipes') ? item('recipes', 'Recipes', 'Drink builds and prep, step by step') : ''}
      ${lead() && on('inventory') ? `<span class="mobonly">${rowBtn('data-tab="inventory"', '<div class="txt"><b>Inventory</b><div class="sub">Count and reorder</div></div><span>›</span>')}</span>` : ''}
      ${shop() ? item('resources', 'Resources', 'Guides, handbooks, documents') : ''}

      ${mgr() ? item('team', 'Team & sign-in codes') : ''}
      ${data.master ? item('master', 'Master admin', 'Turn parts of the app on or off') : ''}</div>
    <div class="card">${item('settings', 'Settings', 'Notifications, reminders, look, sign out')}</div>
    <p class="sub" style="text-align:center">Peregrine Team · server ${esc(data.version || '')}</p>`;
}
/** Settings: everything about this person and this phone, in one place (phone: from More; desktop: in the sidebar). */
function viewSettings() {
  if (shop())
    return `${wide() ? '' : back()}<h1>Settings</h1>
    <h2>Look</h2><div class="seg">${[
      ['auto', 'Auto'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ]
      .map(([k, n]) => `<button data-theme="${k}" aria-pressed="${theme() === k}">${n}</button>`)
      .join('')}</div>
    <h2>Shop iPad</h2><div class="card"><div class="row"><div class="txt sub">Signed in as <b>${esc(data.me.name)}</b>. It stays signed in; a manager can sign it out from Team by giving it a new code.</div><button class="btn sm" data-signout>Sign out</button></div></div>
    <p class="sub" style="text-align:center">Peregrine Team · server ${esc(data.version || '')}</p>`;
  pushCheck();
  const item = (k, label, sub) =>
      rowBtn(
        `data-more="${k}"`,
        `<div class="txt"><b>${label}</b>${sub ? `<div class="sub">${sub}</div>` : ''}</div><span>›</span>`
      ),
    R = data.reminders || {};
  const remindSub =
    data.me.reminders === 'Off'
      ? 'Off'
      : R.by === 'push'
        ? data.me.reminders + ' · by notification'
        : data.me.email
          ? data.me.reminders + ' · ' + esc(data.me.email)
          : 'Off – no email';
  return `${back()}<h1>Settings</h1><div class="card">
      ${data.push && data.push.ready ? item('push', 'Notifications', pushOn_() ? 'On for this ' + deviceKind() : 'Off on this ' + deviceKind()) : ''}
      ${item('reminders', 'Shift reminders', remindSub)}
      ${canSwitch() ? rowBtn('data-locs', `<div class="txt"><b>Location</b><div class="sub">${esc(locName(HERE))}</div></div><span>›</span>`) : ''}</div>
    <h2>Look</h2><div class="seg">${[
      ['auto', 'Auto'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ]
      .map(([k, n]) => `<button data-theme="${k}" aria-pressed="${theme() === k}">${n}</button>`)
      .join('')}</div>
    <h2>${esc(data.me.name)} · ${esc(data.me.role)}</h2><div class="card"><div class="row"><div class="txt sub">Signed in on this ${deviceKind()}.${!standalone() && !wide() ? ' Tip: add this app to your home screen.' : ''}</div><button class="btn sm" data-signout>Sign out</button></div></div>
    <p class="sub" style="text-align:center">Peregrine Team · server ${esc(data.version || '')}</p>`;
}

/* ---------- shop iPad: clock-in screen, whole-team schedule, "who did it" ---------- */
const shopToday = () =>
  shiftsOn(T())
    .filter(live)
    .sort((a, b) => a.start.localeCompare(b.start));
const onClockSince = (name) => ((data.onClock || []).find((x) => x.name === name) || {}).in || '';
/** People for the clock-in screen and the "who did it" picker: today's shifts first, then anyone on the clock, then everyone else. */
function shopPeople() {
  const ppl = (data.people || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    sh = shopToday(),
    today = [];
  sh.forEach((s) => {
    if (today.indexOf(s.name) < 0) today.push(s.name);
  });
  (data.onClock || []).forEach((x) => {
    if (today.indexOf(x.name) < 0) today.push(x.name);
  });
  const known = today.map((n) => ppl.find((p) => p.name === n)).filter(Boolean);
  return { today: known, rest: ppl.filter((p) => today.indexOf(p.name) < 0) };
}
/** Shop iPad home screen: big clock, one big Clock in / out button, who's on now, and app-style tiles. */
function viewShopHome() {
  const now = new Date(),
    on = data.onClock || [],
    sh = shopToday(),
    chatN = (data.channels || []).reduce((n, c) => n + (Number(c.unread) || 0), 0),
    cl = data.checklists || [],
    clDone = cl.reduce((n, c) => n + c.done, 0),
    clAll = cl.reduce((n, c) => n + c.total, 0),
    prepN = (data.prep || []).filter((x) => !x.doneAt && (!x.date || x.date <= T())).length,
    pinned = (data.announcements || []).find((a) => a.pinned);
  const working = [...new Set(sh.map((s) => s.name))].length;
  const tile = (attrs, ic, label, sub, n, hue) =>
    `<button class="hs-app" ${attrs}><span class="hs-ic" style="--hue:${hue}">${ic}${n ? `<span class="hs-n">${n > 99 ? '99+' : n}</span>` : ''}</span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</button>`;
  const groups = resGroups().map((g, i) =>
    tile(`data-tab="res:${esc(g)}"`, resIcon(g, i), esc(g), '', 0, [28, 340, 150, 210, 260, 100][i % 6])
  );
  return `<div class="hs">
    <div class="hs-top"><div class="hs-time">${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '')}<span>${now.getHours() < 12 ? 'AM' : 'PM'}</span></div><div class="hs-date">${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
    <button class="hs-clock" data-kpick><span class="hs-cic">◷</span><span><b>Clock in / out</b><small>Tap, pick your name, type your code</small></span></button>
    <div class="hs-on">${
      on.length
        ? `<span class="sub">On the clock</span>${on
            .map((x) => {
              const p = (data.people || []).find((q) => q.name === x.name) || { name: x.name, id: x.name };
              return `<span class="hs-who">${avatar(p, 30)}<span>${esc(first(x.name))}<small>since ${timeOf(x.in)}</small></span></span>`;
            })
            .join('')}`
        : '<span class="sub">No one is clocked in</span>'
    }</div>
    ${pinned ? `<div class="hs-ann"><span class="pill">Pinned</span> <b>${esc(pinned.title)}</b>${pinned.message ? ` <span class="sub">${linkify(esc(pinned.message))}</span>` : ''}</div>` : ''}
    <div class="hs-grid">
      ${tile('data-tab="schedule"', '▦', 'Schedule', working ? working + ' working today' : 'No one today', 0, 195)}
      ${tile('data-tab="chat"', '✉︎', 'Chat', chatN ? chatN + ' unread' : '', chatN, 175)}
      ${tile('data-tab="lists"', '✓', 'Checklists', clAll ? clDone + ' of ' + clAll + ' done' : '', 0, 120)}
      ${tile(`data-golist="${PREP}"`, '✎', 'Prep', prepN ? prepN + ' to do' : 'All done', prepN, 40)}
      ${tile('data-tab="inventory"', '▤', 'Inventory', 'Count stock', 0, 225)}
      ${groups.join('')}
      ${RECIPES().length && !resGroups().some((g) => /recipe/i.test(g)) ? tile('data-tab="recipes"', '❦', 'Recipes', RECIPES().length + ' recipes', 0, 28) : ''}
      ${tile('data-more="news"', '⚑', 'Announcements', '', 0, 0)}
    </div></div>`;
}
/* ---------- prep done: "how much do we have now?" → straight into the inventory sheet ---------- */
function askCount(id, as) {
  const x = (data.prep || []).find((p) => p.id === id);
  if (!x || !(data.invNames || []).length || x.inv === 'none') return false;
  sheet = { kind: 'prepcount', id, as, pick: x.inv || '', val: '', err: '' };
  render();
  return true;
}
function finishPrep(w, extra) {
  const x = (data.prep || []).find((p) => p.id === w.id),
    it = extra && extra.inv ? (data.invNames || []).find((n) => n.k === extra.inv) : null;
  if (x) {
    x.doneAt = new Date().toISOString();
    x.doneBy = w.as || data.me.name;
    if (extra) x.inv = extra.noinv ? 'none' : extra.inv;
  }
  if (it) {
    it.onHand = Number(extra.count);
    if (inv) {
      const ii = inv.items.find((i) => i.tab + '|' + i.row === extra.inv);
      if (ii) {
        ii.onHand = Number(extra.count);
        ii.counted = T();
      }
    }
  }
  sheet = null;
  render();
  act(
    'donePrep',
    Object.assign({ id: w.id, done: '1' }, w.as ? { as: w.as } : {}, extra || {}, it ? { invItem: it.item } : {})
  ).then((r) => {
    if (r && it) toast(`Saved – ${it.item}: ${extra.count}${it.unit ? ' ' + it.unit : ''}`);
  });
}
function prepCountSheet() {
  const x = (data.prep || []).find((p) => p.id === sheet.id);
  if (!x) return '';
  const names = data.invNames || [],
    it = sheet.pick && sheet.pick !== 'none' ? names.find((n) => n.k === sheet.pick) : null,
    tabs = [...new Set(names.map((n) => n.tab))];
  const picker = `<label class="f">Which inventory item is it?<select name="pick" data-pcpick><option value="">Pick one…</option>${tabs
    .map(
      (t) =>
        `<optgroup label="${esc(t)}">${names
          .filter((n) => n.tab === t)
          .map(
            (n) =>
              `<option value="${esc(n.k)}" ${n.k === sheet.pick ? 'selected' : ''}>${esc(n.item)}${n.unit ? ' (' + esc(n.unit) + ')' : ''}</option>`
          )
          .join('')}</optgroup>`
    )
    .join(
      ''
    )}<option value="none" ${sheet.pick === 'none' ? 'selected' : ''}>It's not in inventory</option></select></label>`;
  return `<div class="sheet" role="dialog" aria-label="How much do we have now?"><div class="sheet-in pc"><div class="pc-ok">✓</div>
    <h1 style="margin:0">${esc(x.item)} done</h1><p class="sub" style="margin:4px 0 14px">${sheet.as ? esc(first(sheet.as)) + ', how' : 'How'} much do we have now?</p>
    <form class="stack" data-form="prepcount" style="padding:0" onsubmit="return false">
      ${it && !sheet.relink ? `<div class="pc-item"><b>${esc(it.item)}</b><span class="sub">${it.unit ? esc(it.unit) + ' · ' : ''}${it.onHand === '' ? 'not counted yet' : 'last count ' + it.onHand}</span><button type="button" class="lnk" data-pcrelink>Not this item?</button></div>` : picker}
      <div class="ic-step pc-step"><button type="button" data-pcstep="-1" aria-label="One less">−</button><input class="cnt" name="n" inputmode="decimal" value="${esc(sheet.val)}" placeholder="–" aria-label="How many now"><button type="button" data-pcstep="1" aria-label="One more">+</button></div>
      ${sheet.err ? `<p class="kerr" role="alert">${esc(sheet.err)}</p>` : ''}
      <div class="btns"><button type="button" class="btn go" data-pcsave>Save</button><button type="button" class="btn" data-pcskip>Skip</button></div>
      <p class="sub" style="margin:0">This updates the inventory count${it ? ' for ' + esc(it.item) : ''}.</p></form></div></div>`;
}
document.addEventListener('change', (e) => {
  if (!e.target.matches || !e.target.matches('[data-pcpick]') || !sheet || sheet.kind !== 'prepcount') return;
  const f = e.target.form;
  sheet.val = f.elements.namedItem('n').value.trim();
  sheet.pick = e.target.value;
  sheet.relink = !sheet.pick; // picked an item: show it like a linked one
  render();
});
/** Shop iPad: pick your name, then the keypad. */
function kpickSheet() {
  const { today, rest } = shopPeople(),
    sh = shopToday();
  const b = (p) => {
    const since = onClockSince(p.name),
      mine = sh.filter((s) => s.name === p.name);
    const sub = since
      ? `<span class="pill ok">In since ${timeOf(since)}</span>`
      : mine.length
        ? `<span class="sub">${mine.map((s) => t12(s.start) + '–' + t12(s.end)).join(', ')}</span>`
        : '';
    return `<button class="kbtn ${since ? 'in' : ''}" data-kiosk="${esc(p.id)}">${avatar(p, 48)}<b>${esc(p.name)}</b>${sub}</button>`;
  };
  return `<div class="sheet" role="dialog" aria-label="Clock in or out"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">Who are you?</h1><button class="btn sm" data-closesheet>Cancel</button></div>
    ${today.length ? `<h2>Working today</h2><div class="kgrid">${today.map(b).join('')}</div>` : ''}
    ${rest.length ? `<details class="kmore" ${today.length ? '' : 'open'}><summary>Someone else</summary><div class="kgrid">${rest.map(b).join('')}</div></details>` : ''}</div></div>`;
}
/* ---------- shop iPad: back to the home screen after a minute, asleep after five ---------- */
const KIOSK_HOME_MS = 60000,
  KIOSK_SLEEP_MS = 5 * 60000,
  KIOSK_RECIPE_MS = 20 * 60000; // an open recipe stays up longer: someone is making it with their hands full
let kioskIdle = Date.now(),
  asleep = false;
function kioskHome() {
  clearWho();
  recSel = '';
  recEdit = '';
  sheet = null;
  viewer = null;
  runner = null;
  moreView = '';
  stopChat();
  tab = 'today';
  save('pt-tab', tab);
  window.scrollTo(0, 0);
  render();
}
function sleepEl() {
  let el = $('#sleep');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sleep';
    el.hidden = true;
    el.setAttribute('aria-label', 'Tap to wake');
    el.innerHTML =
      '<div class="sl-in"><img src="brand/falcon.png" alt="Peregrine"><div class="sl-name">Peregrine</div><div class="sl-tap">Tap to start</div></div>';
    document.body.appendChild(el);
  }
  return el;
}
function setAsleep(on) {
  asleep = on;
  const el = sleepEl();
  el.hidden = !on;
  if (on) sleepDrift();
}
function sleepDrift() {
  // move the logo a little now and then, so the screen doesn't wear in one spot
  const i = $('#sleep .sl-in');
  if (i)
    i.style.transform = `translate(${Math.round((Math.random() - 0.5) * 8)}px, ${Math.round((Math.random() - 0.5) * 8)}px)`; // a few pixels: looks centred, still moves
}
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
  document.addEventListener(
    ev,
    (e) => {
      kioskIdle = Date.now();
      if (asleep) {
        e.preventDefault();
        e.stopPropagation();
        setAsleep(false);
        kioskHome(); // a tap wakes it straight to the home screen (and doesn't press whatever was underneath)
      }
    },
    { capture: true, passive: false }
  )
);
document.addEventListener(
  'click',
  (e) => {
    if (e.target.closest && e.target.closest('#sleep')) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);
setInterval(() => {
  if (!shop() || !TOKEN) return asleep && setAsleep(false);
  const idle = Date.now() - kioskIdle;
  if (asleep) return idle % 60000 < 5000 && sleepDrift();
  if (recSel && isRecView() && idle < KIOSK_RECIPE_MS) return;
  if (idle > KIOSK_SLEEP_MS) return setAsleep(true);
  if (idle > KIOSK_HOME_MS && (tab !== 'today' || sheet || viewer || chat.open || moreView)) kioskHome();
}, 5000);
const kioskTypes = (id) => (data.clockTypesBy || {})[id] || [];
function kioskSheet() {
  const p = (data.people || []).find((x) => x.id === sheet.id);
  if (!p) return '';
  const types = kioskTypes(p.id);
  if (!onClockSince(p.name) && types.length > 1 && !sheet.type)
    return `<div class="sheet" role="dialog" aria-label="What are you clocking in for?"><div class="sheet-in kiosk"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${esc(p.name)}</h1><button class="btn sm" data-closesheet>Cancel</button></div>
    <p class="sub">Clocking <b>in</b> for…</p>${ctPicker(types, (t) => `data-ktype="${esc(t)}"`)}</div></div>`;
  const since = onClockSince(p.name),
    dots = [0, 1, 2, 3].map((i) => `<span class="${i < sheet.code.length ? 'on' : ''}"></span>`).join(''),
    keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  return `<div class="sheet" role="dialog" aria-label="Clock ${since ? 'out' : 'in'}"><div class="sheet-in kiosk"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">${esc(p.name)}</h1><button class="btn sm" data-closesheet>Cancel</button></div>
    <p class="sub">${since ? 'Clocking <b>out</b> · in since ' + timeOf(since) : 'Clocking <b>in</b>' + (sheet.type ? ' as <b>' + esc(sheet.type) + '</b>' + (types.length > 1 ? ' <button class="linkbtn" data-ktype="">change</button>' : '') : '')} · type your code</p>
    <div class="kdots" aria-live="polite">${dots}</div>${sheet.err ? `<p class="kerr" role="alert">${esc(sheet.err)}</p>` : ''}
    <div class="kpad">${keys.map((k) => (k ? `<button data-kpad="${k === '⌫' ? 'del' : k}" ${sheet.busy ? 'disabled' : ''} aria-label="${k === '⌫' ? 'Delete' : k}">${k}</button>` : '<span></span>')).join('')}</div>
    ${sheet.busy ? `<p class="sub" style="text-align:center">Clocking ${since ? 'out' : 'in'}…</p>` : ''}</div></div>`;
}
function kioskDoneSheet() {
  return `<div class="sheet" role="dialog" aria-label="Done"><div class="sheet-in kiosk kdone"><div class="kok">✓</div><h1>${esc(first(sheet.name))} clocked ${sheet.did}</h1><p class="sub">${timeOf(sheet.at)}</p>${
    sheet.did === 'in' && on('dialin') ? ((x) => `<p class="sub" style="margin-top:14px">${x ? "Today's dial-in: <b>" + dialLine(x) + '</b>' : 'Not dialed in yet today'}</p>`)(dialToday()) : ''
  }</div></div>`;
}
async function kioskGo() {
  const k = sheet;
  k.busy = true;
  k.err = '';
  render();
  let got = null,
    err = '';
  try {
    const pos = await getPos();
    got = await post({
      fn: 'api',
      token: TOKEN,
      p: Object.assign(
        { action: 'kioskClock', who: k.id, code: k.code, have: haveNow() },
        k.type ? { type: k.type } : {},
        pos
      ),
    });
  } catch (e) {
    err = String(e.message || e);
  }
  if (sheet !== k) return;
  if (err) {
    if (/^signin/.test(err)) return signOut(err.replace(/^signin:\s*/, ''));
    k.busy = false;
    k.code = '';
    k.err = err === 'timeout' ? 'That took too long – check the list before trying again' : err;
    render();
    return;
  }
  data = mergeGot(data, got);
  save('pt-cache', JSON.stringify(data));
  const r = got.result || {};
  sheet = { kind: 'kioskdone', name: r.name || '', did: r.did || '', at: r.at || new Date().toISOString() };
  render();
  setTimeout(() => {
    if (sheet && sheet.kind === 'kioskdone') {
      sheet = null;
      render();
    }
  }, r.did === 'in' && on('dialin') ? 6000 : 2500);
}
/* Shop iPad: whoever just ticked something off keeps ticking without being asked again, for a minute after their last tick */
const WHO_MS = 60000;
let shopWho = { name: '', at: 0 },
  whoT = 0;
const whoNow = () => (shopWho.name && Date.now() - shopWho.at < WHO_MS ? shopWho.name : '');
function setWho(name) {
  shopWho = { name, at: Date.now() };
  clearTimeout(whoT);
  whoT = setTimeout(() => {
    if (!whoNow()) render(); // the "ticking off as" bar goes away when the minute is up
  }, WHO_MS + 300);
}
function clearWho() {
  shopWho = { name: '', at: 0 };
  clearTimeout(whoT);
}
/** Record a shop-iPad tick (a checklist task or a prep item) under the person who did it. */
function shopDone(w, who) {
  setWho(who);
  if (w.what === 'prep' && askCount(w.id, who)) return;
  if (w.what === 'prep') {
    const x = (data.prep || []).find((p) => p.id === w.id);
    if (x) {
      x.doneAt = new Date().toISOString();
      x.doneBy = who;
    }
    render();
    act('donePrep', { id: w.id, done: '1', as: who });
  } else {
    busy['c|' + w.list + '|' + w.task] = true;
    render();
    if (navigator.vibrate) navigator.vibrate(10);
    act('check', { list: w.list, task: w.task, done: '1', as: who });
  }
}
const whoBar = () =>
  shop() && whoNow()
    ? `<div class="whobar" role="status">${avatar((data.people || []).find((q) => q.name === whoNow()) || { name: whoNow(), id: whoNow() }, 28)}<span class="whotxt">Ticking off as <b>${esc(first(whoNow()))}</b></span><button class="btn sm" data-whoclear>Not you?</button></div>`
    : '';
function whoSheet() {
  const { today, rest } = shopPeople(),
    what = sheet.what === 'prep' ? ((data.prep || []).find((x) => x.id === sheet.id) || {}).item : sheet.task;
  const b = (p) =>
    `<button class="kbtn sm" data-whopick="${esc(p.name)}">${avatar(p, 40)}<b>${esc(p.name)}</b></button>`;
  return `<div class="sheet" role="dialog" aria-label="Who did it?"><div class="sheet-in"><div style="display:flex;justify-content:space-between;align-items:center"><h1 style="margin:0">Who did it?</h1><button class="btn sm" data-closesheet>Cancel</button></div>
    <p class="sub">${esc(what || '')}</p>
    ${today.length ? `<div class="kgrid sm">${today.map(b).join('')}</div>` : ''}
    ${rest.length ? `<details class="kmore" ${today.length ? '' : 'open'}><summary>Someone else</summary><div class="kgrid sm">${rest.map(b).join('')}</div></details>` : ''}</div></div>`;
}
/** Whole-team schedule, published shifts only, a week at a time. */
let shopWeek = '';
function viewShopSchedule() {
  const mon = shopWeek || monday(T()),
    days = [0, 1, 2, 3, 4, 5, 6].map((n) => plus(mon, n));
  const day = (d) => {
    const xs = shiftsOn(d)
      .filter(live)
      .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    return `<h2 ${d === T() ? 'class="today"' : ''}>${dayName(d)}${d === T() ? ' · Today' : ''}</h2><div class="card">${
      xs.length
        ? xs
            .map(
              (s) =>
                `<div class="row"><div class="txt"><b>${esc(s.name)}</b>${levelPill(s.name)}${s.position ? `<div class="sub">${esc(s.position)}</div>` : ''}</div><span class="sub">${t12(s.start)}–${t12(s.end)}</span></div>`
            )
            .join('')
        : '<div class="empty">No one scheduled</div>'
    }</div>`;
  };
  return `<h1>Schedule</h1><div class="weeknav"><button class="btn sm" data-shopweek="-7" aria-label="Previous week">‹</button><b>${shortDay(mon)} – ${shortDay(plus(mon, 6))}</b><button class="btn sm" data-shopweek="7" aria-label="Next week">›</button>${mon !== monday(T()) ? '<button class="btn sm" data-shopweek="0">This week</button>' : ''}</div>
    ${days
      .filter((d) => d >= (data.from || ''))
      .map(day)
      .join('')}`;
}
// Phone: Schedule · Chat · [Today] · Lists · More (Today raised in the middle; Tests lives under More).
// Desktop sidebar: Today first, Tests shown (see .home / .deskonly in app.css).
// The shop iPad: clock-in screen first, then one tab per resource group (Links › Group column), no Tests, a short More.
const RES_ICONS = ['☾︎', '❦', '☑', '❏', '◇', '✧'];
/** A resource tab's icon follows its name (so renaming or merging groups keeps sensible icons). */
const resIcon = (g, i) =>
  /recipe|drink|menu|season/i.test(g)
    ? '❦'
    : /manual|handbook|training|policy/i.test(g)
      ? '❏'
      : /clos|clean|side|check/i.test(g)
        ? '☾︎'
        : RES_ICONS[i % RES_ICONS.length];
const resGroups = () =>
  (data.links || []).reduce((a, l) => (l.group && a.indexOf(l.group) < 0 ? a.concat(l.group) : a), []);
const shopTabs = () =>
  [
    ['today', 'Clock in', '◷'],
    ['schedule', 'Schedule', '▦'],
    ['chat', 'Chat', '✉︎'],
    ['lists', 'Lists', '✓'],
    ['inventory', 'Inventory', '▤'],
  ]
    .concat(resGroups().map((g, i) => ['res:' + g, g, resIcon(g, i)]))
    .concat(RECIPES().length && !resGroups().some((g) => /recipe/i.test(g)) ? [['recipes', 'Recipes', '❦']] : [])
    .concat([['more', 'More', '☰']]);
let navHide = load('pt-navhide') === '1';
const INV_TAB = ['inventory', 'Inventory', '▤'];
/* The bottom bar adapts: new people get Training, everyone else gets Recipes; leads get Training (with Team) and
   keep Inventory on wide screens and in More. */
const mainTabs = () => {
  const st = stage(),
    trainOn = ['training', 'tests', 'manual', 'library', 'hr', 'foodhandler', 'progress'].some(on),
    feat = { schedule: 'schedule', chat: 'chat', lists: 'lists', recipes: 'recipes', inventory: 'inventory' },
    keep = (t) => (t[0] === 'tests' ? trainOn : !feat[t[0]] || on(feat[t[0]]));
  const base = [['schedule', 'Schedule', '▦'], ['chat', 'Chat', '✉︎'], ['today', 'Today', '☀︎', 'home'], ['lists', 'Lists', '✓']];
  const tail =
    st === 'staff'
      ? [['recipes', 'Recipes', '❦'], ['tests', 'Training', '✎', 'deskonly']]
      : st === 'lead'
        ? [['tests', 'Training', '✎'], INV_TAB.concat(['deskonly'])]
        : [['tests', 'Training', '✎'], ['recipes', 'Recipes', '❦', 'deskonly']];
  return base.concat(tail).filter(keep).concat([['more', 'More', '☰']]);
};
const TABS = [
  ['schedule', 'Schedule', '▦'],
  ['chat', 'Chat', '✉︎'],
  ['today', 'Today', '☀︎', 'home'],
  ['lists', 'Lists', '✓'],
  ['tests', 'Training', '✎', 'deskonly'],
  ['more', 'More', '☰'],
];
let lastView = '';
/* ----- icon badge: unread messages as a number on the app icon (installed apps; iPhone needs notifications on) ----- */
let lastBadge = -1;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    lastBadge = -1;
    syncBadge();
  }
});
function syncBadge() {
  const n = data && data.channels ? data.channels.reduce((a, c) => a + (Number(c.unread) || 0), 0) : 0;
  if (n === lastBadge) return;
  lastBadge = n;
  try {
    if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch (_) {}
  try {
    caches
      .open(NS + 'chat-pass')
      .then((c) => c.put('/badge', new Response(String(n))))
      .catch(() => {});
  } catch (_) {} // the notification handler counts up from here
}
/** Desktop sidebar: the More pages listed out, with Settings at the bottom (the phone keeps them under More). */
function deskMore() {
  if (!wide() || !data) return '';
  if (shop()) {
    const it = (k, n, ic) =>
      `<button data-more="${k}" class="deskonly" ${tab === 'more' && moreView === k ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${n}</button>`;
    return `<div class="tabsep deskonly" aria-hidden="true"></div>${it('news', 'Announcements', '⚑')}${(data.links || []).some((l) => !l.group) ? it('resources', 'Other resources', '❏') : ''}<div class="tabspacer deskonly" aria-hidden="true"></div>${it('settings', 'Settings', '⚙︎')}`;
  }
  const pendN = mgr()
      ? (data.requests || []).filter((q) => q.status === 'Pending' && q.from !== data.me.name).length
      : 0,
    unreadN = (data.announcements || []).filter((a) => !a.read).length;
  const it = (k, n, ic, badge) =>
    `<button data-more="${k}" class="deskonly" ${tab === 'more' && (moreView === k || (k === 'settings' && /^(push|reminders)$/.test(moreView))) ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${n}${badge ? `<span class="n">${badge}</span>` : ''}</button>`;
  return `<div class="tabsep deskonly" aria-hidden="true"></div>${on('news') ? it('news', 'Announcements', '⚑', unreadN) : ''}${on('timeclock') ? it('time', mgr() ? 'Time sheets' : 'My time', '⏱') : ''}${on('requests') ? it('requests', 'Requests', '⇄', pendN) : ''}${on('availability') ? it('avail', 'Availability', '◷') : ''}${on('dialin') ? it('dialin', 'Dial-in log', '◎') : ''}${on('drawer') ? it('drawer', 'Drawer count', '$') : ''}${mgr() ? it('team', 'Team', '☺') : ''}${data.master ? it('master', 'Master admin', '⚙︎') : ''}
    <div class="tabspacer deskonly" aria-hidden="true"></div>${it('settings', 'Settings', '⚙︎')}`;
}
function setShop(t) {
  const el = $('#shop');
  if (canSwitch())
    el.innerHTML = `<button class="locbtn" data-locs aria-label="Switch location">${esc(locName(HERE))} <span aria-hidden="true">▾</span></button>`;
  else el.textContent = t;
} // with the switcher, the bar names the location
/* A save, a refresh or a chat update redraws the screen. Whatever someone is in the middle of choosing in an open
   pop-up (or in a form they've started on the page) is put back after the redraw, so a choice never "reverts".
   Parts of the screen that come out exactly the same aren't rebuilt at all. */
let lastMainHtml = '',
  lastOvHtml = '';
const DIRTY_FORMS = new Set();
const sheetId = () => (sheet ? [sheet.kind, sheet.id, sheet.date, sheet.name, sheet.test, sheet.skill].join('|') : '');
const formKey = (f) =>
  f.closest('#overlay')
    ? 'ov|' + f.dataset.form + '|' + sheetId()
    : 'mn|' + f.dataset.form + '|' + tab + '|' + moreView + '|' + trainSel;
function snapForms() {
  const out = {},
    ae = document.activeElement;
  document.querySelectorAll('form[data-form]').forEach((f) => {
    const k = formKey(f);
    if (k.indexOf('ov|') !== 0 && !DIRTY_FORMS.has(k)) return;
    const vals = {};
    [...f.elements].forEach((el) => {
      if (!el.name || el.type === 'submit' || el.type === 'button' || el.type === 'file') return;
      if (el.type === 'radio') {
        if (el.checked) vals[el.name] = el.value;
        else if (!(el.name in vals)) vals[el.name] = null;
      } else vals[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    out[k] = { vals, focus: ae && ae.form === f && ae.name ? [ae.name, ae.selectionStart, ae.selectionEnd] : null };
  });
  return out;
}
function restoreForms(snap) {
  document.querySelectorAll('form[data-form]').forEach((f) => {
    const sv = snap[formKey(f)];
    if (!sv) return;
    const changed = [];
    [...f.elements].forEach((el) => {
      if (!el.name || !(el.name in sv.vals)) return;
      const v = sv.vals[el.name];
      if (el.type === 'radio') {
        const on = el.value === v;
        if (el.checked !== on) {
          el.checked = on;
          if (on) changed.push(el);
        }
      } else if (el.type === 'checkbox') {
        if (el.checked !== v) {
          el.checked = v;
          changed.push(el);
        }
      } else if (el.value !== v) {
        el.value = v;
        changed.push(el);
      }
    });
    changed.forEach((el) => {
      if (el.tagName === 'SELECT' || el.type === 'radio' || el.type === 'checkbox')
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    if (sv.focus) {
      const el = f.elements.namedItem(sv.focus[0]);
      if (el && el.focus && document.activeElement !== el) {
        el.focus();
        try {
          el.setSelectionRange(sv.focus[1], sv.focus[2]);
        } catch (_) {}
      }
    }
  });
}
document.addEventListener(
  'input',
  (e) => {
    const f = e.target.form;
    if (f && f.dataset.form) DIRTY_FORMS.add(formKey(f));
  },
  true
);
document.addEventListener(
  'change',
  (e) => {
    const f = e.target.form;
    if (f && f.dataset.form && e.isTrusted) DIRTY_FORMS.add(formKey(f));
  },
  true
);
document.addEventListener('focusout', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))
    setTimeout(() => {
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || ''))
        window.scrollTo(window.scrollX, window.scrollY);
    }, 60);
});
function render() {
  syncBadge();
  syncWake();
  if (rowDrag) {
    rowDrag.later = true;
    return;
  } // don't redraw under a finger mid-drag
  $('#offline').hidden = !offline;
  if (joined && TOKEN) {
    $('#tabs').hidden = true;
    $('#refresh').hidden = true;
    $('#overlay').innerHTML = '';
    lastMainHtml = lastOvHtml = '';
    $('#main').innerHTML = viewJoined();
    return;
  }
  if (!TOKEN || !data) {
    $('#tabs').hidden = true;
    $('#refresh').hidden = true;
    $('#overlay').innerHTML = '';
    lastMainHtml = lastOvHtml = '';
    setShop(load('pt-shop') || window.PT_NAME || 'Peregrine');
    $('#main').innerHTML = TOKEN ? '<div class="empty">Loading…</div>' : viewSignIn();
    return;
  }
  data.meId = data.me.id;
  const short = String(data.name || 'Peregrine').replace(/\s+(coffee|roasters?|roastery|co\.?)\b.*$/i, '') || data.name;
  setShop(short);
  save('pt-shop', short);
  $('#refresh').hidden = false;
  const gate = mustRead();
  if (gate.length) {
    $('#tabs').hidden = true;
    $('#overlay').innerHTML = '';
    lastMainHtml = lastOvHtml = '';
    $('#main').innerHTML = viewMustRead(gate[0], gate.length);
    return;
  }
  const chatN = (data.channels || []).reduce((n, c) => n + c.unread, 0);
  const badge = {
    lists: prepMine().length,
    chat: chatN,
    more:
      (mgr() ? (data.requests || []).filter((q) => q.status === 'Pending' && q.from !== data.me.name).length : 0) +
      (data.announcements || []).filter((a) => !a.read).length,
    tests: data.trBadge ? (data.trBadge.manual || 0) + (data.trBadge.recipes || 0) + (data.trBadge.sign || 0) : 0,
  };
  $('#tabs').hidden = false;
  if (shop() && !shopTabs().some((t) => t[0] === tab)) tab = 'today';
  if (!shop() && tab === 'inventory' && !lead()) tab = 'today';
  $('#tabs').innerHTML =
    (shop() ? shopTabs() : mainTabs())
      .map(
        ([k, n, ic, cls]) =>
          `<button data-tab="${k}" class="${cls || ''}${k === 'more' ? ' mobonly' : ''}${k === 'more' && tab === 'tests' ? ' cur-m' : ''}" ${tab === k && !(k === 'more' && wide()) ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${ic}</span>${n}${badge[k] ? `<span class="n">${badge[k]}</span>` : ''}</button>`
      )
      .join('') +
    deskMore() +
    (shop()
      ? '<button data-navhide class="navhidebtn" aria-label="Hide menu"><span class="ic" aria-hidden="true">⌄</span>Hide</button>'
      : '');
  const ae = document.activeElement,
    keepWage =
      ae && ae.dataset && (ae.dataset.wage || ae.dataset.invf)
        ? [
            ae.dataset.wage
              ? `[data-wage="${ae.dataset.wage}"]`
              : `[data-invf="${ae.dataset.invf}"][data-invk="${ae.dataset.invk}"]`,
            ae.value,
            ae.selectionStart,
          ]
        : null;
  const typingIn =
    document.activeElement && document.activeElement.closest && document.activeElement.closest('.composer');
  const draft = typingIn ? document.activeElement.value : null;
  document.body.classList.toggle('inchat', tab === 'chat' && !!chat.open);
  document.body.classList.toggle('wide', wide() && tab === 'schedule' && lead() && schedView !== 'mine');
  const vkey = tab + '|' + schedView + '|' + week + '|' + moreView,
    same = vkey === lastView,
    gw = $('.gridwrap'),
    keep = same && gw ? [gw.scrollTop, gw.scrollLeft] : null,
    wy = window.scrollY;
  lastView = vkey;
  const ms0 = $('#msgs'),
    keepMs =
      ms0 && tab === 'chat' && chat.open
        ? [chat.open, ms0.scrollTop, ms0.scrollHeight - ms0.scrollTop - ms0.clientHeight]
        : null;
  const formSnap = snapForms();
  const mainHtml = /^res:/.test(tab)
    ? viewResGroup(tab.slice(4))
    : tab === 'recipes'
      ? viewRecipes()
      : tab === 'inventory'
        ? viewInventory()
        : tab === 'tests'
          ? viewTests()
          : tab === 'lists'
            ? whoBar() + viewLists()
            : tab === 'schedule'
              ? viewSchedule()
              : tab === 'chat'
                ? viewChat()
                : tab === 'more'
                  ? viewMore()
                  : viewToday();
  if (mainHtml !== lastMainHtml || !$('#main').firstChild) {
    $('#main').innerHTML = mainHtml;
    lastMainHtml = mainHtml;
  }
  if (keepMs && chat.open === keepMs[0]) {
    const ms = $('#msgs');
    if (ms) ms.scrollTop = keepMs[2] < 80 ? ms.scrollHeight : keepMs[1];
  }
  if (same && tab !== 'chat') {
    const g2 = $('.gridwrap');
    if (keep && g2) {
      g2.scrollTop = keep[0];
      g2.scrollLeft = keep[1];
    }
    if (window.scrollY !== wy) window.scrollTo(0, wy);
  } // a save or refresh redraws the page; stay where you were
  if (draft !== null) {
    const t = $('.composer textarea');
    if (t) {
      t.value = draft;
      t.focus();
    }
  }
  if (!sheet && !viewer && !runner && !joined && prepPopItems().length) sheet = { kind: 'preppop' };
  const ovHtml = runner
    ? viewRunner()
    : viewer
      ? viewViewer()
      : sheet
        ? sheet.kind === 'shift'
          ? shiftSheet()
          : sheet.kind === 'publish'
            ? publishSheet()
            : sheet.kind === 'clocktype'
              ? clockTypeSheet()
              : sheet.kind === 'punch'
                ? punchSheet()
                : sheet.kind === 'editchat'
                  ? editChatSheet()
                  : sheet.kind === 'loc'
                    ? locSheet()
                    : sheet.kind === 'preppop'
                      ? prepPopSheet()
                      : sheet.kind === 'dialpop'
                        ? dialPopSheet()
                      : sheet.kind === 'testacc'
                        ? testAccSheet()
                        : sheet.kind === 'reqedit'
                          ? reqEditSheet()
                          : sheet.kind === 'availedit'
                            ? availEditSheet()
                            : sheet.kind === 'trainnew'
                              ? trainNewSheet()
                              : sheet.kind === 'trainnote'
                                ? trainNoteSheet()
                                : sheet.kind === 'kiosk'
                                  ? kioskSheet()
                                  : sheet.kind === 'kioskdone'
                                    ? kioskDoneSheet()
                                    : sheet.kind === 'kpick'
                                      ? kpickSheet()
                                      : sheet.kind === 'prepcount'
                                        ? prepCountSheet()
                                        : sheet.kind === 'who'
                                          ? whoSheet()
                                          : pickSheet(sheet.kind)
        : '';
  if (ovHtml !== lastOvHtml) {
    $('#overlay').innerHTML = ovHtml;
    lastOvHtml = ovHtml;
  }
  restoreForms(formSnap);
  document.querySelectorAll('form[data-form=availedit]').forEach((f) => {
    syncAvailPick(f);
    if (!f.dataset.scrolled) {
      f.dataset.scrolled = '1';
      scrollAvailPick(f);
    }
  });
  document.body.classList.toggle('noscroll', !!(viewer || sheet || runner));
  document.body.classList.toggle('navhide', shop() && navHide); // shop iPad: menu folded away
  let fab = $('#navfab');
  if (shop() && !fab) {
    fab = document.createElement('button');
    fab.id = 'navfab';
    fab.dataset.navshow = '';
    fab.setAttribute('aria-label', 'Show menu');
    fab.innerHTML = '<span aria-hidden="true">☰</span> Menu';
    document.body.appendChild(fab);
  }
  if (fab) fab.hidden = !(shop() && navHide);
  if (keepWage) {
    const el = document.querySelector(keepWage[0]);
    if (el) {
      el.value = keepWage[1];
      el.focus();
      try {
        el.setSelectionRange(keepWage[2], keepWage[2]);
      } catch (_) {}
    }
  }
  const sf = document.querySelector('form[data-form=shift]'),
    est = $('#est');
  if (sf && est) est.innerHTML = shiftEstimate(sf);
}

/* ---------- events ---------- */
const theme = () => load('pt-theme') || 'auto';
function setTheme(t) {
  save('pt-theme', t === 'auto' ? null : t);
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => {
    m.content = dark ? '#0E1111' : '#1E5662';
  });
}
function scrollToday() {
  const h = $('#todayh');
  if (h) window.scrollTo(0, h.getBoundingClientRect().top + window.scrollY - 70);
}
function getPos() {
  if (!data.geo || !navigator.geolocation) return Promise.resolve({});
  return new Promise((res) =>
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => res({}),
      { timeout: 7000, maximumAge: 60000, enableHighAccuracy: true }
    )
  );
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[data-file]');
  if (a && !chat.sel) openFile(e, a);
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button, a[data-x]');
  if (!b) {
    const td = e.target.closest && e.target.closest('td[data-cell]');
    if (td && lead()) {
      const [who, date] = td.dataset.cell.split('|');
      sheet = {
        kind: 'shift',
        date,
        name: who,
        start: (data.presets[0] || {}).start,
        end: (data.presets[0] || {}).end,
      };
      render();
    }
    return;
  }
  const d = b.dataset;
  // recipe book
  if (d.recipe) {
    openRecipe(d.recipe);
    return;
  }
  if (d.recedit) {
    recEdit = d.recedit;
    if (d.recedit !== 'new') recSel = d.recedit;
    loadRecCost();
    window.scrollTo(0, 0);
    render();
    return;
  }
  if (d.reccancel !== undefined) {
    if (recEdit === 'new') recSel = '';
    recEdit = '';
    DIRTY_FORMS.clear();
    window.scrollTo(0, 0);
    render();
    return;
  }
  if (d.recshow) {
    const r = recById(d.recshow);
    if (!r) return;
    const on = d.on === '1';
    r.hidden = !on;
    render();
    act('showRecipe', { id: r.id, orig: r.name, on: on ? '1' : '0' });
    toast(on ? 'Shown to the team' : 'Hidden from the team');
    return;
  }
  if (d.recdel) {
    const r = recById(d.recdel);
    if (!r || !confirm('Delete “' + r.name + '” for good? It comes out of the sheet too.')) return;
    data.recipes = RECIPES().filter((y) => y.id !== r.id);
    recEdit = '';
    recSel = '';
    render();
    act('delRecipe', { id: r.id, orig: r.name });
    return;
  }
  if (d.prepfill) {
    const inp = $('form[data-form=prep] input[name=item]');
    if (inp) {
      inp.value = d.prepfill;
      document.querySelectorAll('.pchip').forEach((c) => c.classList.toggle('on', c === b));
      const det = $('form[data-form=prep] input[name=details]');
      if (det) det.focus();
    }
    return;
  }
  if (d.recback !== undefined) {
    recSel = '';
    recScale = 1;
    window.scrollTo(0, 0);
    render();
    return;
  }
  if (d.reckind) {
    recKind = d.reckind;
    save('pt-reckind', recKind);
    render();
    return;
  }
  if (d.recscale) {
    recScale = Number(d.recscale) || 1;
    render();
    return;
  }
  if (d.recstep !== undefined) {
    b.classList.toggle('on'); // ticked steps live on screen only; leaving the recipe clears them
    const all = [...document.querySelectorAll('.rc-step')],
      card = $('#rc-prep');
    if (card) {
      const ready = all.length > 0 && all.every((x) => x.classList.contains('on'));
      card.classList.toggle('ready', ready);
      const q = card.querySelector('.rc-prep-q');
      if (q) q.textContent = ready ? 'All done — tick it off the prep list?' : 'On the prep list';
      if (ready) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }
  if (d.prepok !== undefined) {
    prepSeenAll();
    sheet = null;
    if (d.golist === undefined) {
      render();
      return;
    }
  } // prep pop-up: Got it / Open the prep list
  if (b.id === 'refresh') {
    manualRefresh();
    return;
  } // the refresh button always asks the Sheet itself
  if (d.install !== undefined && installEvt) {
    installEvt.prompt();
    installEvt = null;
    return;
  }
  if (d.ack) {
    const a = data.announcements.find((x) => x.id === d.ack);
    if (a) a.read = true;
    render();
    act('read', { id: d.ack });
    return;
  }
  if (d.tab) {
    tab = d.tab;
    save('pt-tab', tab);
    sheet = null;
    viewer = null;
    recSel = '';
    recEdit = '';
    editUser = null;
    tsPerson = '';
    if (tab === 'more') moreView = '';
    stopChat();
    window.scrollTo(0, 0);
    /* a tab always opens on its main screen: backs out of a DM, a More page, etc. */ render();
    if (tab === 'schedule') scrollToday();
    return;
  }
  if (d.golist) {
    listTab = d.golist;
    tab = 'lists';
    save('pt-tab', tab);
    window.scrollTo(0, 0);
    render();
    return;
  }
  if (d.more !== undefined) {
    tab = 'more';
    moreView = d.more;
    editUser = null;
    recSel = '';
    recEdit = '';
    if (d.more !== 'time') tsPerson = '';
    if (d.more === 'time' && b.textContent.includes('Back')) tsPerson = '';
    window.scrollTo(0, 0);
    render();
    return;
  }
  if (d.list) {
    listTab = d.list;
    if (d.list === INV) loadInv();
    render();
    return;
  }
  if (d.invtab) {
    invTab = d.invtab;
    save('pt-invtab', invTab);
    render();
    return;
  }
  if (d.invfull !== undefined) {
    invFull = !invFull;
    render();
    return;
  }
  if (d.invtodo !== undefined) {
    invTodo = !invTodo;
    render();
    return;
  }
  if (d.invstep) {
    const x = inv && inv.items.find((i) => i.tab + '|' + i.row === d.invk);
    if (!x) return;
    const v = Math.max(0, (Number(x.onHand) || 0) + Number(d.invstep));
    queueCount(x, 'onHand', String(v));
    render();
    return;
  }
  if (d.prepdone && shop() && d.on !== '1') {
    if (whoNow()) return shopDone({ what: 'prep', id: d.prepdone }, whoNow());
    sheet = { kind: 'who', what: 'prep', id: d.prepdone };
    render();
    return;
  }
  if (d.prepdone && d.on !== '1' && askCount(d.prepdone, '')) return;
  if (d.prepdone) {
    const x = (data.prep || []).find((p) => p.id === d.prepdone),
      on = d.on !== '1';
    if (x) {
      x.doneAt = on ? new Date().toISOString() : '';
      x.doneBy = on ? data.me.name : '';
    }
    render();
    act('donePrep', { id: d.prepdone, done: on ? '1' : '0' });
    return;
  }
  if (d.prepdel) {
    if (!confirm('Remove this prep item?')) return;
    data.prep = (data.prep || []).filter((p) => p.id !== d.prepdel);
    render();
    act('delPrep', { id: d.prepdel });
    return;
  }
  if (d.theme) {
    setTheme(d.theme);
    render();
    return;
  }
  if (d.sview) {
    schedView = d.sview;
    save('pt-sview', schedView);
    render();
    if (schedView === 'build') scrollToday();
    return;
  }
  if (d.mine !== undefined) {
    schedMine = d.mine === '1';
    save('pt-mine', schedMine ? '1' : '0');
    render();
    return;
  }
  if (d.week) {
    week = plus(week, Number(d.week));
    render();
    window.scrollTo(0, 0);
    scrollToday();
    return;
  }
  if (d.tsmode) {
    tsMode = d.tsmode;
    save('pt-tsmode', tsMode);
    render();
    return;
  }
  if (d.tsstep) {
    const [f, t] = rangeOf(tsMode, tsDate || T());
    tsDate =
      tsMode === 'day'
        ? plus(f, Number(d.tsstep))
        : Number(d.tsstep) < 0
          ? tsMode === 'period'
            ? plus(f, -1)
            : plus(f, -7)
          : plus(t, 1);
    render();
    return;
  }
  if (d.tsjump !== undefined) {
    tsDate = T();
    render();
    return;
  }
  if (d.tsday) {
    tab = 'more';
    save('pt-tab', tab);
    moreView = 'time';
    tsMode = 'day';
    tsDate = d.tsday;
    tsPerson = '';
    window.scrollTo(0, 0);
    render();
    return;
  }
  if (d.tsperson) {
    tsPerson = d.tsperson;
    window.scrollTo(0, 0);
    render();
    return;
  }
  if (d.signout !== undefined) {
    if (confirm('Sign out on this phone?')) signOut();
    return;
  }
  if (d.showcode) {
    showCode[d.showcode] = !showCode[d.showcode];
    render();
    return;
  }
  if (d.edit) {
    editUser = d.edit;
    render();
    return;
  }
  if (d.canceledit !== undefined) {
    editUser = null;
    render();
    return;
  }
  if (d.readall !== undefined) {
    (data.channels || []).forEach((c) => {
      if (c.unread) {
        c.unread = 0;
        try {
          LIVE && LIVE.send({ t: 'read', ch: c.id });
        } catch (_) {}
      }
    });
    lastBadge = -1;
    render();
    toast('All caught up');
    return;
  }
  if (d.locs !== undefined) {
    sheet = { kind: 'loc' };
    render();
    return;
  }
  if (d.loc) {
    if (d.loc === HERE) {
      sheet = null;
      render();
      return;
    }
    switchTo(d.loc);
    return;
  }
  if (d.joindone !== undefined) {
    joined = null;
    render();
    return;
  }
  if (d.dismiss !== undefined) {
    justAdded = null;
    inviteFor = '';
    render();
    return;
  }
  if (d.invite) {
    inviteFor = d.invite;
    justAdded = null;
    render();
    const el = $('#invite');
    if (el) el.scrollIntoView({ block: 'start' });
    return;
  }
  if (d.shareinvite || d.copyinvite) {
    const u = (data.users || []).find((x) => x.id === (d.shareinvite || d.copyinvite));
    if (!u) return;
    if (d.shareinvite) {
      navigator
        .share({
          title: 'Peregrine team app',
          text: inviteText(u)
            .replace(inviteLink(u), '')
            .replace(/\n\n\n/, '\n\n'),
          url: inviteLink(u),
        })
        .catch(() => {});
      return;
    }
    (navigator.clipboard ? navigator.clipboard.writeText(inviteText(u)) : Promise.reject()).then(
      () => toast('Invite copied – paste it in a text'),
      () => {
        const i = $('#invite .linkbox');
        if (i) {
          i.select();
          document.execCommand('copy');
          toast('Link copied');
        }
      }
    );
    return;
  }
  if (d.closesheet !== undefined) {
    sheet = null;
    render();
    return;
  }
  if (d.taketest) {
    startTest(d.taketest);
    return;
  }
  if (d.closetest !== undefined) {
    if (
      runner &&
      !runner.done &&
      Object.keys(runner.a || {}).length &&
      !confirm('Leave the test? Your answers stay saved on this phone.')
    )
      return;
    runner = null;
    render();
    if (tab === 'tests') loadTests();
    return;
  }
  if (d.pick !== undefined && runner) {
    runner.a[runner.i] = runner.t.q[runner.i].o[Number(d.pick)];
    save('pt-test-' + runner.level, JSON.stringify(runner.a));
    render();
    return;
  }
  if (d.tq && runner) {
    runner.i = Math.max(0, Math.min(runner.t.q.length - 1, runner.i + Number(d.tq)));
    render();
    const o = document.querySelector('.runner');
    if (o) o.scrollTop = 0;
    return;
  }
  if (d.submittest !== undefined && runner && !runner.sending) {
    submitTest();
    return;
  }
  if (d.closeviewer !== undefined) {
    viewer = null;
    render();
    return;
  }
  if (d.pdf) {
    openPdf(d.pdf);
    return;
  }
  if (d.openchat) {
    openChat(d.openchat);
    return;
  }
  if (d.closechat !== undefined) {
    stopChat();
    render();
    return;
  }
  if (d.newdm !== undefined) {
    sheet = { kind: 'dm' };
    render();
    return;
  }
  if (d.newgroup !== undefined) {
    sheet = { kind: 'group' };
    render();
    return;
  }
  if (d.reply) {
    startReply(d.reply);
    return;
  }
  if (d.unreply !== undefined) {
    chat.reply = null;
    render();
    return;
  }
  if (d.mack) {
    if (chat.open) toggleAck(d.mack);
    return;
  }
  if (d.copymsg) {
    const m = (chat.msgs || []).find((x) => x.id === d.copymsg);
    chat.meta = '';
    render();
    if (m && m.text) copyText(m.text).then((ok) => toast(ok ? 'Copied' : "Couldn't copy"));
    return;
  }
  if (d.acks) {
    const m = (chat.msgs || []).find((x) => x.id === d.acks);
    if (m) toast('👍 from ' + (m.acks || []).map((n) => (n === data.me.name ? 'you' : first(n))).join(', '));
    return;
  }
  if (d.seenall !== undefined) {
    const c = curChat(),
      last = (chat.msgs || []).filter((m) => m.fromId === chat.me).pop();
    toast(
      'Seen by ' +
        (chat.seen || [])
          .filter((x) => last && new Date(x.at) >= new Date(last.at))
          .map((x) => first(x.name))
          .join(', ')
    );
    return;
  }
  if (d.jump) {
    jumpTo(d.jump);
    return;
  }
  if (d.openfind) {
    const [c, id] = d.openfind.split('|');
    chat.msgs = [];
    openChat(c, null, undefined, undefined, { find: id });
    return;
  }
  if (d.clearsearch !== undefined) {
    chat.q = '';
    chat.results = null;
    render();
    const el = $('[data-csearch]');
    if (el) el.focus();
    return;
  }
  if (d.ment) {
    const t = $('.composer textarea');
    if (t) {
      const pos = t.selectionStart,
        before = t.value.slice(0, pos).replace(/@[\w]*$/, '@' + d.ment + ' ');
      t.value = before + t.value.slice(pos);
      t.focus();
      t.setSelectionRange(before.length, before.length);
    }
    $('#ment').hidden = true;
    return;
  }
  if (d.editchat !== undefined) {
    sheet = { kind: 'editchat' };
    render();
    return;
  }
  if (d.newchannel !== undefined) {
    sheet = { kind: 'channel' };
    render();
    return;
  }
  if (d.dm) {
    sheet = null;
    const id = 'dm-' + [data.meId, d.dm].sort().join('-');
    chat.msgs = [];
    openChat(id, d.dmname);
    return;
  }
  if (d.preset) {
    const [s, en] = d.preset.split('|'),
      f = b.closest('form');
    f.elements.namedItem('start').value = s;
    f.elements.namedItem('end').value = en;
    const e2 = $('#est');
    if (e2) e2.innerHTML = shiftEstimate(f);
    return;
  }
  if (!data) return;
  if (d.clock) {
    const types = data.clockTypes || [];
    // clocking in: ask what for, unless there's only one choice (or the server is too old to know)
    if (d.clock === 'in' && d.ctype === undefined && types.length > 1) {
      sheet = { kind: 'clocktype' };
      render();
      return;
    }
    const type = d.clock === 'in' ? d.ctype || (types.length === 1 ? types[0] : '') : '';
    if (sheet && sheet.kind === 'clocktype') {
      sheet = null;
      render();
    }
    const cb = $('[data-clock]') || b;
    cb.disabled = true;
    cb.textContent = d.clock === 'in' ? 'Clocking in…' : 'Clocking out…';
    const pos = await getPos();
    act(d.clock === 'in' ? 'clockIn' : 'clockOut', type ? Object.assign({ type }, pos) : pos).then((r) => {
      if (r && d.clock === 'in' && on('dialin') && !/meeting/i.test(type) && !sheet) sheet = { kind: 'dialpop' };
      if (r && d.clock === 'in' && tab === 'today') {
        const L = shiftList();
        if (L) {
          listTab = L;
          tab = 'lists';
          save('pt-tab', tab);
          window.scrollTo(0, 0);
          render();
        }
      }
      if (r)
        toast(
          d.clock === 'in'
            ? 'Clocked in' + (type ? ' as ' + type : '') + ' · ' + timeOf(new Date().toISOString())
            : 'Clocked out · have a good one'
        );
    });
    return;
  }
  if (
    sheet &&
    sheet.kind === 'prepcount' &&
    (d.pcstep || d.pcsave !== undefined || d.pcskip !== undefined || d.pcrelink !== undefined)
  ) {
    const f = $('form[data-form=prepcount]'),
      val = f ? f.elements.namedItem('n').value.trim() : '',
      pick = f && f.elements.namedItem('pick') ? f.elements.namedItem('pick').value : sheet.pick;
    sheet.val = val;
    sheet.pick = pick;
    if (d.pcrelink !== undefined) {
      sheet.pick = '';
      sheet.relink = true;
      render();
      return;
    }
    if (d.pcstep) {
      sheet.val = String(Math.max(0, (Number(val) || 0) + Number(d.pcstep)));
      if (f) f.elements.namedItem('n').value = sheet.val; // change the number in place (a redraw would put the typed value back)
      return;
    }
    if (d.pcsave !== undefined && pick && pick !== 'none' && (val === '' || isNaN(+val) || +val < 0)) {
      sheet.err = 'Type how many we have';
      render();
      return;
    }
    finishPrep(
      sheet,
      d.pcskip !== undefined ? null : pick === 'none' ? { noinv: '1' } : pick ? { inv: pick, count: val } : null
    );
    return;
  }
  if (d.kpick !== undefined) {
    sheet = { kind: 'kpick' };
    render();
    return;
  }
  if (d.navhide !== undefined || d.navshow !== undefined) {
    navHide = d.navhide !== undefined;
    save('pt-navhide', navHide ? '1' : null);
    render();
    return;
  }
  if (d.ktype !== undefined && sheet && sheet.kind === 'kiosk') {
    sheet.type = d.ktype;
    sheet.code = '';
    sheet.err = '';
    render();
    return;
  }
  if (d.kiosk) {
    const ts = kioskTypes(d.kiosk);
    sheet = { kind: 'kiosk', id: d.kiosk, code: '', err: '', type: ts.length === 1 ? ts[0] : '' };
    render();
    return;
  }
  if (d.kpad && sheet && sheet.kind === 'kiosk' && !sheet.busy) {
    if (d.kpad === 'del') sheet.code = sheet.code.slice(0, -1);
    else if (sheet.code.length < 4) sheet.code += d.kpad;
    sheet.err = '';
    render();
    if (sheet.code.length === 4) kioskGo();
    return;
  }
  if (d.whopick && sheet && sheet.kind === 'who') {
    const w = sheet;
    sheet = null;
    shopDone(w, d.whopick);
    return;
  }
  if (d.whoclear !== undefined) {
    clearWho();
    render();
    return;
  }
  if (d.shopweek !== undefined) {
    shopWeek = d.shopweek === '0' ? '' : plus(shopWeek || monday(T()), Number(d.shopweek));
    if (shopWeek === monday(T())) shopWeek = '';
    render();
    return;
  }
  if (d.check && shop() && d.on !== '1') {
    if (whoNow()) return shopDone({ what: 'check', list: listTab, task: d.check }, whoNow());
    sheet = { kind: 'who', what: 'check', list: listTab, task: d.check };
    render();
    return;
  }
  if (d.check) {
    const on = d.on !== '1',
      k = 'c|' + listTab + '|' + d.check;
    busy[k] = on;
    render();
    if (on && navigator.vibrate) navigator.vibrate(10);
    act('check', { list: listTab, task: d.check, done: on ? '1' : '0' });
    return;
  }
  if (d.read) {
    const a = data.announcements.find((x) => x.id === d.read);
    if (a) a.read = true;
    render();
    act('read', { id: d.read });
    return;
  }
  if (d.unann) {
    if (!confirm('Remove this announcement for everyone?')) return;
    data.announcements = data.announcements.filter((x) => x.id !== d.unann);
    render();
    act('unannounce', { id: d.unann });
    return;
  }
  if (d.decide) {
    const note = d.ok === '1' ? '' : prompt('Reason (optional) – they will see it') || '';
    act('decide', { id: d.decide, approve: d.ok, note }).then((r) => {
      if (r) toast(d.ok === '1' ? 'Approved' : 'Denied');
    });
    return;
  }
  if (d.pinchat) {
    const id = d.pinchat,
      on = myPins().indexOf(id) < 0;
    if (on && myPins().length >= 10) {
      toast('You can pin up to 10 chats');
      return;
    }
    data.me.pins = on ? [id].concat(myPins()) : myPins().filter((x) => x !== id);
    render();
    act('pinChat', { id, on: on ? '1' : '0' }).then((r) => {
      if (r) toast(on ? 'Pinned to the top of Messages' : 'Unpinned');
    });
    return;
  }
  if (d.cancelreq) {
    const q = (data.requests || []).find((x) => x.id === d.cancelreq);
    if (!q) return;
    if (
      q.status === 'Approved' &&
      !confirm(
        'Cancel ' + (q.from === data.me.name ? 'your' : q.from + "'s") + ' approved time off (' + reqWhen(q) + ')?'
      )
    )
      return;
    q.status = 'Cancelled';
    render();
    act('cancelRequest', { id: q.id }).then((r) => {
      if (r) toast(q.from === data.me.name ? 'Cancelled' : 'Removed');
    });
    return;
  }
  if (d.editreq) {
    sheet = { kind: 'reqedit', id: d.editreq };
    render();
    return;
  }
  if (d.editavail) {
    sheet = { kind: 'availedit', id: d.editavail };
    render();
    return;
  }
  if (d.mycal !== undefined) {
    myCal = d.mycal === '1';
    save('pt-mycal', myCal ? 1 : 0);
    render();
    return;
  }
  if (d.calstep) {
    const [y, m] = (calMonth || T().slice(0, 7) + '-01').split('-').map(Number),
      nd = new Date(y, m - 1 + Number(d.calstep), 1);
    calMonth = nd.getFullYear() + '-' + pad(nd.getMonth() + 1) + '-01';
    render();
    return;
  }
  if (d.calday) {
    calDay = calDay === d.calday ? '' : d.calday;
    render();
    return;
  }
  if (d.addavail !== undefined) {
    sheet = { kind: 'availedit', id: '' };
    render();
    return;
  }
  if (d.tpick) {
    const f = b.closest('form'),
      [k, t] = d.tpick.split('|');
    if (!f) return;
    f.elements.namedItem(k).value = t;
    if (k === 'from' && f.elements.namedItem('to').value && f.elements.namedItem('to').value <= t)
      f.elements.namedItem('to').value = '';
    DIRTY_FORMS.add(formKey(f));
    syncAvailPick(f);
    return;
  }
  if (d.addshift) {
    sheet = {
      kind: 'shift',
      date: d.addshift,
      name: d.who || '',
      start: (data.presets[0] || {}).start,
      end: (data.presets[0] || {}).end,
    };
    render();
    return;
  }
  if (d.editshift) {
    const s = data.shifts.find((x) => x.id === d.editshift);
    if (s) {
      sheet = Object.assign({ kind: 'shift' }, s);
      render();
    }
    return;
  }
  if (d.delshift) {
    if (!confirm('Delete this shift?')) return;
    const x = data.shifts.find((s) => s.id === d.delshift);
    if (x && x.status && x.status !== 'draft') x.status = 'removed';
    else data.shifts = data.shifts.filter((s) => s.id !== d.delshift);
    sheet = null;
    render();
    act('deleteShift', { id: d.delshift });
    return;
  }
  if (d.restore) {
    const x = data.shifts.find((s) => s.id === d.restore);
    if (x) x.status = 'changed';
    sheet = null;
    render();
    act('restoreShift', { id: d.restore });
    return;
  }
  if (d.onsched) {
    const u = (data.users || []).find((x) => x.id === d.onsched);
    if (u) u.onSchedule = d.to === '1';
    render();
    act('setOnSchedule', { id: d.onsched, on: d.to }).then((r) => {
      if (r && u) toast(first(u.name) + (d.to === '1' ? ' is back on the schedule' : ' is hidden from the schedule'));
    });
    return;
  }
  if (d.trainnew !== undefined) {
    sheet = { kind: 'trainnew' };
    render();
    return;
  }
  if (d.trainopen) {
    trainSel = d.trainopen;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (d.trainback !== undefined) {
    trainSel = '';
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (d.trainnote) {
    sheet = { kind: 'trainnote', skill: d.trainnote };
    render();
    return;
  }
  if (d.traincheck) {
    const t = TR().active.find((x) => x.id === trainSel);
    if (!t) return;
    const sk = d.traincheck,
      had = t.done[sk];
    if (had && had.by !== data.me.name && !confirm('Un-check "' + sk + '"? ' + first(had.by) + ' checked it off.'))
      return;
    if (had) delete t.done[sk];
    else t.done[sk] = { by: data.me.name, at: new Date().toISOString(), note: '' };
    render();
    act('trainCheck', { id: t.id, skill: sk, done: had ? '0' : '1' });
    return;
  }
  if (d.trainfile) {
    const t = TR().active.find((x) => x.id === d.trainfile);
    if (!t) return;
    const left = TR().items.length - trDone(t);
    if (
      !confirm(
        (left ? left + ' skill' + (left > 1 ? 's are' : ' is') + ' not checked off. ' : '') +
          'File ' +
          t.name +
          "'s checklist in Drive now?"
      )
    )
      return;
    b.disabled = true;
    b.textContent = 'Filing…';
    act('trainFile', { id: t.id }).then((r) => {
      if (r && r.result && r.result.url) {
        toast('Filed in Drive');
        trainSel = '';
        render();
      } else {
        b.disabled = false;
        b.textContent = 'File checklist';
      }
    });
    return;
  }
  if (d.traindel) {
    const t = TR().active.find((x) => x.id === d.traindel);
    if (!t || !confirm('Delete ' + t.name + "'s checklist? This can't be undone.")) return;
    data.training.active = TR().active.filter((x) => x.id !== t.id);
    trainSel = '';
    render();
    act('trainDelete', { id: t.id });
    return;
  }
  if (d.tpfilter !== undefined) {
    tpFilter = d.tpfilter;
    render();
    return;
  }
  if (d.tptip) {
    toast(d.tptip);
    return;
  }
  if (d.testacc) {
    sheet = { kind: 'testacc', test: d.testacc };
    render();
    return;
  }
  if (d.publish !== undefined) {
    sheet = { kind: 'publish' };
    render();
    return;
  }
  if (d.sendweek !== undefined) {
    if (!confirm('Email everyone working the week of ' + shortDay(week) + ' their shifts?')) return;
    b.disabled = true;
    act('sendWeek', { from: week }).then((r) => {
      if (r && r.result)
        toast(
          'Sent to ' +
            r.result.sent +
            (r.result.noEmail.length ? ' · no email for ' + r.result.noEmail.map(first).join(', ') : '')
        );
    });
    return;
  }
  if (d.testmail !== undefined) {
    b.disabled = true;
    act('testReminder').then((r) => {
      if (r) toast('Sent – check your inbox (and spam)');
    });
    return;
  }
  if (d.copycal) {
    (navigator.clipboard ? navigator.clipboard.writeText(d.copycal) : Promise.reject()).then(
      () => toast('Link copied'),
      () => prompt('Copy this link', d.copycal)
    );
    return;
  }
  if (d.nohint !== undefined) {
    save('pt-nohint', '1');
    render();
    return;
  }
  if (d.thisweek !== undefined) {
    week = monday(T());
    render();
    return;
  }
  if (d.print !== undefined) {
    window.print();
    return;
  }
  if (d.copyweek !== undefined) {
    if (!confirm("Copy last week's shifts into this week? Shifts already here stay; exact duplicates are skipped."))
      return;
    act('copyWeek', { from: plus(week, -7), to: week }).then((r) => {
      if (r) toast('Copied');
    });
    return;
  }
  if (d.clearweek !== undefined) {
    if (!confirm('Delete every shift this week?')) return;
    act('clearWeek', { from: week }).then((r) => {
      if (r) toast('Week cleared');
    });
    return;
  }
  if (d.delavail) {
    if (!confirm("Delete this time you can't work?")) return;
    data.availability = data.availability.filter((a) => a.id !== d.delavail);
    render();
    act('delAvail', { id: d.delavail });
    return;
  }
  if (d.editpunch !== undefined) {
    sheet = { kind: 'punch', id: d.editpunch, date: d.pdate, name: d.pname || tsPerson, start: d.pstart, end: d.pend };
    render();
    return;
  }
  if (d.delpunch) {
    if (!confirm('Delete this punch?')) return;
    sheet = null;
    act('deletePunch', { id: d.delpunch });
    return;
  }
  if (d.pushon !== undefined) {
    pushTurnOn();
    return;
  }
  if (d.pushoff !== undefined) {
    pushTurnOff();
    return;
  }
  if (d.nopush !== undefined) {
    save('pt-nopush', '1');
    render();
    return;
  }
  if (d.pushtest !== undefined) {
    const r = await act('pushTest');
    const x = r && r.result;
    if (x)
      toast(
        x.sent
          ? 'Sent – it should arrive in a few seconds'
          : x.off
            ? "Push isn't set up in the sheet yet"
            : 'Nothing was sent – try turning notifications off and on'
      );
    return;
  }
  if (d.pushpref) {
    const P = (data.push.prefs = data.push.prefs || {});
    const v = d.v;
    if (d.pushpref === 'msg') P.msg = v;
    else P[d.pushpref] = v === '1';
    render();
    act('pushPrefs', { [d.pushpref]: v });
    return;
  }
  if (d.pic) {
    const m = (chat.msgs || []).find((x) => x.id === d.pic),
      src = (m && m.local) || picCache[d.pic];
    if (src) zoomPic(src);
    else loadPic(d.pic);
    return;
  }
  if (d.unphoto !== undefined) {
    const t = $('.composer textarea');
    if (t) chat.compose = t.value;
    chat.photo = '';
    chat.file = null;
    render();
    return;
  }
  if (d.selmsg) {
    const ta = $('.composer textarea');
    if (ta) chat.compose = ta.value;
    chat.sel = [d.selmsg];
    chat.meta = '';
    chat.reply = null;
    render();
    return;
  }
  if (d.selcancel !== undefined) {
    chat.sel = null;
    render();
    return;
  }
  if (d.seldel !== undefined) {
    const ids = (chat.sel || []).slice();
    if (!ids.length) return;
    if (
      !confirm(
        ids.length === 1
          ? "Delete this message? It can't be undone."
          : `Delete these ${ids.length} messages? It can't be undone.`
      )
    )
      return;
    delMsgs(ids);
    return;
  }
  if (d.delmsg) {
    if (!confirm('Delete this message?')) return;
    chat.msgs = chat.msgs.filter((m) => m.id !== d.delmsg);
    render();
    if (LIVE) {
      LIVE.ask({ t: 'del', id: d.delmsg }).catch((e) => {
        toast(e.message);
        openChat(chat.open);
      });
      return;
    }
    await act('deleteMessage', { id: d.delmsg });
    openChat(chat.open);
    return;
  }
  if (d.newcode) {
    if (!confirm('Give ' + d.name + ' a new code? Their old code stops working and they are signed out everywhere.'))
      return;
    showCode[d.newcode] = true;
    act('newCode', { id: d.newcode }).then((r) => {
      if (r) toast('New code made – tell ' + first(d.name));
    });
    return;
  }
  if (d.active) {
    if (d.to === '0' && !confirm('Turn off ' + d.name + '? They are signed out right away and cannot sign in.')) return;
    act('setActive', { id: d.active, active: d.to });
    return;
  }
});
let wageTimer = {};
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.dataset) return;
  if (t.dataset.wans !== undefined && runner) {
    runner.a[runner.i] = t.value;
    save('pt-test-' + runner.level, JSON.stringify(runner.a));
    return;
  }
  if (t.dataset.invsearch !== undefined) {
    invQ = t.value;
    const pos = t.selectionStart;
    render();
    const el = document.querySelector('[data-invsearch]');
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(pos, pos);
      } catch (_) {}
    }
    return;
  }
  if (t.dataset.invf) {
    const x = inv && inv.items.find((i) => i.tab + '|' + i.row === t.dataset.invk);
    const v = t.value.trim();
    if (x && (v === '' || (!isNaN(+v) && +v >= 0))) queueCount(x, t.dataset.invf, v);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.invf && tab === 'inventory') render();
});
window.addEventListener('pagehide', () => {
  if (Object.keys(invQueue).length) flushCounts();
});
document.addEventListener('input', (e) => {
  const f = e.target.closest && e.target.closest('form[data-form=shift]');
  if (f) {
    const el = $('#est');
    if (el) el.innerHTML = shiftEstimate(f);
  }
  const w = e.target.dataset && e.target.dataset.wage;
  if (w) {
    const u = (data.users || []).find((x) => x.id === w),
      val = e.target.value.replace(/[$,\s]/g, '');
    if (u && (val === '' || (!isNaN(+val) && +val >= 0 && +val < 1000))) {
      u.wage = val === '' ? 0 : +val;
      render();
      clearTimeout(wageTimer[w]);
      wageTimer[w] = setTimeout(() => act('setWage', { id: w, wage: val }), 900);
    }
  }
});
document.addEventListener('change', (e) => {
  if (e.target.name === 'day' && e.target.closest('form[data-form=avail],form[data-form=availedit]')) {
    const f = e.target.closest('form');
    f.querySelector('[data-onlydate]').hidden = e.target.value !== 'date';
  }
});
let tch = null,
  noTap = 0;
document.addEventListener(
  'touchstart',
  (e) => {
    const b = e.target.closest && e.target.closest('[data-bub]');
    if (!b || chat.sel || !v3() || b.dataset.bub === 'tmp' || e.touches.length > 1) {
      tch = null;
      return;
    }
    const t = e.touches[0];
    tch = { b, row: b.closest('.mrow'), x: t.clientX, y: t.clientY, dx: 0, h: false };
    if (b.dataset.mine !== '1')
      tch.lp = setTimeout(() => {
        if (tch && !tch.h) {
          noTap = Date.now();
          const id = b.dataset.bub;
          tch = null;
          toggleAck(id);
        }
      }, 450);
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (e) => {
    if (!tch) return;
    const t = e.touches[0],
      dx = t.clientX - tch.x,
      dy = t.clientY - tch.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(tch.lp);
    if (!tch.h && Math.abs(dy) > Math.abs(dx)) {
      if (Math.abs(dy) > 8) tch = null;
      return;
    }
    if (dx > 6) {
      tch.h = true;
      tch.dx = Math.min(dx, 80);
      tch.row.style.transform = `translateX(${tch.dx}px)`;
      tch.row.classList.toggle('armed', tch.dx > 55);
    }
  },
  { passive: true }
);
document.addEventListener(
  'touchend',
  () => {
    if (!tch) return;
    clearTimeout(tch.lp);
    const { row, dx, b } = tch;
    tch = null;
    if (row) {
      row.style.transition = 'transform .18s';
      row.style.transform = '';
      row.classList.remove('armed');
      setTimeout(() => {
        row.style.transition = '';
      }, 200);
    }
    if (dx > 55) {
      noTap = Date.now();
      if (navigator.vibrate)
        try {
          navigator.vibrate(10);
        } catch (_) {}
      startReply(b.dataset.bub);
    }
  },
  { passive: true }
);
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest && e.target.closest('[data-bub]') && v3()) e.preventDefault();
});
document.addEventListener('dblclick', (e) => {
  const b = e.target.closest && e.target.closest('[data-bub]');
  if (b && v3() && b.dataset.mine !== '1' && b.dataset.bub !== 'tmp' && !('ontouchstart' in window)) {
    e.preventDefault();
    toggleAck(b.dataset.bub);
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.csearch !== undefined) {
    chat.q = t.value;
    runSearch();
    keepSearch(render);
    return;
  }
  if (t.tagName === 'TEXTAREA' && t.closest && t.closest('.composer')) {
    const box = $('#ment');
    if (!box) return;
    const m = t.value.slice(0, t.selectionStart).match(/(?:^|\s)@([\w]*)$/),
      ppl = m
        ? audience(curChat())
            .filter(
              (p) =>
                !m[1] ||
                p.name
                  .toLowerCase()
                  .split(' ')
                  .some((w) => w.indexOf(m[1].toLowerCase()) === 0)
            )
            .slice(0, 6)
        : [];
    const team = m && 'team'.indexOf(m[1].toLowerCase()) === 0 && (curChat() || {}).kind !== 'dm';
    box.hidden = !ppl.length && !team;
    box.innerHTML =
      (team
        ? `<button type="button" data-ment="team"><span class="tmav" aria-hidden="true">@</span><span><b>team</b> <small>– everyone in this chat</small></span></button>`
        : '') +
      ppl
        .map(
          (p) =>
            `<button type="button" data-ment="${esc(mentionLabel(p))}">${avatar({ id: p.id, name: p.name }, 24)}${esc(p.name)}</button>`
        )
        .join('');
  }
});
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('#ment')) e.preventDefault();
});
document.addEventListener(
  'click',
  (e) => {
    if (!chat.sel || !chat.open) return;
    const r = e.target.closest && e.target.closest('[data-selrow]');
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    const id = r.dataset.selrow,
      i = chat.sel.indexOf(id);
    if (i >= 0) chat.sel.splice(i, 1);
    else chat.sel.push(id);
    render();
  },
  true
);
document.addEventListener('click', (e) => {
  if (chat.sel) return;
  if (Date.now() - noTap < 500 && e.target.closest && e.target.closest('[data-bub]')) return;
  const b = e.target.closest && e.target.closest('[data-bub]');
  if (!b || e.target.closest('button, a')) return;
  chat.meta = chat.meta === b.dataset.bub ? '' : b.dataset.bub;
  const near = isNearBottom();
  render();
  if (near) scrollChat();
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.closest && t.closest('.composer') && t.tagName === 'TEXTAREA') {
    setDraft(chat.open, t.value);
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 140) + 'px';
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.closest && e.target.closest('.composer') && !isIOS()) {
    e.preventDefault();
    e.target.closest('form').requestSubmit();
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  DIRTY_FORMS.delete(formKey(f));
  const v = (n) => {
    const el = f.elements.namedItem(n);
    return el ? (el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value.trim()) : '';
  };
  const kind = f.dataset.form,
    btn = f.querySelector('button.go');
  if (kind === 'join') {
    if (!/\d{3}\D*\d{4}\s*$/.test(v('phone')) || v('phone').replace(/\D/g, '').length < 10) {
      toast('Type your whole phone number, area code first');
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) {
      toast('Type your email address');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Setting up…';
    try {
      const r = await post({ fn: 'join', invite: invite.key, phone: v('phone'), email: v('email') });
      TOKEN = r.token;
      save('pt-token', TOKEN);
      save('pt-last', first(r.name));
      history.replaceState(null, '', location.pathname + location.search);
      joined = { first: first(r.name), code: r.code };
      invite = null;
      data = null;
      tab = 'today';
      render();
      refresh();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Create my account';
      toast(
        String(err.message || err) === 'timeout' ? 'The server took too long – try again' : String(err.message || err)
      );
    }
    return;
  }
  if (kind === 'signin') {
    const name = v('name'),
      code = v('code');
    if (!name || !/^\d{4}$/.test(code)) {
      toast('Type your first name and your 4-digit code');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const r = await post({ fn: 'signIn', name, code });
      TOKEN = r.token;
      save('pt-token', TOKEN);
      save('pt-last', name);
      if (/^#join=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
      invite = null;
      data = null;
      tab = 'today';
      render();
      refresh();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      toast(
        String(err.message || err) === 'timeout' ? 'The server took too long – try again' : String(err.message || err)
      );
    }
    return;
  }
  if (kind === 'send') {
    const text = f.elements.namedItem('text').value.trim(),
      photo = chat.photo || '',
      file = chat.file || null;
    if (!text && !photo && !file) return;
    const reply = chat.reply;
    chat.reply = null;
    $('#ment') && ($('#ment').hidden = true);
    setDraft(chat.open, '');
    chat.compose = '';
    chat.photo = '';
    chat.file = null;
    chat.msgs = (chat.msgs || []).concat({
      id: 'tmp',
      fromId: chat.me || data.meId,
      from: data.me.name,
      at: new Date().toISOString(),
      text,
      photo: photo ? 1 : 0,
      local: photo,
      file: file ? file.name : undefined,
      size: file ? file.blob.size : 0,
      reply: reply ? { id: reply.id, from: reply.from, text: reply.text } : null,
    });
    render();
    scrollChat();
    const t = $('.composer textarea');
    if (t) {
      t.value = '';
      t.focus();
      t.style.height = '';
    }
    openChat(
      chat.open,
      null,
      text,
      photo || undefined,
      reply || file ? Object.assign(reply ? { replyTo: reply.id, reply } : {}, file ? { file } : {}) : undefined
    );
    return;
  }
  if (kind === 'shift') {
    if (!v('name')) {
      toast('Pick who is working');
      return;
    }
    const p = {
      id: (sheet && sheet.id) || '',
      name: v('name'),
      date: v('date'),
      start: v('start'),
      end: v('end'),
      position: v('position'),
      notes: v('notes'),
    };
    if (p.end <= p.start) {
      toast('The end has to be after the start');
      return;
    }
    const ex = p.id && (data.shifts || []).find((x) => x.id === p.id);
    if (ex) Object.assign(ex, p, { status: ex.status === 'draft' ? 'draft' : 'changed' });
    else {
      p.cid = 'tmp' + Date.now() + Math.random().toString(36).slice(2, 5);
      data.shifts.push(Object.assign({}, p, { id: p.cid, status: 'draft' }));
    }
    data.shifts.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    sheet = null;
    render();
    act('saveShift', p).then((r) => {
      if (r) toast(p.id ? 'Shift saved' : 'Shift added');
    });
    return;
  }
  if (kind === 'trainnew') {
    const name = v('who') === '*' ? v('other') : v('who');
    if (!name) {
      toast('Pick the trainee');
      return;
    }
    const tmp = {
      id: 'tmp' + Date.now(),
      name,
      trainer: v('trainer'),
      started: v('started') || T(),
      status: 'In training',
      score: '',
      watch: '',
      done: {},
    };
    data.training = TR();
    data.training.active = data.training.active.concat(tmp);
    sheet = null;
    trainSel = '';
    render();
    act('trainStart', { name, trainer: v('trainer'), started: v('started') }).then((r) => {
      if (r && r.result && r.result.id) {
        trainSel = r.result.id;
        render();
      }
    });
    return;
  }
  if (kind === 'recipe') {
    if (!v('name')) {
      toast('Give the recipe a name');
      return;
    }
    const id = f.dataset.id,
      old = id !== 'new' && recById(id),
      typ = (f.querySelector('input[name=type]:checked') || {}).value || 'Drink',
      lines = (n) =>
        v(n)
          .split('\n')
          .map((l) => l.replace(/^\s*(?:[-•*·]|\d+[.)])\s+/, '').trim())
          .filter(Boolean);
    const p = {
      id: old ? id : '',
      orig: old ? old.name : '',
      name: v('name'),
      type: typ,
      cat: v('cat'),
      size: v('size'),
      serve: v('serve'),
      keeps: v('keeps'),
      ing: lines('ing').join('\n'),
      steps: lines('steps').join('\n'),
      notes: v('notes'),
      tier: v('tier'),
      cogs: v('cogs'),
    };
    if (old) p.order = v('order');
    // show it straight away; the save brings back the sheet's copy
    const shown = Object.assign({}, old || { id: 'tmp' + Date.now(), order: 9999, hidden: false }, {
      name: p.name,
      type: p.type,
      cat: p.cat,
      size: p.size,
      serve: p.serve,
      keeps: p.keeps,
      ing: lines('ing'),
      steps: lines('steps'),
      notes: p.notes,
      tier: p.tier,
      cogs: p.cogs,
    });
    data.recipes = old ? RECIPES().map((y) => (y.id === id ? shown : y)) : RECIPES().concat(shown);
    recEdit = '';
    recSel = shown.id;
    recKind = typ;
    window.scrollTo(0, 0);
    render();
    act('saveRecipe', p).then((r) => {
      if (r && r.result && r.result.id) {
        if (!recEdit && isRecView() && (recSel === shown.id || !recSel)) recSel = r.result.id; // open the saved recipe
        toast(old ? 'Recipe saved' : 'Recipe added');
        render();
      }
    });
    return;
  }
  if (kind === 'trainnote') {
    const t = TR().active.find((x) => x.id === trainSel),
      sk = sheet.skill;
    if (t && t.done[sk]) t.done[sk].note = v('note');
    sheet = null;
    render();
    if (t) act('trainCheck', { id: t.id, skill: sk, done: '1', note: v('note') });
    return;
  }
  if (kind === 'trainedit') {
    const t = TR().active.find((x) => x.id === trainSel);
    if (!t) return;
    if (v('score') !== '' && !(Number(v('score')) >= 0 && Number(v('score')) <= 15)) {
      toast('The test score is out of 15');
      return;
    }
    Object.assign(t, {
      trainer: v('trainer'),
      started: v('started') || t.started,
      score: v('score'),
      watch: v('watch'),
    });
    render();
    act('trainEdit', { id: t.id, trainer: t.trainer, started: t.started, score: t.score, watch: t.watch }).then((r) => {
      if (r) toast('Saved');
    });
    return;
  }
  if (kind === 'testacc') {
    const t = (tdata.tests || []).find((x) => x.name === sheet.test);
    if (!t) return;
    const allow = [],
      block = [];
    [...f.elements].forEach((el) => {
      if (!el.name || el.name.indexOf('p:') !== 0) return;
      const n = el.name.slice(2);
      if (el.value === 'allow') allow.push(n);
      if (el.value === 'block') block.push(n);
    });
    Object.assign(t, { who: v('who'), need: v('need'), allow, block });
    sheet = null;
    render();
    act('testAccess', { test: t.name, who: t.who, need: t.need, allow, block }).then((r) => {
      if (r) {
        toast('Saved');
        tAt = 0;
        loadTests();
      }
    });
    return;
  }
  if (kind === 'publish') {
    const notify = f.elements.namedItem('notify').checked ? '1' : '0';
    sheet = null;
    render();
    act('publish', { from: week, to: plus(week, 6), notify }).then((r) => {
      if (r && r.result)
        toast(
          'Published' +
            (notify === '1'
              ? ' · emailed ' +
                r.result.emailed +
                (r.result.noEmail.length ? ' · no email: ' + r.result.noEmail.map(first).join(', ') : '')
              : '')
        );
    });
    return;
  }
  if (kind === 'prep') {
    if (!v('item')) {
      toast('What needs prepping?');
      return;
    }
    const notify = f.elements.namedItem('notify').checked ? '1' : '0';
    (data.prep = data.prep || []).unshift({
      id: 'tmp' + Date.now(),
      item: v('item'),
      details: v('details'),
      label: 'Sending…',
      for: [],
      by: data.me.name,
      at: new Date().toISOString(),
      doneAt: '',
      recipe: (recipeFor('', v('item')) || {}).name || '',
      mine: false,
    });
    render();
    const rec = recipeFor('', v('item'));
    act('addPrep', {
      item: v('item'),
      details: v('details'),
      when: v('when'),
      notify,
      recipe: rec ? rec.name : '',
    }).then((r) => {
      if (r && r.result) {
        const x = r.result;
        toast(
          x.names.length
            ? 'Sent to ' + x.label + ' · ' + x.names.map(first).join(', ') + ''
            : 'Added – nobody is scheduled for that shift yet'
        );
      }
    });
    f.reset();
    return;
  }
  if (kind === 'punch') {
    const p = {
      id: (sheet && sheet.id) || '',
      name: v('name'),
      date: v('date'),
      in: v('in'),
      out: v('out'),
      note: v('note'),
    };
    if (f.elements.namedItem('type')) p.type = v('type');
    sheet = null;
    act('savePunch', p).then((r) => {
      if (r) toast('Saved');
    });
    return;
  }
  if (kind === 'reminders') {
    const mode = (f.querySelector('input[name=mode]:checked') || {}).value || '';
    const em = f.elements.namedItem('email') ? v('email') : data.me.email || '',
      push = data.reminders && data.reminders.by === 'push';
    const pick = (n) => (f.elements.namedItem(n) ? f.elements.namedItem(n).value : undefined);
    const night = pick('night'),
      morning = pick('morning'),
      before = Number(pick('before')) || 0;
    data.me.reminders = mode;
    data.me.remind = { night, morning, before };
    act('myReminders', { email: em, mode, night, morning, before }).then((r) => {
      if (r)
        toast(
          mode === 'Off'
            ? 'Reminders off'
            : push
              ? pushOn_()
                ? 'Saved'
                : 'Saved – turn on notifications to get them'
              : em
                ? 'Saved'
                : 'Saved – add an email to get them'
        );
    });
    return;
  }
  if (kind === 'reqedit') {
    const q = (data.requests || []).find((x) => x.id === sheet.id);
    if (!q) {
      sheet = null;
      render();
      return;
    }
    const until = q.type === 'Time off' && v('until') && v('until') !== v('date') ? v('until') : '';
    if (!v('date')) {
      toast('Pick a date');
      return;
    }
    if (until && until < v('date')) {
      toast('The last day is before the first day');
      return;
    }
    const again = q.status === 'Approved' && q.from === data.me.name && !mgr();
    Object.assign(q, { date: v('date'), until, details: v('details') });
    if (again) q.status = 'Pending';
    sheet = null;
    render();
    act('editRequest', { id: q.id, date: q.date, until, details: q.details }).then((r) => {
      if (r) toast(again ? 'Saved – sent to a manager to approve again' : 'Saved');
    });
    return;
  }
  if (kind === 'availedit') {
    const isNew = !sheet.id,
      a = isNew ? null : (data.availability || []).find((x) => x.id === sheet.id);
    if (!isNew && !a) {
      sheet = null;
      render();
      return;
    }
    const day = v('day') === 'date' ? v('date') : v('day');
    if (!day) {
      toast('Pick a date');
      return;
    }
    const part = v('span') === 'part',
      from = part ? v('from') : '',
      to = part ? v('to') : '';
    if (part && (!from || !to)) {
      toast(from ? 'Pick when it ends' : 'Pick when it starts and ends');
      return;
    }
    if (part && to <= from) {
      toast('The end time is before the start time');
      return;
    }
    sheet = null;
    if (isNew) {
      (data.availability = data.availability || []).push({
        id: 'tmp' + Date.now(),
        name: data.me.name,
        day,
        from,
        to,
        note: v('note'),
      });
      render();
      act('addAvail', { day, from, to, note: v('note') }).then((r) => {
        if (r) toast('Added');
      });
      return;
    }
    Object.assign(a, { day, from, to, note: v('note') });
    render();
    act('editAvail', { id: a.id, day, from, to, note: a.note }).then((r) => {
      if (r) toast('Saved');
    });
    return;
  }
  if (kind === 'avail') {
    const day = v('day') === 'date' ? v('date') : v('day');
    if (!day) {
      toast('Pick a date');
      return;
    }
    (data.availability = data.availability || []).push({
      id: 'tmp' + Date.now(),
      name: data.me.name,
      day,
      from: v('from'),
      to: v('to'),
      note: v('note'),
    });
    render();
    act('addAvail', { day, from: v('from'), to: v('to'), note: v('note') }).then((r) => {
      if (r) toast('Added');
    });
    f.reset();
    return;
  }
  if (kind === 'editchat') {
    const c = curChat();
    if (!c) {
      sheet = null;
      render();
      return;
    }
    if (!v('name')) {
      toast('Give it a name');
      return;
    }
    const p = { id: c.id, name: v('name') };
    if (c.kind === 'group') {
      const m = [...f.querySelectorAll('input[name=m]:checked')].map((x) => x.value);
      if (!m.length) {
        toast('Pick at least one other person');
        return;
      }
      p.members = m.concat(data.meId).join(',');
    } else p.who = v('who');
    c.name = p.name;
    if (p.who) c.who = p.who;
    sheet = null;
    render();
    if (LIVE) {
      LIVE.ask(Object.assign({ t: 'editch' }, p)).then(
        () => toast('Saved'),
        (e) => {
          toast(e.message);
          LIVE.send({ t: 'list' });
        }
      );
      return;
    }
    act('editChannel', p).then((r) => {
      if (r) {
        toast('Saved');
        if (chat.open === c.id) openChat(c.id);
      }
    });
    return;
  }
  if (kind === 'group') {
    const members = [...f.querySelectorAll('input[name=m]:checked')].map((x) => x.value).join(',');
    sheet = null;
    if (LIVE) {
      render();
      liveMake({ kind: 'group', name: v('name'), members }, 'Group made');
      return;
    }
    act('newChannel', { kind: 'group', name: v('name'), members }).then((r) => {
      if (r) toast('Group made');
    });
    return;
  }
  if (kind === 'channel') {
    sheet = null;
    if (LIVE) {
      render();
      liveMake({ kind: 'channel', name: v('name'), who: v('who') }, 'Channel made');
      return;
    }
    act('newChannel', { kind: 'channel', name: v('name'), who: v('who') }).then((r) => {
      if (r) toast('Channel made');
    });
    return;
  }
  if (kind === 'announce') {
    if (!v('title')) {
      toast('Add a title');
      return;
    }
    act('announce', {
      title: v('title'),
      message: f.elements.namedItem('message').value,
      pinned: v('pinned'),
      mustAck: v('mustAck'),
    }).then((r) => {
      if (r) toast('Posted');
    });
    f.reset();
    return;
  }
  if (kind === 'request') {
    const until = v('type') === 'Time off' && v('until') && v('until') !== v('date') ? v('until') : '';
    if (!v('date')) {
      toast('Pick a date');
      return;
    }
    if (until && until < v('date')) {
      toast('The last day is before the first day');
      return;
    }
    (data.requests = data.requests || []).unshift({
      id: 'tmp' + Date.now(),
      from: data.me.name,
      type: v('type'),
      date: v('date'),
      until,
      details: v('details'),
      status: mgr() && v('type') === 'Time off' ? 'Approved' : 'Pending',
      created: new Date().toISOString(),
    });
    render();
    act('request', { type: v('type'), date: v('date'), until, details: v('details'), shift: v('type') === 'Cover' ? v('shift') : '' }).then((r) => {
      if (r) toast(mgr() && v('type') === 'Time off' ? 'Time off approved' : 'Sent to managers');
    });
    f.reset();
    return;
  }
  if (kind === 'user') {
    if (!v('name')) {
      toast('Add a name');
      return;
    }
    const p = { name: v('name'), role: v('role'), phone: v('phone'), email: v('email'), wage: v('wage') };
    if (f.querySelector('.ctextra'))
      p.extra = [...f.querySelectorAll('input[name=extra]:checked')]
        .map((x) => x.value)
        .concat(v('extraother').split(','))
        .map((x) => x.trim())
        .filter(Boolean)
        .join(', ');
    if (f.dataset.id) {
      editUser = null;
      act('editUser', Object.assign({ id: f.dataset.id }, p)).then((r) => {
        if (r) toast('Saved');
      });
    } else {
      act('addUser', p).then((r) => {
        if (r) {
          justAdded = p.name;
          render();
          window.scrollTo(0, 0);
        }
      });
      f.reset();
    }
  }
});

/* drag ⠿ to reorder people (works with mouse and touch) */
let rowDrag = null;
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest && e.target.closest('[data-rowdrag]');
  if (!h || !mgr()) return;
  const row = h.closest('[data-rid]'),
    box = row && row.closest('[data-reorder]');
  if (!box) return;
  e.preventDefault();
  try {
    h.setPointerCapture(e.pointerId);
  } catch (_) {}
  rowDrag = { row, box, before: [...box.querySelectorAll(':scope > [data-rid]')].map((x) => x.dataset.rid).join(',') };
  row.classList.add('lifting');
});
document.addEventListener('pointermove', (e) => {
  if (!rowDrag) return;
  e.preventDefault();
  const { row, box } = rowDrag,
    y = e.clientY,
    sibs = [...box.querySelectorAll(':scope > [data-rid]')].filter((x) => x !== row);
  const next = sibs.find((x) => {
    const b = x.getBoundingClientRect();
    return y < b.top + b.height / 2;
  });
  if (next) {
    if (row.nextElementSibling !== next) box.insertBefore(row, next);
  } else {
    const last = sibs[sibs.length - 1];
    if (last && last.nextElementSibling !== row) last.after(row);
  }
});
const endRowDrag = () => {
  if (!rowDrag) return;
  const { row, box, before, later } = rowDrag;
  row.classList.remove('lifting');
  const ids = [...box.querySelectorAll(':scope > [data-rid]')].map((x) => x.dataset.rid);
  rowDrag = null;
  if (ids.join(',') !== before) {
    // Keep people not shown here (e.g. hidden ones off the grid) after the ones that were dragged.
    const all = lineup().map((u) => u.id),
      full = ids.concat(all.filter((id) => ids.indexOf(id) < 0));
    full.forEach((id, k) => {
      const u = (data.users || []).find((x) => x.id === id);
      if (u) u.order = k + 1;
    });
    render();
    act('scheduleOrder', { ids: full.join(',') });
  } else if (later) render();
};
document.addEventListener('pointerup', endRowDrag);
document.addEventListener('pointercancel', endRowDrag);

let dragId = '';
document.addEventListener('dragstart', (e) => {
  const c = e.target.closest && e.target.closest('[data-drag]');
  if (!c) return;
  dragId = c.dataset.drag;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', dragId);
  c.classList.add('dragging');
});
document.addEventListener('dragend', (e) => {
  dragId = '';
  document.querySelectorAll('.dragging,.drop').forEach((x) => x.classList.remove('dragging', 'drop'));
});
document.addEventListener('dragover', (e) => {
  const td = dragId && e.target.closest && e.target.closest('[data-cell]');
  if (!td) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
  document.querySelectorAll('.drop').forEach((x) => x !== td && x.classList.remove('drop'));
  td.classList.add('drop');
});
document.addEventListener('drop', (e) => {
  const td = dragId && e.target.closest && e.target.closest('[data-cell]');
  if (!td) return;
  e.preventDefault();
  const s = (data.shifts || []).find((x) => x.id === dragId);
  dragId = '';
  if (!s) return;
  const [name, date] = td.dataset.cell.split('|'),
    copy = e.altKey;
  if (!copy && name === s.name && date === s.date) return render();
  const p = { id: copy ? '' : s.id, name, date, start: s.start, end: s.end, position: s.position, notes: s.notes };
  if (copy) {
    p.cid = 'tmp' + Date.now() + Math.random().toString(36).slice(2, 5);
    data.shifts.push(Object.assign({}, s, { id: p.cid, name, date, status: 'draft' }));
  } else
    Object.assign(s, {
      name,
      date,
      status: s.status === 'draft' ? 'draft' : 'changed',
      was:
        s.was ||
        (s.status === 'published' || !s.status ? { date: s.date, start: s.start, end: s.end, name: s.name } : s.was),
    });
  render();
  act('saveShift', p).then((r) => {
    if (r)
      toast(
        copy ? 'Copied to ' + first(name) + ', ' + shortDay(date) : 'Moved to ' + first(name) + ', ' + shortDay(date)
      );
  });
});
WIDE.addEventListener &&
  WIDE.addEventListener('change', () => {
    if (data) render();
  });
const typing = () => {
  const a = document.activeElement;
  return (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) || !!runner;
};
document.addEventListener('visibilitychange', () => {
  if (LIVE && chat.open && tab === 'chat' && document.hidden) LIVE.send({ t: 'close' });
  if (document.hidden || !TOKEN) return;
  unstick();
  if (chat.open && tab === 'chat') openChat(chat.open);
  else if (!pending && !typing() && !sheet) refresh();
});
setInterval(() => {
  if (!document.hidden && TOKEN && !pending && !typing() && !sheet && !viewer && !chat.open) refresh();
}, 90000);
window.addEventListener('online', () => {
  unstick();
  if (TOKEN) refresh();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted && TOKEN) {
    unstick();
    refresh();
  }
}); // reopened from the phone's app switcher
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  if (!TOKEN) render();
});
if ('serviceWorker' in navigator && location.protocol === 'https:')
  navigator.serviceWorker.register(window.PT_SW || 'sw.js').catch(() => {});

if (theme() !== 'auto') setTheme(theme());
let pendingGo = new URLSearchParams(location.search).get('go') || '';
if (pendingGo) history.replaceState(null, '', location.pathname);
if ('serviceWorker' in navigator)
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.go !== undefined) goTo(e.data.go);
  });
if (invite && TOKEN) {
  invite = null;
  history.replaceState(null, '', location.pathname + location.search);
  setTimeout(() => toast('That invite link is for someone new – sign out first to use it on this phone'), 600);
} else if (invite) loadInvite();
render();
if (TOKEN) refresh();

/* The logo at the top goes home (Today, or the shop iPad's home screen). The location switcher next to it keeps working. */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#top .brand');
  if (!b || e.target.closest('.locbtn') || !TOKEN || !data) return;
  if (shop()) return kioskHome();
  sheet = null;
  viewer = null;
  editUser = null;
  moreView = '';
  stopChat();
  tab = 'today';
  save('pt-tab', tab);
  window.scrollTo(0, 0);
  render();
});
(() => {
  const b = document.querySelector('#top .brand');
  if (b) {
    b.title = 'Home';
    b.style.cursor = 'pointer';
  }
})();
