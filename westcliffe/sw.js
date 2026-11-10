// Westcliffe's service worker: the shared one (../sw.js) with its own cache names and file list.
self.PT_NS = 'wc-';
self.PT_ROOT = '../';
self.PT_SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', '../app.css', '../app.js', '../icons/icon-192.png', '../icons/icon-512.png', '../icons/apple-touch-icon.png', '../brand/bird-gold.png', '../brand/falcon.png', '../brand/branch.png'];
importScripts('../sw.js');
