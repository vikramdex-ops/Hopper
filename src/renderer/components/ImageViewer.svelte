<script lang="ts">
  import { app } from '../lib/app.svelte'
  import { fmtSize } from '../lib/format'
  import Icon from './Icon.svelte'

  let zoom = $state(0) // 0 = fit
  let rot = $state(0)
  let pan = $state({ x: 0, y: 0 })
  let natural = $state({ w: 0, h: 0 })
  let slideshow = $state(false)
  let stage: HTMLDivElement | undefined = $state()

  const v = $derived(app.viewer)
  const cur = $derived(v ? v.entries[v.index] : null)
  const enc = encodeURIComponent
  const src = $derived(cur ? `hopper://file/?p=${enc(cur.path)}` : '')
  // Small, cached shell thumbnails for the strip; only the window around the current image.
  const strip = $derived.by(() => {
    if (!v) return []
    const start = Math.max(0, v.index - 12)
    return v.entries.slice(start, start + 25).map((e, k) => ({ e, i: start + k }))
  })

  $effect(() => {
    void cur?.path
    zoom = 0
    rot = 0
    pan = { x: 0, y: 0 }
  })

  $effect(() => {
    if (!slideshow || !v) return
    const t = setInterval(() => step(1), 3500)
    return () => clearInterval(t)
  })

  function step(d: number) {
    if (!v) return
    const n = v.entries.length
    app.viewer = { ...v, index: (v.index + d + n) % n }
    const e = app.viewer.entries[app.viewer.index]
    const i = app.active.rows.findIndex((r) => r.path === e.path)
    if (i >= 0) app.active.selectIndex(i)
  }

  function close() {
    slideshow = false
    app.viewer = null
  }

  const fitScale = $derived.by(() => {
    if (!stage || !natural.w) return 1
    const r = rot % 180 !== 0
    const w = r ? natural.h : natural.w
    const h = r ? natural.w : natural.h
    return Math.min(1, (stage.clientWidth - 40) / w, (stage.clientHeight - 40) / h)
  })
  const scale = $derived(zoom || fitScale)

  function wheel(e: WheelEvent) {
    e.preventDefault()
    const next = Math.max(0.05, Math.min(16, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    // zoom towards the cursor
    const r = stage!.getBoundingClientRect()
    const cx = e.clientX - r.left - r.width / 2 - pan.x
    const cy = e.clientY - r.top - r.height / 2 - pan.y
    const k = next / scale
    pan = { x: pan.x - cx * (k - 1), y: pan.y - cy * (k - 1) }
    zoom = next
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
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  function key(e: KeyboardEvent) {
    if (!app.viewer) return
    const handled = true
    switch (e.key) {
      case 'Escape': close(); break
      case 'ArrowRight': case 'PageDown': case ' ': step(1); break
      case 'ArrowLeft': case 'PageUp': case 'Backspace': step(-1); break
      case 'Home': app.viewer = { ...app.viewer, index: 0 }; break
      case 'End': app.viewer = { ...app.viewer, index: app.viewer.entries.length - 1 }; break
      case '+': case '=': zoom = Math.min(16, scale * 1.25); break
      case '-': zoom = Math.max(0.05, scale / 1.25); break
      case '0': zoom = 0; pan = { x: 0, y: 0 }; break
      case '1': zoom = 1; pan = { x: 0, y: 0 }; break
      case ']': case 'r': rot = (rot + 90) % 360; break
      case '[': rot = (rot + 270) % 360; break
      case 'Enter': if (cur) void app.openEntry(cur); break
      default: return
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
</script>

<svelte:window onkeydowncapture={key} />

{#if v && cur}
  <div class="viewer" role="dialog" aria-label={`Image viewer: ${cur.name}`}>
    <header>
      <span class="name ellipsis">{cur.name}</span>
      <span class="caption">{v.index + 1} / {v.entries.length} · {natural.w ? `${natural.w} × ${natural.h} · ` : ''}{fmtSize(cur.size)} · {Math.round(scale * 100)}%</span>
      <span class="spacer"></span>
      <button class="btn subtle icon sm" title="Zoom out (-)" onclick={() => (zoom = Math.max(0.05, scale / 1.25))}><Icon name="zoomOut" /></button>
      <button class="btn subtle sm" title="Fit (0)" onclick={() => { zoom = 0; pan = { x: 0, y: 0 } }}>Fit</button>
      <button class="btn subtle sm" title="Actual size (1)" onclick={() => { zoom = 1; pan = { x: 0, y: 0 } }}>1:1</button>
      <button class="btn subtle icon sm" title="Zoom in (+)" onclick={() => (zoom = Math.min(16, scale * 1.25))}><Icon name="zoomIn" /></button>
      <button class="btn subtle icon sm" title="Rotate (R)" onclick={() => (rot = (rot + 90) % 360)}><Icon name="rotate" /></button>
      <button class="btn subtle icon sm" class:on={slideshow} title="Slideshow" onclick={() => (slideshow = !slideshow)}><Icon name={slideshow ? 'pause' : 'play'} /></button>
      <button class="btn subtle icon sm" title="Open with default app (Enter)" onclick={() => app.openEntry(cur)}><Icon name="open" /></button>
      <button class="btn subtle icon sm" title="Close (Esc)" onclick={close}><Icon name="close" /></button>
    </header>
    <div class="stage" bind:this={stage} onwheel={wheel} onpointerdown={drag} ondblclick={() => (zoom = zoom ? 0 : 1, pan = { x: 0, y: 0 })} role="presentation">
      {#key cur.path}
        <img
          {src}
          alt={cur.name}
          draggable="false"
          onload={(e) => (natural = { w: (e.currentTarget as HTMLImageElement).naturalWidth, h: (e.currentTarget as HTMLImageElement).naturalHeight })}
          style:transform={`translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg) scale(${scale})`}
        />
      {/key}
      <button class="nav prev" aria-label="Previous" onclick={(e) => { e.stopPropagation(); step(-1) }}><Icon name="chevronLeft" size={20} /></button>
      <button class="nav next" aria-label="Next" onclick={(e) => { e.stopPropagation(); step(1) }}><Icon name="chevronRight" size={20} /></button>
    </div>
    <div class="strip">
      {#each strip as s (s.e.path)}
        <button class="th" class:on={s.i === v.index} onclick={() => (app.viewer = { ...v, index: s.i })} title={s.e.name}>
          <img src={`hopper://thumb/?p=${enc(s.e.path)}&s=96&v=${s.e.mtime}-${s.e.size}`} alt="" loading="lazy" />
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 980;
    display: flex;
    flex-direction: column;
    background: rgba(12, 12, 12, 0.96);
    color: #fff;
    --text: #fff;
    --text-2: rgba(255, 255, 255, 0.75);
    --hover: rgba(255, 255, 255, 0.08);
  }
  header {
    height: 48px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 150px 0 16px;
    -webkit-app-region: drag;
  }
  header :global(.btn) {
    -webkit-app-region: no-drag;
    color: #fff;
  }
  .name {
    font-weight: 600;
    max-width: 40%;
  }
  .caption {
    color: rgba(255, 255, 255, 0.6);
  }
  .on {
    background: rgba(255, 255, 255, 0.12) !important;
  }
  .stage {
    flex: 1;
    position: relative;
    overflow: hidden;
    display: grid;
    place-items: center;
    cursor: grab;
  }
  .stage img {
    max-width: none;
    transform-origin: center;
    image-rendering: auto;
    user-select: none;
  }
  .nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 40px;
    height: 64px;
    border: 0;
    border-radius: var(--r-md);
    background: rgba(255, 255, 255, 0.06);
    color: #fff;
    display: grid;
    place-items: center;
    opacity: 0;
    transition: opacity var(--fast);
  }
  .stage:hover .nav {
    opacity: 1;
  }
  .prev {
    left: 12px;
  }
  .next {
    right: 12px;
  }
  .strip {
    height: 84px;
    display: flex;
    gap: 6px;
    justify-content: center;
    padding: 8px;
    overflow: hidden;
  }
  .th {
    width: 68px;
    height: 68px;
    border: 2px solid transparent;
    border-radius: var(--r-md);
    background: rgba(255, 255, 255, 0.05);
    padding: 2px;
    flex: none;
  }
  .th.on {
    border-color: var(--accent);
  }
  .th img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 4px;
  }
</style>
