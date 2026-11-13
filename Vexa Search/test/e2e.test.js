'use strict';
// End to end: VexaBot crawls a real local website over HTTP, the indexer
// builds the index, and searches run through the engine and the web server.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startSite } = require('./fixtures/site');
const { openDb } = require('../store/db');
const { Crawler } = require('../crawler/crawler');
const { buildIndex } = require('../indexer/indexer');
const { Searcher } = require('../indexer/search');
const { createServer } = require('../server/server');

test('crawl -> index -> search -> serve', async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const db = openDb(':memory:');
  const events = [];
  const crawler = new Crawler(db, { allowPrivateHosts: true, minHostDelayMs: 0, concurrency: 2, onEvent: (e) => events.push(e) });
  crawler.addSeeds([{ url: site.origin + '/', priority: 10, category: 'test' }]);
  await crawler.run({ maxPages: 100 });

  const state = (p) => db.prepare('SELECT state, reason FROM urls WHERE url = ?').get(site.origin + p);
  const paths = site.hits.map((h) => h.path);

  await t.test('obeys robots.txt and identifies as VexaBot', () => {
    assert.ok(site.hits.every((h) => /VexaBot\/\d/.test(h.ua)));
    assert.ok(!paths.includes('/private/secret'));
    assert.ok(!paths.includes('/bot-only-block'));
    assert.equal(state('/private/secret').state, 'disallowed');
    assert.equal(state('/bot-only-block').state, 'disallowed');
  });

  await t.test('respects nofollow, skips files, strips tracking params', () => {
    assert.ok(!paths.includes('/nofollowed'));
    assert.ok(!paths.includes('/file.pdf'));
    assert.ok(paths.includes('/variant'));
    assert.ok(!paths.some((p) => p.includes('utm_source')));
  });

  await t.test('follows redirects, noindex pages, sitemaps and canonicals', () => {
    assert.match(state('/old').reason, /redirect/);
    assert.equal(state('/space-moved').state, 'done');
    assert.equal(state('/hidden').reason, 'noindex');
    assert.equal(state('/from-hidden').state, 'done');
    assert.equal(state('/from-sitemap').state, 'done');
    assert.match(state('/variant').reason, /canonical/);
    assert.equal(state('/canonical-target').state, 'done');
  });

  await t.test('content policy and duplicate detection', () => {
    assert.equal(state('/adult').state, 'blocked');
    assert.match(state('/adult').reason, /RTA/);
    const dupe = [state('/dup'), state('/space')];
    assert.equal(dupe.filter((s) => s.state === 'skipped' && /duplicate/.test(s.reason)).length, 1);
  });

  const info = buildIndex(db);
  const s = new Searcher(db);

  await t.test('index built', () => {
    assert.ok(info.documents >= 8, `documents ${info.documents}`);
    assert.ok(info.terms > 50);
  });

  await t.test('ranking: title match wins; stemming works', () => {
    const r = s.search('rust programming');
    assert.equal(new URL(r.results[0].url).pathname, '/rust');
    const r2 = s.search('borrowed ownership'); // borrowing/ownership via stems
    assert.equal(new URL(r2.results[0].url).pathname, '/rust');
    assert.ok(r2.results[0].snippet.some((x) => x.hit));
  });

  await t.test('noindex and blocked pages never appear', () => {
    assert.equal(s.search('unicorn marmalade').total, 0);
    assert.equal(s.search('age restricted').total, 0);
    assert.equal(s.search('never fetched').total, 0);
  });

  await t.test('phrases, exclusion, site:, OR fallback', () => {
    const p = s.search('"space station"');
    assert.ok(p.total >= 1);
    assert.equal(s.search('"station space"').total, 0);
    const all = s.search('rust').results.map((r) => new URL(r.url).pathname);
    assert.ok(all.includes('/games'));
    const ex = s.search('rust -cargo').results.map((r) => new URL(r.url).pathname);
    assert.ok(ex.includes('/games') && !ex.includes('/rust'));
    assert.ok(s.search('rust site:127.0.0.1').total >= 1);
    assert.equal(s.search('rust site:example.com').total, 0);
    const or = s.search('telescope zebra');
    assert.equal(or.mode, 'or');
    assert.ok(or.total >= 1);
  });

  await t.test('did you mean and autocomplete', () => {
    const r = s.search('telescpe');
    assert.equal(r.total, 0);
    assert.equal(r.suggestion, 'telescope');
    assert.ok(s.suggest('spa').includes('space'));
  });

  await t.test('http server: pages, JSON API, escaping, headers', async () => {
    const server = createServer(db);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
    const homeHtml = await home.text();
    assert.match(homeHtml, /BETA/);

    const serp = await (await fetch(base + '/search?q=' + encodeURIComponent('rust <script>alert(1)</script>'))).text();
    assert.ok(!serp.includes('<script>alert(1)</script>'));
    assert.match(serp, /&lt;script&gt;/);
    assert.match(serp, /Rust Programming Language Guide/);

    const api = await (await fetch(base + '/api/search?q=space')).json();
    assert.ok(api.total >= 1 && typeof api.results[0].snippet === 'string');
    const sug = await (await fetch(base + '/api/suggest?q=gam&format=opensearch')).json();
    assert.equal(sug[0], 'gam');
    assert.ok(sug[1].includes('games'));
    assert.equal((await fetch(base + '/nope')).status, 404);
    assert.equal((await fetch(base + '/static/../server.js')).status, 404);
    assert.equal((await fetch(base + '/bot')).status, 200);
    assert.equal((await fetch(base + '/static/style.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  });

  db.close();
});

test('crawler refuses private hosts by default', async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const db = openDb(':memory:');
  const crawler = new Crawler(db, { minHostDelayMs: 0 });
  crawler.addSeeds([{ url: site.origin + '/' }]);
  await crawler.run({ maxPages: 5 });
  assert.equal(site.hits.length, 0);
  const row = db.prepare('SELECT state, reason FROM urls').get();
  assert.equal(row.state, 'failed');
  assert.match(row.reason, /private/);
  db.close();
});

test('site page cap: stops cleanly, keeps the queue, a higher cap resumes', async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const db = openDb(':memory:');
  const opts = { allowPrivateHosts: true, minHostDelayMs: 0 };
  const count = (state) => db.prepare('SELECT COUNT(*) AS n FROM urls WHERE state = ?').get(state).n;
  const first = new Crawler(db, { ...opts, maxPerSite: 2 });
  first.addSeeds([{ url: site.origin + '/', priority: 10 }]);
  await first.run({ maxPages: 50 });
  assert.equal(count('done'), 2);
  assert.ok(count('queued') > 3, 'remaining URLs stay queued');
  const second = new Crawler(db, { ...opts, maxPerSite: 100 });
  await second.run({ maxPages: 50 });
  assert.ok(count('done') > 6);
  db.close();
});

test('a site root is queued when a seed is a deep page', async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const db = openDb(':memory:');
  const c = new Crawler(db, { allowPrivateHosts: true, minHostDelayMs: 0 });
  c.addSeeds([{ url: site.origin + '/space', priority: 5 }]);
  assert.ok(db.prepare('SELECT 1 FROM urls WHERE url = ?').get(site.origin + '/'));
  db.close();
});
