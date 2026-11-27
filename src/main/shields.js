'use strict';
// Vexa Shields — the live part: which protections apply to a site, what each tab has
// blocked, and the decisions the network layer (sessions.js) and tabs (tab.js) ask for.

const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { settings } = require('./settings');
const { JsonStore } = require('./store');
const { siteOf, hostOf, isGoogleAccountsHost } = require('./url');
const rules = require('./shields-rules');

const { PROTECTIONS } = rules;
const EMPTY_STATS = () => ({ ads: 0, trackers: 0, cookies: 0, fingerprinting: 0, https: 0, params: 0, popups: 0, malicious: 0 });

class Shields extends EventEmitter {
  constructor() {
    super();
    this.tabs = new Map(); // webContents id -> { stats, isPrivate, session, onChange, timer, mainRequestId, fpSeen:Set }
    this.sessionState = new WeakMap(); // session -> { key, privateSites: Map, httpOnly: Set, upgraded: Map, proceed: Set }
    this.maliciousBlocks = new Map(); // webContents id -> blocked main-frame URL
    this.totals = null;
  }

  init() {
    // Lifetime count for the New Tab widget (normal windows only).
    this.totals = new JsonStore(path.join(app.getPath('userData'), 'shields-stats.json'), { blocked: 0, since: Date.now() }, { delay: 5000 });
  }

  // ------------------------------------------------------------------ per-session state
  state(ses) {
    let s = this.sessionState.get(ses);
    if (!s) {
      s = { key: crypto.randomBytes(32), privateSites: new Map(), httpOnly: new Set(), upgraded: new Map(), proceed: new Set(), isPrivate: false };
      this.sessionState.set(ses, s);
    }
    return s;
  }

  markPrivate(ses) {
    this.state(ses).isPrivate = true;
  }

  // ------------------------------------------------------------------ what applies where
  /** Site overrides: private windows keep theirs in memory so they never reach disk. */
  siteOverrides(site, ses) {
    const saved = settings.get('shieldsSites')[site] || {};
    const priv = ses ? this.state(ses).privateSites.get(site) : null;
    return { ...saved, ...(priv || {}) };
  }

  /** Effective protections for a site: { enabled, ads, trackers, ... } */
  forSite(site, ses) {
    const defaults = settings.get('shields');
    const o = this.siteOverrides(site, ses);
    const enabled = o.enabled !== false;
    const out = { enabled };
    for (const p of PROTECTIONS) out[p] = enabled && (o[p] ?? defaults[p]);
    return out;
  }

  forUrl(url, ses) {
    return this.forSite(siteOf(hostOf(url)), ses);
  }

