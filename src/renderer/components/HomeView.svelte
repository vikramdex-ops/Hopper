<script lang="ts">
  // Home: a start page, not a second sidebar. Where you were, what arrived, what needs attention.
  import type { Pane } from '../lib/pane.svelte'
  import { VIRTUAL } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { basename, dirname, fmtAgo, fmtSize, initials, personColor, plural } from '../lib/format'
  import { dialogs, run } from '../lib/commands'
  import Icon from './Icon.svelte'

  let { pane }: { pane: Pane } = $props()

  const greeting = $derived.by(() => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  })
  const me = $derived(app.settings?.profile.displayName || app.info?.identity?.displayName || '')
  const first = $derived(me ? me.split(' ')[0].replace(/^./, (c: string) => c.toUpperCase()) : '')
  const today = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())

  const recent = $derived((app.settings?.recentFolders ?? []).slice(0, 8))
  const pinned = $derived(app.settings?.pinned ?? [])
  const online = $derived(app.peers.filter((p) => !p.self && p.status !== 'offline'))
  const inbox = $derived(app.inbox.slice(0, 4))
  // only drives that need attention; the full list lives in the sidebar
  const tight = $derived(app.drives.filter((d) => d.ready && d.total > 0 && d.free / d.total < 0.1))
  const person = (user: string) => (dialogs.person ?? dialogs.share)?.(dialogs.person ? user : [user])
</script>

<div class="home">
  <header>
    <div>
      <h1 class="title">{greeting}{first ? `, ${first}` : ''}</h1>
      <div class="caption">{today}</div>
    </div>
    <div class="quick">
      <button class="btn" onclick={() => run('nav.go')}><Icon name="search" /> Go to folder</button>
      {#if dialogs.publicLink}<button class="btn" onclick={() => dialogs.publicLink?.()}><Icon name="link" /> Client link</button>{/if}
      <button class="btn" onclick={() => run('tools.package')}><Icon name="package" /> Package a lot</button>
    </div>
  </header>

  {#if tight.length}
    <section class="alerts">
      <span class="lead"><Icon name="warning" /> {tight.length === 1 ? 'A drive is almost full' : `${tight.length} drives are almost full`}</span>
      {#each tight as d (d.root)}
        <button class="chip" onclick={() => pane.navigate(d.root)} title={`${d.label || 'Drive'} (${d.root.slice(0, 2)}) — ${fmtSize(d.free)} free of ${fmtSize(d.total)}`}>
          <b>{d.root.slice(0, 2)}</b> {fmtSize(d.free)} free
        </button>
      {/each}
    </section>
  {/if}

  <div class="grid">
    <section class="card">
      <h2 class="subtitle">Jump back in</h2>
      {#if recent.length}
        {#each recent as p (p)}
          <button class="line" onclick={() => pane.navigate(p)} onauxclick={(e) => e.button === 1 && pane.openTab(p)} title={p}>
            <span class="fold"><Icon name="folder" /></span>
            <span class="ellipsis nm">{basename(p) || p}</span>
            <span class="caption ellipsis where">{dirname(p) === p ? '' : dirname(p)}</span>
          </button>
        {/each}
      {:else}
        <p class="caption">Folders you open appear here.</p>
      {/if}
    </section>

    <section class="card">
      <h2 class="subtitle">Pinned</h2>
      {#if pinned.length}
        {#each pinned as p (p)}
          <button class="line" onclick={() => pane.navigate(p)} onauxclick={(e) => e.button === 1 && pane.openTab(p)} title={p}>
            <span class="fold"><Icon name="pin" /></span>
            <span class="ellipsis nm">{basename(p) || p}</span>
            <span class="caption ellipsis where">{dirname(p) === p ? '' : dirname(p)}</span>
          </button>
        {/each}
      {:else}
        <p class="caption">Pin a folder with Ctrl+B to keep it here.</p>
      {/if}
    </section>

    <section class="card">
      <h2 class="subtitle">
        Inbox
        {#if app.unseenInbox}<span class="badge">{app.unseenInbox}</span>{/if}
        <button class="link" onclick={() => pane.navigate(VIRTUAL.inbox)}>Open</button>
      </h2>
      {#if inbox.length}
        {#each inbox as it (it.id)}
          <button class="line" class:unseen={!it.seen} onclick={() => pane.navigate(it.folder || VIRTUAL.inbox)}>
            <span class="av" style:background={personColor(it.from)}>{initials(it.fromName)}</span>
            <span class="ellipsis nm">{it.fromName}{it.files ? ` · ${plural(it.files, 'file')}` : ''}</span>
            <span class="caption ellipsis where">{it.message || (it.bytes ? fmtSize(it.bytes) : '')}</span>
            <span class="caption when">{fmtAgo(it.at)}</span>
          </button>
        {/each}
      {:else}
        <p class="caption">Files and messages colleagues send you land here.</p>
      {/if}
    </section>

    <section class="card">
      <h2 class="subtitle">On the network</h2>
      {#if online.length}
        <div class="people">
          {#each online as p (p.id)}
            <button class="person" onclick={() => person(p.user)} title={`${p.displayName} · ${p.host}`}>
              <span class="av" style:background={personColor(p.user)}>{initials(p.displayName)}</span>
              <span class="ellipsis">{p.displayName}</span>
            </button>
          {/each}
        </div>
      {:else if app.lanStatus?.ready}
        <p class="caption">Nobody else is running Hopper right now. You can still send: it waits on the office server until they start Hopper.</p>
      {:else}
        <p class="caption">This PC hasn't joined the office yet. <button class="link" onclick={() => dialogs.settings?.('office')}>Join</button></p>
      {/if}
    </section>
  </div>
</div>

<style>
  .home {
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
    margin-bottom: 20px;
  }
  h1 {
    margin: 0;
    font-size: 24px;
    line-height: 32px;
  }
  .quick {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .alerts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    margin-bottom: 16px;
    padding: 8px 12px;
    border-radius: var(--r-md);
    border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    font-size: 13px;
  }
  .lead {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-right: 4px;
  }
  .lead :global(svg) {
    color: var(--warn);
  }
  .chip {
    border: 1px solid var(--stroke-2);
    background: var(--card-solid);
    color: var(--text);
    border-radius: 12px;
    padding: 1px 10px;
    font-size: 12px;
  }
  .chip:hover {
    background: var(--hover);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 14px;
  }
  .card {
    padding: 14px 14px 10px;
    background: var(--layer-solid);
    min-width: 0;
  }
  h2 {
    margin: 0 0 8px 4px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 .link {
    margin-left: auto;
    font-weight: 400;
  }
  .line {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text);
    text-align: left;
    min-width: 0;
  }
  .line:hover {
    background: var(--hover);
  }
  .line.unseen .nm {
    font-weight: 600;
  }
  .fold {
    color: #e8a33d;
    display: flex;
    flex: none;
  }
  .nm {
    flex: 0 1 auto;
    max-width: 60%;
  }
  .where {
    flex: 1;
    min-width: 0;
  }
  .when {
    flex: none;
  }
  .av {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: white;
    font-size: 10px;
    font-weight: 600;
    flex: none;
  }
  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 2px 4px 6px;
  }
  .person {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px 5px 5px;
    border-radius: 20px;
    border: 1px solid var(--stroke);
    background: var(--card-solid);
    color: var(--text);
    max-width: 220px;
  }
  .person:hover {
    background: var(--hover);
  }
  .card p {
    margin: 4px;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
</style>
