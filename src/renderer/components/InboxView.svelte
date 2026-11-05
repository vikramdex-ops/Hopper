<script lang="ts">
  import type { Pane } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { lan, host } from '../lib/api'
  import { fmtAgo, fmtSize, initials, personColor, plural } from '../lib/format'
  import { dialogs } from '../lib/commands'
  import Icon from './Icon.svelte'

  let { pane }: { pane: Pane } = $props()

  function open(id: string, folder: string) {
    void lan.call('inbox.markSeen', id).catch(() => {})
    app.inbox = app.inbox.map((i) => (i.id === id ? { ...i, seen: true } : i))
    void pane.navigate(folder)
  }

  function answer(r: any, accept: boolean) {
    app.incoming = app.incoming.filter((x) => x.requestId !== r.requestId)
    void lan.call('inbox.answer', r.requestId, accept)
  }
</script>

<div class="inbox">
  <div class="head">
    <h1 class="title">Inbox</h1>
    <span class="spacer"></span>
    <button class="btn sm" onclick={() => app.settings && pane.navigate(app.settings.inboxDir)}><Icon name="folderOpen" /> Open Inbox folder</button>
  </div>

  {#each app.incoming as r (r.requestId)}
    <div class="item request">
      <span class="avatar" style:background={personColor(r.from)}>{initials(r.fromName)}</span>
      <div class="meta">
        <div><b>{r.fromName}</b> wants to send you {plural(r.files, 'file')} ({fmtSize(r.bytes)})</div>
        {#if r.message}<div class="msg">“{r.message}”</div>{/if}
      </div>
      <button class="btn primary sm" onclick={() => answer(r, true)}>Accept</button>
      <button class="btn sm" onclick={() => answer(r, false)}>Decline</button>
    </div>
  {/each}

  {#if !app.inbox.length && !app.incoming.length}
    <div class="empty">
      <Icon name="inbox" size={40} />
      <div class="subtitle">Nothing received yet</div>
      <div class="caption">Files colleagues send you over the network land here{app.settings ? ` and in ${app.settings.inboxDir}` : ''}.</div>
    </div>
  {/if}

  {#each app.inbox as it (it.id)}
    <div class="item" class:unseen={!it.seen}>
      <span class="avatar" style:background={personColor(it.from)}>{initials(it.fromName)}</span>
      <div class="meta">
        <div><b>{it.fromName}</b> sent {plural(it.files, 'file')} · {fmtSize(it.bytes)} <span class="caption">· {fmtAgo(it.at)}{it.via === 'server' ? ' · via office server' : ''}</span></div>
        {#if it.message}<div class="msg">“{it.message}”</div>{/if}
        <div class="caption ellipsis">{it.folder}</div>
      </div>
      <button class="btn sm" onclick={() => open(it.id, it.folder)}><Icon name="folderOpen" /> Open</button>
      <button class="btn subtle icon sm" title="More" onclick={(e) => app.openMenu(e.clientX, e.clientY, [
        { label: 'Open in other pane', icon: 'dualPane', disabled: !app.dual, run: () => app.other.navigate(it.folder) },
        { label: `Reply to ${it.fromName}…`, icon: 'send', run: () => dialogs.share?.([it.from]) },
        { label: 'Show in Explorer', icon: 'windows', run: () => host.shell.open(it.folder) },
        { label: 'Mark as seen', icon: 'check', disabled: it.seen, run: () => { void lan.call('inbox.markSeen', it.id); app.inbox = app.inbox.map((x) => (x.id === it.id ? { ...x, seen: true } : x)) } }
      ])}><Icon name="more" /></button>
    </div>
  {/each}
</div>

<style>
  .inbox {
    flex: 1;
    overflow: auto;
    padding: 20px 24px;
  }
  .head {
    display: flex;
    align-items: center;
    margin-bottom: 12px;
  }
  .title {
    margin: 0;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border-radius: var(--r-lg);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
    margin-bottom: 8px;
  }
  .item.unseen {
    border-left: 3px solid var(--accent);
  }
  .item.request {
    border-color: var(--accent);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .msg {
    color: var(--text-2);
    font-style: italic;
  }
  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: white;
    font-size: 13px;
    font-weight: 600;
    flex: none;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 60px 0;
    color: var(--text-2);
    text-align: center;
  }
</style>
