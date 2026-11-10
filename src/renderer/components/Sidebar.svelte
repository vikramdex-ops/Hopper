<script lang="ts">
  import { app } from '../lib/app.svelte'
  import { VIRTUAL } from '../lib/pane.svelte'
  import { basename, fmtSize, initials, personColor } from '../lib/format'
  import { dialogs } from '../lib/commands'
  import { dropPaths, dropOp } from '../lib/dnd'
  import Icon from './Icon.svelte'

  const s = $derived(app.settings!)
  const here = $derived(app.active?.path.toLowerCase() ?? '')
  const online = $derived(app.peers.filter((p) => !p.self && p.status !== 'offline'))
  const offline = $derived(app.peers.filter((p) => !p.self && p.status === 'offline'))
  let dropKey = $state('')

  const special = $derived([
    { icon: 'desktop', label: 'Desktop', path: app.info?.desktop },
    { icon: 'download', label: 'Downloads', path: app.info?.downloads },
    { icon: 'documents', label: 'Documents', path: app.info?.documents },
    { icon: 'image', label: 'Pictures', path: app.info?.pictures }
  ].filter((x) => x.path))

  function go(path: string, e?: MouseEvent) {
    if (e && (e.button === 1 || e.ctrlKey)) app.active.openTab(path)
    void app.active.navigate(path, { newTab: !!e && (e.button === 1 || e.ctrlKey) })
  }

  function driveIcon(kind: string, root: string) {
    if (kind === 'network') return 'network'
    if (kind === 'removable') return 'usb'
    if (kind === 'cdrom') return 'disc'
    return root.toUpperCase() === 'C:\\' ? 'driveSystem' : 'drive'
  }

  function pinMenu(e: MouseEvent, path: string) {
    e.preventDefault()
    app.openMenu(e.clientX, e.clientY, [
      { label: 'Open in new tab', icon: 'plus', run: () => app.active.openTab(path) },
      ...(app.dual ? [{ label: 'Open in other pane', icon: 'dualPane', run: () => app.other.navigate(path) }] : []),
      { separator: true },
      { label: 'Unpin from Quick access', icon: 'pin', run: () => app.updateSettings({ pinned: s.pinned.filter((p) => p !== path) }) },
      { label: 'Move up', disabled: s.pinned.indexOf(path) === 0, run: () => { const l = s.pinned.slice(); const i = l.indexOf(path); [l[i - 1], l[i]] = [l[i], l[i - 1]]; app.updateSettings({ pinned: l }) } }
    ])
  }

  function personMenu(e: MouseEvent, user: string) {
    e.preventDefault()
    app.openMenu(e.clientX, e.clientY, [
      { label: 'Message…', icon: 'at', run: () => dialogs.person?.(user) },
      { label: 'Send files…', icon: 'send', run: () => dialogs.person?.(user, 'files') },
      { label: 'Open Inbox', icon: 'inbox', run: () => app.active.navigate(VIRTUAL.inbox) }
    ])
  }

  function over(e: DragEvent, key: string) {
    e.preventDefault()
    dropKey = key
    if (e.dataTransfer) e.dataTransfer.dropEffect = key.startsWith('person:') ? 'copy' : e.shiftKey ? 'move' : 'copy'
  }

  async function dropOn(e: DragEvent, target: string) {
    e.preventDefault()
    e.stopPropagation()
    dropKey = ''
    const paths = dropPaths(e)
    if (!paths.length) return
    if (target.startsWith('person:')) return dialogs.share?.([target.slice(7)], paths)
    await app.transfer(dropOp(e, paths, target), paths, target)
  }
</script>

