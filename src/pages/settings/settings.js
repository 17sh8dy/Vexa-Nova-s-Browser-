(() => {
  'use strict';
  const { call, esc, $, $$, toast, debounce } = window.V;
  const I = window.VexaIcons;
  $('#side').innerHTML = window.V.sidebar('settings');

  const PERMS = [
    ['media', 'Camera & microphone', I.camera],
    ['geolocation', 'Location', I.pin],
    ['notifications', 'Notifications', I.bell],
    ['display-capture', 'Screen sharing', I.external],
    ['clipboard-read', 'Clipboard reading', I.file.replace('width="18" height="18"', 'width="16" height="16"')],
    ['midiSysex', 'MIDI devices', I.settings]
  ];
  const PERM_NAMES = Object.fromEntries(PERMS.map(([k, n]) => [k, n]));

  let s = null;

  async function load() {
    s = await call('settings.get');
    // Engine list
    const engines = await call('settings.engines');
    $('#engine').innerHTML = engines.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
    render();
    $('#dl-dir').textContent = await call('settings.defaultDownloadDir');
    const info = await call('app.info');
    $('#ver').textContent = info.version;
    $('#meta').innerHTML = `Chromium ${esc(info.chrome)} · Electron ${esc(info.electron)} · ${esc(info.platform)}<br>Profile: ${esc(info.userData)}`;
  }

  function render() {
    for (const el of $$('[data-setting]')) {
      const k = el.dataset.setting;
      if (el.type === 'checkbox') el.checked = !!s[k];
      else el.value = s[k];
    }
    for (const el of $$('[data-exit]')) el.checked = !!s.clearOnExit[el.dataset.exit];
    for (const b of $$('#theme button')) b.classList.toggle('on', b.dataset.v === s.theme);
    for (const b of $$('#home-mode button')) b.classList.toggle('on', b.dataset.v === s.homeMode);
    $('#home-url-row').hidden = s.homeMode !== 'custom';
    if (document.activeElement !== $('#home-url')) $('#home-url').value = s.homeUrl || '';
    renderPermDefaults();
    renderPermSites();
  }

  async function set(key, value) {
    try {
      await call('settings.set', key, value);
      s[key] = value;
    } catch (err) {
      toast('Could not save: ' + err.message);
    }
  }

  for (const el of $$('[data-setting]')) {
    el.addEventListener('change', () => set(el.dataset.setting, el.type === 'checkbox' ? el.checked : el.value));
  }
  for (const el of $$('[data-exit]')) {
    el.addEventListener('change', () => set('clearOnExit', { ...s.clearOnExit, [el.dataset.exit]: el.checked }));
  }
  $('#theme').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) set('theme', b.dataset.v).then(render);
  });
  $('#home-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) set('homeMode', b.dataset.v).then(render);
  });
  $('#home-url').addEventListener(
    'input',
    debounce(() => {
      let v = $('#home-url').value.trim();
      if (v && !/^[a-z]+:\/\//i.test(v)) v = 'https://' + v;
      set('homeUrl', v);
    }, 400)
  );

  // ---- permissions
  function renderPermDefaults() {
    $('#perm-defaults').innerHTML = PERMS.map(
      ([k, name, icon]) => `<div class="row"><span class="favicon">${icon}</span><div class="label"><b>${esc(name)}</b></div>
        <div class="seg" data-perm="${k}"><button data-v="ask" class="${s.permissionDefaults[k] !== 'block' ? 'on' : ''}">Ask</button><button data-v="block" class="${s.permissionDefaults[k] === 'block' ? 'on' : ''}">Block</button></div></div>`
    ).join('');
  }
  $('#perm-defaults').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const seg = e.target.closest('[data-perm]');
    if (!b || !seg) return;
    set('permissionDefaults', { ...s.permissionDefaults, [seg.dataset.perm]: b.dataset.v }).then(render);
  });

  function renderPermSites() {
    const sites = Object.entries(s.sitePermissions || {});
    if (!sites.length) {
      $('#perm-sites').innerHTML = '<div class="perm-empty">No sites have saved permissions yet. Decisions you make with “Remember” checked appear here.</div>';
      return;
    }
    $('#perm-sites').innerHTML = sites
      .map(
        ([origin, perms]) => `<div class="perm-site"><span class="origin">${esc(origin)}</span>${Object.entries(perms)
          .map(([p, d]) => `<span class="perm-chip ${d}">${esc(PERM_NAMES[p] || p)}: ${d === 'allow' ? 'Allowed' : 'Blocked'}<button title="Reset" data-origin="${esc(origin)}" data-perm="${esc(p)}">${I.close}</button></span>`)
          .join(' ')}</div>`
      )
      .join('');
  }
  $('#perm-sites').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-origin]');
    if (!b) return;
    await call('settings.setSitePermission', b.dataset.origin, b.dataset.perm, null);
    s = await call('settings.get');
    render();
  });

  // ---- clear data
  $('#clear-now').addEventListener('click', async () => {
    const what = {
      history: $('#c-history').checked,
      cookies: $('#c-cookies').checked,
      cache: $('#c-cache').checked,
      downloads: $('#c-downloads').checked,
      permissions: $('#c-permissions').checked
    };
    if (!Object.values(what).some(Boolean)) return toast('Choose what to clear first');
    const btn = $('#clear-now');
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    try {
      await call('privacy.clear', what);
      toast('Browsing data cleared');
      s = await call('settings.get');
      render();
    } catch (err) {
      toast('Something went wrong: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Clear data';
    }
  });

  // ---- downloads
  $('#dl-change').addEventListener('click', async () => {
    const dir = await call('settings.chooseDownloadDir');
    if (dir) $('#dl-dir').textContent = dir;
  });
  $('#open-data').addEventListener('click', () => call('app.openUserData'));

  // ---- section highlighting / hash jumps
  function highlightHash() {
    const id = location.hash.slice(1);
    for (const a of $$('#jump a')) a.classList.toggle('on', a.getAttribute('href') === '#' + id);
    const sec = id && document.getElementById(id);
    if (sec) {
      sec.scrollIntoView({ block: 'start' });
      const card = sec.querySelector('.clear-card') || sec.querySelector('.card');
      if (card) {
        card.classList.remove('flash');
        void card.offsetWidth;
        card.classList.add('flash');
      }
    }
  }
  window.addEventListener('hashchange', highlightHash);

  window.V.on('settings', async () => {
    s = await call('settings.get');
    render();
  });

  load().then(highlightHash);
})();
