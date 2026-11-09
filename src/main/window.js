'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, WebContentsView, nativeTheme, clipboard } = require('electron');
const { Tab } = require('./tab');
const { settings } = require('./settings');
const { history } = require('./history');
const { bookmarks, ROOTS } = require('./bookmarks');
const { downloads } = require('./downloads');
const { resolveInput, NEWTAB_URL, SEARCH_ENGINES, displayUrl } = require('./url');
const { actionFor } = require('./shortcuts');
const { defaultSession, newPrivateSession } = require('./sessions');

const CHROME_PRELOAD = path.join(__dirname, '..', 'preload', 'chrome.js');
const RENDERER = path.join(__dirname, '..', 'renderer');
const TAB_STRIP_HEIGHT = 40;
const isMac = process.platform === 'darwin';

const THEME = {
  dark: { strip: '#0e0c15', symbol: '#d9d2f2' },
  light: { strip: '#ece9f5', symbol: '#2a2140' },
  private: { strip: '#0a0814', symbol: '#d9d2f2' }
};

let nextWindowId = 1;

class VexaWindow extends EventEmitter {
  /**
   * @param {object} opts
   * @param {boolean} [opts.isPrivate]
   * @param {object}  [opts.restore]  { tabs: [...], activeIndex, bounds, maximized }
   * @param {string[]} [opts.urls]    URLs to open
   */
  constructor({ isPrivate = false, restore = null, urls = [], bounds = null } = {}) {
    super();
    this.id = nextWindowId++;
    this.isPrivate = isPrivate;
    this.session = isPrivate ? newPrivateSession() : defaultSession();
    this.tabs = [];
    this.activeTab = null;
    this.closedTabs = [];
    this.layoutInfo = { chromeHeight: 84, toolbarBottom: 84 };
    this.popup = null; // { kind, ... }
    this.closing = false;
    this._stateQueued = false;
    this._htmlFullscreenTab = null;

    const b = restore?.bounds || bounds || {};
    const colors = this._titleBarColors();
    this.win = new BrowserWindow({
      width: b.width || 1280,
      height: b.height || 820,
      x: b.x,
      y: b.y,
      minWidth: 520,
      minHeight: 360,
      show: false,
      title: isPrivate ? 'Vexa — Private' : 'Vexa',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
      backgroundColor: colors.strip,
      titleBarStyle: 'hidden',
      ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { color: colors.strip, symbolColor: colors.symbol, height: TAB_STRIP_HEIGHT } }),
      webPreferences: {
        preload: CHROME_PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        additionalArguments: [`--vexa-role=chrome`]
      }
    });
    if (restore?.maximized) this.win.maximize();

    this.chrome = this.win.webContents;
    this.chrome.loadFile(path.join(RENDERER, 'chrome', 'index.html'), { query: { private: isPrivate ? '1' : '0', platform: process.platform } });
    this.chrome.on('before-input-event', (event, input) => {
      const action = actionFor(input);
      if (action && this.handleShortcut(action, null)) event.preventDefault();
    });
    this.chrome.on('did-finish-load', () => this.sendState());
    // The browser UI must never navigate away from itself.
    this.chrome.on('will-navigate', (e) => e.preventDefault());
    this.chrome.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Transparent layer above the page for menus and the address-bar dropdown.
    this.overlay = new WebContentsView({
      webPreferences: { preload: CHROME_PRELOAD, sandbox: true, contextIsolation: true, additionalArguments: ['--vexa-role=overlay'] }
    });
    this.overlay.setBackgroundColor('#00000000');
    this.overlay.webContents.loadFile(path.join(RENDERER, 'overlay', 'index.html'), { query: { private: isPrivate ? '1' : '0' } });
    this.overlay.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        this.hidePopup();
        event.preventDefault();
        return;
      }
      const action = actionFor(input);
      if (action && this.handleShortcut(action, null)) event.preventDefault();
    });
    this.overlay.webContents.on('will-navigate', (e) => e.preventDefault());
    this.overlayAttached = false;

    // Status bubble (link hover URL) in the bottom-left corner.
    this.status = new WebContentsView({
      webPreferences: { preload: CHROME_PRELOAD, sandbox: true, contextIsolation: true, additionalArguments: ['--vexa-role=status'] }
    });
    this.status.setBackgroundColor('#00000000');
    this.status.webContents.loadFile(path.join(RENDERER, 'overlay', 'index.html'), { query: { mode: 'status', private: isPrivate ? '1' : '0' } });
    this.statusAttached = false;
    this.statusTimer = null;

    this.win.on('resize', () => this.layout());
    this.win.on('maximize', () => this.layout());
    this.win.on('unmaximize', () => this.layout());
    this.win.on('enter-full-screen', () => {
      this.layout();
      this.sendState();
    });
    this.win.on('leave-full-screen', () => {
      this.layout();
      this.sendState();
    });
    this.win.on('blur', () => this.hidePopup());
    this.win.once('ready-to-show', () => this.win.show());
    this.win.on('close', () => {
      this.emit('closing', this);
      this.closing = true;
    });
    this.win.on('closed', () => {
      for (const t of this.tabs) t.destroy();
      this.tabs = [];
      for (const v of [this.overlay, this.status]) {
        try {
          v.webContents.close();
        } catch {
          /* ignore */
        }
      }
      this.emit('closed', this);
    });

    this._onTheme = () => this._applyTheme();
    nativeTheme.on('updated', this._onTheme);
    this.win.on('closed', () => nativeTheme.off('updated', this._onTheme));

    // Initial tabs
    if (restore?.tabs?.length) {
      const active = Math.min(restore.activeIndex || 0, restore.tabs.length - 1);
      const restored = restore.tabs.map((t, i) => this.addTab({ restore: t, lazy: i !== active, activate: false }));
      this.activateTab(restored[active].id);
    } else if (urls.length) {
      urls.forEach((u, i) => this.addTab({ url: u, activate: i === 0 }));
    } else {
      this.addTab({ url: NEWTAB_URL });
    }
  }

  // ---------------------------------------------------------------- theme
  _titleBarColors() {
    if (this.isPrivate) return THEME.private;
    return nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light;
  }

  _applyTheme() {
    if (this.win.isDestroyed()) return;
    const c = this._titleBarColors();
    this.win.setBackgroundColor(c.strip);
    if (!isMac) {
      try {
        this.win.setTitleBarOverlay({ color: c.strip, symbolColor: c.symbol, height: TAB_STRIP_HEIGHT });
      } catch {
        /* not supported on this platform */
      }
    }
  }

  // ---------------------------------------------------------------- layout
  contentSize() {
    const [width, height] = this.win.getContentSize();
    return { width, height };
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.contentSize();
    const fsTab = this._htmlFullscreenTab;
    const top = fsTab ? 0 : Math.round(this.layoutInfo.chromeHeight);
    const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) };
    for (const t of this.tabs) t.view.setBounds(bounds);

    // Hide the page while the browser UI shows an error/crash panel for it.
    const t = this.activeTab;
    const shouldShow = t && !t.error && !t.crashed;
    if (t && shouldShow && !t.attached) this._attachTab(t);
    else if (t && !shouldShow && t.attached) this._detachTab(t);

    if (this.overlayAttached) this.overlay.setBounds(this._overlayBounds());
    if (this.statusAttached) this._positionStatus();
  }

  _overlayBounds() {
    const { width, height } = this.contentSize();
    const y = Math.round(this.layoutInfo.toolbarBottom);
    return { x: 0, y, width, height: Math.max(0, height - y) };
  }

  _attachTab(t) {
    this.win.contentView.addChildView(t.view);
    t.attached = true;
    // Keep floating layers above the page.
    if (this.statusAttached) this.win.contentView.addChildView(this.status);
    if (this.overlayAttached) this.win.contentView.addChildView(this.overlay);
  }

  _detachTab(t) {
    try {
      this.win.contentView.removeChildView(t.view);
    } catch {
      /* not attached */
    }
    t.attached = false;
  }

  setLayout({ chromeHeight, toolbarBottom }) {
    if (typeof chromeHeight === 'number' && chromeHeight > 0) this.layoutInfo.chromeHeight = chromeHeight;
    if (typeof toolbarBottom === 'number' && toolbarBottom > 0) this.layoutInfo.toolbarBottom = toolbarBottom;
    this.layout();
  }

  setHtmlFullscreen(tab, on) {
    if (on) {
      this._htmlFullscreenTab = tab;
      this._wasFullscreen = this.win.isFullScreen();
      if (!this._wasFullscreen) this.win.setFullScreen(true);
    } else {
      this._htmlFullscreenTab = null;
      if (!this._wasFullscreen) this.win.setFullScreen(false);
    }
    this.layout();
  }

  // ---------------------------------------------------------------- status bubble
  setStatusUrl(tab, url) {
    if (tab !== this.activeTab) return;
    clearTimeout(this.statusTimer);
    if (!url) {
      this.statusTimer = setTimeout(() => {
        if (this.statusAttached) {
          this.win.contentView.removeChildView(this.status);
          this.statusAttached = false;
        }
      }, 120);
      return;
    }
    this.statusText = url;
    this.status.webContents.send('status:show', url);
    if (!this.statusAttached) {
      this.win.contentView.addChildView(this.status);
      this.statusAttached = true;
      if (this.overlayAttached) this.win.contentView.addChildView(this.overlay);
    }
    this._positionStatus();
  }

  _positionStatus() {
    const { width, height } = this.contentSize();
    const w = Math.min(Math.round(width * 0.6), Math.max(120, Math.round((this.statusText || '').length * 6.6) + 28));
    this.status.setBounds({ x: 0, y: height - 28, width: w, height: 28 });
  }

  // ---------------------------------------------------------------- tabs
  get activeIndex() {
    return this.tabs.indexOf(this.activeTab);
  }

  addTab({ url, restore, lazy = false, activate = true, index, webContents, openerId } = {}) {
    const tab = new Tab(this, { url: url || (restore ? undefined : NEWTAB_URL), restore, lazy, webContents });
    tab.openerId = openerId ?? null;
    const at = index == null ? this.tabs.length : Math.max(0, Math.min(index, this.tabs.length));
    this.tabs.splice(at, 0, tab);
    const { width, height } = this.contentSize();
    const top = Math.round(this.layoutInfo.chromeHeight);
    tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    if (activate) this.activateTab(tab.id);
    else this.sendState();
    this.emit('tabs-changed');
    return tab;
  }

  /** Index for a tab opened from `opener` (after its other children, like Chrome). */
  _childInsertIndex(opener) {
    let i = this.tabs.indexOf(opener);
    if (i < 0) return this.tabs.length;
    while (i + 1 < this.tabs.length && this.tabs[i + 1].openerId === opener.id) i++;
    return i + 1;
  }

  adoptTab(webContents, { afterTab, background, url }) {
    const tab = this.addTab({ webContents, activate: !background, index: this._childInsertIndex(afterTab), openerId: afterTab.id });
    tab.url = url;
    return tab;
  }

  openInNewTab(url, { background = false, opener = this.activeTab } = {}) {
    const index = opener ? this._childInsertIndex(opener) : undefined;
    return this.addTab({ url, activate: !background, index, openerId: background ? opener?.id : null });
  }

  getTab(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  activateTab(id) {
    const tab = this.getTab(id);
    if (!tab) return;
    if (this.activeTab && this.activeTab !== tab && this.activeTab.attached) this._detachTab(this.activeTab);
    this.activeTab = tab;
    tab.lastActive = Date.now();
    tab.ensureLoaded();
    this.hidePopup();
    this.setStatusUrl(tab, '');
    this.layout();
    this.sendState();
    // Focus: the address bar for a new tab page, otherwise the page.
    if (tab.isNewTab) this.focusAddress();
    else if (tab.attached) tab.wc.focus();
    this.emit('tabs-changed');
  }

  closeTab(id) {
    const tab = this.getTab(id);
    if (!tab) return;
    const index = this.tabs.indexOf(tab);
    if (!this.isPrivate && !(tab.isNewTab && !tab.wc.navigationHistory?.canGoBack())) {
      this.closedTabs.push({ data: tab.serialize(), index });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }
    if (this.activeTab === tab) {
      this._detachTab(tab);
      this.activeTab = null;
      // Prefer returning to the opener for a tab opened from it, else the right neighbour.
      const opener = tab.openerId != null ? this.getTab(tab.openerId) : null;
      const next = opener || this.tabs[index + 1] || this.tabs[index - 1];
      this.tabs.splice(index, 1);
      tab.destroy();
      if (next) this.activateTab(next.id);
    } else {
      this.tabs.splice(index, 1);
      tab.destroy();
    }
    for (const t of this.tabs) if (t.openerId === tab.id) t.openerId = null;
    if (!this.tabs.length) {
      this.win.close();
      return;
    }
    this.sendState();
    this.emit('tabs-changed');
  }

  reopenClosedTab() {
    const last = this.closedTabs.pop();
    if (!last) return;
    this.addTab({ restore: last.data, index: last.index, activate: true });
  }

  moveTab(id, index) {
    const tab = this.getTab(id);
    if (!tab) return;
    const from = this.tabs.indexOf(tab);
    this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(index, this.tabs.length)), 0, tab);
    this.sendState();
    this.emit('tabs-changed');
  }

  duplicateTab(id) {
    const tab = this.getTab(id);
    if (!tab) return;
    this.addTab({ restore: tab.serialize(), index: this.tabs.indexOf(tab) + 1, activate: true });
  }

  closeOtherTabs(id) {
    for (const t of [...this.tabs]) if (t.id !== id) this.closeTab(t.id);
  }

  closeTabsToRight(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    for (const t of this.tabs.slice(i + 1)) this.closeTab(t.id);
  }

  tabChanged(tab) {
    if (tab === this.activeTab) this.win.setTitle(`${tab.snapshot().title} — Vexa${this.isPrivate ? ' (Private)' : ''}`);
    this.sendState();
    this.emit('tabs-changed');
  }

  // ---------------------------------------------------------------- navigation
  navigate(input, { disposition = 'current' } = {}) {
    let url = input;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /\s/.test(input)) {
      const r = resolveInput(input, settings.get('searchEngine'));
      if (r.type === 'empty' || r.type === 'blocked') return;
      url = r.url;
    }
    if (disposition === 'new-tab' || disposition === 'background') {
      this.openInNewTab(url, { background: disposition === 'background' });
      return;
    }
    const tab = this.activeTab;
    if (!tab) return this.addTab({ url });
    tab.loadURL(url);
    this.layout();
    tab.wc.focus();
  }

  goHome(tab = this.activeTab) {
    if (tab) tab.loadURL(settings.homeUrl());
  }

  // ---------------------------------------------------------------- focus
  focusAddress() {
    if (this.win.isDestroyed()) return;
    this.chrome.focus();
    this.chrome.send('focus-address');
  }

  // ---------------------------------------------------------------- popups
  showPopup(kind, data = {}, anchor = null) {
    this.popup = { kind };
    if (!this.overlayAttached) {
      this.win.contentView.addChildView(this.overlay);
      this.overlayAttached = true;
    }
    const ob = this._overlayBounds();
    this.overlay.setBounds(ob);
    const rel = anchor ? { x: anchor.x, y: anchor.y - ob.y, width: anchor.width, height: anchor.height, bottom: anchor.y + anchor.height - ob.y, right: anchor.x + anchor.width } : null;
    this.overlay.webContents.send('popup:show', { kind, data, anchor: rel, width: ob.width, height: ob.height });
    if (kind !== 'suggestions') this.overlay.webContents.focus();
    this.sendState();
  }

  updatePopup(kind, data) {
    if (this.popup?.kind === kind) this.overlay.webContents.send('popup:update', { kind, data });
  }

  hidePopup() {
    if (!this.popup && !this.overlayAttached) return;
    const kind = this.popup?.kind;
    this.popup = null;
    if (this.overlayAttached) {
      this.win.contentView.removeChildView(this.overlay);
      this.overlayAttached = false;
    }
    this.overlay.webContents.send('popup:hide');
    if (!this.chrome.isDestroyed()) this.chrome.send('popup-closed', kind);
    this.sendState();
  }

  menuData() {
    const t = this.activeTab;
    return { zoom: t ? t.zoom : 1, isPrivate: this.isPrivate, fullscreen: this.win.isFullScreen(), bookmarksBar: settings.get('showBookmarksBar'), canBookmark: !!t && !t.isNewTab && /^(https?|file):/.test(t.url), bookmarked: !!t && bookmarks.isBookmarked(t.url) };
  }

  downloadsData() {
    return downloads.list().slice(0, 8);
  }

  suggestions(text) {
    const engineId = settings.get('searchEngine');
    const q = String(text || '');
    const trimmed = q.trim();
    if (!trimmed) return { items: [], inline: null };
    const resolved = resolveInput(trimmed, engineId);
    const items = [];
    const engineName = SEARCH_ENGINES[engineId].name;
    if (resolved.type === 'url') items.push({ type: 'url', title: displayUrl(resolved.url) || resolved.url, url: resolved.url, primary: true });
    else if (resolved.type === 'search') items.push({ type: 'search', title: trimmed, subtitle: `Search ${engineName}`, url: resolved.url, primary: true });

    const seen = new Set(items.map((i) => i.url));
    let inline = null;
    if (settings.get('suggestions')) {
      const lower = trimmed.toLowerCase();
      for (const b of bookmarks.search(trimmed, 3)) {
        if (seen.has(b.url)) continue;
        seen.add(b.url);
        items.push({ type: 'bookmark', title: b.title, url: b.url });
      }
      const hist = history.suggest(trimmed, 8);
      for (const h of hist) {
        if (seen.has(h.url) || items.length >= 8) continue;
        seen.add(h.url);
        items.push({ type: 'history', title: h.title || h.url, url: h.url, favicon: h.favicon });
      }
      // Inline autocomplete: complete the typed text to a site the user visits.
      if (!/\s/.test(q) && q === q.trimStart()) {
        for (const h of hist) {
          const bare = h.url.replace(/^https?:\/\/(www\.)?/i, '');
          const host = bare.split('/')[0];
          if (host.toLowerCase().startsWith(lower) && lower.length < host.length) {
            inline = { text: host, url: h.url.match(/^https?:\/\/[^/]+/i)[0] + '/' };
            break;
          }
          if (bare.toLowerCase().startsWith(lower) && lower.length < bare.length) {
            inline = { text: bare.replace(/\/$/, ''), url: h.url };
            break;
          }
        }
      }
    }
    return { items: items.slice(0, 8), inline };
  }

  // ---------------------------------------------------------------- permission prompts
  promptPermission(tab, req) {
    return new Promise((resolve) => {
      tab.addPermissionRequest({ id: `${tab.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...req, resolve });
    });
  }

  // ---------------------------------------------------------------- shortcuts / actions
  /** @returns {boolean} whether the shortcut was consumed */
  handleShortcut(action, tab) {
    const t = this.activeTab;
    if ((action === 'find-next' || action === 'find-prev') && !(t && t.find.active)) return false;
    this.runAction(action, { tab: tab || t });
    return true;
  }

  runAction(action, { tab = this.activeTab, payload } = {}) {
    const app = require('./app-controller');
    switch (action) {
      case 'new-tab':
        return this.addTab({ url: NEWTAB_URL });
      case 'new-window':
        return app.createWindow();
      case 'new-private-window':
        return app.createWindow({ isPrivate: true });
      case 'close-tab':
        return tab && this.closeTab(tab.id);
      case 'close-window':
        return this.win.close();
      case 'reopen-tab':
        return this.reopenClosedTab();
      case 'next-tab':
      case 'prev-tab': {
        if (this.tabs.length < 2) return;
        const d = action === 'next-tab' ? 1 : -1;
        const i = (this.activeIndex + d + this.tabs.length) % this.tabs.length;
        return this.activateTab(this.tabs[i].id);
      }
      case 'tab-last':
        return this.activateTab(this.tabs[this.tabs.length - 1].id);
      case 'focus-address':
        return this.focusAddress();
      case 'reload':
        if (!tab) return;
        if (tab.error || tab.crashed || tab.pending) {
          tab.ensureLoaded();
          if (tab.crashed) return tab.loadURL(tab.url);
          return tab.wc.reload();
        }
        return tab.wc.reload();
      case 'hard-reload':
        return tab && tab.wc.reloadIgnoringCache();
      case 'stop':
        return tab && tab.wc.stop();
      case 'back':
        if (tab && tab.wc.navigationHistory.canGoBack()) tab.wc.navigationHistory.goBack();
        return;
      case 'forward':
        if (tab && tab.wc.navigationHistory.canGoForward()) tab.wc.navigationHistory.goForward();
        return;
      case 'home':
        return this.goHome(tab);
      case 'bookmark':
        if (tab && /^(https?|file):/.test(tab.url)) {
          bookmarks.toggle(tab.url, tab.title);
        }
        return;
      case 'history':
        return this.openInternal('vexa://history/');
      case 'downloads':
        return this.openInternal('vexa://downloads/');
      case 'bookmarks':
        return this.openInternal('vexa://bookmarks/');
      case 'settings':
        return this.openInternal('vexa://settings/');
      case 'clear-data':
        return this.openInternal('vexa://settings/#privacy');
      case 'about':
        return this.openInternal('vexa://settings/#about');
      case 'toggle-bookmarks-bar':
        return settings.set('showBookmarksBar', !settings.get('showBookmarksBar'));
      case 'find':
        if (!tab) return;
        tab.find.active = true;
        this.sendState();
        this.chrome.focus();
        return this.chrome.send('find-open');
      case 'find-next':
        return tab && tab.find.text && tab.findInPage(tab.find.text, { forward: true, findNext: true });
      case 'find-prev':
        return tab && tab.find.text && tab.findInPage(tab.find.text, { forward: false, findNext: true });
      case 'zoom-in':
        return tab && tab.zoomStep(1);
      case 'zoom-out':
        return tab && tab.zoomStep(-1);
      case 'zoom-reset':
        return tab && tab.setZoom(1);
      case 'print':
        return tab && !tab.error && tab.wc.print({}, () => {});
      case 'view-source':
        if (tab && /^(https?|file):/.test(tab.url)) this.openInNewTab('view-source:' + tab.url);
        return;
      case 'fullscreen':
        return this.win.setFullScreen(!this.win.isFullScreen());
      case 'devtools':
        if (!tab) return;
        if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools();
        else tab.wc.openDevTools({ mode: 'detach' });
        return;
      case 'quit':
        return app.quit();
      default: {
        const m = /^tab-(\d)$/.exec(action);
        if (m) {
          const t2 = this.tabs[Number(m[1]) - 1];
          if (t2) this.activateTab(t2.id);
        }
      }
    }
  }

  /** Open an internal page, reusing an existing tab showing it, or the current new-tab page. */
  openInternal(url) {
    const base = url.split('#')[0];
    const existing = this.tabs.find((t) => t.url.split('#')[0] === base);
    if (existing) {
      this.activateTab(existing.id);
      if (url !== existing.url) existing.loadURL(url);
      return;
    }
    if (this.activeTab && this.activeTab.isNewTab) this.activeTab.loadURL(url);
    else this.addTab({ url });
  }

  // ---------------------------------------------------------------- commands from the browser UI
  async command(name, args = {}) {
    const tab = args.tabId != null ? this.getTab(args.tabId) : this.activeTab;
    switch (name) {
      case 'navigate':
        this.hidePopup();
        return this.navigate(String(args.input || ''), { disposition: args.disposition });
      case 'action':
        return this.runAction(String(args.action), { tab });
      case 'activate-tab':
        return this.activateTab(args.tabId);
      case 'close-tab':
        return this.closeTab(args.tabId);
      case 'move-tab':
        return this.moveTab(args.tabId, Number(args.index));
      case 'mute-tab':
        if (tab) {
          tab.wc.setAudioMuted(!tab.wc.isAudioMuted());
          tab.changed();
        }
        return;
      case 'tab-context':
        return require('./context-menu').showTabMenu(this, tab);
      case 'layout':
        return this.setLayout(args);
      case 'suggest':
        return this.suggestions(args.text);
      case 'show-suggestions':
        if (!args.items?.length) return this.popup?.kind === 'suggestions' && this.hidePopup();
        if (this.popup?.kind === 'suggestions') return this.updatePopup('suggestions', args);
        return this.showPopup('suggestions', args, args.anchor);
      case 'popup':
        if (this.popup?.kind === args.kind) return this.hidePopup();
        if (args.kind === 'menu') return this.showPopup('menu', this.menuData(), args.anchor);
        if (args.kind === 'downloads') return this.showPopup('downloads', this.downloadsData(), args.anchor);
        return;
      case 'popup-hide':
        return this.hidePopup();
      case 'find':
        return tab && tab.findInPage(String(args.text || ''), { forward: args.forward !== false, findNext: !!args.findNext });
      case 'find-stop':
        if (tab) {
          tab.stopFind();
          if (tab.attached) tab.wc.focus();
        }
        return;
      case 'permission':
        return tab && tab.resolvePermission(args.reqId, args.decision, !!args.remember);
      case 'bookmark-open': {
        const node = bookmarks.get(args.id);
        if (!node || node.type !== 'bookmark') return;
        return this.navigate(node.url, { disposition: args.disposition || 'current' });
      }
      case 'bookmark-folder':
        return require('./context-menu').showBookmarkFolderMenu(this, args.id);
      case 'bookmark-context':
        return require('./context-menu').showBookmarkMenu(this, args.id);
      case 'window':
        if (args.op === 'minimize') this.win.minimize();
        else if (args.op === 'maximize') this.win.isMaximized() ? this.win.unmaximize() : this.win.maximize();
        else if (args.op === 'close') this.win.close();
        return;
      case 'focus-page':
        if (tab && tab.attached) tab.wc.focus();
        return;
      case 'copy-url':
        if (tab) clipboard.writeText(tab.url);
        return;
      case 'site-settings':
        return this.openInternal('vexa://settings/#permissions');
      default:
        throw new Error(`Unknown command ${name}`);
    }
  }

  // Commands from the overlay (menu clicks, suggestion picks, download actions)
  async overlayCommand(name, args = {}) {
    switch (name) {
      case 'hide':
        return this.hidePopup();
      case 'menu': {
        const action = String(args.action);
        if (!['zoom-in', 'zoom-out', 'zoom-reset'].includes(action)) this.hidePopup();
        this.runAction(action);
        if (this.popup?.kind === 'menu') this.updatePopup('menu', this.menuData());
        return;
      }
      case 'pick-suggestion':
        this.hidePopup();
        this.chrome.send('suggestion-picked');
        return this.navigate(String(args.url), { disposition: args.disposition || 'current' });
      case 'download': {
        if (args.action === 'retry') {
          const rec = downloads.list().find((r) => r.id === args.id);
          if (rec) this.session.downloadURL(rec.url);
          return;
        }
        if (args.action === 'all') {
          this.hidePopup();
          return this.openInternal('vexa://downloads/');
        }
        return downloads.action(args.id, args.action);
      }
      default:
        throw new Error(`Unknown overlay command ${name}`);
    }
  }

  // ---------------------------------------------------------------- state → browser UI
  sendState() {
    if (this._stateQueued) return;
    this._stateQueued = true;
    setImmediate(() => {
      this._stateQueued = false;
      if (this.win.isDestroyed() || this.chrome.isDestroyed()) return;
      this.chrome.send('state', this.state());
    });
  }

  state() {
    const dl = downloads.list();
    const active = dl.filter((d) => d.state === 'progressing' || d.state === 'paused');
    const total = active.reduce((s, d) => s + (d.totalBytes || 0), 0);
    const received = active.reduce((s, d) => s + (d.receivedBytes || 0), 0);
    return {
      windowId: this.id,
      isPrivate: this.isPrivate,
      platform: process.platform,
      fullscreen: this.win.isFullScreen(),
      tabs: this.tabs.map((t) => t.snapshot()),
      activeId: this.activeTab ? this.activeTab.id : null,
      canReopen: this.closedTabs.length > 0,
      popup: this.popup?.kind || null,
      settings: {
        showHomeButton: settings.get('showHomeButton'),
        showBookmarksBar: settings.get('showBookmarksBar'),
        searchEngineName: SEARCH_ENGINES[settings.get('searchEngine')].name
      },
      bookmarksBar: bookmarks.children(ROOTS.bar).map((n) => ({ id: n.id, type: n.type, title: n.title, url: n.url })),
      downloads: {
        active: active.length,
        progress: active.length && total > 0 ? received / total : active.length ? -1 : null,
        hasItems: dl.length > 0
      }
    };
  }

  /** For session restore. */
  serialize() {
    const bounds = this.win.isMaximized() || this.win.isFullScreen() ? this.win.getNormalBounds() : this.win.getBounds();
    return {
      bounds,
      maximized: this.win.isMaximized(),
      activeIndex: Math.max(0, this.activeIndex),
      tabs: this.tabs.map((t) => t.serialize())
    };
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }
}

module.exports = { VexaWindow };
