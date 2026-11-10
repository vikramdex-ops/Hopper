<script lang="ts">
  import { app } from '../lib/app.svelte'
  import { engine, lan } from '../lib/api'
  import { basename, fmtDate, fmtEta, fmtRate, fmtSize, plural } from '../lib/format'
  import type { JobInfo } from '@shared/types'
  import Icon from './Icon.svelte'

  const ACTIVE = ['running', 'queued', 'paused', 'waiting']
  const jobs = $derived(app.jobs)
  const shares = $derived(Object.values(app.shares).filter((s) => !['done', 'failed', 'cancelled'].includes(s.state)))
  const recentShares = $derived(Object.values(app.shares).filter((s) => ['done', 'failed', 'cancelled'].includes(s.state)).slice(-8))
  const conflict = $derived(app.conflicts[0])
  let applyAll = $state(true)

  const pct = (j: { done: number; total: number }) => (j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0)
  const icon = (j: JobInfo) => ({ copy: 'copy', move: 'cut', zip: 'zip', extract: 'extract', delete: 'delete', share: 'send', receive: 'inbox', pdf: 'pdf', package: 'package', hash: 'duplicate', size: 'size' })[j.kind] ?? 'activity'

  $effect(() => {
    // a conflict question shows in the progress window; without that window it shows here
    if (conflict && app.settings?.progressPopup === false) app.drawer = true
  })
</script>

