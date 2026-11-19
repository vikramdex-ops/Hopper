<script lang="ts">
  import { app } from '../lib/app.svelte'
  import { host, engine } from '../lib/api'
  import { isArchivePath, isVirtual } from '../lib/pane.svelte'
  import { typeLabel, kindOf, richMode } from '../lib/filetypes'
  import { openDocViewer } from '../lib/docviewer.svelte'
  import { fmtDateFull, fmtSize, plural, basename, dirname } from '../lib/format'
  import { dialogs } from '../lib/commands'
  import { ATTR, type Entry } from '@shared/types'
  import Preview from './Preview.svelte'
  import Splitter from './Splitter.svelte'
  import Icon from './Icon.svelte'
  import { unlockUi } from '../lib/unlock.svelte'

  const pane = $derived(app.active)
  const sel = $derived(pane?.selected ?? [])
  // Debounce so holding an arrow key doesn't render a preview per row.
  let shown = $state<Entry | null>(null)
  let timer: ReturnType<typeof setTimeout>
  $effect(() => {
    const f = pane?.focused ?? null
    clearTimeout(timer)
    timer = setTimeout(() => (shown = f), 110)
  })

  let hash = $state<{ path: string; value: string } | null>(null)
  let size = $state<{ path: string; bytes: number; files: number; done: boolean } | null>(null)
  $effect(() => {
    void shown?.path
    hash = null
    size = null
  })

  engine.on('size', (d) => {
    if (d.token === 'inspector' && shown && d.path === shown.path) size = d
  })

  function computeSize() {
    if (!shown) return
    size = { path: shown.path, bytes: 0, files: 0, done: false }
    void engine.call('fs.size', [shown.path], 'inspector')
  }

  async function computeHash() {
    if (!shown) return
    const p = shown.path
    hash = { path: p, value: 'Computing…' }
    try {
      hash = { path: p, value: await engine.call('fs.hash', p, 'sha256') }
    } catch (e: any) {
      hash = { path: p, value: e.message }
    }
  }

  const attrs = (a: number) =>
    [a & ATTR.readonly && 'Read-only', a & ATTR.hidden && 'Hidden', a & ATTR.system && 'System', a & ATTR.archive && 'Archive', a & ATTR.compressed && 'Compressed', a & ATTR.encrypted && 'Encrypted', a & (ATTR.recallOnAccess | ATTR.offline) && 'Online-only']
      .filter(Boolean)
      .join(', ')

  const copy = (t: string) => {
    void host.clip.writeText(t)
    app.toast('info', 'Copied', t.length > 80 ? `${t.slice(0, 80)}…` : t)
  }

  // shared status label and note of the shown item
  const item = $derived(shown ? pane?.labelOf(shown.path) : undefined)
  const lockText = $derived(shown ? pane?.lockText(shown.path) ?? '' : '')
  let noteDraft = $state('')
  let notePath = ''
  let editingNote = false
  $effect(() => {
    const p = shown?.path ?? ''
    const n = item?.note ?? ''
    if (p !== notePath || !editingNote) {
      noteDraft = n
      notePath = p
    }
  })
  async function saveNote() {
    editingNote = false
    if (!shown || noteDraft.trim() === (item?.note ?? '')) return
    await unlockUi.setNote(shown.path, noteDraft)
  }

  // px is measured from the left edge of the body row; the inspector takes what's right of it.
  function resize(_f: number, px: number) {
    const body = document.querySelector('.body')?.clientWidth ?? window.innerWidth
    app.updateSettings({ inspectorWidth: Math.round(Math.max(260, Math.min(720, body - px - 12))) })
  }
</script>

