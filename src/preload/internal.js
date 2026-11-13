'use strict';
// Preload for every tab.
//  - On Vexa's own vexa:// pages it exposes the `vexa` API.
//  - On ordinary websites it exposes NOTHING to the page. It only runs the password
//    manager / form autofill glue, talking to the main process over IPC from this
//    isolated world (the page cannot see or call any of it).
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// vexa://search shows text from the open web, so it never gets the API.
if (location.protocol === 'vexa:' && location.hostname !== 'search') {
  const listeners = new Map();
  ipcRenderer.on('vexa:event', (_e, name, payload) => {
    for (const fn of listeners.get(name) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(err);
      }
    }
  });

  contextBridge.exposeInMainWorld('vexa', {
    call: (method, ...args) => ipcRenderer.invoke('vexa:api', method, ...args),
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    }
  });
} else if (/^https?:$/.test(location.protocol)) {
  // ------------------------------------------------------------------ Google sign-in
  // Google refuses sign-in from browsers it can't recognise as Chrome. The user agent
  // and Client Hints headers are fixed in the main process; this makes the JavaScript
  // view (navigator.userAgentData) agree with them, on Google's sign-in hosts only.
  if (/(^|\.)(google\.[a-z.]+|youtube\.com)$/i.test(location.hostname)) {
    try {
      webFrame.executeJavaScript(`(() => {
        const nav = navigator;
        if (!nav.userAgentData) return;
        const major = (/Chrome\\/(\\d+)/.exec(nav.userAgent) || [])[1] || '130';
        const brands = [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not.A/Brand', version: '99' }];
        const proto = Object.getPrototypeOf(nav.userAgentData);
        const origHigh = proto.getHighEntropyValues;
        Object.defineProperty(proto, 'brands', { get: () => brands, configurable: true });
        proto.getHighEntropyValues = function (hints) {
          return origHigh.call(this, hints).then((v) => {
            if (v.brands) v.brands = brands;
            if (v.fullVersionList) v.fullVersionList = brands.map((b) => ({ brand: b.brand, version: b.version + '.0.0.0' }));
            return v;
          });
        };
      })()`);
    } catch {
      /* best effort */
    }
  }

  // ------------------------------------------------------------------ helpers
  const TEXTISH = new Set(['', 'text', 'email', 'tel', 'search', 'url']);
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const passwordFields = (root = document) => [...root.querySelectorAll('input[type="password"]')];
  const isLoginPassword = (el) => !/^(new-password|one-time-code)$/i.test(el.autocomplete || '');

  // Set a value the way a user would, so React/Vue/etc. notice it.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus({ preventScroll: true });
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function usernameFieldFor(pw) {
    const root = pw.form || document;
    const candidates = [...root.querySelectorAll('input')].filter((i) => TEXTISH.has((i.type || '').toLowerCase()) && !i.disabled && !i.readOnly);
    const before = candidates.filter((c) => c.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    const visible = (list) => list.filter(isVisible);
    const byAuto = visible(before).filter((c) => /username|email/i.test(c.autocomplete || ''));
    if (byAuto.length) return byAuto[byAuto.length - 1];
    const v = visible(before);
    return v.length ? v[v.length - 1] : null;
  }

  // ------------------------------------------------------------------ capture logins
  let lastCaptureKey = '';
  function capture(scope) {
    try {
      const pws = passwordFields(scope).filter((p) => p.value);
      if (!pws.length) return;
      // Prefer the "new password" field when changing/creating a password.
      const pw = pws.find((p) => /new-password/i.test(p.autocomplete || '')) || pws[0];
      const userEl = usernameFieldFor(pw);
      const payload = { username: userEl ? userEl.value.trim() : '', password: pw.value };
      const key = payload.username + '\u0000' + payload.password;
      if (key === lastCaptureKey) return;
      lastCaptureKey = key;
      ipcRenderer.send('vexa:pm-capture', payload);
    } catch {
      /* never break the page */
    }
  }
  document.addEventListener('submit', (e) => capture(e.target instanceof HTMLFormElement ? e.target : document), true);
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target instanceof Element ? e.target.closest('button, input[type="submit"], input[type="button"], [role="button"], a') : null;
      if (!t) return;
      const scope = t.closest('form') || document;
      if (passwordFields(scope).some((p) => p.value)) setTimeout(() => capture(scope), 0);
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
        const scope = e.target.closest('form') || document;
        if (passwordFields(scope).some((p) => p.value)) setTimeout(() => capture(scope), 0);
      }
    },
    true
  );

  // ------------------------------------------------------------------ fill logins
  function fillCredential(cred, scope) {
    let pw = passwordFields(scope).find((p) => isVisible(p) && isLoginPassword(p));
    if (!pw && scope !== document) pw = passwordFields(document).find((p) => isVisible(p) && isLoginPassword(p));
    if (!pw) return false;
    const userEl = usernameFieldFor(pw);
    if (userEl && cred.username && !userEl.value) setValue(userEl, cred.username);
    setValue(pw, cred.password);
    return true;
  }

  let autoFillDone = false;
  let autoFillTries = 0;
  async function tryAutoFill() {
    if (autoFillDone || autoFillTries++ > 6) return;
    const pw = passwordFields().find((p) => isVisible(p) && isLoginPassword(p) && !p.value);
    if (!pw) return;
    autoFillDone = true;
    try {
      const creds = await ipcRenderer.invoke('vexa:pm', 'credentials');
      if (Array.isArray(creds) && creds.length === 1 && !pw.value) {
        fillCredential(creds[0], pw.form || document);
        ipcRenderer.send('vexa:pm-used', creds[0].id);
      }
    } catch {
      /* ignore */
    }
  }
  let scanTimer = null;
  const scanSoon = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(tryAutoFill, 350);
  };
  window.addEventListener('DOMContentLoaded', () => {
    scanSoon();
    try {
      new MutationObserver(() => !autoFillDone && scanSoon()).observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  });

  ipcRenderer.on('vexa:pm-fill', (_e, cred) => {
    if (!cred || typeof cred.password !== 'string') return;
    const active = document.activeElement;
    fillCredential(cred, (active && active.form) || document);
  });

  // ------------------------------------------------------------------ fill address / contact details
  const RULES = [
    ['email', /e-?mail/i, /^email$/],
    ['phone', /phone|mobile|tel(ephone)?\b/i, /^tel/],
    ['firstName', /first.?name|given.?name|fname|forename/i, /^given-name$/],
    ['lastName', /last.?name|family.?name|surname|lname/i, /^family-name$/],
    ['organization', /company|organi[sz]ation|employer/i, /^organization$/],
    ['address2', /address.?(line)?.?(2|two)|apt|suite|unit|flat/i, /^address-line2$/],
    ['address1', /street|address.?(line)?.?(1|one)?$|^address$|addr/i, /^(street-address|address-line1)$/],
    ['city', /city|town|suburb/i, /^address-level2$/],
    ['state', /state|province|region|county/i, /^address-level1$/],
    ['zip', /zip|post(al)?.?code|postcode/i, /^postal-code$/],
    ['country', /country/i, /^country(-name)?$/]
  ];

  function hintOf(el) {
    const labels = el.labels ? [...el.labels].map((l) => l.textContent).join(' ') : '';
    return [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labels].filter(Boolean).join(' ');
  }

  function fieldKind(el) {
    const token = (el.autocomplete || '').split(/\s+/).pop() || '';
    for (const [kind, , tokenRe] of RULES) if (token && tokenRe.test(token)) return kind;
    const type = (el.type || '').toLowerCase();
    if (type === 'email') return 'email';
    if (type === 'tel') return 'phone';
    const hint = hintOf(el);
    if (/full.?name|your.?name|^name$/i.test(hint.trim()) || /(^|[\s_-])name$/i.test(el.name || '')) {
      if (!/user|first|last|company|business|card/i.test(hint)) return 'fullName';
    }
    for (const [kind, re] of RULES) if (re.test(hint)) return kind;
    return null;
  }

  function fillSelect(el, wanted) {
    const w = String(wanted).trim().toLowerCase();
    const opt = [...el.options].find((o) => o.value.toLowerCase() === w || o.text.trim().toLowerCase() === w) || [...el.options].find((o) => o.text.trim().toLowerCase().startsWith(w) && w.length > 1);
    if (!opt) return false;
    setValue(el, opt.value);
    return true;
  }

  function fillProfile(profile) {
    const active = document.activeElement;
    const scope = (active && active.form) || document;
    const full = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    let n = 0;
    for (const el of scope.querySelectorAll('input, select, textarea')) {
      if (el.disabled || el.readOnly || !isVisible(el)) continue;
      const type = (el.type || '').toLowerCase();
      if (['password', 'hidden', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(type)) continue;
      const kind = fieldKind(el);
      if (!kind) continue;
      const value = kind === 'fullName' ? full : profile[kind];
      if (!value) continue;
      if (el instanceof HTMLSelectElement) {
        if (fillSelect(el, value)) n++;
      } else if (!el.value || el === active) {
        setValue(el, value);
        n++;
      }
    }
    return n;
  }

  ipcRenderer.on('vexa:af-fill', (_e, profile) => {
    if (profile && typeof profile === 'object') fillProfile(profile);
  });
}
