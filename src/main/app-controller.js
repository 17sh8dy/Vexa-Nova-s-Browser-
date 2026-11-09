'use strict';
// Owns all windows, session save/restore, and fan-out of data changes.

const path = require('path');
const { app, nativeTheme, dialog, BrowserWindow, webContents: allWebContents } = require('electron');
const { JsonStore } = require('./store');
const { settings } = require('./settings');
const { history } = require('./history');
const { bookmarks } = require('./bookmarks');
const { downloads } = require('./downloads');
const { setPermissionPrompter, clearBrowsingData } = require('./sessions');
const { isInternal, NEWTAB_URL } = require('./url');

const windows = new Set();
let lastFocused = null;
let sessionStore = null;
let saveTimer = null;
let quitting = false;

function normalWindows() {
  return [...windows].filter((w) => !w.isPrivate && !w.closing && !w.win.isDestroyed());
}

// ------------------------------------------------------------------ session
function saveSessionNow() {
  if (!sessionStore || quitting) return;
  const wins = normalWindows();
  if (!wins.length) return; // keep the last snapshot (the last window is closing)
  sessionStore.data = { savedAt: Date.now(), windows: wins.map((w) => w.serialize()) };
  sessionStore.flush();
}

function saveSessionSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessionNow, 1000);
}

// ------------------------------------------------------------------ windows
function createWindow(opts = {}) {
  const { VexaWindow } = require('./window');
  if (!opts.restore && !opts.bounds) {
    // Cascade new windows from the focused one.
    const ref = lastFocused && !lastFocused.win.isDestroyed() ? lastFocused.win.getBounds() : null;
    if (ref) opts.bounds = { x: ref.x + 28, y: ref.y + 28, width: ref.width, height: ref.height };
  }
  const w = new VexaWindow(opts);
  windows.add(w);
  lastFocused = w;
  w.win.on('focus', () => {
    lastFocused = w;
  });
  if (!w.isPrivate) w.on('tabs-changed', saveSessionSoon);
  w.on('closing', () => {
    // Snapshot including this window first, then (if others remain) without it.
    if (!w.isPrivate) {
      clearTimeout(saveTimer);
      saveSessionNow();
    }
  });
  w.on('closed', () => {
    windows.delete(w);
    if (lastFocused === w) lastFocused = [...windows].pop() || null;
    if (!w.isPrivate) saveSessionNow();
  });
  return w;
}

function focusedWindow() {
  const bw = BrowserWindow.getFocusedWindow();
  return [...windows].find((w) => w.win === bw) || (lastFocused && !lastFocused.win.isDestroyed() ? lastFocused : null);
}

/** Open URLs (e.g. passed on the command line) in the most recent normal window. */
function openUrls(urls) {
  const w = normalWindows().find((x) => x === lastFocused) || normalWindows()[0];
  if (!w) return createWindow({ urls });
  urls.forEach((u, i) => w.addTab({ url: u, activate: i === urls.length - 1 }));
  w.focus();
  return w;
}

function windowForWebContents(wc) {
  for (const w of windows) {
    if (w.chrome === wc || w.overlay.webContents === wc || w.status.webContents === wc) return { win: w, tab: null };
    const tab = w.tabs.find((t) => t.wc === wc);
    if (tab) return { win: w, tab };
  }
  return { win: null, tab: null };
}

function startup(urls = []) {
  sessionStore = new JsonStore(path.join(app.getPath('userData'), 'session.json'), { windows: [] });
  const mode = settings.get('startup');
  const saved = sessionStore.data.windows || [];
  if (mode === 'restore' && saved.length) {
    saved.forEach((restore) => createWindow({ restore }));
    if (urls.length) openUrls(urls);
  } else {
    createWindow({ urls: urls.length ? urls : [mode === 'home' ? settings.homeUrl() : NEWTAB_URL] });
  }
}

// ------------------------------------------------------------------ fan-out
function broadcastInternal(event, payload) {
  for (const w of windows) {
    for (const t of w.tabs) {
      if (!t.wc.isDestroyed() && isInternal(t.wc.getURL())) t.wc.send('vexa:event', event, payload);
    }
  }
}

function refreshAllChrome() {
  for (const w of windows) w.sendState();
}

let historyTimer = null;
function wireDataEvents() {
  settings.on('changed', (key, value) => {
    if (key === 'theme') nativeTheme.themeSource = value;
    refreshAllChrome();
    broadcastInternal('settings', { key, value });
  });
  bookmarks.on('changed', () => {
    for (const w of windows) {
      for (const t of w.tabs) t.changed();
    }
    refreshAllChrome();
    broadcastInternal('bookmarks');
  });
  history.on('changed', () => {
    if (historyTimer) return;
    historyTimer = setTimeout(() => {
      historyTimer = null;
      broadcastInternal('history');
    }, 500);
  });
  downloads.on('changed', () => {
    for (const w of windows) {
      w.sendState();
      w.updatePopup('downloads', w.downloadsData());
    }
    broadcastInternal('downloads');
  });
  downloads.on('started', (_record, wc) => {
    const { win, tab } = wc ? windowForWebContents(wc) : { win: focusedWindow(), tab: null };
    const target = win || focusedWindow();
    // A link that opened a blank tab just to download: close that tab.
    if (tab && target && target.tabs.length > 1) {
      let entries = 0;
      try {
        entries = tab.wc.navigationHistory.length();
      } catch {
        /* ignore */
      }
      const url = tab.wc.getURL();
      if (entries <= 1 && (!url || url === 'about:blank') && Date.now() - tab.createdAt < 10000) target.closeTab(tab.id);
    }
    if (target && settings.get('showDownloadsOnStart')) {
      target.focus();
      target.chrome.send('downloads-started');
    }
  });

  setPermissionPrompter(async (wc, req) => {
    const { win, tab } = windowForWebContents(wc);
    if (win && tab) return win.promptPermission(tab, req);
    // Popup windows etc.: fall back to a native dialog.
    const parent = BrowserWindow.fromWebContents(wc) || undefined;
    const { response, checkboxChecked } = await dialog.showMessageBox(parent, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      message: `${req.origin} wants to use: ${req.permission}`,
      checkboxLabel: req.oneOff ? undefined : 'Remember this decision'
    });
    return { decision: response === 0 ? 'allow' : 'block', remember: !!checkboxChecked };
  });
}

// ------------------------------------------------------------------ quit
async function onBeforeQuit(event) {
  if (quitting) return;
  clearTimeout(saveTimer);
  saveSessionNow();
  quitting = true;
  const c = settings.get('clearOnExit');
  if (c.history || c.cookies || c.cache || c.downloads) {
    event.preventDefault();
    try {
      await clearBrowsingData({ history: c.history, cookies: c.cookies, cache: c.cache, downloads: c.downloads });
      if (c.history && sessionStore) {
        sessionStore.data = { windows: [] };
        sessionStore.flush();
      }
    } finally {
      require('./store').JsonStore.flushAll();
      app.exit(0);
    }
    return;
  }
  require('./store').JsonStore.flushAll();
}

function quit() {
  app.quit();
}

module.exports = {
  windows,
  createWindow,
  focusedWindow,
  openUrls,
  windowForWebContents,
  startup,
  wireDataEvents,
  broadcastInternal,
  onBeforeQuit,
  quit,
  saveSessionNow,
  allWebContents
};
