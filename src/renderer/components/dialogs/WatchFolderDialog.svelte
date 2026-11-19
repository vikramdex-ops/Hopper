<script lang="ts">
  // Watch this folder: what to be told about, quiet hours and the Dexterity Connect copy.
  import { untrack } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import { app } from '../../lib/app.svelte'
  import { watchUi } from '../../lib/folderwatch.svelte'
  import { WATCH_MAX_ENTRIES, type WatchedFolder } from '@shared/folderwatch'

  let { folder, isNew = false, close }: { folder: WatchedFolder; isNew?: boolean; close: (v?: unknown) => void } = $props()

  // a working copy; nothing changes until Watch / Save
  const w = $state<WatchedFolder>(untrack(() => JSON.parse(JSON.stringify(folder))))
  const c = $derived(app.office?.connect)
  const connectReady = $derived(!!(c?.enabled && c.hub && c.token && c.fingerprint))
  const st = $derived(watchUi.statusOf(folder.id))
  const nothing = $derived(!w.notify.added && !w.notify.changed && !w.notify.removed)

  function save() {
    if (nothing) return
    close($state.snapshot(w))
  }
</script>

<Dialog title={isNew ? 'Watch this folder' : 'Watched folder'} icon="eye" width={520} onclose={() => close()} onsubmit={save}>
  <div class="where">
    <span class="ellipsis" title={w.path}>{w.path}</span>
  </div>

  <label class="check"><input type="checkbox" bind:checked={w.subfolders} /> Include subfolders</label>

  <div class="group">
    <div class="caption">Tell me about</div>
    <label class="check"><input type="checkbox" bind:checked={w.notify.added} /> New files</label>
    <label class="check"><input type="checkbox" bind:checked={w.notify.changed} /> Changed files</label>
    <label class="check"><input type="checkbox" bind:checked={w.notify.removed} /> Deleted files</label>
    {#if nothing}<div class="hint warn">Pick at least one.</div>{/if}
  </div>

  <div class="group">
    <label class="check"><input type="checkbox" bind:checked={w.quiet.on} /> Quiet hours</label>
    {#if w.quiet.on}
      <div class="row times">
        <span class="caption">From</span><input class="input" type="time" bind:value={w.quiet.from} aria-label="Quiet from" />
        <span class="caption">to</span><input class="input" type="time" bind:value={w.quiet.to} aria-label="Quiet to" />
      </div>
      <div class="hint">No pop-ups or messages then; changes still appear in Activity and on the sidebar.</div>
    {/if}
  </div>

  <label class="check" title={connectReady ? '' : 'Dexterity Connect is not set up for this office (Settings > Office)'}>
    <input type="checkbox" bind:checked={w.connect} disabled={!connectReady} /> Also send to me on Dexterity Connect
  </label>
  {#if w.connect || !connectReady}
    <div class="hint">{connectReady ? 'The message says only the folder name and how many files changed.' : 'Dexterity Connect is not set up for this office.'}</div>
  {/if}

  <div class="hint">
    Files you copy, move or create with Hopper on this PC are left out. Temp and lock files (~$…, .tmp, .dwl) are ignored.
    {#if st?.mode === 'poll'}This folder is checked every 30 seconds.{/if}
    {#if st?.limited}Only the first {WATCH_MAX_ENTRIES.toLocaleString()} items are compared, so deletions are not reported.{/if}
    {#if st?.error}<span class="warn">Can't read the folder right now: {st.error}</span>{/if}
  </div>

  {#snippet footer()}
    {#if !isNew}<button type="button" class="btn subtle first" onclick={() => { watchUi.stop(folder.id); close() }}>Stop watching</button>{/if}
    <button type="submit" class="btn primary" disabled={nothing}>{isNew ? 'Watch' : 'Save'}</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .where {
    padding: 8px 10px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    font-size: 13px;
    min-width: 0;
    display: flex;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .times .input {
    width: 120px;
    flex: none !important;
  }
  .warn {
    color: var(--warn);
  }
  .first {
    margin-right: auto;
  }
</style>
