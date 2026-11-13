'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const h = (e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('wab', {
  info: () => ipcRenderer.invoke('app:info'),
  login: (data) => ipcRenderer.invoke('auth:login', data),
  logout: () => ipcRenderer.invoke('auth:logout'),
  call: (method, path, body) => ipcRenderer.invoke('api:call', { method, path, body }),
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setUnread: (n) => ipcRenderer.send('unread:set', n),
  notify: (data) => ipcRenderer.send('notify', data),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => on('update', cb),
  onSettings: (cb) => on('settings', cb),
  onOpenConv: (cb) => on('open-conv', cb),
  onAuthExpired: (cb) => on('auth-expired', cb),
});
