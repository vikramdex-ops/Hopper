<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Pane, Row } from '../lib/pane.svelte'
  import { isArchivePath, isVirtual } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { fmtDate, fmtSize } from '../lib/format'
  import { kindOf, typeLabel, KIND_COLOR, KIND_ICON, THUMB_KINDS } from '../lib/filetypes'
  import { startDrag, dropPaths, dropOp, isNoopDrop, hasFiles } from '../lib/dnd'
  import { fileMenu, backgroundMenu } from '../lib/ctxmenu'
  import { ATTR, type ColumnSpec } from '@shared/types'
  import Icon from './Icon.svelte'

  let { pane }: { pane: Pane } = $props()

  let scroller: HTMLDivElement
  let height = $state(600)
  let width = $state(800)
  let scrollTop = $state(0)
  let rowH = $state(32)
  let dropTarget = $state<string | null>(null)
  let dropHere = $state(false)
  let marquee = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  const rows = $derived(pane.rows)
  const view = $derived(pane.view)
  // Columns that fit this pane: Name always, then the rest by importance until space runs out.
  const PRIORITY: ColumnSpec['id'][] = ['mtime', 'size', 'rev', 'type', 'ctime', 'attrs']
  const NAME_MIN = 200
  const cols = $derived.by(() => {
    const all = (app.settings?.columns ?? []).filter((c) => c.visible)
    let room = width - 24 - NAME_MIN
    const keep = new Set<ColumnSpec['id']>(['name'])
    for (const id of PRIORITY) {
      const c = all.find((x) => x.id === id)
      if (c && c.width <= room) {
        keep.add(id)
        room -= c.width
      }
    }
    return all.filter((c) => keep.has(c.id))
  })
  const thumb = $derived(app.settings?.thumbSize ?? 96)
  const HEADER = 32

  // Grid metrics: list = small tiles, grid = thumbnails.
  const cellW = $derived(view === 'grid' ? thumb + 36 : view === 'list' ? 260 : width)
  const cellH = $derived(view === 'grid' ? thumb + 56 : rowH)
  const perRow = $derived(view === 'details' ? 1 : Math.max(1, Math.floor((width - 16) / cellW)))
  const lines = $derived(Math.ceil(rows.length / perRow))
  const top = $derived(view === 'details' ? HEADER : 8)
  const totalH = $derived(top + lines * cellH + 16)
  const first = $derived(Math.max(0, Math.floor((scrollTop - top) / cellH) - 4))
  const last = $derived(Math.min(lines, Math.ceil((scrollTop + height) / cellH) + 4))
  const visible = $derived.by(() => {
    const out: { row: Row; i: number }[] = []
    for (let line = first; line < last; line++) {
      for (let c = 0; c < perRow; c++) {
        const i = line * perRow + c
        if (i >= rows.length) break
        out.push({ row: rows[i], i })
      }
    }
    return out
  })

  let raf = 0
  function onScroll() {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      scrollTop = scroller.scrollTop
    })
  }

  onMount(() => {
    const readRow = () => (rowH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 32)
    readRow()
    const mo = new MutationObserver(readRow)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-density'] })
    return () => mo.disconnect()
  })

  // Keep the focused row on screen.
  $effect(() => {
    const f = pane.focus
    if (f < 0 || !scroller) return
    const line = Math.floor(f / perRow)
    const y = top + line * cellH
    if (y < scroller.scrollTop + top) scroller.scrollTop = y - top
    else if (y + cellH > scroller.scrollTop + height) scroller.scrollTop = y + cellH - height + 4
  })

  // New folder => scroll to top.
  $effect(() => {
    void pane.path
    if (scroller) scroller.scrollTop = 0
  })

  const keyOf = (r: Row) => r.path.toLowerCase()
  const isSel = (r: Row) => pane.selection.has(keyOf(r))

  const enc = encodeURIComponent
  function iconUrl(r: Row, large = false) {
    return `hopper://icon/?p=${enc(r.path)}&e=${enc(r.ext)}&z=${large ? 'large' : 'small'}`
  }
  function thumbUrl(r: Row) {
    return `hopper://thumb/?p=${enc(r.path)}&s=${thumb * 2 > 256 ? 256 : thumb * 2}&v=${r.mtime}-${r.size}`
  }
  const wantsThumb = (r: Row) => view === 'grid' && !r.dir && THUMB_KINDS.has(kindOf(r.ext)) && !isArchivePath(r.path)
  const sysIcon = (r: Row) => !r.dir && !isArchivePath(r.path) && !isVirtual(r.path)

  // ---- mouse --------------------------------------------------------------

  let pendingSingle = -1
  function down(e: MouseEvent, i: number) {
    if (e.button !== 0 && e.button !== 2) return
    pane.app.setActive(pane.index)
    const r = rows[i]
    pendingSingle = -1
    if (e.shiftKey) pane.selectIndex(i, e.ctrlKey ? 'rangeAdd' : 'range')
    else if (e.ctrlKey) pane.selectIndex(i, 'toggle')
    else if (!isSel(r)) pane.selectIndex(i, 'single')
    else {
      pane.focus = i
      // Clicking inside a multi-selection keeps it until mouse-up (so it can be dragged).
      if (e.button === 0) pendingSingle = i
    }
  }
  function up(i: number) {
    if (pendingSingle === i && pane.selection.size > 1) pane.selectIndex(i, 'single')
    pendingSingle = -1
  }

  function dbl(r: Row) {
    void app.openEntry(r)
  }

  function aux(e: MouseEvent, r: Row) {
    if (e.button !== 1) return
    e.preventDefault()
    if (r.dir) pane.openTab(r.path, false)
    else void app.openEntry(r)
  }

  function ctx(e: MouseEvent, i: number | null) {
    e.preventDefault()
    pane.app.setActive(pane.index)
    if (i === null) {
      pane.clearSelection()
      app.openMenu(e.clientX, e.clientY, backgroundMenu(pane))
      return
    }
    if (!isSel(rows[i])) pane.selectIndex(i, 'single')
    const targets = pane.targets()
    app.openMenu(e.clientX, e.clientY, fileMenu(pane, targets), targets.every((t) => !isVirtual(t.path) && !isArchivePath(t.path)) ? targets.map((t) => t.path) : undefined)
  }

  // Background: clear selection and start a marquee.
  function bgDown(e: MouseEvent) {
    if (e.target !== scroller && !(e.target as HTMLElement).classList.contains('canvas')) return
    if (e.button !== 0) return
    pane.app.setActive(pane.index)
    scroller.focus()
    if (!e.ctrlKey && !e.shiftKey) pane.clearSelection()
    const rect = scroller.getBoundingClientRect()
    const x0 = e.clientX - rect.left
    const y0 = e.clientY - rect.top + scroller.scrollTop
    const base = new Set(e.ctrlKey ? pane.selection : [])
    marquee = { x0, y0, x1: x0, y1: y0 }
    const move = (ev: MouseEvent) => {
      const x1 = ev.clientX - rect.left
      const y1 = ev.clientY - rect.top + scroller.scrollTop
      marquee = { x0, y0, x1, y1 }
      const [ya, yb] = [Math.min(y0, y1), Math.max(y0, y1)]
      const [xa, xb] = [Math.min(x0, x1), Math.max(x0, x1)]
      const la = Math.max(0, Math.floor((ya - top) / cellH))
      const lb = Math.min(lines - 1, Math.floor((yb - top) / cellH))
      const sel = new Set(base)
      for (let l = la; l <= lb; l++) {
        for (let c = 0; c < perRow; c++) {
          const cx0 = 8 + c * cellW
          if (view !== 'details' && (cx0 + cellW < xa || cx0 > xb)) continue
          const i = l * perRow + c
          if (i < rows.length) sel.add(keyOf(rows[i]))
        }
      }
      pane.setSelection(sel)
      if (ev.clientY > rect.bottom - 20) scroller.scrollTop += 20
      else if (ev.clientY < rect.top + 20) scroller.scrollTop -= 20
    }
    const end = () => {
      marquee = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
  }

  // ---- drag & drop ------------------------------------------------------------

  function dragStart(e: DragEvent, i: number) {
    if (!isSel(rows[i])) pane.selectIndex(i, 'single')
    startDrag(e, pane.targets().map((t) => t.path))
  }

  function rowOver(e: DragEvent, r: Row) {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    const target = r.dir || kindOf(r.ext) === 'archive' ? r.path : null
    dropTarget = target ? keyOf(r) : null
    dropHere = !target
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy'
  }

  async function rowDrop(e: DragEvent, r: Row) {
    e.preventDefault()
    e.stopPropagation()
    dropTarget = null
    dropHere = false
    const paths = dropPaths(e)
    if (!paths.length) return
    let dest = pane.path
    if (r.dir) dest = r.path
    else if (kindOf(r.ext) === 'archive' && !isArchivePath(r.path)) {
      if (await app.confirm(`Add ${paths.length} item(s) to ${r.name}?`, undefined, 'Add')) await app.transfer('copy', paths, `${r.path}::`)
      return
    }
    if (paths.some((p) => p.toLowerCase() === dest.toLowerCase())) return
    if (isNoopDrop(paths, dest)) return
    await app.transfer(dropOp(e, paths, dest), paths, dest)
  }

  function bgOver(e: DragEvent) {
    if (!hasFiles(e) || isVirtual(pane.path)) return
    e.preventDefault()
    dropTarget = null
    dropHere = true
  }

  async function bgDrop(e: DragEvent) {
    e.preventDefault()
    dropHere = false
    if (isVirtual(pane.path)) return
    const paths = dropPaths(e)
    if (!paths.length || isNoopDrop(paths, pane.path)) return
    await app.transfer(dropOp(e, paths, pane.path), paths, pane.path)
  }

  // ---- keyboard -------------------------------------------------------------

  let typed = ''
  let typedAt = 0
  function key(e: KeyboardEvent) {
    if (pane.renaming) return
    const n = rows.length
    if (!n) return
    const f = Math.max(0, pane.focus)
    const page = Math.max(1, Math.floor(height / cellH) - 1) * perRow
    const move = (to: number) => {
      to = Math.max(0, Math.min(n - 1, to))
      e.preventDefault()
      if (e.shiftKey) pane.selectIndex(to, 'range')
      else if (e.ctrlKey) pane.focus = to
      else pane.selectIndex(to, 'single')
    }
    switch (e.key) {
      case 'ArrowDown': return move(pane.focus < 0 ? 0 : f + perRow)
      case 'ArrowUp': return move(f - perRow)
      case 'ArrowRight': if (perRow > 1) return move(f + 1); break
      case 'ArrowLeft': if (perRow > 1) return move(f - 1); break
      case 'Home': return move(0)
      case 'End': return move(n - 1)
      case 'PageDown': return move(f + page)
      case 'PageUp': return move(f - page)
      case ' ':
        if (e.ctrlKey) {
          e.preventDefault()
          pane.selectIndex(f, 'toggle')
        }
        return
    }
    // Type-ahead: jump to the next name starting with what was typed.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && e.key !== ' ') {
      const now = Date.now()
      typed = now - typedAt > 900 ? e.key.toLowerCase() : typed + e.key.toLowerCase()
      typedAt = now
      const start = typed.length === 1 ? f + 1 : f
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n
        if (rows[i].name.toLowerCase().startsWith(typed)) {
          pane.selectIndex(i, 'single')
          break
        }
      }
      e.preventDefault()
    }
  }

  // ---- rename -----------------------------------------------------------------

  function renameMount(el: HTMLInputElement, r: Row) {
    el.value = r.name
    el.focus()
    const dot = r.dir ? -1 : r.name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : r.name.length)
    let done = false
    const commit = async (save: boolean) => {
      if (done) return
      done = true
      pane.renaming = null
      if (save) await app.rename(r, el.value)
      await tick()
      scroller?.focus()
    }
    el.onkeydown = (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') void commit(true)
      if (e.key === 'Escape') void commit(false)
    }
    // Blur also fires while Svelte removes the input during a re-render; never write state then.
    el.onblur = () => {
      if (el.isConnected) queueMicrotask(() => void commit(true))
    }
  }

  // ---- columns ----------------------------------------------------------------

  const COL_LABEL: Record<ColumnSpec['id'], string> = { name: 'Name', size: 'Size', type: 'Type', mtime: 'Date modified', ctime: 'Date created', attrs: 'Attributes', rev: 'Rev' }

  function resize(e: PointerEvent, c: ColumnSpec) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = c.width
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const all = app.settings!.columns
      const col = all.find((x) => x.id === c.id)!
      col.width = Math.max(48, startW + ev.clientX - startX)
    }
    const upFn = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', upFn)
      app.updateSettings({ columns: $state.snapshot(app.settings!.columns) })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', upFn)
  }

  function headerMenu(e: MouseEvent) {
    e.preventDefault()
    const all = app.settings!.columns
    app.openMenu(e.clientX, e.clientY, all.filter((c) => c.id !== 'name').map((c) => ({
      label: COL_LABEL[c.id],
      checked: c.visible,
      run: () => app.updateSettings({ columns: all.map((x) => (x.id === c.id ? { ...x, visible: !x.visible } : x)) })
    })))
  }

  const attrText = (a: number) => (a & ATTR.readonly ? 'R' : '') + (a & ATTR.hidden ? 'H' : '') + (a & ATTR.system ? 'S' : '') + (a & ATTR.archive ? 'A' : '') + (a & ATTR.compressed ? 'C' : '') + (a & ATTR.encrypted ? 'E' : '')
  const cloudState = (a: number) => (a & (ATTR.recallOnAccess | ATTR.offline) ? 'cloud' : '')
  const gridTemplate = $derived(cols.map((c) => (c.id === 'name' ? `minmax(${NAME_MIN}px, 1fr)` : `${c.width}px`)).join(' '))
