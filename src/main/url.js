'use strict';
// Address-bar input resolution and URL helpers. Pure functions (no Electron)
// so they can be unit-tested with plain Node.

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?query=%s' },
  // Nova's own engine, built into Vexa (see src/main/vexa-search.js). Beta.
  vexa: { name: 'Vexa Search (Beta)', url: 'vexa://search/?q=%s', beta: true }
};

const INTERNAL_PAGES = ['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'collections', 'reader'];

// Built-in address-bar scope filters: "@tabs foo" only looks through open tabs, etc.
const SCOPES = {
  tabs: 'Open tabs',
  bookmarks: 'Bookmarks',
  history: 'History',
  collections: 'Collections',
  spaces: 'Spaces'
};

/**
 * "@key rest" → { key, rest, kind: 'scope'|'engine', shortcut? }, or null.
 * `shortcuts` = [{ key, name, url }] (url contains %s).
 */
function parseKeyword(raw, shortcuts = []) {
  const m = /^@([a-z0-9]{1,12})(?:\s+([\s\S]*))?$/i.exec(String(raw || '').trimStart());
  if (!m) return null;
  const key = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  if (Object.hasOwn(SCOPES, key)) return { key, rest, kind: 'scope', name: SCOPES[key] };
  const shortcut = shortcuts.find((s) => s.key === key);
  return shortcut ? { key, rest, kind: 'engine', shortcut, name: shortcut.name } : null;
}

// Google's own hosts, where the optional Chrome-brand compatibility mode applies.
const GOOGLE_HOST = /(^|\.)(google\.[a-z.]+|youtube\.com|gstatic\.com|googleusercontent\.com)$/i;
function isGoogleHost(host) {
  return GOOGLE_HOST.test(String(host || ''));
}

/** "Sign in with Google" (Google Identity Services) endpoints that need the user's Google cookies when embedded. */
function isGoogleSignInUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'accounts.google.com' && (u.pathname.startsWith('/gsi/') || u.pathname.startsWith('/o/oauth2/'));
  } catch {
    return false;
  }
}

/** Client Hints brand headers for the Chrome compatibility mode. */
function googleBrandHeaders(chromeVersion) {
  const full = String(chromeVersion || '130.0.0.0');
  const major = full.split('.')[0];
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="99"`,
    'sec-ch-ua-full-version-list': `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not.A/Brand";v="99.0.0.0"`
  };
}

/** Fill a "%s" search template. */
function fillTemplate(template, query) {
  return template.replace('%s', encodeURIComponent(query));
}
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
function resolveInput(raw, engineId = 'duckduckgo', { shortcuts = null } = {}) {
  const input = String(raw || '').trim();
  if (!input) return { url: '', type: 'empty' };

  // Keyword shortcuts ("@g cats") and scope filters ("@tabs mail").
  if (shortcuts && input.startsWith('@')) {
    const kw = parseKeyword(input, shortcuts);
    if (kw && kw.kind === 'scope') return { url: '', type: 'scope', scope: kw.key, query: kw.rest };
    if (kw && kw.kind === 'engine') {
      if (!kw.rest) return { url: '', type: 'empty' };
      return { url: fillTemplate(kw.shortcut.url, kw.rest), type: 'search', query: kw.rest, engine: kw.key };
    }
  }

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
          return { url: searchUrl(input, engineId), type: 'search', query: input, engine: engineId };
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

  return { url: searchUrl(input, engineId), type: 'search', query: input, engine: engineId };
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

const { registrableDomain } = require('./psl');

/** Registrable domain ("eTLD+1") for third-party checks, using the Public Suffix List. */
function siteOf(hostname) {
  return registrableDomain(hostname);
}

module.exports = {
  SEARCH_ENGINES,
  INTERNAL_PAGES,
  NEWTAB_URL,
  SCOPES,
  isGoogleHost,
  isGoogleSignInUrl,
  googleBrandHeaders,
  parseKeyword,
  fillTemplate,
  resolveInput,
  searchUrl,
  displayUrl,
  isInternal,
  hostOf,
  originOf,
  siteOf,
  looksLikeHost
};
