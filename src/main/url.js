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

/**
 * Google's account / sign-in hosts (accounts.google.com, regional accounts.google.co.uk…,
 * accounts.youtube.com). Google's anti-abuse checks run here, so Vexa leaves the page's
 * environment untouched on these hosts (no fingerprinting noise). See docs/COMPATIBILITY.md.
 */
const GOOGLE_ACCOUNTS_HOST = /^accounts\.(google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})|youtube\.com)$/i;
function isGoogleAccountsHost(host) {
  return GOOGLE_ACCOUNTS_HOST.test(String(host || ''));
}

/**
 * Chrome compatibility mode: add the "Google Chrome" brand to a brand list that Chromium
 * itself produced, right after "Chromium" and with Chromium's own version. Chromium's GREASE
 * entry (e.g. "Not:A-Brand";v="8") and order are kept exactly, so the result is always
 * Chromium's real list plus one entry — never a hand-written list no browser sends.
 * Works for `navigator.userAgentData.brands` / `fullVersionList` shaped arrays.
 */
function withChromeBrand(list) {
  if (!Array.isArray(list)) return list;
  if (list.some((b) => b && b.brand === 'Google Chrome')) return list;
  const i = list.findIndex((b) => b && b.brand === 'Chromium');
  if (i < 0) return list;
  const out = list.map((b) => ({ brand: b.brand, version: b.version }));
  out.splice(i + 1, 0, { brand: 'Google Chrome', version: list[i].version });
  return out;
}

/**
 * Chromium's own brand list for a version, the same one `navigator.userAgentData.brands`
 * reports: Chromium plus a "GREASE" brand that varies by major version (Chromium's
 * GenerateBrandVersionList in components/embedder_support/user_agent_utils.cc).
 * For Chromium 156: [{ "Not:A-Brand", "8" }, { "Chromium", "156" }]. `full` = full versions,
 * as in `fullVersionList`.
 */
const GREASEY_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASED_VERSIONS = ['8', '99', '24'];
function chromiumBrands(chromeVersion, { full = false } = {}) {
  const fullVersion = String(chromeVersion || '');
  const major = parseInt(fullVersion, 10);
  if (!Number.isFinite(major) || major <= 0) return [];
  const n = GREASEY_CHARS.length;
  const grease = { brand: `Not${GREASEY_CHARS[major % n]}A${GREASEY_CHARS[(major + 1) % n]}Brand`, version: GREASED_VERSIONS[major % GREASED_VERSIONS.length] };
  const chromium = { brand: 'Chromium', version: full ? fullVersion : String(major) };
  if (full) grease.version += '.0.0.0';
  return major % 2 === 0 ? [grease, chromium] : [chromium, grease];
}

/** Serialize a brand list as a Sec-CH-UA structured header. */
function brandHeader(list) {
  return list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

/**
 * The three low-entropy User-Agent Client Hints every Chromium browser sends to secure
 * origins by default. Electron 45 doesn't send them at all (checked against a local server
 * and a live HTTPS site), although its JavaScript reports the same values — a mismatch real
 * browsers never have. Vexa adds Chromium's own, honest values.
 */
const CH_PLATFORMS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', freebsd: 'FreeBSD', openbsd: 'OpenBSD' };
function lowEntropyClientHints(chromeVersion, platform) {
  const brands = chromiumBrands(chromeVersion);
  if (!brands.length) return {};
  return { 'sec-ch-ua': brandHeader(brands), 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': `"${CH_PLATFORMS[platform] || 'Unknown'}"` };
}

/** Requests that get client hints: secure origins (https/wss, and localhost, as in Chromium). */
function sendsClientHints(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
    return (u.protocol === 'http:' || u.protocol === 'ws:') && (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

/** Parse a Sec-CH-UA style header (`"A";v="1", "B";v="2"`) into [{ brand, version }], or null. */
function parseBrandHeader(value) {
  const out = [];
  const re = /\s*"((?:[^"\\]|\\.)*)"\s*;\s*v\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:,|$)/y;
  const s = String(value || '');
  let m;
  while (re.lastIndex < s.length && (m = re.exec(s))) out.push({ brand: m[1], version: m[2] });
  return out.length && re.lastIndex >= s.trimEnd().length ? out : null;
}

/**
 * The same for a Sec-CH-UA / Sec-CH-UA-Full-Version-List header value that Chromium sent.
 * Returns the value unchanged when it can't be parsed or has no "Chromium" entry.
 */
function withChromeBrandHeader(value) {
  const list = parseBrandHeader(value);
  if (!list) return value;
  const next = withChromeBrand(list);
  if (next === list) return value;
  return brandHeader(next);
}

/** Title for a popup window: the page's host first (it can't be faked by the page), then its title. */
function popupTitle(url, title) {
  let host = '';
  try {
    const u = new URL(url);
    host = /^https?:$/.test(u.protocol) ? u.host : '';
  } catch {
    /* about:blank and the like */
  }
  const t = String(title || '').trim();
  if (!host) return t || 'Vexa';
  return t && t !== url && t !== host ? `${host} — ${t}` : host;
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
  isGoogleAccountsHost,
  withChromeBrand,
  withChromeBrandHeader,
  parseBrandHeader,
  chromiumBrands,
  brandHeader,
  lowEntropyClientHints,
  sendsClientHints,
  popupTitle,
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
