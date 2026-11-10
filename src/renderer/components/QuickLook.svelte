<script lang="ts">
  import { app } from '../lib/app.svelte'
  import { typeLabel, richMode } from '../lib/filetypes'
  import { docViewer, openDocViewer } from '../lib/docviewer.svelte'
  import DocViewer from './viewers/DocViewer.svelte'
  import { fmtDate, fmtSize } from '../lib/format'
  import Preview from './Preview.svelte'
  import Icon from './Icon.svelte'

  // Quick Look follows the pane's focus: arrow keys still move in the list underneath.
  $effect(() => {
    if (!app.quickLook) return
    const f = app.active.focused
    if (f && f.path !== app.quickLook.path) app.quickLook = f
  })

  function key(e: KeyboardEvent) {
    // The full-window viewer sits on top and owns the keyboard while it is open.
    if (!app.quickLook || docViewer.entry) return
    if (e.key === 'Escape' || (e.key === ' ' && !(e.target instanceof HTMLInputElement))) {
      e.preventDefault()
      e.stopPropagation()
      app.quickLook = null
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      e.stopPropagation()
      const p = app.active
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      p.selectIndex(Math.max(0, Math.min(p.rows.length - 1, p.focus + step)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const f = app.quickLook
      app.quickLook = null
      void app.openEntry(f)
    }
  }
</script>

<svelte:window onkeydowncapture={key} />

{#if app.quickLook}
  {@const e = app.quickLook}
  <div class="scrim" onmousedown={() => (app.quickLook = null)} role="presentation"></div>
  <div class="ql" role="dialog" aria-label={`Quick Look: ${e.name}`}>
    <header>
      <div class="meta">
        <div class="name ellipsis">{e.name}</div>
        <div class="caption">{typeLabel(e.ext, e.dir)}{e.dir ? '' : ` · ${fmtSize(e.size)}`} · {fmtDate(e.mtime)}</div>
      </div>
      {#if !e.dir && richMode(e.ext)}
        <button class="btn sm" title="View in full window" onclick={() => openDocViewer(e)}><Icon name="fullscreen" /> View</button>
      {/if}
      <button class="btn sm" onclick={() => { app.quickLook = null; void app.openEntry(e) }}><Icon name="open" /> Open</button>
      <button class="btn subtle icon sm" aria-label="Close" onclick={() => (app.quickLook = null)}><Icon name="close" /></button>
    </header>
    <div class="body">
      <Preview entry={e} large />
    </div>
    <footer class="caption">↑ ↓ next / previous · Enter open · Space or Esc close</footer>
  </div>
{/if}

<DocViewer />

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 950;
    background: var(--scrim);
  }
  .ql {
    position: fixed;
    z-index: 951;
    inset: 6vh 10vw;
    display: flex;
    flex-direction: column;
    border-radius: var(--r-xl);
    background: var(--card-solid);
    border: 1px solid var(--stroke-2);
    box-shadow: var(--shadow-dialog);
    overflow: hidden;
    animation: pop var(--mid) var(--ease);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.98);
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 10px 10px 18px;
    border-bottom: 1px solid var(--divider);
  }
  .meta {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 600;
  }
  .body {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }
  footer {
    padding: 6px 18px;
    border-top: 1px solid var(--divider);
  }
</style>
