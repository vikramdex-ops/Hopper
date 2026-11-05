<script lang="ts">
  // Folder sizes: what takes the space in the active pane's folder, largest first, with bars.
  // Subfolder totals stream in from the engine ('size' events) and are cancelled on close.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine } from '../../lib/api'
  import { fmtSize, plural } from '../../lib/format'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'

  let { close }: { close: (v?: unknown) => void } = $props()

  const pane = app.active
  const folder = pane.path
  const usable = !isVirtual(folder) && !isArchivePath(folder)
  const token = `fsz${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

  interface Item {
    name: string
    path: string
    dir: boolean
    bytes: number
    files: number
    dirs: number
    done: boolean
  }

  const initial: Item[] = usable ? pane.rows.map((e) => ({ name: e.name, path: e.path, dir: e.dir, bytes: e.dir ? 0 : e.size, files: e.dir ? 0 : 1, dirs: 0, done: !e.dir })) : []
  let items = $state<Item[]>(initial)
  let finished = $state(!initial.some((i) => i.dir))
  let failed = $state('')
  let filesToo = $state(true)

  onMount(() => {
    if (!usable) return
    const dirs = initial.filter((i) => i.dir).map((i) => i.path)
    const index = new Map(initial.map((i, k) => [i.path.toLowerCase(), k]))
    const off = engine.on('size', (d: { token: string; path: string; bytes: number; files: number; dirs: number; done: boolean }) => {
      if (d.token !== token) return
      const k = index.get(d.path.toLowerCase())
      if (k === undefined) return
      items[k] = { ...items[k], bytes: d.bytes, files: d.files, dirs: d.dirs, done: d.done }
    })
    if (dirs.length) {
      engine
        .call('fs.size', dirs, token)
        .then(() => (finished = true))
        .catch((e: any) => {
          failed = String(e?.message ?? e).replace(/^Error:\s*/, '')
          finished = true
        })
    }
    return () => {
      off()
      if (!finished) void engine.call('fs.sizeCancel', token).catch(() => {})
    }
  })

  const shown = $derived(items.filter((i) => filesToo || i.dir).slice().sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)))
  const total = $derived(items.reduce((a, i) => a + i.bytes, 0))
  const totalFiles = $derived(items.reduce((a, i) => a + i.files, 0))
  const max = $derived(Math.max(1, ...shown.map((i) => i.bytes)))
  const pending = $derived(items.filter((i) => i.dir && !i.done).length)

  function openItem(i: Item) {
    close(true)
    if (i.dir) void pane.navigate(i.path)
    else void app.reveal(i.path)
  }
</script>

<Dialog title="Folder sizes" icon="size" width={680} onclose={() => close()}>
  {#if !usable}
    <div class="caption">Folder sizes work on real folders, not inside archives or virtual views.</div>
  {:else}
    <div class="head">
      <span class="ellipsis path" title={folder}>{folder}</span>
      <span class="sum">{fmtSize(total)}</span>
    </div>
    <div class="caption">
      {plural(totalFiles, 'file')} counted{pending && !finished ? ` · measuring ${plural(pending, 'folder')}…` : ''}{failed ? ` · ${failed}` : ''}
    </div>
    <label class="check"><input type="checkbox" bind:checked={filesToo} /> Include files in this folder</label>

    {#if !shown.length}
      <div class="caption">This folder is empty.</div>
    {:else}
      <div class="list">
        {#each shown as i (i.path)}
          <button type="button" class="item" onclick={() => openItem(i)} title={i.dir ? `Open ${i.name}` : `Show ${i.name}`}>
            <Icon name={i.dir ? 'folder' : 'file'} />
            <span class="nm ellipsis">{i.name}</span>
            <span class="bar"><span style:width={`${(i.bytes / max) * 100}%`} class:busy={!i.done}></span></span>
            <span class="pct caption">{total ? `${Math.round((i.bytes / total) * 100)}%` : ''}</span>
            <span class="sz">{fmtSize(i.bytes)}{i.done ? '' : '…'}</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  {#snippet footer()}
    <span class="caption foot">Click a folder to open it. Hidden items follow the "Show hidden items" setting.</span>
    <button type="button" class="btn primary" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .path {
    flex: 1;
    font-weight: 600;
  }
  .sum {
    font: 600 20px/28px var(--font-display);
  }
  .list {
    display: flex;
    flex-direction: column;
    max-height: 52vh;
    overflow: auto;
    margin: 0 -8px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
    flex: none;
  }
  .item:hover {
    background: var(--hover);
  }
  .nm {
    width: 220px;
    flex: none;
  }
  .bar {
    flex: 1;
    height: 8px;
    border-radius: 4px;
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width var(--mid) var(--ease);
  }
  .bar span.busy {
    opacity: 0.55;
  }
  .pct {
    width: 36px;
    text-align: right;
  }
  .sz {
    width: 72px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .foot {
    flex: 1;
    align-self: center;
  }
</style>
