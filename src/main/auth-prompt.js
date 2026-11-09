'use strict';
// HTTP authentication (Basic / Digest / NTLM / proxy) sign-in prompt.
// A small modal window over the tab that triggered it; saved logins are offered
// and a successful entry can be remembered in the password manager.

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const controller = require('./app-controller');
const { passwords } = require('./passwords');
const { originOf } = require('./url');

const PRELOAD = path.join(__dirname, '..', 'preload', 'auth.js');
const PAGE = path.join(__dirname, '..', 'renderer', 'auth', 'index.html');

const pending = new Map(); // webContents id of the dialog -> { info, finish }

function register() {
  app.on('login', (event, wc, details, authInfo, callback) => {
    const { win, tab } = controller.windowForWebContents(wc);
    if (!win || !tab) return; // not one of our tabs: let Electron cancel it
    event.preventDefault();
    open(win, tab, details, authInfo, callback);
  });

  ipcMain.handle('auth:info', (event) => pending.get(event.sender.id)?.info || null);
  ipcMain.on('auth:submit', (event, result) => pending.get(event.sender.id)?.finish(result));
}

function open(win, tab, details, authInfo, callback) {
  const origin = authInfo.isProxy ? '' : originOf(details?.url || tab.url);
  const saved = !authInfo.isProxy && origin && passwords.available() ? passwords.forOrigin(origin)[0] : null;
  const info = {
    host: `${authInfo.host}${authInfo.port ? ':' + authInfo.port : ''}`,
    realm: authInfo.realm || '',
    isProxy: !!authInfo.isProxy,
    isPrivate: win.isPrivate,
    canRemember: !authInfo.isProxy && !win.isPrivate && passwords.available(),
    username: saved?.username || '',
    password: saved?.password || ''
  };

  const dlg = new BrowserWindow({
    parent: win.win,
    modal: true,
    width: 420,
    height: 330,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Sign in',
    autoHideMenuBar: true,
    backgroundColor: win.isPrivate ? '#0a0814' : '#15121f',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, session: win.session }
  });
  dlg.setMenu(null);
  const id = dlg.webContents.id;
  let settled = false;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    pending.delete(id);
    if (result && typeof result.username === 'string' && typeof result.password === 'string') {
      callback(result.username, result.password);
      if (result.remember && info.canRemember && origin) {
        try {
          passwords.save({ origin, username: result.username, password: result.password });
        } catch {
          /* encryption unavailable: skip silently */
        }
      }
    } else {
      callback(); // cancelled
    }
    if (!dlg.isDestroyed()) dlg.close();
  };
  pending.set(id, { info, finish });

  dlg.once('ready-to-show', () => dlg.show());
  dlg.on('closed', () => finish(null));
  // If the tab goes away, so does the question.
  tab.wc.once('destroyed', () => finish(null));
  dlg.webContents.on('will-navigate', (e) => e.preventDefault());
  dlg.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dlg.loadFile(PAGE);
}

module.exports = { register };
