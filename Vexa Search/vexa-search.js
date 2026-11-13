#!/usr/bin/env node
'use strict';
// Vexa Search command line.
//   node vexa-search.js crawl [--max 500] [--depth 3] [--per-site 150] [--seeds file.json] [--seed URL ...] [--index]
//   node vexa-search.js index
//   node vexa-search.js serve [--port 8790] [--host 127.0.0.1]
//   node vexa-search.js search "query words"
//   node vexa-search.js stats
// Global: --db path/to/vexa-search.db

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { openDb } = require('./store/db');
const { Crawler } = require('./crawler/crawler');
const { buildIndex } = require('./indexer/indexer');
const { Searcher } = require('./indexer/search');
const { createServer } = require('./server/server');
const { USER_AGENT } = require('./VexaBot/identity');

function parseArgs(argv) {
  const out = { _: [], seed: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next === undefined || next.startsWith('--') ? true : (i++, next);
    if (key === 'seed') out.seed.push(val); else out[key] = val;
  }
  return out;
}

const num = (v, d) => (v === undefined || v === true ? d : Number(v));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  const dbPath = typeof args.db === 'string' ? path.resolve(args.db) : config.dbPath;

  if (cmd === 'help' || args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }

  const db = openDb(dbPath);

  if (cmd === 'crawl') {
    const seedsFile = typeof args.seeds === 'string' ? args.seeds : path.join(__dirname, 'VexaBot', 'seeds.json');
    const seeds = args.seed.length
      ? args.seed.map((url) => ({ url, priority: 8 }))
      : JSON.parse(fs.readFileSync(seedsFile, 'utf8')).seeds;
    const crawler = new Crawler(db, {
      maxDepth: num(args.depth, config.crawl.maxDepth),
      maxPerSite: num(args['per-site'], config.crawl.maxPerSite),
      concurrency: num(args.concurrency, config.crawl.concurrency),
      allowPrivateHosts: Boolean(args['allow-private']),
      onEvent: (e) => {
        const tag = { done: '  ok ', failed: 'fail ', blocked: 'BLOCK', disallowed: 'robot', skipped: 'skip ' }[e.type] || e.type;
        console.log(`${tag} ${e.url}${e.reason ? `  (${e.reason})` : ''}`);
      }
    });
    const added = crawler.addSeeds(seeds);
    console.log(`VexaBot ${USER_AGENT}\n${added} seed(s) queued. Ctrl+C stops after in-flight pages finish.\n`);
    const ac = new AbortController();
    const t0 = Date.now();
    const tick = setInterval(() => console.log(`[progress] ${Math.round((Date.now() - t0) / 1000)}s fetched=${crawler.stats.fetched} indexed=${crawler.stats.indexed} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`), 60000);
    for (const sig of ['SIGHUP', 'SIGBREAK', 'SIGTERM']) {
      process.on(sig, () => { console.log(`[signal] ${sig}: stopping cleanly`); ac.abort(); });
    }
    process.on('exit', (code) => console.log(`[exit] code=${code} after ${Math.round((Date.now() - t0) / 1000)}s`));
    process.on('uncaughtException', (e) => { console.log('[uncaught]', e && e.stack); process.exit(70); });
    process.on('unhandledRejection', (e) => { console.log('[unhandled rejection]', e && e.stack); });
    process.once('SIGINT', () => { console.log('\nStopping…'); ac.abort(); });
    const stats = await crawler.run({ maxPages: num(args.max, config.crawl.maxPages), signal: ac.signal });
    clearInterval(tick);
    console.log('\nCrawl finished:', stats);
    if (args.index) console.log('Index built:', buildIndex(db));
  } else if (cmd === 'index') {
    console.log('Index built:', buildIndex(db, { onProgress: (p) => process.stdout.write(`\r${p.phase} ${p.done}/${p.total}   `) }));
  } else if (cmd === 'serve') {
    const port = num(args.port, config.server.port);
    const host = typeof args.host === 'string' ? args.host : config.server.host;
    createServer(db, { pageSize: config.server.pageSize }).listen(port, host, () => {
      console.log(`Vexa Search (beta) running at http://${host}:${port}/`);
    });
    return; // keep db open
  } else if (cmd === 'search') {
    const r = new Searcher(db).search(args._.slice(1).join(' '));
    console.log(`${r.total} results (${r.ms} ms)${r.suggestion ? `  did you mean: ${r.suggestion}` : ''}`);
    for (const x of r.results) console.log(`\n${x.title}\n  ${x.url}\n  ${x.snippet.map((s) => s.text).join('').slice(0, 200)}`);
  } else if (cmd === 'stats') {
    const s = new Searcher(db).stats();
    const states = db.prepare('SELECT state, COUNT(*) AS n FROM urls GROUP BY state').all();
    console.log({ ...s, indexedAt: s.indexedAt ? new Date(s.indexedAt).toISOString() : null, frontier: Object.fromEntries(states.map((r) => [r.state, r.n])) });
  } else {
    console.error(`Unknown command "${cmd}". Try: crawl, index, serve, search, stats`);
    process.exitCode = 1;
  }
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
