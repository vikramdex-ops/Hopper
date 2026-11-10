<script lang="ts">
  // Hopper's own folder / file picker (replaces the Windows "Browse" dialogs):
  // places on the left, a type-or-paste path box, and a folder list you can drill into.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine } from '../../lib/api'
  import { basename, collator, dirname, join } from '../../lib/format'
  import { ATTR, type Entry } from '@shared/types'

  let {
    title = 'Choose a folder',
    mode = 'folder',
    multiple = false,
    start = '',
    filter = [],
    ok,
    close
  }: {
    title?: string
    mode?: 'folder' | 'file'
    multiple?: boolean
    start?: string
    /** file mode: extensions to show (lower-case, no dot); empty = all */
    filter?: string[]
    ok?: string
    close: (v?: unknown) => void
  } = $props()

  const HOME = ''
  let path = $state(start && !start.startsWith('hopper:') && !start.includes('::') ? start : HOME)
  let typed = $state(path)
  let entries = $state.raw<Entry[]>([])
  let loading = $state(false)
  let error = $state('')
  let picked = $state<string[]>([])
  let token = 0

  const places = $derived([
    ...[app.info?.desktop, app.info?.documents, app.info?.downloads].filter(Boolean).map((p: string) => ({ label: basename(p), path: p, icon: 'folder' })),
    ...(app.settings?.pinned ?? []).map((p) => ({ label: basename(p) || p, path: p, icon: 'pin' })),
    ...(app.settings?.quickDests ?? []).slice(0, 6).map((d) => ({ label: d.label || basename(d.path), path: d.path, icon: 'history' }))
  ].filter((p, i, a) => a.findIndex((x) => x.path.toLowerCase() === p.path.toLowerCase()) === i))

  /** the folder highlighted in a file picker (not part of the answer) */
  let cursor = $state('')

  async function load(p: string) {
    const my = ++token
    path = p
    typed = p
    picked = []
    cursor = ''
    error = ''
    if (p === HOME) {
      entries = []
      return
    }
    loading = true
    try {
      const r = await engine.call<{ entries: Entry[] }>('fs.list', p)
      if (my !== token) return
      entries = r.entries
        .filter((e) => !(e.attrs & ATTR.hidden) && (e.dir || (mode === 'file' && (!filter.length || filter.includes(e.ext)))))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name))
    } catch (e: any) {
      if (my !== token) return
      entries = []
      error = String(e.message).replace(/^Error:\s*/, '')
    } finally {
      if (my === token) loading = false
    }
  }
  void load(path)

  function up() {
    if (path === HOME) return
    const parent = dirname(path)
    void load(parent === path || /^[a-zA-Z]:\\?$/.test(path) ? HOME : parent)
  }

  function click(e: Entry, ev: MouseEvent) {
    if (mode === 'folder' && !e.dir) return
    if (mode === 'file' && e.dir) {
      // a folder cannot be the answer here, but it is highlighted like a file; Open goes into it
      picked = []
      cursor = e.path
      return
    }
    cursor = ''
    if (multiple && ev.ctrlKey) picked = picked.includes(e.path) ? picked.filter((p) => p !== e.path) : [...picked, e.path]
    else picked = [e.path]
  }

  function dbl(e: Entry) {
    if (e.dir) void load(e.path)
    else if (mode === 'file') close(multiple ? [e.path] : e.path)
  }

  async function newFolder() {
    if (path === HOME) return
    const n = await app.prompt('New folder', 'New folder', 'Name')
    if (!n) return
    try {
      const p = await engine.call<string>('fs.mkdir', path, n)
      await load(path)
      picked = [p]
    } catch (e: any) {
      error = e.message
    }
  }

  // Folder mode: the highlighted folder, else the folder being shown.
  const result = $derived(mode === 'folder' ? picked[0] ?? (path !== HOME ? path : '') : picked.length ? (multiple ? picked : picked[0]) : '')

  function submit() {
    if (typed.trim() && typed.trim() !== path) return void load(typed.trim().replace(/^"|"$/g, ''))
    if (!result || (Array.isArray(result) && !result.length)) return
    close(result)
  }
