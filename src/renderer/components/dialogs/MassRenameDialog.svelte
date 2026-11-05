<script lang="ts">
  // Rename many: find/replace, case, prefix/suffix, a "#" counter template and the extension,
  // with a live old -> new preview. Every option starts neutral, so the defaults rename nothing.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine } from '../../lib/api'
  import { dirname, join, plural } from '../../lib/format'
  import { isArchivePath, isVirtual, type Row } from '../../lib/pane.svelte'

  let { targets, close }: { targets: Row[]; close: (v?: unknown) => void } = $props()

  const list = targets.filter((t) => !isVirtual(t.path) && !isArchivePath(t.path))
  const skipped = targets.length - list.length

  let find = $state('')
  let replace = $state('')
  let regex = $state(false)
  let matchCase = $state(false)
  let caseMode = $state<'none' | 'lower' | 'upper' | 'title'>('none')
  let prefix = $state('')
  let suffix = $state('')
  let template = $state('')
  let start = $state(1)
  let step = $state(1)
  let pad = $state(0)
  let extMode = $state<'keep' | 'lower' | 'upper' | 'set'>('keep')
  let newExt = $state('')
  let busy = $state(false)

  const BAD = /[<>:"/\\|?*\x00-\x1f]/
  const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

  function split(r: Row) {
    if (r.dir) return { stem: r.name, ext: '' }
    const dot = r.name.lastIndexOf('.')
    return dot > 0 ? { stem: r.name.slice(0, dot), ext: r.name.slice(dot + 1) } : { stem: r.name, ext: '' }
  }

  const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s_\-.([{])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())

  const finder = $derived.by<{ re: RegExp | null; error: string }>(() => {
    if (!find) return { re: null, error: '' }
    try {
      const src = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return { re: new RegExp(src, matchCase ? 'g' : 'gi'), error: '' }
    } catch (e: any) {
      return { re: null, error: String(e?.message ?? e) }
    }
  })

  type Status = 'same' | 'ok' | 'invalid' | 'duplicate' | 'exists'
  interface Plan {
    row: Row
    to: string
    status: Status
    why: string
  }

  const plan = $derived.by<Plan[]>(() => {
    const re = finder.re
    const width = Math.max(0, Math.min(12, Math.floor(pad) || 0))
    const out = list.map((row, i) => {
      let { stem, ext } = split(row)
      if (re) stem = stem.replace(re, regex ? replace : replace.replace(/\$/g, '$$$$'))
      if (template.trim()) {
        const n = (Number(start) || 0) + i * (Number(step) || 0)
        const name = stem
        // counter first, so a "#" inside the original name is never treated as a placeholder
        stem = template
          .replace(/#+/g, (run) => (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(Math.max(run.length, width), '0'))
          .replace(/\{name\}/gi, () => name)
      }
      if (caseMode === 'lower') stem = stem.toLowerCase()
      else if (caseMode === 'upper') stem = stem.toUpperCase()
      else if (caseMode === 'title') stem = titleCase(stem)
      stem = prefix + stem + suffix
      if (!row.dir) {
        if (extMode === 'lower') ext = ext.toLowerCase()
        else if (extMode === 'upper') ext = ext.toUpperCase()
        else if (extMode === 'set') ext = newExt.trim().replace(/^\.+/, '')
      }
      const to = ext ? `${stem}.${ext}` : stem
      return { row, to, status: 'ok' as Status, why: '' }
    })

    // Names that would clash: inside the batch, or with an item that is not being renamed.
    const moving = new Set(list.map((r) => r.path.toLowerCase()))
    const existing = new Set<string>()
    for (const p of app.panes) {
      for (const e of p.entries) if (!moving.has(e.path.toLowerCase())) existing.add(e.path.toLowerCase())
    }
    const count = new Map<string, number>()
    for (const p of out) {
      const k = join(dirname(p.row.path), p.to).toLowerCase()
      count.set(k, (count.get(k) ?? 0) + 1)
    }
    const why = (p: Plan): [Status, string] => {
      const full = join(dirname(p.row.path), p.to)
      if (p.to === p.row.name) return ['same', '']
      if (!p.to.trim()) return ['invalid', 'Empty name']
      if (BAD.test(p.to)) return ['invalid', 'Contains one of \\ / : * ? " < > |']
      if (/[ .]$/.test(p.to)) return ['invalid', 'Ends with a space or a dot']
      if (RESERVED.test(p.to)) return ['invalid', 'Reserved by Windows']
      if (full.length > 259) return ['invalid', 'Path longer than 259 characters']
      if ((count.get(full.toLowerCase()) ?? 0) > 1) return ['duplicate', 'Two items would get this name']
      if (existing.has(full.toLowerCase())) return ['exists', 'An item with this name already exists']
      return ['ok', '']
    }
    for (const p of out) [p.status, p.why] = why(p)
    return out
  })

  const changes = $derived(plan.filter((p) => p.status !== 'same'))
  const problems = $derived(plan.filter((p) => p.status === 'invalid' || p.status === 'duplicate' || p.status === 'exists'))
  const shownPlan = $derived(plan.slice(0, 1000))

  async function go() {
    if (busy || !changes.length || problems.length || finder.error) return
    busy = true
    const pairs: [string, string][] = changes.map((p) => [p.row.path, join(dirname(p.row.path), p.to)])
    try {
      const r = await engine.call<{ done: number; failed: { path: string; message: string }[] }>('fs.renameMany', pairs)
      const dirs = new Set(pairs.map(([a]) => dirname(a).toLowerCase()))
      for (const p of app.panes) if (dirs.has(p.path.toLowerCase())) void p.refresh()
      if (r.failed.length) app.toast('warning', `Renamed ${plural(r.done, 'item')}; ${plural(r.failed.length, 'item')} failed`, r.failed[0].message, [{ label: 'Undo', run: () => void app.undo() }])
      else app.toast('success', `Renamed ${plural(r.done, 'item')}`, undefined, [{ label: 'Undo', run: () => void app.undo() }])
      close(true)
    } catch (e: any) {
      app.toast('error', 'Rename failed', String(e?.message ?? e).replace(/^Error:\s*/, ''))
      busy = false
    }
  }

  function reset() {
    find = replace = prefix = suffix = template = newExt = ''
    regex = matchCase = false
    caseMode = 'none'
    extMode = 'keep'
    start = 1
    step = 1
    pad = 0
  }
</script>

<Dialog title={`Rename ${plural(list.length, 'item')}`} icon="rename" width={860} onclose={() => close()} onsubmit={go}>
  {#if skipped}<div class="caption">{plural(skipped, 'item')} inside an archive or a virtual view will be left alone.</div>{/if}

  <div class="cols">
    <div class="opts">
      <div class="grid">
        <label class="field"><span>Find</span><input class="input mono" bind:value={find} spellcheck="false" autofocus /></label>
        <label class="field"><span>Replace with {#if regex}<span class="caption">($1, $2 … for groups)</span>{/if}</span><input class="input mono" bind:value={replace} spellcheck="false" /></label>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" bind:checked={regex} /> Regular expression</label>
        <label class="check"><input type="checkbox" bind:checked={matchCase} /> Match case</label>
      </div>
      {#if finder.error}<div class="err"><Icon name="error" /> {finder.error}</div>{/if}

      <label class="field">
        <span>Template <span class="caption">(optional: {'{name}'} = the name so far, # = counter, e.g. ISO-###-{'{name}'})</span></span>
        <input class="input mono" bind:value={template} spellcheck="false" placeholder="Leave empty to keep the name" />
      </label>
      <div class="grid3">
        <label class="field"><span>Start at</span><input class="input" type="number" bind:value={start} disabled={!template.trim()} /></label>
        <label class="field"><span>Step</span><input class="input" type="number" bind:value={step} disabled={!template.trim()} /></label>
        <label class="field"><span>Pad to digits</span><input class="input" type="number" min="0" max="12" bind:value={pad} disabled={!template.trim()} /></label>
      </div>

      <div class="grid">
        <label class="field"><span>Prefix</span><input class="input" bind:value={prefix} spellcheck="false" /></label>
        <label class="field"><span>Suffix <span class="caption">(before the extension)</span></span><input class="input" bind:value={suffix} spellcheck="false" /></label>
      </div>

      <div class="grid">
        <label class="field">
          <span>Case</span>
          <select class="input" bind:value={caseMode}>
            <option value="none">Leave as is</option>
            <option value="lower">lower case</option>
            <option value="upper">UPPER CASE</option>
            <option value="title">Title Case</option>
          </select>
        </label>
        <label class="field">
          <span>Extension</span>
          <select class="input" bind:value={extMode}>
            <option value="keep">Keep</option>
            <option value="lower">lower case</option>
            <option value="upper">UPPER CASE</option>
            <option value="set">Change to…</option>
          </select>
        </label>
      </div>
      {#if extMode === 'set'}
        <label class="field"><span>New extension <span class="caption">(empty removes it)</span></span><input class="input mono" bind:value={newExt} placeholder="pdf" spellcheck="false" /></label>
      {/if}
      <div class="caption">Find, case and template apply to the name without its extension. Folders keep their full name as the "name".</div>
    </div>

    <div class="preview">
      <div class="phead">
        <span class="subtitle">Preview</span>
        <span class="caption">{plural(changes.length, 'change')}{problems.length ? ` · ${plural(problems.length, 'problem')}` : ''}</span>
      </div>
      <div class="table">
        {#each shownPlan as p (p.row.path)}
          <div class="tr {p.status}" title={p.why || p.row.path}>
            <span class="old ellipsis">{p.row.name}</span>
            <Icon name="chevronRight" size={12} />
            <span class="new ellipsis">{p.status === 'same' ? '(unchanged)' : p.to}</span>
            {#if p.status === 'invalid' || p.status === 'duplicate' || p.status === 'exists'}<span class="flag"><Icon name="warning" size={14} /></span>{/if}
          </div>
        {/each}
        {#if plan.length > shownPlan.length}<div class="caption more">…and {plural(plan.length - shownPlan.length, 'more item')}</div>{/if}
      </div>
      {#if problems.length}
        <div class="err"><Icon name="warning" /> {problems[0].row.name}: {problems[0].why}{problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}</div>
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <button type="button" class="btn subtle reset" onclick={reset}>Reset options</button>
    <button type="submit" class="btn primary" disabled={busy || !changes.length || problems.length > 0 || !!finder.error}>
      <Icon name="rename" /> Rename {changes.length ? plural(changes.length, 'item') : ''}
    </button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .cols {
    display: grid;
    grid-template-columns: 360px 1fr;
    gap: 20px;
    min-height: 0;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .grid3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px;
  }
  .checks {
    display: flex;
    gap: 20px;
  }
  .mono {
    font-family: var(--mono);
  }
  .err {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--bad);
    font-size: 13px;
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .phead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .table {
    flex: 1;
    min-height: 240px;
    max-height: 52vh;
    overflow: auto;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    padding: 4px 0;
  }
  .tr {
    display: grid;
    grid-template-columns: 1fr 12px 1fr 18px;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    font-size: 13px;
  }
  .tr .old {
    color: var(--text-2);
  }
  .tr.same .new {
    color: var(--text-3);
  }
  .tr.ok .new {
    font-weight: 600;
  }
  .tr.invalid .new,
  .tr.duplicate .new,
  .tr.exists .new,
  .flag {
    color: var(--bad);
  }
  .flag {
    display: flex;
  }
  .more {
    padding: 4px 10px;
  }
  .reset {
    margin-right: auto;
  }
</style>
