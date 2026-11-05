// Drag and drop: files dragged inside Hopper use the OS drag (so they can also land in
// Explorer, Outlook or Cliq); archive entries use an internal payload.
import { app } from './app.svelte'
import { host } from './api'
import { isArchivePath, isVirtual } from './pane.svelte'
import { dirname } from './format'

export const HOPPER_MIME = 'application/x-hopper-paths'

export function startDrag(e: DragEvent, paths: string[]) {
  app.dragPaths = paths
  if (paths.some((p) => isArchivePath(p) || isVirtual(p))) {
    e.dataTransfer?.setData(HOPPER_MIME, JSON.stringify(paths))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
    return
  }
  e.preventDefault()
  host.drag.start(paths)
}

export function dropPaths(e: DragEvent): string[] {
  const dt = e.dataTransfer
  if (!dt) return []
  const internal = dt.getData(HOPPER_MIME)
  if (internal) {
    try {
      return JSON.parse(internal)
    } catch {
      return []
    }
  }
  const out: string[] = []
  for (const f of Array.from(dt.files)) {
    const p = host.pathForFile(f)
    if (p) out.push(p)
  }
  return out
}

const vol = (p: string) => (p.startsWith('\\\\') ? p.split('\\').slice(0, 4).join('\\').toLowerCase() : p.slice(0, 2).toLowerCase())

/** Explorer's rule: Shift = move, Ctrl = copy, otherwise move on the same drive, copy across drives. */
export function dropOp(e: DragEvent | { shiftKey: boolean; ctrlKey: boolean }, paths: string[], dest: string): 'copy' | 'move' {
  if (e.shiftKey) return 'move'
  if (e.ctrlKey) return 'copy'
  if (paths.some(isArchivePath)) return 'copy'
  return paths.every((p) => vol(p) === vol(dest)) ? 'move' : 'copy'
}

/** Dropping files back into the folder they came from does nothing. */
export const isNoopDrop = (paths: string[], dest: string) => paths.every((p) => dirname(p).toLowerCase() === dest.toLowerCase())

export function hasFiles(e: DragEvent) {
  const types = e.dataTransfer?.types ?? []
  return types.includes('Files') || types.includes(HOPPER_MIME)
}
