// Structured folder templates: declared inputs, conditions, repeats and automatic numbering.
// Pure code (no fs), shared by the engine (preview, create) and the renderer (Settings validation).
// Conditions are parsed by a tiny parser below; nothing is ever evaluated as JavaScript.
import type { FolderTemplate } from './types'

export type InputKind = 'text' | 'choice' | 'multi' | 'list' | 'flag' | 'subs' | 'date'

export interface TemplateInput {
  /** used as {id} in names (text, choice, date) and as an identifier in conditions */
  id: string
  label: string
  kind: InputKind
  /** choice and multi */
  options?: string[]
  /** choice: the token value per option; '' empties the token, dropping any <…> group around it */
  tokens?: Record<string, string>
  default?: unknown
  required?: boolean
  placeholder?: string
  hint?: string
  /** shown under "Options" in the dialog */
  advanced?: boolean
  /** show (and use) the input only when this condition holds */
  when?: string
  /** remember the last value per template (default: everything except text, subs and date) */
  remember?: boolean
  /** list: one item per line in a text box instead of a comma-separated line */
  multiline?: boolean
}

export interface SubProject {
  label: string
  /** optional unit / package code, e.g. ME-102 */
  unit?: string
  /** areas, skids or units of this sub-project: comma or line separated, "Skid-01..06" expands */
  areas?: string
}

export interface TemplateNode {
  /** folder name pattern: {tokens}; <…> is an optional group dropped when a token inside is empty */
  name?: string
  /** splice the nodes of a named block here */
  use?: string
  /** condition over the inputs (see `parseCond`) */
  when?: string
  /** repeat for every item: 'subs', 'areas' or the id of a list / multi input */
  each?: string
  /** prefix "N- " (default: numbered when the template numbers automatically, except repeated nodes) */
  number?: boolean
  /** with two or more sub-projects and outside a sub-project tree: one {sub} folder per sub-project, children inside each */
  split?: boolean
  children?: TemplateNode[]
}

export interface NumberingOptions {
  /** number every node unless it says number: false (default true) */
  auto?: boolean
  /** first number at every level (default 0) */
  start?: number
  /** 'none' (default) or '2' digits */
  pad?: 'none' | '2'
  /** between number and name (default '- ') */
  sep?: string
}

export type DateFormat = 'DD-Mon-YYYY' | 'DD-MM-YYYY' | 'YYYY-MM-DD'
export const DATE_FORMATS: DateFormat[] = ['DD-Mon-YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD']

export interface TemplateWarning {
  kind: 'long' | 'duplicate' | 'exists' | 'deep'
  message: string
  path?: string
}

export interface Expansion {
  /** the template's own root folder (relative to the destination), or null */
  top: string | null
  /** folders relative to the destination, parents first, no duplicates */
  folders: string[][]
  warnings: TemplateWarning[]
  /** problems that block creating (missing values, illegal names, bad template) */
  errors: string[]
}

export const isTree = (t: FolderTemplate) => Array.isArray(t.tree)
export const MAX_PATH_WARN = 240

// ---- names ------------------------------------------------------------------

const BAD = /[<>:"/\\|?*\u0000-\u001f]/

/** Why Windows would refuse this single folder name, or null. */
export function segmentProblem(s: string): string | null {
  if (!s || !s.trim()) return 'is empty'
  if (s === '.' || s === '..') return 'is not allowed'
  if (BAD.test(s)) return 'contains a character Windows does not allow in names (\\ / : * ? " < > |)'
  if (/[. ]$/.test(s)) return 'ends with a dot or space'
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) return 'is a reserved Windows name'
  return null
}

