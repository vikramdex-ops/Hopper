<script lang="ts">
  // Copy / Move to: pinned and recent destinations one click away; options for conflicts and verify.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { host } from '../../lib/api'
  import { basename, fmtAgo, plural } from '../../lib/format'
  import { isVirtual } from '../../lib/pane.svelte'
  import type { ConflictPolicy } from '@shared/types'

  let { op = 'copy', close }: { op?: 'copy' | 'move'; close: (v?: unknown) => void } = $props()
  let mode = $state(op)
  const sources = app.active.targets().map((e) => e.path)
  let dest = $state(app.dual && !isVirtual(app.other.path) ? app.other.path : app.settings?.quickDests[0]?.path ?? '')
  let policy = $state<ConflictPolicy>('ask')
  let verify = $state(app.settings?.verifyCopies ?? false)
  let filter = $state('')

  const dests = $derived(app.settings?.quickDests ?? [])

  async function browse() {
    const d = await host.dialog.folder(`${mode === 'copy' ? 'Copy' : 'Move'} to`, dest || undefined)
    if (d) dest = d
  }

  function togglePin(path: string) {
    const list = (app.settings?.quickDests ?? []).map((d) => (d.path === path ? { ...d, pinned: !d.pinned } : d))
    app.updateSettings({ quickDests: list })
  }

  function go() {
    if (!dest.trim()) return
    void app.transfer(mode, sources, dest.trim(), { policy, verify, filter: filter.trim() || undefined })
    close(true)
  }
</script>

<Dialog title={`${mode === 'copy' ? 'Copy' : 'Move'} ${plural(sources.length, 'item')}`} icon={mode === 'copy' ? 'copy' : 'cut'} width={560} onclose={() => close()} onsubmit={go}>
  <div class="seg">
    <button type="button" class:on={mode === 'copy'} onclick={() => (mode = 'copy')}><Icon name="copy" /> Copy</button>
    <button type="button" class:on={mode === 'move'} onclick={() => (mode = 'move')}><Icon name="cut" /> Move</button>
  </div>

  <label class="field">
    <span>Destination</span>
    <div class="row">
      <input class="input" bind:value={dest} spellcheck="false" placeholder="Type or paste a folder path" />
      <button type="button" class="btn" onclick={browse}><Icon name="folderOpen" /> Browse</button>
    </div>
  </label>

  {#if dests.length || app.dual}
    <div class="dests">
      {#if app.dual && !isVirtual(app.other.path)}
        <button type="button" class="dest" class:on={dest === app.other.path} onclick={() => (dest = app.other.path)}>
          <Icon name="dualPane" /> <span class="ellipsis">Other pane — {basename(app.other.path) || app.other.path}</span>
        </button>
      {/if}
      {#each dests as d (d.path)}
        <div class="dest" class:on={dest === d.path}>
          <button type="button" class="pick" onclick={() => (dest = d.path)} ondblclick={() => { dest = d.path; go() }} title={d.path}>
            <Icon name="folder" /> <span class="ellipsis">{d.label || basename(d.path) || d.path}</span>
            <span class="caption ellipsis path">{d.path}</span>
            {#if !d.pinned}<span class="caption">{fmtAgo(d.usedAt)}</span>{/if}
          </button>
          <button type="button" class="pin" class:pinned={d.pinned} title={d.pinned ? 'Unpin' : 'Pin as a favourite destination'} onclick={() => togglePin(d.path)}><Icon name="pin" size={14} /></button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="grid">
    <label class="field">
      <span>If a file already exists</span>
      <select class="input" bind:value={policy}>
        <option value="ask">Ask me (once, then apply to all)</option>
        <option value="newer">Replace only if newer</option>
        <option value="overwrite">Replace</option>
        <option value="rename">Keep both (rename)</option>
        <option value="skip">Skip</option>
      </select>
    </label>
    <label class="field">
      <span>Only files matching <span class="caption">(optional)</span></span>
      <input class="input" bind:value={filter} placeholder="*.pdf; *.dwg" spellcheck="false" />
    </label>
  </div>
  <label class="check"><input type="checkbox" bind:checked={verify} /> Verify every file with a checksum after copying</label>

  {#snippet footer()}
    <button type="submit" class="btn primary" disabled={!dest.trim()}>{mode === 'copy' ? 'Copy' : 'Move'}</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    align-self: flex-start;
  }
  .seg button {
    display: flex;
    gap: 6px;
    align-items: center;
    height: 30px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
  }
  .seg button.on {
    background: var(--card-solid);
    box-shadow: var(--shadow-card);
    color: var(--accent);
  }
  .dests {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 220px;
    overflow: auto;
  }
  .dest {
    display: flex;
    align-items: center;
    gap: 8px;
    border-radius: var(--r-sm);
    border: 0;
    background: transparent;
    padding: 0 0 0 0;
    text-align: left;
  }
  button.dest {
    height: 34px;
    padding: 0 10px;
  }
  .dest:hover {
    background: var(--hover);
  }
  .dest.on {
    background: var(--sel);
  }
  .pick {
    flex: 1;
    min-width: 0;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    text-align: left;
  }
  .pick .path {
    flex: 1;
    min-width: 0;
  }
  .pin {
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-3);
    display: grid;
    place-items: center;
  }
  .pin.pinned {
    color: var(--accent);
  }
  .pin:hover {
    background: var(--hover);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
</style>
