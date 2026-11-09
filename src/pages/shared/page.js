/* Helpers shared by vexa:// pages. Plain script; exposes window.V. */
(() => {
  'use strict';
  const call = (method, ...args) => window.vexa.call(method, ...args);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtTime(t) {
    return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function dayLabel(t) {
    const d = new Date(t);
    const today = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(today) - start(d)) / 86400000);
    const full = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
    if (diff === 0) return 'Today — ' + full;
    if (diff === 1) return 'Yesterday — ' + full;
    return full;
  }
  function hostOf(u) {
    try {
      return new URL(u).host || u;
    } catch {
      return u;
    }
  }
  function favicon(url, iconUrl) {
    const fallback = window.VexaIcons ? window.VexaIcons.globe : '';
    let src = iconUrl;
    if (!src) {
      try {
        const o = new URL(url);
        if (/^https?:$/.test(o.protocol)) src = o.origin + '/favicon.ico';
      } catch {
        /* ignore */
      }
    }
    const span = document.createElement('span');
    span.className = 'favicon';
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = src;
      img.onerror = () => (span.innerHTML = fallback);
      span.appendChild(img);
    } else span.innerHTML = fallback;
    return span;
  }
  let toastTimer;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }
  function debounce(fn, ms = 200) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }
  /** Sidebar used by settings/history/bookmarks/downloads. */
  function sidebar(active) {
    const I = window.VexaIcons;
    const items = [
      ['history', 'History', I.clock],
      ['bookmarks', 'Bookmarks', I.bookmark],
      ['downloads', 'Downloads', I.download.replace('width="18" height="18"', 'width="16" height="16"')],
      ['settings', 'Settings', I.settings]
    ];
    return `<div class="brand"><img src="vexa://shared/logo.svg" alt=""><div><b>Vexa</b><span>by Nova</span></div></div>
      <nav class="nav">${items.map(([id, label, icon]) => `<a href="vexa://${id}/" class="${id === active ? 'on' : ''}"><span class="ico">${icon}</span>${label}</a>`).join('')}</nav>`;
  }
  /** Open a URL from an internal page, respecting modifier keys. */
  function openFromEvent(e, url) {
    e.preventDefault();
    const disposition = e.button === 1 || e.ctrlKey || e.metaKey ? 'background' : e.shiftKey ? 'new-tab' : 'current';
    call('nav.open', url, disposition);
  }
  window.V = { call, esc, $, $$, fmtBytes, fmtTime, dayLabel, hostOf, favicon, toast, debounce, sidebar, openFromEvent, on: (n, f) => window.vexa.on(n, f) };
})();
