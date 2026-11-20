'use strict';
// Per-session configuration: vexa:// protocol, privacy headers, third-party
// cookie blocking, and permission handling.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, net, session } = require('electron');
const { settings } = require('./settings');
const { downloads } = require('./downloads');
const { siteOf, hostOf, originOf, INTERNAL_PAGES } = require('./url');
const vexaSearch = require('./vexa-search');
const { shields } = require('./shields');

const PAGES_DIR = path.join(__dirname, '..', 'pages');
const PAGE_PRELOAD = path.join(__dirname, '..', 'preload', 'internal.js');
const RENDERER_SHARED = path.join(__dirname, '..', 'renderer', 'shared');

// Permissions that are granted without asking (they're user-initiated or harmless).
const ALWAYS_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'keyboardLock', 'mediaKeySystem', 'speaker-selection', 'fileSystem', 'storage-access', 'top-level-storage-access', 'window-management']);
// Permissions we prompt for (subject to the user's defaults in settings).
const PROMPTABLE = new Set(['media', 'geolocation', 'notifications', 'midiSysex', 'clipboard-read', 'display-capture']);
// One-off prompts that are never remembered.
const ONE_OFF = new Set(['openExternal']);

const CSP = "default-src 'self' vexa:; img-src 'self' vexa: data: https: http: blob:; style-src 'self' vexa: 'unsafe-inline'; script-src 'self' vexa:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'";

let prompter = null; // (webContents, request) => Promise<{ decision: 'allow'|'block'|'dismiss', remember: boolean }>
const configured = new WeakSet();
let privateCounter = 0;
const privateDecisions = new WeakMap(); // session -> Map(origin|perm -> decision)

function setPermissionPrompter(fn) {
  prompter = fn;
}

function cleanUserAgent() {
  // Drop "Electron/x" and "vexa/x" tokens so sites see a standard Chrome UA.
  return app.userAgentFallback
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp(`\\s${app.getName()}\\/\\S+`, 'i'), '')
    .replace(/\svexa\/\S+/i, '');
}

// Google sign-in compatibility (docs/COMPATIBILITY.md). Optional Chrome brand in Client
// Hints on Google's own hosts — see isGoogleHost / googleBrandHeaders in url.js.
const { isGoogleHost, isGoogleSignInUrl, googleBrandHeaders: brandHeaders } = require('./url');
const googleBrandHeaders = () => brandHeaders(process.versions.chrome);
const GOOGLE_HOST = { test: (h) => isGoogleHost(h) };

// "Sign in with Google" buttons (Google Identity Services) on other sites run in an
// accounts.google.com iframe that needs the user's Google cookies to show who is signed in.
// Cross-site cookie blocking would strip them and the button silently fails. Like Brave's
// "Allow Google login buttons on third-party sites", Vexa exempts only that endpoint, and
// only while Settings → Compatibility → "Google sign-in buttons on other sites" is on.
// Nothing else Google loads on other sites (ads, analytics, fonts…) is exempted.
function isGoogleSignInButton(details) {
  return !!settings.get('googleSignInButtons') && isGoogleSignInUrl(details.url);
}

