'use strict';
// Unpacked Chrome extensions ("Load unpacked"), loaded into the normal (non-private)
// profile at startup. Electron implements only part of the Chrome extension API:
// content scripts, background/service workers, storage, runtime, alarms, etc. work;
// toolbar popups and the chrome.tabs / chrome.windows UI APIs do not. Packed .crx
// files can't be loaded — unpack them first.

const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');
const { JsonStore } = require('./store');

class Extensions {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'extensions.json'), { paths: [] });
    this.errors = {}; // path -> message, for extensions that failed to load this run
  }

  get ses() {
    return session.defaultSession;
  }

  get paths() {
    return this.store.data.paths;
  }

  async loadAll() {
    for (const p of [...this.paths]) {
      try {
        await this.ses.extensions.loadExtension(p, { allowFileAccess: false });
        delete this.errors[p];
      } catch (err) {
        this.errors[p] = String(err.message || err);
        console.warn(`[vexa] Could not load extension ${p}: ${this.errors[p]}`);
      }
    }
  }

  /** Loaded extensions plus remembered ones that failed (so they can be removed). */
  list() {
    const loaded = this.ses.extensions.getAllExtensions();
    const rows = loaded.map((e) => ({
      id: e.id,
      name: e.name,
      version: e.version,
      path: e.path,
      description: String(e.manifest?.description || ''),
      manifestVersion: e.manifest?.manifest_version,
      error: null
    }));
    for (const p of this.paths) {
      if (!rows.some((r) => path.resolve(r.path) === path.resolve(p))) {
        rows.push({ id: null, name: path.basename(p), version: '', path: p, description: '', error: this.errors[p] || 'Not loaded' });
      }
    }
    return rows;
  }

  async add(dir) {
    dir = path.resolve(dir);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('That folder has no manifest.json — pick the folder of an unpacked extension.');
    const ext = await this.ses.extensions.loadExtension(dir, { allowFileAccess: false });
    if (!this.paths.some((p) => path.resolve(p) === dir)) {
      this.paths.push(dir);
      this.store.save();
    }
    delete this.errors[dir];
    return { id: ext.id, name: ext.name, version: ext.version };
  }

  remove(idOrPath) {
    const ext = this.ses.extensions.getAllExtensions().find((e) => e.id === idOrPath || path.resolve(e.path) === path.resolve(String(idOrPath)));
    const dir = ext ? ext.path : String(idOrPath);
    if (ext) this.ses.extensions.removeExtension(ext.id);
    this.store.data.paths = this.paths.filter((p) => path.resolve(p) !== path.resolve(dir));
    this.store.save();
    delete this.errors[dir];
    return true;
  }
}

module.exports = { extensions: new Extensions() };
