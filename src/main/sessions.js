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

const PAGES_DIR = path.join(__dirname, '..', 'pages');
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

// Google's sign-in refuses browsers it can't identify as Chrome. Besides dropping the
// Electron token from the user agent, make the Client Hints headers say "Google Chrome".
const GOOGLE_HOST = /(^|.)(google.[a-z.]+|youtube.com|gstatic.com|googleusercontent.com)$/i;
function googleBrandHeaders() {
  const major = String(process.versions.chrome || '130').split('.')[0];
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="99"`,
    'sec-ch-ua-full-version-list': `"Chromium";v="${process.versions.chrome}", "Google Chrome";v="${process.versions.chrome}", "Not.A/Brand";v="99.0.0.0"`
  };
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

function isThirdParty(details) {
  if (details.resourceType === 'mainFrame') return false;
  const top = topLevelUrl(details);
  if (!/^https?:/i.test(top)) return false;
  const reqSite = siteOf(hostOf(details.url));
  const topSite = siteOf(hostOf(top));
  return !!reqSite && !!topSite && reqSite !== topSite;
}

function configureWebRequest(ses) {
  const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };

  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders;
    if (settings.get('doNotTrack')) {
      headers.DNT = '1';
      headers['Sec-GPC'] = '1';
    }
    if (settings.get('blockThirdPartyCookies') && isThirdParty(details)) {
      delete headers.Cookie;
      delete headers.cookie;
    }
    if (GOOGLE_HOST.test(hostOf(details.url))) {
      for (const k of Object.keys(headers)) if (/^sec-ch-ua(-full-version-list)?$/i.test(k)) delete headers[k];
      Object.assign(headers, googleBrandHeaders());
    }
    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    if (!settings.get('blockThirdPartyCookies') || !details.responseHeaders || !isThirdParty(details)) {
      callback({});
      return;
    }
    const responseHeaders = {};
    for (const [k, v] of Object.entries(details.responseHeaders)) {
      if (k.toLowerCase() !== 'set-cookie') responseHeaders[k] = v;
    }
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
  const ses = session.defaultSession;
  const jobs = [];
  if (what.history) history.clear(since);
  if (what.downloads) downloads.clearFinished(since);
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
  if (what.permissions) settings.set('sitePermissions', {});
  if (what.passwords && !(since > 0)) require('./passwords').passwords.clearAll();
  if (what.autofill && !(since > 0)) require('./autofill').autofill.set({});
  await Promise.allSettled(jobs);
  return true;
}

module.exports = { configureSession, defaultSession, newPrivateSession, clearBrowsingData, setPermissionPrompter, cleanUserAgent };
