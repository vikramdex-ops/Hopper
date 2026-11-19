// Shared status labels and notes: a colour label (Checked, Sent to client, …) and a short note on
// any file or folder, seen by the whole office. Stored next to office.json in a "labels" folder,
// never inside project folders, one JSON file ("shard") per server share:
//   labels\<server>-<share>.json  = { v: 1, items: { "<key>": { label, note, by, byName, at } } }
// Keys are folderKey() paths: lower case, mapped drives spelled as UNC. Each item is replaced as a
// whole by the newest writer (merge on conflict keeps the newest `at` per key); a cleared item stays
// as a tombstone for a while so a stale copy cannot bring it back.
// Pure (no Node, no DOM) so the renderer, the engine and node:test share it.

export interface LabelDef {
  /** stable id used in the store and in label:<id> */
  id: string
  name: string
  /** #rrggbb */
  color: string
}

export interface LabelItem {
  /** label id; '' or absent = none */
  label?: string
  note?: string
  /** Windows account, lower case */
  by: string
  byName?: string
  /** ms */
  at: number
}

export interface LabelShard {
  v: 1
  items: Record<string, LabelItem>
}

export const DEFAULT_LABELS: LabelDef[] = [
  { id: 'checked', name: 'Checked', color: '#2e9d5b' },
  { id: 'sent', name: 'Sent to client', color: '#2f7ed8' },
  { id: 'hold', name: 'Hold', color: '#d9822b' },
  { id: 'revise', name: 'Revise', color: '#d64545' },
  { id: 'final', name: 'Final', color: '#8a56c9' }
]

export const MAX_NOTE = 500
export const MAX_LABELS = 12
export const TOMBSTONE_MS = 30 * 86400_000

/** The office's labels (office.json "labels"), validated; the defaults when there are none. */
export function cleanLabelDefs(raw: unknown): LabelDef[] {
  if (!Array.isArray(raw)) return DEFAULT_LABELS
  const out: LabelDef[] = []
  for (const d of raw) {
    const id = String(d?.id ?? '').trim().toLowerCase()
    const name = String(d?.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32)
    const color = String(d?.color ?? '').trim().toLowerCase()
    if (!/^[a-z0-9-]{1,24}$/.test(id) || !name || !/^#[0-9a-f]{6}$/.test(color) || out.some((x) => x.id === id)) continue
    out.push({ id, name, color })
    if (out.length >= MAX_LABELS) break
  }
  return out.length ? out : DEFAULT_LABELS
}

/** A label typed by a person (label:checked, label:"sent to client", label:sent-to-client). */
export function findLabel(defs: readonly LabelDef[], token: string): LabelDef | null {
  const t = token.toLowerCase().replace(/[\s_-]+/g, '')
  if (!t) return null
  return defs.find((d) => d.id.replace(/-/g, '') === t) ?? defs.find((d) => d.name.toLowerCase().replace(/[\s_-]+/g, '') === t) ?? null
}

/** A live item has a label or a note; a cleared one is a tombstone. */
export const isLive = (i: LabelItem | undefined): boolean => !!i && (!!i.label || !!i.note)

/** The shard file a key belongs to: one per \\server\share, one per local drive. */
export function shardOf(key: string): string {
  const k = key.toLowerCase()
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(k)
  const raw = unc ? `${unc[1]}-${unc[2]}` : /^([a-z]):/.test(k) ? `local-${k[0]}` : 'other'
  return raw.replace(/[^a-z0-9.-]+/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'other'
}

/** Validate a shard read from disk (anything malformed is dropped, never thrown). */
export function cleanShard(raw: any): LabelShard {
  const out: LabelShard = { v: 1, items: {} }
  const items = raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object' ? raw.items : {}
  for (const [k, i] of Object.entries<any>(items)) {
    if (typeof k !== 'string' || k.length > 2048 || !i || typeof i !== 'object') continue
    const at = Number(i.at)
    if (!Number.isFinite(at) || at <= 0) continue
    const item: LabelItem = { by: String(i.by ?? '').slice(0, 64), at }
    if (typeof i.label === 'string' && /^[a-z0-9-]{0,24}$/.test(i.label)) item.label = i.label
    if (typeof i.note === 'string') item.note = i.note.slice(0, MAX_NOTE)
    if (typeof i.byName === 'string' && i.byName) item.byName = i.byName.slice(0, 80)
    out.items[k.toLowerCase()] = item
  }
  return out
}

/** Merge two copies of a shard: per key the newest `at` wins (ties keep `a`). */
export function mergeShards(a: LabelShard, b: LabelShard): LabelShard {
  const items: Record<string, LabelItem> = { ...a.items }
  for (const [k, i] of Object.entries(b.items)) {
    const mine = items[k]
    if (!mine || i.at > mine.at) items[k] = i
  }
  return { v: 1, items }
}

/** Drop tombstones older than `ttl`. */
export function prune(s: LabelShard, now: number, ttl = TOMBSTONE_MS): LabelShard {
  const items: Record<string, LabelItem> = {}
  for (const [k, i] of Object.entries(s.items)) if (isLive(i) || now - i.at < ttl) items[k] = i
  return { v: 1, items }
}

/** Set a label and/or a note on one key (null clears that part); returns the new item. */
export function applyPatch(prev: LabelItem | undefined, patch: { label?: string | null; note?: string | null }, by: string, byName: string, at: number): LabelItem {
  const label = patch.label === undefined ? prev?.label ?? '' : patch.label ?? ''
  const note = patch.note === undefined ? prev?.note ?? '' : (patch.note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_NOTE)
  return { label, note, by, ...(byName ? { byName } : {}), at }
}

/**
 * Labels follow a rename or a move: every key equal to `from` or under it moves to the same place
 * under `to`. Returns the items to write at their new keys and the old keys to clear.
 */
export function movedItems(items: Readonly<Record<string, LabelItem>>, from: string, to: string, at: number): { put: Record<string, LabelItem>; clear: string[] } {
  const f = from.toLowerCase()
  const t = to.toLowerCase()
  const put: Record<string, LabelItem> = {}
  const clear: string[] = []
  if (f === t) return { put, clear }
  for (const [k, i] of Object.entries(items)) {
    if (!isLive(i)) continue
    if (k !== f && !k.startsWith(f + '\\')) continue
    put[t + k.slice(f.length)] = { ...i, at }
    clear.push(k)
  }
  return { put, clear }
}
