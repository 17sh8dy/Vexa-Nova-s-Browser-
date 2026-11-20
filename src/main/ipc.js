'use strict';
// IPC entry points. Three channels, each checking who is calling:
//  - chrome:cmd   from the browser UI of a window
//  - overlay:cmd  from that window's popup layer
//  - vexa:api     from internal vexa:// pages only

const fs = require('fs');
const { ipcMain, dialog, app, shell, BrowserWindow } = require('electron');
const controller = require('./app-controller');
const { settings } = require('./settings');
const { history } = require('./history');
const { bookmarks } = require('./bookmarks');
const { downloads } = require('./downloads');
const { clearBrowsingData } = require('./sessions');
const { SEARCH_ENGINES, resolveInput, originOf } = require('./url');
const { passwords } = require('./passwords');
const { autofill, FIELDS: AUTOFILL_FIELDS } = require('./autofill');
const { extensions } = require('./extensions');
const { sync } = require('./sync');
const defaultBrowser = require('./default-browser');
const { shields } = require('./shields');
const { wallpapers } = require('./wallpapers');
const { atmosphere } = require('./atmosphere');
const { spaces } = require('./spaces');
const { collections } = require('./collections');
const { reader } = require('./reader');
const { searchHistory } = require('./search-history');
const { DEFAULT_SEARCH_SHORTCUTS } = require('./settings');

// Internal pages that show content from the web get only the calls they need.
// vexa://reader renders an article extracted from a website: reader.* and two helpers.
const PAGE_ALLOW = {
  reader: (m) => m.startsWith('reader.') || m === 'atmosphere.look' || m === 'nav.open'
};

const RANGES = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 28 * 86400e3 };
const str = (v, max = 2000) => (typeof v === 'string' && v.length <= max ? v : '');
const parentOf = (ctx) => BrowserWindow.fromWebContents(ctx.win.chrome);

function senderWindow(event, role) {
  const { win } = controller.windowForWebContents(event.sender);
  if (!win) throw new Error('Unknown sender');
  if (role === 'chrome' && event.sender !== win.chrome) throw new Error('Not the browser UI');
  if (role === 'overlay' && event.sender !== win.overlay.webContents) throw new Error('Not the popup layer');
  return win;
}

