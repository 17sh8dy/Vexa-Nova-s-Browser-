/* Vexa 0.90 browser UI: Atmosphere (look + sounds + effects), sidebar, Space chip, focus
   chip, research panel, toasts, Reader / Collections buttons. Runs after chrome.js and
   renders from the same state snapshot (window.VexaChrome.onRender). */
(() => {
  'use strict';
  const I = window.VexaIcons;
  const api = window.vexaChrome;
  const C = window.VexaChrome;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const cmd = C.cmd;
  const root = document.documentElement;
  const body = document.body;
  const isPrivate = root.classList.contains('private');
  const darkMq = matchMedia('(prefers-color-scheme: dark)');
  const reduceMq = matchMedia('(prefers-reduced-motion: reduce)');

  // ------------------------------------------------------------------ static icons
  $('#reader-btn').innerHTML = I.reader;
  $('#collect-btn').innerHTML = I.collection;
  $('#sb-add').innerHTML = I.plus;
  $('#sb-command').innerHTML = I.command;
  $('#sb-collections').innerHTML = I.collection;
  $('#sb-focus').innerHTML = I.target.replace('width="18" height="18"', 'width="16" height="16"');
  $('#sb-customize').innerHTML = I.palette;
  $('.fc-icon').innerHTML = I.target.replace('width="18" height="18"', 'width="15" height="15"');
  $('.rs-icon').innerHTML = I.book;
  $('#rs-close').innerHTML = I.close;
  for (const el of document.querySelectorAll('[title]')) el.title = el.title.replace('Ctrl', C.MOD);

  // (Toasts are shown by the status layer above the page — see window.toast / overlay.js.)

  // ------------------------------------------------------------------ sounds
  const engine = new window.VexaSoundEngine({
    fetchCustom: async (id) => {
      const bytes = await api.cmd('atmo-sound-bytes', { id });
      return bytes || null;
    }
  });
  window.__vexaSound = engine; // read by the end-to-end tests
  let soundKey = '';
  const played = []; // last few categories played (tests + debugging)
  window.__vexaSoundLog = played;
  api.on('atmo:play', (category) => {
    played.push(category);
    if (played.length > 50) played.shift();
    engine.play(category);
  });
  // The browser UI's own typing (address bar, find bar) and clicks.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.repeat && !e.ctrlKey && !e.metaKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') && e.target instanceof HTMLInputElement) engine.play('typing');
    },
    true
  );
  document.addEventListener('pointerdown', (e) => e.button === 0 && e.target.closest('button, .tab, .sb-space') && engine.play('click'), true);

  // ------------------------------------------------------------------ look (palette, accent, motion, effects)
  let lookKey = '';
  let fx = null;
  function applyLook(look) {
    const key = JSON.stringify(look) + '|' + darkMq.matches;
    if (key === lookKey) return;
    lookKey = key;
    window.VexaPalettes.apply(document, look, darkMq.matches);
    body.dataset.tabAnim = look.tabAnimation || 'smooth';
    body.classList.toggle('no-transitions', look.transitions === false || reduceMq.matches);
    const effect = reduceMq.matches && look.effect !== 'none' ? 'static-' + look.effect : look.effect || 'none';
    const wp = look.wallpaper;
    body.dataset.effect = effect;
    body.classList.toggle('has-atmo', effect !== 'none' || !!wp);
    const wpEl = document.querySelector('.atmo-wp');
    wpEl.style.backgroundImage = wp ? `url("${String(wp.url).replace(/"/g, '%22')}")` : '';
    body.classList.toggle('atmo-wp-on', !!wp);
    body.classList.toggle('atmo-wp-light', !!(wp && wp.tone === 'light'));
    startEffect(effect);
  }
  darkMq.addEventListener('change', () => {
    lookKey = '';
    const s = C.state();
    if (s) applyLook(s.look);
  });

  // Animated star field for the "stars" effect: low frame rate, paused when the window is
  // in the background, never runs for the other effects (which are CSS only).
  const canvas = $('#atmo-canvas');
  function startEffect(effect) {
    if (fx) {
      fx.stop();
      fx = null;
    }
    canvas.hidden = effect !== 'stars';
    if (effect !== 'stars') return;
    const ctx = canvas.getContext('2d');
    let raf = 0;
    let last = 0;
    let stars = [];
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(160, Math.round((innerWidth * innerHeight) / 9000));
      stars = Array.from({ length: n }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: Math.random() * 1.3 + 0.3, p: Math.random() * Math.PI * 2, s: 0.4 + Math.random() * 1.2, v: 0.05 + Math.random() * 0.15 }));
    };
    resize();
    window.addEventListener('resize', resize);
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const fps = document.hasFocus() ? 24 : 4;
      if (now - last < 1000 / fps) return;
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const col = getComputedStyle(root).getPropertyValue('--accent-2').trim() || '#c084fc';
      for (const st of stars) {
        st.p += dt * st.s;
        st.x -= st.v * dt * 20;
        if (st.x < -2) st.x = innerWidth + 2;
        ctx.globalAlpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(st.p));
        ctx.fillStyle = st.r > 1.1 ? col : '#ffffff';
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    fx = {
      stop() {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }

  api.on('space-switched', () => {
    body.classList.remove('space-anim');
    void body.offsetWidth;
    body.classList.add('space-anim');
  });

  // ------------------------------------------------------------------ sidebar
  const sb = $('#sidebar');
  const SB_W = { compact: 52, wide: 196 };
  const RS_W = 330;
  let sbVisible = false;
  let rsVisible = false;
  let sbSide = 'left';
  let sbSize = 'compact';
  window.__vexaInsets = () => {
    const w = sbVisible ? SB_W[sbSize] : 0;
    return { left: sbSide === 'left' ? w : 0, right: (sbSide === 'right' ? w : 0) + (rsVisible ? RS_W : 0) };
  };

  function spaceButton(s, active) {
    const icon = window.VexaSpaceIcon(s.icon).replace('width="18" height="18"', 'width="17" height="17"');
    return `<button class="sb-space ${active ? 'on' : ''}" data-space="${esc(s.id)}" style="--sp:${esc(s.color)}" title="${esc(s.name)}${s.isolated ? ' (isolated)' : ''}${s.count ? ` · ${s.count} tab${s.count === 1 ? '' : 's'}` : ''}" aria-pressed="${active}">
      <span class="sp-ic">${icon}</span><span class="sp-name">${esc(s.name)}</span>${s.isolated ? '<span class="sp-lock" title="Isolated: its own cookies and storage"></span>' : ''}</button>`;
  }

  let sbKey = '';
  function renderSidebar(state) {
    const cfg = state.sidebar || {};
    const minimal = !!(state.focus && state.focus.minimal);
    const show = !!cfg.show && !isPrivate && !minimal && !state.fullscreen;
    const changed = show !== sbVisible || cfg.side !== sbSide || cfg.size !== sbSize;
    sbVisible = show;
    sbSide = cfg.side || 'left';
    sbSize = cfg.size || 'compact';
    sb.hidden = !show;
    sb.classList.toggle('right', sbSide === 'right');
    sb.classList.toggle('wide', sbSize === 'wide');
    sb.style.width = SB_W[sbSize] + 'px';
    if (changed) C.reportLayout();
    if (!show) return;
    const items = cfg.items || {};
    const key = JSON.stringify([state.spaces, state.spaceId, state.pinnedSites, items, state.focus && state.focus.active]);
    if (key === sbKey) return;
    sbKey = key;
    $('#sb-spaces').hidden = items.spaces === false;
    $('#sb-add').hidden = items.spaces === false;
    $('#sb-spaces').innerHTML = state.spaces.map((s) => spaceButton(s, s.id === state.spaceId)).join('');
    const pins = state.pinnedSites || [];
    const showPins = items.pinned !== false;
    $('#sb-pinned').hidden = !showPins;
    $('#sb-sep-pinned').hidden = !showPins || !pins.length;
    $('#sb-pinned').innerHTML = pins
      .map((p) => {
        let origin = '';
        try {
          origin = new URL(p.url).origin;
        } catch {
          /* ignore */
        }
        const host = origin.replace(/^https?:\/\/(www\.)?/, '');
        return `<button class="sb-pin" data-url="${esc(p.url)}" title="${esc(p.title || host)}\n${esc(p.url)}"><img alt="" src="${esc(origin + '/favicon.ico')}"><span class="pin-letter">${esc((host[0] || '?').toUpperCase())}</span><span class="sp-name">${esc(p.title || host)}</span></button>`;
      })
      .join('');
    for (const img of $('#sb-pinned').querySelectorAll('img')) img.onerror = () => img.remove();
    $('#sb-command').hidden = items.command === false;
    $('#sb-collections').hidden = items.collections === false;
    $('#sb-focus').hidden = items.focus === false;
    $('#sb-focus').classList.toggle('on', !!(state.focus && state.focus.active));
  }

  sb.addEventListener('click', (e) => {
    const sp = e.target.closest('[data-space]');
    if (sp) return cmd('switch-space', { spaceId: sp.dataset.space });
    const pin = e.target.closest('[data-url]');
    if (pin) return cmd('open-pinned', { url: pin.dataset.url, newTab: e.ctrlKey || e.metaKey });
    if (e.target.closest('#sb-add')) return cmd('popup', { kind: 'space', anchor: C.anchorOf($('#sb-add')) });
    if (e.target.closest('#sb-command')) return cmd('action', { action: 'command-center' });
    if (e.target.closest('#sb-collections')) return cmd('action', { action: 'collections' });
    if (e.target.closest('#sb-focus')) return cmd('popup', { kind: 'focus', anchor: C.anchorOf($('#sb-focus')) });
    if (e.target.closest('#sb-customize')) return cmd('action', { action: 'customize' });
  });
  sb.addEventListener('auxclick', (e) => {
    const pin = e.target.closest('[data-url]');
    if (pin && e.button === 1) cmd('open-pinned', { url: pin.dataset.url, newTab: true });
  });
  sb.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sp = e.target.closest('[data-space]');
    if (sp) return cmd('space-context', { spaceId: sp.dataset.space });
    const pin = e.target.closest('[data-url]');
    if (pin) return cmd('pinned-context', { url: pin.dataset.url });
    cmd('sidebar-context');
  });
  // Drag a tab onto a Space in the sidebar is not supported (Spaces may not share a session);
  // use the tab's menu → Move tab to Space.

  // ------------------------------------------------------------------ Space chip (tab strip)
  const chip = $('#space-chip');
  chip.addEventListener('click', () => cmd('action', { action: 'command-center' }));
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const s = C.state();
    if (s) cmd('space-context', { spaceId: s.spaceId });
  });
  function renderSpaceChip(state) {
    const cur = state.spaces.find((s) => s.id === state.spaceId);
    const show = !isPrivate && !!cur && (!sbVisible || state.spaces.length > 1) && !(state.focus && state.focus.minimal);
    chip.hidden = !show || sbVisible;
    if (!show) return;
    const key = `${cur.id}|${cur.icon}|${cur.color}|${cur.name}`;
    if (chip._k === key) return;
    chip._k = key;
    chip.style.setProperty('--sp', cur.color);
    chip.innerHTML = `${window.VexaSpaceIcon(cur.icon).replace('width="18" height="18"', 'width="15" height="15"')}<span>${esc(cur.name)}</span>`;
    chip.title = `Space: ${cur.name} — click for the Command Center`;
  }

  // ------------------------------------------------------------------ focus chip + minimal UI
  const fchip = $('#focus-chip');
  const ftitle = $('#focus-title');
  let focusTimer = null;
  fchip.addEventListener('click', () => cmd('popup', { kind: 'focus', anchor: C.anchorOf(fchip) }));
  function fmtLeft(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function tickFocus() {
    const s = C.state();
    const f = s && s.focus;
    clearTimeout(focusTimer);
    if (!f || !f.active) return;
    let text;
    if (f.done) text = 'Done';
    else if (f.endsAt) text = fmtLeft(f.endsAt - Date.now());
    else text = fmtLeft(Date.now() - f.startedAt);
    fchip.querySelector('.fc-time').textContent = text;
    fchip.classList.toggle('done', !!f.done);
    if (f.minimal) ftitle.innerHTML = `${I.target.replace('width="18" height="18"', 'width="14" height="14"')}<span>${esc(f.name)}</span><b>${esc(text)}</b>`;
    focusTimer = setTimeout(tickFocus, 1000 - (Date.now() % 1000) + 10);
  }
  function renderFocus(state) {
    const f = state.focus;
    const minimal = !!(f && f.minimal);
    body.classList.toggle('minimal', minimal);
    fchip.hidden = !(f && f.active);
    ftitle.hidden = !minimal;
    if (minimal && !(f && f.active)) ftitle.innerHTML = `<span>Minimal interface</span><b>${C.MOD}+Shift+F to exit</b>`;
    fchip.title = f && f.active ? `Focus: ${f.name}${f.blocking ? ' · distractions held back' : ''}` : '';
    tickFocus();
  }

  // ------------------------------------------------------------------ Reader + Collections buttons
  $('#reader-btn').addEventListener('click', () => cmd('reader'));
  $('#collect-btn').addEventListener('click', () => cmd('popup', { kind: 'collect', anchor: C.anchorOf($('#collect-btn')) }));
  function renderButtons(state, t) {
    const web = !!(t && /^https?:/i.test(t.url) && !t.error);
    const inReader = !!(t && t.url.startsWith('vexa://reader/'));
    $('#reader-btn').hidden = !(web || inReader);
    $('#reader-btn').classList.toggle('on', inReader);
    $('#reader-btn').title = inReader ? 'Leave Reader view (F9)' : `Reader view (F9)`;
    $('#collect-btn').hidden = !web || isPrivate;
    $('#collect-btn').classList.toggle('open', state.popup === 'collect');
  }

  // ------------------------------------------------------------------ research panel
  const rs = $('#research');
  let rsKey = '';
  function renderResearch(state) {
    const r = state.research;
    const show = !!r && !state.fullscreen;
    if (show !== rsVisible) {
      rsVisible = show;
      rs.hidden = !show;
      C.reportLayout();
    }
    if (!show) return;
    const key = JSON.stringify(r);
    if (key === rsKey) return;
    rsKey = key;
    $('#rs-collection').innerHTML = r.all.map((c) => `<option value="${esc(c.id)}" ${c.id === r.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const ICON = { link: I.link, article: I.reader, image: I.image, screenshot: I.camera, video: I.video, note: I.note, file: I.file };
    $('#rs-list').innerHTML = r.items.length
      ? r.items
          .map(
            (i) => `<div class="rs-item ${i.type}" data-id="${esc(i.id)}">
          <span class="rs-ic">${ICON[i.type] || I.link}</span>
          <div class="rs-body">${i.type === 'note' ? `<div class="rs-notetext">${esc(i.note).slice(0, 600)}</div>` : `<div class="rs-title">${esc(i.title || i.url)}</div>`}${i.url ? `<button class="rs-url" data-open="${esc(i.url)}">${esc(i.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</button>` : ''}</div>
          <button class="rs-x" data-remove="${esc(i.id)}" title="Remove">${I.trash}</button></div>`
          )
          .join('')
      : `<div class="rs-empty">Nothing here yet. Save the page, clip a selection or write a note — it all goes into <b>${esc(r.name)}</b>.</div>`;
  }
  $('#rs-close').addEventListener('click', () => cmd('research', { op: 'close' }));
  $('#rs-collection').addEventListener('change', (e) => cmd('research', { op: 'collection', id: e.target.value }));
  $('#rs-save').addEventListener('click', () => cmd('research', { op: 'save-page' }));
  $('#rs-clip').addEventListener('click', () => cmd('research', { op: 'clip' }));
  $('#rs-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const text = e.target.value.trim();
      if (text) cmd('research', { op: 'note', text }).then(() => (e.target.value = ''));
    }
  });
  $('#rs-list').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) return cmd('research', { op: 'remove', itemId: rm.dataset.remove });
    const op = e.target.closest('[data-open]');
    if (op) return cmd('research', { op: 'open', url: op.dataset.open });
  });

  // ------------------------------------------------------------------ render hook
  C.onRender((state, t) => {
    if (state.look) applyLook(state.look);
    const sk = JSON.stringify(state.sounds || {});
    if (sk !== soundKey) {
      soundKey = sk;
      engine.configure(state.sounds || {});
    }
    renderSidebar(state);
    renderSpaceChip(state);
    renderFocus(state);
    renderButtons(state, t);
    renderResearch(state);
  });
})();
