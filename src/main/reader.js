'use strict';
// Vexa Focus → Reader view.
//
// The article is extracted inside the page, in an *isolated world* (page scripts can't see
// or tamper with the extractor), as a small tree of allowed elements and text — never as
// HTML. vexa://reader then rebuilds it with createElement under a strict CSP, so nothing
// from the page can run. The extracted article is held in memory only.

const crypto = require('crypto');
const { settings } = require('./settings');
const { siteOf, hostOf } = require('./url');

const WORLD = 1002;
const MAX_KEEP = 30;
const MAX_JSON = 2 * 1024 * 1024;
const articles = new Map(); // token -> { data, url, at }

// Runs in the page's isolated world. Must be self-contained.
function extract() {
  const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DL', 'DT', 'DD']);
  const INLINE = new Set(['A', 'EM', 'I', 'STRONG', 'B', 'CODE', 'SUB', 'SUP', 'MARK', 'SMALL', 'S', 'U', 'BR', 'IMG', 'SPAN', 'TIME', 'ABBR', 'Q', 'CITE', 'KBD']);
  const DROP = 'script,style,noscript,template,iframe,object,embed,form,button,input,select,textarea,nav,aside,footer,header:not(article header),svg,canvas,dialog,[role=navigation],[role=banner],[role=complementary],[aria-hidden=true],[hidden]';
  const NOISE = /(^|[-_\s])(ad|ads|advert|banner|comment|comments|share|social|related|promo|newsletter|subscribe|sidebar|cookie|popup|modal|breadcrumb|footer|nav|menu|sponsor|outbrain|taboola)([-_\s]|$)/i;
  const textLen = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().length;
  const linkDensity = (el) => {
    const t = textLen(el) || 1;
    let l = 0;
    for (const a of el.querySelectorAll('a')) l += textLen(a);
    return l / t;
  };

  // Pick the element holding the article.
  let best = document.querySelector('article [itemprop=articleBody], [itemprop=articleBody]') || null;
  if (!best) {
    const arts = [...document.querySelectorAll('article')].filter((a) => textLen(a) > 500);
    if (arts.length === 1) best = arts[0];
  }
  if (!best) {
    const scores = new Map();
    for (const p of document.querySelectorAll('p, pre, blockquote')) {
      const len = textLen(p);
      if (len < 60) continue;
      const score = 1 + Math.min(3, len / 120) + ((p.textContent.match(/[,.;]/g) || []).length / 10);
      let node = p.parentElement;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        const id = (node.id || '') + ' ' + (typeof node.className === 'string' ? node.className : '');
        if (NOISE.test(id)) continue;
        scores.set(node, (scores.get(node) || 0) + score / (depth + 1));
      }
    }
    let top = 0;
    for (const [node, s] of scores) {
      const adj = s * (1 - Math.min(0.9, linkDensity(node)));
      if (adj > top) {
        top = adj;
        best = node;
      }
    }
    if (top < 8) best = best && textLen(best) > 1200 ? best : null;
  }
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
  const info = {
    url: location.href,
    title: (meta('meta[property="og:title"]') || document.querySelector('h1')?.textContent || document.title || '').trim().slice(0, 300),
    byline: (meta('meta[name="author"]') || document.querySelector('[rel=author], .byline, .author')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    site: (meta('meta[property="og:site_name"]') || location.hostname.replace(/^www\./, '')).slice(0, 100),
    published: meta('meta[property="article:published_time"]') || document.querySelector('time[datetime]')?.getAttribute('datetime') || '',
    lang: document.documentElement.lang || '',
    dir: document.documentElement.dir || 'ltr',
    readable: !!best
  };
  if (!best) return { ...info, content: null, words: 0 };

  const root = best.cloneNode(true);
  for (const el of root.querySelectorAll(DROP)) el.remove();
  for (const el of [...root.querySelectorAll('*')]) {
    const id = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    if (el.isConnected && NOISE.test(id) && textLen(el) < 400) el.remove();
  }

  const abs = (u) => {
    try {
      const x = new URL(u, location.href);
      return /^https?:$/.test(x.protocol) ? x.href : '';
    } catch {
      return '';
    }
  };
  let budget = 6000; // nodes
  function walk(node) {
    if (budget-- <= 0) return null;
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/\s+/g, ' ');
      return t ? t : null;
    }
    if (node.nodeType !== 1) return null;
    const tag = node.tagName;
    if (tag === 'IMG') {
      const src = abs(node.currentSrc || node.getAttribute('src') || node.getAttribute('data-src') || '');
      if (!src || (node.width && node.width < 40)) return null;
      return { t: 'img', src, alt: (node.alt || '').slice(0, 300) };
    }
    if (tag === 'BR') return { t: 'br' };
    if (tag === 'HR') return { t: 'hr' };
    const kids = [];
    for (const c of node.childNodes) {
      const w = walk(c);
      if (w == null) continue;
      if (Array.isArray(w)) kids.push(...w);
      else kids.push(w);
    }
    if (BLOCK.has(tag) || INLINE.has(tag)) {
      if (tag === 'SPAN' || tag === 'TIME' || tag === 'ABBR' || tag === 'CITE') return kids; // unwrap
      const out = { t: tag.toLowerCase(), c: kids };
      if (tag === 'A') {
        const href = abs(node.getAttribute('href') || '');
        if (!href) return kids;
        out.href = href;
      }
      if (!kids.length && tag !== 'TD' && tag !== 'TH') return null;
      return out;
    }
    // div, section and the like: keep the children, group loose text into paragraphs.
    return kids;
  }
  const content = walk(root);
  const words = (root.textContent || '').trim().split(/\s+/).length;
  return { ...info, content: Array.isArray(content) ? content : content ? [content] : [], words };
}

