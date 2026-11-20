'use strict';
// Vexa Collections: a personal internet library. A collection holds links, articles,
// images, videos, notes, files and screenshots, with a name, description, cover and
// favorites. Files you add are copied into the profile (userData/collections) under a
// content hash; images and videos are shown from vexa://collections/files/<name>, other
// files open with their default app (executables are only revealed in their folder).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { app, shell } = require('electron');
const { JsonStore } = require('./store');

const TYPES = ['link', 'article', 'image', 'video', 'note', 'file', 'screenshot'];
const MAX_COLLECTIONS = 500;
const MAX_ITEMS = 5000;
const MAX_FILE = 50 * 1024 * 1024;
const MEDIA = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };
const RISKY = /\.(exe|bat|cmd|com|msi|msix|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|jar|scr|lnk|hta|reg|cpl|pif|appref-ms|application|sh|command|app)$/i;
const COLORS = ['#8b5cf6', '#ec4899', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const newId = () => crypto.randomBytes(6).toString('hex');
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
const okUrl = (u) => typeof u === 'string' && u.length < 4096 && /^(https?:|vexa:\/\/collections\/)/i.test(u);

/** Media type from the first bytes (images/videos are displayed; everything else is a "file"). */
function sniffMedia(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && !/^M4A|^M4B/.test(buf.toString('latin1', 8, 11))) return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

class Collections extends EventEmitter {
  init() {
    this.dir = path.join(app.getPath('userData'), 'collections');
    this.store = new JsonStore(path.join(app.getPath('userData'), 'collections.json'), { collections: [], lastUsed: '', modified: 0 });
    const d = this.store.data;
    d.collections = (Array.isArray(d.collections) ? d.collections : []).filter((c) => isObj(c) && typeof c.id === 'string').map((c) => this._normCollection(c));
  }

  _normCollection(c) {
    return {
      id: c.id,
      name: clip(c.name, 80).trim() || 'Collection',
      description: clip(c.description, 1000),
      color: COLORS.includes(c.color) ? c.color : COLORS[parseInt(crypto.createHash('md5').update(c.id).digest('hex').slice(0, 2), 16) % COLORS.length],
      cover: isObj(c.cover) && (c.cover.item || c.cover.file) ? { item: clip(c.cover.item, 40), file: /^[a-f0-9]{16}\.[a-z0-9]{1,8}$/.test(c.cover.file || '') ? c.cover.file : '' } : null,
      favorite: !!c.favorite,
      created: c.created || Date.now(),
      updated: c.updated || Date.now(),
      items: (Array.isArray(c.items) ? c.items : []).filter(isObj).slice(0, MAX_ITEMS).map((i) => this._normItem(i))
    };
  }

  _normItem(i) {
    const type = TYPES.includes(i.type) ? i.type : 'link';
    return {
      id: typeof i.id === 'string' && i.id ? clip(i.id, 40) : newId(),
      type,
      title: clip(i.title, 300),
      url: okUrl(i.url) ? i.url : '',
      note: clip(i.note, 20000),
      file: /^[a-f0-9]{16}\.[a-z0-9]{1,8}$/.test(i.file || '') ? i.file : '',
      name: clip(i.name, 200), // original file name
      size: Number.isFinite(i.size) ? i.size : 0,
      favicon: typeof i.favicon === 'string' && /^(https?:|data:image\/)/i.test(i.favicon) && i.favicon.length < 4096 ? i.favicon : '',
      favorite: !!i.favorite,
      quote: !!i.quote,
      added: i.added || Date.now()
    };
  }

  _changed() {
    this.store.data.modified = Date.now();
    this.store.save();
    this.emit('changed');
  }

  fileUrl(file) {
    return file ? `vexa://collections/files/${file}` : '';
  }

  _coverUrl(c) {
    if (c.cover?.file) return this.fileUrl(c.cover.file);
    const pick = (c.cover?.item && c.items.find((i) => i.id === c.cover.item)) || c.items.find((i) => (i.type === 'image' || i.type === 'screenshot') && i.file && MEDIA[i.file.split('.').pop()]?.startsWith('image/'));
    return pick && pick.file ? this.fileUrl(pick.file) : '';
  }

  // ---------------------------------------------------------------- reading
  summaries() {
    return this.store.data.collections.map((c) => ({ id: c.id, name: c.name, description: c.description, color: c.color, favorite: c.favorite, count: c.items.length, cover: this._coverUrl(c), updated: c.updated, created: c.created }));
  }

  get(id) {
    return this.store.data.collections.find((c) => c.id === id) || null;
  }

  /** A collection for the page: items with displayable URLs for their files. */
  view(id) {
    const c = this.get(id);
    if (!c) return null;
    return { ...structuredClone(c), cover: this._coverUrl(c), items: c.items.map((i) => ({ ...i, src: i.file && MEDIA[i.file.split('.').pop()] ? this.fileUrl(i.file) : '' })) };
  }

  lastUsedId() {
    const id = this.store.data.lastUsed;
    return id && this.get(id) ? id : this.store.data.collections[0]?.id || null;
  }

  ensureDefault(name = 'Saved') {
    return this.store.data.collections.find((c) => c.name === name) || this.create({ name });
  }

  /** Search names, descriptions, item titles, URLs and notes. */
  search(text, limit = 20) {
    const t = String(text || '').trim().toLowerCase();
    const out = [];
    for (const c of this.store.data.collections) {
      if (!t || c.name.toLowerCase().includes(t) || c.description.toLowerCase().includes(t)) out.push({ collection: { id: c.id, name: c.name, count: c.items.length }, item: null });
      if (!t) continue;
      for (const i of c.items) {
        if (out.length >= limit) return out;
        if (i.title.toLowerCase().includes(t) || i.url.toLowerCase().includes(t) || i.note.toLowerCase().includes(t) || i.name.toLowerCase().includes(t)) out.push({ collection: { id: c.id, name: c.name, count: c.items.length }, item: { id: i.id, type: i.type, title: i.title, url: i.url } });
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  // ---------------------------------------------------------------- collections
  create({ name, description = '', color } = {}) {
    if (this.store.data.collections.length >= MAX_COLLECTIONS) throw new Error('You have reached the maximum number of collections');
    const c = this._normCollection({ id: newId(), name, description, color, created: Date.now(), updated: Date.now(), items: [] });
    this.store.data.collections.unshift(c);
    this.store.data.lastUsed = c.id;
    this._changed();
    return c;
  }

  update(id, patch = {}) {
    const c = this.get(id);
    if (!c) throw new Error('That collection no longer exists');
    if ('name' in patch) c.name = clip(patch.name, 80).trim() || c.name;
    if ('description' in patch) c.description = clip(patch.description, 1000);
    if ('favorite' in patch) c.favorite = !!patch.favorite;
    if ('color' in patch && COLORS.includes(patch.color)) c.color = patch.color;
    if ('cover' in patch) c.cover = patch.cover && typeof patch.cover.item === 'string' && c.items.some((i) => i.id === patch.cover.item) ? { item: patch.cover.item, file: '' } : null;
    c.updated = Date.now();
    this._changed();
    return c;
  }

  remove(id) {
    const d = this.store.data;
    const i = d.collections.findIndex((c) => c.id === id);
    if (i < 0) return false;
    const [c] = d.collections.splice(i, 1);
    this._changed();
    this._gc(c.items.map((x) => x.file).concat(c.cover?.file || []));
    return true;
  }

  move(id, index) {
    const d = this.store.data;
    const i = d.collections.findIndex((c) => c.id === id);
    if (i < 0) return false;
    const [c] = d.collections.splice(i, 1);
    d.collections.splice(Math.max(0, Math.min(Number(index) || 0, d.collections.length)), 0, c);
    this._changed();
    return true;
  }

  // ---------------------------------------------------------------- items
  addItem(collectionId, data = {}) {
    const c = this.get(collectionId);
    if (!c) throw new Error('That collection no longer exists');
    if (c.items.length >= MAX_ITEMS) throw new Error('This collection is full');
    const item = this._normItem({ ...data, id: newId(), added: Date.now() });
    if (!item.url && !item.note && !item.file) throw new Error('Nothing to save');
    // The same page twice in one collection: keep the first, refresh its title.
    if ((item.type === 'link' || item.type === 'article') && item.url) {
      const dupe = c.items.find((x) => (x.type === 'link' || x.type === 'article') && x.url === item.url);
      if (dupe) {
        if (item.title) dupe.title = item.title;
        if (item.note) dupe.note = item.note;
        c.updated = Date.now();
        this.store.data.lastUsed = c.id;
        this._changed();
        return dupe;
      }
    }
    c.items.push(item);
    c.updated = Date.now();
    this.store.data.lastUsed = c.id;
    this._changed();
    return item;
  }

  updateItem(collectionId, itemId, patch = {}) {
    const c = this.get(collectionId);
    const i = c && c.items.find((x) => x.id === itemId);
    if (!i) throw new Error('That item no longer exists');
    if ('title' in patch) i.title = clip(patch.title, 300);
    if ('note' in patch) i.note = clip(patch.note, 20000);
    if ('favorite' in patch) i.favorite = !!patch.favorite;
    if ('url' in patch && (patch.url === '' || okUrl(patch.url))) i.url = patch.url;
    c.updated = Date.now();
    this._changed();
    return i;
  }

  removeItem(collectionId, itemId) {
    const c = this.get(collectionId);
    if (!c) return false;
    const idx = c.items.findIndex((x) => x.id === itemId);
    if (idx < 0) return false;
    const [it] = c.items.splice(idx, 1);
    if (c.cover?.item === itemId) c.cover = null;
    c.updated = Date.now();
    this._changed();
    this._gc([it.file]);
    return true;
  }

  /** Reorder within a collection, or move to another one (drag and drop). */
  moveItem(fromId, itemId, toId, index) {
    const from = this.get(fromId);
    const to = this.get(toId || fromId);
    if (!from || !to) throw new Error('That collection no longer exists');
    const idx = from.items.findIndex((x) => x.id === itemId);
    if (idx < 0) return false;
    const [it] = from.items.splice(idx, 1);
    if (from !== to && from.cover?.item === itemId) from.cover = null;
    const at = index == null ? to.items.length : Math.max(0, Math.min(Number(index), to.items.length));
    to.items.splice(at, 0, it);
    from.updated = to.updated = Date.now();
    this._changed();
    return true;
  }

  // ---------------------------------------------------------------- files
  _writeFile(buf, ext) {
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const file = `${id}.${ext}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) fs.writeFileSync(full, buf);
    return file;
  }

  /** Delete files no item or cover refers to any more. */
  _gc(files) {
    const used = new Set();
    for (const c of this.store.data.collections) {
      if (c.cover?.file) used.add(c.cover.file);
      for (const i of c.items) if (i.file) used.add(i.file);
    }
    for (const f of files) {
      if (!f || used.has(f)) continue;
      try {
        fs.unlinkSync(path.join(this.dir, f));
      } catch {
        /* already gone */
      }
    }
  }

  addFileBytes(collectionId, name, bytes, { title, url, type } = {}) {
    if (!bytes || typeof bytes.length !== 'number') throw new Error('No file data');
    const buf = Buffer.from(bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes);
    if (!buf.length) throw new Error('The file is empty');
    if (buf.length > MAX_FILE) throw new Error('Files can be up to 50 MB');
    const media = sniffMedia(buf);
    const cleanName = clip(path.basename(String(name || 'file')), 200) || 'file';
    let ext = media;
    if (!ext) {
      const m = /\.([a-z0-9]{1,8})$/i.exec(cleanName);
      ext = m ? m[1].toLowerCase() : 'bin';
      if (MEDIA[ext]) ext = 'bin'; // a "media" extension that isn't really media
    }
    const file = this._writeFile(buf, ext);
    const kind = type || (media ? (MEDIA[media].startsWith('image/') ? 'image' : 'video') : 'file');
    return this.addItem(collectionId, { type: kind, title: title || cleanName.replace(/\.[a-z0-9]{1,8}$/i, ''), name: cleanName, file, size: buf.length, url: url || '' });
  }

  addFilePath(collectionId, file) {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE) throw new Error('Files can be up to 50 MB');
    return this.addFileBytes(collectionId, path.basename(file), fs.readFileSync(file));
  }

  async screenshotTab(tab, collectionId) {
    if (!tab || tab.wc.isDestroyed() || tab.error) throw new Error('Nothing to capture on this tab');
    const img = await tab.wc.capturePage();
    const png = img.toPNG();
    if (!png.length) throw new Error('The screenshot is empty');
    const c = (collectionId && this.get(collectionId)) || this.get(this.lastUsedId()) || this.ensureDefault('Screenshots');
    const title = `Screenshot — ${tab.title || tab.url}`.slice(0, 300);
    this.addFileBytes(c.id, 'screenshot.png', png, { title, url: /^https?:/i.test(tab.url) ? tab.url : '', type: 'screenshot' });
    return { collection: c.name, id: c.id };
  }

  /** Open a file item with its default app (executables are only shown in their folder). */
  openItem(collectionId, itemId, { reveal = false } = {}) {
    const c = this.get(collectionId);
    const i = c && c.items.find((x) => x.id === itemId);
    if (!i || !i.file) return false;
    const full = path.join(this.dir, i.file);
    if (!fs.existsSync(full)) throw new Error('The file is missing from the profile folder');
    if (reveal || RISKY.test(i.name || '') || RISKY.test(i.file)) {
      shell.showItemInFolder(full);
      return 'revealed';
    }
    shell.openPath(full);
    return 'opened';
  }

  /** vexa://collections/files/<name> — images and videos only, exact stored names only. */
  async serve(pathname) {
    const file = decodeURIComponent(pathname).replace(/^\/+/, '');
    const m = /^([a-f0-9]{16})\.([a-z0-9]{1,8})$/.exec(file);
    const type = m && MEDIA[m[2]];
    const known = m && this.store.data.collections.some((c) => c.cover?.file === file || c.items.some((i) => i.file === file));
    if (!type || !known) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(path.join(this.dir, file));
      return new Response(data, { status: 200, headers: { 'content-type': type, 'content-length': String(data.length), 'cache-control': 'max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }

  // ---------------------------------------------------------------- export / import
  /** A self-contained JSON bundle (files embedded as base64). `ids` = which collections (all if empty). */
  exportBundle(ids = []) {
    const list = this.store.data.collections.filter((c) => !ids.length || ids.includes(c.id));
    const files = {};
    let total = 0;
    for (const c of list) {
      for (const f of c.items.map((i) => i.file).concat(c.cover?.file || [])) {
        if (!f || files[f]) continue;
        try {
          const b = fs.readFileSync(path.join(this.dir, f));
          total += b.length;
          if (total > 300 * 1024 * 1024) throw new Error('These collections are too large to export in one file (over 300 MB of files)');
          files[f] = b.toString('base64');
        } catch (e) {
          if (/too large/.test(e.message)) throw e;
        }
      }
    }
    return { app: 'vexa-collections', v: 1, exportedAt: new Date().toISOString(), collections: structuredClone(list), files };
  }

  importBundle(bundle) {
    if (!isObj(bundle) || bundle.app !== 'vexa-collections' || bundle.v !== 1 || !Array.isArray(bundle.collections)) throw new Error('This is not a Vexa collections file');
    const rename = new Map();
    for (const [name, b64] of Object.entries(isObj(bundle.files) ? bundle.files : {})) {
      const m = /^[a-f0-9]{16}\.([a-z0-9]{1,8})$/.exec(name);
      if (!m || typeof b64 !== 'string') continue;
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length || buf.length > MAX_FILE) continue;
      // Re-hash: a file is stored under the hash of its real bytes, whatever the bundle says.
      const ext = MEDIA[m[1]] ? sniffMedia(buf) || 'bin' : m[1];
      rename.set(name, this._writeFile(buf, ext));
    }
    let n = 0;
    for (const raw of bundle.collections.slice(0, MAX_COLLECTIONS)) {
      if (!isObj(raw)) continue;
      if (this.store.data.collections.length >= MAX_COLLECTIONS) break;
      const c = this._normCollection({ ...raw, id: newId(), items: (raw.items || []).map((i) => (isObj(i) ? { ...i, id: newId(), file: rename.get(i.file) || '' } : i)), cover: null });
      this.store.data.collections.push(c);
      n++;
    }
    this._changed();
    return n;
  }

  // ---------------------------------------------------------------- sync (text only)
  /** What Sync carries: everything except the files themselves. */
  syncData() {
    return { modified: this.store.data.modified || 0, collections: this.store.data.collections.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i })) })) };
  }

  applySync(data) {
    if (!isObj(data) || !Array.isArray(data.collections)) return false;
    const before = this.store.data.collections;
    const localFiles = new Set(before.flatMap((c) => c.items.map((i) => i.file)).filter(Boolean));
    this.store.data.collections = data.collections.filter(isObj).slice(0, MAX_COLLECTIONS).map((c) => {
      const n = this._normCollection(c);
      // Files don't travel with Sync: an item whose file isn't on this device keeps its metadata only.
      for (const i of n.items) if (i.file && !localFiles.has(i.file) && !fs.existsSync(path.join(this.dir, i.file))) i.missing = true;
      return n;
    });
    this.store.data.modified = data.modified || Date.now();
    this.store.save();
    this.emit('changed', { fromSync: true });
    return true;
  }
}

module.exports = { collections: new Collections(), TYPES, sniffMedia };
