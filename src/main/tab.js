'use strict';
const path = require('path');
const { WebContentsView, dialog } = require('electron');
const { history } = require('./history');
const { bookmarks } = require('./bookmarks');
const { isInternal, NEWTAB_URL } = require('./url');
const { actionFor } = require('./shortcuts');
const { settings } = require('./settings');
const { passwords } = require('./passwords');
const { shields } = require('./shields');

// Input that counts as the user doing something (Chromium's "user activation").
const GESTURES = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'touchStart', 'touchEnd', 'gestureTap']);

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

let nextTabId = 1;

function tabWebPreferences(ses) {
  return {
    session: ses, // the page preload is registered on the session (sessions.js), so it also runs in tabs a page opens
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
  constructor(win, { url, webContents, restore, lazy = false, session = null } = {}) {
    this.id = nextTabId++;
    this.win = win;
    this.isPrivate = win.isPrivate;
    this.spaceId = null; // set by the window (Spaces)
    this.view = webContents ? new WebContentsView({ webContents }) : new WebContentsView({ webPreferences: tabWebPreferences(session || win.session) });
    this.view.setBackgroundColor('#ffffff');
    this.wc = this.view.webContents;

    this.title = restore?.title || '';
    this.url = url || restore?.entries?.[restore.index ?? restore.entries.length - 1]?.url || '';
    this.favicon = restore?.favicon || '';
    this.pinned = !!restore?.pinned; // pinned tabs sit at the left of the strip, icon only
    this.loading = false;
    this.error = null; // { code, description, url }
    this.crashed = null;
    this.audible = false;
    this.zoom = 1;
    this.permissionRequests = []; // pending prompts
    this.passwordPrompt = null; // { id, origin, username, password, update, navs }
    this.find = { active: false, text: '', matches: 0, ordinal: 0 };
    this.htmlFullscreen = false;
    this.lastGesture = 0; // when the user last clicked / typed in this tab (popup blocking)
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

  /** The "Stay focused" panel for a site a focus session holds back (nothing is loaded). */
  _showFocusBlock(url) {
    this.error = { code: 'focus', description: 'VEXA_FOCUS_DISTRACTION', url };
    this.url = url;
    this.loading = false;
    try {
      this.title = new URL(url).host;
    } catch {
      this.title = url;
    }
    this.win.layout();
    this.changed();
  }

  loadURL(url) {
    this.pending = null;
    if (require('./focus').focus.blocks(this, url)) return this._showFocusBlock(url);
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
    shields.attachTab(wc, { isPrivate: this.isPrivate, session: wc.session, onChange: () => this.changed() });
    wc.on('input-event', (_e, input) => {
      if (GESTURES.has(input.type) && !(input.type.endsWith('KeyDown') && ['Escape', 'Control', 'Shift', 'Alt', 'Meta'].includes(input.key))) this.lastGesture = Date.now();
      // Atmosphere: typing and click sounds (played by the browser UI, never in the page).
      if (input.type === 'rawKeyDown' && !input.isAutoRepeat && !input.control && !input.meta && (input.key.length === 1 || input.key === 'Enter' || input.key === 'Backspace')) this.win.sound('typing');
      else if (input.type === 'mouseDown') this.win.sound('click');
    });

    wc.on('did-start-loading', () => {
      this.loading = true;
      this.changed();
    });
    wc.on('did-stop-loading', () => {
      const was = this.loading;
      this.loading = false;
      if (!this.title) this.title = this._entryTitle(wc.getURL());
      this._syncZoom();
      if (was && !this.error && this === this.win.activeTab && /^https?:/i.test(this.url)) this.win.sound('pageLoad');
      require('./reader').reader.afterLoad(this);
      this.changed();
    });

    // Focus sessions: hold back distracting sites before the navigation starts (links, scripts, redirects).
    const focusGuard = (e, url, isMainFrame = true) => {
      if (isMainFrame && require('./focus').focus.blocks(this, url)) {
        e.preventDefault();
        this._showFocusBlock(url);
      }
    };
    wc.on('will-navigate', (e) => focusGuard(e, e.url, e.isMainFrame));
    wc.on('will-redirect', (e) => focusGuard(e, e.url, e.isMainFrame));

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
      // A "save password?" offer survives the post-login redirect, but not wandering around.
      if (this.passwordPrompt && ++this.passwordPrompt.navs > 2) this.passwordPrompt = null;
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
      // An automatic HTTPS upgrade that didn't work: quietly go back to http://.
      const fallback = shields.httpsFallback(wc.session, validatedURL);
      if (fallback) {
        this.loadURL(fallback);
        return;
      }
      // -20 = ERR_BLOCKED_BY_CLIENT: Vexa Shields stopped a dangerous site.
      const dangerous = code === -20 ? shields.takeMaliciousBlock(wc.id, validatedURL) : null;
      this.error = dangerous ? { code: 'malicious', description: 'VEXA_SHIELDS_DANGEROUS_SITE', url: dangerous } : { code, description, url: validatedURL };
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
    // Vexa Shields: a window the user didn't ask for (no click or key press just before) is blocked.
    if (/^https?:/i.test(this.url) && shields.blocksPopup(this.url, url, this.wc.session, this.lastGesture ? Date.now() - this.lastGesture : -1)) {
      shields.count(this.wc.id, 'popups');
      return { action: 'deny' };
    }
    this.lastGesture = 0; // one popup per click, like Chromium
    // A distracting site opened as a new tab or window during a focus session: show the panel in a new tab.
    if (require('./focus').focus.blocks(this, url)) {
      this.win.openInNewTab(url, { opener: this }); // loadURL shows the panel without loading the site
      return { action: 'deny' };
    }
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
          webPreferences: { ...tabWebPreferences(this.wc.session) }
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
    if (this === this.win.activeTab) this.win.sound('notification');
    this.changed();
  }

  resolvePermission(reqId, decision, remember) {
    const i = this.permissionRequests.findIndex((r) => r.id === reqId);
    if (i < 0) return;
    const [req] = this.permissionRequests.splice(i, 1);
    req.resolve({ decision, remember });
    this.changed();
  }

  // --- password manager ---
  /** A page submitted a login: offer to save it (never in private windows, never if the user opted out). */
  offerPassword(origin, username, password) {
    if (this.isPrivate || !settings.get('offerToSavePasswords') || !passwords.available() || passwords.isNever(origin)) return;
    const kind = passwords.classify(origin, username, password);
    if (kind === 'same') return;
    this.passwordPrompt = { id: `pw-${this.id}-${Date.now()}`, origin, username, password, update: kind === 'update', navs: 0 };
    this.win.sound('notification');
    this.changed();
  }

  resolvePasswordPrompt(decision) {
    const p = this.passwordPrompt;
    if (!p) return;
    this.passwordPrompt = null;
    try {
      if (decision === 'save') passwords.save({ origin: p.origin, username: p.username, password: p.password });
      else if (decision === 'never') passwords.addNever(p.origin);
    } catch (err) {
      dialog.showMessageBox(this.win.win, { type: 'warning', message: 'Could not save the password', detail: err.message }).catch(() => {});
    }
    this.changed();
  }

  _dropPermissionRequests() {
    for (const r of this.permissionRequests) r.resolve({ decision: 'dismiss', remember: false });
    this.permissionRequests = [];
  }

  /** "Continue anyway" on the dangerous-site warning. */
  proceedUnsafe() {
    if (!this.error || this.error.code !== 'malicious') return;
    const url = this.error.url;
    shields.proceed(this.wc.session, url);
    this.loadURL(url);
  }

  _shieldsSnapshot(alive) {
    if (!alive || !/^https?:/i.test(this.url) || (this.error && this.error.code !== 'malicious')) return null;
    const st = shields.stats(this.wc.id);
    const p = shields.forUrl(this.url, this.wc.session);
    return { enabled: p.enabled, count: st.ads + st.trackers + st.cookies + st.fingerprinting + st.https + st.params + st.popups + st.malicious };
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
      pinned: this.pinned,
      shields: this._shieldsSnapshot(alive),
      permission: this.permissionRequests[0]
        ? { id: this.permissionRequests[0].id, permission: this.permissionRequests[0].permission, origin: this.permissionRequests[0].origin, mediaTypes: this.permissionRequests[0].mediaTypes, externalURL: this.permissionRequests[0].externalURL, oneOff: this.permissionRequests[0].oneOff }
        : null,
      passwordPrompt: this.passwordPrompt
        ? { id: this.passwordPrompt.id, origin: this.passwordPrompt.origin, username: this.passwordPrompt.username, update: this.passwordPrompt.update }
        : null,
      find: this.find,
      pending: !!this.pending
    };
  }

  /** For session restore. */
  serialize() {
    if (this.pending) {
      const r = this.pending.restore;
      return r ? { entries: r.entries, index: r.index, title: this.title, favicon: this.favicon, pinned: this.pinned } : { entries: [{ url: this.pending.url || NEWTAB_URL, title: this.title }], index: 0, title: this.title, favicon: this.favicon, pinned: this.pinned };
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
    return { entries, index, title: this.title, favicon: this.favicon, pinned: this.pinned };
  }

  destroy() {
    this._dropPermissionRequests();
    this.passwordPrompt = null;
    try {
      if (!this.wc.isDestroyed()) this.wc.close();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { Tab, ZOOM_STEPS };
