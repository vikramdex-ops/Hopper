// One file pane: tabs with their own history, the current listing, selection, sort and filter.
// Listings and selection use $state.raw (no deep proxies) so 100k-entry folders stay cheap.
import { engine } from './api'
import { collator, basename, dirname } from './format'
import { kindOf } from './filetypes'
import { groupRevisions } from '@shared/revisions'
import { ATTR, type ColumnSpec, type Entry, type PaneState, type TabState, type ViewMode } from '@shared/types'
import type { App } from './app.svelte'
import { networkHostOf, networkHostPath, serverOnlyUnc, shareRootHost } from '@shared/network'

export const VIRTUAL = {
  home: 'hopper:home',
  inbox: 'hopper:inbox',
  activity: 'hopper:activity',
  recycle: 'hopper:recycle',
  search: 'hopper:search',
  /** Network node: computers and saved places; ?host=NAME lists that computer's shares */
  network: 'hopper:network'
} as const

export const isVirtual = (p: string) => p.startsWith('hopper:')
export const isArchivePath = (p: string) => p.includes('::')
export const splitArchive = (p: string) => {
  const i = p.indexOf('::')
  return { file: p.slice(0, i), inner: p.slice(i + 2) }
}

export function titleFor(p: string) {
  if (p === VIRTUAL.home) return 'Home'
  if (p === VIRTUAL.inbox) return 'Inbox'
  if (p === VIRTUAL.activity) return 'Activity'
  if (p === VIRTUAL.recycle) return 'Recycle Bin'
  if (p === VIRTUAL.network) return 'Network'
  if (networkHostOf(p)) return networkHostOf(p)!
  if (p.startsWith(VIRTUAL.search)) return `Search: ${new URLSearchParams(p.split('?')[1] ?? '').get('q') ?? ''}`
  if (isArchivePath(p)) {
    const { file, inner } = splitArchive(p)
    return inner ? basename(inner) : basename(file)
  }
  if (/^[a-zA-Z]:\\?$/.test(p)) return p.slice(0, 2)
  return basename(p) || p
}

let tabSeq = 0
const newTabId = () => `t${Date.now().toString(36)}${++tabSeq}`

export interface Row extends Entry {
  /** revision grouping */
  rev?: string | null
  olderRevs?: number
  revUnknown?: boolean
}

