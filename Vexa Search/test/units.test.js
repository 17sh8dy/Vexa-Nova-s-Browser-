'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRobots, isAllowed, robotsForStatus } = require('../VexaBot/robots');
const { hostBlockReason, pageBlockReason } = require('../VexaBot/policy');
const { normalizeUrl, isPrivateAddress, isPrivateHostname, looksLikeFile, siteOf } = require('../crawler/url');
const { parseHtml, decodeEntities } = require('../crawler/html');
const { stem } = require('../indexer/stem');
const { tokenize } = require('../indexer/tokenize');
const { pagerank } = require('../indexer/pagerank');
const { parseQuery, damerau, crowd } = require('../indexer/search');

test('robots: specific group beats *, longest rule wins, Allow wins ties', () => {
  const r = parseRobots(`
User-agent: *
Disallow: /

User-agent: VexaBot
Disallow: /private
Allow: /private/public
Disallow: /*.php$
Crawl-delay: 2
Sitemap: https://x.test/sitemap.xml`);
  assert.equal(isAllowed(r, '/'), true);
  assert.equal(isAllowed(r, '/private/x'), false);
  assert.equal(isAllowed(r, '/private/public/page'), true);
  assert.equal(isAllowed(r, '/index.php'), false);
  assert.equal(isAllowed(r, '/index.php?x=1'), true);
  assert.equal(r.crawlDelay, 2);
  assert.deepEqual(r.sitemaps, ['https://x.test/sitemap.xml']);
});

test('robots: falls back to *, empty Disallow allows, agent with version matches', () => {
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /a'), '/a/b'), false);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), '/a'), true);
  assert.equal(isAllowed(parseRobots('User-agent: vexabot/0.1\nDisallow: /'), '/a'), false);
  assert.equal(isAllowed(parseRobots('User-agent: Googlebot\nDisallow: /'), '/a'), true);
  // grouped user-agents share the rules that follow
  assert.equal(isAllowed(parseRobots('User-agent: a\nUser-agent: VexaBot\nDisallow: /x'), '/x'), false);
  // tie: equal length allow/disallow -> allow
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /p\nAllow: /p'), '/p'), true);
});

test('robots: HTTP status handling per RFC 9309', () => {
  assert.equal(isAllowed(robotsForStatus(404, ''), '/anything'), true);
  assert.equal(isAllowed(robotsForStatus(503, ''), '/anything'), false);
  assert.equal(isAllowed(robotsForStatus(200, 'User-agent: *\nDisallow: /'), '/robots.txt'), true);
});

test('policy: blocks adult hosts and labelled pages, leaves ordinary ones', () => {
  assert.match(hostBlockReason('www.pornhub.com'), /blocklisted/);
  assert.match(hostBlockReason('something.xxx'), /TLD/);
  assert.match(hostBlockReason('free-porn-videos.example'), /explicit/);
  assert.equal(hostBlockReason('en.wikipedia.org'), null);
  assert.equal(hostBlockReason('essex.ac.uk'), null);
  assert.equal(hostBlockReason('middlesex.gov.uk'), null);
  assert.match(pageBlockReason({ rating: 'RTA-5042-1996-1400-1577-RTA' }), /RTA/);
  assert.match(pageBlockReason({ rating: 'adult' }), /rating/);
  assert.equal(pageBlockReason({ rating: 'general', title: 'Breast cancer screening', description: 'Health advice' }), null);
});

test('url: normalisation merges duplicates', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM:443/a//b/../c?utm_source=x&b=2&a=1#top'), 'https://example.com/a/c?a=1&b=2');
  assert.equal(normalizeUrl('/x', 'http://e.com/y/z'), 'http://e.com/x');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('mailto:a@b.c'), null);
  assert.equal(normalizeUrl('http://user:pw@e.com/'), null);
  assert.equal(looksLikeFile('https://e.com/a.pdf'), true);
  assert.equal(looksLikeFile('https://e.com/a.html'), false);
});

