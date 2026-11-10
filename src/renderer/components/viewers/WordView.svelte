<script lang="ts">
  // Word document shown as a sheet of "paper": the engine's HTML, sanitised here, with
  // Ctrl+wheel zoom. In a narrow panel the paper reflows to the panel width instead of shrinking.
  import Icon from '../Icon.svelte'
  import { sanitizeHtml } from '../../lib/sanitize'

  let { html, notes = [], onexpand }: { html: string; notes?: string[]; onexpand?: () => void } = $props()

  const PAPER = 794 // A4 width at 96 dpi

  let scroller: HTMLDivElement | undefined = $state()
  let zoom = $state(1)
  let width = $state(0)
  let showNotes = $state(false)
  const safe = $derived(sanitizeHtml(html))
  const narrow = $derived(width > 0 && width < 620)

  $effect(() => {
    if (!scroller) return
    const ro = new ResizeObserver(() => scroller && (width = scroller.clientWidth))
    ro.observe(scroller)
    return () => ro.disconnect()
  })

  function setZoom(z: number) {
    const next = Math.max(0.3, Math.min(4, z))
    if (!scroller) return void (zoom = next)
    const k = next / zoom
    const t = (scroller.scrollTop + scroller.clientHeight / 2) * k - scroller.clientHeight / 2
    zoom = next
    requestAnimationFrame(() => scroller && (scroller.scrollTop = t))
  }

  function wheel(e: WheelEvent) {
    if (!e.ctrlKey) return
    e.preventDefault()
    setZoom(zoom * Math.exp(-e.deltaY * 0.0012))
  }

  function key(e: KeyboardEvent) {
    if (e.key === '+' || e.key === '=') setZoom(zoom * 1.15)
    else if (e.key === '-') setZoom(zoom / 1.15)
    else if (e.key === '0') setZoom(1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="word" tabindex="0" onkeydown={key} role="document" aria-label="Document">
  <div class="bar">
    <button class="notes caption ellipsis" onclick={() => (showNotes = !showNotes)} title="What this view leaves out"><Icon name="info" size={14} /> Simplified view{notes.length > 1 ? ` · ${notes.length} notes` : ''}</button>
    <span class="spacer"></span>
    <button class="btn subtle icon sm" title="Zoom out (Ctrl+wheel, -)" onclick={() => setZoom(zoom / 1.15)}><Icon name="zoomOut" /></button>
    <span class="caption pct">{Math.round(zoom * 100)}%</span>
    <button class="btn subtle icon sm" title="Zoom in (Ctrl+wheel, +)" onclick={() => setZoom(zoom * 1.15)}><Icon name="zoomIn" /></button>
    <button class="btn subtle sm" title="100% (0)" onclick={() => setZoom(1)}>100%</button>
    {#if onexpand}<button class="btn subtle icon sm" title="View in full window" onclick={onexpand}><Icon name="fullscreen" /></button>{/if}
  </div>
  {#if showNotes}
    <div class="caption all">{#each notes as n (n)}<div>{n}</div>{/each}</div>
  {/if}
  <div class="scroll" bind:this={scroller} onwheel={wheel} ondblclick={() => onexpand?.()} role="presentation">
    <div class="paper" class:narrow style:zoom={zoom} style:width={narrow ? `${Math.max(240, (width - 18) / zoom)}px` : `${PAPER}px`}>
      {@html safe}
    </div>
  </div>
</div>

<style>
  .word {
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
    min-width: 0;
  }
  .notes {
    border: 0;
    background: none;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    min-width: 0;
    color: var(--text-2);
  }
  .all {
    padding: 0 2px 6px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .pct {
    min-width: 40px;
    text-align: center;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-radius: var(--r-md);
    background: var(--stroke-2);
    border: 1px solid var(--stroke);
    padding: 12px 8px;
  }
  .paper {
    margin: 0 auto;
    background: white;
    color: black;
    box-shadow: var(--shadow-card);
    padding: 72px 76px;
    min-height: 1000px;
    font: 11pt/1.45 Calibri, 'Segoe UI', sans-serif;
    user-select: text;
    overflow-wrap: break-word;
  }
  .paper.narrow {
    padding: 18px 16px;
    min-height: 0;
    font-size: 10pt;
  }
  .paper :global(h1) {
    font-size: 18pt;
    margin: 14pt 0 6pt;
  }
  .paper :global(h2) {
    font-size: 14pt;
    margin: 12pt 0 5pt;
  }
  .paper :global(h3),
  .paper :global(h4) {
    font-size: 12pt;
    margin: 10pt 0 4pt;
  }
  .paper :global(p) {
    margin: 0 0 8pt;
    min-height: 1em;
  }
  .paper :global(table) {
    border-collapse: collapse;
    margin: 6pt 0 10pt;
    width: 100%;
    table-layout: auto;
  }
  .paper :global(td),
  .paper :global(th) {
    border: 1px solid rgba(0, 0, 0, 0.45);
    padding: 3pt 5pt;
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  .paper :global(td p),
  .paper :global(th p) {
    margin: 0 0 3pt;
  }
  .paper :global(img) {
    max-width: 100%;
    height: auto;
  }
  .paper :global(.omitted) {
    display: inline-block;
    padding: 2pt 6pt;
    border: 1px dashed rgba(0, 0, 0, 0.45);
    font-size: 9pt;
    color: rgba(0, 0, 0, 0.6);
  }
  .paper :global(ul),
  .paper :global(ol) {
    margin: 0 0 8pt;
    padding-left: 22pt;
  }
</style>
