// Dialog openers. Each dialog is a lazily loaded chunk, so startup only parses what it shows.
import type { Component } from 'svelte'
import { app } from '../../lib/app.svelte'

const mods = import.meta.glob<{ default: Component<any> }>('./*Dialog.svelte')

function lazy(file: string, toProps: (...args: any[]) => Record<string, unknown> = () => ({})) {
  return async (...args: any[]) => {
    const load = mods[`./${file}.svelte`]
    if (!load) {
      app.toast('warning', `${file.replace(/Dialog$/, '')} isn't available in this build`)
      return
    }
    const C = (await load()).default
    return app.dialog(C, toProps(...args))
  }
}

export function registerDialogs(d: Record<string, (...args: any[]) => unknown>) {
  Object.assign(d, {
    share: lazy('ShareDialog', (to?: string[], paths?: string[]) => ({ to: to ?? [], paths })),
    copyTo: lazy('CopyToDialog', (op: 'copy' | 'move' = 'copy') => ({ op })),
    zip: lazy('ZipDialog'),
    massRename: lazy('MassRenameDialog', (targets) => ({ targets: targets ?? app.active.targets() })),
    settings: lazy('SettingsDialog', (section?: string) => ({ section })),
    shortcuts: lazy('ShortcutsDialog'),
    folderSize: lazy('FolderSizeDialog'),
    checksum: lazy('ChecksumDialog'),
    selectPattern: lazy('SelectPatternDialog'),
    template: lazy('TemplateDialog'),
    packager: lazy('PackagerDialog', (paths?: string[]) => ({ paths: paths ?? app.active.targets().map((e) => e.path) })),
    pdf: lazy('PdfDialog', (mode?: string) => ({ mode, paths: app.active.targets().filter((e) => e.ext === 'pdf').map((e) => e.path) })),
    dupes: lazy('DupesDialog'),
    compare: lazy('CompareDialog'),
    workspaces: lazy('WorkspacesDialog'),
    undoHistory: lazy('UndoHistoryDialog'),
    people: lazy('PeopleDialog')
  })
}
