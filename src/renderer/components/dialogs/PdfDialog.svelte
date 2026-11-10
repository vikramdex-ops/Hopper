<script lang="ts">
  // PDF toolkit: merge, split, extract, rotate, reorder. Page numbers are 1-based. Outputs default
  // next to the source and never overwrite (the engine adds " (2)"), except "replace the original" on rotate.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { basename, dirname, fmtSize, join, plural } from '../../lib/format'
  import type { PdfInfo } from '../../../engine/office/types'

  type Mode = 'merge' | 'split' | 'extract' | 'rotate' | 'reorder'
  let { mode: initial, paths = [], close }: { mode?: Mode; paths?: string[]; close: (v?: unknown) => void } = $props()

  const MODES: { id: Mode; label: string; icon: string }[] = [
    { id: 'merge', label: 'Merge', icon: 'merge' },
    { id: 'split', label: 'Split', icon: 'split' },
    { id: 'extract', label: 'Extract', icon: 'copy' },
    { id: 'rotate', label: 'Rotate', icon: 'rotate' },
    { id: 'reorder', label: 'Reorder', icon: 'sort' }
  ]

  let mode = $state<Mode>(initial ?? (paths.length > 1 ? 'merge' : 'split'))
  let files = $state<string[]>([...paths])
  let infos = $state<Record<string, PdfInfo | { error: string }>>({})
  let source = $state(paths[0] ?? '')

  const requested = new Set<string>() // not reactive: only guards against asking twice
  $effect(() => {
    for (const p of files) {
      if (requested.has(p)) continue
      requested.add(p)
      engine.call<PdfInfo>('pdf.info', p).then(
        (i) => (infos[p] = i),
        (e) => (infos[p] = { error: e?.message ?? String(e) })
      )
    }
    if (!files.includes(source)) source = files[0] ?? ''
  })

  const infoOf = (p: string) => {
    const i = infos[p]
    return i && 'pages' in i ? i : null
  }
  const errOf = (p: string) => {
    const i = infos[p]
    return i && 'error' in i ? i.error : ''
  }
  const stem = (p: string) => basename(p).replace(/\.pdf$/i, '')
  const withPdf = (n: string) => (/\.pdf$/i.test(n) ? n : n + '.pdf')
  const srcInfo = $derived(infoOf(source))
  const pageCount = $derived(srcInfo?.pages ?? 0)

  // outputs (defaults follow the source until edited)
  let outDir = $state(paths[0] ? dirname(paths[0]) : '')
  let outName = $state('')
  let edited = $state(false)
  $effect(() => {
    if (edited) return
    const s = mode === 'merge' ? files[0] : source
    if (!s) return
    outDir = mode === 'split' ? join(dirname(s), `${stem(s)} pages`) : dirname(s)
    outName = mode === 'merge' ? `${stem(s)} merged.pdf` : mode === 'extract' ? `${stem(s)} extract.pdf` : mode === 'rotate' ? `${stem(s)} rotated.pdf` : `${stem(s)} reordered.pdf`
  })

  let splitMode = $state<'each' | 'ranges'>('each')
  let ranges = $state('')
  let pagesText = $state('')
  let rotateAll = $state(true)
  let degrees = $state<90 | 180 | 270>(90)
  let inPlace = $state(false)
  let orderText = $state('')

  let runError = $state('')
  let busy = $state(false)

  /** "1,3,5-7" / "7-" / "-3" -> page numbers in the order written. Mirrors the engine's rules. */
  function expand(text: string, n: number): number[] {
    const out: number[] = []
    for (const raw of text.split(/[,;\s]+/).filter(Boolean)) {
      let a: number
      let b: number
      if (/^\d+$/.test(raw)) a = b = Number(raw)
      else {
        const m = /^(\d*)-(\d*)$/.exec(raw)
        if (!m || (m[1] === '' && m[2] === '')) throw new Error(`"${raw}" is not a page or range`)
        a = m[1] === '' ? 1 : Number(m[1])
        b = m[2] === '' ? n : Number(m[2])
      }
      if (a < 1 || b > n || a > b) throw new Error(`"${raw}" is outside pages 1-${n}`)
      for (let k = a; k <= b; k++) out.push(k)
    }
    if (!out.length) throw new Error('Enter at least one page')
    return out
  }

  const problem = $derived.by(() => {
    if (mode === 'merge') {
      if (files.length < 2) return 'Add at least two PDFs to merge'
      const bad = files.find((f) => errOf(f))
      if (bad) return `${basename(bad)}: ${errOf(bad)}`
      if (!outDir.trim() || !outName.trim()) return 'Choose the output folder and name'
      return ''
    }
    if (!source) return 'Choose a PDF'
    if (errOf(source)) return errOf(source)
    if (!srcInfo) return 'Reading the PDF…'
    if (srcInfo.encrypted) return 'This PDF is encrypted; remove the password first'
    try {
      if (mode === 'split') {
        if (splitMode === 'ranges') expand(ranges, pageCount)
        if (!outDir.trim()) return 'Choose the output folder'
      } else if (mode === 'extract') {
        expand(pagesText, pageCount)
      } else if (mode === 'rotate') {
        if (!rotateAll) expand(pagesText, pageCount)
      } else if (mode === 'reorder') {
        const order = expand(orderText, pageCount)
        if (order.length !== pageCount || new Set(order).size !== pageCount) return `List each of the ${pageCount} pages exactly once (you listed ${order.length}${new Set(order).size !== order.length ? ', with repeats' : ''})`
      }
    } catch (e: any) {
      return e.message
    }
    if (mode !== 'split' && !(mode === 'rotate' && inPlace) && (!outDir.trim() || !outName.trim())) return 'Choose the output folder and name'
    return ''
  })

  const out = $derived(join(outDir.trim(), withPdf(outName.trim())))

  async function browse() {
    const d = await host.dialog.folder(mode === 'split' ? 'Save the parts in' : 'Save in', outDir || undefined)
    if (d) {
      outDir = d
      edited = true
    }
  }

  async function addFiles() {
    const more: string[] = await host.dialog.files('Add PDFs', [{ name: 'PDF documents', extensions: ['pdf'] }])
    const have = new Set(files.map((f) => f.toLowerCase()))
    files = [...files, ...more.filter((f) => !have.has(f.toLowerCase()))]
  }

  function move(i: number, d: -1 | 1) {
    const j = i + d
    if (j < 0 || j >= files.length) return
    const next = [...files]
    ;[next[i], next[j]] = [next[j], next[i]]
    files = next
  }

  async function go() {
    if (problem || busy) return
    busy = true
    runError = ''
    try {
      if (mode === 'merge') await engine.call('pdf.merge', [...files], out)
      else if (mode === 'split') await engine.call('pdf.split', source, splitMode, splitMode === 'ranges' ? ranges : '', outDir.trim())
      else if (mode === 'extract') await engine.call('pdf.extract', source, expand(pagesText, pageCount), out)
      else if (mode === 'rotate') await engine.call('pdf.rotate', source, rotateAll ? 'all' : expand(pagesText, pageCount), degrees, inPlace ? source : out)
      else await engine.call('pdf.reorder', source, expand(orderText, pageCount), out)
      app.showProgress()
      close(true)
    } catch (e: any) {
      runError = e?.message ?? String(e)
    } finally {
      busy = false
    }
  }

  const verb = $derived(MODES.find((m) => m.id === mode)!.label)
