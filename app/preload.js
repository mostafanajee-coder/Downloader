'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('queue:list'),
  add: (payload) => ipcRenderer.invoke('queue:add', payload),
  pause: (id) => ipcRenderer.invoke('queue:pause', id),
  resume: (id) => ipcRenderer.invoke('queue:resume', id),
  cancel: (id) => ipcRenderer.invoke('queue:cancel', id),
  remove: (id) => ipcRenderer.invoke('queue:remove', id),
  pauseAll: () => ipcRenderer.invoke('queue:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('queue:resumeAll'),
  startAll: () => ipcRenderer.invoke('queue:startAll'),
  refreshUrl: (id, url) => ipcRenderer.invoke('queue:refreshUrl', { id, url }),
  hold: (id) => ipcRenderer.invoke('queue:hold', id),
  startQueue: () => ipcRenderer.invoke('queue:startQueue'),
  stopQueue: () => ipcRenderer.invoke('queue:stopQueue'),
  isQueueRunning: () => ipcRenderer.invoke('queue:isQueueRunning'),
  onQueueStateChanged: (cb) => ipcRenderer.on('queue:state-changed', (_e, state) => cb(state)),
  openFile: (destPath) => ipcRenderer.invoke('shell:openFile', destPath),
  showInFolder: (destPath) => ipcRenderer.invoke('shell:showInFolder', destPath),
  getClientCount: () => ipcRenderer.invoke('bridge:clientCount'),
  pickDestDir: () => ipcRenderer.invoke('dialog:pickDestDir'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  onItemAdded: (cb) => ipcRenderer.on('queue:item-added', (_e, item) => cb(item)),
  onItemUpdated: (cb) => ipcRenderer.on('queue:item-updated', (_e, item) => cb(item)),
  onItemRemoved: (cb) => ipcRenderer.on('queue:item-removed', (_e, info) => cb(info)),
});
