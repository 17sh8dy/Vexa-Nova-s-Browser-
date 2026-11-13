'use strict';
// robots.txt parser and matcher, written to RFC 9309.
//  - Groups start with one or more `user-agent` lines; rules follow.
//  - The group whose product token matches ours wins; otherwise `*`.
//    Several groups for the same agent are merged.
//  - Longest matching rule wins; on a tie, Allow wins.
//  - `*` matches any run of characters, a trailing `$` anchors the end.
//  - Crawl-delay and Sitemap are non-standard but widely used; we honour both.

const { TOKEN } = require('./identity');

function parseRobots(text, token = TOKEN) {
  const me = token.toLowerCase();
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;

  for (const raw of String(text || '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') { if (value) sitemaps.push(value); continue; }
    if (!current) continue; // rules before any user-agent line are ignored
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow means "allow everything"; it adds no rule.
      if (value === '') continue;
      current.rules.push({ allow: key === 'allow', pattern: value, re: compile(value), len: value.length });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }

  const exact = groups.filter((g) => g.agents.some((a) => a !== '*' && matchesAgent(a, me)));
  const chosen = exact.length ? exact : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.crawlDelay).filter((d) => d != null);
  return {
    rules,
    crawlDelay: delays.length ? Math.max(...delays) : null,
    sitemaps
  };
}

// RFC 9309: match the product token case-insensitively. We also accept
// user-agent lines like "VexaBot/0.1".
function matchesAgent(agentLine, me) {
  const name = agentLine.split('/')[0].trim();
  return name === me;
}

function compile(pattern) {
  let p = pattern;
  let anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const body = p.split('*').map(escapeRe).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

function escapeRe(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

// Normalise percent-encoding so /a%2fb style paths compare consistently.
function normalisePath(p) {
  try { return encodeURI(decodeURI(p)); } catch { return p; }
}

function isAllowed(robots, pathAndQuery) {
  if (!robots) return true;
  const path = normalisePath(pathAndQuery || '/');
  if (path === '/robots.txt') return true;
  let best = null;
  for (const r of robots.rules) {
    if (!r.re.test(path) && !r.re.test(pathAndQuery)) continue;
    if (!best || r.len > best.len || (r.len === best.len && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}

// What to do with an HTTP status for robots.txt (RFC 9309 §2.3.1).
//  2xx -> parse; 4xx -> no restrictions; 5xx / network error -> assume full disallow.
const ALLOW_ALL = { rules: [], crawlDelay: null, sitemaps: [] };
const DISALLOW_ALL = { rules: [{ allow: false, pattern: '/', re: /^\//, len: 1 }], crawlDelay: null, sitemaps: [] };

function robotsForStatus(status, body) {
  if (status >= 200 && status < 300) return parseRobots(body);
  if (status >= 400 && status < 500) return ALLOW_ALL;
  return DISALLOW_ALL;
}

module.exports = { parseRobots, isAllowed, robotsForStatus, ALLOW_ALL, DISALLOW_ALL };
