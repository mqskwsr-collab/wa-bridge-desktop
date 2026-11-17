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
  logout: (id) => ipcRenderer.invoke('auth:logout', { id }),
  switchAccount: (id) => ipcRenderer.invoke('accounts:switch', { id }),
  call: (method, path, body, accountId) => ipcRenderer.invoke('api:call', { method, path, body, accountId }),
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  cacheLoad: (accountId) => ipcRenderer.invoke('cache:load', { accountId }),
  cacheSave: (accountId, json) => ipcRenderer.invoke('cache:save', { accountId, json }),
  lockState: () => ipcRenderer.invoke('lock:state'),
  lockSetup: (o) => ipcRenderer.invoke('lock:setup', o),
  lockUpdate: (o) => ipcRenderer.invoke('lock:update', o),
  lockVerify: (pin) => ipcRenderer.invoke('lock:verify', { pin }),
  lockDisable: (pin) => ipcRenderer.invoke('lock:disable', { pin }),
  lockNow: () => ipcRenderer.invoke('lock:now'),
  lockReset: () => ipcRenderer.invoke('lock:reset'),
  onLock: (cb) => on('lock', cb),
  media: (id, accountId, expect) => ipcRenderer.invoke('media:get', { id, accountId, expect }),
  saveMedia: (id, name, accountId, expect) => ipcRenderer.invoke('media:save', { id, name, accountId, expect }),
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
