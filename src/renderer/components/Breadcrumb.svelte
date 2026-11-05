<script lang="ts">
  import type { Pane } from '../lib/pane.svelte'
  import { VIRTUAL, isArchivePath, isVirtual, splitArchive, titleFor } from '../lib/pane.svelte'
  import { app } from '../lib/app.svelte'
  import { engine } from '../lib/api'
  import { basename, collator, join } from '../lib/format'
  import { dialogs } from '../lib/commands'
  import { dropPaths, dropOp } from '../lib/dnd'
  import type { Entry } from '@shared/types'
  import Icon from './Icon.svelte'

  let { pane }: { pane: Pane } = $props()
  let editing = $state(false)
  let text = $state('')
  let input: HTMLInputElement | undefined = $state()
  let suggestions = $state<string[]>([])
  let hot = $state(-1)
  let dropIdx = $state(-1)
  let bar: HTMLDivElement | undefined = $state()

  // Long paths: keep the current folder in view (the start of the path scrolls off).
  $effect(() => {
    void crumbs
    if (bar && !editing) queueMicrotask(() => bar && (bar.scrollLeft = bar.scrollWidth))
  })

  interface Crumb {
    label: string
    path: string
  }

  const crumbs = $derived.by<Crumb[]>(() => {
    const p = pane.path
    if (isVirtual(p)) return [{ label: titleFor(p), path: p }]
    const out: Crumb[] = [{ label: 'This PC', path: VIRTUAL.home }]
    let base = p
    let inner = ''
    if (isArchivePath(p)) {
      const a = splitArchive(p)
      base = a.file
      inner = a.inner
    }
    if (base.startsWith('\\\\')) {
      const parts = base.slice(2).split('\\').filter(Boolean)
      let acc = '\\\\' + parts[0]
      out.push({ label: parts[0], path: acc })
      for (const part of parts.slice(1)) {
        acc += '\\' + part
        out.push({ label: part, path: acc })
      }
    } else {
      const parts = base.split('\\').filter(Boolean)
      let acc = ''
      for (const part of parts) {
        acc = acc ? join(acc, part) : part + '\\'
        const d = app.drives.find((x) => x.root.toLowerCase() === acc.toLowerCase())
        out.push({ label: acc.length === 3 ? `${d?.label || 'Local Disk'} (${part})` : part, path: acc })
      }
    }
    if (isArchivePath(p)) {
      out[out.length - 1].path = `${base}::`
      let acc = ''
      for (const part of inner.split('/').filter(Boolean)) {
        acc = acc ? `${acc}/${part}` : part
        out.push({ label: part, path: `${base}::${acc}` })
      }
    }
    return out
  })

  function startEdit() {
    if (isVirtual(pane.path) && !pane.path.startsWith(VIRTUAL.search)) text = ''
    else text = pane.path.startsWith(VIRTUAL.search) ? '' : pane.path
    editing = true
    queueMicrotask(() => {
      input?.focus()
      input?.select()
    })
  }

  dialogs.address = () => app.active === pane && startEdit()

  async function suggest() {
    const t = text.trim()
    const i = t.lastIndexOf('\\')
    if (i < 2) {
      suggestions = app.drives.map((d) => d.root).filter((r) => r.toLowerCase().startsWith(t.toLowerCase()))
      return
    }
    const parent = t.slice(0, i + 1)
    const frag = t.slice(i + 1).toLowerCase()
    try {
      const r = await engine.call<{ entries: Entry[] }>('fs.list', parent)
      if (text.trim() !== t) return
      suggestions = r.entries.filter((e) => e.dir && e.name.toLowerCase().startsWith(frag)).map((e) => e.path).sort(collator.compare).slice(0, 12)
      hot = -1
    } catch {
      suggestions = []
    }
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      editing = false
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = hot >= 0 ? suggestions[hot] : text.trim()
      editing = false
      if (!target) return
      if (/^(https?:)/i.test(target)) void window.hopper.shell.openExternal(target)
      else if (!/^([a-zA-Z]:|\\\\|hopper:)/.test(target)) {
        // Not a path: treat as a search in the current folder.
        const params = new URLSearchParams({ q: target })
        if (!isVirtual(pane.path)) params.set('root', pane.path)
        void pane.navigate(`${VIRTUAL.search}?${params}`)
      } else void pane.navigate(target)
    } else if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault()
      hot = (hot + 1) % suggestions.length
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault()
      hot = (hot - 1 + suggestions.length) % suggestions.length
    } else if (e.key === 'Tab' && suggestions.length) {
      e.preventDefault()
      text = (suggestions[Math.max(0, hot)] ?? text) + '\\'
      void suggest()
    }
  }

  async function children(e: MouseEvent, c: Crumb) {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    let dirs: Entry[] = []
    try {
      if (c.path === VIRTUAL.home) {
        app.openMenu(r.left, r.bottom + 4, app.drives.map((d) => ({ label: `${d.label || 'Local Disk'} (${d.root.slice(0, 2)})`, icon: 'drive', run: () => pane.navigate(d.root) })))
        return
      }
      if (isArchivePath(c.path)) {
        const a = splitArchive(c.path)
        dirs = (await engine.call<Entry[]>('archive.listDir', a.file, a.inner)).filter((x) => x.dir)
      } else dirs = (await engine.call<{ entries: Entry[] }>('fs.list', c.path)).entries.filter((x) => x.dir && !(x.attrs & 2))
    } catch {
      /* unreadable */
    }
    dirs.sort((a, b) => collator.compare(a.name, b.name))
    app.openMenu(r.left, r.bottom + 4, dirs.length ? dirs.slice(0, 300).map((d) => ({ label: d.name, icon: 'folder', run: () => pane.navigate(d.path) })) : [{ label: 'No folders', disabled: true }])
  }

  async function drop(e: DragEvent, c: Crumb, i: number) {
    e.preventDefault()
    dropIdx = -1
    if (isVirtual(c.path) || i === crumbs.length - 1) return
    const paths = dropPaths(e)
    if (paths.length) await app.transfer(dropOp(e, paths, c.path), paths, c.path)
  }