{#if s.sidebarCollapsed}
  <aside class="rail" aria-label="Sidebar (collapsed)">
    <button class="rbtn" title="Show sidebar (Ctrl+Shift+B)" aria-label="Show sidebar" onclick={() => app.updateSettings({ sidebarCollapsed: false })}><Icon name="sidebar" /></button>
    <button class="rbtn" class:on={here === VIRTUAL.home} title="Home" aria-label="Home" onclick={() => go(VIRTUAL.home)}><Icon name="home" /></button>
    <button class="rbtn" class:on={here === VIRTUAL.inbox} title="Inbox" aria-label="Inbox" onclick={() => go(VIRTUAL.inbox)}>
      <Icon name="inbox" />{#if app.unseenInbox}<span class="rdot"></span>{/if}
    </button>
    <button class="rbtn" class:on={here === VIRTUAL.activity} title="Activity" aria-label="Activity" onclick={() => go(VIRTUAL.activity)}><Icon name="activity" /></button>
    <span class="rgrow"></span>
    <button class="rbtn" title="Settings (Ctrl+,)" aria-label="Settings" onclick={() => dialogs.settings?.()}><Icon name="settings" /></button>
  </aside>
{:else}
<aside class="sidebar" style:width={`${s.sidebarWidth}px`}>
  <div class="top">
    <button class="collapse" title="Hide sidebar (Ctrl+Shift+B)" aria-label="Hide sidebar" onclick={() => app.updateSettings({ sidebarCollapsed: true })}><Icon name="chevronLeft" size={14} /></button>
    <button class="row" class:on={here === VIRTUAL.home} onclick={() => go(VIRTUAL.home)}><Icon name="home" /><span>Home</span></button>
    <button class="row" class:on={here === VIRTUAL.inbox} onclick={() => go(VIRTUAL.inbox)}>
      <Icon name="inbox" /><span>Inbox</span>
      {#if app.unseenInbox}<span class="badge">{app.unseenInbox}</span>{/if}
    </button>
    <button class="row" class:on={here === VIRTUAL.activity} onclick={() => go(VIRTUAL.activity)}><Icon name="activity" /><span>Activity</span></button>
  </div>
  <div class="scroll">
    <div class="head">Quick access</div>
    {#each special as sp (sp.path)}
      <button class="row" class:on={here === sp.path.toLowerCase()} class:drop={dropKey === sp.path} onclick={(e) => go(sp.path, e)} onauxclick={(e) => go(sp.path, e)}
        ondragover={(e) => over(e, sp.path)} ondragleave={() => (dropKey = '')} ondrop={(e) => dropOn(e, sp.path)}>
        <Icon name={sp.icon} /><span>{sp.label}</span>
      </button>
    {/each}
    {#each s.pinned.filter((p) => !special.some((x) => x.path?.toLowerCase() === p.toLowerCase())) as p (p)}
      <button class="row" class:on={here === p.toLowerCase()} class:drop={dropKey === p} title={p} onclick={(e) => go(p, e)} onauxclick={(e) => go(p, e)} oncontextmenu={(e) => pinMenu(e, p)}
        ondragover={(e) => over(e, p)} ondragleave={() => (dropKey = '')} ondrop={(e) => dropOn(e, p)}>
        <span class="folder"><Icon name="folder" /></span><span class="ellipsis">{basename(p) || p}</span><Icon name="pin" size={12} cls="pin" />
      </button>
    {/each}

    {#if s.workspaces.length}
      <div class="head">Workspaces</div>
      {#each s.workspaces as ws (ws.id)}
        <button class="row" onclick={() => app.openWorkspace(ws)} oncontextmenu={(e) => { e.preventDefault(); app.openMenu(e.clientX, e.clientY, [{ label: 'Delete workspace', icon: 'delete', run: () => app.updateSettings({ workspaces: s.workspaces.filter((w) => w.id !== ws.id) }) }]) }}>
          <Icon name="workspace" /><span class="ellipsis">{ws.name}</span>
        </button>
      {/each}
    {/if}

    <div class="head">This PC</div>
    {#each app.drives as d (d.root)}
      {@const used = d.total ? 1 - d.free / d.total : 0}
      <button class="row drive" class:on={here.startsWith(d.root.toLowerCase()) && here.length <= 3} class:drop={dropKey === d.root} class:dim={!d.ready}
        title={`${d.remote ?? d.root}${d.ready ? `\n${fmtSize(d.free)} free of ${fmtSize(d.total)}` : '\nNot available'}`}
        onclick={(e) => go(d.root, e)} onauxclick={(e) => go(d.root, e)}
        ondragover={(e) => d.ready && over(e, d.root)} ondragleave={() => (dropKey = '')} ondrop={(e) => dropOn(e, d.root)}>
        <Icon name={driveIcon(d.kind, d.root)} />
        <span class="dl">
          <span class="ellipsis">{d.label || (d.kind === 'network' ? (d.remote ?? '').split('\\').filter(Boolean).pop() ?? 'Network' : 'Local Disk')} ({d.root.slice(0, 2)})</span>
          {#if d.ready && d.total}
            <span class="cap"><span class="fill" class:full={used > 0.9} style:width={`${Math.round(used * 100)}%`}></span></span>
            <span class="free" class:low={used > 0.9}>{fmtSize(d.free)} free of {fmtSize(d.total)}</span>
          {:else}
            <span class="free">{d.ready ? '' : 'Not connected'}</span>
          {/if}
        </span>
      </button>
    {/each}
    <button class="row" class:on={here === VIRTUAL.recycle} onclick={() => go(VIRTUAL.recycle)}><Icon name="trash" /><span>Recycle Bin</span></button>

    <div class="head people-head">
      <span>People</span>
      {#if app.lanStatus && !app.lanStatus.ready}
        <button class="link" onclick={() => dialogs.settings?.('sharing')} title={app.lanStatus.reason}>Set up</button>
      {/if}
    </div>
    {#if !online.length && !offline.length}
      <div class="empty caption">{app.lanStatus?.ready ? 'No one else is running Hopper on the network yet.' : 'Sharing is not set up on this PC.'}</div>
    {/if}
    {#each online as p (p.id)}
      <button class="row person" class:drop={dropKey === `person:${p.user}`} title={`${p.displayName} · ${p.host}\nDrop files here to send`}
        onclick={() => dialogs.person?.(p.user)} oncontextmenu={(e) => personMenu(e, p.user)}
        ondragover={(e) => over(e, `person:${p.user}`)} ondragleave={() => (dropKey = '')} ondrop={(e) => dropOn(e, `person:${p.user}`)}>
        <span class="avatar" style:background={personColor(p.user)}>{initials(p.displayName)}<span class="presence {p.status}"></span></span>
        <span class="ellipsis">{p.displayName}</span>
      </button>
    {/each}
    {#each offline.slice(0, 20) as p (p.id)}
      <button class="row person dim" title={`${p.displayName} is offline — files go to the server inbox`} onclick={() => dialogs.person?.(p.user)}
        ondragover={(e) => over(e, `person:${p.user}`)} ondragleave={() => (dropKey = '')} ondrop={(e) => dropOn(e, `person:${p.user}`)}>
        <span class="avatar" style:background={personColor(p.user)}>{initials(p.displayName)}<span class="presence offline"></span></span>
        <span class="ellipsis">{p.displayName}</span>
      </button>
    {/each}
  </div>
  <div class="foot">
    <button class="btn subtle sm" onclick={() => dialogs.settings?.()} title="Settings (Ctrl+,)"><Icon name="settings" /> Settings</button>
  </div>
</aside>
{/if}

<style>
  .rail {
    flex: none;
    width: 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 0 4px 0 8px;
  }
  .rbtn {
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text);
    display: grid;
    place-items: center;
    position: relative;
  }
  .rbtn:hover,
  .rbtn.on {
    background: var(--hover);
  }
  .rdot {
    position: absolute;
    top: 7px;
    right: 7px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
  .rgrow {
    flex: 1;
  }
  .top {
    position: relative;
  }
  .collapse {
    position: absolute;
    right: 6px;
    top: 6px;
    z-index: 1;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-3);
    display: grid;
    place-items: center;
    opacity: 0;
  }
  .sidebar:hover .collapse,
  .collapse:focus-visible {
    opacity: 1;
  }
  .collapse:hover {
    background: var(--hover);
    color: var(--text);
  }

  .sidebar {
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0 4px 0 8px;
  }
  .top {
    flex: none;
    padding-right: 2px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--divider);
    margin-bottom: 2px;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 2px;
  }
  .head {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    padding: 14px 12px 4px;
    display: flex;
    align-items: center;
  }
  .people-head span {
    flex: 1;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 12px;
    padding: 0;
    cursor: pointer;
  }
  .row {
    width: 100%;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
    position: relative;
    color: var(--text);
  }
  .row:hover {
    background: var(--hover);
  }
  .row:active {
    background: var(--press);
  }
  .row.on {
    background: var(--hover);
  }
  .row.on::before {
    content: '';
    position: absolute;
    left: 0;
    top: 9px;
    bottom: 9px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  .row.drop {
    background: var(--sel);
    outline: 1px solid var(--accent);
  }
  .row > span:not(.badge):not(.avatar):not(.folder) {
    flex: 1;
    min-width: 0;
  }
  .row :global(.pin) {
    opacity: 0;
    color: var(--text-3);
  }
  .row:hover :global(.pin) {
    opacity: 1;
  }
  .folder {
    color: #e8a33d;
    flex: none !important;
    display: flex;
  }
  .drive {
    height: 58px;
  }
  .free {
    font-size: 11px;
    line-height: 14px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .free.low {
    color: var(--bad);
  }
  .dl {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .cap {
    height: 4px;
    border-radius: 2px;
    background: var(--stroke-2);
    overflow: hidden;
    width: 100%;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
  }
  .fill.full {
    background: var(--bad);
  }
  .dim {
    opacity: 0.6;
  }
  .avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex: none;
    display: grid;
    place-items: center;
    color: white;
    font-size: 10px;
    font-weight: 600;
    position: relative;
  }
  .presence {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid var(--bg-solid);
    background: #6ccb5f;
  }
  .presence.busy {
    background: #e74856;
  }
  .presence.away {
    background: #fce100;
  }
  .presence.offline {
    background: #8a8a8a;
  }
  .empty {
    padding: 4px 12px 8px;
  }
  .foot {
    padding: 6px 4px 0;
  }
</style>
