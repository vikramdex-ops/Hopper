// State of the full-window document viewer (PDF, spreadsheets, Word, drawings).
// Kept apart from the app store so the viewers stay self-contained.
import type { Entry } from '@shared/types'
import type { RichMode } from './filetypes'

/** `mode` is set when the content, not the extension, decided the viewer. */
export const docViewer = $state<{ entry: Entry | null; mode: RichMode | null }>({ entry: null, mode: null })

export function openDocViewer(entry: Entry, mode: RichMode | null = null) {
  docViewer.mode = mode
  docViewer.entry = entry
}

export function closeDocViewer() {
  docViewer.entry = null
}
