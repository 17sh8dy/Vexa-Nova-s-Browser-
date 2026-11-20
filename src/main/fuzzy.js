'use strict';
// Fuzzy matching for the Command Center. Pure (no Electron), unit tested.

const strip = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const isBoundary = (t, i) => i === 0 || /[\s\-_/.:@#(]/.test(t[i - 1]);

/** Score one query token against text. 0 = no match; higher is better. */
function tokenScore(q, t) {
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - Math.min(200, t.length - q.length);
  const at = t.indexOf(q);
  if (at >= 0) return (isBoundary(t, at) ? 760 : 620) - Math.min(150, at * 2);
  // Subsequence: every query character, in order, with bonuses for word starts and runs.
  let ti = 0;
  let score = 0;
  let run = 0;
  let gaps = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    // Prefer the next occurrence that starts a word.
    for (let j = ti; j < t.length; j++) {
      if (t[j] !== c) continue;
      if (found < 0) found = j;
      if (isBoundary(t, j) && j - ti < 12) {
        found = j;
        break;
      }
    }
    if (found < 0) return 0;
    if (found === ti && qi > 0) run++;
    else run = 0;
    gaps += found - ti;
    score += 10 + (isBoundary(t, found) ? 14 : 0) + run * 8;
    ti = found + 1;
  }
  // Too scattered to be meaningful.
  if (gaps > q.length * 6 + 10) return 0;
  return Math.max(1, 200 + score - gaps * 1.5 - (t.length - q.length) * 0.2);
}

/**
 * Score a query against one or more fields (the best field wins; the first field counts most).
 * Multi-word queries: every word has to match somewhere.
 */
function score(query, ...fields) {
  const words = strip(query).trim().split(/\s+/).filter(Boolean);
  const texts = fields.map(strip).filter(Boolean);
  if (!words.length) return 1;
  if (!texts.length) return 0;
  const whole = strip(query).trim();
  // The whole query as one phrase first (exact / prefix of a field).
  let best = 0;
  texts.forEach((t, i) => {
    const s = tokenScore(whole, t) * (i === 0 ? 1 : 0.85);
    if (s > best) best = s;
  });
  if (words.length === 1) return best;
  let total = 0;
  for (const w of words) {
    let wb = 0;
    texts.forEach((t, i) => {
      const s = tokenScore(w, t) * (i === 0 ? 1 : 0.85);
      if (s > wb) wb = s;
    });
    if (!wb) return best; // a word matched nowhere: only the phrase score counts
    total += wb;
  }
  return Math.max(best, total / words.length);
}

module.exports = { score, tokenScore, strip };
