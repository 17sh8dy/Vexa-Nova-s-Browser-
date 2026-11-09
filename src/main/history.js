'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const { app } = require('electron');
const { JsonStore } = require('./store');

const MAX_ENTRIES = 25000;
const MERGE_WINDOW_MS = 30 * 1000;

function isRecordable(url) {
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}

class History extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'history.json'), { nextId: 1, entries: [] }, { delay: 1500 });
  }

  get entries() {
    return this.store.data.entries;
  }

  _changed() {
    this.store.save();
    this.emit('changed');
  }

  addVisit(url, title = '', favicon = '') {
    if (!isRecordable(url)) return;
    const now = Date.now();
    const last = this.entries[this.entries.length - 1];
    if (last && last.url === url && now - last.time < MERGE_WINDOW_MS) {
      last.time = now;
      if (title) last.title = title;
      if (favicon) last.favicon = favicon;
    } else {
      this.entries.push({ id: this.store.data.nextId++, url, title, favicon, time: now });
      if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this._changed();
  }

  _updateRecent(url, patch) {
    for (let i = this.entries.length - 1, n = 0; i >= 0 && n < 200; i--, n++) {
      if (this.entries[i].url === url) {
        Object.assign(this.entries[i], patch);
        this._changed();
        return;
      }
    }
  }

  updateTitle(url, title) {
    if (title && isRecordable(url)) this._updateRecent(url, { title });
  }

  updateFavicon(url, favicon) {
    if (favicon && isRecordable(url)) this._updateRecent(url, { favicon });
  }

  /** Newest first. */
  query({ text = '', limit = 200, before = Infinity } = {}) {
    const q = String(text).trim().toLowerCase();
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (e.time >= before) continue;
      if (q && !e.url.toLowerCase().includes(q) && !(e.title || '').toLowerCase().includes(q)) continue;
      out.push(e);
    }
    return out;
  }

  remove(ids) {
    const set = new Set(ids);
    this.store.data.entries = this.entries.filter((e) => !set.has(e.id));
    this._changed();
  }

  clear(since = 0) {
    this.store.data.entries = since > 0 ? this.entries.filter((e) => e.time < since) : [];
    this._changed();
  }

  /** Aggregate visits per URL. */
  _aggregate() {
    const map = new Map();
    for (const e of this.entries) {
      let a = map.get(e.url);
      if (!a) {
        a = { url: e.url, title: e.title, favicon: e.favicon, count: 0, last: 0 };
        map.set(e.url, a);
      }
      a.count++;
      if (e.time >= a.last) {
        a.last = e.time;
        if (e.title) a.title = e.title;
        if (e.favicon) a.favicon = e.favicon;
      }
    }
    return [...map.values()];
  }

  topSites(limit = 8, hidden = []) {
    const hide = new Set(hidden);
    // Group by origin so a site shows once, using its most visited page.
    const byOrigin = new Map();
    for (const a of this._aggregate()) {
      let origin;
      try {
        const u = new URL(a.url);
        if (!/^https?:$/.test(u.protocol)) continue;
        origin = u.origin;
      } catch {
        continue;
      }
      if (hide.has(origin) || hide.has(a.url)) continue;
      const cur = byOrigin.get(origin);
      const score = a.count;
      if (!cur) byOrigin.set(origin, { ...a, origin, score, url: a.url });
      else {
        cur.score += score;
        if (a.count > cur.count) Object.assign(cur, { url: a.url, title: a.title || cur.title, favicon: a.favicon || cur.favicon, count: a.count });
      }
    }
    return [...byOrigin.values()].sort((x, y) => y.score - x.score || y.last - x.last).slice(0, limit);
  }

  /** Address-bar suggestions. */
  suggest(text, limit = 6) {
    const q = String(text).trim().toLowerCase();
    if (!q) return [];
    const now = Date.now();
    const results = [];
    for (const a of this._aggregate()) {
      const url = a.url.toLowerCase();
      const bare = url.replace(/^https?:\/\/(www\.)?/, '');
      const title = (a.title || '').toLowerCase();
      let score = 0;
      if (bare.startsWith(q)) score = 100;
      else if (url.includes(q)) score = 40;
      else if (title.includes(q)) score = 30;
      else continue;
      // Shorter URLs (site roots) first for prefix matches.
      score += Math.min(a.count, 30) * 2;
      score += Math.max(0, 20 - (now - a.last) / 86400000);
      score -= bare.length / 20;
      results.push({ ...a, score });
    }
    return results.sort((x, y) => y.score - x.score).slice(0, limit);
  }
}

module.exports = { history: new History() };
