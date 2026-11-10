// Bridges to the main process (window.hopper, via preload) and to the engine and LAN
// utility processes (direct MessagePorts, so file work never queues behind the main process).
import { client } from '@shared/rpc'
import type { HopperApi } from '../../preload/index'

declare global {
  interface Window {
    hopper: HopperApi
  }
}

const raw = window.hopper
const picker = async (opts: Record<string, unknown>) => (await import('./commands')).dialogs.pickFolder?.(opts)

/** window.hopper, with the folder and file pickers replaced by Hopper's own dialog. */
export const host: HopperApi = {
  ...raw,
  dialog: {
    ...raw.dialog,
    folder: (async (title?: string, defaultPath?: string) => ((await picker({ title: title ?? 'Choose a folder', mode: 'folder', start: defaultPath })) as string | undefined) ?? null) as HopperApi['dialog']['folder'],
    files: (async (title?: string, filters?: { extensions: string[] }[]) => {
      const filter = (filters ?? []).flatMap((f) => f.extensions).filter((e) => e !== '*').map((e) => e.toLowerCase())
      return ((await picker({ title: title ?? 'Choose files', mode: 'file', multiple: true, filter })) as string[] | undefined) ?? []
    }) as HopperApi['dialog']['files']
  }
}

function portClient(name: 'engine' | 'lan') {
  let port: MessagePort | null = null
  const queue: unknown[] = []
  const c = client({
    postMessage(msg) {
      if (port) port.postMessage(msg)
      else queue.push(msg)
    }
  })
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.hopperPort !== name || !e.ports[0]) return
    port?.close()
    port = e.ports[0]
    port.onmessage = (m) => c.onMessage(m.data)
    for (const msg of queue.splice(0)) port.postMessage(msg)
  })
  return c
}

export const engine = portClient('engine')
export const lan = portClient('lan')
