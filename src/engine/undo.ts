// Undo journal: every reversible operation records what to put back. Persisted so
// "undo" survives a restart; recycled items are restored from the Recycle Bin.
import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UndoRecord } from '@shared/types'
import type { EngineCtx } from './index'
import { moveOne, removeTree } from './fsutil'

const MAX = 200

export class Undo {
  private file: string
  private items: UndoRecord[] = []
  private saveTimer?: NodeJS.Timeout
  private seq = 0

  constructor(dataDir: string, private emit: (e: string, d: unknown) => void) {
    this.file = join(dataDir, 'undo.json')
    try {
      this.items = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      this.items = []
    }
  }

  list() {
    return this.items.slice().reverse()
  }

  record(r: Omit<UndoRecord, 'id' | 'at'>) {
    if (!r.pairs.length) return
    const rec: UndoRecord = { ...r, id: `u${Date.now().toString(36)}${++this.seq}`, at: Date.now() }
    this.items.push(rec)
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX)
    this.changed()
    return rec.id
  }

  private changed() {
    this.emit('undo', this.list().slice(0, 30))
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void fsp.mkdir(dirname(this.file), { recursive: true }).then(() => fsp.writeFile(this.file, JSON.stringify(this.items)))
    }, 500)
  }

  /** Undo the most recent (or a specific) record. Returns a short report. */
  async undo(ctx: EngineCtx, id?: string) {
    const rec = id ? this.items.find((r) => r.id === id) : [...this.items].reverse().find((r) => !r.undone)
    if (!rec || rec.undone) throw new Error('Nothing to undo')
    const failed: string[] = []
    let ok = 0
    switch (rec.kind) {
      case 'copy':
      case 'new':
        // Remove what the operation created (copies go to the Recycle Bin via the UI is safer,
        // but created items are ours, so removing them restores the previous state).
        for (const [, created] of rec.pairs) {
          try {
            await removeTree(created)
            ok++
          } catch {
            failed.push(created)
          }
        }
        break
      case 'move':
      case 'rename':
        for (const [from, to] of [...rec.pairs].reverse()) {
          try {
            if (existsSync(from)) throw new Error('exists')
            await fsp.mkdir(dirname(from), { recursive: true })
            await moveOne(to, from)
            ok++
          } catch {
            failed.push(to)
          }
        }
        break
      case 'recycle': {
        const r = await ctx.shell.call<{ restored: string[]; failed: string[] }>('recycleRestore', { paths: rec.pairs.map((p) => p[0]) }, 120000)
        ok = r.restored.length
        failed.push(...r.failed)
        break
      }
    }
    rec.undone = true
    this.changed()
    return { label: rec.label, ok, failed }
  }
}

export function undoHandlers(ctx: EngineCtx) {
  return {
    'undo.list': () => ctx.undo.list(),
    'undo.undo': (id?: string) => ctx.undo.undo(ctx, id),
    'undo.record': (r: Omit<UndoRecord, 'id' | 'at'>) => ctx.undo.record(r)
  }
}
