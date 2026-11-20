'use strict';
// Vexa Spaces: named workspaces, each with its own tabs in every window.
//
// A Space definition is global (name, icon, colour, look, pinned sites, startup pages,
// isolation). Which tabs a Space has is per window (see window.js). Saved sessions are
// named snapshots of a Space's tabs that can be reopened later.
//
// Isolation: an *isolated* Space keeps its cookies, storage and cache in its own
// persistent partition ("persist:space-<id>"), configured exactly like the default
// session (Shields, permissions, downloads, the page preload). Ordinary Spaces share the
// default session: they organise tabs, they are not a security boundary.

const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { app, session } = require('electron');
const { JsonStore } = require('./store');

const ICONS = ['home', 'gamepad', 'code', 'book', 'film', 'briefcase', 'star', 'heart', 'music', 'globe', 'flask', 'cart', 'palette', 'rocket', 'leaf', 'coffee', 'target'];
const COLORS = ['#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#a3a3a3'];
const MAX_SPACES = 24;
const MAX_SAVED = 100;

// Starting points offered when you create a Space (you can rename everything).
const TEMPLATES = [
  { name: 'Personal', icon: 'home', color: '#8b5cf6' },
  { name: 'Work', icon: 'briefcase', color: '#3b82f6' },
  { name: 'Development', icon: 'code', color: '#22c55e', look: { palette: 'minimal' } },
  { name: 'Research', icon: 'book', color: '#eab308' },
  { name: 'Gaming', icon: 'gamepad', color: '#ef4444', look: { palette: 'cyber' } },
  { name: 'Entertainment', icon: 'film', color: '#ec4899', look: { palette: 'arcade' } }
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const webUrl = (u) => typeof u === 'string' && u.length < 2048 && /^(https?:|vexa:\/\/(newtab|collections|search)\/)/i.test(u);
const newId = () => crypto.randomBytes(6).toString('hex');

function cleanLook(look) {
  const { PALETTES, EFFECTS } = require('./settings');
  const out = {};
  if (!isObj(look)) return out;
  if (PALETTES.includes(look.palette)) out.palette = look.palette;
  if (typeof look.accent === 'string' && /^#[0-9a-f]{6}$/i.test(look.accent)) out.accent = look.accent;
  if (EFFECTS.includes(look.effect)) out.effect = look.effect;
  if (isObj(look.wallpaper) && ['gallery', 'upload', 'default'].includes(look.wallpaper.kind) && typeof look.wallpaper.id === 'string' && look.wallpaper.id.length < 100) out.wallpaper = { kind: look.wallpaper.kind, id: look.wallpaper.id };
  return out;
}

function cleanPinned(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => isObj(p) && /^https?:\/\//i.test(p.url || '') && p.url.length < 2048)
    .slice(0, 16)
    .map((p) => ({ url: p.url, title: String(p.title || '').slice(0, 120) }));
}

function cleanStartup(st) {
  if (!isObj(st)) return { mode: 'newtab', urls: [] };
  const urls = Array.isArray(st.urls) ? st.urls.filter(webUrl).slice(0, 12) : [];
  return { mode: st.mode === 'urls' && urls.length ? 'urls' : 'newtab', urls };
}

class Spaces extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'spaces.json'), { spaces: [], saved: [] });
    const d = this.store.data;
    // A focus session's Space left over from a crash or quit becomes an ordinary Space.
    d.spaces = (Array.isArray(d.spaces) ? d.spaces : []).filter((s) => isObj(s) && /^[a-z0-9-]{1,40}$/.test(s.id)).map((s) => this._normalize({ ...s, focus: false }));
    if (!d.spaces.length) d.spaces = [this._normalize({ id: 'personal', name: 'Personal', icon: 'home', color: '#8b5cf6' })];
    d.saved = Array.isArray(d.saved) ? d.saved.filter((s) => isObj(s) && Array.isArray(s.tabs)).slice(0, MAX_SAVED) : [];
    this.sessions = new Map(); // isolated space id -> Session
  }

  _normalize(s) {
    return {
      id: s.id,
      name: String(s.name || 'Space').trim().slice(0, 40) || 'Space',
      icon: ICONS.includes(s.icon) ? s.icon : 'star',
      color: COLORS.includes(s.color) || /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : COLORS[0],
      isolated: !!s.isolated,
      look: cleanLook(s.look),
      pinned: cleanPinned(s.pinned),
      startup: cleanStartup(s.startup),
      focus: !!s.focus, // created by a focus session (ends with it)
      created: s.created || Date.now()
    };
  }

  list() {
    return structuredClone(this.store.data.spaces);
  }

  get(id) {
    return this.store.data.spaces.find((s) => s.id === id) || null;
  }

  first() {
    return this.store.data.spaces[0];
  }

  meta() {
    return { icons: ICONS, colors: COLORS, templates: TEMPLATES, max: MAX_SPACES };
  }

  create(data = {}) {
    if (this.store.data.spaces.length >= MAX_SPACES) throw new Error(`You can have up to ${MAX_SPACES} Spaces`);
    const tpl = TEMPLATES.find((t) => t.name.toLowerCase() === String(data.template || '').toLowerCase()) || {};
    const space = this._normalize({ ...tpl, ...data, look: { ...(tpl.look || {}), ...(isObj(data.look) ? data.look : {}) }, id: newId(), created: Date.now() });
    this.store.data.spaces.push(space);
    this._changed();
    return structuredClone(space);
  }

  update(id, patch = {}) {
    const i = this.store.data.spaces.findIndex((s) => s.id === id);
    if (i < 0) throw new Error('That Space no longer exists');
    const cur = this.store.data.spaces[i];
    if ('isolated' in patch && !!patch.isolated !== cur.isolated) {
      // Switching isolation would strand open tabs in the wrong session: only allowed while it has none.
      const open = [...require('./app-controller').windows].some((w) => (w.spaceTabs?.get(id) || []).length);
      if (open) throw new Error('Close this Space’s tabs before changing its isolation');
    }
    const next = this._normalize({ ...cur, ...patch, look: 'look' in patch ? patch.look : cur.look, id: cur.id, created: cur.created });
    this.store.data.spaces[i] = next;
    this._changed();
    return structuredClone(next);
  }

  remove(id) {
    const d = this.store.data;
    if (d.spaces.length <= 1) throw new Error('Vexa needs at least one Space');
    const i = d.spaces.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const [removed] = d.spaces.splice(i, 1);
    this._changed();
    this.emit('removed', removed, d.spaces[0]);
    return true;
  }

  move(id, index) {
    const d = this.store.data;
    const i = d.spaces.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const [s] = d.spaces.splice(i, 1);
    d.spaces.splice(Math.max(0, Math.min(Number(index) || 0, d.spaces.length)), 0, s);
    this._changed();
    return true;
  }

  addPinned(id, { url, title }) {
    const s = this.get(id);
    if (!s) throw new Error('That Space no longer exists');
    if (!/^https?:\/\//i.test(url || '')) throw new Error('Only web pages can be pinned to a Space');
    if (s.pinned.some((p) => p.url === url)) return false;
    return this.update(id, { pinned: [...s.pinned, { url, title }] });
  }

  removePinned(id, url) {
    const s = this.get(id);
    if (!s) return false;
    return this.update(id, { pinned: s.pinned.filter((p) => p.url !== url) });
  }

  // ---------------------------------------------------------------- sessions
  /** The Electron session a Space's tabs use. */
  sessionFor(id) {
    const s = this.get(id);
    const { defaultSession, configureSession } = require('./sessions');
    if (!s || !s.isolated) return defaultSession();
    if (!this.sessions.has(id)) this.sessions.set(id, configureSession(session.fromPartition(`persist:space-${id}`)));
    return this.sessions.get(id);
  }

  /** Every isolated session that exists (for "clear browsing data"). */
  isolatedSessions() {
    return this.store.data.spaces.filter((s) => s.isolated).map((s) => this.sessionFor(s.id));
  }

  // ---------------------------------------------------------------- saved sessions
  saved() {
    return this.store.data.saved.map((s) => ({ id: s.id, name: s.name, spaceId: s.spaceId, savedAt: s.savedAt, count: s.tabs.length, tabs: s.tabs.slice(0, 50) }));
  }

  saveSession(spaceId, name, tabs) {
    const list = (tabs || []).filter((t) => t && webUrl(t.url)).slice(0, 200).map((t) => ({ url: t.url, title: String(t.title || '').slice(0, 200) }));
    if (!list.length) throw new Error('There are no pages to save in this Space');
    const space = this.get(spaceId);
    const entry = { id: newId(), name: String(name || '').trim().slice(0, 80) || `${space ? space.name : 'Space'} — ${new Date().toLocaleString()}`, spaceId, savedAt: Date.now(), tabs: list };
    this.store.data.saved.unshift(entry);
    if (this.store.data.saved.length > MAX_SAVED) this.store.data.saved.length = MAX_SAVED;
    this._changed();
    return { id: entry.id, name: entry.name, count: list.length };
  }

  getSaved(id) {
    return this.store.data.saved.find((s) => s.id === id) || null;
  }

  removeSaved(id) {
    const i = this.store.data.saved.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.store.data.saved.splice(i, 1);
    this._changed();
    return true;
  }

  _changed() {
    this.store.save();
    this.emit('changed');
  }
}

module.exports = { spaces: new Spaces(), ICONS, COLORS, TEMPLATES };
