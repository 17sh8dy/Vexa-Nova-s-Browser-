'use strict';
// VexaBot's crawl loop: a persistent, prioritised frontier with per-site
// politeness (one fetch at a time per registrable domain), robots.txt, the content policy and duplicate detection.

const crypto = require('node:crypto');
const defaults = require('../config');
const { fetchPage, FetchError } = require('./fetcher');
const { parseHtml } = require('./html');
const { normalizeUrl, hostOf, siteOf, looksLikeFile } = require('./url');
const { robotsForStatus, isAllowed, parseRobots } = require('../VexaBot/robots');
const { hostBlockReason, pageBlockReason } = require('../VexaBot/policy');
const { transaction } = require('../store/db');

const ROBOTS_TTL = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Crawler {
  constructor(db, options = {}) {
    this.db = db;
    this.o = { ...defaults.crawl, ...options };
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || Date.now;
    this.robots = new Map();     // host -> parsed robots
    this.nextAt = new Map();     // site -> earliest next fetch time
    this.inFlight = new Set();   // sites being fetched right now
    this.siteDone = new Map();   // site -> pages fetched (cap)
    this.candCache = { at: 0, rows: [] };
    this.siteQueued = new Map(); // site -> URLs waiting (frontier bound)
    this.seenHosts = new Set();  // origins whose root has been queued
    this.stats = { fetched: 0, indexed: 0, blocked: 0, disallowed: 0, failed: 0, skipped: 0, queued: 0 };
    this.onEvent = options.onEvent || (() => {});
    this.q = {
      insertUrl: db.prepare(`INSERT INTO urls (url, host, site, depth, priority, category, state, found_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT(url) DO NOTHING`),
      getUrl: db.prepare('SELECT * FROM urls WHERE url = ?'),
      setState: db.prepare('UPDATE urls SET state = ?, reason = ?, fetched_at = ? WHERE url = ?'),
      requeue: db.prepare("UPDATE urls SET state = 'queued', priority = MAX(priority, ?), depth = MIN(depth, ?), category = COALESCE(?, category) WHERE url = ?"),
      // Best queued URL of each site (its seeds first), best sites first: one big site can't starve the rest.
      candidates: db.prepare(`SELECT url, host, site, depth, priority, category FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY site ORDER BY depth = 0 DESC, priority DESC, depth ASC, found_at ASC) AS rn
          FROM urls WHERE state = 'queued')
        WHERE rn = 1 ORDER BY priority DESC, depth ASC LIMIT 2000`),
      siteQueuedCount: db.prepare("SELECT COUNT(*) AS n FROM urls WHERE site = ? AND state = 'queued'"),
      siteCount: db.prepare("SELECT COUNT(*) AS n FROM urls WHERE site = ? AND state = 'done'"),
      getRobots: db.prepare('SELECT * FROM robots WHERE host = ?'),
      putRobots: db.prepare(`INSERT INTO robots (host, status, body, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at`),
      pageByUrl: db.prepare('SELECT id FROM pages WHERE url = ?'),
      pageByHash: db.prepare('SELECT url FROM pages WHERE hash = ? AND url != ? LIMIT 1'),
      upsertPage: db.prepare(`INSERT INTO pages (url, host, title, description, headings, body, lang, category, hash, noindex, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET title = excluded.title, description = excluded.description, headings = excluded.headings,
          body = excluded.body, lang = excluded.lang, category = COALESCE(excluded.category, pages.category), hash = excluded.hash,
          noindex = excluded.noindex, fetched_at = excluded.fetched_at
        RETURNING id`),
      deleteLinks: db.prepare('DELETE FROM links WHERE from_id = ?'),
      insertLink: db.prepare('INSERT INTO links (from_id, to_url, text) VALUES (?, ?, ?)')
    };
  }

  // ---- frontier -------------------------------------------------------

  enqueue(url, { depth = 0, priority = 0, category = null, force = false } = {}) {
    const u = normalizeUrl(url);
    if (!u || looksLikeFile(u)) return false;
    const host = hostOf(u);
    const site = siteOf(u);
    // Bounded frontier: each site keeps at most maxQueuedPerSite waiting URLs
    // (seeds always get in). Keeps scheduling fast as the crawl grows.
    if (!force) {
      if (!this.siteQueued.has(site)) this.siteQueued.set(site, this.q.siteQueuedCount.get(site).n);
      if (this.siteQueued.get(site) >= this.o.maxQueuedPerSite) return false;
    }
    const existing = this.q.getUrl.get(u);
    if (!existing) {
      this.q.insertUrl.run(u, host, site, depth, priority, category, this.now());
      this.siteQueued.set(site, (this.siteQueued.get(site) ?? 0) + 1);
      this.stats.queued++;
      return true;
    }
    return false;
  }

  addSeeds(seeds) {
    let added = 0;
    for (const s of seeds) {
      const u = normalizeUrl(s.url);
      if (!u) continue;
      const row = this.q.getUrl.get(u);
      const pr = s.priority ?? 5;
      if (!row) {
        this.enqueue(u, { depth: 0, priority: pr, category: s.category || null, force: true });
        this.enqueueRoot(u, 0, pr);
        added++;
        continue;
      }
      // Seeds are recrawled once they are older than recrawlAfterMs.
      const stale = !row.fetched_at || this.now() - row.fetched_at > this.o.recrawlAfterMs;
      if (row.state !== 'queued' && stale) { this.q.requeue.run(pr, 0, s.category || null, u); added++; }
    }
    return added;
  }

  // A site's root page is its most important page; queue it the first time
  // the host is seen (the indexer also learns where "/" redirects to).
  enqueueRoot(url, depth, priority) {
    let origin;
    try { origin = new URL(url).origin + '/'; } catch { return; }
    if (this.seenHosts.has(origin)) return;
    this.seenHosts.add(origin);
    if (!hostBlockReason(new URL(origin).hostname)) this.enqueue(origin, { depth: Math.min(depth, this.o.maxDepth), priority, force: true });
  }

  mark(url, state, reason = null) {
    this.q.setState.run(state, reason, this.now(), url);
    if (this.stats[state] !== undefined) this.stats[state]++;
    this.onEvent({ type: state, url, reason });
  }

  // ---- robots ---------------------------------------------------------

  async robotsFor(url, job = null) {
    const { origin, host } = new URL(url);
    if (this.robots.has(host)) return this.robots.get(host);
    let row = this.q.getRobots.get(host);
    if (!row || this.now() - row.fetched_at > ROBOTS_TTL) {
      if (job) job.hitNetwork = true;
      let status = 0;
      let body = '';
      try {
        const res = await fetchPage(origin + '/robots.txt', {
          timeoutMs: this.o.timeoutMs, maxBytes: 512 * 1024, allowPrivate: this.o.allowPrivateHosts,
          accept: 'text/plain,*/*;q=0.5', fetchImpl: this.fetchImpl, anyType: true,
          // Robots redirects may cross hosts; RFC 9309 allows following them.
          maxRedirects: 5
        });
        status = res.status;
        body = res.body || '';
      } catch (e) {
        // Unreachable host: treat as server error (disallow), retried after TTL.
        status = e instanceof FetchError && e.code === 'private' ? 403 : 503;
      }
      this.q.putRobots.run(host, status, body.slice(0, 512 * 1024), this.now());
      row = { status, body };
    }
    const parsed = robotsForStatus(row.status, row.body);
    this.robots.set(host, parsed);
    return parsed;
  }

  hostDelay(host) {
    const r = this.robots.get(host);
    const robotsMs = r && r.crawlDelay != null ? r.crawlDelay * 1000 : 0;
    return Math.max(this.o.minHostDelayMs, robotsMs);
  }

  siteFull(site) {
    if (!this.siteDone.has(site)) this.siteDone.set(site, this.q.siteCount.get(site).n);
    return this.siteDone.get(site) >= this.o.maxPerSite;
  }

  candidates(force = false) {
    if (force || this.now() - this.candCache.at > 1000 || !this.candCache.rows.length) {
      this.candCache = { at: this.now(), rows: this.q.candidates.all() };
    }
    return this.candCache.rows;
  }

  // ---- crawl loop -----------------------------------------------------

  async run({ maxPages = this.o.maxPages, signal } = {}) {
    // URLs left mid-fetch by a crashed or killed run go back in the queue.
    this.db.exec("UPDATE urls SET state = 'queued' WHERE state = 'fetching'");
    const running = new Set();
    let started = 0;
    const startNext = () => {
      if (signal?.aborted || started >= maxPages) return false;
      const now = this.now();
      for (const row of this.candidates()) {
        if (row.taken || this.inFlight.has(row.site)) continue;
        if ((this.nextAt.get(row.site) || 0) > now) continue;
        // A full site keeps its queue (a later run with a higher cap continues it).
        if (this.siteFull(row.site)) continue;
        row.taken = true;
        this.inFlight.add(row.site);
        this.q.setState.run('fetching', null, now, row.url);
        this.siteQueued.set(row.site, Math.max(0, (this.siteQueued.get(row.site) ?? 1) - 1));
        started++;
        const p = this.process(row)
          .catch((e) => this.mark(row.url, 'failed', e.message))
          .finally(() => {
            this.inFlight.delete(row.site);
            // Only real requests cost the site a politeness delay and the run a page;
            // URLs refused by robots.txt or policy are free.
            if (row.hitNetwork) this.nextAt.set(row.site, this.now() + this.hostDelay(row.host));
            else started--;
            running.delete(p);
          });
        running.add(p);
        return true;
      }
      return false;
    };

    while (true) {
      while (running.size < this.o.concurrency && startNext()) { /* fill slots */ }
      if (running.size === 0) {
        if (signal?.aborted || started >= maxPages) break;
        const waiting = this.candidates(true).filter((r) => !this.siteFull(r.site));
        if (!waiting.length) break;
        // Everything left is on a site that is cooling down.
        const soonest = Math.min(...waiting.map((r) => this.nextAt.get(r.site) || 0));
        await sleep(Math.max(20, Math.min(1000, soonest - this.now())));
        continue;
      }
      await Promise.race([...running, sleep(100)]);
    }
    // Anything claimed but interrupted goes back to the queue.
    this.db.exec("UPDATE urls SET state = 'queued' WHERE state = 'fetching'");
    return this.stats;
  }

  async process(row) {
    const { url, site } = row;
    const blockHost = hostBlockReason(new URL(url).hostname);
    if (blockHost) return this.mark(url, 'blocked', blockHost);

    const robots = await this.robotsFor(url, row);
    if (robots.crawlDelay != null && robots.crawlDelay * 1000 > this.o.maxCrawlDelayMs) {
      return this.mark(url, 'skipped', `crawl-delay ${robots.crawlDelay}s too high`);
    }
    const { pathname, search } = new URL(url);
    if (!isAllowed(robots, pathname + search)) return this.mark(url, 'disallowed', 'robots.txt');

    row.hitNetwork = true;
    if (row.depth === 0) await this.enqueueSitemap(robots, row).catch(() => {});

    const res = await fetchPage(url, {
      timeoutMs: this.o.timeoutMs, maxBytes: this.o.maxBytes, maxRedirects: this.o.maxRedirects,
      allowPrivate: this.o.allowPrivateHosts, fetchImpl: this.fetchImpl,
      checkHop: async (hopUrl) => {
        const why = hostBlockReason(new URL(hopUrl).hostname);
        if (why) throw new Error(`redirect to blocked host (${why})`);
        const r = await this.robotsFor(hopUrl);
        const h = new URL(hopUrl);
        if (!isAllowed(r, h.pathname + h.search)) throw new Error('redirect target disallowed by robots.txt');
      }
    });
    this.stats.fetched++;
    this.siteDone.set(site, (this.siteDone.get(site) ?? this.q.siteCount.get(site).n) + 1);

    let finalUrl = res.url;
    if (finalUrl !== url) {
      this.mark(url, 'done', `redirect → ${finalUrl}`);
      if (this.q.pageByUrl.get(finalUrl)) return; // already have it
      this.enqueue(finalUrl, { depth: row.depth, priority: row.priority, category: row.category });
      this.q.setState.run('fetching', null, this.now(), finalUrl);
    }
    if (res.status !== 200) return this.mark(finalUrl, 'failed', `HTTP ${res.status}`);
    if (res.body == null || !/html|xhtml/i.test(res.contentType)) return this.mark(finalUrl, 'skipped', `not HTML (${res.contentType || 'no type'})`);

    const xRobots = (res.headers.get('x-robots-tag') || '').toLowerCase();
    const page = parseHtml(res.body);
    const metaRobots = `${page.robots},${xRobots}`;
    const noindex = /\b(noindex|none)\b/.test(metaRobots);
    const nofollow = /\b(nofollow|none)\b/.test(metaRobots);

    const blockPage = pageBlockReason(page);
    if (blockPage) return this.mark(finalUrl, 'blocked', blockPage);

    const base = normalizeUrl(page.base || '', finalUrl) || finalUrl;

    // A canonical pointing elsewhere on the same host: index that one instead.
    if (page.canonical) {
      const canon = normalizeUrl(page.canonical, base);
      if (canon && canon !== finalUrl && hostOf(canon) === hostOf(finalUrl)) {
        this.enqueue(canon, { depth: row.depth, priority: row.priority + 0.5, category: row.category });
        if (!nofollow) this.followLinks(null, page, base, row);
        return this.mark(finalUrl, 'skipped', `canonical → ${canon}`);
      }
    }

    const text = page.text.slice(0, 200000);
    const hash = crypto.createHash('sha1').update(text.toLowerCase()).digest('hex');
    const dup = this.q.pageByHash.get(hash, finalUrl);
    if (dup && text.length > 0) return this.mark(finalUrl, 'skipped', `duplicate of ${dup.url}`);

    transaction(this.db, () => {
      const { id } = this.q.upsertPage.get(
        finalUrl, hostOf(finalUrl), page.title.slice(0, 500), page.description.slice(0, 1000),
        page.headings.join(' • ').slice(0, 4000), noindex ? '' : text, page.lang, row.category, hash, noindex ? 1 : 0, this.now()
      );
      this.q.deleteLinks.run(id);
      if (!nofollow) this.followLinks(id, page, base, row);
    });
    if (!noindex) this.stats.indexed++;
    this.mark(finalUrl, 'done', noindex ? 'noindex' : null);
  }

  followLinks(pageId, page, base, row) {
    const seen = new Set();
    const fromHost = hostOf(base);
    for (const link of page.links.slice(0, 500)) {
      if (link.nofollow) continue;
      const to = normalizeUrl(link.href, base);
      if (!to || seen.has(to)) continue;
      seen.add(to);
      if (pageId != null) this.q.insertLink.run(pageId, to, link.text.slice(0, 200));
      const depth = row.depth + 1;
      if (depth > this.o.maxDepth || looksLikeFile(to)) continue;
      const sameHost = hostOf(to) === fromHost;
      // Beta coverage is English-first: links found on other-language pages rank lower.
      const langPenalty = page.lang && !page.lang.startsWith('en') ? 2 : 0;
      const priority = row.priority - (sameHost ? 1.5 : 3) - langPenalty;
      if (this.enqueue(to, { depth, priority, category: sameHost ? row.category : null })) {
        const why = hostBlockReason(new URL(to).hostname);
        if (why) this.mark(to, 'blocked', why);
        else if (!sameHost) this.enqueueRoot(to, depth, priority + 1);
      }
    }
  }

  // Seeds: pull a few URLs from the site's sitemap (first one listed).
  async enqueueSitemap(robots, row) {
    if (!robots.sitemaps.length) return;
    let smUrl = normalizeUrl(robots.sitemaps[0], row.url);
    if (!smUrl || hostOf(smUrl) !== row.host) return;
    for (let level = 0; level < 2 && smUrl; level++) {
      const res = await fetchPage(smUrl, {
        timeoutMs: this.o.timeoutMs, maxBytes: 4 * 1024 * 1024, allowPrivate: this.o.allowPrivateHosts,
        accept: 'application/xml,text/xml,*/*;q=0.5', fetchImpl: this.fetchImpl, anyType: true
      });
      if (res.status !== 200 || !res.body || /\.gz$/i.test(smUrl)) return;
      const locs = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
      if (/<sitemapindex/i.test(res.body)) { smUrl = normalizeUrl(locs[0] || '', smUrl); continue; }
      for (const loc of locs.slice(0, 50)) {
        const u = normalizeUrl(loc);
        if (u && hostOf(u) === row.host) this.enqueue(u, { depth: 1, priority: row.priority - 1, category: row.category });
      }
      return;
    }
  }
}

module.exports = { Crawler, parseRobots };
