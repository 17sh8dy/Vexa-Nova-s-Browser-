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
const { SEARCH_ENGINES, resolveInput } = require('./url');

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
  'settings.engines': () => Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
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
  'privacy.clear': (_ctx, what) => clearBrowsingData(what || {}),

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

  ipcMain.handle('vexa:api', async (event, method, ...args) => {
    const frameUrl = event.senderFrame?.url || '';
    if (!frameUrl.startsWith('vexa://')) throw new Error('Not allowed');
    const { win, tab } = controller.windowForWebContents(event.sender);
    if (!win || !tab) throw new Error('Unknown sender');
    const fn = api[method];
    if (!fn) throw new Error(`Unknown API ${method}`);
    return fn({ win, tab }, ...args);
  });
}

module.exports = { register };
