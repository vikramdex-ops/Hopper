<script lang="ts">
  // New folders from a template: pick one, fill {name} {project} {date}, preview the tree, create it
  // in the current folder. Templates come from the shared office config (Settings → Office).
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine } from '../../lib/api'
  import { plural } from '../../lib/format'
  import { isVirtual } from '../../lib/pane.svelte'
  import type { FolderTemplate } from '@shared/types'
  import type { TemplateResult } from '../../../engine/office/types'

  let { close }: { close: (v?: unknown) => void } = $props()

  const today = () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  let templates = $state<FolderTemplate[] | null>(null)
  let loadError = $state('')
  let id = $state('')
  let name = $state('')
  let project = $state('')
  let date = $state(today())
  let error = $state('')
  let busy = $state(false)
  const dest = app.active.path
  const destOk = !isVirtual(dest)

  void engine.call<FolderTemplate[]>('templates.list').then(
    (t) => {
      templates = t
      id = t[0]?.id ?? ''
    },
    (e) => {
      templates = []
      loadError = e?.message ?? String(e)
    }
  )

  const tpl = $derived(templates?.find((t) => t.id === id) ?? null)
  const used = $derived(new Set((tpl?.folders ?? []).flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))))
  const values = $derived<Record<string, string>>({ name: name.trim(), project: project.trim(), date: date.trim() })
  const missing = $derived([...used].filter((k) => !values[k]))

  type Node = { label: string; depth: number; pending: boolean }
  /** The tree after substitution, parents first; unfilled tokens stay visible as {token}. */
  const preview = $derived.by(() => {
    type T = { label: string; kids: Map<string, T> }
    const root: T = { label: '', kids: new Map() }
    for (const raw of tpl?.folders ?? []) {
      let cur = root
      for (const s of raw.split(/[\\/]+/).filter(Boolean)) {
        const label = s.replace(/\{(\w+)\}/g, (t, k: string) => values[k] || t)
        const key = label.toLowerCase() // Windows names are case-insensitive
        let next = cur.kids.get(key)
        if (!next) cur.kids.set(key, (next = { label, kids: new Map() }))
        cur = next
      }
    }
    const nodes: Node[] = []
    const walk = (t: T, depth: number) => {
      for (const k of t.kids.values()) {
        nodes.push({ label: k.label, depth, pending: /\{\w+\}/.test(k.label) })
        walk(k, depth + 1)
      }
    }
    walk(root, 0)
    return nodes
  })

  const problem = $derived(
    !destOk ? 'Open a real folder first; templates cannot be created here' :
    !tpl ? '' :
    missing.length ? `Fill in ${missing.map((k) => `{${k}}`).join(', ')}` :
    used.has('date') && !/^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? 'Date must be YYYY-MM-DD' :
    ''
  )

  async function go() {
    if (!tpl || problem || busy) return
    busy = true
    error = ''
    try {
      const vars = { name: name.trim() || undefined, project: project.trim() || undefined, date: date.trim() || undefined }
      const r = await engine.call<TemplateResult>('templates.create', tpl.id, dest, vars)
      void app.active.refresh()
      if (r.created.length) app.toast('success', `Created ${plural(r.created.length, 'folder')}`, `${tpl.name} in ${dest}`)
      else app.toast('info', 'Nothing to create', 'Every folder in the template already exists here.')
      close(true)
    } catch (e: any) {
      error = e?.message ?? String(e)
    } finally {
      busy = false
    }
  }
</script>

<Dialog title="New from template" icon="template" width={600} onclose={() => close()} onsubmit={go}>
  {#if templates === null}
    <div class="caption">Loading templates…</div>
  {:else if !templates.length}
    <div class="emptybox">
      <Icon name="template" size={28} />
      <div>
        <div class="subtitle">No folder templates yet</div>
        <div class="caption">{loadError || 'Folder templates are configured in Settings → Office and shared with the whole office through the office config.'}</div>
      </div>
    </div>
  {:else}
    <div class="cols">
      <div class="tpls" role="listbox" aria-label="Templates">
        {#each templates as t (t.id)}
          <button type="button" role="option" aria-selected={t.id === id} class="tpl" class:on={t.id === id} onclick={() => (id = t.id)}>
            <Icon name="template" /> <span class="ellipsis">{t.name}</span>
            <span class="caption">{t.folders.length}</span>
          </button>
        {/each}
      </div>

      <div class="side">
        {#if used.has('name')}<label class="field"><span>Name <span class="caption">{'{name}'}</span></span><input class="input" bind:value={name} spellcheck="false" /></label>{/if}
        {#if used.has('project')}<label class="field"><span>Project <span class="caption">{'{project}'}</span></span><input class="input" bind:value={project} spellcheck="false" /></label>{/if}
        {#if used.has('date')}<label class="field"><span>Date <span class="caption">{'{date}'}, YYYY-MM-DD</span></span><input class="input" bind:value={date} spellcheck="false" /></label>{/if}

        <div class="tree" aria-label="Preview">
          <div class="node root" title={dest}><Icon name="folderOpen" size={14} /> <span class="ellipsis">{dest}</span></div>
          {#each preview as n, i (i)}
            <div class="node" class:pending={n.pending} style:padding-left={`${(n.depth + 1) * 16 + 6}px`}>
              <Icon name="folder" size={14} /> <span class="ellipsis">{n.label}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if problem}<div class="banner warn"><Icon name="warning" /> <span>{problem}</span></div>{/if}
  {#if error}<div class="banner bad"><Icon name="error" /> <span>{error}</span></div>{/if}

  {#snippet footer()}
    <button type="submit" class="btn primary" disabled={!tpl || !!problem || busy}><Icon name="newFolder" /> Create</button>
    <button type="button" class="btn" onclick={() => close()}>{templates?.length ? 'Cancel' : 'Close'}</button>
  {/snippet}
</Dialog>

<style>
  .cols {
    display: grid;
    grid-template-columns: 190px 1fr;
    gap: 16px;
    min-height: 220px;
  }
  .tpls {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tpl {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 10px;
    border-radius: var(--r-md);
    border: 1px solid transparent;
    background: transparent;
    text-align: left;
  }
  .tpl span:first-of-type {
    flex: 1;
  }
  .tpl:hover {
    background: var(--hover);
  }
  .tpl.on {
    background: var(--sel);
    border-color: var(--accent);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .tree {
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    padding: 4px 0;
    max-height: 260px;
    overflow: auto;
    font-size: 13px;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px 0 6px;
    min-width: 0;
  }
  .node.root {
    color: var(--text-2);
  }
  .node.pending {
    color: var(--text-3);
    font-style: italic;
  }
  .emptybox {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 16px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    color: var(--text-2);
  }
  .banner {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 12px;
    border-radius: var(--r-md);
    font-size: 13px;
  }
  .banner.warn {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
  }
  .banner.bad {
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 10%, transparent);
  }
</style>
