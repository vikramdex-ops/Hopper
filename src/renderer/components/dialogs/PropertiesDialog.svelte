<script lang="ts">
  // Hopper's own Properties window: general facts, size on disk, attributes, path forms and
  // who has access. Nothing here opens Windows Explorer.
  import { onDestroy } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { basename, dirname, fmtDateFull, fmtSize, plural } from '../../lib/format'
  import { typeLabel, kindOf, KIND_COLOR, KIND_ICON } from '../../lib/filetypes'
  import { formatPath, PATH_MODES, type PathMode } from '../../lib/pathcopy'

  let { paths, close }: { paths: string[]; close: (v?: unknown) => void } = $props()

  interface Info {
    path: string
    dir?: boolean
    attrs?: number
    created?: number
    modified?: number
    accessed?: number
    size?: number
    sizeOnDisk?: number
    owner?: string
    access?: { who: string; allow: boolean; rights: string; inherited: boolean }[]
    securityError?: string
    link?: boolean
    error?: string
  }

  const single = paths.length === 1
  let tab = $state<'general' | 'paths' | 'access'>('general')
  let infos = $state<Info[]>([])
  let loading = $state(true)
  let error = $state('')
  // folder totals arrive as the engine walks the tree
  let walk = $state<Record<string, { bytes: number; disk: number; files: number; dirs: number; done: boolean }>>({})
  const token = `props${Date.now().toString(36)}`
  let name = $state(single ? basename(paths[0]) || paths[0] : '')
  let forms = $state<{ label: string; value: string }[]>([])
  let hash = $state('')

  const first = $derived(infos[0])
  const isDrive = single && /^[a-zA-Z]:\\?$/.test(paths[0])
  const drive = $derived(app.drives.find((d) => d.root.slice(0, 2).toUpperCase() === paths[0].slice(0, 2).toUpperCase()))
  const ext = single ? (basename(paths[0]).includes('.') ? basename(paths[0]).split('.').pop()!.toLowerCase() : '') : ''

  const fileBytes = $derived(infos.reduce((a, i) => a + (i.dir ? 0 : i.size ?? 0), 0))
  const fileDisk = $derived(infos.reduce((a, i) => a + (i.dir ? 0 : i.sizeOnDisk ?? 0), 0))
  const walked = $derived(Object.values(walk))
  const total = $derived({
    bytes: fileBytes + walked.reduce((a, w) => a + w.bytes, 0),
    disk: fileDisk + walked.reduce((a, w) => a + w.disk, 0),
    files: infos.filter((i) => !i.dir).length + walked.reduce((a, w) => a + w.files, 0),
    dirs: walked.reduce((a, w) => a + w.dirs, 0),
    done: walked.every((w) => w.done)
  })
  const hasDirs = $derived(infos.some((i) => i.dir))

  // attribute checkboxes: true / false / mixed across the selection
  const BITS = { readonly: 1, hidden: 2 } as const
  let attr = $state<Record<keyof typeof BITS, boolean | null>>({ readonly: null, hidden: null })
  let attrDirty = $state(false)

  const off = engine.on('size', (d: any) => {
    if (d.token === token) walk[d.path] = d
  })
  onDestroy(() => {
    off()
    void engine.call('fs.sizeCancel', token)
  })

  async function load() {
    try {
      infos = await host.shell.props(paths)
      for (const k of Object.keys(BITS) as (keyof typeof BITS)[]) {
        const vals = infos.filter((i) => i.attrs !== undefined).map((i) => (i.attrs! & BITS[k]) !== 0)
        attr[k] = vals.every(Boolean) ? true : vals.some(Boolean) ? null : false
      }
      const dirs = infos.filter((i) => i.dir).map((i) => i.path)
      if (dirs.length) {
        const cluster = Number(await host.shell.cluster(dirs[0]).catch(() => 4096))
        void engine.call('fs.size', dirs, token, cluster)
      }
      if (infos.length === 1 && infos[0].error) error = infos[0].error
    } catch (e: any) {
      error = e.message
    } finally {
      loading = false
    }
    if (single) forms = await Promise.all(PATH_MODES.map(async (m) => ({ label: m.label, value: await formatPath(paths[0], m.id as PathMode) })))
  }
  void load()

  const bytesText = (n: number) => `${fmtSize(n)} (${n.toLocaleString()} bytes)`
  const copy = (t: string) => {
    void host.clip.writeText(t)
    app.toast('info', 'Copied', t.length > 100 ? `${t.slice(0, 100)}…` : t)
  }

  async function computeHash() {
    hash = 'Computing…'
    try {
      hash = await engine.call('fs.hash', paths[0], 'sha256')
    } catch (e: any) {
      hash = e.message
    }
  }

  async function apply() {
    try {
      if (attrDirty) {
        let set = 0
        let clear = 0
        for (const k of Object.keys(BITS) as (keyof typeof BITS)[]) {
          if (attr[k] === true) set |= BITS[k]
          else if (attr[k] === false) clear |= BITS[k]
        }
        const r = await host.shell.setAttrs(paths, set, clear)
        if (r.failed.length) app.toast('warning', `${plural(r.failed.length, 'item')} could not be changed`, 'They may be in use or you may not have permission.')
      }
      if (single && !isDrive && name.trim() && name.trim() !== basename(paths[0])) {
        const entry = app.active.rows.find((r) => r.path === paths[0]) ?? { name: basename(paths[0]), path: paths[0] }
        await app.rename(entry as any, name.trim())
      } else {
        for (const p of app.panes) void p.refresh()
      }
      close(true)
    } catch (e: any) {
      error = e.message
    }
  }

  const title = single ? `${basename(paths[0]) || paths[0]} — Properties` : `${paths.length} items — Properties`
  const kind = single ? kindOf(ext, first?.dir ?? false) : 'file'
