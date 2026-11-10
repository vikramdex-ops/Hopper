<script lang="ts">
  // Compress with options: preset, name, destination, password, split. Presets are editable.
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { basename, dirname, fmtSize, plural } from '../../lib/format'
  import type { ArchivePreset } from '@shared/types'

  let { close }: { close: (v?: unknown) => void } = $props()
  const targets = app.active.targets()
  const sources = targets.map((e) => e.path)
  const bytes = targets.reduce((a, e) => a + (e.dir ? 0 : e.size), 0)
  const presets = app.settings?.archivePresets ?? []

  let presetId = $state(app.settings?.defaultPreset ?? presets[0]?.id)
  const preset = $derived(presets.find((p) => p.id === presetId) ?? presets[0])
  let custom = $state<ArchivePreset>({ ...(presets.find((p) => p.id === presetId) ?? presets[0]) })
  $effect(() => {
    custom = { ...preset }
  })
  const stem = targets.length === 1 ? targets[0].name.replace(targets[0].dir ? /$^/ : /\.[^.]+$/, '') : `${basename(dirname(sources[0])) || 'Archive'} ${new Date().toISOString().slice(0, 10)}`
  let name = $state(stem)
  let dest = $state(dirname(sources[0]))
  let password = $state('')
  let makeDefault = $state(false)
  let hasRar = $state(true)
  void engine.call<boolean>('archive.hasRar').then((v) => (hasRar = v))

  const LEVELS = [
    { v: 0, label: 'Store — fastest, no compression' },
    { v: 1, label: 'Fastest' },
    { v: 3, label: 'Fast' },
    { v: 5, label: 'Normal' },
    { v: 7, label: 'Maximum' },
    { v: 9, label: 'Ultra — smallest, slowest' }
  ]

  async function browse() {
    const d = await host.dialog.folder('Save archive in', dest)
    if (d) dest = d
  }

  function go() {
    const changed = custom.format !== preset.format || custom.level !== preset.level || custom.volumeMB !== preset.volumeMB
    let id = preset.id
    if (changed) {
      // Remember an edited preset as "Custom" so it can be reused with one key.
      const c: ArchivePreset = { ...custom, id: 'custom', name: `Custom (${custom.format}, level ${custom.level}${custom.volumeMB ? `, ${custom.volumeMB} MB parts` : ''})`, password: false }
      app.updateSettings({ archivePresets: [...presets.filter((p) => p.id !== 'custom'), c] })
      id = 'custom'
    }
    if (makeDefault) app.updateSettings({ defaultPreset: id })
    void engine.call('archive.create', sources, { presetId: id, dest, name, password: password || undefined })
    app.showProgress()
    close(true)
  }
</script>

<Dialog title="Compress" icon="zip" width={560} onclose={() => close()} onsubmit={go}>
  <div class="caption">{plural(sources.length, 'item')}{bytes ? ` · ${fmtSize(bytes)}` : ''}{targets.some((t) => t.dir) ? ' + folders' : ''} · uses every CPU core</div>

  <div class="presets">
    {#each presets as p (p.id)}
      <button type="button" class="preset" class:on={p.id === presetId} disabled={p.format === 'rar' && !hasRar} onclick={() => (presetId = p.id)} title={p.format === 'rar' && !hasRar ? 'WinRAR is not installed on this PC' : ''}>
        <Icon name="zip" />
        <span class="ellipsis">{p.name}</span>
        {#if p.id === app.settings?.defaultPreset}<span class="caption">default</span>{/if}
      </button>
    {/each}
  </div>

  <div class="grid">
    <label class="field">
      <span>Name</span>
      <div class="row"><input class="input" bind:value={name} spellcheck="false" /><span class="caption">.{custom.format}{custom.volumeMB ? '.001…' : ''}</span></div>
    </label>
    <label class="field">
      <span>Format</span>
      <select class="input" bind:value={custom.format}>
        <option value="zip">ZIP (opens everywhere)</option>
        <option value="7z">7z (smaller)</option>
        <option value="rar" disabled={!hasRar}>RAR (WinRAR)</option>
      </select>
    </label>
    <label class="field">
      <span>Compression</span>
      <select class="input" bind:value={custom.level}>
        {#each LEVELS as l (l.v)}<option value={l.v}>{l.label}</option>{/each}
      </select>
    </label>
    <label class="field">
      <span>Split into parts of</span>
      <select class="input" bind:value={custom.volumeMB}>
        <option value={0}>Don't split</option>
        <option value={10}>10 MB</option>
        <option value={20}>20 MB (email)</option>
        <option value={25}>25 MB (Gmail)</option>
        <option value={100}>100 MB</option>
        <option value={700}>700 MB</option>
        <option value={4000}>4 GB (FAT32 USB)</option>
      </select>
    </label>
  </div>

  <label class="field">
    <span>Save in</span>
    <div class="row">
      <input class="input" bind:value={dest} spellcheck="false" />
      <button type="button" class="btn" onclick={browse}><Icon name="folderOpen" /> Browse</button>
      {#if app.dual}<button type="button" class="btn" onclick={() => (dest = app.other.path)} title="Save in the other pane's folder"><Icon name="dualPane" /></button>{/if}
    </div>
  </label>

  <label class="field">
    <span>Password <span class="caption">(optional — AES-256)</span></span>
    <input class="input" type="password" bind:value={password} autocomplete="new-password" />
  </label>

  <label class="check"><input type="checkbox" bind:checked={makeDefault} /> Use these settings for one-key Zip (Ctrl+Alt+Z)</label>

  {#snippet footer()}
    <button type="submit" class="btn primary" disabled={!name.trim() || !dest.trim()}><Icon name="zip" /> Create</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .presets {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .preset {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
    text-align: left;
  }
  .preset span:first-of-type {
    flex: 1;
  }
  .preset:hover {
    background: var(--hover);
  }
  .preset.on {
    border-color: var(--accent);
    background: var(--sel);
  }
  .preset:disabled {
    opacity: 0.5;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
</style>
