'use strict';
// Query engine: parse -> retrieve postings -> BM25F score -> PageRank blend
// -> host crowding -> snippets. Supports "exact phrases", -exclusions and
// site:example.com, plus "did you mean" and autocomplete.

const { words, termOf, fold } = require('./tokenize');
const zlib = require('node:zlib');
const { getMeta } = require('../store/db');

const FIELDS = {
  //       weight  b (length normalisation)
  title:  { w: 3.0, b: 0.5, col: 'tf_title', len: 'len_title' },
  head:   { w: 1.8, b: 0.6, col: 'tf_head', len: 'len_head' },
  body:   { w: 1.0, b: 0.75, col: 'tf_body', len: 'len_body' },
  url:    { w: 1.5, b: 0.5, col: 'tf_url', len: 'len_url' },
  anchor: { w: 2.0, b: 0.6, col: 'tf_anchor', len: 'len_anchor' }
};
const K1 = 1.2;
const MAX_QUERY = 256;
const PER_HOST = 2;
const MAX_CANDIDATES = 1000;

function parseQuery(raw) {
  const q = String(raw || '').slice(0, MAX_QUERY);
  const out = { raw: q.trim(), terms: [], words: [], phrases: [], exclude: [], sites: [] };
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[2] !== undefined) {
      const ws = words(m[2]);
      if (m[1]) { ws.map(termOf).filter(Boolean).forEach((t) => out.exclude.push(t)); continue; }
      const toks = [];
      ws.forEach((w, i) => { const t = termOf(w); if (t) toks.push({ term: t, off: i }); });
      if (toks.length) { out.phrases.push(toks); toks.forEach((t) => out.terms.push(t.term)); out.words.push(...ws); }
      continue;
    }
    const tok = m[3];
    const site = /^site:(.+)$/i.exec(tok);
    if (site) { out.sites.push(site[1].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')); continue; }
    if (tok.startsWith('-') && tok.length > 1) { words(tok.slice(1)).map(termOf).filter(Boolean).forEach((t) => out.exclude.push(t)); continue; }
    for (const w of words(tok)) { out.words.push(w); const t = termOf(w); if (t) out.terms.push(t); }
  }
  // A query made only of stopwords ("the who") still deserves an answer.
  if (!out.terms.length && out.words.length) out.terms = out.words.slice(0, 6);
  out.terms = [...new Set(out.terms)];
  return out;
}

class Searcher {
  constructor(db) {
    this.db = db;
    this.q = {
      term: db.prepare('SELECT id, df FROM terms WHERE term = ?'),
      postings: db.prepare('SELECT doc_id, tf_title, tf_head, tf_body, tf_url, tf_anchor, pos FROM postings WHERE term_id = ?'),
      doc: db.prepare('SELECT id, len_title, len_head, len_body, len_url, len_anchor, pagerank, siterank, is_home FROM docs WHERE id = ?'),
      page: db.prepare('SELECT id, url, host, title, description, lang, category FROM pages WHERE id = ?'),
      content: db.prepare('SELECT content FROM docs WHERE id = ?'),
      wordRange: db.prepare('SELECT word, freq FROM words WHERE word >= ? AND word < ? AND length(word) BETWEEN ? AND ? ORDER BY freq DESC LIMIT 4000'),
      prefix: db.prepare('SELECT word FROM words WHERE word >= ? AND word < ? ORDER BY freq DESC LIMIT ?'),
      wordFreq: db.prepare('SELECT freq FROM words WHERE word = ?')
    };
    this.refreshStats();
  }

  refreshStats() {
    this.N = Number(getMeta(this.db, 'N', 0));
    this.avg = {};
    for (const f of Object.keys(FIELDS)) this.avg[f] = Math.max(1, Number(getMeta(this.db, `avg_${f}`, 1)));
    this.indexedAt = Number(getMeta(this.db, 'indexed_at', 0));
    this.docCache = new Map();
    this.statsCache = null;
  }

  // Page text for snippets. The shipped index stores it zlib-compressed (BLOB).
  contentOf(id) {
    const c = this.q.content.get(id)?.content;
    if (!c) return '';
    if (typeof c === 'string') return c;
    try { return zlib.inflateRawSync(c).toString('utf8'); } catch { return ''; }
  }

  docStats(id) {
    let d = this.docCache.get(id);
    if (!d) { d = this.q.doc.get(id); if (this.docCache.size > 50000) this.docCache.clear(); this.docCache.set(id, d); }
    return d;
  }

  idf(df) { return Math.log(1 + (this.N - df + 0.5) / (df + 0.5)); }