/** "a, b; c" or one per line; "Skid-01..06" expands to Skid-01 … Skid-06 (padding kept). */
export function splitList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\r\n,;]+/) : []
  const out: string[] = []
  for (const r of raw) {
    const s = r.trim().replace(/\s+/g, ' ')
    if (!s) continue
    const m = /^(.*?)(\d+)\s*\.\.\s*(\d+)$/.exec(s)
    if (m && Number(m[3]) >= Number(m[2]) && Number(m[3]) - Number(m[2]) <= 200) {
      const w = m[2].length > 1 && m[2].startsWith('0') ? Math.max(m[2].length, m[3].length) : 0
      for (let i = Number(m[2]); i <= Number(m[3]); i++) out.push(m[1] + String(i).padStart(w, '0'))
    } else out.push(s)
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function todayIso(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** YYYY-MM-DD in one of the office's date formats. */
export function formatDate(iso: string, fmt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new Error(`Date "${iso}" is not YYYY-MM-DD`)
  if (fmt === 'DD-MM-YYYY') return `${m[3]}-${m[2]}-${m[1]}`
  if (fmt === 'DD-Mon-YYYY') return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`
  return iso
}

// ---- conditions ---------------------------------------------------------------
// expr  := and ('or' and)*      and := unary ('and' unary)*      unary := 'not' unary | '(' expr ')' | cmp
// cmp   := ident [op value]     op := == != has in >= <= > <     value := 'text' | number | [ 'a', 'b' ]
// A bare ident is "set": a ticked flag, a non-empty text or list, a count above zero.

type Val = string | number | string[]
type Ast =
  | { t: 'or'; a: Ast; b: Ast }
  | { t: 'and'; a: Ast; b: Ast }
  | { t: 'not'; a: Ast }
  | { t: 'cmp'; id: string; op?: string; v?: Val }

const condCache = new Map<string, Ast>()

function tokenize(s: string): string[] {
  const out: string[] = []
  const re = /\s*(?:('(?:[^'])*'|"(?:[^"])*")|(==|!=|>=|<=|[<>()[\],])|([A-Za-z_$][\w$]*)|(\d+(?:\.\d+)?))/y
  let i = 0
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break
    re.lastIndex = i
    const m = re.exec(s)
    if (!m) throw new Error(`can't read "${s.slice(i).trim()}"`)
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4])
    i = re.lastIndex
  }
  return out
}

