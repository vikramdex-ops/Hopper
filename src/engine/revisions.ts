// Revision timeline: every revision of one drawing in a folder tree. A bounded walk (at most
// MAX_FILES files and MAX_MS, cancelable); matching and ordering are in shared/revisions.ts.
import { defaultOffice } from '@shared/defaults'
import { drawingKey, parseRevision, revisionTimeline } from '@shared/revisions'
import type { Entry } from '@shared/types'
import type { EngineCtx } from './index'
import { walk } from './fsops'

const MAX_FILES = 20_000
const MAX_MS = 15_000

export interface RevisionFind {
  items: (Entry & { rev: string })[]
  orderKnown: boolean
  /** files looked at */
  scanned: number
  /** why the walk ended early, null when it finished */
  stopped: 'files' | 'time' | 'cancelled' | null
  /** folders that could not be read */
  errors: number
}

export function revisionHandlers(ctx: EngineCtx) {
  const running = new Map<string, AbortController>()
  return {
    /** All revisions of `file`'s drawing under `roots` (each walked whole, subfolders included). */
    'revisions.find': async (token: string, file: string, roots: string[]): Promise<RevisionFind> => {
      const rules = ctx.office?.revisions ?? defaultOffice().revisions
      const name = file.split('\\').pop() ?? file
      const key = drawingKey(name, rules)
      if (key === null) return { items: [], orderKnown: false, scanned: 0, stopped: null, errors: 0 }
      const ac = new AbortController()
      running.set(token, ac)
      let stopped: RevisionFind['stopped'] = null
      const timer = setTimeout(() => {
        stopped ??= 'time'
        ac.abort()
      }, MAX_MS)
      let scanned = 0
      let errors = 0
      const found: Entry[] = []
      try {
        for (const root of Array.isArray(roots) ? roots : []) {
          if (ac.signal.aborted) break
          await walk(
            ctx,
            root,
            (e) => {
              if (e.dir) return
              if (++scanned > MAX_FILES) {
                stopped ??= 'files'
                ac.abort()
                return false
              }
              const p = parseRevision(e.name, rules)
              if (p.rev !== null && p.base.trim().toLowerCase() === key) found.push(e)
            },
            { signal: ac.signal, concurrency: 6, onError: () => void errors++ }
          )
        }
      } finally {
        clearTimeout(timer)
        running.delete(token)
      }
      if (ac.signal.aborted) stopped ??= 'cancelled'
      const t = revisionTimeline(name, found, rules)
      return { items: t.items, orderKnown: t.orderKnown, scanned: Math.min(scanned, MAX_FILES), stopped, errors }
    },
    'revisions.cancel': (token: string) => {
      const ac = running.get(token)
      if (!ac) return false
      ac.abort()
      return true
    }
  }
}
