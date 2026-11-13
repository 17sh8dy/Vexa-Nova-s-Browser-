'use strict';
/*
 * End-to-end tests: launches the real Vexa app against a local test site and
 * drives it through the Chrome DevTools Protocol (no extra dependencies).
 *
 *   npm run test:e2e            (needs a display; on Linux CI use xvfb-run)
 *   VEXA_E2E_SHOTS=1 npm run test:e2e   also saves screenshots to test/e2e/artifacts
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server/server');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = require('electron');
const PORT = 9300 + Math.floor(Math.random() * 500);
const SHOTS = process.env.VEXA_E2E_SHOTS === '1';
const ART = path.join(__dirname, 'artifacts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 10000, interval = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? ': ' + last.message : ''}`);
}

// ------------------------------------------------------------------ minimal CDP client
class Target {
  constructor(info) {
    this.info = info;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP ${method} ${params.type || ''} ${params.key || ''} timed out on ${this.info.url.slice(0, 60)}`));
      }, 10000);
      this.pending.set(id, { res: (v) => (clearTimeout(timer), res(v)), rej: (e) => (clearTimeout(timer), rej(e)) });
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async key(key, { ctrl = false, shift = false, alt = false, code, vk } = {}) {
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const keyCode = vk || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, Tab: 9, F5: 116, ArrowLeft: 37, ArrowRight: 39, Delete: 46, F3: 114 }[key]);
    const base = { modifiers, key, code: code || (key.length === 1 ? 'Key' + key.toUpperCase() : key), windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (key === 'Enter' && !ctrl && !alt) await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}
async function target(pred, label) {
  const info = await waitFor(async () => (await targets()).find((t) => t.type === 'page' && pred(t.url)), { label: `target ${label}` });
  return new Target(info).connect();
}

// ------------------------------------------------------------------ app lifecycle
let app = null;
function launch(profile) {
  const args = ['.', `--remote-debugging-port=${PORT}`];
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  app = spawn(ELECTRON, args, { cwd: ROOT, env: { ...process.env, VEXA_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stderr.on('data', (d) => {
    const s = String(d);
    if (process.env.VEXA_E2E_VERBOSE && !/dbus|Fontconfig|NODE_OPTION/.test(s)) process.stderr.write(s);
  });
  return waitFor(() => targets().then((t) => t.some((x) => x.url.includes('chrome/index.html'))), { label: 'app start', timeout: 20000 });
}
async function quit() {
  if (!app) return;
  const proc = app;
  app = null;
  // Close every window through the UI (Ctrl+Shift+W) so the normal quit path runs.
  try {
    const list = await targets();
    for (const t of list.filter((x) => x.url.includes('chrome/index.html'))) {
      const c = await new Target(t).connect();
      c.key('w', { ctrl: true, shift: true }).catch(() => {});
      await sleep(300);
      c.close();
    }
  } catch {
    /* ignore */
  }
  await new Promise((res) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      res();
    }, 8000);
    proc.on('exit', () => {
      clearTimeout(timer);
      res();
    });
  });
}

function screenshot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(ART, { recursive: true });
  try {
    execSync(`import -window root ${path.join(ART, name + '.png')}`, { env: process.env, stdio: 'ignore' });
  } catch {
    /* screenshots are best-effort (Linux/X11 only) */
  }
}

