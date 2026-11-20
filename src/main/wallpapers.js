'use strict';
// New Tab wallpapers: Vexa's gallery, the user's own images, and automatic rotation.
// Uploaded images are copied into the profile (userData/wallpapers) and served to the
// New Tab page as vexa://newtab/uploads/<file> (same origin, so the page can measure the
// image's brightness). Only exact uploaded file names are served, as image bytes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { settings, DEFAULTS } = require('./settings');
const { JsonStore } = require('./store');
const { sniff } = require('./image-type');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_UPLOADS = 12;
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// Vexa's own wallpapers (original SVG artwork in src/pages/newtab/wallpapers).
// tone = how the image reads, so the page picks legible text before the image has loaded.
const GALLERY = [
  { id: 'nebula', name: 'Nebula', tone: 'dark' },
  { id: 'aurora', name: 'Aurora', tone: 'dark' },
  { id: 'dusk', name: 'Dusk', tone: 'dark' },
  { id: 'peaks', name: 'Peaks', tone: 'dark' },
  { id: 'tide', name: 'Tide', tone: 'dark' },
  { id: 'ember', name: 'Ember', tone: 'dark' },
  { id: 'midnight', name: 'Midnight', tone: 'dark' },
  { id: 'glacier', name: 'Glacier', tone: 'light' },
  { id: 'bloom', name: 'Bloom', tone: 'light' }
];

class Wallpapers {
  init() {
    this.dir = path.join(app.getPath('userData'), 'wallpapers');
    this.store = new JsonStore(path.join(app.getPath('userData'), 'wallpapers.json'), { uploads: [] });
    // Drop entries whose file was deleted outside Vexa.
    this.store.data.uploads = (this.store.data.uploads || []).filter((u) => u && fs.existsSync(path.join(this.dir, u.file)));
    this.lastShown = null;
  }

  galleryItem(g) {
    return { kind: 'gallery', id: g.id, name: g.name, tone: g.tone, url: `vexa://newtab/wallpapers/${g.id}.svg` };
  }

  uploadItem(u) {
    return { kind: 'upload', id: u.id, name: u.name, tone: null, url: `vexa://newtab/uploads/${u.file}`, added: u.added };
  }

  find(kind, id) {
    if (kind === 'gallery') {
      const g = GALLERY.find((x) => x.id === id);
      return g ? this.galleryItem(g) : null;
    }
    if (kind === 'upload') {
      const u = this.store.data.uploads.find((x) => x.id === id);
      return u ? this.uploadItem(u) : null;
    }
    return null;
  }

  pool(source) {
    const g = GALLERY.map((x) => this.galleryItem(x));
    const u = this.store.data.uploads.map((x) => this.uploadItem(x));
    return source === 'uploads' ? u : source === 'all' ? [...g, ...u] : g;
  }

  /** The wallpaper this New Tab page should show (null = Vexa's default look). */
  current(now = Date.now()) {
    const cfg = settings.get('newTab');
    const chosen = this.find(cfg.wallpaper.kind, cfg.wallpaper.id);
    if (cfg.rotate === 'off') return chosen;
    const pool = this.pool(cfg.rotateSource);
    if (!pool.length) return chosen;
    if (cfg.rotate === 'newtab') {
      const options = pool.length > 1 ? pool.filter((p) => p.url !== this.lastShown) : pool;
      const pick = options[crypto.randomInt(options.length)];
      this.lastShown = pick.url;
      return pick;
    }
    const period = cfg.rotate === 'hourly' ? 3600e3 : 86400e3;
    const bucket = Math.floor((now - new Date(now).getTimezoneOffset() * 60e3) / period);
    const h = crypto.createHash('sha256').update(String(bucket)).digest().readUInt32LE(0);
    return pool[h % pool.length];
  }

