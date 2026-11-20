# Peregrine Team – developer guide

The staff app for Peregrine Coffee Roasters (Richardson and Westcliffe). This guide is for a developer picking it up:
what each piece is, how a tap travels to the data and back, where each feature lives, and how to ship a change
without breaking the shops. The [README](README.md) covers setup from scratch and roles.

Everything is plain JavaScript. No framework, no build step, no bundler: the files in this repo are exactly what
phones load.

---

## 1. The pieces

```
 Phone (installed web app)                        Google                         Cloudflare
 ─────────────────────────                        ──────                         ──────────
 index.html + app.js + app.css   ── saves ──▶   Apps Script (backend/Code.gs)   ◀── pushes data ──▶  team-data   (fast loads)
 served by GitHub Pages          ◀─ state ──    bound to the location's Sheet   ── posts ──▶        push worker (notifications)
                                 ── loads ──────────────────────────────────────────────────────▶  team-data
                                 ── live chat (WebSocket) ──────────────────────────────────────▶  team-chat   (Messages)
                                                                                                    peregrine-mcp (Claude connector)
```

| Piece | Where | What it does |
|---|---|---|
| **App** | `index.html`, `app.js`, `app.css`, `config.js`, `locations.js`, `sw.js`, `manifest.webmanifest` | Everything staff see. GitHub Pages serves the repo root. |
| **Westcliffe** | `westcliffe/` | Only its own `config.js`, `manifest`, `index.html`, `sw.js`. It loads the shared files from `../`. |
| **Server** | `backend/Code.gs` | Google Apps Script bound to each location's Google Sheet, deployed as a Web app (`/exec`). All data lives in the Sheet. The **same file** goes into both sheets. |
| **Live chat** | `chat-service/` → Worker `team-chat` | Messages, read receipts, photos, PDFs. One Durable Object (SQLite) per "space": `peregrine`, `westcliffe`, `family`. |
| **Fast loading** | `data-service/` → Worker `team-data` | Holds a ready-made copy of each person's app data, pushed by the Sheet every minute after changes. Saves still go to the Sheet. |
| **Push** | `push-worker/worker.js` | Sends Web Push notifications (Apps Script can't do the encryption). Its three secret values are pasted in at deploy time; the repo copy has placeholders. |
| **Claude connector** | `mcp-service/` → Worker `peregrine-mcp` | Lets the owner read and send Messages through Claude. Binds `team-chat`'s Durable Object class, so deploy `team-chat` first. |
| **Sales relay** | `sales-relay/Relay.gs` | A second Apps Script file in the Richardson sheet that imports the POS's daily sales email. |

> ⚠️ `team-chat` and `team-data` also serve a separate app, **Bellah Family HQ** (`salem-bell/family-app`, space `family`).
> Any change to those Workers must keep the `family` space working.

Live addresses: app https://salem-bell.github.io/Peregrine-App/ (Westcliffe: `/westcliffe/`); each sheet's `/exec`
address is in `config.js` / `westcliffe/config.js` / `locations.js`.

---

## 2. How a tap becomes saved data

1. **Render.** `render()` (app.js) rebuilds the screen as an HTML string from the global `data` object and the UI state
   (`tab`, `moreView`, `sheet` for pop-ups, `chat`, …) and puts it in `#main` / `#overlay`. Each screen is a `viewXxx()`
   function returning HTML. Everything goes through `esc()`; never put unescaped user text into the HTML.
2. **Events.** There are no per-element listeners. A few `document.addEventListener('click' | 'submit' | 'input' | 'change')`
   handlers near the bottom of app.js read `data-*` attributes (e.g. `data-traincheck="Hot tea"`) and `data-form="…"`
   on forms. To add a button, give it a new `data-something` attribute and add an `if (d.something …)` branch.
3. **Save.** Handlers update `data` straight away (so the screen changes at once) and call `act('action', {params})`.
   `act` queues changes for ~120 ms and sends them as one batch: `post({ fn: 'api', token, p: { actions: [...] } })`.
   All values travel as strings (`'1'`/`'0'` for booleans, dates `YYYY-MM-DD`, times `HH:MM`).
4. **Server.** `doPost` → `api_()` takes the script lock, runs each action through `act_()` (one big `switch` on the
   action name: `addShift`, `decide`, `trainCheck`, …), marks the touched tabs dirty, then returns fresh state from
   `state_()`. Permissions are checked **in `act_`/`state_`**, never only in the app: managers see wages, leads see
   training, etc.
5. **State.** `state_()` builds the person's data in named **sections** (`SECTIONS_`: `lists`, `news`, `sched`, `chat`,
   `train`, …), each with a version made from the tabs it reads (`gen_`) plus a 15-minute time bucket. The app sends the
   versions it has (`have`), and unchanged sections are skipped. The app merges what comes back, saves it to
   `localStorage` (`pt-cache`) and re-renders.
