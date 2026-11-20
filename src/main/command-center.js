'use strict';
// Vexa Command Center (Ctrl+Space): one box for websites, searches, tabs in every window,
// Spaces, bookmarks, history, downloads, collections, settings, themes and browser actions.
//
// It is built from *providers*. Each returns scored items; an item carries a `run`
// descriptor that the main process validates and executes (the popup never runs anything
// itself). Basic commands come from fuzzy matching and a rule-based phrase parser
// (intents.js) — no AI. registerProvider() is the hook for a future Nova AI provider that
// understands free-form requests and answers with the same descriptors.

const { settings } = require('./settings');
const { history } = require('./history');
const { bookmarks } = require('./bookmarks');
const { downloads } = require('./downloads');
const { spaces } = require('./spaces');
const { resolveInput, SEARCH_ENGINES, fillTemplate } = require('./url');
const { score } = require('./fuzzy');
const intents = require('./intents');

// [action, title, extra keywords, icon, shortcut hint]
const ACTIONS = [
  ['new-tab', 'New tab', 'open blank', 'plus', 'Ctrl+T'],
  ['new-window', 'New window', '', 'window', 'Ctrl+N'],
  ['new-private-window', 'New private window', 'incognito', 'mask', 'Ctrl+Shift+N'],
  ['close-tab', 'Close tab', '', 'close', 'Ctrl+W'],
  ['reopen-tab', 'Reopen closed tab', 'undo restore', 'reload', 'Ctrl+Shift+T'],
  ['reload', 'Reload page', 'refresh', 'reload', 'Ctrl+R'],
  ['hard-reload', 'Hard reload (ignore cache)', 'refresh', 'reload', 'Ctrl+Shift+R'],
  ['bookmark', 'Bookmark this page', 'star favorite', 'bookmark', 'Ctrl+D'],
  ['find', 'Find on page', 'search text', 'search', 'Ctrl+F'],
  ['print', 'Print', '', 'file', 'Ctrl+P'],
  ['zoom-in', 'Zoom in', 'bigger larger', 'plus', 'Ctrl+='],
  ['zoom-out', 'Zoom out', 'smaller', 'minus', 'Ctrl+-'],
  ['zoom-reset', 'Reset zoom', 'actual size 100', 'search', 'Ctrl+0'],
  ['fullscreen', 'Full screen', '', 'fullscreen', 'F11'],
  ['devtools', 'Developer tools', 'inspect console devtools', 'code', 'F12'],
  ['view-source', 'View page source', 'html', 'code', 'Ctrl+U'],
  ['reader', 'Reader view', 'read article focus', 'book', 'F9'],
  ['focus-mode', 'Minimal interface', 'focus distraction zen hide', 'target', 'Ctrl+Shift+F'],
  ['focus-start', 'Start a focus session', 'pomodoro timer task', 'target', ''],
  ['focus-end', 'End the focus session', 'stop', 'target', ''],
  ['collect', 'Save page to a collection', 'collections clip library', 'collection', 'Ctrl+Shift+S'],
  ['screenshot', 'Screenshot this page to a collection', 'capture image', 'camera', ''],
  ['collections', 'Open Collections', 'library saved', 'collection', ''],
  ['research', 'Research panel', 'notes side panel clip', 'book', ''],
  ['new-space', 'New Space', 'workspace create', 'spaces', ''],
  ['edit-space', 'Edit this Space', 'rename icon color workspace', 'spaces', ''],
  ['save-space-session', 'Save this Space’s tabs as a session', 'snapshot workspace', 'spaces', ''],
  ['pin-to-space', 'Pin this page to the Space', 'sidebar shortcut', 'pin', ''],
  ['toggle-sidebar', 'Show or hide the sidebar', 'panel rail', 'sidebar', 'Ctrl+Shift+E'],
  ['toggle-bookmarks-bar', 'Show or hide the bookmarks bar', '', 'bookmark', 'Ctrl+Shift+B'],
  ['customize', 'Customize Vexa (Atmosphere, wallpaper, sounds)', 'theme customise sounds wallpaper look', 'palette', ''],
  ['history', 'History', '', 'clock', 'Ctrl+H'],
  ['downloads', 'Downloads', '', 'download', 'Ctrl+J'],
  ['bookmarks', 'Bookmarks manager', '', 'bookmark', 'Ctrl+Shift+O'],
  ['settings', 'Settings', 'preferences options', 'settings', 'Ctrl+,'],
  ['clear-data', 'Clear browsing data', 'privacy delete cookies cache', 'shield', 'Ctrl+Shift+Del'],
  ['about', 'About Vexa', 'version', 'info', ''],
  ['quit', 'Exit Vexa', 'quit close', 'close', '']
];
const PRIVATE_OK = new Set(['new-tab', 'new-window', 'new-private-window', 'close-tab', 'reload', 'hard-reload', 'find', 'print', 'zoom-in', 'zoom-out', 'zoom-reset', 'fullscreen', 'devtools', 'view-source', 'reader', 'focus-mode', 'history', 'downloads', 'bookmarks', 'settings', 'clear-data', 'about', 'quit', 'bookmark']);
const TAB_ACTIONS = new Set(['duplicate-tab', 'mute-tab', 'pin-tab']);
const ALLOWED_ACTIONS = new Set([...ACTIONS.map((a) => a[0]), ...TAB_ACTIONS]);

