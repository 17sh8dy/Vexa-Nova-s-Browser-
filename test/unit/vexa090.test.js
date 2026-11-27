'use strict';
// Unit tests for the pure 0.90 modules: keyword shortcuts, fuzzy matching, the Command
// Center phrase parser, Google compatibility helpers, and palette resolution.
const test = require('node:test');
const assert = require('node:assert');
const url = require('../../src/main/url');
const fuzzy = require('../../src/main/fuzzy');
const intents = require('../../src/main/intents');
const palettes = require('../../src/renderer/shared/palettes');

const SHORTCUTS = [
  { key: 'g', name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { key: 'vexa', name: 'Vexa Search', url: 'vexa://search/?q=%s' }
];

test('keyword shortcuts and scopes in the address bar', () => {
  assert.deepStrictEqual(url.resolveInput('@g cats and dogs', 'duckduckgo', { shortcuts: SHORTCUTS }), { url: 'https://www.google.com/search?q=cats%20and%20dogs', type: 'search', query: 'cats and dogs', engine: 'g' });
  assert.deepStrictEqual(url.resolveInput('@tabs mail', 'duckduckgo', { shortcuts: SHORTCUTS }), { url: '', type: 'scope', scope: 'tabs', query: 'mail' });
  assert.strictEqual(url.resolveInput('@g', 'duckduckgo', { shortcuts: SHORTCUTS }).type, 'empty');
  // An unknown keyword is just a search.
  assert.strictEqual(url.resolveInput('@nope hi', 'duckduckgo', { shortcuts: SHORTCUTS }).type, 'search');
  // Without shortcuts (older callers) nothing changes.
  assert.strictEqual(url.resolveInput('@g cats').engine, 'duckduckgo');
  assert.strictEqual(url.parseKeyword('@BOOKMARKS recipes', SHORTCUTS).kind, 'scope');
  assert.strictEqual(url.parseKeyword('hello @g', SHORTCUTS), null);
});

test('fuzzy matching ranks exact > prefix > word start > scattered', () => {
  const exact = fuzzy.score('reload', 'Reload');
  const prefix = fuzzy.score('rel', 'Reload page');
  const word = fuzzy.score('page', 'Reload page');
  const sub = fuzzy.score('rld', 'Reload page');
  assert.ok(exact > prefix && prefix > word && word > sub && sub > 0, [exact, prefix, word, sub].join(' '));
  assert.strictEqual(fuzzy.score('xyzzy', 'New tab'), 0);
  assert.ok(fuzzy.score('new priv', 'New private window') > 300, 'multi-word');
  assert.ok(fuzzy.score('cafe', 'Café opening hours') > 600, 'accents folded');
});

test('Command Center phrases become actions (no AI)', () => {
  const ctx = { spaces: [{ id: 'w1', name: 'Work' }], collections: [{ id: 'r1', name: 'Recipes' }], presets: [{ id: 'midnight', name: 'Midnight' }], sections: [{ hash: 'shields', name: 'Vexa Shields' }] };
  const first = (t) => intents.parse(t, ctx)[0]?.run;
  assert.deepStrictEqual(first('Switch to Work'), { kind: 'space', id: 'w1' });
  assert.deepStrictEqual(first('create a space called Gaming'), { kind: 'create-space', name: 'Gaming' });
  assert.deepStrictEqual(first('focus on thesis for 2 hours'), { kind: 'focus', name: 'thesis', minutes: 120 });
  assert.deepStrictEqual(first('save this page to recipes'), { kind: 'collect', collectionId: 'r1' });
  assert.deepStrictEqual(first('save this page to Reading'), { kind: 'collect-new', name: 'Reading' });
  assert.deepStrictEqual(first('apply midnight theme'), { kind: 'preset', id: 'midnight' });
  assert.deepStrictEqual(first('dark mode'), { kind: 'setting', key: 'theme', value: 'dark' });
  assert.deepStrictEqual(first('search lo-fi beats on youtube'), { kind: 'search', query: 'lo-fi beats', engine: 'yt' });
  assert.deepStrictEqual(first('close this tab'), { kind: 'action', action: 'close-tab' });
  assert.deepStrictEqual(first('end focus session'), { kind: 'action', action: 'focus-end' });
  assert.deepStrictEqual(first('open github.com'), { kind: 'open', input: 'github.com' });
  assert.deepStrictEqual(first('settings shields'), { kind: 'settings', hash: 'shields' });
  assert.strictEqual(intents.parse('switch to nowhere', ctx).length, 0);
});

test('Google compatibility helpers are narrow', () => {
  for (const h of ['accounts.google.com', 'www.google.co.uk', 'youtube.com', 'm.youtube.com', 'fonts.gstatic.com']) assert.ok(url.isGoogleHost(h), h);
  for (const h of ['googlex.com', 'xgoogle.com', 'youtube.com.evil.net', 'example.com', 'google-evil.net']) assert.ok(!url.isGoogleHost(h), h);
  assert.ok(url.isGoogleSignInUrl('https://accounts.google.com/gsi/button?x=1'));
  assert.ok(url.isGoogleSignInUrl('https://accounts.google.com/o/oauth2/iframe'));
  assert.ok(!url.isGoogleSignInUrl('http://accounts.google.com/gsi/button'), 'https only');
  assert.ok(!url.isGoogleSignInUrl('https://accounts.google.com/ServiceLogin'), 'not the sign-in page itself');
  assert.ok(!url.isGoogleSignInUrl('https://www.google-analytics.com/gsi/x'), 'other Google hosts are not exempt');
  // 0.91: the Chrome brand is added to Chromium's own header (see vexa091.test.js).
  assert.match(url.withChromeBrandHeader('"Not:A-Brand";v="8", "Chromium";v="156"'), /"Google Chrome";v="156"/);
});

test('Atmosphere palettes resolve to CSS variables', () => {
  assert.deepStrictEqual(palettes.resolve({ palette: 'vexa' }, true).vars, {}, 'Vexa = the stock theme');
  const cyber = palettes.resolve({ palette: 'cyber' }, false);
  assert.ok(cyber.dark && cyber.vars['--strip'] && cyber.vars['--accent'] === '#00e5d4', 'forced-dark palette with its own accent');
  const custom = palettes.resolve({ palette: 'vexa', accent: '#ff0000' }, true).vars;
  assert.strictEqual(custom['--accent'], '#ff0000');
  assert.match(custom['--accent-soft'], /^rgba\(255, 0, 0, /);
  assert.ok(custom['--accent-2'] && custom['--accent-text'], 'derived tokens');
  const minimalLight = palettes.resolve({ palette: 'minimal' }, false);
  assert.ok(!minimalLight.dark && minimalLight.vars['--toolbar'] === '#fbfbfb', 'minimal follows light mode');
});
