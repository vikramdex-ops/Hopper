<script lang="ts">
  // New folders from a template: pick one, fill in the form the template declares, watch the live
  // preview (folder count, depth, warnings), create it in the current folder and open it.
  // Templates: built-in (Dexterity project, issue pack) plus the office config's (Settings → Office).
  // The engine does the expanding and checking; this only collects inputs and shows the result.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { plural } from '../../lib/format'
  import { isVirtual } from '../../lib/pane.svelte'
  import type { FolderTemplate } from '@shared/types'
  import { defaultValue, inputActive, inputsOf, isTree, normalize, rememberable, type TemplateInput, type Values } from '@shared/template-model'
  import type { TemplatePreview, TemplateResult } from '../../../engine/office/types'

  let { close }: { close: (v?: unknown) => void } = $props()

  type SubRow = { label: string; unit: string; areas: string }

  let templates = $state<FolderTemplate[] | null>(null)
  let loadError = $state('')
  let id = $state('')
  let values = $state<Values>({})
  let rootEdited = $state(false)
  let rootText = $state('')
  let pad = $state<'none' | '2'>('none')
  let optionsOpen = $state(false)
  let dest = $state(app.active.path)
  let preview = $state<TemplatePreview | null>(null)
  let previewError = $state('')
  let error = $state('')
  let busy = $state(false)
  const destOk = $derived(!!dest && !isVirtual(dest))

  const store = {
    get(k: string) {
      try {
        return JSON.parse(localStorage.getItem(k) ?? 'null')
      } catch {
        return null
      }
    },
    set(k: string, v: unknown) {
      try {
        localStorage.setItem(k, JSON.stringify(v))
      } catch {
        /* private window or blocked storage: nothing remembered */
      }
    }
  }

  void engine.call<FolderTemplate[]>('templates.list').then(
    (t) => {
      templates = t
      const last = store.get('hopper.template.last')
      pick(t.find((x) => x.id === last) ?? t[0])
    },
    (e) => {
      templates = []
      loadError = e?.message ?? String(e)
    }
  )

  const tpl = $derived(templates?.find((t) => t.id === id) ?? null)
  const inputs = $derived(tpl ? inputsOf(tpl) : [])

  /** form value of an input: lists as text, subs as rows */
  function formValue(i: TemplateInput, v: unknown): unknown {
    if (i.kind === 'list') return Array.isArray(v) ? v.join(i.multiline ? '\n' : ', ') : String(v ?? '')
    if (i.kind === 'subs') return Array.isArray(v) ? v.map((s: any) => ({ label: s.label ?? '', unit: s.unit ?? '', areas: Array.isArray(s.areas) ? s.areas.join(', ') : (s.areas ?? '') })) : []
    return v
  }

  function pick(t: FolderTemplate | undefined) {
    if (!t) return
    id = t.id
    const saved = store.get(`hopper.template.${t.id}`) ?? {}
    const v: Values = {}
    for (const i of inputsOf(t)) v[i.id] = formValue(i, saved[i.id] !== undefined ? saved[i.id] : defaultValue(i))
    values = v
    pad = saved.$pad === '2' ? '2' : (t.numbering?.pad ?? 'none')
    rootEdited = false
    rootText = ''
    error = ''
  }

  // what the engine gets: the form values plus the edited root name and padding
  const payload = $derived.by(() => {
    const p: Values = { ...$state.snapshot(values) }
    if (tpl && isTree(tpl)) {
      if (rootEdited && rootText.trim()) p.$root = rootText.trim()
      p.$pad = pad
    }
    return p
  })
  const visible = $derived(inputs.filter((i) => inputActive(i, tpl ? normalize(tpl, payload) : {})))
  const main = $derived(visible.filter((i) => !i.advanced))
  const advanced = $derived(visible.filter((i) => i.advanced))

  let seq = 0
  $effect(() => {
    const t = tpl
    const p = payload
    const d = dest
    if (!t) return
    const n = ++seq
    const timer = setTimeout(() => {
      engine.call<TemplatePreview>('templates.preview', t.id, destOk ? d : '', p).then(
        (r) => {
          if (n !== seq) return
          preview = r
          previewError = ''
        },
        (e) => {
          if (n === seq) previewError = e?.message ?? String(e)
        }
      )
    }, 150)
    return () => clearTimeout(timer)
  })

  type Row = { name: string; depth: number; exists: boolean; path: string }
  const rows = $derived.by((): Row[] => {
    if (!preview) return []
    const ex = new Set(preview.existing.map((x) => x.toLowerCase()))
    return preview.paths.map((p) => {
      const segs = p.split('\\')
      return { name: segs.at(-1)!, depth: segs.length - 1, exists: ex.has(p.toLowerCase()), path: p }
    })
  })

  const problem = $derived(!destOk ? 'Open a real folder first; templates cannot be created here' : (previewError || preview?.errors[0] || ''))
  const canCreate = $derived(!!tpl && !!preview && !problem && !busy && preview.count > 0)

  // ---- sub-projects -----------------------------------------------------------

  const subRows = (i: TemplateInput) => values[i.id] as SubRow[]
  function addSub(i: TemplateInput) {
    const rows = subRows(i)
    // a twin needs two rows to make sense: the first click adds both
    const n = rows.length === 0 ? 2 : 1
    for (let k = 0; k < n; k++) rows.push({ label: '', unit: '', areas: '' })
  }

  function toggle(i: TemplateInput, o: string, on: boolean) {
    const cur = (values[i.id] as string[]) ?? []
    values[i.id] = on ? i.options!.filter((x) => x === o || cur.includes(x)) : cur.filter((x) => x !== o)
  }

  async function browse() {
    const d = await host.dialog.folder('Create the folders in', dest || undefined)
    if (d) dest = d
  }

  async function go() {
    if (!tpl || !canCreate) return
    busy = true
    error = ''
    try {
      const r = await engine.call<TemplateResult>('templates.create', tpl.id, dest, payload)
      store.set(`hopper.template.${tpl.id}`, rememberable(tpl, payload))
      store.set('hopper.template.last', tpl.id)
      void app.active.refresh()
      if (r.created.length) {
        if (r.top) void app.active.navigate(r.top)
        app.toast('success', `Created ${plural(r.created.length, 'folder')}`, r.existing.length ? `${plural(r.existing.length, 'folder')} already existed and were kept.` : `${tpl.name} in ${dest}`, [{ label: 'Undo', run: () => void app.undo() }])
      } else app.toast('info', 'Nothing to create', 'Every folder in the template already exists here.')
      close(true)
    } catch (e: any) {
      error = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
    } finally {
      busy = false
    }
  }

  const spanOf = (i: TemplateInput) =>
    i.kind === 'text' ? 2 : i.kind === 'choice' || i.kind === 'date' ? ((i.options?.length ?? 0) <= 2 && (i.options ?? []).join('').length > 30 ? 6 : 3) : i.kind === 'flag' ? 3 : 6