function registerProtocol(ses, isPrivate = false) {
  ses.protocol.handle('vexa', async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const host = url.hostname;
    // Vexa Search (beta) has its own handler and is not a privileged page.
    if (host === 'search') return vexaSearch.handleRequest(request.url);
    // The user's own New Tab wallpapers: image bytes from the profile, same origin as the page.
    if (host === 'newtab' && url.pathname.startsWith('/uploads/')) return require('./wallpapers').wallpapers.serve(url.pathname.slice('/uploads/'.length));
    // Images and videos saved in Collections (same origin as vexa://collections).
    if (host === 'collections' && url.pathname.startsWith('/files/')) return require('./collections').collections.serve(url.pathname.slice('/files/'.length));
    if (!INTERNAL_PAGES.includes(host) && host !== 'shared') {
      return new Response(`<!doctype html><meta charset=utf-8><title>Not found</title><body style="font-family:system-ui;padding:40px">vexa://${host} doesn't exist.`, {
        status: 404,
        headers: { 'content-type': 'text/html' }
      });
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    // vexa://shared/ also serves the browser UI's design tokens and icons, so there's one source of truth.
    const baseDirs = host === 'shared' ? [path.join(PAGES_DIR, 'shared'), RENDERER_SHARED] : [path.join(PAGES_DIR, host)];
    let file = null;
    for (const baseDir of baseDirs) {
      const candidate = path.normalize(path.join(baseDir, rel));
      if (!candidate.startsWith(baseDir + path.sep)) return new Response('Forbidden', { status: 403 });
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        file = candidate;
        break;
      }
    }
    if (!file) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(res.headers);
    if (isPrivate && file.endsWith('.html')) {
      // Private windows get the private (dark indigo) look on internal pages too.
      const html = (await res.text()).replace('<html lang="en">', '<html lang="en" class="private">');
      headers.set('content-security-policy', CSP);
      return new Response(html, { status: res.status, headers });
    }
    if (file.endsWith('.html')) headers.set('content-security-policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

function topLevelUrl(details) {
  try {
    if (details.frame && details.frame.top) return details.frame.top.url;
  } catch {
    /* frame may be gone */
  }
  try {
    if (details.webContents) return details.webContents.getURL();
  } catch {
    /* destroyed */
  }
  return details.referrer || '';
}

function isThirdParty(details, top = topLevelUrl(details)) {
  if (details.resourceType === 'mainFrame') return false;
  if (!/^https?:/i.test(top)) return false;
  const reqSite = siteOf(hostOf(details.url));
  const topSite = siteOf(hostOf(top));
  return !!reqSite && !!topSite && reqSite !== topSite;
}

function configureWebRequest(ses) {
  const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };

  // Vexa Shields: block ads/trackers/dangerous hosts, remove tracking parameters, upgrade to HTTPS.
  ses.webRequest.onBeforeRequest(filter, (details, callback) => {
    try {
      callback(shields.beforeRequest(details, ses, details.resourceType === 'mainFrame' ? '' : topLevelUrl(details)));
    } catch (err) {
      console.error('[vexa] shields:', err.message);
      callback({});
    }
  });

  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders;
    if (settings.get('doNotTrack')) {
      headers.DNT = '1';
      headers['Sec-GPC'] = '1';
    }
    const top = details.resourceType === 'mainFrame' ? '' : topLevelUrl(details);
    if (isThirdParty(details, top) && shields.blocksCookies(top, ses) && !isGoogleSignInButton(details)) {
      if (headers.Cookie || headers.cookie) shields.count(details.webContentsId, 'cookies');
      delete headers.Cookie;
      delete headers.cookie;
    }
    // Opt-out compatibility mode (Settings → Compatibility): Chrome brand in Client Hints on Google's hosts.
    if (settings.get('googleCompat') && GOOGLE_HOST.test(hostOf(details.url))) {
      for (const k of Object.keys(headers)) if (/^sec-ch-ua(-full-version-list)?$/i.test(k)) delete headers[k];
      Object.assign(headers, googleBrandHeaders());
    }
    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const top = details.resourceType === 'mainFrame' ? '' : topLevelUrl(details);
    if (!details.responseHeaders || !isThirdParty(details, top) || !shields.blocksCookies(top, ses) || isGoogleSignInButton(details)) {
      callback({});
      return;
    }
    const responseHeaders = {};
    let dropped = false;
    for (const [k, v] of Object.entries(details.responseHeaders)) {
      if (k.toLowerCase() !== 'set-cookie') responseHeaders[k] = v;
      else dropped = true;
    }
    if (dropped) shields.count(details.webContentsId, 'cookies');
    callback({ responseHeaders });
  });
}

function decisionFor(ses, origin, permission, isPrivate) {
  if (isPrivate) {
    const d = privateDecisions.get(ses)?.get(origin + '|' + permission);
    if (d) return d;
  }
  const site = settings.sitePermission(origin, permission);
  if (site) return site;
  const def = settings.get('permissionDefaults')[permission];
  return def === 'block' ? 'block' : 'ask';
}

