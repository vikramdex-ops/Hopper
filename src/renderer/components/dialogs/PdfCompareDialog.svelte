<script lang="ts">
  // Visual PDF compare: both pages rendered with pdf.js at the same scale, aligned at the top-left,
  // and diffed pixel by pixel in a worker (shared/pixeldiff.ts). Ink only in the older file is red,
  // only in the newer green, in both dark grey. It shows where the pages differ; it does not say
  // what a difference means. Views: overlay, side by side, swipe; zoom and pan are shared.
  import { onDestroy, onMount, tick, untrack } from 'svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine } from '../../lib/api'
  import { basename, plural } from '../../lib/format'
  import { compareScale, pixelDiff, type ChangeBox, type DiffResult } from '@shared/pixeldiff'
  import DiffWorker from '../../lib/pdfdiff.worker?worker'

  let { older, newer, labels, close }: { older: string; newer: string; labels?: [string, string]; close: (v?: unknown) => void } = $props()

  const DPIS = [72, 100, 150, 200]
  const MM = 25.4 / 72

  // the viewer's own copy: Swap changes it
  let paths = $state<[string, string]>(untrack(() => [older, newer]))
  let names = $state<[string, string]>(untrack(() => labels ?? ['Older', 'Newer']))
  let docs: [any, any] = [null, null]
  let closers: (() => void)[] = []
  let counts = $state<[number, number]>([0, 0])
  const pages = $derived(Math.max(counts[0], counts[1]))
  let page = $state(1)
  let dpi = $state(100)
  let view = $state<'overlay' | 'side' | 'swipe'>('overlay')
  let showBoxes = $state(true)
  let heat = $state(false)
  let swipe = $state(50)

  let status = $state<'opening' | 'rendering' | 'diffing' | 'ready' | 'error'>('opening')
  let message = $state('')
  let notes = $state<string[]>([])
  let size = $state({ W: 0, H: 0, dpi: 0 })
  let boxes = $state.raw<ChangeBox[]>([])
  let stats = $state({ onlyOld: 0, onlyNew: 0 })
  let at = $state(-1)

  let canvasA = $state.raw<HTMLCanvasElement | null>(null)
  let canvasB = $state.raw<HTMLCanvasElement | null>(null)
  let canvasOut = $state.raw<HTMLCanvasElement | null>(null)
  let canvasHeat = $state.raw<HTMLCanvasElement | null>(null)
  let gen = 0
  let ver = $state(0) // bumps when new canvases are ready
  let worker: Worker | null = null
  let jobSeq = 0

  // shared zoom and pan: content px -> screen px = z, offset (x, y)
  let stage: HTMLDivElement | undefined = $state()
  let z = $state(1)
  let x = $state(0)
  let y = $state(0)
  let fitZ = 1

  const swapLabel = $derived(`${names[0]}: ${basename(paths[0])}  →  ${names[1]}: ${basename(paths[1])}`)

  const fileUrl = (p: string) => `hopper://file/?p=${encodeURIComponent(p)}`

  async function openDocs() {
    status = 'opening'
    try {
      const pdfjs = await import('../../lib/pdf')
      const opened = await Promise.all(
        paths.map(async (p) => {
          const st = await engine.call<{ exists: boolean; size?: number }>('fs.stat', p).catch(() => ({ exists: false }) as { exists: boolean; size?: number })
          if (!st.exists) throw new Error(`Not found: ${p}`)
          return pdfjs.open(fileUrl(p), st.size ?? 0)
        })
      )
      for (const c of closers) c()
      closers = opened.map((o) => o.close)
      docs = [opened[0].doc, opened[1].doc]
      counts = [docs[0].numPages, docs[1].numPages]
      page = Math.min(page, Math.max(counts[0], counts[1]))
      await render()
    } catch (e: any) {
      status = 'error'
      message = String(e?.message ?? e).replace(/^Error:\s*/, '')
    }
  }

  const mm = (pt: number) => Math.round(pt * MM)

  async function render() {
    const my = ++gen
    status = 'rendering'
    message = ''
    try {
      const pgs = await Promise.all(docs.map((d) => (d && page <= d.numPages ? d.getPage(page) : null)))
      if (my !== gen) return
      const v1 = pgs.map((p) => (p ? p.getViewport({ scale: 1 }) : null))
      const dims = v1.filter(Boolean).map((v: any) => ({ w: v.width, h: v.height }))
      const s = compareScale(dims, dpi)
      const n: string[] = []
      if (!pgs[0]) n.push(`Page ${page} is only in the ${names[1].toLowerCase() === 'newer' ? 'newer' : names[1]} file.`)
      if (!pgs[1]) n.push(`Page ${page} is only in the ${names[0].toLowerCase() === 'older' ? 'older' : names[0]} file.`)
      if (v1[0] && v1[1] && (Math.abs(v1[0].width - v1[1].width) > 1 || Math.abs(v1[0].height - v1[1].height) > 1)) {
        n.push(`Page sizes differ: ${mm(v1[0].width)} × ${mm(v1[0].height)} mm and ${mm(v1[1].width)} × ${mm(v1[1].height)} mm. Both are aligned at the top-left corner.`)
      }
      const rot = pgs.map((p) => (p ? ((p.rotate ?? 0) % 360 + 360) % 360 : 0))
      if (pgs[0] && pgs[1] && rot[0] !== rot[1]) n.push(`The pages are rotated differently (${rot[0]}° and ${rot[1]}°); both are shown as they print.`)
      const usedDpi = Math.round(s * 72)
      if (usedDpi < dpi) n.push(`Rendered at ${usedDpi} dpi to keep this large sheet within 8,000 pixels.`)

      const draw = async (pg: any, other: any) => {
        const vp = (pg ?? other).getViewport({ scale: s })
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(vp.width))
        c.height = Math.max(1, Math.round(vp.height))
        const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true })!
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, c.width, c.height)
        // a page missing on one side is blank paper of the other side's size
        if (pg) await pg.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise
        return c
      }
      const a = await draw(pgs[0], pgs[1])
      if (my !== gen) return drop(a)
      const b = await draw(pgs[1], pgs[0])
      for (const p of pgs) p?.cleanup()
      if (my !== gen) return void (drop(a), drop(b))
      status = 'diffing'
      await tick()
      const da = a.getContext('2d')!.getImageData(0, 0, a.width, a.height)
      const db = b.getContext('2d')!.getImageData(0, 0, b.width, b.height)
      const r = await diff(da, db)
      if (my !== gen) return void (drop(a), drop(b))
      const out = document.createElement('canvas')
      out.width = r.width
      out.height = r.height
      out.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.out.buffer as ArrayBuffer, r.out.byteOffset, r.out.length), r.width, r.height), 0, 0)
      for (const c of [canvasA, canvasB, canvasOut, canvasHeat]) drop(c)
      canvasA = a
      canvasB = b
      canvasOut = out
      canvasHeat = heatmap(r)
      size = { W: r.width, H: r.height, dpi: usedDpi }
      boxes = r.boxes
      stats = { onlyOld: r.onlyOld, onlyNew: r.onlyNew }
      notes = n
      at = -1
      status = 'ready'
      ver++
      await tick()
      fit()
    } catch (e: any) {
      if (my !== gen) return
      status = 'error'
      message = String(e?.message ?? e).replace(/^Error:\s*/, '')
    }
  }

  function diff(a: ImageData, b: ImageData): Promise<DiffResult> {
    try {
      worker ??= new DiffWorker()
    } catch {
      worker = null
    }
    if (!worker) return Promise.resolve(pixelDiff(a.data, a.width, a.height, b.data, b.width, b.height))
    const w = worker
    const id = ++jobSeq
    return new Promise((resolve, reject) => {
      const done = (e: MessageEvent) => {
        if (e.data?.id !== id) return
        w.removeEventListener('message', done)
        w.removeEventListener('error', fail)
        if (e.data.ok) resolve(e.data.r)
        else reject(new Error(e.data.error))
      }
      const fail = (e: ErrorEvent) => {
        w.removeEventListener('message', done)
        w.removeEventListener('error', fail)
        reject(new Error(e.message || 'The compare worker stopped'))
      }
      w.addEventListener('message', done)
      w.addEventListener('error', fail)
      w.postMessage({ id, a: a.data.buffer, aw: a.width, ah: a.height, b: b.data.buffer, bw: b.width, bh: b.height }, [a.data.buffer, b.data.buffer])
    })
  }

  /** Changed pixels per grid square as a translucent orange layer (one canvas pixel per square). */
  function heatmap(r: DiffResult) {
    const c = document.createElement('canvas')
    c.width = r.cols
    c.height = r.rows
    const img = c.getContext('2d')!.createImageData(r.cols, r.rows)
    const full = r.cell * r.cell
    for (let i = 0; i < r.cells.length; i++) {
      const v = r.cells[i]
      if (!v) continue
      img.data[i * 4] = 255
      img.data[i * 4 + 1] = 120
      img.data[i * 4 + 2] = 0
      img.data[i * 4 + 3] = Math.round(60 + 160 * Math.min(1, (v / full) * 6))
    }
    c.getContext('2d')!.putImageData(img, 0, 0)
    return c
  }

  function drop(c: HTMLCanvasElement | null) {
    if (!c) return
    c.width = 0
    c.height = 0
    c.remove()
  }

  // ---- zoom and pan ---------------------------------------------------------

  function fit() {
    if (!stage || !size.W) return
    const w = view === 'side' ? (stage.clientWidth - 12) / 2 : stage.clientWidth
    const h = stage.clientHeight
    fitZ = Math.min((w - 16) / size.W, (h - 16) / size.H)
    z = fitZ
    x = (w - size.W * z) / 2
    y = (h - size.H * z) / 2
  }

  function zoomAt(f: number, cx?: number, cy?: number) {
    if (!stage) return
    const r = stage.getBoundingClientRect()
    const panel = view === 'side' ? (stage.clientWidth - 12) / 2 : stage.clientWidth
    let px = (cx ?? r.left + panel / 2) - r.left
    if (view === 'side' && px > panel) px -= panel + 12
    const py = (cy ?? r.top + r.height / 2) - r.top
    const nz = Math.max(fitZ / 4, Math.min(8, z * f))
    x = px - ((px - x) * nz) / z
    y = py - ((py - y) * nz) / z
    z = nz
  }

  function wheel(e: WheelEvent) {
    e.preventDefault()
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
  }

  function drag(e: PointerEvent) {
    if (e.button !== 0 || !stage || (e.target as HTMLElement).closest('.swipeh')) return
    const el = stage
    const sx = e.clientX - x
    const sy = e.clientY - y
    el.setPointerCapture(e.pointerId)
    el.classList.add('dragging')
    const move = (ev: PointerEvent) => {
      x = ev.clientX - sx
      y = ev.clientY - sy
    }
    const up = () => {
      el.classList.remove('dragging')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  /** Centre change `i` and zoom so it fills about half of the view. */
  function goChange(i: number) {
    if (!boxes.length || !stage) return
    at = (i + boxes.length) % boxes.length
    const b = boxes[at]
    const w = view === 'side' ? (stage.clientWidth - 12) / 2 : stage.clientWidth
    const h = stage.clientHeight
    z = Math.max(fitZ, Math.min(4, Math.min((w * 0.5) / Math.max(b.w, 8), (h * 0.5) / Math.max(b.h, 8))))
    x = w / 2 - (b.x + b.w / 2) * z
    y = h / 2 - (b.y + b.h / 2) * z
  }

  function setPage(n: number) {
    const p = Math.max(1, Math.min(pages, n))
    if (p === page) return
    page = p
    void render()
  }

  function swap() {
    paths = [paths[1], paths[0]]
    names = [names[1], names[0]]
    counts = [counts[1], counts[0]]
    docs = [docs[1], docs[0]]
    void render()
  }

  function key(e: KeyboardEvent) {
    const t = e.target as HTMLElement
    if (t?.tagName === 'SELECT' || t?.tagName === 'INPUT') {
      if (e.key === 'Escape') close()
      return
    }
    switch (e.key) {
      case 'Escape': close(); break
      case 'n': case 'N': case 'F8': goChange(at + 1); break
      case 'p': case 'P': goChange(at - 1); break
      case 'PageDown': setPage(page + 1); break
      case 'PageUp': setPage(page - 1); break
      case '+': case '=': zoomAt(1.25); break
      case '-': zoomAt(1 / 1.25); break
      case '0': fit(); break
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  /** Put an imperatively drawn canvas into a holder element. */
  function hold(node: HTMLElement, c: HTMLCanvasElement | null) {
    const put = (x: HTMLCanvasElement | null) => node.replaceChildren(...(x ? [x] : []))
    put(c)
    return { update: put }
  }

  let root: HTMLDivElement | undefined = $state()
  onMount(() => {
    root?.focus()
    void openDocs()
    const ro = new ResizeObserver(() => fit())
    if (stage) ro.observe(stage)
    return () => ro.disconnect()
  })
  onDestroy(() => {
    gen++
    for (const c of [canvasA, canvasB, canvasOut, canvasHeat]) drop(c)
    worker?.terminate()
    for (const c of closers) c()
    docs = [null, null]
  })

  $effect(() => {
    void view
    void tick().then(fit)
  })

  const changeText = $derived(status !== 'ready' ? '' : boxes.length ? `${plural(boxes.length, 'changed area')}` : 'No differences found')
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="scrim">
  <div class="cmpv" bind:this={root} tabindex="0" role="dialog" aria-modal="true" aria-label="Compare PDFs" onkeydown={key}
    data-state={status} data-changes={status === 'ready' ? boxes.length : ''}>
    <header>
      <span class="hi"><Icon name="compare" size={20} /></span>
      <div class="files">
        <span class="f old" title={paths[0]}><span class="sw"></span>{names[0]} · {basename(paths[0])}</span>
        <span class="f new" title={paths[1]}><span class="sw"></span>{names[1]} · {basename(paths[1])}</span>
      </div>
      <button type="button" class="btn subtle sm" title={`Swap: ${swapLabel}`} onclick={swap}>Swap</button>
      <button type="button" class="btn subtle icon sm" aria-label="Close" onclick={() => close()}><Icon name="close" /></button>
    </header>

    <div class="bar">
      <div class="seg" role="radiogroup" aria-label="View">
        <button type="button" class="btn sm" class:on={view === 'overlay'} onclick={() => (view = 'overlay')}>Overlay</button>
        <button type="button" class="btn sm" class:on={view === 'side'} onclick={() => (view = 'side')}>Side by side</button>
        <button type="button" class="btn sm" class:on={view === 'swipe'} onclick={() => (view = 'swipe')}>Swipe</button>
      </div>
      <label class="check sm"><input type="checkbox" bind:checked={showBoxes} /> Boxes</label>
      <label class="check sm"><input type="checkbox" bind:checked={heat} /> Heatmap</label>
      <span class="sep"></span>
      <button type="button" class="btn subtle icon sm" title="Previous change (P)" disabled={!boxes.length} onclick={() => goChange(at - 1)}><Icon name="chevronUp" /></button>
      <span class="caption count">{changeText}{boxes.length && at >= 0 ? ` · ${at + 1} of ${boxes.length}` : ''}</span>
      <button type="button" class="btn subtle icon sm" title="Next change (N)" disabled={!boxes.length} onclick={() => goChange(at + 1)}><Icon name="chevronDown" /></button>
      <span class="grow"></span>
      {#if pages > 1}
        <button type="button" class="btn subtle icon sm" title="Previous page (PgUp)" disabled={page <= 1} onclick={() => setPage(page - 1)}><Icon name="chevronLeft" /></button>
        <select class="input sm" value={page} onchange={(e) => setPage(Number((e.target as HTMLSelectElement).value))} aria-label="Page">
          {#each Array.from({ length: pages }, (_, i) => i + 1) as n (n)}<option value={n}>Page {n} of {pages}</option>{/each}
        </select>
        <button type="button" class="btn subtle icon sm" title="Next page (PgDn)" disabled={page >= pages} onclick={() => setPage(page + 1)}><Icon name="chevronRight" /></button>
      {/if}
      <select class="input sm" bind:value={dpi} onchange={() => void render()} aria-label="Detail" title="Render resolution">
        {#each DPIS as d (d)}<option value={d}>{d} dpi</option>{/each}
      </select>
      <button type="button" class="btn subtle icon sm" title="Zoom out (-)" onclick={() => zoomAt(1 / 1.25)}><Icon name="zoomOut" /></button>
      <span class="caption pct">{Math.round((z / (size.dpi ? size.dpi / 96 : 1)) * 100)}%</span>
      <button type="button" class="btn subtle icon sm" title="Zoom in (+)" onclick={() => zoomAt(1.25)}><Icon name="zoomIn" /></button>
      <button type="button" class="btn subtle sm" title="Fit (0)" onclick={fit}>Fit</button>
    </div>

    <div class="stage {view}" bind:this={stage} onwheel={wheel} onpointerdown={drag} role="presentation">
      {#if status === 'error'}
        <div class="msg">{message || "These PDFs couldn't be compared."}</div>
      {:else if status !== 'ready'}
        <div class="msg">{status === 'opening' ? 'Opening…' : status === 'rendering' ? `Drawing page ${page}…` : 'Comparing…'}</div>
      {/if}
      {#key ver}
        {#if view === 'side'}
          {#each [canvasA, canvasB] as c, i (i)}
            <div class="panel">
              <div class="content" style:transform={`translate(${x}px, ${y}px) scale(${z})`} style:width={`${size.W}px`} style:height={`${size.H}px`}>
                <div class="layer" use:hold={c}></div>
                {#if showBoxes}{@render boxLayer()}{/if}
              </div>
              <span class="tag {i ? 'new' : 'old'}">{names[i]}</span>
            </div>
          {/each}
        {:else}
          <div class="panel">
            <div class="content" style:transform={`translate(${x}px, ${y}px) scale(${z})`} style:width={`${size.W}px`} style:height={`${size.H}px`}>
              {#if view === 'overlay'}
                <div class="layer" use:hold={canvasOut}></div>
              {:else}
                <div class="layer" use:hold={canvasA}></div>
                <div class="layer" style:clip-path={`inset(0 0 0 ${swipe}%)`} use:hold={canvasB}></div>
                <div class="swipel" style:left={`${swipe}%`}></div>
              {/if}
              {#if heat}<div class="layer heat" use:hold={canvasHeat}></div>{/if}
              {#if showBoxes}{@render boxLayer()}{/if}
            </div>
          </div>
        {/if}
      {/key}
    </div>

    <footer>
      {#if view === 'swipe'}
        <label class="swipeh"><span class="caption">{names[0]}</span><input type="range" min="0" max="100" step="0.5" bind:value={swipe} aria-label="Swipe" /><span class="caption">{names[1]}</span></label>
      {:else}
        <span class="legend"><span class="sw old"></span>Only in {names[0].toLowerCase() === 'older' ? 'the older file' : names[0]}</span>
        <span class="legend"><span class="sw new"></span>Only in {names[1].toLowerCase() === 'newer' ? 'the newer file' : names[1]}</span>
        <span class="legend"><span class="sw both"></span>In both</span>
      {/if}
      <span class="caption notes">
        {#each notes as n (n)}<span>{n}</span>{/each}
        {#if status === 'ready'}<span>Compared at {size.dpi} dpi, {size.W.toLocaleString()} × {size.H.toLocaleString()} px. Shows where the ink differs; it does not judge the changes.</span>{/if}
      </span>
    </footer>
  </div>
</div>

{#snippet boxLayer()}
  <svg class="boxes" viewBox={`0 0 ${size.W} ${size.H}`} width={size.W} height={size.H} aria-hidden="true">
    {#each boxes as b, i (i)}
      <rect x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} class:cur={i === at} vector-effect="non-scaling-stroke" />
    {/each}
  </svg>
{/snippet}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: var(--scrim);
    display: grid;
    place-items: center;
  }
  .cmpv {
    width: calc(100vw - 32px);
    height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    border-radius: var(--r-xl);
    background: var(--card-solid);
    border: 1px solid var(--stroke-2);
    box-shadow: var(--shadow-dialog);
    overflow: hidden;
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 12px 6px 20px;
  }
  .hi {
    color: var(--accent);
    display: flex;
  }
  .files {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 16px;
    font-size: 13px;
  }
  .f {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sw {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    display: inline-block;
  }
  .old .sw,
  .sw.old {
    background: rgb(220, 38, 38);
  }
  .new .sw,
  .sw.new {
    background: rgb(22, 150, 70);
  }
  .sw.both {
    background: rgb(40, 40, 40);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px 8px 20px;
    flex-wrap: wrap;
  }
  .seg {
    display: flex;
    gap: 2px;
    margin-right: 8px;
  }
  .on {
    background: var(--sel) !important;
    border-color: var(--accent) !important;
  }
  .check.sm {
    font-size: 12px;
    margin: 0 6px;
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--divider);
    margin: 0 6px;
  }
  .grow {
    flex: 1;
  }
  .count {
    min-width: 150px;
    text-align: center;
  }
  .pct {
    min-width: 44px;
    text-align: center;
  }
  .input.sm {
    height: 28px;
    padding: 0 6px;
    font-size: 12px;
    width: auto;
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    margin: 0 12px;
    display: flex;
    gap: 12px;
    overflow: hidden;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: var(--stroke-2);
    cursor: grab;
    touch-action: none;
  }
  .stage:global(.dragging) {
    cursor: grabbing;
  }
  .panel {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .side .panel + .panel {
    border-left: 1px solid var(--stroke);
  }
  .content {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
    background: white;
    box-shadow: var(--shadow-card);
  }
  .layer {
    position: absolute;
    inset: 0;
  }
  .layer :global(canvas) {
    display: block;
    position: absolute;
    left: 0;
    top: 0;
  }
  .heat :global(canvas) {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }
  .swipel {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 2px solid var(--accent);
    pointer-events: none;
  }
  .boxes {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
  }
  .boxes rect {
    fill: none;
    stroke: #f08c00;
    stroke-width: 2;
  }
  .boxes rect.cur {
    stroke: var(--accent);
    stroke-width: 3;
  }
  .tag {
    position: absolute;
    left: 8px;
    top: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    color: white;
  }
  .tag.old {
    background: rgb(220, 38, 38);
  }
  .tag.new {
    background: rgb(22, 150, 70);
  }
  .msg {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-2);
    font-size: 13px;
    z-index: 2;
    pointer-events: none;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 8px 20px 12px;
    min-height: 40px;
  }
  .legend {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    white-space: nowrap;
  }
  .notes {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    text-align: right;
  }
  .swipeh {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 420px;
  }
  .swipeh input {
    flex: 1;
  }
</style>
