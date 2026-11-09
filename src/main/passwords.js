'use strict';
// Password manager storage. Passwords are encrypted with the OS keystore
// (Electron safeStorage: DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
// Linux) before they touch the disk. If the OS can't encrypt, nothing is saved.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const { app, safeStorage } = require('electron');
const { JsonStore } = require('./store');
const { originOf } = require('./url');

const DEFAULTS = { items: [], never: [], deleted: {} };

class Passwords extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'passwords.json'), DEFAULTS);
    this.store.data.never ||= [];
    this.store.data.deleted ||= {};
  }

  get items() {
    return this.store.data.items;
  }

  available() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  _enc(plain) {
    return safeStorage.encryptString(plain).toString('base64');
  }

  _dec(item) {
    try {
      return safeStorage.decryptString(Buffer.from(item.secret, 'base64'));
    } catch {
      return '';
    }
  }

  _changed(fromSync = false) {
    this.store.save();
    this.emit('changed', { fromSync });
  }

  /** Entries without their passwords (safe to show in a list). */
  list() {
    return this.items
      .map(({ id, origin, username, created, updated, used }) => ({ id, origin, username, created, updated, used }))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  reveal(id) {
    const item = this.items.find((i) => i.id === id);
    return item ? this._dec(item) : null;
  }

  /** Saved logins for an origin, including passwords — only ever sent to that origin's own tab. */
  forOrigin(origin) {
    return this.items
      .filter((i) => i.origin === origin)
      .map((i) => ({ id: i.id, username: i.username, password: this._dec(i), used: i.used || 0 }))
      .filter((i) => i.password)
      .sort((a, b) => b.used - a.used);
  }

  /** What would saving this login do? 'new' | 'update' | 'same' */
  classify(origin, username, password) {
    const existing = this.items.find((i) => i.origin === origin && i.username === username);
    if (!existing) return 'new';
    return this._dec(existing) === password ? 'same' : 'update';
  }

  save({ origin, username = '', password }) {
    if (!this.available()) throw new Error('This computer cannot encrypt passwords, so Vexa will not store them.');
    origin = originOf(origin);
    if (!origin || !/^https?:/.test(origin) || !password) throw new Error('Nothing to save');
    const now = Date.now();
    const existing = this.items.find((i) => i.origin === origin && i.username === username);
    if (existing) {
      existing.secret = this._enc(password);
      existing.updated = now;
    } else {
      this.items.push({ id: crypto.randomUUID(), origin, username, secret: this._enc(password), created: now, updated: now, used: 0 });
    }
    this.store.data.never = this.store.data.never.filter((o) => o !== origin);
    this._changed();
  }

  update(id, { username, password }) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    if (typeof username === 'string') item.username = username;
    if (typeof password === 'string' && password) item.secret = this._enc(password);
    item.updated = Date.now();
    this._changed();
    return true;
  }

  markUsed(id) {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.used = Date.now();
      this.store.save(); // not a content change: no sync, no UI refresh
    }
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.store.data.deleted[id] = Date.now();
    this._changed();
    return true;
  }

  // --- "never save for this site"
  isNever(origin) {
    return this.store.data.never.includes(origin);
  }

  addNever(origin) {
    if (!this.isNever(origin)) {
      this.store.data.never.push(origin);
      this._changed();
    }
  }

  neverList() {
    return [...this.store.data.never];
  }

  removeNever(origin) {
    this.store.data.never = this.store.data.never.filter((o) => o !== origin);
    this._changed();
  }

  clearAll() {
    for (const i of this.items) this.store.data.deleted[i.id] = Date.now();
    this.store.data.items = [];
    this._changed();
  }

  // --- CSV (the format Chrome and Edge use: name,url,username,password,note)
  exportCsv() {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = ['name,url,username,password,note'];
    for (const i of this.items) {
      let host = i.origin;
      try {
        host = new URL(i.origin).hostname;
      } catch {
        /* keep origin */
      }
      rows.push([host, i.origin + '/', i.username, this._dec(i), ''].map(q).join(','));
    }
    return rows.join('\r\n') + '\r\n';
  }

  importCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { added: 0, skipped: 0 };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (names) => head.findIndex((h) => names.includes(h));
    const cUrl = col(['url', 'origin', 'login_uri', 'website']);
    const cUser = col(['username', 'login', 'login_username', 'user']);
    const cPass = col(['password', 'login_password']);
    if (cUrl < 0 || cPass < 0) throw new Error('This file has no url and password columns.');
    let added = 0;
    let skipped = 0;
    for (const r of rows.slice(1)) {
      const origin = originOf(r[cUrl] || '');
      const password = r[cPass];
      const username = cUser >= 0 ? r[cUser] || '' : '';
      if (!origin || !/^https?:/.test(origin) || !password || this.classify(origin, username, password) === 'same') {
        skipped++;
        continue;
      }
      this.save({ origin, username, password });
      added++;
    }
    return { added, skipped };
  }

  // --- sync: decrypted snapshot for the (passphrase-encrypted) sync file, and merge back
  syncSnapshot() {
    return {
      items: this.items
        .map((i) => ({ id: i.id, origin: i.origin, username: i.username, password: this._dec(i), created: i.created, updated: i.updated }))
        .filter((i) => i.password),
      deleted: { ...this.store.data.deleted },
      never: [...this.store.data.never]
    };
  }

  /** Merge a remote snapshot: the newest edit per entry wins; deletions are remembered. */
  syncMerge(remote) {
    if (!remote || !Array.isArray(remote.items) || !this.available()) return false;
    let changed = false;
    const deleted = this.store.data.deleted;
    for (const [id, ts] of Object.entries(remote.deleted || {})) {
      if (typeof ts === 'number' && (!deleted[id] || deleted[id] < ts)) {
        deleted[id] = ts;
        changed = true;
      }
    }
    for (const r of remote.items) {
      if (!r || typeof r.id !== 'string' || !r.password || !/^https?:/.test(r.origin || '')) continue;
      if (deleted[r.id] && deleted[r.id] >= (r.updated || 0)) continue;
      const mine = this.items.find((i) => i.id === r.id) || this.items.find((i) => i.origin === r.origin && i.username === (r.username || ''));
      if (!mine) {
        this.items.push({ id: r.id, origin: r.origin, username: r.username || '', secret: this._enc(r.password), created: r.created || Date.now(), updated: r.updated || Date.now(), used: 0 });
        changed = true;
      } else if ((r.updated || 0) > (mine.updated || 0)) {
        mine.username = r.username || '';
        mine.secret = this._enc(r.password);
        mine.updated = r.updated;
        changed = true;
      }
    }
    // Apply deletions learned from the other device.
    const before = this.items.length;
    this.store.data.items = this.items.filter((i) => !(deleted[i.id] && deleted[i.id] >= (i.updated || 0)));
    if (this.items.length !== before) changed = true;
    for (const o of remote.never || []) {
      if (typeof o === 'string' && !this.store.data.never.includes(o)) {
        this.store.data.never.push(o);
        changed = true;
      }
    }
    if (changed) this._changed(true);
    return changed;
  }
}

/** Small RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

module.exports = { passwords: new Passwords(), parseCsv };