function configurePermissions(ses, isPrivate) {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (ALWAYS_ALLOW.has(permission)) return callback(true);
    const origin = originOf(details.requestingUrl || webContents.getURL());
    // Internal pages get nothing they didn't ask for.
    if (!origin || origin.startsWith('vexa:')) return callback(permission === 'clipboard-read');
    if (!PROMPTABLE.has(permission) && !ONE_OFF.has(permission)) return callback(false);

    if (PROMPTABLE.has(permission)) {
      const d = decisionFor(ses, origin, permission, isPrivate);
      if (d === 'allow') return callback(true);
      if (d === 'block') return callback(false);
    }
    if (!prompter) return callback(false);

    prompter(webContents, { permission, origin, mediaTypes: details.mediaTypes || [], externalURL: details.externalURL, oneOff: ONE_OFF.has(permission) })
      .then(({ decision, remember }) => {
        if (remember && decision !== 'dismiss' && PROMPTABLE.has(permission)) {
          if (isPrivate) {
            if (!privateDecisions.has(ses)) privateDecisions.set(ses, new Map());
            privateDecisions.get(ses).set(origin + '|' + permission, decision);
          } else {
            settings.setSitePermission(origin, permission, decision);
          }
        }
        callback(decision === 'allow');
      })
      .catch(() => callback(false));
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (ALWAYS_ALLOW.has(permission)) return true;
    if (!PROMPTABLE.has(permission)) return false;
    const origin = originOf(requestingOrigin);
    if (!origin) return false;
    return decisionFor(ses, origin, permission, isPrivate) === 'allow';
  });
}

function configureSession(ses, { isPrivate = false } = {}) {
  if (configured.has(ses)) return ses;
  configured.add(ses);
  if (isPrivate) shields.markPrivate(ses);
  // Vexa's page preload (vexa:// page API, password manager, Shields fingerprinting glue).
  // Registered on the session rather than per tab, so it also runs in tabs that a page
  // opened itself (target=_blank, window.open): those are created before Vexa can set
  // their preferences. Never for the browser's own file:// UI.
  ses.registerPreloadScript({ type: 'frame', id: 'vexa-page', filePath: PAGE_PRELOAD, matches: ['http://*/*', 'https://*/*', 'vexa://*/*'] });
  ses.setUserAgent(cleanUserAgent());
  registerProtocol(ses, isPrivate);
  configureWebRequest(ses);
  configurePermissions(ses, isPrivate);
  ses.setSpellCheckerEnabled(true);
  downloads.attach(ses, { isPrivate });
  return ses;
}

function defaultSession() {
  return configureSession(session.defaultSession);
}

function newPrivateSession() {
  // A partition name without "persist:" lives only in memory.
  const ses = session.fromPartition(`vexa-private-${++privateCounter}-${Date.now()}`);
  return configureSession(ses, { isPrivate: true });
}

/**
 * Clear browsing data. `what` = { history, cookies, cache, downloads, permissions, passwords, autofill }.
 * `since` (ms timestamp, 0 = all time) applies to history and the download list. Chromium
 * can't clear cookies, site data or the cache by time range, so those are only ever
 * cleared for "all time" — with a range they are skipped rather than over-deleting.
 */
async function clearBrowsingData(what, { since = 0 } = {}) {
  const { history } = require('./history');
  // The default session plus every isolated Space's own partition.
  let sessions = [session.defaultSession];
  try {
    sessions = sessions.concat(require('./spaces').spaces.isolatedSessions());
  } catch {
    /* spaces not ready */
  }
  const jobs = [];
  if (what.history) {
    history.clear(since);
    try {
      require('./search-history').searchHistory.clear(since);
    } catch {
      /* not ready */
    }
  }
  if (what.downloads) downloads.clearFinished(since);
  for (const ses of sessions) {
    if (what.cookies && !(since > 0)) {
      jobs.push(
        ses.clearStorageData({
          storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
        })
      );
      jobs.push(ses.clearAuthCache());
    }
    if (what.cache && !(since > 0)) {
      jobs.push(ses.clearCache());
      jobs.push(ses.clearCodeCaches({}));
      jobs.push(ses.clearHostResolverCache());
    }
  }
  if (what.permissions) settings.set('sitePermissions', {});
  if (what.passwords && !(since > 0)) require('./passwords').passwords.clearAll();
  if (what.autofill && !(since > 0)) require('./autofill').autofill.set({});
  await Promise.allSettled(jobs);
  return true;
}

module.exports = { configureSession, defaultSession, newPrivateSession, clearBrowsingData, setPermissionPrompter, cleanUserAgent };
