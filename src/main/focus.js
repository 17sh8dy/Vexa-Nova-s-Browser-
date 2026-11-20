'use strict';
// Vexa Focus: focus sessions, the minimal browser interface, and distraction blocking.
//
// A focus session belongs to one window. It gets its own Space ("Focus: <task>") so the
// tabs for that task stay together, an optional timer, and (optionally) a block on the
// distracting sites in Settings → Focus. When it ends you choose what happens to its tabs:
// keep them as a Space, save them to a Collection, or move them back where you were.

const { settings } = require('./settings');
const { spaces } = require('./spaces');
const { siteOf, hostOf } = require('./url');

const ALLOW_MS = 5 * 60 * 1000;

class Focus {
  constructor() {
    this.minimal = new WeakMap(); // window -> boolean (minimal UI without a session)
  }

  state(win) {
    const f = win.focusSession;
    const minimal = this.isMinimal(win);
    if (!f) return minimal ? { active: false, minimal } : null;
    return { active: true, name: f.name, startedAt: f.startedAt, endsAt: f.endsAt, done: f.done, minimal, blocking: f.blockDistractions, spaceId: f.spaceId };
  }

  isMinimal(win) {
    const f = win.focusSession;
    if (this.minimal.has(win)) return this.minimal.get(win);
    return !!(f && f.minimal);
  }

  popupData(win) {
    const cfg = settings.get('focus');
    const t = win.activeTab;
    return { session: this.state(win), defaults: { minutes: cfg.defaultMinutes, blockDistractions: cfg.blockDistractions, minimal: cfg.minimalUi }, page: t && /^https?:/i.test(t.url) ? { title: t.title } : null, isPrivate: win.isPrivate };
  }

  toggleMinimal(win) {
    this.minimal.set(win, !this.isMinimal(win));
    win.sendState();
    win.toast(this.isMinimal(win) ? 'Minimal interface on — press Ctrl+Shift+F to bring everything back' : 'Minimal interface off');
  }

  /**
   * Start a session. opts: { name, minutes (0 = no timer), bringTab, blockDistractions, minimal }.
   */
  start(win, opts = {}) {
    if (win.focusSession) this.stop(win, { outcome: 'return', silent: true });
    const cfg = settings.get('focus');
    const name = String(opts.name || '').trim().slice(0, 60) || 'Focus';
    const minutes = opts.minutes === 0 ? 0 : Math.max(1, Math.min(480, Math.round(Number(opts.minutes) || cfg.defaultMinutes)));
    const session = {
      name,
      startedAt: Date.now(),
      endsAt: minutes ? Date.now() + minutes * 60e3 : 0,
      done: false,
      blockDistractions: opts.blockDistractions ?? cfg.blockDistractions,
      minimal: opts.minimal ?? cfg.minimalUi,
      fromSpace: win.spaceId,
      spaceId: null,
      allowed: new Map(), // site -> until
      muted: [],
      timer: null
    };

    // The session's own Space (not in private windows, which have no Spaces).
    if (!win.isPrivate) {
      const from = spaces.get(win.spaceId);
      const space = spaces.create({ name: `Focus: ${name}`, icon: 'target', color: '#14b8a6', look: { palette: 'minimal' }, focus: true });
      session.spaceId = space.id;
      const tab = win.activeTab;
      win.focusSession = session;
      if (opts.bringTab !== false && tab && !tab.isNewTab && !(from && from.isolated)) {
        win.moveTabToSpace(tab.id, space.id);
        win.switchSpace(space.id, { tabId: tab.id });
      } else {
        win.switchSpace(space.id);
      }
    } else {
      win.focusSession = session;
    }

    // Quiet the other tabs that are playing sound.
    if (settings.get('focus').muteOtherTabs) {
      for (const t of win.allTabs()) {
        if (t.spaceId !== session.spaceId && t.audible && !t.wc.isAudioMuted()) {
          t.wc.setAudioMuted(true);
          session.muted.push(t.id);
          t.changed();
        }
      }
    }
    this.minimal.delete(win);
    this._arm(win);
    win.sendState();
    win.toast(minutes ? `Focus session started: ${name} · ${minutes} min` : `Focus session started: ${name}`);
    return this.state(win);
  }

  _arm(win) {
    const f = win.focusSession;
    if (!f) return;
    clearTimeout(f.timer);
    if (!f.endsAt) return;
    f.timer = setTimeout(() => {
      if (win.focusSession !== f) return;
      f.done = true;
      win.sound('notification');
      win.sendState();
      win.toast(`Focus session complete: ${f.name}`);
      try {
        win.win.flashFrame(true);
      } catch {
        /* not supported */
      }
    }, Math.max(0, f.endsAt - Date.now()));
  }

