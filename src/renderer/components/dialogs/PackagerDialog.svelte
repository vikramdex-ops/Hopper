<script lang="ts">
  // Lot packager: check names and revisions (live package.plan), then copy, write the transmittal
  // (.xlsx + .pdf) and optionally archive. Revisions are shown exactly as the office rules parse them.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { basename, dirname, fmtSize, plural } from '../../lib/format'
  import { isVirtual } from '../../lib/pane.svelte'
  import type { PackageSpec, PlanFile, PlanReport } from '../../../engine/office/types'

  let { paths = [], close }: { paths?: string[]; close: (v?: unknown) => void } = $props()

  const today = () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  let files = $state<string[]>([...paths])
  const first = paths[0]
  let name = $state(first ? basename(dirname(first)) || 'Lot' : 'Lot')
  let outDir = $state(first ? dirname(first) : isVirtual(app.active.path) ? '' : app.active.path)
  const conventions = $derived(app.office?.conventions ?? [])
  let conventionId = $state('')
  let copy = $state(true)
  let zip = $state(true)
  const presets = $derived(app.settings?.archivePresets ?? [])
  let presetId = $state(app.settings?.archivePresets?.some((p) => p.id === 'balanced') ? 'balanced' : app.settings?.defaultPreset ?? 'balanced')
  const preset = $derived(presets.find((p) => p.id === presetId))
  let password = $state('')

  let number = $state('')
  let project = $state('')
  let client = $state('')
  let to = $state('')
  let from = $state(app.settings?.profile.displayName || app.info?.identity?.displayName || '')
  let purpose = $state('For approval')
  let date = $state(today())
  let notes = $state('')

  let report = $state<PlanReport | null>(null)
  let planError = $state('')
  let planning = $state(false)
  let runError = $state('')
  let busy = $state(false)

  // Re-plan (debounced) whenever the files, name, folder or convention change; stale answers are dropped.
  let seq = 0
  $effect(() => {
    const spec = { files: [...files], name: name.trim(), outDir: outDir.trim(), conventionId: conventionId || undefined }
    const my = ++seq
    planning = true
    const t = setTimeout(async () => {
      try {
        const r = await engine.call<PlanReport>('package.plan', spec)
        if (my !== seq) return
        report = r
        planError = ''
      } catch (e: any) {
        if (my !== seq) return
        report = null
        planError = e?.message ?? String(e)
      } finally {
        if (my === seq) planning = false
      }
    }, 300)
    return () => clearTimeout(t)
  })

  const rows = $derived<PlanFile[]>(report?.files ?? [])
  const formError = $derived(
    !files.length ? 'Add at least one file' :
    !name.trim() ? 'Give the package a name' :
    !outDir.trim() ? 'Choose where to save the package' :
    !number.trim() ? 'Enter the transmittal number' :
    zip && preset?.password && !password ? `"${preset.name}" needs a password` :
    ''
  )
  const canRun = $derived(!busy && !planning && !!report && !report.blocking.length && !formError)

  async function browse() {
    const d = await host.dialog.folder('Save the package in', outDir || undefined)
    if (d) outDir = d
  }

  async function addFiles() {
    const more: string[] = await host.dialog.files('Add files to the lot')
    const have = new Set(files.map((f) => f.toLowerCase()))
    files = [...files, ...more.filter((f) => !have.has(f.toLowerCase()))]
  }

  const remove = (p: string) => (files = files.filter((f) => f !== p))

  async function go() {
    if (!canRun) return
    const spec: PackageSpec = {
      files: [...files],
      outDir: outDir.trim(),
      name: name.trim(),
      conventionId: conventionId || undefined,
      copy,
      zip,
      presetId: zip ? presetId : undefined,
      password: zip && preset?.password ? password : undefined,
      transmittal: {
        number: number.trim(),
        project: project.trim(),
        client: client.trim() || undefined,
        to: to.trim(),
        from: from.trim(),
        purpose: purpose.trim(),
        date: date.trim(),
        notes: notes.trim() || undefined
      }
    }
    busy = true
    runError = ''
    try {
      await engine.call('package.run', spec)
      app.drawer = true
      close(true)
    } catch (e: any) {
      runError = e?.message ?? String(e)
    } finally {
      busy = false
    }
  }

  const convTitle = (f: PlanFile) =>
    f.convention === 'ok' ? 'Matches the naming convention' : f.convention === 'fail' ? `Does not match ${report?.convention?.pattern ?? 'the convention'}` : 'No naming convention chosen'
