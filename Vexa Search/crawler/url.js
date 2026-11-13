'use strict';
// URL normalisation so one page is one document, plus the checks that keep
// the crawler on ordinary web pages.

const net = require('node:net');
const { registrableDomain } = require('./psl');

// Query parameters that only track the visit; dropping them merges duplicates.
const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|igshid|ref_src|_hsenc|_hsmi|yclid)$/i;

// File types we will never parse as HTML; skip without fetching.
const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4[av]|webm|mkv|avi|mov|wav|ogg|flac|zip|rar|7z|gz|tgz|bz2|xz|tar|exe|msi|dmg|pkg|deb|rpm|apk|iso|bin|pdf|docx?|xlsx?|pptx?|odt|csv|json|xml|rss|atom|css|js|mjs|woff2?|ttf|otf|eot|wasm)$/i;

function normalizeUrl(input, base) {
  let u;
  try { u = base ? new URL(input, base) : new URL(input); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  // Drop tracking params and sort the rest for a stable key.
  const kept = [...u.searchParams].filter(([k]) => !TRACKING_PARAMS.test(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = kept.length ? '?' + new URLSearchParams(kept).toString() : '';
  // Collapse duplicate slashes in the path; resolve dot segments (URL does that).
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  const s = u.toString();
  return s.length > 2048 ? null : s;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// The site a URL belongs to: its registrable domain (en.wikipedia.org and
// de.wikipedia.org are one site, run by one organisation on shared servers).
function siteOf(url) {
  try { return registrableDomain(new URL(url).hostname); } catch { return ''; }
}

function looksLikeFile(url) {
  try { return SKIP_EXT.test(new URL(url).pathname); } catch { return true; }
}

// Loopback, private, link-local, CGNAT, multicast and reserved ranges.
function isPrivateAddress(addr) {
  const a = addr.replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || p >= 224 ||
      (p === 100 && q >= 64 && q <= 127) ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 198 && (q === 18 || q === 19));
  }
  if (net.isIPv6(a)) {
    const x = a.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return false;
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return isPrivateAddress(h);
}

module.exports = { normalizeUrl, hostOf, hostnameOf, siteOf, looksLikeFile, isPrivateAddress, isPrivateHostname };
