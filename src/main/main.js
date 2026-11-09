'use strict';
// Vexa — main process entry point.

const path = require('path');
const { app, protocol, nativeTheme, Menu } = require('electron');

app.setName('Vexa');
if (process.platform === 'win32') app.setAppUserModelId('com.nova.vexa');

// Allow running against a throwaway profile: `electron . --user-data-dir=/tmp/x`
// (Chromium handles --user-data-dir itself; this also covers VEXA_PROFILE).
if (process.env.VEXA_PROFILE) app.setPath('userData', path.resolve(process.env.VEXA_PROFILE));

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

  app.whenReady().then(() => {
    const { settings } = require('./settings');
    const { history } = require('./history');
    const { bookmarks } = require('./bookmarks');
    const { downloads } = require('./downloads');
    settings.init();
    history.init();
    bookmarks.init();
    downloads.init();
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
    controller.wireDataEvents();
    controller.startup(urlsFromArgv(process.argv));

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
