<script lang="ts">
  // Find duplicates: by content (size, then quick hash, then full SHA-256), by name, or name + size.
  // The engine runs it as a job (progress in the transfer drawer); groups come back on 'dupes'.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { fmtDate, fmtSize, plural } from '../../lib/format'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'
  import type { Entry } from '@shared/types'

  let { close }: { close: (v?: unknown) => void } = $props()

  const start = app.active.path
  let roots = $state<string[]>(!isVirtual(start) && !isArchivePath(start) ? [start] : [])
  let by = $state<'content' | 'name' | 'nameSize'>('content')
  let minSize = $state(1)
  let jobId = $state('')
  let groups = $state.raw<Entry[][]>([])
  let checked = $state.raw<Set<string>>(new Set())
  let limit = $state(200)
  let busy = $state(false)

  const job = $derived(jobId ? app.jobs.find((j) => j.id === jobId) : undefined)
  const running = $derived(!!job && ['queued', 'running', 'paused', 'waiting'].includes(job.state))
  const gotResult = $derived(!!jobId && !running && job?.state === 'done')

  // Results can, in principle, arrive before dupes.run has returned the job id.
  const early = new Map<string, Entry[][]>()
  function show(list: Entry[][]) {
    groups = list
    checked = new Set()
    limit = 200
  }

  onMount(() => {
    const off = engine.on('dupes', (d: { jobId: string; groups: Entry[][] }) => {
      if (d.jobId === jobId) show(d.groups)
      else early.set(d.jobId, d.groups)
    })
    return () => {
      off()
      if (jobId && running) void engine.call('jobs.cancel', jobId).catch(() => {})
    }
  })

  async function addRoot() {
    const d = await host.dialog.folder('Look for duplicates in', roots[0])
    if (d && !roots.some((r) => r.toLowerCase() === d.toLowerCase())) roots = [...roots, d]
  }

  async function run() {
    if (!roots.length || running) return
    groups = []
    checked = new Set()
    try {
      jobId = await engine.call<string>('dupes.run', $state.snapshot(roots), { by, minSize })
      const got = early.get(jobId)
      if (got) show(got)
      early.clear()
      app.showProgress()
    } catch (e: any) {
      app.toast('error', "Couldn't start the duplicate search", String(e?.message ?? e).replace(/^Error:\s*/, ''))
    }
  }

  const key = (p: string) => p.toLowerCase()
  const wasted = $derived(groups.reduce((a, g) => a + g[0].size * (g.length - 1), 0))
  const chosenBytes = $derived(groups.flat().filter((e) => checked.has(key(e.path))).reduce((a, e) => a + e.size, 0))
  const wiped = $derived(groups.filter((g) => g.every((e) => checked.has(key(e.path)))).length)

  function toggle(p: string) {
    const s = new Set(checked)
    s.has(key(p)) ? s.delete(key(p)) : s.add(key(p))
    checked = s
  }

  function allBut(which: 'newest' | 'oldest') {
    const s = new Set<string>()
    for (const g of groups) {
      const keep = g.reduce((best, e) => ((which === 'newest' ? e.mtime > best.mtime : e.mtime < best.mtime) ? e : best), g[0])
      for (const e of g) if (e !== keep) s.add(key(e.path))
    }
    checked = s
  }

  async function trash() {
    const paths = groups.flat().filter((e) => checked.has(key(e.path))).map((e) => e.path)
    if (!paths.length || busy) return
    const warn = wiped ? `${plural(wiped, 'group')} would lose every copy. ` : ''
    const ok = await app.confirm(`Move ${plural(paths.length, 'file')} (${fmtSize(chosenBytes)}) to the Recycle Bin?`, `${warn}You can restore them with Undo or from the Recycle Bin.`, 'Move to Recycle Bin')
    if (!ok) return
    busy = true
    try {
      const r = await host.shell.trash(paths)
      if (r.done.length) {
        void engine.call('fs.recordRecycle', r.done)
        const gone = new Set(r.done.map(key))
        groups = groups.map((g) => g.filter((e) => !gone.has(key(e.path)))).filter((g) => g.length > 1)
        checked = new Set([...checked].filter((k) => !gone.has(k)))
        app.toast('info', `Moved ${plural(r.done.length, 'file')} to the Recycle Bin`, undefined, [{ label: 'Undo', run: () => void app.undo() }])
        for (const p of app.panes) void p.refresh()
      }
      if (r.failed.length) app.toast('error', `${plural(r.failed.length, 'file')} could not be deleted`, r.failed[0].message)
    } finally {
      busy = false
    }
  }
</script>

