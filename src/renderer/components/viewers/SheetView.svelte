<script lang="ts">
  // Spreadsheet grid: sheet tabs, sticky row and column headers, rows drawn only when visible,
  // Ctrl+wheel zoom, cell / range selection with copy. Shows stored values exactly as the engine
  // formatted them; nothing is calculated here.
  import { onDestroy } from 'svelte'
  import { engine, host } from '../../lib/api'
  import type { SheetBook, SheetCell, SheetGrid } from '../../../engine/preview/types'
  import Icon from '../Icon.svelte'

  let { path, slot = 'default', onexpand }: { path: string; slot?: string; onexpand?: () => void } = $props()

  const ROW = 22
  const HEAD_W = 46
  const DEF_W = 84
  const KEY = 4096 // > max columns; cell key = r * KEY + c

  let book = $state<SheetBook | null>(null)
  let grid = $state<SheetGrid | null>(null)
  let active = $state(0)
  let status = $state<'loading' | 'ready' | 'error'>('loading')
  let message = $state('')
  let zoom = $state(1)
  let scroller: HTMLDivElement | undefined = $state()
  let scrollTop = $state(0)
  let viewH = $state(400)
  let sel = $state<{ r0: number; c0: number; r1: number; c1: number } | null>(null)
  let token = 0

  async function load(p: string) {
    const my = ++token
    status = 'loading'
    book = null
    grid = null
    sel = null
    try {
      const b = await engine.call<SheetBook>('preview.sheetBook', p, slot)
      if (my !== token) return
      book = b
      const first = Math.max(0, b.sheets.findIndex((s) => !s.hidden))
      await openSheet(first, my)
    } catch (err: any) {
      if (my !== token || err?.message === 'superseded') return
      status = 'error'
      message = String(err?.message ?? err)
    }
  }

  async function openSheet(i: number, my = ++token) {
    active = i
    status = 'loading'
    try {
      const g = await engine.call<SheetGrid>('preview.sheet', path, i, slot)
      if (my !== token) return
      grid = g
      sel = null
      status = 'ready'
      if (scroller) scroller.scrollTop = scroller.scrollLeft = 0
      scrollTop = 0
    } catch (err: any) {
      if (my !== token || err?.message === 'superseded') return
      status = 'error'
      message = String(err?.message ?? err)
    }
  }

  $effect(() => {
    void load(path)
  })
  onDestroy(() => token++)

  // Layout tables for the loaded sheet.
  const lay = $derived.by(() => {
    const g = grid
    if (!g) return null
    const hiddenC = new Set(g.hiddenCols)
    const hiddenR = new Set(g.hiddenRows)
    const left: number[] = [0]
    for (let c = 0; c < g.cols; c++) left.push(left[c] + (hiddenC.has(c) ? 0 : (g.widths[c] ?? DEF_W)))
    const rows: number[] = []
    for (let r = 0; r < g.rows; r++) if (!hiddenR.has(r)) rows.push(r)
    const rowPos = new Map<number, number>()
    rows.forEach((r, i) => rowPos.set(r, i))
    const byRow = new Map<number, SheetCell[]>()
    for (const c of g.cells) {
      let a = byRow.get(c.r)
      if (!a) byRow.set(c.r, (a = []))
      a.push(c)
    }
    const covered = new Set<number>()
    const anchors = new Map<number, [number, number, number, number]>()
    for (const m of g.merges) {
      anchors.set(m[0] * KEY + m[1], m)
      for (let r = m[0]; r <= m[2]; r++) for (let c = m[1]; c <= m[3]; c++) if (r !== m[0] || c !== m[1]) covered.add(r * KEY + c)
    }
    return { left, rows, rowPos, byRow, covered, anchors, hiddenC }
  })

  const rowH = $derived(ROW * zoom)
  const first = $derived(Math.max(0, Math.floor(scrollTop / rowH) - 6))
  const last = $derived(lay ? Math.min(lay.rows.length, Math.ceil((scrollTop + viewH) / rowH) + 6) : 0)

  /** Cells of one visible row with their box; text runs over empty neighbours as in Excel. */
  function rowCells(r: number) {
    const l = lay!
    const g = grid!
    const cells = l.byRow.get(r) ?? []
    const out: { c: SheetCell; x: number; w: number; h: number; span: boolean }[] = []
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]
      if (l.covered.has(r * KEY + c.c) || l.hiddenC.has(c.c)) continue
      const m = l.anchors.get(r * KEY + c.c)
      if (m) {
        let h = 0
        for (let rr = m[0]; rr <= m[2]; rr++) if (l.rowPos.has(rr)) h += rowH
        out.push({ c, x: l.left[c.c], w: l.left[m[3] + 1] - l.left[c.c], h, span: true })
        continue
      }
      let end = c.c + 1
      if (c.k === 's') {
        const next = cells[i + 1]?.c ?? g.cols
        while (end < next && !l.covered.has(r * KEY + end) && l.left[end] - l.left[c.c] < 900) end++
      }
      out.push({ c, x: l.left[c.c], w: l.left[end] - l.left[c.c], h: rowH, span: false })
    }
    return out
  }

  const colName = (c: number) => {
    let s = ''
    for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    return s
  }

  const box = $derived(sel ? { r0: Math.min(sel.r0, sel.r1), r1: Math.max(sel.r0, sel.r1), c0: Math.min(sel.c0, sel.c1), c1: Math.max(sel.c0, sel.c1) } : null)
  const selText = $derived.by(() => {
    if (!sel || !lay) return ''
    return lay.byRow.get(sel.r0)?.find((c) => c.c === sel!.c0)?.t ?? ''
  })

  function cellAt(e: MouseEvent) {
    if (!scroller || !lay || !grid) return null
    const r = scroller.getBoundingClientRect()
    const x = (e.clientX - r.left + scroller.scrollLeft) / zoom - HEAD_W
    const y = e.clientY - r.top + scroller.scrollTop - rowH
    if (x < 0 || y < 0) return null
    const ri = Math.floor(y / rowH)
    if (ri >= lay.rows.length) return null
    let c = 0
    while (c < grid.cols - 1 && lay.left[c + 1] <= x) c++
    return { r: lay.rows[ri], c }
  }

  function down(e: PointerEvent) {
    if (e.button !== 0 || !scroller) return
    const rect = scroller.getBoundingClientRect()
    if (e.clientX - rect.left > scroller.clientWidth || e.clientY - rect.top > scroller.clientHeight) return
    const at = cellAt(e)
    if (!at) return
    sel = e.shiftKey && sel ? { ...sel, r1: at.r, c1: at.c } : { r0: at.r, c0: at.c, r1: at.r, c1: at.c }
    const el = scroller
    const move = (ev: PointerEvent) => {
      const m = cellAt(ev)
      if (m && sel) sel = { ...sel, r1: m.r, c1: m.c }
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function copy() {
    if (!box || !lay) return
    const lines: string[] = []
    for (let r = box.r0; r <= box.r1; r++) {
      if (!lay.rowPos.has(r)) continue
      const row = lay.byRow.get(r) ?? []
      const out: string[] = []
      for (let c = box.c0; c <= box.c1; c++) {
        if (lay.hiddenC.has(c)) continue
        out.push((row.find((x) => x.c === c)?.t ?? '').replace(/[\t\r\n]+/g, ' '))
      }
      lines.push(out.join('\t'))
    }
    void host.clip.writeText(lines.join('\r\n'))
  }

  function key(e: KeyboardEvent) {
    if (!grid || !lay) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'c') {
      if (!sel) return
      copy()
    } else if (mod && e.key.toLowerCase() === 'a') {
      sel = { r0: 0, c0: 0, r1: grid.rows - 1, c1: grid.cols - 1 }
    } else if (e.key.startsWith('Arrow') && sel) {
      const i = lay.rowPos.get(sel.r1) ?? 0
      let r = sel.r1, c = sel.c1
      if (e.key === 'ArrowDown') r = lay.rows[Math.min(lay.rows.length - 1, i + 1)]
      if (e.key === 'ArrowUp') r = lay.rows[Math.max(0, i - 1)]
      if (e.key === 'ArrowRight') c = Math.min(grid.cols - 1, c + 1)
      if (e.key === 'ArrowLeft') c = Math.max(0, c - 1)
      sel = e.shiftKey ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c }
      reveal(r, c)
    } else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.15)
    else if (e.key === '-') setZoom(zoom / 1.15)
    else if (e.key === '0') setZoom(1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  function reveal(r: number, c: number) {
    if (!scroller || !lay) return
    const y = (lay.rowPos.get(r) ?? 0) * rowH
    if (y < scroller.scrollTop) scroller.scrollTop = y
    else if (y + rowH * 2 > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + rowH * 2 - scroller.clientHeight
    const x = lay.left[c] * zoom
    const x1 = lay.left[c + 1] * zoom + HEAD_W * zoom
    if (x < scroller.scrollLeft) scroller.scrollLeft = x
    else if (x1 > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = x1 - scroller.clientWidth
  }

  function setZoom(z: number) {
    const next = Math.max(0.4, Math.min(3, z))
    if (scroller) {
      const k = next / zoom
      const t = scroller.scrollTop * k
      const l = scroller.scrollLeft * k
      zoom = next
      requestAnimationFrame(() => {
        if (!scroller) return
        scroller.scrollTop = t
        scroller.scrollLeft = l
      })
    } else zoom = next
  }

  function wheel(e: WheelEvent) {
    if (!e.ctrlKey) return
    e.preventDefault()
    setZoom(zoom * Math.exp(-e.deltaY * 0.0012))
  }

  $effect(() => {
    if (!scroller) return
    const ro = new ResizeObserver(() => scroller && (viewH = scroller.clientHeight))
    ro.observe(scroller)
    return () => ro.disconnect()
  })

  const capNote = $derived.by(() => {
    const g = grid
    if (!g) return ''
    const parts: string[] = []
    if (g.totalRows > g.rows) parts.push(`Showing the first ${g.rows.toLocaleString()} of ${g.totalRows.toLocaleString()} rows`)
    if (g.totalCols > g.cols) parts.push(`${parts.length ? 'and ' : 'Showing '}the first ${g.cols} of ${g.totalCols.toLocaleString()} columns`)
    const hid: string[] = []
    if (g.hiddenRows.length) hid.push(`${g.hiddenRows.length} hidden row${g.hiddenRows.length === 1 ? '' : 's'}`)
    if (g.hiddenCols.length) hid.push(`${g.hiddenCols.length} hidden column${g.hiddenCols.length === 1 ? '' : 's'}`)
    if (hid.length) parts.push(`${hid.join(' and ')} not shown`)
    return parts.join(' · ')
  })
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="sheet" tabindex="0" onkeydown={key} role="group" aria-label="Spreadsheet">
  <div class="bar">
    {#if sel && grid}
      <span class="ref">{colName(sel.c0)}{sel.r0 + 1}{box && (box.r0 !== box.r1 || box.c0 !== box.c1) ? `:${colName(sel.c1)}${sel.r1 + 1}` : ''}</span>
      <span class="val ellipsis" title={selText}>{selText}</span>
    {:else}
      <span class="caption ellipsis">{status === 'loading' ? 'Reading…' : 'Values as stored in the file · click a cell, Ctrl+C copies'}</span>
    {/if}
    <span class="spacer"></span>
    {#if sel}<button class="btn subtle icon sm" title="Copy selection (Ctrl+C)" onclick={copy}><Icon name="copy" /></button>{/if}
    <button class="btn subtle icon sm" title="Zoom out (Ctrl+wheel)" onclick={() => setZoom(zoom / 1.15)}><Icon name="zoomOut" /></button>
    <span class="caption pct">{Math.round(zoom * 100)}%</span>
    <button class="btn subtle icon sm" title="Zoom in (Ctrl+wheel)" onclick={() => setZoom(zoom * 1.15)}><Icon name="zoomIn" /></button>
    {#if onexpand}<button class="btn subtle icon sm" title="View in full window" onclick={onexpand}><Icon name="fullscreen" /></button>{/if}
  </div>

  <div class="scroll" bind:this={scroller} onscroll={() => scroller && (scrollTop = scroller.scrollTop)} onwheel={wheel} onpointerdown={down} ondblclick={(e) => !cellAt(e) && onexpand?.()} role="presentation">
    {#if status === 'error'}
      <div class="msg caption">{message}</div>
    {:else if grid && lay}
      {#if !grid.rows}
        <div class="msg caption">This sheet is empty.</div>
      {:else}
        <div class="canvas" style:zoom={zoom} style:width={`${HEAD_W + lay.left[grid.cols]}px`} style:height={`${ROW * (lay.rows.length + 1)}px`} style:--row={`${ROW}px`}>
          <div class="colhead" style:height={`${ROW}px`}>
            <div class="corner" style:width={`${HEAD_W}px`}></div>
            {#each { length: grid.cols } as _, c (c)}
              {#if !lay.hiddenC.has(c)}
                <div class="ch" class:on={box && c >= box.c0 && c <= box.c1} style:left={`${HEAD_W + lay.left[c]}px`} style:width={`${lay.left[c + 1] - lay.left[c]}px`}>{colName(c)}</div>
              {/if}
            {/each}
          </div>
          {#each lay.rows.slice(first, last) as r, k (r)}
            {@const top = ROW * (first + k + 1)}
            <div class="row" style:top={`${top}px`}>
              <div class="rh" class:on={box && r >= box.r0 && r <= box.r1} style:width={`${HEAD_W}px`}>{r + 1}</div>
              {#each rowCells(r) as b (b.c.c)}
                <div class="cell" class:num={b.c.k === 'n' || b.c.k === 'd'} class:mid={b.c.k === 'b' || b.c.k === 'e'} class:span={b.span} style:left={`${HEAD_W + b.x}px`} style:width={`${b.w}px`} style:height={`${b.h / zoom}px`}>{b.c.t}</div>
              {/each}
            </div>
          {/each}
          <div class="lines" style:left={`${HEAD_W}px`} style:top={`${ROW}px`} style:background-size={`100% ${ROW}px`}></div>
          {#each { length: grid.cols } as _, c (c)}
            {#if !lay.hiddenC.has(c)}<div class="vline" style:left={`${HEAD_W + lay.left[c + 1] - 1}px`} style:top={`${ROW}px`}></div>{/if}
          {/each}
          {#if box && lay.rowPos.has(box.r0)}
            {@const y0 = (lay.rowPos.get(box.r0) ?? 0) + 1}
            {@const y1 = (lay.rowPos.get(box.r1) ?? lay.rows.length - 1) + 2}
            <div class="selbox" style:left={`${HEAD_W + lay.left[box.c0]}px`} style:top={`${ROW * y0}px`} style:width={`${lay.left[box.c1 + 1] - lay.left[box.c0]}px`} style:height={`${ROW * (y1 - y0)}px`}></div>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="msg"><span class="spin"></span></div>
    {/if}
  </div>

  {#if capNote || book?.notes.length}
    <div class="caption note">{[capNote, ...(book?.notes ?? [])].filter(Boolean).join(' · ')}</div>
  {/if}
  {#if book && book.sheets.length}
    <div class="tabs">
      {#each book.sheets as s, i (i)}
        <button class="tab" class:on={i === active} class:hid={s.hidden} title={s.hidden ? `${s.name} (hidden sheet)` : s.name} onclick={() => i !== active && openSheet(i)}>{s.name}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sheet {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    outline: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 30px;
    padding: 0 2px 4px;
    flex: none;
    min-width: 0;
  }
  .ref {
    font: 600 12px/18px var(--mono);
    padding: 1px 6px;
    border-radius: var(--r-sm);
    background: var(--stroke);
    flex: none;
  }
  .val {
    font-size: 12px;
    min-width: 0;
    user-select: text;
  }
  .pct {
    min-width: 40px;
    text-align: center;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--stroke-2);
    border-radius: var(--r-md);
    background: var(--card-solid);
    position: relative;
  }
  .canvas {
    position: relative;
    font-size: 12px;
    line-height: var(--row);
  }
  .colhead {
    position: sticky;
    top: 0;
    z-index: 3;
    width: 100%;
  }
  .corner,
  .ch,
  .rh {
    background: var(--layer-solid);
    color: var(--text-2);
    text-align: center;
    border-right: 1px solid var(--stroke-2);
    border-bottom: 1px solid var(--stroke-2);
    height: var(--row);
    overflow: hidden;
  }
  .corner {
    position: sticky;
    left: 0;
    z-index: 4;
  }
  .ch {
    position: absolute;
    top: 0;
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
    height: var(--row);
  }
  .rh {
    position: sticky;
    left: 0;
    z-index: 2;
    font-size: 11px;
  }
  .ch.on,
  .rh.on {
    background: var(--sel-strong);
    color: var(--text);
  }
  .cell {
    position: absolute;
    top: 0;
    padding: 0 4px;
    white-space: nowrap;
    overflow: hidden;
    z-index: 1;
  }
  .cell.num {
    text-align: right;
  }
  .cell.mid {
    text-align: center;
  }
  .cell.span {
    background: var(--card-solid);
    border-right: 1px solid var(--stroke-2);
    border-bottom: 1px solid var(--stroke-2);
    white-space: normal;
    line-height: 16px;
    display: flex;
    align-items: center;
  }
  .lines {
    position: absolute;
    right: 0;
    bottom: 0;
    pointer-events: none;
    background-image: linear-gradient(to top, var(--stroke-2) 1px, transparent 1px);
  }
  .vline {
    position: absolute;
    bottom: 0;
    width: 1px;
    background: var(--stroke-2);
    pointer-events: none;
  }
  .selbox {
    position: absolute;
    border: 2px solid var(--accent);
    background: var(--sel);
    pointer-events: none;
    z-index: 2;
  }
  .msg {
    padding: 24px;
    text-align: center;
    display: grid;
    place-items: center;
  }
  .note {
    padding: 4px 2px 0;
    flex: none;
  }
  .tabs {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    padding-top: 4px;
    flex: none;
    scrollbar-width: thin;
  }
  .tab {
    border: 1px solid transparent;
    background: none;
    border-radius: var(--r-sm);
    padding: 2px 10px;
    font-size: 12px;
    white-space: nowrap;
    color: var(--text-2);
    cursor: pointer;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: none;
  }
  .tab:hover {
    background: var(--hover);
  }
  .tab.on {
    background: var(--sel);
    color: var(--text);
    border-color: var(--stroke-2);
    font-weight: 600;
  }
  .tab.hid {
    font-style: italic;
    opacity: 0.7;
  }
  .spin {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 3px solid var(--stroke-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
