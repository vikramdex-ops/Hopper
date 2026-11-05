<script lang="ts">
  // Undo history: the engine's journal, newest first. Any entry can be undone on its own;
  // entries already undone are greyed out.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine } from '../../lib/api'
  import { basename, fmtAgo, fmtDateFull, plural } from '../../lib/format'
  import type { UndoRecord } from '@shared/types'

  let { close }: { close: (v?: unknown) => void } = $props()

  let list = $state.raw<UndoRecord[]>(app.undoList)
  let loading = $state(true)
  let busy = $state('')
  let open = $state<string | null>(null)

  const ICON: Record<UndoRecord['kind'], string> = { copy: 'copy', move: 'cut', rename: 'rename', new: 'newFile', recycle: 'trash' }
  const WHAT: Record<UndoRecord['kind'], string> = {
    copy: 'Undo deletes the copies that were made',
    move: 'Undo moves the items back',
    rename: 'Undo restores the old names',
    new: 'Undo deletes the new item',
    recycle: 'Undo restores the items from the Recycle Bin'
  }

  async function load() {
    try {
      list = await engine.call<UndoRecord[]>('undo.list')
    } catch {
      /* keep what we have */
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
    return engine.on('undo', () => void load())
  })

  async function undo(r: UndoRecord) {
    if (busy) return
    busy = r.id
    try {
      const res = await engine.call<{ label: string; ok: number; failed: string[] }>('undo.undo', r.id)
      app.toast(res.failed.length ? 'warning' : 'success', `Undid: ${res.label}`, res.failed.length ? `${plural(res.failed.length, 'item')} could not be restored: ${basename(res.failed[0])}` : undefined)
      for (const p of app.panes) void p.refresh()
      await load()
    } catch (e: any) {
      app.toast('error', "Couldn't undo", String(e?.message ?? e).replace(/^Error:\s*/, ''))
    } finally {
      busy = ''
    }
  }

  const pairText = (r: UndoRecord, [a, b]: [string, string]) => {
    if (r.kind === 'recycle') return a
    if (r.kind === 'new') return b || a
    if (r.kind === 'rename') return `${a}  →  ${basename(b)}`
    return `${a}  →  ${b}`
  }
</script>

<Dialog title="Undo history" icon="history" width={720} onclose={() => close()}>
  {#if !list.length}
    <div class="caption">{loading ? 'Loading…' : 'Nothing to undo yet. Copies, moves, renames, new items and deletes to the Recycle Bin are recorded here.'}</div>
  {:else}
    <div class="caption">Undo works best newest first: undoing an older step after later changes to the same files may not restore everything.</div>
    <div class="list">
      {#each list as r (r.id)}
        <div class="rec" class:undone={r.undone}>
          <div class="line">
            <Icon name={ICON[r.kind] ?? 'history'} />
            <button type="button" class="lbl" onclick={() => (open = open === r.id ? null : r.id)} title={WHAT[r.kind]}>
              <span class="ellipsis">{r.label}</span>
              <span class="caption">{plural(r.pairs.length, 'item')}{r.undone ? ' · undone' : ''}</span>
            </button>
            <span class="caption when" title={fmtDateFull(r.at)}>{fmtAgo(r.at)}</span>
            <button type="button" class="btn sm" disabled={r.undone || !!busy} onclick={() => undo(r)}>
              <Icon name="undo" /> {busy === r.id ? 'Undoing…' : 'Undo'}
            </button>
          </div>
          {#if open === r.id}
            <div class="pairs">
              {#each r.pairs.slice(0, 50) as p, i (i)}<div class="caption ellipsis" title={pairText(r, p)}>{pairText(r, p)}</div>{/each}
              {#if r.pairs.length > 50}<div class="caption">…and {plural(r.pairs.length - 50, 'more item')}</div>{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#snippet footer()}
    <button type="button" class="btn primary" onclick={() => close()}>Close</button>
  {/snippet}
</Dialog>

<style>
  .list {
    display: flex;
    flex-direction: column;
    max-height: 56vh;
    overflow: auto;
  }
  .rec {
    border-bottom: 1px solid var(--divider);
    padding: 4px 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
  }
  .lbl {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    border: 0;
    background: transparent;
    padding: 2px 4px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .lbl:hover {
    background: var(--hover);
  }
  .lbl .ellipsis {
    max-width: 100%;
  }
  .when {
    flex: none;
  }
  .undone {
    opacity: 0.5;
  }
  .pairs {
    padding: 2px 0 6px 30px;
    font-family: var(--mono);
  }
</style>
