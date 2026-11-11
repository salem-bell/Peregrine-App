// The shop's locations. Each is its own Google Sheet and team; managers can switch between them inside one app
// (tap the shop name at the top). Each location keeps its own sign-in on the phone, so switching never signs you out.
// Loaded after the page's own config.js (which says which location this address is: PT_HOME) and before app.js.
window.PT_LOCATIONS = [
  { key: 'richardson', name: 'Richardson', api: 'https://script.google.com/macros/s/AKfycbz5Dy_OZRdEPfPWR72e268ZviaBpBJLKvAVTaQGXc41fC7Y_wlgQOhRrIcqyDWYHEaw/exec',
    ns: '', space: 'peregrine', url: 'https://salem-bell.github.io/Peregrine-App/' },
  { key: 'westcliffe', name: 'Westcliffe', api: 'https://script.google.com/macros/s/AKfycbzquvYZLp2-oRIXMbMFxbCbuSLqeEixgEzf7jAKgA0SyJvFX34nSKwBtPtkQ7hk7K3vPQ/exec',
    ns: 'wc-', space: 'westcliffe', url: 'https://salem-bell.github.io/Peregrine-App/westcliffe/' }
];
(function () {
  var home = window.PT_HOME || 'richardson', pick = null;
  try { pick = localStorage.getItem('pt-loc@' + home); } catch (e) {}
  var L = window.PT_LOCATIONS.filter(function (l) { return l.key === (pick || home); })[0] || window.PT_LOCATIONS.filter(function (l) { return l.key === home; })[0];
  if (!L) return;
  window.PT_LOC = L.key;
  window.PT_APPURL = L.url;                         // invite links always point at that location's own address
  if (L.key === home) return;                       // this address's own location: its config.js already set everything
  window.PEREGRINE_API = L.api; window.PT_NS = L.ns; window.PT_SPACE = L.space; window.PT_NAME = 'Peregrine ' + L.name;
})();
