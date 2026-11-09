'use strict';
const path = require('path');
const { WebContentsView, dialog } = require('electron');
const { history } = require('./history');
const { bookmarks } = require('./bookmarks');
const { isInternal, NEWTAB_URL } = require('./url');
const { actionFor } = require('./shortcuts');

const TAB_PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

let nextTabId = 1;

function tabWebPreferences(ses) {
  return {
    session: ses,
    preload: TAB_PRELOAD,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: true,
    safeDialogs: true,
    navigateOnDragDrop: true
  };
}

class Tab {
  /**
   * @param {import('./window').VexaWindow} win
   * @param {object} opts
   * @param {string} [opts.url]            URL to load (immediately, or on first activation if lazy)
   * @param {Electron.WebContents} [opts.webContents] adopt a webContents created by window.open
   * @param {object} [opts.restore]        { entries, index, title, favicon } from a saved session
   * @param {boolean} [opts.lazy]          defer loading until the tab is first shown
   */
  constructor(win, { url, webContents, restore, lazy = false } = {}) {
    this.id = nextTabId++;
    this.win = win;
    this.isPrivate = win.isPrivate;
    this.view = webContents ? new WebContentsView({ webContents }) : new WebContentsView({ webPreferences: tabWebPreferences(win.session) });
    this.view.setBackgroundColor('#ffffff');
    this.wc = this.view.webContents;

    this.title = restore?.title || '';
    this.url = url || restore?.entries?.[restore.index ?? restore.entries.length - 1]?.url || '';
    this.favicon = restore?.favicon || '';
    this.loading = false;
    this.error = null; // { code, description, url }
    this.crashed = null;
    this.audible = false;
    this.zoom = 1;
    this.permissionRequests = []; // pending prompts
    this.find = { active: false, text: '', matches: 0, ordinal: 0 };
    this.htmlFullscreen = false;
    this.pending = lazy ? { url, restore } : null;
    this.createdAt = Date.now();

    this._wire();

    if (!lazy && !webContents) this._load({ url, restore });
  }

  _entryTitle(url) {
    const t = this.wc.isDestroyed() ? '' : this.wc.getTitle();
    if (!t || t === url || url.endsWith(t) || t.startsWith('http://') || t.startsWith('https://')) return '';
    return t;
  }

  _load({ url, restore }) {
    if (restore?.entries?.length && this.wc.navigationHistory?.restore) {
      this.wc.navigationHistory.restore({ entries: restore.entries, index: restore.index }).catch(() => {});
    } else {
      this.loadURL(url || NEWTAB_URL);
    }
  }

