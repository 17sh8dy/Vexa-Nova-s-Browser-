'use strict';
/*
 * Switch Vexa between stock Electron (no DRM) and the Widevine-enabled build of
 * Electron published by castlabs ("Electron for Content Security", the "+wvcus" builds).
 *
 *   npm run use-widevine         switch to the Widevine build, then reinstall
 *   npm run use-stock-electron   switch back
 *
 * Why this isn't the default: it replaces the Electron binary with a third-party fork, and
 * for some services (Netflix, Disney+, Prime Video…) Widevine will only work after the
 * packaged app is VMP-signed with a free castlabs EVS account. Spotify's web player and
 * most other Widevine L3 sites work without signing. See README → "Protected video".
 *
 * Nothing here runs unless you run it. It only edits package.json and calls `npm install`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CASTLABS = 'github:castlabs/electron-releases#v45.2.1+wvcus';
const STOCK = '45.2.3';
const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const revert = process.argv.includes('--revert');

if (revert) {
  pkg.devDependencies.electron = STOCK;
  delete pkg.build.electronVersion;
  delete pkg.build.electronDist;
} else {
  pkg.devDependencies.electron = CASTLABS;
  // electron-builder can't read a version out of a git URL, so tell it which one this is
  // and where the already-installed binaries are.
  pkg.build.electronVersion = '45.2.1';
  pkg.build.electronDist = 'node_modules/electron/dist';
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package.json → electron: ${pkg.devDependencies.electron}`);
console.log('Running npm install…');
const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
