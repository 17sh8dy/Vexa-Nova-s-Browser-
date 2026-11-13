'use strict';
// Vexa Search HTTP server (node:http, no framework).
//   GET /               home
//   GET /search?q=      results page (page=N)
//   GET /api/search?q=  JSON results
//   GET /api/suggest?q= autocomplete (format=opensearch for browser format)
//   GET /api/stats      index stats
//   GET /about, /bot    info pages;  /opensearch.xml;  /static/*

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const views = require('./views');
const { Searcher } = require('../indexer/search');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function createServer(db, { pageSize = 10 } = {}) {
  const searcher = new Searcher(db);
  const staticCache = new Map();

  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, {
      'content-type': type,
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      ...extra
    });
    res.end(body);
  };
  const html = (res, status, body) => send(res, status, 'text/html; charset=utf-8', body);
  const json = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));

  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed', { allow: 'GET, HEAD' });
      const url = new URL(req.url, 'http://localhost');
      const q = (url.searchParams.get('q') || '').slice(0, 256);
      const page = Math.min(50, Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1));

      // Pick up a rebuilt index without restarting.
      if (searcher.indexedAt !== Number(db.prepare("SELECT value FROM meta WHERE key = 'indexed_at'").get()?.value || 0)) searcher.refreshStats();

      switch (url.pathname) {
        case '/':
          return html(res, 200, views.homePage(searcher.stats()));
        case '/search': {
          if (!q.trim()) { res.writeHead(302, { location: '/' }); return res.end(); }
          const r = searcher.search(q, { page, pageSize });
          return html(res, 200, views.resultsPage(q, r, searcher.stats()));
        }
        case '/api/search': {
          const r = searcher.search(q, { page, pageSize });
          r.results = r.results.map((x) => ({ ...x, snippet: x.snippet.map((s) => s.text).join('') }));
          return json(res, 200, r);
        }
        case '/api/suggest': {
          const list = searcher.suggest(q);
          return json(res, 200, url.searchParams.get('format') === 'opensearch' ? [q, list] : { query: q, suggestions: list });
        }
        case '/api/stats':
          return json(res, 200, searcher.stats());
        case '/about':
          return html(res, 200, views.aboutPage(searcher.stats()));
        case '/bot':
          return html(res, 200, views.botPage());
        case '/opensearch.xml': {
          const origin = `http://${req.headers.host || 'localhost'}`;
          return send(res, 200, 'application/opensearchdescription+xml; charset=utf-8', views.opensearch(origin));
        }
        default:
          if (url.pathname.startsWith('/static/')) {
            const name = path.basename(url.pathname);
            const file = path.join(PUBLIC, name);
            const type = TYPES[path.extname(name)];
            if (type && fs.existsSync(file)) {
              if (!staticCache.has(name)) staticCache.set(name, fs.readFileSync(file));
              return send(res, 200, type, staticCache.get(name), { 'cache-control': 'public, max-age=300' });
            }
          }
          return html(res, 404, views.errorPage(404, 'That page does not exist.'));
      }
    } catch (e) {
      console.error(e);
      if (!res.headersSent) html(res, 500, views.errorPage(500, 'Something went wrong on our side.'));
      else res.end();
    }
  });
  return server;
}

module.exports = { createServer };
