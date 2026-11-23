<script lang="ts">
  import { app } from '../lib/app.svelte'
  import { engine } from '../lib/api'
  import { VIRTUAL } from '../lib/pane.svelte'
  import { dialogs } from '../lib/commands'
  import Icon from './Icon.svelte'
  import { basename } from '../lib/format'
  import { compileQuery, FILTER_HELP } from '@shared/listing'

  let q = $state('')
  let input: HTMLInputElement
  let help = $state(false)
  let focused = $state(false)

  // The box mirrors the active pane: while it shows search results, their query is here (and
  // comes back when you return to them with Back or switch tabs/panes); once the pane shows
  // anything else, the box is empty again - unless you are typing in it right now.
  const shownQuery = $derived.by(() => {
    const p = app.ready ? app.active?.path ?? '' : ''
    return p.startsWith(VIRTUAL.search) ? new URLSearchParams(p.split('?')[1] ?? '').get('q') ?? '' : ''
  })
  const searching = $derived(!!shownQuery)
  const info = $derived(searching ? app.active?.searchInfo : null)
  $effect(() => {
    const s = shownQuery
    if (!focused) q = s
  })

  /** End the search: back to the folder it searched (or Home), box cleared. */
  function closeSearch() {
    q = ''
    help = false
    const root = app.active.searchRoot
    void app.active.navigate(root || VIRTUAL.home)
  }
  // values the query language did not understand: shown under the box, ignored by the search
  const hints = $derived(q.trim() ? compileQuery(q).hints : [])

  function insert(example: string) {
    const token = example.split(/\s+/)[0]
    q = q.trim() ? `${q.trim()} ${token}` : token
    input.focus()
  }

  function focusOut(e: FocusEvent) {
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return
    help = false
    focused = false
    // left the box without searching: show what the pane shows, not a half-typed query
    q = shownQuery
  }

  function submit(e: Event) {
    e.preventDefault()
    const text = q.trim()
    if (!text) {
      if (searching) closeSearch()
      return
    }
    const root = app.active.searchRoot
    const params = new URLSearchParams({ q: text })
    if (root) params.set('root', root)
    void app.active.navigate(`${VIRTUAL.search}?${params}`)
    help = false
    focused = false
    input.blur()
  }

  dialogs.search = () => {
    input?.focus()
    input?.select()
  }
  dialogs.searchHelp = () => {
    help = true
    input?.focus()
  }
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
  <form class="search" class:active={searching && !focused} onsubmit={submit} onfocusin={() => {
    // load sleeping indexes while the query is typed, so Enter answers at once
    if (!focused) void engine.call('index.warm', app.active?.searchRoot || undefined).catch(() => {})
    focused = true
  }} onfocusout={focusOut}>
    <Icon name="search" />
    <input
      bind:this={input}
      bind:value={q}
      placeholder={app.ready ? `Search ${app.active?.searchRoot ? basename(app.active.searchRoot) || app.active.searchRoot : 'this PC'}` : 'Search'}
      spellcheck="false"
      onkeydown={(e) => {
        if (e.key !== 'Escape') return
        if (help) help = false
        else {
          q = shownQuery
          input.blur()
        }
      }}
    />
    {#if searching && info && !focused}
      <span class="count" class:busy={!info.done} title={info.done ? `${info.hits} found, ${info.scanned.toLocaleString('en-GB')} items looked at` : 'Searching…'}>
        {info.done ? `${info.hits.toLocaleString('en-GB')} found` : `${info.hits.toLocaleString('en-GB')}…`}
      </span>
    {/if}
    {#if q || searching}
      <button type="button" class="helpbtn" title={searching ? 'Close search and go back to the folder' : 'Clear'} aria-label="Clear search"
        onclick={() => (searching ? closeSearch() : ((q = ''), input.focus()))}><Icon name="close" size={14} /></button>
    {/if}
    {#if hints.length}<span class="hintdot" title={hints.join('\n')}><Icon name="warning" size={14} /></span>{/if}
    <button type="button" class="helpbtn" class:on={help} title="Search filters" aria-label="Search filters" aria-expanded={help} onclick={() => (help = !help)}><Icon name="info" size={14} /></button>
    <span class="kbd">Ctrl+E</span>
    {#if help || hints.length}
      <div class="pop" role="dialog" aria-label="Search filters">
        {#each hints as h (h)}<div class="hint"><Icon name="warning" size={12} /> {h} — ignored</div>{/each}
        {#if help}
          <div class="ptitle">Search filters</div>
          <div class="grid">
            {#each FILTER_HELP as f (f.example)}
              <button type="button" class="ex" title="Add to the search" onclick={() => insert(f.example)}>{f.example}</button>
              <span class="meaning">{f.meaning}</span>
            {/each}
          </div>
          <div class="pfoot">Combine them: <code>iso type:pdf date:thisweek</code>. They also work in Filter this folder (Ctrl+F).</div>
        {/if}
      </div>
    {/if}
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
  /* results of this query are on screen */
  .search.active {
    background: color-mix(in srgb, var(--accent) 10%, var(--input));
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    color: var(--accent);
  }
  .search.active input {
    font-weight: 600;
  }
  .count {
    font-size: 11px;
    white-space: nowrap;
    padding: 1px 7px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
  }
  .count.busy {
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }
  .search input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    min-width: 0;
  }
  .search {
    position: relative;
  }
  .helpbtn {
    border: 0;
    background: transparent;
    color: var(--text-3);
    width: 22px;
    height: 22px;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
  }
  .helpbtn:hover,
  .helpbtn.on {
    background: var(--hover);
    color: var(--text);
  }
  .hintdot {
    color: var(--warn);
    display: flex;
  }
  .pop {
    position: absolute;
    top: 36px;
    left: 0;
    right: 0;
    z-index: 50;
    -webkit-app-region: no-drag;
    padding: 10px 12px;
    background: var(--card-solid);
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-flyout, var(--shadow-card));
    color: var(--text);
    font-size: 12px;
  }
  .hint {
    color: var(--warn);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
  }
  .ptitle {
    font-weight: 600;
    margin: 2px 0 6px;
  }
  .grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    align-items: center;
  }
  .ex {
    border: 0;
    background: var(--hover);
    border-radius: var(--r-sm);
    padding: 2px 6px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
    text-align: left;
    white-space: nowrap;
  }
  .ex:hover {
    background: var(--sel);
  }
  .meaning {
    color: var(--text-2);
  }
  .pfoot {
    margin-top: 8px;
    color: var(--text-2);
  }
  .pfoot code {
    font-family: var(--mono);
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
