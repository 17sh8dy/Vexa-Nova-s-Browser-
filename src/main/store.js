'use strict';
// Tiny JSON persistence layer: load synchronously at startup, debounce writes,
// write atomically (tmp file + rename) so a crash can't leave a half-written file.

const fs = require('fs');
const path = require('path');

const allStores = new Set();

class JsonStore {
  constructor(file, defaults, { delay = 400 } = {}) {
    this.file = file;
    this.delay = delay;
    this.timer = null;
    this.data = this._load(defaults);
    allStores.add(this);
  }

  _load(defaults) {
    const fallback = structuredClone(defaults);
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
      if (parsed && typeof parsed === 'object') return { ...fallback, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a copy of the unreadable file instead of silently discarding it.
        try {
          fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now());
        } catch {
          /* ignore */
        }
        console.warn(`[vexa] Could not read ${path.basename(this.file)}: ${err.message}`);
      }
    }
    return fallback;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[vexa] Failed to save ${path.basename(this.file)}: ${err.message}`);
    }
  }

  static flushAll() {
    for (const s of allStores) if (s.timer) s.flush();
  }
}

module.exports = { JsonStore };