export function parseCond(src: string): Ast {
  const hit = condCache.get(src)
  if (hit) return hit
  const tk = tokenize(src)
  let i = 0
  const peek = () => tk[i]
  const next = () => tk[i++]
  const expect = (x: string) => {
    if (next() !== x) throw new Error(`expected "${x}"`)
  }
  const value = (): Val => {
    const x = next()
    if (x === undefined) throw new Error('a value is missing')
    if (x === '[') {
      const list: string[] = []
      while (peek() !== ']') {
        const v = value()
        if (Array.isArray(v)) throw new Error('lists cannot be nested')
        list.push(String(v))
        if (peek() === ',') next()
        else if (peek() !== ']') throw new Error('expected "," or "]"')
      }
      next()
      return list
    }
    if (/^['"]/.test(x)) return x.slice(1, -1)
    if (/^\d/.test(x)) return Number(x)
    throw new Error(`"${x}" is not a value (put text in quotes)`)
  }
  const cmp = (): Ast => {
    const id = next()
    if (!id || !/^[A-Za-z_$]/.test(id) || ['and', 'or', 'not', 'has', 'in'].includes(id)) throw new Error(`expected an input name, found "${id ?? 'the end'}"`)
    const op = peek()
    if (op && ['==', '!=', 'has', 'in', '>=', '<=', '>', '<'].includes(op)) {
      next()
      return { t: 'cmp', id, op, v: value() }
    }
    return { t: 'cmp', id }
  }
  const unary = (): Ast => {
    if (peek() === 'not') {
      next()
      return { t: 'not', a: unary() }
    }
    if (peek() === '(') {
      next()
      const e = or()
      expect(')')
      return e
    }
    return cmp()
  }
  const and = (): Ast => {
    let a = unary()
    while (peek() === 'and') {
      next()
      a = { t: 'and', a, b: unary() }
    }
    return a
  }
  const or = (): Ast => {
    let a = and()
    while (peek() === 'or') {
      next()
      a = { t: 'or', a, b: and() }
    }
    return a
  }
  const ast = or()
  if (i < tk.length) throw new Error(`unexpected "${tk[i]}"`)
  condCache.set(src, ast)
  return ast
}

/** identifiers a condition reads */
function condIds(a: Ast, out: Set<string>) {
  if (a.t === 'cmp') out.add(a.id)
  else if (a.t === 'not') condIds(a.a, out)
  else {
    condIds(a.a, out)
    condIds(a.b, out)
  }
  return out
}

type Lookup = (id: string) => unknown

const low = (x: unknown) => String(x).toLowerCase()

function evalAst(a: Ast, get: Lookup): boolean {
  if (a.t === 'or') return evalAst(a.a, get) || evalAst(a.b, get)
  if (a.t === 'and') return evalAst(a.a, get) && evalAst(a.b, get)
  if (a.t === 'not') return !evalAst(a.a, get)
  const x = get(a.id)
  if (!a.op) return Array.isArray(x) ? x.length > 0 : typeof x === 'number' ? x > 0 : !!x
  const v = a.v!
  const num = (y: unknown) => (Array.isArray(y) ? y.length : typeof y === 'number' ? y : Number(y))
  switch (a.op) {
    case '==':
    case '!=': {
      const eq = typeof v === 'number' ? num(x) === v : Array.isArray(x) ? x.some((y) => low(y) === low(v)) : low(x ?? '') === low(v)
      return a.op === '==' ? eq : !eq
    }
    case 'has':
      return Array.isArray(x) ? x.some((y) => low(y) === low(v)) : low(x ?? '') === low(v)
    case 'in':
      return (Array.isArray(v) ? v : [String(v)]).some((y) => (Array.isArray(x) ? x.some((z) => low(z) === low(y)) : low(x ?? '') === low(y)))
    case '>=':
      return num(x) >= Number(v)
    case '<=':
      return num(x) <= Number(v)
    case '>':
      return num(x) > Number(v)
    case '<':
      return num(x) < Number(v)
  }
  return false
}

export function evalCond(src: string | undefined, get: Lookup): boolean {
  if (!src || !src.trim()) return true
  return evalAst(parseCond(src), get)
}

// ---- inputs -----------------------------------------------------------------------

export interface NormalSub {
  label: string
  unit: string
  areas: string[]
}

export type Values = Record<string, unknown>

/** Simple templates declare no inputs: offer one for every token they use. */
export function inputsOf(t: FolderTemplate): TemplateInput[] {
  if (t.inputs) return t.inputs
  const used = new Set((t.folders ?? []).flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))
  const out: TemplateInput[] = []
  if (used.has('name')) out.push({ id: 'name', label: 'Name', kind: 'text', required: true })
  if (used.has('project')) out.push({ id: 'project', label: 'Project', kind: 'text', required: true })
  if (used.has('date')) out.push({ id: 'date', label: 'Date', kind: 'date' })
  return out
}

export function defaultValue(i: TemplateInput): unknown {
  const d = i.default
  switch (i.kind) {
    case 'flag':
      return d === true
    case 'multi':
    case 'list':
      return Array.isArray(d) ? [...d] : typeof d === 'string' ? splitList(d) : []
    case 'subs':
      return Array.isArray(d) ? structuredClone(d) : []
    case 'choice':
      return typeof d === 'string' ? d : (i.options?.[0] ?? '')
    case 'date':
      return typeof d === 'string' && d ? d : todayIso()
    default:
      return typeof d === 'string' ? d : ''
  }
}

/** Every declared input with a clean value: defaults filled in, wrong types fixed, lists split. */
export function normalize(t: FolderTemplate, raw: Values = {}): Values {
  const out: Values = {}
  for (const i of inputsOf(t)) {
    const v = raw[i.id] === undefined ? defaultValue(i) : raw[i.id]
    switch (i.kind) {
      case 'flag':
        out[i.id] = v === true || v === 'true'
        break
      case 'multi': {
        const list = Array.isArray(v) ? v.map(String) : splitList(v)
        out[i.id] = i.options ? i.options.filter((o) => list.some((x) => low(x) === low(o))) : list
        break
      }
      case 'list':
        out[i.id] = splitList(v)
        break
      case 'choice': {
        const s = String(v ?? '')
        out[i.id] = i.options?.find((o) => low(o) === low(s)) ?? defaultValue(i)
        break
      }
      case 'subs':
        out[i.id] = (Array.isArray(v) ? v : [])
          .map((s: any): NormalSub => ({
            label: String(s?.label ?? '').trim().replace(/\s+/g, ' '),
            unit: String(s?.unit ?? '').trim().replace(/\s+/g, ' '),
            areas: splitList(s?.areas ?? '')
          }))
          .filter((s) => s.label)
        break
      default:
        out[i.id] = String(v ?? '').trim().replace(/\s+/g, ' ')
    }
  }
  for (const k of ['$root', '$pad']) if (typeof raw[k] === 'string') out[k] = (raw[k] as string).trim()
  return out
}

/** Is this input shown / used with these values? */
export function inputActive(i: TemplateInput, values: Values): boolean {
  try {
    return evalCond(i.when, (id) => look(values, id))
  } catch {
    return true
  }
}

function look(values: Values, id: string): unknown {
  const v = values[id]
  return Array.isArray(v) && v.length && typeof v[0] === 'object' ? v.length : v
}

// ---- validation -----------------------------------------------------------------

const CONTEXT_TOKENS = ['sub', 'unit', 'label', 'area', 'item', 'date']

/** Problems in the template itself (not in the values). Empty when it is usable. */
export function validateTemplate(t: FolderTemplate): string[] {
  const errs: string[] = []
  if (!t || typeof t !== 'object') return ['The template is not an object']
  if (!t.id || !String(t.id).trim()) errs.push('The template needs an "id"')
  if (!t.name || !String(t.name).trim()) errs.push('The template needs a "name"')
  if (!isTree(t)) {
    if (!Array.isArray(t.folders)) errs.push('"folders" must be a list of folder paths')
    return errs
  }
  const inputs = Array.isArray(t.inputs) ? t.inputs : []
  if (t.inputs !== undefined && !Array.isArray(t.inputs)) errs.push('"inputs" must be a list')
  const ids = new Set<string>()
  const lists = new Set(['subs', 'areas'])
  const tokens = new Set(CONTEXT_TOKENS)
  for (const i of inputs) {
    if (!i?.id || !/^[A-Za-z_]\w*$/.test(i.id)) errs.push(`Input "${i?.id ?? '?'}" needs an id of letters, digits and _`)
    else if (ids.has(i.id)) errs.push(`Input id "${i.id}" is used twice`)
    ids.add(i?.id)
    if (!['text', 'choice', 'multi', 'list', 'flag', 'subs', 'date'].includes(i?.kind)) errs.push(`Input "${i?.id}" has an unknown kind "${i?.kind}"`)
    if ((i?.kind === 'choice' || i?.kind === 'multi') && !(Array.isArray(i.options) && i.options.length)) errs.push(`Input "${i.id}" needs "options"`)
    if (i?.kind === 'list' || i?.kind === 'multi' || i?.kind === 'subs') lists.add(i.id)
    if (i?.kind === 'text' || i?.kind === 'choice' || i?.kind === 'date') tokens.add(i.id)
  }
  const known = new Set([...ids, 'subs', 'areas', 'item', 'sub', 'area', 'unit'])
  const checkCond = (c: string | undefined, where: string) => {
    if (!c) return
    try {
      for (const id of condIds(parseCond(c), new Set())) if (!known.has(id)) errs.push(`${where}: condition "${c}" uses "${id}", which is not an input`)
    } catch (e: any) {
      errs.push(`${where}: condition "${c}": ${e.message}`)
    }
  }
  const checkName = (n: string, where: string) => {
    const bare = n.replace(/<|>/g, '').replace(/\{(\w+)\}/g, (_, k: string) => {
      if (!tokens.has(k)) errs.push(`${where}: "${n}" uses an unknown token {${k}}`)
      return 'x'
    })
    if (/[\\/]/.test(bare)) errs.push(`${where}: "${n}" must be a single folder name (no \\ or /)`)
    else if (/[:"|?*]/.test(bare)) errs.push(`${where}: "${n}" contains a character Windows does not allow in names`)
    if ((n.match(/</g) ?? []).length !== (n.match(/>/g) ?? []).length) errs.push(`${where}: "${n}" has an unclosed <…> group`)
  }
  for (const i of inputs) checkCond(i?.when, `Input "${i?.id}"`)
  const blocks = t.blocks ?? {}
  const walk = (nodes: unknown, where: string, stack: string[]) => {
    if (!Array.isArray(nodes)) return errs.push(`${where}: children must be a list`)
    for (const [k, n] of (nodes as TemplateNode[]).entries()) {
      const w = `${where} › ${n?.name ?? n?.use ?? `#${k + 1}`}`
      if (!n || typeof n !== 'object') {
        errs.push(`${w}: not a folder`)
        continue
      }
      checkCond(n.when, w)
      if (n.use !== undefined) {
        if (!blocks[n.use]) errs.push(`${w}: block "${n.use}" does not exist`)
        else if (stack.includes(n.use)) errs.push(`${w}: block "${n.use}" uses itself`)
        else walk(blocks[n.use], `${where} › [${n.use}]`, [...stack, n.use])
        continue
      }
      if (typeof n.name !== 'string' || !n.name.trim()) errs.push(`${w}: needs a "name"`)
      else checkName(n.name, w)
      if (n.each !== undefined && !lists.has(n.each)) errs.push(`${w}: "each" must be subs, areas or a list input, not "${n.each}"`)
      if (n.children !== undefined) walk(n.children, w, stack)
    }
  }
  if (t.root !== undefined) {
    if (typeof t.root !== 'string' || !t.root.trim()) errs.push('"root" must be a folder name pattern')
    else checkName(t.root, 'Root')
  }
  if (t.subLabel !== undefined) checkName(t.subLabel, 'Sub-project label')
  walk(t.tree, 'Tree', [])
  const pad = t.numbering?.pad
  if (pad !== undefined && pad !== 'none' && pad !== '2') errs.push('"numbering.pad" must be "none" or "2"')
  return [...new Set(errs)]
}

// ---- expansion ----------------------------------------------------------------------

interface Ctx {
  sub?: NormalSub
  item?: string
  area?: string
}

/**
 * The folders a structured template makes for these values. `destLength` (characters of the
 * destination path) enables the long-path warning.
 */
export function expandTree(t: FolderTemplate, raw: Values = {}, destLength = 0): Expansion {
  const errors: string[] = []
  const warnings: TemplateWarning[] = []
  const folders: string[][] = []
  const res: Expansion = { top: null, folders, warnings, errors }
  const bad = validateTemplate(t)
  if (bad.length) {
    errors.push(...bad)
    return res
  }
  const v = normalize(t, raw)
  const inputs = inputsOf(t)
  const byId = new Map(inputs.map((i) => [i.id, i]))
  const subs = (inputs.find((i) => i.kind === 'subs') ? (v[inputs.find((i) => i.kind === 'subs')!.id] as NormalSub[]) : []) ?? []
  const subsId = inputs.find((i) => i.kind === 'subs')?.id ?? 'subs'
  const fmt = typeof v.dateFormat === 'string' && v.dateFormat ? v.dateFormat : 'YYYY-MM-DD'
  const num = t.numbering ?? {}
  const auto = num.auto !== false
  const start = Number.isInteger(num.start) ? num.start! : 0
  const pad = (v.$pad === 'none' || v.$pad === '2' ? v.$pad : num.pad) === '2' ? 2 : 0
  const sep = typeof num.sep === 'string' ? num.sep : '- '
  const subLabel = t.subLabel ?? '{label}< ({unit})>'
  const blocks = t.blocks ?? {}

  // required inputs (only those in use)
  for (const i of inputs) {
    if (!i.required || !inputActive(i, v)) continue
    const x = v[i.id]
    if (Array.isArray(x) ? !x.length : !x) errors.push(`Fill in ${i.label}`)
  }

  const areasOf = (c: Ctx) => c.sub?.areas ?? (subs.length === 1 ? subs[0].areas : splitList(v.areas))
  const get = (c: Ctx) => (id: string): unknown => {
    if (id === subsId) return subs.length
    if (id === 'areas') return areasOf(c)
    if (id === 'item') return c.item ?? ''
    if (id === 'area') return c.area ?? ''
    if (id === 'sub') return c.sub?.label ?? ''
    if (id === 'unit') return c.sub?.unit ?? ''
    const i = byId.get(id)
    if (i && !inputActive(i, v)) return i.kind === 'multi' || i.kind === 'list' ? [] : i.kind === 'flag' ? false : ''
    return v[id]
  }

  const tokenValue = (k: string, c: Ctx): string => {
    if (k === 'label') return c.sub?.label ?? ''
    if (k === 'unit') return c.sub?.unit ?? ''
    if (k === 'sub') return c.sub ? render(subLabel, c, 'Sub-project label') : ''
    if (k === 'area') return c.area ?? ''
    if (k === 'item') return c.item ?? ''
    const i = byId.get(k)
    if (k === 'date' && (!i || i.kind === 'date')) return formatDate(String(v.date || todayIso()), fmt)
    if (!i) return ''
    if (i.kind === 'date') return formatDate(String(v[k]), fmt)
    const s = String(v[k] ?? '')
    if (i.kind === 'choice' && i.tokens && s in i.tokens) return i.tokens[s]
    return s
  }

  const tokenProblem = new Set<string>()
  function render(pattern: string, c: Ctx, where: string): string {
    const fill = (s: string, optional: boolean): string | null => {
      let empty = false
      const r = s.replace(/\{(\w+)\}/g, (_, k: string) => {
        const val = tokenValue(k, c)
        if (!val) {
          empty = true
          if (!optional) {
            const i = byId.get(k)
            const msg = i ? `Fill in ${i.label}` : `{${k}} has no value in "${where}"`
            if (!tokenProblem.has(msg)) errors.push(msg)
            tokenProblem.add(msg)
          }
          return ''
        }
        if (/[<>:"/\\|?*\u0000-\u001f]/.test(val)) {
          const i = byId.get(k)
          const msg = `${i?.label ?? `{${k}}`} "${val}" contains a character Windows does not allow in names`
          if (!tokenProblem.has(msg)) errors.push(msg)
          tokenProblem.add(msg)
        }
        return val
      })
      return optional && empty ? null : r
    }
    const out = pattern.replace(/<([^<>]*)>/g, (_, inner: string) => fill(inner, true) ?? '')
    return (fill(out, false) ?? '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  }

  type Item = { node: TemplateNode; c: Ctx }
  const flatten = (nodes: TemplateNode[], c: Ctx, out: Item[], depth = 0) => {
    if (depth > 20) return
    for (const n of nodes) {
      if (n.use !== undefined) {
        if (evalCond(n.when, get(c))) flatten(blocks[n.use] ?? [], c, out, depth + 1)
        continue
      }
      if (n.each) {
        const list = n.each === subsId ? subs : n.each === 'areas' ? areasOf(c) : (get(c)(n.each) as string[]) ?? []
        for (const x of list as (string | NormalSub)[]) {
          const c2: Ctx = typeof x === 'string' ? { ...c, item: x, ...(n.each === 'areas' ? { area: x } : {}) } : { ...c, sub: x, item: x.label }
          if (evalCond(n.when, get(c2))) out.push({ node: n, c: c2 })
        }
        continue
      }
      if (evalCond(n.when, get(c))) out.push({ node: n, c })
    }
  }

  const seen = new Map<string, string>()
  const add = (path: string[], where: string) => {
    const key = path.join('\\').toLowerCase()
    if (seen.has(key)) {
      if (where !== 'split') warnings.push({ kind: 'duplicate', message: `"${path.at(-1)}" appears twice in ${path.slice(0, -1).join('\\') || 'the destination'}; made once`, path: path.join('\\') })
      return false
    }
    seen.set(key, path.join('\\'))
    folders.push(path)
    return true
  }

  const emit = (nodes: TemplateNode[], c: Ctx, parent: string[]) => {
    const items: Item[] = []
    flatten(nodes, c, items)
    let n = start
    for (const { node, c: ic } of items) {
      let name = render(node.name ?? '', ic, node.name ?? '')
      if (!name) continue
      const numbered = node.number ?? (auto && !node.each)
      if (numbered) name = `${String(n++).padStart(pad, '0')}${sep}${name}`
      const why = segmentProblem(name)
      if (why) {
        errors.push(`Folder "${name}" ${why}`)
        continue
      }
      const path = [...parent, name]
      add(path, 'node')
      const kids = node.children ?? []
      if (node.split && subs.length >= 2 && !ic.sub) {
        for (const s of subs) {
          const sc: Ctx = { ...ic, sub: s }
          const label = render(subLabel, sc, 'Sub-project label')
          const why2 = segmentProblem(label)
          if (why2) {
            errors.push(`Sub-project "${label}" ${why2}`)
            continue
          }
          const sp = [...path, label]
          if (!add(sp, 'node')) continue
          emit(kids, sc, sp)
        }
      } else emit(kids, ic, path)
    }
  }

  let base: string[] = []
  if (t.root) {
    const before = errors.length
    const r = typeof v.$root === 'string' && v.$root ? v.$root : render(t.root, {}, 'Root')
    const why = r ? segmentProblem(r) : 'is empty'
    if (why && errors.length === before) errors.push(`Folder name "${r}" ${why}`)
    // still show the tree under a stand-in name while values are missing (creating is blocked)
    const name = why || errors.length > before ? t.root.replace(/[<>]/g, '') : r
    if (!why && errors.length === before) res.top = r
    base = [name]
    folders.push(base)
    seen.set(name.toLowerCase(), name)
  }
  try {
    emit(t.tree ?? [], {}, base)
  } catch (e: any) {
    errors.push(String(e?.message ?? e))
  }

  if (destLength > 0) {
    const long = folders.filter((p) => destLength + 1 + p.join('\\').length > MAX_PATH_WARN)
    if (long.length) {
      const worst = long.reduce((a, b) => (b.join('\\').length > a.join('\\').length ? b : a))
      warnings.push({
        kind: 'long',
        message: `${long.length} folder path${long.length === 1 ? '' : 's'} would be longer than ${MAX_PATH_WARN} characters here (longest ${destLength + 1 + worst.join('\\').length}); files inside them may not open in older tools`,
        path: worst.join('\\')
      })
    }
  }
  res.errors = [...new Set(errors)]
  return res
}

/** Value to store for "remember last inputs": only the inputs that are worth reusing. */
export function rememberable(t: FolderTemplate, values: Values): Values {
  const out: Values = {}
  for (const i of inputsOf(t)) {
    const keep = i.remember ?? !['text', 'subs', 'date'].includes(i.kind)
    if (keep && values[i.id] !== undefined) out[i.id] = values[i.id]
  }
  if (values.$pad) out.$pad = values.$pad
  return out
}
