<script lang="ts">
  // Compare the two panes' folders (top level, names case-insensitive). A file differs when its
  // size differs or its modified time is more than 2 s apart. Sync copies newer and missing items.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { fmtDate, fmtSize, plural } from '../../lib/format'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'
  import type { Entry } from '@shared/types'

  let { close }: { close: (v?: unknown) => void } = $props()

  const [L, R] = app.panes
  const SLACK = 2000

  type Kind = 'onlyLeft' | 'onlyRight' | 'newerLeft' | 'newerRight' | 'sizeOnly' | 'clash' | 'same' | 'bothDirs'
  interface Item {
    name: string
    kind: Kind
    left?: Entry
    right?: Entry
  }

  const LABELS: Record<Kind, string> = {
    onlyLeft: 'Only left',
    onlyRight: 'Only right',
    newerLeft: 'Newer left',
    newerRight: 'Newer right',
    sizeOnly: 'Different size, same time',
    clash: 'File on one side, folder on the other',
    same: 'Same',
    bothDirs: 'Folder on both sides'
  }

  const real = (p: string) => !isVirtual(p) && !isArchivePath(p)
  const usable = $derived(!!L && !!R && real(L.path) && real(R.path) && L.path.toLowerCase() !== R.path.toLowerCase())

  const items = $derived.by<Item[]>(() => {
    if (!usable) return []
    const right = new Map(R.entries.map((e) => [e.name.toLowerCase(), e]))
    const out: Item[] = []
    for (const l of L.entries) {
      const k = l.name.toLowerCase()
      const r = right.get(k)
      right.delete(k)
      if (!r) out.push({ name: l.name, kind: 'onlyLeft', left: l })
      else if (l.dir !== r.dir) out.push({ name: l.name, kind: 'clash', left: l, right: r })
      else if (l.dir) out.push({ name: l.name, kind: 'bothDirs', left: l, right: r })
      else {
        const dt = l.mtime - r.mtime
        let kind: Kind = 'same'
        if (dt > SLACK) kind = 'newerLeft'
        else if (dt < -SLACK) kind = 'newerRight'
        else if (l.size !== r.size) kind = 'sizeOnly'
        out.push({ name: l.name, kind, left: l, right: r })
      }
    }
    for (const r of right.values()) out.push({ name: r.name, kind: 'onlyRight', right: r })
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  })

  const counts = $derived.by(() => {
    const c = { onlyLeft: 0, onlyRight: 0, newerLeft: 0, newerRight: 0, sizeOnly: 0, clash: 0, same: 0, bothDirs: 0 } as Record<Kind, number>
    for (const i of items) c[i.kind]++
    return c
  })

  let show = $state<'diff' | Kind>('diff')
  let includeFolders = $state(false)
  const DIFF: Kind[] = ['onlyLeft', 'onlyRight', 'newerLeft', 'newerRight', 'sizeOnly', 'clash']
  const TILES: Kind[] = ['onlyLeft', 'onlyRight', 'newerLeft', 'newerRight', 'same']
  const visible = $derived(items.filter((i) => (show === 'diff' ? DIFF.includes(i.kind) : i.kind === show)).slice(0, 2000))

  function selectDifferences() {
    const diff = items.filter((i) => DIFF.includes(i.kind))
    L.setSelection(diff.filter((i) => i.left).map((i) => i.left!.path.toLowerCase()))
    R.setSelection(diff.filter((i) => i.right).map((i) => i.right!.path.toLowerCase()))
    app.toast('info', `Selected ${plural(diff.length, 'difference')} in both panes`)
    close(true)
  }

  /** Sources to copy from one side: missing and newer items (and, if asked, shared folders to merge). */
  function plan(dir: 'toRight' | 'toLeft') {
    const toRight = dir === 'toRight'
    return items
      .filter((i) => (toRight ? i.kind === 'onlyLeft' || i.kind === 'newerLeft' : i.kind === 'onlyRight' || i.kind === 'newerRight') || (includeFolders && i.kind === 'bothDirs'))
      .map((i) => (toRight ? i.left! : i.right!).path)
  }

  async function sync(dir: 'toRight' | 'toLeft' | 'both') {
    const a = dir === 'toLeft' ? [] : plan('toRight')
    const b = dir === 'toRight' ? [] : plan('toLeft')
    if (!a.length && !b.length) return app.toast('info', 'Nothing to copy')
    const parts = [a.length ? `${plural(a.length, 'item')} to the right` : '', b.length ? `${plural(b.length, 'item')} to the left` : ''].filter(Boolean)
    const skipped = counts.sizeOnly + counts.clash
    const body = `Existing files are replaced only when the copy is newer.${skipped ? ` ${plural(skipped, 'item')} that can't be ordered by date (different size at the same time, or file vs folder) are left alone.` : ''}`
    if (!(await app.confirm(`Copy ${parts.join(' and ')}?`, body, 'Copy'))) return
    if (a.length) void app.transfer('copy', a, R.path, { policy: 'newer' })
    if (b.length) void app.transfer('copy', b, L.path, { policy: 'newer' })
    close(true)
  }