  /** Everything the New Tab page needs. `space` (optional) can give the page its own wallpaper. */
  pageData(isPrivate, space = null) {
    const own = space && space.look && space.look.wallpaper;
    const spaceWallpaper = own ? (own.kind === 'default' ? null : this.find(own.kind, own.id)) : undefined;
    return {
      isPrivate: !!isPrivate,
      config: settings.get('newTab'),
      current: isPrivate ? null : spaceWallpaper !== undefined ? spaceWallpaper : this.current(),
      space: space ? { id: space.id, name: space.name, icon: space.icon, color: space.color, ownWallpaper: !!own } : null,
      atmosphere: settings.get('atmosphere'),
      gallery: GALLERY.map((g) => this.galleryItem(g)),
      uploads: this.store.data.uploads.map((u) => this.uploadItem(u)),
      maxUploads: MAX_UPLOADS
    };
  }

  choose(kind, id) {
    if (kind === 'default') return settings.set('newTab', { wallpaper: { kind: 'default', id: '' }, rotate: 'off' });
    if (!this.find(kind, id)) throw new Error('That wallpaper no longer exists');
    // Picking one wallpaper means "show this one": automatic changes stop.
    return settings.set('newTab', { wallpaper: { kind, id }, rotate: 'off' });
  }

  addFile(file) {
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) throw new Error('That image is larger than 20 MB');
    return this.addBytes(path.basename(file), fs.readFileSync(file));
  }

  addBytes(name, bytes) {
    if (!bytes || typeof bytes.length !== 'number') throw new Error('No image data');
    const buf = Buffer.from(bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes);
    if (!buf.length) throw new Error('The file is empty');
    if (buf.length > MAX_BYTES) throw new Error('That image is larger than 20 MB');
    const ext = sniff(buf);
    if (!ext) throw new Error('Only JPG, PNG and WebP images can be used');
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    let entry = this.store.data.uploads.find((u) => u.id === id);
    if (!entry) {
      if (this.store.data.uploads.length >= MAX_UPLOADS) throw new Error(`You can keep up to ${MAX_UPLOADS} of your own wallpapers. Remove one first.`);
      fs.mkdirSync(this.dir, { recursive: true });
      const file = `${id}.${ext}`;
      fs.writeFileSync(path.join(this.dir, file), buf);
      const cleanName = String(name || 'Wallpaper').replace(/\.(jpe?g|png|webp)$/i, '').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || 'Wallpaper';
      entry = { id, file, name: cleanName, added: Date.now(), size: buf.length };
      this.store.data.uploads.push(entry);
      this.store.save();
    }
    this.choose('upload', id);
    return this.uploadItem(entry);
  }

  remove(id) {
    const i = this.store.data.uploads.findIndex((u) => u.id === id);
    if (i < 0) return false;
    const [u] = this.store.data.uploads.splice(i, 1);
    this.store.save();
    try {
      fs.unlinkSync(path.join(this.dir, u.file));
    } catch {
      /* already gone */
    }
    const cfg = settings.get('newTab');
    if (cfg.wallpaper.kind === 'upload' && cfg.wallpaper.id === id) settings.set('newTab', { wallpaper: { kind: 'default', id: '' } });
    else settings.set('newTab', {}); // nudge open New Tab pages to refresh their lists
    return true;
  }

  /** Back to the stock Vexa New Tab page (uploaded images are kept for later). */
  reset() {
    return settings.set('newTab', structuredClone(DEFAULTS.newTab));
  }

  /** vexa://newtab/uploads/<file> */
  async serve(pathname) {
    const file = decodeURIComponent(pathname).replace(/^\/+/, '');
    const m = /^([a-f0-9]{16})\.(jpg|png|webp)$/.exec(file);
    if (!m || !this.store.data.uploads.some((u) => u.file === file)) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(path.join(this.dir, file));
      return new Response(data, { status: 200, headers: { 'content-type': TYPES[m[2]], 'content-length': String(data.length), 'cache-control': 'max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
}

module.exports = { wallpapers: new Wallpapers(), GALLERY, sniff, MAX_UPLOADS };
