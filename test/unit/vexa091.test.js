'use strict';
// Unit tests for Vexa 0.91: Google sign-in compatibility (brand lists derived from Chromium's
// own, header rewriting, the sign-in page fingerprinting exemption, popup titles) and the
// New Tab defaults migration.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

// settings.js / shields.js only need Electron for app.getPath(); give them a stand-in.
let userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vexa091-'));
const fakeElectron = { app: { getPath: () => userData, getName: () => 'Vexa' } };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const url = require('../../src/main/url');
const ntpDefaults = require('../../src/main/ntp-defaults');

// What Chromium 156 (Electron 45.2.3) actually reports, captured from the bundled Electron.
const REAL_BRANDS = [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }];
const REAL_FULL = [{ brand: 'Not:A-Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: '156.0.8078.80' }];

test('withChromeBrand keeps Chromium\'s GREASE entry and order, adds one entry', () => {
  assert.deepStrictEqual(url.withChromeBrand(REAL_BRANDS), [
    { brand: 'Not:A-Brand', version: '8' },
    { brand: 'Chromium', version: '156' },
    { brand: 'Google Chrome', version: '156' }
  ]);
  assert.deepStrictEqual(url.withChromeBrand(REAL_FULL)[2], { brand: 'Google Chrome', version: '156.0.8078.80' });
  // Already branded, or no Chromium entry: unchanged (same object).
  const branded = url.withChromeBrand(REAL_BRANDS);
  assert.strictEqual(url.withChromeBrand(branded), branded);
  const other = [{ brand: 'Foo', version: '1' }];
  assert.strictEqual(url.withChromeBrand(other), other);
  assert.strictEqual(url.withChromeBrand(null), null);
  // The input is never mutated.
  assert.strictEqual(REAL_BRANDS.length, 2);
});

test('chromiumBrands reproduces Chromium\'s own GREASE brand list', () => {
  // The captured Chromium 156 values, and published values for older Chrome versions.
  assert.deepStrictEqual(url.chromiumBrands('156.0.8078.80'), REAL_BRANDS);
  assert.deepStrictEqual(url.chromiumBrands('156.0.8078.80', { full: true }), REAL_FULL);
  assert.strictEqual(url.brandHeader(url.chromiumBrands('120.0.6099.71')), '"Not_A Brand";v="8", "Chromium";v="120"');
  assert.strictEqual(url.brandHeader(url.chromiumBrands('124.0.6367.60')), '"Not-A.Brand";v="99", "Chromium";v="124"');
  assert.strictEqual(url.brandHeader(url.chromiumBrands('131.0.6778.86')), '"Chromium";v="131", "Not_A Brand";v="24"');
  assert.deepStrictEqual(url.chromiumBrands(''), []);
});

test('low-entropy Client Hints: honest values, secure requests only', () => {
  assert.deepStrictEqual(url.lowEntropyClientHints('156.0.8078.80', 'win32'), {
    'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  });
  assert.strictEqual(url.lowEntropyClientHints('156.0.1', 'darwin')['sec-ch-ua-platform'], '"macOS"');
  assert.ok(!/Google Chrome/.test(url.lowEntropyClientHints('156.0.1', 'win32')['sec-ch-ua']), 'never the Chrome brand by default');
  for (const u of ['https://example.com/', 'wss://example.com/s', 'http://localhost:3000/', 'http://127.0.0.1:9/', 'http://app.localhost/']) assert.ok(url.sendsClientHints(u), u);
  for (const u of ['http://example.com/', 'ws://example.com/', 'http://localhost.example.com/', 'vexa://newtab/', 'file:///C:/x.html', 'nonsense']) assert.ok(!url.sendsClientHints(u), u);
});

test('withChromeBrandHeader rewrites only what Chromium sent', () => {
  assert.strictEqual(url.withChromeBrandHeader('"Not:A-Brand";v="8", "Chromium";v="156"'), '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"');
  assert.strictEqual(
    url.withChromeBrandHeader('"Not:A-Brand";v="8.0.0.0", "Chromium";v="156.0.8078.80"'),
    '"Not:A-Brand";v="8.0.0.0", "Chromium";v="156.0.8078.80", "Google Chrome";v="156.0.8078.80"'
  );
  // Chromium's order is whatever it chose; the Chrome brand follows "Chromium" wherever it is.
  assert.strictEqual(url.withChromeBrandHeader('"Chromium";v="157", "Not)A;Brand";v="24"'), '"Chromium";v="157", "Google Chrome";v="157", "Not)A;Brand";v="24"');
  // Unparseable or already-branded values pass through untouched.
  for (const v of ['', 'garbage', '"Chromium";v="156", "Google Chrome";v="156"', '"Chromium";v="156",,junk']) assert.strictEqual(url.withChromeBrandHeader(v), v);
  assert.strictEqual(url.parseBrandHeader('"A";v="1"').length, 1);
  assert.strictEqual(url.parseBrandHeader('"A";v="1" trailing'), null);
});

test('the old hand-written brand list is gone (it named a GREASE brand Chromium 156 never sends)', () => {
  const pre = fs.readFileSync(path.join(__dirname, '../../src/preload/internal.js'), 'utf8');
  const ses = fs.readFileSync(path.join(__dirname, '../../src/main/sessions.js'), 'utf8');
  for (const src of [pre, ses]) assert.ok(!src.includes('Not.A/Brand'), 'no hardcoded GREASE brand');
  assert.ok(!ses.includes('Object.assign(headers, googleBrandHeaders'), 'no headers added that Chromium did not send');
  // The page script no longer decides the host list itself: the main process does, per frame.
  assert.ok(!/google\\\.\[a-z\.\]\+\|youtube/.test(pre), 'no separate host regex in the preload');
});

test('preload addChromeBrand matches url.withChromeBrand on a NavigatorUAData-like object', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/preload/internal.js'), 'utf8');
  const m = /\r?\nfunction addChromeBrand\(\) \{[\s\S]*?\r?\n\}\r?\n/.exec(src);
  assert.ok(m, 'addChromeBrand found');
  class NavigatorUAData {
    get brands() {
      return Object.freeze(REAL_BRANDS.map((b) => Object.freeze({ ...b })));
    }
    getHighEntropyValues() {
      return Promise.resolve({ brands: this.brands, fullVersionList: REAL_FULL.map((b) => ({ ...b })), platform: 'Windows' });
    }
  }
  const ctx = { navigator: { userAgentData: new NavigatorUAData() }, Object, Array, Promise };
  vm.runInNewContext(m[0] + '\naddChromeBrand();', ctx);
  const brands = ctx.navigator.userAgentData.brands;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(brands)), url.withChromeBrand(REAL_BRANDS));
  assert.ok(Object.isFrozen(brands), 'frozen, like the real FrozenArray');
  const hev = await ctx.navigator.userAgentData.getHighEntropyValues(['fullVersionList']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(hev.fullVersionList)), url.withChromeBrand(REAL_FULL));
  assert.strictEqual(hev.platform, 'Windows', 'other values untouched');
});

