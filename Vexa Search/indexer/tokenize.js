'use strict';
// Text -> index terms. Lowercases, folds accents, splits on anything that is
// not a letter or digit, drops stopwords and stems English words.

const { stem } = require('./stem');

const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before
being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each
few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him
himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself
no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's
should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd
they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were
weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you
you'd you'll you're you've your yours yourself yourselves`.split(/\s+/).flatMap((w) => [w, w.replace(/'/g, '')]));

const MAX_TOKEN = 40;

function fold(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Raw word split (no stemming / stopword removal). Keeps letters and digits
// of every script; joins "don't" -> "dont", splits "e-mail" -> "e", "mail".
function words(text) {
  return fold(text).replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
}

function termOf(word) {
  if (word.length > MAX_TOKEN) return null;
  if (STOPWORDS.has(word)) return null;
  // Only stem plain ASCII words; numbers and other scripts stay as they are.
  return /^[a-z]+$/.test(word) ? stem(word) : word;
}

/** Terms with their positions in the word stream (stopwords keep a slot). */
function tokenize(text) {
  const out = [];
  const ws = words(text);
  for (let i = 0; i < ws.length; i++) {
    const t = termOf(ws[i]);
    if (t) out.push({ term: t, pos: i, word: ws[i] });
  }
  return { tokens: out, length: ws.length };
}

module.exports = { tokenize, words, termOf, fold, STOPWORDS };
