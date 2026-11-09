'use strict';
// Bridge for Vexa's own UI (browser chrome, popup layer, status bubble).
// Exposes a narrow, whitelisted API; the main process re-checks the sender.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'state',
  'focus-address',
  'find-open',
  'popup-closed',
  'suggestion-picked',
  'downloads-started',
  'popup:show',
  'popup:update',
  'popup:hide',
  'status:show'
]);

contextBridge.exposeInMainWorld('vexaChrome', {
  cmd: (name, args) => ipcRenderer.invoke('chrome:cmd', name, args),
  overlay: (name, args) => ipcRenderer.invoke('overlay:cmd', name, args),
  layout: (info) => ipcRenderer.send('chrome:layout', info),
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) throw new Error('Unknown channel ' + channel);
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
