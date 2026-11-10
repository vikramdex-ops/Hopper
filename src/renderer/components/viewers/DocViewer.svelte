<script lang="ts">
  // Full-window viewer for documents and drawings, opened from a preview's "View" button or by
  // double-clicking it. Esc closes. While it is open, keys stay inside it (no file commands).
  import { app } from '../../lib/app.svelte'
  import { closeDocViewer, docViewer } from '../../lib/docviewer.svelte'
  import { richMode, typeLabel } from '../../lib/filetypes'
  import { fmtDate, fmtSize } from '../../lib/format'
  import Icon from '../Icon.svelte'
  import RichPreview from './RichPreview.svelte'

  let root: HTMLDivElement | undefined = $state()
  const e = $derived(docViewer.entry)
  const mode = $derived(e ? (docViewer.mode ?? richMode(e.ext)) : null)

  $effect(() => {
    if (e && root) root.focus()
  })

  function capture(ev: KeyboardEvent) {
    if (!docViewer.entry) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      closeDocViewer()
    } else if (root && !root.contains(ev.target as Node)) {
      // Focus is somewhere behind the viewer: don't let the file list act on the key.
      ev.stopPropagation()
    }
  }
</script>

<svelte:window onkeydowncapture={capture} />

{#if e && mode}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="docv" bind:this={root} tabindex="-1" role="dialog" aria-label={`Viewer: ${e.name}`} onkeydown={(ev) => ev.stopPropagation()}>
    <header>
      <span class="name ellipsis">{e.name}</span>
      <span class="caption ellipsis">{typeLabel(e.ext)} · {fmtSize(e.size)} · {fmtDate(e.mtime)}</span>
      <span class="spacer"></span>
      <button class="btn sm" title="Open with the default app" onclick={() => app.openEntry(e)}><Icon name="open" /> Open</button>
      <button class="btn subtle icon sm" title="Close (Esc)" aria-label="Close" onclick={closeDocViewer}><Icon name="close" /></button>
    </header>
    <div class="body">
      {#key e.path}<RichPreview entry={e} {mode} size="full" />{/key}
    </div>
  </div>
{/if}

<style>
  .docv {
    position: fixed;
    inset: 0;
    z-index: 980;
    display: flex;
    flex-direction: column;
    background: var(--bg-solid);
    outline: none;
  }
  header {
    height: var(--title-h);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 150px 0 16px;
    flex: none;
    -webkit-app-region: drag;
    border-bottom: 1px solid var(--divider);
  }
  header :global(.btn) {
    -webkit-app-region: no-drag;
  }
  .name {
    font-weight: 600;
    max-width: 45%;
  }
  .caption {
    min-width: 0;
  }
  .body {
    flex: 1;
    min-height: 0;
    padding: 8px 12px 12px;
    display: flex;
    flex-direction: column;
  }
</style>
