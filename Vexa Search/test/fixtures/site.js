'use strict';
// A tiny local website for crawl tests. Covers robots.txt, redirects,
// noindex, nofollow, canonical, duplicates, an adult-labelled page,
// a non-HTML file and a sitemap.

const http = require('node:http');

const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const ROUTES = {
  '/robots.txt': [200, 'text/plain', `User-agent: *\nDisallow: /private\nSitemap: /sitemap.xml\n\nUser-agent: VexaBot\nDisallow: /private\nDisallow: /bot-only-block\nCrawl-delay: 0\nSitemap: /sitemap.xml`],
  '/': [200, 'text/html', page('Vexa Test Home', `<nav><a href="/">Home</a> navigation words</nav>
    <h1>Welcome to the test site</h1>
    <p>Learn about <a href="/rust">the Rust programming language</a>, <a href="/games">open world games</a> and <a href="/space">space exploration</a>.</p>
    <p><a href="/private/secret">secret</a> <a href="/bot-only-block">blocked</a> <a href="/old">old page</a> <a href="/hidden">hidden</a>
    <a href="/adult">adult</a> <a href="/nofollowed" rel="nofollow">nf</a> <a href="/file.pdf">pdf</a> <a href="/dup">dup</a> <a href="/variant?utm_source=x">variant</a></p>
    <footer>footer boilerplate copyright</footer>`, '<meta name="description" content="Home of the Vexa crawler test site.">')],
  '/rust': [200, 'text/html; charset=utf-8', page('Rust Programming Language Guide', `<h1>Rust programming</h1><h2>Ownership and borrowing</h2>
    <p>Rust is a systems programming language focused on memory safety without a garbage collector. The borrow checker enforces ownership rules at compile time.</p>
    <p>Cargo is the Rust package manager. Crates are compiled quickly and safely.</p><a href="/games">Games built with Rust</a>`)],
  '/games': [200, 'text/html', page('Open World Games', `<h1>Open world games</h1>
    <p>Open world games let players explore a large map freely. Driving games and role playing games often use open worlds.</p>
    <p>Some engines are written in Rust and C++.</p><a href="/space">Space games</a>`)],
  '/space': [200, 'text/html', page('Space Exploration', `<h1>Space exploration</h1>
    <p>NASA launched the James Webb Space Telescope to study distant galaxies. Rockets carry astronauts to the International Space Station.</p>`)],
  '/private/secret': [200, 'text/html', page('Secret', '<p>should never be fetched</p>')],
  '/bot-only-block': [200, 'text/html', page('Bot only', '<p>blocked for VexaBot only</p>')],
  '/old': [301, null, '/space-moved'],
  '/space-moved': [200, 'text/html', page('Moved Page About Telescopes', '<p>Telescopes and observatories gather light from stars.</p>')],
  '/hidden': [200, 'text/html', page('Hidden page', '<p>unicorn marmalade should not be searchable</p><a href="/from-hidden">next</a>', '<meta name="robots" content="noindex">')],
  '/from-hidden': [200, 'text/html', page('Reached from hidden', '<p>Links on noindex pages are still followed.</p>')],
  '/adult': [200, 'text/html', page('Adult page', '<p>age restricted</p>', '<meta name="rating" content="RTA-5042-1996-1400-1577-RTA">')],
  '/nofollowed': [200, 'text/html', page('Nofollowed', '<p>should not be crawled</p>')],
  '/dup': [200, 'text/html', page('Space Exploration copy', `<h1>Space exploration</h1>
    <p>NASA launched the James Webb Space Telescope to study distant galaxies. Rockets carry astronauts to the International Space Station.</p>`)],
  '/variant': [200, 'text/html', page('Variant', '<p>tracking params are stripped so this is crawled once</p>', '<link rel="canonical" href="/canonical-target">')],
  '/canonical-target': [200, 'text/html', page('Canonical Target Page', '<p>The canonical version of the variant page.</p>')],
  '/sitemap.xml': [200, 'application/xml', '<?xml version="1.0"?><urlset><url><loc>__ORIGIN__/from-sitemap</loc></url></urlset>'],
  '/from-sitemap': [200, 'text/html', page('Found Through Sitemap', '<p>Sitemap discovery works for seeds.</p>')]
};

function startSite() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits.push({ path: url.pathname + url.search, ua: req.headers['user-agent'] });
    const r = ROUTES[url.pathname];
    if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    const [status, type, body] = r;
    if (status === 301) { res.writeHead(301, { location: body }); return res.end(); }
    const origin = `http://${req.headers.host}`;
    res.writeHead(status, { 'content-type': type });
    res.end(body.replace(/__ORIGIN__/g, origin));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { startSite };
