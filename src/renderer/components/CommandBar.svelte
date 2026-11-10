<script lang="ts">
  import { app, type MenuItem } from '../lib/app.svelte'
  import { byId, run, keyLabel, dialogs } from '../lib/commands'
  import { isArchivePath, isVirtual } from '../lib/pane.svelte'
  import { kindOf } from '../lib/filetypes'
  import Icon from './Icon.svelte'

  const pane = $derived(app.active)
  const targets = $derived(pane ? pane.targets() : [])
  const has = $derived(targets.length > 0)
  const real = $derived(pane ? !isVirtual(pane.path) : false)
  const writable = $derived(real && pane && !isArchivePath(pane.path))
  const archiveSel = $derived(targets.some((e) => kindOf(e.ext) === 'archive'))
  const pdfSel = $derived(has && targets.every((e) => e.ext === 'pdf'))
  const running = $derived(app.activeJobs.length)

  const item = (id: string, extra: Partial<MenuItem> = {}): MenuItem => {
    const c = byId.get(id)!
    return { label: c.label, icon: c.icon, keys: c.keys?.[0], run: () => run(id), disabled: c.when ? !c.when() : false, ...extra }
  }

  function at(e: MouseEvent, items: MenuItem[]) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    app.openMenu(r.left, r.bottom + 4, items)
  }

  function newMenu(e: MouseEvent) {
    at(e, [item('file.newFolder'), item('file.newFile'), { separator: true }, item('file.template'), { separator: true },
      { label: 'Word document', icon: 'documents', run: () => app.newFile('New Document.docx'), disabled: !writable },
      { label: 'Excel workbook', icon: 'sheet', run: () => app.newFile('New Workbook.xlsx'), disabled: !writable }])
  }

  function zipMenu(e: MouseEvent) {
    const presets = app.settings?.archivePresets ?? []
    at(e, [
      ...presets.map((p) => ({ label: p.name, icon: 'zip', checked: p.id === app.settings?.defaultPreset, run: () => app.zip(p.id), disabled: !has || !writable })),
      { separator: true },
      item('zip.dialog'),
      { separator: true },
      item('zip.extractSmart'),
      item('zip.extractEach'),
      item('zip.extractTo'),
      ...(app.dual ? [item('zip.extractOther')] : [])
    ])
  }

  function sortMenu(e: MouseEvent) {
    const s = pane.sort
    const opt = (key: any, label: string) => ({ label, checked: s.key === key, run: () => pane.setSort(key) })
    at(e, [opt('name', 'Name'), opt('mtime', 'Date modified'), opt('ctime', 'Date created'), opt('type', 'Type'), opt('size', 'Size'), opt('rev', 'Revision'),
      { separator: true },
      { label: 'Ascending', checked: s.dir === 1, run: () => (pane.sort = { ...s, dir: 1 }) },
      { label: 'Descending', checked: s.dir === -1, run: () => (pane.sort = { ...s, dir: -1 }) }])
  }

  function viewMenu(e: MouseEvent) {
    at(e, [
      item('view.details', { checked: pane.view === 'details' }),
      item('view.list', { checked: pane.view === 'list' }),
      item('view.grid', { checked: pane.view === 'grid' }),
      { separator: true },
      item('view.dual', { checked: app.dual }),
      item('view.sidebar', { checked: !app.settings?.sidebarCollapsed, label: 'Sidebar' }),
      item('view.inspector', { checked: app.settings?.inspector }),
      { separator: true },
      item('view.hidden', { checked: app.settings?.showHidden }),
      item('view.revisions', { checked: app.settings?.groupRevisions }),
      { label: 'Compact rows', checked: document.documentElement.dataset.density === 'compact', run: () => { const c = document.documentElement.dataset.density === 'compact'; document.documentElement.dataset.density = c ? '' : 'compact'; localStorage.setItem('density', c ? '' : 'compact') } },
      { separator: true },
      item('view.theme')
    ])
  }

  function moreMenu(e: MouseEvent) {
    at(e, [
      item('sel.all'), item('sel.invert'), item('sel.pattern'), { separator: true },
      item('file.copyTo'), item('file.moveTo'), item('file.duplicate'), item('file.massRename'), { separator: true },
      item('file.copyPath'), item('file.properties'), item('file.size'), item('file.checksum'), { separator: true },
      item('tools.compare'), item('tools.dupes'), item('tools.package'), item('tools.pdf'), { separator: true },
      item('tools.workspaceSave'), item('tools.workspaces'), item('file.terminal'), item('file.history'), { separator: true },
      item('app.shortcuts'), item('app.settings')
    ])
  }

  const tip = (label: string, id: string) => (keyLabel(id) ? `${label} (${keyLabel(id)})` : label)
