<script lang="ts">
  import type { Pane } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { dropPaths, dropOp } from '../lib/dnd'
  import { isVirtual } from '../lib/pane.svelte'
  import Icon from './Icon.svelte'

  let { pane }: { pane: Pane } = $props()
  let dragFrom = -1
  let dropAt = $state(-1)

  function menu(e: MouseEvent, i: number) {
    e.preventDefault()
    const t = pane.tabs[i]
    app.openMenu(e.clientX, e.clientY, [
      { label: 'New tab', icon: 'plus', run: () => { pane.openTab(t.path); void pane.load() } },
      { label: 'Duplicate tab', icon: 'duplicate', run: () => { pane.active = i; pane.openTab(t.path); void pane.load() } },
      { label: t.locked ? 'Unlock tab' : 'Lock tab', icon: 'lock', run: () => { t.locked = !t.locked; app.persistSoon() } },
      { label: 'Rename tab…', icon: 'rename', run: async () => { const n = await app.prompt('Tab name', t.title ?? app.tabTitle(t)); if (n !== null) { t.title = n || undefined; app.persistSoon() } } },
      ...(app.dual ? [{ label: 'Open in other pane', icon: 'dualPane', run: () => app.other.navigate(t.path) }] : []),
      { separator: true },
      { label: 'Close tab', icon: 'close', keys: 'Ctrl+W', disabled: t.locked || pane.tabs.length < 2, run: () => pane.closeTab(i) },
      { label: 'Close other tabs', disabled: pane.tabs.length < 2, run: () => { pane.tabs = pane.tabs.filter((x, k) => k === i || x.locked); pane.active = pane.tabs.indexOf(t); void pane.load() } }
    ])
  }

  async function dropOnTab(e: DragEvent, i: number) {
    e.preventDefault()
    dropAt = -1
    if (dragFrom >= 0) {
      pane.moveTab(dragFrom, i)
      dragFrom = -1
      app.persistSoon()
      return
    }
    const paths = dropPaths(e)
    const dest = pane.tabs[i].path
    if (paths.length && !isVirtual(dest)) await app.transfer(dropOp(e, paths, dest), paths, dest)
  }
</script>

<div class="tabs" role="tablist">
  {#each pane.tabs as t, i (t.id)}
    <div
      class="tab"
      class:active={i === pane.active}
      class:drop={dropAt === i}
      role="tab"
      tabindex="-1"
      aria-selected={i === pane.active}
      title={t.path}
      draggable="true"
      onclick={() => pane.switchTab(i)}
      onauxclick={(e) => e.button === 1 && pane.closeTab(i)}
      oncontextmenu={(e) => menu(e, i)}
      ondragstart={(e) => { dragFrom = i; e.dataTransfer?.setData('text/x-hopper-tab', String(i)) }}
      ondragover={(e) => { e.preventDefault(); dropAt = i; if (dragFrom < 0 && i !== pane.active) pane.switchTab(i) }}
      ondragleave={() => (dropAt = -1)}
      ondrop={(e) => dropOnTab(e, i)}
      onkeydown={() => {}}
    >
      {#if t.locked}<Icon name="lock" size={12} />{/if}
      <span class="label ellipsis">{app.tabTitle(t)}</span>
      {#if !t.locked && pane.tabs.length > 1}
        <button class="x" tabindex="-1" aria-label="Close tab" onclick={(e) => { e.stopPropagation(); pane.closeTab(i) }}><Icon name="close" size={12} /></button>
      {/if}
    </div>
  {/each}
  <button class="add btn subtle icon sm" title="New tab (Ctrl+T)" onclick={() => { pane.openTab(pane.path); void pane.load() }}><Icon name="plus" /></button>
</div>

<style>
  .tabs {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 38px;
    padding: 4px 6px 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    flex: none;
  }
  .tab {
    height: 32px;
    min-width: 60px;
    max-width: 220px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 12px;
    border-radius: var(--r-md) var(--r-md) 0 0;
    color: var(--text-2);
    position: relative;
    flex: 0 1 auto;
  }
  .tab:hover {
    background: var(--hover);
    color: var(--text);
  }
  .tab.active {
    background: var(--card-solid);
    color: var(--text);
    box-shadow: 0 0 0 1px var(--stroke);
    clip-path: inset(-2px -2px 0 -2px);
  }
  .tab.drop {
    outline: 1px solid var(--accent);
  }
  .label {
    flex: 1;
    font-size: 13px;
  }
  .x {
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-2);
    display: grid;
    place-items: center;
    opacity: 0;
  }
  .tab:hover .x,
  .tab.active .x {
    opacity: 1;
  }
  .x:hover {
    background: var(--hover);
  }
  .add {
    margin-bottom: 2px;
  }
</style>
