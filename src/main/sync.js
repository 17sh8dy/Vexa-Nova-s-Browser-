'use strict';
// Sync without a Vexa server.
//
// Vexa keeps one encrypted file (vexa-sync.json) in a folder you choose. Point that
// folder at OneDrive / Dropbox / Google Drive / Syncthing / a NAS share on every
// device and the cloud client moves the file around; Vexa reads and merges it.
//  - The file is encrypted with a passphrase you set (scrypt → AES-256-GCM), so the
//    storage provider only ever sees ciphertext. The passphrase is kept on this
//    computer in the OS keystore (safeStorage).
//  - Synced: bookmarks, passwords, autofill details, and the main settings.
//    Not synced: history, open tabs, downloads, cookies, site permissions.
//  - Merge rules: passwords merge per entry (newest edit wins, deletions travel);
//    bookmarks, settings and autofill details are replaced as a whole by whichever
//    device changed them last. History stays on each device.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { JsonStore } = require('./store');
const { settings } = require('./settings');
const { bookmarks } = require('./bookmarks');
const { passwords } = require('./passwords');
const { autofill } = require('./autofill');

const FILE = 'vexa-sync.json';
const SYNC_SETTING_KEYS = [
  'theme', 'searchEngine', 'homeMode', 'homeUrl', 'showHomeButton', 'showBookmarksBar', 'startup',
  'blockThirdPartyCookies', 'doNotTrack', 'suggestions', 'permissionDefaults', 'clearOnExit', 'offerToSavePasswords'
];
const INTERVAL = 5 * 60 * 1000;
const DEBOUNCE = 20 * 1000;

