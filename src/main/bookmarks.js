'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const { app } = require('electron');
const { JsonStore } = require('./store');

const ROOTS = { bar: 'bar', other: 'other' };

function defaults() {
  const now = Date.now();
  return {
    nextId: 1,
    nodes: {
      bar: { id: 'bar', type: 'folder', title: 'Bookmarks bar', parentId: null, children: [], added: now },
      other: { id: 'other', type: 'folder', title: 'Other bookmarks', parentId: null, children: [], added: now }
    }
  };
}

class Bookmarks extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'bookmarks.json'), defaults());
    // Repair missing roots if the file was edited by hand.
    const d = defaults();
    for (const r of Object.values(ROOTS)) if (!this.nodes[r]) this.nodes[r] = d.nodes[r];
  }

  get nodes() {
    return this.store.data.nodes;
  }

  _changed() {
    this.store.save();
    this.emit('changed');
  }

  get(id) {
    const n = this.nodes[id];
    return n ? structuredClone(n) : null;
  }

  /** Children of a folder, resolved to node objects. */
  children(folderId) {
    const f = this.nodes[folderId];
    if (!f || f.type !== 'folder') return [];
    return f.children.map((id) => this.nodes[id]).filter(Boolean).map((n) => structuredClone(n));
  }

  folders() {
    // Flat list of folders with depth, for pickers.
    const out = [];
    const walk = (id, depth) => {
      const n = this.nodes[id];
      if (!n || n.type !== 'folder') return;
      out.push({ id: n.id, title: n.title, depth, parentId: n.parentId });
      for (const c of n.children) walk(c, depth + 1);
    };
    walk(ROOTS.bar, 0);
    walk(ROOTS.other, 0);
    return out;
  }

  _newId() {
    return 'b' + this.store.data.nextId++;
  }

  _insert(node, parentId, index) {
    const parent = this.nodes[parentId];
    if (!parent || parent.type !== 'folder') throw new Error('Invalid folder');
    this.nodes[node.id] = node;
    node.parentId = parentId;
    if (index == null || index < 0 || index > parent.children.length) parent.children.push(node.id);
    else parent.children.splice(index, 0, node.id);
  }

  add({ title, url, parentId = ROOTS.bar, index }) {
    if (typeof url !== 'string' || !url) throw new Error('URL required');
    const node = { id: this._newId(), type: 'bookmark', title: String(title || url).slice(0, 500), url, added: Date.now() };
    this._insert(node, parentId, index);
    this._changed();
    return structuredClone(node);
  }

  addFolder({ title, parentId = ROOTS.bar, index }) {
    const node = { id: this._newId(), type: 'folder', title: String(title || 'New folder').slice(0, 200), children: [], added: Date.now() };
    this._insert(node, parentId, index);
    this._changed();
    return structuredClone(node);
  }

  update(id, { title, url }) {
    const n = this.nodes[id];
    if (!n) throw new Error('Not found');
    if (typeof title === 'string') n.title = title.slice(0, 500);
    if (n.type === 'bookmark' && typeof url === 'string' && url) n.url = url;
    this._changed();
    return structuredClone(n);
  }

  _isAncestor(ancestorId, id) {
    for (let cur = this.nodes[id]; cur; cur = this.nodes[cur.parentId]) if (cur.id === ancestorId) return true;
    return false;
  }

  move(id, parentId, index) {
    const n = this.nodes[id];
    if (!n || n.parentId == null) throw new Error('Cannot move');
    if (n.type === 'folder' && this._isAncestor(id, parentId)) throw new Error('Cannot move a folder into itself');
    const oldParent = this.nodes[n.parentId];
    const oldIndex = oldParent.children.indexOf(id);
    oldParent.children.splice(oldIndex, 1);
    if (oldParent.id === parentId && index != null && index > oldIndex) index--;
    this._insert(n, parentId, index);
    this._changed();
  }

  remove(id) {
    const n = this.nodes[id];
    if (!n || n.parentId == null) return; // roots can't be removed
    const parent = this.nodes[n.parentId];
    if (parent) parent.children = parent.children.filter((c) => c !== id);
    const drop = (nid) => {
      const x = this.nodes[nid];
      if (!x) return;
      if (x.type === 'folder') x.children.forEach(drop);
      delete this.nodes[nid];
    };
    drop(id);
    this._changed();
  }

  allBookmarks() {
    return Object.values(this.nodes).filter((n) => n.type === 'bookmark');
  }

  findByUrl(url) {
    return this.allBookmarks().find((n) => n.url === url) || null;
  }

  isBookmarked(url) {
    return !!url && this.allBookmarks().some((n) => n.url === url);
  }

  /** Star button behaviour: add to bar, or remove every bookmark of this URL. */
  toggle(url, title) {
    const existing = this.allBookmarks().filter((n) => n.url === url);
    if (existing.length) {
      existing.forEach((n) => this.remove(n.id));
      return false;
    }
    this.add({ url, title, parentId: ROOTS.bar });
    return true;
  }

  search(text, limit = 100) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return [];
    return this.allBookmarks()
      .filter((n) => n.title.toLowerCase().includes(q) || n.url.toLowerCase().includes(q))
      .slice(0, limit)
      .map((n) => structuredClone(n));
  }

  /** Import a Netscape bookmark HTML file (exported from Chrome/Edge/Firefox) into a new folder. */
  importHtml(html) {
    const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const root = this.addFolder({ title: 'Imported bookmarks', parentId: ROOTS.other });
    const stack = [root.id];
    let pendingFolder = null;
    let count = 0;
    const re = /<DT><H3[^>]*>([\s\S]*?)<\/H3>|<DT><A\s+([^>]*)>([\s\S]*?)<\/A>|<DL>|<\/DL>/gi;
    let m;
    let depth = 0;
    while ((m = re.exec(html))) {
      const tok = m[0].toUpperCase();
      if (m[1] !== undefined) {
        pendingFolder = this.addFolder({ title: decode(m[1].trim()), parentId: stack[stack.length - 1] }).id;
      } else if (m[2] !== undefined) {
        const href = (m[2].match(/HREF="([^"]*)"/i) || [])[1];
        if (href && /^(https?|file|ftp):/i.test(href)) {
          this._insert({ id: this._newId(), type: 'bookmark', title: decode(m[3].trim()) || href, url: decode(href), added: Date.now() }, stack[stack.length - 1]);
          count++;
        }
      } else if (tok === '<DL>') {
        depth++;
        if (depth > 1) stack.push(pendingFolder || stack[stack.length - 1]);
        pendingFolder = null;
      } else if (tok === '</DL>') {
        if (depth > 1) stack.pop();
        depth--;
      }
    }
    this._changed();
    return count;
  }

  /** Netscape bookmark file (the format every browser imports). */
  exportHtml() {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const walk = (id, indent) => {
      const n = this.nodes[id];
      const pad = '    '.repeat(indent);
      if (n.type === 'bookmark') return `${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${Math.floor(n.added / 1000)}">${esc(n.title)}</A>\n`;
      const extra = n.id === ROOTS.bar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
      return `${pad}<DT><H3 ADD_DATE="${Math.floor(n.added / 1000)}"${extra}>${esc(n.title)}</H3>\n${pad}<DL><p>\n${n.children.map((c) => walk(c, indent + 1)).join('')}${pad}</DL><p>\n`;
    };
    return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${walk(ROOTS.bar, 1)}${walk(ROOTS.other, 1)}</DL><p>\n`;
  }
}

module.exports = { bookmarks: new Bookmarks(), ROOTS };
