'use strict';
// Vexa — main process entry point.

const path = require('path');
const { app, protocol, nativeTheme, Menu } = require('electron');

app.setName('Vexa');
if (process.platform === 'win32') app.setAppUserModelId('com.nova.vexa');

// Allow running against a throwaway profile: `electron . --user-data-dir=/tmp/x`
// (Chromium handles --user-data-dir itself; this also covers VEXA_PROFILE).
if (process.env.VEXA_PROFILE) app.setPath('userData', path.resolve(process.env.VEXA_PROFILE));

// Chromium's location service needs a Google API key. If the user saved one in Settings,
// hand it to Chromium before anything starts (the environment variable is read at launch).
if (!process.env.GOOGLE_API_KEY) {
  try {
    const saved = JSON.parse(require('fs').readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (typeof saved.googleApiKey === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(saved.googleApiKey)) process.env.GOOGLE_API_KEY = saved.googleApiKey;
  } catch {
    /* no settings yet */
  }
}

// vexa:// must be registered as a privileged scheme before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'vexa', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }
]);

function urlsFromArgv(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && (/^(https?|file|vexa):/i.test(a) || /\.(html?|pdf|svg|txt)$/i.test(a)))
    .map((a) => (/^[a-z]+:/i.test(a) ? a : require('url').pathToFileURL(path.resolve(a)).href));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const controller = require('./app-controller');

  app.on('second-instance', (_e, argv) => {
    const urls = urlsFromArgv(argv);
    if (urls.length) controller.openUrls(urls);
    else {
      const w = controller.focusedWindow();
      if (w) w.focus();
      else controller.createWindow();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) controller.openUrls([url]);
  });

  app.whenReady().then(async () => {
    // Widevine-enabled Electron builds (castlabs "wvcus") must finish installing the CDM first.
    try {
      const { components } = require('electron');
      if (components && typeof components.whenReady === 'function') await components.whenReady();
    } catch (err) {
      console.warn('[vexa] Widevine component not ready:', err?.message || err);
    }
    const { settings } = require('./settings');
    const { history } = require('./history');
    const { bookmarks } = require('./bookmarks');
    const { downloads } = require('./downloads');
    const { passwords } = require('./passwords');
    const { autofill } = require('./autofill');
    const { extensions } = require('./extensions');
    const { sync } = require('./sync');
    settings.init();
    history.init();
    bookmarks.init();
    downloads.init();
    passwords.init();
    autofill.init();
    extensions.init();
    nativeTheme.themeSource = settings.get('theme');

    const { cleanUserAgent, defaultSession } = require('./sessions');
    app.userAgentFallback = cleanUserAgent();
    defaultSession();

    // macOS needs an app menu for standard editing shortcuts; elsewhere we draw our own UI.
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      );
    } else {
      Menu.setApplicationMenu(null);
    }

    require('./ipc').register();
    require('./auth-prompt').register();
    controller.wireDataEvents();
    controller.startup(urlsFromArgv(process.argv));

    // Background work after the first window is up.
    extensions.loadAll().catch(() => {});
    sync.init();
    require('./default-browser').refreshRegistration();

    app.on('activate', () => {
      if (!controller.windows.size) controller.createWindow();
    });
  });

  app.on('before-quit', (e) => controller.onBeforeQuit(e));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Never allow a web page to create a webview tag.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
