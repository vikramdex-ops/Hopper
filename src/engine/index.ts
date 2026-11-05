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
}

const servers: ReturnType<typeof serve>[] = []
const emit = (event: string, data: unknown) => {
  for (const s of servers) s.emit(event, data)
}

const ctx: EngineCtx = {
  emit,
  jobs: new JobQueue(emit),
  shell: new HopperShell(process.env.HOPPER_HELPER!),
  bulkShell: new HopperShell(process.env.HOPPER_HELPER!),
  indexShell: new HopperShell(process.env.HOPPER_HELPER!),
  undo: new Undo(process.env.HOPPER_DATA!, emit),
  sevenZip: process.env.HOPPER_7Z!,
  dataDir: process.env.HOPPER_DATA!,
  office: null,
  settings: null
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
  ...officeHandlers(ctx)
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
    emit('office', null)
  }
})

trace(`engine ready, uptime ${Math.round(performance.now())} ms`)
process.on('uncaughtException', (err) => console.error('[engine]', err))
process.on('unhandledRejection', (err) => console.error('[engine]', err))
