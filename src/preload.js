'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** Safe bridge exposed to the renderer as window.aether. */
contextBridge.exposeInMainWorld('aether', {
  // window controls
  minimize: () => ipcRenderer.send('window-min'),
  close: () => ipcRenderer.send('window-close'),

  // config & settings
  getConfig: () => ipcRenderer.invoke('get-config'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  openInstance: () => ipcRenderer.invoke('open-instance'),
  skinHead: (uuid) => ipcRenderer.invoke('skin-head', uuid),
  guildEmblem: () => ipcRenderer.invoke('guild-emblem'),
  detectJava: () => ipcRenderer.invoke('detect-java'),

  // auth
  msSignIn: () => ipcRenderer.invoke('ms-signin'),
  rememberedAccount: () => ipcRenderer.invoke('remembered-account'),
  resumeSignIn: () => ipcRenderer.invoke('resume-signin'),
  forgetAccount: () => ipcRenderer.invoke('forget-account'),
  loginCode: (code) => ipcRenderer.invoke('login-code', code),
  logout: () => ipcRenderer.invoke('logout'),

  // api
  api: (fn, ...args) => ipcRenderer.invoke('api', fn, ...args),

  // launch — one listener at a time: the Play view re-registers on every visit, and
  // stacking the old ones would replay each event into stale DOM closures.
  launch: () => ipcRenderer.invoke('launch'),
  onLaunchEvent: (cb) => {
    ipcRenderer.removeAllListeners('launch-event');
    ipcRenderer.on('launch-event', (_e, evt) => cb(evt));
  },

  // auto-update
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, version) => cb(version)),
  installUpdate: () => ipcRenderer.send('install-update'),
});