</script>

<Dialog {title} icon="info" width={520} onclose={() => close()} onsubmit={apply}>
  <div class="tabs" role="tablist">
    <button type="button" class:on={tab === 'general'} onclick={() => (tab = 'general')}>General</button>
    {#if single}<button type="button" class:on={tab === 'paths'} onclick={() => (tab = 'paths')}>Paths</button>{/if}
    {#if single}<button type="button" class:on={tab === 'access'} onclick={() => (tab = 'access')}>Access</button>{/if}
  </div>

  {#if error}<div class="banner"><Icon name="warning" /> {error}</div>{/if}

  {#if tab === 'general'}
    <div class="head">
      <span class="big" style:color={KIND_COLOR[first?.dir ? 'folder' : kind]}>
        {#if single && first && !first.dir}
          <img src={`hopper://icon/?p=${encodeURIComponent(paths[0])}&e=${ext}&z=large`} alt="" width="40" height="40" />
        {:else}
          <Icon name={single ? (isDrive ? 'drive' : KIND_ICON[first?.dir ? 'folder' : kind]) : 'layers'} size={40} />
        {/if}
      </span>
      {#if single && !isDrive}
        <input class="input name" bind:value={name} spellcheck="false" aria-label="Name" />
      {:else}
        <div class="subtitle">{single ? `${drive?.label || 'Drive'} (${paths[0].slice(0, 2)})` : plural(paths.length, 'item')}</div>
      {/if}
    </div>

    <dl>
      <dt>Type</dt>
      <dd>{single ? (isDrive ? (drive?.kind === 'network' ? 'Network drive' : 'Local disk') : first ? typeLabel(ext, !!first.dir) : '…') : `${plural(infos.filter((i) => i.dir).length, 'folder')}, ${plural(infos.filter((i) => !i.dir).length, 'file')}`}</dd>
      <dt>Location</dt>
      <dd class="sel">{single ? (isDrive ? drive?.remote ?? paths[0] : dirname(paths[0])) : dirname(paths[0])}</dd>
      {#if isDrive && drive?.ready}
        <dt>Capacity</dt>
        <dd>{bytesText(drive.total)}</dd>
        <dt>Used</dt>
        <dd>{bytesText(drive.total - drive.free)}</dd>
        <dt>Free</dt>
        <dd>{bytesText(drive.free)}</dd>
        <dd class="span"><span class="cap"><span class:full={drive.free / drive.total < 0.1} style:width={`${Math.round((1 - drive.free / drive.total) * 100)}%`}></span></span></dd>
      {:else}
        <dt>Size</dt>
        <dd>{loading ? '…' : bytesText(total.bytes)}{!total.done ? ' — counting…' : ''}</dd>
        <dt>Size on disk</dt>
        <dd>{loading ? '…' : bytesText(total.disk)}{hasDirs ? ' (estimate)' : ''}</dd>
        {#if hasDirs}
          <dt>Contains</dt>
          <dd>{total.files.toLocaleString()} files, {total.dirs.toLocaleString()} folders{!total.done ? '…' : ''}</dd>
        {/if}
      {/if}
      {#if single && first && !isDrive}
        <dt class="gap">Created</dt>
        <dd class="gap">{fmtDateFull(first.created ?? 0)}</dd>
        <dt>Modified</dt>
        <dd>{fmtDateFull(first.modified ?? 0)}</dd>
        <dt>Accessed</dt>
        <dd>{fmtDateFull(first.accessed ?? 0)}</dd>
        {#if !first.dir}
          <dt>SHA-256</dt>
          <dd>{#if hash}<button type="button" class="link mono" onclick={() => copy(hash)}>{hash}</button>{:else}<button type="button" class="link" onclick={computeHash}>Compute</button>{/if}</dd>
        {/if}
      {/if}
      {#if !isDrive}
        <dt class="gap">Attributes</dt>
        <dd class="gap attrs">
          {#each [['readonly', 'Read-only'], ['hidden', 'Hidden']] as [k, label] (k)}
            <label class="check">
              <input type="checkbox" checked={attr[k as 'readonly'] === true} indeterminate={attr[k as 'readonly'] === null}
                onchange={(e) => { attr[k as 'readonly'] = (e.currentTarget as HTMLInputElement).checked; attrDirty = true }} />
              {label}
            </label>
          {/each}
          {#if first?.link}<span class="caption">Link or junction</span>{/if}
        </dd>
      {/if}
    </dl>
  {:else if tab === 'paths'}
    <p class="caption">Click a line to copy it.</p>
    <div class="forms">
      {#each forms as f (f.label)}
        <button type="button" class="form" onclick={() => copy(f.value)} title="Copy">
          <span class="caption">{f.label}</span>
          <span class="mono val">{f.value}</span>
        </button>
      {/each}
    </div>
  {:else}
    {#if first?.securityError}
      <div class="banner"><Icon name="warning" /> Access information can't be read here: {first.securityError}</div>
    {:else if first}
      <dl>
        <dt>Owner</dt>
        <dd class="sel">{first.owner ?? '—'}</dd>
      </dl>
      <div class="acl">
        <div class="acl-h"><span>Who</span><span>Access</span></div>
        {#each first.access ?? [] as r, i (i)}
          <div class="acl-r">
            <span class="ellipsis" title={r.who}><Icon name={/\\(Domain )?Users$|Everyone|Administrators|SYSTEM$/i.test(r.who) ? 'people' : 'person'} /> {r.who}</span>
            <span class:deny={!r.allow}>{r.allow ? '' : 'Denied: '}{r.rights}{r.inherited ? '' : ' · set here'}</span>
          </div>
        {/each}
      </div>
      <p class="caption">Read-only view. Permissions are managed by IT on the server.</p>
    {/if}
  {/if}

  {#snippet footer()}
    <button type="submit" class="btn primary">OK</button>
    <button type="button" class="btn" onclick={() => close()}>Cancel</button>
  {/snippet}
</Dialog>

<style>
  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--divider);
    margin: -4px 0 0;
  }
  .tabs button {
    border: 0;
    background: none;
    height: 34px;
    padding: 0 14px;
    color: var(--text-2);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .big {
    display: grid;
    place-items: center;
    width: 44px;
    flex: none;
  }
  .name {
    flex: 1;
  }
  dl {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 8px 12px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--text-2);
  }
  dd {
    margin: 0;
    min-width: 0;
    word-break: break-word;
  }
  .sel {
    user-select: text;
  }
  .gap {
    margin-top: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--divider);
  }
  .span {
    grid-column: 1 / -1;
  }
  .attrs {
    display: flex;
    gap: 18px;
    align-items: center;
    flex-wrap: wrap;
  }
  .cap {
    display: block;
    height: 6px;
    border-radius: 3px;
    background: var(--stroke-2);
    overflow: hidden;
  }
  .cap span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .cap span.full {
    background: var(--bad);
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .mono {
    font-family: var(--mono);
    font-size: 12px;
    word-break: break-all;
  }
  .link.mono {
    color: var(--text);
  }
  .forms {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 8px 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--stroke);
    background: var(--layer-solid);
  }
  .form:hover {
    background: var(--hover);
  }
  .val {
    color: var(--text);
  }
  .acl {
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
    overflow: auto;
    max-height: 260px;
    font-size: 13px;
  }
  .acl-h,
  .acl-r {
    display: grid;
    grid-template-columns: 1fr 190px;
    gap: 12px;
    padding: 7px 10px;
  }
  .acl-h {
    color: var(--text-2);
    font-size: 12px;
    background: var(--layer-solid);
    position: sticky;
    top: 0;
  }
  .acl-r + .acl-r {
    border-top: 1px solid var(--divider);
  }
  .deny {
    color: var(--bad);
  }
  .banner {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-radius: var(--r-md);
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    font-size: 13px;
  }
</style>
