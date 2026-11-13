'use strict';
// Vexa Search (beta) inside the browser: Nova's own search engine, served at
// vexa://search/. The engine code comes from "Vexa Search/" and the index is a
// read-only database shipped with the app, so searching works offline and
// nothing the user searches for leaves their computer.
//
// The results page shows text from the open web, so it is NOT a privileged
// internal page: the preload and the vexa:api IPC both refuse vexa://search.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'Vexa Search');
const INDEX_NAME = 'vexa-search-index.db';

function indexPath() {
  const candidates = [
    // Packaged app: shipped as an extra resource (SQLite needs a real file, not asar).
    path.join(process.resourcesPath || '', 'vexa-search', INDEX_NAME),
    // Development: the exported index next to the engine.
    path.join(ENGINE_DIR, 'dist', INDEX_NAME)
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

let handler = null;
let failure = null;

function load() {
  if (handler || failure) return;
  try {
    const file = indexPath();
    if (!file) throw new Error('The Vexa Search index is missing from this install.');
    const { openIndexReadOnly } = require(path.join(ENGINE_DIR, 'store', 'db'));
    const { createHandler } = require(path.join(ENGINE_DIR, 'server', 'server'));
    handler = createHandler(openIndexReadOnly(file), { watchIndex: false });
  } catch (e) {
    failure = e;
    console.error('[vexa-search]', e);
  }
}

function errorPage(message) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>Vexa Search</title><body style="font-family:system-ui;padding:40px;max-width:640px">
<h1 style="font-size:22px">Vexa Search isn't available</h1><p>${esc(message)}</p>
<p>You can switch to another search engine in <b>Settings &rsaquo; Search</b>.</p>`;
}

/** Handle a vexa://search/... request. Returns a fetch Response. */
function handleRequest(requestUrl) {
  load();
  if (!handler) {
    return new Response(errorPage(failure ? failure.message : 'Unknown error.'), {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }
    });
  }
  const url = new URL(requestUrl);
  const r = handler(new URL(url.pathname + url.search, 'http://vexa-search'), { origin: 'vexa://search' });
  const headers = { ...r.headers };
  if (headers.location) headers.location = 'vexa://search' + headers.location;
  return new Response(r.status === 302 || r.status === 204 ? null : r.body, { status: r.status, headers });
}

app.on('will-quit', () => { handler = null; });

module.exports = { handleRequest, indexPath };
