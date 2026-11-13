'use strict';
// The Porter stemming algorithm (M. F. Porter, 1980), implemented from the
// original paper. Maps "connection", "connected", "connecting" -> "connect".

function isCons(w, i) {
  const c = w[i];
  if ('aeiou'.includes(c)) return false;
  if (c === 'y') return i === 0 ? true : !isCons(w, i - 1);
  return true;
}

// m() = number of VC sequences in w[0..end).
function measure(w, end = w.length) {
  let n = 0;
  let i = 0;
  while (i < end && isCons(w, i)) i++;
  while (i < end) {
    while (i < end && !isCons(w, i)) i++;
    if (i >= end) break;
    n++;
    while (i < end && isCons(w, i)) i++;
  }
  return n;
}

function hasVowel(w, end = w.length) {
  for (let i = 0; i < end; i++) if (!isCons(w, i)) return true;
  return false;
}

function endsDoubleCons(w) {
  const n = w.length;
  return n >= 2 && w[n - 1] === w[n - 2] && isCons(w, n - 1);
}

// *o: stem ends cvc, where the final c is not w, x or y.
function endsCvc(w, end = w.length) {
  if (end < 3) return false;
  if (!isCons(w, end - 3) || isCons(w, end - 2) || !isCons(w, end - 1)) return false;
  return !'wxy'.includes(w[end - 1]);
}

// Replace suffix `s` by `r` if the stem before it has measure > minM.
function replaceIf(w, pairs, minM) {
  for (const [s, r] of pairs) {
    if (w.endsWith(s)) {
      const stemLen = w.length - s.length;
      return measure(w, stemLen) > minM ? w.slice(0, stemLen) + r : w;
    }
  }
  return w;
}

const STEP2 = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'],
  ['bli', 'ble'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'],
  ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'],
  ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'], ['logi', 'log']
].sort((a, b) => b[0].length - a[0].length);

const STEP3 = [
  ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']
].sort((a, b) => b[0].length - a[0].length);

const STEP4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent',
  'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'].sort((a, b) => b.length - a.length);

function stem(word) {
  let w = word;
  if (w.length <= 2) return w;

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('ss')) { /* keep */ }
  else if (w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b
  let extra = false;
  if (w.endsWith('eed')) {
    if (measure(w, w.length - 3) > 0) w = w.slice(0, -1);
  } else if (w.endsWith('ed') && hasVowel(w, w.length - 2)) {
    w = w.slice(0, -2); extra = true;
  } else if (w.endsWith('ing') && hasVowel(w, w.length - 3)) {
    w = w.slice(0, -3); extra = true;
  }
  if (extra) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
    else if (endsDoubleCons(w) && !'lsz'.includes(w[w.length - 1])) w = w.slice(0, -1);
    else if (measure(w) === 1 && endsCvc(w)) w += 'e';
  }

  // Step 1c
  if (w.endsWith('y') && hasVowel(w, w.length - 1)) w = w.slice(0, -1) + 'i';

  // Steps 2 and 3
  w = replaceIf(w, STEP2, 0);
  w = replaceIf(w, STEP3, 0);

  // Step 4
  for (const s of STEP4) {
    if (!w.endsWith(s)) continue;
    const stemLen = w.length - s.length;
    if (measure(w, stemLen) > 1) {
      if (s === 'ion') {
        const c = w[stemLen - 1];
        if (c === 's' || c === 't') w = w.slice(0, stemLen);
      } else {
        w = w.slice(0, stemLen);
      }
    }
    break;
  }

  // Step 5a
  if (w.endsWith('e')) {
    const m = measure(w, w.length - 1);
    if (m > 1 || (m === 1 && !endsCvc(w, w.length - 1))) w = w.slice(0, -1);
  }
  // Step 5b
  if (measure(w) > 1 && endsDoubleCons(w) && w.endsWith('l')) w = w.slice(0, -1);

  return w;
}

module.exports = { stem, measure };
