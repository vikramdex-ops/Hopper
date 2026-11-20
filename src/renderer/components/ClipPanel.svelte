<script lang="ts">
  // Hopper Clipboard: the Win+V panel (its own window, see main/clipboard.ts).
  // Type to search; arrows move; Enter pastes into the window you were in; Ctrl+Enter only copies;
  // Shift+Enter pastes as plain text; Ctrl+P pins; Delete removes; 1-9 paste that row; Esc closes.
  import { onMount, tick } from 'svelte'
  import Icon from './Icon.svelte'
  import { byFilter, entryTitle, matches, type ClipEntry, type ClipFilter, type ClipSettings } from '@shared/cliphist'
  import { fmtAgo, fmtSize } from '../lib/format'

  const api = window.hopper.cliphist
  let entries = $state.raw<ClipEntry[]>([])
  let dests = $state.raw<string[]>([])
  let settings = $state<ClipSettings | null>(null)
  let q = $state('')
  let filter = $state<ClipFilter>('all')
  let hot = $state(0)
  let note = $state('')
  let menuFor = $state<string | null>(null)
  let big = $state<{ id: string; src: string } | null>(null)
  let search: HTMLInputElement | undefined = $state()
  let listEl: HTMLDivElement | undefined = $state()

  const FILTERS: { id: ClipFilter; label: string; icon: string }[] = [
    { id: 'all', label: 'All', icon: 'history' },
    { id: 'pinned', label: 'Pinned', icon: 'pin' },
    { id: 'text', label: 'Text', icon: 'text' },
    { id: 'links', label: 'Links & paths', icon: 'link' },
    { id: 'images', label: 'Images', icon: 'image' },
    { id: 'files', label: 'Files', icon: 'folder' }
  ]

  const shown = $derived(entries.filter((e) => byFilter(e, filter) && matches(e, q)))
  const current = $derived(shown[Math.min(hot, shown.length - 1)])

  async function load() {
    const r = await api.list()
    entries = r.entries
    dests = r.dests
    settings = r.settings
  }

  async function applyTheme() {
    const [info, s] = await Promise.all([window.hopper.app.info(), window.hopper.settings.get()])
    const t = s.theme ?? 'system'
    const dark = t === 'dark' || (t === 'system' && info.dark)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.dataset.mica = info.win11 ? 'on' : 'off'
    const hex = s.accent === 'system' ? info.accent : s.accent
    if (hex) {
      const root = document.documentElement.style
      root.setProperty('--accent', dark ? `color-mix(in srgb, ${hex} 55%, white)` : `color-mix(in srgb, ${hex} 88%, black)`)
      root.setProperty('--accent-hover', dark ? `color-mix(in srgb, ${hex} 45%, white)` : hex)
    }
  }

  onMount(() => {
    void applyTheme()
    void load()
    const off = api.on((m: { opened?: boolean }) => {
      void load()
      if (m?.opened) {
        q = ''
        hot = 0
        menuFor = null
        big = null
        note = ''
        void applyTheme()
        void tick().then(() => search?.focus())
      }
    })
    const offTheme = window.hopper.onTheme(() => void applyTheme())
    search?.focus()
    return () => {
      off()
      offTheme()
    }
  })

  function flash(t: string) {
    note = t
    setTimeout(() => note === t && (note = ''), 2500)
  }

  async function use(e: ClipEntry | undefined, mode: 'paste' | 'copy' | 'plain' = settings?.pasteAfterPick === false ? 'copy' : 'paste') {
    if (!e) return
    try {
      await api.use(e.id, mode !== 'copy', mode === 'plain')
      if (mode === 'copy') flash('Copied — paste it with Ctrl+V')
    } catch (err: any) {
      flash(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  async function remove(e: ClipEntry) {
    await api.remove([e.id])
  }

  async function pin(e: ClipEntry) {
    await api.pin(e.id, !e.pinned)
  }

  async function tidy() {
    const n = await api.tidy()
    flash(n ? `Removed ${n} duplicate or stale ${n === 1 ? 'entry' : 'entries'}` : 'Nothing to tidy')
  }

  async function clearAll() {
    const n = await api.clear(true)
    flash(`Cleared ${n} ${n === 1 ? 'entry' : 'entries'}; pinned ones stay`)
  }

  async function pasteFiles(e: ClipEntry, op: 'copy' | 'move', dest: string) {
    menuFor = null
    try {
      await api.pasteFiles(e.id, op, dest)
    } catch (err: any) {
      flash(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  async function preview(e: ClipEntry) {
    const src = await api.image(e.id)
    if (src) big = { id: e.id, src }
  }

  function key(ev: KeyboardEvent) {
    const typing = ev.target === search
    if (ev.key === 'Escape') {
      ev.preventDefault()
      if (big) big = null
      else if (menuFor) menuFor = null
      else if (q) q = ''
      else void api.hide()
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      hot = Math.min(shown.length - 1, hot + 1)
      scrollHot()
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      hot = Math.max(0, hot - 1)
      scrollHot()
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      void use(current, ev.ctrlKey ? 'copy' : ev.shiftKey ? 'plain' : undefined)
    } else if (ev.key === 'Delete' && current && (!typing || !q)) {
      ev.preventDefault()
      void remove(current)
    } else if (ev.ctrlKey && ev.key.toLowerCase() === 'p' && current) {
      ev.preventDefault()
      void pin(current)
    } else if (/^[1-9]$/.test(ev.key) && (ev.altKey || (!typing && !ev.ctrlKey)) ) {
      ev.preventDefault()
      void use(shown[Number(ev.key) - 1])
    } else if (ev.key === 'Tab') {
      ev.preventDefault()
      const i = FILTERS.findIndex((f) => f.id === filter)
      filter = FILTERS[(i + (ev.shiftKey ? FILTERS.length - 1 : 1)) % FILTERS.length].id
      hot = 0
    }
  }

  function scrollHot() {
    void tick().then(() => listEl?.querySelector('.row.hot')?.scrollIntoView({ block: 'nearest' }))
  }

  const kindIcon = (e: ClipEntry) =>
    e.kind === 'image' ? 'image' : e.kind === 'files' ? (e.files?.length === 1 && e.files[0].dir ? 'folder' : 'file') : e.hint === 'url' ? 'link' : e.hint === 'path' ? 'folder' : e.hint === 'email' ? 'at' : e.hint === 'code' ? 'code' : 'text'
  const base = (p: string) => p.replace(/\\+$/, '').split('\\').pop() || p
</script>

<svelte:window onkeydown={key} />

<div class="panel">
  <header class="drag">
    <span class="logo"><Icon name="paste" size={16} /></span>
    <span class="title">Clipboard</span>
    <span class="count">{entries.length}</span>
    <span class="grow"></span>
    <button class="ghost" title="Remove duplicates, empty text and entries whose files are gone" onclick={tidy}><Icon name="duplicate" size={14} /> Tidy</button>
    <button class="ghost" title="Clear everything except pinned entries" onclick={clearAll}><Icon name="delete" size={14} /></button>
    <button class="ghost" title="Close (Esc)" onclick={() => void api.hide()}><Icon name="close" size={14} /></button>
  </header>

  <div class="search">
    <Icon name="search" size={14} />
    <input bind:this={search} bind:value={q} oninput={() => (hot = 0)} placeholder="Search what you copied" spellcheck="false" />
  </div>

  <div class="chips">
    {#each FILTERS as f (f.id)}
      <button class="chip" class:on={filter === f.id} onclick={() => { filter = f.id; hot = 0 }}><Icon name={f.icon} size={12} /> {f.label}</button>
    {/each}
  </div>

  <div class="list" bind:this={listEl}>
    {#if settings && !settings.enabled}
      <div class="empty">Clipboard history is off. Turn it on in Hopper's Settings › Clipboard.</div>
    {:else if !shown.length}
      <div class="empty">{entries.length ? 'Nothing matches.' : 'Copy something — text, an image, files or folders — and it appears here.'}</div>
    {/if}
    {#each shown as e, i (e.id)}
      <div class="row" class:hot={i === hot} class:pinned={e.pinned} role="option" aria-selected={i === hot} tabindex="-1"
        onmouseenter={() => (hot = i)} onclick={() => void use(e)} onkeydown={() => {}}>
        <div class="lead">
          {#if i < 9}<span class="num">{i + 1}</span>{/if}
          <Icon name={kindIcon(e)} size={14} />
        </div>
        <div class="body">
          {#if e.kind === 'image'}
            <button class="thumb" title="Preview" onclick={(ev) => { ev.stopPropagation(); void preview(e) }}><img src={e.thumb} alt="" /></button>
            <div class="meta">{entryTitle(e)} · {fmtSize(e.bytes)}</div>
          {:else if e.kind === 'files'}
            <div class="files">
              {#each (e.files ?? []).slice(0, 4) as f (f.path)}
                <div class="file" class:missing={f.missing} title={f.path}><Icon name={f.dir ? 'folder' : 'file'} size={12} /> <span class="ellipsis">{base(f.path)}</span>{#if f.missing}<em>gone</em>{/if}</div>
              {/each}
              {#if (e.files?.length ?? 0) > 4}<div class="more">and {(e.files?.length ?? 0) - 4} more</div>{/if}
            </div>
            <div class="meta">{e.files?.length} item{e.files?.length === 1 ? '' : 's'}{e.cut ? ' · cut' : ''} · {(e.files?.[0]?.path ?? '').replace(/\\[^\\]*$/, '')}</div>
          {:else}
            <div class="text" class:code={e.hint === 'code' || e.hint === 'path'}>
              {#if e.hint === 'color'}<span class="swatch" style:background={e.text?.trim()}></span>{/if}{(e.text ?? '').slice(0, 600)}
            </div>
          {/if}
          <div class="sub">
            {fmtAgo(e.at)}{#if e.count > 1} · copied {e.count}×{/if}{#if e.source} · {e.source}{/if}
          </div>
        </div>
        <div class="acts" onclick={(ev) => ev.stopPropagation()} onkeydown={() => {}} role="toolbar" tabindex="-1">
          <button title={e.pinned ? 'Unpin (Ctrl+P)' : 'Pin: never cleared or pushed out (Ctrl+P)'} class:on={e.pinned} onclick={() => void pin(e)}><Icon name="pin" size={13} /></button>
          <button title="Copy only (Ctrl+Enter)" onclick={() => void use(e, 'copy')}><Icon name="copy" size={13} /></button>
          {#if e.kind === 'text' && (e.html || e.rtf)}
            <button title="Paste as plain text (Shift+Enter)" onclick={() => void use(e, 'plain')}><Icon name="text" size={13} /></button>
          {/if}
          {#if e.kind === 'text' && e.hint === 'path'}
            <button title="Open in Hopper" onclick={() => void api.reveal(e.text?.trim().replace(/^"|"$/g, ''))}><Icon name="open" size={13} /></button>
          {/if}
          {#if e.kind === 'image'}
            <button title="Save as PNG…" onclick={() => void api.saveImage(e.id)}><Icon name="download" size={13} /></button>
          {/if}
          {#if e.kind === 'files'}
            <button title="Paste into a folder…" class:on={menuFor === e.id} onclick={() => (menuFor = menuFor === e.id ? null : e.id)}><Icon name="paste" size={13} /></button>
            <button title="Show in Hopper" onclick={() => void api.reveal(e.files?.[0]?.path)}><Icon name="open" size={13} /></button>
          {/if}
          <button title="Remove (Del)" onclick={() => void remove(e)}><Icon name="close" size={13} /></button>
        </div>
        {#if menuFor === e.id}
          <div class="dest" onclick={(ev) => ev.stopPropagation()} onkeydown={() => {}} role="menu" tabindex="-1">
            <div class="dhead">Paste {e.files?.length} item{e.files?.length === 1 ? '' : 's'} into…</div>
            <button onclick={() => void pasteFiles(e, 'copy', 'hopper')}><Icon name="folderOpen" size={13} /> The folder open in Hopper</button>
            {#each dests as d (d)}
              <button title={d} onclick={() => void pasteFiles(e, 'copy', d)}><Icon name="history" size={13} /> <span class="ellipsis">{d}</span></button>
            {/each}
            <button onclick={() => void pasteFiles(e, 'copy', 'choose')}><Icon name="folder" size={13} /> Choose a folder…</button>
            <button onclick={() => void pasteFiles(e, 'move', 'choose')}><Icon name="cut" size={13} /> Move into a folder…</button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <footer>
    {#if note}<span class="note">{note}</span>{:else}<span><kbd>Enter</kbd> paste · <kbd>Ctrl+Enter</kbd> copy · <kbd>Tab</kbd> filter · <kbd>Esc</kbd> close</span>{/if}
  </footer>

  {#if big}
    <div class="big" onclick={() => (big = null)} onkeydown={() => {}} role="presentation"><img src={big.src} alt="" /></div>
  {/if}
</div>

<style>
  :global(html[data-panel='clipboard'] body) {
    background: var(--bg);
  }
  :global(html[data-panel='clipboard'][data-mica='on'] body) {
    background: transparent;
  }
  .panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    font-family: var(--font);
    color: var(--text);
    border: 1px solid var(--stroke-2);
    box-sizing: border-box;
    position: relative;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px 4px 12px;
    -webkit-app-region: drag;
  }
  header button {
    -webkit-app-region: no-drag;
  }
  .logo {
    color: var(--accent);
    display: flex;
  }
  .title {
    font-weight: 600;
  }
  .count {
    font-size: 11px;
    color: var(--text-3);
    background: var(--hover);
    border-radius: 10px;
    padding: 1px 7px;
  }
  .grow {
    flex: 1;
  }
  .ghost {
    border: 0;
    background: transparent;
    color: var(--text-2);
    height: 28px;
    min-width: 28px;
    padding: 0 6px;
    border-radius: var(--r-sm);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ghost:hover {
    background: var(--hover);
    color: var(--text);
  }
  .search {
    margin: 4px 10px 6px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    height: 34px;
    border-radius: var(--r-md);
    background: var(--input);
    border: 1px solid var(--control-stroke);
    border-bottom: 2px solid var(--accent);
    color: var(--text-3);
  }
  .search input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
  }
  .chips {
    display: flex;
    gap: 4px;
    padding: 0 10px 8px;
    flex-wrap: wrap;
  }
  .chip {
    border: 1px solid var(--control-stroke);
    background: var(--control);
    color: var(--text-2);
    border-radius: 14px;
    height: 24px;
    padding: 0 9px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  .chip.on {
    background: var(--accent);
    color: var(--on-accent);
    border-color: transparent;
  }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px 8px;
  }
  .empty {
    color: var(--text-3);
    text-align: center;
    padding: 40px 24px;
  }
  .row {
    position: relative;
    display: flex;
    gap: 8px;
    padding: 8px;
    margin-bottom: 4px;
    border-radius: var(--r-lg);
    background: var(--card);
    border: 1px solid var(--stroke);
    cursor: default;
    animation: rowin var(--mid) var(--ease);
  }
  .row.hot {
    background: var(--sel);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .row.pinned {
    box-shadow: inset 3px 0 0 var(--accent);
  }
  @keyframes rowin {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  .lead {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    color: var(--text-3);
    width: 18px;
    padding-top: 1px;
  }
  .num {
    font-size: 10px;
    font-family: var(--mono);
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .text {
    white-space: pre-wrap;
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.35;
  }
  .text.code {
    font-family: var(--mono);
    font-size: 12px;
  }
  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    margin-right: 6px;
    vertical-align: -1px;
    border: 1px solid var(--stroke-strong);
  }
  .thumb {
    border: 0;
    padding: 0;
    background: repeating-conic-gradient(var(--hover) 0 25%, transparent 0 50%) 0 0 / 12px 12px;
    border-radius: var(--r-md);
    overflow: hidden;
    display: block;
    max-width: 100%;
  }
  .thumb img {
    display: block;
    max-width: 100%;
    max-height: 140px;
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .file.missing {
    color: var(--text-3);
    text-decoration: line-through;
  }
  .file em {
    font-style: normal;
    font-size: 11px;
    color: var(--bad);
    text-decoration: none;
  }
  .more,
  .meta,
  .sub {
    font-size: 11px;
    color: var(--text-3);
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .acts {
    position: absolute;
    top: 5px;
    right: 6px;
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-md);
    background: var(--card-solid);
    box-shadow: 0 0 0 1px var(--stroke-2);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--fast);
  }
  .row.hot .acts,
  .row:hover .acts {
    opacity: 1;
    pointer-events: auto;
  }
  .acts button {
    border: 0;
    background: transparent;
    color: var(--text-2);
    width: 26px;
    height: 24px;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
  }
  .acts button:hover {
    background: var(--hover);
    color: var(--text);
  }
  .acts button.on {
    color: var(--accent);
  }
  .dest {
    position: absolute;
    right: 40px;
    top: 8px;
    z-index: 5;
    width: 260px;
    background: var(--flyout);
    border: 1px solid var(--stroke-2);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-flyout);
    padding: 4px;
  }
  .dhead {
    font-size: 11px;
    color: var(--text-3);
    padding: 4px 8px;
  }
  .dest button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--text);
    min-width: 0;
  }
  .dest button:hover {
    background: var(--hover);
  }
  footer {
    padding: 6px 12px 8px;
    font-size: 11px;
    color: var(--text-3);
    border-top: 1px solid var(--divider);
  }
  kbd {
    font-family: var(--mono);
    font-size: 10px;
    padding: 0 3px;
    border: 1px solid var(--stroke-2);
    border-radius: 3px;
  }
  .note {
    color: var(--accent);
  }
  .big {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    display: grid;
    place-items: center;
    padding: 16px;
    z-index: 10;
    backdrop-filter: blur(8px);
  }
  .big img {
    max-width: 100%;
    max-height: 100%;
    box-shadow: var(--shadow-dialog);
    border-radius: var(--r-md);
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
</style>
