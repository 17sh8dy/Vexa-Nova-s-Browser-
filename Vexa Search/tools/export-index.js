#!/usr/bin/env node
'use strict';
// Export a compact, read-only search index for shipping inside the Vexa app.
// Keeps only what searching reads: terms, postings, docs (lengths, ranks,
// zlib-compressed snippet text), page titles/URLs/descriptions, words, meta.
// Crawl state (frontier, link graph, robots cache, raw page text) is dropped.
//
//   node tools/export-index.js [--db data/vexa-search.db] [--out dist/vexa-search-index.db] [--max-pos 16]

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const src = path.resolve(opt('db', config.dbPath));
const out = path.resolve(opt('out', path.join(__dirname, '..', 'dist', 'vexa-search-index.db')));
const maxPos = Number(opt('max-pos', 16));
// Snippet text kept per page. Deliberately short: the shipped index must hold
// enough for a result snippet, not a redistributable copy of anyone's page.
const maxContent = 2500;

fs.mkdirSync(path.dirname(out), { recursive: true });
for (const f of [out, out + '-wal', out + '-shm']) fs.rmSync(f, { force: true });

const t0 = Date.now();
const db = new DatabaseSync(out);
db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; ATTACH DATABASE '${src.replace(/'/g, "''")}' AS src;`);
db.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE terms (id INTEGER PRIMARY KEY, term TEXT NOT NULL UNIQUE, df INTEGER NOT NULL);
CREATE TABLE postings (term_id INTEGER NOT NULL, doc_id INTEGER NOT NULL,
  tf_title INTEGER NOT NULL, tf_head INTEGER NOT NULL, tf_body INTEGER NOT NULL, tf_url INTEGER NOT NULL, tf_anchor INTEGER NOT NULL,
  pos TEXT, PRIMARY KEY (term_id, doc_id)) WITHOUT ROWID;
CREATE TABLE docs (id INTEGER PRIMARY KEY, len_title INTEGER, len_head INTEGER, len_body INTEGER, len_url INTEGER, len_anchor INTEGER,
  pagerank REAL NOT NULL DEFAULT 0, siterank REAL NOT NULL DEFAULT 0, is_home INTEGER NOT NULL DEFAULT 0, content BLOB);
CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, title TEXT, description TEXT, lang TEXT, category TEXT);
CREATE TABLE words (word TEXT PRIMARY KEY, freq INTEGER NOT NULL) WITHOUT ROWID;
`);
db.exec('BEGIN');
db.exec(`INSERT INTO meta SELECT key, value FROM src.meta;
INSERT INTO meta (key, value) VALUES ('exported_at', '${Date.now()}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
INSERT INTO terms SELECT id, term, df FROM src.terms;
INSERT INTO pages SELECT p.id, p.url, p.host, p.title, p.description, p.lang, p.category FROM src.pages p JOIN src.docs d ON d.id = p.id;
INSERT INTO words SELECT word, freq FROM src.words;`);

// Positions: keep the first `maxPos` per posting (enough for phrases + proximity near the top).
const insPost = db.prepare('INSERT INTO postings VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
for (const r of db.prepare('SELECT * FROM src.postings').iterate()) {
  const pos = r.pos ? r.pos.split(',').slice(0, maxPos).join(',') : null;
  insPost.run(r.term_id, r.doc_id, r.tf_title, r.tf_head, r.tf_body, r.tf_url, r.tf_anchor, pos);
}
const insDoc = db.prepare('INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (const d of db.prepare('SELECT * FROM src.docs').iterate()) {
  const text = (d.content || '').slice(0, maxContent);
  insDoc.run(d.id, d.len_title, d.len_head, d.len_body, d.len_url, d.len_anchor, d.pagerank, d.siterank || 0, d.is_home || 0,
    zlib.deflateRawSync(Buffer.from(text, 'utf8'), { level: 9 }));
}
db.exec('COMMIT');
db.exec('DETACH DATABASE src; PRAGMA journal_mode = DELETE; VACUUM;');
const counts = db.prepare('SELECT (SELECT COUNT(*) FROM pages) AS pages, (SELECT COUNT(*) FROM terms) AS terms, (SELECT COUNT(*) FROM postings) AS postings').get();
db.close();
const mb = (fs.statSync(out).size / 1048576).toFixed(1);
console.log(`Exported ${counts.pages} pages, ${counts.terms} terms, ${counts.postings} postings -> ${out} (${mb} MB) in ${Date.now() - t0} ms`);
