'use strict';
// Content policy for the beta index.
// Vexa Search prioritises mainstream web content (technology, gaming,
// entertainment, education, news, general reference) and does not
// intentionally index adult / pornographic sites. This module decides,
// from cheap signals, whether a host or page is out of scope:
//   1. host on the blocklist (VexaBot/blocklist.txt, subdomains included)
//   2. adult-only TLDs (.xxx .adult .porn .sex)
//   3. self-labelled adult pages: RTA label or <meta name="rating" content="adult|mature">
//   4. explicit-term density in the URL host, title and description
// Out-of-scope pages are recorded as `blocked` (with the reason) and never
// indexed, and their links are not followed.

const fs = require('node:fs');
const path = require('node:path');

const ADULT_TLDS = new Set(['xxx', 'adult', 'porn', 'sex']);
const RTA_LABEL = 'rta-5042-1996-1400-1577-rta';
// Kept short on purpose: unambiguous terms only, so ordinary pages
// (medicine, biology, news) are not caught.
const EXPLICIT_TERMS = ['porn', 'porno', 'xxx', 'hentai', 'nsfw', 'camgirl', 'camgirls', 'sexcam', 'milf', 'onlyfans', 'nude', 'nudes'];
// Stricter subset for host names (a brand called "nude" exists; these words don't).
const HOST_TERMS = ['porn', 'porno', 'xxx', 'hentai', 'nsfw', 'sexcam', 'camgirls'];

function loadBlocklist(file = path.join(__dirname, 'blocklist.txt')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Set(); }
  return new Set(text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim().toLowerCase()).filter(Boolean));
}

const BLOCKLIST = loadBlocklist();

function hostBlockReason(host, blocklist = BLOCKLIST) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  const tld = h.split('.').pop();
  if (ADULT_TLDS.has(tld)) return `adult TLD .${tld}`;
  const labels = h.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join('.');
    if (blocklist.has(suffix)) return `blocklisted host ${suffix}`;
  }
  // Host names made of explicit words, e.g. "freeporn-videos.example".
  const words = h.split(/[^a-z0-9]+/);
  if (words.some((w) => HOST_TERMS.includes(w)) || /porn|hentai/.test(h)) return 'explicit host name';
  return null;
}

function pageBlockReason(page) {
  const rating = (page.rating || '').toLowerCase();
  if (rating.includes(RTA_LABEL)) return 'RTA adult label';
  if (/\b(adult|mature|restricted)\b/.test(rating)) return `rating meta "${page.rating}"`;
  const text = `${page.title || ''} ${page.description || ''}`.toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const hits = words.filter((w) => EXPLICIT_TERMS.includes(w)).length;
  if (hits >= 2) return 'explicit title/description';
  return null;
}

module.exports = { hostBlockReason, pageBlockReason, loadBlocklist, EXPLICIT_TERMS };
