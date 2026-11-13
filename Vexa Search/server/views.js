'use strict';
// Server-rendered HTML for the search pages. Every dynamic value goes
// through esc(); no inline scripts (the CSP forbids them).

const { TOKEN, USER_AGENT } = require('../VexaBot/identity');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ title, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="icon" href="/static/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css">
<link rel="search" type="application/opensearchdescription+xml" title="Vexa Search" href="/opensearch.xml">
<script src="/static/app.js" defer></script>
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

const brand = (big) => `<a class="brand${big ? ' big' : ''}" href="/" aria-label="Vexa Search home">
  <img src="/static/logo.svg" alt="" width="${big ? 56 : 30}" height="${big ? 56 : 30}">
  <span class="word">Vexa <b>Search</b></span><span class="beta" title="Vexa Search is in beta">BETA</span>
</a>`;

const searchBox = (q, autofocus) => `<form class="box" action="/search" method="get" role="search">
  <svg class="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  <input name="q" value="${esc(q)}" placeholder="Search the web with Vexa" autocomplete="off" spellcheck="false" maxlength="256" aria-label="Search" ${autofocus ? 'autofocus' : ''}>
  <button type="submit" aria-label="Search">Search</button>
  <ul class="suggest" role="listbox" hidden></ul>
</form>`;

const footer = () => `<footer class="foot">
  <span>Vexa Search is Nova's own search engine, built from scratch, in beta.</span>
  <nav><a href="/about">About</a><a href="/bot">${TOKEN}</a><a href="/api/stats">Stats</a></nav>
</footer>`;

function fmtCount(n) { return Number(n || 0).toLocaleString('en-US'); }

function homePage(stats) {
  return layout({
    title: 'Vexa Search',
    bodyClass: 'home',
    body: `<main class="hero">
  ${brand(true)}
  ${searchBox('', true)}
  <p class="meta">${fmtCount(stats.documents)} pages from ${fmtCount(stats.hosts)} sites indexed by ${TOKEN}</p>
</main>
${footer()}`
  });
}

function renderSnippet(segs) {
  return segs.map((s) => (s.hit ? `<b>${esc(s.text)}</b>` : esc(s.text))).join('');
}

function displayUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    return { host: u.hostname.replace(/^www\./, ''), crumbs: parts.slice(0, 3).join(' › ') + (parts.length > 3 ? ' › …' : '') };
  } catch { return { host: url, crumbs: '' }; }
}

function resultsPage(q, res, stats) {
  const items = res.results.map((r) => {
    const d = displayUrl(r.url);
    return `<li class="result">
  <a class="link" href="${esc(r.url)}" rel="noopener noreferrer">
    <span class="site"><span class="fav" aria-hidden="true">${esc(d.host[0] || '?').toUpperCase()}</span><span><span class="host">${esc(d.host)}</span>${d.crumbs ? `<span class="crumbs"> › ${esc(d.crumbs)}</span>` : ''}</span></span>
    <h3>${esc(r.title)}</h3>
  </a>
  <p class="snip">${renderSnippet(r.snippet)}</p>
</li>`;
  }).join('\n');

  const pages = Math.ceil(res.total / res.pageSize);
  const nav = pages > 1 ? `<nav class="pager" aria-label="Pages">
  ${res.page > 1 ? `<a href="/search?q=${encodeURIComponent(q)}&amp;page=${res.page - 1}">‹ Previous</a>` : '<span></span>'}
  <span class="pg">Page ${res.page} of ${pages}</span>
  ${res.page < pages ? `<a href="/search?q=${encodeURIComponent(q)}&amp;page=${res.page + 1}">Next ›</a>` : '<span></span>'}
</nav>` : '';

  const dym = res.suggestion ? `<p class="dym">Did you mean <a href="/search?q=${encodeURIComponent(res.suggestion)}">${esc(res.suggestion)}</a>?</p>` : '';
  const orNote = res.mode === 'or' && res.total ? '<p class="note">No page had every word, so these match some of them.</p>' : '';

  const body = res.total ? `<p class="count">${fmtCount(res.total)} result${res.total === 1 ? '' : 's'} <span>(${res.ms} ms)</span></p>${dym}${orNote}
<ol class="results">${items}</ol>${nav}` : `${dym}<div class="empty">
  <h2>No results for “${esc(q)}”</h2>
  <p>Vexa Search is in beta and has indexed ${fmtCount(stats.documents)} pages so far, so it may not know this yet.</p>
  <ul><li>Check the spelling, or try fewer or more general words.</li><li>Remove quotes, <code>-word</code> or <code>site:</code> filters.</li></ul>
</div>`;

  return layout({
    title: `${q} - Vexa Search`,
    bodyClass: 'serp',
    body: `<header class="top">${brand(false)}${searchBox(q, false)}</header>
<main class="main">${body}</main>
${footer()}`
  });
}

