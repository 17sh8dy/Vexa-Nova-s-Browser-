'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, WebContentsView, nativeTheme, clipboard, screen } = require('electron');
const { Tab } = require('./tab');
const { settings } = require('./settings');
const { history } = require('./history');
const { bookmarks, ROOTS } = require('./bookmarks');
const { downloads } = require('./downloads');
const { resolveInput, NEWTAB_URL, SEARCH_ENGINES, displayUrl, hostOf, siteOf, parseKeyword, fillTemplate } = require('./url');
const { shields } = require('./shields');
const { actionFor } = require('./shortcuts');
const { defaultSession, newPrivateSession } = require('./sessions');
const { spaces } = require('./spaces');
const { atmosphere } = require('./atmosphere');
const palettes = require('../renderer/shared/palettes');

const CHROME_PRELOAD = path.join(__dirname, '..', 'preload', 'chrome.js');
const RENDERER = path.join(__dirname, '..', 'renderer');
const TAB_STRIP_HEIGHT = 40;
const isMac = process.platform === 'darwin';
const PRIVATE_SPACE = 'private';

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
   * @param {import('./tab').Tab} [opts.transferTab] a live tab (released from another window) to start with
   */
  constructor({ isPrivate = false, restore = null, urls = [], bounds = null, transferTab = null } = {}) {
    super();
    this.id = nextWindowId++;
    this.isPrivate = isPrivate;
    this.session = isPrivate ? newPrivateSession() : defaultSession();
    // Spaces: every Space has its own ordered tab list in this window. `this.tabs` is the
    // current Space's list; allTabs() is every tab in the window.
    this.spaceTabs = new Map();
    this.spaceActive = new Map(); // spaceId -> id of the tab last shown in it
    this.spaceId = isPrivate ? PRIVATE_SPACE : restore?.spaceId && spaces.get(restore.spaceId) ? restore.spaceId : spaces.first().id;
    this.activeTab = null;
    this.closedTabs = [];
    this.focusSession = null; // see focus.js
    this.research = { open: false, collectionId: null };
    this.layoutInfo = { chromeHeight: 84, toolbarBottom: 84, insetLeft: 0, insetRight: 0 };
    this._ready = false;
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
        autoplayPolicy: 'no-user-gesture-required', // Atmosphere sounds play without a click first
        backgroundThrottling: false,
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
    this.overlay.webContents.on('did-finish-load', () => this._sendLook());
    this.overlayAttached = false;

    // Status bubble (link hover URL) in the bottom-left corner.
    this.status = new WebContentsView({
      webPreferences: { preload: CHROME_PRELOAD, sandbox: true, contextIsolation: true, additionalArguments: ['--vexa-role=status'] }
    });
    this.status.setBackgroundColor('#00000000');
    this.status.webContents.loadFile(path.join(RENDERER, 'overlay', 'index.html'), { query: { mode: 'status', private: isPrivate ? '1' : '0' } });
    this.status.webContents.on('did-finish-load', () => this._sendLook());
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
    this.win.on('close', (e) => {
      // Atmosphere: let the shutdown sound play when the last window closes.
      const app = require('./app-controller');
      if (!this._shutdownPlayed && !this.closing && app.isLastWindow(this) && this.soundOn('shutdown')) {
        e.preventDefault();
        this._shutdownPlayed = true;
        this.sound('shutdown');
        setTimeout(() => !this.win.isDestroyed() && this.win.close(), 650);
        return;
      }
      this.emit('closing', this);
      this.closing = true;
    });
    this.win.on('closed', () => {
      require('./focus').focus.stop(this, { silent: true });
      for (const t of this.allTabs()) t.destroy();
      this.spaceTabs.clear();
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
    if (transferTab) {
      this.spaceId = transferTab.spaceId && spaces.get(transferTab.spaceId) ? transferTab.spaceId : this.spaceId;
      this.receiveTab(transferTab, 0);
    } else if (restore?.spaces && !isPrivate) {
      this._restoreSpaces(restore);
    } else if (restore?.tabs?.length) {
      const active = Math.min(restore.activeIndex || 0, restore.tabs.length - 1);
      const restored = restore.tabs.map((t, i) => this.addTab({ restore: t, lazy: i !== active, activate: false }));
      this.activateTab(restored[active].id);
    } else if (urls.length) {
      urls.forEach((u, i) => this.addTab({ url: u, activate: i === 0 }));
    } else {
      this._openStartup(this.spaceId);
    }
    this._ready = true;
  }

  /** Session restore (0.90 format): tabs per Space, each Space's last-shown tab. */
  _restoreSpaces(restore) {
    const fallback = spaces.first();
    for (const [sid, entry] of Object.entries(restore.spaces)) {
      if (!entry || !Array.isArray(entry.tabs) || !entry.tabs.length) continue;
      let target = spaces.get(sid) ? sid : null;
      // A Space deleted since: its tabs join the first Space, unless that would put them in another session.
      if (!target && !fallback.isolated) target = fallback.id;
      if (!target) continue;
      const added = entry.tabs.map((t) => this.addTab({ restore: t, lazy: true, activate: false, spaceId: target }));
      const ai = Math.min(Math.max(0, entry.activeIndex || 0), added.length - 1);
      this.spaceActive.set(target, added[ai].id);
    }
    const list = this.tabs;
    if (!list.length) return this._openStartup(this.spaceId);
    const remembered = this.getTab(this.spaceActive.get(this.spaceId));
    this.activateTab((remembered || list[0]).id);
  }

  // ---------------------------------------------------------------- spaces
  /** The tab list of one Space in this window (created on first use). */
  _list(spaceId) {
    let list = this.spaceTabs.get(spaceId);
    if (!list) {
      list = [];
      this.spaceTabs.set(spaceId, list);
    }
    return list;
  }

  /** The current Space's tabs, in strip order. */
  get tabs() {
    return this._list(this.spaceId);
  }

  /** Every tab in this window, in every Space. */
  allTabs() {
    const out = [];
    for (const list of this.spaceTabs.values()) out.push(...list);
    return out;
  }

  get space() {
    return this.isPrivate ? null : spaces.get(this.spaceId);
  }

  /** Open a Space's startup pages (or a New Tab) in this window. */
  _openStartup(spaceId) {
    const s = this.isPrivate ? null : spaces.get(spaceId);
    const urls = s && s.startup.mode === 'urls' && s.startup.urls.length ? s.startup.urls : [NEWTAB_URL];
    urls.forEach((u, i) => this.addTab({ url: u, activate: i === 0, spaceId }));
  }

  /** Show another Space in this window. */
  switchSpace(id, { tabId = null } = {}) {
    if (this.isPrivate || !spaces.get(id)) return false;
    if (id === this.spaceId && !tabId) return true;
    const prev = this.activeTab;
    if (prev) {
      if (prev.attached) this._detachTab(prev);
      this.spaceActive.set(this.spaceId, prev.id);
    }
    const changed = id !== this.spaceId;
    this.spaceId = id;
    this.activeTab = null;
    this.hidePopup();
    if (!this.tabs.length) {
      this._openStartup(id);
    } else {
      const want = this.getTab(tabId) || this.getTab(this.spaceActive.get(id)) || this.tabs[this.tabs.length - 1];
      this._quietSwitch = true;
      this.activateTab(want.id);
      this._quietSwitch = false;
    }
    if (changed) {
      this._applyTheme();
      this.sound('tabSwitch');
      if (!this.chrome.isDestroyed()) this.chrome.send('space-switched', id);
    }
    this.emit('tabs-changed');
    return true;
  }

  /** A Space was deleted: its tabs move to `fallback` (same session) or close. */
  spaceRemoved(removed, fallback) {
    const list = this.spaceTabs.get(removed.id) || [];
    this.spaceTabs.delete(removed.id);
    this.spaceActive.delete(removed.id);
    const canMove = !removed.isolated && !fallback.isolated;
    for (const t of list) {
      if (canMove) {
        t.spaceId = fallback.id;
        this._list(fallback.id).push(t);
      } else {
        if (t === this.activeTab) {
          this._detachTab(t);
          this.activeTab = null;
        }
        t.destroy();
      }
    }
    if (this.spaceId === removed.id) {
      this.spaceId = fallback.id;
      this.activeTab = null;
      if (!this.tabs.length) this._openStartup(fallback.id);
      else this.activateTab((this.getTab(this.spaceActive.get(fallback.id)) || this.tabs[0]).id);
    }
    this._applyTheme();
    this.sendState();
    this.emit('tabs-changed');
  }

  // ---------------------------------------------------------------- Atmosphere sounds
  soundOn(category) {
    const s = settings.get('atmosphere').sounds;
    if (!s.enabled || !s.categories[category]?.on) return false;
    if (this.focusSession && settings.get('focus').quietSounds) return false;
    return true;
  }

  /** Ask this window's browser UI to play an interface sound. */
  sound(category) {
    if (!this.soundOn(category) || this.chrome.isDestroyed()) return;
    this.chrome.send('atmo:play', category);
  }

  /** The look (palette, accent, motion, effect, wallpaper) for this window's current Space. */
  look() {
    return atmosphere.look(this.space, { isPrivate: this.isPrivate });
  }

  // ---------------------------------------------------------------- theme
  _titleBarColors() {
    if (this.isPrivate) return THEME.private;
    const sysDark = nativeTheme.shouldUseDarkColors;
    const { vars, dark } = palettes.resolve(this.look(), sysDark);
    const base = dark ? THEME.dark : THEME.light;
    return { strip: vars['--strip'] || base.strip, symbol: vars['--text-dim'] || base.symbol };
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

  /** Where tab pages go: under the browser UI, beside the sidebar / research panel. */
  _tabBounds() {
    const { width, height } = this.contentSize();
    if (this._htmlFullscreenTab) return { x: 0, y: 0, width, height };
    const top = Math.round(this.layoutInfo.chromeHeight);
    const left = Math.round(this.layoutInfo.insetLeft || 0);
    const right = Math.round(this.layoutInfo.insetRight || 0);
    return { x: left, y: top, width: Math.max(0, width - left - right), height: Math.max(0, height - top) };
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const bounds = this._tabBounds();
    for (const t of this.allTabs()) t.view.setBounds(bounds);

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

  setLayout({ chromeHeight, toolbarBottom, insetLeft, insetRight }) {
    if (typeof chromeHeight === 'number' && chromeHeight > 0) this.layoutInfo.chromeHeight = chromeHeight;
    if (typeof toolbarBottom === 'number' && toolbarBottom > 0) this.layoutInfo.toolbarBottom = toolbarBottom;
    if (typeof insetLeft === 'number' && insetLeft >= 0 && insetLeft < 600) this.layoutInfo.insetLeft = insetLeft;
    if (typeof insetRight === 'number' && insetRight >= 0 && insetRight < 900) this.layoutInfo.insetRight = insetRight;
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
    if (tab !== this.activeTab || this._toast) return; // a toast is using the layer

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
    if (this._toast) {
      const b = this._tabBounds();
      const w = Math.min(Math.max(220, b.width - 40), Math.round(this._toast.length * 7.4) + 56);
      this.status.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: height - 64, width: w, height: 48 });
      return;
    }
    const w = Math.min(Math.round(width * 0.6), Math.max(120, Math.round((this.statusText || '').length * 6.6) + 28));
    this.status.setBounds({ x: 0, y: height - 28, width: w, height: 28 });
  }

  // ---------------------------------------------------------------- tabs
  get pinnedCount() {
    return this.tabs.filter((t) => t.pinned).length;
  }

  /** The list (Space) a tab belongs to in this window. */
  listOf(tab) {
    return this._list(tab.spaceId);
  }

  /** Pin or unpin a tab. Pinning moves it to the end of the pinned group; unpinning to just after it. */
  setPinned(id, pinned) {
    const tab = this.getTab(id);
    if (!tab || tab.pinned === !!pinned) return;
    const list = this.listOf(tab);
    list.splice(list.indexOf(tab), 1);
    tab.pinned = !!pinned;
    list.splice(list.filter((t) => t.pinned).length, 0, tab);
    tab.changed();
    this.emit('tabs-changed');
  }

  get activeIndex() {
    return this.tabs.indexOf(this.activeTab);
  }

  addTab({ url, restore, lazy = false, activate = true, index, webContents, openerId, spaceId } = {}) {
    const sid = this.isPrivate ? PRIVATE_SPACE : spaceId && spaces.get(spaceId) ? spaceId : this.spaceId;
    const ses = this.isPrivate ? this.session : spaces.sessionFor(sid);
    const tab = new Tab(this, { url: url || (restore ? undefined : NEWTAB_URL), restore, lazy, webContents, session: ses });
    tab.spaceId = sid;
    tab.openerId = openerId ?? null;
    const list = this._list(sid);
    const pinned = list.filter((t) => t.pinned).length;
    let at = index == null ? list.length : Math.max(0, Math.min(index, list.length));
    // Pinned tabs stay together on the left: ordinary tabs never go in front of them.
    if (tab.pinned) at = Math.min(at, pinned);
    else at = Math.max(at, pinned);
    list.splice(at, 0, tab);
    tab.view.setBounds(this._tabBounds());
    if (this._ready && !restore) this.sound('tabOpen');
    if (activate) {
      this._quietSwitch = true;
      this.activateTab(tab.id);
      this._quietSwitch = false;
    } else this.sendState();
    this.emit('tabs-changed');
    return tab;
  }

  /** Index for a tab opened from `opener` (after its other children, like Chrome). */
  _childInsertIndex(opener) {
    const list = this.listOf(opener);
    let i = list.indexOf(opener);
    if (i < 0) return list.length;
    while (i + 1 < list.length && list[i + 1].openerId === opener.id) i++;
    return i + 1;
  }

  adoptTab(webContents, { afterTab, background, url }) {
    const tab = this.addTab({ webContents, activate: !background, index: this._childInsertIndex(afterTab), openerId: afterTab.id, spaceId: afterTab.spaceId });
    tab.url = url;
    return tab;
  }

  openInNewTab(url, { background = false, opener = this.activeTab } = {}) {
    const index = opener ? this._childInsertIndex(opener) : undefined;
    return this.addTab({ url, activate: !background, index, openerId: background ? opener?.id : null, spaceId: opener ? opener.spaceId : undefined });
  }

  getTab(id) {
    if (id == null) return null;
    for (const list of this.spaceTabs.values()) {
      const t = list.find((x) => x.id === id);
      if (t) return t;
    }
    return null;
  }

  activateTab(id) {
    const tab = this.getTab(id);
    if (!tab) return;
    // A tab in another Space: show that Space (with this tab in front).
    if (tab.spaceId !== this.spaceId) return this.switchSpace(tab.spaceId, { tabId: id });
    const prev = this.activeTab;
    if (prev && prev !== tab && prev.attached) this._detachTab(prev);
    this.activeTab = tab;
    this.spaceActive.set(this.spaceId, tab.id);
    if (this._ready && prev && prev !== tab && !this._quietSwitch) this.sound('tabSwitch');
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
    const list = this.listOf(tab);
    const index = list.indexOf(tab);
    if (!this.isPrivate && !(tab.isNewTab && !tab.wc.navigationHistory?.canGoBack())) {
      this.closedTabs.push({ data: tab.serialize(), index, spaceId: tab.spaceId });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }
    if (this.activeTab === tab) {
      this._detachTab(tab);
      this.activeTab = null;
      // Prefer returning to the opener for a tab opened from it, else the right neighbour.
      const opener = tab.openerId != null ? this.getTab(tab.openerId) : null;
      const next = (opener && opener.spaceId === tab.spaceId ? opener : null) || list[index + 1] || list[index - 1];
      list.splice(index, 1);
      tab.destroy();
      if (next) {
        this._quietSwitch = true;
        this.activateTab(next.id);
        this._quietSwitch = false;
      }
    } else {
      list.splice(index, 1);
      tab.destroy();
    }
    for (const t of this.allTabs()) if (t.openerId === tab.id) t.openerId = null;
    if (!this.allTabs().length) {
      this.win.close();
      return;
    }
    // The current Space is empty but others still have tabs: keep the window, start fresh here.
    if (!this.tabs.length) this._openStartup(this.spaceId);
    this.sound('tabClose');
    this.sendState();
    this.emit('tabs-changed');
  }

  reopenClosedTab() {
    const last = this.closedTabs.pop();
    if (!last) return;
    this.addTab({ restore: last.data, index: last.index, activate: true, spaceId: last.spaceId });
  }

  moveTab(id, index) {
    const tab = this.getTab(id);
    if (!tab) return;
    const list = this.listOf(tab);
    const from = list.indexOf(tab);
    list.splice(from, 1);
    // A pinned tab moves within the pinned group, an ordinary one only after it.
    const pinned = list.filter((t) => t.pinned).length;
    const lo = tab.pinned ? 0 : pinned;
    const hi = tab.pinned ? pinned : list.length;
    list.splice(Math.max(lo, Math.min(index, hi)), 0, tab);
    this.sendState();
    this.emit('tabs-changed');
  }

  /** Move a tab to another Space in this window (only between Spaces that share a session). */
  moveTabToSpace(id, spaceId) {
    const tab = this.getTab(id);
    const to = spaces.get(spaceId);
    if (!tab || !to || this.isPrivate || tab.spaceId === spaceId) return false;
    const from = spaces.get(tab.spaceId);
    if ((from && from.isolated) || to.isolated) throw new Error('Tabs can’t move into or out of an isolated Space (it has its own cookies and storage)');
    const list = this.listOf(tab);
    const wasActive = this.activeTab === tab;
    if (wasActive) {
      this._detachTab(tab);
      this.activeTab = null;
    }
    const i = list.indexOf(tab);
    list.splice(i, 1);
    tab.pinned = false;
    tab.spaceId = spaceId;
    this._list(spaceId).push(tab);
    if (wasActive) {
      if (list.length) this.activateTab((list[i] || list[i - 1]).id);
      else this._openStartup(this.spaceId);
    }
    this.sendState();
    this.emit('tabs-changed');
    return true;
  }

  // ---------------------------------------------------------------- moving tabs between windows
  /** Take a tab out of this window *without* destroying it, so another window can adopt it. */
  releaseTab(id) {
    const tab = this.getTab(id);
    if (!tab) return null;
    const list = this.listOf(tab);
    const index = list.indexOf(tab);
    if (tab.attached) this._detachTab(tab);
    if (this.activeTab === tab) {
      this.activeTab = null;
      const opener = tab.openerId != null ? this.getTab(tab.openerId) : null;
      const next = (opener && opener.spaceId === tab.spaceId ? opener : null) || list[index + 1] || list[index - 1];
      list.splice(index, 1);
      if (next) this.activateTab(next.id);
    } else {
      list.splice(index, 1);
    }
    for (const t of this.allTabs()) if (t.openerId === tab.id) t.openerId = null;
    tab.openerId = null;
    this.setStatusUrl(tab, '');
    // Other Spaces still have tabs but this one is now empty: give it a New Tab.
    if (this.allTabs().length && !this.tabs.length) this._openStartup(this.spaceId);
    this.sendState();
    this.emit('tabs-changed');
    return tab;
  }

  /** Adopt a live tab released by another window of the same kind (normal ↔ normal). It keeps its Space. */
  receiveTab(tab, index) {
    tab.win = this;
    tab.attached = false;
    tab.pinned = false; // a tab moved to another window arrives unpinned
    if (this.isPrivate || !spaces.get(tab.spaceId)) tab.spaceId = this.spaceId;
    const list = this.listOf(tab);
    const pinned = list.filter((t) => t.pinned).length;
    const at = Math.max(pinned, Math.min(index ?? list.length, list.length));
    list.splice(at, 0, tab);
    tab.view.setBounds(this._tabBounds());
    this.activateTab(tab.id);
    this.emit('tabs-changed');
    return tab;
  }

  /** Is a screen point (DIPs) over this window's tab strip? */
  stripContains(pt) {
    if (this.win.isDestroyed() || this.win.isMinimized() || !this.win.isVisible()) return false;
    const b = this.win.getContentBounds();
    return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + TAB_STRIP_HEIGHT;
  }

  /**
   * The user let go of a dragged tab. Returns 'moved' if it went to another window
   * (or a new one), or 'reorder' if the strip should just reorder it in place.
   */
  async dropTab(id, { out = false } = {}) {
    const tab = this.getTab(id);
    if (!tab || this.isPrivate) return 'reorder'; // private windows have their own session: tabs can't leave
    const app = require('./app-controller');
    const pt = screen.getCursorScreenPoint();

    const target = [...app.windows].find((w) => w !== this && !w.isPrivate && !w.closing && w.stripContains(pt));
    if (target) {
      const tb = target.win.getContentBounds();
      let index = target.tabs.length;
      try {
        const i = await target.chrome.executeJavaScript(`window.__vexaTabIndexAt ? window.__vexaTabIndexAt(${Math.round(pt.x - tb.x)}) : -1`);
        if (Number.isInteger(i) && i >= 0) index = i;
      } catch {
        /* append */
      }
      if (!this.getTab(id)) return 'moved';
      const moved = this.releaseTab(id);
      target.receiveTab(moved, index);
      target.focus();
      if (!this.allTabs().length) this.win.close();
      return 'moved';
    }

    // Dragged clear of the strip: tear it off into a window of its own.
    if (out && this.allTabs().length > 1) {
      const b = this.win.getBounds();
      const moved = this.releaseTab(id);
      app.createWindow({ transferTab: moved, bounds: { x: Math.round(pt.x - 140), y: Math.round(pt.y - 16), width: b.width, height: b.height } });
      return 'moved';
    }
    return 'reorder';
  }

  /** Menu/keyboard equivalent of dragging a tab out of the strip. */
  moveTabToNewWindow(id) {
    if (this.isPrivate || this.allTabs().length < 2 || !this.getTab(id)) return false;
    const app = require('./app-controller');
    const b = this.win.getBounds();
    const moved = this.releaseTab(id);
    app.createWindow({ transferTab: moved, bounds: { x: b.x + 36, y: b.y + 36, width: b.width, height: b.height } });
    return true;
  }

  moveTabToWindow(id, target) {
    if (!target || target === this || target.isPrivate || this.isPrivate || target.closing || !this.getTab(id)) return false;
    const moved = this.releaseTab(id);
    target.receiveTab(moved);
    target.focus();
    if (!this.allTabs().length) this.win.close();
    return true;
  }

  duplicateTab(id) {
    const tab = this.getTab(id);
    if (!tab) return;
    this.addTab({ restore: tab.serialize(), index: this.listOf(tab).indexOf(tab) + 1, activate: true, spaceId: tab.spaceId });
  }

  closeOtherTabs(id) {
    for (const t of [...this.tabs]) if (t.id !== id && !t.pinned) this.closeTab(t.id); // pinned tabs are kept, as in Chrome
  }

  closeTabsToRight(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    for (const t of this.tabs.slice(i + 1)) if (!t.pinned) this.closeTab(t.id);
  }

  tabChanged(tab) {
    if (tab === this.activeTab) {
      this.win.setTitle(`${tab.snapshot().title} — Vexa${this.isPrivate ? ' (Private)' : ''}`);
      if (this.popup?.kind === 'shields') this.updatePopup('shields', this.shieldsData());
    }
    this.sendState();
    this.emit('tabs-changed');
  }

  // ---------------------------------------------------------------- navigation
  navigate(input, { disposition = 'current' } = {}) {
    let url = input;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /\s/.test(input)) {
      const r = resolveInput(input, settings.get('searchEngine'), { shortcuts: settings.get('searchShortcuts') });
      if (r.type === 'empty' || r.type === 'blocked') return;
      // "@tabs mail" + Enter: go to the best match in that scope.
      if (r.type === 'scope') {
        const best = this._scopeItems(r.scope, r.query)[0];
        if (best) this.pickSuggestion(best, disposition);
        return;
      }
      if (r.type === 'search' && !this.isPrivate) require('./search-history').searchHistory.add(r.query, r.engine);
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
    const key = { 'ctrl+space': 'Ctrl+Space', 'ctrl+shift+space': 'Ctrl+Shift+Space', 'ctrl+shift+k': 'Ctrl+Shift+K', off: '' }[settings.get('commandCenterKey')];
    return { zoom: t ? t.zoom : 1, isPrivate: this.isPrivate, fullscreen: this.win.isFullScreen(), bookmarksBar: settings.get('showBookmarksBar'), canBookmark: !!t && !t.isNewTab && /^(https?|file):/.test(t.url), bookmarked: !!t && bookmarks.isBookmarked(t.url), commandKey: key, focusActive: !!this.focusSession };
  }

  /** What the Vexa Shields panel shows for the active tab. */
  shieldsData() {
    const t = this.activeTab;
    if (!t || !/^https?:/i.test(t.url) || t.wc.isDestroyed()) return { applicable: false };
    const ses = t.wc.session;
    const host = hostOf(t.url);
    const site = siteOf(host);
    const overrides = shields.siteOverrides(site, ses);
    return {
      applicable: true,
      host,
      site,
      isPrivate: this.isPrivate,
      secure: /^https:/i.test(t.url),
      protections: shields.forSite(site, ses),
      defaults: settings.get('shields'),
      custom: Object.keys(overrides).length > 0,
      stats: shields.stats(t.wc.id),
      dangerous: !!(t.error && t.error.code === 'malicious')
    };
  }

  /** A Shields change for the active tab's site, then reload so it takes effect. */
  shieldsCommand(args) {
    const t = this.activeTab;
    const data = this.shieldsData();
    if (!data.applicable) return;
    const ses = t.wc.session;
    if (args.op === 'site') shields.setSite(data.site, { enabled: !!args.enabled }, ses);
    else if (args.op === 'protection' && typeof args.key === 'string') shields.setSite(data.site, { enabled: true, [args.key]: !!args.value }, ses);
    else if (args.op === 'reset') shields.resetSite(data.site, ses);
    else if (args.op === 'settings') {
      this.hidePopup();
      return this.openInternal('vexa://settings/#shields');
    } else return;
    if (!t.error) t.wc.reload();
    this.updatePopup('shields', this.shieldsData());
    this.sendState();
  }

  downloadsData() {
    return downloads.list().slice(0, 8);
  }

  /** Open tabs (all normal windows, or just this private one) whose title or URL matches. */
  _tabMatches(text, limit = 3, { exceptActive = true } = {}) {
    const t = String(text || '').trim().toLowerCase();
    const app = require('./app-controller');
    const wins = this.isPrivate ? [this] : [...app.windows].filter((w) => !w.isPrivate && !w.closing);
    const out = [];
    for (const w of wins) {
      for (const tab of w.allTabs()) {
        if (exceptActive && tab === this.activeTab) continue;
        const title = (tab.title || '').toLowerCase();
        const url = (tab.url || '').toLowerCase();
        if (t && !title.includes(t) && !url.replace(/^https?:\/\/(www\.)?/, '').includes(t)) continue;
        const sp = w.isPrivate ? null : spaces.get(tab.spaceId);
        out.push({ type: 'tab', title: tab.snapshot().title, url: tab.url, favicon: tab.favicon, tab: { windowId: w.id, tabId: tab.id }, subtitle: sp && spaces.list().length > 1 ? sp.name : '' });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Suggestions for one "@scope" filter. */
  _scopeItems(scope, text, limit = 8) {
    const q = String(text || '').trim();
    if (scope === 'tabs') return this._tabMatches(q, limit, { exceptActive: false });
    if (scope === 'bookmarks') return (q ? bookmarks.search(q, limit) : bookmarks.allBookmarks().slice(0, limit)).map((b) => ({ type: 'bookmark', title: b.title, url: b.url }));
    if (scope === 'history') {
      if (this.isPrivate) return [];
      return (q ? history.suggest(q, limit) : history.query({ limit })).map((h) => ({ type: 'history', title: h.title || h.url, url: h.url, favicon: h.favicon }));
    }
    if (scope === 'collections') {
      const { collections } = require('./collections');
      return collections.search(q, limit).map((r) => (r.item ? { type: 'collection', title: r.item.title || r.item.url || 'Note', url: r.item.url || `vexa://collections/#c=${r.collection.id}&i=${r.item.id}`, subtitle: r.collection.name } : { type: 'collection', title: r.collection.name, url: `vexa://collections/#c=${r.collection.id}`, subtitle: `${r.collection.count} items` }));
    }
    if (scope === 'spaces') {
      if (this.isPrivate) return [];
      const l = q.toLowerCase();
      return spaces.list().filter((s) => !l || s.name.toLowerCase().includes(l)).slice(0, limit).map((s) => ({ type: 'space', title: s.name, url: '', space: s.id, subtitle: s.id === this.spaceId ? 'Current Space' : 'Switch to this Space' }));
    }
    return [];
  }

  /** The user chose a suggestion (Enter on it, or a click in the list). */
  pickSuggestion(item, disposition = 'current') {
    if (!item) return;
    if (item.tab) {
      const app = require('./app-controller');
      const w = [...app.windows].find((x) => x.id === item.tab.windowId);
      if (w && w.getTab(item.tab.tabId) && (w === this || (!w.isPrivate && !this.isPrivate))) {
        w.activateTab(item.tab.tabId);
        if (w !== this) w.focus();
        return;
      }
    }
    if (item.space) return this.switchSpace(item.space);
    if (item.url) {
      if (item.type === 'search' && item.query && !this.isPrivate) require('./search-history').searchHistory.add(item.query, item.engine || settings.get('searchEngine'));
      return this.navigate(item.url, { disposition });
    }
  }

  suggestions(text) {
    const engineId = settings.get('searchEngine');
    const q = String(text || '');
    const trimmed = q.trim();
    if (!trimmed) return { items: [], inline: null };
    const shortcuts = settings.get('searchShortcuts');
    const engineName = SEARCH_ENGINES[engineId].name;
    const vexaSearch = require('./vexa-search');
    const { searchHistory } = require('./search-history');

    // "@key …": a keyword engine or a scope filter.
    const kw = parseKeyword(trimmed, shortcuts);
    if (kw && kw.kind === 'scope') {
      const items = this._scopeItems(kw.key, kw.rest).map((it, i) => ({ ...it, pick: i === 0 }));
      if (!items.length) items.push({ type: 'info', title: kw.rest ? `No ${kw.name.toLowerCase()} match “${kw.rest}”` : `Type to search ${kw.name.toLowerCase()}`, url: '' });
      return { items, inline: null, scope: { key: kw.key, name: kw.name } };
    }
    if (kw && kw.kind === 'engine') {
      const items = [{ type: 'search', title: kw.rest || '…', subtitle: `Search ${kw.shortcut.name}`, url: kw.rest ? fillTemplate(kw.shortcut.url, kw.rest) : '', primary: true, query: kw.rest, engine: kw.key }];
      if (kw.rest && /^vexa:\/\/search\//i.test(kw.shortcut.url) && settings.get('vexaSuggestions')) {
        for (const s of vexaSearch.suggest(kw.rest)) if (s !== kw.rest.toLowerCase()) items.push({ type: 'search', title: s, subtitle: kw.shortcut.name, url: fillTemplate(kw.shortcut.url, s), query: s, engine: kw.key });
      }
      return { items: items.slice(0, 8), inline: null, scope: { key: kw.key, name: kw.shortcut.name } };
    }

    const resolved = resolveInput(trimmed, engineId);
    const items = [];
    if (resolved.type === 'url') items.push({ type: 'url', title: displayUrl(resolved.url) || resolved.url, url: resolved.url, primary: true });
    else if (resolved.type === 'search') items.push({ type: 'search', title: trimmed, subtitle: `Search ${engineName}`, url: resolved.url, primary: true, query: trimmed });

    const seen = new Set(items.map((i) => i.url));
    let inline = null;
    if (settings.get('suggestions')) {
      const lower = trimmed.toLowerCase();
      if (settings.get('tabSuggestions') && trimmed.length > 1) {
        for (const t of this._tabMatches(trimmed, 2)) {
          if (seen.has(t.url)) continue;
          seen.add(t.url);
          items.push({ ...t, subtitle: t.subtitle ? `Switch to tab · ${t.subtitle}` : 'Switch to tab' });
        }
      }
      for (const b of bookmarks.search(trimmed, 3)) {
        if (seen.has(b.url)) continue;
        seen.add(b.url);
        items.push({ type: 'bookmark', title: b.title, url: b.url });
      }
      const hist = this.isPrivate ? [] : history.suggest(trimmed, 8);
      for (const h of hist) {
        if (seen.has(h.url) || items.length >= 7) continue;
        seen.add(h.url);
        items.push({ type: 'history', title: h.title || h.url, url: h.url, favicon: h.favicon });
      }
      if (trimmed.length > 1) {
        try {
          const { collections } = require('./collections');
          for (const r of collections.search(trimmed, 2)) {
            if (!r.item || !r.item.url || seen.has(r.item.url)) continue;
            seen.add(r.item.url);
            items.push({ type: 'collection', title: r.item.title || r.item.url, url: r.item.url, subtitle: r.collection.name });
          }
        } catch {
          /* collections unavailable */
        }
      }
      // Search suggestions: your own recent searches, then completions from the offline Vexa Search index.
      const searches = new Set([lower]);
      if (!this.isPrivate) {
        for (const s of searchHistory.suggest(trimmed, 2)) {
          if (searches.has(s.q.toLowerCase())) continue;
          searches.add(s.q.toLowerCase());
          items.push({ type: 'recent', title: s.q, subtitle: 'Recent search', url: resolveInput(s.q, engineId).url, query: s.q });
        }
      }
      if (settings.get('vexaSuggestions') && resolved.type === 'search') {
        for (const s of vexaSearch.suggest(trimmed).slice(0, 3)) {
          if (searches.has(s.toLowerCase())) continue;
          searches.add(s.toLowerCase());
          items.push({ type: 'search', title: s, subtitle: `Search ${engineName}`, url: resolveInput(s, engineId).url, query: s });
        }
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
    return { items: items.slice(0, 10), inline };
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
      // ---- 0.90
      case 'command-center':
        if (this.popup?.kind === 'command') return this.hidePopup();
        return this.showPopup('command', { query: payload?.query || '', isPrivate: this.isPrivate, key: settings.get('commandCenterKey') });
      case 'reader':
        return tab && require('./reader').reader.toggle(tab);
      case 'focus-mode':
        return require('./focus').focus.toggleMinimal(this);
      case 'focus-start':
        return require('./focus').focus.start(this, payload || {});
      case 'focus-end':
        return require('./focus').focus.stop(this);
      case 'collect':
        if (this.isPrivate) return;
        return this.showPopup('collect', this.collectData(), payload?.anchor || null);
      case 'screenshot':
        if (!tab || this.isPrivate) return;
        return require('./collections').collections.screenshotTab(tab, payload?.collectionId).then((r) => this.toast(`Screenshot saved to ${r.collection}`)).catch((e) => this.toast(e.message));
      case 'collections':
        return this.openInternal('vexa://collections/');
      case 'customize':
        return this.openInternal('vexa://newtab/#customize');
      case 'toggle-sidebar':
        return settings.set('sidebar', { show: !settings.get('sidebar').show });
      case 'research':
        return this.setResearch({ open: !this.research.open });
      case 'new-space':
        if (this.isPrivate) return;
        return this.showPopup('space', this.spaceEditData(null), payload?.anchor || null);
      case 'edit-space':
        if (this.isPrivate) return;
        return this.showPopup('space', this.spaceEditData(payload?.spaceId || this.spaceId), payload?.anchor || null);
      case 'next-space':
      case 'prev-space': {
        const list = spaces.list();
        if (this.isPrivate || list.length < 2) return;
        const i = list.findIndex((s) => s.id === this.spaceId);
        const d = action === 'next-space' ? 1 : -1;
        return this.switchSpace(list[(i + d + list.length) % list.length].id);
      }
      case 'save-space-session': {
        if (this.isPrivate) return;
        const saved = spaces.saveSession(this.spaceId, payload?.name, this.tabs.map((t) => ({ url: t.url, title: t.title })));
        return this.toast(`Saved “${saved.name}” (${saved.count} tab${saved.count === 1 ? '' : 's'})`);
      }
      case 'pin-to-space':
        if (this.isPrivate || !tab || !/^https?:/i.test(tab.url)) return;
        spaces.addPinned(this.spaceId, { url: tab.url, title: tab.title });
        return this.toast(`Pinned to ${this.space.name}`);
      default: {
        const m = /^tab-(\d)$/.exec(action);
        if (m) {
          const t2 = this.tabs[Number(m[1]) - 1];
          if (t2) this.activateTab(t2.id);
        }
        const sm = /^space-(\d)$/.exec(action);
        if (sm && !this.isPrivate) {
          const s = spaces.list()[Number(sm[1]) - 1];
          if (s) this.switchSpace(s.id);
        }
      }
    }
  }

  /** A short message, shown on the floating status layer (above the page) for a few seconds. */
  toast(text) {
    if (this.win.isDestroyed() || this.status.webContents.isDestroyed()) return;
    this._toast = String(text).slice(0, 200);
    this.lastToast = this._toast; // read by the end-to-end tests
    clearTimeout(this._toastTimer);
    clearTimeout(this.statusTimer);
    this.status.webContents.send('status:toast', this._toast);
    if (!this.statusAttached) {
      this.win.contentView.addChildView(this.status);
      this.statusAttached = true;
      if (this.overlayAttached) this.win.contentView.addChildView(this.overlay);
    }
    this._positionStatus();
    this._toastTimer = setTimeout(() => {
      this._toast = null;
      if (this.status.webContents.isDestroyed()) return;
      this.status.webContents.send('status:toast', '');
      if (this.statusAttached) {
        this.win.contentView.removeChildView(this.status);
        this.statusAttached = false;
      }
    }, 2800);
  }

  // ---------------------------------------------------------------- Collections / Spaces popups
  collectData() {
    const { collections } = require('./collections');
    const t = this.activeTab;
    const page = t && /^https?:/i.test(t.url) ? { title: t.title, url: t.url, favicon: t.favicon } : null;
    return { page, collections: collections.summaries().slice(0, 40), recent: collections.lastUsedId() };
  }

  spaceEditData(id) {
    const s = id ? spaces.get(id) : null;
    const t = this.activeTab;
    return { space: s ? structuredClone(s) : null, meta: spaces.meta(), count: s ? this._list(s.id).length : 0, current: { url: t && /^https?:/i.test(t.url) ? t.url : '', title: t ? t.title : '' }, total: spaces.list().length };
  }

  /** Research panel: a Collection docked beside the page, with notes and clipping. */
  setResearch(patch = {}) {
    if (this.isPrivate) return;
    const { collections } = require('./collections');
    const next = { ...this.research, ...patch };
    if (next.open && !(next.collectionId && collections.get(next.collectionId))) next.collectionId = collections.lastUsedId() || collections.ensureDefault('Research').id;
    this.research = next;
    this.sendState();
  }

  researchData() {
    if (!this.research.open) return null;
    const { collections } = require('./collections');
    const c = collections.get(this.research.collectionId);
    if (!c) return null;
    return { id: c.id, name: c.name, items: c.items.slice(-60).reverse().map((i) => ({ id: i.id, type: i.type, title: i.title, url: i.url, note: i.note, thumb: i.thumb ? collections.fileUrl(i.thumb) : '' })), all: collections.summaries().map((x) => ({ id: x.id, name: x.name })) };
  }

  async researchCommand(args) {
    const { collections } = require('./collections');
    const t = this.activeTab;
    const cid = this.research.collectionId;
    if (args.op === 'collection') return this.setResearch({ collectionId: String(args.id || '') });
    if (args.op === 'close') return this.setResearch({ open: false });
    if (args.op === 'note') {
      const text = String(args.text || '').trim().slice(0, 20000);
      if (text) collections.addItem(cid, { type: 'note', title: text.split('\n')[0].slice(0, 120), note: text, url: t && /^https?:/i.test(t.url) ? t.url : '' });
      return;
    }
    if (args.op === 'save-page' && t && /^https?:/i.test(t.url)) return collections.addItem(cid, { type: 'link', title: t.title, url: t.url, favicon: t.favicon });
    if (args.op === 'clip' && t && !t.wc.isDestroyed()) {
      let sel = '';
      try {
        sel = await t.wc.executeJavaScriptInIsolatedWorld(1001, [{ code: 'String(window.getSelection ? window.getSelection() : "").slice(0, 20000)' }]);
      } catch {
        sel = '';
      }
      if (!String(sel || '').trim()) return this.toast('Select some text on the page first');
      return collections.addItem(cid, { type: 'note', title: `“${String(sel).trim().slice(0, 100)}”`, note: String(sel).trim(), url: t.url, quote: true });
    }
    if (args.op === 'remove') return collections.removeItem(cid, String(args.itemId || ''));
    if (args.op === 'open' && args.url) return this.navigate(String(args.url), { disposition: 'new-tab' });
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
      case 'autofill-contact':
        if (tab && !tab.error && /^https?:/.test(tab.url)) tab.wc.send('vexa:af-fill', require('./autofill').autofill.get());
        return;
      case 'tab-to-new-window':
        return this.moveTabToNewWindow(args.tabId);
      case 'tab-to-window':
        return this.moveTabToWindow(args.tabId, [...require('./app-controller').windows].find((x) => x.id === args.windowId));
      case 'tab-drop':
        return this.dropTab(args.tabId, { out: !!args.out });
      case 'google-notice-dismiss':
        if (tab) {
          tab.googleNotice = false;
          tab.changed();
        }
        return;
      case 'password-decision':
        return tab && tab.resolvePasswordPrompt(args.decision === 'save' ? 'save' : args.decision === 'never' ? 'never' : 'dismiss');
      case 'move-tab':
        return this.moveTab(args.tabId, Number(args.index));
      case 'mute-tab':
        if (tab) {
          tab.wc.setAudioMuted(!tab.wc.isAudioMuted());
          tab.changed();
        }
        return;
      case 'pin-tab':
        return this.setPinned(args.tabId, args.pinned !== false);
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
        if (args.kind === 'shields') return this.showPopup('shields', this.shieldsData(), args.anchor);
        if (args.kind === 'collect') return this.runAction('collect', { payload: { anchor: args.anchor } });
        if (args.kind === 'space') return this.runAction(args.spaceId ? 'edit-space' : 'new-space', { payload: { anchor: args.anchor, spaceId: args.spaceId } });
        if (args.kind === 'command') return this.runAction('command-center', { payload: { query: args.query || '' } });
        if (args.kind === 'focus') return this.showPopup('focus', require('./focus').focus.popupData(this), args.anchor);
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
      case 'shields-proceed':
        return tab && tab.proceedUnsafe();
      // ---- 0.90
      case 'pick':
        this.hidePopup();
        return this.pickSuggestion(args.item, args.disposition || 'current');
      case 'switch-space':
        return this.switchSpace(String(args.spaceId || ''));
      case 'move-to-space':
        return tab && this.moveTabToSpace(tab.id, String(args.spaceId || ''));
      case 'space-context':
        return require('./context-menu').showSpaceMenu(this, String(args.spaceId || ''));
      case 'sidebar-context':
        return require('./context-menu').showSidebarMenu(this);
      case 'open-pinned': {
        const url = String(args.url || '');
        if (!/^https?:\/\//i.test(url)) return;
        const origin = url.match(/^https?:\/\/[^/]+/i)[0].toLowerCase();
        const open = this.tabs.find((t) => t.url.toLowerCase().startsWith(origin));
        if (open && !args.newTab) return this.activateTab(open.id);
        return this.addTab({ url });
      }
      case 'pinned-context':
        return require('./context-menu').showPinnedMenu(this, String(args.url || ''));
      case 'focus': {
        const { focus } = require('./focus');
        if (args.op === 'stop') return focus.stop(this, { outcome: ['keep', 'collect', 'return'].includes(args.outcome) ? args.outcome : 'return' });
        if (args.op === 'extend') return focus.extend(this, Number(args.minutes) || 10);
        if (args.op === 'minimal') return focus.toggleMinimal(this);
        if (args.op === 'allow') return focus.allowOnce(this, tab);
        if (args.op === 'dismiss') return focus.dismiss(this, tab);
        if (args.op === 'start') return focus.start(this, { name: args.name, minutes: Number(args.minutes), blockDistractions: args.blockDistractions, minimal: args.minimal, bringTab: args.bringTab });
        return;
      }
      case 'research':
        return this.researchCommand(args);
      case 'atmo-sound-bytes':
        return atmosphere.bytes(String(args.id || ''));
      case 'reader':
        return tab && require('./reader').reader.toggle(tab);
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
      case 'shields':
        return this.shieldsCommand(args);
      case 'pick-suggestion':
        this.hidePopup();
        this.chrome.send('suggestion-picked');
        if (args.item) return this.pickSuggestion(args.item, args.disposition || 'current');
        return this.navigate(String(args.url), { disposition: args.disposition || 'current' });
      // ---- Command Center
      case 'cc-query':
        return require('./command-center').commandCenter.query(this, String(args.text || '').slice(0, 300));
      case 'cc-run': {
        const keepOpen = !!args.keepOpen;
        if (!keepOpen) this.hidePopup();
        return require('./command-center').commandCenter.run(this, args.item, { disposition: args.disposition });
      }
      // ---- Save to Collection
      case 'collect': {
        const { collections } = require('./collections');
        const t = this.activeTab;
        if (args.op === 'new') {
          const c = collections.create({ name: String(args.name || '').slice(0, 80) || 'New collection' });
          args = { ...args, op: 'add', collectionId: c.id };
        }
        if (args.op === 'add' && t && /^https?:/i.test(t.url)) {
          const c = collections.get(String(args.collectionId || ''));
          if (!c) throw new Error('That collection no longer exists');
          collections.addItem(c.id, { type: args.as === 'article' ? 'article' : 'link', title: t.title, url: t.url, favicon: t.favicon, note: String(args.note || '').slice(0, 5000) });
          this.hidePopup();
          return this.toast(`Saved to ${c.name}`);
        }
        if (args.op === 'screenshot') {
          this.hidePopup();
          return this.runAction('screenshot', { payload: { collectionId: args.collectionId } });
        }
        if (args.op === 'open') {
          this.hidePopup();
          return this.openInternal('vexa://collections/');
        }
        return;
      }
      // ---- Space editor
      case 'space': {
        if (this.isPrivate) return;
        if (args.op === 'create') {
          const s = spaces.create(args.data || {});
          this.hidePopup();
          this.switchSpace(s.id);
          return s;
        }
        if (args.op === 'update') {
          const s = spaces.update(String(args.id), args.data || {});
          this.hidePopup();
          return s;
        }
        if (args.op === 'delete') {
          spaces.remove(String(args.id));
          this.hidePopup();
          return true;
        }
        if (args.op === 'manage') {
          this.hidePopup();
          return this.openInternal('vexa://settings/#spaces');
        }
        return;
      }
      // ---- Focus popup
      case 'focus': {
        const { focus } = require('./focus');
        this.hidePopup();
        if (args.op === 'start') return focus.start(this, { name: args.name, minutes: Number(args.minutes), blockDistractions: !!args.blockDistractions, minimal: !!args.minimal, bringTab: !!args.bringTab });
        if (args.op === 'stop') return focus.stop(this, { outcome: ['keep', 'collect', 'return'].includes(args.outcome) ? args.outcome : 'return' });
        if (args.op === 'extend') return focus.extend(this, Number(args.minutes) || 10);
        if (args.op === 'minimal') return focus.toggleMinimal(this);
        return;
      }
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
      const st = this.state();
      this.chrome.send('state', st);
      // The popup layer and status bubble follow the window's Atmosphere look.
      const lk = JSON.stringify(st.look);
      if (lk !== this._lookSent) {
        this._lookSent = lk;
        this._sendLook(st.look);
      }
    });
  }

  _sendLook(look = this.look()) {
    for (const v of [this.overlay, this.status]) if (!v.webContents.isDestroyed()) v.webContents.send('look', look);
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
      },
      // 0.90
      spaceId: this.spaceId,
      spaces: this.isPrivate ? [] : spaces.list().map((s) => ({ id: s.id, name: s.name, icon: s.icon, color: s.color, isolated: s.isolated, count: this._list(s.id).length })),
      pinnedSites: this.space ? this.space.pinned : [],
      look: this.look(),
      sounds: atmosphere.soundConfig({ quiet: !!(this.focusSession && settings.get('focus').quietSounds) }),
      sidebar: settings.get('sidebar'),
      focus: require('./focus').focus.state(this),
      research: this.researchData(),
      commandKey: settings.get('commandCenterKey')
    };
  }

  /** For session restore: every Space's tabs, plus the current Space's in the 0.6 format. */
  serialize() {
    const bounds = this.win.isMaximized() || this.win.isFullScreen() ? this.win.getNormalBounds() : this.win.getBounds();
    const perSpace = {};
    for (const [id, list] of this.spaceTabs) {
      if (!list.length) continue;
      const active = this.getTab(this.spaceActive.get(id));
      perSpace[id] = { activeIndex: Math.max(0, active ? list.indexOf(active) : 0), tabs: list.map((t) => t.serialize()) };
    }
    return {
      bounds,
      maximized: this.win.isMaximized(),
      spaceId: this.spaceId,
      activeIndex: Math.max(0, this.activeIndex),
      tabs: this.tabs.map((t) => t.serialize()),
      spaces: perSpace
    };
  }

  focus() {
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }
}

module.exports = { VexaWindow };