  search(raw, { page = 1, pageSize = 10 } = {}) {
    const t0 = process.hrtime.bigint();
    const query = parseQuery(raw);
    const empty = { query: query.raw, total: 0, results: [], page, pageSize, suggestion: null, mode: 'and' };
    if (!query.terms.length || !this.N) return { ...empty, ms: elapsed(t0) };

    // Postings for each query term.
    const lists = new Map();
    for (const t of query.terms) {
      const row = this.q.term.get(t);
      lists.set(t, row ? { df: row.df, rows: this.q.postings.all(row.id) } : { df: 0, rows: [] });
    }

    const score = (requireAll) => {
      const acc = new Map(); // docId -> { s, matched, pos: Map(term -> positions) }
      for (const [term, { df, rows }] of lists) {
        if (!rows.length) continue;
        const idf = this.idf(df);
        for (const r of rows) {
          const d = this.docStats(r.doc_id);
          if (!d) continue;
          let tf = 0;
          for (const [f, cfg] of Object.entries(FIELDS)) {
            const raw = r[cfg.col];
            if (!raw) continue;
            tf += (cfg.w * raw) / (1 - cfg.b + cfg.b * (d[cfg.len] / this.avg[f]));
          }
          const s = (idf * tf) / (K1 + tf);
          let a = acc.get(r.doc_id);
          if (!a) { a = { s: 0, matched: 0, pos: new Map() }; acc.set(r.doc_id, a); }
          a.s += s;
          a.matched++;
          if (r.pos) a.pos.set(term, r.pos);
        }
      }
      const need = query.terms.length;
      const out = [];
      for (const [id, a] of acc) {
        if (requireAll && a.matched < need) continue;
        if (!requireAll) a.s *= (a.matched / need) ** 2;
        out.push([id, a]);
      }
      return out;
    };

    let mode = 'and';
    let hits = score(true);
    if (!hits.length && query.terms.length > 1 && !query.phrases.length) { mode = 'or'; hits = score(false); }

    // Phrase filter.
    if (query.phrases.length) {
      hits = hits.filter(([, a]) => query.phrases.every((ph) => hasPhrase(a.pos, ph)));
    }
    // Exclusions.
    if (query.exclude.length) {
      const banned = new Set();
      for (const t of query.exclude) {
        const row = this.q.term.get(t);
        if (row) for (const r of this.q.postings.all(row.id)) banned.add(r.doc_id);
      }
      hits = hits.filter(([id]) => !banned.has(id));
    }

    hits.sort((a, b) => b[1].s - a[1].s);
    const matched = hits.length; // true count; only the best MAX_CANDIDATES are reranked
    hits = hits.slice(0, MAX_CANDIDATES);

    // Rerank: PageRank, title/phrase match, homepages; and site: filter.
    const phraseText = query.words.join(' ');
    const ranked = [];
    for (const [id, a] of hits) {
      const p = this.q.page.get(id);
      if (!p) continue;
      const hostname = p.host.replace(/:\d+$/, '');
      if (query.sites.length && !query.sites.some((s) => hostname === s || hostname.endsWith('.' + s))) continue;
      const d = this.docStats(id);
      // PageRank is a nudge, not a trump card: relevance decides first.
      let s = a.s * (0.9 + 0.1 * Math.min(3, Math.log2(1 + (d.pagerank || 1))));
      // Proximity: query words close together beat the same words scattered.
      const n = query.terms.length;
      if (n > 1) {
        const span = minSpan(query.terms.map((t) => a.pos.get(t)));
        if (span) s *= 1 + 0.6 * Math.min(1, n / span);
      }
      // Title coverage: share of the query's terms found in the title.
      const title = fold(p.title || '');
      const titleTerms = new Set(words(title).map(termOf));
      s *= 1 + 0.4 * (query.terms.filter((t) => titleTerms.has(t)).length / n);
      if (phraseText.length > 2 && title.includes(phraseText)) s *= 1.3;
      s *= pageFactors(p, query, d);
      ranked.push({ id, score: s, page: p });
    }
    ranked.sort((a, b) => b.score - a.score);
    const ordered = crowd(ranked, PER_HOST);

    const start = (Math.max(1, page) - 1) * pageSize;
    const results = ordered.slice(start, start + pageSize).map((r) => ({
      url: r.page.url,
      host: r.page.host,
      title: r.page.title || r.page.url,
      snippet: snippet({ ...r.page, body: this.contentOf(r.id) }, query),
      score: Number(r.score.toFixed(4)),
      category: r.page.category || null
    }));

    const suggestion = ordered.length < 3 ? this.didYouMean(query) : null;
    const total = query.sites.length ? ordered.length : Math.max(ordered.length, matched);
    return { query: query.raw, total, results, page, pageSize, suggestion, mode, ms: elapsed(t0) };
  }

