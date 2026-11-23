<script lang="ts">
  // What a running search looks like, in the Dexterity "Line of flow" language: the search root
  // is the source, the main run carries pulses, every folder the walk opens branches off it, and
  // each hit drops into the collector at the far end. `compact` is the slim strip shown on top of
  // results that are already listed while the walk goes on.
  import type { Pane } from '../lib/pane.svelte'
  import { basename } from '../lib/format'
  import Icon from './Icon.svelte'

  let { pane, compact = false }: { pane: Pane; compact?: boolean } = $props()

  const info = $derived(pane.searchInfo)
  const words = $derived((new URLSearchParams(pane.path.split('?')[1] ?? '').get('q') ?? '').split(/\s+/).filter(Boolean).slice(0, 6))
  const source = $derived(info?.roots?.length === 1 ? basename(info.roots[0]) || info.roots[0] : `${info?.roots?.length ?? 0} places`)

  // a clock for elapsed time and rate (stops with the search); keyed on running alone, since
  // info is replaced on every progress tick and would restart the timers
  const running = $derived(!!info && !info.done)
  let now = $state(Date.now())
  $effect(() => {
    if (!running) return
    const t = setInterval(() => (now = Date.now()), 250)
    return () => clearInterval(t)
  })
  const secs = $derived(info?.started ? Math.max(0, (now - info.started) / 1000) : 0)
  const rate = $derived(secs > 0.5 && info ? Math.round(info.scanned / secs) : 0)

  // index answers arrive in ~100 ms: show the scene only when there is a wait to fill
  let shown = $state(false)
  $effect(() => {
    if (!running) return
    const t = setTimeout(() => (shown = true), 300)
    return () => clearTimeout(t)
  })

  // branches: one per folder the walk reports, a few alive at a time
  const SLOTS = [118, 176, 234, 292, 350, 408]
  type Branch = { id: number; x: number; up: boolean; name: string }
  let branches = $state<Branch[]>([])
  let seq = 0
  let lastAt = ''
  $effect(() => {
    const at = info?.at
    if (compact || !at || at === lastAt || info?.done) return
    lastAt = at
    const id = ++seq
    branches = [...branches.slice(-5), { id, x: SLOTS[id % SLOTS.length], up: id % 2 === 0, name: basename(at) || at }]
    setTimeout(() => (branches = branches.filter((b) => b.id !== id)), 2600)
  })

  // drops: each new hit travels down the run into the collector
  let drops = $state<number[]>([])
  let prevHits = 0
  let pop = $state(0)
  $effect(() => {
    const h = info?.hits ?? 0
    if (compact || h <= prevHits) {
      prevHits = h
      return
    }
    const n = Math.min(3, h - prevHits)
    prevHits = h
    pop++
    for (let k = 0; k < n; k++) {
      const id = ++seq
      setTimeout(() => {
        drops = [...drops, id]
        setTimeout(() => (drops = drops.filter((d) => d !== id)), 1100)
      }, k * 160)
    }
  })

  const fmt = (n: number) => n.toLocaleString('en-GB')
  const fmtSecs = (s: number) => (s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`)
</script>

{#if info && !info.done}
  {#if compact}
    <div class="strip" role="progressbar" aria-label="Still searching" title={`Still searching… ${fmt(info.scanned)} looked at${info.at ? ` · now in ${info.at}` : ''}`}></div>
  {:else if shown}
    <div class="flow" role="status" aria-live="polite" aria-label={`Searching ${source}: ${fmt(info.scanned)} items looked at, ${info.hits} found`}>
      <svg viewBox="0 0 520 200" class="route" aria-hidden="true">
        <!-- branches: folders the walk is opening -->
        {#each branches as b (b.id)}
          <g class="branch" style={`--x:${b.x}px`}>
            <path class="seg" pathLength="1" d={b.up ? `M${b.x} 100 V70 q0 -12 12 -12 H${b.x + 46}` : `M${b.x} 100 V130 q0 12 12 12 H${b.x + 46}`} />
            <circle class="tee" cx={b.x} cy="100" r="3.2" />
            <text x={b.x + 14} y={b.up ? 50 : 160}>{b.name.length > 18 ? b.name.slice(0, 17) + '…' : b.name}</text>
          </g>
        {/each}
        <!-- the main run, from the source to the collector -->
        <path class="run" pathLength="1" d="M58 100 H452" />
        <path class="pulse" pathLength="1" d="M58 100 H452" />
        {#each drops as d (d)}
          <circle class="drop" r="4.5" cy="100" />
        {/each}
        <!-- source: where the search looks -->
        <g class="source">
          <circle cx="40" cy="100" r="18" />
          <path d="M33 93h6l2 2.5h8v10.5h-16z" />
        </g>
        <!-- collector: what was found -->
        <g class="collector">
          <circle cx="474" cy="100" r="22" />
          {#key pop}<text class="count" x="474" y="105">{info.hits > 999 ? '999+' : info.hits}</text>{/key}
        </g>
      </svg>

      <div class="title">Searching {source}</div>
      {#if words.length}
        <div class="words">
          {#each words as w, i (i)}<span class="word" style={`animation-delay:${i * 0.25}s`}>{w}</span>{/each}
        </div>
      {/if}
      <div class="at" title={info.at}>
        {#if info.at}<span>Looking in</span> <span class="path">{info.at}</span>{:else}Opening the first folders…{/if}
      </div>
      <div class="stats">
        <span><b>{fmt(info.scanned)}</b> looked at</span>
        {#if info.folders}<span><b>{fmt(info.folders)}</b> folders</span>{/if}
        {#if rate}<span><b>{fmt(rate)}</b>/s</span>{/if}
        <span>{fmtSecs(secs)}</span>
      </div>
      <button type="button" class="btn sm stop" onclick={() => pane.stopSearch()} disabled={info.stopped}>
        <Icon name="close" size={14} /> {info.stopped ? 'Stopping…' : 'Stop search'}
      </button>
    </div>
  {/if}
{/if}

<style>
  .flow {
    --amber: #f7af44;
    --flow-ease: cubic-bezier(0.65, 0, 0.35, 1);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: min(520px, 100%);
    animation: rise 0.35s cubic-bezier(0.2, 0.7, 0.2, 1);
    pointer-events: auto;
  }
  .route {
    width: 100%;
    height: auto;
    overflow: visible;
    color: var(--accent);
  }
  .run {
    fill: none;
    stroke: currentColor;
    stroke-width: 6;
    stroke-linecap: round;
    opacity: 0.22;
  }
  .pulse {
    fill: none;
    stroke: currentColor;
    stroke-width: 6;
    stroke-linecap: round;
    stroke-dasharray: 0.035 0.045;
    animation: run 0.9s linear infinite;
  }
  .seg {
    fill: none;
    stroke: currentColor;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    opacity: 0.7;
    animation: draw 0.7s var(--flow-ease) forwards;
  }
  .branch {
    animation: fadeout 2.6s ease-in forwards;
  }
  .tee {
    fill: currentColor;
  }
  .branch text {
    font: 11px var(--font, 'Segoe UI', sans-serif);
    fill: var(--text-2);
    opacity: 0;
    animation: rise 0.4s 0.35s forwards;
  }
  .source circle {
    fill: currentColor;
    animation: breathe 1.8s ease-in-out infinite;
  }
  .source path {
    fill: var(--on-accent, #fff);
  }
  .collector circle {
    fill: none;
    stroke: var(--amber);
    stroke-width: 4;
  }
  .count {
    font: 600 14px var(--font, 'Segoe UI', sans-serif);
    fill: var(--text);
    text-anchor: middle;
    transform-box: fill-box;
    transform-origin: center;
    animation: pop 0.45s cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  .drop {
    fill: var(--amber);
    animation: travel 1.1s var(--flow-ease) forwards;
  }
  .title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }
  .words {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .word {
    padding: 2px 9px;
    border-radius: 999px;
    border: 1px solid var(--stroke-strong);
    color: var(--text);
    font-size: 12px;
    animation: glint 2.4s ease-in-out infinite;
  }
  .at {
    display: flex;
    gap: 6px;
    max-width: 100%;
    font-size: 12px;
    color: var(--text-3);
    white-space: nowrap;
  }
  .at .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl; /* keep the deep end of a long path visible */
    font-family: 'Cascadia Mono', Consolas, monospace;
  }
  .stats {
    display: flex;
    gap: 14px;
    font-size: 12px;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .stats b {
    color: var(--text);
    font-weight: 600;
  }
  .stop {
    margin-top: 6px;
    pointer-events: auto;
  }
  .strip {
    position: absolute;
    top: 32px;
    left: 0;
    right: 0;
    height: 3px;
    z-index: 2;
    background: repeating-linear-gradient(90deg, var(--accent) 0 14px, transparent 14px 34px);
    background-size: 34px 3px;
    opacity: 0.75;
    animation: stream 0.6s linear infinite;
  }

  @keyframes run {
    from { stroke-dashoffset: 0; }
    to { stroke-dashoffset: -0.08; }
  }
  @keyframes draw {
    to { stroke-dashoffset: 0; }
  }
  @keyframes fadeout {
    0%, 70% { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes travel {
    from { cx: 58px; opacity: 1; }
    85% { opacity: 1; }
    to { cx: 470px; opacity: 0; }
  }
  @keyframes breathe {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  @keyframes pop {
    0% { transform: scale(0.5); opacity: 0; }
    70% { transform: scale(1.18); opacity: 1; }
    100% { transform: none; }
  }
  @keyframes glint {
    0%, 100% { border-color: var(--stroke-strong); }
    50% { border-color: var(--accent); }
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes stream {
    to { background-position: 34px 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .flow, .pulse, .seg, .branch, .branch text, .source circle, .count, .word, .strip { animation: none; }
    .seg { stroke-dashoffset: 0; }
    .branch text { opacity: 1; }
    .drop { display: none; }
  }
</style>
