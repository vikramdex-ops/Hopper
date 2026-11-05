<script lang="ts">
  // Select by pattern: wildcards ("*.pdf; ISO-0??*") or a regex, replacing or adding to the selection.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { plural } from '../../lib/format'
  import type { Row } from '../../lib/pane.svelte'

  let { close }: { close: (v?: unknown) => void } = $props()
  const pane = app.active

  let pattern = $state(lastPattern())
  let regex = $state(false)
  let caseSensitive = $state(false)
  let mode = $state<'replace' | 'add'>('replace')
  let what = $state<'all' | 'files' | 'folders'>('all')

  function lastPattern() {
    try {
      return localStorage.getItem('selectPattern') ?? ''
    } catch {
      return ''
    }
  }

  function wildcardRe(p: string, flags: string) {
    return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', flags)
  }

  const compiled = $derived.by<{ test: ((r: Row) => boolean) | null; error: string }>(() => {
    const p = pattern.trim()
    if (!p) return { test: null, error: '' }
    const flags = caseSensitive ? '' : 'i'
    let res: RegExp[]
    try {
      res = regex ? [new RegExp(p, flags)] : p.split(';').map((s) => s.trim()).filter(Boolean).map((s) => wildcardRe(s, flags))
    } catch (e: any) {
      return { test: null, error: String(e?.message ?? e) }
    }
    const kind = what
    return {
      test: (r: Row) => (kind === 'all' || (kind === 'files') !== r.dir) && res.some((re) => re.test(r.name)),
      error: ''
    }
  })

  const matches = $derived(compiled.test ? pane.rows.filter(compiled.test) : [])
  const added = $derived(mode === 'add' ? matches.filter((r) => !pane.selection.has(r.path.toLowerCase())).length : matches.length)

  function go() {
    const test = compiled.test
    if (!test) return
    if (mode === 'replace') pane.selectWhere(test)
    else pane.setSelection([...pane.selection, ...matches.map((r) => r.path.toLowerCase())])
    try {
      localStorage.setItem('selectPattern', pattern.trim())
    } catch {
      /* storage unavailable */
    }
    close(true)
  }
</script>

<Dialog title="Select by pattern" icon="filter" width={520} onclose={() => close()} onsubmit={go}>
  <label class="field">
    <span>{regex ? 'Regular expression' : 'Wildcards'} <span class="caption">{regex ? '(matched anywhere in the name; use ^ and $ to anchor)' : '(* any text, ? one character; separate several with ;)'}</span></span>
    <input class="input mono" bind:value={pattern} placeholder={regex ? '^ISO-0\\d{2}.*\\.pdf$' : '*.pdf; ISO-0??*'} spellcheck="false" autofocus />
  </label>

  <div class="opts">
    <label class="check"><input type="checkbox" bind:checked={regex} /> Regular expression</label>
    <label class="check"><input type="checkbox" bind:checked={caseSensitive} /> Match case</label>
  </div>

  <div class="grid">
    <label class="field">
      <span>Apply to</span>
      <select class="input" bind:value={what}>
        <option value="all">Files and folders</option>
        <option value="files">Files only</option>
        <option value="folders">Folders only</option>
      </select>
    </label>
    <label class="field">
      <span>Selection</span>
      <select class="input" bind:value={mode}>
        <option value="replace">Replace the current selection</option>
        <option value="add">Add to the current selection</option>
      </select>
    </label>
  </div>

  {#if compiled.error}
    <div class="msg bad"><Icon name="error" /> {compiled.error}</div>
  {:else if pattern.trim()}
    <div class="msg">
      <Icon name={matches.length ? 'success' : 'info'} />
      {#if matches.length}
        {plural(matches.length, 'item')} match{matches.length === 1 ? 'es' : ''}{mode === 'add' ? ` (${added.toLocaleString()} not selected yet)` : ''}
      {:else}
        Nothing in this folder matches
      {/if}
      <span class="caption">of {plural(pane.rows.length, 'item')} shown</span>
    </div>
  {/if}

  {#snippet footer()}
    <button type="submit" class="btn primary" disabled={!compiled.test || !matches.length}>Select</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .mono {
    font-family: var(--mono);
  }
  .opts {
    display: flex;
    gap: 20px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .msg {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .msg.bad {
    color: var(--bad);
  }
</style>
