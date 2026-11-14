'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const { app } = require('electron');
const { JsonStore } = require('./store');
const { SEARCH_ENGINES } = require('./url');
const { PROTECTIONS } = require('./shields-rules');

const PERMISSION_TYPES = ['media', 'geolocation', 'notifications', 'midiSysex', 'clipboard-read', 'display-capture'];

const DEFAULTS = {
  theme: 'system', // system | dark | light
  searchEngine: 'duckduckgo',
  homeMode: 'newtab', // newtab | custom
  homeUrl: '',
  showHomeButton: true,
  showBookmarksBar: true,
  startup: 'restore', // restore | newtab | home
  downloadDir: '',
  askDownloadLocation: false,
  showDownloadsOnStart: true,
  blockThirdPartyCookies: true, // kept in step with shields.cookies (older Vexa versions and sync read it)
  doNotTrack: true,
  // Vexa Shields: global defaults, and per-site overrides keyed by registrable domain.
  shields: Object.fromEntries(PROTECTIONS.map((p) => [p, true])),
  shieldsSites: {}, // { [site]: { enabled?: boolean, [protection]?: boolean } }
  newTab: {
    wallpaper: { kind: 'default', id: '' }, // kind: default | gallery | upload
    rotate: 'off', // off | newtab | hourly | daily
    rotateSource: 'gallery', // gallery | uploads | all
    blur: 0, // px
    brightness: 100, // %
    overlay: 25, // % darkening scrim over a wallpaper
    shortcuts: true,
    greeting: true,
    clock: false,
    shieldsStats: true
  },
  clearOnExit: { history: false, cookies: false, cache: false, downloads: false },
  permissionDefaults: { media: 'ask', geolocation: 'ask', notifications: 'ask', midiSysex: 'ask', 'clipboard-read': 'ask', 'display-capture': 'ask' },
  sitePermissions: {}, // { [origin]: { [permission]: 'allow' | 'block' } }
  hiddenTopSites: [],
  suggestions: true,
  offerToSavePasswords: true,
  googleApiKey: '' // lets Chromium's location service work; applied at next launch
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const NEWTAB_BOOLS = ['shortcuts', 'greeting', 'clock', 'shieldsStats'];
function validNewTab(v) {
  for (const [k, x] of Object.entries(v)) {
    if (k === 'wallpaper') {
      if (!isObj(x) || !['default', 'gallery', 'upload'].includes(x.kind) || typeof x.id !== 'string' || x.id.length > 100) return false;
    } else if (k === 'rotate') {
      if (!['off', 'newtab', 'hourly', 'daily'].includes(x)) return false;
    } else if (k === 'rotateSource') {
      if (!['gallery', 'uploads', 'all'].includes(x)) return false;
    } else if (k === 'blur') {
      if (!Number.isFinite(x) || x < 0 || x > 40) return false;
    } else if (k === 'brightness') {
      if (!Number.isFinite(x) || x < 30 || x > 130) return false;
    } else if (k === 'overlay') {
      if (!Number.isFinite(x) || x < 0 || x > 85) return false;
    } else if (NEWTAB_BOOLS.includes(k)) {
      if (typeof x !== 'boolean') return false;
    } else return false;
  }
  return true;
}

// Validators: settings coming from renderer processes are never trusted blindly.
const VALIDATORS = {
  theme: (v) => ['system', 'dark', 'light'].includes(v),
  searchEngine: (v) => Object.hasOwn(SEARCH_ENGINES, v),
  homeMode: (v) => ['newtab', 'custom'].includes(v),
  homeUrl: (v) => typeof v === 'string' && v.length < 4096,
  showHomeButton: (v) => typeof v === 'boolean',
  showBookmarksBar: (v) => typeof v === 'boolean',
  startup: (v) => ['restore', 'newtab', 'home'].includes(v),
  downloadDir: (v) => typeof v === 'string',
  askDownloadLocation: (v) => typeof v === 'boolean',
  showDownloadsOnStart: (v) => typeof v === 'boolean',
  blockThirdPartyCookies: (v) => typeof v === 'boolean',
  doNotTrack: (v) => typeof v === 'boolean',
  shields: (v) => isObj(v) && Object.entries(v).every(([k, x]) => PROTECTIONS.includes(k) && typeof x === 'boolean'),
  shieldsSites: (v) => isObj(v) && Object.keys(v).length <= 5000 && Object.entries(v).every(([site, o]) => site.length < 256 && isObj(o) && Object.entries(o).every(([k, x]) => (k === 'enabled' || PROTECTIONS.includes(k)) && typeof x === 'boolean')),
  newTab: (v) => isObj(v) && validNewTab(v),
  clearOnExit: (v) => v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'boolean'),
  permissionDefaults: (v) => v && typeof v === 'object' && Object.entries(v).every(([k, x]) => PERMISSION_TYPES.includes(k) && ['ask', 'block'].includes(x)),
  sitePermissions: (v) => v && typeof v === 'object',
  hiddenTopSites: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  suggestions: (v) => typeof v === 'boolean',
  offerToSavePasswords: (v) => typeof v === 'boolean',
  googleApiKey: (v) => typeof v === 'string' && v.length < 200 && /^[A-Za-z0-9_-]*$/.test(v)
};

