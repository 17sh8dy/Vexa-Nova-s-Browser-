# Vexa Search (beta)

Vexa's and Nova's own search engine, built from scratch: its own crawler (**VexaBot**), its own
inverted index and its own ranking. No search API, no proxying of another engine's results.
Zero npm dependencies; needs Node 22.13+ (uses the built-in `node:sqlite` purely as storage).

Planned to become a choice in Vexa's search settings, labelled **BETA**. It is not wired into
the browser yet.

## Quick start

```sh
cd "D:\Dev\Vexa\Vexa Search"
npm test                                   # unit + end-to-end tests (real crawl of a local test site)
node vexa-search.js crawl --max 300 --index # polite crawl of VexaBot/seeds.json, then index
node vexa-search.js serve                  # http://127.0.0.1:8790/
node vexa-search.js search "css grid"      # search from the terminal
node vexa-search.js stats
node tools/eval.js --verbose               # score ranking on the judged queries
```

Crawl options: `--max N` (pages this run), `--depth N`, `--per-site N`, `--concurrency N`,
`--seeds file.json` or `--seed URL` (repeatable), `--index` (rebuild the index afterwards),
`--db path`. Crawls resume: the frontier lives in `data/vexa-search.db`. Ctrl+C stops cleanly.

## How it works

| Folder | What it does |
| --- | --- |
| `VexaBot/` | The crawler's identity (user agent), robots.txt parser (RFC 9309: groups, longest match, `*`/`$`, Crawl-delay, Sitemap), the beta content policy, the blocklist and the seed list. |
| `crawler/` | URL normalisation, SSRF guard (no localhost/LAN, checked after DNS too), polite fetcher (redirects checked hop by hop, 2 MB / 15 s caps, charset detection), a forgiving HTML parser written from scratch, and the crawl loop. |
| `indexer/` | Tokeniser (accent folding, stopwords), Porter stemmer, inverted index builder, PageRank, and the query engine. |
| `store/` | SQLite schema (storage only). |
| `server/` | Search pages and JSON API (`node:http`), Vexa-styled, light/dark, phone layout, strict CSP. |

**Crawling.** One fetch at a time per *site* (registrable domain, from the Public Suffix List,
so all `*.wikipedia.org` share one slot), at least 1.5 s apart or the robots Crawl-delay if longer.
The best URL of each site is scheduled first, seeds before links, so one huge site can't starve
the rest. A per-site page cap keeps the crawl broad; capped URLs stay queued for a later run. Each site keeps at
most 600 waiting URLs, so the frontier (and scheduling time) stays bounded as the crawl grows.
Respects `noindex`/`nofollow` (meta robots, `meta name="vexabot"`, `X-Robots-Tag`, `rel=nofollow`),
follows same-host canonicals, drops tracking parameters, skips exact-duplicate pages.

**Content policy (beta).** Mainstream web first. Adult sites are not crawled: blocklisted hosts,
adult TLDs, the RTA label, `rating` meta and explicit host names / titles. Blocked URLs are logged
with a reason, never indexed, and their links aren't followed.

**Indexing.** Five fields per page: title, headings, body, URL words and *anchor text* (how other
pages describe it). Boilerplate that repeats on half or more of a site's pages (menus, cookie bars)
is removed before indexing. Positions are kept for phrase search. The index is rebuilt in one
transaction; the server picks up a new index without a restart.

**Ranking.** BM25F over the five fields, then: term proximity (query words close together),
title coverage, exact-phrase-in-title, a gentle PageRank nudge, and:
- *navigational intent*: a query that names a site ("nova legal", "replay.gg", "node.js") lifts that
  site's homepage, then the rest of the site;
- *site authority*: how many other sites link to the site (log scale, small weight);
- shallow URLs over deep ones; non-English pages lower for Latin-script queries (English-first beta);
  login / cookie / terms / 404 pages lower unless asked for; generic anchors ("click here") ignored.

**Measuring ranking.** `tools/relevance.json` holds judged queries (query -> URLs that count as
correct). `node tools/eval.js --baseline tools/baseline/search-v0.1.js` scores the current ranker
against the first beta ranker on the same index (MRR@10, P@1, S@3). Add queries there whenever a
search looks wrong, then change ranking until the number goes up without other queries going down.
At most two results per host in a row. Supports `"phrases"`, `-exclude`, `site:example.com`,
"did you mean" (edit distance over the index's own vocabulary) and autocomplete.

## Endpoints

`/` home · `/search?q=&page=` · `/api/search?q=` (JSON) · `/api/suggest?q=` (`&format=opensearch`
for browsers) · `/api/stats` · `/about` · `/bot` (webmaster page: what VexaBot is, how to block it) ·
`/opensearch.xml`.

## Known limits / before going public

- Many big publishers (AP, IGN, GameSpot, The Guardian, Eurogamer, RPS) answer **403** to an
  unknown crawler. Getting VexaBot treated as a legitimate bot (e.g. Cloudflare's verified-bot
  programme, published crawl IPs) is needed before coverage of those sites is possible.
- `VexaBot/identity.js` points webmasters at `https://vexa.shadylabs.workers.dev/bot`, which does
  not exist yet. Publish the `/bot` page there before any large crawl.
- No JavaScript rendering: pages that build their content in JS index poorly.
- Index rebuilds are full, not incremental (fine for tens of thousands of pages, not millions).
- The server binds to 127.0.0.1 and has no rate limiting; it is not ready to be exposed publicly.
- English-first: links from non-English pages are crawled later.
