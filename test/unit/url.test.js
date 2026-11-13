'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveInput, siteOf, displayUrl } = require('../../src/main/url');

const r = (s) => resolveInput(s, 'duckduckgo');

test('full URLs pass through', () => {
  assert.deepStrictEqual(r('https://example.com/a?b=1'), { url: 'https://example.com/a?b=1', type: 'url' });
  assert.strictEqual(r('http://example.com').url, 'http://example.com/');
  assert.strictEqual(r('file:///C:/x.html').type, 'url');
  assert.strictEqual(r('about:blank').url, 'about:blank');
});

test('bare domains get https', () => {
  assert.strictEqual(r('example.com').url, 'https://example.com/');
  assert.strictEqual(r('news.ycombinator.com/item?id=1').url, 'https://news.ycombinator.com/item?id=1');
  assert.strictEqual(r('sub.domain.co.uk').url, 'https://sub.domain.co.uk/');
  assert.strictEqual(r('example.com:8443/x').url, 'https://example.com:8443/x');
});

test('local addresses get http', () => {
  assert.strictEqual(r('localhost').url, 'http://localhost/');
  assert.strictEqual(r('localhost:3000/app').url, 'http://localhost:3000/app');
  assert.strictEqual(r('127.0.0.1:8080').url, 'http://127.0.0.1:8080/');
  assert.strictEqual(r('192.168.1.1').url, 'http://192.168.1.1/');
  assert.strictEqual(r('printer.local').url, 'http://printer.local/');
});

test('queries become searches', () => {
  assert.deepStrictEqual(r('how do rockets work'), { url: 'https://duckduckgo.com/?q=how%20do%20rockets%20work', type: 'search' });
  assert.strictEqual(r('electron').type, 'search');
  assert.strictEqual(r('node.js tutorial').type, 'search');
  assert.strictEqual(r('what is 2+2?').type, 'search');
  assert.strictEqual(r('1.5').type, 'search');
  assert.strictEqual(r('c++').type, 'search');
  assert.ok(resolveInput('cats', 'google').url.startsWith('https://www.google.com/search?q=cats'));
});

test('internal pages', () => {
  assert.strictEqual(r('vexa://settings').url, 'vexa://settings/');
  assert.strictEqual(r('vexa:history').url, 'vexa://history/');
});

test('javascript: is blocked, empty is empty', () => {
  assert.strictEqual(r('javascript:alert(1)').type, 'blocked');
  assert.strictEqual(r('   ').type, 'empty');
});

test('windows paths become file URLs', () => {
  assert.strictEqual(r('C:\\Users\\me\\page.html').url, 'file:///C:/Users/me/page.html');
});

test('siteOf approximates registrable domains', () => {
  assert.strictEqual(siteOf('www.example.com'), 'example.com');
  assert.strictEqual(siteOf('a.b.example.co.uk'), 'example.co.uk');
  assert.strictEqual(siteOf('user.github.io'), 'user.github.io');
  assert.strictEqual(siteOf('127.0.0.1'), '127.0.0.1');
  assert.strictEqual(siteOf('localhost'), 'localhost');
});

test('displayUrl hides the new tab page', () => {
  assert.strictEqual(displayUrl('vexa://newtab/'), '');
  assert.strictEqual(displayUrl('https://a.com/'), 'https://a.com/');
});

test('siteOf uses the full Public Suffix List', () => {
  assert.strictEqual(siteOf('a.b.c.example.com.au'), 'example.com.au');
  assert.strictEqual(siteOf('foo.bar.kobe.jp'), 'foo.bar.kobe.jp'); // wildcard rule *.kobe.jp
  assert.strictEqual(siteOf('city.kobe.jp'), 'city.kobe.jp'); // exception rule !city.kobe.jp
  assert.strictEqual(siteOf('x.myshopify.com'), 'x.myshopify.com'); // private suffix
  assert.strictEqual(siteOf('co.uk'), 'co.uk');
  assert.strictEqual(siteOf('sub.example.xyz'), 'example.xyz');
});

test('Vexa Search (beta) is a selectable engine served at vexa://search', () => {
  const { SEARCH_ENGINES, searchUrl, isInternal } = require('../../src/main/url');
  assert.ok(SEARCH_ENGINES.vexa && SEARCH_ENGINES.vexa.beta);
  assert.match(SEARCH_ENGINES.vexa.name, /Beta/);
  assert.equal(searchUrl('rust & go', 'vexa'), 'vexa://search/?q=rust%20%26%20go');
  assert.equal(resolveInput('open world games', 'vexa').url, 'vexa://search/?q=open%20world%20games');
  assert.ok(isInternal('vexa://search/?q=x'));
});
