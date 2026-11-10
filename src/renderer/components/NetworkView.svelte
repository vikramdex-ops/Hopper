<script lang="ts">
  // The Network page: hopper:network lists saved places and the computers Hopper found;
  // hopper:network?host=NAME lists that computer's shared folders. Opening a share goes to the
  // normal file list at \\NAME\share.
  import type { Pane } from '../lib/pane.svelte'
  import { VIRTUAL } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { host as hostApi } from '../lib/api'
  import { net } from '../lib/network.svelte'
  import { networkHostOf, networkHostPath, parseAddress, visibleShares, SOURCE_LABEL, type NetComputer, type NetShare, type NetworkPlace } from '@shared/network'
  import { plural } from '../lib/format'
  import Icon from './Icon.svelte'
  import { untrack } from 'svelte'

  let { pane }: { pane: Pane } = $props()
  const server = $derived(networkHostOf(pane.path))
  const listing = $derived(server ? net.listing(server) : undefined)
  const f = $derived(pane.filter.trim().toLowerCase())
  const match = (...texts: (string | undefined)[]) => !f || texts.some((t) => t?.toLowerCase().includes(f))

  const allShares = $derived(server && listing ? visibleShares(server, listing.shares, true) : [])
  const shares = $derived(allShares.filter((s) => (net.settings.showHidden || !s.hidden) && match(s.name, s.remark)))
  const hiddenCount = $derived(allShares.filter((s) => s.hidden).length)
  const places = $derived(net.places.filter((p) => match(p.name, p.path)))
  const computers = $derived(net.computers.filter((c) => match(c.name, c.address, ...(c.people ?? []))))

  // Load when the page opens (and when Back/Forward moves between computers).
  $effect(() => {
    const s = server
    untrack(() => (s ? void net.loadShares(s) : net.scan()))
  })

  function refresh() {
    if (server) void net.loadShares(server, true)
    else net.scan(true)
  }

  const newTab = (e: MouseEvent) => e.button === 1 || e.ctrlKey

  function openComputer(c: string, e?: MouseEvent) {
    void pane.navigate(networkHostPath(c), { newTab: !!e && newTab(e) })
  }

  function openShare(s: NetShare, e?: MouseEvent) {
    void net.open(pane, s.path, { newTab: !!e && newTab(e) })
  }

  function openPlace(p: NetworkPlace, e?: MouseEvent) {
    void net.open(pane, p.path, { newTab: !!e && newTab(e) })
  }

  async function copy(text: string) {
    await hostApi.clip.writeText(text)
    app.toast('info', 'Path copied', text)
  }

  function placeKind(p: NetworkPlace) {
    const a = parseAddress(p.path)
    return a.ok ? a.kind : 'share'
  }

  function describe(c: NetComputer) {
    if (c.self) return 'This PC'
    const bits: string[] = []
    if (c.people?.length) bits.push(`Hopper · ${c.people.slice(0, 2).join(', ')}${c.people.length > 2 ? ` +${c.people.length - 2}` : ''}`)
    for (const s of c.sources) {
      const l = SOURCE_LABEL[s]
      if (s !== 'peers' && l && !bits.includes(l)) bits.push(l)
    }
    return bits.join(' · ')
  }

  function computerMenu(e: MouseEvent, c: NetComputer) {
    e.preventDefault()
    app.openMenu(e.clientX, e.clientY, [
      { label: 'Open', icon: 'open', run: () => openComputer(c.name) },
      { label: 'Open in new tab', icon: 'plus', run: () => pane.openTab(networkHostPath(c.name)) },
      { separator: true },
      { label: 'Sign in…', icon: 'lock', run: () => void net.signIn(c.name) },
      { label: 'Add as a network place', icon: 'pin', run: () => addPlace(`\\\\${c.name}`) },
      { label: 'Copy path', icon: 'copyPath', run: () => void copy(`\\\\${c.name}`) }
    ])
  }

  function shareMenu(e: MouseEvent, s: NetShare) {
    e.preventDefault()
    app.openMenu(e.clientX, e.clientY, [
      { label: 'Open', icon: 'open', run: () => openShare(s) },
      { label: 'Open in new tab', icon: 'plus', run: () => void net.open(pane, s.path, { newTab: true }) },
      ...(app.dual ? [{ label: 'Open in other pane', icon: 'dualPane', run: () => void net.open(app.panes[pane.index === 0 ? 1 : 0], s.path) }] : []),
      { separator: true },
      { label: 'Add as a network place', icon: 'pin', run: () => addPlace(s.path) },
      { label: 'Sign in to this share…', icon: 'lock', run: () => void net.signIn(server!, s.name) },
      { label: 'Copy path', icon: 'copyPath', run: () => void copy(s.path) }
    ])
  }

  function placeMenu(e: MouseEvent, p: NetworkPlace) {
    e.preventDefault()
    app.openMenu(e.clientX, e.clientY, [
      { label: 'Open', icon: 'open', run: () => openPlace(p) },
      { label: 'Open in new tab', icon: 'plus', run: () => void net.open(pane, p.path, { newTab: true }) },
      { separator: true },
      { label: 'Rename…', icon: 'rename', run: () => void net.renamePlace(p.id) },
      { label: 'Remove', icon: 'delete', run: () => net.removePlace(p.id) },
      { label: 'Copy path', icon: 'copyPath', run: () => void copy(p.path) }
    ])
  }

  function addPlace(path = '') {
    const a = parseAddress(path)
    if (path && a.ok) {
      const r = net.addPlaceRaw(a.unc)
      if (!('error' in r)) app.toast('success', `Added ${r.name || r.path}`, 'It is under Network in the sidebar.')
      return
    }
    void net.addPlace(path)
  }