class Reader {
  /** Extract the article from a tab. Returns the data, or null if the page isn't readable. */
  async extract(tab) {
    if (!tab || tab.wc.isDestroyed() || !/^https?:/i.test(tab.url)) return null;
    let data;
    try {
      data = await tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${extract.toString()})()` }]);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    try {
      if (JSON.stringify(data).length > MAX_JSON) return null;
    } catch {
      return null;
    }
    return data;
  }

  async open(tab, { auto = false } = {}) {
    const data = await this.extract(tab);
    if (!data || !data.readable || !data.content || data.words < (auto ? 250 : 40)) {
      if (!auto) tab.win.toast('Reader view isn’t available for this page');
      return false;
    }
    const token = crypto.randomBytes(9).toString('base64url');
    articles.set(token, { data, url: tab.url, at: Date.now() });
    while (articles.size > MAX_KEEP) articles.delete(articles.keys().next().value);
    tab.loadURL(`vexa://reader/?id=${token}&u=${encodeURIComponent(tab.url)}`);
    return true;
  }

  /** Toolbar button / F9: into Reader view, or back to the page. */
  async toggle(tab) {
    if (tab.url.startsWith('vexa://reader/')) return this.leave(tab);
    return this.open(tab);
  }

  leave(tab) {
    let original = '';
    try {
      original = new URL(tab.url).searchParams.get('u') || '';
    } catch {
      /* ignore */
    }
    if (!/^https?:\/\//i.test(original)) return;
    tab._readerSkip = original; // don't jump straight back in on "always use Reader"
    const nav = tab.wc.navigationHistory;
    if (nav.canGoBack() && nav.getEntryAtIndex(nav.getActiveIndex() - 1)?.url === original) nav.goBack();
    else tab.loadURL(original);
  }

  get(token) {
    const a = articles.get(String(token || ''));
    return a ? a.data : null;
  }

  /** "Always use Reader view on this site": switch automatically when an article loads. */
  afterLoad(tab) {
    if (!/^https?:/i.test(tab.url) || tab.error) return;
    const site = siteOf(hostOf(tab.url));
    if (!site || !settings.get('focus').sitePrefs[site]?.reader) return;
    if (tab._readerSkip === tab.url) return;
    this.open(tab, { auto: true }).catch(() => {});
  }

  setSitePref(site, key, value) {
    if (!/^[a-z0-9.-]+$/i.test(site || '') || !['reader', 'allowInFocus'].includes(key)) throw new Error('Invalid site preference');
    const cur = settings.get('focus').sitePrefs[site] || {};
    // Both keys are always written, so a deep merge can't leave a stale one behind.
    const next = { reader: !!(key === 'reader' ? value : cur.reader), allowInFocus: !!(key === 'allowInFocus' ? value : cur.allowInFocus) };
    settings.set('focus', { sitePrefs: { [site]: next.reader || next.allowInFocus ? next : null } });
    return settings.get('focus').sitePrefs[site] || {};
  }
}

module.exports = { reader: new Reader(), extract };
