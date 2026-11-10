<script lang="ts">
  // Settings: section list on the left, the section on the right. Personal settings apply at once
  // (no Save button). The Office section edits the shared office config as a draft and saves it
  // to the server, because every Hopper in the office reads that one file.
  import { onMount } from 'svelte'
  import { PATH_MODES } from '../../lib/pathcopy'
  import Dialog from '../Dialog.svelte'
  import Icon from '../Icon.svelte'
  import { app } from '../../lib/app.svelte'
  import { engine, host, lan } from '../../lib/api'
  import { fingerprintOf, lanx, toUnc, validKey } from '../../lib/lan2.svelte'
  import { basename, fmtAgo, fmtDateFull, plural } from '../../lib/format'
  import { DEFAULT_PRESETS } from '@shared/defaults'
  import { dialogs } from '../../lib/commands'
  import { groupRevisions, splitExt } from '@shared/revisions'
  import { BUILTIN_TEMPLATES } from '@shared/project-template'
  import { expandTree, inputsOf, isTree, validateTemplate } from '@shared/template-model'
  import type { ArchivePreset, IndexStatus, OfficeConfig, Peer, QuickDest, Settings } from '@shared/types'

  let { section, close }: { section?: string; close: (v?: unknown) => void } = $props()

  const SECTIONS = [
    { id: 'general', label: 'General', icon: 'settings' },
    { id: 'appearance', label: 'Appearance', icon: 'sun' },
    { id: 'files', label: 'Files & Copying', icon: 'copy' },
    { id: 'archives', label: 'Archives', icon: 'zip' },
    { id: 'sharing', label: 'Sharing', icon: 'share' },
    { id: 'office', label: 'Office', icon: 'people' },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'advanced', label: 'Advanced', icon: 'code' },
    { id: 'about', label: 'About', icon: 'info' }
  ]
  const initial = (section ?? '').toLowerCase()
  let current = $state(SECTIONS.some((x) => x.id === initial) ? initial : 'general')

  const s = $derived(app.settings!)
  const set = (patch: Partial<Settings>) => app.updateSettings(patch)
  const msg = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')

  // ---- General ---------------------------------------------------------------

  let login = $state(!!app.info?.loginItem)
  const keepInTray = $derived((app.settings as any)?.keepInTray !== false)

  async function setLogin(v: boolean) {
    try {
      await host.app.setLogin(v)
      login = v
      if (app.info) app.info.loginItem = v
    } catch (e) {
      app.toast('error', "Couldn't change the startup setting", msg(e))
    }
  }

  async function browseInbox() {
    const d = await host.dialog.folder('Inbox folder', s.inboxDir || undefined)
    if (d) set({ inboxDir: d })
  }

  // ---- Appearance ------------------------------------------------------------

  const ACCENTS = ['#0078d4', '#0063b1', '#8764b8', '#b146c2', '#e3008c', '#c30052', '#e81123', '#ca5010', '#ff8c00', '#498205', '#107c10', '#038387', '#00b7c3', '#567c73', '#69797e']
  let compact = $state(document.documentElement.dataset.density === 'compact')

  function setTheme(t: Settings['theme']) {
    set({ theme: t })
    // The accent shade depends on light or dark, so re-derive a custom accent too.
    if (s.accent !== 'system') app.setAccent(s.accent)
  }

  function setAccent(v: string) {
    set({ accent: v })
    if (v === 'system') {
      if (app.info?.accent) app.setAccent(app.info.accent)
    } else app.setAccent(v)
  }

  function setCompact(v: boolean) {
    compact = v
    document.documentElement.dataset.density = v ? 'compact' : ''
    try {
      localStorage.setItem('density', v ? 'compact' : '')
    } catch {
      /* storage unavailable */
    }
  }

  // ---- Files & copying -----------------------------------------------------------

  const setDests = (list: QuickDest[]) => set({ quickDests: list })

  async function addDest() {
    const d = await host.dialog.folder('Add a favourite destination')
    if (!d) return
    const rest = s.quickDests.filter((x) => x.path.toLowerCase() !== d.toLowerCase())
    setDests([{ path: d, pinned: true, usedAt: Date.now() }, ...rest])
  }

  // ---- Archives ----------------------------------------------------------------

  const LEVELS = [
    { v: 0, label: 'Store (no compression)' },
    { v: 1, label: 'Fastest' },
    { v: 3, label: 'Fast' },
    { v: 5, label: 'Normal' },
    { v: 7, label: 'Maximum' },
    { v: 9, label: 'Ultra' }
  ]
  let hasRar = $state(true)

  const setPresets = (list: ArchivePreset[]) => set({ archivePresets: list })
  const patchPreset = (id: string, patch: Partial<ArchivePreset>) => setPresets(s.archivePresets.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  function movePreset(i: number, d: -1 | 1) {
    const list = s.archivePresets.slice()
    const j = i + d
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    setPresets(list)
  }

  function removePreset(id: string) {
    const list = s.archivePresets.filter((p) => p.id !== id)
    if (!list.length) return
    setPresets(list)
    if (s.defaultPreset === id) set({ defaultPreset: list[0].id })
  }

  function addPreset() {
    const p: ArchivePreset = { id: `p${Date.now().toString(36)}`, name: 'New preset', format: 'zip', level: 5, volumeMB: 0 }
    setPresets([...s.archivePresets, p])
  }

  async function resetPresets() {
    if (!(await app.confirm('Restore the built-in archive presets?', 'Your own presets are removed.', 'Restore'))) return
    setPresets(structuredClone(DEFAULT_PRESETS))
    set({ defaultPreset: DEFAULT_PRESETS[0].id })
  }

  // ---- Sharing -------------------------------------------------------------------

  let blockInput = $state('')
  let firewallBusy = $state(false)
  const lanStatus = $derived(app.lanStatus)
  const STATUSES: Peer['status'][] = ['online', 'busy', 'away']

  function block() {
    const u = blockInput.trim()
    blockInput = ''
    if (!u || s.lan.blocked.some((b) => b.toLowerCase() === u.toLowerCase())) return
    set({ lan: { ...s.lan, blocked: [...s.lan.blocked, u] } })
  }

  async function firewall() {
    firewallBusy = true
    try {
      const ok = await host.shell.firewall()
      if (ok) app.toast('success', 'Windows Firewall now allows Hopper on private and domain networks')
      else app.toast('warning', "Windows Firewall wasn't changed", 'The administrator prompt was declined or failed.')
    } catch (e) {
      app.toast('error', "Couldn't change Windows Firewall", msg(e))
    } finally {
      firewallBusy = false
    }
  }

  // ---- Office (shared config on the server) ------------------------------------------

  let officeInfo = $state<{ config: OfficeConfig; path: string; error: string } | null>(null)
  let draft = $state<OfficeConfig | null>(null)
  let baseline = $state('')
  let officePath = $state(app.settings?.officeConfigPath ?? '')
  let officeBusy = $state(false)
  let showKey = $state(false)
  let showZapikey = $state(false)
  let testEmail = $state(app.settings?.profile.email ?? '')
  let testBusy = $state(false)
  let memberInput = $state<Record<string, string>>({})
  let convTest = $state<Record<string, string>>({})
  let revTest = $state('')
  const dirty = $derived(!!draft && JSON.stringify(draft) !== baseline)

  async function loadOffice() {
    try {
      const r = await host.office.get()
      officeInfo = r
      draft = structuredClone(r.config)
      baseline = JSON.stringify(draft)
      if (r.path) officePath = r.path
    } catch (e) {
      app.toast('error', "Couldn't read the office config", msg(e))
    }
  }

  async function changeOfficePath() {
    const p = officePath.trim()
    if (!p) return
    if (dirty && !(await app.confirm('Discard unsaved office changes?', 'Loading another office config throws away the edits you have not saved.', 'Discard'))) return
    officeBusy = true
    try {
      await app.reloadOffice(p)
      if (app.settings) app.settings.officeConfigPath = p
      await loadOffice()
    } catch (e) {
      app.toast('error', "Couldn't load the office config", msg(e))
    } finally {
      officeBusy = false
    }
  }

  async function browseOffice() {
    const files = await host.dialog.files('Choose the office config', [{ name: 'Office config', extensions: ['json'] }])
    if (files?.[0]) {
      officePath = files[0]
      await changeOfficePath()
    }
  }

  let shareStatus = $state('')
  async function checkShare() {
    shareStatus = 'Checking…'
    try {
      const r = await engine.call('pubshare.status')
      shareStatus = !r.enabled ? 'Not switched on' : !r.storeOk ? `Store folder not reachable: ${r.storeError ?? r.store}` : r.healthy ? `Share server online${r.server?.host ? ` on ${r.server.host}` : ''}` : (r.healthError ?? 'Share server not answering')
    } catch (e: any) {
      shareStatus = String(e?.message ?? e)
    }
  }

  function tidy(c: OfficeConfig): OfficeConfig {
    const lines = (a: string[]) => a.map((x) => x.trim()).filter(Boolean)
    const users = (a: string[] | undefined) => [...new Set(lines(a ?? []).map((x) => x.toLowerCase()))]
    return {
      ...c,
      admins: users(c.admins),
      announcers: users(c.announcers),
      officeName: c.officeName.trim(),
      serverInbox: c.serverInbox.trim(),
      publicShare: c.publicShare ? { ...c.publicShare, store: c.publicShare.store.trim(), pageUrl: c.publicShare.pageUrl.trim() } : undefined,
      cliq: { ...c.cliq, endpoint: c.cliq.endpoint.trim(), zapikey: c.cliq.zapikey.trim() },
      groups: c.groups.map((g) => ({ ...g, name: g.name.trim(), members: [...new Set(lines(g.members))] })),
      templates: c.templates.map((t) => ({ ...t, name: t.name.trim(), folders: lines(t.folders) })),
      conventions: c.conventions.map((n) => ({ ...n, name: n.name.trim() })),
      revisions: { patterns: lines(c.revisions.patterns), order: lines(c.revisions.order) }
    }
  }

  async function saveOffice() {
    if (!draft) return
    officeBusy = true
    try {
      await host.office.save(tidy($state.snapshot(draft) as OfficeConfig))
      await app.reloadOffice()
      await loadOffice()
      await lanx.refreshMeta()
      app.toast('success', 'Office config saved', 'Other PCs pick it up when they reload it or restart Hopper.')
    } catch (e) {
      app.toast('error', "Couldn't save the office config", msg(e))
    } finally {
      officeBusy = false
    }
  }

  async function revertOffice() {
    if (dirty && !(await app.confirm('Discard unsaved office changes?', undefined, 'Discard'))) return
    await loadOffice()
  }

  async function generateKey() {
    if (!draft) return
    const ok = await app.confirm(
      draft.officeKey ? 'Replace the office key?' : 'Generate an office key?',
      'After you save, every PC in the office must reload the office config (Settings → Office → Reload, or restart Hopper). Until then, PCs on the old key cannot send to or receive from PCs on the new one.',
      'Generate'
    )
    if (!ok) return
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    draft.officeKey = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    showKey = false
  }

  // ---- Office: admins, joining, inviting -------------------------------------------------

  // Only an office admin creates the key and edits the shared config (main enforces it too).
  // Everyone else gets a read-only page with a way to join: the config file, or a pasted key.
  const isAdmin = $derived(lanx.meta.admin)
  const joined = $derived(lanx.meta.keySource !== 'none')
  let draftFp = $state('')
  let joinKey = $state('')
  let joinFp = $state('')
  let joinBusy = $state(false)
  let adminInput = $state('')
  let announcerInput = $state('')
  let clock = $state(Date.now())
  const inviteLeft = $derived(lanx.inviteStatus.active ? Math.max(0, Math.ceil((lanx.inviteStatus.until - clock) / 1000)) : 0)

  $effect(() => {
    const k = draft?.officeKey ?? ''
    void fingerprintOf(k).then((fp) => (draftFp = fp))
  })
  $effect(() => {
    const k = joinKey
    void fingerprintOf(k).then((fp) => (joinFp = fp))
  })
  $effect(() => {
    if (!lanx.inviteStatus.active) return
    const t = setInterval(() => (clock = Date.now()), 1000)
    return () => clearInterval(t)
  })

  function addUser(list: 'admins' | 'announcers') {
    if (!draft) return
    const v = (list === 'admins' ? adminInput : announcerInput).trim().toLowerCase()
    if (list === 'admins') adminInput = ''
    else announcerInput = ''
    draft[list] ??= []
    if (v && !draft[list].includes(v)) draft[list].push(v)
  }

  async function removeAdmin(u: string) {
    if (!draft) return
    if (u === lanx.meta.user && !(await app.confirm('Remove yourself as an admin?', 'After you save, you can no longer change the office config from this account.', 'Remove'))) return
    draft.admins = draft.admins.filter((x) => x !== u)
  }

  async function joinByKey() {
    if (joinBusy || !validKey(joinKey)) return
    joinBusy = true
    try {
      const fp = await lanx.joinWithKey(joinKey, { via: 'paste' })
      joinKey = ''
      await loadOffice()
      app.toast('success', 'This PC joined the office', `Key fingerprint ${fp}. Colleagues appear under People in a few seconds.`)
    } catch (e) {
      app.toast('error', "Couldn't join", msg(e))
    } finally {
      joinBusy = false
    }
  }

  async function forgetKey() {
    if (!(await app.confirm('Forget the office key stored on this PC?', 'LAN sharing stops until this PC reads a key from the office config again, or you join again.', 'Forget'))) return
    await lanx.leave()
  }

  async function toggleInvite() {
    try {
      lanx.inviteStatus = await lan.call(lanx.inviteStatus.active ? 'invite.stop' : 'invite.start')
      clock = Date.now()
    } catch (e) {
      app.toast('error', "Couldn't start inviting", msg(e))
    }
  }

  async function moveOffice() {
    if (!draft || officeBusy) return
    const from = officeInfo?.path || officePath
    const picked = await host.dialog.folder('Move the office config to…', from.replace(/[\\/][^\\/]*$/, '') || undefined)
    if (!picked) return
    // a mapped drive letter differs between PCs: store the UNC so the pointer works everywhere
    const dir = toUnc(picked, app.drives).path
    const ok = await app.confirm(
      'Move the office config?',
      `office.json${dirty ? ' (with your unsaved changes)' : ''} and the announcements are written to ${dir}. A pointer stays in the old file, so PCs that can still read ${from} follow it by themselves; any other PC needs the new path or an invite.`,
      'Move'
    )
    if (!ok) return
    officeBusy = true
    try {
      const r = await host.office.save(tidy($state.snapshot(draft) as OfficeConfig), { moveTo: dir })
      if (app.settings) app.settings.officeConfigPath = r.path
      await app.reloadOffice()
      await loadOffice()
      await lanx.refreshMeta()
      app.toast('success', 'Office config moved', `${r.path}${r.pointer === false ? '. The old file could not be updated, so tell the other PCs the new path.' : ''}`)
    } catch (e) {
      app.toast('error', "Couldn't move the office config", msg(e))
    } finally {
      officeBusy = false
    }
  }

  async function copyText(text: string, what: string) {
    await host.clip.writeText(text)
    app.toast('info', `${what} copied`)
  }

  async function browseServerInbox() {
    if (!draft) return
    const d = await host.dialog.folder('Server inbox folder', draft.serverInbox || undefined)
    if (d) draft.serverInbox = d
  }

  async function testCliq() {
    testBusy = true
    try {
      const r = await lan.call<{ ok: boolean; status: number; error?: string }>('cliq.test', testEmail.trim())
      if (r?.ok) app.toast('success', `Test DM sent to ${testEmail.trim()}`)
      else app.toast('error', 'Cliq test failed', r?.error ?? `HTTP ${r?.status ?? '?'}`)
    } catch (e) {
      app.toast('error', 'Cliq test failed', msg(e))
    } finally {
      testBusy = false
    }
  }

  const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

  // ---- folder templates: structured ones are edited as JSON (everything but id and name) ----
  let tplErrors = $state<Record<string, string[]>>({})
  const TREE_KEYS = ['description', 'root', 'numbering', 'subLabel', 'inputs', 'tree', 'blocks'] as const
  function treeJson(t: OfficeConfig['templates'][number]) {
    const o: Record<string, unknown> = {}
    for (const k of TREE_KEYS) if (t[k] !== undefined) o[k] = t[k]
    return JSON.stringify(o, null, 2)
  }
  function setTreeJson(t: OfficeConfig['templates'][number], text: string) {
    let o: any
    try {
      o = JSON.parse(text)
    } catch (e: any) {
      tplErrors[t.id] = [`Not valid JSON: ${e.message}`]
      return
    }
    const next = { id: t.id, name: t.name, folders: [], ...o }
    const errs = o && typeof o === 'object' && Array.isArray(o.tree) ? validateTemplate(next) : ['The JSON needs a "tree" list']
    tplErrors[t.id] = errs
    if (errs.length) return
    for (const k of TREE_KEYS) delete (t as any)[k]
    Object.assign(t, o, { folders: [] })
  }
  /** the tree with sample values in the required fields, for the editor's preview */
  function samplePreview(t: OfficeConfig['templates'][number]) {
    const tt = $state.snapshot(t) as OfficeConfig['templates'][number]
    const sample: Record<string, unknown> = {}
    for (const i of inputsOf(tt)) if (i.required && (i.kind === 'text' || i.kind === 'list')) sample[i.id] = i.placeholder && !/one per line/i.test(i.placeholder) ? i.placeholder : 'Sample'
    const e = expandTree(tt, sample)
    return { errors: e.errors, count: e.folders.length, depth: e.folders.reduce((m, f) => Math.max(m, f.length), 0), lines: e.folders.filter((f) => f.length <= 3).map((f) => '  '.repeat(f.length - 1) + f.at(-1)) }
  }
  function copyBuiltin(b: (typeof BUILTIN_TEMPLATES)[number]) {
    const c = structuredClone($state.snapshot(b)) as OfficeConfig['templates'][number]
    delete c.builtin
    draft!.templates.push({ ...c, id: uid('t'), name: `${b.name} (office copy)` })
  }

  function addMember(gid: string) {
    const g = draft?.groups.find((x) => x.id === gid)
    const v = (memberInput[gid] ?? '').trim()
    memberInput[gid] = ''
    if (!g || !v || g.members.some((m) => m.toLowerCase() === v.toLowerCase())) return
    g.members.push(v)
  }

  function enterTo(fn: () => void) {
    return (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      fn()
    }
  }

  function moveIn<T>(list: T[], i: number, d: -1 | 1) {
    const j = i + d
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
  }

  function conventionCheck(pattern: string, name: string) {
    let re: RegExp
    try {
      re = new RegExp(`^(?:${pattern})$`)
    } catch (e) {
      return { ok: false, error: msg(e), stem: '' }
    }
    const stem = splitExt(name.trim()).stem
    return { ok: re.test(stem), error: '', stem }
  }

  function revPatternError(p: string) {
    if (!p.trim()) return ''
    try {
      new RegExp(p, 'i')
    } catch (e) {
      return msg(e)
    }
    return p.includes('(?<rev>') ? '' : 'Needs a named group (?<rev>…) for the revision token'
  }

  const revGroups = $derived.by(() => {
    if (!draft || !revTest.trim()) return null
    const names = revTest.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    const rules = $state.snapshot(draft.revisions) as OfficeConfig['revisions']
    const groups = groupRevisions(names.map((n, i) => ({ name: n, path: `${i}:${n}`, mtime: 0 })), rules)
    const grouped = new Set(groups.flatMap((g) => g.items.map((i) => i.path)))
    const loose = names.filter((n, i) => !grouped.has(`${i}:${n}`))
    return { groups, loose }
  })

  // ---- Search --------------------------------------------------------------------

  let indexStatus = $state<IndexStatus | null>(app.indexStatus)
  let rebuilding = $state(false)
  const roots = $derived(s.indexRoots.length ? s.indexRoots : app.defaultIndexRoots())

  async function addRoot() {
    const d = await host.dialog.folder('Index this folder')
    if (!d || roots.some((r) => r.toLowerCase() === d.toLowerCase())) return
    set({ indexRoots: [...roots, d] })
  }

  function removeRoot(r: string) {
    const list = roots.filter((x) => x !== r)
    if (!list.length) return app.toast('info', 'Keep at least one folder, or turn indexing off')
    set({ indexRoots: list })
  }

  async function rebuild() {
    rebuilding = true
    try {
      indexStatus = await engine.call<IndexStatus>('index.rebuild')
      app.toast('success', 'Search index rebuilt')
    } catch (e) {
      app.toast('error', 'Index rebuild failed', msg(e))
    } finally {
      rebuilding = false
    }
  }

  // ---- Advanced ------------------------------------------------------------------

  let dm = $state<any>(null)
  let dmBusy = $state(false)
  let dmError = $state('')

  async function defmgr(action: 'apply' | 'revert') {
    dmBusy = true
    dmError = ''
    try {
      dm = action === 'apply' ? await host.defmgr.apply() : await host.defmgr.revert()
    } catch (e) {
      dmError = msg(e)
    } finally {
      dmBusy = false
    }
  }

  async function clearThumbs() {
    try {
      await host.thumbs.clear()
      app.toast('success', 'Thumbnail cache cleared')
    } catch (e) {
      app.toast('error', "Couldn't clear the thumbnail cache", msg(e))
    }
  }

  async function clearArchiveCache() {
    try {
      await engine.call('archive.clearCache')
      app.toast('success', 'Archive cache cleared')
    } catch (e) {
      app.toast('error', "Couldn't clear the archive cache", msg(e))
    }
  }

  // ---- About ---------------------------------------------------------------------

  let upd = $state<{ status: string; version?: string; percent?: number; error?: string } | null>(null)
  let checking = $state(false)

  async function checkUpdates() {
    checking = true
    try {
      upd = await host.update.check()
    } catch (e) {
      upd = { status: 'error', error: msg(e) }
    } finally {
      checking = false
    }
  }

  const updText = $derived.by(() => {
    switch (upd?.status) {
      case 'checking': return 'Checking for updates…'
      case 'available': return `Hopper ${upd.version ?? ''} is available; downloading`
      case 'downloading': return `Downloading the update… ${upd.percent ?? 0}%`
      case 'ready': return `Hopper ${upd.version ?? ''} is ready to install`
      case 'none': return 'Hopper is up to date'
      case 'error': return `Couldn't check for updates. ${upd.error ?? ''}`
      case 'unavailable': return 'This is a development build; updates apply to the installed app.'
      default: return 'Not checked yet this session'
    }
  })

  // ---- wiring --------------------------------------------------------------------

  onMount(() => {
    void engine.call<boolean>('archive.hasRar').then((v) => (hasRar = v)).catch(() => {})
    void lan.call('lan.status').then((v) => (app.lanStatus = v)).catch(() => {})
    void engine.call<IndexStatus>('index.status').then((v) => (indexStatus = v)).catch(() => {})
    void host.defmgr.status().then((v: any) => (dm = v)).catch((e: any) => (dmError = msg(e)))
    void host.update.state().then((v: any) => (upd = v)).catch(() => {})
    void loadOffice()
    void lanx.refreshMeta()
    const offIndex = engine.on('index', (v: IndexStatus) => (indexStatus = v))
    const offUpdate = host.update.on((v: any) => (upd = v))
    return () => {
      offIndex()
      offUpdate()
    }
  })

  async function tryClose() {
    if (dirty && !(await app.confirm('Discard unsaved office changes?', 'The shared office config has edits that are not saved to the server.', 'Discard'))) {
      current = 'office'
      return
    }
    close()
  }
</script>

{#snippet toggle(label: string, desc: string, checked: boolean, onchange: (v: boolean) => void, disabled: boolean = false)}
  <label class="item" class:disabled>
    <span class="txt"><span>{label}</span>{#if desc}<span class="caption">{desc}</span>{/if}</span>
    <input type="checkbox" class="switch" {checked} {disabled} onchange={(e) => onchange(e.currentTarget.checked)} />
  </label>
{/snippet}

<Dialog title="Settings" icon="settings" width={860} onclose={tryClose}>
  <div class="wrap">
    <nav>
      {#each SECTIONS as x (x.id)}
        <button type="button" class:on={current === x.id} onclick={() => (current = x.id)}>
          <Icon name={x.icon} />
          <span>{x.label}</span>
          {#if x.id === 'office' && dirty}<span class="dot unsaved" title="Unsaved changes"></span>{/if}
        </button>
      {/each}
    </nav>

    <div class="panel">
      {#if current === 'general'}
        <h3 class="subtitle">Startup</h3>
        {@render toggle('Start Hopper when Windows starts', 'Starts in the tray, ready to receive files', login, setLogin)}
        {@render toggle('Keep running in the tray after the window closes', 'So colleagues can still send you files. Applies while LAN sharing is on.', keepInTray, (v) => app.updateSettings({ keepInTray: v } as any))}

        <h3 class="subtitle">Inbox</h3>
        <label class="field">
          <span>Files people send you are saved in</span>
          <div class="row">
            <input class="input" value={s.inboxDir} placeholder="Default Inbox folder" spellcheck="false" onchange={(e) => set({ inboxDir: e.currentTarget.value.trim() })} />
            <button type="button" class="btn" onclick={browseInbox}><Icon name="folderOpen" /> Browse</button>
            {#if s.inboxDir}<button type="button" class="btn subtle" onclick={() => { void app.active.navigate(s.inboxDir); tryClose() }} title="Open the Inbox folder"><Icon name="open" /></button>{/if}
          </div>
        </label>

        <h3 class="subtitle">Deleting</h3>
        {@render toggle('Ask before moving items to the Recycle Bin', '', s.confirmDelete, (v) => set({ confirmDelete: v }))}
        {@render toggle('Ask before deleting permanently (Shift+Delete)', 'Permanent deletes cannot be undone', s.confirmPermanentDelete !== false, (v) => set({ confirmPermanentDelete: v }))}
      {:else if current === 'appearance'}
        <h3 class="subtitle">Theme</h3>
        <div class="seg">
          {#each [['system', 'Use Windows setting'], ['light', 'Light'], ['dark', 'Dark']] as [v, l] (v)}
            <button type="button" class:on={s.theme === v} onclick={() => setTheme(v as Settings['theme'])}>{l}</button>
          {/each}
        </div>

        <h3 class="subtitle">Accent colour</h3>
        <div class="swatches">
          <button type="button" class="sw sys" class:on={s.accent === 'system'} onclick={() => setAccent('system')} title="Use the Windows accent colour" style:--c={app.info?.accent ?? 'var(--accent)'}>
            <span></span>Windows
          </button>
          {#each ACCENTS as c (c)}
            <button type="button" class="sw" class:on={s.accent.toLowerCase() === c} onclick={() => setAccent(c)} title={c} aria-label={`Accent ${c}`} style:--c={c}><span></span></button>
          {/each}
          <label class="sw custom" title="Pick any colour">
            <input type="color" value={s.accent === 'system' ? (app.info?.accent ?? '#0078d4') : s.accent} onchange={(e) => setAccent(e.currentTarget.value)} />
          </label>
        </div>

        <h3 class="subtitle">File list</h3>
        {@render toggle('Compact rows', 'Fits more files on screen', compact, setCompact)}
        {@render toggle('Show hidden items', 'Ctrl+H', s.showHidden, (v) => set({ showHidden: v }))}
        {@render toggle('Also show protected system files', 'Only when hidden items are shown', s.showSystem, (v) => set({ showSystem: v }), !s.showHidden)}
        {@render toggle('Show file extensions', '', s.showExtensions, (v) => set({ showExtensions: v }))}
        <div class="item">
          <span class="txt"><span>Thumbnail size</span><span class="caption">Thumbnails view</span></span>
          <span class="range">
            <input type="range" min="48" max="256" step="16" value={s.thumbSize} onchange={(e) => set({ thumbSize: Number(e.currentTarget.value) })} />
            <span class="caption">{s.thumbSize} px</span>
          </span>
        </div>
      {:else if current === 'files'}
        <h3 class="subtitle">Copying</h3>
        {@render toggle('Show a progress window', 'Copy, move, delete, zip and extract show their progress in a small window with pause and cancel. When this is off, the Transfers panel opens instead.', s.progressPopup !== false, (v) => set({ progressPopup: v }))}
        {@render toggle('Verify copies with a checksum', 'Each copied file is read back and compared with SHA-256. Slower, but catches bad network copies.', s.verifyCopies, (v) => set({ verifyCopies: v }))}
        <div class="item">
          <span class="txt"><span>Small files copied at once</span><span class="caption">More is faster for many small files on fast disks; fewer is gentler on the server</span></span>
          <select class="input narrow" value={s.parallelSmallFiles} onchange={(e) => set({ parallelSmallFiles: Number(e.currentTarget.value) })}>
            {#each [1, 2, 3, 4, 5, 6, 7, 8] as n (n)}<option value={n}>{n}</option>{/each}
          </select>
        </div>

        <h3 class="subtitle">Path Copy</h3>
        <div class="item">
          <span class="txt"><span>Ctrl+Shift+C copies</span><span class="caption">The other forms are in the right-click Path Copy menu and the command palette.</span></span>
          <select class="input" value={s.pathCopy?.defaultMode ?? 'path'} onchange={(e) => set({ pathCopy: { ...(s.pathCopy ?? { quote: 'never' }), defaultMode: e.currentTarget.value } })}>
            {#each PATH_MODES as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
          </select>
        </div>
        <div class="item">
          <span class="txt"><span>Quotes</span><span class="caption">Wrap copied paths in "double quotes".</span></span>
          <select class="input" value={s.pathCopy?.quote ?? 'never'} onchange={(e) => set({ pathCopy: { ...(s.pathCopy ?? { defaultMode: 'path' }), quote: e.currentTarget.value as 'never' | 'spaces' | 'always' } })}>
            <option value="never">Never</option>
            <option value="spaces">Only when the path has spaces</option>
            <option value="always">Always</option>
          </select>
        </div>

        <h3 class="subtitle">Quick destinations</h3>
        <div class="caption">Shown in Copy to / Move to. Pinned ones stay; the 10 most recent are kept automatically.</div>
        <div class="list">
          {#each s.quickDests as d (d.path)}
            <div class="lrow">
              <button type="button" class="btn subtle icon sm" class:pinned={d.pinned} title={d.pinned ? 'Unpin' : 'Pin'} aria-label={d.pinned ? 'Unpin' : 'Pin'} onclick={() => setDests(s.quickDests.map((x) => (x.path === d.path ? { ...x, pinned: !x.pinned } : x)))}><Icon name="pin" /></button>
              <input class="input lbl" value={d.label ?? ''} placeholder={basename(d.path) || d.path} spellcheck="false" onchange={(e) => setDests(s.quickDests.map((x) => (x.path === d.path ? { ...x, label: e.currentTarget.value.trim() || undefined } : x)))} />
              <span class="caption ellipsis grow" title={d.path}>{d.path}</span>
              {#if !d.pinned}<span class="caption">{fmtAgo(d.usedAt)}</span>{/if}
              <button type="button" class="btn subtle icon sm" title="Remove" aria-label="Remove" onclick={() => setDests(s.quickDests.filter((x) => x.path !== d.path))}><Icon name="close" /></button>
            </div>
          {:else}
            <div class="caption">No destinations yet. Folders you copy or move to appear here.</div>
          {/each}
        </div>
        <div class="row">
          <button type="button" class="btn" onclick={addDest}><Icon name="plus" /> Add pinned folder</button>
          <button type="button" class="btn subtle" disabled={!s.quickDests.some((d) => !d.pinned)} onclick={() => setDests(s.quickDests.filter((d) => d.pinned))}>Forget recent</button>
        </div>
      {:else if current === 'archives'}
        <h3 class="subtitle">Presets</h3>
        <div class="caption">The default preset is used by one-key Zip (Ctrl+Alt+Z). {#if !hasRar}<span class="warnText">WinRAR is not installed on this PC, so RAR presets can't be used here.</span>{:else}WinRAR is installed, so RAR presets work.{/if}</div>
        <div class="presets">
          <div class="ph caption"><span>Default</span><span>Name</span><span>Format</span><span>Compression</span><span>Split (MB)</span><span>Password</span><span></span></div>
          {#each s.archivePresets as p, i (p.id)}
            <div class="pr">
              <input type="radio" name="defpreset" checked={s.defaultPreset === p.id} onchange={() => set({ defaultPreset: p.id })} aria-label="Default preset" />
              <input class="input" value={p.name} spellcheck="false" onchange={(e) => patchPreset(p.id, { name: e.currentTarget.value.trim() || p.name })} />
              <select class="input" value={p.format} onchange={(e) => patchPreset(p.id, { format: e.currentTarget.value as ArchivePreset['format'] })}>
                <option value="zip">ZIP</option>
                <option value="7z">7z</option>
                <option value="rar">RAR{hasRar ? '' : ' (not installed)'}</option>
              </select>
              <select class="input" value={p.level} onchange={(e) => patchPreset(p.id, { level: Number(e.currentTarget.value) })}>
                {#each LEVELS as l (l.v)}<option value={l.v}>{l.label}</option>{/each}
              </select>
              <input class="input" type="number" min="0" step="1" value={p.volumeMB} title="0 = don't split" onchange={(e) => patchPreset(p.id, { volumeMB: Math.max(0, Math.round(Number(e.currentTarget.value) || 0)) })} />
              <input type="checkbox" class="cb" checked={!!p.password} title="Ask for a password" aria-label="Ask for a password" onchange={(e) => patchPreset(p.id, { password: e.currentTarget.checked })} />
              <span class="acts">
                <button type="button" class="btn subtle icon sm" aria-label="Move up" disabled={i === 0} onclick={() => movePreset(i, -1)}><Icon name="chevronUp" /></button>
                <button type="button" class="btn subtle icon sm" aria-label="Move down" disabled={i === s.archivePresets.length - 1} onclick={() => movePreset(i, 1)}><Icon name="chevronDown" /></button>
                <button type="button" class="btn subtle icon sm" aria-label="Remove" disabled={s.archivePresets.length < 2} onclick={() => removePreset(p.id)}><Icon name="delete" /></button>
              </span>
            </div>
          {/each}
        </div>
        <div class="row">
          <button type="button" class="btn" onclick={addPreset}><Icon name="plus" /> Add preset</button>
          <button type="button" class="btn subtle" onclick={resetPresets}>Restore built-in presets</button>
        </div>
      {:else if current === 'sharing'}
        <h3 class="subtitle">Your profile</h3>
        <div class="grid2">
          <label class="field">
            <span>Display name</span>
            <input class="input" value={s.profile.displayName} placeholder={app.info?.identity?.displayName ?? ''} spellcheck="false" onchange={(e) => set({ profile: { ...s.profile, displayName: e.currentTarget.value.trim() } })} />
          </label>
          <label class="field">
            <span>Zoho email <span class="caption">(for Cliq DMs)</span></span>
            <input class="input" type="email" value={s.profile.email} placeholder="name@company.com" spellcheck="false" onchange={(e) => set({ profile: { ...s.profile, email: e.currentTarget.value.trim() } })} />
          </label>
          <label class="field">
            <span>Status</span>
            <select class="input" value={s.profile.status} onchange={(e) => set({ profile: { ...s.profile, status: e.currentTarget.value as Peer['status'] } })}>
              {#each STATUSES as st (st)}<option value={st}>{st[0].toUpperCase() + st.slice(1)}</option>{/each}
            </select>
          </label>
        </div>

        <h3 class="subtitle">LAN sharing</h3>
        <div class="status" class:ok={lanStatus?.ready}>
          <span class="dot" class:on={lanStatus?.ready}></span>
          <span class="grow">
            {#if !lanStatus}Checking…{:else if lanStatus.ready}Ready{lanStatus.port ? ` on port ${lanStatus.port}` : ''}{lanStatus.self ? ` · ${lanStatus.self.host} (${lanStatus.self.address})` : ''}{:else if !lanStatus.enabled}Off{lanStatus.reason ? `: ${lanStatus.reason}` : ''}{:else}Not ready{lanStatus.reason ? `: ${lanStatus.reason}` : ''}{/if}
          </span>
          <button type="button" class="btn sm" onclick={() => lan.call('lan.status').then((v) => (app.lanStatus = v)).catch(() => {})}><Icon name="refresh" /></button>
        </div>
        {#if lanx.meta.keySource === 'none'}<div class="caption warnText">Sharing needs the office key. {lanx.meta.admin ? 'Create it under Office.' : 'Join the office under Office.'}</div>{/if}
        {@render toggle('Share and receive files over the office network', 'Colleagues running Hopper can send to this PC, and you to them', s.lan.enabled, (v) => set({ lan: { ...s.lan, enabled: v } }))}
        <div class="item">
          <span class="txt"><span>When someone sends you files</span><span class="caption">Blocked people are always refused</span></span>
          <select class="input narrow2" value={s.lan.acceptFrom} onchange={(e) => set({ lan: { ...s.lan, acceptFrom: e.currentTarget.value as 'all' | 'ask' } })}>
            <option value="all">Accept into the Inbox</option>
            <option value="ask">Ask me first</option>
          </select>
        </div>
        <label class="field">
          <span>Blocked people <span class="caption">(Windows user names)</span></span>
          <div class="chips">
            {#each s.lan.blocked as b, bi (bi)}
              <span class="chip">{app.personName(b)}{app.personName(b) !== b ? ` (${b})` : ''}<button type="button" aria-label={`Unblock ${b}`} onclick={() => set({ lan: { ...s.lan, blocked: s.lan.blocked.filter((x) => x !== b) } })}><Icon name="close" size={10} /></button></span>
            {/each}
            <input class="bare" list="hopper-people" bind:value={blockInput} placeholder="Add a user name and press Enter" spellcheck="false" onkeydown={enterTo(block)} />
          </div>
        </label>
        <div class="item">
          <span class="txt"><span>Allow Hopper through Windows Firewall</span><span class="caption">Needed once per PC so others can reach it. Asks for administrator rights.</span></span>
          <button type="button" class="btn" disabled={firewallBusy} onclick={firewall}><Icon name="shield" /> Allow</button>
        </div>
      {:else if current === 'office' && !isAdmin}
        <div class="note"><Icon name="info" /> <span>The office is set up by its admin{app.office?.admins?.length ? ` (${app.office.admins.map((a) => app.personName(a)).join(', ')})` : ''}. This page shows what this PC uses; there is nothing to configure here.</span></div>
        <div class="item">
          <span class="txt">
            <span>{app.office?.officeName || 'Office'}</span>
            <span class="caption" class:warnText={!!officeInfo?.error}>
              {#if !officeInfo}Loading…{:else if officeInfo.error}This PC can't read the office config at {officeInfo.path || officePath}{officeInfo.error === 'not-found' ? '' : ` (${officeInfo.error})`}{:else}Config loaded from {officeInfo.path}{/if}
            </span>
          </span>
          <button type="button" class="btn" onclick={() => lanx.openList()}><Icon name="bell" /> Announcements</button>
        </div>
        <div class="item" data-join-state={joined ? 'joined' : 'none'}>
          <span class="dot" class:on={joined}></span>
          <span class="txt">
            <span><b>{joined ? 'Joined' : 'Not joined'}</b>{#if joined}&nbsp;· key fingerprint <code class="key">{lanx.meta.fingerprint}</code>{/if}</span>
            <span class="caption">
              {#if lanx.meta.keySource === 'config'}Key read from the shared office config.
              {:else if lanx.meta.keySource === 'override'}{s.officeJoined?.via === 'invite' ? `Joined from ${s.officeJoined.by || 'an admin'}'s invite` : 'Joined with a pasted key'}{s.officeJoined?.at ? ` on ${fmtDateFull(s.officeJoined.at)}` : ''}. Stored on this PC only.
              {:else}This PC has no office key yet, so it can't share with colleagues. Join below, or ask the admin to invite this PC.{/if}
            </span>
          </span>
          {#if lanx.meta.keySource === 'override'}<button type="button" class="btn subtle" onclick={forgetKey}>Forget key</button>{/if}
        </div>

        {#each lanx.invites as inv (inv.id)}
          <div class="item invite">
            <span class="txt">
              <span><b>{inv.adminName}</b> ({inv.host}, {inv.address}) invites this PC to join <b>{inv.officeName}</b></span>
              <span class="caption">Key fingerprint <code class="key">{inv.fingerprint}</code>{inv.haveKey ? ' · different from the key this PC uses' : ''}</span>
            </span>
            <span class="acts">
              <button type="button" class="btn primary" onclick={() => lanx.acceptInvite(inv).then(loadOffice)}>{inv.haveKey ? 'Switch to it' : 'Join'}</button>
              <button type="button" class="btn" onclick={() => lanx.ignoreInvite(inv)}>Ignore</button>
            </span>
          </div>
        {/each}

        <h3 class="subtitle">Join office</h3>
        <label class="field">
          <span>Office config file <span class="caption">(the admin's office.json on the server)</span></span>
          <div class="row">
            <input class="input" bind:value={officePath} spellcheck="false" onkeydown={enterTo(changeOfficePath)} />
            <button type="button" class="btn" onclick={browseOffice} disabled={officeBusy}><Icon name="folderOpen" /> Browse</button>
            <button type="button" class="btn" onclick={changeOfficePath} disabled={officeBusy || !officePath.trim()} title="Load the config from this path"><Icon name="refresh" /> Load</button>
          </div>
        </label>
        <label class="field">
          <span>Or paste the office key <span class="caption">(from the admin's announcement or message)</span></span>
          <div class="row">
            <input class="input mono" type="password" bind:value={joinKey} spellcheck="false" autocomplete="off" placeholder="64 hex characters" onkeydown={enterTo(joinByKey)} data-join-key />
            <button type="button" class="btn primary" disabled={joinBusy || !joinFp} onclick={joinByKey} data-join-go><Icon name="lock" /> Join</button>
          </div>
        </label>
        <div class="caption" class:warnText={!!joinKey.trim() && !joinFp}>
          {#if !joinKey.trim()}The key is only used when the office config has none or can't be reached. It is stored on this PC.
          {:else if joinFp}Fingerprint <code class="key">{joinFp}</code> · check it matches the one on the admin's Office page, then Join.
          {:else}Not an office key: it must be hex characters only, 32 or more.{/if}
        </div>
      {:else if current === 'office'}
        <div class="note"><Icon name="info" /> Saved to the server: every Hopper in the office uses it. You are an office admin.</div>
        <label class="field">
          <span>Office config file</span>
          <div class="row">
            <input class="input" bind:value={officePath} spellcheck="false" onkeydown={enterTo(changeOfficePath)} />
            <button type="button" class="btn" onclick={browseOffice} disabled={officeBusy}><Icon name="folderOpen" /> Browse</button>
            <button type="button" class="btn" onclick={changeOfficePath} disabled={officeBusy || !officePath.trim()} title="Load the config from this path"><Icon name="refresh" /> Reload</button>
          </div>
        </label>
        <div class="caption" class:warnText={!!officeInfo?.error}>
          {#if !officeInfo}Loading…{:else if officeInfo.error === 'not-found'}No office config at this path yet. Saving below creates it.{:else if officeInfo.error}Couldn't load: {officeInfo.error}. Showing defaults; saving would overwrite the file.{:else}Loaded from {officeInfo.path}{/if}
        </div>

        {#if draft}
          <div class="savebar" class:dirty>
            <span class="grow caption">{dirty ? 'Unsaved changes to the shared office config' : 'No unsaved changes'}</span>
            <button type="button" class="btn subtle" disabled={!dirty || officeBusy} onclick={revertOffice}>Discard</button>
            <button type="button" class="btn primary" disabled={!dirty || officeBusy} onclick={saveOffice}><Icon name="cloud" /> Save to server</button>
          </div>

          <div class="grid2">
            <label class="field"><span>Office name</span><input class="input" bind:value={draft.officeName} spellcheck="false" /></label>
            <label class="field">
              <span>Server inbox <span class="caption">(fallback when a PC is offline)</span></span>
              <div class="row">
                <input class="input" bind:value={draft.serverInbox} spellcheck="false" />
                <button type="button" class="btn icon" aria-label="Browse" title="Browse" onclick={browseServerInbox}><Icon name="folderOpen" /></button>
              </div>
            </label>
          </div>

          <h3 class="subtitle">Office key</h3>
          <div class="item">
            <span class="txt">
              <code class="key">{draft.officeKey ? (showKey ? draft.officeKey : `${'•'.repeat(24)}${draft.officeKey.slice(-4)}`) : 'Not set: LAN sharing is off until a key exists'}</code>
              <span class="caption">Shared secret for PC-to-PC transfers. Anyone with it can send to office PCs.</span>
            </span>
            <span class="acts">
              {#if draft.officeKey}
                <button type="button" class="btn subtle icon sm" aria-label={showKey ? 'Hide' : 'Show'} title={showKey ? 'Hide' : 'Show'} onclick={() => (showKey = !showKey)}><Icon name={showKey ? 'hidden' : 'eye'} /></button>
                <button type="button" class="btn subtle icon sm" aria-label="Copy" title="Copy" onclick={() => copyText(draft!.officeKey, 'Office key')}><Icon name="copy" /></button>
              {/if}
              <button type="button" class="btn" onclick={generateKey}><Icon name="lock" /> Generate</button>
            </span>
          </div>
          {#if draftFp}
            <div class="caption">Fingerprint <code class="key">{draftFp}</code> · every PC shows its own on the Office page; they match when the PC is on this key.{#if lanx.meta.keySource === 'override'} This PC is running on a key stored locally because the saved config has none.{/if}</div>
          {/if}
          <div class="item">
            <span class="txt">
              <span>Invite PCs on this network</span>
              <span class="caption">
                {#if inviteLeft}Inviting for {inviteLeft} s more. PCs without a key show a Join prompt with fingerprint <code class="key">{lanx.inviteStatus.fingerprint}</code>.
                {:else}For 2 minutes, PCs that have no key are offered this office and join with one click. The key crosses the LAN unencrypted during that time.{/if}
              </span>
            </span>
            <button type="button" class="btn" class:primary={!inviteLeft} disabled={!inviteLeft && (dirty || !draft.officeKey || !app.lanStatus?.ready)} title={dirty ? 'Save first' : !app.lanStatus?.ready ? 'LAN sharing must be ready' : ''} onclick={toggleInvite} data-invite-toggle>
              <Icon name={inviteLeft ? 'stop' : 'people'} /> {inviteLeft ? 'Stop inviting' : 'Invite PCs'}
            </button>
          </div>
          <div class="item">
            <span class="txt">
              <span>Move office config to…</span>
              <span class="caption">Writes office.json and the announcements into a folder you pick, and leaves a pointer in the old file for the other PCs.</span>
            </span>
            <button type="button" class="btn" disabled={officeBusy} onclick={moveOffice}><Icon name="folderOpen" /> Move…</button>
          </div>

          <h3 class="subtitle">Admins and announcers</h3>
          <label class="field">
            <span>Admins <span class="caption">(Windows user names; may create the key and change everything on this page)</span></span>
            <div class="chips">
              {#each draft.admins ?? [] as u (u)}
                <span class="chip">{app.personName(u)}{app.personName(u) !== u ? ` (${u})` : ''}<button type="button" aria-label={`Remove ${u}`} disabled={(draft.admins ?? []).length < 2} onclick={() => removeAdmin(u)}><Icon name="close" size={10} /></button></span>
              {/each}
              <input class="bare" list="hopper-people" bind:value={adminInput} placeholder="Add a user name and press Enter" spellcheck="false" onkeydown={enterTo(() => addUser('admins'))} />
            </div>
          </label>
          <label class="field">
            <span>Announcers <span class="caption">(besides admins, may post office announcements)</span></span>
            <div class="chips">
              {#each draft.announcers ?? [] as u (u)}
                <span class="chip">{app.personName(u)}{app.personName(u) !== u ? ` (${u})` : ''}<button type="button" aria-label={`Remove ${u}`} onclick={() => (draft!.announcers = draft!.announcers.filter((x) => x !== u))}><Icon name="close" size={10} /></button></span>
              {/each}
              <input class="bare" list="hopper-people" bind:value={announcerInput} placeholder="Add a user name and press Enter" spellcheck="false" onkeydown={enterTo(() => addUser('announcers'))} />
            </div>
          </label>
          <div class="row">
            <button type="button" class="btn" onclick={() => lanx.compose()}><Icon name="bell" /> New announcement…</button>
            <button type="button" class="btn subtle" onclick={() => lanx.openList()}>All announcements</button>
          </div>

          <h3 class="subtitle">Dexterity Share (client links)</h3>
          <div class="caption">Staff send a client a download link; the files stay on one office PC that is always on. Set it up once, on that PC.</div>
          <div class="row">
            <button type="button" class="btn primary" onclick={async () => { await dialogs.shareServer?.(); await loadOffice(); void checkShare() }}><Icon name="cloud" /> Set up…</button>
            <button type="button" class="btn" onclick={checkShare}>Check</button>
            <span class="caption ellipsis" title={shareStatus}>{shareStatus || (draft.publicShare?.enabled ? (draft.publicShare.host?.pc ? `On · share server: ${draft.publicShare.host.pc}` : 'On') : 'Not set up yet')}</span>
          </div>
          {#if draft.publicShare}
            <div class="grid2">
              <label class="check"><input type="checkbox" bind:checked={draft.publicShare.enabled} /> Let staff create client links</label>
              <label class="field"><span>Default expiry</span>
                <select class="input" bind:value={draft.publicShare.defaultDays}>
                  {#each [1, 3, 7, 14, 30, 60, 90] as d (d)}<option value={d}>{d} day{d > 1 ? 's' : ''}</option>{/each}
                </select></label>
            </div>
          {/if}

          <h3 class="subtitle">Zoho Cliq bot</h3>
          <label class="check"><input type="checkbox" bind:checked={draft.cliq.enabled} /> Send a Cliq DM to each recipient when files are shared</label>
          <div class="grid2">
            <label class="field"><span>Bot endpoint</span><input class="input" bind:value={draft.cliq.endpoint} spellcheck="false" placeholder="https://cliq.zoho.in/api/v2/bots/hopper/message" /></label>
            <label class="field">
              <span>zapikey</span>
              <div class="row">
                <input class="input" type={showZapikey ? 'text' : 'password'} bind:value={draft.cliq.zapikey} spellcheck="false" autocomplete="off" />
                <button type="button" class="btn icon" aria-label={showZapikey ? 'Hide' : 'Show'} onclick={() => (showZapikey = !showZapikey)}><Icon name={showZapikey ? 'hidden' : 'eye'} /></button>
              </div>
            </label>
          </div>
          <div class="row">
            <input class="input" type="email" bind:value={testEmail} placeholder="Zoho email to test with" spellcheck="false" />
            <button type="button" class="btn" disabled={testBusy || dirty || !testEmail.trim()} onclick={testCliq} title={dirty ? 'Save first: the test uses the saved config' : ''}><Icon name="send" /> {testBusy ? 'Sending…' : 'Send test DM'}</button>
          </div>
          {#if dirty}<div class="caption">The test uses the saved config, so save your changes first.</div>{/if}

          <h3 class="subtitle">Groups</h3>
          <div class="caption">Share with a whole team by typing @ and the group name.</div>
          {#each draft.groups as g, gi (g.id)}
            <div class="box">
              <div class="row">
                <input class="input" bind:value={g.name} placeholder="Group name" spellcheck="false" />
                <button type="button" class="btn subtle icon sm" aria-label="Remove group" title="Remove group" onclick={() => draft!.groups.splice(gi, 1)}><Icon name="delete" /></button>
              </div>
              <div class="chips">
                {#each g.members as m, mi (mi)}
                  <span class="chip">{app.personName(m)}{app.personName(m) !== m ? ` (${m})` : ''}<button type="button" aria-label={`Remove ${m}`} onclick={() => g.members.splice(mi, 1)}><Icon name="close" size={10} /></button></span>
                {/each}
                <input class="bare" list="hopper-people" bind:value={memberInput[g.id]} placeholder="Add a user name and press Enter" spellcheck="false" onkeydown={enterTo(() => addMember(g.id))} onchange={() => addMember(g.id)} />
              </div>
            </div>
          {/each}
          <div><button type="button" class="btn" onclick={() => draft!.groups.push({ id: uid('g'), name: 'New group', members: [] })}><Icon name="plus" /> Add group</button></div>

          <h3 class="subtitle">Folder templates</h3>
          <div class="caption">Simple templates: one folder per line, "/" for subfolders; {'{name}'}, {'{date}'} and {'{project}'} are filled in when the template is used. Structured templates (inputs, conditions, automatic numbering) are edited as JSON; start from a copy of a built-in one.</div>
          <div class="row wrap">
            <span class="caption">Built in:</span>
            {#each BUILTIN_TEMPLATES as b (b.id)}
              <button type="button" class="btn sm" title={b.description ?? ''} onclick={() => copyBuiltin(b)}><Icon name="duplicate" /> Copy “{b.name}” to edit</button>
            {/each}
          </div>
          {#each draft.templates as t, ti (t.id)}
            <div class="box">
              <div class="row">
                <input class="input" bind:value={t.name} placeholder="Template name" spellcheck="false" />
                <button type="button" class="btn subtle icon sm" aria-label="Move up" disabled={ti === 0} onclick={() => moveIn(draft!.templates, ti, -1)}><Icon name="chevronUp" /></button>
                <button type="button" class="btn subtle icon sm" aria-label="Move down" disabled={ti === draft.templates.length - 1} onclick={() => moveIn(draft!.templates, ti, 1)}><Icon name="chevronDown" /></button>
                <button type="button" class="btn subtle icon sm" aria-label="Remove template" onclick={() => draft!.templates.splice(ti, 1)}><Icon name="delete" /></button>
              </div>
              {#if isTree(t)}
                {@const pv = samplePreview(t)}
                <textarea class="input mono" rows={14} value={treeJson(t)} spellcheck="false" aria-label={`${t.name} as JSON`} onchange={(e) => setTreeJson(t, e.currentTarget.value)}></textarea>
                {#each tplErrors[t.id] ?? [] as m (m)}<div class="caption bad"><Icon name="error" size={12} /> {m}</div>{/each}
                {#if !(tplErrors[t.id] ?? []).length}
                  <div class="caption">{pv.errors.length ? pv.errors[0] : `With default inputs: ${plural(pv.count, 'folder')}, depth ${pv.depth}. First three levels:`}</div>
                  {#if !pv.errors.length}<pre class="input mono tplpv">{pv.lines.join('\n')}</pre>{/if}
                {/if}
              {:else}
                <textarea class="input mono" rows={Math.min(8, Math.max(3, t.folders.length + 1))} value={t.folders.join('\n')} spellcheck="false" onchange={(e) => (t.folders = e.currentTarget.value.split(/\r?\n/))}></textarea>
              {/if}
            </div>
          {/each}
          <div><button type="button" class="btn" onclick={() => draft!.templates.push({ id: uid('t'), name: 'New template', folders: [] })}><Icon name="plus" /> Add template</button></div>

          <h3 class="subtitle">Naming conventions</h3>
          <div class="caption">A regular expression the whole file name (without extension) must match. Case-sensitive. Used by the lot packager.</div>
          {#each draft.conventions as c, ci (c.id)}
            {@const ex = c.example ? conventionCheck(c.pattern, c.example) : null}
            {@const tt = convTest[c.id]?.trim() ? conventionCheck(c.pattern, convTest[c.id]) : null}
            <div class="box">
              <div class="row">
                <input class="input" bind:value={c.name} placeholder="Convention name" spellcheck="false" />
                <button type="button" class="btn subtle icon sm" aria-label="Remove convention" onclick={() => draft!.conventions.splice(ci, 1)}><Icon name="delete" /></button>
              </div>
              <label class="field"><span>Pattern</span><input class="input mono" bind:value={c.pattern} spellcheck="false" placeholder={'[A-Z0-9]+-ISO-\\d{4}'} /></label>
              <label class="field">
                <span>Example {#if ex}<span class="caption" class:okText={ex.ok} class:warnText={!ex.ok}>{ex.error ? ex.error : ex.ok ? '· matches' : "· doesn't match the pattern"}</span>{/if}</span>
                <input class="input mono" bind:value={c.example} spellcheck="false" />
              </label>
              <label class="field">
                <span>Test a name {#if tt}<span class="caption" class:okText={tt.ok} class:warnText={!tt.ok}>{tt.error ? tt.error : `· "${tt.stem}" ${tt.ok ? 'matches' : "doesn't match"}`}</span>{/if}</span>
                <input class="input mono" bind:value={convTest[c.id]} placeholder="Paste a file name" spellcheck="false" />
              </label>
            </div>
          {/each}
          <div><button type="button" class="btn" onclick={() => draft!.conventions.push({ id: uid('n'), name: 'New convention', pattern: '', example: '' })}><Icon name="plus" /> Add convention</button></div>

          <h3 class="subtitle">Revision rules</h3>
          <div class="caption">
            Patterns find the revision token in a file name (without extension). Each needs a named group <code>(?&lt;rev&gt;…)</code>; an optional <code>(?&lt;base&gt;…)</code> names the drawing. They are tried in order, ignoring case.
          </div>
          {#each draft.revisions.patterns as _p, pi (pi)}
            {@const err = revPatternError(draft.revisions.patterns[pi])}
            <div class="row">
              <input class="input mono" class:bad={!!err} bind:value={draft.revisions.patterns[pi]} spellcheck="false" title={err} />
              <button type="button" class="btn subtle icon sm" aria-label="Move up" disabled={pi === 0} onclick={() => moveIn(draft!.revisions.patterns, pi, -1)}><Icon name="chevronUp" /></button>
              <button type="button" class="btn subtle icon sm" aria-label="Remove pattern" onclick={() => draft!.revisions.patterns.splice(pi, 1)}><Icon name="delete" /></button>
            </div>
            {#if err}<div class="caption warnText">{err}</div>{/if}
          {/each}
          <div><button type="button" class="btn" onclick={() => draft!.revisions.patterns.push('')}><Icon name="plus" /> Add pattern</button></div>

          <label class="field">
            <span>Revision order <span class="caption">(earliest first, separated by commas or spaces)</span></span>
            <input class="input mono" value={draft.revisions.order.join(', ')} placeholder="e.g. P1, P2, A, B, C, 0, 1, 2" spellcheck="false" onchange={(e) => (draft!.revisions.order = e.currentTarget.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))} />
          </label>
          <div class="caption">
            With an empty order, numbers are compared with numbers (0 &lt; 1 &lt; 2) and letters with letters (A &lt; B, Z &lt; AA). A drawing whose revisions mix numbers and letters is reported as "order unknown", never guessed. Once you list an order, it decides, and any token not in the list is "order unknown".
          </div>
          <label class="field">
            <span>Try the rules <span class="caption">(one file name per line)</span></span>
            <textarea class="input mono" rows="3" bind:value={revTest} placeholder={'ISO-1001_RevA.pdf\nISO-1001_RevB.pdf\nISO-1001_Rev0.pdf'} spellcheck="false"></textarea>
          </label>
          {#if revGroups}
            <div class="revres">
              {#each revGroups.groups as g, i (i)}
                <div>
                  <b>{g.base}</b>{g.ext ? `.${g.ext}` : ''}: {g.items.map((x) => x.rev).join(g.orderKnown ? ' → ' : ', ')}
                  {#if !g.orderKnown}<span class="warnText"> · order unknown</span>{:else if g.latest}<span class="okText"> · latest {g.items.find((x) => x.path === g.latest)?.rev}</span>{:else}<span class="warnText"> · latest is ambiguous</span>{/if}
                  {#if g.outOfSequence.length}<span class="caption"> · {g.outOfSequence.join('; ')}</span>{/if}
                </div>
              {/each}
              {#each revGroups.loose as n, ni (ni)}<div class="caption">{n}: no revision token found</div>{/each}
            </div>
          {/if}
        {/if}
      {:else if current === 'search'}
        <h3 class="subtitle">Search index</h3>
        {@render toggle('Index file names for instant search', 'Names only, kept in memory and updated as files change', s.indexEnabled, (v) => set({ indexEnabled: v }))}
        <div class="caption">Indexed folders{s.indexRoots.length ? '' : ' (default: your user folder, plus D:\\ when present)'}</div>
        <div class="list">
          {#each roots as r, ri (ri)}
            {@const st = indexStatus?.roots.find((x) => x.path.toLowerCase() === r.toLowerCase())}
            <div class="lrow">
              <Icon name="folder" />
              <span class="ellipsis grow" title={r}>{r}</span>
              <span class="caption">
                {#if !s.indexEnabled}off{:else if !st}waiting{:else if !st.ready}indexing… {st.files.toLocaleString()}{:else}{plural(st.files, 'item')}{st.scannedAt ? ` · scanned ${fmtAgo(st.scannedAt)}` : ''}{/if}
              </span>
              <button type="button" class="btn subtle icon sm" aria-label={`Stop indexing ${r}`} title="Remove" onclick={() => removeRoot(r)}><Icon name="close" /></button>
            </div>
          {/each}
        </div>
        <div class="row">
          <button type="button" class="btn" onclick={addRoot} disabled={!s.indexEnabled}><Icon name="plus" /> Add folder</button>
          {#if s.indexRoots.length}<button type="button" class="btn subtle" onclick={() => set({ indexRoots: [] })}>Use default folders</button>{/if}
          <span class="grow"></span>
          <button type="button" class="btn" onclick={rebuild} disabled={rebuilding || !s.indexEnabled}><Icon name="refresh" /> {rebuilding ? 'Rebuilding…' : 'Rebuild index'}</button>
        </div>
        {#if indexStatus}
          <div class="caption">{plural(indexStatus.total, 'item')} indexed{indexStatus.building ? ' · building…' : ''}</div>
        {/if}
      {:else if current === 'advanced'}
        <h3 class="subtitle">Default file manager</h3>
        <div class="item">
          <span class="txt">
            <span>{dm?.label ?? 'Checking…'}</span>
            <span class="caption">Open folders and drives in Hopper from the desktop, Start, Win+E links and other apps. Revert restores what was there before.</span>
          </span>
          <span class="acts">
            <button type="button" class="btn" disabled={dmBusy || dm?.state === 'set'} onclick={() => defmgr('apply')}>Use Hopper</button>
            <button type="button" class="btn" disabled={dmBusy || (dm && dm.state !== 'set' && !dm.backup)} onclick={() => defmgr('revert')}>Revert</button>
          </span>
        </div>
        {#if dm && dm.packaged === false}<div class="caption">This is a development build; only the installed Hopper can register itself.</div>{/if}
        {#if dmError}<div class="caption warnText">{dmError}</div>{/if}
        {#if dm?.skipped?.length}<div class="caption warnText">Left alone because another app changed them since: {dm.skipped.map((x: any) => x.key).join(', ')}</div>{/if}

        <h3 class="subtitle">Maintenance</h3>
        <div class="item">
          <span class="txt"><span>Thumbnail cache</span><span class="caption">Thumbnails are rebuilt as folders are viewed</span></span>
          <button type="button" class="btn" onclick={clearThumbs}>Clear</button>
        </div>
        <div class="item">
          <span class="txt"><span>Archive cache</span><span class="caption">Files opened from inside archives</span></span>
          <button type="button" class="btn" onclick={clearArchiveCache}>Clear</button>
        </div>
        <div class="item">
          <span class="txt"><span>Settings folder</span><span class="caption ellipsis">{app.info?.userData ?? ''}</span></span>
          <button type="button" class="btn" disabled={!app.info?.userData} onclick={() => { void app.active.navigate(app.info.userData); tryClose() }}><Icon name="folderOpen" /> Open</button>
        </div>
        <div class="item">
          <span class="txt"><span>Developer tools</span><span class="caption">Ctrl+Shift+F12</span></span>
          <button type="button" class="btn" onclick={() => host.win.devtools()}><Icon name="code" /> Open</button>
        </div>
        <div class="item">
          <span class="txt"><span>Restart Hopper</span><span class="caption">Reloads everything, including the office config</span></span>
          <button type="button" class="btn" onclick={() => host.app.relaunch()}><Icon name="refresh" /> Restart</button>
        </div>
      {:else if current === 'about'}
        <div class="about">
          <div class="title">Hopper</div>
          <div class="caption">Version {app.info?.version ?? '?'}{app.info?.packaged ? '' : ' (development build)'}{app.info?.portable ? ' · portable' : ''}</div>
          <div class="caption">Electron {app.info?.electron ?? '?'} · Chrome {app.info?.chrome ?? '?'}</div>
          <div class="caption">© 2026 Dexterity Design Services Private Limited. Internal software for Dexterity staff; all rights reserved.</div>
        </div>

        <h3 class="subtitle">Updates</h3>
        <div class="item">
          <span class="txt"><span>{updText}</span>{#if !app.info?.packaged}<span class="caption">Updates are installed only in the installed build.</span>{/if}</span>
          <span class="acts">
            {#if upd?.status === 'ready'}<button type="button" class="btn primary" onclick={() => host.update.install()}>Restart and install</button>{/if}
            <button type="button" class="btn" disabled={checking} onclick={checkUpdates}><Icon name="refresh" /> {checking ? 'Checking…' : 'Check now'}</button>
          </span>
        </div>
        {@render toggle('Update automatically', 'Downloads in the background and installs when you quit. Takes effect at the next start.', s.autoUpdate, (v) => set({ autoUpdate: v }))}

        <h3 class="subtitle">Help</h3>
        <div class="row">
          <button type="button" class="btn" onclick={() => host.shell.openExternal('https://vikramdex-ops.github.io/Hopper/')}><Icon name="link" /> Hopper website</button>
          <button type="button" class="btn" onclick={() => host.shell.openExternal('https://github.com/vikramdex-ops/Hopper/releases')}><Icon name="download" /> Releases</button>
        </div>
      {/if}
    </div>
  </div>

  <datalist id="hopper-people">
    {#each app.peers as p (p.id)}<option value={p.user}>{p.displayName}{p.host ? ` · ${p.host}` : ''}</option>{/each}
  </datalist>

  {#snippet footer()}
    <span class="caption foot">{current === 'office' ? (isAdmin ? 'Office settings are shared and need Save to server.' : 'Office settings are managed by the office admin.') : 'Changes apply immediately.'}</span>
    <button type="button" class="btn primary" onclick={tryClose}>Close</button>
  {/snippet}
</Dialog>

<style>
  .wrap {
    display: grid;
    grid-template-columns: 196px 1fr;
    gap: 20px;
    height: min(620px, calc(100vh - 230px));
    min-height: 320px;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: auto;
  }
  nav button {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 36px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    text-align: left;
  }
  nav button span:first-of-type {
    flex: 1;
  }
  nav button:hover {
    background: var(--hover);
  }
  nav button.on {
    background: var(--sel);
  }
  nav button.on::before {
    content: '';
    position: absolute;
    left: 0;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  .unsaved {
    background: var(--warn);
  }
  .panel {
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-right: 6px;
    min-width: 0;
  }
  h3 {
    margin: 10px 0 0;
  }
  h3:first-child {
    margin-top: 0;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 52px;
    padding: 8px 14px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  .item.disabled {
    opacity: 0.6;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .switch {
    appearance: none;
    width: 40px;
    height: 20px;
    margin: 0;
    flex: none;
    border-radius: 10px;
    border: 1px solid var(--text-2);
    background: var(--control);
    position: relative;
    transition: background var(--fast) var(--ease);
  }
  .switch::before {
    content: '';
    position: absolute;
    top: 3px;
    left: 4px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-2);
    transition: transform var(--fast) var(--ease);
  }
  .switch:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  .switch:checked::before {
    background: var(--on-accent);
    transform: translateX(19px);
  }
  .switch:disabled {
    opacity: 0.5;
  }
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    align-self: flex-start;
  }
  .seg button {
    height: 30px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
  }
  .seg button.on {
    background: var(--card-solid);
    box-shadow: var(--shadow-card);
    color: var(--accent);
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .sw {
    width: 32px;
    height: 32px;
    padding: 3px;
    border-radius: var(--r-md);
    border: 2px solid transparent;
    background: transparent;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sw span {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: var(--r-sm);
    background: var(--c);
  }
  .sw.sys {
    width: auto;
    padding-right: 10px;
    font-size: 13px;
  }
  .sw.on {
    border-color: var(--text);
  }
  .sw:hover {
    background: var(--hover);
  }
  .sw.custom {
    position: relative;
    overflow: hidden;
  }
  .sw.custom input {
    width: 22px;
    height: 22px;
    border: 0;
    padding: 0;
    background: transparent;
  }
  .range {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .range input {
    accent-color: var(--accent);
    width: 180px;
  }
  .narrow {
    width: 80px;
  }
  .narrow2 {
    width: 200px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lrow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 4px;
    border-radius: var(--r-sm);
  }
  .lrow:hover {
    background: var(--hover);
  }
  .lrow .lbl {
    width: 180px;
    flex: none;
  }
  .pinned {
    color: var(--accent);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .presets {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ph,
  .pr {
    display: grid;
    grid-template-columns: 48px 1.6fr 0.8fr 1fr 80px 60px 92px;
    gap: 6px;
    align-items: center;
  }
  .pr input[type='radio'],
  .pr .cb {
    justify-self: center;
    accent-color: var(--accent);
    width: 16px;
    height: 16px;
    margin: 0;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 14px;
    border-radius: var(--r-md);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    font-size: 13px;
  }
  .status.ok {
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  .item > .dot {
    background: var(--warn);
  }
  .item > .dot.on {
    background: var(--ok);
  }
  .status .dot {
    background: var(--warn);
  }
  .status .dot.on {
    background: var(--ok);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 34px;
    padding: 4px 6px;
    border-radius: var(--r-sm);
    border: 1px solid var(--control-stroke);
    border-bottom-color: var(--control-stroke-bottom);
    background: var(--input);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 3px 0 10px;
    border-radius: 12px;
    background: var(--sel);
    font-size: 13px;
  }
  .chip button {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 0;
    background: transparent;
    display: grid;
    place-items: center;
    color: var(--text-2);
  }
  .chip button:hover {
    background: var(--hover);
  }
  .bare {
    flex: 1;
    min-width: 200px;
    height: 24px;
    border: 0;
    outline: 0;
    background: transparent;
    user-select: text;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--r-md);
    background: var(--sel);
    font-size: 13px;
  }
  .savebar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    border-radius: var(--r-md);
    background: var(--card-solid);
    border: 1px solid var(--stroke-2);
  }
  .savebar.dirty {
    border-color: var(--accent);
  }
  .box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
  }
  .key {
    font: 12px/18px var(--mono);
    word-break: break-all;
    user-select: text;
  }
  .mono {
    font-family: var(--mono);
  }
  .input.bad {
    border-bottom-color: var(--bad);
  }
  code {
    font-family: var(--mono);
  }
  .revres {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    border-radius: var(--r-md);
    background: var(--layer-solid);
    border: 1px solid var(--stroke);
    font-size: 13px;
  }
  .warnText {
    color: var(--warn);
  }
  .okText {
    color: var(--ok);
  }
  .about {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .foot {
    flex: 1;
    align-self: center;
  }
  .tplpv {
    max-height: 180px;
    overflow: auto;
    margin: 0;
    padding: 6px 10px;
    height: auto;
    font-size: 12px;
    white-space: pre;
  }
  .caption.bad {
    color: var(--bad);
  }
  .row.wrap {
    flex-wrap: wrap;
  }
</style>
