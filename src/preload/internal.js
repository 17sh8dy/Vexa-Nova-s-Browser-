'use strict';
// Preload for every tab. It only exposes an API on Vexa's own vexa:// pages;
// ordinary websites get nothing. The main process also verifies the caller's URL.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'vexa:') {
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
}