6. **Loads** (not saves) try `team-data` first (`edgeLoad()`); if it's missing, stale or down, the app silently asks the
   Sheet.

Reads in Code.gs go through `rv_()` (cached whole-tab reads, 10 minutes, cleared by `dirty_()` on app edits and by the
`onEdit` trigger on hand edits). `vals_()` reads a sheet directly.

**Chat** is different: when Settings › *Chat service address* is set, messages never touch the Sheet. The app holds a
WebSocket to `team-chat` (`LiveChat()` in app.js). The Sheet only issues signed tickets (`chatTicket_`), syncs the
roster (`chatSyncRoster_`) and relays push notifications (`chatPush_`). The old Messages tab is the fallback when no
chat service is set.

---

## 3. Where things live

### app.js (one file, in this order)
| Section (search for the comment) | Contains |
|---|---|
| `server` | `LiveChat`, `post`, `act`, `flush`, `refresh`, `edgeLoad` |
| `formatting` · `schedule logic` · `wage estimates` · `time sheet logic` | Pure helpers |
| `locations` · `invite links` | Switching shops; joining by invite link |
| `screens` | `viewSignIn`, `viewToday`, checklists, inventory, prep, `viewLists` |
| `schedule` | `viewMyShifts` (list/calendar), `viewSchedule`, `viewScheduleBuild`, `viewScheduleGrid` |
| `availability` · `time sheet` | `viewAvail`, `viewTime` |
| `chat` · `live chat` · `chat photos` · `chat PDFs` | `viewChat`, `viewConversation`, drafts, links, multi-select delete |
| `push notifications` · `reminders` | `viewPush`, `viewReminders` |
| `announcements` · `requests` · `resources` · `training` · `tests` · `team` | One screen each |
| `recipes` | The recipe book: `viewRecipes` (menu), `viewRecipe` (one recipe card), batch scaler, manager costs (`loadRecCost`) |
| `render()` | Top-level draw, form-preserving redraws |
| `events` | All the click / submit / input handlers |

### backend/Code.gs
| Look for | Contains |
|---|---|
| `TABS`, `SETTINGS` (top) | Every sheet tab with its columns, and every setting with its default and explanation. Change the sheet's shape here. |
| `setup`, `buildTab_`, `examples_` | Team › Set up menu; creates missing tabs |
| `doPost`, `api_`, `signIn_`, `who_` | Entry points and sign-in (codes are checked only by the sheet, which hands out signed tokens) |
| `state_`, `SECTIONS_` | What each person gets back |
| `act_` | Every change the app can make |
| `channels_`, `chat_`, `chat*_` | Chat (sheet fallback + live chat glue) |
| `recipes_`, `recipeCosts_`, `saveRecipe`/`showRecipe`/`delRecipe` (in `act_`) | Recipes tab → the recipe book (managers edit it in the app too); managers' costs read from the Menu and Prep COGS sheets (Settings) |
| `training_`, `level1Results_`, `trainDoc_` | Trainee checklists; filing them as Google Docs |
| `tests_`, `testTeam_`, `testSees_` | Certification tests (results come from a separate results sheet) |
| `sendShiftReminders`, `clockTick_`, `payrollTick_`, `pushDataTick` | Timed triggers (every 15 min / every minute) |
| `push_`, `pushPrefs_` | Who gets which notification |
| `rv_`, `dirty_`, `gen_`, `cachePut_` | Caching |
| `pushData_`, `setupFastLoading` | Fast-loading copy to `team-data` |
| `payroll*_` | Payroll timesheet tab and the payroll template copy |

