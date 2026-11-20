<script lang="ts">
  // Insights: Predictive Storage Intelligence (engine/storage.ts) and Smart File Notifications
  // (engine/smartnotify.ts). Every number shown is from the recorded history - nothing estimated
  // beyond the plain trend arithmetic in shared/storage.ts.
  import { onMount } from 'svelte'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host } from '../../lib/api'
  import { fmtAgo, fmtSize } from '../../lib/format'
  import { isArchivePath, isVirtual } from '../../lib/pane.svelte'
  import { FULL_WARN_DAYS, cleanStorageSettings, fmtBytes, type StorageSeriesView, type TrackedFolder } from '@shared/storage'
  import { SMART_KINDS, cleanSmartSettings, type SmartAction, type SmartKind, type SmartNotice } from '@shared/smartnotify'

  let { close, tab: startTab = 'storage' }: { close: (v?: unknown) => void; tab?: 'storage' | 'notices' } = $props()

  let tab = $state<'storage' | 'notices'>(startTab)
  let views = $state.raw<StorageSeriesView[]>([])
  let lastScan = $state(0)
  let scanning = $state(false)
  let progress = $state('')
  let notices = $state.raw<SmartNotice[]>([])
  let showKids = $state<Record<string, boolean>>({})

  const st = $derived(cleanStorageSettings(app.settings?.storageIntel))
  const sm = $derived(cleanSmartSettings(app.settings?.smartNotify))
  const here = $derived(!isVirtual(app.active.path) && !isArchivePath(app.active.path) ? app.active.path : '')
  const drives = $derived(views.filter((v) => v.kind === 'drive'))
  const folderViews = $derived(views.filter((v) => v.kind === 'folder'))
  const kidsOf = (id?: string) => views.filter((v) => v.kind === 'child' && v.folderId === id).sort((a, b) => (b.trend.recent ?? 0) - (a.trend.recent ?? 0))

  async function load() {
    const r = await engine.call<{ views: StorageSeriesView[]; lastScan: number; scanning: boolean; progress: string }>('storage.views')
    views = r.views
    lastScan = r.lastScan
    scanning = r.scanning
    progress = r.progress
  }

  onMount(() => {
    void load()
    void engine.call<SmartNotice[]>('smart.list').then((l) => (notices = l))
    const off1 = engine.on('storage', (m: { views: StorageSeriesView[] | null; scanning: boolean; progress: string }) => {
      scanning = m.scanning
      progress = m.progress
      if (m.views) {
        views = m.views
        lastScan = Date.now()
      }
    })
    const off2 = engine.on('smart-notice', (n: SmartNotice) => (notices = [n, ...notices.filter((x) => x.key !== n.key)]))
    return () => {
      off1?.()
      off2?.()
    }
  })

  function saveStorage(patch: Partial<ReturnType<typeof cleanStorageSettings>>) {
    app.updateSettings({ storageIntel: { ...st, ...patch } })
  }
  function saveSmart(patch: Partial<ReturnType<typeof cleanSmartSettings>>) {
    app.updateSettings({ smartNotify: { ...sm, ...patch } })
  }

  function track(path: string) {
    if (!path || st.folders.some((f) => f.path.toLowerCase() === path.toLowerCase())) return
    const f: TrackedFolder = { id: `st${Date.now().toString(36)}`, path, notify: [], children: true }
    saveStorage({ folders: [...st.folders, f] })
    app.toast('success', `Tracking ${path.split('\\').pop() || path}`, 'Its size is measured every few hours; trends appear after four days of history.')
    void engine.call('storage.scanNow')
  }
  async function addFolder() {
    const p = await host.dialog.folder('Track storage growth of…', here || undefined)
    if (p) track(p)
  }
  function untrack(id: string) {
    saveStorage({ folders: st.folders.filter((f) => f.id !== id) })
  }
  async function editPeople(f: TrackedFolder) {
    const v = await app.prompt('People to alert about this folder', f.notify.join(', '), 'Office user names, separated by commas (you are always alerted)')
    if (v === null) return
    const notify = v.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
    saveStorage({ folders: st.folders.map((x) => (x.id === f.id ? { ...x, notify } : x)) })
  }

  function spark(vals: number[], w = 120, h = 28) {
    if (vals.length < 2) return ''
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const span = hi - lo || 1
    return vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join(' ')
  }
  const rate = (v: StorageSeriesView) => (v.trend.rate === null ? '—' : `${v.trend.rate >= 0 ? '+' : ''}${fmtBytes(v.trend.rate)}/day`)
  const fullIn = (v: StorageSeriesView) => (v.fullIn === null ? 'not filling' : v.fullIn > 3650 ? 'not in years' : `full in ~${Math.floor(v.fullIn)} days`)

  async function act(n: SmartNotice, a: SmartAction) {
    if (a.id === 'show') return app.reveal(a.paths[0])
    if (a.id === 'open') return app.active.navigate(a.paths[0])
    if (a.id === 'review') return review(n, a)
    if (a.id === 'recycle') {
      // a duplicate is checked again right before it goes
      if (n.kind === 'duplicate' && n.actions[1]?.paths[1]) {
        const same = await engine.call<boolean>('smart.stillIdentical', a.paths[0], n.actions[1].paths[1]).catch(() => false)
        if (!same) return app.toast('warning', 'Not identical any more', 'One of the two files changed or moved; nothing was recycled.')
      }
      if (!(await app.confirm(`Recycle ${a.paths.length === 1 ? a.paths[0].split('\\').pop() : `${a.paths.length} files`}?`, 'It goes to the Recycle Bin; you can restore it from there.', 'Recycle'))) return
      await host.shell.trash(a.paths)
      await dismiss(n)
      app.toast('success', `Recycled — ${fmtSize(n.bytes)} freed`)
    }
  }
  let reviewing = $state<{ n: SmartNotice; files: { path: string; name: string; size: number; mtime: number; pick: boolean }[] } | null>(null)
  async function review(n: SmartNotice, a: SmartAction) {
    const files = await engine.call<{ path: string; name: string; size: number; mtime: number }[]>('smart.review', a.paths)
    reviewing = { n, files: files.map((f) => ({ ...f, pick: true })) }
  }
  async function recyclePicked() {
    if (!reviewing) return
    const paths = reviewing.files.filter((f) => f.pick).map((f) => f.path)
    if (!paths.length) return
    const bytes = reviewing.files.filter((f) => f.pick).reduce((s, f) => s + f.size, 0)
    if (!(await app.confirm(`Recycle ${paths.length} files (${fmtSize(bytes)})?`, 'They go to the Recycle Bin. Files a program still has open are skipped by Windows.', 'Recycle'))) return
    await host.shell.trash(paths)
    await dismiss(reviewing.n)
    reviewing = null
    app.toast('success', `Recycled ${paths.length} files — ${fmtSize(bytes)} freed`)
  }
  async function dismiss(n: SmartNotice) {
    await engine.call('smart.dismiss', n.id)
    notices = notices.filter((x) => x.id !== n.id)
  }
  function mute(kind: SmartKind, on: boolean) {
    saveSmart({ muted: on ? [...new Set([...sm.muted, kind])] : sm.muted.filter((k) => k !== kind) })
  }
  const kindLabel = (k: SmartKind) => SMART_KINDS.find((x) => x.id === k)?.label ?? k
