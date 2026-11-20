/* Customize drawer: Atmosphere, Sounds and Layout tabs (the Wallpaper tab is newtab.js). */
(() => {
  'use strict';
  const { call, esc, $, $$, toast, debounce } = window.V;
  const I = window.VexaIcons;
  const NTP = window.NTP;
  const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (document.documentElement.classList.contains('private')) return;

  let atmo = null; // { config, sidebar, presets, sounds, palettes, look, space }
  const engine = new window.VexaSoundEngine({ fetchCustom: (id) => call('atmosphere.soundBytes', id) });
  const CAT_NAMES = { typing: 'Typing', click: 'Mouse clicks', tabOpen: 'Opening a tab', tabClose: 'Closing a tab', tabSwitch: 'Switching tabs', pageLoad: 'Page finished loading', notification: 'Notifications', startup: 'Starting Vexa', shutdown: 'Closing Vexa' };
  const WIDGET_NAMES = { search: 'Search box', favorites: 'Favorites', shortcuts: 'Most visited', recent: 'Recently visited', collections: 'Collections', spaces: 'Spaces', weather: 'Weather' };

  // ------------------------------------------------------------------ tabs
  function showTab(name) {
    for (const b of $$('#dr-tabs button')) b.classList.toggle('on', b.dataset.tab === name);
    for (const p of $$('.dr-pane')) p.hidden = p.dataset.pane !== name;
    if (name !== 'wallpaper') render();
  }
  $('#dr-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  NTP.showTab = showTab;
  // vexa://newtab/#customize=sounds opens a given tab.
  const fromHash = () => {
    const m = /#customi[sz]e=(\w+)/.exec(location.hash);
    if (m && document.querySelector(`[data-pane="${m[1]}"]`)) setTimeout(() => showTab(m[1]), 50);
  };
  fromHash();
  window.addEventListener('hashchange', fromHash);

  async function refresh() {
    atmo = await call('atmosphere.get');
    engine.configure(atmo.config.sounds);
    render();
  }
  const refreshSoon = debounce(refresh, 80);
  window.V.on('settings', (p) => p && ['atmosphere', 'sidebar', 'newTab'].includes(p.key) && refreshSoon());
  window.V.on('atmosphere-sounds', refreshSoon);
  window.V.on('spaces', refreshSoon);
  NTP.renderDrawer = () => (atmo ? render() : refresh());

  async function setAtmo(patch) {
    try {
      await call('atmosphere.set', patch);
    } catch (e) {
      toast(clean(e.message));
    }
  }

  function render() {
    if (!atmo || $('#drawer').hidden) return;
    renderAtmosphere();
    renderSounds();
    renderLayout();
  }

  // ------------------------------------------------------------------ Atmosphere
  const PRESET_ART = {
    vexa: 'linear-gradient(135deg,#1d1928,#8b5cf6 120%)',
    midnight: 'linear-gradient(135deg,#07080f,#1f2340 60%,#6d7cff 140%)',
    cyber: 'linear-gradient(135deg,#05060a,#00e5d4 90%,#ff2bd6 130%)',
    aurora: 'linear-gradient(135deg,#061214,#34d399 70%,#a78bfa 120%)',
    arcade: 'linear-gradient(135deg,#140a26,#ff4fa3 70%,#ffd23f 120%)',
    minimal: 'linear-gradient(135deg,#171717,#525252 120%)'
  };
  function renderAtmosphere() {
    const a = atmo.config;
    $('#presets').innerHTML = atmo.presets
      .map((p) => `<button class="preset ${a.preset === p.id ? 'on' : ''}" data-preset="${esc(p.id)}" style="--art:${PRESET_ART[p.id] || PRESET_ART.vexa}"><span class="pr-art">${p.sounds ? `<span class="pr-snd">${I.sound}</span>` : ''}</span><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></button>`)
      .join('');
    $('#palettes').innerHTML = atmo.palettes
      .map((p) => `<button class="pal ${a.palette === p.id ? 'on' : ''}" data-pal="${esc(p.id)}" title="${esc(p.desc)}"><span class="pal-sw" style="background:linear-gradient(135deg, ${esc(p.strip)} 55%, ${esc(p.swatch)} 55%)"></span>${esc(p.name)}</button>`)
      .join('');
    $('#accent').value = a.accent || (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().slice(0, 7) || '#8b5cf6');
    $('#accent-reset').hidden = !a.accent;
    $('#effect').value = a.effect;
    $('#tab-anim').value = a.tabAnimation;
    $('#transitions').checked = a.transitions;
    $('#chrome-wp').checked = a.chromeWallpaper;
    const sb = atmo.sidebar;
    $('#sb-show').checked = sb.show;
    for (const b of $$('#sb-side button')) b.classList.toggle('on', b.dataset.v === sb.side);
    for (const b of $$('#sb-size button')) b.classList.toggle('on', b.dataset.v === sb.size);
    const ITEMS = [['spaces', 'Spaces'], ['pinned', 'Pinned sites'], ['collections', 'Collections'], ['focus', 'Focus'], ['command', 'Command Center']];
    $('#sb-items').innerHTML = ITEMS.map(([k, n]) => `<label class="chip-check"><input type="checkbox" data-sbi="${k}" ${sb.items[k] !== false ? 'checked' : ''}> ${n}</label>`).join('');
    const sp = atmo.space;
    $('#space-look-row').hidden = !sp;
    if (sp) {
      const own = sp.look && (sp.look.palette || sp.look.accent);
      $('#space-look-label').textContent = own ? `“${sp.name}” has its own colors` : `Space: ${sp.name}`;
      $('#space-look').textContent = own ? 'Use the shared colors again' : 'Give this Space its own colors…';
    }
  }
  $('#presets').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    try {
      await call('atmosphere.preset', b.dataset.preset);
      engine.configure((await call('atmosphere.get')).config.sounds);
      engine.play('tabOpen', { force: true });
      toast(`${b.querySelector('b').textContent} applied`);
    } catch (err) {
      toast(clean(err.message));
    }
  });
  $('#palettes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pal]');
    if (b) setAtmo({ palette: b.dataset.pal, accent: '' });
  });
  $('#accent').addEventListener('input', debounce((e) => setAtmo({ accent: e.target.value }), 150));
  $('#accent-reset').addEventListener('click', () => setAtmo({ accent: '' }));
  $('#effect').addEventListener('change', (e) => setAtmo({ effect: e.target.value }));
  $('#tab-anim').addEventListener('change', (e) => setAtmo({ tabAnimation: e.target.value }));
  $('#transitions').addEventListener('change', (e) => setAtmo({ transitions: e.target.checked }));
  $('#chrome-wp').addEventListener('change', (e) => setAtmo({ chromeWallpaper: e.target.checked }));
  $('#atmo-reset').addEventListener('click', async () => {
    await call('atmosphere.reset');
    toast('Atmosphere is back to the standard Vexa look');
  });
  $('#space-look').addEventListener('click', async () => {
    const sp = atmo.space;
    if (!sp) return;
    const own = sp.look && (sp.look.palette || sp.look.accent);
    const look = { ...(sp.look || {}) };
    if (own) {
      delete look.palette;
      delete look.accent;
    } else {
      look.palette = atmo.config.palette;
      if (atmo.config.accent) look.accent = atmo.config.accent;
      toast(`“${sp.name}” now keeps these colors. Pick another theme for your other Spaces.`);
    }
    try {
      await call('spaces.update', sp.id, { look });
    } catch (err) {
      toast(clean(err.message));
    }
  });
  // Sidebar
  const setSb = (patch) => call('sidebar.set', patch).catch((e) => toast(clean(e.message)));
  $('#sb-show').addEventListener('change', (e) => setSb({ show: e.target.checked }));
  $('#sb-side').addEventListener('click', (e) => e.target.closest('button') && setSb({ side: e.target.closest('button').dataset.v }));
  $('#sb-size').addEventListener('click', (e) => e.target.closest('button') && setSb({ size: e.target.closest('button').dataset.v }));
  $('#sb-items').addEventListener('change', (e) => {
    const c = e.target.closest('[data-sbi]');
    if (c) setSb({ items: { [c.dataset.sbi]: c.checked } });
  });

  // ------------------------------------------------------------------ Sounds
  $('#snd-prof-preview').innerHTML = I.play;
  $('#snd-profile').innerHTML = Object.entries(window.VexaSoundEngine.PROFILES)
    .map(([id, p]) => `<option value="${id}">${esc(p.name)} — ${esc(p.desc)}</option>`)
    .join('');
  function renderSounds() {
    const s = atmo.config.sounds;
    $('#snd-on').checked = s.enabled;
    $('#snd-vol').value = s.volume;
    $('#o-vol').textContent = s.volume + '%';
    $('#snd-profile').value = s.profile;
    const own = atmo.sounds;
    const opts = (cur) => `<option value="">${esc(window.VexaSoundEngine.PROFILES[s.profile].name)} sound</option>${own.map((x) => `<option value="${esc(x.id)}" ${cur === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;
    if (!$('#snd-cats').contains(document.activeElement)) {
      $('#snd-cats').innerHTML = window.VexaSoundEngine.CATEGORIES.map((c) => {
        const o = s.categories[c] || { on: true, volume: 70, custom: '' };
        return `<div class="snd-cat ${o.on ? '' : 'off'}" data-cat="${c}">
          <label class="switch small"><input type="checkbox" data-k="on" ${o.on ? 'checked' : ''} aria-label="${esc(CAT_NAMES[c])}"><span></span></label>
          <span class="sc-name">${esc(CAT_NAMES[c])}</span>
          <select data-k="custom" aria-label="Sound for ${esc(CAT_NAMES[c])}">${opts(o.custom)}</select>
          <input type="range" min="0" max="100" data-k="volume" value="${o.volume}" aria-label="Volume for ${esc(CAT_NAMES[c])}">
          <button class="ibtn" data-play="${c}" title="Preview">${I.play}</button>
        </div>`;
      }).join('');
    }
    $('#snd-cats').classList.toggle('muted', !s.enabled);
    $('#snd-list').innerHTML = own.length
      ? own.map((x) => `<div class="snd-own"><button class="ibtn" data-play-own="${esc(x.id)}" title="Preview">${I.play}</button><span>${esc(x.name)}</span><small>${esc(x.ext.toUpperCase())} · ${(x.size / 1024).toFixed(0)} KB${x.duration ? ` · ${x.duration.toFixed(1)} s` : ''}</small><button class="ibtn" data-rm-own="${esc(x.id)}" title="Remove">${I.trash}</button></div>`).join('')
      : '<p class="dr-note">No imported sounds yet.</p>';
  }
  $('#snd-on').addEventListener('change', (e) => {
    setAtmo({ sounds: { enabled: e.target.checked } });
    if (e.target.checked) engine.play('notification', { force: true });
  });
  $('#snd-vol').addEventListener('input', (e) => ($('#o-vol').textContent = e.target.value + '%'));
  $('#snd-vol').addEventListener('change', (e) => {
    setAtmo({ sounds: { volume: Number(e.target.value) } });
    engine.play('tabOpen', { force: true, masterVolume: Number(e.target.value) });
  });
  $('#snd-profile').addEventListener('change', (e) => {
    setAtmo({ sounds: { profile: e.target.value } });
    engine.play('notification', { force: true, profile: e.target.value, custom: '' });
  });
  $('#snd-prof-preview').addEventListener('click', () => {
    const p = $('#snd-profile').value;
    ['tabOpen', 'click', 'tabSwitch', 'notification'].forEach((c, i) => setTimeout(() => engine.play(c, { force: true, profile: p, custom: '' }), i * 260));
  });
  $('#snd-cats').addEventListener('change', (e) => {
    const row = e.target.closest('[data-cat]');
    const k = e.target.dataset.k;
    if (!row || !k) return;
    const v = k === 'on' ? e.target.checked : k === 'volume' ? Number(e.target.value) : e.target.value;
    setAtmo({ sounds: { categories: { [row.dataset.cat]: { [k]: v } } } });
    if (k !== 'on' || v) engine.play(row.dataset.cat, { force: true, ...(k === 'custom' ? { custom: v } : {}), ...(k === 'volume' ? { volume: v } : {}) });
  });
  $('#snd-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-play]');
    if (!b) return;
    const row = b.closest('[data-cat]');
    engine.play(b.dataset.play, { force: true, custom: row.querySelector('select').value, volume: Number(row.querySelector('input[type=range]').value) });
  });
  $('#snd-list').addEventListener('click', async (e) => {
    const p = e.target.closest('[data-play-own]');
    if (p) return engine.play('notification', { force: true, custom: p.dataset.playOwn, volume: 80 });
    const r = e.target.closest('[data-rm-own]');
    if (r) await call('atmosphere.removeSound', r.dataset.rmOwn);
  });
  $('#snd-import').addEventListener('click', async () => {
    try {
      const f = await call('atmosphere.importSound');
      if (!f) return;
      // Decode it here first: only files Chromium can actually play, and short enough, are kept.
      const info = await engine.probe(f.bytes).catch((err) => {
        throw new Error(/seconds/.test(err.message) ? err.message : 'Vexa can’t play that file. Try an MP3, WAV or OGG.');
      });
      const saved = await call('atmosphere.saveSound', f.name, f.bytes, info.duration);
      toast(`Imported “${saved.name}”. Choose it for a sound below.`);
    } catch (err) {
      toast(clean(err.message));
    }
  });

  // ------------------------------------------------------------------ Layout (widgets)
  function renderLayout() {
    const cfg = NTP.data.config;
    for (const b of $$('#ntp-layout button')) b.classList.toggle('on', b.dataset.v === cfg.layout);
    $('#widget-list').innerHTML = cfg.order
      .map((id, i) => `<div class="wl-row" draggable="true" data-w="${id}"><span class="wl-grip">${I.grip}</span><span class="wl-name">${esc(WIDGET_NAMES[id])}</span>
        <button class="ibtn" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move up">${I.chevronUp}</button><button class="ibtn" data-move="1" ${i === cfg.order.length - 1 ? 'disabled' : ''} title="Move down">${I.chevronDown}</button>
        ${id === 'search' ? '<span class="wl-fixed">Always on</span>' : `<label class="switch small"><input type="checkbox" data-wtoggle="${id}" ${cfg[id] ? 'checked' : ''} aria-label="Show ${esc(WIDGET_NAMES[id])}"><span></span></label>`}</div>`)
      .join('');
    $('#city-now').textContent = cfg.weatherCity ? cfg.weatherCity.name : 'No city chosen';
    for (const b of $$('#w-unit button')) b.classList.toggle('on', b.dataset.v === cfg.weatherUnit);
  }
  const saveNtp = (patch) => call('ntp.set', patch).catch((e) => toast(clean(e.message)));
  $('#ntp-layout').addEventListener('click', (e) => e.target.closest('button') && saveNtp({ layout: e.target.closest('button').dataset.v }));
  $('#widget-list').addEventListener('change', (e) => {
    const c = e.target.closest('[data-wtoggle]');
    if (c) saveNtp({ [c.dataset.wtoggle]: c.checked });
  });
  function moveWidget(id, to) {
    const order = NTP.data.config.order.filter((x) => x !== id);
    order.splice(Math.max(0, Math.min(to, order.length)), 0, id);
    saveNtp({ order });
  }
  $('#widget-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-move]');
    if (!b) return;
    const id = b.closest('[data-w]').dataset.w;
    moveWidget(id, NTP.data.config.order.indexOf(id) + Number(b.dataset.move));
  });
  let wDrag = null;
  $('#widget-list').addEventListener('dragstart', (e) => {
    const r = e.target.closest('[data-w]');
    if (r) wDrag = r.dataset.w;
  });
  $('#widget-list').addEventListener('dragover', (e) => wDrag && e.preventDefault());
  $('#widget-list').addEventListener('drop', (e) => {
    if (!wDrag) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.target.closest('[data-w]');
    if (r && r.dataset.w !== wDrag) moveWidget(wDrag, NTP.data.config.order.indexOf(r.dataset.w));
    wDrag = null;
  });
  // Weather city
  $('#city-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#city').value.trim();
    if (q.length < 2) return;
    $('#city-results').innerHTML = '<p class="dr-note">Searching…</p>';
    try {
      const list = await call('ntp.geocode', q);
      $('#city-results').innerHTML = list.length ? list.map((c, i) => `<button class="city" data-i="${i}">${esc(c.name)}</button>`).join('') : '<p class="dr-note">No city found.</p>';
      $('#city-results').onclick = (ev) => {
        const b = ev.target.closest('[data-i]');
        if (!b) return;
        saveNtp({ weatherCity: list[Number(b.dataset.i)], weather: true });
        $('#city-results').innerHTML = '';
        $('#city').value = '';
      };
    } catch (err) {
      $('#city-results').innerHTML = `<p class="dr-note">${esc(clean(err.message))}</p>`;
    }
  });
  $('#w-unit').addEventListener('click', (e) => e.target.closest('button') && saveNtp({ weatherUnit: e.target.closest('button').dataset.v }));

  // Load once the drawer opens (and keep it fresh while open).
  new MutationObserver(() => !$('#drawer').hidden && refresh()).observe($('#drawer'), { attributes: true, attributeFilter: ['hidden'] });
})();
