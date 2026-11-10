// Network node state: discovered computers, each computer's share list, saved network places and
// signing in. Helper calls go through `netApi` (one place, so the e2e test can stand in for a server).
import { app } from './app.svelte'
import { host } from './api'
import { VIRTUAL, type Pane } from './pane.svelte'
import {
  defaultNetworkSettings, hostKey, isAccessDenied, mergeComputers, netCallError, netError, networkHostPath, parseAddress, samePlacePath,
  type NetError, type NetworkPlace, type NetworkSettings, type RawShare, type RawSource
} from '@shared/network'

export interface ShareListing {
  status: 'loading' | 'ok' | 'error'
  shares: RawShare[]
  error?: NetError
  /** this PC has a connection open to the server */
  connected?: boolean
  /** user name Windows Credential Manager remembers for the server */
  remembered?: string | null
  at: number
}

type RawShares = { server: string; shares?: RawShare[]; error?: { stage: string; code: number }; connected?: boolean; remembered?: string | null; ms?: number }
type RawConnect = { ok?: boolean; remembered?: boolean; error?: { stage: string; code: number } }
type RawDisconnect = { closed: number; failed: { remote: string; code: number }[]; forgot: boolean }

/** The native helper's network commands (via main). Replaced only by tests/e2e/network.mjs. */
export const netApi = {
  computers: (sources: string[]) => host.net.computers(sources) as Promise<{ sources: RawSource[]; ms: number }>,
  shares: (server: string) => host.net.shares(server) as Promise<RawShares>,
  connect: (spec: { remote: string; user: string; password: string; remember: boolean }) => host.net.connect(spec) as Promise<RawConnect>,
  disconnect: (server: string, forget: boolean) => host.net.disconnect(server, forget) as Promise<RawDisconnect>
}

/** Sources are asked in groups: the quick ones first; the old Windows browse list (slow to fail) on its own. */
const QUICK = [['connected'], ['wsd']]
const SLOW = ['browse', 'serverEnum']
const RESCAN_MS = 5 * 60_000
const SHARES_FRESH_MS = 60_000

let placeSeq = 0
const placeId = () => `np${Date.now().toString(36)}${++placeSeq}`

class Net {
  raw = $state.raw<Record<string, RawSource>>({})
  /** quick source groups still running */
  busy = $state(0)
  /** the slow browse-list group is still running */
  slow = $state(false)
  scannedAt = $state(0)
  listings = $state.raw<Record<string, ShareListing>>({})

  settings = $derived<NetworkSettings>({ ...defaultNetworkSettings(), ...(app.settings?.network ?? {}) })
  places = $derived(this.settings.places)
  computers = $derived(mergeComputers(Object.values(this.raw), app.peers, app.info?.identity?.host ?? ''))

  /** Looks for computers; does nothing if a scan ran in the last few minutes unless forced. */
  scan(force = false) {
    if (this.busy) return
    if (!force && this.scannedAt && Date.now() - this.scannedAt < RESCAN_MS) return
    this.scannedAt = Date.now()
    const take = (r: { sources: RawSource[] }) => {
      const next = { ...this.raw }
      for (const s of r.sources ?? []) next[s.id] = s
      this.raw = next
    }
    for (const g of QUICK) {
      this.busy++
      netApi.computers(g).then(take, () => {}).finally(() => this.busy--)
    }
    if (!this.slow) {
      this.slow = true
      netApi.computers(SLOW).then(take, () => {}).finally(() => (this.slow = false))
    }
  }

  listing(server: string): ShareListing | undefined {
    return this.listings[hostKey(server)]
  }

  private setListing(server: string, l: ShareListing) {
    this.listings = { ...this.listings, [hostKey(server)]: l }
  }

  async loadShares(server: string, force = false) {
    const cur = this.listing(server)
    if (cur?.status === 'loading') return
    if (!force && cur?.status === 'ok' && Date.now() - cur.at < SHARES_FRESH_MS) return
    this.setListing(server, { status: 'loading', shares: cur?.shares ?? [], connected: cur?.connected, remembered: cur?.remembered, at: Date.now() })
    try {
      const r = await netApi.shares(server)
      if (r.error) this.setListing(server, { status: 'error', shares: [], error: netError(r.error, server), connected: r.connected, remembered: r.remembered, at: Date.now() })
      else this.setListing(server, { status: 'ok', shares: r.shares ?? [], connected: r.connected, remembered: r.remembered, at: Date.now() })
    } catch (e) {
      this.setListing(server, { status: 'error', shares: [], error: netCallError(e, server), at: Date.now() })
    }
  }

  // ---- signing in -------------------------------------------------------------------------

  /** One sign-in attempt. The password is handed to the helper and not kept. */
  async connect(remote: string, user: string, password: string, remember: boolean): Promise<{ error?: NetError; remembered?: boolean }> {
    const server = hostOf(remote)
    try {
      const r = await netApi.connect({ remote, user, password, remember })
      if (r.error) return { error: netError(r.error, server) }
      return { remembered: r.remembered }
    } catch (e) {
      return { error: netCallError(e, server) }
    }
  }