  // "Did you mean": swap unknown / rare words for a close, common word.
  didYouMean(query) {
    let changed = false;
    const fixed = query.words.map((w) => {
      if (w.length < 3 || /\d/.test(w)) return w;
      const t = termOf(w);
      const known = t && this.q.term.get(t);
      const ownFreq = (this.q.wordFreq.get(w) || { freq: 0 }).freq;
      if (known && known.df > 2) return w;
      const maxDist = w.length < 5 ? 1 : 2;
      const lo = w[0];
      const hi = String.fromCharCode(lo.charCodeAt(0) + 1);
      let best = null;
      for (const c of this.q.wordRange.all(lo, hi, w.length - maxDist, w.length + maxDist)) {
        if (c.word === w || c.freq <= ownFreq * 3) continue;
        const dist = damerau(w, c.word, maxDist);
        if (dist > maxDist) continue;
        const sc = Math.log(1 + c.freq) - dist * 1.5; // closeness first, popularity second
        if (!best || sc > best.sc) best = { word: c.word, sc };
      }
      if (best) { changed = true; return best.word; }
      return w;
    });
    return changed ? fixed.join(' ') : null;
  }

  suggest(raw, limit = 8) {
    const q = fold(String(raw || '')).slice(0, 100);
    const m = /^(.*?)([\p{L}\p{N}]+)$/u.exec(q);
    if (!m || m[2].length < 2) return [];
    const [, head, last] = m;
    const hi = last.slice(0, -1) + String.fromCharCode(last.charCodeAt(last.length - 1) + 1);
    return this.q.prefix.all(last, hi, limit).map((r) => head + r.word);
  }

  stats() {
    if (!this.statsCache) {
      const n = (sql) => this.db.prepare(sql).get().n;
      this.statsCache = {
        documents: this.N,
        terms: n('SELECT COUNT(*) AS n FROM terms'),
        // Hosts with at least one indexed page (works on the crawl DB and the shipped index).
        hosts: n('SELECT COUNT(DISTINCT p.host) AS n FROM pages p JOIN docs d ON d.id = p.id'),
        indexedAt: this.indexedAt || null
      };
    }
    return this.statsCache;
  }
}

function hasPhrase(posMap, phrase) {
  const lists = phrase.map((t) => posMap.get(t.term));
  if (lists.some((l) => !l)) return false;
  const sets = lists.map((l) => new Set(l.split(',').map(Number)));
  const base = phrase[0].off;
  for (const p of sets[0]) {
    if (phrase.every((t, i) => sets[i].has(p + t.off - base))) return true;
  }
  return false;
}

// ---- query-independent and navigational signals --------------------------

// Host labels that say nothing about what a site is.
const GENERIC_LABELS = new Set(['www', 'com', 'org', 'net', 'gov', 'edu', 'int', 'io', 'dev', 'app', 'co', 'uk', 'us',
  'en', 'm', 'workers', 'pages', 'shadylabs', 'site', 'web', 'github', 'blogspot']);
// Utility pages people rarely search for by topic.
const UTILITY_TITLE = /^(log ?in|sign ?(in|up)|register|create (an )?account|privacy|cookie|terms|legal notice|subscribe|newsletter|404|page not found|not found|access denied|error|redirecting|search results?)\b/i;
const UTILITY_WORDS = new Set(['login', 'log', 'sign', 'signin', 'signup', 'register', 'account', 'privacy', 'cookie', 'cookies', 'terms', 'legal', 'subscribe', 'newsletter']);

function hostTokens(hostname) {
  const labels = hostname.toLowerCase().split('.');
  const toks = new Set();
  for (const l of labels) {
    if (GENERIC_LABELS.has(l)) continue;
    toks.add(l.replace(/-/g, ''));               // "nova-legal" -> "novalegal"
    for (const part of l.split('-')) if (part && !GENERIC_LABELS.has(part)) toks.add(part);
  }
  return toks;
}

