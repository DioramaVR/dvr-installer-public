const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (!process.argv.includes('--dvr-mock')) contextBridge.exposeInMainWorld('dvr', {
  status: () => ipcRenderer.invoke('status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  steamRunning: () => ipcRenderer.invoke('steam:running'),
  openStore: (appid) => ipcRenderer.invoke('open-store', appid),
  preflight: () => ipcRenderer.invoke('preflight'),
  vrStatus: () => ipcRenderer.invoke('vr-status'),
  dev: process.argv.includes('--dvr-dev'),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  // credits.json, plain text only (About / Credits screen).
  credits: () => ipcRenderer.invoke('credits'),
  launch: (modId) => ipcRenderer.invoke('launch', modId),
  // plan.install items with a version download that public release (progress:
  // download, verify, copy...); without one, the active package installs as it is.
  run: (plan) => ipcRenderer.invoke('run', plan),
  window: (action) => ipcRenderer.invoke('win', action),
  onProgress: (fn) => ipcRenderer.on('progress', (_, p) => fn(p)),
  // Sideloading (vr-iwc.3). sideload() opens the file dialog; sideloadFiles()
  // takes the File objects of a drop, never a path string, so only files the
  // player chose reach the main process. Both give { canceled, results: [{ file, ok, info | error }] }.
  sideload: () => ipcRenderer.invoke('sideload:pick'),
  sideloadFiles: (files) => ipcRenderer.invoke('sideload:files', Array.from(files, (f) => webUtils.getPathForFile(f)).filter(Boolean)),
  // Downloads (vr-iwc.2): read the registry and indexes; per-game choices.
  refresh: (opts) => ipcRenderer.invoke('refresh', opts),
  // A game's data zip (line, notes, tutorial, known issues, media), fetched once
  // per index hash when its page opens; null when there's none.
  gameData: (modId) => ipcRenderer.invoke('game-data', modId),
  backToPublic: (modId) => ipcRenderer.invoke('back-to-public', modId),
  setBetaOptIn: (modId, on) => ipcRenderer.invoke('set-beta-opt-in', modId, on),
  dismissAnnouncement: (id) => ipcRenderer.invoke('dismiss-announcement', id),
});