test('url: site = registrable domain (one politeness bucket per site)', () => {
  assert.equal(siteOf('https://ar.wikipedia.org/wiki/x'), 'wikipedia.org');
  assert.equal(siteOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(siteOf('https://user.github.io/'), 'user.github.io');
  assert.equal(siteOf('http://127.0.0.1:8080/'), '127.0.0.1');
});

test('url: private address detection (SSRF guard)', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) assert.equal(isPrivateAddress(a), false, a);
  assert.equal(isPrivateHostname('localhost'), true);
  assert.equal(isPrivateHostname('printer.local'), true);
  assert.equal(isPrivateHostname('example.com'), false);
});

test('html: extracts title, meta, headings, text, links; skips scripts and nav', () => {
  const p = parseHtml(`<!DOCTYPE html><html lang="EN"><head>
    <title>Hello &amp; Welcome</title>
    <meta name="description" content="A &quot;test&quot; page">
    <meta name="robots" content="noindex, nofollow">
    <link rel="canonical" href="/canon">
    <script>var x = "<a href='/fake'>no</a>";</script><style>p{}</style>
  </head><body>
    <nav><a href="/menu">Menu item</a></nav>
    <h1>Main <em>heading</em></h1>
    <p>First&nbsp;para with <a href="/link" rel="nofollow ugc">a link</a> and a &lt;tag&gt; &#169; &#x263A;</p>
    <!-- <a href="/commented">x</a> -->
    <p>a < b and c > d</p><img src="i.png" alt="Logo picture"><div>x</div><div>y</div>
    <footer>Copyright junk</footer>
  </body></html>`);
  assert.equal(p.title, 'Hello & Welcome');
  assert.equal(p.description, 'A "test" page');
  assert.equal(p.lang, 'en');
  assert.equal(p.canonical, '/canon');
  assert.match(p.robots, /noindex/);
  assert.deepEqual(p.headings, ['Main heading']);
  assert.match(p.text, /First para with a link and a <tag> © ☺/);
  assert.match(p.text, /a < b and c > d/);
  assert.match(p.text, /Logo picture/);
  assert.ok(p.text.split(String.fromCharCode(10)).includes('x')); // blocks are separate lines
  assert.doesNotMatch(p.text, /Menu item|Copyright junk|var x/);
  assert.deepEqual(p.links.map((l) => [l.href, l.nofollow]), [['/menu', false], ['/link', true]]);
  assert.equal(p.links[1].text, 'a link');
});

test('html: survives broken markup', () => {
  const p = parseHtml('<p>unclosed <b>bold <a href="/a">one <a href=/b>two</p><div class="x>broken');
  assert.deepEqual(p.links.map((l) => l.href), ['/a', '/b']);
  assert.match(p.text.replace(/\s+/g, ' '), /unclosed bold one two/);
  assert.equal(decodeEntities('&bogus; &amp &#0;'), '&bogus; & �');
});

