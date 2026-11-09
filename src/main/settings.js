'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const { app } = require('electron');
const { JsonStore } = require('./store');
const { SEARCH_ENGINES } = require('./url');

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
  blockThirdPartyCookies: true,
  doNotTrack: true,
  clearOnExit: { history: false, cookies: false, cache: false, downloads: false },
  permissionDefaults: { media: 'ask', geolocation: 'ask', notifications: 'ask', midiSysex: 'ask', 'clipboard-read': 'ask', 'display-capture': 'ask' },
  sitePermissions: {}, // { [origin]: { [permission]: 'allow' | 'block' } }
  hiddenTopSites: [],
  suggestions: true
};

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
  clearOnExit: (v) => v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'boolean'),
  permissionDefaults: (v) => v && typeof v === 'object' && Object.entries(v).every(([k, x]) => PERMISSION_TYPES.includes(k) && ['ask', 'block'].includes(x)),
  sitePermissions: (v) => v && typeof v === 'object',
  hiddenTopSites: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  suggestions: (v) => typeof v === 'boolean'
};

class Settings extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), DEFAULTS);
    // Merge nested defaults that may be missing from older files.
    this.store.data.clearOnExit = { ...DEFAULTS.clearOnExit, ...this.store.data.clearOnExit };
    this.store.data.permissionDefaults = { ...DEFAULTS.permissionDefaults, ...this.store.data.permissionDefaults };
  }

  get(key) {
    return key ? this.store.data[key] : structuredClone(this.store.data);
  }

  set(key, value) {
    if (!Object.hasOwn(VALIDATORS, key)) throw new Error(`Unknown setting: ${key}`);
    if (!VALIDATORS[key](value)) throw new Error(`Invalid value for ${key}`);
    if (key === 'clearOnExit') value = { ...DEFAULTS.clearOnExit, ...value };
    if (key === 'permissionDefaults') value = { ...DEFAULTS.permissionDefaults, ...value };
    this.store.data[key] = value;
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
