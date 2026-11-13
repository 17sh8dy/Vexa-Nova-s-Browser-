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
    const r = resolveInput(String(input), settings.get('searchEngine'));
    if (!r.url) return false;
    if (disposition === 'current' && ctx.tab) ctx.tab.loadURL(r.url);
    else ctx.win.navigate(r.url, { disposition: disposition === 'background' ? 'background' : 'new-tab' });
    return true;
  },
  'nav.focusAddress': (ctx) => ctx.win.focusAddress(),

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

  ipcMain.handle('vexa:api', async (event, method, ...args) => {
    const frameUrl = event.senderFrame?.url || '';
    if (!frameUrl.startsWith('vexa://') || frameUrl.startsWith('vexa://search')) throw new Error('Not allowed');
    const { win, tab } = controller.windowForWebContents(event.sender);
    if (!win || !tab) throw new Error('Unknown sender');
    const fn = api[method];
    if (!fn) throw new Error(`Unknown API ${method}`);
    return fn({ win, tab }, ...args);
  });
}

module.exports = { register };