  /** Hopper's own sign-in dialog; true when signed in. */
  async signIn(server: string, share = ''): Promise<boolean> {
    const { default: C } = await import('../components/dialogs/NetworkSignInDialog.svelte')
    const ok = await app.dialog<boolean>(C, { host: server, share })
    if (ok) {
      app.toast('success', `Signed in to ${server}`)
      void this.loadShares(server, true)
    }
    return !!ok
  }

  /** Closes this PC's drive-less connections to the server (mapped drives are left alone); optionally forgets the saved sign-in. */
  async signOut(server: string, forget = false) {
    try {
      const r = await netApi.disconnect(server, forget)
      if (r.failed.length) {
        const e = netError({ stage: 'disconnect', code: r.failed[0].code }, server)
        app.toast('warning', `Couldn't sign out of ${server}`, e.message)
      } else {
        app.toast('info', `Signed out of ${server}`, forget ? (r.forgot ? 'The saved sign-in was removed from this PC.' : 'There was no saved sign-in to remove.') : undefined)
      }
    } catch (e) {
      app.toast('error', `Couldn't sign out of ${server}`, netCallError(e, server).message)
    }
    void this.loadShares(server, true)
  }

  // ---- saved places -------------------------------------------------------------------------

  private save(patch: Partial<NetworkSettings>) {
    app.updateSettings({ network: { ...$state.snapshot(this.settings), ...patch } })
  }

  setExpanded(expanded: boolean) {
    this.save({ expanded })
    if (expanded) this.scan()
  }

  setShowHidden(showHidden: boolean) {
    this.save({ showHidden })
  }

  /** Adds a place; returns it, or the existing one if that address is already saved. */
  addPlaceRaw(path: string, name = ''): NetworkPlace | { error: string } {
    const a = parseAddress(path)
    if (!a.ok) return { error: a.message }
    const have = this.places.find((p) => samePlacePath(p.path, a.unc))
    if (have) return have
    const place: NetworkPlace = { id: placeId(), path: a.unc, name: name.trim() || undefined, added: Date.now() }
    this.save({ places: [...$state.snapshot(this.places), place] })
    return place
  }

  /** "Add a network place…": Hopper's dialog, then saved on this PC. */
  async addPlace(initial = '') {
    const { default: C } = await import('../components/dialogs/NetworkPlaceDialog.svelte')
    const r = await app.dialog<{ path: string; name: string } | null>(C, { value: initial })
    if (!r) return null
    const before = this.places.length
    const p = this.addPlaceRaw(r.path, r.name)
    if ('error' in p) {
      app.toast('error', "Couldn't add the network place", p.error)
      return null
    }
    if (this.places.length === before) app.toast('info', `${p.name || p.path} is already a saved network place`)
    else app.toast('success', `Added ${p.name || p.path}`, 'It is under Network in the sidebar.')
    if (!this.settings.expanded) this.save({ expanded: true })
    return p
  }

  async renamePlace(id: string) {
    const p = this.places.find((x) => x.id === id)
    if (!p) return
    const name = await app.prompt('Rename network place', p.name || '', `Name for ${p.path} (leave empty to show the address)`)
    if (name === null) return
    this.save({ places: $state.snapshot(this.places).map((x) => (x.id === id ? { ...x, name: name.trim() || undefined } : x)) })
  }

  removePlace(id: string) {
    const all = $state.snapshot(this.places)
    const i = all.findIndex((x) => x.id === id)
    if (i < 0) return
    const [gone] = all.splice(i, 1)
    this.save({ places: all })
    app.toast('info', `Removed ${gone.name || gone.path}`, undefined, [
      { label: 'Undo', run: () => this.save({ places: [...$state.snapshot(this.places).slice(0, i), gone, ...$state.snapshot(this.places).slice(i)] }) }
    ])
  }

  // ---- opening -------------------------------------------------------------------------------

  /** Where a saved place or address opens: a computer's share list, or the folder itself. */
  targetOf(path: string) {
    const a = parseAddress(path)
    if (!a.ok) return null
    return a.kind === 'server' ? networkHostPath(a.host) : a.unc
  }

  /**
   * Opens a share or folder in the file list. If Windows refuses with "access denied", Hopper's
   * sign-in dialog comes up and the listing is retried after signing in.
   */
  async open(pane: Pane, path: string, opts: { newTab?: boolean } = {}) {
    const target = this.targetOf(path)
    if (!target) return
    await pane.navigate(target, { newTab: opts.newTab })
    if (target.startsWith(VIRTUAL.network) || !pane.error || !isAccessDenied(pane.error)) return
    if (pane.path.toLowerCase() !== target.toLowerCase()) return
    const a = parseAddress(target)
    if (a.ok && (await this.signIn(a.host, a.share))) await pane.refresh()
  }
}

export const hostOf = (remote: string) => remote.replace(/^[\\/]+/, '').split(/[\\/]/)[0]

export const net = new Net()

// test hook, next to window.__hopper
;(window as any).__hopperNet = { net, netApi }