const SECTIONS = [
  ['general', 'General', 'startup home page default browser'],
  ['appearance', 'Appearance & Atmosphere', 'theme dark light customize sounds accent wallpaper'],
  ['spaces', 'Spaces', 'workspaces isolated sessions'],
  ['search', 'Search', 'search engine suggestions shortcuts keywords'],
  ['focus', 'Focus & Reader', 'reader distraction blocklist'],
  ['shields', 'Vexa Shields', 'ads trackers fingerprinting block'],
  ['privacy', 'Privacy & security', 'clear data cookies dnt'],
  ['passwords', 'Passwords & autofill', 'logins addresses'],
  ['sync', 'Sync', 'encrypted folder'],
  ['extensions', 'Extensions', 'unpacked chrome'],
  ['permissions', 'Site permissions', 'camera microphone location notifications'],
  ['downloads', 'Downloads', 'folder location'],
  ['compatibility', 'Compatibility (Google sign-in, DRM)', 'google login widevine netflix drm'],
  ['about', 'About Vexa', 'version']
];

const SETTING_VALUES = { theme: ['system', 'light', 'dark'], showBookmarksBar: [true, false] };

class CommandCenter {
  constructor() {
    this.providers = [];
    for (const p of BUILTIN) this.registerProvider(p);
  }

  /**
   * Add a provider: { id, query(text, ctx) => items | Promise<items> }.
   * items: [{ title, subtitle?, icon?, hint?, section?, score, run }]. Errors and slow
   * providers (over 400 ms) are skipped, so a misbehaving one can't break the box.
   */
  registerProvider(p) {
    if (!p || typeof p.id !== 'string' || typeof p.query !== 'function') throw new Error('A provider needs an id and a query function');
    this.providers = this.providers.filter((x) => x.id !== p.id).concat(p);
  }

  async query(win, text) {
    const ctx = { win, isPrivate: win.isPrivate, text };
    const settled = await Promise.all(
      this.providers.map((p) =>
        Promise.race([Promise.resolve().then(() => p.query(text, ctx)), new Promise((r) => setTimeout(() => r([]), 400))])
          .then((items) => (Array.isArray(items) ? items.map((it) => ({ ...it, section: it.section || p.section || p.id })) : []))
          .catch(() => [])
      )
    );
    const all = settled.flat().filter((it) => it && it.run && typeof it.title === 'string' && it.score > 0);
    all.sort((a, b) => b.score - a.score);
    // Keep a few of each kind so one provider (history!) can't push everything else out.
    const per = {};
    const items = [];
    for (const it of all) {
      per[it.section] = (per[it.section] || 0) + 1;
      if (per[it.section] > (text.trim() ? 6 : 8)) continue;
      items.push({ ...it, id: items.length });
      if (items.length >= 40) break;
    }
    return { query: text, items };
  }