</script>

{#snippet field(i: TemplateInput)}
  {#if i.kind === 'text'}
    <label class="field" style:grid-column={`span ${spanOf(i)}`}>
      <span>{i.label}{#if i.required}<span class="req" aria-hidden="true"> *</span>{/if}</span>
      <input class="input" bind:value={values[i.id]} placeholder={i.placeholder ?? ''} spellcheck="false" aria-required={i.required} />
    </label>
  {:else if i.kind === 'date'}
    <label class="field" style:grid-column={`span ${spanOf(i)}`}>
      <span>{i.label}</span>
      <input class="input" type="date" bind:value={values[i.id]} />
    </label>
  {:else if i.kind === 'choice' && (i.options?.length ?? 0) <= 2}
    <div class="field" style:grid-column={`span ${spanOf(i)}`} role="radiogroup" aria-label={i.label}>
      <span>{i.label}</span>
      <div class="seg">
        {#each i.options ?? [] as o (o)}
          <button type="button" role="radio" aria-checked={values[i.id] === o} class:on={values[i.id] === o} onclick={() => (values[i.id] = o)}>{o}</button>
        {/each}
      </div>
    </div>
  {:else if i.kind === 'choice'}
    <label class="field" style:grid-column={`span ${spanOf(i)}`}>
      <span>{i.label}</span>
      <select class="input" bind:value={values[i.id]}>
        {#each i.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}
      </select>
    </label>
  {:else if i.kind === 'multi'}
    <fieldset class="field wide">
      <legend>{i.label}</legend>
      <div class="checks">
        {#each i.options ?? [] as o (o)}
          <label class="check"><input type="checkbox" checked={((values[i.id] as string[]) ?? []).includes(o)} onchange={(e) => toggle(i, o, e.currentTarget.checked)} /> {o}</label>
        {/each}
      </div>
    </fieldset>
  {:else if i.kind === 'list'}
    <label class="field wide">
      <span>{i.label}{#if i.hint}<span class="caption">&nbsp;·&nbsp;{i.hint}</span>{/if}</span>
      {#if i.multiline}
        <textarea class="input mono" rows="4" bind:value={values[i.id]} placeholder={i.placeholder ?? ''} spellcheck="false"></textarea>
      {:else}
        <input class="input" bind:value={values[i.id]} placeholder={i.placeholder ?? ''} spellcheck="false" />
      {/if}
    </label>
  {:else if i.kind === 'flag'}
    <label class="check flag" style:grid-column={`span ${spanOf(i)}`}><input type="checkbox" checked={!!values[i.id]} onchange={(e) => (values[i.id] = e.currentTarget.checked)} /> {i.label}</label>
  {:else if i.kind === 'subs'}
    {@const rowsOf = subRows(i)}
    <div class="field wide">
      <span>{i.label}{#if !rowsOf.length}<span class="caption">&nbsp;·&nbsp;none: standalone project</span>{/if}</span>
      {#if rowsOf.length}
        <div class="subs">
          <span class="caption">Label</span><span class="caption">Unit / package code</span><span class="caption">Areas / skids (optional)</span><span></span>
          {#each rowsOf as s, si (si)}
            <input class="input" bind:value={s.label} placeholder={si === 0 ? 'DE-OIL' : 'PW DE-OIL'} spellcheck="false" aria-label={`Sub-project ${si + 1} label`} />
            <input class="input" bind:value={s.unit} placeholder="optional" spellcheck="false" aria-label={`Sub-project ${si + 1} unit code`} />
            <input class="input" bind:value={s.areas} placeholder="Interconnection, Skid-01..06" spellcheck="false" aria-label={`Sub-project ${si + 1} areas`} />
            <button type="button" class="btn subtle icon sm" aria-label={`Remove sub-project ${si + 1}`} title="Remove" onclick={() => rowsOf.splice(si, 1)}><Icon name="close" /></button>
          {/each}
        </div>
      {:else if i.hint}
        <span class="caption">{i.hint}</span>
      {/if}
      <div><button type="button" class="btn sm" onclick={() => addSub(i)}><Icon name="plus" /> {rowsOf.length ? 'Add sub-project' : 'Add sub-projects (twin / multi-package)'}</button></div>
    </div>
  {/if}
{/snippet}

<Dialog title="New from template" icon="template" width={980} onclose={() => close()} onsubmit={go}>
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
    <div class="tpls" role="listbox" aria-label="Templates">
      {#each templates as t (t.id)}
        <button type="button" role="option" aria-selected={t.id === id} class="tpl" class:on={t.id === id} onclick={() => pick(t)} title={t.description ?? ''}>
          <Icon name={isTree(t) ? 'layers' : 'template'} />
          <span class="ellipsis">{t.name}</span>
          {#if t.builtin}<span class="caption">built-in</span>{/if}
        </button>
      {/each}
    </div>

    <div class="cols">
      <div class="form">
        {#if tpl?.description}<div class="caption desc">{tpl.description}</div>{/if}
        <div class="grid">
          {#each main as i (i.id)}{@render field(i)}{/each}
        </div>

        {#if tpl && isTree(tpl) && (advanced.length || tpl.numbering?.auto !== false)}
          <details class="opts" bind:open={optionsOpen}>
            <summary><Icon name="chevronRight" size={12} /> Options</summary>
            <div class="grid">
              {#each advanced as i (i.id)}{@render field(i)}{/each}
              {#if tpl.numbering?.auto !== false}<div class="field" style:grid-column="span 6" role="radiogroup" aria-label="Number padding">
                <span>Folder numbers</span>
                <div class="seg">
                  <button type="button" role="radio" aria-checked={pad === 'none'} class:on={pad === 'none'} onclick={() => (pad = 'none')}>0- 1- … 10-</button>
                  <button type="button" role="radio" aria-checked={pad === '2'} class:on={pad === '2'} onclick={() => (pad = '2')}>00- 01- … 10-</button>
                </div>
              </div>{/if}
            </div>
          </details>
        {/if}
      </div>

      <div class="side">
        {#if tpl?.root}
          <label class="field">
            <span>Folder name {#if rootEdited}<button type="button" class="link" onclick={() => ((rootEdited = false), (rootText = ''))}>Reset</button>{/if}</span>
            <input
              class="input"
              value={rootEdited ? rootText : (preview?.top ?? '')}
              placeholder="Made from the job number and short name"
              spellcheck="false"
              oninput={(e) => ((rootEdited = true), (rootText = e.currentTarget.value))}
            />
          </label>
        {/if}
        <div class="where">
          <Icon name="folderOpen" size={14} /> <span class="ellipsis" title={dest}>{dest}</span>
          <button type="button" class="btn subtle sm" onclick={browse}>Change…</button>
        </div>
        <div class="stats caption" aria-live="polite">
          {#if preview && !preview.errors.length}
            <b>{plural(preview.count, 'new folder')}</b>{#if preview.existing.length}, {preview.existing.length} existing{/if} · depth {preview.depth} · longest path {preview.longest} characters
          {:else}&nbsp;{/if}
        </div>
        <div class="tree" aria-label="Preview">
          {#each rows as r (r.path)}
            <div class="node" class:exists={r.exists} style:padding-left={`${r.depth * 16 + 8}px`} title={r.path}>
              <Icon name="folder" size={14} /> <span class="ellipsis">{r.name}</span>
              {#if r.exists}<span class="tag">exists</span>{/if}
            </div>
          {/each}
        </div>
        {#each (preview?.errors.length ? [] : preview?.warnings) ?? [] as w (w.message)}
          <div class="banner {w.kind === 'exists' ? 'info' : 'warn'}" title={w.path ?? ''}><Icon name={w.kind === 'exists' ? 'info' : 'warning'} /> <span>{w.message}</span></div>
        {/each}
      </div>
    </div>
  {/if}

  {#if problem}<div class="banner {/^Fill in/.test(problem) ? 'info' : 'warn'}"><Icon name={/^Fill in/.test(problem) ? 'info' : 'warning'} /> <span>{problem}</span></div>{/if}
  {#if error}<div class="banner bad"><Icon name="error" /> <span>{error}</span></div>{/if}

  {#snippet footer()}
    <button type="submit" class="btn primary" disabled={!canCreate}><Icon name="newFolder" /> {busy ? 'Creating…' : preview?.count ? `Create ${plural(preview.count, 'folder')}` : 'Create'}</button>
    <button type="button" class="btn" onclick={() => close()}>{templates?.length ? 'Cancel' : 'Close'}</button>
  {/snippet}
</Dialog>

<style>
  .tpls {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 6px;
  }
  .tpl {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
    text-align: left;
    min-width: 0;
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
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: 20px;
    min-height: 420px;
  }
  .form,
  .side {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .desc {
    margin-top: -2px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 12px 12px;
    align-items: start;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    min-width: 0;
  }
  .field.wide {
    grid-column: span 6;
  }
  fieldset.field {
    border: 0;
    margin: 0;
    padding: 0;
  }
  legend {
    padding: 0 0 6px;
  }
  .req {
    color: var(--bad);
  }
  .seg {
    display: flex;
    border: 1px solid var(--control-stroke);
    border-bottom-color: var(--control-stroke-bottom);
    border-radius: var(--r-sm);
    background: var(--control);
    padding: 2px;
    gap: 2px;
  }
  .seg button {
    flex: 1;
    height: 26px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 8px;
  }
  .seg button:hover {
    background: var(--hover);
  }
  .seg button.on {
    background: var(--sel-strong);
    color: var(--text);
    font-weight: 600;
  }
  .checks {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px 12px;
  }
  .check {
    font-size: 13px;
    min-width: 0;
  }
  .flag {
    align-self: center;
  }
  .subs {
    display: grid;
    grid-template-columns: 1fr 0.8fr 1.4fr 28px;
    gap: 6px;
    align-items: center;
  }
  .opts {
    border-top: 1px solid var(--divider);
    padding-top: 8px;
  }
  .opts summary {
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 13px;
    padding: 4px 0 8px;
    cursor: default;
  }
  .opts summary::-webkit-details-marker {
    display: none;
  }
  .opts[open] summary :global(svg) {
    transform: rotate(90deg);
  }
  .opts summary :global(svg) {
    transition: transform var(--fast) var(--ease);
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent);
    padding: 0 0 0 6px;
    font-size: 12px;
  }
  .where {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-2);
    min-width: 0;
  }
  .where .ellipsis {
    flex: 1;
  }
  .stats {
    margin-bottom: -4px;
  }
  .tree {
    flex: 1;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    padding: 4px 0;
    min-height: 220px;
    max-height: 420px;
    overflow: auto;
    font-size: 13px;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding-right: 8px;
    min-width: 0;
  }
  .node.exists {
    color: var(--text-3);
  }
  .tag {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-3);
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
  .banner.info {
    color: var(--text-2);
    background: var(--layer-solid);
  }
  .banner.bad {
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 10%, transparent);
  }
</style>
