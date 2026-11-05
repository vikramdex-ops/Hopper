import type { ArchivePreset, OfficeConfig, PaneState, Settings } from './types'

export const DEFAULT_PRESETS: ArchivePreset[] = [
  { id: 'fast', name: 'Fast zip (store)', format: 'zip', level: 0, volumeMB: 0, key: 'Ctrl+Alt+Z' },
  { id: 'balanced', name: 'Balanced zip', format: 'zip', level: 5, volumeMB: 0 },
  { id: 'max7z', name: 'Smallest (7z ultra)', format: '7z', level: 9, volumeMB: 0 },
  { id: 'email', name: 'Split for email (20 MB)', format: 'zip', level: 5, volumeMB: 20 },
  { id: 'secure', name: 'Password zip', format: 'zip', level: 5, volumeMB: 0, password: true },
  { id: 'rar', name: 'RAR (WinRAR)', format: 'rar', level: 3, volumeMB: 0 }
]

export function defaultPane(path: string): PaneState {
  return {
    tabs: [{ id: 't' + Math.random().toString(36).slice(2, 8), path, history: [path], index: 0 }],
    active: 0,
    view: 'details',
    sort: { key: 'name', dir: 1 }
  }
}

export function defaultSettings(home: string, docs: string): Settings {
  return {
    theme: 'system',
    accent: 'system',
    dual: true,
    showHidden: false,
    showSystem: false,
    showExtensions: true,
    confirmDelete: false,
    keepInTray: true,
    confirmPermanentDelete: true,
    inspector: true,
    sidebarWidth: 232,
    inspectorWidth: 320,
    groupRevisions: false,
    thumbSize: 96,
    columns: [
      { id: 'name', width: 320, visible: true },
      { id: 'rev', width: 64, visible: false },
      { id: 'size', width: 96, visible: true },
      { id: 'type', width: 140, visible: true },
      { id: 'mtime', width: 150, visible: true },
      { id: 'ctime', width: 150, visible: false },
      { id: 'attrs', width: 64, visible: false }
    ],
    panes: [defaultPane(home), defaultPane(docs)],
    activePane: 0,
    workspaces: [],
    pinned: [home, docs],
    quickDests: [],
    archivePresets: DEFAULT_PRESETS,
    defaultPreset: 'fast',
    verifyCopies: false,
    parallelSmallFiles: 4,
    inboxDir: '',
    officeConfigPath: '\\\\192.168.0.200\\free exchange - updated\\_Hopper\\office.json',
    indexRoots: [],
    indexEnabled: true,
    autoUpdate: true,
    profile: { displayName: '', email: '', status: 'online' },
    lan: { enabled: true, acceptFrom: 'all', blocked: [], askFor: [] },
    recentShares: [],
    tagColors: {}
  }
}

export function defaultOffice(): OfficeConfig {
  return {
    officeName: 'Dexterity Design Services',
    officeKey: '',
    serverInbox: '\\\\192.168.0.200\\free exchange - updated\\_Hopper\\Inbox',
    cliq: { enabled: false, endpoint: 'https://cliq.zoho.in/api/v2/bots/hopper/message', zapikey: '' },
    groups: [],
    templates: [
      {
        id: 'project',
        name: 'Project folder',
        folders: ['01_Incoming', '02_Working', '03_Outgoing', '04_Transmittals', '05_References', '06_Correspondence']
      },
      {
        id: 'lot',
        name: 'Lot folder',
        folders: ['{name}/01_Received', '{name}/02_Checked', '{name}/03_Comments', '{name}/04_Issued']
      }
    ],
    // Revision tokens are an engineering convention, so they live in the office config,
    // not in code. These defaults only cover the common "_RevA" / "-R1" / " Rev 0" spellings;
    // anything outside `order` is reported as "order unknown", never guessed.
    revisions: {
      patterns: [
        '^(?<base>.+?)[ _\\-.]+rev[ _\\-.]?(?<rev>[0-9A-Z]{1,3})$',
        '^(?<base>.+?)[ _\\-.]+R(?<rev>[0-9]{1,2})$'
      ],
      order: []
    },
    conventions: []
  }
}