{#if app.drawer}
  <section class="drawer" aria-label="Transfers" style:margin-left={`${app.settings?.sidebarCollapsed ? 56 : (app.settings?.sidebarWidth ?? 232) + 8}px`}>
    <header>
      <span class="subtitle">Transfers</span>
      {#if app.activeJobs.length}<span class="caption">{plural(app.activeJobs.length, 'active job')}</span>{/if}
      <span class="spacer"></span>
      <button class="btn subtle sm" onclick={() => engine.call('jobs.clear')} disabled={!jobs.some((j) => !ACTIVE.includes(j.state))}>Clear finished</button>
      <button class="btn subtle icon sm" onclick={() => (app.drawer = false)} aria-label="Close transfers" title="Close (Ctrl+J)"><Icon name="chevronDown" /></button>
    </header>

    {#if conflict}
      <div class="conflict">
        <Icon name="warning" />
        <div class="cmeta">
          <div><b>{basename(conflict.dst.path)}</b> already exists</div>
          <div class="cmp">
            <span>Incoming: {fmtSize(conflict.src.size)} · {fmtDate(conflict.src.mtime)}{conflict.src.mtime > conflict.dst.mtime + 2000 ? ' · newer' : ''}</span>
            <span>Existing: {fmtSize(conflict.dst.size)} · {fmtDate(conflict.dst.mtime)}{conflict.dst.mtime > conflict.src.mtime + 2000 ? ' · newer' : ''}</span>
          </div>
        </div>
        <label class="check"><input type="checkbox" bind:checked={applyAll} /> Do this for all conflicts</label>
        <button class="btn primary sm" onclick={() => app.resolveConflict(conflict, 'overwrite', applyAll)}>Replace</button>
        <button class="btn sm" onclick={() => app.resolveConflict(conflict, 'newer', applyAll)} title="Replace only when the incoming file is newer">Keep newer</button>
        <button class="btn sm" onclick={() => app.resolveConflict(conflict, 'rename', applyAll)}>Keep both</button>
        <button class="btn sm" onclick={() => app.resolveConflict(conflict, 'skip', applyAll)}>Skip</button>
        <button class="btn subtle sm" onclick={() => app.resolveConflict(conflict, 'cancel', true)}>Cancel</button>
      </div>
    {/if}

    <div class="list">
      {#each shares as s (s.shareId + s.to)}
        <div class="job">
          <span class="ic"><Icon name="send" /></span>
          <div class="jm">
            <div class="row1"><span class="ellipsis">Sending to {app.personName(s.to)}</span><span class="caption">{s.state === 'server' ? 'via office server' : s.state}</span></div>
            <div class="bar"><span style:width={`${pct(s)}%`}></span></div>
            <div class="caption">{fmtSize(s.done)} of {fmtSize(s.total)} · {fmtRate(s.rate)} {fmtEta(s.total - s.done, s.rate)}</div>
          </div>
          <button class="btn subtle icon sm" title="Cancel" onclick={() => lan.call('share.cancel', s.shareId)}><Icon name="close" /></button>
        </div>
      {/each}
      {#each jobs as j (j.id)}
        {@const live = ACTIVE.includes(j.state)}
        <div class="job" class:done={!live}>
          <span class="ic" class:bad={j.state === 'failed'} class:ok={j.state === 'done' && !j.errors.length}><Icon name={j.state === 'done' ? (j.errors.length ? 'warning' : 'success') : j.state === 'failed' ? 'error' : icon(j)} /></span>
          <div class="jm">
            <div class="row1">
              <span class="ellipsis" title={j.title}>{j.title}</span>
              <span class="caption">
                {#if j.state === 'running'}{pct(j)}%{:else if j.state === 'waiting'}waiting for you{:else}{j.state}{/if}
              </span>
            </div>
            {#if live}
              <div class="bar" class:paused={j.state === 'paused'} class:indet={!j.total && j.state === 'running'}><span style:width={`${pct(j)}%`}></span></div>
              <div class="caption ellipsis">
                {#if j.total}{fmtSize(j.done)} of {fmtSize(j.total)}{/if}
                {#if j.filesTotal} · {j.files.toLocaleString()} / {j.filesTotal.toLocaleString()} files{/if}
                {#if j.rate} · {fmtRate(j.rate)} · {fmtEta(j.total - j.done, j.rate)}{/if}
                {#if j.current} · {basename(j.current)}{/if}
              </div>
            {:else}
              <div class="caption ellipsis">
                {plural(j.files, 'file')}{j.total ? ` · ${fmtSize(j.total)}` : ''}{j.endedAt ? ` · ${Math.max(1, Math.round((j.endedAt - j.startedAt) / 1000))}s` : ''}
                {#if j.error} · {j.error}{/if}
                {#if j.errors.length} · {plural(j.errors.length, 'problem')}: {j.errors[0].message}{/if}
              </div>
            {/if}
          </div>
          {#if live}
            {#if j.state === 'paused'}
              <button class="btn subtle icon sm" title="Resume" onclick={() => engine.call('jobs.resume', j.id)}><Icon name="play" /></button>
            {:else}
              <button class="btn subtle icon sm" title="Pause" onclick={() => engine.call('jobs.pause', j.id)}><Icon name="pause" /></button>
            {/if}
            <button class="btn subtle icon sm" title="Cancel" onclick={() => engine.call('jobs.cancel', j.id)}><Icon name="close" /></button>
          {:else if j.output ?? j.dest}
            <button class="btn subtle icon sm" title="Show" onclick={() => app.reveal((j.output ?? j.dest)!)}><Icon name="folderOpen" /></button>
          {/if}
        </div>
      {/each}
      {#each recentShares as s (s.shareId + s.to)}
        <div class="job done">
          <span class="ic" class:ok={s.state === 'done'} class:bad={s.state === 'failed'}><Icon name={s.state === 'done' ? 'success' : 'error'} /></span>
          <div class="jm">
            <div class="row1"><span class="ellipsis">{s.state === 'done' ? 'Sent' : 'Not sent'} to {app.personName(s.to)}</span><span class="caption">{s.via === 'server' ? 'via office server' : s.state}</span></div>
            <div class="caption">{fmtSize(s.total)}{s.error ? ` · ${s.error}` : ''}</div>
          </div>
        </div>
      {/each}
      {#if !jobs.length && !shares.length && !recentShares.length}
        <div class="empty caption">Copies, moves, zips and shares show up here. Everything runs in the background — keep working.</div>
      {/if}
    </div>
  </section>
{/if}

<style>
  .drawer {
    flex: none;
    margin: 0 8px 8px 240px;
    max-height: 38vh;
    display: flex;
    flex-direction: column;
    background: var(--card-solid);
    border: 1px solid var(--stroke);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-card);
    animation: up var(--mid) var(--ease);
  }
  @keyframes up {
    from {
      transform: translateY(12px);
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 6px 6px 14px;
    border-bottom: 1px solid var(--divider);
  }
  .list {
    overflow: auto;
    padding: 4px 6px 6px;
  }
  .job {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px;
    border-radius: var(--r-sm);
  }
  .job:hover {
    background: var(--hover);
  }
  .job.done {
    opacity: 0.85;
  }
  .ic {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--stroke-2);
    flex: none;
  }
  .ic.ok {
    color: var(--ok);
  }
  .ic.bad {
    color: var(--bad);
  }
  .jm {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .row1 {
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }
  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--stroke-2);
    overflow: hidden;
    position: relative;
  }
  .bar span {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.25s linear;
  }
  .bar.paused span {
    background: var(--warn);
  }
  .bar.indet span {
    width: 30% !important;
    animation: slide 1.2s var(--ease) infinite;
  }
  @keyframes slide {
    from {
      left: -30%;
    }
    to {
      left: 100%;
    }
  }
  .conflict {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin: 8px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  }
  .cmeta {
    flex: 1;
    min-width: 240px;
  }
  .cmp {
    display: flex;
    flex-direction: column;
    font-size: 12px;
    color: var(--text-2);
  }
  .empty {
    padding: 16px;
    text-align: center;
  }
</style>
