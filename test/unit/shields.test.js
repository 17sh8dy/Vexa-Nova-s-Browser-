'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rules = require('../../src/main/shields-rules');
const { sniff } = require('../../src/main/image-type');

test('classify: ad networks, trackers and fingerprinters', () => {
  assert.strictEqual(rules.classify('https://securepubads.g.doubleclick.net/tag/js/gpt.js'), 'ads');
  assert.strictEqual(rules.classify('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'), 'ads');
  assert.strictEqual(rules.classify('https://www.google-analytics.com/analytics.js'), 'trackers');
  assert.strictEqual(rules.classify('https://www.googletagmanager.com/gtag/js?id=G-1'), 'trackers');
  assert.strictEqual(rules.classify('https://static.hotjar.com/c/hotjar-1.js'), 'trackers');
  assert.strictEqual(rules.classify('https://fpjs.io/v3/abc'), 'fingerprinting');
  assert.strictEqual(rules.classify('wss://x.hotjar.com/socket'), 'trackers');
});

test('classify: path rules only match their path', () => {
  assert.strictEqual(rules.classify('https://connect.facebook.net/en_US/fbevents.js'), 'trackers');
  assert.strictEqual(rules.classify('https://connect.facebook.net/en_US/sdk.js'), null); // Facebook login SDK keeps working
  assert.strictEqual(rules.classify('https://www.facebook.com/tr?id=1&ev=PageView'), 'trackers');
  assert.strictEqual(rules.classify('https://www.facebook.com/login'), null);
});

test('classify: ordinary sites are left alone', () => {
  for (const u of ['https://example.com/', 'https://www.google.com/search?q=x', 'https://accounts.google.com/', 'https://cdn.jsdelivr.net/npm/x', 'https://notdoubleclick.net/', 'https://doubleclick.net.example.com/', 'vexa://newtab/', 'not a url']) {
    assert.strictEqual(rules.classify(u), null, u);
  }
});

test('suffix matching is label-based', () => {
  assert.deepStrictEqual(rules.suffixes('a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com']);
});

test('malicious hosts: shipped list loads, matches subdomains, never blocks platform roots', () => {
  const set = rules.maliciousHosts();
  assert.ok(set.size > 1000, `list has ${set.size} hosts`);
  const sample = [...set][Math.floor(set.size / 2)];
  assert.ok(rules.isMaliciousHost(sample));
  assert.ok(rules.isMaliciousHost('deep.sub.' + sample));
  for (const h of ['google.com', 'github.io', 'pages.dev', 'workers.dev', 'vexa.shadylabs.workers.dev', 'example.com', 'wikipedia.org']) {
    assert.strictEqual(rules.isMaliciousHost(h), false, h);
  }
});

test('tracking parameters are removed, everything else is kept byte for byte', () => {
  assert.deepStrictEqual(rules.stripTrackingParams('https://shop.example/item?id=7&utm_source=news&utm_medium=email&fbclid=AbC'), { url: 'https://shop.example/item?id=7', removed: 3 });
  assert.deepStrictEqual(rules.stripTrackingParams('https://x.example/?gclid=1'), { url: 'https://x.example/', removed: 1 });
  assert.strictEqual(rules.stripTrackingParams('https://x.example/p?q=a%20b&sort=new#frag').removed, 0);
  assert.strictEqual(rules.stripTrackingParams('https://x.example/p?q=a+b&utm_campaign=z#top').url, 'https://x.example/p?q=a+b#top');
  assert.strictEqual(rules.stripTrackingParams('https://x.example/?UTM_Source=caps').removed, 1);
  assert.strictEqual(rules.stripTrackingParams('vexa://newtab/?utm_source=x').removed, 0);
  // "source" and "ref" are real parameters on many sites: kept.
  assert.strictEqual(rules.stripTrackingParams('https://x.example/?source=home&ref=main').removed, 0);
});

test('HTTPS upgrade: public hosts on the default port only', () => {
  assert.strictEqual(rules.httpsUpgradeCandidate('http://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(rules.httpsUpgradeCandidate('http://news.example.co.uk/'), 'https://news.example.co.uk/');
  for (const u of ['https://example.com/', 'http://example.com:8080/', 'http://localhost/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'http://printer.local/', 'http://router/', 'http://nas.lan/', 'http://site.test/', 'http://x.home.arpa/', 'ftp://example.com/']) {
    assert.strictEqual(rules.httpsUpgradeCandidate(u), null, u);
  }
});

test('protections list', () => {
  assert.deepStrictEqual(rules.PROTECTIONS, ['ads', 'trackers', 'cookies', 'fingerprinting', 'https', 'malicious', 'params', 'popups']);
});

test('wallpaper uploads are recognised by their bytes, not their name', () => {
  assert.strictEqual(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.strictEqual(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
  assert.strictEqual(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp');
  assert.strictEqual(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.strictEqual(sniff(Buffer.from('GIF89a......')), null);
  assert.strictEqual(sniff(Buffer.alloc(0)), null);
});
