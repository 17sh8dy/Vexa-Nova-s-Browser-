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
  // ------------------------------------------------------------------ Vexa Shields: fingerprinting
  // Ask the main process (synchronously, before any page script runs) whether this site
  // has fingerprinting protection on, then install it in the page's world.
  let pageCfg = null;
  try {
    pageCfg = ipcRenderer.sendSync('vexa:shields-page');
    if (pageCfg && pageCfg.fingerprinting && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: protect, args: [pageCfg.seed >>> 0, (api) => ipcRenderer.send('vexa:shields-fp', String(api).slice(0, 20))] });
    }
  } catch (err) {
    console.warn('[vexa] fingerprinting protection unavailable:', err && err.message);
  }

  // ------------------------------------------------------------------ Google sign-in (compatibility mode)
  // Optional (Settings → Compatibility, see docs/COMPATIBILITY.md): the Client Hints headers
  // carry the Chrome brand on Google's hosts; this makes navigator.userAgentData agree with
  // them there. Off = Vexa reports the honest Chromium brand list everywhere.
  if (pageCfg && pageCfg.googleCompat && /(^|\.)(google\.[a-z.]+|youtube\.com)$/i.test(location.hostname)) {
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

// Vexa Shields fingerprinting protection. `protect` is run in the PAGE's world (via
// contextBridge.executeInMainWorld) before any page script, so it must be self-contained.
//
// Approach ("farbling"): the values fingerprinting scripts read are nudged by an amount
// nobody can see or hear, using a seed that is fixed for one site in one browsing session
// and different everywhere else. Sites keep working; the reading stops identifying you
// across sites and sessions.
//   - canvas readback (toDataURL / toBlob / getImageData): a few pixel bits flipped
//   - WebGL: GPU model hidden behind the generic renderer string; readPixels farbled
//   - Web Audio sample reads: inaudible noise (about 1e-7)
//   - navigator.hardwareConcurrency: a plausible value between 2 and the real count
// Not covered: fonts, workers, cross-origin frames (they get their own pass when loaded).

function protect(seed, report) {
  const rnd = (n) => {
    let t = (seed + Math.imul(n, 0x6d2b79f5)) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const noted = new Set();
  const note = (api) => {
    if (noted.has(api)) return;
    noted.add(api);
    try {
      report(api);
    } catch {
      /* ignore */
    }
  };
  const done = new WeakSet();

  // Replace proto[name] with make(original), keeping the property's shape and name.
  const wrap = (proto, name, make) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== 'function') return;
    const orig = desc.value;
    const fn = make(orig);
    Object.defineProperty(fn, 'name', { value: name });
    Object.defineProperty(fn, 'length', { value: orig.length });
    Object.defineProperty(proto, name, { ...desc, value: fn });
  };

  function farblePixels(data) {
    const pixels = Math.floor(data.length / 4);
    if (!pixels) return;
    const flips = Math.min(64, Math.max(4, Math.floor(pixels / 2000)));
    for (let i = 0; i < flips; i++) {
      const p = Math.floor(rnd(i + 1) * pixels) * 4;
      const ch = Math.floor(rnd(i + 7919) * 3);
      data[p + ch] ^= 1;
    }
  }

  function apply(w) {
    if (!w || done.has(w)) return;
    done.add(w);
    let origGetImageData = null;

    // ---------------------------------------------------------------- canvas 2D
    wrap(w.CanvasRenderingContext2D && w.CanvasRenderingContext2D.prototype, 'getImageData', (orig) => {
      origGetImageData = orig;
      return function (...args) {
        const img = orig.apply(this, args);
        note('canvas');
        farblePixels(img.data);
        return img;
      };
    });
    const farbledCopy = (canvas) => {
      const wdt = canvas.width;
      const hgt = canvas.height;
      if (!wdt || !hgt || wdt * hgt > 16e6 || !origGetImageData) return null;
      const copy = w.document.createElement('canvas');
      copy.width = wdt;
      copy.height = hgt;
      const ctx = copy.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const img = origGetImageData.call(ctx, 0, 0, wdt, hgt);
      farblePixels(img.data);
      ctx.putImageData(img, 0, 0);
      return copy;
    };
    for (const name of ['toDataURL', 'toBlob']) {
      wrap(w.HTMLCanvasElement && w.HTMLCanvasElement.prototype, name, (orig) => function (...args) {
        note('canvas');
        let copy = null;
        try {
          copy = farbledCopy(this);
        } catch {
          copy = null;
        }
        return orig.apply(copy || this, args);
      });
    }

    // ---------------------------------------------------------------- WebGL
    const UNMASKED_VENDOR = 0x9245;
    const UNMASKED_RENDERER = 0x9246;
    for (const C of [w.WebGLRenderingContext, w.WebGL2RenderingContext]) {
      if (!C) continue;
      wrap(C.prototype, 'getParameter', (orig) => function (p) {
        if (p === UNMASKED_VENDOR || p === UNMASKED_RENDERER) {
          note('webgl');
          return orig.call(this, p === UNMASKED_VENDOR ? 0x1f00 : 0x1f01); // VENDOR / RENDERER
        }
        return orig.apply(this, arguments);
      });
      wrap(C.prototype, 'readPixels', (orig) => function (...args) {
        const r = orig.apply(this, args);
        const out = args[6];
        if (out && out instanceof w.Uint8Array) {
          note('webgl');
          farblePixels(out);
        }
        return r;
      });
    }

    // ---------------------------------------------------------------- Web Audio
    const touched = new WeakSet();
    const farbleSamples = (arr) => {
      if (!arr || touched.has(arr)) return;
      touched.add(arr);
      for (let i = 0; i < arr.length; i += 97) arr[i] += (rnd(i + 31) - 0.5) * 2e-7;
    };
    if (w.AudioBuffer) {
      wrap(w.AudioBuffer.prototype, 'getChannelData', (orig) => function (...args) {
        const arr = orig.apply(this, args);
        note('audio');
        farbleSamples(arr);
        return arr;
      });
      wrap(w.AudioBuffer.prototype, 'copyFromChannel', (orig) => function (...args) {
        const r = orig.apply(this, args);
        note('audio');
        const dest = args[0];
        if (dest) for (let i = 0; i < dest.length; i += 97) dest[i] += (rnd(i + 31) - 0.5) * 2e-7;
        return r;
      });
    }
    if (w.AnalyserNode) {
      wrap(w.AnalyserNode.prototype, 'getFloatFrequencyData', (orig) => function (...args) {
        const r = orig.apply(this, args);
        note('audio');
        const a = args[0];
        if (a) for (let i = 0; i < a.length; i += 7) a[i] += (rnd(i + 53) - 0.5) * 1e-4;
        return r;
      });
    }

    // ---------------------------------------------------------------- CPU count
    try {
      const NavProto = w.Navigator && w.Navigator.prototype;
      const d = NavProto && Object.getOwnPropertyDescriptor(NavProto, 'hardwareConcurrency');
      if (d && d.get) {
        const real = d.get.call(w.navigator);
        if (real > 2) {
          const value = 2 + Math.floor(rnd(4242) * (real - 1));
          const getter = { get hardwareConcurrency() { return value; } };
          Object.defineProperty(NavProto, 'hardwareConcurrency', { ...d, get: Object.getOwnPropertyDescriptor(getter, 'hardwareConcurrency').get });
        }
      }
    } catch {
      /* ignore */
    }

    // ---------------------------------------------------------------- same-origin frames
    // A script could create an about:blank iframe and use its untouched canvas; protect
    // such frames the moment their window is reached.
    const IF = w.HTMLIFrameElement && w.HTMLIFrameElement.prototype;
    for (const prop of ['contentWindow', 'contentDocument']) {
      const d = IF && Object.getOwnPropertyDescriptor(IF, prop);
      if (!d || !d.get) continue;
      const get = d.get;
      const holder = {
        get [prop]() {
          const v = get.call(this);
          try {
            const win = prop === 'contentWindow' ? v : v && v.defaultView;
            if (win && win.document) apply(win);
          } catch {
            /* cross-origin */
          }
          return v;
        }
      };
      Object.defineProperty(IF, prop, { ...d, get: Object.getOwnPropertyDescriptor(holder, prop).get });
    }
  }

  apply(window);
}
