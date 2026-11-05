// Tiny request/response + event protocol over anything with postMessage.
// Used renderer<->engine and renderer<->lan over MessagePorts, so neither
// talks through the main process.

export interface Wire {
  postMessage(msg: unknown): void
}

type Req = { t: 'req'; id: number; m: string; p: unknown[] }
type Res = { t: 'res'; id: number; ok: boolean; v?: unknown; e?: string }
type Evt = { t: 'evt'; n: string; d: unknown }
type Msg = Req | Res | Evt

export type Handlers = Record<string, (...args: any[]) => unknown>

/** Serve `handlers` on a wire. Returns an emit function for events. */
export function serve(wire: Wire, handlers: Handlers) {
  return {
    async onMessage(raw: unknown) {
      const msg = raw as Msg
      if (!msg || msg.t !== 'req') return
      const fn = handlers[msg.m]
      if (!fn) {
        wire.postMessage({ t: 'res', id: msg.id, ok: false, e: `no method ${msg.m}` } satisfies Res)
        return
      }
      try {
        const v = await fn(...msg.p)
        wire.postMessage({ t: 'res', id: msg.id, ok: true, v } satisfies Res)
      } catch (err: any) {
        wire.postMessage({ t: 'res', id: msg.id, ok: false, e: String(err?.message ?? err) } satisfies Res)
      }
    },
    emit(n: string, d: unknown) {
      wire.postMessage({ t: 'evt', n, d } satisfies Evt)
    }
  }
}

/** Client side: call(method, ...args) and on(event, fn). */
export function client(wire: Wire) {
  let seq = 0
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const listeners = new Map<string, Set<(d: any) => void>>()
  return {
    onMessage(raw: unknown) {
      const msg = raw as Msg
      if (!msg) return
      if (msg.t === 'res') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        msg.ok ? p.resolve(msg.v) : p.reject(new Error(msg.e))
      } else if (msg.t === 'evt') {
        listeners.get(msg.n)?.forEach((fn) => fn(msg.d))
        listeners.get('*')?.forEach((fn) => fn({ n: msg.n, d: msg.d }))
      }
    },
    call<T = any>(m: string, ...p: unknown[]): Promise<T> {
      const id = ++seq
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        wire.postMessage({ t: 'req', id, m, p } satisfies Req)
      })
    },
    on(n: string, fn: (d: any) => void) {
      let set = listeners.get(n)
      if (!set) listeners.set(n, (set = new Set()))
      set.add(fn)
      return () => set!.delete(fn)
    }
  }
}

export type RpcClient = ReturnType<typeof client>
