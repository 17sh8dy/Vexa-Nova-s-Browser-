'use strict';
// Vexa Atmosphere: presets, imported sound files, and the resolved "look" (palette, accent,
// animations, background effect, browser wallpaper) for a window and its current Space.
//
// Imported sounds are copied into the profile (userData/atmosphere-sounds) under a content
// hash. The browser UI asks for their bytes over IPC and decodes them itself, so audio is
// never served on a URL and never reaches web pages.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { settings, DEFAULTS, SOUND_CATEGORIES, merge } = require('./settings');
const { JsonStore } = require('./store');

const MAX_SOUND_BYTES = 2 * 1024 * 1024;
const MAX_SOUNDS = 24;

/** Identify an audio file from its first bytes. Returns an extension or null. */
function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (a, b) => buf.toString('latin1', a, b);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0) return 'mp3'; // MPEG audio frame sync, layer set
  if (ascii(4, 8) === 'ftyp') return 'm4a';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

// Presets are complete configurations, not pictures: applying one sets the palette, accent,
// motion, background effect, sound profile + categories and the New Tab wallpaper together.
const on = (list) => Object.fromEntries(SOUND_CATEGORIES.map((c) => [c, { on: list.includes(c) }]));
const PRESETS = {
  vexa: {
    name: 'Vexa',
    desc: 'The standard Nova look, sounds off',
    atmosphere: { palette: 'vexa', accent: '', tabAnimation: 'smooth', effect: 'none', chromeWallpaper: false, transitions: true, sounds: { enabled: false, profile: 'nova', categories: on(['tabOpen', 'tabClose', 'tabSwitch', 'pageLoad', 'notification', 'startup']) } },
    wallpaper: { kind: 'default', id: '' }
  },
  midnight: {
    name: 'Midnight',
    desc: 'Subtle, dark and elegant',
    atmosphere: { palette: 'midnight', accent: '', tabAnimation: 'smooth', effect: 'glow', chromeWallpaper: false, transitions: true, sounds: { enabled: true, profile: 'soft', volume: 45, categories: on(['tabOpen', 'tabClose', 'notification', 'startup']) } },
    wallpaper: { kind: 'gallery', id: 'midnight' }
  },
  cyber: {
    name: 'Cyber',
    desc: 'Futuristic neon, mechanical keys',
    atmosphere: { palette: 'cyber', accent: '', tabAnimation: 'spring', effect: 'grid', chromeWallpaper: false, transitions: true, sounds: { enabled: true, profile: 'mech', volume: 55, categories: on(['typing', 'click', 'tabOpen', 'tabClose', 'tabSwitch', 'notification', 'startup', 'shutdown']) } },
    wallpaper: { kind: 'gallery', id: 'nebula' }
  },
  aurora: {
    name: 'Aurora',
    desc: 'Gradients and ambient light',
    atmosphere: { palette: 'aurora', accent: '', tabAnimation: 'smooth', effect: 'aurora', chromeWallpaper: true, transitions: true, sounds: { enabled: true, profile: 'nova', volume: 50, categories: on(['tabOpen', 'tabClose', 'pageLoad', 'notification', 'startup', 'shutdown']) } },
    wallpaper: { kind: 'gallery', id: 'aurora' }
  },
  arcade: {
    name: 'Arcade',
    desc: 'Playful sounds and bouncy tabs',
    atmosphere: { palette: 'arcade', accent: '', tabAnimation: 'spring', effect: 'stars', chromeWallpaper: false, transitions: true, sounds: { enabled: true, profile: 'arcade', volume: 60, categories: on(['typing', 'click', 'tabOpen', 'tabClose', 'tabSwitch', 'pageLoad', 'notification', 'startup', 'shutdown']) } },
    wallpaper: { kind: 'gallery', id: 'ember' }
  },
  minimal: {
    name: 'Minimal',
    desc: 'Clean, quiet, distraction-free',
    atmosphere: { palette: 'minimal', accent: '', tabAnimation: 'fade', effect: 'none', chromeWallpaper: false, transitions: false, sounds: { enabled: false } },
    wallpaper: { kind: 'default', id: '' }
  }
};

class Atmosphere extends EventEmitter {
  init() {
    this.dir = path.join(app.getPath('userData'), 'atmosphere-sounds');
    this.store = new JsonStore(path.join(app.getPath('userData'), 'atmosphere.json'), { sounds: [] });
    this.store.data.sounds = (this.store.data.sounds || []).filter((s) => s && /^[a-f0-9]{16}\.[a-z0-9]{3,4}$/.test(s.file) && fs.existsSync(path.join(this.dir, s.file)));
    this._cache = new Map(); // id -> Buffer (small, recently used)
  }

