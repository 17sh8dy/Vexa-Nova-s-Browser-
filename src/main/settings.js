'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const { app } = require('electron');
const { JsonStore } = require('./store');
const { SEARCH_ENGINES } = require('./url');
const { PROTECTIONS } = require('./shields-rules');

const PERMISSION_TYPES = ['media', 'geolocation', 'notifications', 'midiSysex', 'clipboard-read', 'display-capture'];

// Vexa Atmosphere (0.90): sound + look. Kept in one setting so presets apply atomically.
const SOUND_CATEGORIES = ['typing', 'click', 'tabOpen', 'tabClose', 'tabSwitch', 'pageLoad', 'notification', 'startup', 'shutdown'];
const SOUND_PROFILES = ['nova', 'soft', 'crystal', 'mech', 'arcade'];
const PALETTES = ['vexa', 'midnight', 'cyber', 'aurora', 'arcade', 'minimal'];
const TAB_ANIMATIONS = ['smooth', 'spring', 'fade', 'none'];
const EFFECTS = ['none', 'glow', 'aurora', 'grid', 'stars'];
const NEWTAB_WIDGETS = ['search', 'favorites', 'shortcuts', 'recent', 'collections', 'spaces', 'weather'];
const COMMAND_KEYS = ['ctrl+space', 'ctrl+shift+space', 'ctrl+shift+k', 'off'];

const DEFAULT_SOUND_CATEGORIES = Object.fromEntries(
  SOUND_CATEGORIES.map((c) => [c, { on: !['typing', 'click', 'shutdown'].includes(c), volume: c === 'typing' || c === 'click' ? 45 : 70, custom: '' }])
);

