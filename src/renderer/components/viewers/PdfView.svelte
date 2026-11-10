<script lang="ts">
  // Continuous PDF viewer: every page in one scrolling column, rendered only near the viewport.
  // "Fit" shows each page at the width of the panel, whatever its paper size; zoom is a factor
  // on that, and Ctrl+wheel zooms at the cursor. Pages too large for one canvas (A1 sheets
  // zoomed in) get a capped whole-page canvas plus a sharp canvas for just the visible part.
  import { onDestroy, onMount, tick } from 'svelte'
  import Icon from '../Icon.svelte'

  let { url, size = 0, onexpand }: { url: string; size?: number; onexpand?: () => void } = $props()

  const PX = 96 / 72 // CSS px per PDF point at 100 %
  const GAP = 10
  const PAD = 12
  const BASE_MAX = 5_000_000 // pixels in a whole-page canvas
  const DETAIL_MAX = 9_000_000
  const KMIN = 0.2
  const KMAX = 48

  interface Rt {
    el: HTMLDivElement | null
    base: HTMLCanvasElement | null
    baseScale: number
    detail: HTMLCanvasElement | null
    detailKey: string
    sized: boolean
  }
  interface Job {
    key: string
    page: number
    kind: 'base' | 'detail'
    /** canvas pixels per PDF point */
    scale: number
    region?: { x: number; y: number; w: number; h: number }
  }

  let scroller: HTMLDivElement | undefined = $state()
  let pages = $state<{ w: number; h: number }[]>([])
  let k = $state(1) // 1 = page width fits the panel
  let current = $state(1)
  let status = $state<'loading' | 'ready' | 'error'>('loading')
  let message = $state('')
  let viewW = $state(0)

  let doc: any = null
  let closeDoc: (() => void) | null = null
  let rt: Rt[] = []
  let alive = true
  let running: { job: Job; task: any } | null = null
  let queue: Job[] = []
  let settle: ReturnType<typeof setTimeout> | undefined
  let sizing = 0

  const fitW = $derived(Math.max(120, viewW - PAD * 2))
  const pageW = $derived(k * fitW)
  const boxW = $derived(Math.max(viewW, pageW + PAD * 2))
  const pct = $derived(pages.length ? Math.round((pageW / (pages[Math.min(pages.length, current) - 1].w * PX)) * 100) : 100)

  const heightOf = (i: number, w = pageW) => (w * pages[i].h) / pages[i].w
  const pageTop = (i: number, w = pageW) => {
    let y = PAD
    for (let j = 0; j < i; j++) y += heightOf(j, w) + GAP
    return y
  }
  /** Page under content position y, and how far down that page (0..1). */
  function locate(y: number, w = pageW) {
    let top = PAD
    for (let i = 0; i < pages.length; i++) {
      const h = heightOf(i, w)
      if (y < top + h + GAP || i === pages.length - 1) return { i, f: Math.max(0, Math.min(1, (y - top) / h)) }
      top += h + GAP
    }
    return { i: 0, f: 0 }
  }

  async function open() {
    try {
      const pdfjs = await import('../../lib/pdf')
      const r = await pdfjs.open(url, size)
      if (!alive) return r.close()
      doc = r.doc
      closeDoc = r.close
      const first = await doc.getPage(1)
      if (!alive) return
      const vp = first.getViewport({ scale: 1 })
      first.cleanup()
      const n: number = doc.numPages
      rt = Array.from({ length: n }, () => ({ el: null, base: null, baseScale: 0, detail: null, detailKey: '', sized: false }))
      rt[0].sized = true
      pages = Array.from({ length: n }, () => ({ w: vp.width, h: vp.height }))
      viewW = scroller?.clientWidth ?? 0
      status = 'ready'
      await tick()
      schedule(0)
      void measureAll()
    } catch (err: any) {
      if (!alive) return
      status = 'error'
      message = String(err?.message ?? err).replace(/^Error:\s*/, '')
    }
  }

  /**
   * Real page sizes, one at a time and only while nothing is waiting to be drawn, keeping the
   * reading position while the layout settles.
   */
  async function measureAll() {
    const my = ++sizing
    const idle = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await idle(400)
    for (let i = 1; i < pages.length; i++) {
      while (alive && my === sizing && (running || queue.length)) await idle(120)
      if (!alive || my !== sizing) return
      if (rt[i].sized) continue
      try {
        const pg = await doc.getPage(i + 1)
        const vp = pg.getViewport({ scale: 1 })
        pg.cleanup()
        setSize(i, vp.width, vp.height)
      } catch {
        return
      }
      await idle(i % 8 === 0 ? 30 : 0)
    }
  }

  function setSize(i: number, w: number, h: number) {
    rt[i].sized = true
    const p = pages[i]
    if (Math.abs(p.w - w) < 0.5 && Math.abs(p.h - h) < 0.5) return
    const at = scroller ? locate(scroller.scrollTop) : null
    const off = at && scroller ? scroller.scrollTop - (pageTop(at.i) + at.f * heightOf(at.i)) : 0
    pages[i] = { w, h }
    release(rt[i])
    if (at && scroller && i <= at.i) {
      const y = pageTop(at.i) + at.f * heightOf(at.i) + off
      void tick().then(() => scroller && (scroller.scrollTop = y))
    }
    schedule()
  }

  function drop(c: HTMLCanvasElement | null) {
    if (!c) return
    c.width = 0
    c.height = 0
    c.remove()
  }
  function release(r: Rt) {
    drop(r.base)
    drop(r.detail)
    r.base = null
    r.detail = null
    r.baseScale = 0
    r.detailKey = ''
  }

  function schedule(delay = 130) {
    clearTimeout(settle)
    settle = setTimeout(update, delay)
  }

  function update() {
    if (!alive || !scroller || !doc || !pages.length) return
    const top = scroller.scrollTop
    const vh = scroller.clientHeight
    const vw = scroller.clientWidth
    const left = scroller.scrollLeft
    const dpr = window.devicePixelRatio || 1
    const a = locate(top - vh * 0.5).i
    const b = locate(top + vh * 1.5).i
    current = locate(top + vh / 2).i + 1
    const jobs: Job[] = []
    const mid = top + vh / 2
    const pw = pageW
    const px0 = (boxW - pw) / 2
    for (let i = 0; i < pages.length; i++) {
      const r = rt[i]
      if (i < a - 2 || i > b + 2) {
        release(r)
        continue
      }
      if (i < a || i > b) continue
      const p = pages[i]
      const full = (pw / p.w) * dpr
      const whole = p.w * p.h * full * full
      const baseScale = whole > BASE_MAX ? Math.sqrt(BASE_MAX / (p.w * p.h)) : full
      if (Math.abs(r.baseScale - baseScale) > baseScale * 0.01) jobs.push({ key: `b${i}@${baseScale.toFixed(4)}`, page: i, kind: 'base', scale: baseScale })
      if (whole > BASE_MAX) {
        // Visible part of this page in page CSS px, with a margin so small scrolls stay sharp.
        const ph = heightOf(i)
        const py0 = pageTop(i)
        let m = 0.25
        let x0 = 0, y0 = 0, x1 = 0, y1 = 0
        for (;;) {
          x0 = Math.max(0, Math.floor(left - px0 - vw * m))
          y0 = Math.max(0, Math.floor(top - py0 - vh * m))
          x1 = Math.min(pw, Math.ceil(left - px0 + vw * (1 + m)))
          y1 = Math.min(ph, Math.ceil(top - py0 + vh * (1 + m)))
          if ((x1 - x0) * (y1 - y0) * dpr * dpr <= DETAIL_MAX || m === 0) break
          m = 0
        }
        if (x1 - x0 > 4 && y1 - y0 > 4) {
          const prefix = `d${i}@${pw.toFixed(2)}|`
          const cur = r.detailKey.split('|')
          // Keep the current sharp canvas while the view is still inside it.
          const inside =
            r.detailKey.startsWith(prefix) && +cur[1] <= Math.max(0, left - px0) && +cur[2] <= Math.max(0, top - py0) && +cur[3] >= Math.min(pw, left - px0 + vw) && +cur[4] >= Math.min(ph, top - py0 + vh)
          if (!inside) jobs.push({ key: `${prefix}${x0}|${y0}|${x1}|${y1}`, page: i, kind: 'detail', scale: full, region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } })
        }
      } else if (r.detail) {
        drop(r.detail)
        r.detail = null
        r.detailKey = ''
      }
    }
    const dist = (j: Job) => Math.abs(pageTop(j.page) + heightOf(j.page) / 2 - mid) + (j.kind === 'detail' ? 1e7 : 0)
    jobs.sort((x, y) => dist(x) - dist(y))
    // A job that is already being drawn stays out of the queue (it would only be drawn twice);
    // one that is no longer wanted is cancelled.
    const busy = running?.job.key
    queue = jobs.filter((j) => j.key !== busy)
    if (running && queue.length === jobs.length) running.task?.cancel()
    void pump()
  }

  async function pump() {
    if (running || !alive) return
    const job = queue.shift()
    if (!job) return
    const r = rt[job.page]
    const state: { job: Job; task: any } = { job, task: null }
    running = state
    let canvas: HTMLCanvasElement | null = null
    try {
      const pg = await doc.getPage(job.page + 1)
      if (!alive) return
      if (!r.sized) {
        const v1 = pg.getViewport({ scale: 1 })
        setSize(job.page, v1.width, v1.height)
      }
      const vp = pg.getViewport({ scale: job.scale })
      const dpr = window.devicePixelRatio || 1
      canvas = document.createElement('canvas')
      const reg = job.region
      canvas.width = Math.max(1, Math.round(reg ? reg.w * dpr : vp.width))
      canvas.height = Math.max(1, Math.round(reg ? reg.h * dpr : vp.height))
      // pdf.js reads pixels back while compositing scanned pages; a software canvas keeps that fast.
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
      state.task = pg.render({ canvasContext: ctx, viewport: vp, canvas, transform: reg ? [1, 0, 0, 1, -reg.x * dpr, -reg.y * dpr] : undefined })
      await state.task.promise
      pg.cleanup()
      if (!alive || !r.el) throw new Error('gone')
      if (job.kind === 'base') {
        canvas.className = 'pdf-base'
        drop(r.base)
        r.el.prepend(canvas)
        r.base = canvas
        r.baseScale = job.scale
      } else {
        // Placed in fractions of the page, so it stays in register while a zoom is pending.
        const pw = Number(job.key.slice(job.key.indexOf('@') + 1).split('|')[0])
        const ph = (pw * pages[job.page].h) / pages[job.page].w
        canvas.className = 'pdf-detail'
        canvas.style.left = `${(reg!.x / pw) * 100}%`
        canvas.style.top = `${(reg!.y / ph) * 100}%`
        canvas.style.width = `${(reg!.w / pw) * 100}%`
        canvas.style.height = `${(reg!.h / ph) * 100}%`
        drop(r.detail)
        r.el.append(canvas)
        r.detail = canvas
        r.detailKey = job.key
      }
      canvas = null
    } catch {
      /* cancelled or page gone */
    } finally {
      if (canvas) canvas.width = 0
      if (running === state) running = null
      if (alive) void pump()
    }
  }

  /** Zoom keeping the point under (cx, cy) (client coordinates) where it is. */
  async function zoomTo(next: number, cx?: number, cy?: number) {
    if (!scroller || !pages.length) return
    next = Math.max(KMIN, Math.min(KMAX, next))
    if (Math.abs(next - 1) < 0.02) next = 1
    const rect = scroller.getBoundingClientRect()
    const ax = (cx ?? rect.left + rect.width / 2) - rect.left
    const ay = (cy ?? rect.top + rect.height / 2) - rect.top
    const at = locate(scroller.scrollTop + ay)
    const fx = (scroller.scrollLeft + ax - (boxW - pageW) / 2) / pageW
    k = next
    await tick()
    if (!scroller) return
    const w = next * fitW
    scroller.scrollTop = pageTop(at.i, w) + at.f * heightOf(at.i, w) - ay
    scroller.scrollLeft = (Math.max(viewW, w + PAD * 2) - w) / 2 + fx * w - ax
    schedule()
  }

  const step = (f: number) => void zoomTo(k * f)

  function wheel(e: WheelEvent) {
    if (!e.ctrlKey) return
    e.preventDefault()
    void zoomTo(k * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
  }

  function drag(e: PointerEvent) {
    if (e.button !== 0 || !scroller) return
    // Presses on the scrollbars belong to the scrollbars.
    const rect = scroller.getBoundingClientRect()
    if (e.clientX - rect.left > scroller.clientWidth || e.clientY - rect.top > scroller.clientHeight) return
    const el = scroller
    const sx = e.clientX + el.scrollLeft
    const sy = e.clientY + el.scrollTop
    el.setPointerCapture(e.pointerId)
    el.classList.add('dragging')
    const move = (ev: PointerEvent) => {
      el.scrollLeft = sx - ev.clientX
      el.scrollTop = sy - ev.clientY
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

  function goPage(n: number) {
    if (!scroller) return
    const i = Math.max(0, Math.min(pages.length - 1, n - 1))
    scroller.scrollTop = pageTop(i) - PAD / 2
  }

  function key(e: KeyboardEvent) {
    if (status !== 'ready' || !scroller) return
    switch (e.key) {
      case 'PageDown': goPage(locate(scroller.scrollTop + PAD).i + 2); break
      case 'PageUp': {
        const t = locate(scroller.scrollTop + PAD).i
        goPage(scroller.scrollTop > pageTop(t) + 2 ? t + 1 : t)
        break
      }
      case 'Home': goPage(1); break
      case 'End': goPage(pages.length); break
      case '+': case '=': step(1.25); break
      case '-': step(1 / 1.25); break
      case '0': void zoomTo(1); break
      case 'ArrowDown': scroller.scrollTop += 60; break
      case 'ArrowUp': scroller.scrollTop -= 60; break
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  function reg(el: HTMLDivElement, i: number) {
    if (rt[i]) rt[i].el = el
    return {
      destroy() {
        if (rt[i]?.el === el) {
          release(rt[i])
          rt[i].el = null
        }
      }
    }
  }

  onMount(() => {
    void open()
    const ro = new ResizeObserver(() => {
      if (!scroller) return
      const w = scroller.clientWidth
      if (w === viewW) return schedule()
      // Pages follow the panel width; stay on the same spot of the same page.
      const at = pages.length ? locate(scroller.scrollTop) : null
      viewW = w
      if (at) void tick().then(() => scroller && (scroller.scrollTop = pageTop(at.i) + at.f * heightOf(at.i)))
      schedule()
    })
    if (scroller) ro.observe(scroller)
    return () => ro.disconnect()
  })

  onDestroy(() => {
    alive = false
    sizing++
    clearTimeout(settle)
    running?.task?.cancel()
    for (const r of rt) release(r)
    closeDoc?.()
    doc = null
  })
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="pdfv" tabindex="0" onkeydown={key} role="document" aria-label="PDF pages">
  <div class="bar">
    {#if status === 'ready'}
      <span class="caption pg">Page {current} of {pages.length}</span>
      <span class="spacer"></span>
      <button class="btn subtle icon sm" title="Zoom out (Ctrl+wheel, -)" onclick={() => step(1 / 1.25)}><Icon name="zoomOut" /></button>
      <span class="caption pct" title="Zoom of the current page">{pct}%</span>
      <button class="btn subtle icon sm" title="Zoom in (Ctrl+wheel, +)" onclick={() => step(1.25)}><Icon name="zoomIn" /></button>
      <button class="btn subtle sm" class:on={k === 1} title="Fit width (0)" onclick={() => zoomTo(1)}>Fit</button>
      {#if onexpand}<button class="btn subtle icon sm" title="View in full window" onclick={onexpand}><Icon name="fullscreen" /></button>{/if}
    {:else if status === 'loading'}
      <span class="caption">Opening…</span>
    {/if}
  </div>
  {#if status === 'error'}
    <div class="caption err">{message || 'This PDF could not be opened.'}</div>
  {/if}
  <div class="scroll" bind:this={scroller} onscroll={() => schedule(90)} onwheel={wheel} onpointerdown={drag} ondblclick={() => onexpand?.()} role="presentation">
    <div class="pages" style:width={`${boxW}px`} style:padding={`${PAD}px 0`} style:gap={`${GAP}px`}>
      {#each pages as p, i (i)}
        <div class="page" use:reg={i} style:width={`${pageW}px`} style:height={`${(pageW * p.h) / p.w}px`}></div>
      {/each}
    </div>
  </div>
</div>

<style>
  .pdfv {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    outline: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 30px;
    padding: 0 2px 4px;
    flex: none;
  }
  .pct {
    min-width: 40px;
    text-align: center;
  }
  .on {
    background: var(--sel) !important;
  }
  .err {
    padding: 16px;
    text-align: center;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-radius: var(--r-md);
    background: var(--stroke-2);
    border: 1px solid var(--stroke);
    cursor: grab;
  }
  .scroll:global(.dragging) {
    cursor: grabbing;
  }
  .pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    box-sizing: border-box;
  }
  .page {
    position: relative;
    flex: none;
    background: white;
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  /* Scanned sheets can take seconds to draw; say so instead of showing a blank page. */
  .page:empty::after {
    content: 'Drawing page…';
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 12px;
    color: rgba(0, 0, 0, 0.45);
  }
  .page :global(.pdf-base) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .page :global(.pdf-detail) {
    position: absolute;
    display: block;
  }
</style>
