'use strict';
// What you searched for from the address bar, the New Tab page or the Command Center.
// Local only: never synced, never recorded in private windows, cleared together with
// browsing history, and switchable off in Settings → Search.

const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { JsonStore } = require('./store');
const { settings } = require('./settings');

const MAX = 400;

class SearchHistory extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'search-history.json'), { items: [] }, { delay: 1500 });
    if (!Array.isArray(this.store.data.items)) this.store.data.items = [];
  }

  add(query, engine = '') {
    if (!settings.get('searchHistory')) return;
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!q) return;
    const items = this.store.data.items;
    const i = items.findIndex((x) => x.q.toLowerCase() === q.toLowerCase());
    const prev = i >= 0 ? items.splice(i, 1)[0] : null;
    items.unshift({ q, engine: String(engine || '').slice(0, 20), t: Date.now(), n: (prev?.n || 0) + 1 });
    if (items.length > MAX) items.length = MAX;
    this.store.save();
    this.emit('changed');
  }

  /** Searches starting with (or containing) `text`, most recent / frequent first. */
  suggest(text, limit = 3) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return this.store.data.items.slice(0, limit);
    const starts = [];
    const contains = [];
    for (const x of this.store.data.items) {
      const l = x.q.toLowerCase();
      if (l === t) continue;
      if (l.startsWith(t)) starts.push(x);
      else if (t.length > 2 && l.includes(t)) contains.push(x);
      if (starts.length >= limit) break;
    }
    return [...starts, ...contains].slice(0, limit);
  }

  list(limit = 100) {
    return this.store.data.items.slice(0, limit);
  }

  remove(q) {
    const before = this.store.data.items.length;
    this.store.data.items = this.store.data.items.filter((x) => x.q !== q);
    if (this.store.data.items.length !== before) {
      this.store.save();
      this.emit('changed');
    }
  }

  clear(since = 0) {
    this.store.data.items = since > 0 ? this.store.data.items.filter((x) => x.t < since) : [];
    this.store.flush();
    this.emit('changed');
  }
}

module.exports = { searchHistory: new SearchHistory() };