<Dialog title="Find duplicates" icon="duplicate" width={820} onclose={() => close()}>
  <div class="setup">
    <div class="roots">
      <span class="caption">Look in</span>
      {#each roots as r (r)}
        <span class="chip" title={r}>
          <Icon name="folder" size={14} /><span class="ellipsis">{r}</span>
          <button type="button" aria-label={`Remove ${r}`} onclick={() => (roots = roots.filter((x) => x !== r))} disabled={running}><Icon name="close" size={10} /></button>
        </span>
      {/each}
      <button type="button" class="btn sm" onclick={addRoot} disabled={running}><Icon name="plus" /> Add folder</button>
    </div>
    <div class="row">
      <label class="field grow">
        <span>Compare by</span>
        <select class="input" bind:value={by} disabled={running}>
          <option value="content">Content (identical bytes, slowest and exact)</option>
          <option value="nameSize">Name and size</option>
          <option value="name">Name only</option>
        </select>
      </label>
      <label class="field">
        <span>Ignore files smaller than</span>
        <select class="input" bind:value={minSize} disabled={running}>
          <option value={1}>Nothing (skip empty files)</option>
          <option value={1024}>1 KB</option>
          <option value={100 * 1024}>100 KB</option>
          <option value={1024 * 1024}>1 MB</option>
          <option value={10 * 1024 * 1024}>10 MB</option>
          <option value={100 * 1024 * 1024}>100 MB</option>
        </select>
      </label>
      <button type="button" class="btn primary go" onclick={run} disabled={!roots.length || running}><Icon name={running ? 'clock' : 'search'} /> {running ? 'Searching…' : jobId ? 'Search again' : 'Search'}</button>
    </div>
    {#if by !== 'content'}<div class="caption">Name matches are not proof the files are identical: check before deleting.</div>{/if}
  </div>

  {#if running}
    <div class="status caption">
      Searching{job?.filesTotal ? ` · ${job.files.toLocaleString()} of ${plural(job.filesTotal, 'candidate')} checked` : '…'}{job?.current ? ` · ${job.current}` : ''}
      <button type="button" class="btn sm" onclick={() => engine.call('jobs.cancel', jobId)}>Stop</button>
    </div>
  {:else if job && (job.state === 'failed' || job.state === 'cancelled')}
    <div class="status caption">{job.state === 'failed' ? `Search failed: ${job.error ?? ''}` : 'Search stopped.'}</div>
  {/if}

  {#if groups.length}
    <div class="bar">
      <span class="caption">{plural(groups.length, 'group')} · {fmtSize(wasted)} in extra copies</span>
      <span class="spacer"></span>
      <button type="button" class="btn sm" onclick={() => allBut('newest')}>Select all but newest</button>
      <button type="button" class="btn sm" onclick={() => allBut('oldest')}>Select all but oldest</button>
      <button type="button" class="btn sm subtle" onclick={() => (checked = new Set())} disabled={!checked.size}>Clear</button>
    </div>
    <div class="groups">
      {#each groups.slice(0, limit) as g, gi (g[0].path + gi)}
        {@const all = g.every((e) => checked.has(key(e.path)))}
        <div class="group" class:wiped={all}>
          <div class="gh">
            <span class="ellipsis">{g[0].name}</span>
            <span class="caption">{plural(g.length, 'copy')}{by !== 'name' ? ` · ${fmtSize(g[0].size)} each` : ''}</span>
            {#if all}<span class="warn"><Icon name="warning" size={14} /> every copy selected</span>{/if}
          </div>
          {#each g as e (e.path)}
            <div class="file">
              <label class="check"><input type="checkbox" checked={checked.has(key(e.path))} onchange={() => toggle(e.path)} /></label>
              <span class="ellipsis p" title={e.path}>{e.path}</span>
              <span class="caption sz">{fmtSize(e.size)}</span>
              <span class="caption dt">{fmtDate(e.mtime)}</span>
              <button type="button" class="btn subtle icon sm" title="Show in Hopper" aria-label="Show in Hopper" onclick={() => { close(); void app.reveal(e.path) }}><Icon name="folderOpen" /></button>
            </div>
          {/each}
        </div>
      {/each}
      {#if groups.length > limit}
        <button type="button" class="btn more" onclick={() => (limit += 200)}>Show {Math.min(200, groups.length - limit)} more groups</button>
      {/if}
    </div>
  {:else if gotResult}
    <div class="caption">No duplicates found.</div>
  {/if}

  {#snippet footer()}
    {#if checked.size}<span class="caption foot">{plural(checked.size, 'file')} selected · {fmtSize(chosenBytes)}</span>{/if}
    <button type="button" class="btn primary" onclick={trash} disabled={!checked.size || busy}><Icon name="delete" /> Move selected to Recycle Bin</button>
    <button type="button" class="btn" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .setup {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .roots {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    max-width: 420px;
    padding: 0 4px 0 8px;
    border-radius: 14px;
    background: var(--sel);
    font-size: 13px;
  }
  .chip button {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 0;
    background: transparent;
    display: grid;
    place-items: center;
    color: var(--text-2);
    flex: none;
  }
  .chip button:hover {
    background: var(--hover);
  }
  .row {
    align-items: flex-end;
  }
  .grow {
    flex: 1;
  }
  .go {
    min-width: 140px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 46vh;
    overflow: auto;
  }
  .group {
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    padding: 4px 0;
  }
  .group.wiped {
    border-color: var(--warn);
  }
  .gh {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 10px 4px;
    font-weight: 600;
    font-size: 13px;
  }
  .warn {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--warn);
    font-weight: 400;
    font-size: 12px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 30px;
    padding: 0 6px 0 10px;
    font-size: 13px;
  }
  .file:hover {
    background: var(--hover);
  }
  .p {
    flex: 1;
    min-width: 0;
  }
  .sz {
    width: 64px;
    text-align: right;
  }
  .dt {
    width: 130px;
  }
  .more {
    align-self: center;
  }
  .foot {
    flex: 1;
    align-self: center;
  }
</style>
