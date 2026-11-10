<script lang="ts">
  // Zoom and pan for one picture (saved CAD previews). Ctrl+wheel zooms at the cursor; with
  // `plainWheel` the wheel zooms without Ctrl, as in the full-window viewer.
  import Icon from '../Icon.svelte'

  let { src, alt = '', plainWheel = false, dark = false, onexpand, onerror }: { src: string; alt?: string; plainWheel?: boolean; dark?: boolean; onexpand?: () => void; onerror?: () => void } = $props()

  let stage: HTMLDivElement | undefined = $state()
  let zoom = $state(0) // 0 = fit
  let pan = $state({ x: 0, y: 0 })
  let natural = $state({ w: 0, h: 0 })
  let box = $state({ w: 0, h: 0 })

  // Small saved previews may be enlarged up to 3x to fill the space; beyond that they only blur.
  const fitScale = $derived(natural.w && box.w ? Math.min(3, (box.w - 16) / natural.w, (box.h - 16) / natural.h) : 1)
  const scale = $derived(zoom || fitScale)

  $effect(() => {
    void src
    zoom = 0
    pan = { x: 0, y: 0 }
  })

  $effect(() => {
    if (!stage) return
    const ro = new ResizeObserver(() => stage && (box = { w: stage.clientWidth, h: stage.clientHeight }))
    ro.observe(stage)
    return () => ro.disconnect()
  })

  function zoomAt(next: number, cx?: number, cy?: number) {
    if (!stage) return
    next = Math.max(0.05, Math.min(32, next))
    const r = stage.getBoundingClientRect()
    const ax = (cx ?? r.left + r.width / 2) - r.left - r.width / 2 - pan.x
    const ay = (cy ?? r.top + r.height / 2) - r.top - r.height / 2 - pan.y
    const k = next / scale
    pan = { x: pan.x - ax * (k - 1), y: pan.y - ay * (k - 1) }
    zoom = next
  }

  function wheel(e: WheelEvent) {
    if (!plainWheel && !e.ctrlKey) return
    e.preventDefault()
    zoomAt(scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
  }

  function drag(e: PointerEvent) {
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const sx = e.clientX - pan.x
    const sy = e.clientY - pan.y
    const move = (ev: PointerEvent) => (pan = { x: ev.clientX - sx, y: ev.clientY - sy })
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const reset = () => {
    zoom = 0
    pan = { x: 0, y: 0 }
  }

  function key(e: KeyboardEvent) {
    if (e.key === '+' || e.key === '=') zoomAt(scale * 1.25)
    else if (e.key === '-') zoomAt(scale / 1.25)
    else if (e.key === '0') reset()
    else return
    e.preventDefault()
    e.stopPropagation()
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="pan" tabindex="0" onkeydown={key} role="group" aria-label="Picture">
  <div class="bar">
    <span class="caption">{natural.w ? `${natural.w} × ${natural.h} px` : ''}</span>
    <span class="spacer"></span>
    <button class="btn subtle icon sm" title="Zoom out (Ctrl+wheel, -)" onclick={() => zoomAt(scale / 1.25)}><Icon name="zoomOut" /></button>
    <span class="caption pct">{Math.round(scale * 100)}%</span>
    <button class="btn subtle icon sm" title="Zoom in (Ctrl+wheel, +)" onclick={() => zoomAt(scale * 1.25)}><Icon name="zoomIn" /></button>
    <button class="btn subtle sm" class:on={!zoom} title="Fit (0)" onclick={reset}>Fit</button>
    {#if onexpand}<button class="btn subtle icon sm" title="View in full window" onclick={onexpand}><Icon name="fullscreen" /></button>{/if}
  </div>
  <div class="stage" class:dark bind:this={stage} onwheel={wheel} onpointerdown={drag} ondblclick={() => (onexpand ? onexpand() : reset())} role="presentation">
    <img
      {src}
      {alt}
      draggable="false"
      onload={(e) => (natural = { w: (e.currentTarget as HTMLImageElement).naturalWidth, h: (e.currentTarget as HTMLImageElement).naturalHeight })}
      onerror={() => onerror?.()}
      style:transform={`translate(${pan.x}px, ${pan.y}px) scale(${scale})`}
      style:image-rendering={scale >= 4 ? 'pixelated' : 'auto'}
    />
  </div>
</div>

<style>
  .pan {
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
  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
    display: grid;
    place-items: center;
    cursor: grab;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: repeating-conic-gradient(var(--stroke) 0 25%, transparent 0 50%) 0 0 / 16px 16px;
  }
  .stage.dark {
    background: black;
  }
  .stage img {
    max-width: none;
    transform-origin: center;
    user-select: none;
  }
</style>
