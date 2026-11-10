<script lang="ts">
  // The progress window for copy, move, delete, zip and extract: Hopper's own, on top of the
  // file list while the work runs. The Transfers panel keeps the full history.
  import { app } from '../lib/app.svelte'
  import { engine } from '../lib/api'
  import { basename, dirname, fmtDate, fmtEta, fmtRate, fmtSize, plural } from '../lib/format'
  import type { JobInfo } from '@shared/types'
  import Icon from './Icon.svelte'

  const SHOWN = ['copy', 'move', 'delete', 'zip', 'extract']
  const LIVE = ['running', 'queued', 'paused', 'waiting']
  const VERB: Record<string, string> = { copy: 'Copying', move: 'Moving', delete: 'Deleting', zip: 'Compressing', extract: 'Extracting' }

  /** jobs the user sent to the background with "Hide" */
  let hidden = $state<string[]>([])
  /** finished jobs still shown: with problems until dismissed, clean ones for a moment */
  let kept = $state<string[]>([])
  let details = $state<string | null>(null)
  let applyAll = $state(true)
  let pos = $state<{ x: number; y: number } | null>(null)

  const on = $derived(app.settings?.progressPopup !== false)
  const jobs = $derived(app.jobs.filter((j) => SHOWN.includes(j.kind) && !hidden.includes(j.id) && (LIVE.includes(j.state) || kept.includes(j.id))))
  const conflict = $derived(app.conflicts.find((c) => jobs.some((j) => j.id === c.jobId)))

  const seen = new Set<string>()
  $effect(() => {
    for (const j of app.jobs) {
      if (!SHOWN.includes(j.kind)) continue
      if (LIVE.includes(j.state)) {
        seen.add(j.id)
      } else if (seen.has(j.id)) {
        // just finished while its window was up
        seen.delete(j.id)
        if (hidden.includes(j.id)) continue
        const id = j.id
        const trouble = j.state === 'failed' || j.errors.length > 0
        if (j.state === 'cancelled') continue
        kept = [...kept, id]
        if (!trouble) setTimeout(() => (kept = kept.filter((k) => k !== id)), 1500)
      }
    }
  })

  const pct = (j: JobInfo) => (j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : j.filesTotal ? Math.min(100, Math.round((j.files / j.filesTotal) * 100)) : 0)
  function hide(j: JobInfo) {
    if (LIVE.includes(j.state)) hidden = [...hidden, j.id]
    else kept = kept.filter((k) => k !== j.id)
  }
  function hideAll() {
    for (const j of jobs) hide(j)
  }
  function openTransfers() {
    hideAll()
    app.drawer = true
  }
  function show(j: JobInfo, where: string) {
    void app.reveal(where)
    hide(j)
  }

  function drag(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return
    const box = (e.currentTarget as HTMLElement).parentElement!
    const r = box.getBoundingClientRect()
    const dx = e.clientX - r.left
    const dy = e.clientY - r.top
    const move = (m: PointerEvent) => {
      pos = { x: Math.max(8, Math.min(window.innerWidth - r.width - 8, m.clientX - dx)), y: Math.max(8, Math.min(window.innerHeight - 60, m.clientY - dy)) }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
</script>

{#if on && jobs.length}
  <div class="pp" role="dialog" aria-label="File operation progress" style:left={pos ? `${pos.x}px` : undefined} style:top={pos ? `${pos.y}px` : undefined} class:placed={!!pos}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header onpointerdown={drag}>
      <Icon name="activity" size={15} />
      <span class="subtitle">{jobs.length === 1 ? (VERB[jobs[0].kind] ?? 'Working') : `${jobs.length} operations`}</span>
      <span class="spacer"></span>
      <button class="btn subtle icon sm" title="Open the Transfers panel (Ctrl+J)" aria-label="Open the Transfers panel" onclick={openTransfers}><Icon name="chevronDown" /></button>
      <button class="btn subtle icon sm" title="Hide. The work continues in the background." aria-label="Hide" onclick={hideAll}><Icon name="close" /></button>
    </header>

    {#if conflict}
      <div class="conflict">
        <div class="ctitle"><Icon name="warning" /> <span><b>{basename(conflict.dst.path)}</b> already exists in this folder</span></div>
        <div class="cmp">
          <span>Incoming: {fmtSize(conflict.src.size)} · {fmtDate(conflict.src.mtime)}{conflict.src.mtime > conflict.dst.mtime + 2000 ? ' · newer' : ''}</span>
          <span>Existing: {fmtSize(conflict.dst.size)} · {fmtDate(conflict.dst.mtime)}{conflict.dst.mtime > conflict.src.mtime + 2000 ? ' · newer' : ''}</span>
        </div>
        <label class="check"><input type="checkbox" bind:checked={applyAll} /> Do this for all conflicts</label>
        <div class="cbtns">
          <button class="btn primary sm" onclick={() => app.resolveConflict(conflict, 'overwrite', applyAll)}>Replace</button>
          <button class="btn sm" onclick={() => app.resolveConflict(conflict, 'newer', applyAll)} title="Replace only when the incoming file is newer">Keep newer</button>
          <button class="btn sm" onclick={() => app.resolveConflict(conflict, 'rename', applyAll)}>Keep both</button>
          <button class="btn sm" onclick={() => app.resolveConflict(conflict, 'skip', applyAll)}>Skip</button>
        </div>
      </div>
    {/if}

    <div class="jobs">
      {#each jobs as j (j.id)}
        {@const live = LIVE.includes(j.state)}
        {@const where = j.output ?? j.dest}
        <div class="job" data-state={j.state}>
          <div class="jt ellipsis" title={j.title}>{j.title}</div>
          {#if where}<div class="caption ellipsis" title={where}>To <b>{basename(where) || where}</b>{j.kind === 'zip' ? ` in ${basename(dirname(where)) || dirname(where)}` : ''}</div>{/if}

          {#if live}
            <div class="line">
              <span class="big">{j.state === 'paused' ? 'Paused' : j.state === 'queued' ? 'Waiting to start' : j.state === 'waiting' ? 'Waiting for your answer' : j.total || j.filesTotal ? `${pct(j)}% complete` : 'Working…'}</span>
              <span class="spacer"></span>
              {#if j.state === 'paused'}
                <button class="btn subtle icon sm" title="Resume" aria-label="Resume" onclick={() => engine.call('jobs.resume', j.id)}><Icon name="play" /></button>
              {:else}
                <button class="btn subtle icon sm" title="Pause" aria-label="Pause" onclick={() => engine.call('jobs.pause', j.id)} disabled={j.state !== 'running'}><Icon name="pause" /></button>
              {/if}
            </div>
            <div class="bar" class:paused={j.state === 'paused'} class:indet={!j.total && !j.filesTotal && j.state === 'running'}><span style:width={`${pct(j)}%`}></span></div>
            <dl>
              {#if j.current}<dt>Name</dt><dd class="ellipsis" title={j.current}>{basename(j.current)}</dd>{/if}
              <dt>Items</dt><dd>{j.files.toLocaleString()}{j.filesTotal ? ` of ${j.filesTotal.toLocaleString()}` : ''}{j.total ? ` · ${fmtSize(j.done)} of ${fmtSize(j.total)}` : ''}</dd>
              {#if j.state === 'running' && j.rate}
                <dt>Speed</dt><dd>{fmtRate(j.rate)}</dd>
                {#if j.total}<dt>Time left</dt><dd>{fmtEta(j.total - j.done, j.rate) || 'a moment'}</dd>{/if}
              {/if}
            </dl>
            <div class="foot">
              {#if j.errors.length}<button class="link" onclick={() => (details = details === j.id ? null : j.id)}>{plural(j.errors.length, 'problem')} so far</button>{/if}
              <span class="spacer"></span>
              <button class="btn sm" onclick={() => hide(j)}>Hide</button>
              <button class="btn sm" onclick={() => engine.call('jobs.cancel', j.id)}>Cancel</button>
            </div>
          {:else}
            <div class="line">
              <span class="res" class:bad={j.state === 'failed'} class:warn={j.state === 'done' && j.errors.length > 0} class:ok={j.state === 'done' && !j.errors.length}>
                <Icon name={j.state === 'done' ? (j.errors.length ? 'warning' : 'success') : 'error'} />
                {j.state === 'done' ? (j.errors.length ? `Finished with ${plural(j.errors.length, 'problem')}` : 'Done') : 'Failed'}
              </span>
            </div>
            <div class="caption">{plural(j.files, 'item')}{j.total ? ` · ${fmtSize(j.done)}` : ''}{j.error ? ` · ${j.error}` : ''}</div>
            <div class="foot">
              {#if j.errors.length}<button class="link" onclick={() => (details = details === j.id ? null : j.id)}>{details === j.id ? 'Hide details' : 'Show details'}</button>{/if}
              <span class="spacer"></span>
              {#if where && j.state === 'done'}<button class="btn sm" onclick={() => show(j, where)}>Show</button>{/if}
              <button class="btn primary sm" onclick={() => hide(j)}>Close</button>
            </div>
          {/if}
          {#if details === j.id && j.errors.length}
            <ul class="errs">
              {#each j.errors.slice(0, 100) as er, n (n)}
                <li><b class="ellipsis" title={er.path}>{basename(er.path)}</b><span>{er.message}</span></li>
              {/each}
              {#if j.errors.length > 100}<li><span>…and {j.errors.length - 100} more.</span></li>{/if}
            </ul>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .pp {
    position: fixed;
    z-index: 1050;
    left: 50%;
    top: 96px;
    transform: translateX(-50%);
    width: 440px;
    max-width: calc(100vw - 24px);
    max-height: calc(100vh - 140px);
    display: flex;
    flex-direction: column;
    background: var(--flyout);
    backdrop-filter: blur(30px) saturate(1.4);
    border: 1px solid var(--stroke-2);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-dialog);
    animation: pp-in var(--mid) var(--ease);
  }
  .pp.placed {
    transform: none;
  }
  @keyframes pp-in {
    from {
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    border-bottom: 1px solid var(--divider);
    cursor: move;
    user-select: none;
  }
  .spacer {
    flex: 1;
  }
  .jobs {
    overflow: auto;
  }
  .job {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .job + .job {
    border-top: 1px solid var(--divider);
  }
  .jt {
    font-weight: 600;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 26px;
  }
  .big {
    font-size: 15px;
    font-family: var(--font-display);
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--stroke-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 200ms linear;
  }
  .bar.paused span {
    background: var(--warn);
  }
  .bar.indet span {
    width: 35% !important;
    animation: pp-slide 1.2s ease-in-out infinite;
  }
  @keyframes pp-slide {
    from {
      translate: -100% 0;
    }
    to {
      translate: 290% 0;
    }
  }
  dl {
    margin: 2px 0 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    font-size: 12px;
  }
  dt {
    color: var(--text-2);
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .res {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 15px;
  }
  .res.ok {
    color: var(--ok);
  }
  .res.warn {
    color: var(--warn);
  }
  .res.bad {
    color: var(--bad);
  }
  .errs {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
    max-height: 160px;
    overflow: auto;
    border: 1px solid var(--divider);
    border-radius: var(--r-sm);
    font-size: 12px;
  }
  .errs li {
    display: flex;
    flex-direction: column;
    padding: 5px 8px;
  }
  .errs li + li {
    border-top: 1px solid var(--divider);
  }
  .errs span {
    color: var(--text-2);
  }
  .conflict {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: color-mix(in srgb, var(--warn) 9%, transparent);
    border-bottom: 1px solid var(--divider);
  }
  .ctitle {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .cmp {
    display: flex;
    flex-direction: column;
    font-size: 12px;
    color: var(--text-2);
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
  }
  .cbtns {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
</style>