</script>

<div class="net" aria-label={server ? `Shared folders on ${server}` : 'Network'}>
  {#if !server}
    <header>
      <div class="ttl">
        <h1 class="title">Network</h1>
        <div class="caption">Computers and shared folders on the office network</div>
      </div>
      <div class="actions">
        <button class="btn" onclick={() => addPlace()}><Icon name="plus" /> Add a network place</button>
        <button class="btn subtle icon" title="Look for computers again" aria-label="Refresh" onclick={refresh} disabled={net.busy > 0}><Icon name="refresh" /></button>
      </div>
    </header>

    {#if net.places.length}
      <section aria-label="Saved places">
        <h2 class="subtitle">Saved places</h2>
        <div class="tiles">
          {#each places as p (p.id)}
            {@const kind = placeKind(p)}
            <button class="tile" title={p.path} onclick={(e) => openPlace(p, e)} onauxclick={(e) => e.button === 1 && openPlace(p, e)} oncontextmenu={(e) => placeMenu(e, p)}>
              <span class="ic" class:fold={kind !== 'server'}><Icon name={kind === 'server' ? 'computer' : 'folder'} size={28} /></span>
              <span class="tx">
                <span class="nm ellipsis">{p.name || p.path}</span>
                <span class="caption ellipsis">{p.name ? p.path : kind === 'server' ? 'Computer' : 'Shared folder'}</span>
              </span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <section aria-label="Computers">
      <h2 class="subtitle">
        Computers
        {#if net.busy}<span class="spin" aria-hidden="true"></span><span class="caption">Looking for computers…</span>{/if}
      </h2>
      {#if computers.length}
        <div class="tiles">
          {#each computers as c (c.key)}
            <button class="tile" title={`\\\\${c.name}${c.address && c.address !== c.name ? `\n${c.address}` : ''}`} onclick={(e) => openComputer(c.name, e)} onauxclick={(e) => e.button === 1 && openComputer(c.name, e)} oncontextmenu={(e) => computerMenu(e, c)}>
              <span class="ic"><Icon name="computer" size={28} /></span>
              <span class="tx">
                <span class="nm ellipsis">{c.name}</span>
                <span class="caption ellipsis">{describe(c)}</span>
              </span>
            </button>
          {/each}
        </div>
      {:else if net.busy}
        <p class="empty caption">Looking for computers on the network…</p>
      {:else if f}
        <p class="empty caption">No computers match "{pane.filter}".</p>
      {:else}
        <div class="empty">
          <p>No computers found.</p>
          <p class="caption">Many computers and NAS boxes don't announce themselves on the network. If you know a name or IP address, add it as a network place.</p>
          <button class="btn" onclick={() => addPlace()}><Icon name="plus" /> Add a network place</button>
        </div>
      {/if}
      <p class="foot caption">Not every computer shows up here. Type <b>\\name</b> in the address bar, or add a network place, to open one by name or IP address. FTP servers aren't supported yet.</p>
    </section>
  {:else}
    <header>
      <div class="ttl row">
        <span class="hic"><Icon name="computer" size={28} /></span>
        <div>
          <h1 class="title">{server}</h1>
          <div class="caption">
            {#if listing?.remembered}Signed in as {listing.remembered} (remembered on this PC){:else if listing?.connected}Connected from this PC{:else}Shared folders{/if}
          </div>
        </div>
      </div>
      <div class="actions">
        {#if listing?.connected || listing?.remembered}
          <button class="btn" onclick={() => void net.signOut(server!, !!listing?.remembered)} title={listing?.remembered ? 'Close the connection and remove the saved sign-in' : 'Close the connection'}><Icon name="lock" /> Sign out</button>
        {:else}
          <button class="btn" onclick={() => void net.signIn(server!)}><Icon name="lock" /> Sign in…</button>
        {/if}
        <button class="btn" onclick={() => addPlace(`\\\\${server}`)} title="Keep this computer under Network in the sidebar"><Icon name="pin" /> Save</button>
        <label class="check" title="Administrative shares such as C$ and ADMIN$">
          <input type="checkbox" checked={net.settings.showHidden} onchange={(e) => net.setShowHidden((e.currentTarget as HTMLInputElement).checked)} />
          <span>Hidden shares</span>
        </label>
        <button class="btn subtle icon" title="Refresh" aria-label="Refresh" onclick={refresh} disabled={listing?.status === 'loading'}><Icon name="refresh" /></button>
      </div>
    </header>

    {#if !listing || listing.status === 'loading'}
      <div class="state" role="status"><span class="spin" aria-hidden="true"></span> Opening {server}…</div>
    {:else if listing.status === 'error' && listing.error}
      <div class="state err" role="alert" data-code={listing.error.code}>
        <span class="sic"><Icon name={listing.error.code === 'denied' || listing.error.code === 'badlogin' ? 'lock' : 'warning'} size={28} /></span>
        <p class="msg">{listing.error.message}</p>
        {#if listing.error.winerr}<p class="caption">Windows error {listing.error.winerr}</p>{/if}
        <div class="btns">
          {#if listing.error.canSignIn}<button class="btn primary" onclick={() => void net.signIn(server!)}><Icon name="lock" /> Sign in…</button>{/if}
          {#if listing.error.code === 'conflict'}<button class="btn primary" onclick={() => void net.signOut(server!)}>Sign out of {server}</button>{/if}
          {#if listing.error.code === 'unsupported'}<button class="btn" onclick={() => void net.addPlace(`\\\\${server}\\`)}><Icon name="plus" /> Add a share by name…</button>{/if}
          <button class="btn" onclick={refresh}><Icon name="refresh" /> Try again</button>
          <button class="btn subtle" onclick={() => pane.navigate(VIRTUAL.network)}>Back to Network</button>
        </div>
      </div>
    {:else if !shares.length}
      <div class="state">
        <p class="msg">{f ? `No shared folders match "${pane.filter}".` : `${server} isn't sharing any folders${hiddenCount && !net.settings.showHidden ? ` (it has ${plural(hiddenCount, 'hidden share')})` : ''}.`}</p>
      </div>
    {:else}
      <div class="tiles" aria-label="Shared folders">
        {#each shares as s (s.name)}
          <button class="tile" class:hid={s.hidden} title={`${s.path}${s.remark ? `\n${s.remark}` : ''}`} onclick={(e) => openShare(s, e)} onauxclick={(e) => e.button === 1 && openShare(s, e)} oncontextmenu={(e) => shareMenu(e, s)}>
            <span class="ic fold"><Icon name="folder" size={28} /></span>
            <span class="tx">
              <span class="nm ellipsis">{s.name}</span>
              <span class="caption ellipsis">{s.remark || 'Shared folder'}</span>
            </span>
          </button>
        {/each}
      </div>
      {#if hiddenCount && !net.settings.showHidden && !f}
        <p class="foot caption">{plural(hiddenCount, 'hidden share')} not shown.</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .net {
    flex: 1;
    overflow: auto;
    padding: 24px 28px 32px;
  }
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }
  h1 {
    margin: 0;
  }
  .ttl.row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .hic {
    color: var(--text-2);
    display: flex;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .actions .check {
    font-size: 13px;
    margin: 0 4px;
  }
  section {
    margin-bottom: 22px;
  }
  h2 {
    margin: 0 0 10px 2px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 .caption {
    font-weight: 400;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 8px;
  }
  .tile {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    height: 60px;
    padding: 0 12px;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    color: var(--text);
    text-align: left;
  }
  .tile:hover {
    background: var(--hover);
  }
  .tile:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .tile.hid {
    opacity: 0.75;
  }
  .ic {
    display: flex;
    flex: none;
    color: var(--text-2);
  }
  .ic.fold {
    color: #e8a33d;
  }
  /* .icon-svg is fixed at 16px app-wide; these icons are drawn larger */
  .ic :global(svg),
  .hic :global(svg),
  .sic :global(svg) {
    width: 28px;
    height: 28px;
  }
  .tx {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 2px;
  }
  .nm {
    font-weight: 600;
  }
  .empty {
    padding: 8px 2px;
  }
  .empty p {
    margin: 0 0 8px;
  }
  .foot {
    margin: 14px 2px 0;
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 48px 16px;
    text-align: center;
    color: var(--text-2);
  }
  .state[role='status'] {
    flex-direction: row;
    justify-content: center;
  }
  .state .msg {
    margin: 0;
    max-width: 520px;
    color: var(--text);
    font-size: 14px;
  }
  .state p.caption {
    margin: 0;
  }
  .sic {
    display: flex;
    color: var(--warn);
  }
  .btns {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 6px;
  }
  .spin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--stroke-2);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
    display: inline-block;
    flex: none;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