  /** Execute a run descriptor (validated: anything unknown is ignored). */
  async run(win, item, { disposition } = {}) {
    const r = item && item.run;
    if (!r || typeof r !== 'object') return false;
    const app = require('./app-controller');
    const dispo = disposition === 'new-tab' || disposition === 'background' ? disposition : 'current';
    switch (r.kind) {
      case 'action': {
        const action = String(r.action || '');
        if (!ALLOWED_ACTIONS.has(action)) return false;
        if (win.isPrivate && !PRIVATE_OK.has(action) && !TAB_ACTIONS.has(action)) return false;
        const t = win.activeTab;
        if (action === 'duplicate-tab') return t && win.duplicateTab(t.id);
        if (action === 'mute-tab') return t && (t.wc.setAudioMuted(!t.wc.isAudioMuted()), t.changed());
        if (action === 'pin-tab') return t && win.setPinned(t.id, !t.pinned);
        return win.runAction(action);
      }
      case 'tab': {
        const w = [...app.windows].find((x) => x.id === r.windowId);
        if (!w || !w.getTab(r.tabId) || (w.isPrivate !== win.isPrivate && w !== win)) return false;
        w.activateTab(r.tabId);
        if (w !== win) w.focus();
        return true;
      }
      case 'space':
        return win.switchSpace(String(r.id || ''));
      case 'create-space': {
        if (win.isPrivate) return false;
        const s = spaces.create({ name: String(r.name || 'Space').slice(0, 40), template: r.name });
        return win.switchSpace(s.id);
      }
      case 'saved-session': {
        const saved = spaces.getSaved(String(r.id || ''));
        if (!saved || win.isPrivate) return false;
        const target = spaces.get(saved.spaceId) ? saved.spaceId : win.spaceId;
        win.switchSpace(target);
        saved.tabs.forEach((t, i) => win.addTab({ url: t.url, activate: i === 0, spaceId: target }));
        return true;
      }
      case 'url':
        if (typeof r.url !== 'string' || !/^(https?:|vexa:\/\/|file:)/i.test(r.url)) return false;
        return win.navigate(r.url, { disposition: dispo });
      case 'open':
        return win.navigate(String(r.input || ''), { disposition: dispo });
      case 'search': {
        const q = String(r.query || '').slice(0, 300);
        if (!q) return false;
        const sc = r.engine ? settings.get('searchShortcuts').find((s) => s.key === r.engine) : null;
        const url = sc ? fillTemplate(sc.url, q) : resolveInput(q, settings.get('searchEngine')).url;
        if (!win.isPrivate) require('./search-history').searchHistory.add(q, sc ? sc.key : settings.get('searchEngine'));
        return win.navigate(url, { disposition: dispo });
      }
      case 'setting': {
        const allowed = SETTING_VALUES[r.key];
        if (!allowed || !allowed.includes(r.value)) return false;
        return settings.set(r.key, r.value);
      }
      case 'preset':
        if (win.isPrivate) return false;
        require('./atmosphere').atmosphere.applyPreset(String(r.id || ''));
        return win.toast('Atmosphere applied');
      case 'settings':
        if (!SECTIONS.some((s) => s[0] === r.hash)) return false;
        return win.openInternal(`vexa://settings/#${r.hash}`);
      case 'download':
        if (!['open', 'show'].includes(r.op)) return false;
        return downloads.action(String(r.id || ''), r.op);
      case 'collection':
        return win.openInternal(`vexa://collections/#c=${encodeURIComponent(String(r.id || ''))}`);
      case 'collect':
      case 'collect-new': {
        if (win.isPrivate) return false;
        const t = win.activeTab;
        if (!t || !/^https?:/i.test(t.url)) return win.toast('Only web pages can be saved to a collection');
        const { collections } = require('./collections');
        const c = r.kind === 'collect' ? collections.get(String(r.collectionId || '')) : collections.create({ name: String(r.name || '').slice(0, 80) });
        if (!c) return false;
        collections.addItem(c.id, { type: 'link', title: t.title, url: t.url, favicon: t.favicon });
        return win.toast(`Saved to ${c.name}`);
      }
      case 'focus':
        return require('./focus').focus.start(win, { name: String(r.name || ''), minutes: r.minutes == null ? undefined : Number(r.minutes) });
      default:
        return false;
    }
  }
}

// ------------------------------------------------------------------ built-in providers
const isUrlish = (q) => resolveInput(q, 'duckduckgo').type === 'url';