class Settings extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), DEFAULTS);
    // Merge nested defaults that may be missing from older files.
    this.store.data.clearOnExit = { ...DEFAULTS.clearOnExit, ...this.store.data.clearOnExit };
    this.store.data.permissionDefaults = { ...DEFAULTS.permissionDefaults, ...this.store.data.permissionDefaults };
    // Profiles from before Vexa Shields: carry the old third-party-cookie choice over.
    this.store.data.shields = { ...DEFAULTS.shields, ...(isObj(this.store.data.shields) ? this.store.data.shields : {}) };
    if (!this._fileHad('shields')) this.store.data.shields.cookies = this.store.data.blockThirdPartyCookies !== false;
    this.store.data.newTab = { ...DEFAULTS.newTab, ...(isObj(this.store.data.newTab) ? this.store.data.newTab : {}) };
  }

  _fileHad(key) {
    try {
      return Object.hasOwn(JSON.parse(require('fs').readFileSync(this.store.file, 'utf8')), key);
    } catch {
      return false;
    }
  }

  get(key) {
    return key ? this.store.data[key] : structuredClone(this.store.data);
  }

  set(key, value) {
    if (!Object.hasOwn(VALIDATORS, key)) throw new Error(`Unknown setting: ${key}`);
    if (!VALIDATORS[key](value)) throw new Error(`Invalid value for ${key}`);
    if (key === 'clearOnExit') value = { ...DEFAULTS.clearOnExit, ...value };
    if (key === 'permissionDefaults') value = { ...DEFAULTS.permissionDefaults, ...value };
    if (key === 'shields') value = { ...this.store.data.shields, ...value };
    if (key === 'newTab') value = { ...this.store.data.newTab, ...value };
    this.store.data[key] = value;
    // The third-party-cookie switch exists twice (old key + Shields); keep them in step.
    if (key === 'shields' && this.store.data.blockThirdPartyCookies !== value.cookies) {
      this.store.data.blockThirdPartyCookies = value.cookies;
      this.emit('changed', 'blockThirdPartyCookies', value.cookies);
    } else if (key === 'blockThirdPartyCookies' && this.store.data.shields.cookies !== value) {
      this.store.data.shields = { ...this.store.data.shields, cookies: value };
      this.emit('changed', 'shields', this.store.data.shields);
    }
    this.store.save();
    this.emit('changed', key, value);
    return value;
  }

  downloadDir() {
    return this.store.data.downloadDir || app.getPath('downloads');
  }

  homeUrl() {
    const { homeMode, homeUrl } = this.store.data;
    return homeMode === 'custom' && homeUrl ? homeUrl : 'vexa://newtab/';
  }

  // --- site permissions ---
  sitePermission(origin, permission) {
    return this.store.data.sitePermissions[origin]?.[permission];
  }

  setSitePermission(origin, permission, decision) {
    const all = this.store.data.sitePermissions;
    if (decision == null) {
      if (all[origin]) {
        delete all[origin][permission];
        if (!Object.keys(all[origin]).length) delete all[origin];
      }
    } else {
      all[origin] = { ...(all[origin] || {}), [permission]: decision };
    }
    this.store.save();
    this.emit('changed', 'sitePermissions', all);
  }
}

module.exports = { settings: new Settings(), DEFAULTS, PERMISSION_TYPES };
