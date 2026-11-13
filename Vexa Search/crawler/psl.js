'use strict';
// Public Suffix List lookup (https://publicsuffix.org). Pure Node, no Electron.
// The list lives in data/public_suffix_list.dat (comments stripped) and is parsed
// once, on first use. Used to find a host's registrable domain ("eTLD+1").

const fs = require('fs');
const path = require('path');

let rules = null; // { normal:Set, wildcard:Set, exception:Set }

function load() {
  rules = { normal: new Set(), wildcard: new Set(), exception: new Set() };
  let text = '';
  try {
    text = fs.readFileSync(path.join(__dirname, 'data', 'public_suffix_list.dat'), 'utf8');
  } catch {
    return; // falls back to "last two labels"
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().split(/\s/)[0];
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('!')) rules.exception.add(line.slice(1));
    else if (line.startsWith('*.')) rules.wildcard.add(line.slice(2));
    else rules.normal.add(line);
  }
}

/** Number of labels in the public suffix of `labels` (already lower-cased). */
function suffixLength(labels) {
  if (!rules) load();
  // Longest matching rule wins; exception rules beat everything and drop one label.
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (rules.exception.has(candidate)) return labels.length - i - 1;
  }
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    const len = labels.length - i;
    if (rules.normal.has(candidate)) return len;
    if (len > 1 && rules.wildcard.has(labels.slice(i + 1).join('.'))) return len;
  }
  return 1; // unknown TLD: the default rule is "*"
}

/** Registrable domain of a hostname, or the hostname itself when it has none (IPs, localhost, bare suffixes). */
function registrableDomain(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.') || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split('.');
  const n = suffixLength(labels);
  if (labels.length <= n) return host; // the host *is* a public suffix
  return labels.slice(-(n + 1)).join('.');
}

module.exports = { registrableDomain };
