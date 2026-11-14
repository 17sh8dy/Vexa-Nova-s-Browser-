'use strict';
// Refresh Vexa Shields' malicious-site list (phishing + scam hosts).
// Run before a release:  node scripts/update-shield-lists.js
// Vexa itself never downloads lists at run time; it ships the snapshot written here.
//
// Source: The Block List Project (https://github.com/blocklistproject/Lists), released into
// the public domain (Unlicense; the list headers say MIT). Its multi-million-entry malware
// list is too large to ship, so Vexa uses the phishing and scam lists.

const fs = require('fs');
const path = require('path');
const { registrableDomain } = require('../src/main/psl');

const SOURCES = [
  'https://raw.githubusercontent.com/blocklistproject/Lists/master/phishing.txt',
  'https://raw.githubusercontent.com/blocklistproject/Lists/master/scam.txt'
];
const OUT = path.join(__dirname, '..', 'src', 'main', 'data', 'shields', 'malicious-hosts.txt');

// Never block these sites as a whole, whatever a list says: a false positive here would
// take out a large part of the web (or Nova's own sites). Subdomains listed individually
// (e.g. someone's phishing page on a hosting platform) are still blocked.
const NEVER_WHOLE = new Set([
  'google.com', 'youtube.com', 'gmail.com', 'microsoft.com', 'live.com', 'outlook.com', 'office.com',
  'apple.com', 'icloud.com', 'amazon.com', 'facebook.com', 'instagram.com', 'whatsapp.com', 'x.com',
  'twitter.com', 'linkedin.com', 'github.com', 'github.io', 'gitlab.io', 'wikipedia.org', 'reddit.com',
  'discord.com', 'discord.gg', 'paypal.com', 'netflix.com', 'yahoo.com', 'bing.com', 'duckduckgo.com',
  'cloudflare.com', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'web.app', 'firebaseapp.com',
  'blogspot.com', 'wordpress.com', 'weebly.com', 'weeblysite.com', 'wixsite.com', '000webhostapp.com',
  'herokuapp.com', 'glitch.me', 'repl.co', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com',
  'googleusercontent.com', 'appspot.com', 'godaddysites.com', 'square.site', 'webflow.io', 'framer.app',
  'notion.site', 'shadylabs.workers.dev'
]);

function parseHosts(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const host = t.split(/\s+/).pop().toLowerCase().replace(/\.$/, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) out.push(host); // hostnames only, no IPs
  }
  return out;
}

async function main() {
  const hosts = new Set();
  let dropped = 0;
  for (const url of SOURCES) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    for (const host of parseHosts(await res.text())) {
      // A bare public suffix (e.g. "pages.dev": "x.pages.dev" is its own site) or a
      // protected site as a whole is never blocked.
      const isPublicSuffix = registrableDomain('x.' + host) === 'x.' + host;
      if (isPublicSuffix || NEVER_WHOLE.has(host)) {
        dropped++;
        continue;
      }
      hosts.add(host);
    }
  }
  if (hosts.size < 1000) throw new Error(`Only ${hosts.size} hosts parsed; refusing to overwrite the list`);
  const header = [
    '# Vexa Shields malicious-site list (phishing and scam hosts)',
    '# Source: The Block List Project, https://github.com/blocklistproject/Lists (public domain / MIT)',
    `# Snapshot: ${new Date().toISOString().slice(0, 10)}, ${hosts.size} hosts (${dropped} protected entries dropped)`,
    ''
  ].join('\n');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header + [...hosts].sort().join('\n') + '\n');
  console.log(`Wrote ${hosts.size} hosts (${dropped} dropped) to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
