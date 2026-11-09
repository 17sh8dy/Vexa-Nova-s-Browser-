'use strict';
// Preload for the HTTP sign-in dialog only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vexaAuth', {
  info: () => ipcRenderer.invoke('auth:info'),
  submit: (result) => ipcRenderer.send('auth:submit', result)
});