  presets() {
    return Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, desc: p.desc, palette: p.atmosphere.palette, effect: p.atmosphere.effect, profile: p.atmosphere.sounds.profile || null, sounds: !!p.atmosphere.sounds.enabled }));
  }

  /** Apply a preset. Keeps imported sounds assigned to categories and the master volume unless the preset sets one. */
  applyPreset(id) {
    const p = PRESETS[id];
    if (!p) throw new Error('Unknown preset');
    const cur = settings.get('atmosphere');
    const sounds = merge(cur.sounds, p.atmosphere.sounds);
    const next = { ...structuredClone(p.atmosphere), sounds, preset: id };
    settings.set('atmosphere', next);
    settings.set('newTab', { wallpaper: p.wallpaper, rotate: 'off' });
    return settings.get('atmosphere');
  }

  /** Change part of the atmosphere by hand: the preset becomes "custom". */
  update(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid change');
    const out = { ...patch };
    if (!('preset' in out)) out.preset = 'custom';
    return settings.set('atmosphere', out);
  }

  reset() {
    settings.set('atmosphere', { ...structuredClone(DEFAULTS.atmosphere), sounds: { ...structuredClone(DEFAULTS.atmosphere.sounds) } });
    return settings.get('atmosphere');
  }

  // ---------------------------------------------------------------- imported sounds
  sounds() {
    return this.store.data.sounds.map(({ id, name, ext, size, added, duration }) => ({ id, name, ext, size, added, duration }));
  }

  importFile(file) {
    const st = fs.statSync(file);
    if (st.size > MAX_SOUND_BYTES) throw new Error('Sound files can be up to 2 MB');
    return this.importBytes(path.basename(file), fs.readFileSync(file));
  }

  importBytes(name, bytes, duration = null) {
    if (!bytes || typeof bytes.length !== 'number') throw new Error('No audio data');
    const buf = Buffer.from(bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes);
    if (!buf.length) throw new Error('The file is empty');
    if (buf.length > MAX_SOUND_BYTES) throw new Error('Sound files can be up to 2 MB');
    const ext = sniffAudio(buf);
    if (!ext) throw new Error('Use an MP3, WAV, OGG, FLAC, M4A/AAC or WebM audio file');
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    let entry = this.store.data.sounds.find((s) => s.id === id);
    if (!entry) {
      if (this.store.data.sounds.length >= MAX_SOUNDS) throw new Error(`You can keep up to ${MAX_SOUNDS} imported sounds. Remove one first.`);
      fs.mkdirSync(this.dir, { recursive: true });
      const file = `${id}.${ext}`;
      fs.writeFileSync(path.join(this.dir, file), buf);
      const clean = String(name || 'Sound').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[\u0000-\u001f]/g, '').slice(0, 60) || 'Sound';
      entry = { id, file, name: clean, ext, size: buf.length, added: Date.now(), duration: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null };
      this.store.data.sounds.push(entry);
      this.store.save();
      this.emit('sounds-changed');
    }
    return { id: entry.id, name: entry.name, ext: entry.ext, size: entry.size, duration: entry.duration };
  }

  /** Raw bytes of an imported sound, for the browser UI / drawer to decode. */
  bytes(id) {
    const s = this.store.data.sounds.find((x) => x.id === id);
    if (!s) return null;
    if (this._cache.has(id)) return this._cache.get(id);
    try {
      const buf = fs.readFileSync(path.join(this.dir, s.file));
      if (this._cache.size > 12) this._cache.delete(this._cache.keys().next().value);
      this._cache.set(id, buf);
      return buf;
    } catch {
      return null;
    }
  }

  removeSound(id) {
    const i = this.store.data.sounds.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const [s] = this.store.data.sounds.splice(i, 1);
    this.store.save();
    this._cache.delete(id);
    try {
      fs.unlinkSync(path.join(this.dir, s.file));
    } catch {
      /* already gone */
    }
    // Categories that used it go back to the profile sound.
    const cats = settings.get('atmosphere').sounds.categories;
    const patch = {};
    for (const [c, o] of Object.entries(cats)) if (o.custom === id) patch[c] = { custom: '' };
    if (Object.keys(patch).length) settings.set('atmosphere', { sounds: { categories: patch } });
    this.emit('sounds-changed');
    return true;
  }

  // ---------------------------------------------------------------- the resolved look
  /**
   * What the browser UI should look like for a window showing `space` (a Space definition or null).
   * A Space can override the palette, accent, effect and wallpaper.
   */
  look(space = null, { isPrivate = false } = {}) {
    const a = settings.get('atmosphere');
    const o = (space && space.look) || {};
    if (isPrivate) return { palette: 'vexa', accent: '', tabAnimation: a.tabAnimation, effect: 'none', transitions: a.transitions, wallpaper: null, private: true };
    const { wallpapers } = require('./wallpapers');
    const wpChoice = o.wallpaper && o.wallpaper.kind ? o.wallpaper : settings.get('newTab').wallpaper;
    const wp = a.chromeWallpaper && wpChoice ? wallpapers.find(wpChoice.kind, wpChoice.id) : null;
    return {
      palette: o.palette || a.palette,
      accent: o.accent || a.accent,
      tabAnimation: a.tabAnimation,
      effect: o.effect || a.effect,
      transitions: a.transitions,
      wallpaper: wp ? { url: wp.url, tone: wp.tone } : null
    };
  }

  /** Sound config for the browser UI. Quiet during focus sessions if the user asked for that. */
  soundConfig({ quiet = false } = {}) {
    const s = settings.get('atmosphere').sounds;
    return quiet ? { ...s, enabled: false } : s;
  }
}

module.exports = { atmosphere: new Atmosphere(), PRESETS, sniffAudio, MAX_SOUND_BYTES };