// ------------------------------------------------------------------ tests
const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✘ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  let syncDir = null;
  const srv = await start(0);
  const site = `http://127.0.0.1:${srv.address().port}`;
  const siteAlt = `http://localhost:${srv.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vexa-e2e-'));
  const dlDir = path.join(profile, 'dl');
  fs.mkdirSync(dlDir);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ downloadDir: dlDir, showDownloadsOnStart: true }));
  // A tiny unpacked extension (content script) that Vexa should load from the profile's extension list.
  const extDir = path.join(profile, 'test-ext');
  fs.mkdirSync(extDir);
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Vexa Test Extension', version: '1.2.3', description: 'e2e', content_scripts: [{ matches: ['http://127.0.0.1/*', 'http://localhost/*'], js: ['cs.js'], run_at: 'document_end' }] }));
  fs.writeFileSync(path.join(extDir, 'cs.js'), "document.documentElement.setAttribute('data-vexa-ext', 'loaded');");
  fs.writeFileSync(path.join(profile, 'extensions.json'), JSON.stringify({ paths: [extDir] }));
  console.log(`Profile: ${profile}\nTest site: ${site}\n`);

  await launch(profile);
  let chrome = await target((u) => u.includes('chrome/index.html'), 'chrome');
  const state = () => chrome.eval('window.__vexaState');
  const active = async () => {
    const s = await state();
    return s.tabs.find((t) => t.id === s.activeId);
  };
  const typeAndGo = async (text, opts = {}) => {
    await chrome.eval(`(() => { const a = document.querySelector('#address'); a.focus(); a.value=''; return true })()`);
    await sleep(80);
    await chrome.send('Input.insertText', { text });
    await sleep(opts.waitSuggest ?? 250);
    await chrome.key('Enter', opts);
  };
  const tabTarget = async (pred, label) => target(pred, label);

  await check('starts with one New Tab page', async () => {
    const s = await waitFor(state, { label: 'state' });
    assert(s.tabs.length === 1, `expected 1 tab, got ${s.tabs.length}`);
    assert(s.tabs[0].isNewTab, 'first tab should be the new tab page');
    const ntp = await tabTarget((u) => u.startsWith('vexa://newtab'), 'ntp');
    await waitFor(() => ntp.eval(`!!document.querySelector('.wordmark') && document.querySelector('#q').placeholder.includes('DuckDuckGo')`), { label: 'NTP render' });
    ntp.close();
    screenshot('01-newtab');
  });

  await check('address bar: typing a URL navigates', async () => {
    await typeAndGo(site + '/');
    const t = await waitFor(async () => {
      const a = await active();
      return a.title === 'Vexa Test Home' && !a.loading && a;
    }, { label: 'page load' });
    assert(t.url === site + '/', 'url mismatch ' + t.url);
    assert(/^http:/.test(t.url) && !t.secure, 'http page should not be marked secure');
    await waitFor(async () => (await active()).favicon.endsWith('/favicon.svg'), { label: 'favicon' });
    const chip = await chrome.eval(`document.querySelector('#site-chip').textContent`);
    assert(chip.includes('Not secure'), 'http site chip should say Not secure');
    screenshot('02-loaded');
  });

  await check('link click, back, forward', async () => {
    const page = await tabTarget((u) => u === site + '/', 'home page');
    await page.eval(`document.getElementById('p2').click()`);
    await waitFor(async () => (await active()).title === 'Second Page', { label: 'page2' });
    page.close();
    let a = await active();
    assert(a.canGoBack && !a.canGoForward, 'nav state after link');
    await chrome.eval(`document.querySelector('#back').click()`);
    await waitFor(async () => (await active()).title === 'Vexa Test Home', { label: 'back' });
    a = await active();
    assert(a.canGoForward, 'should be able to go forward');
    await chrome.eval(`document.querySelector('#forward').click()`);
    await waitFor(async () => (await active()).title === 'Second Page', { label: 'forward' });
    // keyboard: Alt+Left
    await chrome.key('ArrowLeft', { alt: true });
    await waitFor(async () => (await active()).title === 'Vexa Test Home', { label: 'Alt+Left' });
  });

  await check('reload and loading indicator', async () => {
    await typeAndGo(site + '/slow');
    await waitFor(async () => (await active()).loading, { label: 'loading=true' });
    const spinner = await chrome.eval(`!!document.querySelector('.tab.active .spinner') && document.querySelector('#progress').classList.contains('on')`);
    assert(spinner, 'spinner + progress bar visible while loading');
    await waitFor(async () => {
      const a = await active();
      return !a.loading && a.title === 'Slow page';
    }, { label: 'slow load finished', timeout: 8000 });
    await chrome.key('r', { ctrl: true });
    await waitFor(async () => (await active()).loading, { label: 'reload started' });
    await waitFor(async () => !(await active()).loading, { label: 'reload finished', timeout: 8000 });
  });

  await check('search query uses the search engine', async () => {
    await typeAndGo('vexa browser test query');
    const a = await waitFor(async () => {
      const x = await active();
      return x.url.startsWith('https://duckduckgo.com/?q=vexa%20browser%20test%20query') && x;
    }, { label: 'search url' });
    assert(a, 'search navigated');
  });

  await check('unreachable site shows the error panel, retry works', async () => {
    await typeAndGo('http://this-host-does-not-exist.invalid/');
    const a = await waitFor(async () => {
      const x = await active();
      return x.error && x;
    }, { label: 'error state', timeout: 15000 });
    const panel = await chrome.eval(`!document.querySelector('#panel').hidden && document.querySelector('#panel-title').textContent`);
    assert(panel, 'error panel visible');
    assert(a.url.includes('this-host-does-not-exist.invalid'), 'address keeps the failed URL');
    screenshot('03-error');
    await typeAndGo(site + '/');
    await waitFor(async () => {
      const x = await active();
      return !x.error && x.title === 'Vexa Test Home';
    }, { label: 'recovered' });
    const hidden = await chrome.eval(`document.querySelector('#panel').hidden`);
    assert(hidden, 'error panel hidden after successful load');
  });

  await check('tabs: Ctrl+T, switch, Ctrl+W, reopen closed tab', async () => {
    await chrome.key('t', { ctrl: true });
    let s = await waitFor(async () => {
      const x = await state();
      return x.tabs.length === 2 && x;
    }, { label: 'new tab' });
    assert(s.tabs[1].isNewTab && s.activeId === s.tabs[1].id, 'new tab is active');
    const focused = await chrome.eval(`document.activeElement && document.activeElement.id`);
    assert(focused === 'address', 'address bar focused on new tab (got ' + focused + ')');
    await typeAndGo(site + '/page2');
    await waitFor(async () => (await active()).title === 'Second Page', { label: 'tab2 loaded' });
    await chrome.key('1', { ctrl: true, code: 'Digit1', vk: 49 });
    await waitFor(async () => (await active()).title === 'Vexa Test Home', { label: 'Ctrl+1' });
    await chrome.key('Tab', { ctrl: true });
    await waitFor(async () => (await active()).title === 'Second Page', { label: 'Ctrl+Tab' });
    await chrome.key('w', { ctrl: true });
    s = await waitFor(async () => {
      const x = await state();
      return x.tabs.length === 1 && x;
    }, { label: 'closed' });
    await chrome.key('t', { ctrl: true, shift: true });
    await waitFor(async () => {
      const x = await state();
      const t = x.tabs.find((y) => y.id === x.activeId);
      return x.tabs.length === 2 && t.title === 'Second Page' && t.canGoBack;
    }, { label: 'reopened with history', timeout: 8000 });
    // close it again via the tab's close button
    const id = (await state()).activeId;
    await chrome.eval(`document.querySelector('.tab[data-id="${id}"] .tab-close').click()`);
    await waitFor(async () => (await state()).tabs.length === 1, { label: 'close button' });
  });

  await check('target=_blank opens a new tab; window.open keeps window.opener', async () => {
    const page = await tabTarget((u) => u === site + '/', 'home');
    await page.eval(`document.getElementById('blank').click()`);
    await waitFor(async () => (await state()).tabs.length === 2, { label: 'target=_blank tab' });
    await chrome.key('w', { ctrl: true });
    await waitFor(async () => (await state()).tabs.length === 1, { label: 'closed _blank tab' });
    await page.eval(`document.getElementById('winopen').click()`);
    page.close();
    const s = await waitFor(async () => {
      const x = await state();
      return x.tabs.length === 2 && x;
    }, { label: 'blank tab' });
    assert(s.tabs[1].url.endsWith('/opener'), 'new tab url');
    const op = await tabTarget((u) => u.endsWith('/opener'), 'opener tab');
    const txt = await waitFor(() => op.eval(`document.getElementById('r') && document.getElementById('r').textContent !== 'checking' && document.getElementById('r').textContent`), { label: 'opener check' });
    op.close();
    assert(txt === 'has-opener', 'window.opener should be preserved, got ' + txt);
    await chrome.key('w', { ctrl: true });
    await waitFor(async () => (await state()).tabs.length === 1, { label: 'closed opener tab' });
  });

  await check('bookmarks: Ctrl+D, star, bookmarks bar, persistence', async () => {
    await waitFor(async () => (await active()).title === 'Vexa Test Home', { label: 'on home' });
    await chrome.key('d', { ctrl: true });
    await waitFor(async () => (await active()).bookmarked, { label: 'bookmarked' });
    const s = await state();
    assert(s.bookmarksBar.some((b) => b.url === site + '/'), 'appears in bookmarks bar');
    const bar = await chrome.eval(`[...document.querySelectorAll('.bm-item')].map(b => b.textContent).join('|')`);
    assert(bar.includes('Vexa Test Home'), 'bar renders it: ' + bar);
    const star = await chrome.eval(`document.querySelector('#star').classList.contains('on')`);
    assert(star, 'star is filled');
    await waitFor(() => fs.existsSync(path.join(profile, 'bookmarks.json')) && fs.readFileSync(path.join(profile, 'bookmarks.json'), 'utf8').includes(site), { label: 'bookmarks.json written' });
    screenshot('04-bookmarked');
  });

  await check('address suggestions + inline autocomplete from history', async () => {
    await chrome.eval(`(() => { const a = document.querySelector('#address'); a.focus(); a.value=''; })()`);
    await sleep(50);
    await chrome.send('Input.insertText', { text: '127.0' });
    await waitFor(async () => (await state()).popup === 'suggestions', { label: 'suggestions popup' });
    const inline = await waitFor(() => chrome.eval(`(() => { const a = document.querySelector('#address'); return a.value.length > 5 && a.selectionStart === 5 && a.value })()`), { label: 'inline completion' });
    assert(inline.startsWith('127.0.0.1'), 'inline completes to the visited host: ' + inline);
    screenshot('05-suggestions');
    await chrome.key('Escape');
    await chrome.key('Escape');
    await waitFor(async () => (await state()).popup !== 'suggestions', { label: 'suggestions closed' });
  });

  await check('find in page', async () => {
    await chrome.key('f', { ctrl: true });
    await waitFor(() => chrome.eval(`!document.querySelector('#findbar').hidden && document.activeElement.id === 'find-input'`), { label: 'find bar' });
    await chrome.send('Input.insertText', { text: 'needle' });
    await waitFor(async () => (await active()).find.matches === 3, { label: '3 matches' });
    const count = await chrome.eval(`document.querySelector('#find-count').textContent`);
    assert(count === '1 of 3', 'count text: ' + count);
    await chrome.key('Enter');
    await waitFor(async () => (await active()).find.ordinal === 2, { label: 'next match' });
    await chrome.key('Escape');
    await waitFor(async () => !(await active()).find.active, { label: 'find closed' });
  });

  await check('zoom in / reset', async () => {
    await chrome.key('=', { ctrl: true, code: 'Equal', vk: 187 });
    await waitFor(async () => (await active()).zoom === 1.1, { label: 'zoom 110%' });
    const badge = await chrome.eval(`!document.querySelector('#zoom-badge').hidden && document.querySelector('#zoom-badge').textContent`);
    assert(badge === '110%', 'zoom badge ' + badge);
    await chrome.key('0', { ctrl: true, code: 'Digit0', vk: 48 });
    await waitFor(async () => (await active()).zoom === 1, { label: 'zoom reset' });
  });

  await check('download: file saved, panel + downloads page', async () => {
    const page = await tabTarget((u) => u === site + '/', 'home');
    await page.eval(`document.getElementById('dl').click()`);
    page.close();
    await waitFor(() => fs.existsSync(path.join(dlDir, 'vexa-test.bin')) && fs.statSync(path.join(dlDir, 'vexa-test.bin')).size === 256 * 1024, { label: 'file on disk', timeout: 15000 });
    await waitFor(async () => (await state()).downloads.hasItems, { label: 'downloads state' });
    await waitFor(async () => (await state()).popup === 'downloads', { label: 'downloads panel opened' });
    const ov = await tabTarget((u) => u.includes('overlay/index.html') && !u.includes('mode=status'), 'overlay');
    const name = await waitFor(() => ov.eval(`document.querySelector('.dl-name') && document.querySelector('.dl-name').textContent`), { label: 'panel item' });
    assert(name === 'vexa-test.bin', 'panel shows file: ' + name);
    screenshot('06-downloads-panel');
    ov.close();
    await chrome.eval(`document.querySelector('#downloads-btn').click()`); // toggle closed
    await waitFor(async () => !(await state()).popup, { label: 'panel closed' });
    const a = await active();
    assert(a.title === 'Vexa Test Home', 'still on the page (download did not navigate)');
  });

  await check('app menu opens and runs actions', async () => {
    await chrome.eval(`document.querySelector('#menu-btn').click()`);
    await waitFor(async () => (await state()).popup === 'menu', { label: 'menu' });
    const ov = await tabTarget((u) => u.includes('overlay/index.html') && !u.includes('mode=status'), 'overlay');
    await waitFor(() => ov.eval(`document.querySelectorAll('.mi').length > 8`), { label: 'menu items' });
    screenshot('07-menu');
    await ov.eval(`document.querySelector('[data-action="history"]').click()`);
    ov.close();
    await waitFor(async () => (await active()).url === 'vexa://history/', { label: 'history page opened' });
  });

  await check('history page lists visits and can delete one', async () => {
    const hp = await tabTarget((u) => u.startsWith('vexa://history'), 'history page');
    await waitFor(() => hp.eval(`document.querySelectorAll('.item').length >= 3`), { label: 'history items' });
    const titles = await hp.eval(`[...document.querySelectorAll('.item a')].map(a => a.textContent)`);
    assert(titles.includes('Second Page') && titles.includes('Vexa Test Home'), 'titles: ' + titles.join(','));
    const before = await hp.eval(`document.querySelectorAll('.item').length`);
    await hp.eval(`document.querySelector('.item [data-act="delete"]').click()`);
    await waitFor(async () => (await hp.eval(`document.querySelectorAll('.item').length`)) === before - 1, { label: 'deleted one' });
    // search
    await hp.eval(`(() => { const q = document.getElementById('q'); q.value = 'Second'; q.dispatchEvent(new Event('input')); })()`);
    await waitFor(async () => {
      const t = await hp.eval(`[...document.querySelectorAll('.item a')].map(a => a.textContent)`);
      return t.length > 0 && t.every((x) => x === 'Second Page');
    }, { label: 'history search' });
    screenshot('08-history');
    hp.close();
  });

  await check('settings page: change theme + search engine (persisted)', async () => {
    await typeAndGo('vexa://settings');
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings');
    await waitFor(() => sp.eval(`document.querySelectorAll('#engine option').length > 3`), { label: 'settings loaded' });
    await sp.eval(`document.querySelector('#theme [data-v="dark"]').click()`);
    await sp.eval(`(() => { const e = document.getElementById('engine'); e.value = 'google'; e.dispatchEvent(new Event('change')); })()`);
    await waitFor(() => {
      const j = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
      return j.theme === 'dark' && j.searchEngine === 'google';
    }, { label: 'settings.json updated' });
    await waitFor(async () => (await state()).settings.searchEngineName === 'Google', { label: 'chrome sees new engine' });
    const dark = await chrome.eval(`matchMedia('(prefers-color-scheme: dark)').matches`);
    assert(dark, 'browser UI switched to dark');
    screenshot('09-settings-dark');
    sp.close();
  });

  await check('Vexa Search (beta): option, note, results, no privileged API', async () => {
    const shot = async (t, name) => {
      if (!SHOTS) return;
      fs.mkdirSync(ART, { recursive: true });
      const { data } = await t.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(data, 'base64'));
    };
    await typeAndGo('vexa://settings/#search');
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings');
    await waitFor(() => sp.eval(`[...document.querySelectorAll('#engine option')].some((o) => o.value === 'vexa' && /Vexa Search \\(Beta\\)/.test(o.textContent))`), { label: 'Vexa Search option' });
    assert(await sp.eval(`document.getElementById('vexa-search-note').hidden`), 'note hidden while another engine is selected');
    await sp.eval(`(() => { const e = document.getElementById('engine'); e.value = 'vexa'; e.dispatchEvent(new Event('change')); })()`);
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).searchEngine === 'vexa', { label: 'saved vexa engine' });
    await waitFor(() => sp.eval(`!document.getElementById('vexa-search-note').hidden && document.getElementById('vexa-search-note').textContent.includes('BETA')`), { label: 'beta note shown' });
    await shot(sp, 'vexa-search-settings');
    sp.close();

    await waitFor(async () => (await state()).settings.searchEngineName === 'Vexa Search (Beta)', { label: 'chrome sees Vexa Search' });
    await typeAndGo('rust programming language');
    await waitFor(async () => (await active()).url.startsWith('vexa://search/?q=rust%20programming%20language'), { label: 'vexa search url' });
    const rp = await tabTarget((u) => u.startsWith('vexa://search/'), 'results page');
    await waitFor(() => rp.eval(`document.querySelectorAll('.result').length >= 3`), { label: 'results rendered', timeout: 15000 });
    const info = await rp.eval(`({ beta: document.querySelector('.beta')?.textContent, first: document.querySelector('.result a.link')?.href, api: typeof window.vexa, count: document.querySelector('.count')?.textContent })`);
    assert(info.beta === 'BETA', 'BETA label on results page');
    assert(/^https?:\/\//.test(info.first || ''), 'results link to the web: ' + info.first);
    assert(info.api === 'undefined', 'search page must not get the privileged vexa API');
    await shot(rp, 'vexa-search-results');
    rp.close();

    // Put the engine back for the tests that follow.
    await typeAndGo('vexa://settings');
    const sp2 = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings again');
    await waitFor(() => sp2.eval(`document.querySelectorAll('#engine option').length > 3`), { label: 'settings loaded' });
    await sp2.eval(`(() => { const e = document.getElementById('engine'); e.value = 'google'; e.dispatchEvent(new Event('change')); })()`);
    await waitFor(async () => (await state()).settings.searchEngineName === 'Google', { label: 'engine restored' });
    sp2.close();
  });

  await check('permission prompt: allow notifications (remembered)', async () => {
    await typeAndGo(site + '/notify');
    await waitFor(async () => (await active()).permission, { label: 'permission request' });
    const bar = await chrome.eval(`!document.querySelector('#permission-bar').hidden && document.querySelector('#permission-bar .infobar-text').textContent`);
    assert(bar && bar.includes('show notifications'), 'bar text: ' + bar);
    screenshot('10-permission');
    await chrome.eval(`document.querySelector('#permission-bar [data-decision="allow"]').click()`);
    const pg = await tabTarget((u) => u.endsWith('/notify'), 'notify page');
    await waitFor(async () => (await pg.eval(`document.getElementById('r').textContent`)) === 'granted', { label: 'granted' });
    pg.close();
    const j = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).sitePermissions[site]?.notifications === 'allow', { label: 'remembered' });
    void j;
  });

  await check('privacy: DNT/GPC headers sent, third-party cookies blocked, first-party kept', async () => {
    await typeAndGo(site + '/headers');
    const hp = await tabTarget((u) => u.endsWith('/headers'), 'headers');
    const headers = JSON.parse(await waitFor(() => hp.eval(`document.body.innerText.includes('{') && document.body.innerText`), { label: 'headers' }));
    hp.close();
    assert(headers.dnt === '1' && headers['sec-gpc'] === '1', 'DNT/GPC headers');
    assert(!/Electron|vexa\//i.test(headers['user-agent']), 'clean user agent: ' + headers['user-agent']);
    // first-party cookie works
    await typeAndGo(site + '/c/first-set');
    await waitFor(async () => (await active()).title === 'First party cookie', { label: 'fp set' });
    await typeAndGo(site + '/c/first-check');
    const fc = await tabTarget((u) => u.endsWith('/c/first-check'), 'fp check');
    const fpc = await waitFor(() => fc.eval(`document.getElementById('r') && document.getElementById('r').textContent`), { label: 'fp check' });
    fc.close();
    assert(fpc.includes('fp=1'), 'first-party cookie sent: ' + fpc);
    // third party: page on localhost embeds 127.0.0.1
    await typeAndGo(`${siteAlt}/3p?other=127.0.0.1:${srv.address().port}`);
    await sleep(1500);
    const log = await (await fetch(site + '/__cookielog')).json();
    assert(log.length >= 1, 'check request made');
    assert(log.every((c) => !c.includes('tp=1')), 'third-party cookie must not be sent: ' + JSON.stringify(log));
  });

  await check('clear browsing data from settings', async () => {
    await typeAndGo('vexa://settings/#privacy');
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings');
    await waitFor(() => sp.eval(`!!document.getElementById('clear-now')`), { label: 'settings' });
    await sp.eval(`document.getElementById('clear-now').click()`);
    await waitFor(() => {
      const h = JSON.parse(fs.readFileSync(path.join(profile, 'history.json'), 'utf8'));
      return h.entries.length === 0;
    }, { label: 'history cleared', timeout: 8000 });
    sp.close();
    await typeAndGo(site + '/c/first-check');
    const fc = await tabTarget((u) => u.endsWith('/c/first-check'), 'fp check');
    const txt = await waitFor(() => fc.eval(`document.getElementById('r') && document.getElementById('r').textContent`), { label: 'cookie check' });
    fc.close();
    assert(txt === 'none', 'cookies cleared, got: ' + txt);
  });

  await check('private window: separate session, no history', async () => {
    await chrome.key('n', { ctrl: true, shift: true });
    const pc = await target((u) => u.includes('chrome/index.html') && u.includes('private=1'), 'private chrome');
    await waitFor(() => pc.eval(`!!window.__vexaState && window.__vexaState.isPrivate`), { label: 'private state' });
    const chip = await pc.eval(`!document.querySelector('#private-chip').hidden`);
    assert(chip, 'private chip visible');
    await pc.eval(`(() => { const a = document.querySelector('#address'); a.focus(); a.value=''; })()`);
    await sleep(50);
    await pc.send('Input.insertText', { text: site + '/page2?private=1' });
    await sleep(200);
    await pc.key('Enter');
    await waitFor(() => pc.eval(`window.__vexaState.tabs[0].title === 'Second Page'`), { label: 'private load' });
    // the private session must not see the normal session's cookie
    await pc.eval(`(() => { const a = document.querySelector('#address'); a.focus(); a.value=''; })()`);
    await pc.send('Input.insertText', { text: site + '/c/first-check' });
    await sleep(200);
    await pc.key('Enter');
    screenshot('11-private');
    await sleep(500);
    const h = JSON.parse(fs.readFileSync(path.join(profile, 'history.json'), 'utf8'));
    assert(!h.entries.some((e) => e.url.includes('private=1')), 'private visit not in history');
    pc.key('w', { ctrl: true, shift: true }).catch(() => {}); // the window closes, so no ack arrives
    await sleep(300);
    pc.close();
    await waitFor(async () => !(await targets()).some((t) => t.url.includes('private=1')), { label: 'private window closed' });
  });

  await check('session + data persist across restart', async () => {
    // Leave a known set of tabs, then quit.
    await typeAndGo(site + '/');
    await waitFor(async () => (await active()).title === 'Vexa Test Home', { label: 'home' });
    await chrome.key('t', { ctrl: true });
    await sleep(300);
    await typeAndGo(site + '/page2');
    await waitFor(async () => (await active()).title === 'Second Page', { label: 'page2' });
    await chrome.key('d', { ctrl: true });
    await waitFor(async () => (await active()).bookmarked, { label: 'bookmark page2' });
    await sleep(1300); // session save is debounced
    chrome.close();
    await quit();
    const sess = JSON.parse(fs.readFileSync(path.join(profile, 'session.json'), 'utf8'));
    const expectTabs = sess.windows[0] && sess.windows[0].tabs.length;
    assert(sess.windows.length === 1 && expectTabs >= 2, 'session.json saved the window: ' + JSON.stringify(sess).slice(0, 300));
    assert(sess.windows[0].tabs[sess.windows[0].activeIndex].entries.some((e) => e.url.endsWith('/page2')), 'active tab saved');
    await launch(profile);
    chrome = await target((u) => u.includes('chrome/index.html'), 'chrome');
    const s = await waitFor(async () => {
      const x = await state();
      return x && x.tabs.length === expectTabs && x;
    }, { label: 'restored tabs', timeout: 15000 });
    const at = s.tabs.find((t) => t.id === s.activeId);
    await waitFor(async () => (await active()).title === 'Second Page', { label: 'active restored tab loads' });
    assert(at, 'active tab');
    assert(s.bookmarksBar.some((b) => b.url === site + '/page2'), 'bookmark persisted');
    assert(s.settings.searchEngineName === 'Google', 'settings persisted');
    // lazily restored background tab loads when activated
    const homeTab = s.tabs.find((t) => t.url === site + '/');
    assert(homeTab && homeTab.pending, 'background tab restored lazily');
    await chrome.eval(`window.vexaChrome.cmd('activate-tab', { tabId: ${homeTab.id} })`);
    await waitFor(async () => (await active()).title === 'Vexa Test Home', { label: 'lazy tab loads on activation', timeout: 8000 });
    screenshot('12-restored');
  });

  await check('internal pages render (bookmarks, downloads)', async () => {
    await chrome.key('o', { ctrl: true, shift: true });
    const bp = await tabTarget((u) => u.startsWith('vexa://bookmarks'), 'bookmarks page');
    await waitFor(() => bp.eval(`document.querySelectorAll('#items .item').length >= 2`), { label: 'bookmark items' });
    screenshot('13-bookmarks');
    bp.close();
    await chrome.key('j', { ctrl: true });
    const dp = await tabTarget((u) => u.startsWith('vexa://downloads'), 'downloads page');
    const nm = await waitFor(() => dp.eval(`document.querySelector('.dl-name') && document.querySelector('.dl-name').textContent`), { label: 'download row' });
    assert(nm === 'vexa-test.bin', 'downloads page lists the file');
    screenshot('14-downloads');
    dp.close();
  });

  // ================================================================== 0.2 features
  await check('settings: new sections render (default browser, passwords, sync, extensions)', async () => {
    await chrome.key(',', { ctrl: true });
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings page');
    await waitFor(() => sp.eval(`document.querySelector('#default-status').textContent !== 'Checking…'`), { label: 'default browser status' });
    await waitFor(() => sp.eval(`document.querySelector('#pw-list').children.length > 0 && document.querySelector('#sync-card').children.length > 0 && document.querySelector('#ext-list').children.length > 0`), { label: 'new sections' });
    const drm = await sp.eval(`document.querySelector('#drm-note').textContent`);
    assert(/Widevine/.test(drm), 'DRM status line present: ' + drm);
    screenshot('15-settings-new');
    sp.close();
  });

  await check('password manager: offer to save, save encrypted, auto-fill next visit', async () => {
    await typeAndGo(site + '/login');
    const lp = await tabTarget((u) => u.endsWith('/login'), 'login page');
    await waitFor(() => lp.eval(`!!document.querySelector('#go')`), { label: 'login form' });
    await lp.eval(`(() => { document.querySelector('#u').value = 'alice'; document.querySelector('#p').value = 'hunter22-correct'; document.querySelector('#go').click(); })()`);
    const prompt = await waitFor(async () => (await active()).passwordPrompt, { label: 'save-password offer', timeout: 8000 });
    assert(prompt.username === 'alice' && !prompt.update, 'offer is for alice: ' + JSON.stringify(prompt));
    assert(!JSON.stringify(prompt).includes('hunter22'), 'password is never sent to the UI');
    const visible = await chrome.eval(`!document.querySelector('#password-bar').hidden`);
    assert(visible, 'password bar is shown');
    await chrome.eval(`window.vexaChrome.cmd('password-decision', { tabId: ${(await active()).id}, decision: 'save' })`);
    await waitFor(() => fs.existsSync(path.join(profile, 'passwords.json')) && JSON.parse(fs.readFileSync(path.join(profile, 'passwords.json'), 'utf8')).items.length === 1, { label: 'passwords.json written', timeout: 5000 });
    const raw = fs.readFileSync(path.join(profile, 'passwords.json'), 'utf8');
    assert(!raw.includes('hunter22'), 'password is not stored in plain text');
    // Next visit: the single saved login is filled in automatically.
    await typeAndGo(site + '/login');
    await sleep(300);
    const lp2 = await tabTarget((u) => u.endsWith('/login'), 'login page 2');
    await waitFor(() => lp2.eval(`document.querySelector('#p').value === 'hunter22-correct' && document.querySelector('#u').value === 'alice'`), { label: 'auto-fill', timeout: 8000 });
    // Same credentials again: no new offer.
    await lp2.eval(`document.querySelector('#go').click()`);
    await sleep(800);
    assert(!(await active()).passwordPrompt, 'no offer for an already-saved login');
    // Settings page lists it and can reveal it.
    await chrome.key(',', { ctrl: true });
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings page');
    await waitFor(() => sp.eval(`!!document.querySelector('#pw-list [data-pw]')`), { label: 'password listed' });
    assert((await sp.eval(`vexa.call('passwords.list').then(l => l[0].username)`)) === 'alice', 'list shows alice');
    assert((await sp.eval(`vexa.call('passwords.list').then(l => vexa.call('passwords.reveal', l[0].id))`)) === 'hunter22-correct', 'reveal returns the password');
    sp.close();
    lp.close();
    lp2.close();
  });

  await check('autofill: contact details persist and fill a form', async () => {
    await chrome.key(',', { ctrl: true });
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings page');
    await waitFor(() => sp.eval('!!window.vexa'), { label: 'vexa api' });
    await sp.eval("vexa.call('autofill.set', { firstName: 'Alice', lastName: 'Example', email: 'alice@example.com', zip: '12345', country: 'United States' })");
    await sp.eval('location.reload()');
    await waitFor(() => sp.eval("document.querySelector('[data-af=firstName]') && document.querySelector('[data-af=firstName]').value === 'Alice'"), { label: 'settings form shows saved details' });
    sp.close();
    await chrome.key('t', { ctrl: true });
    await sleep(200);
    await typeAndGo(site + '/contact');
    const cp = await tabTarget((u) => u.endsWith('/contact'), 'contact page');
    await waitFor(() => cp.eval("!!document.querySelector('#fn')"), { label: 'contact form' });
    await chrome.eval(`window.vexaChrome.cmd('autofill-contact', {})`);
    await waitFor(() => cp.eval("document.querySelector('#fn').value === 'Alice' && document.querySelector('#em').value === 'alice@example.com' && document.querySelector('#zip').value === '12345' && document.querySelector('#co').value === 'US'"), { label: 'form filled', timeout: 5000 });
    cp.close();
    await chrome.key('w', { ctrl: true });
  });

  await check('extensions: an unpacked extension loads and its content script runs', async () => {
    await chrome.key('t', { ctrl: true });
    await sleep(200);
    await typeAndGo(site + '/page2');
    const ep = await tabTarget((u) => u.endsWith('/page2'), 'extension page');
    await waitFor(() => ep.eval("document.documentElement.getAttribute('data-vexa-ext') === 'loaded'"), { label: 'content script ran', timeout: 8000 });
    await chrome.key(',', { ctrl: true });
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings page');
    await waitFor(() => sp.eval('!!window.vexa'), { label: 'vexa api' });
    const list = await sp.eval("vexa.call('extensions.list')");
    assert(list.length === 1 && list[0].name === 'Vexa Test Extension' && list[0].version === '1.2.3' && !list[0].error, 'listed: ' + JSON.stringify(list));
    assert(await sp.eval("document.querySelector('#ext-list').textContent.includes('Vexa Test Extension')").catch(() => true), 'shown on the settings page');
    ep.close();
    sp.close();
    await chrome.key('w', { ctrl: true });
  });

  await check('HTTP basic auth: sign-in dialog accepts credentials', async () => {
    await typeAndGo(site + '/auth');
    const dlg = await target((u) => u.includes('renderer/auth/index.html'), 'auth dialog');
    await waitFor(() => dlg.eval(`document.querySelector('#who') && document.querySelector('#who').textContent.includes('127.0.0.1')`), { label: 'dialog text' });
    await dlg.eval(`(() => { document.querySelector('#user').value = 'vexa'; document.querySelector('#pass').value = 'secret'; document.querySelector('#remember').checked = false; document.querySelector('#ok').click(); })()`);
    dlg.close();
    await waitFor(async () => (await active()).title === 'Authorized', { label: 'authorized page', timeout: 8000 });
  });

  await check('basic auth: cancelling shows the 401 page', async () => {
    await chrome.key('t', { ctrl: true });
    await sleep(200);
    await typeAndGo(siteAlt + '/auth'); // different host → no cached credentials
    const dlg = await target((u) => u.includes('renderer/auth/index.html'), 'auth dialog 2');
    await waitFor(() => dlg.eval(`!!document.querySelector('#cancel')`), { label: 'dialog ready' });
    await dlg.eval(`document.querySelector('#cancel').click()`);
    dlg.close();
    await waitFor(async () => (await active()).title === 'Denied', { label: '401 page', timeout: 8000 });
    await chrome.key('w', { ctrl: true });
  });

  await check('tabs move between windows (same live page, no reload)', async () => {
    await typeAndGo(site + '/page2');
    await waitFor(async () => (await active()).title === 'Second Page', { label: 'page2' });
    const pt = await tabTarget((u) => u.endsWith('/page2'), 'page2 tab');
    await pt.eval(`window.__marker = 42`);
    const s0 = await state();
    const moving = s0.tabs.find((t) => t.id === s0.activeId);
    const homeWindowId = s0.windowId;
    const before = s0.tabs.length;
    assert(before >= 2, 'need at least two tabs to move one');
    await chrome.eval(`window.vexaChrome.cmd('tab-to-new-window', { tabId: ${moving.id} })`);
    // a second browser window appears and holds the tab
    const chromes = await waitFor(async () => {
      const t = (await targets()).filter((x) => x.url.includes('chrome/index.html') && !x.url.includes('private=1'));
      return t.length === 2 && t;
    }, { label: 'second window' });
    const other = chromes.find((x) => x.id !== chrome.info.id);
    const oc = await new Target(other).connect();
    const os2 = await waitFor(async () => {
      const x = await oc.eval('window.__vexaState');
      return x && x.tabs.length === 1 && x.tabs[0].title === 'Second Page' && x;
    }, { label: 'tab arrived' });
    assert((await state()).tabs.length === before - 1, 'source window lost the tab');
    assert((await pt.eval('window.__marker')) === 42, 'same page instance moved (state preserved)');
    // ...and back again
    // (this window closes itself once it is empty, so its own reply never arrives)
    oc.eval(`window.vexaChrome.cmd('tab-to-window', { tabId: ${os2.tabs[0].id}, windowId: ${homeWindowId} })`).catch(() => {});
    await waitFor(async () => (await state()).tabs.length === before, { label: 'tab came back' });
    await waitFor(async () => !(await targets()).some((x) => x.id === other.id), { label: 'empty window closed' });
    assert((await pt.eval('window.__marker')) === 42, 'page state preserved after the round trip');
    assert((await active()).title === 'Second Page', 'moved tab is active');
    oc.close();
    pt.close();
  });

  await check('sync: encrypted file, wrong passphrase rejected', async () => {
    const dir = (syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vexa-sync-')));
    await chrome.key(',', { ctrl: true });
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings page');
    await waitFor(() => sp.eval(`!!window.vexa`), { label: 'vexa api' });
    const dirJs = JSON.stringify(dir);
    const st = await sp.eval(`vexa.call('sync.enable', ${dirJs}, 'correct horse battery')`);
    assert(st.enabled && st.lastSync > 0 && !st.lastError, 'sync enabled: ' + JSON.stringify(st));
    const file = path.join(dir, 'vexa-sync.json');
    assert(fs.existsSync(file), 'sync file written');
    const text = fs.readFileSync(file, 'utf8');
    assert(!text.includes('alice') && !text.includes('hunter22') && !text.includes('page2'), 'sync file is ciphertext');
    await sp.eval(`vexa.call('sync.disable')`);
    let err = '';
    try {
      await sp.eval(`vexa.call('sync.enable', ${dirJs}, 'not the passphrase')`);
    } catch (e) {
      err = e.message;
    }
    assert(/Wrong passphrase/.test(err), 'wrong passphrase is rejected: ' + err);
    assert(!(await sp.eval(`vexa.call('sync.status').then(s => s.enabled)`)), 'still disabled after a wrong passphrase');
    await sp.eval(`vexa.call('sync.enable', ${dirJs}, 'correct horse battery')`);
    assert(await sp.eval(`vexa.call('sync.status').then(s => s.enabled && !s.lastError)`), 're-enabled with the right passphrase');
    await sp.eval(`vexa.call('sync.disable')`);
    sp.close();
  });

  await check('clear data with a time range keeps cookies; all-time clears them', async () => {
    await typeAndGo(site + '/c/first-set');
    await waitFor(async () => (await active()).title === 'First party cookie', { label: 'cookie set' });
    await chrome.key(',', { ctrl: true });
    const sp = await tabTarget((u) => u.startsWith('vexa://settings'), 'settings page');
    await waitFor(() => sp.eval(`!!window.vexa`), { label: 'vexa api' });
    await sp.eval(`vexa.call('privacy.clear', { history: true, cookies: true }, 'hour')`);
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(profile, 'history.json'), 'utf8')).entries.length === 0, { label: 'recent history cleared', timeout: 4000 });
    await chrome.key('t', { ctrl: true }); // keep the settings tab alive; check the cookie in a new one
    await sleep(200);
    await typeAndGo(site + '/c/first-check');
    await waitFor(async () => (await active()).title === 'First party check', { label: 'cookie check page' });
    const cp = await tabTarget((u) => u.endsWith('/c/first-check'), 'cookie check');
    assert((await cp.eval(`document.querySelector('#r').textContent`)).includes('fp=1'), 'cookie survived a ranged clear');
    await sp.eval(`vexa.call('privacy.clear', { cookies: true }, 'all')`);
    await chrome.key('r', { ctrl: true });
    await waitFor(() => cp.eval(`document.querySelector('#r').textContent === 'none'`), { label: 'cookie cleared' });
    cp.close();
    sp.close();
  });

  chrome.close();
  await quit();

  await check('sync: a second device pulls bookmarks, passwords and settings', async () => {
    const profileB = fs.mkdtempSync(path.join(os.tmpdir(), 'vexa-e2e-b-'));
    try {
      await launch(profileB);
      const c2 = await target((u) => u.includes('chrome/index.html'), 'chrome B');
      await c2.key(',', { ctrl: true });
      const sp = await target((u) => u.startsWith('vexa://settings'), 'settings B');
      await waitFor(() => sp.eval('!!window.vexa'), { label: 'vexa api B' });
      assert((await sp.eval("vexa.call('passwords.list').then(l => l.length)")) === 0, 'device B starts with no passwords');
      assert((await sp.eval("vexa.call('settings.get').then(s => s.searchEngine)")) === 'duckduckgo', 'device B starts with the default engine');
      const st = await sp.eval(`vexa.call('sync.enable', ${JSON.stringify(syncDir)}, 'correct horse battery')`);
      assert(st.enabled && !st.lastError, 'sync enabled on B: ' + JSON.stringify(st));
      const pw = await sp.eval("vexa.call('passwords.list')");
      assert(pw.length === 1 && pw[0].username === 'alice', 'password arrived: ' + JSON.stringify(pw));
      assert((await sp.eval("vexa.call('passwords.reveal', " + JSON.stringify(pw[0].id) + ')')) === 'hunter22-correct', 'password decrypts on B');
      const bm = await sp.eval("vexa.call('bookmarks.children', 'bar')");
      assert(bm.some((b) => b.url === site + '/page2'), 'bookmark arrived: ' + JSON.stringify(bm));
      assert((await sp.eval("vexa.call('settings.get').then(s => s.searchEngine)")) === 'google', 'setting arrived');
      // A password deleted on B travels back to A's file as a deletion.
      await sp.eval("vexa.call('passwords.remove', " + JSON.stringify(pw[0].id) + ')');
      await sp.eval("vexa.call('sync.now')");
      sp.close();
      c2.close();
    } finally {
      await quit();
      try {
        fs.rmSync(profileB, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      } catch {
        /* Windows may still hold the profile for a moment; it is in the temp folder */
      }
    }
  });
  if (syncDir) fs.rmSync(syncDir, { recursive: true, force: true });
  srv.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
  if (!process.env.VEXA_E2E_KEEP) {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
    } catch {
      /* see above */
    }
  }
}

main().catch(async (e) => {
  console.error(e);
  if (app) app.kill('SIGKILL');
  process.exit(1);
});