// Multiplier from signals that don't depend on term statistics.
function pageFactors(p, query, d) {
  let f = 1;
  let url;
  try { url = new URL(p.url); } catch { return f; }
  const depth = url.pathname.split('/').filter(Boolean).length;
  const isRoot = (depth === 0 && !url.search) || d.is_home === 1;

  // Navigational intent: the query names the site ("nova legal", "replay.gg",
  // "node.js"). Its homepage should win, the rest of the site comes next.
  const hostToks = hostTokens(url.hostname);
  const qw = query.words.filter((w) => w.length > 1);
  if (qw.length) {
    const joined = qw.join('');
    const covered = qw.filter((w) => hostToks.has(w)).length;
    const allNamed = covered === qw.length || hostToks.has(joined);
    if (allNamed) f *= isRoot ? 2.6 : 1.5;
    else if (covered && isRoot) f *= 1 + 0.6 * (covered / qw.length);
    else if (covered) f *= 1 + 0.15 * (covered / qw.length);
  }

  // Shallow pages are usually more central than deep ones.
  f *= 1 / (1 + 0.04 * Math.max(0, depth - 1));

  // English-first beta: other-language pages rank lower for Latin-script queries.
  if (p.lang && !/^en\b|^en-/.test(p.lang) && /^[\x00-\x7f]*$/.test(query.raw)) f *= 0.55;

  // Login/cookie/terms/404-style pages, unless that's what was asked for.
  if (UTILITY_TITLE.test((p.title || '').trim()) && !query.words.some((w) => UTILITY_WORDS.has(w))) f *= 0.5;

  // Site authority: how many other sites link to this site (log scale).
  if (d.siterank) f *= 1 + 0.06 * Math.min(6, d.siterank);
  return f;
}

// Smallest window (in word positions) containing every term at least once.
// `lists` holds one comma-separated position list per term; null if any is missing.
function minSpan(lists) {
  if (lists.some((l) => !l)) return null;
  const events = [];
  lists.forEach((l, k) => { for (const p of l.split(',')) events.push([Number(p), k]); });
  events.sort((x, y) => x[0] - y[0]);
  const need = lists.length;
  const count = new Array(need).fill(0);
  let have = 0;
  let best = Infinity;
  let lo = 0;
  for (let hi = 0; hi < events.length; hi++) {
    if (count[events[hi][1]]++ === 0) have++;
    while (have === need) {
      best = Math.min(best, events[hi][0] - events[lo][0] + 1);
      if (--count[events[lo][1]] === 0) have--;
      lo++;
    }
  }
  return best === Infinity ? null : best;
}

// At most `n` results per host in a row; extra ones are moved down, not dropped.
function crowd(ranked, n) {
  const count = new Map();
  const first = [];
  const later = [];
  for (const r of ranked) {
    const c = count.get(r.page.host) || 0;
    (c < n ? first : later).push(r);
    count.set(r.page.host, c + 1);
  }
  return first.concat(later);
}

function safePath(url) { try { return new URL(url).pathname; } catch { return ''; } }

function elapsed(t0) { return Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)); }

// Restricted Damerau-Levenshtein with early exit.
function damerau(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length];
}

// Best ~32-word window of the body containing the most query terms.
// Returns segments [{ text, hit }] so the caller decides how to highlight.
function snippet(page, query, size = 32) {
  const wanted = new Set(query.terms);
  const source = page.body || page.description || '';
  const toks = source.split(/\s+/).filter(Boolean).slice(0, 20000);
  const isHit = toks.map((tk) => {
    const ws = words(tk);
    return ws.some((w) => wanted.has(termOf(w)) || wanted.has(w));
  });
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < toks.length; i += 4) {
    const seen = new Set();
    let hitsN = 0;
    for (let j = i; j < Math.min(toks.length, i + size); j++) {
      if (!isHit[j]) continue;
      hitsN++;
      seen.add(termOf(words(toks[j])[0] || '') || toks[j]);
    }
    const sc = seen.size * 10 + hitsN;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  if (bestScore <= 0 && page.description) return [{ text: page.description.slice(0, 260), hit: false }];
  const start = Math.max(0, best - 2);
  const end = Math.min(toks.length, start + size);
  const segs = [];
  if (start > 0) segs.push({ text: '… ', hit: false });
  for (let j = start; j < end; j++) {
    const sep = j < end - 1 ? ' ' : '';
    const last = segs[segs.length - 1];
    if (!isHit[j] && last && !last.hit) last.text += toks[j] + sep;
    else { segs.push({ text: toks[j], hit: isHit[j] }); if (sep) segs.push({ text: sep, hit: false }); }
  }
  if (end < toks.length) segs.push({ text: ' …', hit: false });
  return segs;
}

module.exports = { Searcher, parseQuery, damerau, hasPhrase, crowd, minSpan, pageFactors, hostTokens };
