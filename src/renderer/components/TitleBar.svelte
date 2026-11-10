<script lang="ts">
  import { app } from '../lib/app.svelte'
  import { VIRTUAL } from '../lib/pane.svelte'
  import { dialogs } from '../lib/commands'
  import Icon from './Icon.svelte'
  import { basename } from '../lib/format'

  let q = $state('')
  let input: HTMLInputElement

  function submit(e: Event) {
    e.preventDefault()
    const text = q.trim()
    if (!text) return
    const root = app.active.searchRoot
    const params = new URLSearchParams({ q: text })
    if (root) params.set('root', root)
    void app.active.navigate(`${VIRTUAL.search}?${params}`)
    input.blur()
  }

  dialogs.search = () => input?.focus()
</script>

<header class="titlebar">
  <div class="brand">
    <svg class="logo" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="2" y="4" width="9" height="16" rx="2.5" fill="var(--accent)" />
      <rect x="13" y="4" width="9" height="16" rx="2.5" fill="var(--accent)" opacity=".55" />
      <path d="M9 12h6m-2.5-2.5L15 12l-2.5 2.5" stroke="var(--on-accent)" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="name">Hopper</span>
  </div>
  <form class="search" onsubmit={submit}>
    <Icon name="search" />
    <input
      bind:this={input}
      bind:value={q}
      placeholder={app.ready ? `Search ${app.active?.searchRoot ? basename(app.active.searchRoot) || app.active.searchRoot : 'this PC'}` : 'Search'}
      spellcheck="false"
      onkeydown={(e) => e.key === 'Escape' && (q = '', input.blur())}
    />
    <span class="kbd">Ctrl+E</span>
  </form>
  <div class="drag"></div>
  <div class="layout" role="group" aria-label="Pane layout">
    <button class:on={!app.dual} title="One pane (F10)" aria-label="One pane" aria-pressed={!app.dual} onclick={() => app.dual && app.toggleDual()}><Icon name="singlePane" size={15} /></button>
    <button class:on={app.dual} title="Two panes (F10)" aria-label="Two panes" aria-pressed={app.dual} onclick={() => !app.dual && app.toggleDual()}><Icon name="dualPane" size={15} /></button>
  </div>
  <div class="caption-space"></div>
</header>

<style>
  .titlebar {
    height: var(--title-h);
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding-left: 14px;
    -webkit-app-region: drag;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 220px;
    flex: none;
  }
  .name {
    font-size: 12px;
    color: var(--text-2);
  }
  .search {
    -webkit-app-region: no-drag;
    width: min(520px, 40vw);
    height: 32px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    background: var(--input);
    border: 1px solid var(--control-stroke);
    border-bottom-color: var(--control-stroke-bottom);
    color: var(--text-2);
  }
  .search:focus-within {
    background: var(--card-solid);
    border-bottom: 2px solid var(--accent);
  }
  .search input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    min-width: 0;
  }
  .search input::placeholder {
    color: var(--text-3);
  }
  .drag {
    flex: 1;
    height: 100%;
  }
  .layout {
    flex: none;
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-sm);
    background: var(--hover);
    -webkit-app-region: no-drag;
  }
  .layout button {
    width: 28px;
    height: 22px;
    border: 0;
    border-radius: calc(var(--r-sm) - 1px);
    background: transparent;
    color: var(--text-2);
    display: grid;
    place-items: center;
  }
  .layout button:hover {
    color: var(--text);
  }
  .layout button.on {
    background: var(--card-solid);
    color: var(--accent);
    box-shadow: 0 0 0 1px var(--stroke-2);
  }
  .caption-space {
    width: 140px;
    flex: none;
  }
</style>
