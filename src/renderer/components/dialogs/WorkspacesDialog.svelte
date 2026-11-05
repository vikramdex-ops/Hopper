<script lang="ts">
  // Workspaces: saved pane layouts (tabs of both panes plus dual mode). Open, rename, delete, save.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { plural } from '../../lib/format'
  import { titleFor } from '../../lib/pane.svelte'
  import type { Workspace } from '@shared/types'

  let { close }: { close: (v?: unknown) => void } = $props()

  const list = $derived(app.settings?.workspaces ?? [])
  let name = $state('')

  function summary(ws: Workspace) {
    const panes = ws.dual ? ws.panes : [ws.panes[0]]
    return panes.map((p) => {
      const t = p.tabs[p.active] ?? p.tabs[0]
      const extra = p.tabs.length > 1 ? ` +${p.tabs.length - 1}` : ''
      return t ? `${t.title || titleFor(t.path)}${extra}` : '—'
    })
  }

  function save() {
    const n = name.trim()
    if (!n) return
    const same = list.find((w) => w.name.toLowerCase() === n.toLowerCase())
    if (same) return replace(same)
    app.saveWorkspace(n)
    name = ''
  }

  async function replace(ws: Workspace) {
    if (!(await app.confirm(`Replace "${ws.name}" with the current layout?`, undefined, 'Replace'))) return
    const next: Workspace = { ...ws, panes: [app.panes[0].state(), app.panes[1].state()], dual: app.dual }
    app.updateSettings({ workspaces: list.map((w) => (w.id === ws.id ? next : w)) })
    app.toast('success', `Updated workspace "${ws.name}"`)
    name = ''
  }

  async function rename(ws: Workspace) {
    const n = (await app.prompt('Rename workspace', ws.name, 'Name'))?.trim()
    if (!n || n === ws.name) return
    app.updateSettings({ workspaces: list.map((w) => (w.id === ws.id ? { ...w, name: n } : w)) })
  }

  async function remove(ws: Workspace) {
    if (!(await app.confirm(`Delete workspace "${ws.name}"?`, 'Only the saved layout is removed; no files are touched.', 'Delete'))) return
    app.updateSettings({ workspaces: list.filter((w) => w.id !== ws.id) })
  }

  function move(ws: Workspace, d: -1 | 1) {
    const i = list.findIndex((w) => w.id === ws.id)
    const j = i + d
    if (j < 0 || j >= list.length) return
    const next = list.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    app.updateSettings({ workspaces: next })
  }

  async function open(ws: Workspace) {
    close(true)
    await app.openWorkspace($state.snapshot(ws) as Workspace)
  }
</script>

<Dialog title="Workspaces" icon="workspace" width={600} onclose={() => close()} onsubmit={save}>
  <label class="field">
    <span>Save the current layout as</span>
    <div class="row">
      <input class="input" bind:value={name} placeholder="e.g. FST lot 07 back-check" spellcheck="false" autofocus />
      <button type="submit" class="btn" disabled={!name.trim()}><Icon name="plus" /> Save current</button>
    </div>
  </label>

  {#if !list.length}
    <div class="caption">No workspaces yet. A workspace remembers every tab in both panes, so you can switch jobs in one click.</div>
  {:else}
    <div class="list">
      {#each list as ws, i (ws.id)}
        <div class="ws">
          <button type="button" class="main" onclick={() => open(ws)} title="Open this workspace">
            <Icon name="workspace" size={20} />
            <span class="txt">
              <span class="ellipsis nm">{ws.name}</span>
              <span class="caption ellipsis">{summary(ws).join('  |  ')} · {plural(ws.panes[0].tabs.length + (ws.dual ? ws.panes[1].tabs.length : 0), 'tab')}{ws.dual ? '' : ' · single pane'}</span>
            </span>
          </button>
          <button type="button" class="btn subtle icon sm" title="Move up" aria-label="Move up" disabled={i === 0} onclick={() => move(ws, -1)}><Icon name="chevronUp" /></button>
          <button type="button" class="btn subtle icon sm" title="Move down" aria-label="Move down" disabled={i === list.length - 1} onclick={() => move(ws, 1)}><Icon name="chevronDown" /></button>
          <button type="button" class="btn subtle icon sm" title="Replace with the current layout" aria-label="Replace with the current layout" onclick={() => replace(ws)}><Icon name="refresh" /></button>
          <button type="button" class="btn subtle icon sm" title="Rename" aria-label="Rename" onclick={() => rename(ws)}><Icon name="rename" /></button>
          <button type="button" class="btn subtle icon sm" title="Delete" aria-label="Delete" onclick={() => remove(ws)}><Icon name="delete" /></button>
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
    gap: 2px;
    max-height: 50vh;
    overflow: auto;
  }
  .ws {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--r-md);
    padding-right: 4px;
  }
  .ws:hover {
    background: var(--hover);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border: 0;
    background: transparent;
    text-align: left;
    color: inherit;
  }
  .main :global(svg) {
    color: var(--accent);
  }
  .txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .nm {
    font-weight: 600;
  }
</style>