<Splitter onDrag={(f, px) => resize(f, px)} />
<aside class="insp" style:width={`${app.settings?.inspectorWidth ?? 320}px`} aria-label="Preview and details">
  {#if sel.length > 1}
    <div class="multi">
      <Icon name="selectAll" size={40} />
      <div class="subtitle">{plural(sel.length, 'item')} selected</div>
      <div class="caption">{fmtSize(sel.reduce((a, e) => a + (e.dir ? 0 : e.size), 0))}{sel.some((e) => e.dir) ? ' + folders' : ''}</div>
      <div class="actions">
        <button class="btn" onclick={() => dialogs.share?.()}><Icon name="share" /> Share</button>
        <button class="btn" onclick={() => app.zip(app.settings?.defaultPreset)}><Icon name="zip" /> Zip</button>
        <button class="btn" onclick={() => dialogs.copyTo?.('copy')}><Icon name="copy" /> Copy to…</button>
      </div>
    </div>
  {:else if shown}
    {@const e = shown}
    <div class="scroll">
      <Preview entry={e} />
      <h3 class="name" title={e.name}>{e.name}</h3>
      <div class="caption type">{typeLabel(e.ext, e.dir)}{e.dir ? '' : ` · ${fmtSize(e.size)}`}</div>
      <div class="actions">
        <button class="btn sm" onclick={() => app.openEntry(e)}><Icon name="open" /> Open</button>
        {#if !e.dir && !isArchivePath(e.path) && richMode(e.ext)}
          <button class="btn sm" title="View in full window" onclick={() => openDocViewer(e)}><Icon name="fullscreen" /> View</button>
        {/if}
        {#if !isVirtual(e.path) && !isArchivePath(e.path)}
          <button class="btn sm" onclick={() => dialogs.share?.()}><Icon name="share" /> Share</button>
          <button class="btn subtle icon sm" title="Copy path" onclick={() => copy(e.path)}><Icon name="copyPath" /></button>
          <button class="btn subtle icon sm" title="Properties" onclick={() => dialogs.properties?.([e.path])}><Icon name="info" /></button>
        {/if}
      </div>
      {#if !isVirtual(e.path) && !isArchivePath(e.path)}
        {#if lockText}
          <div class="lockline"><Icon name="lock" size={14} /><span>{lockText}</span><button class="link" onclick={() => unlockUi.open([e.path])}>Who has it open?</button></div>
        {/if}
        <div class="labels" aria-label="Status label and note">
          <div class="lrow">
            {#each pane.labelDefs as d (d.id)}
              <button class="lchip" class:on={item?.label === d.id} style:--lc={d.color} aria-pressed={item?.label === d.id} title={item?.label === d.id ? 'Click to clear' : `Label: ${d.name}`} onclick={() => unlockUi.setLabel([e.path], item?.label === d.id ? null : d.id)}><span class="ldot"></span>{d.name}</button>
            {/each}
          </div>
          <textarea class="input note" rows="2" maxlength="500" placeholder="Add a note for the office…" bind:value={noteDraft} onfocus={() => (editingNote = true)} onblur={saveNote}></textarea>
          {#if item}<div class="caption">{item.label ? 'Label' : 'Note'} by {item.byName || item.by}, {fmtDateFull(item.at)}</div>{/if}
        </div>
      {/if}
      <dl class="meta">
        <dt>Location</dt>
        <dd><button class="link ellipsis" title={dirname(e.path)} onclick={() => app.reveal(e.path)}>{dirname(e.path)}</button></dd>
        {#if !e.dir}
          <dt>Size</dt>
          <dd>{fmtSize(e.size)} <span class="caption">({e.size.toLocaleString()} bytes)</span></dd>
        {:else if !isVirtual(e.path) && !isArchivePath(e.path)}
          <dt>Size</dt>
          <dd>
            {#if size && size.path === e.path}
              {fmtSize(size.bytes)} <span class="caption">· {plural(size.files, 'file')}{size.done ? '' : '…'}</span>
            {:else}
              <button class="link" onclick={computeSize}>Calculate</button>
            {/if}
          </dd>
        {/if}
        <dt>Modified</dt>
        <dd>{fmtDateFull(e.mtime)}</dd>
        {#if e.ctime}<dt>Created</dt><dd>{fmtDateFull(e.ctime)}</dd>{/if}
        {#if e.atime}<dt>Accessed</dt><dd>{fmtDateFull(e.atime)}</dd>{/if}
        {#if attrs(e.attrs)}<dt>Attributes</dt><dd>{attrs(e.attrs)}</dd>{/if}
        {#if (e as any).rev}<dt>Revision</dt><dd>{(e as any).rev}{(e as any).revUnknown ? ' · order unknown, check manually' : ''}</dd>{/if}
        {#if !e.dir && !isArchivePath(e.path) && !isVirtual(e.path)}
          <dt>SHA-256</dt>
          <dd>
            {#if hash && hash.path === e.path}
              <button class="link hash" title="Copy" onclick={() => copy(hash!.value)}>{hash.value}</button>
            {:else}
              <button class="link" onclick={computeHash}>Compute</button>
            {/if}
          </dd>
        {/if}
      </dl>
    </div>
  {:else if pane && !isVirtual(pane.path)}
    <div class="multi">
      <span style:color="#e8a33d"><Icon name="folder" size={48} /></span>
      <div class="subtitle">{basename(pane.path) || pane.path}</div>
      <div class="caption">{plural(pane.rows.length, 'item')} · {fmtSize(pane.rows.reduce((a, r) => a + (r.dir ? 0 : r.size), 0))}</div>
      <div class="caption">Select a file to preview it.</div>
    </div>
  {:else}
    <div class="multi caption">Select a file to see a preview and its details.</div>
  {/if}
</aside>

<style>
  .insp {
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--card-solid);
    border: 1px solid var(--stroke);
    border-radius: var(--r-lg);
    margin-top: 38px;
    min-height: 0;
    overflow: hidden;
    box-shadow: var(--shadow-card);
  }
  .scroll {
    flex: 1;
    overflow: auto;
    padding: 14px;
  }
  .name {
    margin: 12px 0 0;
    font: 600 16px/22px var(--font-display);
    word-break: break-word;
    user-select: text;
  }
  .type {
    margin-bottom: 10px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
  }
  .meta {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 6px 10px;
    margin: 0;
    font-size: 12px;
  }
  dt {
    color: var(--text-2);
  }
  dd {
    margin: 0;
    min-width: 0;
    word-break: break-word;
    user-select: text;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    text-align: left;
    cursor: pointer;
    max-width: 100%;
    display: block;
  }
  .hash {
    font-family: var(--mono);
    word-break: break-all;
    white-space: normal;
    color: var(--text);
  }
  .multi {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
    color: var(--text-2);
  }
  .multi .actions {
    justify-content: center;
    margin-top: 8px;
  }
  .lockline {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 10px;
    color: #d9822b;
    font-size: 12px;
  }
  .lockline .link {
    display: inline;
    width: auto;
    margin-left: auto;
    flex: none;
  }
  .labels {
    margin: 0 0 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lrow {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .lchip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--stroke);
    background: transparent;
    color: var(--text);
    border-radius: 999px;
    padding: 1px 8px 1px 6px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .lchip.on {
    background: color-mix(in srgb, var(--lc) 20%, transparent);
    border-color: var(--lc);
  }
  .ldot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--lc);
  }
  .note {
    width: 100%;
    resize: vertical;
    font: inherit;
    font-size: 12px;
    box-sizing: border-box;
  }
</style>
