'use strict';
// Vexa Search request handling. One handler, two front doors:
//   - createServer(): a node:http server (standalone / development)
//   - createHandler(): used directly by the Vexa browser for vexa://search/
// Routes:
//   GET /?q= or /search?q=  results page (page=N);  / without q = home
//   GET /api/search?q=      JSON results
//   GET /api/suggest?q=     autocomplete (format=opensearch for browser format)
//   GET /api/stats          index stats
//   GET /about, /bot        info pages;  /opensearch.xml;  /static/*

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const views = require('./views');
const { Searcher } = require('../indexer/search');

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const BASE_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
};

/**
 * @returns {(url: string|URL, opts?: { origin?: string }) => { status: number, headers: object, body: string|Buffer }}
 */
function createHandler(db, { pageSize = 10, watchIndex = true } = {}) {
  const searcher = new Searcher(db);
  const staticCache = new Map();
  const reply = (status, type, body, extra = {}) => ({ status, headers: { ...BASE_HEADERS, 'content-type': type, ...extra }, body });
  const html = (status, body) => reply(status, 'text/html; charset=utf-8', body);
  const json = (status, obj) => reply(status, 'application/json; charset=utf-8', JSON.stringify(obj));

  return function handle(input, { origin = 'http://localhost' } = {}) {
    try {
      const url = input instanceof URL ? input : new URL(input, 'http://localhost');
      const q = (url.searchParams.get('q') || '').slice(0, 256);
      const page = Math.min(50, Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1));

      // Pick up a rebuilt index without restarting (crawl database only).
      if (watchIndex && searcher.indexedAt !== Number(db.prepare("SELECT value FROM meta WHERE key = 'indexed_at'").get()?.value || 0)) searcher.refreshStats();

      let route = url.pathname || '/';
      if (route === '/' && q.trim()) route = '/search';
      switch (route) {
        case '/':
          return html(200, views.homePage(searcher.stats()));
        case '/search': {
          if (!q.trim()) return reply(302, 'text/plain', '', { location: '/' });
          const r = searcher.search(q, { page, pageSize });
          return html(200, views.resultsPage(q, r, searcher.stats()));
        }
        case '/api/search': {
          const r = searcher.search(q, { page, pageSize });
          r.results = r.results.map((x) => ({ ...x, snippet: x.snippet.map((s) => s.text).join('') }));
          return json(200, r);
        }
        case '/api/suggest': {
          const list = searcher.suggest(q);
          return json(200, url.searchParams.get('format') === 'opensearch' ? [q, list] : { query: q, suggestions: list });
        }
        case '/api/stats':
          return json(200, searcher.stats());
        case '/about':
          return html(200, views.aboutPage(searcher.stats()));
        case '/bot':
          return html(200, views.botPage());
        case '/opensearch.xml':
          return reply(200, 'application/opensearchdescription+xml; charset=utf-8', views.opensearch(origin));
        default:
          if (route.startsWith('/static/')) {
            const name = path.basename(route);
            const file = path.join(PUBLIC, name);
            const type = TYPES[path.extname(name)];
            if (type && fs.existsSync(file)) {
              if (!staticCache.has(name)) staticCache.set(name, fs.readFileSync(file));
              return reply(200, type, staticCache.get(name), { 'cache-control': 'public, max-age=300' });
            }
          }
          return html(404, views.errorPage(404, 'That page does not exist.'));
      }
    } catch (e) {
      console.error(e);
      return html(500, views.errorPage(500, 'Something went wrong on our side.'));
    }
  };
}

function createServer(db, options = {}) {
  const handle = createHandler(db, options);
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, 'content-type': 'text/plain', allow: 'GET, HEAD' });
      return res.end('Method not allowed');
    }
    const r = handle(req.url, { origin: `http://${req.headers.host || 'localhost'}` });
    res.writeHead(r.status, r.headers);
    res.end(req.method === 'HEAD' ? undefined : r.body);
  });
}

module.exports = { createServer, createHandler, CSP };
