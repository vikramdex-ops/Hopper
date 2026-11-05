<script lang="ts">
  import type { Pane } from '../lib/pane.svelte'
  import { VIRTUAL, isVirtual } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { fmtSize, plural } from '../lib/format'
  import { dialogs } from '../lib/commands'
  import TabStrip from './TabStrip.svelte'
  import Breadcrumb from './Breadcrumb.svelte'
  import FileList from './FileList.svelte'
  import HomeView from './HomeView.svelte'
  import InboxView from './InboxView.svelte'
  import ActivityView from './ActivityView.svelte'
  import Icon from './Icon.svelte'

  let { pane }: { pane: Pane } = $props()
  const active = $derived(app.dual && app.activeIndex === pane.index)
  const sel = $derived(pane.selected)
  const selBytes = $derived(sel.reduce((a, e) => a + (e.dir ? 0 : e.size), 0))
  const totalBytes = $derived(pane.rows.reduce((a, e) => a + (e.dir ? 0 : e.size), 0))
  let filterOpen = $state(false)
  let filterInput: HTMLInputElement | undefined = $state()

  dialogs[`filter${pane.index}`] = () => {
    filterOpen = true
    queueMicrotask(() => filterInput?.focus())
  }
  dialogs.filter = () => dialogs[`filter${app.activeIndex}`]?.()

  function historyMenu(e: MouseEvent, dir: -1 | 1) {
    e.preventDefault()
    const t = pane.tab
    const idx = dir < 0 ? [...Array(t.index).keys()].reverse() : [...Array(t.history.length - t.index - 1).keys()].map((k) => t.index + 1 + k)
    app.openMenu(e.clientX, e.clientY, idx.slice(0, 20).map((i) => ({ label: t.history[i], icon: 'folder', run: () => pane.jumpHistory(i) })))
  }
</script>

<section class="pane" class:active class:single={!app.dual} onmousedown={() => app.setActive(pane.index)} role="region" aria-label={`Pane ${pane.index + 1}`}>
  <TabStrip {pane} />
  <div class="card">
    <div class="nav">
      <button class="btn subtle icon sm" disabled={!pane.canBack} title="Back (Alt+Left)" onclick={() => pane.back()} oncontextmenu={(e) => historyMenu(e, -1)}><Icon name="back" /></button>
      <button class="btn subtle icon sm" disabled={!pane.canForward} title="Forward (Alt+Right)" onclick={() => pane.forward()} oncontextmenu={(e) => historyMenu(e, 1)}><Icon name="forward" /></button>
      <button class="btn subtle icon sm" disabled={!pane.canUp} title="Up (Alt+Up)" onclick={() => pane.up()}><Icon name="up" /></button>
      <button class="btn subtle icon sm" title="Refresh (F5)" onclick={() => pane.refresh()}><Icon name="refresh" /></button>
      <Breadcrumb {pane} />
      {#if filterOpen || pane.filter}
        <div class="filter">
          <Icon name="filter" />
          <input bind:this={filterInput} bind:value={pane.filter} placeholder="Filter (e.g. *.pdf or iso 07)" spellcheck="false"
            onkeydown={(e) => { if (e.key === 'Escape') { pane.filter = ''; filterOpen = false } if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget as HTMLElement).closest('.pane')?.querySelector<HTMLElement>('.list')?.focus(); if (pane.rows.length) pane.selectIndex(0) } }} />
          <button class="x" aria-label="Clear filter" onclick={() => { pane.filter = ''; filterOpen = false }}><Icon name="close" size={12} /></button>
        </div>
      {:else}
        <button class="btn subtle icon sm" title="Filter this folder (Ctrl+F)" onclick={() => dialogs[`filter${pane.index}`]?.()}><Icon name="filter" /></button>
      {/if}
    </div>

    {#if pane.path === VIRTUAL.home}
      <HomeView {pane} />
    {:else if pane.path === VIRTUAL.inbox}
      <InboxView {pane} />
    {:else if pane.path === VIRTUAL.activity}
      <ActivityView {pane} />
    {:else}
      <FileList {pane} />
    {/if}

    <footer class="status">
      {#if !isVirtual(pane.path) || pane.path.startsWith(VIRTUAL.search) || pane.path === VIRTUAL.recycle}
        <span>{plural(pane.rows.length, 'item')}{totalBytes ? ` · ${fmtSize(totalBytes)}` : ''}</span>
        {#if sel.length}<span class="selinfo">{plural(sel.length, 'item')} selected{selBytes ? ` · ${fmtSize(selBytes)}` : ''}</span>{/if}
        {#if pane.searchInfo}
          <span class="caption">{pane.searchInfo.done ? `Searched ${pane.searchInfo.scanned.toLocaleString()} items` : `Searching… ${pane.searchInfo.scanned.toLocaleString()} scanned`}</span>
        {/if}
        {#if pane.entries.length !== pane.rows.length && !pane.filter}
          <span class="caption" title="Hidden items or older revisions are not shown">{pane.entries.length - pane.rows.length} not shown</span>
        {/if}
      {/if}
      <span class="spacer"></span>
      <div class="views">
        <button class="btn subtle icon sm" class:on={pane.view === 'details'} title="Details" onclick={() => (pane.view = 'details', app.persistSoon())}><Icon name="details" /></button>
        <button class="btn subtle icon sm" class:on={pane.view === 'list'} title="List" onclick={() => (pane.view = 'list', app.persistSoon())}><Icon name="list" /></button>
        <button class="btn subtle icon sm" class:on={pane.view === 'grid'} title="Thumbnails" onclick={() => (pane.view = 'grid', app.persistSoon())}><Icon name="grid" /></button>
        {#if pane.view === 'grid'}
          <input class="zoom" type="range" min="48" max="256" step="8" value={app.settings?.thumbSize ?? 96} oninput={(e) => app.updateSettings({ thumbSize: Number((e.currentTarget as HTMLInputElement).value) })} title="Thumbnail size" />
        {/if}
      </div>
    </footer>
  </div>
</section>

<style>
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .card {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--card-solid);
    border: 1px solid var(--stroke);
    border-radius: 0 var(--r-lg) var(--r-lg) var(--r-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
    position: relative;
  }
  .pane.active .card {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--stroke));
  }
  .pane.active :global(.tab.active) {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, var(--stroke)), inset 0 2px 0 var(--accent);
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--divider);
  }
  .nav :global(.crumbs) {
    margin: 0 6px;
  }
  .filter {
    width: 220px;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 10px;
    border-radius: var(--r-sm);
    background: var(--input);
    border: 1px solid var(--control-stroke);
    border-bottom: 2px solid var(--accent);
    color: var(--text-2);
  }
  .filter input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    user-select: text;
  }
  .x {
    border: 0;
    background: transparent;
    width: 22px;
    height: 22px;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .x:hover {
    background: var(--hover);
  }
  .status {
    height: 32px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 6px 0 14px;
    font-size: 12px;
    color: var(--text-2);
    border-top: 1px solid var(--divider);
  }
  .selinfo {
    color: var(--text);
  }
  .views {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .views .on {
    background: var(--hover);
    color: var(--accent);
  }
  .zoom {
    width: 90px;
    accent-color: var(--accent);
    margin-left: 6px;
  }
</style>