  /** Load a deferred (restored) tab the first time it's shown. */
  ensureLoaded() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    this._load(p);
  }

  get isNewTab() {
    return this.url === NEWTAB_URL || this.url === 'vexa://newtab';
  }

  loadURL(url) {
    this.pending = null;
    this.error = null;
    this.crashed = null;
    this.url = url;
    this.wc.loadURL(url).catch(() => {
      /* failures are reported through did-fail-load */
    });
    this.changed();
  }

  changed() {
    this.win.tabChanged(this);
  }

  _wire() {
    const wc = this.wc;

    wc.on('did-start-loading', () => {
      this.loading = true;
      this.changed();
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      if (!this.title) this.title = this._entryTitle(wc.getURL());
      this._syncZoom();
      this.changed();
    });

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      if (this.error || this.crashed) {
        this.error = null;
        this.crashed = null;
        this.win.layout();
      }
      this.find = { active: this.find.active, text: this.find.text, matches: 0, ordinal: 0 };
      // Permission prompts belong to the page that asked.
      this._dropPermissionRequests();
      this.changed();
    });

    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      // Restored and back/forward-cached entries already carry a title, and Chromium
      // won't fire page-title-updated for them — so take it from the entry.
      this.title = this._entryTitle(url);
      this.favicon = '';
      if (!this.isPrivate) history.addVisit(url, wc.getTitle());
      this.changed();
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      if (!this.isPrivate) history.addVisit(url, wc.getTitle(), this.favicon);
      this.changed();
    });

    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      if (!this.isPrivate) history.updateTitle(wc.getURL(), title);
      this.changed();
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      // Prefer a non-ico, non-tiny icon if offered; fall back to the first.
      this.favicon = favicons.find((f) => /\.(png|svg)(\?|$)/i.test(f)) || favicons[0] || '';
      if (!this.isPrivate) history.updateFavicon(wc.getURL(), this.favicon);
      this.changed();
    });

    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED (user stopped, or the response became a download).
      if (!isMainFrame || code === -3) return;
      this.error = { code, description, url: validatedURL };
      this.url = validatedURL || this.url;
      try {
        this.title = new URL(this.url).host || this.url;
      } catch {
        this.title = this.url;
      }
      this.favicon = '';
      this.loading = false;
      this.win.layout();
      this.changed();
    });

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.crashed = details.reason;
      this.loading = false;
      this.win.layout();
      this.changed();
    });

    wc.on('unresponsive', () => {
      const res = dialog.showMessageBoxSync(this.win.win, {
        type: 'warning',
        title: 'Page unresponsive',
        message: `${this.title || this.url} isn't responding.`,
        detail: 'You can wait for it to respond or close the tab.',
        buttons: ['Wait', 'Close tab'],
        defaultId: 0,
        cancelId: 0
      });
      if (res === 1) this.win.closeTab(this.id);
    });

    wc.on('audio-state-changed', (e) => {
      this.audible = !!e.audible;
      this.changed();
    });

    wc.on('zoom-changed', (_e, direction) => {
      this.zoomStep(direction === 'in' ? 1 : -1);
    });

    wc.on('found-in-page', (_e, result) => {
      if (result.finalUpdate || result.matches !== undefined) {
        this.find.matches = result.matches ?? this.find.matches;
        this.find.ordinal = result.activeMatchOrdinal ?? this.find.ordinal;
        this.changed();
      }
    });

    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true;
      this.win.setHtmlFullscreen(this, true);
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false;
      this.win.setHtmlFullscreen(this, false);
    });

    // A page's beforeunload handler wants to block navigation/close: ask the user.
    wc.on('will-prevent-unload', (event) => {
      const choice = dialog.showMessageBoxSync(this.win.win, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        title: 'Leave site?',
        message: 'Leave site?',
        detail: 'Changes you made may not be saved.',
        defaultId: 0,
        cancelId: 1
      });
      if (choice === 0) event.preventDefault();
    });

    wc.on('before-input-event', (event, input) => {
      const action = actionFor(input);
      if (action && this.win.handleShortcut(action, this)) event.preventDefault();
    });

    wc.on('context-menu', (_e, params) => {
      require('./context-menu').showPageMenu(this, params);
    });

    wc.on('update-target-url', (_e, url) => {
      this.win.setStatusUrl(this, url);
    });

    wc.setWindowOpenHandler((details) => this._windowOpen(details));
  }

  _windowOpen({ url, disposition, features }) {
    if (/^javascript:/i.test(url)) return { action: 'deny' };
    // Real popups (window.open with size features) get a small, plain window so
    // sign-in flows that rely on window.opener keep working.
    if (disposition === 'new-window' && features) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: { ...tabWebPreferences(this.win.session) }
        }
      };
    }
    // Everything else becomes a tab. Adopting the webContents keeps window.opener intact.
    const background = disposition === 'background-tab';
    return {
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options) => {
        const tab = this.win.adoptTab(options.webContents, { afterTab: this, background, url });
        return tab.wc;
      }
    };
  }

  // --- zoom ---
  _syncZoom() {
    if (this.wc.isDestroyed()) return;
    const z = Math.round(this.wc.getZoomFactor() * 100) / 100;
    if (z !== this.zoom) {
      this.zoom = z;
      this.changed();
    }
  }

  setZoom(factor) {
    this.wc.setZoomFactor(factor);
    this.zoom = factor;
    this.changed();
  }

  zoomStep(dir) {
    const cur = this.wc.getZoomFactor();
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((z) => z > cur + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
    else next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) ?? ZOOM_STEPS[0];
    this.setZoom(next);
  }

  // --- find in page ---
  findInPage(text, { forward = true, findNext = false } = {}) {
    this.find.text = text;
    this.find.active = true;
    if (!text) {
      this.wc.stopFindInPage('clearSelection');
      this.find.matches = 0;
      this.find.ordinal = 0;
      this.changed();
      return;
    }
    this.wc.findInPage(text, { forward, findNext });
  }

  stopFind() {
    this.find = { active: false, text: this.find.text, matches: 0, ordinal: 0 };
    if (!this.wc.isDestroyed()) this.wc.stopFindInPage('keepSelection');
    this.changed();
  }

  // --- permissions ---
  addPermissionRequest(req) {
    this.permissionRequests.push(req);
    this.changed();
  }

  resolvePermission(reqId, decision, remember) {
    const i = this.permissionRequests.findIndex((r) => r.id === reqId);
    if (i < 0) return;
    const [req] = this.permissionRequests.splice(i, 1);
    req.resolve({ decision, remember });
    this.changed();
  }

  _dropPermissionRequests() {
    for (const r of this.permissionRequests) r.resolve({ decision: 'dismiss', remember: false });
    this.permissionRequests = [];
  }

  /** Serializable snapshot for the browser UI. */
  snapshot() {
    const wc = this.wc;
    const alive = !wc.isDestroyed();
    const nav = alive ? wc.navigationHistory : null;
    return {
      id: this.id,
      title: this.title || (this.isNewTab ? 'New Tab' : this.url),
      url: this.url,
      favicon: this.favicon,
      loading: this.loading,
      canGoBack: !!nav && nav.canGoBack(),
      canGoForward: !!nav && nav.canGoForward(),
      error: this.error,
      crashed: this.crashed,
      audible: this.audible,
      muted: alive && wc.isAudioMuted(),
      zoom: this.zoom,
      bookmarked: bookmarks.isBookmarked(this.url),
      internal: isInternal(this.url),
      isNewTab: this.isNewTab,
      secure: /^https:/i.test(this.url),
      permission: this.permissionRequests[0]
        ? { id: this.permissionRequests[0].id, permission: this.permissionRequests[0].permission, origin: this.permissionRequests[0].origin, mediaTypes: this.permissionRequests[0].mediaTypes, externalURL: this.permissionRequests[0].externalURL, oneOff: this.permissionRequests[0].oneOff }
        : null,
      find: this.find,
      pending: !!this.pending
    };
  }

  /** For session restore. */
  serialize() {
    if (this.pending) {
      const r = this.pending.restore;
      return r ? { entries: r.entries, index: r.index, title: this.title, favicon: this.favicon } : { entries: [{ url: this.pending.url || NEWTAB_URL, title: this.title }], index: 0, title: this.title, favicon: this.favicon };
    }
    let entries = [];
    let index = 0;
    try {
      const nav = this.wc.navigationHistory;
      entries = nav.getAllEntries().map((e) => ({ url: e.url, title: e.title, ...(e.pageState && e.pageState.length < 64 * 1024 ? { pageState: e.pageState } : {}) }));
      index = nav.getActiveIndex();
    } catch {
      /* destroyed */
    }
    // Don't restore error pages or blank entries.
    entries = entries.filter((e) => e.url && !e.url.startsWith('chrome-error:'));
    if (!entries.length) entries = [{ url: this.url || NEWTAB_URL, title: this.title }];
    // Keep it bounded.
    if (entries.length > 25) {
      const drop = entries.length - 25;
      entries = entries.slice(drop);
      index = Math.max(0, index - drop);
    }
    index = Math.min(Math.max(0, index), entries.length - 1);
    return { entries, index, title: this.title, favicon: this.favicon };
  }

  destroy() {
    this._dropPermissionRequests();
    try {
      if (!this.wc.isDestroyed()) this.wc.close();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { Tab, ZOOM_STEPS };