test('Google account hosts are recognised narrowly', () => {
  for (const h of ['accounts.google.com', 'ACCOUNTS.GOOGLE.COM', 'accounts.google.co.uk', 'accounts.google.de', 'accounts.google.com.au', 'accounts.youtube.com']) assert.ok(url.isGoogleAccountsHost(h), h);
  for (const h of ['google.com', 'www.google.com', 'myaccount.google.com', 'accounts.google.com.evil.net', 'accounts.googlex.com', 'xaccounts.google.com', 'accounts.youtube.com.evil', '']) assert.ok(!url.isGoogleAccountsHost(h), h);
});

test('popup titles always start with the real host', () => {
  assert.strictEqual(url.popupTitle('https://accounts.google.com/v3/signin/identifier?x=1', 'Sign in - Google Accounts'), 'accounts.google.com — Sign in - Google Accounts');
  assert.strictEqual(url.popupTitle('https://evil.example/', 'accounts.google.com'), 'evil.example — accounts.google.com', 'a page cannot replace the host');
  assert.strictEqual(url.popupTitle('https://a.example:8443/', ''), 'a.example:8443');
  assert.strictEqual(url.popupTitle('https://a.example/', 'https://a.example/'), 'a.example');
  assert.strictEqual(url.popupTitle('about:blank', ''), 'Vexa');
});

