<script lang="ts">
  // Inbox: what colleagues sent this PC over the LAN, newest first. Files open their folder;
  // messages, folder links and requests carry no files and get their own actions. Current
  // announcements sit on top so nothing office-wide is missed here either.
  import type { Pane } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { host, lan } from '../lib/api'
  import { isLive, lanx, LEVEL_LABEL } from '../lib/lan2.svelte'
  import { fmtAgo, fmtSize, initials, personColor, plural } from '../lib/format'
  import { dialogs } from '../lib/commands'
  import Icon from './Icon.svelte'
  import type { InboxItem } from '@shared/types'

  let { pane }: { pane: Pane } = $props()

  const notices = $derived(lanx.announcements.filter((a) => isLive(a, lanx.now)).slice(0, 3))
  const liveCount = $derived(lanx.announcements.filter((a) => isLive(a, lanx.now)).length)

  function seen(id: string) {
    void lan.call('inbox.markSeen', id).catch(() => {})
    app.inbox = app.inbox.map((i) => (i.id === id ? { ...i, seen: true } : i))
  }

  function open(it: InboxItem) {
    seen(it.id)
    if (it.link) void lanx.openLink(it.link)
    else if (it.folder) void pane.navigate(it.folder)
  }

  function reply(it: InboxItem, tab = 'message') {
    seen(it.id)
    void dialogs.person?.(it.from, tab, tab === 'files' && it.kind === 'request' ? it.id : undefined)
  }

  function answer(r: any, accept: boolean) {
    app.incoming = app.incoming.filter((x) => x.requestId !== r.requestId)
    void lan.call('inbox.answer', r.requestId, accept)
  }

  function menu(e: MouseEvent, it: InboxItem) {
    app.openMenu(e.clientX, e.clientY, [
      ...(it.folder ? [{ label: 'Open in other pane', icon: 'dualPane', disabled: !app.dual, run: () => void app.other.navigate(it.folder) }] : []),
      ...(it.link ? [{ label: 'Copy path', icon: 'copyPath', run: () => void host.clip.writeText(it.link!.path) }] : []),
      ...(it.message ? [{ label: 'Copy message', icon: 'copy', run: () => void host.clip.writeText(it.message!) }] : []),
      { label: `Message ${it.fromName}…`, icon: 'at', run: () => reply(it) },
      { label: `Send files to ${it.fromName}…`, icon: 'send', run: () => reply(it, 'files') },
      { label: 'Mark as seen', icon: 'check', disabled: it.seen, run: () => seen(it.id) }
    ])
  }
</script>