</script>

<Dialog title="Package lot" icon="package" width={760} onclose={() => close()} onsubmit={go}>
  <div class="grid">
    <label class="field">
      <span>Package name</span>
      <input class="input" bind:value={name} spellcheck="false" />
    </label>
    <label class="field">
      <span>Naming convention</span>
      <select class="input" bind:value={conventionId}>
        <option value="">Don't check names</option>
        {#each conventions as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
      </select>
    </label>
  </div>

  <label class="field">
    <span>Save in</span>
    <div class="row">
      <input class="input" bind:value={outDir} spellcheck="false" placeholder="Folder for the package" />
      <button type="button" class="btn" onclick={browse}><Icon name="folderOpen" /> Browse</button>
    </div>
  </label>

  <div class="opts">
    <label class="check"><input type="checkbox" bind:checked={copy} /> Copy the files into the package folder</label>
    <label class="check"><input type="checkbox" bind:checked={zip} /> Archive the package</label>
    {#if zip}
      <select class="input preset" bind:value={presetId} aria-label="Archive preset">
        {#each presets as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
      {#if preset?.password}<input class="input pw" type="password" bind:value={password} placeholder="Password" autocomplete="new-password" />{/if}
    {/if}
  </div>

  <section>
    <div class="head">
      <span class="subtitle">Files</span>
      <span class="caption">
        {#if report}{plural(report.totals.files, 'file')} · {fmtSize(report.totals.bytes)}{#if report.convention} · {report.totals.conventionOk} match, {report.totals.conventionFail} don't{/if}{/if}
        {#if planning} · checking…{/if}
      </span>
      <span class="spacer"></span>
      <button type="button" class="btn sm" onclick={addFiles}><Icon name="plus" /> Add files</button>
    </div>

    {#if planError}<div class="banner bad"><Icon name="error" /> <span>{planError}</span></div>{/if}
    {#each report?.blocking ?? [] as b}<div class="banner bad"><Icon name="error" /> <span>{b}</span></div>{/each}
    {#each report?.warnings ?? [] as w}<div class="banner warn"><Icon name="warning" /> <span>{w}</span></div>{/each}

    <div class="table" role="table">
      <div class="tr th" role="row">
        <span role="columnheader">File</span><span role="columnheader">Rev</span><span role="columnheader" class="num">Size</span><span role="columnheader" class="c">Name</span><span></span>
      </div>
      {#each rows as f (f.path)}
        <div class="tr" role="row" class:missing={f.missing || f.problem}>
          <span class="name" title={f.path}>
            <Icon name={f.missing ? 'error' : 'file'} size={14} />
            <span class="ellipsis">{f.name}</span>
            {#if f.missing}<span class="tag bad">missing</span>{/if}
            {#if f.problem}<span class="tag bad">{f.problem}</span>{/if}
            {#if f.nameClash.length}<span class="tag bad" title={f.nameClash.join('\n')}>same name</span>{/if}
            {#if f.sameBase.length}<span class="tag warn" title={`Same drawing as:\n${f.sameBase.join('\n')}`}>{f.sameBase.length + 1}×</span>{/if}
          </span>
          <span class="rev" title={f.rev === null ? 'No revision found by the office rules' : ''}>{f.rev ?? '—'}</span>
          <span class="num">{f.missing ? '' : fmtSize(f.size)}</span>
          <span class="c conv" class:ok={f.convention === 'ok'} class:fail={f.convention === 'fail'} title={convTitle(f)}>
            <Icon name={f.convention === 'ok' ? 'success' : f.convention === 'fail' ? 'error' : 'minus'} size={14} />
          </span>
          <button type="button" class="btn subtle icon sm" title="Remove from the lot" aria-label="Remove" onclick={() => remove(f.path)}><Icon name="close" size={14} /></button>
        </div>
      {:else}
        <div class="empty caption">{files.length ? 'Checking…' : 'No files yet — add some to build the lot.'}</div>
      {/each}
    </div>
  </section>

  <section>
    <span class="subtitle">Transmittal</span>
    <div class="grid3">
      <label class="field"><span>Transmittal no.</span><input class="input" bind:value={number} spellcheck="false" /></label>
      <label class="field"><span>Date</span><input class="input" bind:value={date} spellcheck="false" /></label>
      <label class="field"><span>Purpose</span><input class="input" bind:value={purpose} list="hopper-purposes" /></label>
      <label class="field"><span>Project</span><input class="input" bind:value={project} spellcheck="false" /></label>
      <label class="field"><span>Client <span class="caption">(optional)</span></span><input class="input" bind:value={client} /></label>
      <span></span>
      <label class="field"><span>To</span><input class="input" bind:value={to} /></label>
      <label class="field"><span>From</span><input class="input" bind:value={from} /></label>
    </div>
    <datalist id="hopper-purposes">
      <option value="For approval"></option>
      <option value="For information"></option>
      <option value="For construction"></option>
      <option value="For review and comments"></option>
      <option value="As-built"></option>
    </datalist>
    <label class="field"><span>Notes <span class="caption">(optional)</span></span><textarea class="input notes" bind:value={notes} rows="2"></textarea></label>
  </section>

  {#if runError}<div class="banner bad"><Icon name="error" /> <span>{runError}</span></div>{/if}

  {#snippet footer()}
    {#if formError}<span class="caption why">{formError}</span>{/if}
    <button type="submit" class="btn primary" disabled={!canRun}><Icon name="package" /> Create package</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .grid3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px 12px;
    margin-top: 8px;
  }
  .opts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
  }
  .opts .preset {
    width: 200px;
  }
  .opts .pw {
    width: 160px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
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
  .table {
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    background: var(--layer-solid);
    max-height: 240px;
    overflow: auto;
  }
  .tr {
    display: grid;
    grid-template-columns: 1fr 56px 76px 48px 32px;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 10px;
    min-height: 30px;
    font-size: 13px;
    border-bottom: 1px solid var(--divider);
  }
  .tr:last-child {
    border-bottom: 0;
  }
  .th {
    position: sticky;
    top: 0;
    background: var(--layer-solid);
    color: var(--text-2);
    font-size: 12px;
    min-height: 28px;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .rev {
    font-family: var(--mono);
    font-size: 12px;
  }
  .num {
    text-align: right;
    color: var(--text-2);
  }
  .c {
    display: flex;
    justify-content: center;
  }
  .conv {
    color: var(--text-3);
  }
  .conv.ok {
    color: var(--ok);
  }
  .conv.fail {
    color: var(--bad);
  }
  .missing .name {
    color: var(--bad);
  }
  .tag {
    flex: none;
    font-size: 11px;
    padding: 0 6px;
    border-radius: 9px;
    line-height: 16px;
  }
  .tag.bad {
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 12%, transparent);
  }
  .tag.warn {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
  }
  .empty {
    padding: 14px;
    text-align: center;
  }
  .notes {
    resize: vertical;
    min-height: 48px;
    padding-top: 6px;
    font-family: inherit;
  }
  .why {
    margin-right: auto;
    align-self: center;
  }
</style>
