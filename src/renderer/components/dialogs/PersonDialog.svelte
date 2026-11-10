<script lang="ts">
  // Person panel: everything you can do with one colleague over the LAN. Opened by clicking a
  // person. Message (with the conversation so far), Send files, Send a folder link (a pointer to
  // a shared folder, no bytes copied) and Ask for files. Files are only ever taken from an
  // explicit selection or from the pickers here, never from the row that merely has focus.
  import { tick } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { host, lan } from '../../lib/api'
  import { lanx, toUnc } from '../../lib/lan2.svelte'
  import { basename, fmtAgo, fmtDateFull, fmtSize, initials, personColor, plural } from '../../lib/format'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'
  import type { HistoryItem, Peer, ShareSpec } from '@shared/types'

  type Tab = 'message' | 'files' | 'link' | 'request'
  let { user, tab, replyTo, close }: { user: string; tab?: string; replyTo?: string; close: (v?: unknown) => void } = $props()

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'message', label: 'Message', icon: 'at' },
    { id: 'files', label: 'Send files', icon: 'send' },
    { id: 'link', label: 'Folder link', icon: 'link' },
    { id: 'request', label: 'Ask for files', icon: 'download' }
  ]
  const STATUS: Record<Peer['status'], string> = { online: 'Online', busy: 'Busy', away: 'Away', offline: 'Offline' }
  const real = (p: string) => !isVirtual(p) && !isArchivePath(p)

  let current = $state<Tab>(TABS.some((t) => t.id === tab) ? (tab as Tab) : 'message')
  let answering = $state(replyTo)

  const peer = $derived(app.peers.filter((p) => p.user === user && !p.self).sort((a, b) => Number(a.status === 'offline') - Number(b.status === 'offline'))[0])
  const name = $derived(peer?.displayName || user)
  const offline = $derived(!peer || peer.status === 'offline')
  const ready = $derived(!!app.lanStatus?.ready)

  // ---- conversation ----------------------------------------------------------------

  let history = $state.raw<HistoryItem[]>([])
  let loaded = $state(false)
  let scroller: HTMLDivElement | undefined = $state()
  /** notes sent from this panel, to show their delivery state until they land in the history */
  let mine = $state<string[]>([])
  const pending = $derived(mine.map((id) => lanx.notes[`${id}|${user}`]).filter((n) => n && n.state !== 'done'))

  $effect(() => {
    void lanx.historyTick
    void lanx.history(user).then(async (h) => {
      history = h.slice(-200)
      loaded = true
      await tick()
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    }).catch(() => (loaded = true))
  })

  // opening the panel is reading what they wrote
  $effect(() => {
    const unseen = app.inbox.filter((i) => i.from === user && !i.seen && (i.kind ?? 'files') !== 'files')
    if (!unseen.length) return
    for (const i of unseen) void lan.call('inbox.markSeen', i.id).catch(() => {})
    app.inbox = app.inbox.map((i) => (unseen.includes(i) ? { ...i, seen: true } : i))
  })

  let text = $state('')
  let busy = $state(false)

  async function sendNote(spec: Omit<ShareSpec, 'to' | 'paths'>) {
    if (busy) return false
    busy = true
    try {
      const id = await lan.call<string>('share.send', { ...spec, to: [user], paths: [], notifyCliq: app.office?.cliq.enabled ?? false })
      mine = [...mine, id]
      if (app.settings) app.updateSettings({ recentShares: [...new Set([user, ...app.settings.recentShares])].slice(0, 12) })
      return true
    } catch (e: any) {
      app.toast('error', `Couldn't send to ${name}`, e.message)
      return false
    } finally {
      busy = false
    }
  }

  async function sendMessage() {
    const body = text.trim()
    if (!body) return
    if (await sendNote({ kind: 'message', message: body })) text = ''
  }

  function enterSends(e: KeyboardEvent, fn: () => void) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      fn()
    }
  }

  function openItem(h: HistoryItem) {
    close()
    if (h.link) void lanx.openLink(h.link)
    else if (h.folder) void app.active.navigate(h.folder)
  }

  function answer(h: HistoryItem) {
    answering = h.id
    current = 'files'
  }

  // ---- send files ----------------------------------------------------------------------

  // the explicit selection only: a focused row that is not selected is not "chosen"
  let paths = $state<string[]>(app.active.selected.map((e) => e.path).filter(real))
  const fromSelection = paths.length
  let fileNote = $state('')
  let zipFirst = $state(false)

  function add(list: string[]) {
    const have = new Set(paths.map((p) => p.toLowerCase()))
    paths = [...paths, ...list.filter((p) => p && real(p) && !have.has(p.toLowerCase()))]
  }

  async function chooseFiles() {
    add(await host.dialog.files(`Choose files to send to ${name}`))
  }

  async function chooseFolder() {
    const start = real(app.active.path) ? app.active.path : undefined
    const d = await host.dialog.folder(`Choose a folder to send to ${name}`, start)
    if (d) add([d])
  }

  function sendFiles() {
    if (!paths.length) return
    void app.share({ to: [user], paths: $state.snapshot(paths), message: fileNote.trim() || undefined, zipFirst, notifyCliq: app.office?.cliq.enabled ?? false, replyTo: answering })
    close(true)
  }

  // ---- folder link ----------------------------------------------------------------------

  const sel = app.active.selected.filter((e) => real(e.path))
  let linkPath = $state(sel.length === 1 ? sel[0].path : real(app.active.path) ? app.active.path : '')
  let linkIsFile = $state(sel.length === 1 && !sel[0].dir)
  let linkNote = $state('')
  const unc = $derived(toUnc(linkPath, app.drives))
  const linkOk = $derived(/^(\\\\[^\\]+\\[^\\]+|[a-zA-Z]:\\)/.test(unc.path))

  async function browseLink() {
    const d = await host.dialog.folder('Choose the folder to point to', linkPath && !linkIsFile ? linkPath : undefined)
    if (d) {
      linkPath = d
      linkIsFile = false
    }
  }

  async function sendLink() {
    if (!linkOk) return
    if (await sendNote({ kind: 'link', link: { path: unc.path, dir: !linkIsFile }, message: linkNote.trim() || undefined })) {
      linkNote = ''
      current = 'message'
    }
  }

  // ---- ask for files ---------------------------------------------------------------------

  let ask = $state('')

  async function sendRequest() {
    const body = ask.trim()
    if (!body) return
    if (await sendNote({ kind: 'request', message: body })) {
      ask = ''
      current = 'message'
    }
  }

  function submit() {
    if (current === 'message') void sendMessage()
    else if (current === 'files') sendFiles()
    else if (current === 'link') void sendLink()
    else void sendRequest()
  }

  const day = (ms: number) => new Date(ms).toDateString()
