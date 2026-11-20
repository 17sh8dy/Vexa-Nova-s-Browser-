/* vexa://reader — renders an article extracted from a web page.
   The article arrives as a tree of allowed tags and text; it is rebuilt here with
   createElement / textContent only (never innerHTML), and only http(s) links and images
   survive. The page's CSP also blocks every script but this one. */
(() => {
  'use strict';
  const call = (m, ...a) => window.vexa.call(m, ...a);
  const $ = (s) => document.querySelector(s);
  const I = window.VexaIcons;
  $('#leave-ico').innerHTML = I.back;
  $('#save-ico').innerHTML = I.collection;

  const params = new URLSearchParams(location.search);
  const token = params.get('id') || '';
  const original = params.get('u') || '';
  let prefs = { font: 'serif', size: 19, width: 680, theme: 'auto' };
  let site = '';
  try {
    site = new URL(original).hostname.replace(/^www\./, '');
  } catch {
    /* ignore */
  }

  const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'figure', 'figcaption', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'dl', 'dt', 'dd', 'a', 'em', 'i', 'strong', 'b', 'sub', 'sup', 'mark', 'small', 's', 'u', 'q', 'kbd', 'img']);
  const safeUrl = (u) => {
    try {
      const x = new URL(String(u));
      return /^https?:$/.test(x.protocol) ? x.href : '';
    } catch {
      return '';
    }
  };

  function build(node, parent, depth = 0) {
    if (depth > 60) return;
    if (typeof node === 'string') {
      parent.appendChild(document.createTextNode(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const n of node) build(n, parent, depth + 1);
      return;
    }
    if (!node || typeof node !== 'object' || !ALLOWED.has(node.t)) return;
    let tag = node.t === 'h1' ? 'h2' : node.t; // the article title is the page's only h1
    if (tag === 'img') {
      const src = safeUrl(node.src);
      if (!src) return;
      const img = document.createElement('img');
      img.src = src;
      img.alt = String(node.alt || '').slice(0, 300);
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      parent.appendChild(img);
      return;
    }
    const el = document.createElement(tag);
    if (tag === 'a') {
      const href = safeUrl(node.href);
      if (href) {
        el.href = href;
        el.rel = 'noreferrer';
      }
    }
    build(node.c || [], el, depth + 1);
    // Drop empty paragraphs and lists left after cleaning.
    if (['p', 'li', 'figure', 'blockquote', 'ul', 'ol'].includes(tag) && !el.textContent.trim() && !el.querySelector('img')) return;
    parent.appendChild(el);
  }

  // Loose text and inline elements at the top level get grouped into paragraphs.
  const INLINE = new Set(['a', 'em', 'i', 'strong', 'b', 'sub', 'sup', 'mark', 'small', 's', 'u', 'q', 'kbd', 'code', 'br']);
  function render(data) {
    const art = $('#article');
    art.textContent = '';
    const head = document.createElement('header');
    const h1 = document.createElement('h1');
    h1.textContent = data.title || site;
    head.appendChild(h1);
    const meta = document.createElement('div');
    meta.className = 'rd-meta';
    const minutes = Math.max(1, Math.round((data.words || 0) / 230));
    let when = '';
    if (data.published) {
      const d = new Date(data.published);
      if (!isNaN(d)) when = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    }
    meta.textContent = [data.byline, data.site, when, `${minutes} min read`].filter(Boolean).join(' · ');
    head.appendChild(meta);
    art.appendChild(head);
    let para = null;
    for (const n of data.content || []) {
      const inline = typeof n === 'string' || (n && INLINE.has(n.t));
      if (inline) {
        if (typeof n === 'string' && !n.trim() && !para) continue;
        if (!para) para = document.createElement('p');
        build(n, para);
        continue;
      }
      if (para) {
        if (para.textContent.trim()) art.appendChild(para);
        para = null;
      }
      build(n, art);
    }
    if (para && para.textContent.trim()) art.appendChild(para);
    if (data.dir === 'rtl') art.dir = 'rtl';
    if (data.lang) document.documentElement.lang = String(data.lang).slice(0, 20);
    document.title = data.title || 'Reader';
  }

  function applyPrefs() {
    const r = document.documentElement;
    r.dataset.font = prefs.font;
    r.dataset.theme = prefs.theme;
    r.style.setProperty('--rd-size', prefs.size + 'px');
    r.style.setProperty('--rd-width', prefs.width + 'px');
    for (const b of document.querySelectorAll('[data-font]')) b.classList.toggle('on', b.dataset.font === prefs.font);
    for (const b of document.querySelectorAll('[data-theme]')) b.classList.toggle('on', b.dataset.theme === prefs.theme);
  }
  async function setPrefs(patch) {
    prefs = { ...prefs, ...patch };
    applyPrefs();
    try {
      prefs = await call('reader.setPrefs', patch);
    } catch {
      /* keep local */
    }
  }

  $('#smaller').addEventListener('click', () => setPrefs({ size: Math.max(12, prefs.size - 1) }));
  $('#bigger').addEventListener('click', () => setPrefs({ size: Math.min(32, prefs.size + 1) }));
  $('#narrower').addEventListener('click', () => setPrefs({ width: Math.max(480, prefs.width - 60) }));
  $('#wider').addEventListener('click', () => setPrefs({ width: Math.min(1100, prefs.width + 60) }));
  for (const b of document.querySelectorAll('[data-font]')) b.addEventListener('click', () => setPrefs({ font: b.dataset.font }));
  for (const b of document.querySelectorAll('[data-theme]')) b.addEventListener('click', () => setPrefs({ theme: b.dataset.theme }));
  $('#leave').addEventListener('click', () => call('reader.leave'));
  $('#save').addEventListener('click', async () => {
    try {
      const name = await call('reader.save', token);
      $('#save').querySelector('span:last-child').textContent = `Saved to ${name}`;
    } catch (e) {
      $('#save').querySelector('span:last-child').textContent = 'Couldn’t save';
    }
  });
  // The site key (registrable domain) comes from the main process, which uses the Public Suffix List.
  let siteKeyValue = '';
  const siteKey = () => siteKeyValue;
  $('#always').addEventListener('change', (e) => siteKeyValue && call('reader.sitePref', siteKey(), 'reader', e.target.checked));

  (async () => {
    $('#site').textContent = site;
    try {
      prefs = (await call('reader.prefs')) || prefs;
    } catch {
      /* defaults */
    }
    applyPrefs();
    try {
      const look = await call('atmosphere.look');
      if (look && look.accent) document.documentElement.style.setProperty('--accent', look.accent);
    } catch {
      /* ignore */
    }
    siteKeyValue = original ? await call('reader.siteOf', original).catch(() => '') : '';
    $('#always').disabled = !siteKeyValue;
    if (siteKeyValue) $('#always').checked = !!(await call('reader.getSitePref', siteKeyValue).catch(() => ({}))).reader;
    const data = await call('reader.get', token).catch(() => null);
    if (!data) {
      const art = $('#article');
      art.textContent = '';
      const p = document.createElement('p');
      p.className = 'rd-loading';
      p.textContent = 'This article is no longer in Reader view (Vexa keeps it only while the tab is open). ';
      if (safeUrl(original)) {
        const a = document.createElement('a');
        a.href = safeUrl(original);
        a.textContent = 'Open the original page';
        p.appendChild(a);
      }
      art.appendChild(p);
      return;
    }
    render(data);
  })();

  document.addEventListener('keydown', (e) => {
    if (e.key === '+' && e.ctrlKey) return;
    if (e.key === '=' && !e.ctrlKey && !e.metaKey && document.activeElement === document.body) setPrefs({ size: Math.min(32, prefs.size + 1) });
    if (e.key === '-' && !e.ctrlKey && !e.metaKey && document.activeElement === document.body) setPrefs({ size: Math.max(12, prefs.size - 1) });
  });
})();
