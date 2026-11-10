<script lang="ts">
  // Canvas viewer for a MicroStation V7 display list (see engine/preview/dgn7.ts).
  // Wheel zooms at the cursor (as in CAD), drag pans. Geometry is batched into one path per
  // level / colour / weight / style, so a redraw is a few hundred strokes whatever the file size.
  import { onDestroy } from 'svelte'
  import type { DgnDrawing } from '../../../engine/preview/types'
  import Icon from '../Icon.svelte'

  let { drawing, onexpand }: { drawing: DgnDrawing; onexpand?: () => void } = $props()

  interface Batch {
    level: number
    color: number
    weight: number
    style: number
    path: Path2D
  }

  let wrap: HTMLDivElement | undefined = $state()
  let canvas: HTMLCanvasElement | undefined = $state()
  let dark = $state(true)
  let hidden = $state<number[]>([])
  let showLevels = $state(false)
  let showNotes = $state(false)
  let pct = $state(100)

  let view = { s: 1, tx: 0, ty: 0 }
  let fitS = 1
  let size = { w: 0, h: 0 }
  let strokes: Batch[] = []
  let fills: Batch[] = []
  let bitmaps: (ImageBitmap | null)[] = []
  let raf = 0
  let lastMs = 0
  let snap: { c: HTMLCanvasElement; s: number; tx: number; ty: number } | null = null
  let settle: ReturnType<typeof setTimeout> | undefined
  let fitted = true
  let alive = true

  const MONO = '100px Consolas, "Cascadia Mono", "Courier New", monospace'
  const PROP = '100px Arial, "Segoe UI", sans-serif'
  let propWidth = new Float32Array(0)
  const DASH: number[][] = [[], [1, 4], [6, 4], [12, 5], [10, 4, 2, 4], [3, 3], [10, 3, 2, 3, 2, 3], [12, 4, 5, 4]]

  function build(d: DgnDrawing) {
    const sm = new Map<number, Path2D>()
    const fm = new Map<number, Path2D>()
    const pathOf = (m: Map<number, Path2D>, key: number) => {
      let p = m.get(key)
      if (!p) m.set(key, (p = new Path2D()))
      return p
    }
    const { lines, lineStart, lineAttr, arcs, arcAttr } = d
    for (let i = 0, n = lineAttr.length / 5; i < n; i++) {
      const a = i * 5
      const flags = lineAttr[a + 3]
      const add = (p: Path2D) => {
        const s = lineStart[i], e = lineStart[i + 1]
        p.moveTo(lines[s * 2], lines[s * 2 + 1])
        for (let v = s + 1; v < e; v++) p.lineTo(lines[v * 2], lines[v * 2 + 1])
        if (flags & 0x10) p.closePath()
      }
      add(pathOf(sm, lineAttr[a] * 16777216 + (lineAttr[a + 1] << 16) + (lineAttr[a + 2] << 8) + (flags & 7)))
      if (flags & 0x20) add(pathOf(fm, lineAttr[a] * 16777216 + (lineAttr[a + 4] << 16)))
    }
    for (let i = 0, n = arcAttr.length / 5; i < n; i++) {
      const a = i * 5
      const o = i * 8
      const flags = arcAttr[a + 3]
      const add = (p: Path2D) => {
        const cx = arcs[o], cy = arcs[o + 1], ux = arcs[o + 2], uy = arcs[o + 3], vx = arcs[o + 4], vy = arcs[o + 5]
        const a0 = arcs[o + 6], sw = arcs[o + 7]
        const ru = Math.hypot(ux, uy), rv = Math.hypot(vx, vy)
        const dot = ux * vx + uy * vy
        const cross = ux * vy - uy * vx
        if (ru > 0 && rv > 0 && Math.abs(dot) < 1e-4 * ru * rv) {
          // Perpendicular axes: a true ellipse. A mirrored pair (cross < 0) runs the other way.
          const rot = Math.atan2(uy, ux)
          const sgn = cross < 0 ? -1 : 1
          const start = sgn * a0
          const end = Math.abs(sw) >= Math.PI * 2 - 1e-6 ? start + Math.PI * 2 : sgn * (a0 + sw)
          p.moveTo(cx + ux * Math.cos(a0) + vx * Math.sin(a0), cy + uy * Math.cos(a0) + vy * Math.sin(a0))
          p.ellipse(cx, cy, ru, rv, rot, start, end, sgn * sw < 0)
        } else {
          // Axes skewed by the view projection: straight segments.
          const steps = Math.max(8, Math.ceil((Math.abs(sw) / (Math.PI * 2)) * 96))
          for (let k = 0; k <= steps; k++) {
            const t = a0 + (sw * k) / steps
            const x = cx + ux * Math.cos(t) + vx * Math.sin(t), y = cy + uy * Math.cos(t) + vy * Math.sin(t)
            k ? p.lineTo(x, y) : p.moveTo(x, y)
          }
        }
      }
      add(pathOf(sm, arcAttr[a] * 16777216 + (arcAttr[a + 1] << 16) + (arcAttr[a + 2] << 8) + (flags & 7)))
      if (flags & 0x20) add(pathOf(fm, arcAttr[a] * 16777216 + (arcAttr[a + 4] << 16)))
    }
    const unpack = (m: Map<number, Path2D>) => [...m].map(([k, path]) => ({ level: Math.floor(k / 16777216), color: (k >> 16) & 255, weight: (k >> 8) & 255, style: k & 255, path }))
    strokes = unpack(sm).sort((x, y) => x.weight - y.weight)
    fills = unpack(fm)
    propWidth = new Float32Array(d.texts.length)
    bitmaps = d.images.map(() => null)
    d.images.forEach((im, i) => {
      if (!im.w || !im.h || im.rgba.length !== im.w * im.h * 4) return
      void createImageBitmap(new ImageData(new Uint8ClampedArray(im.rgba), im.w, im.h)).then((b) => {
        if (!alive) return b.close()
        bitmaps[i] = b
        redraw()
      })
    })
  }

  function colorOf(i: number, onDark: boolean) {
    const c = drawing.colors
    const r = c[i * 3], g = c[i * 3 + 1], b = c[i * 3 + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    // Like MicroStation, never draw in (nearly) the background colour.
    if (onDark && lum < 48) return 'rgb(235,235,235)'
    if (!onDark && lum > 208) return 'rgb(20,20,20)'
    return `rgb(${r},${g},${b})`
  }

  function fitView() {
    const [x0, y0, x1, y1] = drawing.fit
    const fw = Math.max(x1 - x0, 1e-6), fh = Math.max(y1 - y0, 1e-6)
    const s = Math.min((size.w - 20) / fw, (size.h - 20) / fh)
    fitS = s > 0 && Number.isFinite(s) ? s : 1
    view = { s: fitS, tx: size.w / 2 - ((x0 + x1) / 2) * fitS, ty: size.h / 2 + ((y0 + y1) / 2) * fitS }
    fitted = true
    redraw()
  }

  function redraw() {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      draw()
    })
  }

  /** While a heavy drawing is being zoomed or panned, move the last frame and redraw once it settles. */
  function interact() {
    if (lastMs < 45 || !snap) return redraw()
    paintSnap()
    clearTimeout(settle)
    settle = setTimeout(redraw, 140)
  }

  function paintSnap() {
    const ctx = canvas?.getContext('2d')
    if (!ctx || !snap || !canvas) return
    const dpr = window.devicePixelRatio || 1
    const k = view.s / snap.s
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = dark ? '#000' : '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(snap.c, (view.tx - snap.tx * k) * dpr, (view.ty - snap.ty * k) * dpr, snap.c.width * k, snap.c.height * k)
    pct = Math.round((view.s / fitS) * 100)
  }

  function draw() {
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas || !size.w) return
    const t0 = performance.now()
    const dpr = window.devicePixelRatio || 1
    const { s, tx, ty } = view
    const hide = new Set(hidden)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = dark ? '#000' : '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const world = () => ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * tx, dpr * ty)
    world()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const f of fills) {
      if (hide.has(f.level)) continue
      ctx.fillStyle = colorOf(f.color, dark)
      ctx.fill(f.path, 'evenodd')
    }

    ctx.imageSmoothingEnabled = true
    drawing.images.forEach((im, i) => {
      const b = bitmaps[i]
      if (!b || hide.has(im.level)) return
      ctx.save()
      ctx.transform(1, 0, 0, -1, im.x, im.y)
      ctx.drawImage(b, 0, 0, im.w * im.pixel, im.h * im.pixel)
      ctx.restore()
    })

    // Line weights are screen widths; they thin out when the whole sheet is small on screen.
    const sheetPx = (drawing.fit[2] - drawing.fit[0]) * s
    const thin = Math.max(0.4, Math.min(1, sheetPx / 1400))
    for (const b of strokes) {
      if (hide.has(b.level)) continue
      ctx.strokeStyle = colorOf(b.color, dark)
      const px = b.weight ? Math.min(7, 1 + b.weight * 0.6 * thin) : 1
      ctx.lineWidth = px / s
      ctx.setLineDash(DASH[b.style].map((v) => (v * Math.max(1, px * 0.7)) / s))
      ctx.stroke(b.path)
    }
    ctx.setLineDash([])

    // Text in system fonts, sized from the file: capitals reach the stored height. Where the
    // element's range box shows the string is as long as characters x width, the font was fixed
    // pitch, so a fixed-pitch font keeps columns aligned; otherwise a proportional font is
    // fitted to the length the box gives.
    if (drawing.texts.length) {
      ctx.textBaseline = 'alphabetic'
      ctx.font = MONO
      const adv = ctx.measureText('M').width || 55
      const capMono = ctx.measureText('H').actualBoundingBoxAscent || 64
      ctx.font = PROP
      const capProp = ctx.measureText('H').actualBoundingBoxAscent || 72
      let mono = false
      const x0 = -tx / s, x1 = (size.w - tx) / s, y1 = ty / s, y0 = (ty - size.h) / s
      const texts = drawing.texts
      if (propWidth.length !== texts.length) propWidth = new Float32Array(texts.length)
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i]
        if (t.h * s < 2.2 || hide.has(t.level)) continue
        const nominal = t.w * t.s.length
        const reach = nominal + t.h
        if (t.x - reach > x1 || t.x + reach < x0 || t.y - reach > y1 || t.y + reach < y0) continue
        const fixed = !t.len || t.len >= nominal * 0.93
        if (fixed !== mono) {
          ctx.font = fixed ? MONO : PROP
          mono = fixed
        }
        let kx = t.w / adv
        if (!fixed) {
          if (!propWidth[i]) propWidth[i] = ctx.measureText(t.s).width || 1
          kx = t.len / propWidth[i]
        }
        world()
        ctx.transform(t.ax, t.ay, t.bx, t.by, t.x, t.y)
        ctx.scale(kx * (t.mirror & 1 ? -1 : 1), (-t.h / (fixed ? capMono : capProp)) * (t.mirror & 2 ? -1 : 1))
        ctx.fillStyle = colorOf(t.color, dark)
        ctx.fillText(t.s, 0, 0)
      }
    }
    lastMs = performance.now() - t0
    pct = Math.round((s / fitS) * 100)
    if (lastMs >= 45) {
      // Keep a copy to move around while the next real frame is pending.
      const c = snap?.c ?? document.createElement('canvas')
      c.width = canvas.width
      c.height = canvas.height
      c.getContext('2d')!.drawImage(canvas, 0, 0)
      snap = { c, s, tx, ty }
    } else snap = null
  }

  function zoomAt(f: number, cx: number, cy: number) {
    const s = Math.max(fitS / 40, Math.min(fitS * 4000, view.s * f))
    const k = s / view.s
    view = { s, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k }
    fitted = false
    interact()
  }

  function wheel(e: WheelEvent) {
    e.preventDefault()
    const r = canvas!.getBoundingClientRect()
    zoomAt(Math.exp(-e.deltaY * 0.0018), e.clientX - r.left, e.clientY - r.top)
  }

  function drag(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const sx = e.clientX - view.tx
    const sy = e.clientY - view.ty
    const move = (ev: PointerEvent) => {
      view = { ...view, tx: ev.clientX - sx, ty: ev.clientY - sy }
      fitted = false
      interact()
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  function key(e: KeyboardEvent) {
    const step = 60
    switch (e.key) {
      case '+': case '=': zoomAt(1.25, size.w / 2, size.h / 2); break
      case '-': zoomAt(1 / 1.25, size.w / 2, size.h / 2); break
      case '0': case 'f': case 'F': fitView(); break
      case 'ArrowLeft': view = { ...view, tx: view.tx + step }; interact(); break
      case 'ArrowRight': view = { ...view, tx: view.tx - step }; interact(); break
      case 'ArrowUp': view = { ...view, ty: view.ty + step }; interact(); break
      case 'ArrowDown': view = { ...view, ty: view.ty - step }; interact(); break
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  function toggleLevel(l: number) {
    hidden = hidden.includes(l) ? hidden.filter((x) => x !== l) : [...hidden, l]
  }

  $effect(() => {
    const d = drawing
    build(d)
    // Start on the background the file's colour table asks for.
    const c = d.colors
    dark = 0.299 * c[765] + 0.587 * c[766] + 0.114 * c[767] < 128
    hidden = []
    snap = null
    if (size.w) fitView()
  })

  $effect(() => {
    void dark
    void hidden
    redraw()
  })

  $effect(() => {
    if (!wrap || !canvas) return
    const ro = new ResizeObserver(() => {
      if (!wrap || !canvas) return
      const dpr = window.devicePixelRatio || 1
      const w = wrap.clientWidth, h = wrap.clientHeight
      if (!w || !h) return
      const first = !size.w
      const keep = { cx: (size.w / 2 - view.tx) / view.s, cy: (view.ty - size.h / 2) / view.s }
      size = { w, h }
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      snap = null
      if (first || fitted) fitView()
      else {
        view = { ...view, tx: w / 2 - keep.cx * view.s, ty: h / 2 + keep.cy * view.s }
        draw()
      }
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  })

  onDestroy(() => {
    alive = false
    cancelAnimationFrame(raf)
    clearTimeout(settle)
    for (const b of bitmaps) b?.close()
  })

  const unitNote = $derived(drawing.units.master ? `${drawing.units.master}${drawing.units.sub && drawing.units.sub !== drawing.units.master ? ` / ${drawing.units.sub}` : ''}` : '')
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="dgn" tabindex="0" onkeydown={key} role="group" aria-label="Drawing">
  <div class="bar">
    <span class="caption ellipsis" title={`${drawing.elements.toLocaleString()} elements in the file, ${drawing.drawn.toLocaleString()} drawn`}>MicroStation V7 · {drawing.is3d ? '3D' : '2D'}{unitNote ? ` · ${unitNote}` : ''}</span>
    <span class="spacer"></span>
    <button class="btn subtle icon sm" title="Zoom out (wheel, -)" onclick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)}><Icon name="zoomOut" /></button>
    <span class="caption pct">{pct}%</span>
    <button class="btn subtle icon sm" title="Zoom in (wheel, +)" onclick={() => zoomAt(1.25, size.w / 2, size.h / 2)}><Icon name="zoomIn" /></button>
    <button class="btn subtle sm" title="Fit (0)" onclick={fitView}>Fit</button>
    <button class="btn subtle icon sm" title={dark ? 'White background' : 'Black background'} onclick={() => (dark = !dark)}><Icon name={dark ? 'sun' : 'moon'} /></button>
    <button class="btn subtle icon sm" class:on={showLevels} title="Levels" onclick={() => (showLevels = !showLevels)}><Icon name="layers" /></button>
    {#if onexpand}<button class="btn subtle icon sm" title="View in full window" onclick={onexpand}><Icon name="fullscreen" /></button>{/if}
  </div>
  {#if drawing.notices.length}
    <button class="notes caption" class:open={showNotes} onclick={() => (showNotes = !showNotes)} title={showNotes ? 'Collapse' : 'Show all notes'}>
      <Icon name="info" size={14} />
      {#if showNotes}
        <span class="all">{#each drawing.notices as n (n)}<span>{n}</span>{/each}</span>
      {:else}
        <span class="ellipsis">{drawing.notices.length > 1 ? `${drawing.notices.length} notes · ` : ''}{drawing.notices[0]}</span>
      {/if}
    </button>
  {/if}
  <div class="stage" bind:this={wrap}>
    <canvas bind:this={canvas} onwheel={wheel} onpointerdown={drag} ondblclick={() => (onexpand ? onexpand() : fitView())}></canvas>
    {#if showLevels}
      <div class="levels">
        <div class="lh">
          <span class="caption">Levels</span>
          <span class="spacer"></span>
          <button class="btn subtle sm" onclick={() => (hidden = [])}>All</button>
          <button class="btn subtle sm" onclick={() => (hidden = drawing.levels.map((l) => l.level))}>None</button>
        </div>
        <div class="ll">
          {#each drawing.levels as l (l.level)}
            <label class="check"><input type="checkbox" checked={!hidden.includes(l.level)} onchange={() => toggleLevel(l.level)} /> <span>{l.level}</span> <span class="caption">{l.count.toLocaleString()}</span></label>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .dgn {
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
  .bar .caption:first-child {
    min-width: 0;
  }
  .pct {
    min-width: 44px;
    text-align: center;
  }
  .on {
    background: var(--sel) !important;
  }
  .notes {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    border: 0;
    background: none;
    padding: 0 2px 6px;
    text-align: left;
    cursor: pointer;
    min-width: 0;
    flex: none;
    color: var(--text-2);
  }
  .notes :global(svg) {
    flex: none;
    margin-top: 1px;
  }
  .notes .all {
    display: flex;
    flex-direction: column;
    gap: 3px;
    white-space: normal;
  }
  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke-2);
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    cursor: crosshair;
    touch-action: none;
  }
  .levels {
    position: absolute;
    top: 6px;
    right: 6px;
    bottom: 6px;
    width: 150px;
    display: flex;
    flex-direction: column;
    background: var(--flyout);
    border: 1px solid var(--stroke-2);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-flyout);
    padding: 6px;
  }
  .lh {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-bottom: 4px;
  }
  .ll {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ll label {
    font-size: 12px;
    gap: 6px;
  }
  .ll label span:last-child {
    margin-left: auto;
  }
</style>
