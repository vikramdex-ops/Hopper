// Xplorer² Modern preload — exposes a minimal, promise-based API to the renderer.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let transferCount = 0;
const listeners = new Set();

// Buffered push events: main may send before the renderer attached handlers
// (startup --open launches, update checks that finish early).
const updateSet = new Set(), updateBuf = [];
const openSet = new Set(), openBuf = [];
function sub(set, buf, fn) {
  set.add(fn);
  for (const m of buf.splice(0)) { try { fn(m); } catch { /* listener error */ } }
  return () => set.delete(fn);
}
function dispatch(set, buf, msg) {
  if (!set.size) { buf.push(msg); if (buf.length > 24) buf.shift(); return; }
  for (const l of set) { try { l(msg); } catch { /* listener error must not kill the bridge */ } }
}
ipcRenderer.on('x2:update', (e, m) => dispatch(updateSet, updateBuf, m));
ipcRenderer.on('app:openPath', (e, p) => dispatch(openSet, openBuf, p));

contextBridge.exposeInMainWorld('x2', {
  // settings
  home: () => ipcRenderer.invoke('sys:home'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.send('settings:set', s),
  flushSettings: () => ipcRenderer.send('settings:flush'),

  // fs
  listDir: (dir) => ipcRenderer.invoke('dir:list', dir),
  stat: (p) => ipcRenderer.invoke('fs:stat', p),
  mkdir: (dir, name) => ipcRenderer.invoke('fs:mkdir', dir, name),
  touch: (dir, name) => ipcRenderer.invoke('fs:touch', dir, name),
  rename: (o, n) => ipcRenderer.invoke('fs:rename', o, n),
  trash: (paths) => ipcRenderer.invoke('fs:trash', paths),
  deletePaths: (paths, permanent, jobId) => ipcRenderer.invoke('fs:delete', paths, permanent, jobId),
  transfer: (entries, dst, opts, jobId) => ipcRenderer.invoke('fs:transfer', entries, dst, opts, jobId),
  readText: (fp, limit) => ipcRenderer.invoke('fs:readText', fp, limit),
  writeText: (fp, text) => ipcRenderer.invoke('fs:writeText', fp, text),
  hexPreview: (fp) => ipcRenderer.invoke('fs:hex', fp),
  hash: (fp, algo) => ipcRenderer.invoke('fs:hash', fp, algo),
  treeStat: (dir, jobId) => ipcRenderer.invoke('fs:treeStat', dir, jobId),
  link: (kind, src, dst) => ipcRenderer.invoke('fs:links', kind, src, dst),
  split: (fp, mb, outDir, jobId) => ipcRenderer.invoke('fs:split', fp, mb, outDir, jobId),
  merge: (parts, out, jobId) => ipcRenderer.invoke('fs:merge', parts, out, jobId),

  // search & dupes
  search: (roots, opts, jobId) => ipcRenderer.invoke('search:run', roots, opts, jobId),
  cancelSearch: (jobId) => ipcRenderer.send('search:cancel', jobId),
  findDuplicates: (roots, opts, jobId) => ipcRenderer.invoke('dupes:run', roots, opts, jobId),

  // archives
  listArchive: (fp, ext) => ipcRenderer.invoke('archive:list', fp, ext),
  extractArchive: (fp, ext, dest, entries, jobId) => ipcRenderer.invoke('archive:extract', fp, ext, dest, entries, jobId),

  // shell
  open: (fp) => ipcRenderer.invoke('shell:open', fp),
  openInApp: (fp, appPath, args) => ipcRenderer.invoke('shell:openInApp', fp, appPath, args),
  showInExplorer: (fp) => ipcRenderer.invoke('shell:showInExplorer', fp),
  copyText: (t) => ipcRenderer.invoke('shell:copy', t),
  runCommand: (dir, cmd) => ipcRenderer.invoke('shell:run', dir, cmd),
  runCapture: (cmd, dir) => ipcRenderer.invoke('shell:runCapture', cmd, dir),
  runTerminal: (dir) => ipcRenderer.invoke('shell:runTerminal', dir),
  setTimes: (fp, mtimeMs, atimeMs) => ipcRenderer.invoke('fs:setTimes', fp, mtimeMs, atimeMs),
  setAttr: (fp, spec) => ipcRenderer.invoke('fs:setAttr', fp, spec),
  zipCreate: (items, outFile, jobId) => ipcRenderer.invoke('archive:zipCreate', items, outFile, jobId),
  winCmd: (cmd) => ipcRenderer.invoke('win:cmd', cmd),
  pick: (kind, opts) => ipcRenderer.invoke('dialog:pick', kind, opts),
  msgBox: (opts) => ipcRenderer.invoke('dialog:msg', opts),
  drives: () => ipcRenderer.invoke('drives:get'),
  openDev: () => ipcRenderer.invoke('sys:openDev'),

  // default file manager (per-user folder/drive association, Windows)
  defmgrStatus: () => ipcRenderer.invoke('defmgr:status'),
  defmgrApply: () => ipcRenderer.invoke('defmgr:apply'),
  defmgrRevert: () => ipcRenderer.invoke('defmgr:revert'),

  // silent updates
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdate: (fn) => sub(updateSet, updateBuf, fn),
  onOpenPath: (fn) => sub(openSet, openBuf, fn),

  // progress channel
  onProgress: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
});

ipcMainBridge();
function ipcMainBridge() {
  // NB: with contextIsolation on, preload's own `window` is the isolated world,
  // so `window.x2` is undefined here. Dispatch straight to the local listener set.
  ipcRenderer.on('t2f', (e, jobId, ...args) => {
    for (const l of listeners) { try { l(jobId, ...args); } catch { /* listener error must not kill the bridge */ } }
  });
}