test('porter stemmer matches reference outputs', () => {
  const cases = {
    caresses: 'caress', ponies: 'poni', ties: 'ti', caress: 'caress', cats: 'cat', feed: 'feed', agreed: 'agre',
    plastered: 'plaster', bled: 'bled', motoring: 'motor', sing: 'sing', conflated: 'conflat', troubled: 'troubl',
    sized: 'size', hopping: 'hop', tanned: 'tan', falling: 'fall', hissing: 'hiss', fizzed: 'fizz', failing: 'fail',
    filing: 'file', happy: 'happi', sky: 'sky', relational: 'relat', conditional: 'condit', rational: 'ration',
    valenci: 'valenc', digitizer: 'digit', conformabli: 'conform', radicalli: 'radic', differentli: 'differ',
    vileli: 'vile', analogousli: 'analog', vietnamization: 'vietnam', predication: 'predic', operator: 'oper',
    feudalism: 'feudal', decisiveness: 'decis', hopefulness: 'hope', callousness: 'callous', formaliti: 'formal',
    sensitiviti: 'sensit', sensibiliti: 'sensibl', triplicate: 'triplic', formative: 'form', formalize: 'formal',
    electriciti: 'electr', electrical: 'electr', hopeful: 'hope', goodness: 'good', revival: 'reviv',
    allowance: 'allow', inference: 'infer', airliner: 'airlin', gyroscopic: 'gyroscop', adjustable: 'adjust',
    defensible: 'defens', irritant: 'irrit', replacement: 'replac', adjustment: 'adjust', dependent: 'depend',
    adoption: 'adopt', homologou: 'homolog', communism: 'commun', activate: 'activ', angulariti: 'angular',
    homologous: 'homolog', effective: 'effect', bowdlerize: 'bowdler', probate: 'probat', rate: 'rate',
    cease: 'ceas', controll: 'control', roll: 'roll', connection: 'connect', connecting: 'connect', generalizations: 'gener'
  };
  for (const [w, s] of Object.entries(cases)) assert.equal(stem(w), s, w);
});

test('tokenize: folds accents, drops stopwords, keeps positions', () => {
  const { tokens, length } = tokenize('The Café is RUNNING in São Paulo, isn\'t it?');
  assert.deepEqual(tokens.map((t) => t.term), ['cafe', 'run', 'sao', 'paulo']);
  assert.deepEqual(tokens.map((t) => t.pos), [1, 3, 5, 6]);
  assert.equal(length, 9);
});

test('pagerank: hub page outranks leaves, mean is 1', () => {
  const r = pagerank([1, 2, 3, 4], [[2, 1], [3, 1], [4, 1], [1, 2]]);
  assert.ok(r.get(1) > r.get(2) && r.get(2) > r.get(3));
  const mean = [...r.values()].reduce((a, b) => a + b) / 4;
  assert.ok(Math.abs(mean - 1) < 1e-6);
});

test('query parsing: phrases, exclusions, site:', () => {
  const q = parseQuery('"open world" games -racing site:Example.com rust');
  assert.deepEqual(q.terms, ['open', 'world', 'game', 'rust']);
  assert.deepEqual(q.exclude, ['race']);
  assert.deepEqual(q.sites, ['example.com']);
  assert.deepEqual(q.phrases[0].map((t) => t.term), ['open', 'world']);
});

test('damerau distance and host crowding', () => {
  assert.equal(damerau('teh', 'the', 2), 1);
  assert.equal(damerau('rsut', 'rust', 2), 1);
  assert.equal(damerau('kitten', 'sitting', 3), 3);
  const r = crowd(['a', 'a', 'a', 'b'].map((h, i) => ({ id: i, page: { host: h } })), 2);
  assert.deepEqual(r.map((x) => x.id), [0, 1, 3, 2]);
});

test('boilerplate: blocks repeated across a site are stripped, unique text kept', () => {
  const { stripBoilerplate } = require('../indexer/indexer');
  const menu = 'Missions Search All Missions A to Z';
  const pages = [1, 2, 3, 4].map((id) => ({ id, url: `https://www.nasa.gov/p${id}`, body: `${menu}\nUnique text for page ${id}\nCookie notice` }));
  pages.push({ id: 9, url: 'https://other.example/', body: `${menu}\nOther site` });
  const c = stripBoilerplate(pages);
  assert.equal(c.get(1), 'Unique text for page 1');
  assert.equal(c.get(9), `${menu}\nOther site`); // other sites untouched
});

test('minSpan: smallest window holding every term', () => {
  const { minSpan } = require('../indexer/search');
  assert.equal(minSpan(['1,50', '2,90', '60']), 41); // best window is 50..90
  assert.equal(minSpan(['10', '11']), 2);
  assert.equal(minSpan(['10', null]), null);
});
