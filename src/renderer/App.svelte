<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from './lib/app.svelte'
  import { handleGlobalKey } from './lib/commands'
  import TitleBar from './components/TitleBar.svelte'
  import CommandBar from './components/CommandBar.svelte'
  import LanBanner from './components/LanBanner.svelte'
  import Sidebar from './components/Sidebar.svelte'
  import PaneView from './components/PaneView.svelte'
  import Inspector from './components/Inspector.svelte'
  import TransferDrawer from './components/TransferDrawer.svelte'
  import Toasts from './components/Toasts.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import Palette from './components/Palette.svelte'
  import QuickLook from './components/QuickLook.svelte'
  import ImageViewer from './components/ImageViewer.svelte'
  import DialogHost from './components/DialogHost.svelte'
  import Splitter from './components/Splitter.svelte'

  let split = $state(0.5)

  onMount(() => {
    void app.init()
    const onKey = (e: KeyboardEvent) => handleGlobalKey(e)
    window.addEventListener('keydown', onKey)
    // Mouse back/forward buttons
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) app.active?.back()
      if (e.button === 4) app.active?.forward()
    }
    window.addEventListener('mouseup', onMouse)
    // Files dropped outside a pane must never navigate the window.
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  })
</script>

<div class="shell" class:ready={app.ready}>
  <TitleBar />
  {#if app.ready && app.settings}
    <CommandBar />
    <LanBanner />
    <div class="body">
      <Sidebar />
      <main class="panes" class:dual={app.dual}>
        <div class="pane-slot" style:flex-basis={app.dual ? `${split * 100}%` : '100%'}>
          <PaneView pane={app.panes[0]} />
        </div>
        {#if app.dual}
          <Splitter onDrag={(f) => (split = Math.min(0.8, Math.max(0.2, f)))} />
          <div class="pane-slot" style:flex-basis={`${(1 - split) * 100}%`}>
            <PaneView pane={app.panes[1]} />
          </div>
        {/if}
      </main>
      {#if app.settings.inspector}
        <Inspector />
      {/if}
    </div>
    <TransferDrawer />
  {:else}
    <div class="boot">
      <div class="boot-logo"></div>
    </div>
  {/if}
</div>

<ContextMenu />
<Palette />
<QuickLook />
<ImageViewer />
<DialogHost />
<Toasts />

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
    padding: 0 8px 8px 0;
    gap: 0;
  }
  .panes {
    flex: 1;
    display: flex;
    min-width: 0;
    gap: 0;
  }
  .pane-slot {
    min-width: 260px;
    display: flex;
    flex-grow: 1;
    flex-shrink: 1;
  }
  .boot {
    flex: 1;
    display: grid;
    place-items: center;
  }
  .boot-logo {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 3px solid var(--stroke-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