</script>

<Dialog title="Insights" icon="activity" width={760} onclose={() => close()}>
  <div class="tabs" role="tablist">
    <button role="tab" class:on={tab === 'storage'} aria-selected={tab === 'storage'} onclick={() => (tab = 'storage')}><Icon name="size" size={14} /> Storage forecast</button>
    <button role="tab" class:on={tab === 'notices'} aria-selected={tab === 'notices'} onclick={() => (tab = 'notices')}><Icon name="bell" size={14} /> Smart notices {#if notices.length}<span class="badge">{notices.length}</span>{/if}</button>
  </div>

  {#if tab === 'storage'}
    <div class="bar">
      <span class="muted">{scanning ? `Measuring ${progress}…` : lastScan ? `Measured ${fmtAgo(lastScan)} · every ${st.scanHours} h` : 'Not measured yet'}</span>
      <span class="grow"></span>
      <label class="check"><input type="checkbox" checked={st.enabled} onchange={(e) => saveStorage({ enabled: e.currentTarget.checked })} /> On</label>
      <button class="btn sm" disabled={scanning || !st.enabled} onclick={() => void engine.call('storage.scanNow')}><Icon name="refresh" size={14} /> Measure now</button>
    </div>

    <h4>Drives</h4>
    {#if !drives.length}<div class="muted pad">Drives appear after the first measurement.</div>{/if}
    {#each drives as v (v.key)}
      <div class="row" class:warn={v.fullIn !== null && v.fullIn <= FULL_WARN_DAYS}>
        <Icon name={v.path.startsWith('\\\\') ? 'network' : 'drive'} size={18} />
        <div class="main">
          <div class="name">{v.label}</div>
          <div class="meter"><span style:width={`${v.total ? Math.min(100, ((v.total - (v.free ?? 0)) / v.total) * 100) : 0}%`}></span></div>
          <div class="muted small">{fmtSize(v.free ?? 0)} free of {fmtSize(v.total ?? 0)} · {rate(v)} · <b>{fullIn(v)}</b></div>
        </div>
        <svg class="spark" viewBox="0 0 120 28" aria-hidden="true"><path d={spark(v.spark)} /></svg>
      </div>
    {/each}

    <h4>Tracked folders</h4>
    {#each st.folders as f (f.id)}
      {@const v = folderViews.find((x) => x.folderId === f.id)}
      {@const kids = kidsOf(f.id)}
      <div class="row" class:alert={v?.trend.unusual || kids.some((k) => k.trend.unusual)}>
        <Icon name="folder" size={18} />
        <div class="main">
          <div class="name" title={f.path}>{f.path}</div>
          {#if v}
            <div class="small">
              <b>{fmtBytes(v.trend.now)}</b> · {rate(v)}
              {#if v.trend.in30 !== null} · in 30 days ≈ {fmtBytes(v.trend.in30)} · in 90 days ≈ {fmtBytes(v.trend.in90 ?? 0)}{/if}
              {#if v.partial}<span class="warnt"> · partly measured</span>{/if}
            </div>
            {#if v.trend.unusual}<div class="reason"><Icon name="warning" size={12} /> {v.trend.reason}</div>{/if}
            {#if v.trend.rate === null}<div class="muted small">Trend after {Math.max(0, 4 - v.trend.days)} more day(s) of history.</div>{/if}
          {:else}
            <div class="muted small">Waiting for the first measurement…</div>
          {/if}
          <div class="muted small">Alerts go to you{f.notify.length ? ` and ${f.notify.join(', ')}` : ''} · <button class="link" onclick={() => editPeople(f)}>change</button>
            {#if kids.length} · <button class="link" onclick={() => (showKids = { ...showKids, [f.id]: !showKids[f.id] })}>{showKids[f.id] ? 'hide' : 'show'} {kids.length} subfolders</button>{/if}
          </div>
          {#if showKids[f.id]}
            <div class="kids">
              {#each kids.slice(0, 40) as k (k.key)}
                <div class="kid" class:alert={k.trend.unusual}>
                  <button class="link name2" title={k.path} onclick={() => { close(); void app.active.navigate(k.path) }}>{k.label}</button>
                  <span>{fmtBytes(k.trend.now)}</span>
                  <span class="muted">{rate(k)}</span>
                  <svg class="spark sm" viewBox="0 0 120 28" aria-hidden="true"><path d={spark(k.spark)} /></svg>
                </div>
              {/each}
            </div>
          {/if}
        </div>
        {#if v}<svg class="spark" viewBox="0 0 120 28" aria-hidden="true"><path d={spark(v.spark)} /></svg>{/if}
        <button class="icon" title="Stop tracking" onclick={() => untrack(f.id)}><Icon name="close" size={14} /></button>
      </div>
    {/each}
    <div class="adds">
      {#if here && !st.folders.some((f) => f.path.toLowerCase() === here.toLowerCase())}
        <button class="btn sm" onclick={() => track(here)}><Icon name="plus" size={14} /> Track “{here.split('\\').pop() || here}”</button>
      {/if}
      <button class="btn sm" onclick={addFolder}><Icon name="folder" size={14} /> Track a folder…</button>
      <span class="muted small">Measure every
        <select value={String(st.scanHours)} onchange={(e) => saveStorage({ scanHours: Number(e.currentTarget.value) })}>
          {#each [1, 3, 6, 12, 24] as h (h)}<option value={String(h)}>{h} h</option>{/each}
        </select></span>
    </div>
    <p class="muted small foot">Unusual = the last 3 days grew at least 512 MB/day, twice the usual rate, and well outside the folder's own day-to-day history (robust score ≥ 3.5). Drives warn when the 30-day trend fills them within {FULL_WARN_DAYS} days.</p>
  {:else if reviewing}
    <div class="bar">
      <button class="btn sm" onclick={() => (reviewing = null)}><Icon name="back" size={14} /> Back</button>
      <span class="muted">{reviewing.files.length} files · {fmtSize(reviewing.files.filter((f) => f.pick).reduce((s, f) => s + f.size, 0))} selected</span>
      <span class="grow"></span>
      <button class="btn sm danger" onclick={recyclePicked}><Icon name="delete" size={14} /> Recycle selected</button>
    </div>
    <div class="review">
      {#each reviewing.files as f (f.path)}
        <label class="rfile"><input type="checkbox" bind:checked={f.pick} /> <span class="ellipsis" title={f.path}>{f.name}</span><span class="muted">{fmtAgo(f.mtime)}</span><b>{fmtSize(f.size)}</b></label>
      {/each}
    </div>
  {:else}
    <div class="bar">
      <span class="muted">Watching Downloads{sm.folders.length ? ` and ${sm.folders.length} more` : ''}; Temp is checked every two hours.</span>
      <span class="grow"></span>
      <label class="check"><input type="checkbox" checked={sm.enabled} onchange={(e) => saveSmart({ enabled: e.currentTarget.checked })} /> On</label>
      <button class="btn sm" onclick={() => void engine.call('smart.sweep').then(() => app.toast('info', 'Checking Temp and Downloads now'))}><Icon name="refresh" size={14} /> Check now</button>
    </div>
    {#if !notices.length}<div class="muted pad">Nothing to report. Notices appear here and as Windows notifications.</div>{/if}
    {#each notices as n (n.id)}
      <div class="notice">
        <div class="ntop"><span class="kind">{kindLabel(n.kind)}</span><span class="muted small">{fmtAgo(n.at)}</span></div>
        <div class="name">{n.title}</div>
        <div class="muted small">{n.body}</div>
        <div class="acts">
          {#each n.actions as a (a.id)}<button class="btn sm" class:primary={a.id === 'recycle' || a.id === 'review'} onclick={() => void act(n, a)}>{a.label}</button>{/each}
          <button class="btn sm" onclick={() => void dismiss(n)}>Dismiss</button>
        </div>
      </div>
    {/each}
    <h4>Tell me about</h4>
    <div class="kinds">
      {#each SMART_KINDS as k (k.id)}
        <label class="check" title={k.help}><input type="checkbox" checked={!sm.muted.includes(k.id)} onchange={(e) => mute(k.id, !e.currentTarget.checked)} /> {k.label}</label>
      {/each}
    </div>
    <div class="adds">
      <span class="muted small">Large temp file from
        <select value={String(sm.largeTempMB)} onchange={(e) => saveSmart({ largeTempMB: Number(e.currentTarget.value) })}>
          {#each [100, 250, 500, 1024, 4096] as v (v)}<option value={String(v)}>{v >= 1024 ? `${v / 1024} GB` : `${v} MB`}</option>{/each}
        </select>
        · Temp folder from
        <select value={String(sm.tempTotalGB)} onchange={(e) => saveSmart({ tempTotalGB: Number(e.currentTarget.value) })}>
          {#each [2, 5, 10, 20, 50] as v (v)}<option value={String(v)}>{v} GB</option>{/each}
        </select></span>
      {#if here && !sm.folders.some((p) => p.toLowerCase() === here.toLowerCase())}
        <button class="btn sm" onclick={() => saveSmart({ folders: [...sm.folders, here] })}><Icon name="plus" size={14} /> Also watch “{here.split('\\').pop()}”</button>
      {/if}
    </div>
  {/if}
</Dialog>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 10px;
    border-bottom: 1px solid var(--divider);
  }
  .tabs button {
    border: 0;
    background: transparent;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-2);
    border-bottom: 2px solid transparent;
  }
  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .badge {
    background: var(--accent);
    color: var(--on-accent);
    border-radius: 10px;
    font-size: 11px;
    padding: 0 6px;
  }
  .bar,
  .adds {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 6px 0;
  }
  .grow {
    flex: 1;
  }
  h4 {
    margin: 14px 0 6px;
    font-size: 12px;
    color: var(--text-2);
    font-weight: 600;
  }
  .row,
  .notice {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px;
    border: 1px solid var(--stroke);
    border-radius: var(--r-lg);
    background: var(--card);
    margin-bottom: 6px;
  }
  .notice {
    flex-direction: column;
    gap: 4px;
  }
  .row.warn {
    border-color: color-mix(in srgb, var(--warn) 50%, transparent);
  }
  .row.alert {
    border-color: color-mix(in srgb, var(--bad) 50%, transparent);
    box-shadow: inset 3px 0 0 var(--bad);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .small {
    font-size: 12px;
  }
  .muted {
    color: var(--text-2);
  }
  .pad {
    padding: 8px 2px;
  }
  .warnt {
    color: var(--warn);
  }
  .reason {
    color: var(--bad);
    font-size: 12px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .meter {
    height: 6px;
    border-radius: 3px;
    background: var(--hover);
    overflow: hidden;
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .row.warn .meter span {
    background: var(--warn);
  }
  .spark {
    width: 120px;
    height: 28px;
    flex: none;
  }
  .spark.sm {
    width: 80px;
    height: 18px;
  }
  .spark path {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.5;
  }
  .row.alert > .spark path,
  .kid.alert .spark path {
    stroke: var(--bad);
  }
  .icon {
    border: 0;
    background: transparent;
    color: var(--text-3);
    width: 26px;
    height: 26px;
    border-radius: var(--r-sm);
    display: grid;
    place-items: center;
  }
  .icon:hover {
    background: var(--hover);
    color: var(--text);
  }
  .link {
    border: 0;
    background: transparent;
    color: var(--accent);
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .kids {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 220px;
    overflow: auto;
  }
  .kid {
    display: grid;
    grid-template-columns: 1fr 80px 110px 80px;
    gap: 8px;
    align-items: center;
    font-size: 12px;
  }
  .kid.alert .name2 {
    color: var(--bad);
  }
  .name2 {
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ntop {
    display: flex;
    justify-content: space-between;
    width: 100%;
  }
  .kind {
    font-size: 11px;
    color: var(--accent);
    font-weight: 600;
  }
  .acts {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .kinds {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 12px;
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .review {
    max-height: 380px;
    overflow: auto;
    border: 1px solid var(--stroke);
    border-radius: var(--r-md);
  }
  .rfile {
    display: grid;
    grid-template-columns: auto 1fr 110px 80px;
    gap: 8px;
    padding: 5px 8px;
    align-items: center;
    border-bottom: 1px solid var(--divider);
    font-size: 12px;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .foot {
    margin-top: 12px;
  }
  select {
    font: inherit;
  }
</style>
