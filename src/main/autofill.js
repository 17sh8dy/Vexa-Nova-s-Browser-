'use strict';
// Saved address/contact details used for form autofill (no payment cards).

const { EventEmitter } = require('events');
const path = require('path');
const { app } = require('electron');
const { JsonStore } = require('./store');

const FIELDS = ['firstName', 'lastName', 'email', 'phone', 'organization', 'address1', 'address2', 'city', 'state', 'zip', 'country'];
const DEFAULTS = { profile: Object.fromEntries(FIELDS.map((f) => [f, ''])), modified: 0 };

class Autofill extends EventEmitter {
  init() {
    this.store = new JsonStore(path.join(app.getPath('userData'), 'autofill.json'), DEFAULTS);
    this.store.data.profile = { ...DEFAULTS.profile, ...this.store.data.profile };
  }

  get() {
    return { ...this.store.data.profile };
  }

  isEmpty() {
    return !Object.values(this.store.data.profile).some((v) => String(v).trim());
  }

  get modified() {
    return this.store.data.modified || 0;
  }

  set(profile, { fromSync = false, modified } = {}) {
    const clean = {};
    for (const f of FIELDS) clean[f] = String(profile?.[f] ?? '').slice(0, 300);
    this.store.data.profile = clean;
    this.store.data.modified = modified ?? Date.now();
    this.store.save();
    this.emit('changed', { fromSync });
    return clean;
  }
}

module.exports = { autofill: new Autofill(), FIELDS };
