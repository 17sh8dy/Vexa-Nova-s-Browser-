'use strict';
// Storage. SQLite (built into Node) is used only as a durable key/row store;
// the inverted index, ranking and everything else are Vexa Search's own code.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Crawl frontier and crawl log. One row per normalised URL ever seen.
CREATE TABLE IF NOT EXISTS urls (
  url        TEXT PRIMARY KEY,
  host       TEXT NOT NULL,
  site       TEXT NOT NULL,              -- registrable domain; politeness + caps are per site
  depth      INTEGER NOT NULL DEFAULT 0,
  priority   REAL NOT NULL DEFAULT 0,
  category   TEXT,
  state      TEXT NOT NULL DEFAULT 'queued', -- queued | done | failed | blocked | disallowed | skipped
  reason     TEXT,
  found_at   INTEGER NOT NULL,
  fetched_at INTEGER
);
CREATE INDEX IF NOT EXISTS urls_queue ON urls(state, priority DESC, depth);
CREATE INDEX IF NOT EXISTS urls_site ON urls(site, state);

-- Fetched, indexable documents.
CREATE TABLE IF NOT EXISTS pages (
  id          INTEGER PRIMARY KEY,
  url         TEXT NOT NULL UNIQUE,
  host        TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  headings    TEXT,
  body        TEXT,
  lang        TEXT,
  category    TEXT,
  hash        TEXT,
  noindex     INTEGER NOT NULL DEFAULT 0,
  fetched_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_hash ON pages(hash);

-- Link graph (for PageRank and anchor text).
CREATE TABLE IF NOT EXISTS links (
  from_id INTEGER NOT NULL,
  to_url  TEXT NOT NULL,
  text    TEXT
);
CREATE INDEX IF NOT EXISTS links_from ON links(from_id);
CREATE INDEX IF NOT EXISTS links_to ON links(to_url);

CREATE TABLE IF NOT EXISTS robots (
  host       TEXT PRIMARY KEY,
  status     INTEGER,
  body       TEXT,
  fetched_at INTEGER NOT NULL
);

-- The inverted index (rebuilt by the indexer).
CREATE TABLE IF NOT EXISTS terms (
  id   INTEGER PRIMARY KEY,
  term TEXT NOT NULL UNIQUE,
  df   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS postings (
  term_id INTEGER NOT NULL,
  doc_id  INTEGER NOT NULL,
  tf_title INTEGER NOT NULL, tf_head INTEGER NOT NULL, tf_body INTEGER NOT NULL,
  tf_url INTEGER NOT NULL, tf_anchor INTEGER NOT NULL,
  pos TEXT,                    -- token positions in title+headings+body stream, for phrases
  PRIMARY KEY (term_id, doc_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,      -- = pages.id
  len_title INTEGER, len_head INTEGER, len_body INTEGER, len_url INTEGER, len_anchor INTEGER,
  pagerank REAL NOT NULL DEFAULT 0,
  siterank REAL NOT NULL DEFAULT 0, -- log2(1 + other sites linking to this page's site)
  is_home INTEGER NOT NULL DEFAULT 0, -- the site's root, or the page its root redirects to
  content TEXT                 -- body with site boilerplate removed (indexed + used for snippets)
);
-- Surface words (unstemmed) for "did you mean" and autocomplete.
CREATE TABLE IF NOT EXISTS words (
  word TEXT PRIMARY KEY,
  freq INTEGER NOT NULL
) WITHOUT ROWID;
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  // Columns added after a database was created.
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has('docs', 'content')) db.exec('ALTER TABLE docs ADD COLUMN content TEXT');
  if (!has('docs', 'is_home')) db.exec('ALTER TABLE docs ADD COLUMN is_home INTEGER NOT NULL DEFAULT 0');
  if (!has('docs', 'siterank')) db.exec('ALTER TABLE docs ADD COLUMN siterank REAL NOT NULL DEFAULT 0');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
  if (!row) db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  return db;
}

function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { openDb, getMeta, setMeta, transaction };
