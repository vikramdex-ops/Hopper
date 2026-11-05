// Types private to the lan utility process.
import type { InboxItem, OfficeConfig, Peer, Settings } from '@shared/types'

export interface Identity {
  /** Windows account name, lower-case */
  user: string
  displayName: string
  host: string
  domain: string
  email: string
  status: Peer['status']
}

export interface LanCtx {
  emit: (event: string, data: unknown) => void
  /** ask main to flash the taskbar */
  attention: () => void
  log: (...args: unknown[]) => void
  dataDir: string
  sevenZip: string
  version: string
  office: OfficeConfig | null
  settings: Settings | null
  /** office key bytes, null when missing/invalid */
  key: Buffer | null
  me: Identity
  inboxRoot: () => string
}

export type ShareState = 'zipping' | 'connecting' | 'sending' | 'server' | 'done' | 'failed' | 'cancelled'

export interface ShareEvent {
  shareId: string
  /** the recipient this event is about */
  to: string
  state: ShareState
  done: number
  total: number
  rate: number
  via: 'direct' | 'server' | null
  error?: string
}

export interface RecipientState {
  user: string
  state: ShareState
  done: number
  total: number
  rate: number
  via: 'direct' | 'server' | null
  error?: string
  endedAt?: number
}

export interface OutgoingShare {
  shareId: string
  to: string[]
  paths: string[]
  message?: string
  zipFirst: boolean
  createdAt: number
  files: number
  bytes: number
  recipients: RecipientState[]
}

export interface IncomingRequest {
  requestId: string
  from: string
  fromName: string
  files: number
  bytes: number
  message: string
  via: 'direct' | 'server'
}

/** A file to send: wire path ('/' separated) plus where it is on disk. */
export interface FileItem {
  rel: string
  abs: string
  size: number
  mtime: number
}

/** manifest.json in a server-inbox drop folder; written last. */
export interface Manifest {
  v: 1
  shareId: string
  from: string
  fromName: string
  at: number
  message: string
  files: { path: string; size: number; mtime: number; sha256: string }[]
  dirs: string[]
}

export type Admit = (req: Omit<IncomingRequest, 'requestId'>) => Promise<true | string>
export type OnReceived = (item: InboxItem) => void
