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
    loadDefaultBrowser();
    loadPasswords();
    loadAutofill();
    loadSync();
    loadExtensions();
    loadDrm();
    $('#google-key').value = s.googleApiKey || '';
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
      permissions: $('#c-permissions').checked,
      passwords: $('#c-passwords').checked,
      autofill: $('#c-autofill').checked
    };
    if (!Object.values(what).some(Boolean)) return toast('Choose what to clear first');
    const btn = $('#clear-now');
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    try {
      await call('privacy.clear', what, $('#clear-range').value);
      toast('Browsing data cleared');
      loadPasswords();
      loadAutofill();
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

  // ---- clear data: range
  function updateClearHint() {
    const all = $('#clear-range').value === 'all';
    for (const id of ['#c-cookies', '#c-cache', '#c-passwords', '#c-autofill']) {
      $(id).disabled = !all;
      $(id).closest('label').style.opacity = all ? '' : '0.45';
    }
    $('#clear-hint').textContent = all
      ? 'Clears data from all time.'
      : 'History and the download list are cleared for this period. Cookies, cache, passwords and autofill can only be cleared for all time.';
  }
  $('#clear-range').addEventListener('change', updateClearHint);
  updateClearHint();

  // ---- default browser
  async function loadDefaultBrowser() {
    const st = await call('browser.defaultStatus');
    $('#default-status').textContent = st.isDefault ? 'Vexa is your default browser.' : 'Vexa is not your default browser.';
    $('#make-default').hidden = st.isDefault;
  }
  $('#make-default').addEventListener('click', async () => {
    try {
      const st = await call('browser.makeDefault');
      if (st.pendingUserAction) toast('Windows opened Default apps — choose Vexa there to finish.');
      await loadDefaultBrowser();
    } catch (err) {
      toast('Could not register Vexa: ' + err.message);
    }
  });
  window.addEventListener('focus', () => loadDefaultBrowser().catch(() => {}));

  // ---- location key
  $('#google-key').addEventListener(
    'input',
    debounce(() => set('googleApiKey', $('#google-key').value.trim()).then(() => toast('Saved — restart Vexa to apply')), 600)
  );

  // ---- passwords
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString() : '');
  let pwEditing = null; // id | 'new' | null
  async function loadPasswords() {
    const [list, never, ok] = await Promise.all([call('passwords.list'), call('passwords.never'), call('passwords.available')]);
    $('#pw-add').disabled = !ok;
    $('#pw-import').disabled = !ok;
    if (!ok) $('#pw-storage-note').textContent = 'This computer has no secure keystore available, so Vexa will not store passwords.';
    const rows = [];
    if (pwEditing === 'new') rows.push(editRow({ id: 'new', origin: '', username: '' }));
    for (const p of list) rows.push(pwEditing === p.id ? editRow(p) : viewRow(p));
    if (!list.length && pwEditing !== 'new') rows.push('<div class="perm-empty">No saved passwords. When you sign in to a site, Vexa will offer to save it.</div>');
    $('#pw-list').innerHTML = rows.join('');
    $('#pw-never-card').hidden = !never.length;
    $('#pw-never').innerHTML = never
      .map((o) => `<div class="list-row"><div class="grow"><b>${esc(o)}</b></div><button class="btn small" data-never="${esc(o)}">Remove</button></div>`)
      .join('');
  }
  const viewRow = (p) => `<div class="list-row" data-pw="${esc(p.id)}">
      <div class="grow"><b>${esc(p.origin.replace(/^https?:\/\//, ''))}</b><small>${esc(p.username || '(no username)')}${p.updated ? ' · updated ' + esc(fmtDate(p.updated)) : ''}</small></div>
      <span class="secret" data-secret>••••••••</span>
      <button class="btn small" data-act="show">Show</button>
      <button class="btn small" data-act="copy">Copy</button>
      <button class="btn small" data-act="edit">Edit</button>
      <button class="btn small danger" data-act="del">Delete</button></div>`;
  const editRow = (p) => `<div class="list-row edit" data-pw="${esc(p.id)}">
      ${p.id === 'new' ? '<input data-f="origin" placeholder="https://example.com" spellcheck="false" />' : `<b class="grow">${esc(p.origin.replace(/^https?:\/\//, ''))}</b>`}
      <input data-f="username" placeholder="Username" value="${esc(p.username)}" spellcheck="false" autocomplete="off" />
      <input data-f="password" type="password" placeholder="${p.id === 'new' ? 'Password' : 'New password (leave empty to keep)'}" autocomplete="new-password" />
      <button class="btn small primary" data-act="save">Save</button>
      <button class="btn small" data-act="cancel">Cancel</button></div>`;

  $('#pw-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    const row = e.target.closest('[data-pw]');
    if (!b || !row) return;
    const id = row.dataset.pw;
    try {
      if (b.dataset.act === 'show') {
        const el = row.querySelector('[data-secret]');
        if (b.textContent === 'Hide') {
          el.textContent = '••••••••';
          b.textContent = 'Show';
        } else {
          el.textContent = (await call('passwords.reveal', id)) ?? '';
          b.textContent = 'Hide';
        }
      } else if (b.dataset.act === 'copy') {
        await navigator.clipboard.writeText((await call('passwords.reveal', id)) ?? '');
        toast('Password copied');
      } else if (b.dataset.act === 'edit') {
        pwEditing = id;
        await loadPasswords();
      } else if (b.dataset.act === 'cancel') {
        pwEditing = null;
        await loadPasswords();
      } else if (b.dataset.act === 'del') {
        await call('passwords.remove', id);
        await loadPasswords();
      } else if (b.dataset.act === 'save') {
        const val = (f) => row.querySelector(`[data-f="${f}"]`)?.value ?? '';
        if (id === 'new') {
          let origin = val('origin').trim();
          if (origin && !/^https?:\/\//i.test(origin)) origin = 'https://' + origin;
          await call('passwords.add', { origin, username: val('username').trim(), password: val('password') });
        } else {
          await call('passwords.update', id, { username: val('username').trim(), password: val('password') });
        }
        pwEditing = null;
        await loadPasswords();
        toast('Saved');
      }
    } catch (err) {
      toast(err.message);
    }
  });
  $('#pw-never').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-never]');
    if (b) {
      await call('passwords.removeNever', b.dataset.never);
      loadPasswords();
    }
  });
  $('#pw-add').addEventListener('click', () => {
    pwEditing = 'new';
    loadPasswords();
  });
  $('#pw-import').addEventListener('click', async () => {
    try {
      const r = await call('passwords.import');
      if (r) toast(`Imported ${r.added} password${r.added === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped}` : ''}`);
      loadPasswords();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#pw-export').addEventListener('click', async () => {
    try {
      const f = await call('passwords.export');
      if (f) toast('Exported to ' + f);
    } catch (err) {
      toast(err.message);
    }
  });

  // ---- autofill details
  async function loadAutofill() {
    const p = await call('autofill.get');
    for (const el of $$('[data-af]')) el.value = p[el.dataset.af] || '';
  }
  $('#af-save').addEventListener('click', async () => {
    const profile = {};
    for (const el of $$('[data-af]')) profile[el.dataset.af] = el.value.trim();
    try {
      await call('autofill.set', profile);
      toast('Contact details saved');
    } catch (err) {
      toast(err.message);
    }
  });

  // ---- sync
  let syncFolder = '';
  async function loadSync() {
    const st = await call('sync.status');
    const card = $('#sync-card');
    if (!st.available) {
      card.innerHTML = '<div class="perm-empty">Sync needs a secure keystore to protect its passphrase, and this computer does not have one available.</div>';
      return;
    }
    if (st.enabled) {
      card.innerHTML = `<div class="list-row"><div class="grow"><b>Sync is on <span class="pill">${esc(st.running ? 'syncing…' : st.lastSync ? 'last synced ' + new Date(st.lastSync).toLocaleTimeString() : 'not yet synced')}</span></b>
        <small>${esc(st.folder)}</small>${st.lastError ? `<small class="err">${esc(st.lastError)}</small>` : ''}</div>
        <button class="btn small" id="sync-now">Sync now</button><button class="btn small danger" id="sync-off">Turn off</button></div>`;
      $('#sync-now').onclick = async () => {
        $('#sync-now').disabled = true;
        try {
          await call('sync.now');
          toast('Synced');
        } catch (err) {
          toast(err.message);
        }
        loadSync();
        loadPasswords();
        loadAutofill();
      };
      $('#sync-off').onclick = async () => {
        await call('sync.disable');
        loadSync();
      };
      return;
    }
    card.innerHTML = `<div class="sync-form">
      <div class="folder"><span id="sync-folder">${esc(syncFolder || 'No folder chosen')}</span><button class="btn small" id="sync-pick">Choose folder…</button></div>
      <label>Sync passphrase (at least 8 characters — use the same one on every device)<input id="sync-pass" type="password" autocomplete="new-password" /></label>
      <div><button class="btn primary small" id="sync-on">Turn on sync</button></div>
      ${st.lastError ? `<small class="err" style="color:var(--danger)">${esc(st.lastError)}</small>` : ''}
      <small class="hint">If you forget the passphrase the synced file cannot be recovered. Your data on this device is unaffected.</small></div>`;
    $('#sync-pick').onclick = async () => {
      const f = await call('sync.chooseFolder');
      if (f) {
        syncFolder = f;
        $('#sync-folder').textContent = f;
      }
    };
    $('#sync-on').onclick = async () => {
      if (!syncFolder) return toast('Choose a folder first');
      $('#sync-on').disabled = true;
      try {
        await call('sync.enable', syncFolder, $('#sync-pass').value);
        toast('Sync is on');
        s = await call('settings.get');
        render();
      } catch (err) {
        toast(err.message);
      }
      loadSync();
      loadPasswords();
      loadAutofill();
    };
  }

  // ---- extensions
  async function loadExtensions() {
    const list = await call('extensions.list');
    $('#ext-list').innerHTML = list.length
      ? list
          .map(
            (x) => `<div class="list-row"><div class="grow"><b>${esc(x.name)} <span class="pill">${esc(x.version || '')}</span></b>
              <small>${esc(x.error ? '' : x.description || x.path)}</small>${x.error ? `<small class="err">Could not load: ${esc(x.error)}</small>` : ''}</div>
              <button class="btn small danger" data-ext="${esc(x.id || x.path)}">Remove</button></div>`
          )
          .join('')
      : '<div class="perm-empty">No extensions loaded.</div>';
  }
  $('#ext-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-ext]');
    if (!b) return;
    await call('extensions.remove', b.dataset.ext);
    loadExtensions();
  });
  $('#ext-add').addEventListener('click', async () => {
    try {
      const r = await call('extensions.add');
      if (r) toast(`Loaded ${r.name}`);
      loadExtensions();
    } catch (err) {
      toast(err.message);
    }
  });

  // ---- protected video (DRM)
  async function loadDrm() {
    const d = await call('drm.status');
    $('#drm-note').textContent = d.supported ? 'Protected video (Widevine): available in this build.' : 'Protected video (Widevine): not in this build — see the README to enable it.';
  }

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
