'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const { JsonStore } = require('./store');
const { settings } = require('./settings');

function uniquePath(dir, filename) {
  const safe = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_') || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate) || fs.existsSync(candidate + '.crdownload'); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

class Downloads extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'downloads.json'), { nextId: 1, items: [] });
    // Anything that was still running when the app closed is now interrupted.
    for (const r of this.store.data.items) if (r.state === 'progressing' || r.state === 'paused') r.state = 'interrupted';
    this.live = new Map(); // id -> DownloadItem
    this.privateRecords = []; // never persisted
    this._emitTimer = null;
  }

  /** All records, newest first. */
  list() {
    const all = [...this.privateRecords, ...this.store.data.items];
    return all
      .map((r) => ({ ...r, exists: r.state === 'completed' ? fs.existsSync(r.savePath) : undefined }))
      .sort((a, b) => b.startTime - a.startTime);
  }

  activeCount() {
    return [...this.live.values()].filter((i) => i.getState() === 'progressing').length;
  }

  _record(id) {
    return this.store.data.items.find((r) => r.id === id) || this.privateRecords.find((r) => r.id === id);
  }

  _changed(immediate = false) {
    if (immediate) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
      this.emit('changed');
      return;
    }
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit('changed');
    }, 200);
  }

  attach(ses, { isPrivate = false } = {}) {
    ses.on('will-download', (_event, item, webContents) => {
      const id = 'd' + this.store.data.nextId++;
      this.store.save();
      const filename = item.getFilename();
      if (settings.get('askDownloadLocation')) {
        item.setSaveDialogOptions({ defaultPath: path.join(settings.downloadDir(), filename) });
      } else {
        const dir = settings.downloadDir();
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          /* ignore — Chromium will report an error */
        }
        item.setSavePath(uniquePath(dir, filename));
      }

      const record = {
        id,
        url: item.getURL(),
        filename,
        savePath: item.getSavePath(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        mime: item.getMimeType(),
        state: 'progressing',
        startTime: Date.now(),
        endTime: null,
        private: isPrivate
      };
      if (isPrivate) this.privateRecords.push(record);
      else this.store.data.items.push(record);
      this.live.set(id, item);

      item.on('updated', (_e, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.savePath = item.getSavePath() || record.savePath;
        if (record.savePath) record.filename = path.basename(record.savePath);
        record.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
        this._changed();
      });

      item.once('done', (_e, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes() || record.receivedBytes;
        record.savePath = item.getSavePath() || record.savePath;
        if (record.savePath) record.filename = path.basename(record.savePath);
        record.state = state; // completed | cancelled | interrupted
        record.endTime = Date.now();
        this.live.delete(id);
        if (!isPrivate) this.store.save();
        this._changed(true);
        this.emit('done', record);
      });

      if (!isPrivate) this.store.save();
      this._changed(true);
      this.emit('started', record, webContents);
    });
  }

  action(id, action) {
    const item = this.live.get(id);
    const record = this._record(id);
    if (!record) throw new Error('Unknown download');
    switch (action) {
      case 'pause':
        if (item && !item.isPaused()) item.pause();
        record.state = 'paused';
        break;
      case 'resume':
        if (item && item.canResume()) item.resume();
        record.state = 'progressing';
        break;
      case 'cancel':
        if (item) item.cancel();
        break;
      case 'open':
        if (record.state === 'completed') return shell.openPath(record.savePath);
        break;
      case 'show':
        if (record.savePath && fs.existsSync(record.savePath)) shell.showItemInFolder(record.savePath);
        else shell.openPath(path.dirname(record.savePath || settings.downloadDir()));
        break;
      case 'remove':
        if (item) item.cancel();
        this.store.data.items = this.store.data.items.filter((r) => r.id !== id);
        this.privateRecords = this.privateRecords.filter((r) => r.id !== id);
        this.store.save();
        break;
      default:
        throw new Error('Unknown action');
    }
    this._changed(true);
    return true;
  }

  /** Remove finished entries from the list (files are kept). */
  clearFinished() {
    const keep = (r) => this.live.has(r.id);
    this.store.data.items = this.store.data.items.filter(keep);
    this.privateRecords = this.privateRecords.filter(keep);
    this.store.save();
    this._changed(true);
  }

  forgetPrivate(sessionRecordsFilter) {
    this.privateRecords = this.privateRecords.filter((r) => !sessionRecordsFilter(r));
    this._changed(true);
  }
}

module.exports = { downloads: new Downloads() };