const BUILTIN = [
  {
    id: 'intents',
    section: 'Suggested',
    query(text, { isPrivate }) {
      if (!text.trim()) return [];
      const { atmosphere } = require('./atmosphere');
      const { collections } = require('./collections');
      return intents.parse(text, {
        spaces: isPrivate ? [] : spaces.list(),
        collections: isPrivate ? [] : collections.summaries(),
        presets: isPrivate ? [] : atmosphere.presets(),
        sections: SECTIONS.map(([hash, name]) => ({ hash, name }))
      });
    }
  },
  {
    id: 'web',
    section: 'Web',
    query(text) {
      const q = text.trim();
      if (!q) return [];
      const engine = SEARCH_ENGINES[settings.get('searchEngine')];
      const out = [];
      if (isUrlish(q)) out.push({ title: `Open ${q}`, subtitle: resolveInput(q).url, icon: 'globe', score: 890, run: { kind: 'open', input: q } });
      out.push({ title: `Search ${engine.name} for “${q.slice(0, 80)}”`, icon: 'search', hint: 'Enter', score: isUrlish(q) ? 300 : 640, run: { kind: 'search', query: q } });
      if (settings.get('searchEngine') !== 'vexa') out.push({ title: `Search Vexa Search for “${q.slice(0, 80)}”`, subtitle: 'Offline, private — Nova’s own engine', icon: 'vexa', score: 260, run: { kind: 'search', query: q, engine: 'vexa' } });
      return out;
    }
  },
  {
    id: 'actions',
    section: 'Actions',
    query(text, { isPrivate }) {
      const q = text.trim();
      const out = [];
      for (const [action, title, kw, icon, hint] of ACTIONS) {
        if (isPrivate && !PRIVATE_OK.has(action)) continue;
        const s = q ? score(q, title, kw) : ['new-tab', 'collect', 'reader', 'new-space', 'focus-start', 'customize'].includes(action) ? 300 : 0;
        if (s > (!q ? 0 : q.length < 3 ? 600 : 150)) out.push({ title, icon, hint, score: q ? Math.min(870, s * 0.95) : s, run: { kind: 'action', action } });
      }
      return out;
    }
  },
  {
    id: 'tabs',
    section: 'Open tabs',
    query(text, { win }) {
      const q = text.trim();
      const app = require('./app-controller');
      const wins = win.isPrivate ? [win] : [...app.windows].filter((w) => !w.isPrivate && !w.closing);
      const out = [];
      for (const w of wins) {
        for (const t of w.allTabs()) {
          if (t === win.activeTab) continue;
          const s = q ? score(q, t.title, t.url.replace(/^https?:\/\/(www\.)?/, '')) : 200 + Math.min(60, (t.lastActive || 0) / 1e12);
          if (s < (q ? 220 : 1)) continue;
          const sp = w.isPrivate ? null : spaces.get(t.spaceId);
          out.push({ title: t.snapshot().title, subtitle: [sp && spaces.list().length > 1 ? sp.name : '', w !== win ? 'Other window' : '', t.url.replace(/^https?:\/\//, '').slice(0, 80)].filter(Boolean).join(' · '), icon: 'tab', favicon: t.favicon, score: q ? s * 0.98 : s, run: { kind: 'tab', windowId: w.id, tabId: t.id } });
        }
      }
      return out;
    }
  },
  {
    id: 'spaces',
    section: 'Spaces',
    query(text, { win }) {
      if (win.isPrivate) return [];
      const q = text.trim();
      const out = [];
      for (const s of spaces.list()) {
        if (s.id === win.spaceId && q) continue;
        const sc = q ? score(q, s.name, 'space workspace') : s.id === win.spaceId ? 0 : 240;
        if (sc > (q ? 250 : 0)) out.push({ title: s.name, subtitle: `Switch to this Space${s.isolated ? ' · isolated' : ''}`, icon: 'spaces', color: s.color, spaceIcon: s.icon, score: sc, run: { kind: 'space', id: s.id } });
      }
      if (q) {
        for (const saved of spaces.saved()) {
          const sc = score(q, saved.name, 'saved session restore');
          if (sc > 300) out.push({ title: `Restore “${saved.name}”`, subtitle: `Saved session · ${saved.count} tabs`, icon: 'reload', score: sc * 0.9, run: { kind: 'saved-session', id: saved.id } });
        }
      }
      return out;
    }
  },
  {
    id: 'bookmarks',
    section: 'Bookmarks',
    query(text) {
      const q = text.trim();
      if (q.length < 2) return [];
      return bookmarks
        .allBookmarks()
        .map((b) => ({ b, s: score(q, b.title, b.url.replace(/^https?:\/\/(www\.)?/, '')) }))
        .filter((x) => x.s > 300)
        .sort((a, b) => b.s - a.s)
        .slice(0, 6)
        .map(({ b, s }) => ({ title: b.title || b.url, subtitle: b.url, icon: 'bookmark', score: s * 0.9, run: { kind: 'url', url: b.url } }));
    }
  },
  {
    id: 'history',
    section: 'History',
    query(text, { isPrivate }) {
      const q = text.trim();
      if (isPrivate || q.length < 2) return [];
      return history.suggest(q, 12).map((h) => ({ title: h.title || h.url, subtitle: h.url, icon: 'clock', favicon: h.favicon, score: score(q, h.title, h.url.replace(/^https?:\/\/(www\.)?/, '')) * 0.8, run: { kind: 'url', url: h.url } }));
    }
  },
  {
    id: 'downloads',
    section: 'Downloads',
    query(text) {
      const q = text.trim();
      if (q.length < 2) return [];
      return downloads
        .list()
        .filter((d) => d.state === 'completed' && d.exists !== false)
        .map((d) => ({ d, s: score(q, d.filename, 'download') }))
        .filter((x) => x.s > 300)
        .slice(0, 4)
        .flatMap(({ d, s }) => [
          { title: `Open ${d.filename}`, subtitle: 'Downloaded file', icon: 'download', score: s * 0.85, run: { kind: 'download', id: d.id, op: 'open' } },
          { title: `Show ${d.filename} in folder`, subtitle: 'Downloaded file', icon: 'folder', score: s * 0.8, run: { kind: 'download', id: d.id, op: 'show' } }
        ]);
    }
  },
  {
    id: 'collections',
    section: 'Collections',
    query(text, { isPrivate }) {
      const q = text.trim();
      if (isPrivate || q.length < 2) return [];
      const { collections } = require('./collections');
      return collections.search(q, 8).map((r) =>
        r.item
          ? { title: r.item.title || r.item.url || 'Note', subtitle: `${r.collection.name}${r.item.url ? ' · ' + r.item.url : ''}`, icon: 'collection', score: score(q, r.item.title, r.item.url) * 0.85 || 280, run: r.item.url ? { kind: 'url', url: r.item.url } : { kind: 'collection', id: r.collection.id } }
          : { title: r.collection.name, subtitle: `Collection · ${r.collection.count} items`, icon: 'collection', score: score(q, r.collection.name) * 0.9 || 280, run: { kind: 'collection', id: r.collection.id } }
      );
    }
  },
  {
    id: 'settings',
    section: 'Settings',
    query(text) {
      const q = text.trim();
      if (q.length < 2) return [];
      return SECTIONS.map(([hash, name, kw]) => ({ hash, name, s: score(q, name, kw) }))
        .filter((x) => x.s > 320)
        .map((x) => ({ title: `${x.name} settings`, icon: 'settings', score: x.s * 0.8, run: { kind: 'settings', hash: x.hash } }));
    }
  },
  {
    id: 'themes',
    section: 'Atmosphere',
    query(text, { isPrivate }) {
      const q = text.trim();
      if (isPrivate || q.length < 2) return [];
      const { atmosphere } = require('./atmosphere');
      const out = atmosphere
        .presets()
        .map((p) => ({ p, s: score(q, p.name, `${p.desc} theme atmosphere preset look`) }))
        .filter((x) => x.s > 300)
        .map(({ p, s }) => ({ title: `${p.name} atmosphere`, subtitle: p.desc, icon: 'palette', score: s * 0.85, run: { kind: 'preset', id: p.id } }));
      for (const v of ['dark', 'light', 'system']) {
        const s = score(q, `${v} theme`, `${v} mode appearance`);
        if (s > 400) out.push({ title: `${v[0].toUpperCase() + v.slice(1)} theme`, subtitle: 'Appearance', icon: 'palette', score: s * 0.8, run: { kind: 'setting', key: 'theme', value: v } });
      }
      return out;
    }
  }
];

module.exports = { commandCenter: new CommandCenter(), ACTIONS, SECTIONS };
