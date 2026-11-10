// Sandboxed preload: exposes a small, typed surface as window.hopper and forwards the
// MessagePorts for the engine and LAN processes into the page.
import { contextBridge, ipcRenderer, webUtils } from 'electron'

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)

ipcRenderer.on('hopper:port', (e, { name }) => {
  // Ports cannot cross contextBridge; window.postMessage can transfer them.
  window.postMessage({ hopperPort: name }, '*', e.ports)
})

const listen = (ch: string) => (fn: (data: any) => void) => {
  const wrapped = (_e: unknown, data: any) => fn(data)
  ipcRenderer.on(ch, wrapped)
  return () => ipcRenderer.removeListener(ch, wrapped)
}

const api = {
  app: {
    info: invoke('app:info'),
    quit: invoke('app:quit'),
    relaunch: invoke('app:relaunch'),
    setLogin: invoke('app:setLogin')
  },
  win: {
    minimize: invoke('win:minimize'),
    toggleMaximize: invoke('win:toggleMaximize'),
    close: invoke('win:close'),
    isMaximized: invoke('win:isMaximized'),
    fullscreen: invoke('win:fullscreen'),
    devtools: invoke('win:devtools'),
    onState: listen('hopper:win')
  },
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  office: { get: invoke('office:get'), load: invoke('office:load'), save: invoke('office:save') },
  dialog: { folder: invoke('dialog:folder'), files: invoke('dialog:files'), save: invoke('dialog:save') },
  shell: {
    open: invoke('shell:open'),
    openExternal: invoke('shell:openExternal'),
    openWithList: invoke('shell:openWithList'),
    openWithInvoke: invoke('shell:openWithInvoke'),
    openWithApp: invoke('shell:openWithApp'),
    props: invoke('shell:props'),
    setAttrs: invoke('shell:setAttrs'),
    cluster: invoke('shell:cluster'),
    shares: invoke('shell:shares'),
    print: invoke('shell:print'),
    terminal: invoke('shell:terminal'),
    trash: invoke('shell:trash'),
    restore: invoke('shell:restore'),
    recycleList: invoke('shell:recycleList'),
    drives: invoke('shell:drives'),
    firewall: invoke('shell:firewall')
  },
  clip: { writeFiles: invoke('clip:writeFiles'), read: invoke('clip:read'), writeText: invoke('clip:writeText') },
  drag: { start: (paths: string[]) => ipcRenderer.send('drag:start', paths) },
  /** Real paths for files dropped in from Explorer (File.path no longer exists). */
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  thumbs: { clear: invoke('thumbs:clear') },
  update: { check: invoke('update:check'), install: invoke('update:install'), state: invoke('update:state'), on: listen('hopper:update') },
  defmgr: { status: invoke('defmgr:status'), apply: invoke('defmgr:apply'), revert: invoke('defmgr:revert') },
  fs: { ensureDir: invoke('fs:ensureDir') },
  onOpen: listen('hopper:open'),
  onTheme: listen('hopper:theme')
}

contextBridge.exposeInMainWorld('hopper', api)
export type HopperApi = typeof api
