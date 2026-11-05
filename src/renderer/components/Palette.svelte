<script lang="ts">
  import { tick } from 'svelte'
  import { app } from '../lib/app.svelte'
  import { commands, type Command } from '../lib/commands'
  import { engine } from '../lib/api'
  import { basename } from '../lib/format'
  import type { Entry } from '@shared/types'
  import Icon from './Icon.svelte'

  let q = $state('')
  let hot = $state(0)
  let input: HTMLInputElement | undefined = $state()
  let folders = $state<Entry[]>([])
  let goToken = 0

  type Item = { kind: 'cmd'; cmd: Command } | { kind: 'path'; path: string; label: string; hint: string }

  const fuzzy = (text: string, query: string) => {
    let i = 0
    const t = text.toLowerCase()
    for (const ch of query.toLowerCase()) {
      i = t.indexOf(ch, i)
      if (i < 0) return false
      i++
    }
    return true
  }

  const items = $derived.by<Item[]>(() => {
    const query = q.trim()
    if (app.paletteMode === 'go' || query.startsWith('>') === false && /^([a-zA-Z]:|\\\\)/.test(query)) {
      const pins = (app.settings?.pinned ?? []).concat((app.settings?.quickDests ?? []).map((d) => d.path))
      const local: Item[] = [...new Set(pins)].filter((p) => !query || fuzzy(p, query)).slice(0, 8).map((p) => ({ kind: 'path', path: p, label: basename(p) || p, hint: p }))
      const found: Item[] = folders.map((f) => ({ kind: 'path', path: f.path, label: f.name, hint: f.path }))
      return [...local, ...found.filter((f) => !local.some((l) => l.kind === 'path' && f.kind === 'path' && l.path.toLowerCase() === f.path.toLowerCase()))]
    }
    const qq = query.replace(/^>/, '').trim()
    return commands
      .filter((c) => (!c.when || c.when()) && (!qq || fuzzy(`${c.group} ${c.label}`, qq)))
      .sort((a, b) => (qq ? Number(!b.label.toLowerCase().startsWith(qq.toLowerCase())) - Number(!a.label.toLowerCase().startsWith(qq.toLowerCase())) : 0))
      .map((cmd) => ({ kind: 'cmd', cmd }))
  })

  $effect(() => {
    if (app.palette) {
      q = ''
      hot = 0
      folders = []
      void tick().then(() => input?.focus())
    }
  })

  // "Go to folder" searches the index for folder names as you type.
  $effect(() => {
    const query = q.trim()
    if (!app.palette || app.paletteMode !== 'go' || query.length < 2) {
      folders = []
      return
    }
    const my = ++goToken
    const t = setTimeout(async () => {
      const r = await engine.call<{ entries: Entry[] }>('index.query', query, { limit: 30, dirsOnly: true }).catch(() => ({ entries: [] }))
      if (my === goToken) folders = r.entries
    }, 120)
    return () => clearTimeout(t)
  })

  function exec(it: Item | undefined) {
    if (!it) return
    app.palette = false
    if (it.kind === 'cmd') void it.cmd.run()
    else void app.active.navigate(it.path)
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      app.palette = false
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      hot = Math.min(items.length - 1, hot + 1)
      scrollHot()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      hot = Math.max(0, hot - 1)
      scrollHot()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[hot]
      if (!it && app.paletteMode === 'go' && /^([a-zA-Z]:|\\\\)/.test(q.trim())) {
        app.palette = false
        void app.active.navigate(q.trim())
      } else exec(it)
    }
  }

  function scrollHot() {
    void tick().then(() => document.querySelector('.pal .hot')?.scrollIntoView({ block: 'nearest' }))
  }
</script>

{#if app.palette}
  <div class="scrim" onmousedown={() => (app.palette = false)} role="presentation"></div>
  <div class="pal" role="dialog" aria-label="Command palette">
    <div class="in">
      <Icon name={app.paletteMode === 'go' ? 'folder' : 'command'} />
      <input bind:this={input} bind:value={q} oninput={() => (hot = 0)} onkeydown={key} spellcheck="false"
        placeholder={app.paletteMode === 'go' ? 'Go to a folder — type a name or a path' : 'Type a command'} />
      <button class="btn subtle sm" onclick={() => { app.paletteMode = app.paletteMode === 'go' ? 'commands' : 'go'; input?.focus() }}>{app.paletteMode === 'go' ? 'Commands' : 'Go to folder'}</button>
    </div>
    <div class="items">
      {#each items.slice(0, 80) as it, i (i)}
        <button class="it" class:hot={i === hot} onmouseenter={() => (hot = i)} onclick={() => exec(it)}>
          {#if it.kind === 'cmd'}
            <span class="ic"><Icon name={it.cmd.icon ?? 'command'} /></span>
            <span class="lbl">{it.cmd.label}</span>
            <span class="caption grp">{it.cmd.group}</span>
            {#if it.cmd.keys?.[0]}<span class="kbd">{it.cmd.keys[0]}</span>{/if}
          {:else}
            <span class="ic folder"><Icon name="folder" /></span>
            <span class="lbl">{it.label}</span>
            <span class="caption ellipsis hint">{it.hint}</span>
          {/if}
        </button>
      {/each}
      {#if !items.length}
        <div class="caption empty">{app.paletteMode === 'go' ? (q.trim().length < 2 ? 'Type at least two letters to search indexed folders.' : 'No matching folders.') : 'No matching commands.'}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 1000;
  }
  .pal {
    position: fixed;
    z-index: 1001;
    top: 72px;
    left: 50%;
    transform: translateX(-50%);
    width: min(640px, 90vw);
    border-radius: var(--r-xl);
    background: var(--flyout);
    border: 1px solid var(--stroke-2);
    box-shadow: var(--shadow-dialog);
    backdrop-filter: blur(30px) saturate(1.2);
    overflow: hidden;
    animation: pop var(--mid) var(--ease);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translate(-50%, -6px);
    }
  }
  .in {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 10px 16px;
    border-bottom: 1px solid var(--divider);
  }
  .in input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    font-size: 16px;
    height: 32px;
    user-select: text;
  }
  .items {
    max-height: 420px;
    overflow: auto;
    padding: 4px;
  }
  .it {
    width: 100%;
    height: 38px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--r-md);
    background: transparent;
    text-align: left;
    color: var(--text);
  }
  .it.hot {
    background: var(--hover);
  }
  .ic {
    display: flex;
  }
  .ic.folder {
    color: #e8a33d;
  }
  .lbl {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grp,
  .hint {
    flex: 1;
    min-width: 0;
  }
  .empty {
    padding: 16px;
    text-align: center;
  }
</style>
