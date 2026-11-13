'use strict';
// Builds Vexa Search's inverted index from the crawled pages.
// Each document has five fields - title, headings, body, URL words and the
// anchor text other pages use to link to it - with a term frequency per
// field, plus token positions for phrase queries. A full rebuild runs in one
// transaction, so searches never see a half-built index.

const { tokenize, words } = require('./tokenize');
const { pagerank } = require('./pagerank');
const { transaction, setMeta } = require('../store/db');
const { siteOf } = require('../crawler/url');

const NL = String.fromCharCode(10); // block separator in page text
const MAX_POSITIONS = 64;
const FIELD_GAP = 50; // position gap between fields so phrases don't span them
const MAX_ANCHORS = 60;

function urlText(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return `${host} ${decodeURIComponent(u.pathname)}`;
  } catch { return url; }
}

// Boilerplate: text blocks (menus, cookie notices, footers not marked up as
// <nav>/<footer>) that repeat on at least half of a site's pages. They say
// nothing about any one page, so they are removed before indexing.
function stripBoilerplate(pages) {
  const bySite = new Map();
  for (const p of pages) {
    const s = siteOf(p.url);
    if (!bySite.has(s)) bySite.set(s, []);
    bySite.get(s).push(p);
  }
  const content = new Map();
  for (const group of bySite.values()) {
    const blocksOf = group.map((p) => (p.body || '').split(NL));
    const seen = new Map();
    if (group.length >= 3) {
      for (const blocks of blocksOf) for (const b of new Set(blocks)) seen.set(b, (seen.get(b) || 0) + 1);
    }
    const limit = Math.max(3, Math.ceil(group.length * 0.5));
    group.forEach((p, i) => {
      const kept = blocksOf[i].filter((b) => (seen.get(b) || 0) < limit);
      // Never strip a page down to nothing: fall back to the full text.
      content.set(p.id, (kept.length ? kept : blocksOf[i]).join(NL));
    });
  }
  return content;
}

function buildIndex(db, { onProgress = () => {} } = {}) {
  const started = Date.now();
  const pages = db.prepare('SELECT id, url, title, headings, body FROM pages WHERE noindex = 0').all();
  const content = stripBoilerplate(pages);
  const idByUrl = new Map(pages.map((p) => [p.url, p.id]));

  // Anchor text and link graph.
  const anchors = new Map();
  const edges = [];
  for (const l of db.prepare('SELECT from_id, to_url, text FROM links').iterate()) {
    const to = idByUrl.get(l.to_url);
    if (to === undefined) continue;
    edges.push([l.from_id, to]);
    if (!l.text || l.from_id === to) continue;
    const list = anchors.get(to) || [];
    if (list.length < MAX_ANCHORS) { list.push(l.text); anchors.set(to, list); }
  }

  const postings = new Map(); // term -> Map(docId -> posting)
  const wordFreq = new Map();
  const docRows = [];
  const totals = { title: 0, head: 0, body: 0, url: 0, anchor: 0 };

  const addField = (docId, field, text, offset) => {
    const { tokens, length } = tokenize(text);
    for (const t of tokens) {
      let byDoc = postings.get(t.term);
      if (!byDoc) { byDoc = new Map(); postings.set(t.term, byDoc); }
      let p = byDoc.get(docId);
      if (!p) { p = { title: 0, head: 0, body: 0, url: 0, anchor: 0, pos: [] }; byDoc.set(docId, p); }
      p[field]++;
      if (offset != null && p.pos.length < MAX_POSITIONS) p.pos.push(offset + t.pos);
    }
    return length;
  };

  pages.forEach((page, n) => {
    const lt = addField(page.id, 'title', page.title || '', 0);
    const lh = addField(page.id, 'head', page.headings || '', lt + FIELD_GAP);
    const lb = addField(page.id, 'body', content.get(page.id), lt + lh + 2 * FIELD_GAP);
    const lu = addField(page.id, 'url', urlText(page.url), null);
    const la = addField(page.id, 'anchor', (anchors.get(page.id) || []).join(' . '), null);
    docRows.push([page.id, lt, lh, lb, lu, la, content.get(page.id)]);
    totals.title += lt; totals.head += lh; totals.body += lb; totals.url += lu; totals.anchor += la;
    for (const w of words(`${page.title} ${page.headings} ${content.get(page.id)}`)) {
      if (w.length < 2 || w.length > 24 || !/^[\p{L}]+$/u.test(w)) continue;
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }
    if (n % 500 === 0) onProgress({ phase: 'tokenize', done: n, total: pages.length });
  });

  const ranks = pagerank(pages.map((p) => p.id), edges);
  const N = pages.length || 1;

  transaction(db, () => {
    db.exec('DELETE FROM postings; DELETE FROM terms; DELETE FROM docs; DELETE FROM words;');
    const insDoc = db.prepare('INSERT INTO docs (id, len_title, len_head, len_body, len_url, len_anchor, content, pagerank) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of docRows) insDoc.run(...r, ranks.get(r[0]) ?? 1);

    const insTerm = db.prepare('INSERT INTO terms (term, df) VALUES (?, ?) RETURNING id');
    const insPost = db.prepare('INSERT INTO postings (term_id, doc_id, tf_title, tf_head, tf_body, tf_url, tf_anchor, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let t = 0;
    for (const [term, byDoc] of postings) {
      const { id } = insTerm.get(term, byDoc.size);
      for (const [docId, p] of byDoc) {
        insPost.run(id, docId, p.title, p.head, p.body, p.url, p.anchor, p.pos.length ? p.pos.join(',') : null);
      }
      if (++t % 5000 === 0) onProgress({ phase: 'write', done: t, total: postings.size });
    }
    const insWord = db.prepare('INSERT INTO words (word, freq) VALUES (?, ?)');
    for (const [w, f] of wordFreq) insWord.run(w, f);

    setMeta(db, 'N', pages.length);
    for (const k of Object.keys(totals)) setMeta(db, `avg_${k}`, totals[k] / N);
    setMeta(db, 'indexed_at', Date.now());
  });

  return { documents: pages.length, terms: postings.size, links: edges.length, ms: Date.now() - started };
}

module.exports = { buildIndex, urlText, stripBoilerplate };
