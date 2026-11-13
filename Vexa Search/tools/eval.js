#!/usr/bin/env node
'use strict';
// Ranking evaluation. Runs every judged query in tools/relevance.json and
// reports, per ranker:
//   MRR@10  mean of 1/rank of the first correct result (0 if none in top 10)
//   P@1     share of queries whose top result is correct
//   S@3     share with a correct result in the top 3
// Queries whose correct page is not in the index at all are listed and
// excluded (that's a crawl gap, not a ranking failure).
//
//   node tools/eval.js [--db path] [--baseline path/to/old/search.js] [--verbose]

const path = require('node:path');
const fs = require('node:fs');
const config = require('../config');
const { openDb } = require('../store/db');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const verbose = args.includes('--verbose');
const db = openDb(opt('db') || config.dbPath);
const { queries } = JSON.parse(fs.readFileSync(path.join(__dirname, 'relevance.json'), 'utf8'));

const allUrls = db.prepare('SELECT p.url FROM pages p JOIN docs d ON d.id = p.id').all().map((r) => r.url);

const rankers = [['current', require('../indexer/search').Searcher]];
if (opt('baseline')) rankers.unshift(['baseline', require(path.resolve(opt('baseline'))).Searcher]);

const judged = [];
const gaps = [];
for (const j of queries) {
  const res = j.relevant.map((r) => new RegExp(r));
  (allUrls.some((u) => res.some((re) => re.test(u))) ? judged : gaps).push({ ...j, res });
}

console.log(`${judged.length} judged queries with an answer in the index; ${gaps.length} crawl gaps (not scored)\n`);
const summary = [];
for (const [name, Searcher] of rankers) {
  const s = new Searcher(db);
  let mrr = 0; let p1 = 0; let s3 = 0;
  const lines = [];
  for (const j of judged) {
    const urls = s.search(j.q, { pageSize: 10 }).results.map((r) => r.url);
    const rank = urls.findIndex((u) => j.res.some((re) => re.test(u))) + 1;
    if (rank) mrr += 1 / rank;
    if (rank === 1) p1++;
    if (rank && rank <= 3) s3++;
    lines.push(`${rank ? String(rank).padStart(2) : ' -'}  ${j.q}${rank === 1 ? '' : `   [top: ${urls[0] || 'none'}]`}`);
  }
  const n = judged.length || 1;
  summary.push({ ranker: name, 'MRR@10': +(mrr / n).toFixed(3), 'P@1': +(p1 / n).toFixed(3), 'S@3': +(s3 / n).toFixed(3) });
  if (verbose) console.log(`--- ${name}\n${lines.join('\n')}\n`);
}
console.table(summary);
if (gaps.length) console.log('Crawl gaps:', gaps.map((g) => g.q).join(' | '));