// Keyword shortcuts for the address bar: "@g cats" searches Google for "cats".
// url: a template with %s (http, https or vexa://search). Scope filters (@tabs…) are built in.
const DEFAULT_SEARCH_SHORTCUTS = [
  { key: 'vexa', name: 'Vexa Search', url: 'vexa://search/?q=%s' },
  { key: 'nova', name: 'Nova sites (Vexa Search)', url: 'vexa://search/?q=%s%20in%3Anova' },
  { key: 'g', name: 'Google', url: 'https://www.google.com/search?q=%s' },
  { key: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  { key: 'b', name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  { key: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s' },
  { key: 'w', name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { key: 'gh', name: 'GitHub', url: 'https://github.com/search?q=%s' },
  { key: 'mdn', name: 'MDN Web Docs', url: 'https://developer.mozilla.org/en-US/search?q=%s' }
];
const SCOPE_KEYWORDS = ['tabs', 'bookmarks', 'history', 'collections', 'spaces'];

// Sites a focus session holds back (registrable domains), until you allow them.
const DEFAULT_FOCUS_BLOCKLIST = ['youtube.com', 'reddit.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitch.tv', 'netflix.com'];

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
    shieldsStats: true,
    // 0.90 widgets
    layout: 'centered', // centered | dashboard
    order: [...NEWTAB_WIDGETS],
    favorites: true,
    recent: false,
    collections: false, // 0.91: in the sidebar instead (still available as a widget)
    spaces: false, // 0.91: in the sidebar instead (still available as a widget)
    weather: false, // opt-in: fetches from open-meteo.com
    favoritesList: [], // [{ title, url }]
    weatherCity: null, // { name, lat, lon }
    weatherUnit: 'c' // c | f
  },
  atmosphere: {
    preset: 'vexa', // vexa | midnight | cyber | aurora | arcade | minimal | custom
    palette: 'vexa',
    accent: '', // '' = the palette's own accent, else #rrggbb
    tabAnimation: 'smooth',
    effect: 'none', // background effect behind the browser UI and New Tab
    chromeWallpaper: false, // show the New Tab wallpaper behind the tab strip
    transitions: true,
    sounds: { enabled: false, volume: 60, profile: 'nova', categories: DEFAULT_SOUND_CATEGORIES }
  },
  sidebar: {
    show: true,
    side: 'left', // left | right
    size: 'compact', // compact | wide
    items: { spaces: true, pinned: true, collections: true, command: true, focus: true }
  },
  focus: {
    minimalUi: true,
    blockDistractions: true,
    muteOtherTabs: true,
    quietSounds: true, // Atmosphere sounds stay silent during a focus session
    defaultMinutes: 25,
    blocklist: DEFAULT_FOCUS_BLOCKLIST,
    sitePrefs: {}, // { [site]: { reader?: boolean, allowInFocus?: boolean } }
    reader: { font: 'serif', size: 19, width: 680, theme: 'auto' } // theme: auto | light | sepia | dark
  },
  searchShortcuts: DEFAULT_SEARCH_SHORTCUTS,
  searchHistory: true, // remember what you search for (shown as suggestions; never synced)
  vexaSuggestions: true, // word completions from the offline Vexa Search index
  tabSuggestions: true, // "Switch to tab" in the address bar
  commandCenterKey: 'ctrl+space',
  // Google sign-in compatibility (see docs/COMPATIBILITY.md)
  googleCompat: true, // present the Chrome brand in Client Hints on Google's own hosts
  googleSignInButtons: true, // let "Sign in with Google" buttons on other sites keep their Google cookies
  clearOnExit: { history: false, cookies: false, cache: false, downloads: false },
  permissionDefaults: { media: 'ask', geolocation: 'ask', notifications: 'ask', midiSysex: 'ask', 'clipboard-read': 'ask', 'display-capture': 'ask' },
  sitePermissions: {}, // { [origin]: { [permission]: 'allow' | 'block' } }
  hiddenTopSites: [],
  suggestions: true,
  offerToSavePasswords: true,
  googleApiKey: '' // lets Chromium's location service work; applied at next launch
};

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const NEWTAB_BOOLS = ['shortcuts', 'greeting', 'clock', 'shieldsStats', 'favorites', 'recent', 'collections', 'spaces', 'weather'];
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const pct = (v) => Number.isFinite(v) && v >= 0 && v <= 100;
const webUrl = (v) => typeof v === 'string' && v.length < 2048 && /^(https?:\/\/|vexa:\/\/)/i.test(v);
const host = (v) => typeof v === 'string' && v.length < 256 && /^[a-z0-9.-]+$/i.test(v);

function validSounds(v) {
  if (!isObj(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'enabled') {
      if (typeof x !== 'boolean') return false;
    } else if (k === 'volume') {
      if (!pct(x)) return false;
    } else if (k === 'profile') {
      if (!SOUND_PROFILES.includes(x)) return false;
    } else if (k === 'categories') {
      if (!isObj(x)) return false;
      for (const [c, o] of Object.entries(x)) {
        if (!SOUND_CATEGORIES.includes(c) || !isObj(o)) return false;
        if ('on' in o && typeof o.on !== 'boolean') return false;
        if ('volume' in o && !pct(o.volume)) return false;
        if ('custom' in o && !(typeof o.custom === 'string' && /^[a-f0-9]{0,16}$/.test(o.custom))) return false;
        if (Object.keys(o).some((p) => !['on', 'volume', 'custom'].includes(p))) return false;
      }
    } else return false;
  }
  return true;
}

function validAtmosphere(v) {
  if (!isObj(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'preset') {
      if (![...PALETTES, 'custom'].includes(x)) return false;
    } else if (k === 'palette') {
      if (!PALETTES.includes(x)) return false;
    } else if (k === 'accent') {
      if (!(x === '' || isHex(x))) return false;
    } else if (k === 'tabAnimation') {
      if (!TAB_ANIMATIONS.includes(x)) return false;
    } else if (k === 'effect') {
      if (!EFFECTS.includes(x)) return false;
    } else if (k === 'chromeWallpaper' || k === 'transitions') {
      if (typeof x !== 'boolean') return false;
    } else if (k === 'sounds') {
      if (!validSounds(x)) return false;
    } else return false;
  }
  return true;
}

const SIDEBAR_ITEMS = ['spaces', 'pinned', 'collections', 'command', 'focus'];
function validSidebar(v) {
  if (!isObj(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'show') {
      if (typeof x !== 'boolean') return false;
    } else if (k === 'side') {
      if (!['left', 'right'].includes(x)) return false;
    } else if (k === 'size') {
      if (!['compact', 'wide'].includes(x)) return false;
    } else if (k === 'items') {
      if (!isObj(x) || !Object.entries(x).every(([i, b]) => SIDEBAR_ITEMS.includes(i) && typeof b === 'boolean')) return false;
    } else return false;
  }
  return true;
}

function validReader(x) {
  if (!isObj(x)) return false;
  for (const [k, v] of Object.entries(x)) {
    if (k === 'font') {
      if (!['serif', 'sans', 'mono'].includes(v)) return false;
    } else if (k === 'size') {
      if (!Number.isInteger(v) || v < 12 || v > 32) return false;
    } else if (k === 'width') {
      if (!Number.isInteger(v) || v < 480 || v > 1100) return false;
    } else if (k === 'theme') {
      if (!['auto', 'light', 'sepia', 'dark'].includes(v)) return false;
    } else return false;
  }
  return true;
}

function validFocus(v) {
  if (!isObj(v)) return false;
  for (const [k, x] of Object.entries(v)) {
    if (['minimalUi', 'blockDistractions', 'muteOtherTabs', 'quietSounds'].includes(k)) {
      if (typeof x !== 'boolean') return false;
    } else if (k === 'defaultMinutes') {
      if (!Number.isInteger(x) || x < 1 || x > 480) return false;
    } else if (k === 'blocklist') {
      if (!Array.isArray(x) || x.length > 500 || !x.every(host)) return false;
    } else if (k === 'sitePrefs') {
      if (!isObj(x) || Object.keys(x).length > 2000) return false;
      if (!Object.entries(x).every(([site, o]) => host(site) && isObj(o) && Object.entries(o).every(([p, b]) => ['reader', 'allowInFocus'].includes(p) && typeof b === 'boolean'))) return false;
    } else if (k === 'reader') {
      if (!validReader(x)) return false;
    } else return false;
  }
  return true;
}

function validShortcuts(v) {
  if (!Array.isArray(v) || v.length > 60) return false;
  const keys = new Set();
  for (const s of v) {
    if (!isObj(s) || typeof s.key !== 'string' || !/^[a-z0-9]{1,12}$/.test(s.key) || SCOPE_KEYWORDS.includes(s.key) || keys.has(s.key)) return false;
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 60) return false;
    if (!webUrl(s.url) || !s.url.includes('%s') || (/^vexa:/i.test(s.url) && !/^vexa:\/\/search\//i.test(s.url))) return false;
    keys.add(s.key);
  }
  return true;
}
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
    } else if (k === 'layout') {
      if (!['centered', 'dashboard'].includes(x)) return false;
    } else if (k === 'order') {
      if (!Array.isArray(x) || x.length !== NEWTAB_WIDGETS.length || !NEWTAB_WIDGETS.every((w) => x.includes(w))) return false;
    } else if (k === 'favoritesList') {
      if (!Array.isArray(x) || x.length > 24 || !x.every((f) => isObj(f) && /^https?:\/\//i.test(f.url || '') && f.url.length < 2048 && typeof f.title === 'string' && f.title.length <= 120)) return false;
    } else if (k === 'weatherCity') {
      if (!(x === null || (isObj(x) && typeof x.name === 'string' && x.name.length <= 120 && Number.isFinite(x.lat) && Math.abs(x.lat) <= 90 && Number.isFinite(x.lon) && Math.abs(x.lon) <= 180))) return false;
    } else if (k === 'weatherUnit') {
      if (!['c', 'f'].includes(x)) return false;
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
  googleApiKey: (v) => typeof v === 'string' && v.length < 200 && /^[A-Za-z0-9_-]*$/.test(v),
  atmosphere: validAtmosphere,
  sidebar: validSidebar,
  focus: validFocus,
  searchShortcuts: validShortcuts,
  searchHistory: (v) => typeof v === 'boolean',
  vexaSuggestions: (v) => typeof v === 'boolean',
  tabSuggestions: (v) => typeof v === 'boolean',
  commandCenterKey: (v) => COMMAND_KEYS.includes(v),
  googleCompat: (v) => typeof v === 'boolean',
  googleSignInButtons: (v) => typeof v === 'boolean'
};

const NESTED = ['atmosphere', 'sidebar', 'focus'];

/** Deep-merge plain objects (arrays and scalars from `patch` replace; null deletes). */
function merge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return structuredClone(patch);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : structuredClone(v);
  }
  return out;
}

class Settings extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), DEFAULTS);
    // Merge nested defaults that may be missing from older files.
    this.store.data.clearOnExit = { ...DEFAULTS.clearOnExit, ...this.store.data.clearOnExit };
    this.store.data.permissionDefaults = { ...DEFAULTS.permissionDefaults, ...this.store.data.permissionDefaults };
    // Profiles from before Vexa Shields: carry the old third-party-cookie choice over.
    this.store.data.shields = { ...DEFAULTS.shields, ...(isObj(this.store.data.shields) ? this.store.data.shields : {}) };
    if (!this._fileHad('shields')) this.store.data.shields.cookies = this.store.data.blockThirdPartyCookies !== false;
    // 0.91 New Tab defaults: profiles that never customized their widgets get the new, calmer
    // page; customized layouts are kept exactly (see ntp-defaults.js). Runs once per profile.
    const raw = this._raw();
    const { NTP_DEFAULTS_VERSION, migrateNewTab } = require('./ntp-defaults');
    const ntp = migrateNewTab(raw ? raw.newTab : undefined, raw ? raw.ntpDefaultsVersion : NTP_DEFAULTS_VERSION);
    this.store.data.newTab = { ...DEFAULTS.newTab, ...(isObj(this.store.data.newTab) ? this.store.data.newTab : {}), ...ntp.patch };
    if (!validNewTab({ order: this.store.data.newTab.order })) this.store.data.newTab.order = [...NEWTAB_WIDGETS];
    if (this.store.data.ntpDefaultsVersion !== NTP_DEFAULTS_VERSION) {
      this.store.data.ntpDefaultsVersion = NTP_DEFAULTS_VERSION;
      this.store.save();
    }
    // 0.90: nested objects get any defaults that older (or partial) files lack.
    for (const key of ['atmosphere', 'sidebar', 'focus']) {
      const cur = this.store.data[key];
      const merged = merge(DEFAULTS[key], isObj(cur) ? cur : {});
      this.store.data[key] = VALIDATORS[key](merged) ? merged : structuredClone(DEFAULTS[key]);
    }
    if (!validShortcuts(this.store.data.searchShortcuts)) this.store.data.searchShortcuts = structuredClone(DEFAULT_SEARCH_SHORTCUTS);
  }

  _raw() {
    try {
      const v = JSON.parse(require('fs').readFileSync(this.store.file, 'utf8'));
      return isObj(v) ? v : null;
    } catch {
      return null;
    }
  }

  _fileHad(key) {
    const raw = this._raw();
    return !!raw && Object.hasOwn(raw, key);
  }

  get(key) {
    return key ? this.store.data[key] : structuredClone(this.store.data);
  }

  set(key, value) {
    if (!Object.hasOwn(VALIDATORS, key)) throw new Error(`Unknown setting: ${key}`);
    // Nested 0.90 settings accept partial patches ({ sounds: { volume: 40 } }; null deletes a
    // key), so they are validated after merging.
    if (NESTED.includes(key)) {
      if (!isObj(value)) throw new Error(`Invalid value for ${key}`);
      value = merge(this.store.data[key], value);
    }
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

module.exports = {
  settings: new Settings(),
  DEFAULTS,
  PERMISSION_TYPES,
  SOUND_CATEGORIES,
  SOUND_PROFILES,
  PALETTES,
  EFFECTS,
  TAB_ANIMATIONS,
  NEWTAB_WIDGETS,
  SCOPE_KEYWORDS,
  DEFAULT_SEARCH_SHORTCUTS,
  merge
};