test('fingerprinting protection is skipped on Google sign-in pages unless the user chose it for that site', () => {
  const { settings, DEFAULTS } = require('../../src/main/settings');
  const { shields } = require('../../src/main/shields');
  settings.store = { data: structuredClone(DEFAULTS), save() {}, file: path.join(userData, 'none.json') };
  const ses = {};
  assert.strictEqual(shields.pageConfig(ses, 'https://example.com/').fingerprinting, true, 'ordinary sites protected');
  assert.strictEqual(shields.pageConfig(ses, 'https://www.google.com/search?q=x').fingerprinting, true, 'Google Search itself is still protected');
  const g = shields.pageConfig(ses, 'https://accounts.google.com/v3/signin/identifier');
  assert.strictEqual(g.fingerprinting, false);
  assert.strictEqual(g.exempt, 'google-sign-in');
  // An explicit choice for google.com in the Shields panel wins.
  settings.store.data.shieldsSites = { 'google.com': { fingerprinting: true } };
  assert.strictEqual(shields.pageConfig(ses, 'https://accounts.google.com/').fingerprinting, true);
  // Fingerprinting off globally: off everywhere, as before.
  settings.store.data.shieldsSites = {};
  settings.store.data.shields = { ...settings.store.data.shields, fingerprinting: false };
  assert.strictEqual(shields.pageConfig(ses, 'https://example.com/').fingerprinting, false);
});

test('New Tab migration only touches layouts that were never customized', () => {
  const { migrateNewTab, NTP_DEFAULTS_VERSION, WIDGET_ORDER_090 } = ntpDefaults;
  const untouched = { wallpaper: { kind: 'gallery', id: 'tide' }, blur: 4, favorites: true, recent: false, collections: true, spaces: true, weather: false, layout: 'centered', order: [...WIDGET_ORDER_090] };
  assert.deepStrictEqual(migrateNewTab(untouched, undefined), { patch: { collections: false, spaces: false }, changed: true }, 'wallpaper changes are not widget customization');
  assert.deepStrictEqual(migrateNewTab({ blur: 3 }, undefined).patch, { collections: false, spaces: false }, 'missing keys count as 0.90 defaults');
  for (const custom of [{ ...untouched, spaces: false }, { ...untouched, collections: false }, { ...untouched, recent: true }, { ...untouched, layout: 'dashboard' }, { ...untouched, order: ['search', 'spaces', 'favorites', 'shortcuts', 'recent', 'collections', 'weather'] }]) {
    assert.deepStrictEqual(migrateNewTab(custom, undefined), { patch: {}, changed: false }, JSON.stringify(custom));
  }
  assert.deepStrictEqual(migrateNewTab(untouched, NTP_DEFAULTS_VERSION), { patch: {}, changed: false }, 'runs once');
  assert.deepStrictEqual(migrateNewTab(undefined, undefined), { patch: {}, changed: false }, 'nothing saved: defaults apply');
});

test('settings.init applies the New Tab migration once and keeps customized layouts', () => {
  const { settings, DEFAULTS } = require('../../src/main/settings');
  assert.strictEqual(DEFAULTS.newTab.collections, false);
  assert.strictEqual(DEFAULTS.newTab.spaces, false);
  assert.strictEqual(DEFAULTS.newTab.favorites, true, 'other widgets unchanged');
  const run = (saved) => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vexa091-'));
    if (saved) fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(saved));
    settings.init();
    return settings.get();
  };
  // Fresh profile.
  let s = run(null);
  assert.strictEqual(s.newTab.collections, false);
  assert.strictEqual(s.ntpDefaultsVersion, ntpDefaults.NTP_DEFAULTS_VERSION);
  // A 0.90 profile that never touched its widgets (as 0.90 saved it: full object).
  const v090 = { theme: 'dark', newTab: { ...structuredClone(DEFAULTS.newTab), collections: true, spaces: true, favoritesList: [{ title: 'A', url: 'https://a.example/' }] } };
  s = run(v090);
  assert.strictEqual(s.newTab.collections, false);
  assert.strictEqual(s.newTab.spaces, false);
  assert.deepStrictEqual(s.newTab.favoritesList, [{ title: 'A', url: 'https://a.example/' }], 'favorites kept');
  assert.strictEqual(s.theme, 'dark', 'other settings kept');
  // A 0.90 profile that customized its widgets keeps them.
  s = run({ newTab: { ...v090.newTab, recent: true } });
  assert.strictEqual(s.newTab.collections, true);
  assert.strictEqual(s.newTab.spaces, true);
  assert.strictEqual(s.newTab.recent, true);
  // After the migration ran, turning the boxes back on sticks.
  s = run({ ntpDefaultsVersion: ntpDefaults.NTP_DEFAULTS_VERSION, newTab: { ...v090.newTab } });
  assert.strictEqual(s.newTab.collections, true);
  assert.strictEqual(s.newTab.spaces, true);
});
