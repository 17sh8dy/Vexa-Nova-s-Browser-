'use strict';
// "Make Vexa the default browser".
//
// Windows 10/11 does not let an app silently take over http/https: an app has to
// register itself as a browser (Capabilities in the registry) and then the *user*
// picks it in Settings → Default apps. We do the registration (per-user, HKCU, no
// admin rights needed) and open that settings page. macOS/Linux use Electron's
// protocol-client API, which does the whole job (macOS shows its own confirmation).

const path = require('path');
const { execFile } = require('child_process');
const { app, shell } = require('electron');

const PROTOCOLS = ['http', 'https'];
const isWin = process.platform === 'win32';

/** Executable + args used to launch this exact install (dev runs need the app path too). */
function launcher() {
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [path.resolve(process.argv[1] || '.')] };
}

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

async function regSet(key, name, value) {
  const args = ['add', `HKCU\\${key}`];
  if (name == null) args.push('/ve');
  else args.push('/v', name);
  args.push('/t', 'REG_SZ', '/d', value, '/f');
  await reg(args);
}

/** Register Vexa as a browser Windows can offer in Default apps. Idempotent. */
async function registerWindows() {
  if (!isWin) return;
  const { exe, args } = launcher();
  const quoted = [exe, ...args].map((a) => `"${a}"`).join(' ');
  const open = `${quoted} "%1"`;
  const cap = 'Software\\Clients\\StartMenuInternet\\Vexa\\Capabilities';

  await regSet('Software\\Classes\\VexaURL', null, 'Vexa URL');
  await regSet('Software\\Classes\\VexaURL', 'URL Protocol', '');
  await regSet('Software\\Classes\\VexaURL\\DefaultIcon', null, `"${exe}",0`);
  await regSet('Software\\Classes\\VexaURL\\shell\\open\\command', null, open);
  await regSet('Software\\Classes\\VexaHTML', null, 'Vexa HTML Document');
  await regSet('Software\\Classes\\VexaHTML\\DefaultIcon', null, `"${exe}",0`);
  await regSet('Software\\Classes\\VexaHTML\\shell\\open\\command', null, open);

  await regSet('Software\\Clients\\StartMenuInternet\\Vexa', null, 'Vexa');
  await regSet('Software\\Clients\\StartMenuInternet\\Vexa\\DefaultIcon', null, `"${exe}",0`);
  await regSet('Software\\Clients\\StartMenuInternet\\Vexa\\shell\\open\\command', null, quoted);
  await regSet(cap, 'ApplicationName', 'Vexa');
  await regSet(cap, 'ApplicationDescription', 'Vexa — the Nova browser');
  await regSet(cap, 'ApplicationIcon', `"${exe}",0`);
  await regSet(`${cap}\\URLAssociations`, 'http', 'VexaURL');
  await regSet(`${cap}\\URLAssociations`, 'https', 'VexaURL');
  for (const ext of ['.htm', '.html', '.xhtml', '.svg']) await regSet(`${cap}\\FileAssociations`, ext, 'VexaHTML');
  await regSet(`${cap}\\StartMenu`, 'StartMenuInternet', 'Vexa');
  await regSet('Software\\RegisteredApplications', 'Vexa', cap);
}

function isDefault() {
  const { exe, args } = launcher();
  try {
    return PROTOCOLS.every((p) => app.isDefaultProtocolClient(p, exe, args));
  } catch {
    return false;
  }
}

function status() {
  return { supported: true, isDefault: isDefault(), platform: process.platform };
}

/** Start the "make default" flow. Returns the new status; on Windows the user finishes it in Settings. */
async function makeDefault() {
  const { exe, args } = launcher();
  if (isWin) {
    await registerWindows();
    // Windows 11 opens straight to Vexa's entry; older builds ignore the query.
    await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Vexa').catch(() => shell.openExternal('ms-settings:defaultapps'));
    return { ...status(), pendingUserAction: true };
  }
  for (const p of PROTOCOLS) app.setAsDefaultProtocolClient(p, exe, args);
  return status();
}

/** Keep the registration pointing at the current exe (e.g. after the app was moved or updated). */
function refreshRegistration() {
  if (isWin && app.isPackaged) registerWindows().catch((err) => console.warn('[vexa] default-browser registration failed:', err.message));
}

module.exports = { status, makeDefault, refreshRegistration, registerWindows };