</script>

<Dialog {title} icon="folderOpen" width={720} onclose={() => close()} onsubmit={submit}>
  <div class="bar">
    <button type="button" class="btn subtle icon sm" onclick={up} disabled={path === HOME} title="Up"><Icon name="up" /></button>
    <input class="input" bind:value={typed} spellcheck="false" placeholder="Type or paste a path, then Enter" />
    {#if mode === 'folder'}<button type="button" class="btn sm" onclick={newFolder} disabled={path === HOME}><Icon name="newFolder" /> New folder</button>{/if}
  </div>
  <div class="cols">
    <nav class="places">
      <div class="caption h">Drives</div>
      {#each app.drives.filter((d) => d.ready) as d (d.root)}
        <button type="button" class="place" class:on={path.toLowerCase().startsWith(d.root.toLowerCase())} onclick={() => load(d.root)}>
          <Icon name={d.kind === 'network' ? 'network' : 'drive'} /> <span class="ellipsis">{d.label || (d.kind === 'network' ? 'Network' : 'Local Disk')} ({d.root.slice(0, 2)})</span>
        </button>
      {/each}
      {#if places.length}<div class="caption h">Places</div>{/if}
      {#each places as p (p.path)}
        <button type="button" class="place" onclick={() => load(p.path)} title={p.path}><Icon name={p.icon} /> <span class="ellipsis">{p.label}</span></button>
      {/each}
    </nav>
    <div class="list" role="listbox">
      {#if path === HOME}
        <div class="caption pad">Pick a drive or a place on the left, or paste a path above.</div>
      {:else if error}
        <div class="caption pad">{error}</div>
      {:else if loading}
        <div class="caption pad">Loading…</div>
      {:else if !entries.length}
        <div class="caption pad">{mode === 'folder' ? 'No folders in here.' : 'Nothing to pick in here.'}</div>
      {/if}
      {#each entries as e (e.path)}
        <button type="button" class="item" class:on={picked.includes(e.path) || cursor === e.path} class:dim={mode === 'folder' ? !e.dir : false} onclick={(ev) => click(e, ev)} ondblclick={() => dbl(e)}>
          <span class="ic" class:folder={e.dir}>
            {#if e.dir}<Icon name="folder" />{:else}<img src={`hopper://icon/?p=${encodeURIComponent(e.path)}&e=${e.ext}&z=small`} alt="" width="16" height="16" />{/if}
          </span>
          <span class="ellipsis">{e.name}</span>
        </button>
      {/each}
    </div>
  </div>
  {#snippet footer()}
    <span class="caption sel ellipsis">{Array.isArray(result) ? `${result.length} selected` : result || 'Nothing selected'}</span>
    {#if cursor}
      <button type="button" class="btn primary" onclick={() => load(cursor)}>Open folder</button>
    {:else}
      <button type="submit" class="btn primary" disabled={!result || (Array.isArray(result) && !result.length)}>{ok ?? (mode === 'folder' ? 'Choose this folder' : 'Choose')}</button>
    {/if}
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .bar {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .bar .input {
    flex: 1;
  }
  .cols {
    display: grid;
    grid-template-columns: 190px 1fr;
    gap: 10px;
    height: 380px;
  }
  .places,
  .list {
    overflow: auto;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    padding: 4px;
  }
  .h {
    padding: 8px 8px 2px;
    font-weight: 600;
  }
  .place,
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
    min-width: 0;
  }
  .place:hover,
  .item:hover {
    background: var(--hover);
  }
  .place.on {
    background: var(--hover);
  }
  .item.on {
    background: var(--sel);
  }
  .item.dim {
    opacity: 0.5;
  }
  .ic {
    display: flex;
    flex: none;
  }
  .ic.folder {
    color: #e8a33d;
  }
  .pad {
    padding: 24px;
    text-align: center;
  }
  .sel {
    flex: 1;
    align-self: center;
    min-width: 0;
  }
</style>