const api = {
  // settings
  'settings.get': () => settings.get(),
  'settings.set': (_ctx, key, value) => settings.set(key, value),
  'settings.engines': () => Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name, beta: Boolean(e.beta) })),
  'settings.chooseDownloadDir': async (ctx) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(ctx.win.chrome), {
      title: 'Choose download folder',
      defaultPath: settings.downloadDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    settings.set('downloadDir', res.filePaths[0]);
    return res.filePaths[0];
  },
  'settings.defaultDownloadDir': () => settings.downloadDir(),
  'settings.sitePermissions': () => settings.get('sitePermissions'),
  'settings.setSitePermission': (_ctx, origin, permission, decision) => settings.setSitePermission(String(origin), String(permission), decision == null ? null : decision === 'allow' ? 'allow' : 'block'),

  // Vexa Shields (settings page + New Tab widget)
  'shields.sites': () => settings.get('shieldsSites'),
  'shields.resetSite': (_ctx, site) => shields.resetSite(str(site, 255)),
  'shields.resetAllSites': () => settings.set('shieldsSites', {}),
  'shields.lifetime': () => shields.lifetime(),

  // New Tab page: wallpaper + layout
  'ntp.get': (ctx) => wallpapers.pageData(ctx.win.isPrivate, ctx.tab && !ctx.win.isPrivate ? spaces.get(ctx.tab.spaceId) : null),
  'ntp.set': (_ctx, patch) => settings.set('newTab', patch && typeof patch === 'object' ? patch : {}),
  'ntp.reset': () => wallpapers.reset(),
  'wallpaper.choose': (_ctx, kind, id) => wallpapers.choose(str(kind, 20), str(id, 100)),
  'wallpaper.upload': async (ctx) => {
    const res = await dialog.showOpenDialog(parentOf(ctx), {
      title: 'Choose a wallpaper',
      filters: [{ name: 'Images (JPG, PNG, WebP)', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return wallpapers.addFile(res.filePaths[0]);
  },
  'wallpaper.uploadData': (_ctx, name, bytes) => wallpapers.addBytes(str(name, 300), bytes),
  'wallpaper.remove': (_ctx, id) => wallpapers.remove(str(id, 100)),

  // history
  'history.query': (_ctx, opts) => history.query(opts || {}),
  'history.remove': (_ctx, ids) => history.remove(Array.isArray(ids) ? ids : [ids]),
  'history.clear': () => history.clear(),
  'history.topSites': (_ctx, n = 8) => history.topSites(Math.min(Number(n) || 8, 24), settings.get('hiddenTopSites')),
  'history.hideTopSite': (_ctx, key) => settings.set('hiddenTopSites', [...new Set([...settings.get('hiddenTopSites'), String(key)])]),
  'history.restoreTopSites': () => settings.set('hiddenTopSites', []),

  // bookmarks
  'bookmarks.children': (_ctx, id) => bookmarks.children(id),
  'bookmarks.folders': () => bookmarks.folders(),
  'bookmarks.get': (_ctx, id) => bookmarks.get(id),
  'bookmarks.add': (_ctx, data) => bookmarks.add(data),
  'bookmarks.addFolder': (_ctx, data) => bookmarks.addFolder(data),
  'bookmarks.update': (_ctx, id, data) => bookmarks.update(id, data),
  'bookmarks.remove': (_ctx, id) => bookmarks.remove(id),
  'bookmarks.move': (_ctx, id, parentId, index) => bookmarks.move(id, parentId, index),
  'bookmarks.search': (_ctx, text) => bookmarks.search(text),
  'bookmarks.export': async (ctx) => {
    const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(ctx.win.chrome), {
      title: 'Export bookmarks',
      defaultPath: 'vexa-bookmarks.html',
      filters: [{ name: 'HTML', extensions: ['html'] }]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, bookmarks.exportHtml());
    return res.filePath;
  },
  'bookmarks.import': async (ctx) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(ctx.win.chrome), {
      title: 'Import bookmarks (HTML file exported from another browser)',
      filters: [{ name: 'Bookmark HTML', extensions: ['html', 'htm'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return bookmarks.importHtml(fs.readFileSync(res.filePaths[0], 'utf8'));
  },

  // downloads
  'downloads.list': () => downloads.list(),
  'downloads.action': (ctx, id, action) => {
    if (action === 'retry') {
      const rec = downloads.list().find((r) => r.id === id);
      if (rec) ctx.win.session.downloadURL(rec.url);
      return true;
    }
    return downloads.action(id, action);
  },
  'downloads.clear': () => downloads.clearFinished(),
  'downloads.openFolder': () => shell.openPath(settings.downloadDir()),

  // privacy
  'privacy.clear': (_ctx, what, range = 'all') => {
    const w = what || {};
    const since = RANGES[range] ? Date.now() - RANGES[range] : 0;
    return clearBrowsingData({ history: !!w.history, cookies: !!w.cookies, cache: !!w.cache, downloads: !!w.downloads, permissions: !!w.permissions, passwords: !!w.passwords, autofill: !!w.autofill }, { since });
  },

  // default browser
  'browser.defaultStatus': () => defaultBrowser.status(),
  'browser.makeDefault': () => defaultBrowser.makeDefault(),

  // passwords
  'passwords.available': () => passwords.available(),
  'passwords.list': () => passwords.list(),
  'passwords.reveal': (_ctx, id) => passwords.reveal(str(id, 100)),
  'passwords.add': (_ctx, data) => passwords.save({ origin: str(data?.origin, 500), username: str(data?.username, 500), password: str(data?.password, 1000) }),
  'passwords.update': (_ctx, id, data) => passwords.update(str(id, 100), { username: typeof data?.username === 'string' ? data.username.slice(0, 500) : undefined, password: typeof data?.password === 'string' ? data.password.slice(0, 1000) : undefined }),
  'passwords.remove': (_ctx, id) => passwords.remove(str(id, 100)),
  'passwords.never': () => passwords.neverList(),
  'passwords.removeNever': (_ctx, origin) => passwords.removeNever(str(origin, 500)),
  'passwords.import': async (ctx) => {
    const res = await dialog.showOpenDialog(parentOf(ctx), {
      title: 'Import passwords (CSV exported from Chrome, Edge, Firefox or a password manager)',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return passwords.importCsv(fs.readFileSync(res.filePaths[0], 'utf8'));
  },
  'passwords.export': async (ctx) => {
    const confirm = await dialog.showMessageBox(parentOf(ctx), {
      type: 'warning',
      buttons: ['Export', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Export passwords',
      message: 'The exported file is NOT encrypted.',
      detail: 'Anyone who can open the file can read every password in it. Delete it as soon as you have imported it elsewhere.'
    });
    if (confirm.response !== 0) return null;
    const res = await dialog.showSaveDialog(parentOf(ctx), { title: 'Export passwords', defaultPath: 'vexa-passwords.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, passwords.exportCsv());
    return res.filePath;
  },

  // autofill (contact details)
  'autofill.get': () => autofill.get(),
  'autofill.set': (_ctx, profile) => autofill.set(Object.fromEntries(AUTOFILL_FIELDS.map((f) => [f, str(profile?.[f], 300)]))),

  // extensions
  'extensions.list': () => extensions.list(),
  'extensions.add': async (ctx) => {
    const res = await dialog.showOpenDialog(parentOf(ctx), { title: 'Choose the folder of an unpacked extension (it contains manifest.json)', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    return extensions.add(res.filePaths[0]);
  },
  'extensions.remove': (_ctx, idOrPath) => extensions.remove(str(idOrPath, 1000)),

  // sync
  'sync.status': () => sync.status(),
  'sync.chooseFolder': async (ctx) => {
    const res = await dialog.showOpenDialog(parentOf(ctx), { title: 'Choose a sync folder (inside OneDrive, Dropbox, Google Drive, Syncthing…)', properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  },
  'sync.enable': (_ctx, folder, passphrase) => sync.enable(str(folder, 1000), str(passphrase, 500)),
  'sync.now': () => sync.syncNow(),
  'sync.disable': () => sync.disable(),

  // DRM
  'drm.status': () => {
    const c = require('electron').components; // only present in Widevine-enabled Electron builds
    return { supported: !!c && typeof c.whenReady === 'function', status: c && typeof c.status === 'function' ? c.status() : null };
  },

  // navigation from internal pages (new tab page search box, history links with modifiers)
  'nav.open': (ctx, input, disposition = 'current') => {
    const r = resolveInput(String(input), settings.get('searchEngine'), { shortcuts: settings.get('searchShortcuts') });
    if (r.type === 'scope') {
      ctx.win.runAction('command-center', { payload: { query: String(input) } });
      return true;
    }
    if (!r.url) return false;
    if (r.type === 'search' && !ctx.win.isPrivate) searchHistory.add(r.query, r.engine);
    if (disposition === 'current' && ctx.tab) ctx.tab.loadURL(r.url);
    else ctx.win.navigate(r.url, { disposition: disposition === 'background' ? 'background' : 'new-tab' });
    return true;
  },
  'nav.focusAddress': (ctx) => ctx.win.focusAddress(),
  'nav.commandCenter': (ctx, query = '') => ctx.win.runAction('command-center', { payload: { query: str(query, 300) } }),

  // ---- 0.90: Vexa Atmosphere
  'atmosphere.get': (ctx) => ({
    config: settings.get('atmosphere'),
    sidebar: settings.get('sidebar'),
    presets: atmosphere.presets(),
    sounds: atmosphere.sounds(),
    palettes: Object.entries(require('../renderer/shared/palettes').PALETTES).map(([id, p]) => ({ id, name: p.name, desc: p.desc, swatch: (p.dark['--accent'] || '#8b5cf6'), strip: p.dark['--strip'] || '#0e0c15' })),
    look: ctx.win.look(),
    space: ctx.win.space ? { id: ctx.win.space.id, name: ctx.win.space.name, look: ctx.win.space.look } : null
  }),
  'atmosphere.look': (ctx) => ctx.win.look(),
  'atmosphere.set': (_ctx, patch) => atmosphere.update(patch),
  'atmosphere.preset': (_ctx, id) => atmosphere.applyPreset(str(id, 20)),
  'atmosphere.reset': () => atmosphere.reset(),
  'atmosphere.importSound': async (ctx) => {
    const res = await dialog.showOpenDialog(parentOf(ctx), { title: 'Import a sound', filters: [{ name: 'Audio (MP3, WAV, OGG, FLAC, M4A, WebM)', extensions: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'mp4', 'webm'] }], properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return null;
    return { path: res.filePaths[0], bytes: fs.readFileSync(res.filePaths[0]).subarray(0, 2 * 1024 * 1024 + 1), name: require('path').basename(res.filePaths[0]) };
  },
  'atmosphere.saveSound': (_ctx, name, bytes, duration) => atmosphere.importBytes(str(name, 300), bytes, Number(duration)),
  'atmosphere.removeSound': (_ctx, id) => atmosphere.removeSound(str(id, 16)),
  'atmosphere.soundBytes': (_ctx, id) => atmosphere.bytes(str(id, 16)),
  'sidebar.set': (_ctx, patch) => settings.set('sidebar', patch && typeof patch === 'object' ? patch : {}),

  // ---- Spaces
  'spaces.list': (ctx) => ({ spaces: spaces.list(), current: ctx.win.isPrivate ? null : ctx.win.spaceId, tabSpace: ctx.tab ? ctx.tab.spaceId : null, meta: spaces.meta(), saved: spaces.saved() }),
  'spaces.create': (ctx, data) => {
    const s = spaces.create(data && typeof data === 'object' ? data : {});
    return s;
  },
  'spaces.update': (_ctx, id, patch) => spaces.update(str(id, 40), patch && typeof patch === 'object' ? patch : {}),
  'spaces.remove': (_ctx, id) => spaces.remove(str(id, 40)),
  'spaces.move': (_ctx, id, index) => spaces.move(str(id, 40), Number(index)),
  'spaces.switch': (ctx, id) => ctx.win.switchSpace(str(id, 40)),
  'spaces.removeSaved': (_ctx, id) => spaces.removeSaved(str(id, 40)),
  'spaces.restoreSaved': (ctx, id) => require('./command-center').commandCenter.run(ctx.win, { run: { kind: 'saved-session', id: str(id, 40) } }),
  'spaces.pinned': (_ctx, id, op, data) => (op === 'remove' ? spaces.removePinned(str(id, 40), str(data, 2048)) : spaces.addPinned(str(id, 40), { url: str(data?.url, 2048), title: str(data?.title, 200) })),

  // ---- Collections
  'collections.list': () => collections.summaries(),
  'collections.view': (_ctx, id) => collections.view(str(id, 40)),
  'collections.create': (_ctx, data) => collections.create({ name: str(data?.name, 80), description: str(data?.description, 1000) }),
  'collections.update': (_ctx, id, patch) => collections.update(str(id, 40), patch && typeof patch === 'object' ? patch : {}),
  'collections.remove': (_ctx, id) => collections.remove(str(id, 40)),
  'collections.move': (_ctx, id, index) => collections.move(str(id, 40), Number(index)),
  'collections.addItem': (_ctx, id, item) => collections.addItem(str(id, 40), item && typeof item === 'object' ? { type: item.type, title: item.title, url: item.url, note: item.note } : {}),
  'collections.updateItem': (_ctx, id, itemId, patch) => collections.updateItem(str(id, 40), str(itemId, 40), patch && typeof patch === 'object' ? patch : {}),
  'collections.removeItem': (_ctx, id, itemId) => collections.removeItem(str(id, 40), str(itemId, 40)),
  'collections.moveItem': (_ctx, from, itemId, to, index) => collections.moveItem(str(from, 40), str(itemId, 40), str(to, 40), index == null ? null : Number(index)),
  'collections.addFileData': (_ctx, id, name, bytes) => collections.addFileBytes(str(id, 40), str(name, 300), bytes),
  'collections.addFiles': async (ctx, id) => {
    const res = await dialog.showOpenDialog(parentOf(ctx), { title: 'Add files to the collection', properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return 0;
    let n = 0;
    for (const f of res.filePaths.slice(0, 50)) {
      collections.addFilePath(str(id, 40), f);
      n++;
    }
    return n;
  },
  'collections.openItem': (_ctx, id, itemId, reveal) => collections.openItem(str(id, 40), str(itemId, 40), { reveal: !!reveal }),
  'collections.search': (_ctx, text) => collections.search(str(text, 200), 60),
  'collections.export': async (ctx, ids) => {
    const bundle = collections.exportBundle(Array.isArray(ids) ? ids.map((x) => str(x, 40)) : []);
    const res = await dialog.showSaveDialog(parentOf(ctx), { title: 'Export collections', defaultPath: 'vexa-collections.json', filters: [{ name: 'Vexa collections', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, JSON.stringify(bundle));
    return res.filePath;
  },
  'collections.import': async (ctx) => {
    const res = await dialog.showOpenDialog(parentOf(ctx), { title: 'Import collections (a Vexa collections .json file)', filters: [{ name: 'Vexa collections', extensions: ['json'] }], properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const st = fs.statSync(res.filePaths[0]);
    if (st.size > 450 * 1024 * 1024) throw new Error('That file is too large');
    return collections.importBundle(JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')));
  },

  // ---- Reader view (also callable from vexa://reader, which gets only reader.* — see PAGE_ALLOW)
  'reader.get': (_ctx, token) => reader.get(str(token, 40)),
  'reader.prefs': () => settings.get('focus').reader,
  'reader.setPrefs': (_ctx, patch) => settings.set('focus', { reader: patch && typeof patch === 'object' ? patch : {} }).reader,
  'reader.sitePref': (_ctx, site, key, value) => reader.setSitePref(str(site, 255), str(key, 20), !!value),
  'reader.getSitePref': (_ctx, site) => settings.get('focus').sitePrefs[str(site, 255)] || {},
  // The registrable domain ("site") for a URL, decided with the Public Suffix List.
  'reader.siteOf': (_ctx, url) => require('./url').siteOf(require('./url').hostOf(str(url, 2048))) || '',
  'reader.leave': (ctx) => ctx.tab && reader.leave(ctx.tab),
  'reader.save': (ctx, token) => {
    const a = reader.get(str(token, 40));
    if (!a) throw new Error('This article is no longer available');
    const c = collections.get(collections.lastUsedId()) || collections.ensureDefault('Reading list');
    collections.addItem(c.id, { type: 'article', title: a.title, url: a.url, note: [a.byline, a.site].filter(Boolean).join(' · ') });
    return c.name;
  },
  'reader.collections': () => collections.summaries().map((c) => ({ id: c.id, name: c.name })),

  // ---- Search
  'search.history': () => searchHistory.list(200),
  'search.removeHistory': (_ctx, q) => searchHistory.remove(str(q, 300)),
  'search.clearHistory': () => searchHistory.clear(),
  'search.resetShortcuts': () => settings.set('searchShortcuts', structuredClone(DEFAULT_SEARCH_SHORTCUTS)),

  // ---- New Tab widgets
  'ntp.recent': (_ctx, n = 8) => {
    const seen = new Set();
    const out = [];
    for (const h of history.query({ limit: 200 })) {
      const o = originOf(h.url);
      if (!/^https?:/.test(h.url) || seen.has(h.url) || seen.has(o)) continue;
      seen.add(h.url);
      seen.add(o);
      out.push({ url: h.url, title: h.title, favicon: h.favicon, time: h.time });
      if (out.length >= Math.min(Number(n) || 8, 16)) break;
    }
    return out;
  },
  'ntp.addFavorite': (_ctx, fav) => {
    const list = settings.get('newTab').favoritesList.slice();
    const url = str(fav?.url, 2047);
    if (!/^https?:\/\//i.test(url)) throw new Error('Favorites need a web address (https://…)');
    if (list.length >= 24) throw new Error('You can have up to 24 favorites');
    if (!list.some((f) => f.url === url)) list.push({ url, title: str(fav?.title, 120) || url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] });
    return settings.set('newTab', { favoritesList: list }).favoritesList;
  },
  'ntp.removeFavorite': (_ctx, url) => settings.set('newTab', { favoritesList: settings.get('newTab').favoritesList.filter((f) => f.url !== url) }).favoritesList,
  'ntp.moveFavorite': (_ctx, url, index) => {
    const list = settings.get('newTab').favoritesList.slice();
    const i = list.findIndex((f) => f.url === url);
    if (i < 0) return list;
    const [f] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(Number(index) || 0, list.length)), 0, f);
    return settings.set('newTab', { favoritesList: list }).favoritesList;
  },
  'ntp.weather': (ctx) => {
    const cfg = settings.get('newTab');
    if (!cfg.weather || !cfg.weatherCity || ctx.win.isPrivate) return null;
    return require('./weather').current(cfg.weatherCity, cfg.weatherUnit);
  },
  'ntp.geocode': (_ctx, name) => require('./weather').geocode(str(name, 80)),

  // ---- Compatibility report (Settings → Compatibility)
  'app.compat': () => {
    const c = require('electron').components;
    return {
      widevine: { build: !!c && typeof c.whenReady === 'function', status: c && typeof c.status === 'function' ? c.status() : null },
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      userAgent: require('./sessions').cleanUserAgent(),
      googleCompat: settings.get('googleCompat'),
      googleSignInButtons: settings.get('googleSignInButtons')
    };
  },

  'app.info': () => ({
    name: 'Vexa',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: `${process.platform} ${process.arch}`,
    userData: app.getPath('userData')
  }),
  'app.openUserData': () => shell.openPath(app.getPath('userData'))
};

function register() {
  ipcMain.handle('chrome:cmd', (event, name, args) => senderWindow(event, 'chrome').command(name, args || {}));
  ipcMain.on('chrome:layout', (event, info) => {
    try {
      senderWindow(event, 'chrome').setLayout(info || {});
    } catch {
      /* ignore */
    }
  });
  ipcMain.handle('overlay:cmd', (event, name, args) => senderWindow(event, 'overlay').overlayCommand(name, args || {}));

  // Password manager / autofill glue for ordinary web pages (see preload/internal.js).
  const pageContext = (event) => {
    if (event.senderFrame !== event.sender.mainFrame) return null;
    const { win, tab } = controller.windowForWebContents(event.sender);
    if (!win || !tab) return null;
    const origin = originOf(event.senderFrame.url);
    return /^https?:/.test(origin) ? { win, tab, origin } : null;
  };
  ipcMain.handle('vexa:pm', (event, op) => {
    const c = pageContext(event);
    if (!c || op !== 'credentials' || !passwords.available()) return [];
    return passwords.forOrigin(c.origin);
  });
  ipcMain.on('vexa:pm-capture', (event, payload) => {
    const c = pageContext(event);
    if (!c || !payload || typeof payload.password !== 'string' || !payload.password || payload.password.length > 1000) return;
    c.tab.offerPassword(c.origin, str(payload.username, 500).trim(), payload.password);
  });
  ipcMain.on('vexa:pm-used', (event, id) => {
    if (pageContext(event)) passwords.markUsed(str(id, 100));
  });

  // Vexa Shields glue for web pages: fingerprinting config (sync, read before page scripts
  // run) and reports of protected API reads.
  ipcMain.on('vexa:shields-page', (event) => {
    try {
      const frameUrl = event.senderFrame?.url || '';
      const base = event.senderFrame === event.sender.mainFrame ? shields.pageConfig(event.sender.session, frameUrl) : { fingerprinting: false };
      event.returnValue = { ...base, googleCompat: !!settings.get('googleCompat') };
    } catch {
      event.returnValue = { fingerprinting: false, googleCompat: false };
    }
  });
  ipcMain.on('vexa:shields-fp', (event, apiName) => {
    if (event.senderFrame !== event.sender.mainFrame) return;
    if (['canvas', 'webgl', 'audio'].includes(apiName)) shields.fingerprintAttempt(event.sender.id, apiName);
  });

  ipcMain.handle('vexa:api', async (event, method, ...args) => {
    const frameUrl = event.senderFrame?.url || '';
    if (!frameUrl.startsWith('vexa://') || frameUrl.startsWith('vexa://search')) throw new Error('Not allowed');
    const { win, tab } = controller.windowForWebContents(event.sender);
    if (!win || !tab) throw new Error('Unknown sender');
    const fn = Object.hasOwn(api, method) ? api[method] : null;
    if (!fn) throw new Error(`Unknown API ${method}`);
    let page = '';
    try {
      page = new URL(frameUrl).hostname;
    } catch {
      throw new Error('Not allowed');
    }
    if (PAGE_ALLOW[page] && !PAGE_ALLOW[page](String(method))) throw new Error('Not allowed');
    return fn({ win, tab }, ...args);
  });
}

module.exports = { register };