</script>

<Dialog title="Compare panes" icon="compare" width={820} onclose={() => close()}>
  {#if !usable}
    <div class="caption">Open two different real folders in the left and right panes to compare them.</div>
  {:else}
    <div class="sides">
      <div class="side"><span class="caption">Left</span><span class="ellipsis" title={L.path}>{L.path}</span></div>
      <div class="side"><span class="caption">Right</span><span class="ellipsis" title={R.path}>{R.path}</span></div>
    </div>

    <div class="counts">
      <button type="button" class="count" class:on={show === 'diff'} onclick={() => (show = 'diff')}><b>{DIFF.reduce((a, k) => a + counts[k], 0)}</b><span>All differences</span></button>
      {#each TILES as k (k)}
        <button type="button" class="count {k}" class:on={show === k} onclick={() => (show = k)}><b>{counts[k]}</b><span>{LABELS[k]}</span></button>
      {/each}
    </div>
    {#if counts.sizeOnly || counts.clash || counts.bothDirs}
      <div class="caption">
        {#if counts.sizeOnly}<button type="button" class="link" onclick={() => (show = 'sizeOnly')}>{plural(counts.sizeOnly, 'file')} differ in size with the same time</button> (not synced). {/if}
        {#if counts.clash}<button type="button" class="link" onclick={() => (show = 'clash')}>{plural(counts.clash, 'name')} are a file on one side and a folder on the other</button> (not synced). {/if}
        {#if counts.bothDirs}<button type="button" class="link" onclick={() => (show = 'bothDirs')}>{plural(counts.bothDirs, 'folder')} exist on both sides</button>; their contents are not compared here.{/if}
      </div>
    {/if}

    <div class="table">
      <div class="tr th caption"><span>Name</span><span>Left</span><span></span><span>Right</span></div>
      {#each visible as i (i.name + i.kind)}
        <div class="tr {i.kind}">
          <span class="ellipsis nm" title={LABELS[i.kind]}><Icon name={(i.left ?? i.right)?.dir ? 'folder' : 'file'} size={14} /> {i.name}</span>
          <span class="caption ellipsis">{i.left ? `${i.left.dir ? 'folder' : fmtSize(i.left.size)} · ${fmtDate(i.left.mtime)}` : '—'}</span>
          <span class="arrow">
            {#if i.kind === 'onlyLeft' || i.kind === 'newerLeft'}<Icon name="chevronRight" size={14} />{:else if i.kind === 'onlyRight' || i.kind === 'newerRight'}<Icon name="chevronLeft" size={14} />{:else if i.kind === 'same'}={:else if i.kind === 'bothDirs'}·{:else}<Icon name="warning" size={14} />{/if}
          </span>
          <span class="caption ellipsis">{i.right ? `${i.right.dir ? 'folder' : fmtSize(i.right.size)} · ${fmtDate(i.right.mtime)}` : '—'}</span>
        </div>
      {:else}
        <div class="caption empty">{show === 'diff' ? 'The two folders match at the top level.' : 'Nothing in this category.'}</div>
      {/each}
    </div>

    <label class="check"><input type="checkbox" bind:checked={includeFolders} /> When syncing, also merge folders that exist on both sides (copies their newer and missing files)</label>
  {/if}

  {#snippet footer()}
    <button type="button" class="btn subtle first" onclick={selectDifferences} disabled={!usable}>Select differences in both panes</button>
    <button type="button" class="btn" onclick={() => sync('toRight')} disabled={!usable}>Sync <Icon name="chevronRight" /></button>
    <button type="button" class="btn" onclick={() => sync('toLeft')} disabled={!usable}><Icon name="chevronLeft" /> Sync</button>
    <button type="button" class="btn primary" onclick={() => sync('both')} disabled={!usable}>Both ways</button>
    <button type="button" class="btn" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .side {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 8px 10px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  .counts {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
  }
  .count {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 6px 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
    text-align: left;
  }
  .count b {
    font: 600 18px/24px var(--font-display);
  }
  .count span {
    font-size: 12px;
    color: var(--text-2);
  }
  .count:hover {
    background: var(--hover);
  }
  .count.on {
    border-color: var(--accent);
    background: var(--sel);
  }
  .link {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--accent);
    font-size: 12px;
  }
  .link:hover {
    text-decoration: underline;
  }
  .table {
    max-height: 40vh;
    min-height: 160px;
    overflow: auto;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
  }
  .tr {
    display: grid;
    grid-template-columns: 1.4fr 1fr 28px 1fr;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 10px;
    font-size: 13px;
  }
  .th {
    position: sticky;
    top: 0;
    background: var(--layer-solid);
    border-bottom: 1px solid var(--divider);
  }
  .nm {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .arrow {
    display: flex;
    justify-content: center;
    color: var(--accent);
  }
  .tr.sizeOnly .arrow,
  .tr.clash .arrow {
    color: var(--warn);
  }
  .tr.same .arrow,
  .tr.bothDirs .arrow {
    color: var(--text-3);
  }
  .empty {
    padding: 12px;
  }
  .first {
    margin-right: auto;
  }
</style>