</script>

<Dialog title={name} icon="person" width={620} onclose={() => close()} onsubmit={submit}>
  <div class="who">
    <span class="av" style:background={personColor(user)}>{initials(name)}<span class="pres {peer?.status ?? 'offline'}"></span></span>
    <div class="id">
      <div class="st">
        <b>{STATUS[peer?.status ?? 'offline']}</b>
        {#if peer?.host}· {peer.host}{/if}
        {#if peer && !offline && peer.address}· {peer.address}{/if}
        {#if offline && peer?.lastSeen}· last seen {fmtAgo(peer.lastSeen)}{/if}
      </div>
      <div class="caption ellipsis">
        {user}{peer?.email ? ` · ${peer.email}` : ''}{peer?.version ? ` · Hopper ${peer.version}` : ''}
      </div>
    </div>
    <span class="route caption" class:server={offline}>
      <Icon name={offline ? 'cloud' : 'network'} size={14} />
      {offline ? 'Goes to the office server; arrives when they open Hopper' : 'Delivered straight to their PC'}
    </span>
  </div>

  {#if !ready}
    <div class="warn"><Icon name="warning" /> <span>LAN sharing isn't ready on this PC{app.lanStatus?.reason ? ` (${app.lanStatus.reason})` : ''}. Set it up in Settings → Sharing.</span></div>
  {/if}

  <div class="tabs" role="tablist">
    {#each TABS as t (t.id)}
      <button type="button" role="tab" class="tab" class:on={current === t.id} aria-selected={current === t.id} data-tab={t.id} onclick={() => (current = t.id)}>
        <Icon name={t.icon} size={15} /> {t.label}
      </button>
    {/each}
  </div>

  {#if current === 'message'}
    <div class="chat" bind:this={scroller}>
      {#if loaded && !history.length && !pending.length}
        <div class="none caption">
          <Icon name="at" size={28} />
          <span>Nothing exchanged with {name} yet. Write a note below, or use the tabs to send files, point to a folder, or ask for something.</span>
        </div>
      {/if}
      {#each history as h, i (h.dir + h.id)}
        {#if i === 0 || day(history[i - 1].at) !== day(h.at)}
          <div class="day caption">{new Date(h.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>
        {/if}
        <div class="line {h.dir}">
          <div class="bubble {h.kind}">
            {#if h.kind === 'files'}
              <div class="head"><Icon name="layers" size={14} /> {plural(h.files, 'file')} · {fmtSize(h.bytes)}</div>
              {#if h.names?.length}<div class="caption ellipsis">{h.names.slice(0, 3).join(', ')}{h.names.length > 3 ? ` +${h.names.length - 3} more` : ''}</div>{/if}
            {:else if h.kind === 'link'}
              <div class="head"><Icon name="link" size={14} /> {h.link?.dir === false ? 'File link' : 'Folder link'}</div>
              <div class="path" title={h.link?.path}>{h.link?.path}</div>
            {:else if h.kind === 'request'}
              <div class="head"><Icon name="download" size={14} /> {h.dir === 'in' ? 'Asks you for files' : 'You asked for files'}</div>
            {/if}
            {#if h.message}<div class="body">{h.message}</div>{/if}
            {#if h.replyTo}<div class="caption">In reply to a request</div>{/if}
            {#if h.dir === 'in' && (h.folder || h.link)}
              <button type="button" class="btn sm" onclick={() => openItem(h)}><Icon name="folderOpen" /> {h.link ? (h.link.dir ? 'Open folder' : 'Show file') : 'Open'}</button>
            {:else if h.dir === 'in' && h.kind === 'request'}
              <button type="button" class="btn sm" onclick={() => answer(h)}><Icon name="send" /> Send files…</button>
            {/if}
          </div>
          <span class="when caption" title={fmtDateFull(h.at)}>
            {new Date(h.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}{h.via === 'server' ? ' · via server' : ''}
          </span>
        </div>
      {/each}
      {#each pending as n (n.shareId)}
        <div class="line out">
          <div class="bubble ghost caption">
            {n.state === 'failed' ? `Not delivered: ${n.error ?? 'unknown error'}` : n.state === 'server' ? 'Leaving it on the office server…' : 'Sending…'}
          </div>
        </div>
      {/each}
    </div>
    <div class="compose">
      <textarea class="input" rows="2" bind:value={text} placeholder={`Message ${name}`} onkeydown={(e) => enterSends(e, sendMessage)} autofocus></textarea>
      <button type="submit" class="btn primary" disabled={busy || !text.trim()}><Icon name="send" /> Send</button>
    </div>
    <div class="caption">Enter sends, Shift+Enter starts a new line. Notes show up in their Hopper Inbox{app.office?.cliq.enabled ? ' and as a Cliq DM' : ''}.</div>
  {:else if current === 'files'}
    {#if answering}
      <div class="note"><Icon name="download" /> <span class="grow">Answering {name}'s request.</span><button type="button" class="link" onclick={() => (answering = undefined)}>Not a reply</button></div>
    {/if}
    {#if paths.length}
      <div class="caption">{fromSelection ? `${plural(fromSelection, 'selected item')} from ${basename(app.active.path) || app.active.path}${paths.length > fromSelection ? `, plus ${paths.length - fromSelection} added here` : ''}` : plural(paths.length, 'item')} · remove any you don't want to send</div>
      <div class="files">
        {#each paths as p (p)}
          <div class="file" title={p}>
            <Icon name="file" size={15} />
            <span class="fn ellipsis">{basename(p) || p}</span>
            <span class="caption ellipsis dir">{p}</span>
            <button type="button" class="btn subtle icon sm" aria-label={`Remove ${basename(p)}`} title="Remove" onclick={() => (paths = paths.filter((x) => x !== p))}><Icon name="close" size={12} /></button>
          </div>
        {/each}
      </div>
    {:else}
      <div class="drop">
        <Icon name="send" size={28} />
        <div><b>Nothing is selected.</b> Pick what to send to {name}:</div>
      </div>
    {/if}
    <div class="row">
      <button type="button" class="btn" onclick={chooseFiles}><Icon name="file" /> Choose files…</button>
      <button type="button" class="btn" onclick={chooseFolder}><Icon name="folder" /> Choose folder…</button>
      <span class="grow"></span>
      <label class="check"><input type="checkbox" bind:checked={zipFirst} /> Zip first</label>
    </div>
    <label class="field">
      <span>Note <span class="caption">(optional)</span></span>
      <textarea class="input" rows="2" bind:value={fileNote} placeholder="e.g. Lot 07 isos for back-check, due Friday"></textarea>
    </label>
  {:else if current === 'link'}
    <div class="caption">Sends a pointer, not a copy: {name} gets an <b>Open folder</b> button that takes their Hopper straight there. Best for big project folders on a shared drive.</div>
    <label class="field">
      <span>Folder or file on a shared drive</span>
      <div class="row">
        <input class="input" bind:value={linkPath} spellcheck="false" placeholder="\\server\share\project folder" oninput={() => (linkIsFile = false)} />
        <button type="button" class="btn" onclick={browseLink}><Icon name="folderOpen" /> Browse…</button>
      </div>
    </label>
    {#if linkPath.trim()}
      {#if !linkOk}
        <div class="caption warnText">Type a full path, like \\server\share\folder or X:\folder.</div>
      {:else if unc.shared}
        <div class="resolved"><Icon name="network" size={15} /><span class="caption">{name} opens</span><code class="ellipsis" title={unc.path}>{unc.path}</code></div>
      {:else}
        <div class="warn"><Icon name="warning" /> <span>{linkPath.slice(0, 2).toUpperCase()} is a disk on this PC, not a shared drive, so {name} probably can't open this. Send the files instead, or pick a folder on the server.</span></div>
      {/if}
    {/if}
    <label class="field">
      <span>Note <span class="caption">(optional)</span></span>
      <textarea class="input" rows="2" bind:value={linkNote} placeholder="e.g. Latest stress reports are in here"></textarea>
    </label>
  {:else}
    <div class="caption">{name} gets a request in their Inbox with a <b>Send files</b> button that replies to you.</div>
    <label class="field">
      <span>What do you need?</span>
      <textarea class="input" rows="4" bind:value={ask} placeholder="e.g. The marked-up PDFs for lot 07, when you have a minute" onkeydown={(e) => enterSends(e, sendRequest)} autofocus></textarea>
    </label>
  {/if}

  {#snippet footer()}
    {#if current === 'files'}
      <button type="submit" class="btn primary" disabled={!paths.length || !ready}><Icon name="send" /> Send {paths.length ? plural(paths.length, 'item') : 'files'}</button>
    {:else if current === 'link'}
      <button type="submit" class="btn primary" disabled={busy || !linkOk || !ready}><Icon name="link" /> Send link</button>
    {:else if current === 'request'}
      <button type="submit" class="btn primary" disabled={busy || !ask.trim() || !ready}><Icon name="send" /> Send request</button>
    {/if}
    <button type="button" class="btn" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .who {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .av {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: white;
    font-size: 14px;
    font-weight: 600;
    flex: none;
    position: relative;
  }
  .pres {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 13px;
    height: 13px;
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
  .id {
    flex: 1;
    min-width: 0;
  }
  .st {
    font-size: 13px;
  }
  .route {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 230px;
    padding: 4px 10px;
    border-radius: 12px;
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  .route.server {
    color: var(--warn);
  }
  .warn {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-radius: var(--r-md);
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    font-size: 13px;
  }
  .warnText {
    color: var(--warn);
  }
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--divider);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
    background: transparent;
    color: var(--text-2);
    font-size: 13px;
  }
  .tab:hover {
    background: var(--hover);
  }
  .tab.on {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .chat {
    height: 280px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
  }
  .none {
    margin: auto;
    max-width: 340px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
  }
  .day {
    align-self: center;
    padding: 4px 0 2px;
  }
  .line {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    max-width: 86%;
  }
  .line.out {
    align-self: flex-end;
    flex-direction: row-reverse;
  }
  .bubble {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 7px 11px;
    border-radius: 12px 12px 12px 3px;
    background: var(--card-solid);
    border: 1px solid var(--stroke);
    font-size: 13px;
  }
  .out .bubble {
    border-radius: 12px 12px 3px 12px;
    background: var(--sel);
    border-color: transparent;
  }
  .bubble.ghost {
    border-style: dashed;
    background: transparent;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .path {
    font: 12px/16px var(--mono);
    overflow-wrap: anywhere;
    user-select: text;
  }
  .when {
    flex: none;
    font-size: 11px;
  }
  .compose {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .compose textarea {
    flex: 1;
  }
  .files {
    max-height: 200px;
    overflow: auto;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
    padding: 4px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 4px 0 8px;
    border-radius: var(--r-sm);
  }
  .file:hover {
    background: var(--hover);
  }
  .fn {
    flex: none;
    max-width: 55%;
  }
  .dir {
    flex: 1;
  }
  .drop {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 26px 12px;
    border-radius: var(--r-md);
    border: 1px dashed var(--stroke-strong);
    color: var(--text-2);
    text-align: center;
  }
  .grow {
    flex: 1;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--r-md);
    background: var(--sel);
    font-size: 13px;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 12px;
    padding: 0;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .resolved {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  .resolved code {
    flex: 1;
    font: 12px/16px var(--mono);
    user-select: text;
  }
</style>