</script>

<Dialog title="PDF tools" icon="pdf" width={640} onclose={() => close()} onsubmit={go}>
  <div class="seg" role="tablist">
    {#each MODES as m (m.id)}
      <button type="button" role="tab" aria-selected={mode === m.id} class:on={mode === m.id} onclick={() => { mode = m.id; edited = false; runError = '' }}><Icon name={m.icon} /> {m.label}</button>
    {/each}
  </div>

  {#if mode === 'merge'}
    <div class="head">
      <span class="subtitle">Files, in merge order</span>
      <span class="caption">{plural(files.reduce((n, f) => n + (infoOf(f)?.pages ?? 0), 0), 'page')}</span>
      <span class="spacer"></span>
      <button type="button" class="btn sm" onclick={addFiles}><Icon name="plus" /> Add PDFs</button>
    </div>
    <div class="list">
      {#each files as f, i (f)}
        <div class="item" class:bad={!!errOf(f)}>
          <Icon name="pdf" size={14} />
          <span class="ellipsis grow" title={f}>{basename(f)}</span>
          <span class="caption">{errOf(f) || (infoOf(f) ? `${plural(infoOf(f)!.pages, 'page')} · ${fmtSize(infoOf(f)!.bytes)}` : '…')}</span>
          <button type="button" class="btn subtle icon sm" aria-label="Move up" disabled={i === 0} onclick={() => move(i, -1)}><Icon name="chevronUp" size={14} /></button>
          <button type="button" class="btn subtle icon sm" aria-label="Move down" disabled={i === files.length - 1} onclick={() => move(i, 1)}><Icon name="chevronDown" size={14} /></button>
          <button type="button" class="btn subtle icon sm" aria-label="Remove" onclick={() => (files = files.filter((x) => x !== f))}><Icon name="close" size={14} /></button>
        </div>
      {:else}
        <div class="caption empty">No PDFs yet.</div>
      {/each}
    </div>
  {:else}
    <label class="field">
      <span>PDF</span>
      <div class="row">
        <select class="input" bind:value={source}>
          {#each files as f (f)}<option value={f}>{basename(f)}</option>{/each}
        </select>
        <button type="button" class="btn" onclick={addFiles}><Icon name="plus" /> Add</button>
      </div>
      {#if srcInfo}
        <span class="hint">{plural(srcInfo.pages, 'page')} · {fmtSize(srcInfo.bytes)}{srcInfo.title ? ` · ${srcInfo.title}` : ''}{srcInfo.encrypted ? ' · encrypted' : ''}</span>
      {:else if errOf(source)}
        <span class="hint bad">{errOf(source)}</span>
      {/if}
    </label>

    {#if mode === 'split'}
      <div class="radios">
        <label class="check"><input type="radio" bind:group={splitMode} value="each" /> One file per page</label>
        <label class="check"><input type="radio" bind:group={splitMode} value="ranges" /> By page ranges</label>
      </div>
      {#if splitMode === 'ranges'}
        <label class="field">
          <span>Ranges <span class="caption">(each range becomes one file)</span></span>
          <input class="input" bind:value={ranges} placeholder="1-3, 5, 7-" spellcheck="false" />
        </label>
      {/if}
    {:else if mode === 'extract'}
      <label class="field">
        <span>Pages to extract <span class="caption">(in this order)</span></span>
        <input class="input" bind:value={pagesText} placeholder="1, 3, 5-7" spellcheck="false" />
      </label>
    {:else if mode === 'rotate'}
      <div class="radios">
        <label class="check"><input type="radio" bind:group={rotateAll} value={true} /> All pages</label>
        <label class="check"><input type="radio" bind:group={rotateAll} value={false} /> Only pages</label>
        {#if !rotateAll}<input class="input pages" bind:value={pagesText} placeholder="1, 3, 5-7" spellcheck="false" aria-label="Pages to rotate" />{/if}
      </div>
      <div class="seg small">
        <button type="button" class:on={degrees === 90} onclick={() => (degrees = 90)}>90° right</button>
        <button type="button" class:on={degrees === 180} onclick={() => (degrees = 180)}>180°</button>
        <button type="button" class:on={degrees === 270} onclick={() => (degrees = 270)}>90° left</button>
      </div>
      <label class="check"><input type="checkbox" bind:checked={inPlace} /> Replace the original file</label>
    {:else if mode === 'reorder'}
      <label class="field">
        <span>New page order <span class="caption">(every page once; ranges allowed)</span></span>
        <input class="input" bind:value={orderText} placeholder={pageCount ? Array.from({ length: Math.min(pageCount, 6) }, (_, i) => Math.min(pageCount, 6) - i).join(', ') + (pageCount > 6 ? ', 7-' : '') : '3, 1, 2'} spellcheck="false" />
      </label>
    {/if}
  {/if}

  {#if !(mode === 'rotate' && inPlace)}
    <label class="field">
      <span>{mode === 'split' ? 'Save the parts in' : 'Save as'}</span>
      <div class="row">
        <input class="input" bind:value={outDir} oninput={() => (edited = true)} spellcheck="false" placeholder="Folder" />
        {#if mode !== 'split'}<input class="input name" bind:value={outName} oninput={() => (edited = true)} spellcheck="false" placeholder="File name" />{/if}
        <button type="button" class="btn" onclick={browse}><Icon name="folderOpen" /> Browse</button>
      </div>
      <span class="hint">{mode === 'split' ? 'The folder is created if needed. ' : ''}Existing files are never overwritten; a " (2)" copy is made instead.</span>
    </label>
  {/if}

  {#if problem && problem !== 'Reading the PDF…'}<div class="banner warn"><Icon name="warning" /> <span>{problem}</span></div>{/if}
  {#if runError}<div class="banner bad"><Icon name="error" /> <span>{runError}</span></div>{/if}

  {#snippet footer()}
    <button type="submit" class="btn primary" disabled={!!problem || busy}><Icon name={MODES.find((m) => m.id === mode)!.icon} /> {verb}</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    align-self: flex-start;
  }
  .seg button {
    display: flex;
    gap: 6px;
    align-items: center;
    height: 30px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
  }
  .seg.small button {
    height: 26px;
    padding: 0 12px;
  }
  .seg button.on {
    background: var(--card-solid);
    box-shadow: var(--shadow-card);
    color: var(--accent);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    max-height: 240px;
    overflow: auto;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 4px 0 10px;
    font-size: 13px;
    border-bottom: 1px solid var(--divider);
  }
  .item:last-child {
    border-bottom: 0;
  }
  .item.bad,
  .hint.bad {
    color: var(--bad);
  }
  .grow {
    flex: 1;
  }
  .empty {
    padding: 14px;
    text-align: center;
  }
  .radios {
    display: flex;
    gap: 16px;
    align-items: center;
    min-height: 32px;
  }
  .pages {
    flex: 1;
  }
  .name {
    max-width: 220px;
  }
  .banner {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 12px;
    border-radius: var(--r-md);
    font-size: 13px;
  }
  .banner.warn {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
  }
  .banner.bad {
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 10%, transparent);
  }
</style>