</script>

<nav class="cmdbar" aria-label="Commands">
  <button class="btn subtle" onclick={newMenu} disabled={!writable} title="New">
    <Icon name="plus" /> New <Icon name="chevronDown" size={12} />
  </button>
  <div class="sep"></div>
  <button class="btn subtle icon" onclick={() => run('file.cut')} disabled={!has || !real} title={tip('Cut', 'file.cut')}><Icon name="cut" /></button>
  <button class="btn subtle icon" onclick={() => run('file.copy')} disabled={!has || !real} title={tip('Copy', 'file.copy')}><Icon name="copy" /></button>
  <button class="btn subtle icon" onclick={() => run('file.paste')} disabled={!real} title={tip('Paste', 'file.paste')}><Icon name="paste" /></button>
  <button class="btn subtle icon" onclick={() => run('file.rename')} disabled={!has || !real} title={tip('Rename', 'file.rename')}><Icon name="rename" /></button>
  <button class="btn subtle" onclick={() => run('share.send')} disabled={!has || !real} title={tip('Share with people on the network', 'share.send')}>
    <Icon name="share" /> Share
  </button>
  <button class="btn subtle icon" onclick={() => run('file.delete')} disabled={!has} title={tip('Delete', 'file.delete')}><Icon name="delete" /></button>
  <div class="sep"></div>
  <div class="split">
    <button class="btn subtle" onclick={() => run('zip.here')} disabled={!has || !writable} title={tip('Zip here with your default preset', 'zip.here')}>
      <Icon name="zip" /> Zip
    </button>
    <button class="btn subtle icon chev" onclick={zipMenu} title="Archive presets and extract" aria-label="Archive options"><Icon name="chevronDown" size={12} /></button>
  </div>
  {#if archiveSel}
    <button class="btn subtle" onclick={() => run('zip.extractSmart')} title={tip('Extract here', 'zip.extractSmart')}><Icon name="extract" /> Extract</button>
  {/if}
  {#if pdfSel}
    <button class="btn subtle" onclick={() => dialogs.pdf?.()} title="PDF tools"><Icon name="pdf" /> PDF</button>
  {/if}
  <div class="sep"></div>
  <button class="btn subtle" onclick={sortMenu} title="Sort"><Icon name="sort" /> Sort <Icon name="chevronDown" size={12} /></button>
  <button class="btn subtle" onclick={viewMenu} title="View"><Icon name={pane?.view === 'grid' ? 'grid' : pane?.view === 'list' ? 'list' : 'details'} /> View <Icon name="chevronDown" size={12} /></button>
  <button class="btn subtle icon" onclick={moreMenu} title="More" aria-label="More commands"><Icon name="more" /></button>
  <div class="spacer"></div>
  <button class="btn subtle icon" onclick={() => run('file.undo')} disabled={!app.undoList.some((u) => !u.undone)} title={tip('Undo', 'file.undo')}><Icon name="undo" /></button>
  <button class="btn subtle icon" class:on={app.dual} onclick={() => run('view.dual')} title={tip('Dual pane', 'view.dual')}><Icon name="dualPane" /></button>
  <button class="btn subtle icon" class:on={app.settings?.inspector} onclick={() => run('view.inspector')} title={tip('Preview & details', 'view.inspector')}><Icon name="inspector" /></button>
  <button class="btn subtle transfers" class:on={app.drawer} onclick={() => (app.drawer = !app.drawer)} title={tip('Transfers', 'view.transfers')}>
    {#if running}
      <span class="spin"></span>
      <span>{running}</span>
    {:else}
      <Icon name="activity" />
    {/if}
  </button>
</nav>

<style>
  .cmdbar {
    flex: none;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 8px 4px 8px;
  }
  .cmdbar :global(.btn) {
    height: 34px;
    gap: 6px;
  }
  .cmdbar :global(.btn.icon) {
    width: 36px;
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--divider);
    margin: 0 6px;
  }
  .split {
    display: flex;
  }
  .split .chev {
    width: 22px !important;
    margin-left: -2px;
  }
  .on {
    background: var(--hover) !important;
    color: var(--accent);
  }
  .transfers {
    min-width: 36px;
  }
  .spin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--stroke-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
