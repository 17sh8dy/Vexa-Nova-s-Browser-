/* Vexa browser chrome — renders state pushed from the main process and sends commands back. */
(() => {
  'use strict';
  const I = window.VexaIcons;
  const api = window.vexaChrome;
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const isPrivate = params.get('private') === '1';
  const platform = params.get('platform') || 'win32';
  const isMac = platform === 'darwin';
  const MOD = isMac ? '⌘' : 'Ctrl';

  document.documentElement.classList.toggle('private', isPrivate);
  document.body.classList.add('platform-' + platform);

  let state = null;
  let lastActiveId = null;

  // ------------------------------------------------------------------ static icons
  $('#new-tab').innerHTML = I.plus;
  $('#back').innerHTML = I.back;
  $('#forward').innerHTML = I.forward;
  $('#reload').innerHTML = I.reload;
  $('#home').innerHTML = I.home;
  $('#star').innerHTML = I.star;
  $('#menu-btn').innerHTML = I.menu;
  $('#downloads-btn .dl-icon').innerHTML = I.download;
  $('.find-icon').innerHTML = I.search;
  $('#find-prev').innerHTML = I.chevronUp;
  $('#find-next').innerHTML = I.chevronDown;
  $('#find-close').innerHTML = I.close;
  $('.panel-mark').innerHTML = window.VexaMark(56);
  if (isPrivate) {
    const chip = $('#private-chip');
    chip.hidden = false;
    chip.innerHTML = `${I.mask}<span>Private</span>`;
    chip.title = 'Private window: history, cookies and site data are discarded when you close it.';
  }
  for (const el of document.querySelectorAll('[title]')) el.title = el.title.replace('Ctrl', MOD);

  // ------------------------------------------------------------------ layout reporting
  const chromeEl = $('#chrome');
  const toolbarEl = $('#toolbar');
  function reportLayout() {
    const h = chromeEl.getBoundingClientRect().height;
    const tb = toolbarEl.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty('--chrome-h', h + 'px');
    api.layout({ chromeHeight: h, toolbarBottom: tb });
  }
  new ResizeObserver(reportLayout).observe(chromeEl);
  window.addEventListener('resize', reportLayout);

  const cmd = (name, args) => api.cmd(name, args).catch((e) => console.error(name, e));
  const activeTab = () => state && state.tabs.find((t) => t.id === state.activeId);

  // ------------------------------------------------------------------ tabs
  const tabsEl = $('#tabs');
  const tabEls = new Map();

  function faviconHtml(t) {
    if (t.loading && !t.pending) return '<div class="spinner"></div>';
    if (t.crashed || t.error) return `<span class="fallback" style="color:var(--danger)">${I.warning}</span>`;
    if (t.internal) return window.VexaMark(16);
    if (t.favicon) return `<img src="${escapeAttr(t.favicon)}" alt="" draggable="false">`;
    return `<span class="fallback">${I.globe}</span>`;
  }

  function renderTabs() {
    const seen = new Set();
    state.tabs.forEach((t, index) => {
      seen.add(t.id);
      let el = tabEls.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tab';
        el.setAttribute('role', 'tab');
        el.dataset.id = t.id;
        el.innerHTML = '<div class="tab-icon"></div><div class="tab-title"></div><button class="tab-audio" tabindex="-1" hidden></button><button class="tab-close" tabindex="-1" aria-label="Close tab"></button>';
        el.querySelector('.tab-close').innerHTML = I.close;
        wireTab(el);
        tabEls.set(t.id, el);
      }
      // Keep DOM order in sync without re-creating nodes.
      if (tabsEl.children[index] !== el) tabsEl.insertBefore(el, tabsEl.children[index] || null);
      el.classList.toggle('active', t.id === state.activeId);
      el.setAttribute('aria-selected', t.id === state.activeId);
      el.title = t.title + (t.url && !t.isNewTab ? '\n' + t.url : '');
      const iconKey = `${t.loading && !t.pending}|${!!(t.crashed || t.error)}|${t.internal}|${t.favicon}`;
      if (el._iconKey !== iconKey) {
        el._iconKey = iconKey;
        const icon = el.querySelector('.tab-icon');
        icon.innerHTML = faviconHtml(t);
        const img = icon.querySelector('img');
        if (img) img.onerror = () => (icon.innerHTML = `<span class="fallback">${I.globe}</span>`);
      }
      const titleEl = el.querySelector('.tab-title');
      if (titleEl.textContent !== t.title) titleEl.textContent = t.title;
      const audio = el.querySelector('.tab-audio');
      const showAudio = t.audible || t.muted;
      audio.hidden = !showAudio;
      if (showAudio) {
        const key = t.muted ? 'm' : 'a';
        if (audio._k !== key) {
          audio._k = key;
          audio.innerHTML = t.muted ? I.muted : I.volume;
          audio.title = t.muted ? 'Unmute tab' : 'Mute tab';
        }
      }
    });
    for (const [id, el] of tabEls) {
      if (!seen.has(id)) {
        el.remove();
        tabEls.delete(id);
      }
    }
    updateNarrow();
    if (state.activeId !== lastActiveId) {
      const el = tabEls.get(state.activeId);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function updateNarrow() {
    for (const el of tabEls.values()) el.classList.toggle('narrow', el.getBoundingClientRect().width < 72);
  }
  new ResizeObserver(updateNarrow).observe(tabsEl);

  // Drag a tab: along the strip to reorder; off the strip to tear it into its own window, or
  // onto another Vexa window's strip to move it there (main decides, using the cursor position).
  let drag = null;
  const STRIP_H = 40;
  // Called by the main process when another window drops a tab on this strip.
  window.__vexaTabIndexAt = (x) => {
    const kids = [...tabsEl.children];
    const i = kids.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    return i < 0 ? kids.length : i;
  };
  function wireTab(el) {
    el.addEventListener('pointerdown', (e) => {
      const id = Number(el.dataset.id);
      if (e.target.closest('.tab-close') || e.target.closest('.tab-audio')) return;
      if (e.button === 1) {
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      cmd('activate-tab', { tabId: id });
      drag = { el, id, startX: e.clientX, moved: false, out: false, pointerId: e.pointerId };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.el !== el) return;
      const dx = e.clientX - drag.startX;
      const out = e.clientY < -12 || e.clientY > STRIP_H + 24 || e.clientX < -12 || e.clientX > window.innerWidth + 12;
      if (!drag.moved && Math.abs(dx) < 6 && !out) return;
      if (!drag.moved) {
        drag.moved = true;
        el.classList.add('dragging');
      }
      drag.out = out;
      el.classList.toggle('tearing', out);
      el.style.transform = out ? `translate(${dx}px, ${Math.max(-20, Math.min(e.clientY - STRIP_H / 2, 60))}px)` : `translateX(${dx}px)`;
    });
    const end = async (e) => {
      if (!drag || drag.el !== el) return;
      const d = drag;
      drag = null;
      el.classList.remove('dragging', 'tearing');
      el.style.transform = '';
      if (!d.moved) return;
      // Work out the in-strip position first (the DOM may change while we wait).
      const r = el.getBoundingClientRect();
      const center = r.left + r.width / 2 + (e.clientX - d.startX);
      const others = [...tabsEl.children].filter((c) => c !== el);
      let index = others.findIndex((c) => {
        const cr = c.getBoundingClientRect();
        return center < cr.left + cr.width / 2;
      });
      if (index < 0) index = others.length;
      let result = 'reorder';
      if (e.type === 'pointerup') {
        try {
          result = await cmd('tab-drop', { tabId: d.id, out: d.out });
        } catch {
          result = 'reorder';
        }
      }
      if (result !== 'moved' && !d.out) cmd('move-tab', { tabId: d.id, index });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) cmd('close-tab', { tabId: Number(el.dataset.id) });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cmd('tab-context', { tabId: Number(el.dataset.id) });
    });
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      cmd('close-tab', { tabId: Number(el.dataset.id) });
    });
    el.querySelector('.tab-audio').addEventListener('click', (e) => {
      e.stopPropagation();
      cmd('mute-tab', { tabId: Number(el.dataset.id) });
    });
  }

  // Double-click on empty strip space opens a new tab (the drag region handles maximize on the caption itself).
  tabsEl.addEventListener('dblclick', (e) => {
    if (e.target === tabsEl) cmd('action', { action: 'new-tab' });
  });

  $('#new-tab').addEventListener('click', () => cmd('action', { action: 'new-tab' }));

  // ------------------------------------------------------------------ toolbar
  $('#back').addEventListener('click', () => cmd('action', { action: 'back' }));
  $('#forward').addEventListener('click', () => cmd('action', { action: 'forward' }));
  $('#reload').addEventListener('click', (e) => {
    const t = activeTab();
    if (t && t.loading) cmd('action', { action: 'stop' });
    else cmd('action', { action: e.shiftKey || e.ctrlKey ? 'hard-reload' : 'reload' });
  });
  $('#home').addEventListener('click', () => cmd('action', { action: 'home' }));
  $('#star').addEventListener('click', () => cmd('action', { action: 'bookmark' }));
  $('#zoom-badge').addEventListener('click', () => cmd('action', { action: 'zoom-reset' }));
  $('#site-chip').addEventListener('click', () => {
    const t = activeTab();
    if (t && !t.internal && /^https?:/.test(t.url)) cmd('site-settings');
  });

  function anchorOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  $('#menu-btn').addEventListener('click', () => cmd('popup', { kind: 'menu', anchor: anchorOf($('#menu-btn')) }));
  $('#downloads-btn').addEventListener('click', () => cmd('popup', { kind: 'downloads', anchor: anchorOf($('#downloads-btn')) }));

  // Clicking anywhere in the chrome (outside the omnibox) dismisses an open popup.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!state || !state.popup) return;
      if (e.target.closest('#menu-btn') || e.target.closest('#downloads-btn')) return; // toggles handle it
      if (state.popup === 'suggestions' && e.target.closest('#omnibox')) return;
      cmd('popup-hide');
    },
    true
  );

  // ------------------------------------------------------------------ omnibox
  const omnibox = $('#omnibox');
  const address = $('#address');
  const urlDisplay = $('#url-display');
  let omni = { focused: false, typed: '', items: [], selected: -1, inline: null, editing: false };
  let suggestSeq = 0;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function displayFor(t) {
    if (!t || t.isNewTab) return '';
    return t.url;
  }

  function renderUrlDisplay(t) {
    const url = displayFor(t);
    if (!url) {
      urlDisplay.innerHTML = '';
      omnibox.classList.remove('has-display');
      return;
    }
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const rest = url.slice(u.protocol.length + 2 + u.host.length);
        urlDisplay.innerHTML = `<span class="scheme">${escapeHtml(u.protocol + '//')}</span><span class="host">${escapeHtml(u.host)}</span><span>${escapeHtml(rest)}</span>`;
      } else {
        urlDisplay.textContent = url;
      }
      omnibox.classList.add('has-display');
    } catch {
      urlDisplay.textContent = url;
      omnibox.classList.add('has-display');
    }
  }

  function renderSiteChip(t) {
    const chip = $('#site-chip');
    chip.className = 'site-chip';
    let html = '';
    let title = '';
    if (!t || t.isNewTab) {
      html = I.search;
      title = '';
    } else if (t.error || t.crashed) {
      chip.classList.add('error');
      html = I.warning;
      title = 'This page could not be loaded';
    } else if (t.internal) {
      chip.classList.add('internal');
      html = `${window.VexaMark(16)}<span class="chip-label">Vexa</span>`;
      title = 'Vexa page';
    } else if (/^https:/.test(t.url)) {
      html = I.lock;
      title = 'Connection is secure — click for site permissions';
    } else if (/^http:/.test(t.url)) {
      chip.classList.add('insecure');
      html = `${I.info}<span class="chip-label">Not secure</span>`;
      title = 'Your connection to this site is not secure';
    } else if (/^file:/.test(t.url)) {
      html = I.file.replace('width="18" height="18"', 'width="14" height="14"');
      title = 'Local file';
    } else {
      html = I.info;
    }
    chip.innerHTML = html;
    chip.title = title;
  }

  function setAddressFromTab(force = false) {
    const t = activeTab();
    if (omni.focused && omni.editing && !force) return;
    address.value = displayFor(t);
    address.placeholder = `Search ${state ? state.settings.searchEngineName : ''} or type a URL`;
    renderUrlDisplay(t);
  }

  address.addEventListener('focus', () => {
    omni.focused = true;
    omnibox.classList.add('focused');
    if (!omni.editing) {
      const t = activeTab();
      address.value = displayFor(t);
    }
    requestAnimationFrame(() => address.select());
  });

  address.addEventListener('blur', () => {
    omni.focused = false;
    omnibox.classList.remove('focused');
    // Give a click in the suggestion list time to register.
    setTimeout(() => {
      if (omni.focused) return;
      omni.editing = false;
      closeSuggestions();
      setAddressFromTab(true);
    }, 160);
  });

  // Prevent the mouseup after a click-focus from clearing the select-all.
  let focusClick = false;
  address.addEventListener('mousedown', () => {
    focusClick = document.activeElement !== address;
  });
  address.addEventListener('mouseup', (e) => {
    if (focusClick) {
      e.preventDefault();
      address.select();
      focusClick = false;
    }
  });

  address.addEventListener('input', (e) => {
    omni.editing = true;
    const isDelete = e.inputType && e.inputType.startsWith('delete');
    // When the user types over an inline completion, the selection already replaced it.
    omni.typed = address.value;
    omni.inline = null;
    requestSuggestions(omni.typed, !isDelete);
  });

  async function requestSuggestions(text, allowInline) {
    const seq = ++suggestSeq;
    if (!text.trim()) {
      omni.items = [];
      omni.selected = -1;
      closeSuggestions();
      return;
    }
    const res = await api.cmd('suggest', { text });
    if (seq !== suggestSeq || !omni.focused) return;
    omni.items = res.items || [];
    omni.selected = omni.items.length ? 0 : -1;
    // Inline autocomplete, only while the caret is at the end of what was typed.
    if (allowInline && res.inline && address.value === text && address.selectionStart === text.length) {
      const completion = res.inline.text;
      if (completion.toLowerCase().startsWith(text.toLowerCase()) && completion.length > text.length) {
        address.value = text + completion.slice(text.length);
        address.setSelectionRange(text.length, address.value.length);
        omni.inline = res.inline;
      }
    }
    showSuggestions();
  }

  function showSuggestions() {
    if (!omni.items.length) return closeSuggestions();
    const r = omnibox.getBoundingClientRect();
    cmd('show-suggestions', {
      items: omni.items,
      selected: omni.inline ? -2 : omni.selected,
      anchor: { x: r.left, y: r.top, width: r.width, height: r.height }
    });
  }

  function closeSuggestions() {
    if (state && state.popup === 'suggestions') cmd('popup-hide');
  }

  function commitNavigation(disposition) {
    let target;
    if (omni.inline && address.selectionStart !== address.selectionEnd) {
      target = omni.inline.url;
    } else if (omni.selected > 0 && omni.items[omni.selected]) {
      target = omni.items[omni.selected].url;
    } else {
      target = address.value.trim();
      if (omni.inline && address.value.toLowerCase() === omni.inline.text.toLowerCase()) target = omni.inline.url;
    }
    if (!target) return;
    omni.editing = false;
    omni.inline = null;
    closeSuggestions();
    cmd('navigate', { input: target, disposition });
    address.blur();
  }

  address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      let disposition = e.altKey || (e.shiftKey && !e.ctrlKey) ? 'new-tab' : 'current';
      if ((e.ctrlKey || e.metaKey) && !/[.\s/:]/.test(address.value.trim()) && address.value.trim()) {
        // Ctrl+Enter: "example" → www.example.com
        address.value = `www.${address.value.trim()}.com`;
        omni.inline = null;
        omni.selected = -1;
      }
      commitNavigation(disposition);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (state && state.popup === 'suggestions') {
        closeSuggestions();
        if (omni.inline) {
          address.value = omni.typed;
          omni.inline = null;
        }
      } else {
        omni.editing = false;
        setAddressFromTab(true);
        address.select();
        if (!activeTab()?.isNewTab) cmd('focus-page');
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!omni.items.length) return;
      e.preventDefault();
      const n = omni.items.length;
      if (omni.inline) {
        address.value = omni.typed;
        omni.inline = null;
      }
      omni.selected = e.key === 'ArrowDown' ? (omni.selected + 1) % n : (omni.selected - 1 + n) % n;
      const item = omni.items[omni.selected];
      if (item) address.value = item.type === 'search' ? item.title : item.url;
      showSuggestions();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (omni.inline && address.selectionStart !== address.selectionEnd) {
        // First backspace just removes the inline completion.
        e.preventDefault();
        address.value = omni.typed;
        omni.inline = null;
        showSuggestions();
      }
    } else if (e.key === 'Tab' && omni.inline) {
      e.preventDefault();
      address.setSelectionRange(address.value.length, address.value.length);
    }
  });

  api.on('suggestion-picked', () => {
    omni.editing = false;
    address.blur();
  });

  api.on('focus-address', () => {
    address.focus();
    address.select();
  });

  // ------------------------------------------------------------------ bookmarks bar
  const bmBar = $('#bookmarks-bar');
  function renderBookmarksBar() {
    const show = state.settings.showBookmarksBar;
    bmBar.hidden = !show;
    if (!show) return;
    const key = JSON.stringify(state.bookmarksBar);
    if (bmBar._key === key) return;
    bmBar._key = key;
    bmBar.innerHTML = '';
    if (!state.bookmarksBar.length) {
      bmBar.innerHTML = `<span class="bm-empty">Bookmark pages with ${MOD}+D or the star to see them here.</span>`;
      return;
    }
    for (const b of state.bookmarksBar) {
      const btn = document.createElement('button');
      btn.className = 'bm-item';
      btn.dataset.id = b.id;
      if (b.type === 'folder') {
        btn.innerHTML = `<span class="bm-fallback">${I.folder}</span><span></span>`;
        btn.title = b.title;
      } else {
        let origin = '';
        try {
          const u = new URL(b.url);
          if (/^https?:$/.test(u.protocol)) origin = u.origin;
        } catch {
          /* ignore */
        }
        btn.innerHTML = origin ? `<img alt="" src="${escapeAttr(origin + '/favicon.ico')}"><span></span>` : `<span class="bm-fallback">${I.globe}</span><span></span>`;
        const img = btn.querySelector('img');
        if (img) img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'bm-fallback', innerHTML: I.globe }));
        btn.title = `${b.title}\n${b.url}`;
      }
      btn.querySelector('span:last-child').textContent = b.title || b.url;
      btn.addEventListener('click', (e) => {
        if (b.type === 'folder') cmd('bookmark-folder', { id: b.id });
        else cmd('bookmark-open', { id: b.id, disposition: e.ctrlKey || e.metaKey ? 'background' : e.shiftKey ? 'new-tab' : 'current' });
      });
      btn.addEventListener('auxclick', (e) => {
        if (e.button === 1 && b.type !== 'folder') cmd('bookmark-open', { id: b.id, disposition: 'background' });
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        cmd('bookmark-context', { id: b.id });
      });
      bmBar.appendChild(btn);
    }
  }

  // ------------------------------------------------------------------ permission bar
  const permBar = $('#permission-bar');
  const PERM_TEXT = {
    media: (r) => {
      const v = r.mediaTypes?.includes('video');
      const a = r.mediaTypes?.includes('audio');
      return v && a ? 'use your camera and microphone' : v ? 'use your camera' : a ? 'use your microphone' : 'use your camera or microphone';
    },
    geolocation: () => 'know your location',
    notifications: () => 'show notifications',
    midiSysex: () => 'control MIDI devices',
    'clipboard-read': () => 'see text and images copied to the clipboard',
    'display-capture': () => 'share your screen',
    openExternal: (r) => `open an external application${r.externalURL ? ` (${r.externalURL.split(':')[0]}:)` : ''}`
  };
  const PERM_ICON = { media: I.camera, geolocation: I.pin, notifications: I.bell, openExternal: I.external };
  function renderPermission(t) {
    const p = t && t.permission;
    permBar.hidden = !p;
    if (!p) return;
    if (permBar._id === p.id) return;
    permBar._id = p.id;
    let host = p.origin;
    try {
      host = new URL(p.origin).host;
    } catch {
      /* keep origin */
    }
    permBar.querySelector('.infobar-icon').innerHTML = PERM_ICON[p.permission] || I.shield;
    permBar.querySelector('.infobar-text').innerHTML = `<strong>${escapeHtml(host)}</strong> wants to ${escapeHtml((PERM_TEXT[p.permission] || (() => p.permission))(p))}`;
    permBar.querySelector('.infobar-remember').hidden = !!p.oneOff;
    permBar.querySelector('.infobar-remember input').checked = true;
  }
  permBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-decision]');
    const t = activeTab();
    if (!b || !t || !t.permission) return;
    cmd('permission', { tabId: t.id, reqId: t.permission.id, decision: b.dataset.decision, remember: permBar.querySelector('.infobar-remember input').checked });
  });

  // ------------------------------------------------------------------ save-password bar
  const pwBar = $('#password-bar');
  function renderPasswordPrompt(t) {
    const p = t && t.passwordPrompt;
    pwBar.hidden = !p;
    if (!p) return;
    if (pwBar._id === p.id) return;
    pwBar._id = p.id;
    let host = p.origin;
    try {
      host = new URL(p.origin).host;
    } catch {
      /* keep origin */
    }
    pwBar.querySelector('.infobar-icon').innerHTML = I.shield;
    const who = p.username ? ` for <strong>${escapeHtml(p.username)}</strong>` : '';
    pwBar.querySelector('.infobar-text').innerHTML = p.update
      ? `Update the saved password${who} on <strong>${escapeHtml(host)}</strong>?`
      : `Save the password${who} on <strong>${escapeHtml(host)}</strong>?`;
    pwBar.querySelector('[data-decision="save"]').textContent = p.update ? 'Update' : 'Save';
  }
  pwBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-decision]');
    const t = activeTab();
    if (!b || !t || !t.passwordPrompt) return;
    cmd('password-decision', { tabId: t.id, decision: b.dataset.decision });
  });

  // ------------------------------------------------------------------ find bar
  const findbar = $('#findbar');
  const findInput = $('#find-input');
  const findCount = $('#find-count');
  let findTabId = null;
  function renderFind(t) {
    const f = t && t.find;
    const open = !!(f && f.active);
    findbar.hidden = !open;
    if (!open) return;
    if (findTabId !== t.id) {
      findTabId = t.id;
      findInput.value = f.text || '';
    }
    if (!findInput.value) {
      findCount.textContent = '';
      findCount.classList.remove('none');
    } else {
      findCount.textContent = f.matches ? `${f.ordinal} of ${f.matches}` : 'No results';
      findCount.classList.toggle('none', !f.matches);
    }
  }
  api.on('find-open', () => {
    findbar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) cmd('find', { text: findInput.value });
  });
  findInput.addEventListener('input', () => cmd('find', { text: findInput.value }));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      cmd('find', { text: findInput.value, forward: !e.shiftKey, findNext: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cmd('find-stop');
    }
  });
  $('#find-next').addEventListener('click', () => cmd('find', { text: findInput.value, forward: true, findNext: true }));
  $('#find-prev').addEventListener('click', () => cmd('find', { text: findInput.value, forward: false, findNext: true }));
  $('#find-close').addEventListener('click', () => cmd('find-stop'));

  // ------------------------------------------------------------------ error / crash panel
  const ERRORS = {
    '-105': ['This site can’t be reached', (h) => `Vexa couldn’t find the server for <b>${h}</b>. Check the address for typos, or search for it instead.`],
    '-137': ['This site can’t be reached', (h) => `The address for <b>${h}</b> couldn’t be resolved.`],
    '-106': ['You’re offline', () => 'Vexa can’t reach the internet. Check your network connection, then try again.'],
    '-21': ['Your network changed', () => 'The connection was interrupted because your network changed. Try again.'],
    '-102': ['This site refused to connect', (h) => `<b>${h}</b> refused the connection. The server may be down or not accepting connections.`],
    '-101': ['The connection was reset', (h) => `The connection to <b>${h}</b> was interrupted.`],
    '-118': ['This site took too long to respond', (h) => `<b>${h}</b> didn’t respond in time.`],
    '-7': ['This site took too long to respond', (h) => `<b>${h}</b> didn’t respond in time.`],
    '-109': ['This site can’t be reached', (h) => `<b>${h}</b> is unreachable from your network.`],
    '-324': ['The page didn’t send any data', (h) => `<b>${h}</b> closed the connection without sending a response.`],
    '-310': ['This page isn’t working', (h) => `<b>${h}</b> redirected you too many times.`],
    '-6': ['File not found', () => 'The file may have been moved, renamed or deleted.'],
    '-10': ['Access denied', () => 'Vexa doesn’t have permission to open this file.'],
    '-20': ['This page was blocked', () => 'This page was blocked by Vexa.'],
    '-27': ['This content is blocked', (h) => `<b>${h}</b> doesn’t allow itself to be shown here.`],
    '-300': ['That address isn’t valid', () => 'Check the address and try again.'],
    '-301': ['Vexa can’t open this link', () => 'This type of address isn’t supported.'],
    '-302': ['Vexa can’t open this link', () => 'This type of address isn’t supported.'],
    '-501': ['This site can’t provide a secure connection', (h) => `<b>${h}</b> sent an invalid response.`],
    '-130': ['Proxy connection failed', () => 'There’s a problem with your proxy server.']
  };
  function hostOf(url) {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  }
  function renderPanel(t) {
    const panel = $('#panel');
    const show = !!(t && (t.error || t.crashed));
    panel.hidden = !show;
    if (!show) return;
    const host = escapeHtml(hostOf(t.url));
    let title;
    let desc;
    let code;
    if (t.crashed) {
      title = 'This tab stopped working';
      desc = t.crashed === 'oom' ? 'The page ran out of memory.' : 'Something went wrong while displaying this page.';
      code = `Renderer: ${t.crashed}`;
    } else {
      const c = String(t.error.code);
      const entry = ERRORS[c];
      if (entry) {
        title = entry[0];
        desc = entry[1](host);
      } else if (t.error.code <= -200 && t.error.code > -300) {
        title = 'Your connection isn’t private';
        desc = `Vexa stopped loading <b>${host}</b> because its security certificate couldn’t be verified. Attackers might be trying to intercept your information.`;
      } else {
        title = 'This page couldn’t be loaded';
        desc = `Something went wrong loading <b>${host}</b>.`;
      }
      code = `${t.error.description || 'ERROR'} (${t.error.code})`;
    }
    $('#panel-title').textContent = title;
    $('#panel-desc').innerHTML = desc;
    $('#panel-code').textContent = code;
    $('#panel-back').hidden = !t.canGoBack;
    const isCert = t.error && t.error.code <= -200 && t.error.code > -300;
    $('#panel-retry').textContent = t.crashed ? 'Reload' : 'Try again';
    $('#panel-retry').hidden = false;
    $('#panel-back').classList.toggle('primary', !!isCert);
    $('#panel-retry').classList.toggle('primary', !isCert);
  }
  $('#panel-retry').addEventListener('click', () => cmd('action', { action: 'reload' }));
  $('#panel-back').addEventListener('click', () => cmd('action', { action: 'back' }));

  // ------------------------------------------------------------------ downloads button
  const dlBtn = $('#downloads-btn');
  function renderDownloads() {
    const d = state.downloads;
    dlBtn.hidden = !d.hasItems && !d.active;
    dlBtn.classList.toggle('active', d.active > 0);
    dlBtn.classList.toggle('indeterminate', d.active > 0 && d.progress === -1);
    const fill = dlBtn.querySelector('.ring-fill');
    if (d.active > 0 && d.progress >= 0) fill.style.strokeDashoffset = String(97.4 * (1 - d.progress));
    dlBtn.title = d.active ? `${d.active} download${d.active > 1 ? 's' : ''} in progress (${MOD}+J)` : `Downloads (${MOD}+J)`;
  }
  api.on('downloads-started', () => {
    // Wait for state to reveal the button, then pulse and open the panel.
    setTimeout(() => {
      dlBtn.hidden = false;
      dlBtn.classList.remove('pulse');
      void dlBtn.offsetWidth;
      dlBtn.classList.add('pulse');
      if (!state || state.popup !== 'downloads') cmd('popup', { kind: 'downloads', anchor: anchorOf(dlBtn) });
    }, 60);
  });

  // ------------------------------------------------------------------ popup state
  api.on('popup-closed', () => {
    $('#menu-btn').classList.remove('open');
    dlBtn.classList.remove('open');
  });

  // ------------------------------------------------------------------ state
  function render() {
    const t = activeTab();
    document.body.classList.toggle('fullscreen', !!state.fullscreen);
    renderTabs();
    $('#back').disabled = !(t && t.canGoBack);
    $('#forward').disabled = !(t && t.canGoForward);
    const reload = $('#reload');
    const loading = !!(t && t.loading && !t.pending);
    if (reload._loading !== loading) {
      reload._loading = loading;
      reload.innerHTML = loading ? I.stop : I.reload;
      reload.title = loading ? 'Stop loading (Esc)' : `Reload (${MOD}+R)`;
    }
    $('#home').hidden = !state.settings.showHomeButton;
    $('#progress').classList.toggle('on', loading);

    const star = $('#star');
    const canStar = t && /^(https?|file):/.test(t.url) && !t.error;
    star.hidden = !canStar;
    star.classList.toggle('on', !!(t && t.bookmarked));
    const starKey = t && t.bookmarked ? 'on' : 'off';
    if (star._k !== starKey) {
      star._k = starKey;
      star.innerHTML = t && t.bookmarked ? I.starFilled : I.star;
      star.title = t && t.bookmarked ? `Remove bookmark (${MOD}+D)` : `Bookmark this page (${MOD}+D)`;
    }

    const zoom = $('#zoom-badge');
    const z = t ? Math.round(t.zoom * 100) : 100;
    zoom.hidden = z === 100;
    zoom.textContent = z + '%';

    if (state.activeId !== lastActiveId) {
      omni.editing = false;
      if (lastActiveId !== null && omni.focused && !(t && t.isNewTab)) address.blur();
    }
    renderSiteChip(t);
    setAddressFromTab();
    renderBookmarksBar();
    renderPermission(t);
    renderPasswordPrompt(t);
    renderFind(t);
    renderPanel(t);
    renderDownloads();
    $('#menu-btn').classList.toggle('open', state.popup === 'menu');
    dlBtn.classList.toggle('open', state.popup === 'downloads');
    lastActiveId = state.activeId;
  }

  api.on('state', (s) => {
    state = s;
    window.__vexaState = s; // read by the end-to-end tests
    render();
  });

  reportLayout();
})();