<div class="inbox">
  <div class="head">
    <h1 class="title">Inbox</h1>
    <span class="spacer"></span>
    <button class="btn sm" onclick={() => lanx.openList()}><Icon name="bell" /> Announcements{liveCount ? ` (${liveCount})` : ''}</button>
    {#if lanx.canAnnounce}<button class="btn sm" onclick={() => lanx.compose()}><Icon name="plus" /> Announce</button>{/if}
    <button class="btn sm" onclick={() => app.settings && pane.navigate(app.settings.inboxDir)}><Icon name="folderOpen" /> Open Inbox folder</button>
  </div>

  {#each notices as a (a.id)}
    <div class="item notice {a.level}" class:unseen={!a.acked && a.level !== 'info'}>
      <span class="badge"><Icon name={a.level === 'urgent' ? 'warning' : 'bell'} size={18} /></span>
      <div class="meta">
        <div><span class="lvl">{LEVEL_LABEL[a.level]}</span> <b>{a.title}</b> <span class="caption">· {a.byName} · {fmtAgo(a.at)}</span></div>
        {#if a.body}<div class="text">{a.body}</div>{/if}
        {#if a.path}<div class="caption ellipsis">{a.path}</div>{/if}
      </div>
      {#if a.path}<button class="btn sm" onclick={() => pane.navigate(a.path!)}><Icon name="folderOpen" /> Open folder</button>{/if}
      {#if a.by !== lanx.meta.user}
        {#if a.acked}
          <span class="caption done"><Icon name="check" size={13} /> Acknowledged</span>
        {:else}
          <button class="btn primary sm" onclick={() => lanx.ack(a.id)}><Icon name="check" /> Got it</button>
        {/if}
      {:else}
        <button class="btn sm" onclick={() => lanx.openList()}>{plural(a.acks?.length ?? 0, 'person')} acknowledged</button>
      {/if}
    </div>
  {/each}

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

  {#if !app.inbox.length && !app.incoming.length && !notices.length}
    <div class="empty">
      <Icon name="inbox" size={40} />
      <div class="subtitle">Nothing received yet</div>
      <div class="caption">Files, messages and folder links colleagues send you over the network land here{app.settings ? `; files are saved in ${app.settings.inboxDir}` : ''}.</div>
    </div>
  {/if}

  {#each app.inbox as it (it.id)}
    {@const kind = it.kind ?? 'files'}
    <div class="item {kind}" class:unseen={!it.seen} data-kind={kind}>
      <span class="avatar" style:background={personColor(it.from)}>
        {initials(it.fromName)}
        {#if kind !== 'files'}<span class="kind"><Icon name={kind === 'message' ? 'at' : kind === 'link' ? 'link' : 'download'} size={11} /></span>{/if}
      </span>
      <div class="meta">
        {#if kind === 'files'}
          <div><b>{it.fromName}</b> sent {plural(it.files, 'file')} · {fmtSize(it.bytes)} <span class="caption">· {fmtAgo(it.at)}{it.via === 'server' ? ' · via office server' : ''}{it.replyTo ? ' · answers your request' : ''}</span></div>
          {#if it.message}<div class="msg">“{it.message}”</div>{/if}
          <div class="caption ellipsis">{it.folder}</div>
        {:else if kind === 'message'}
          <div><b>{it.fromName}</b> <span class="caption">· {fmtAgo(it.at)}{it.via === 'server' ? ' · via office server' : ''}</span></div>
          <div class="text">{it.message}</div>
        {:else if kind === 'link'}
          <div><b>{it.fromName}</b> shared a {it.link?.dir === false ? 'file' : 'folder'} link <span class="caption">· {fmtAgo(it.at)}{it.via === 'server' ? ' · via office server' : ''}</span></div>
          <div class="path ellipsis" title={it.link?.path}>{it.link?.path}</div>
          {#if it.message}<div class="msg">“{it.message}”</div>{/if}
        {:else}
          <div><b>{it.fromName}</b> is asking you for files <span class="caption">· {fmtAgo(it.at)}{it.via === 'server' ? ' · via office server' : ''}</span></div>
          <div class="text">{it.message}</div>
        {/if}
      </div>
      {#if kind === 'files'}
        <button class="btn sm" onclick={() => open(it)}><Icon name="folderOpen" /> Open</button>
      {:else if kind === 'message'}
        <button class="btn sm" onclick={() => reply(it)}><Icon name="at" /> Reply</button>
      {:else if kind === 'link'}
        <button class="btn primary sm" onclick={() => open(it)}><Icon name="folderOpen" /> {it.link?.dir === false ? 'Show file' : 'Open folder'}</button>
      {:else}
        <button class="btn primary sm" onclick={() => reply(it, 'files')}><Icon name="send" /> Send files…</button>
      {/if}
      <button class="btn subtle icon sm" title="More" onclick={(e) => menu(e, it)}><Icon name="more" /></button>
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
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .title {
    margin: 0;
  }
  .item {
    display: flex;
    flex-wrap: wrap;
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
  .item.notice {
    --tone: var(--accent);
    border-left: 3px solid var(--tone);
  }
  .item.notice.important {
    --tone: var(--warn);
  }
  .item.notice.urgent {
    --tone: var(--bad);
  }
  .item.notice.unseen {
    background: color-mix(in srgb, var(--tone) 8%, var(--layer-solid));
  }
  .badge {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
  }
  .lvl {
    display: inline-block;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
    color: var(--card-solid);
    background: var(--tone);
  }
  .meta {
    flex: 1 1 240px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .msg {
    color: var(--text-2);
    font-style: italic;
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .path {
    font: 12px/18px var(--mono);
    color: var(--accent);
    user-select: text;
  }
  .done {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--ok);
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
    position: relative;
  }
  .kind {
    position: absolute;
    right: -4px;
    bottom: -4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--text);
    background: var(--card-solid);
    border: 1px solid var(--stroke-2);
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
