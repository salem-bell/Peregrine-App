// Peregrine – Westcliffe. Same app as Richardson (the files one folder up), its own Google Sheet and its own team.
// The Westcliffe sheet's Apps Script web app (Deploy › Manage deployments › Web app URL, ends in /exec):
window.PEREGRINE_API = '';
window.PT_NAME = 'Peregrine Westcliffe';   // shown before the first load
window.PT_NS = 'wc-';                      // everything this phone keeps for Westcliffe is named wc-…, apart from Richardson's
window.PT_SW = 'westcliffe/sw.js';         // its own service worker, so its installed app opens Westcliffe
window.PT_SPACE = 'westcliffe';            // its space on the Cloudflare chat and fast-loading services