function aboutPage(stats) {
  return layout({
    title: 'About Vexa Search',
    bodyClass: 'doc',
    body: `<header class="top">${brand(false)}</header>
<main class="main prose">
<h1>About Vexa Search <span class="beta">BETA</span></h1>
<p>Vexa Search is an independently developed search engine with its own web crawler (${TOKEN}), indexing and ranking. It is built from scratch by Nova: it does not resell or proxy another search engine's results.</p>
<h2>Coverage during the beta</h2>
<p>While in beta, Vexa Search prioritises mainstream websites: technology, gaming, entertainment, education, news and general-purpose reference. Adult and pornographic websites are not prioritised and may not be indexed. Coverage will change as the engine develops. The index currently holds ${fmtCount(stats.documents)} pages.</p>
<p>In the Vexa browser you can always choose another search provider, such as Google or Brave, in settings.</p>
<h2>Search tips</h2>
<ul>
<li><code>"exact phrase"</code> finds the words together, in order.</li>
<li><code>-word</code> leaves out pages containing that word.</li>
<li><code>site:example.com</code> searches one site.</li>
</ul>
<h2>Privacy</h2>
<p>This search page sets no cookies and keeps no search history.</p>
</main>
${footer()}`
  });
}

function botPage() {
  return layout({
    title: `${TOKEN} - Vexa Search's crawler`,
    bodyClass: 'doc',
    body: `<header class="top">${brand(false)}</header>
<main class="main prose">
<h1>${TOKEN}</h1>
<p>${TOKEN} is the web crawler for Vexa Search. It identifies itself with this user agent:</p>
<pre>${esc(USER_AGENT)}</pre>
<h2>How ${TOKEN} behaves</h2>
<ul>
<li>It reads and obeys <code>robots.txt</code> (RFC 9309), including <code>Crawl-delay</code>, and re-checks it every 24 hours.</li>
<li>It fetches one page at a time per site, at least 1.5 seconds apart.</li>
<li>It respects <code>noindex</code> and <code>nofollow</code> in <code>&lt;meta name="robots"&gt;</code>, <code>&lt;meta name="vexabot"&gt;</code> and the <code>X-Robots-Tag</code> header, and <code>rel="nofollow"</code> on links.</li>
<li>It only downloads HTML, up to 2 MB per page, and never submits forms.</li>
</ul>
<h2>Blocking ${TOKEN}</h2>
<p>To keep ${TOKEN} off your whole site, add this to <code>robots.txt</code>:</p>
<pre>User-agent: ${TOKEN}
Disallow: /</pre>
<p>To slow it down instead:</p>
<pre>User-agent: ${TOKEN}
Crawl-delay: 10</pre>
</main>
${footer()}`
  });
}

function errorPage(status, message) {
  return layout({
    title: `${status} - Vexa Search`,
    bodyClass: 'doc',
    body: `<header class="top">${brand(false)}</header><main class="main prose"><h1>${status}</h1><p>${esc(message)}</p><p><a href="/">Back to Vexa Search</a></p></main>`
  });
}

function opensearch(origin) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Vexa Search</ShortName>
  <Description>Nova's own search engine (beta)</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image type="image/svg+xml">${esc(origin)}/static/logo.svg</Image>
  <Url type="text/html" method="get" template="${esc(origin)}/search?q={searchTerms}"/>
  <Url type="application/x-suggestions+json" template="${esc(origin)}/api/suggest?q={searchTerms}&amp;format=opensearch"/>
</OpenSearchDescription>`;
}

module.exports = { homePage, resultsPage, aboutPage, botPage, errorPage, opensearch, esc };
