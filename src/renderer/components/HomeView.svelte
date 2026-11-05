<script lang="ts">
  import type { Pane } from '../lib/pane.svelte'
  import { VIRTUAL } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { basename, fmtAgo, fmtSize, initials, personColor, plural } from '../lib/format'
  import { dialogs } from '../lib/commands'
  import Icon from './Icon.svelte'

  let { pane }: { pane: Pane } = $props()
  const recentDests = $derived((app.settings?.quickDests ?? []).slice(0, 8))
  const online = $derived(app.peers.filter((p) => !p.self && p.status !== 'offline'))
  const greeting = $derived.by(() => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  })
  const me = $derived(app.settings?.profile.displayName || app.info?.identity?.displayName || '')
</script>

<div class="home">
  <h1 class="title">{greeting}{me ? `, ${me.split(' ')[0]}` : ''}</h1>

  <section>
    <h2 class="subtitle">Drives</h2>
    <div class="tiles">
      {#each app.drives as d (d.root)}
        {@const used = d.total ? 1 - d.free / d.total : 0}
        <button class="tile drive" class:dim={!d.ready} onclick={() => pane.navigate(d.root)} onauxclick={(e) => e.button === 1 && pane.openTab(d.root)}>
          <Icon name={d.kind === 'network' ? 'network' : d.kind === 'removable' ? 'usb' : 'drive'} size={28} />
          <div class="meta">
            <div class="ellipsis">{d.label || (d.kind === 'network' ? 'Network drive' : 'Local Disk')} ({d.root.slice(0, 2)})</div>
            {#if d.ready && d.total}
              <div class="cap"><span class:full={used > 0.9} style:width={`${Math.round(used * 100)}%`}></span></div>
              <div class="caption">{fmtSize(d.free)} free of {fmtSize(d.total)}</div>
            {:else}
              <div class="caption">{d.remote ?? 'Not available'}</div>
            {/if}
          </div>
        </button>
      {/each}
    </div>
  </section>

  <section>
    <h2 class="subtitle">Quick access</h2>
    <div class="tiles">
      {#each app.settings?.pinned ?? [] as p (p)}
        <button class="tile" onclick={() => pane.navigate(p)} title={p}>
          <span class="folder"><Icon name="folder" size={28} /></span>
          <div class="meta"><div class="ellipsis">{basename(p) || p}</div><div class="caption ellipsis">{p}</div></div>
        </button>
      {/each}
    </div>
  </section>

  {#if recentDests.length}
    <section>
      <h2 class="subtitle">Recent destinations</h2>
      <div class="tiles">
        {#each recentDests as d (d.path)}
          <button class="tile" onclick={() => pane.navigate(d.path)} title={d.path}>
            <span class="folder"><Icon name={d.pinned ? 'pin' : 'folder'} size={24} /></span>
            <div class="meta"><div class="ellipsis">{d.label || basename(d.path)}</div><div class="caption">{fmtAgo(d.usedAt)}</div></div>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <section>
    <h2 class="subtitle">
      People on the network
      {#if app.unseenInbox}<button class="link" onclick={() => pane.navigate(VIRTUAL.inbox)}>{plural(app.unseenInbox, 'new share')} in your Inbox</button>{/if}
    </h2>
    {#if online.length}
      <div class="people">
        {#each online as p (p.id)}
          <button class="person" onclick={() => dialogs.share?.([p.user])} title={`Send files to ${p.displayName}`}>
            <span class="avatar" style:background={personColor(p.user)}>{initials(p.displayName)}</span>
            <span class="ellipsis">{p.displayName}</span>
            <span class="caption">{p.host}</span>
          </button>
        {/each}
      </div>
    {:else}
      <p class="caption">
        {#if app.lanStatus?.ready}Nobody else is running Hopper right now. Shares to offline colleagues go to the office server and arrive when they open Hopper.{:else}LAN sharing is not set up on this PC yet. <button class="link" onclick={() => dialogs.settings?.('sharing')}>Set it up</button>{/if}
      </p>
    {/if}
  </section>
</div>

<style>
  .home {
    flex: 1;
    overflow: auto;
    padding: 24px 28px 32px;
  }
  h1 {
    margin: 0 0 20px;
    font-size: 24px;
    line-height: 32px;
  }
  section {
    margin-bottom: 24px;
  }
  h2 {
    margin: 0 0 10px;
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 8px;
  }
  .tile {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border-radius: var(--r-lg);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
    text-align: left;
    min-width: 0;
    color: var(--text);
  }
  .tile:hover {
    background: var(--hover);
  }
  .tile.dim {
    opacity: 0.6;
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cap {
    height: 4px;
    border-radius: 2px;
    background: var(--stroke-2);
    overflow: hidden;
  }
  .cap span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .cap span.full {
    background: var(--bad);
  }
  .folder {
    color: #e8a33d;
    display: flex;
  }
  .people {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .person {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px 8px 8px;
    border-radius: 24px;
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
    color: var(--text);
    max-width: 280px;
  }
  .person:hover {
    background: var(--hover);
  }
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: white;
    font-size: 12px;
    font-weight: 600;
    flex: none;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    cursor: pointer;
  }
</style>
