// Engine utility process: file system, transfer queue, archives, search index, office tools.
// The renderer gets a MessagePort straight to this process (see main/ctx.ts connectPorts).
import { trace } from '@shared/trace'
trace('engine module start')
import { serve, type Handlers } from '@shared/rpc'
import { HopperShell } from '@shared/hshell'
import type { OfficeConfig, Settings } from '@shared/types'
import { JobQueue } from './jobs'
import { fsHandlers } from './fsops'
import { transferHandlers } from './transfer'
import { archiveHandlers } from './archive'
import { undoHandlers, Undo } from './undo'
import { watchHandlers } from './watch'
import { searchHandlers } from './search'
import { officeHandlers } from './office'
import { pubshareHandlers } from './pubshare'
import { previewHandlers } from './preview'
import { Labels, labelHandlers } from './labels'
import { unlockHandlers } from './unlock'
import { FolderWatch, folderWatchHandlers } from './folderwatch'
import { revisionHandlers } from './revisions'
import { StorageIntel, storageHandlers } from './storage'
import { SmartNotify, smartHandlers } from './smartnotify'

export interface EngineCtx {
  emit: (event: string, data: unknown) => void
  jobs: JobQueue
  shell: HopperShell
  /** separate helper processes so folder walks and indexing never queue ahead of what's on screen */
  bulkShell: HopperShell
  indexShell: HopperShell
  undo: Undo
  sevenZip: string
  dataDir: string
  office: OfficeConfig | null
  settings: Settings | null
  /** where office.json was loaded from ('' = none): shared labels live next to it */
  officePath: string
  labels: Labels
  /** Watch this folder (folderwatch.ts) */
  folderWatch: FolderWatch
  /** Predictive Storage Intelligence (storage.ts) */
  storage: StorageIntel
  /** Smart File Notifications (smartnotify.ts) */
  smart: SmartNotify
}

const servers: ReturnType<typeof serve>[] = []
const emit = (event: string, data: unknown) => {
  for (const s of servers) s.emit(event, data)
}

const ctx: EngineCtx = {
  emit,
  jobs: new JobQueue(emit),
  // the listing helper stays warm while you browse; after five quiet minutes it lets go
  shell: new HopperShell(process.env.HOPPER_HELPER!, 300_000),
  // bulk and index helpers exit after a quiet minute (~25 MB each); the listing one stays warm
  bulkShell: new HopperShell(process.env.HOPPER_HELPER!, 60000),
  indexShell: new HopperShell(process.env.HOPPER_HELPER!, 60000),
  undo: new Undo(process.env.HOPPER_DATA!, emit),
  sevenZip: process.env.HOPPER_7Z!,
  dataDir: process.env.HOPPER_DATA!,
  office: null,
  settings: null,
  officePath: '',
  labels: null as unknown as Labels,
  folderWatch: null as unknown as FolderWatch,
  storage: null as unknown as StorageIntel,
  smart: null as unknown as SmartNotify
}
ctx.labels = new Labels(ctx)
ctx.folderWatch = new FolderWatch(ctx)
ctx.storage = new StorageIntel(ctx)
ctx.smart = new SmartNotify(ctx)
// what this Hopper creates, moves or deletes is never reported by a watched folder as someone else's
// (nor as a "duplicate download" by Smart File Notifications)
ctx.undo.onRecord = (r) => {
  const paths = r.pairs.flatMap(([from, to]) => (r.kind === 'recycle' ? [from] : r.kind === 'move' || r.kind === 'rename' ? [from, to] : [to]))
  ctx.folderWatch.noteOwn(paths)
  ctx.smart.noteOwn(paths)
}

const handlers: Handlers = {
  ping: () => 'pong',
  'jobs.list': () => ctx.jobs.list(),
  'jobs.pause': (id: string) => ctx.jobs.pause(id),
  'jobs.resume': (id: string) => ctx.jobs.resume(id),
  'jobs.cancel': (id: string) => ctx.jobs.cancel(id),
  'jobs.resolve': (jobId: string, conflictId: string, answer, all: boolean) => ctx.jobs.resolve(jobId, conflictId, answer, all),
  'jobs.clear': () => ctx.jobs.clearFinished(),
  ...fsHandlers(ctx),
  ...transferHandlers(ctx),
  ...archiveHandlers(ctx),
  ...undoHandlers(ctx),
  ...watchHandlers(ctx),
  ...searchHandlers(ctx),
  ...officeHandlers(ctx),
  ...pubshareHandlers(ctx),
  ...previewHandlers(ctx),
  ...labelHandlers(ctx),
  ...unlockHandlers(ctx),
  ...folderWatchHandlers(ctx),
  ...revisionHandlers(ctx),
  ...storageHandlers(ctx),
  ...smartHandlers(ctx)
}

process.parentPort.on('message', (e) => {
  const data = e.data as any
  if (data?.type === 'port' && e.ports[0]) {
    trace('engine got port')
    const port = e.ports[0]
    const server = serve(port, handlers)
    servers.push(server)
    port.on('message', (m) => void server.onMessage(m.data))
    port.on('close', () => {
      const i = servers.indexOf(server)
      if (i >= 0) servers.splice(i, 1)
    })
    port.start()
  } else if (data?.type === 'office') {
    ctx.office = data.office
    ctx.settings = data.settings
    ctx.officePath = String(data.officePath || '')
    ctx.folderWatch.configure(ctx.settings?.watchedFolders)
    ctx.storage.configure(ctx.settings?.storageIntel)
    ctx.smart.configure(ctx.settings?.smartNotify)
    emit('office', null)
  }
})

trace(`engine ready, uptime ${Math.round(performance.now())} ms`)
process.on('uncaughtException', (err) => console.error('[engine]', err))
process.on('unhandledRejection', (err) => console.error('[engine]', err))