function deriveKey(pass, salt) {
  return crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(obj, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { app: 'vexa-sync', v: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(file, pass) {
  if (!file || file.app !== 'vexa-sync' || file.v !== 1) throw new Error('This is not a Vexa sync file.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, Buffer.from(file.salt, 'base64')), Buffer.from(file.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('Wrong passphrase (or the sync file is damaged).');
  }
}

class Sync {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'sync.json'), {
      enabled: false, folder: '', passphrase: '', lastSync: 0, lastError: '', modified: { settings: 0, bookmarks: 0 }
    });
    this.applying = false;
    this.running = false;
    this.timer = null;
    this.debounce = null;

    settings.on('changed', (key) => {
      if (!this.applying && SYNC_SETTING_KEYS.includes(key)) this._touch('settings');
    });
    bookmarks.on('changed', () => {
      if (!this.applying) this._touch('bookmarks');
    });
    passwords.on('changed', ({ fromSync }) => !fromSync && this._schedule());
    autofill.on('changed', ({ fromSync }) => !fromSync && this._schedule());

    if (this.store.data.enabled) {
      setTimeout(() => this.syncNow().catch(() => {}), 4000);
      this._startTimer();
    }
  }

  get d() {
    return this.store.data;
  }

  _touch(section) {
    this.d.modified[section] = Date.now();
    this.store.save();
    this._schedule();
  }

  _schedule() {
    if (!this.d.enabled) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.syncNow().catch(() => {}), DEBOUNCE);
  }

  _startTimer() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.syncNow().catch(() => {}), INTERVAL);
    this.timer.unref?.();
  }

  _pass() {
    if (!this.d.passphrase) return '';
    try {
      return safeStorage.decryptString(Buffer.from(this.d.passphrase, 'base64'));
    } catch {
      return '';
    }
  }

  status() {
    return {
      available: passwords.available(),
      enabled: this.d.enabled,
      folder: this.d.folder,
      lastSync: this.d.lastSync,
      lastError: this.d.lastError,
      running: this.running
    };
  }

  _filePath() {
    return path.join(this.d.folder, FILE);
  }

  _readRemote(pass) {
    let raw;
    try {
      raw = fs.readFileSync(this._filePath(), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`Can't read the sync folder: ${err.message}`);
    }
    return decrypt(JSON.parse(raw), pass);
  }

  _snapshot() {
    const s = settings.get();
    const picked = {};
    for (const k of SYNC_SETTING_KEYS) picked[k] = s[k];
    return {
      updated: { settings: this.d.modified.settings, bookmarks: this.d.modified.bookmarks, autofill: autofill.modified },
      settings: picked,
      bookmarks: { nextId: bookmarks.store.data.nextId, nodes: bookmarks.store.data.nodes },
      autofill: autofill.get(),
      passwords: passwords.syncSnapshot()
    };
  }

  _applySettings(remote) {
    for (const k of SYNC_SETTING_KEYS) {
      if (remote[k] === undefined || JSON.stringify(remote[k]) === JSON.stringify(settings.get(k))) continue;
      try {
        settings.set(k, remote[k]);
      } catch {
        /* ignore a value this version doesn't accept */
      }
    }
  }

  /** Merge with the file in the sync folder, then write the result back. */
  async syncNow() {
    if (!this.d.enabled || this.running) return this.status();
    this.running = true;
    try {
      const pass = this._pass();
      if (!pass) throw new Error('The sync passphrase is missing. Turn sync off and on again.');
      if (!fs.existsSync(this.d.folder)) throw new Error('The sync folder is not available right now.');
      const remote = this._readRemote(pass);
      const firstSync = !this.d.lastSync;
      this.applying = true;
      try {
        if (remote) {
          // Local bookmarks that exist on no other device yet (first sync only) are kept.
          const localOnly = firstSync ? bookmarks.allBookmarks().filter((b) => !remote.bookmarks?.nodes || !Object.values(remote.bookmarks.nodes).some((n) => n.url === b.url)) : [];
          if ((remote.updated?.settings || 0) > this.d.modified.settings) {
            this._applySettings(remote.settings || {});
            this.d.modified.settings = remote.updated.settings;
          }
          if ((remote.updated?.bookmarks || 0) > this.d.modified.bookmarks && bookmarks.replaceAll(remote.bookmarks)) {
            this.d.modified.bookmarks = remote.updated.bookmarks;
            for (const b of localOnly) bookmarks.add({ title: b.title, url: b.url, parentId: 'other' });
            if (localOnly.length) this.d.modified.bookmarks = Date.now();
          }
          if ((remote.updated?.autofill || 0) > autofill.modified) autofill.set(remote.autofill || {}, { fromSync: true, modified: remote.updated.autofill });
          passwords.syncMerge(remote.passwords);
        } else {
          // Nothing to merge with: this device becomes the source.
          this.d.modified.settings ||= Date.now();
          this.d.modified.bookmarks ||= Date.now();
        }
      } finally {
        this.applying = false;
      }

      const mine = this._snapshot();
      const same = remote && JSON.stringify({ ...remote, passwords: null }) === JSON.stringify({ ...mine, passwords: null }) && JSON.stringify(remote.passwords) === JSON.stringify(mine.passwords);
      if (!same) {
        const tmp = this._filePath() + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(encrypt(mine, pass)));
        fs.renameSync(tmp, this._filePath());
      }
      this.d.lastSync = Date.now();
      this.d.lastError = '';
    } catch (err) {
      this.d.lastError = err.message;
      throw err;
    } finally {
      this.running = false;
      this.store.save();
    }
    return this.status();
  }

  async enable(folder, passphrase) {
    if (!passwords.available()) throw new Error('This computer cannot protect the sync passphrase (no OS keystore), so sync is unavailable.');
    folder = path.resolve(String(folder || ''));
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Choose an existing folder.');
    if (String(passphrase || '').length < 8) throw new Error('Use a passphrase of at least 8 characters.');
    // Validate against an existing sync file before committing to anything.
    const prev = { ...this.d };
    this.d.folder = folder;
    try {
      this._readRemote(passphrase);
    } catch (err) {
      Object.assign(this.d, prev);
      throw err;
    }
    this.d.passphrase = safeStorage.encryptString(passphrase).toString('base64');
    this.d.enabled = true;
    this.d.lastSync = 0;
    this.d.lastError = '';
    this.store.save();
    this._startTimer();
    return this.syncNow();
  }

  disable() {
    this.d.enabled = false;
    this.d.passphrase = '';
    this.d.lastError = '';
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.store.save();
    return this.status();
  }
}

module.exports = { sync: new Sync(), SYNC_SETTING_KEYS, encrypt, decrypt };