export class Pane {
  tabs = $state<TabState[]>([])
  active = $state(0)
  view = $state<ViewMode>('details')
  sort = $state<{ key: ColumnSpec['id']; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  filter = $state('')

  entries = $state.raw<Entry[]>([])
  loading = $state(false)
  error = $state('')
  listMs = $state(0)
  /** selected keys (lower-case paths) */
  selection = $state.raw<Set<string>>(new Set())
  focus = $state(-1)
  anchor = -1
  renaming = $state<string | null>(null)
  /** search pane extras */
  searchInfo = $state<{ scanned: number; hits: number; done: boolean } | null>(null)
  private token = 0
  private searchToken = ''

  constructor(public app: App, public index: 0 | 1, init: PaneState) {
    this.tabs = init.tabs.length ? init.tabs : [{ id: newTabId(), path: VIRTUAL.home, history: [VIRTUAL.home], index: 0 }]
    this.active = Math.min(init.active, this.tabs.length - 1)
    this.view = init.view
    this.sort = init.sort
  }

  get tab() {
    return this.tabs[this.active]
  }
  get path() {
    return this.tab?.path ?? VIRTUAL.home
  }
  get canBack() {
    return this.tab.index > 0
  }
  get canForward() {
    return this.tab.index < this.tab.history.length - 1
  }
  get canUp() {
    const p = this.path
    if (networkHostOf(p) || shareRootHost(p)) return true
    if (isVirtual(p)) return false
    if (isArchivePath(p)) return true
    return dirname(p) !== p || /^[a-zA-Z]:\\?$/.test(p)
  }

  /** Sorted, filtered, hidden-aware rows (revision-grouped when enabled). */
  rows = $derived.by<Row[]>(() => {
    const s = this.app.settings
    const showHidden = s?.showHidden ?? false
    const showSystem = s?.showSystem ?? false
    const f = this.filter.trim().toLowerCase()
    let list: Row[] = this.entries.filter((e) => {
      if (!showHidden && (e.attrs & ATTR.hidden || (e.name.startsWith('.') && e.name !== '..'))) return false
      if (!showSystem && e.attrs & ATTR.system && e.attrs & ATTR.hidden) return false
      return true
    })
    if (f) {
      if (/[*?]/.test(f)) {
        const re = new RegExp('^' + f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
        list = list.filter((e) => re.test(e.name))
      } else {
        const words = f.split(/\s+/)
        list = list.filter((e) => {
          const n = e.name.toLowerCase()
          return words.every((w) => n.includes(w))
        })
      }
    }
    const rules = this.app.office?.revisions
    if (rules && (s?.groupRevisions || s?.columns.find((c) => c.id === 'rev')?.visible)) {
      const groups = groupRevisions(list.filter((e) => !e.dir).map((e) => ({ name: e.name, path: e.path, mtime: e.mtime })), rules)
      const info = new Map<string, { rev: string | null; hide: boolean; older: number; unknown: boolean }>()
      for (const g of groups) {
        for (const it of g.items) {
          const hide = !!s.groupRevisions && g.items.length > 1 && g.latest !== null && it.path !== g.latest
          info.set(it.path, { rev: it.rev, hide, older: it.path === g.latest ? g.items.length - 1 : 0, unknown: !g.orderKnown && g.items.length > 1 })
        }
      }
      list = list.flatMap((e) => {
        const i = info.get(e.path)
        if (!i) return [e]
        if (i.hide) return []
        return [{ ...e, rev: i.rev, olderRevs: s.groupRevisions ? i.older : 0, revUnknown: i.unknown }]
      })
    }
    const { key, dir } = this.sort
    const cmp = (a: Row, b: Row) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      let r = 0
      switch (key) {
        case 'size': r = a.size - b.size; break
        case 'mtime': r = a.mtime - b.mtime; break
        case 'ctime': r = a.ctime - b.ctime; break
        case 'type': r = collator.compare(kindOf(a.ext, a.dir) + a.ext, kindOf(b.ext, b.dir) + b.ext); break
        case 'attrs': r = a.attrs - b.attrs; break
        case 'rev': r = collator.compare(a.rev ?? '', b.rev ?? ''); break
      }
      return (r || collator.compare(a.name, b.name)) * dir
    }
    return list.slice().sort(cmp)
  })

  selected = $derived.by(() => {
    if (!this.selection.size) return [] as Row[]
    return this.rows.filter((r) => this.selection.has(r.path.toLowerCase()))
  })

  focused = $derived(this.focus >= 0 ? this.rows[this.focus] : undefined)

  /** What actions apply to: the selection, else the focused row. */
  targets() {
    const s = this.selected
    return s.length ? s : this.focused ? [this.focused] : []
  }

  state(): PaneState {
    return { tabs: $state.snapshot(this.tabs) as TabState[], active: this.active, view: this.view, sort: $state.snapshot(this.sort) as PaneState['sort'] }
  }

  // ---- navigation ---------------------------------------------------------

  async navigate(path: string, opts: { push?: boolean; select?: string; newTab?: boolean } = {}) {
    path = normalize(path)
    // \\server on its own is not a folder: show that computer's shares
    if (serverOnlyUnc(path)) path = networkHostPath(serverOnlyUnc(path)!)
    if (opts.newTab || this.tab.locked) {
      this.openTab(path)
      return this.load({ select: opts.select })
    }
    const t = this.tab
    if (opts.push !== false && t.path.toLowerCase() !== path.toLowerCase()) {
      t.history = [...t.history.slice(0, t.index + 1), path].slice(-60)
      t.index = t.history.length - 1
    }
    t.path = path
    await this.load({ select: opts.select })
  }

  back() {
    if (!this.canBack) return
    const prev = this.path
    this.tab.index--
    this.tab.path = this.tab.history[this.tab.index]
    void this.load({ select: prev })
  }

  forward() {
    if (!this.canForward) return
    this.tab.index++
    this.tab.path = this.tab.history[this.tab.index]
    void this.load()
  }

  up() {
    const p = this.path
    if (isArchivePath(p)) {
      const { file, inner } = splitArchive(p)
      const parent = inner.includes('/') ? `${file}::${inner.slice(0, inner.lastIndexOf('/'))}` : inner ? `${file}::` : dirname(file)
      return this.navigate(parent, { select: inner ? `${file}::${inner}` : file })
    }
    if (/^[a-zA-Z]:\\?$/.test(p)) return this.navigate(VIRTUAL.home)
    if (networkHostOf(p)) return this.navigate(VIRTUAL.network)
    if (shareRootHost(p)) return this.navigate(networkHostPath(shareRootHost(p)!), { select: p })
    const parent = dirname(p)
    if (parent !== p) void this.navigate(parent, { select: p })
  }

  jumpHistory(i: number) {
    if (i < 0 || i >= this.tab.history.length) return
    this.tab.index = i
    this.tab.path = this.tab.history[i]
    void this.load()
  }

  openTab(path: string, activate = true) {
    path = normalize(path)
    if (serverOnlyUnc(path)) path = networkHostPath(serverOnlyUnc(path)!)
    const t: TabState = { id: newTabId(), path, history: [path], index: 0 }
    this.tabs = [...this.tabs.slice(0, this.active + 1), t, ...this.tabs.slice(this.active + 1)]
    if (activate) this.active = this.active + 1
    this.app.persistSoon()
  }

  closeTab(i = this.active) {
    if (this.tabs[i]?.locked) return
    // The last tab can't be closed: a pane always shows something.
    if (this.tabs.length === 1) return
    this.app.closedTabs.push($state.snapshot(this.tabs[i]) as TabState)
    this.tabs = this.tabs.filter((_, k) => k !== i)
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1
    else if (i < this.active) this.active--
    void this.load()
  }

  switchTab(i: number) {
    if (i === this.active || !this.tabs[i]) return
    this.active = i
    void this.load()
  }

  moveTab(from: number, to: number) {
    const tabs = this.tabs.slice()
    const [t] = tabs.splice(from, 1)
    tabs.splice(to, 0, t)
    const activeId = this.tab.id
    this.tabs = tabs
    this.active = tabs.findIndex((x) => x.id === activeId)
  }

  // ---- loading --------------------------------------------------------------

  async load(opts: { keepSelection?: boolean; select?: string } = {}) {
    const token = ++this.token
    const path = this.path
    const prevSel = opts.keepSelection ? this.selection : null
    const prevFocusPath = opts.keepSelection ? this.focused?.path : undefined
    if (this.searchToken) {
      void engine.call('search.cancel', this.searchToken)
      this.searchToken = ''
    }
    this.loading = true
    this.error = ''
    if (!opts.keepSelection) {
      this.filter = ''
      this.searchInfo = null
    }
    try {
      let entries: Entry[]
      const t0 = performance.now()
      if (path === VIRTUAL.home || path === VIRTUAL.inbox || path === VIRTUAL.activity || path.startsWith(VIRTUAL.network)) entries = []
      else if (path === VIRTUAL.recycle) {
        const list = await window.hopper.shell.recycleList()
        entries = (list as any[]).map((r) => ({ name: basename(r.path), path: r.path, dir: false, size: r.size, mtime: r.deleted, ctime: r.deleted, atime: 0, attrs: 0, ext: (r.path.split('.').pop() ?? '').toLowerCase() }))
      } else if (path.startsWith(VIRTUAL.search)) {
        entries = []
        this.startSearch(path, token)
      } else if (isArchivePath(path)) {
        const { file, inner } = splitArchive(path)
        entries = await engine.call('archive.listDir', file, inner)
      } else {
        const r = await engine.call<{ entries: Entry[] }>('fs.list', path)
        entries = r.entries
      }
      if (token !== this.token) return
      this.listMs = Math.round(performance.now() - t0)
      this.entries = entries
      if (prevSel) {
        const keep = new Set<string>()
        const have = new Set(entries.map((e) => e.path.toLowerCase()))
        for (const k of prevSel) if (have.has(k)) keep.add(k)
        this.selection = keep
        this.focus = prevFocusPath ? this.rows.findIndex((r) => r.path === prevFocusPath) : -1
      } else {
        this.selection = new Set()
        this.focus = -1
        if (opts.select) {
          const i = this.rows.findIndex((r) => r.path.toLowerCase() === opts.select!.toLowerCase())
          if (i >= 0) {
            this.focus = i
            this.anchor = i
            this.selection = new Set([this.rows[i].path.toLowerCase()])
          }
        }
      }
    } catch (e: any) {
      if (token !== this.token) return
      this.entries = []
      this.error = String(e?.message ?? e).replace(/^Error:\s*/, '')
    } finally {
      if (token === this.token) this.loading = false
    }
    this.app.onPaneNavigated(this)
  }

  refresh() {
    return this.load({ keepSelection: true })
  }

  /** The folder a search typed in this pane should look in ('' = everywhere). */
  get searchRoot(): string {
    if (this.path.startsWith(VIRTUAL.search)) return new URLSearchParams(this.path.split('?')[1] ?? '').get('root') ?? ''
    return isVirtual(this.path) || isArchivePath(this.path) ? '' : this.path
  }

  private startSearch(path: string, token: number) {
    const params = new URLSearchParams(path.split('?')[1] ?? '')
    const q = params.get('q') ?? ''
    const root = params.get('root') ?? ''
    const content = params.get('content') ?? ''
    const st = `s${token}${Date.now().toString(36)}`
    this.searchToken = st
    this.searchInfo = { scanned: 0, hits: 0, done: false }
    const seen = new Set<string>()
    const push = (list: Entry[]) => {
      if (token !== this.token) return
      const add = list.filter((e) => !seen.has(e.path.toLowerCase()))
      for (const e of add) seen.add(e.path.toLowerCase())
      if (add.length) this.entries = this.entries.concat(add)
    }
    // Instant results from the index first (names only); the live walk then fills in the rest.
    if (!content) void engine.call<{ entries: Entry[] }>('index.query', q, { limit: 2000, under: root || undefined }).then((r) => push(r.entries))
    const off = engine.on('search-hit', (d: { token: string; entries: Entry[]; scanned: number; hits: number; done: boolean }) => {
      if (d.token !== st) return
      if (token !== this.token) return off()
      push(d.entries)
      this.searchInfo = { scanned: d.scanned, hits: Math.max(d.hits, seen.size), done: d.done }
      if (d.done) off()
    })
    const roots = root ? [root] : this.app.searchEverywhereRoots()
    void engine.call('search.run', st, { roots, name: q, content: content || undefined, limit: 20000 })
  }

  // ---- selection ------------------------------------------------------------

  setSelection(keys: Iterable<string>) {
    this.selection = new Set(keys)
  }

  selectIndex(i: number, mode: 'single' | 'toggle' | 'range' | 'rangeAdd' = 'single') {
    const rows = this.rows
    if (i < 0 || i >= rows.length) return
    const key = rows[i].path.toLowerCase()
    if (mode === 'single') {
      this.selection = new Set([key])
      this.anchor = i
    } else if (mode === 'toggle') {
      const s = new Set(this.selection)
      s.has(key) ? s.delete(key) : s.add(key)
      this.selection = s
      this.anchor = i
    } else {
      const a = this.anchor < 0 ? i : this.anchor
      const [lo, hi] = a < i ? [a, i] : [i, a]
      const s = mode === 'rangeAdd' ? new Set(this.selection) : new Set<string>()
      for (let k = lo; k <= hi; k++) s.add(rows[k].path.toLowerCase())
      this.selection = s
    }
    this.focus = i
  }

  selectAll() {
    this.selection = new Set(this.rows.map((r) => r.path.toLowerCase()))
  }

  invertSelection() {
    const s = new Set<string>()
    for (const r of this.rows) {
      const k = r.path.toLowerCase()
      if (!this.selection.has(k)) s.add(k)
    }
    this.selection = s
  }

  selectWhere(pred: (r: Row) => boolean) {
    this.selection = new Set(this.rows.filter(pred).map((r) => r.path.toLowerCase()))
  }

  clearSelection() {
    this.selection = new Set()
  }

  setSort(key: ColumnSpec['id']) {
    this.sort = this.sort.key === key ? { key, dir: (this.sort.dir * -1) as 1 | -1 } : { key, dir: key === 'mtime' || key === 'size' ? -1 : 1 }
    this.app.persistSoon()
  }
}

export function normalize(p: string) {
  p = p.trim().replace(/^"|"$/g, '').replace(/\//g, (m, i) => (p.includes('::') && i > p.indexOf('::') ? m : '\\'))
  if (/^[a-zA-Z]:$/.test(p)) return p.toUpperCase() + '\\'
  if (/^[a-zA-Z]:\\/.test(p)) p = p[0].toUpperCase() + p.slice(1)
  if (p.length > 3 && p.endsWith('\\') && !p.endsWith(':\\') && !/^\\\\[^\\]+\\[^\\]+\\$/.test(p)) p = p.slice(0, -1)
  return p
}
