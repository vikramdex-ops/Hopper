// Revision tokens: parse, compare and group file names by revision.
// Pure (no Node, no runtime imports) so the renderer and node:test can load it directly.
// Rules come from OfficeConfig.revisions; when they cannot decide, the answer is "unknown".
import type { RevisionRules } from './types'

export interface ParsedRevision {
  /** name without extension and without the revision token */
  base: string
  /** the token exactly as written in the name, or null */
  rev: string | null
  /** lower-case extension without the dot, '' when none */
  ext: string
}

export interface RevisionEntry {
  name: string
  path: string
  mtime: number
}

export interface RevisionItem extends RevisionEntry {
  rev: string
}

export interface RevisionGroup {
  base: string
  ext: string
  /** sorted earliest first when the order is known, otherwise in input order */
  items: RevisionItem[]
  /** null when the order is unknown or the latest revision exists twice */
  latest: string | null
  orderKnown: boolean
  /** gaps or duplicates, reported only when the rules can determine them */
  outOfSequence: string[]
}

export function splitExt(fileName: string) {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return { stem: fileName, ext: '' }
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot + 1).toLowerCase() }
}

const cache = new Map<string, RegExp | null>()
function compile(pattern: string) {
  if (!cache.has(pattern)) {
    let re: RegExp | null = null
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      re = null // an invalid pattern in the office config is skipped, not fatal
    }
    cache.set(pattern, re)
  }
  return cache.get(pattern)!
}

export function parseRevision(fileName: string, rules: RevisionRules): ParsedRevision {
  const { stem, ext } = splitExt(fileName)
  for (const p of rules.patterns ?? []) {
    const re = compile(p)
    const m = re?.exec(stem)
    const rev = m?.groups?.rev
    if (!m || !rev) continue
    const base = m.groups?.base ?? (stem.slice(0, m.index) + stem.slice(m.index + m[0].length))
    return { base: base.trim() || stem, rev, ext }
  }
  return { base: stem, rev: null, ext }
}

const norm = (r: string) => r.trim().toUpperCase()
const isNum = (r: string) => /^[0-9]+$/.test(r)
const isAlpha = (r: string) => /^[A-Z]+$/i.test(r)

/** <0 when a is earlier, >0 when later, 0 when the same revision, null when the rules cannot tell. */
export function compareRevs(a: string, b: string, rules: RevisionRules): number | null {
  const A = norm(a)
  const B = norm(b)
  const order = (rules.order ?? []).map(norm)
  if (order.length) {
    const ia = order.indexOf(A)
    const ib = order.indexOf(B)
    if (ia < 0 || ib < 0) return null
    return ia - ib
  }
  if (isNum(A) && isNum(B)) return Number(A) - Number(B)
  if (isAlpha(A) && isAlpha(B)) return A.length !== B.length ? A.length - B.length : A < B ? -1 : A > B ? 1 : 0
  // Mixed classes (e.g. A,B for review then 0,1 for construction) depend on the office convention.
  return null
}

/** Compress consecutive missing tokens: ['C','D','E'] -> 'missing C to E'. */
function missingRuns(tokens: string[], present: boolean[]) {
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    if (present[i]) {
      i++
      continue
    }
    let j = i
    while (j + 1 < tokens.length && !present[j + 1]) j++
    out.push(j > i ? `missing ${tokens[i]} to ${tokens[j]}` : `missing ${tokens[i]}`)
    i = j + 1
  }
  return out
}

function gaps(items: RevisionItem[], rules: RevisionRules): string[] {
  const order = (rules.order ?? []).map(norm)
  const revs = items.map((i) => norm(i.rev))
  if (order.length) {
    const idx = revs.map((r) => order.indexOf(r))
    const lo = Math.min(...idx)
    const hi = Math.max(...idx)
    const span = order.slice(lo, hi + 1)
    return missingRuns(span, span.map((t) => revs.includes(t)))
  }
  // Without an order list only plain numbers have a determinable sequence. Letters do not:
  // many offices skip I, O, Q, S, X, Z, so a "missing I" would be a guess.
  if (revs.every(isNum)) {
    const nums = revs.map(Number)
    const lo = Math.min(...nums)
    const hi = Math.max(...nums)
    if (hi - lo > 1000) return []
    const width = new Set(revs.map((r) => r.length)).size === 1 && revs[0].length > 1 ? revs[0].length : 0
    const span: string[] = []
    for (let n = lo; n <= hi; n++) span.push(width ? String(n).padStart(width, '0') : String(n))
    return missingRuns(span, span.map((_, k) => nums.includes(lo + k)))
  }
  return []
}

/** Groups of files that carry a revision token. Files without one are standalone and not returned. */
export function groupRevisions(entries: RevisionEntry[], rules: RevisionRules): RevisionGroup[] {
  const map = new Map<string, { base: string; ext: string; items: RevisionItem[] }>()
  for (const e of entries) {
    const p = parseRevision(e.name, rules)
    if (p.rev === null) continue
    const key = `${p.base.toLowerCase()}\u0000${p.ext}`
    let g = map.get(key)
    if (!g) map.set(key, (g = { base: p.base, ext: p.ext, items: [] }))
    g.items.push({ ...e, rev: p.rev })
  }

  const groups: RevisionGroup[] = []
  for (const g of map.values()) {
    const first = g.items[0]
    const orderKnown = g.items.every((i) => compareRevs(i.rev, first.rev, rules) !== null)
    const outOfSequence: string[] = []

    // Duplicates are determinable whenever two tokens are equal, even if the order is not.
    const seen = new Map<string, string[]>()
    for (const i of g.items) {
      const k = norm(i.rev)
      seen.set(k, [...(seen.get(k) ?? []), i.name])
    }
    for (const [k, names] of seen) if (names.length > 1) outOfSequence.push(`duplicate ${k} (${names.join(', ')})`)

    let items = g.items
    let latest: string | null = null
    if (orderKnown) {
      items = [...g.items].sort((a, b) => compareRevs(a.rev, b.rev, rules)!)
      // numerically equal but differently written tokens, e.g. "01" and "1"
      for (let k = 1; k < items.length; k++) {
        const a = items[k - 1]
        const b = items[k]
        if (compareRevs(a.rev, b.rev, rules) === 0 && norm(a.rev) !== norm(b.rev)) {
          outOfSequence.push(`duplicate ${a.rev}/${b.rev} (${a.name}, ${b.name})`)
        }
      }
      const top = items[items.length - 1]
      const tied = items.filter((i) => compareRevs(i.rev, top.rev, rules) === 0)
      latest = tied.length === 1 ? top.path : null
      outOfSequence.push(...gaps(items, rules))
    }
    groups.push({ base: g.base, ext: g.ext, items, latest, orderKnown, outOfSequence })
  }
  return groups
}
