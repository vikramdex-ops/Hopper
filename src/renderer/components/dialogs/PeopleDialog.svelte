<script lang="ts">
  // People on the network: presence, PC and Hopper version for each colleague, plus office groups.
  // "Send selected files" opens the share composer addressed to that person or group.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { dialogs } from '../../lib/commands'
  import { collator, fmtAgo, initials, personColor, plural } from '../../lib/format'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'
  import type { Peer } from '@shared/types'

  let { close }: { close: (v?: unknown) => void } = $props()

  let q = $state('')
  const files = app.active.targets().filter((e) => !isVirtual(e.path) && !isArchivePath(e.path))
  const canSend = files.length > 0
  const sendTip = canSend ? `Send ${plural(files.length, 'selected item')}` : 'Select files in the active pane first'

  const RANK: Record<Peer['status'], number> = { online: 0, busy: 1, away: 2, offline: 3 }
  const STATUS: Record<Peer['status'], string> = { online: 'Online', busy: 'Busy', away: 'Away', offline: 'Offline' }

  const me = $derived(app.peers.find((p) => p.self))
  const people = $derived.by(() => {
    const f = q.trim().toLowerCase()
    return app.peers
      .filter((p) => !p.self)
      .filter((p) => !f || [p.displayName, p.user, p.host, p.email ?? ''].some((s) => s.toLowerCase().includes(f)))
      .slice()
      .sort((a, b) => RANK[a.status] - RANK[b.status] || collator.compare(a.displayName || a.user, b.displayName || b.user))
  })
  const online = $derived(app.peers.filter((p) => !p.self && p.status !== 'offline').length)
  const groups = $derived(app.groups.filter((g) => !q.trim() || g.name.toLowerCase().includes(q.trim().toLowerCase())))
  const lan = $derived(app.lanStatus)

  function send(to: string) {
    close(true)
    void dialogs.share?.([to])
  }

  function settings() {
    close()
    void dialogs.settings?.('sharing')
  }
</script>

<Dialog title="People" icon="people" width={640} onclose={() => close()}>
  <div class="lan" class:ok={lan?.ready}>
    <span class="dot" class:on={lan?.ready}></span>
    <span class="ellipsis">
      {#if !lan}
        Checking LAN sharing…
      {:else if lan.ready}
        LAN sharing is on{lan.port ? ` (port ${lan.port})` : ''} · {plural(online, 'colleague')} online
      {:else if !lan.enabled}
        LAN sharing is off on this PC{lan.reason ? ` (${lan.reason})` : ''}
      {:else}
        LAN sharing isn't ready{lan.reason ? `: ${lan.reason}` : ''}
      {/if}
    </span>
    <button type="button" class="btn sm" onclick={settings}><Icon name="settings" /> Sharing settings</button>
  </div>

  <input class="input" bind:value={q} placeholder="Find a person, PC or group" spellcheck="false" autofocus />

  <div class="list">
    {#if me}
      <div class="caption head">You</div>
      <div class="person">
        <span class="av" style:background={personColor(me.user)}>{initials(me.displayName || me.user)}<span class="pres {me.status}"></span></span>
        <span class="who">
          <span class="ellipsis nm">{me.displayName || me.user}</span>
          <span class="caption ellipsis">{me.user} · {me.host} · {me.address} · Hopper {me.version}</span>
        </span>
        <span class="caption">{STATUS[me.status]}</span>
      </div>
    {/if}

    <div class="caption head">Colleagues</div>
    {#each people as p (p.id)}
      <div class="person" class:off={p.status === 'offline'}>
        <span class="av" style:background={personColor(p.user)}>{initials(p.displayName || p.user)}<span class="pres {p.status}"></span></span>
        <span class="who">
          <span class="ellipsis nm">{p.displayName || p.user}</span>
          <span class="caption ellipsis" title={p.email ?? ''}>
            {p.user} · {p.host}{p.version ? ` · Hopper ${p.version}` : ''}{p.status === 'offline' ? ` · last seen ${fmtAgo(p.lastSeen)}` : ''}
          </span>
        </span>
        <span class="caption st">{STATUS[p.status]}{p.status === 'offline' ? ' (via server)' : ''}</span>
        <button type="button" class="btn sm" disabled={!canSend} title={sendTip} onclick={() => send(p.user)}><Icon name="send" /> Send selected files</button>
      </div>
    {:else}
      <div class="caption empty">{q.trim() ? `No one matches “${q}”.` : 'Nobody else running Hopper has been seen on this network yet.'}</div>
    {/each}

    {#if groups.length}
      <div class="caption head">Groups</div>
      {#each groups as g (g.id)}
        <div class="person">
          <span class="av grp"><Icon name="people" size={14} /></span>
          <span class="who">
            <span class="ellipsis nm">{g.name}</span>
            <span class="caption ellipsis" title={g.members.map((m) => app.personName(m)).join(', ')}>{plural(g.members.length, 'member')}: {g.members.map((m) => app.personName(m)).join(', ')}</span>
          </span>
          <button type="button" class="btn sm" disabled={!canSend || !g.members.length} title={sendTip} onclick={() => send(`group:${g.id}`)}><Icon name="send" /> Send selected files</button>
        </div>
      {/each}
    {/if}
  </div>

  {#snippet footer()}
    <span class="caption foot">Groups are set in Settings → Office and shared with everyone.</span>
    <button type="button" class="btn primary" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .lan {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 12px;
    border-radius: var(--r-md);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    font-size: 13px;
  }
  .lan.ok {
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  .lan .ellipsis {
    flex: 1;
  }
  .lan .dot {
    background: var(--warn);
  }
  .lan .dot.on {
    background: var(--ok);
  }
  .list {
    display: flex;
    flex-direction: column;
    max-height: 52vh;
    overflow: auto;
  }
  .head {
    padding: 10px 0 4px;
    font-weight: 600;
  }
  .person {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 0 4px;
    border-radius: var(--r-sm);
  }
  .person:hover {
    background: var(--hover);
  }
  .person.off .nm {
    color: var(--text-2);
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .st {
    flex: none;
  }
  .av {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: white;
    font-size: 12px;
    font-weight: 600;
    flex: none;
    position: relative;
  }
  .av.grp {
    background: var(--stroke-strong);
    color: var(--text);
  }
  .pres {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--card-solid);
    background: var(--ok);
  }
  .pres.offline {
    background: var(--text-3);
  }
  .pres.busy {
    background: var(--bad);
  }
  .pres.away {
    background: var(--warn);
  }
  .empty {
    padding: 8px 4px;
  }
  .foot {
    flex: 1;
    align-self: center;
  }
</style>
