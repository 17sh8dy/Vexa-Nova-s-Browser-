/* Vexa popup layer: app menu, downloads panel, address-bar suggestions, status bubble. */
(() => {
  'use strict';
  const I = window.VexaIcons;
  const api = window.vexaChrome;
  const params = new URLSearchParams(location.search);
  const isMac = navigator.userAgent.includes('Mac OS');
  const MOD = isMac ? '⌘' : 'Ctrl';
  document.documentElement.classList.toggle('private', params.get('private') === '1');

  const card = document.getElementById('card');
  const backdrop = document.getElementById('backdrop');
  let current = null; // { kind, data, anchor, width, height }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const send = (name, args) => api.overlay(name, args).catch((e) => console.error(name, e));

  // ------------------------------------------------------------------ status bubble mode
  if (params.get('mode') === 'status') {
    document.body.classList.add('status-mode');
    const el = document.getElementById('status');
    const toast = document.getElementById('toast');
    api.on('status:show', (text) => {
      el.hidden = false;
      el.textContent = text;
    });
    // Short confirmations ("Saved to Recipes") take over the layer for a moment.
    api.on('status:toast', (text) => {
      document.body.classList.toggle('toast-mode', !!text);
      toast.hidden = !text;
      if (!text) return;
      toast.textContent = text;
      toast.classList.remove('show');
      void toast.offsetWidth;
      toast.classList.add('show');
    });
    api.on('look', (look) => window.VexaPalettes && window.VexaPalettes.apply(document, look, matchMedia('(prefers-color-scheme: dark)').matches));
    return;
  }
  // The popup layer follows the window's Atmosphere look too.
  api.on('look', (look) => window.VexaPalettes && window.VexaPalettes.apply(document, look, matchMedia('(prefers-color-scheme: dark)').matches));

  backdrop.addEventListener('mousedown', () => send('hide'));

  // ------------------------------------------------------------------ positioning
  function place() {
    const { kind, anchor, width } = current;
    if (kind === 'command') {
      const w = Math.min(680, width - 32);
      card.style.width = w + 'px';
      card.style.left = Math.round((width - w) / 2) + 'px';
      card.style.right = 'auto';
      card.style.top = '28px';
      return;
    }
    const a = anchor || { x: width - 50, bottom: 0, right: width - 10, width: 40 };
    card.style.top = Math.max(4, a.bottom + 6) + 'px';
    // Popups opened from the sidebar sit next to it, not under the toolbar's right edge.
    if (anchor && (kind === 'space' || kind === 'focus') && anchor.x < width / 2) {
      card.style.width = '';
      card.style.right = 'auto';
      card.style.left = Math.round(anchor.right + 8) + 'px';
      card.style.top = Math.max(4, Math.min(anchor.y, current.height - 420)) + 'px';
      return;
    }
    if (kind === 'suggestions') {
      card.style.left = a.x + 'px';
      card.style.width = a.width + 'px';
      card.style.right = 'auto';
    } else {
      card.style.width = '';
      card.style.left = 'auto';
      card.style.right = Math.max(6, width - a.right) + 'px';
    }
  }

  // ------------------------------------------------------------------ menu
  function menuItem(action, icon, label, keys) {
    return `<button class="mi" data-action="${action}"><span class="mi-icon">${icon || ''}</span><span class="mi-label">${label}</span>${keys ? `<kbd>${keys}</kbd>` : ''}</button>`;
  }
  function renderMenu(d) {
    card.className = 'card menu';
    const z = Math.round((d.zoom || 1) * 100);
    card.innerHTML = `
      <div class="menu-head"><div class="brand-mark">${window.VexaMark(20)}</div><div><div class="brand">Vexa</div><div class="sub">${d.isPrivate ? 'Private window' : 'by Nova'}</div></div></div>
      ${menuItem('new-tab', I.plus, 'New tab', `${MOD}+T`)}
      ${menuItem('new-window', I.external, 'New window', `${MOD}+N`)}
      ${menuItem('new-private-window', I.mask, 'New private window', `${MOD}+Shift+N`)}
      <div class="sep"></div>
      <div class="zoom-row"><span class="mi-label">Zoom</span>
        <button class="zbtn" data-action="zoom-out" title="Zoom out (${MOD}+-)">${I.minus}</button>
        <button class="zval" data-action="zoom-reset" title="Reset (${MOD}+0)">${z}%</button>
        <button class="zbtn" data-action="zoom-in" title="Zoom in (${MOD}+=)">${I.plus.replace('width="18" height="18"', 'width="16" height="16"')}</button>
        <button class="zbtn" data-action="fullscreen" title="Full screen (F11)">${I.fullscreen}</button>
      </div>
      <div class="sep"></div>
      ${menuItem('command-center', I.command, 'Command Center', d.commandKey || '')}
      ${d.isPrivate ? '' : menuItem('new-space', I.spaces, 'New Space…', '')}
      ${d.isPrivate ? '' : menuItem('collections', I.collection, 'Collections', '')}
      ${menuItem(d.focusActive ? 'focus-end' : 'focus-mode', I.target.replace('width="18" height="18"', 'width="16" height="16"'), d.focusActive ? 'End focus session' : 'Minimal interface', d.focusActive ? '' : `${MOD}+Shift+F`)}
      ${d.isPrivate ? '' : menuItem('research', I.book.replace('width="18" height="18"', 'width="16" height="16"'), 'Research panel', '')}
      <div class="sep"></div>
      ${menuItem('history', I.clock, 'History', `${MOD}+H`)}
      ${menuItem('downloads', I.download.replace('width="18" height="18"', 'width="16" height="16"'), 'Downloads', `${MOD}+J`)}
      ${menuItem('bookmarks', I.bookmark, 'Bookmarks', `${MOD}+Shift+O`)}
      ${menuItem('toggle-bookmarks-bar', '', d.bookmarksBar ? 'Hide bookmarks bar' : 'Show bookmarks bar', `${MOD}+Shift+B`)}
      <div class="sep"></div>
      ${menuItem('find', I.search, 'Find on page…', `${MOD}+F`)}
      ${menuItem('print', '', 'Print…', `${MOD}+P`)}
      ${menuItem('devtools', '', 'Developer tools', 'F12')}
      <div class="sep"></div>
      ${menuItem('clear-data', I.shield, 'Clear browsing data…', `${MOD}+Shift+Del`)}
      ${d.isPrivate ? '' : menuItem('customize', I.palette, 'Customize Vexa…', '')}
      ${menuItem('settings', I.settings, 'Settings', `${MOD}+,`)}
      ${menuItem('about', I.info.replace('width="14" height="14"', 'width="16" height="16"'), 'About Vexa', '')}
      ${isMac ? '' : `<div class="sep"></div>${menuItem('quit', '', 'Exit', '')}`}
    `;
  }

  card.addEventListener('click', (e) => {
    if (!current) return;
    const b = e.target.closest('[data-action]');
    if (current.kind === 'menu' && b) send('menu', { action: b.dataset.action });
  });

  // Keyboard navigation inside the menu.
  document.addEventListener('keydown', (e) => {
    if (!current || current.kind !== 'menu') return;
    const items = [...card.querySelectorAll('.mi, .zbtn, .zval')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    }
  });

  // ------------------------------------------------------------------ downloads
  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function dlMeta(r) {
    switch (r.state) {
      case 'progressing':
      case 'paused': {
        const of = r.totalBytes ? ` of ${fmtBytes(r.totalBytes)}` : '';
        return `${r.state === 'paused' ? 'Paused — ' : ''}${fmtBytes(r.receivedBytes)}${of}`;
      }
      case 'completed':
        return r.exists === false ? 'Deleted' : `${fmtBytes(r.totalBytes)} — ${hostOf(r.url)}`;
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Failed — ' + hostOf(r.url);
    }
  }
  function hostOf(u) {
    try {
      return new URL(u).host;
    } catch {
      return '';
    }
  }
  function renderDownloads(list) {
    card.className = 'card downloads';
    const items = list
      .map((r) => {
        const live = r.state === 'progressing' || r.state === 'paused';
        const failed = r.state === 'interrupted' || r.state === 'cancelled';
        const pct = r.totalBytes ? Math.round((r.receivedBytes / r.totalBytes) * 100) : 0;
        const actions = [];
        if (r.state === 'progressing') actions.push(['pause', I.pause, 'Pause']);
        if (r.state === 'paused') actions.push(['resume', I.play, 'Resume']);
        if (live) actions.push(['cancel', I.close, 'Cancel']);
        if (failed) actions.push(['retry', I.retry, 'Retry']);
        if (r.state === 'completed' && r.exists !== false) actions.push(['show', I.folderOpen, 'Show in folder']);
        const clickable = r.state === 'completed' && r.exists !== false;
        return `<div class="dl-item ${failed ? 'failed' : ''} ${clickable ? 'clickable' : ''}" data-id="${esc(r.id)}">
          <div class="dl-file">${failed ? I.warning : I.file}</div>
          <div class="dl-body">
            <div class="dl-name" ${clickable ? 'data-dl="open" title="Open file"' : ''}>${esc(r.filename)}</div>
            <div class="dl-meta">${esc(dlMeta(r))}</div>
            ${live ? `<div class="dl-bar ${r.totalBytes ? '' : 'indeterminate'}"><div style="width:${pct}%"></div></div>` : ''}
          </div>
          <div class="dl-actions">${actions.map(([a, ic, t]) => `<button class="ibtn" data-dl="${a}" title="${t}">${ic}</button>`).join('')}</div>
        </div>`;
      })
      .join('');
    card.innerHTML = `
      <div class="dl-head"><h2>Downloads</h2><button class="link-btn" data-dl="all">See all</button></div>
      <div class="dl-list">${items || '<div class="dl-empty">No downloads yet.</div>'}</div>`;
  }
  card.addEventListener('click', (e) => {
    if (!current || current.kind !== 'downloads') return;
    const b = e.target.closest('[data-dl]');
    if (!b) return;
    const item = b.closest('.dl-item');
    send('download', { id: item ? item.dataset.id : null, action: b.dataset.dl });
  });


  // ------------------------------------------------------------------ Vexa Shields
  const SH_ROWS = [
    ['ads', 'Ads & trackers', I.target, (s) => s.ads + s.trackers, ['ads', 'trackers']],
    ['cookies', 'Cross-site cookies', I.cookie, (s) => s.cookies, ['cookies']],
    ['fingerprinting', 'Fingerprinting', I.fingerprint, (s) => s.fingerprinting, ['fingerprinting']],
    ['https', 'Insecure connections', I.lockUp, (s) => s.https, ['https']],
    ['popups', 'Popups & tracking links', I.popup, (s) => s.popups + s.params, ['popups', 'params']]
  ];
  const SH_SWITCHES = [
    ['ads', 'Block third-party ads'],
    ['trackers', 'Block trackers'],
    ['cookies', 'Block cross-site cookies'],
    ['fingerprinting', 'Fingerprinting protection'],
    ['https', 'Upgrade connections to HTTPS'],
    ['malicious', 'Dangerous-site protection'],
    ['params', 'Remove tracking parameters'],
    ['popups', 'Block intrusive popups']
  ];
  let shExpanded = false;
  let shShown = 0; // the number currently on screen (for the count-up)
  let shSite = null;
  const sw = (on, attrs) => `<button class="sw ${on ? 'on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" ${attrs}><span></span></button>`;

  function shTotal(st) {
    return st.ads + st.trackers + st.cookies + st.fingerprinting + st.https + st.params + st.popups + st.malicious;
  }

  function renderShields(d) {
    card.className = 'card shields';
    if (!d.applicable) {
      card.innerHTML = `<div class="sh-empty">${I.vexaShield}<p>Vexa Shields protect websites. There is nothing to block on this page.</p></div>`;
      return;
    }
    if (d.site !== shSite) {
      shSite = d.site;
      shShown = 0;
    }
    const p = d.protections;
    const on = p.enabled;
    const total = shTotal(d.stats);
    const status = !on ? ['down', 'SHIELDS DOWN'] : d.custom ? ['custom', 'PROTECTED · CUSTOM'] : ['on', 'PROTECTED'];
    const rows = SH_ROWS.map(([key, label, icon, count, keys]) => {
      const active = on && keys.some((k) => p[k]);
      const n = count(d.stats);
      const value = !active ? '<span class="sh-off">Off</span>' : key === 'https' && n ? `${n} upgraded` : String(n);
      return `<div class="sh-row ${active ? '' : 'inactive'}"><span class="sh-ricon">${icon}</span><span class="sh-rlabel">${label}</span><span class="sh-rval">${value}</span></div>`;
    }).join('');
    const switches = SH_SWITCHES.map(([key, label]) => {
      const def = d.defaults[key];
      const val = p[key];
      const note = on && val !== def ? '<span class="sh-dot" title="Different from your global setting"></span>' : '';
      return `<div class="sh-srow ${on ? '' : 'inactive'}"><span>${label}${note}</span>${sw(val, `data-sh="protection" data-key="${key}" data-val="${val ? '1' : '0'}" ${on ? '' : 'disabled'}`)}</div>`;
    }).join('');
    card.innerHTML = `
      <div class="sh-hero ${status[0]}">
        <div class="sh-top">
          <span class="sh-crest">${on ? I.vexaShield : I.vexaShieldOff}</span>
          <div class="sh-title"><div class="sh-name">Vexa Shields</div><div class="sh-host" title="${esc(d.host)}">${esc(d.host)}</div></div>
          <span class="sh-pill ${status[0]}">${status[1]}</span>
        </div>
        <div class="sh-count"><span class="sh-num">${on ? shShown : 0}</span><span class="sh-cap">${on ? (total === 1 ? 'thing blocked on this page' : 'things blocked on this page') : 'Nothing is blocked while Shields are down'}</span></div>
      </div>
      ${d.dangerous ? '<div class="sh-warn">This site is on Vexa\'s phishing and scam list.</div>' : ''}
      <div class="sh-master">
        <div><b>Shields for this site</b><small>${on ? 'On. Turn off if the site doesn\'t work properly.' : 'Off. Ads, trackers and fingerprinting are allowed here.'}</small></div>
        ${sw(on, `data-sh="site" data-val="${on ? '1' : '0'}"`)}
      </div>
      <div class="sh-rows">${rows}</div>
      <button class="sh-expand ${shExpanded ? 'open' : ''}" data-sh="expand">${I.chevronDown}<span>Customize for this site</span></button>
      <div class="sh-custom" ${shExpanded ? '' : 'hidden'}>${switches}</div>
      <div class="sh-foot">
        ${d.custom ? '<button class="link-btn" data-sh="reset">Reset this site</button>' : '<span class="sh-hint">' + (d.isPrivate ? 'Changes here end with this private window' : 'Changes reload the page') + '</span>'}
        <button class="link-btn" data-sh="settings">All Shields settings</button>
      </div>`;
    if (on) countUp(total);
  }

  function countUp(target) {
    const el = card.querySelector('.sh-num');
    if (!el) return;
    const from = shShown;
    shShown = target;
    if (target <= from) {
      el.textContent = String(target);
      return;
    }
    const t0 = performance.now();
    const dur = Math.min(700, 250 + (target - from) * 12);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      if (el.isConnected) el.textContent = String(Math.round(from + (target - from) * eased));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  card.addEventListener('click', (e) => {
    if (!current || current.kind !== 'shields') return;
    const b = e.target.closest('[data-sh]');
    if (!b || b.disabled) return;
    const op = b.dataset.sh;
    if (op === 'expand') {
      shExpanded = !shExpanded;
      b.classList.toggle('open', shExpanded);
      card.querySelector('.sh-custom').hidden = !shExpanded;
      return;
    }
    if (op === 'site') return send('shields', { op: 'site', enabled: b.dataset.val !== '1' });
    if (op === 'protection') return send('shields', { op: 'protection', key: b.dataset.key, value: b.dataset.val !== '1' });
    if (op === 'reset' || op === 'settings') return send('shields', { op });
  });

  // ------------------------------------------------------------------ suggestions
  const SG_ICON = { search: I.search, url: I.globe, history: I.clock, bookmark: I.bookmark, tab: I.tab, space: I.spaces, recent: I.clock, collection: I.collection, info: I.info };
  const SG_TAG = { bookmark: 'Bookmark', history: 'History', collection: 'Collection', recent: '', tab: '', space: 'Space' };
  function renderSuggestions(d) {
    card.className = 'card suggest';
    const head = d.scope ? `<div class="sg-scope">${I.search}<span>Searching <b>${esc(d.scope.name)}</b></span><kbd>@${esc(d.scope.key)}</kbd></div>` : '';
    card.innerHTML =
      head +
      d.items
        .map((it, i) => {
          let text;
          if (it.type === 'info') text = `<span class="dim">${esc(it.title)}</span>`;
          else if (it.type === 'search' || it.type === 'recent') text = `${esc(it.title)} <span class="dim">— ${esc(it.subtitle)}</span>`;
          else if (it.type === 'url') text = `<span class="url">${esc(it.title)}</span>`;
          else if (it.type === 'space') text = `${esc(it.title)} <span class="dim">— ${esc(it.subtitle)}</span>`;
          else if (it.type === 'tab') text = `${esc(it.title)} <span class="dim">— ${esc(it.subtitle || 'Switch to tab')}</span>`;
          else text = `${esc(it.title)} <span class="dim">— </span><span class="url">${esc((it.subtitle ? it.subtitle + ' · ' : '') + it.url.replace(/^https?:\/\/(www\.)?/, ''))}</span>`;
          const icon = it.favicon && it.type !== 'tab' ? `<img src="${esc(it.favicon)}" alt="">` : it.favicon ? `<img src="${esc(it.favicon)}" alt="">` : SG_ICON[it.type] || I.globe;
          const tag = it.type === 'tab' ? '<span class="sg-pill">Switch to tab</span>' : esc(SG_TAG[it.type] || '');
          return `<div class="sg ${i === d.selected ? 'sel' : ''} ${it.type === 'info' ? 'info' : ''}" data-i="${i}"><span class="sg-icon">${icon}</span><span class="sg-text">${text}</span><span class="sg-tag">${tag}</span></div>`;
        })
        .join('');
    for (const img of card.querySelectorAll('img')) img.onerror = () => (img.parentElement.innerHTML = I.globe);
  }
  card.addEventListener('mousedown', (e) => {
    if (!current || current.kind !== 'suggestions') return;
    const row = e.target.closest('.sg');
    if (!row) return;
    e.preventDefault();
    const it = current.data.items[Number(row.dataset.i)];
    if (!it || it.type === 'info') return;
    const disposition = e.button === 1 || e.ctrlKey || e.metaKey ? 'background' : 'current';
    if (it.tab || it.space || it.type === 'recent' || it.type === 'search') send('pick-suggestion', { item: it, disposition });
    else send('pick-suggestion', { url: it.url, disposition });
  });

  // ------------------------------------------------------------------ Command Center
  const CC_ICON = { plus: I.plus, close: I.close, reload: I.reload, bookmark: I.bookmark, search: I.search, file: I.file, minus: I.minus, fullscreen: I.fullscreen, code: I.code, book: I.book, target: I.target, collection: I.collection, camera: I.camera, spaces: I.spaces, pin: I.pin, sidebar: I.sidebar, palette: I.palette, clock: I.clock, download: I.download, settings: I.settings, shield: I.shield, info: I.info, globe: I.globe, tab: I.tab, window: I.window, mask: I.mask, folder: I.folder, vexa: I.vexa };
  let cc = null; // { items, sel, seq }
  function renderCommand(d) {
    card.className = 'card command';
    card.innerHTML = `
      <div class="cc-box"><span class="cc-icon">${I.command}</span><input id="cc-q" type="text" spellcheck="false" autocomplete="off" placeholder="${d.isPrivate ? 'Search tabs, bookmarks, actions or the web…' : 'Search tabs, Spaces, bookmarks, history, actions… or just say what you want'}" aria-label="Command Center"><kbd>Esc</kbd></div>
      <div class="cc-list" id="cc-list" role="listbox"></div>
      <div class="cc-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Alt</kbd>+<kbd>Enter</kbd> new tab</span><span class="cc-hint">Try “switch to work”, “focus on essay for 25 min”, “save this page to Recipes”</span></div>`;
    cc = { items: [], sel: 0, seq: 0 };
    const input = card.querySelector('#cc-q');
    input.value = d.query || '';
    input.addEventListener('input', () => ccQuery(input.value));
    input.addEventListener('keydown', ccKey);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    ccQuery(input.value);
  }
  async function ccQuery(text) {
    const seq = ++cc.seq;
    let res;
    try {
      res = await api.overlay('cc-query', { text });
    } catch {
      return;
    }
    if (!cc || seq !== cc.seq || !current || current.kind !== 'command') return;
    cc.items = res.items || [];
    cc.sel = 0;
    ccRender();
  }
  function ccRender() {
    const list = card.querySelector('#cc-list');
    if (!list) return;
    if (!cc.items.length) {
      list.innerHTML = '<div class="cc-empty">No matches. Press Enter to search the web.</div>';
      return;
    }
    let html = '';
    let section = null;
    cc.items.forEach((it, i) => {
      if (it.section !== section) {
        section = it.section;
        html += `<div class="cc-sec">${esc(section)}</div>`;
      }
      let icon;
      if (it.favicon) icon = `<img src="${esc(it.favicon)}" alt="">`;
      else if (it.spaceIcon) icon = `<span class="cc-sp" style="--sp:${esc(it.color || '#8b5cf6')}">${(window.VexaSpaceIcon(it.spaceIcon) || '').replace('width="18" height="18"', 'width="14" height="14"')}</span>`;
      else icon = CC_ICON[it.icon] || I.sparkle;
      html += `<div class="cc-item ${i === cc.sel ? 'sel' : ''}" data-i="${i}" role="option" aria-selected="${i === cc.sel}">
        <span class="cc-ic">${icon}</span>
        <span class="cc-text"><span class="cc-title">${esc(it.title)}</span>${it.subtitle ? `<span class="cc-sub">${esc(it.subtitle)}</span>` : ''}</span>
        ${it.hint ? `<kbd class="cc-kbd">${esc(it.hint)}</kbd>` : ''}</div>`;
    });
    list.innerHTML = html;
    for (const img of list.querySelectorAll('img')) img.onerror = () => (img.parentElement.innerHTML = I.globe);
    list.querySelector('.cc-item.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function ccRun(i, disposition) {
    const it = cc && cc.items[i];
    const input = card.querySelector('#cc-q');
    if (!it) {
      if (input && input.value.trim()) send('cc-run', { item: { run: { kind: 'search', query: input.value.trim() } }, disposition });
      return;
    }
    send('cc-run', { item: it, disposition });
  }
  function ccKey(e) {
    if (!cc) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = cc.items.length;
      if (!n) return;
      cc.sel = e.key === 'ArrowDown' ? (cc.sel + 1) % n : (cc.sel - 1 + n) % n;
      ccRender();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      ccRun(cc.sel, e.altKey ? 'new-tab' : 'current');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Tab jumps to the next section.
      const sec = cc.items[cc.sel]?.section;
      const next = cc.items.findIndex((it, i) => i > cc.sel && it.section !== sec);
      cc.sel = next >= 0 ? next : 0;
      ccRender();
    }
  }
  card.addEventListener('mousemove', (e) => {
    if (!current || current.kind !== 'command') return;
    const row = e.target.closest('.cc-item');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (i !== cc.sel) {
      cc.sel = i;
      for (const el of card.querySelectorAll('.cc-item')) el.classList.toggle('sel', Number(el.dataset.i) === i);
    }
  });
  card.addEventListener('click', (e) => {
    if (!current || current.kind !== 'command') return;
    const row = e.target.closest('.cc-item');
    if (row) ccRun(Number(row.dataset.i), e.ctrlKey || e.metaKey ? 'new-tab' : 'current');
  });

  // ------------------------------------------------------------------ Save to Collection
  function renderCollect(d) {
    card.className = 'card collect';
    if (!d.page) {
      card.innerHTML = `<div class="pp-empty">${I.collection}<p>Only web pages can be saved to a collection.</p><button class="link-btn" data-co="open">Open Collections</button></div>`;
      return;
    }
    const rows = d.collections.length
      ? d.collections.map((c) => `<button class="co-row ${c.id === d.recent ? 'recent' : ''}" data-co="add" data-id="${esc(c.id)}"><span class="co-cover" style="${c.cover ? `background-image:url(&quot;${esc(c.cover)}&quot;)` : `background:${esc(c.color)}`}"></span><span class="co-name">${esc(c.name)}</span><span class="co-count">${c.count}</span></button>`).join('')
      : '<div class="co-none">No collections yet — name your first one below.</div>';
    card.innerHTML = `
      <div class="pp-head">${I.collection}<div><b>Save to a collection</b><small title="${esc(d.page.url)}">${esc(d.page.title || d.page.url)}</small></div></div>
      <textarea class="co-note" id="co-note" rows="2" placeholder="Add a note (optional)"></textarea>
      <div class="co-list">${rows}</div>
      <div class="co-new"><input id="co-name" type="text" placeholder="New collection…" maxlength="80"><button class="pp-btn primary" data-co="new">Create &amp; save</button></div>
      <div class="pp-foot"><button class="link-btn" data-co="screenshot">${I.camera}<span>Screenshot instead</span></button><button class="link-btn" data-co="open">Open Collections</button></div>`;
    card.querySelector('#co-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        card.querySelector('[data-co="new"]').click();
      }
    });
  }
  card.addEventListener('click', (e) => {
    if (!current || current.kind !== 'collect') return;
    const b = e.target.closest('[data-co]');
    if (!b) return;
    const note = card.querySelector('#co-note')?.value || '';
    const op = b.dataset.co;
    if (op === 'add') return send('collect', { op: 'add', collectionId: b.dataset.id, note });
    if (op === 'new') {
      const name = card.querySelector('#co-name').value.trim();
      if (!name) return card.querySelector('#co-name').focus();
      return send('collect', { op: 'new', name, note });
    }
    if (op === 'screenshot') return send('collect', { op: 'screenshot', collectionId: d0(current).recent });
    if (op === 'open') return send('collect', { op: 'open' });
  });
  const d0 = (c) => (c && c.data) || {};

  // ------------------------------------------------------------------ Space editor
  let spaceDraft = null;
  function renderSpace(d) {
    card.className = 'card space-ed';
    const s = d.space;
    if (!spaceDraft || spaceDraft._for !== (s ? s.id : '')) {
      spaceDraft = s ? { _for: s.id, name: s.name, icon: s.icon, color: s.color, isolated: s.isolated, palette: s.look.palette || '', startupMode: s.startup.mode, urls: s.startup.urls.join('\n') } : { _for: '', name: '', icon: 'star', color: d.meta.colors[(d.total || 0) % d.meta.colors.length], isolated: false, palette: '', startupMode: 'newtab', urls: '' };
    }
    const dr = spaceDraft;
    const PALS = [['', 'Same as Vexa'], ['vexa', 'Vexa'], ['midnight', 'Midnight'], ['cyber', 'Cyber'], ['aurora', 'Aurora'], ['arcade', 'Arcade'], ['minimal', 'Minimal']];
    const canIsolate = !s || d.count === 0;
    card.innerHTML = `
      <div class="pp-head"><span class="sp-prev" style="--sp:${esc(dr.color)}">${window.VexaSpaceIcon(dr.icon)}</span><div><b>${s ? 'Edit Space' : 'New Space'}</b><small>${s ? `${d.count} open tab${d.count === 1 ? '' : 's'} in this window` : 'Its own tabs, look and startup pages'}</small></div></div>
      ${s ? '' : `<div class="sp-tpls">${d.meta.templates.map((t) => `<button class="chip" data-tpl="${esc(t.name)}" data-icon="${esc(t.icon)}" data-color="${esc(t.color)}" data-pal="${esc((t.look && t.look.palette) || '')}">${window.VexaSpaceIcon(t.icon).replace('width="18" height="18"', 'width="13" height="13"')}${esc(t.name)}</button>`).join('')}</div>`}
      <label class="pp-field">Name<input id="sp-name" type="text" maxlength="40" value="${esc(dr.name)}" placeholder="e.g. Work"></label>
      <div class="pp-label">Icon</div>
      <div class="sp-icons">${d.meta.icons.map((ic) => `<button class="sp-ib ${ic === dr.icon ? 'on' : ''}" data-icon-pick="${esc(ic)}" title="${esc(ic)}">${window.VexaSpaceIcon(ic).replace('width="18" height="18"', 'width="16" height="16"')}</button>`).join('')}</div>
      <div class="pp-label">Color</div>
      <div class="sp-colors">${d.meta.colors.map((c) => `<button class="sp-cb ${c === dr.color ? 'on' : ''}" data-color-pick="${esc(c)}" style="--c:${esc(c)}" aria-label="${esc(c)}"></button>`).join('')}</div>
      <label class="pp-field">Look<select id="sp-pal">${PALS.map(([v, n]) => `<option value="${v}" ${v === dr.palette ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="pp-field">When it opens<select id="sp-start"><option value="newtab" ${dr.startupMode === 'newtab' ? 'selected' : ''}>A New Tab page</option><option value="urls" ${dr.startupMode === 'urls' ? 'selected' : ''}>These pages…</option></select></label>
      <div class="sp-urls" ${dr.startupMode === 'urls' ? '' : 'hidden'}><textarea id="sp-urls" rows="3" placeholder="One address per line (https://…)">${esc(dr.urls)}</textarea>${d.current.url ? `<button class="link-btn" data-sp="use-current">Add the current page</button>` : ''}</div>
      <label class="pp-check ${canIsolate ? '' : 'disabled'}"><input type="checkbox" id="sp-iso" ${dr.isolated ? 'checked' : ''} ${canIsolate ? '' : 'disabled'}><span><b>Isolated</b><small>${canIsolate ? 'Its own cookies, logins and site storage — sign in to different accounts here.' : 'Close this Space’s tabs to change isolation.'}</small></span></label>
      <div class="pp-err" id="sp-err" hidden></div>
      <div class="pp-actions">${s && d.total > 1 ? '<button class="pp-btn danger" data-sp="delete">Delete</button>' : ''}<span class="grow"></span><button class="link-btn" data-sp="manage">All Spaces</button><button class="pp-btn primary" data-sp="save">${s ? 'Save' : 'Create Space'}</button></div>`;
    const name = card.querySelector('#sp-name');
    setTimeout(() => name.focus(), 0);
    name.addEventListener('input', () => (dr.name = name.value));
    name.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), card.querySelector('[data-sp="save"]').click()));
    card.querySelector('#sp-pal').addEventListener('change', (e) => (dr.palette = e.target.value));
    card.querySelector('#sp-start').addEventListener('change', (e) => {
      dr.startupMode = e.target.value;
      card.querySelector('.sp-urls').hidden = dr.startupMode !== 'urls';
    });
    card.querySelector('#sp-urls').addEventListener('input', (e) => (dr.urls = e.target.value));
    card.querySelector('#sp-iso').addEventListener('change', (e) => (dr.isolated = e.target.checked));
  }
  card.addEventListener('click', async (e) => {
    if (!current || current.kind !== 'space' || !spaceDraft) return;
    const dr = spaceDraft;
    const d = current.data;
    const tpl = e.target.closest('[data-tpl]');
    if (tpl) {
      Object.assign(dr, { name: dr.name || tpl.dataset.tpl, icon: tpl.dataset.icon, color: tpl.dataset.color, palette: tpl.dataset.pal });
      return renderSpace(d);
    }
    const ic = e.target.closest('[data-icon-pick]');
    if (ic) {
      dr.icon = ic.dataset.iconPick;
      return renderSpace(d);
    }
    const co = e.target.closest('[data-color-pick]');
    if (co) {
      dr.color = co.dataset.colorPick;
      return renderSpace(d);
    }
    const b = e.target.closest('[data-sp]');
    if (!b) return;
    if (b.dataset.sp === 'use-current') {
      dr.urls = (dr.urls.trim() ? dr.urls.trim() + '\n' : '') + d.current.url;
      return renderSpace(d);
    }
    if (b.dataset.sp === 'manage') return send('space', { op: 'manage' });
    const err = card.querySelector('#sp-err');
    try {
      if (b.dataset.sp === 'delete') {
        await api.overlay('space', { op: 'delete', id: d.space.id });
      } else if (b.dataset.sp === 'save') {
        const urls = dr.urls.split(/\s+/).map((u) => u.trim()).filter(Boolean).map((u) => (/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u));
        const data = { name: dr.name.trim() || 'Space', icon: dr.icon, color: dr.color, look: dr.palette ? { ...(d.space ? d.space.look : {}), palette: dr.palette } : { ...(d.space ? d.space.look : {}), palette: undefined }, startup: { mode: dr.startupMode, urls } };
        if (!d.space || d.count === 0) data.isolated = dr.isolated;
        await api.overlay('space', d.space ? { op: 'update', id: d.space.id, data } : { op: 'create', data });
      }
      spaceDraft = null;
    } catch (ex) {
      err.hidden = false;
      err.textContent = String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  });

  // ------------------------------------------------------------------ Focus
  function renderFocusPopup(d) {
    card.className = 'card focus-pp';
    const s = d.session;
    if (s && s.active) {
      const left = s.endsAt ? Math.max(0, s.endsAt - Date.now()) : 0;
      card.innerHTML = `
        <div class="pp-head">${I.target}<div><b>${esc(s.name)}</b><small>${s.done ? 'Session complete — nice work.' : s.endsAt ? `${Math.ceil(left / 60000)} min left` : 'No timer'}${s.blocking ? ' · distractions held back' : ''}</small></div></div>
        <div class="fp-row"><button class="pp-btn" data-fo="extend" data-min="10">+10 min</button><button class="pp-btn" data-fo="extend" data-min="25">+25 min</button></div>
        <div class="pp-label">End the session and…</div>
        <button class="fp-end" data-fo="stop" data-out="return"><b>Move its tabs back</b><small>to the Space you started from</small></button>
        <button class="fp-end" data-fo="stop" data-out="collect"><b>Save its tabs to a collection</b><small>named “${esc(s.name)}”, then close them</small></button>
        <button class="fp-end" data-fo="stop" data-out="keep"><b>Keep them as a Space</b><small>called “${esc(s.name)}”</small></button>`;
      return;
    }
    const m = d.defaults.minutes;
    card.innerHTML = `
      <div class="pp-head">${I.target}<div><b>Start a focus session</b><small>A Space for one task, a timer, and fewer distractions</small></div></div>
      <label class="pp-field">What are you working on?<input id="fo-name" type="text" maxlength="60" placeholder="e.g. Essay draft" value=""></label>
      <div class="pp-label">Timer</div>
      <div class="fp-mins">${[15, 25, 50, 90].map((x) => `<button class="chip ${x === m ? 'on' : ''}" data-min-pick="${x}">${x} min</button>`).join('')}<button class="chip ${m === 0 ? 'on' : ''}" data-min-pick="0">No timer</button></div>
      <label class="pp-check"><input type="checkbox" id="fo-block" ${d.defaults.blockDistractions ? 'checked' : ''}><span><b>Hold back distracting sites</b><small>The list is in Settings → Focus</small></span></label>
      <label class="pp-check"><input type="checkbox" id="fo-min" ${d.defaults.minimal ? 'checked' : ''}><span><b>Minimal interface</b><small>Hide tabs, sidebar and bookmarks bar</small></span></label>
      ${d.page && !d.isPrivate ? `<label class="pp-check"><input type="checkbox" id="fo-tab" checked><span><b>Bring this tab</b><small>${esc(d.page.title || '')}</small></span></label>` : ''}
      <div class="pp-actions"><button class="link-btn" data-fo="minimal">Just the minimal interface</button><span class="grow"></span><button class="pp-btn primary" data-fo="start">Start</button></div>`;
    card.dataset.minutes = String(m);
    setTimeout(() => card.querySelector('#fo-name')?.focus(), 0);
    card.querySelector('#fo-name').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), card.querySelector('[data-fo="start"]').click()));
  }
  card.addEventListener('click', (e) => {
    if (!current || current.kind !== 'focus') return;
    const pick = e.target.closest('[data-min-pick]');
    if (pick) {
      card.dataset.minutes = pick.dataset.minPick;
      for (const c of card.querySelectorAll('[data-min-pick]')) c.classList.toggle('on', c === pick);
      return;
    }
    const b = e.target.closest('[data-fo]');
    if (!b) return;
    const op = b.dataset.fo;
    if (op === 'start') {
      return send('focus', {
        op: 'start',
        name: card.querySelector('#fo-name').value,
        minutes: Number(card.dataset.minutes),
        blockDistractions: card.querySelector('#fo-block').checked,
        minimal: card.querySelector('#fo-min').checked,
        bringTab: card.querySelector('#fo-tab') ? card.querySelector('#fo-tab').checked : false
      });
    }
    if (op === 'minimal') return send('focus', { op: 'minimal' });
    if (op === 'extend') return send('focus', { op: 'extend', minutes: Number(b.dataset.min) });
    if (op === 'stop') return send('focus', { op: 'stop', outcome: b.dataset.out });
  });

  // ------------------------------------------------------------------ wiring
  function render() {
    card.hidden = false;
    if (current.kind === 'menu') renderMenu(current.data);
    else if (current.kind === 'downloads') renderDownloads(current.data);
    else if (current.kind === 'suggestions') renderSuggestions(current.data);
    else if (current.kind === 'shields') renderShields(current.data);
    else if (current.kind === 'command') renderCommand(current.data);
    else if (current.kind === 'collect') renderCollect(current.data);
    else if (current.kind === 'space') renderSpace(current.data);
    else if (current.kind === 'focus') renderFocusPopup(current.data);
    place();
  }

  api.on('popup:show', (p) => {
    current = p;
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
    render();
    if (p.kind === 'menu') setTimeout(() => card.querySelector('.mi')?.focus({ focusVisible: false }), 0);
    if (p.kind === 'shields') setTimeout(() => card.querySelector('.sh-master .sw')?.focus({ focusVisible: false }), 0);
  });
  api.on('popup:update', ({ kind, data }) => {
    if (!current || current.kind !== kind) return;
    // Interactive popups keep what the user is typing; they don't re-render on outside changes.
    if (kind === 'command' || kind === 'space' || kind === 'focus') return;
    if (kind === 'collect') {
      const note = card.querySelector('#co-note')?.value;
      current.data = data;
      render();
      if (note) card.querySelector('#co-note').value = note;
      return;
    }
    current.data = data;
    const scroll = card.querySelector('.dl-list')?.scrollTop;
    render();
    if (scroll) card.querySelector('.dl-list').scrollTop = scroll;
  });
  api.on('popup:hide', () => {
    current = null;
    cc = null;
    spaceDraft = null;
    card.hidden = true;
    card.innerHTML = '';
  });
})();