  extend(win, minutes = 10) {
    const f = win.focusSession;
    if (!f) return;
    const base = f.done || !f.endsAt ? Date.now() : f.endsAt;
    f.endsAt = base + Math.max(1, Math.min(240, minutes)) * 60e3;
    f.done = false;
    this._arm(win);
    win.sendState();
  }

  /**
   * End the session. outcome: 'keep' (its Space stays, renamed to the task), 'collect' (tabs
   * saved to a Collection and closed), 'return' (tabs move back to the Space you came from).
   */
  stop(win, { outcome = 'return', silent = false } = {}) {
    const f = win.focusSession;
    if (!f) {
      if (this.minimal.has(win) && !silent) {
        this.minimal.delete(win);
        win.sendState();
      }
      return null;
    }
    clearTimeout(f.timer);
    win.focusSession = null;
    this.minimal.delete(win);
    for (const id of f.muted) {
      const t = win.getTab(id);
      if (t && !t.wc.isDestroyed()) {
        t.wc.setAudioMuted(false);
        t.changed();
      }
    }
    let result = null;
    const space = f.spaceId ? spaces.get(f.spaceId) : null;
    if (space && !win.win.isDestroyed()) {
      const tabs = win._list(space.id).filter((t) => /^https?:/i.test(t.url));
      if (outcome === 'keep') {
        spaces.update(space.id, { name: f.name, focus: false, icon: 'target' });
        result = { kept: space.id };
      } else {
        // Leave the session's Space first, so closing or moving its tabs never empties the visible Space.
        const back = spaces.get(f.fromSpace) || spaces.first();
        if (win.spaceId === space.id) win.switchSpace(back.id);
        if (outcome === 'collect' && tabs.length) {
          const { collections } = require('./collections');
          const c = collections.create({ name: f.name, description: `Focus session, ${new Date(f.startedAt).toLocaleString()}` });
          for (const t of tabs) collections.addItem(c.id, { type: 'link', title: t.title, url: t.url, favicon: t.favicon });
          result = { collectionId: c.id, count: tabs.length };
          for (const t of [...win._list(space.id)]) win.closeTab(t.id);
        }
        // Whatever is left goes back to where the session started.
        this._moveAll(win, space.id, back.id);
        if (spaces.list().length > 1) spaces.remove(space.id);
      }
    } else if (space && win.win.isDestroyed()) {
      // Window closed mid-session: the Space keeps its tabs for next time, as a normal Space.
      spaces.update(space.id, { focus: false, name: f.name });
    }
    // Pages that were held back load now that the session is over.
    if (!win.win.isDestroyed()) for (const t of win.allTabs()) if (t.error && t.error.code === 'focus') t.loadURL(t.error.url);
    if (!silent && !win.win.isDestroyed()) {
      win.sendState();
      win.toast(result && result.collectionId ? `Saved ${result.count} tab${result.count === 1 ? '' : 's'} to the “${f.name}” collection` : 'Focus session ended');
    }
    return result;
  }

  _moveAll(win, fromId, toId) {
    const to = spaces.get(toId);
    for (const t of [...win._list(fromId)]) {
      if (to && to.isolated) win.closeTab(t.id);
      else win.moveTabToSpace(t.id, toId);
    }
  }

  /** Should this navigation be held back by the window's focus session? */
  blocks(tab, url) {
    const f = tab.win.focusSession;
    if (!f || f.done || !f.blockDistractions || !/^https?:/i.test(url)) return false;
    const site = siteOf(hostOf(url));
    if (!site) return false;
    const cfg = settings.get('focus');
    if (cfg.sitePrefs[site]?.allowInFocus) return false;
    const until = f.allowed.get(site);
    if (until && until > Date.now()) return false;
    return cfg.blocklist.some((b) => site === b || site.endsWith('.' + b) || hostOf(url) === b);
  }

  /** "Go back" on the stay-focused panel: show the page the tab is still on (nothing was loaded). */
  dismiss(win, tab) {
    if (!tab || !tab.error || tab.error.code !== 'focus') return;
    const current = tab.wc.isDestroyed() ? '' : tab.wc.getURL();
    if (!current || current === 'about:blank') return tab.loadURL(require('./url').NEWTAB_URL);
    tab.error = null;
    tab.url = current;
    tab.title = tab.wc.getTitle();
    win.layout();
    tab.changed();
  }

  /** "Allow for 5 minutes" on the stay-focused panel. */
  allowOnce(win, tab) {
    const f = win.focusSession;
    if (!f || !tab || !tab.error || tab.error.code !== 'focus') return;
    const url = tab.error.url;
    f.allowed.set(siteOf(hostOf(url)), Date.now() + ALLOW_MS);
    tab.loadURL(url);
  }
}

module.exports = { focus: new Focus() };
