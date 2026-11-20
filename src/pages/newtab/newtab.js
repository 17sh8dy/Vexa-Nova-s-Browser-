(() => {
  'use strict';
  const { call, esc, $, $$, toast, debounce } = window.V;
  const I = window.VexaIcons;

  const isPrivate = document.documentElement.classList.contains('private');
  const MAX_BYTES = 20 * 1024 * 1024;
  const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  let data = null; // { config, current, gallery, uploads, maxUploads }
  let shown = null; // the wallpaper this page is showing (kept while "every new tab" rotation is on)

  // ------------------------------------------------------------------ greeting + clock
  function greetingText() {
    const h = new Date().getHours();
    if (isPrivate) return 'Private window — history, cookies and site data are erased when you close it.';
    return h < 5 ? 'Up late? The web never sleeps.' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }
  $('#greeting').textContent = greetingText();
  $('#search-icon').innerHTML = I.search;

  let clockTimer = null;
  function tickClock() {
    const now = new Date();
    $('.clock-time').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('.clock-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    clearTimeout(clockTimer);
    clockTimer = setTimeout(tickClock, 60000 - (Date.now() % 60000) + 50);
  }

  async function setPlaceholder() {
    const [s, engines] = await Promise.all([call('settings.get'), call('settings.engines')]);
    const engine = engines.find((e) => e.id === s.searchEngine);
    $('#q').placeholder = `Search ${engine ? engine.name : 'the web'} or type a URL`;
  }

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#q').value.trim();
    if (v) call('nav.open', v, 'current');
  });

  // ------------------------------------------------------------------ shortcuts (most visited)
  async function renderTiles() {
    if (isPrivate) return; // don't surface browsing history in private windows
    const [sites, s] = await Promise.all([call('history.topSites', 8), call('settings.get')]);
    const box = $('#tiles');
    box.innerHTML = '';
    $('#tiles-empty').hidden = sites.length > 0 || !(data && data.config.shortcuts);
    $('#restore').hidden = !s.hiddenTopSites.length || !(data && data.config.shortcuts);
    for (const site of sites) {
      const a = document.createElement('a');
      a.className = 'tile';
      a.href = site.url;
      let host = site.origin;
      try {
        host = new URL(site.url).hostname.replace(/^www\./, '');
      } catch {
        /* keep */
      }
      const title = site.title && site.title.length < 40 ? site.title : host;
      const letter = esc((host[0] || '?').toUpperCase());
      a.innerHTML = `<div class="tile-icon"></div><div class="tile-title">${esc(title)}</div><button class="tile-x" title="Remove from this page">${I.close}</button>`;
      const icon = a.querySelector('.tile-icon');
      const src = site.favicon || site.origin + '/favicon.ico';
      const img = document.createElement('img');
      img.alt = '';
      img.src = src;
      img.onerror = () => (icon.innerHTML = letter);
      icon.appendChild(img);
      a.title = `${site.title || host}\n${site.url}`;
      a.addEventListener('click', (e) => {
        if (e.target.closest('.tile-x')) return;
        window.V.openFromEvent(e, site.url);
      });
      a.addEventListener('auxclick', (e) => {
        if (e.button === 1) window.V.openFromEvent(e, site.url);
      });
      a.querySelector('.tile-x').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await call('history.hideTopSite', site.origin);
        renderTiles();
      });
      box.appendChild(a);
    }
  }

  $('#restore-btn').addEventListener('click', async () => {
    await call('history.restoreTopSites');
    renderTiles();
  });

  // ------------------------------------------------------------------ wallpaper
  const bg = $('#bg');
  const bgImg = $('.bg-img');
  const lumCache = new Map(); // url -> average luminance 0..1

  /** Average brightness of an image (sampled small), so text stays legible on any upload. */
  function measure(url) {
    if (lumCache.has(url)) return Promise.resolve(lumCache.get(url));
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 32;
          c.height = 18;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 32, 18);
          const px = ctx.getImageData(0, 0, 32, 18).data;
          let sum = 0;
          for (let i = 0; i < px.length; i += 4) sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
          const lum = sum / (px.length / 4);
          lumCache.set(url, lum);
          resolve(lum);
        } catch {
          resolve(0.3);
        }
      };
      img.onerror = () => resolve(0.3);
      img.src = url;
    });
  }

  function applyAdjustments(cfg) {
    document.body.style.setProperty('--wp-blur', cfg.blur + 'px');
    document.body.style.setProperty('--wp-brightness', cfg.brightness / 100);
    document.body.style.setProperty('--wp-overlay', cfg.overlay / 100);
  }

  // Light or dark text, from the image's own brightness (after the brightness slider).
  // The overlay then washes the image away from the text colour, so it only adds contrast.
  async function applyTone(wp, cfg) {
    const lum = (wp.tone === 'light' ? 0.86 : wp.tone === 'dark' ? 0.22 : await measure(wp.url)) * (cfg.brightness / 100);
    document.body.classList.toggle('wp-light', lum > 0.55);
    document.body.classList.toggle('wp-dark', lum <= 0.55);
  }

  async function renderWallpaper() {
    const cfg = data.config;
    applyAdjustments(cfg);
    const wp = shown;
    document.body.classList.toggle('has-wallpaper', !!wp);
    if (!wp) {
      bg.hidden = true;
      bgImg.style.backgroundImage = '';
      document.body.classList.remove('wp-light', 'wp-dark');
      return;
    }
    await applyTone(wp, cfg);
    const css = `url("${wp.url.replace(/"/g, '%22')}")`;
    if (bgImg.style.backgroundImage !== css) {
      // Fade in once the image has loaded, so the page never flashes an empty frame.
      // (img.decode() never settles for vexa:// images, so wait for the load event.)
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = img.onerror = resolve;
        img.src = wp.url;
        setTimeout(resolve, 2000);
      });
      bgImg.style.backgroundImage = css;
      bg.classList.remove('in');
      void bg.offsetWidth;
      bg.classList.add('in');
    }
    bg.hidden = false;
  }

  // ------------------------------------------------------------------ widgets (0.90)
  const WIDGET_ON = { search: () => true, favorites: (c) => c.favorites, shortcuts: (c) => c.shortcuts, recent: (c) => c.recent, collections: (c) => c.collections, spaces: (c) => c.spaces, weather: (c) => c.weather };
  // Widgets that show your browsing never appear in private windows.
  const PRIVATE_HIDDEN = new Set(['favorites', 'shortcuts', 'recent', 'collections', 'spaces', 'weather']);
  function widgetOn(id) {
    if (isPrivate && PRIVATE_HIDDEN.has(id)) return false;
    return !!WIDGET_ON[id](data.config);
  }
  function renderWidgets() {
    const cfg = data.config;
    const box = $('#widgets');
    document.body.classList.toggle('layout-dashboard', cfg.layout === 'dashboard');
    for (const id of cfg.order) {
      const el = box.querySelector(`[data-widget="${id}"]`);
      if (!el) continue;
      box.appendChild(el); // DOM order = chosen order
      el.hidden = !widgetOn(id);
    }
    $('#shortcuts-title').hidden = cfg.layout !== 'dashboard';
    if (widgetOn('favorites')) renderFavorites();
    if (widgetOn('recent')) renderRecent();
    if (widgetOn('collections')) renderCollectionsWidget();
    if (widgetOn('spaces')) renderSpacesWidget();
    if (widgetOn('weather')) renderWeather();
  }

  function tileFor(url, title, { favicon, removeTitle, data: d = '' } = {}) {
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = url;
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* keep */
    }
    const label = title && title.length < 40 ? title : host;
    a.innerHTML = `<div class="tile-icon"></div><div class="tile-title">${esc(label)}</div>${removeTitle ? `<button class="tile-x" title="${esc(removeTitle)}" data-x="${esc(d)}">${I.close}</button>` : ''}`;
    const icon = a.querySelector('.tile-icon');
    const img = document.createElement('img');
    img.alt = '';
    try {
      img.src = favicon || new URL(url).origin + '/favicon.ico';
    } catch {
      img.src = '';
    }
    img.onerror = () => (icon.textContent = (host[0] || '?').toUpperCase());
    icon.appendChild(img);
    a.title = `${title || host}\n${url}`;
    a.addEventListener('click', (e) => {
      if (e.target.closest('.tile-x')) return;
      window.V.openFromEvent(e, url);
    });
    a.addEventListener('auxclick', (e) => e.button === 1 && window.V.openFromEvent(e, url));
    return a;
  }

  function renderFavorites() {
    const box = $('#favorites');
    box.innerHTML = '';
    for (const f of data.config.favoritesList) {
      const t = tileFor(f.url, f.title, { removeTitle: 'Remove from favorites', data: f.url });
      t.draggable = true;
      t.dataset.url = f.url;
      box.appendChild(t);
    }
    if (data.config.favoritesList.length < 24) {
      const add = document.createElement('button');
      add.className = 'tile tile-add';
      add.innerHTML = `<div class="tile-icon">${I.plus}</div><div class="tile-title">Add</div>`;
      add.addEventListener('click', () => {
        $('#fav-form').hidden = false;
        $('#fav-url').focus();
      });
      box.appendChild(add);
    }
  }
  $('#favorites').addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    e.preventDefault();
    e.stopPropagation();
    await call('ntp.removeFavorite', x.dataset.x);
  });
  // Drag favorites to reorder.
  let favDrag = null;
  $('#favorites').addEventListener('dragstart', (e) => {
    const t = e.target.closest('.tile[data-url]');
    if (!t) return;
    favDrag = t.dataset.url;
    e.dataTransfer.setData('application/x-vexa-fav', favDrag);
  });
  $('#favorites').addEventListener('dragover', (e) => favDrag && e.preventDefault());
  $('#favorites').addEventListener('drop', async (e) => {
    if (!favDrag) return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.target.closest('.tile[data-url]');
    const list = data.config.favoritesList;
    const to = t ? list.findIndex((f) => f.url === t.dataset.url) : list.length - 1;
    const url = favDrag;
    favDrag = null;
    await call('ntp.moveFavorite', url, to);
  });
  $('#fav-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let url = $('#fav-url').value.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
    try {
      await call('ntp.addFavorite', { url, title: $('#fav-title').value.trim() });
      $('#fav-url').value = '';
      $('#fav-title').value = '';
      $('#fav-form').hidden = true;
    } catch (err) {
      toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  });
  $('#fav-cancel').addEventListener('click', () => ($('#fav-form').hidden = true));

  async function renderRecent() {
    const items = await call('ntp.recent', 6);
    $('#recent').innerHTML = items.length
      ? items.map((h, i) => `<a class="w-row" href="${esc(h.url)}" data-i="${i}"><img alt="" src="${esc(h.favicon || (() => { try { return new URL(h.url).origin + '/favicon.ico'; } catch { return ''; } })())}"><span>${esc(h.title || h.url)}</span><small>${esc(window.V.hostOf(h.url).replace(/^www\./, ''))}</small></a>`).join('')
      : '<div class="w-empty">Pages you visit will appear here.</div>';
    for (const img of $$('#recent img')) img.onerror = () => (img.style.visibility = 'hidden');
    for (const a of $$('#recent a')) a.addEventListener('click', (e) => window.V.openFromEvent(e, items[Number(a.dataset.i)].url));
  }

  async function renderCollectionsWidget() {
    const cols = (await call('collections.list')).slice().sort((a, b) => (b.favorite - a.favorite) || b.updated - a.updated).slice(0, 4);
    $('#w-collections').innerHTML = cols.length
      ? cols.map((c) => `<a class="w-col" href="vexa://collections/#c=${esc(c.id)}"><span class="w-col-cover" style="${c.cover ? `background-image:url(&quot;${esc(c.cover)}&quot;)` : `background:${esc(c.color)}`}"></span><span class="w-col-name">${esc(c.name)}</span><small>${c.count} item${c.count === 1 ? '' : 's'}</small></a>`).join('')
      : '<div class="w-empty">Save pages, notes and images with the collection button in the address bar.</div>';
  }

  async function renderSpacesWidget() {
    const s = await call('spaces.list');
    $('#w-spaces').innerHTML =
      s.spaces.map((sp) => `<button class="w-space ${sp.id === s.current ? 'on' : ''}" data-space="${esc(sp.id)}" style="--sp:${esc(sp.color)}" title="${esc(sp.name)}">${window.VexaSpaceIcon(sp.icon)}<span>${esc(sp.name)}</span></button>`).join('') +
      `<button class="w-space add" data-space="" title="New Space">${I.plus}<span>New</span></button>`;
  }
  $('#w-spaces').addEventListener('click', (e) => {
    const b = e.target.closest('[data-space]');
    if (!b) return;
    if (b.dataset.space) call('spaces.switch', b.dataset.space);
    else call('nav.commandCenter', 'new space');
  });

  const WICON = { sun: I.sun, moon: I.moon, cloud: I.cloud, cloudSun: I.cloudSun, rain: I.rain, snow: I.snow, storm: I.storm, fog: I.fog };
  async function renderWeather() {
    const el = $('#weather');
    if (!data.config.weatherCity) {
      el.innerHTML = `<button class="linkish" id="w-setup">Choose a city for the weather widget</button>`;
      $('#w-setup').onclick = () => {
        openDrawer();
        window.NTP && window.NTP.showTab('layout');
      };
      return;
    }
    try {
      const w = await call('ntp.weather');
      if (!w) return;
      el.innerHTML = `<span class="w-ic">${WICON[w.icon] || I.cloud}</span><div><b>${w.temp}${esc(w.unit)}</b><span>${esc(w.label)}</span><small>${esc(data.config.weatherCity.name)} · H ${w.high}° L ${w.low}°</small></div>`;
    } catch (err) {
      el.innerHTML = `<span class="w-ic">${I.cloud}</span><div><span>Weather unavailable</span><small>${esc(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 80))}</small></div>`;
    }
  }

  function renderLayout() {
    const cfg = data.config;
    const showTiles = cfg.shortcuts && !isPrivate;
    $('#tiles').hidden = !showTiles;
    if (!showTiles) {
      $('#tiles-empty').hidden = true;
      $('#restore').hidden = true;
    }
    renderWidgets();
    $('#greeting').hidden = !cfg.greeting && !isPrivate;
    const clockOn = cfg.clock && !isPrivate;
    $('#clock').hidden = !clockOn;
    document.body.classList.toggle('with-clock', clockOn);
    if (clockOn) tickClock();
    else clearTimeout(clockTimer);
    renderShieldsWidget();
  }

  async function renderShieldsWidget() {
    const w = $('#shields-widget');
    if (isPrivate || !data.config.shieldsStats) {
      w.hidden = true;
      return;
    }
    const life = await call('shields.lifetime');
    const since = new Date(life.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(life.since).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    w.innerHTML = `<span class="sw-crest">${I.vexaShield}</span><span class="sw-text"><b>${life.blocked.toLocaleString()}</b><small>${life.blocked === 1 ? 'thing' : 'things'} blocked by Vexa Shields since ${esc(since)}</small></span>`;
    w.title = 'Vexa Shields settings';
    w.hidden = false;
  }

  // ------------------------------------------------------------------ drawer
  const drawer = $('#drawer');
  const scrim = $('#drawer-scrim');
  $('#drawer-close').innerHTML = I.close;
  $('.cb-icon').innerHTML = I.palette;
  $('.dh-icon').innerHTML = I.image;

  function openDrawer() {
    if (isPrivate) return;
    drawer.hidden = false;
    scrim.hidden = false;
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      scrim.classList.add('open');
    });
    renderDrawer();
    setTimeout(() => $('#drawer-close').focus({ focusVisible: false }), 50);
  }
  function closeDrawer() {
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    setTimeout(() => {
      if (!drawer.classList.contains('open')) {
        drawer.hidden = true;
        scrim.hidden = true;
      }
    }, 220);
    if (/^#customi[sz]e/.test(location.hash)) history.replaceState(null, '', location.pathname);
  }
  $('#customize-btn').addEventListener('click', openDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
  });

  function isSelected(item) {
    if (wpScope === 'space' && data.space && data.space.ownWallpaper) return item ? !!(shown && shown.url === item.url) : !shown;
    const w = data.config.wallpaper;
    if (data.config.rotate !== 'off') return false;
    return item ? w.kind === item.kind && w.id === item.id : w.kind === 'default';
  }

  function renderDrawer() {
    if (drawer.hidden || !data) return;
    const cfg = data.config;
    const tile = (item, extra = '') => {
      const sel = isSelected(item);
      const style = item ? `style="background-image:url(&quot;${esc(item.url)}&quot;)"` : '';
      const name = item ? item.name : 'Vexa';
      return `<div class="wp-tile ${item ? '' : 'wp-default'} ${sel ? 'sel' : ''}" role="button" tabindex="0" aria-pressed="${sel}" data-kind="${item ? item.kind : 'default'}" data-id="${item ? esc(item.id) : ''}" title="${esc(name)}" ${style}>
        ${item ? '' : `<span class="wp-default-mark"><img src="vexa://shared/logo.svg" alt=""></span>`}
        <span class="wp-name">${esc(name)}</span>
        ${sel ? `<span class="wp-check">${I.check}</span>` : ''}${extra}
      </div>`;
    };
    const uploads = data.uploads.map((u) => tile(u, `<button class="wp-remove" data-remove="${esc(u.id)}" title="Remove this image" aria-label="Remove ${esc(u.name)}">${I.trash}</button>`)).join('');
    const canUpload = data.uploads.length < data.maxUploads;
    $('#wp-grid').innerHTML =
      tile(null) +
      data.gallery.map((g) => tile(g)).join('') +
      uploads +
      (canUpload ? `<button class="wp-tile wp-upload" id="wp-upload"><span>${I.upload}</span><span class="wp-name">Upload</span></button>` : '');

    $('#rotate').value = cfg.rotate;
    $('#rotate-source-row').hidden = cfg.rotate === 'off';
    for (const b of $$('#rotate-source button')) {
      b.classList.toggle('on', b.dataset.v === cfg.rotateSource);
      b.disabled = b.dataset.v === 'uploads' && !data.uploads.length;
    }
    for (const input of $$('#adjust-sec .dr-slider input')) {
      const k = input.dataset.key;
      if (document.activeElement !== input) input.value = cfg[k];
      $('#o-' + k).textContent = k === 'blur' ? cfg[k] + ' px' : cfg[k] + '%';
      input.disabled = !shown;
    }
    $('#adjust-note').hidden = !!shown;
    for (const c of $$('[data-show]')) c.checked = !!cfg[c.dataset.show];
    renderScope();
    if (window.NTP && window.NTP.renderDrawer) window.NTP.renderDrawer();
  }

  async function save(patch) {
    try {
      await call('ntp.set', patch);
    } catch (err) {
      toast('Could not save: ' + err.message);
    }
  }

  $('#wp-grid').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      e.stopPropagation();
      await call('wallpaper.remove', rm.dataset.remove);
      return;
    }
    if (e.target.closest('#wp-upload')) return upload();
    const t = e.target.closest('.wp-tile');
    if (!t) return;
    try {
      // "This Space": the wallpaper belongs to the current Space only.
      if (wpScope === 'space' && data.space) {
        const sp = (await call('spaces.list')).spaces.find((s) => s.id === data.space.id);
        await call('spaces.update', data.space.id, { look: { ...(sp ? sp.look : {}), wallpaper: { kind: t.dataset.kind, id: t.dataset.id } } });
        return load();
      }
      await call('wallpaper.choose', t.dataset.kind, t.dataset.id);
    } catch (err) {
      toast(err.message);
    }
  });

  // Wallpaper for all Spaces, or just this one.
  let wpScope = 'all';
  $('#wp-scope').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v === 'all' && data.space && data.space.ownWallpaper) {
      // Back to the shared wallpaper: drop this Space's own one.
      const sp = (await call('spaces.list')).spaces.find((s) => s.id === data.space.id);
      const look = { ...(sp ? sp.look : {}) };
      delete look.wallpaper;
      await call('spaces.update', data.space.id, { look });
    }
    wpScope = b.dataset.v;
    load();
  });
  function renderScope() {
    const has = !!data.space && !isPrivate;
    $('#wp-scope-row').hidden = !has;
    if (!has) return;
    if (data.space.ownWallpaper) wpScope = 'space';
    for (const b of $$('#wp-scope button')) b.classList.toggle('on', b.dataset.v === wpScope);
    $('#wp-scope-note').hidden = wpScope !== 'space';
    $('#wp-scope-note').textContent = `Choices here apply to the “${data.space.name}” Space only. Pick “All Spaces” to go back to the shared wallpaper.`;
  }
  $('#wp-grid').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('wp-tile')) {
      e.preventDefault();
      e.target.click();
    }
  });

  async function upload() {
    try {
      const r = await call('wallpaper.upload');
      if (r) toast('Wallpaper added');
    } catch (err) {
      toast(err.message);
    }
  }

  $('#rotate').addEventListener('change', () => save({ rotate: $('#rotate').value }));
  $('#rotate-source').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled) save({ rotateSource: b.dataset.v });
  });
  const saveSliders = debounce((patch) => save(patch), 250);
  for (const input of $$('#adjust-sec .dr-slider input')) {
    input.addEventListener('input', () => {
      const k = input.dataset.key;
      data.config[k] = Number(input.value);
      $('#o-' + k).textContent = k === 'blur' ? input.value + ' px' : input.value + '%';
      applyAdjustments(data.config);
      if (shown) applyTone(shown, data.config);
      saveSliders({ [k]: Number(input.value) });
    });
  }
  for (const c of $$('[data-show]')) c.addEventListener('change', () => save({ [c.dataset.show]: c.checked }));
  $('#reset-look').addEventListener('click', async () => {
    await call('ntp.reset');
    toast('New Tab is back to the Vexa look');
  });

  // ------------------------------------------------------------------ drag and drop an image
  const dropHint = $('#drop-hint');
  let dragDepth = 0;
  const hasFiles = (e) => !isPrivate && e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropHint.hidden = false;
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropHint.hidden = true;
    }
  });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // never navigate to the dropped file
    dragDepth = 0;
    dropHint.hidden = true;
    const file = [...e.dataTransfer.files][0];
    if (!file) return;
    if (!OK_TYPES.includes(file.type)) return toast('Only JPG, PNG and WebP images can be used');
    if (file.size > MAX_BYTES) return toast('That image is larger than 20 MB');
    try {
      await call('wallpaper.uploadData', file.name, new Uint8Array(await file.arrayBuffer()));
      toast('Wallpaper added');
    } catch (err) {
      toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  });

  // ------------------------------------------------------------------ load + live updates
  async function load({ keepShown = false } = {}) {
    const prev = data;
    data = await call('ntp.get');
    // "Every new tab" picks a fresh wallpaper per page; a settings change elsewhere
    // shouldn't reshuffle this page unless the rotation itself changed.
    const rotationChanged = !prev || prev.config.rotate !== data.config.rotate || prev.config.rotateSource !== data.config.rotateSource;
    const stillExists = shown && [...data.gallery, ...data.uploads].some((w) => w.url === shown.url);
    if (!(keepShown && data.config.rotate === 'newtab' && !rotationChanged && stillExists)) shown = data.current;
    $('#customize-btn').hidden = isPrivate;
    applyEffect();
    renderLayout();
    await renderWallpaper();
    renderTiles();
    renderDrawer();
  }

  const reload = debounce(() => load({ keepShown: true }), 60);
  window.V.on('settings', (p) => {
    if (!p) return;
    if (p.key === 'searchEngine') setPlaceholder();
    if (p.key === 'newTab' || p.key === 'atmosphere' || p.key === 'sidebar') reload();
  });
  window.V.on('spaces', reload);
  window.V.on('collections', debounce(() => data && widgetOn('collections') && renderCollectionsWidget(), 200));
  window.V.on('atmosphere-sounds', reload);

  // Atmosphere background effect on the New Tab page (same as the browser UI's).
  async function applyEffect() {
    let look = null;
    try {
      look = await call('atmosphere.look');
    } catch {
      return;
    }
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.body.dataset.effect = look.effect === 'none' ? 'none' : reduce ? 'static-' + look.effect : look.effect;
  }

  // Search hints: keyword shortcuts and the Command Center.
  $('#search-hints').innerHTML = isPrivate ? '' : `<span>Try <kbd>@yt</kbd> <kbd>@w</kbd> <kbd>@nova</kbd> <kbd>@tabs</kbd> or press <kbd>${navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'}+Space</kbd> for the Command Center</span>`;

  // Hooks for customize.js (Atmosphere, Sounds and Layout tabs of the drawer).
  window.NTP = { get data() { return data; }, load: () => load({ keepShown: true }), openDrawer: () => openDrawer(), renderWidgets: () => renderWidgets() };

  setPlaceholder();
  load().then(() => {
    document.body.classList.add('ready');
    if (/^#customi[sz]e/.test(location.hash)) openDrawer();
  });
  window.addEventListener('hashchange', () => {
    if (/^#customi[sz]e/.test(location.hash)) openDrawer();
  });
})();
