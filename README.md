# Peregrine Team app

A phone app for the Peregrine Coffee Roasters team: checklists, schedule, announcements, time-off and swap requests, and team management for managers. It installs to the home screen and opens full screen like a normal app.

- **App (what staff open):** https://salem-bell.github.io/Peregrine-App/
- **Data:** a Google Sheet ("Peregrine Team"). Nothing about the team is stored in this repository.
- **Server:** `backend/Code.gs`, a Google Apps Script bound to that Sheet. The app talks to it over HTTPS.

## Locations
- **Richardson** – https://salem-bell.github.io/Peregrine-App/ (sheet "Peregrine Team").
- **Westcliffe** – https://salem-bell.github.io/Peregrine-App/westcliffe/ (sheet "Peregrine Westcliffe Team"). Same app files; `westcliffe/` holds only its own config.js (its sheet's web app address), manifest and service worker. Phones keep each location's sign-in and data apart (names start with `wc-`), so someone can be on both. Settings › *Location key* (`peregrine` / `westcliffe`) keeps them apart on the Cloudflare chat and fast-loading services.
- Every app update reaches both. A new Code.gs goes into **both** sheets.

## Roles

| | Staff | Lead | Manager |
|---|---|---|---|
| Checklists: tick tasks | ✓ | ✓ | ✓ |
| Checklists: untick someone else's, see the last 7 days | | ✓ | ✓ |
| Announcements: read, "Got it" | ✓ | ✓ | ✓ |
| Announcements: post, see who hasn't read | | ✓ | ✓ |
| Schedule: see it, request time off / swap / cover | ✓ | ✓ | ✓ |
| Schedule: add and remove shifts, approve requests | | | ✓ |
| Team: add people, change roles, new codes, turn people off | | | ✓ |

## Sign-in

Everyone uses the same app address. Each person signs in with their **first name + their own 4-digit code**. A phone asks again every 60 days (Settings › *Ask for the code again every*).

- 5 wrong codes lock that name for 15 minutes; 25 wrong codes in an hour pause sign-in for everyone for an hour.
- A new code, or turning someone off, signs them out on every phone right away.
- The last manager can't be turned off or demoted.

## Setup (once)

1. **Sheet:** open the "Peregrine Team" Google Sheet › Extensions › Apps Script. Replace `Code.gs` with `backend/Code.gs`. Save.
2. Reload the Sheet › menu **Team › 1. Set up** › approve.
3. **Deploy › New deployment › Web app** – Execute as: *Me*, Who has access: *Anyone* › Deploy. Copy the Web app URL (ends in `/exec`).
4. Put that URL in `config.js` here (`window.PEREGRINE_API = '…/exec';`) and in the Sheet's Settings › *Server address*.
5. **GitHub Pages:** repo Settings › Pages › Source: *Deploy from a branch* › Branch: `main`, folder `/ (root)` › Save.
6. **Team › 2. Show sign-in codes** in the Sheet – send the app address to the team and each person their own code.

**Updating the server later:** paste the new `Code.gs`, then Deploy › Manage deployments › pencil › Version: *New version* › Deploy (the URL stays the same).
**Fast loading (optional):** `data-service/` is a Cloudflare Worker (`team-data`) that keeps a ready-made copy of each person's data so the app loads in well under a second. The Sheet pushes to it every minute when something changed (Team › *Fast loading: turn on / check* starts that). Saves still go to the Sheet. If the Worker is down or behind, the app loads from the Sheet as before. Deploy with `cd data-service && npx wrangler deploy`, then `npx wrangler secret put DATA_SECRET_PEREGRINE` (same value as Settings › *Data service secret*).
**Updating the app:** change files here and bump `VERSION` in `sw.js` so phones pick it up.

## Putting it on a phone

- **iPhone (Safari):** open the app address › Share ⬆︎ › *Add to Home Screen*. Open it from the home screen, then sign in.
- **Android (Chrome):** open the address › *Install app* (or ⋮ › *Add to Home screen*).