</script>

<div class="crumbs" bind:this={bar} class:editing role="navigation" onclick={(e) => e.target === e.currentTarget && startEdit()} onkeydown={() => {}}>
  {#if editing}
    <input
      bind:this={input}
      class="edit"
      bind:value={text}
      spellcheck="false"
      oninput={suggest}
      onkeydown={key}
      onblur={() => setTimeout(() => (editing = false), 150)}
      placeholder="Type a path, or words to search"
    />
    {#if suggestions.length}
      <div class="suggest">
        {#each suggestions as s, i (s)}
          <button class:hot={i === hot} onmousedown={(e) => { e.preventDefault(); editing = false; void pane.navigate(s) }}>
            <Icon name="folder" /> <span class="ellipsis">{s}</span>
          </button>
        {/each}
      </div>
    {/if}
  {:else}
    <span class="lead"><Icon name={pane.path === VIRTUAL.home ? 'home' : isArchivePath(pane.path) ? 'zip' : pane.path.startsWith('\\\\') ? 'network' : isVirtual(pane.path) ? 'activity' : 'folder'} /></span>
    {#each crumbs as c, i (c.path)}
      {#if i > 0}
        <!-- the chevron before a crumb lists the folders inside the previous crumb -->
        <button class="chev" tabindex="-1" aria-label={`Folders in ${crumbs[i - 1].label}`} onclick={(e) => children(e, crumbs[i - 1])}><Icon name="chevronRight" size={12} /></button>
      {/if}
      <button class="seg" class:drop={dropIdx === i} class:last={i === crumbs.length - 1} title={c.path}
        onclick={() => pane.navigate(c.path)}
        onauxclick={(e) => e.button === 1 && pane.openTab(c.path)}
        ondragover={(e) => { e.preventDefault(); dropIdx = i }} ondragleave={() => (dropIdx = -1)} ondrop={(e) => drop(e, c, i)}>
        {c.label}
      </button>
    {/each}
    {#if !isVirtual(pane.path)}
      <button class="chev" tabindex="-1" aria-label="Subfolders" onclick={(e) => children(e, crumbs[crumbs.length - 1])}><Icon name="chevronDown" size={12} /></button>
    {/if}
    <span class="fill" onclick={startEdit} onkeydown={() => {}} role="presentation"></span>
  {/if}
</div>

<style>
  .crumbs {
    flex: 1;
    min-width: 0;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 4px;
    border-radius: var(--r-sm);
    background: var(--input);
    border: 1px solid var(--control-stroke);
    position: relative;
    overflow: hidden;
  }
  .crumbs.editing {
    overflow: visible;
    border-bottom: 2px solid var(--accent);
    background: var(--card-solid);
  }
  .lead {
    display: flex;
    padding: 0 6px 0 4px;
    color: var(--text-2);
  }
  .seg {
    border: 0;
    background: transparent;
    height: 24px;
    padding: 0 6px;
    border-radius: var(--r-sm);
    white-space: nowrap;
    color: var(--text-2);
    flex: none;
  }
  .seg.last {
    color: var(--text);
  }
  .seg:hover,
  .chev:hover {
    background: var(--hover);
    color: var(--text);
  }
  .seg.drop {
    background: var(--sel);
    outline: 1px solid var(--accent);
  }
  .chev {
    border: 0;
    background: transparent;
    width: 18px;
    height: 24px;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
    color: var(--text-3);
    flex: none;
  }
  .chev.hidden {
    display: none;
  }
  .fill {
    flex: 1;
    align-self: stretch;
  }
  .edit {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    height: 100%;
    padding: 0 6px;
    user-select: text;
  }
  .suggest {
    position: absolute;
    top: 34px;
    left: -1px;
    right: -1px;
    z-index: 50;
    background: var(--flyout);
    border: 1px solid var(--stroke-2);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-flyout);
    padding: 4px;
    backdrop-filter: blur(20px);
  }
  .suggest button {
    width: 100%;
    display: flex;
    gap: 8px;
    align-items: center;
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
  }
  .suggest button:hover,
  .suggest .hot {
    background: var(--hover);
  }
</style>
