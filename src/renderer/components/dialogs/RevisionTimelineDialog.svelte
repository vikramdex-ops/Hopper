<script lang="ts">
  // Revision timeline: every revision of one drawing under a folder (bounded walk in the engine),
  // newest first, with its status label. Pick two PDFs to compare them visually.
  import { onDestroy, untrack } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine } from '../../lib/api'
  import { basename, dirname, fmtDate, fmtSize, plural } from '../../lib/format'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'
  import { labelById } from '../../lib/unlock.svelte'
  import { dialogs } from '../../lib/commands'
  import { parseRevision } from '@shared/revisions'
  import { defaultOffice } from '@shared/defaults'
  import type { Entry } from '@shared/types'
  import type { LabelItem } from '@shared/labels'

  let { path, close }: { path: string; close: (v?: unknown) => void } = $props()

  type Item = Entry & { rev: string }
  interface Found {
    items: Item[]
    orderKnown: boolean
    scanned: number
    stopped: 'files' | 'time' | 'cancelled' | null
    errors: number
  }

  const file = untrack(() => path)
  const rules = app.office?.revisions ?? defaultOffice().revisions
  const drawing = parseRevision(basename(file), rules).base

  // Where to look: the folder on screen (when the file is inside it) or the file's folder, then
  // each folder above it, so the whole project can be searched without guessing which one it is.
  const here = app.active.path
  const start = !isVirtual(here) && !isArchivePath(here) && file.toLowerCase().startsWith(here.toLowerCase().replace(/\\+$/, '') + '\\') ? here : dirname(file)
  const scopes: string[] = []
  for (let p = start; p && !scopes.includes(p); p = dirname(p)) {
    scopes.push(p)
    if (/^[a-z]:\\?$/i.test(p) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(p)) break
  }
  let scope = $state(scopes[0])

  let running = $state(false)
  let found = $state<Found | null>(null)
  let error = $state('')
  let labels = $state<Record<string, LabelItem>>({})
  let picked = $state<string[]>([])
  let token = ''

  async function find() {
    if (running) await cancel()
    const my = (token = `rt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
    running = true
    error = ''
    picked = []
    try {
      const r = await engine.call<Found>('revisions.find', my, path, [scope])
      if (my !== token) return
      found = r
      labels = r.items.length ? await engine.call<Record<string, LabelItem>>('labels.get', r.items.map((i) => i.path)).catch(() => ({})) : {}
    } catch (e: any) {
      if (my === token) error = String(e?.message ?? e).replace(/^Error:\s*/, '')
    } finally {
      if (my === token) running = false
    }
  }

  async function cancel() {
    if (token) await engine.call('revisions.cancel', token).catch(() => {})
  }

  $effect(() => {
    void scope
    untrack(() => void find())
  })
  onDestroy(() => void cancel())

  const rel = (p: string) => {
    const d = dirname(p)
    const root = scope.replace(/\\+$/, '')
    return d.toLowerCase() === root.toLowerCase() ? '.' : d.toLowerCase().startsWith(root.toLowerCase() + '\\') ? d.slice(root.length + 1) : d
  }

  function toggle(i: Item) {
    if (i.ext !== 'pdf') return
    const k = i.path
    picked = picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k].slice(-2)
  }

  function compare() {
    if (!found || picked.length !== 2) return
    // the list is newest first: the one further down is the older
    const order = found.items.map((i) => i.path)
    const [newer, older] = [...picked].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const it = (p: string) => found!.items.find((i) => i.path === p)!
    void dialogs.pdfCompare?.(older, newer, [`Rev ${it(older).rev}`, `Rev ${it(newer).rev}`])
  }

  function show(p: string) {
    void app.reveal(p)
    close()
  }

  const stoppedText = $derived(
    !found?.stopped ? '' : found.stopped === 'files' ? 'Stopped after 20,000 files: pick a smaller folder to see everything.' : found.stopped === 'time' ? 'Stopped after 15 seconds: pick a smaller folder to see everything.' : 'Stopped.'
  )
</script>

<Dialog title="Revision timeline" icon="history" width={900} onclose={() => close()}>
  <div class="top">
    <div class="drawing"><span class="caption">Drawing</span><b class="ellipsis" title={drawing}>{drawing}</b></div>
    <label class="field look">
      <span class="caption">Look in</span>
      <select class="input" bind:value={scope} disabled={running}>
        {#each scopes as s, i (s)}
          <option value={s}>{basename(s) || s}{i === 0 ? ' and its subfolders' : ' (and everything below it)'}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="caption status">
    {#if running}
      Looking for revisions…
    {:else if error}
      <span class="warn">{error}</span>
    {:else if found}
      {plural(found.items.length, 'revision file')} · looked at {plural(found.scanned, 'file')}{found.errors ? ` · ${plural(found.errors, 'folder')} could not be read` : ''} ·
      {found.orderKnown ? 'newest revision first' : 'newest modified first (the office rules cannot order these revisions)'}
      {#if stoppedText}<div class="warn">{stoppedText}</div>{/if}
    {/if}
  </div>

  <div class="table" role="list">
    {#if found}
      {#each found.items as i, n (i.path)}
        {@const lab = labelById(labels[i.path.toLowerCase()]?.label)}
        {@const isPdf = i.ext === 'pdf'}
        <div class="tr" class:on={picked.includes(i.path)} class:me={i.path.toLowerCase() === path.toLowerCase()} role="listitem">
          <span class="dot" class:first={n === 0}></span>
          <label class="pick" title={isPdf ? 'Pick two PDFs to compare' : 'Only PDFs can be compared'}>
            <input type="checkbox" disabled={!isPdf} checked={picked.includes(i.path)} onchange={() => toggle(i)} aria-label={`Pick ${i.name}`} />
          </label>
          <span class="rev" title="Revision">{i.rev}</span>
          <span class="meta">
            <span class="ellipsis nm" title={i.path}>{i.name}</span>
            <span class="caption ellipsis" title={dirname(i.path)}>{rel(i.path)}</span>
          </span>
          <span class="caption when">{fmtDate(i.mtime)}</span>
          <span class="caption size">{fmtSize(i.size)}</span>
          <span class="lab">{#if lab}<span class="lpill" style:--lc={lab.color}><span class="ldot"></span>{lab.name}</span>{/if}</span>
          <span class="acts">
            <button type="button" class="btn subtle sm" onclick={() => void app.openEntry(i)}>Open</button>
            <button type="button" class="btn subtle sm" onclick={() => show(i.path)}>Show in folder</button>
          </span>
        </div>
      {:else}
        {#if !running}<div class="caption empty">No revisions of {drawing} found here.</div>{/if}
      {/each}
    {/if}
  </div>

  {#snippet footer()}
    <span class="caption lead">{picked.length === 2 ? 'Ready to compare' : 'Pick two PDF revisions to compare'}</span>
    {#if running}<button type="button" class="btn" onclick={() => void cancel()}>Stop</button>{/if}
    <button type="button" class="btn primary" disabled={picked.length !== 2} onclick={compare}><Icon name="compare" /> Compare</button>
    <button type="button" class="btn" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .top {
    display: flex;
    gap: 12px;
    align-items: flex-end;
  }
  .drawing {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .drawing b {
    font: 600 18px/24px var(--font-display);
  }
  .look {
    width: 340px;
  }
  .status {
    min-height: 18px;
  }
  .warn {
    color: var(--warn);
  }
  .table {
    max-height: 52vh;
    min-height: 180px;
    overflow: auto;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    padding: 4px 0;
  }
  .tr {
    position: relative;
    display: grid;
    grid-template-columns: 18px 24px 52px minmax(0, 1fr) 128px 72px 120px auto;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 10px 0 12px;
    font-size: 13px;
  }
  .tr:hover {
    background: var(--hover);
  }
  .tr.on {
    background: var(--sel);
  }
  /* the timeline line through the dots */
  .tr::before {
    content: '';
    position: absolute;
    left: 20px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--stroke);
  }
  .dot {
    position: relative;
    z-index: 1;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--layer-solid);
    border: 2px solid var(--text-3);
  }
  .dot.first {
    border-color: var(--accent);
    background: var(--accent);
  }
  .me .nm {
    font-weight: 600;
  }
  .pick {
    display: flex;
    align-items: center;
  }
  .rev {
    font: 600 15px/20px var(--font-display);
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .when,
  .size {
    text-align: right;
  }
  .acts {
    display: flex;
    gap: 2px;
  }
  .lpill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 7px 0 5px;
    height: 18px;
    border-radius: 999px;
    font-size: 11px;
    background: color-mix(in srgb, var(--lc) 16%, transparent);
    color: var(--text);
  }
  .ldot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--lc);
  }
  .empty {
    padding: 12px;
  }
  .lead {
    margin-right: auto;
    align-self: center;
  }
</style>
