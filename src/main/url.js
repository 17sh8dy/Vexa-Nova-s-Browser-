'use strict';
// Address-bar input resolution and URL helpers. Pure functions (no Electron)
// so they can be unit-tested with plain Node.

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?query=%s' }
};

const INTERNAL_PAGES = ['newtab', 'settings', 'history', 'bookmarks', 'downloads'];
const NEWTAB_URL = 'vexa://newtab/';

// Schemes we pass straight through when typed.
const PASSTHROUGH_SCHEMES = ['http:', 'https:', 'file:', 'vexa:', 'about:', 'data:', 'view-source:', 'blob:'];
const BLOCKED_SCHEMES = ['javascript:'];

function searchUrl(query, engineId) {
  const engine = SEARCH_ENGINES[engineId] || SEARCH_ENGINES.duckduckgo;
  return engine.url.replace('%s', encodeURIComponent(query));
}

function isIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// Very small heuristic for "does this look like a hostname someone meant to visit".
function looksLikeHost(host) {
  if (!host) return false;
  if (host === 'localhost') return true;
  if (isIPv4(host)) return true;
  if (/^\[[0-9a-f:]+\]$/i.test(host)) return true; // IPv6 literal
  if (!/^[a-z0-9.-]+$/i.test(host)) {
    // Allow internationalised domains (unicode letters) but not spaces/symbols.
    if (!/^[\p{L}\p{N}.-]+$/u.test(host)) return false;
  }
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (labels.some((l) => l.length === 0 || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return false;
  const tld = labels[labels.length - 1];
  return /^(\p{L}{2,63}|xn--[a-z0-9-]+)$/iu.test(tld);
}

/**
 * Turn what the user typed into a URL to load.
 * @returns {{ url: string, type: 'url'|'search'|'blocked'|'empty' }}
 */
function resolveInput(raw, engineId = 'duckduckgo') {
  const input = String(raw || '').trim();
  if (!input) return { url: '', type: 'empty' };

  const lower = input.toLowerCase();

  if (BLOCKED_SCHEMES.some((s) => lower.startsWith(s))) return { url: '', type: 'blocked' };

  // Windows absolute paths: C:\foo\bar or C:/foo
  if (/^[a-z]:[\\/]/i.test(input)) {
    return { url: 'file:///' + input.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([a-z])%3A/i, '$1:'), type: 'url' };
  }
  // Unix absolute paths
  if (input.startsWith('/') && !/\s/.test(input)) {
    return { url: 'file://' + input.split('/').map(encodeURIComponent).join('/'), type: 'url' };
  }

  // Bare internal page names like "vexa:settings"
  const internal = lower.match(/^vexa:\/{0,2}([a-z]+)\/?(.*)$/);
  if (internal) {
    return { url: `vexa://${internal[1]}/${internal[2] || ''}`, type: 'url' };
  }

  if (!/\s/.test(input)) {
    const scheme = (lower.match(/^[a-z][a-z0-9+.-]*:/) || [''])[0];
    if (scheme && PASSTHROUGH_SCHEMES.includes(scheme)) {
      // "localhost:3000" also matches the scheme regex — handled below.
      if (scheme !== 'localhost:') {
        try {
          // Validate http(s) URLs actually parse.
          const u = new URL(input);
          if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.hostname) throw new Error('no host');
          return { url: u.href, type: 'url' };
        } catch {
          return { url: searchUrl(input, engineId), type: 'search' };
        }
      }
    }

    // host[:port][/path...]
    const m = input.match(/^([^/?#:]+|\[[0-9a-f:]+\])(:\d{1,5})?([/?#].*)?$/i);
    if (m) {
      const host = m[1].toLowerCase();
      if (looksLikeHost(host)) {
        const isLocal = host === 'localhost' || isIPv4(host) || host.startsWith('[') || host.endsWith('.local') || host.endsWith('.localhost');
        const proto = isLocal ? 'http://' : 'https://';
        try {
          return { url: new URL(proto + input).href, type: 'url' };
        } catch {
          /* fall through to search */
        }
      }
    }
  }

  return { url: searchUrl(input, engineId), type: 'search' };
}

/** URL shown to the user in the address bar. */
function displayUrl(url) {
  if (!url) return '';
  if (url === NEWTAB_URL || url === 'vexa://newtab' || url === 'about:blank') return '';
  return url;
}

function isInternal(url) {
  return typeof url === 'string' && url.startsWith('vexa://');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}

// Minimal multi-part public suffix list. Not the full PSL — good enough to
// keep e.g. "a.co.uk" and "b.co.uk" from being treated as the same site.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'com.br', 'net.br', 'org.br',
  'com.cn', 'net.cn', 'org.cn', 'com.tw', 'com.hk', 'com.sg', 'com.my', 'co.in', 'net.in', 'org.in',
  'co.za', 'com.mx', 'com.ar', 'com.tr', 'co.il', 'com.ua', 'co.id', 'com.ph', 'com.vn', 'com.eg',
  'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com'
]);

/** Approximate registrable domain ("eTLD+1") for third-party checks. */
function siteOf(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || isIPv4(host) || host.startsWith('[') || !host.includes('.')) return host;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  const lastThree = labels.slice(-3).join('.');
  if (MULTI_PART_SUFFIXES.has(lastThree) && labels.length >= 4) return labels.slice(-4).join('.');
  return lastTwo;
}

module.exports = {
  SEARCH_ENGINES,
  INTERNAL_PAGES,
  NEWTAB_URL,
  resolveInput,
  searchUrl,
  displayUrl,
  isInternal,
  hostOf,
  originOf,
  siteOf,
  looksLikeHost
};
