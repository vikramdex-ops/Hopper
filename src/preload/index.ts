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
    /** the window listens now: main delivers what waited for it */
    ready: invoke('app:ready'),
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
  office: { get: invoke('office:get'), load: invoke('office:load'), save: invoke('office:save'), lock: invoke('office:lock'), revoke: invoke('office:revoke'), onChanged: listen('hopper:office') },
  dialog: { folder: invoke('dialog:folder'), files: invoke('dialog:files'), save: invoke('dialog:save') },
  shell: {
    open: invoke('shell:open'),
    openExternal: invoke('shell:openExternal'),
    shellNew: invoke('shell:shellNew'),
    openWithList: invoke('shell:openWithList'),
    openWithInvoke: invoke('shell:openWithInvoke'),
    openWithApp: invoke('shell:openWithApp'),
    /** the real Windows context menu (More options); resolves when it closes: { invoked, verb? } */
    menu: invoke('shell:menu'),
    createShortcut: invoke('shell:createShortcut'),
    readShortcut: invoke('shell:readShortcut'),
    runAsAdmin: invoke('shell:runAsAdmin'),
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
    firewall: invoke('shell:firewall'),
    firewallStatus: invoke('shell:firewallStatus')
  },
  /** Network node: discovery, share lists, sign-in (passwords go straight to the native helper) */
  net: { computers: invoke('net:computers'), shares: invoke('net:shares'), connect: invoke('net:connect'), disconnect: invoke('net:disconnect'), mapDrive: invoke('net:mapDrive'), unmapDrive: invoke('net:unmapDrive') },
  clip: { writeFiles: invoke('clip:writeFiles'), read: invoke('clip:read'), writeText: invoke('clip:writeText') },
  /** paste-and-go: the path in the clipboard text / in given text ({ path, kind } or null) */
  pastePath: { fromClipboard: invoke('path:fromClipboard'), resolve: invoke('path:resolve') },
  /** unreachable folders: waited on in main, back = reload + notification (main/reach.ts) */
  reach: { watch: invoke('reach:watch'), unwatch: invoke('reach:unwatch'), now: invoke('reach:now'), on: listen('hopper:reach') },
  /** Hopper Clipboard (main/clipboard.ts) */
  cliphist: {
    list: invoke('cliphist:list'),
    use: invoke('cliphist:use'),
    pin: invoke('cliphist:pin'),
    remove: invoke('cliphist:remove'),
    clear: invoke('cliphist:clear'),
    tidy: invoke('cliphist:tidy'),
    image: invoke('cliphist:image'),
    saveImage: invoke('cliphist:saveImage'),
    pasteFiles: invoke('cliphist:pasteFiles'),
    show: invoke('cliphist:show'),
    hide: invoke('cliphist:hide'),
    reveal: invoke('cliphist:reveal'),
    on: listen('hopper:cliphist'),
    onTransfer: listen('hopper:clip-transfer'),
    onReveal: listen('hopper:clip-reveal')
  },
  drag: { start: (paths: string[]) => ipcRenderer.send('drag:start', paths) },
  /** Real paths for files dropped in from Explorer (File.path no longer exists). */
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  thumbs: { clear: invoke('thumbs:clear') },
  update: { check: invoke('update:check'), install: invoke('update:install'), state: invoke('update:state'), on: listen('hopper:update') },
  defmgr: { status: invoke('defmgr:status'), apply: invoke('defmgr:apply'), revert: invoke('defmgr:revert') },
  fs: { ensureDir: invoke('fs:ensureDir') },
  /** Dexterity Share server hosted by this PC (setup wizard and status) */
  share: {
    state: invoke('share:state'),
    call: invoke('share:call'),
    connectPointer: invoke('share:connectPointer'),
    setTunnelToken: invoke('share:setTunnelToken'),
    forgetToken: invoke('share:forgetToken'),
    configure: invoke('share:configure'),
    on: listen('hopper:share')
  },
  onOpen: listen('hopper:open'),
  /** a watched-folder notification was clicked: { folder, select } */
  onWatchOpen: listen('hopper:watch-open'),
  onTheme: listen('hopper:theme')
}

contextBridge.exposeInMainWorld('hopper', api)
export type HopperApi = typeof api
