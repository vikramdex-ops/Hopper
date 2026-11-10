// Network node IPC: discovery, share lists and sign-in through the native helper (native/Network.cs).
// Passwords pass straight through to the helper's stdin for one WNetAddConnection2 call; nothing here
// logs, stores or echoes them. "Remember" is Windows Credential Manager's job, never Hopper's settings.
import { ipcMain } from 'electron'
import { ctx } from './ctx'

const SOURCES = ['wsd', 'browse', 'serverEnum', 'connected']
const str = (v: unknown, max = 1024) => (typeof v === 'string' ? v.slice(0, max) : '')

export function registerNetworkIpc() {
  const h = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(name, (_e, ...args) => fn(...args))

  /** Each source has its own budget; the old browse list can take ~10 s to fail, so it is asked separately. */
  h('net:computers', (sources?: string[]) => {
    const want = Array.isArray(sources) ? sources.filter((s) => SOURCES.includes(s)) : SOURCES
    const slow = want.includes('browse') || want.includes('serverEnum')
    const budgetMs = slow ? 12000 : 6000
    return ctx.shell.call('netComputers', { sources: want, wsdMs: 2500, budgetMs }, budgetMs + 5000)
  })
  h('net:shares', (server: string) => ctx.shell.call('netShares', { server: str(server, 260), timeoutMs: 15000 }, 25000))
  h('net:connect', (spec: { remote?: string; user?: string; password?: string; remember?: boolean }) =>
    ctx.shell.call(
      'netConnect',
      { remote: str(spec?.remote, 520), user: str(spec?.user, 256), password: str(spec?.password, 512), remember: spec?.remember === true, timeoutMs: 30000 },
      45000
    )
  )
  h('net:disconnect', (server: string, forget?: boolean) => ctx.shell.call('netDisconnect', { server: str(server, 260), forget: forget === true }, 20000))
}