</script>

<div
  class="list v-{view}"
  class:drop-here={dropHere}
  bind:this={scroller}
  bind:clientHeight={height}
  bind:clientWidth={width}
  tabindex="0"
  role="listbox"
  aria-multiselectable="true"
  aria-label="Files"
  onscroll={onScroll}
  onkeydown={key}
  onmousedown={bgDown}
  oncontextmenu={(e) => (e.target === scroller || (e.target as HTMLElement).classList.contains('canvas')) && ctx(e, null)}
  ondragover={bgOver}
  ondragleave={(e) => { if (e.target === scroller) dropHere = false }}
  ondrop={bgDrop}
  onfocus={() => pane.app.setActive(pane.index)}
  style:--grid={gridTemplate}
  style:--thumb={`${thumb}px`}
>
  <div class="canvas" style:height={`${totalH}px`}>
    {#if view === 'details'}
      <div class="header" style:top={`${scrollTop}px`} oncontextmenu={headerMenu} role="row" tabindex="-1">
        {#each cols as c (c.id)}
          <button class="hcell {c.id}" class:sorted={pane.sort.key === c.id} onclick={() => pane.setSort(c.id)}>
            <span class="ellipsis">{COL_LABEL[c.id]}</span>
            {#if pane.sort.key === c.id}<Icon name={pane.sort.dir === 1 ? 'chevronUp' : 'chevronDown'} size={10} />{/if}
            <span class="grip" role="separator" onpointerdown={(e) => resize(e, c)} onclick={(e) => e.stopPropagation()} onkeydown={() => {}} tabindex="-1"></span>
          </button>
        {/each}
      </div>
    {/if}

    {#each visible as { row: r, i } (i)}
      {@const sel = isSel(r)}
      {@const k = kindOf(r.ext, r.dir)}
      {@const line = Math.floor(i / perRow)}
      {@const col = i % perRow}
      <div
        class="row"
        class:sel
        class:focus={i === pane.focus}
        class:cut={app.cutPaths.has(keyOf(r))}
        class:hidden-item={(r.attrs & ATTR.hidden) !== 0}
        class:drop={dropTarget === keyOf(r)}
        role="option"
        aria-selected={sel}
        tabindex="-1"
        draggable={!pane.renaming}
        style:transform={`translate(${view === 'details' ? 0 : 8 + col * cellW}px, ${top + line * cellH}px)`}
        style:width={view === 'details' ? undefined : `${cellW - 4}px`}
        style:height={`${cellH - (view === 'grid' ? 4 : 0)}px`}
        onmousedown={(e) => down(e, i)}
        onmouseup={() => up(i)}
        ondblclick={() => dbl(r)}
        onauxclick={(e) => aux(e, r)}
        oncontextmenu={(e) => { e.stopPropagation(); ctx(e, i) }}
        ondragstart={(e) => dragStart(e, i)}
        ondragover={(e) => rowOver(e, r)}
        ondragleave={() => (dropTarget = null)}
        ondrop={(e) => rowDrop(e, r)}
      >
        {#if view === 'grid'}
          <div class="thumb">
            {#if wantsThumb(r)}
              <img src={thumbUrl(r)} alt="" loading="lazy" decoding="async" draggable="false" onerror={(e) => ((e.currentTarget as HTMLImageElement).src = iconUrl(r, true))} />
            {:else if r.dir}
              <span class="big" style:color={KIND_COLOR.folder}><Icon name="folder" size={Math.round(thumb * 0.6)} /></span>
            {:else if sysIcon(r)}
              <img class="sysicon" src={iconUrl(r, true)} alt="" draggable="false" />
            {:else}
              <span class="big" style:color={KIND_COLOR[k]}><Icon name={KIND_ICON[k]} size={Math.round(thumb * 0.5)} /></span>
            {/if}
          </div>
          {#if pane.renaming === keyOf(r)}
            <input class="rename" use:renameMount={r} />
          {:else}
            <div class="gname" title={r.name}>{r.name}</div>
          {/if}
        {:else}
          {#each view === 'list' ? cols.filter((c) => c.id === 'name') : cols as c (c.id)}
            {#if c.id === 'name'}
              <div class="cell name">
                <span class="ico" style:color={KIND_COLOR[k]}>
                  {#if sysIcon(r)}
                    <img src={iconUrl(r)} alt="" width="16" height="16" draggable="false" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
                  {:else}
                    <Icon name={KIND_ICON[k]} />
                  {/if}
                  {#if r.link}<span class="linkbadge"><Icon name="link" size={9} /></span>{/if}
                </span>
                {#if pane.renaming === keyOf(r)}
                  <input class="rename" use:renameMount={r} />
                {:else}
                  <span class="ellipsis label" title={r.name}>{r.name}</span>
                  {#if r.olderRevs}<span class="revs" title={`${r.olderRevs} older revision(s) hidden — turn off "Group drawing revisions" to see them`}>+{r.olderRevs}</span>{/if}
                  {#if r.revUnknown}<span class="revq" title="Revision order can't be decided from the office rules — check manually"><Icon name="warning" size={12} /></span>{/if}
                  {#if cloudState(r.attrs)}<span class="cloud" title="Online-only (cloud) file"><Icon name="cloud" size={12} /></span>{/if}
                {/if}
              </div>
            {:else if c.id === 'size'}
              <div class="cell num">{r.dir ? '' : fmtSize(r.size)}</div>
            {:else if c.id === 'type'}
              <div class="cell dim ellipsis">{typeLabel(r.ext, r.dir)}</div>
            {:else if c.id === 'mtime'}
              <div class="cell dim">{fmtDate(r.mtime)}</div>
            {:else if c.id === 'ctime'}
              <div class="cell dim">{fmtDate(r.ctime)}</div>
            {:else if c.id === 'attrs'}
              <div class="cell dim mono">{attrText(r.attrs)}</div>
            {:else if c.id === 'rev'}
              <div class="cell">{r.rev ?? ''}</div>
            {/if}
          {/each}
        {/if}
      </div>
    {/each}

    {#if marquee}
      <div class="marquee" style:left={`${Math.min(marquee.x0, marquee.x1)}px`} style:top={`${Math.min(marquee.y0, marquee.y1)}px`} style:width={`${Math.abs(marquee.x1 - marquee.x0)}px`} style:height={`${Math.abs(marquee.y1 - marquee.y0)}px`}></div>
    {/if}
  </div>

  {#if !rows.length && !pane.loading}
    <div class="empty">
      {#if pane.error}
        <Icon name="warning" size={28} />
        <div class="subtitle">Can’t open this location</div>
        <div class="caption">{pane.error}</div>
        <button class="btn sm" onclick={() => pane.refresh()}>Try again</button>
      {:else if pane.filter}
        <div class="caption">No items match “{pane.filter}”.</div>
      {:else if pane.searchInfo}
        <div class="caption">{pane.searchInfo.done ? 'No results.' : 'Searching…'}</div>
      {:else}
        <div class="caption">This folder is empty.</div>
      {/if}
    </div>
  {/if}
  {#if pane.loading && !rows.length}
    <div class="loading"><span class="bar"></span></div>
  {/if}
</div>

<style>
  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    position: relative;
    outline: none;
    contain: strict;
  }
  .list.drop-here {
    box-shadow: inset 0 0 0 2px var(--accent);
    border-radius: var(--r-md);
  }
  .canvas {
    position: relative;
    min-width: 100%;
  }
  .header {
    position: absolute;
    left: 0;
    right: 0;
    height: 32px;
    display: grid;
    grid-template-columns: var(--grid);
    z-index: 3;
    background: var(--card-solid);
    border-bottom: 1px solid var(--divider);
    padding: 0 8px;
  }
  .hcell {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 100%;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    padding: 0 8px;
    text-align: left;
    min-width: 0;
  }
  .hcell:hover {
    background: var(--hover);
  }
  .hcell.size {
    justify-content: flex-end;
  }
  .hcell.sorted {
    color: var(--text);
  }
  .grip {
    position: absolute;
    right: -3px;
    top: 6px;
    bottom: 6px;
    width: 7px;
    cursor: col-resize;
    border-right: 1px solid var(--divider);
    margin-right: 3px;
  }
  .row {
    position: absolute;
    left: 0;
    top: 0;
    will-change: transform;
    border-radius: var(--r-sm);
    color: var(--text);
  }
  .v-details .row {
    right: 0;
    display: grid;
    grid-template-columns: var(--grid);
    align-items: center;
    margin: 0 8px;
    padding: 0;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.sel {
    background: var(--sel);
  }
  .row.sel:hover {
    background: var(--sel-strong);
  }
  .list:focus-within .row.focus {
    box-shadow: inset 0 0 0 1px var(--stroke-strong);
  }
  .row.sel.focus::before {
    content: '';
    position: absolute;
    left: 0;
    top: 25%;
    bottom: 25%;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  .v-grid .row.sel.focus::before {
    display: none;
  }
  .row.cut,
  .row.hidden-item {
    opacity: 0.55;
  }
  .row.drop {
    background: var(--sel-strong);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .cell {
    padding: 0 8px;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
  }
  .cell.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
  }
  .cell.dim {
    color: var(--text-2);
  }
  .cell.mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .cell.name {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 10px;
  }
  .list .row:not(.sel) .cell.name {
    color: var(--text);
  }
  .label {
    flex: 1;
    min-width: 0;
  }
  .ico {
    width: 18px;
    height: 18px;
    flex: none;
    display: grid;
    place-items: center;
    position: relative;
  }
  .ico :global(.icon-svg) {
    width: 18px;
    height: 18px;
  }
  .ico img {
    width: 16px;
    height: 16px;
  }
  .linkbadge {
    position: absolute;
    left: -3px;
    bottom: -3px;
    background: var(--card-solid);
    border-radius: 3px;
    display: grid;
    color: var(--text);
  }
  .revs {
    font-size: 11px;
    color: var(--text-2);
    background: var(--stroke-2);
    border-radius: 8px;
    padding: 0 6px;
    line-height: 16px;
  }
  .revq {
    color: var(--warn);
    display: flex;
  }
  .cloud {
    color: var(--text-3);
    display: flex;
  }
  .v-list .row {
    display: flex;
    align-items: center;
  }
  .v-list .cell.name {
    width: 100%;
  }
  .v-grid .row {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 6px 4px;
    gap: 4px;
  }
  .thumb {
    width: var(--thumb);
    height: var(--thumb);
    display: grid;
    place-items: center;
    flex: none;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: var(--shadow-card);
  }
  .thumb img.sysicon {
    width: 48px;
    height: 48px;
    box-shadow: none;
  }
  .big {
    display: grid;
  }
  .gname {
    font-size: 12px;
    line-height: 16px;
    text-align: center;
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    max-width: 100%;
  }
  .rename {
    flex: 1;
    min-width: 0;
    height: 24px;
    border: 1px solid var(--accent);
    border-radius: var(--r-sm);
    background: var(--card-solid);
    padding: 0 6px;
    outline: none;
    user-select: text;
  }
  .v-grid .rename {
    width: 100%;
    flex: none;
    text-align: center;
  }
  .marquee {
    position: absolute;
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    pointer-events: none;
    z-index: 4;
  }
  .empty {
    position: absolute;
    inset: 80px 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--text-2);
    pointer-events: none;
    text-align: center;
    padding: 0 24px;
  }
  .empty .btn {
    pointer-events: auto;
  }
  .loading {
    position: absolute;
    top: 32px;
    left: 0;
    right: 0;
    height: 2px;
    overflow: hidden;
  }
  .loading .bar {
    position: absolute;
    width: 30%;
    height: 100%;
    background: var(--accent);
    animation: slide 1s var(--ease) infinite;
  }
  @keyframes slide {
    from {
      left: -30%;
    }
    to {
      left: 100%;
    }
  }
</style>
