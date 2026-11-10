<script lang="ts">
  import type { Pane } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { basename, fmtAgo, fmtSize, plural } from '../lib/format'
  import Icon from './Icon.svelte'

  let { pane }: { pane: Pane } = $props()

  const PAST: Record<string, string> = { Copying: 'Copied', Moving: 'Moved', Zipping: 'Zipped', Extracting: 'Extracted', Duplicating: 'Duplicated', Adding: 'Added', Finding: 'Found' }
  const past = (t: string) => t.replace(/^\w+/, (w) => PAST[w] ?? w)

  // One timeline from jobs, shares, received items and the undo journal.
  const events = $derived.by(() => {
    const out: { at: number; icon: string; title: string; detail?: string; path?: string; tone?: string }[] = []
    for (const j of app.jobs) {
      if (!j.endedAt) continue
      const icon = j.kind === 'zip' ? 'zip' : j.kind === 'extract' ? 'extract' : j.kind === 'move' ? 'cut' : j.kind === 'copy' ? 'copy' : j.kind === 'share' ? 'send' : 'activity'
      out.push({ at: j.endedAt, icon, title: past(j.title), detail: `${j.state === 'done' ? '' : `${j.state} · `}${plural(j.files, 'file')}${j.total ? ` · ${fmtSize(j.total)}` : ''}${j.errors.length ? ` · ${plural(j.errors.length, 'problem')}` : ''}`, path: j.output ?? j.dest, tone: j.state === 'failed' ? 'bad' : j.errors.length ? 'warn' : '' })
    }
    for (const i of app.inbox) out.push({ at: i.at, icon: 'inbox', title: `Received ${plural(i.files, 'file')} from ${i.fromName}`, detail: i.message ?? fmtSize(i.bytes), path: i.folder })
    for (const s of Object.values(app.shares)) if (s.state === 'done') out.push({ at: Date.now(), icon: 'send', title: `Sent to ${app.personName(s.to)}`, detail: `${fmtSize(s.total)}${s.via === 'server' ? ' · via office server' : ''}` })
    for (const d of app.clientDownloads) out.push({ at: d.at, icon: 'download', title: `Your client downloaded ${d.title}`, detail: d.downloads > 1 ? `${d.downloads} downloads so far` : 'First download', tone: 'ok' })
    for (const u of app.undoList) if (u.kind === 'rename' || u.kind === 'recycle' || u.kind === 'new') out.push({ at: u.at, icon: u.kind === 'recycle' ? 'delete' : u.kind === 'new' ? 'plus' : 'rename', title: u.label, detail: u.undone ? 'undone' : undefined, path: u.pairs[0]?.[1] || undefined })
    return out.sort((a, b) => b.at - a.at).slice(0, 300)
  })
</script>

<div class="activity">
  <h1 class="title">Activity</h1>
  {#if !events.length}
    <p class="caption">Copies, moves, zips, shares and received files from this session appear here.</p>
  {/if}
  {#each events as ev, i (i)}
    <button class="ev" disabled={!ev.path} onclick={() => ev.path && app.reveal(ev.path)}>
      <span class="ic {ev.tone ?? ''}"><Icon name={ev.icon} /></span>
      <span class="meta">
        <span class="ellipsis">{ev.title}</span>
        {#if ev.detail}<span class="caption ellipsis">{ev.detail}</span>{/if}
      </span>
      {#if ev.path}<span class="caption ellipsis where" title={ev.path}>{basename(ev.path)}</span>{/if}
      <span class="caption when">{fmtAgo(ev.at)}</span>
    </button>
  {/each}
</div>

<style>
  .activity {
    flex: 1;
    overflow: auto;
    padding: 20px 24px;
  }
  .title {
    margin: 0 0 12px;
  }
  .ev {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
    color: var(--text);
  }
  .ev:hover:not(:disabled) {
    background: var(--hover);
  }
  .ic {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--stroke-2);
    flex: none;
  }
  .ic.bad {
    color: var(--bad);
  }
  .ic.warn {
    color: var(--warn);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .where {
    max-width: 200px;
  }
  .when {
    width: 90px;
    text-align: right;
    flex: none;
  }
</style>
