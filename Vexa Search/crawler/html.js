'use strict';
// A small, forgiving HTML parser written from scratch for the crawler.
// It does not build a DOM: one linear pass over the markup pulls out what
// search needs (title, meta, headings, readable text, links) and survives
// the broken markup real sites ship.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Content of these is not markup; skip to the matching end tag.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'template']);
// Text inside these is boilerplate or not prose; it is not indexed as body.
const SKIP_TEXT = new Set(['nav', 'footer', 'svg', 'math', 'select', 'button', 'form', 'dialog']);
// Inline elements: no word break at their boundaries.
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'font', 'label']);
const HEADINGS = new Set(['h1', 'h2', 'h3']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  bull: '•', middot: '·', laquo: '«', raquo: '»', times: '×', divide: '÷', deg: '°', plusmn: '±',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', shy: '', zwj: '', zwnj: '',
  iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  atilde: 'ã', ntilde: 'ñ', otilde: 'õ', Ntilde: 'Ñ', ccedil: 'ç', Ccedil: 'Ç', szlig: 'ß',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', thorn: 'þ',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', star: '☆', check: '✓',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', mu: 'μ', lambda: 'λ'
};

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});?/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const v = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

// Parse the attribute section of a start tag: `href="x" data-a=b checked`.
function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue; // first wins, like browsers
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const NL = String.fromCharCode(10); // block separator in extracted text

function collapse(s) { return s.replace(/\s+/g, ' ').trim(); }

function parseHtml(html) {
  const out = {
    title: '', description: '', lang: '', canonical: '', base: '', robots: '', rating: '',
    headings: [], text: '', links: []
  };
  let ogTitle = '';
  let ogDesc = '';
  const body = [];
  const skip = Object.create(null);
  let skipping = 0;
  let headingDepth = 0;
  let headingBuf = [];
  let anchor = null; // { href, rel, text: [] }

  const n = html.length;
  let i = 0;

  const pushText = (raw) => {
    if (!raw) return;
    const t = decodeEntities(raw);
    if (anchor) anchor.text.push(t);
    if (headingDepth > 0) headingBuf.push(t);
    if (skipping === 0) body.push(t.replace(/\s+/g, ' '));
  };
  const boundary = () => {
    if (anchor) anchor.text.push(' ');
    if (headingDepth > 0) headingBuf.push(' ');
    body.push(NL); // block boundary, kept so the indexer can find repeated blocks
  };
  const closeAnchor = () => {
    if (!anchor) return;
    out.links.push({ href: anchor.href, text: collapse(anchor.text.join('')), nofollow: /\bnofollow\b/i.test(anchor.rel) });
    anchor = null;
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));
    i = lt;

    // Comments, doctype, CDATA, processing instructions.
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const c1 = html[i + 1];
    if (c1 === '!' || c1 === '?') {
      const end = html.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const isEnd = c1 === '/';
    const nameStart = isEnd ? i + 2 : i + 1;
    if (!/[a-zA-Z]/.test(html[nameStart] || '')) {
      // A bare "<" in text, e.g. "a < b".
      pushText('<');
      i += 1;
      continue;
    }
    // Find the end of the tag, respecting quoted attribute values.
    let j = nameStart;
    let quote = null;
    while (j < n) {
      const ch = html[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    const inner = html.slice(nameStart, j);
    i = j + 1;
    const nm = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(inner);
    const name = nm[0].toLowerCase();

    if (isEnd) {
      if (skip[name]) { skip[name]--; skipping--; }
      if (HEADINGS.has(name) && headingDepth > 0) {
        headingDepth--;
        if (headingDepth === 0) {
          const h = collapse(headingBuf.join(''));
          if (h) out.headings.push(h);
          headingBuf = [];
        }
      }
      if (name === 'a') closeAnchor();
      if (!INLINE.has(name)) boundary();
      continue;
    }

    const attrs = parseAttrs(inner.slice(name.length));

    if (RAW_TEXT.has(name) && !inner.trimEnd().endsWith('/')) {
      const closeRe = new RegExp('</' + name + '\\s*>', 'ig');
      closeRe.lastIndex = i;
      const m = closeRe.exec(html);
      const content = html.slice(i, m ? m.index : n);
      i = m ? m.index + m[0].length : n;
      if (name === 'title' && !out.title) out.title = collapse(decodeEntities(content));
      else if (name === 'textarea') pushText(content);
      boundary();
      continue;
    }

    switch (name) {
      case 'html': if (attrs.lang) out.lang = attrs.lang.toLowerCase(); break;
      case 'base': if (attrs.href && !out.base) out.base = attrs.href; break;
      case 'meta': {
        const key = (attrs.name || attrs.property || attrs['http-equiv'] || '').toLowerCase();
        const val = attrs.content || '';
        if (key === 'description' && !out.description) out.description = collapse(val);
        else if (key === 'og:title') ogTitle = collapse(val);
        else if (key === 'og:description') ogDesc = collapse(val);
        else if (key === 'robots' || key === 'vexabot') out.robots = (out.robots + ',' + val.toLowerCase()).replace(/^,/, '');
        else if (key === 'rating') out.rating = val;
        break;
      }
      case 'link': {
        const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
        if (rel.includes('canonical') && attrs.href && !out.canonical) out.canonical = attrs.href;
        break;
      }
      case 'a':
        closeAnchor();
        if (attrs.href) anchor = { href: attrs.href, rel: attrs.rel || '', text: [] };
        break;
      case 'img':
        // Alt text is real content (and the anchor text of image links).
        if (attrs.alt) pushText(' ' + attrs.alt + ' ');
        break;
      default: break;
    }

    if (VOID.has(name) || inner.trimEnd().endsWith('/')) { if (!INLINE.has(name)) boundary(); continue; }
    if (SKIP_TEXT.has(name)) { skip[name] = (skip[name] || 0) + 1; skipping++; }
    if (HEADINGS.has(name)) headingDepth++;
    if (!INLINE.has(name)) boundary();
  }
  closeAnchor();

  if (!out.title) out.title = ogTitle;
  if (!out.description) out.description = ogDesc;
  // Text keeps one block per line (paragraphs, list items, cells...).
  out.text = body.join('').split(NL).map(collapse).filter(Boolean).join(NL);
  return out;
}

// Look for <meta charset> / http-equiv content-type in the first bytes.
function sniffCharset(latin1Head) {
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i.exec(latin1Head);
  return m ? m[1].toLowerCase() : '';
}

module.exports = { parseHtml, decodeEntities, sniffCharset };
