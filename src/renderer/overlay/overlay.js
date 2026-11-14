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
    api.on('status:show', (text) => {
      el.hidden = false;
      el.textContent = text;
    });
    return;
  }

  backdrop.addEventListener('mousedown', () => send('hide'));

  // ------------------------------------------------------------------ positioning
  function place() {
    const { kind, anchor, width } = current;
    const a = anchor || { x: width - 50, bottom: 0, right: width - 10, width: 40 };
    card.style.top = Math.max(4, a.bottom + 6) + 'px';
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
      <button class="sh-expand ${shExpanded ? 'open' : ''}" data-sh="expand">${I.chevronDown}<span>Customise for this site</span></button>
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
  const SG_ICON = { search: I.search, url: I.globe, history: I.clock, bookmark: I.bookmark };
  function renderSuggestions(d) {
    card.className = 'card suggest';
    card.innerHTML = d.items
      .map((it, i) => {
        let text;
        if (it.type === 'search') text = `${esc(it.title)} <span class="dim">— ${esc(it.subtitle)}</span>`;
        else if (it.type === 'url') text = `<span class="url">${esc(it.title)}</span>`;
        else text = `${esc(it.title)} <span class="dim">— </span><span class="url">${esc(it.url.replace(/^https?:\/\/(www\.)?/, ''))}</span>`;
        const icon = it.favicon ? `<img src="${esc(it.favicon)}" alt="">` : SG_ICON[it.type];
        const tag = it.type === 'bookmark' ? 'Bookmark' : it.type === 'history' ? 'History' : '';
        return `<div class="sg ${i === d.selected ? 'sel' : ''}" data-i="${i}"><span class="sg-icon">${icon}</span><span class="sg-text">${text}</span><span class="sg-tag">${tag}</span></div>`;
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
    if (it) send('pick-suggestion', { url: it.url, disposition: e.button === 1 || e.ctrlKey || e.metaKey ? 'background' : 'current' });
  });

  // ------------------------------------------------------------------ wiring
  function render() {
    card.hidden = false;
    if (current.kind === 'menu') renderMenu(current.data);
    else if (current.kind === 'downloads') renderDownloads(current.data);
    else if (current.kind === 'suggestions') renderSuggestions(current.data);
    else if (current.kind === 'shields') renderShields(current.data);
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
    current.data = data;
    const scroll = card.querySelector('.dl-list')?.scrollTop;
    render();
    if (scroll) card.querySelector('.dl-list').scrollTop = scroll;
  });
  api.on('popup:hide', () => {
    current = null;
    card.hidden = true;
    card.innerHTML = '';
  });
})();
