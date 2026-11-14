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

  function renderLayout() {
    const cfg = data.config;
    const showTiles = cfg.shortcuts && !isPrivate;
    $('#tiles').hidden = !showTiles;
    if (!showTiles) {
      $('#tiles-empty').hidden = true;
      $('#restore').hidden = true;
    }
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
    if (location.hash === '#customise') history.replaceState(null, '', location.pathname);
  }
  $('#customise-btn').addEventListener('click', openDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
  });

  function isSelected(item) {
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
    for (const input of $$('.dr-slider input')) {
      const k = input.dataset.key;
      if (document.activeElement !== input) input.value = cfg[k];
      $('#o-' + k).textContent = k === 'blur' ? cfg[k] + ' px' : cfg[k] + '%';
      input.disabled = !shown;
    }
    $('#adjust-note').hidden = !!shown;
    for (const c of $$('[data-show]')) c.checked = !!cfg[c.dataset.show];
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
      await call('wallpaper.choose', t.dataset.kind, t.dataset.id);
    } catch (err) {
      toast(err.message);
    }
  });
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
  for (const input of $$('.dr-slider input')) {
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
    $('#customise-btn').hidden = isPrivate;
    renderLayout();
    await renderWallpaper();
    renderTiles();
    renderDrawer();
  }

  const reload = debounce(() => load({ keepShown: true }), 60);
  window.V.on('settings', (p) => {
    if (!p) return;
    if (p.key === 'searchEngine') setPlaceholder();
    if (p.key === 'newTab') reload();
  });

  setPlaceholder();
  load().then(() => {
    document.body.classList.add('ready');
    if (location.hash === '#customise') openDrawer();
  });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#customise') openDrawer();
  });
})();