Settings marked secret (push/chat/data service secrets) live in **Script properties**, not in the sheet cell
(`secret_`, `moveSecrets_`).

---

## 4. Shipping a change

### App files (app.js, app.css, index.html…)
1. Edit, then `node --check app.js`.
2. Try it in a browser. Opening `index.html` from disk works for layout; for data, stub `post()` or point at a sheet.
   Check phone width (390 px) and desktop (≥1000 px has a sidebar layout).
3. **Bump `VERSION` in `sw.js`** (e.g. `pt-3.5.21` → `pt-3.5.22`). Phones only pick up new files when it changes.
   Westcliffe's service worker imports `../sw.js`, so one bump covers both.
4. If you add a new file the app needs offline, add it to `SHELL` in `sw.js` **and** `PT_SHELL` in `westcliffe/sw.js`
   (with `../` in front).
5. Push to `main`. GitHub Pages is live in about a minute; phones update on their next open (closing and reopening the
   app twice forces it).

### Server (Code.gs)
1. Bump `VERSION` at the top of Code.gs.
2. Paste into **both** sheets (Extensions › Apps Script), then Deploy › Manage deployments › Edit › **New version**.
   The `/exec` address stays the same. Forgetting "New version" means the old code keeps running.
3. If the app depends on the new server code, gate it: `if (Number(data.version) >= 4.99) …`, so phones talking to a
   sheet that hasn't been updated yet don't break.
4. Apps Script limits to keep in mind: about 6 minutes per run, a single script lock per sheet (saves queue behind
   each other), and daily quotas for email and URL fetches.

### Workers (chat-service, data-service, mcp-service)
```
cd chat-service && npm install && npx wrangler deploy        # needs CLOUDFLARE_API_TOKEN or `wrangler login`
```
- Run the tests first. `chat-service`: start `npx wrangler dev --port 8799 --local --var SECRET_FAMILY:test-family-secret`,
  then `node test/live.test.mjs`. `mcp-service`: instructions at the top of `test/local.test.mjs`.
- Database changes in a Durable Object must upgrade existing data in place (see the `ALTER TABLE … ADD COLUMN file` check in
  `chat-service` for the pattern). Never drop or rename columns.
- Each space's secret must match that sheet's Settings value (`SECRET_PEREGRINE` ↔ *Chat service secret*, etc.).
  Set them with `npx wrangler secret put NAME`; never commit them.
- Signing between Apps Script and the Workers (HMAC-SHA256 over the exact same bytes) must stay byte-identical on both
  sides; a mismatch silently breaks every connection.

### Formatting
The code is formatted with [Prettier](https://prettier.io) (`.prettierrc.json`: 120 columns, single quotes; `.gs` files
use the JavaScript parser). Format before committing:
```
npx prettier --write app.js app.css backend/Code.gs chat-service/src data-service/src mcp-service/src push-worker sw.js
```
Long HTML strings inside template literals are left as they are by Prettier.

---

## 5. Gotchas

- **Two locations, one codebase.** A front-end change reaches both shops at once; a server change reaches only the
  sheets you paste it into. Phone storage is namespaced per location (`NS`, e.g. `wc-pt-token`).
- **Never trust the app for permissions.** The role check that matters is in Code.gs. Wages and sign-in codes must never
  be sent to staff phones.
- **Redraws.** `render()` replaces the whole screen. Half-filled forms survive because of `snapForms`/`restoreForms` and the
  `DIRTY_FORMS` set; a new form needs a stable `data-form` name to benefit.
- **Saves are optimistic.** The screen changes before the server confirms. If an action fails, the next refresh brings
  the real data back; show the error with `toast()`.
- **IDs.** New rows get IDs from `nextId_()`, which remembers the highest ID ever issued (Script properties), so a deleted
  row's ID is never reused.
- **Hand edits.** Managers edit the sheets by hand too. Code must tolerate blank rows, extra columns and odd values
  (`truthy_`, `ymd_`, `hhmm_` exist for this).
- **Secrets.** Nothing secret is in this repo. Keep it that way (the Worker secrets, the push keys, any Cloudflare token).