  /** Change a site's Shields. `patch` = { enabled?, [protection]? }, a value of null removes the override. */
  setSite(site, patch, ses) {
    if (!site) return;
    const isPrivate = ses && this.state(ses).isPrivate;
    const current = isPrivate ? { ...(this.state(ses).privateSites.get(site) || {}) } : { ...(settings.get('shieldsSites')[site] || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
      if (k !== 'enabled' && !PROTECTIONS.includes(k)) continue;
      const def = k === 'enabled' ? true : settings.get('shields')[k];
      if (v == null || v === def) delete current[k];
      else current[k] = !!v;
    }
    if (isPrivate) {
      if (Object.keys(current).length) this.state(ses).privateSites.set(site, current);
      else this.state(ses).privateSites.delete(site);
      this.emit('changed');
      return;
    }
    const all = { ...settings.get('shieldsSites') };
    if (Object.keys(current).length) all[site] = current;
    else delete all[site];
    settings.set('shieldsSites', all);
  }

  resetSite(site, ses) {
    if (ses && this.state(ses).isPrivate) this.state(ses).privateSites.delete(site);
    const all = { ...settings.get('shieldsSites') };
    if (all[site]) {
      delete all[site];
      settings.set('shieldsSites', all);
    } else this.emit('changed');
  }

  // ------------------------------------------------------------------ tabs + counting
  attachTab(wc, { isPrivate, session, onChange }) {
    const id = wc.id;
    this.tabs.set(id, { stats: EMPTY_STATS(), isPrivate, session, onChange, timer: null, mainRequestId: null, fpSeen: new Set() });
    wc.once('destroyed', () => {
      const t = this.tabs.get(id);
      if (t) clearTimeout(t.timer);
      this.tabs.delete(id);
      this.maliciousBlocks.delete(id);
    });
  }

  stats(wcId) {
    return this.tabs.get(wcId)?.stats || EMPTY_STATS();
  }

  resetStats(wcId) {
    const t = this.tabs.get(wcId);
    if (!t) return;
    t.stats = EMPTY_STATS();
    t.fpSeen = new Set();
    this._notify(t);
  }

  count(wcId, kind, n = 1) {
    const t = this.tabs.get(wcId);
    if (!t || !n) return;
    t.stats[kind] += n;
    if (!t.isPrivate && this.totals) {
      this.totals.data.blocked += n;
      this.totals.save();
    }
    this._notify(t);
  }

  _notify(t) {
    // Pages can make hundreds of blocked requests; batch the UI updates.
    if (t.timer) return;
    t.timer = setTimeout(() => {
      t.timer = null;
      try {
        t.onChange();
      } catch {
        /* tab gone */
      }
    }, 150);
  }

  lifetime() {
    return { blocked: this.totals?.data.blocked || 0, since: this.totals?.data.since || Date.now() };
  }

  // ------------------------------------------------------------------ network decisions
  /**
   * Called from webRequest.onBeforeRequest. Returns the callback response.
   * @param {object} d   Electron request details
   * @param {Electron.Session} ses
   * @param {string} topUrl  the top-level page URL (for sub-resources)
   */
  beforeRequest(d, ses, topUrl) {
    const wcId = d.webContentsId;
    const isMain = d.resourceType === 'mainFrame';
    const tab = wcId != null ? this.tabs.get(wcId) : null;
    if (isMain && tab && tab.mainRequestId !== d.id) {
      // A new page (redirects keep the same request id, so their counts are kept).
      tab.mainRequestId = d.id;
      tab.stats = EMPTY_STATS();
      tab.fpSeen = new Set();
      this._notify(tab);
    }
    const st = this.state(ses);
    const host = hostOf(d.url);

    if (isMain) {
      const p = this.forUrl(d.url, ses);
      // Dangerous sites: stop the navigation; the tab shows a warning page.
      if (settings.get('shields').malicious && p.malicious !== false && !st.proceed.has(host) && rules.isMaliciousHost(host)) {
        if (wcId != null) this.maliciousBlocks.set(wcId, d.url);
        this.count(wcId, 'malicious');
        return { cancel: true };
      }
      if (p.params) {
        const { url, removed } = rules.stripTrackingParams(d.url);
        if (removed) {
          this.count(wcId, 'params', removed);
          return { redirectURL: url };
        }
      }
      if (p.https && !st.httpOnly.has(host)) {
        const https = rules.httpsUpgradeCandidate(d.url);
        if (https) {
          st.upgraded.set(https, d.url);
          if (st.upgraded.size > 500) st.upgraded.delete(st.upgraded.keys().next().value);
          this.count(wcId, 'https');
          return { redirectURL: https };
        }
      }
      return {};
    }

    // Sub-resources and sub-frames: decided by the top-level site's Shields.
    if (!/^https?:/i.test(topUrl)) return {};
    const p = this.forUrl(topUrl, ses);
    if (!p.enabled) return {};
    if (p.malicious && rules.isMaliciousHost(host)) {
      this.count(wcId, 'malicious');
      return { cancel: true };
    }
    const reqSite = siteOf(host);
    const topSite = siteOf(hostOf(topUrl));
    if (!reqSite || reqSite === topSite) return {}; // only third parties are blocked
    const kind = rules.classify(d.url);
    if (kind && p[kind]) {
      this.count(wcId, kind);
      return { cancel: true };
    }
    if (d.resourceType === 'subFrame' && p.params) {
      const { url, removed } = rules.stripTrackingParams(d.url);
      if (removed) {
        this.count(wcId, 'params', removed);
        return { redirectURL: url };
      }
    }
    return {};
  }

  /** Should third-party cookies be stripped for this request (top-level page URL given)? */
  blocksCookies(topUrl, ses) {
    return this.forUrl(topUrl, ses).cookies;
  }

  /** The tab's main-frame load failed: if it was an HTTPS upgrade, return the http:// URL to fall back to. */
  httpsFallback(ses, failedUrl) {
    const st = this.state(ses);
    const original = st.upgraded.get(failedUrl);
    if (!original) return null;
    st.upgraded.delete(failedUrl);
    st.httpOnly.add(hostOf(original)); // don't try https on this host again this session
    return original;
  }

  /** A main-frame load ended in ERR_BLOCKED_BY_CLIENT: was it a dangerous site? */
  takeMaliciousBlock(wcId, url) {
    const blocked = this.maliciousBlocks.get(wcId);
    if (!blocked) return null;
    this.maliciousBlocks.delete(wcId);
    return blocked === url || hostOf(blocked) === hostOf(url) ? blocked : null;
  }

  /** "Continue anyway" on the dangerous-site warning: allow that host for this session. */
  proceed(ses, url) {
    this.state(ses).proceed.add(hostOf(url));
  }

  // ------------------------------------------------------------------ fingerprinting
  /** Config for the page preload: whether to protect, and a per-session, per-site seed. */
  pageConfig(ses, url) {
    if (!/^https?:/i.test(url)) return { fingerprinting: false };
    const host = hostOf(url);
    const site = siteOf(host);
    const p = this.forSite(site, ses);
    if (!p.fingerprinting) return { fingerprinting: false };
    // Google's sign-in pages check that canvas / graphics / audio readings are genuine and
    // refuse the sign-in ("This browser or app may not be secure") when they look altered.
    // They're left untouched there, unless the user turned fingerprinting protection on for
    // that site explicitly from the Shields panel. See docs/COMPATIBILITY.md.
    if (isGoogleAccountsHost(host) && this.siteOverrides(site, ses).fingerprinting !== true) return { fingerprinting: false, exempt: 'google-sign-in' };
    const seed = crypto.createHmac('sha256', this.state(ses).key).update(site).digest().readUInt32LE(0);
    return { fingerprinting: true, seed };
  }

  /** The page reported a fingerprinting API it was stopped from reading. Counted once per API per page. */
  fingerprintAttempt(wcId, api) {
    const t = this.tabs.get(wcId);
    if (!t || t.fpSeen.has(api) || t.fpSeen.size > 20) return;
    t.fpSeen.add(api);
    this.count(wcId, 'fingerprinting');
  }

  // ------------------------------------------------------------------ popups
  /** Block a window.open? `gestureAge` = ms since the user last clicked or pressed a key in the tab. */
  blocksPopup(openerUrl, targetUrl, ses, gestureAge) {
    const p = this.forUrl(openerUrl, ses);
    if (!p.popups) return false;
    if (rules.isMaliciousHost(hostOf(targetUrl)) || (rules.classify(targetUrl) === 'ads' && p.ads)) return true;
    return !(gestureAge >= 0 && gestureAge < 5000);
  }
}

module.exports = { shields: new Shields(), EMPTY_STATS };
