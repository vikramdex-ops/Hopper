// Types for the office tools (PDF toolkit, folder templates, lot packager).
// Type-only, so the renderer can import them too.

export interface PdfInfo {
  path: string
  pages: number
  title: string
  author: string
  producer: string
  /** ms since epoch, null when the document does not say */
  created: number | null
  bytes: number
  encrypted: boolean
}

export type SplitMode = 'each' | 'ranges'
export type RotateDegrees = 90 | 180 | 270

export interface TemplateVars {
  name?: string
  project?: string
  /** YYYY-MM-DD; today (local) when omitted */
  date?: string
}

export interface TemplateResult {
  /** every folder this call created, top-down */
  created: string[]
  /** folders the template names that already existed */
  existing: string[]
  /** the folder to open afterwards: the template's root, or its first top-level folder */
  top?: string | null
}

export interface TemplatePreview {
  /** resolved destination ('' when previewing without one) */
  dest: string
  /** the template's own root folder name, when it has one and the values are complete */
  top: string | null
  /** every folder, relative to dest, '\' separated, parents first */
  paths: string[]
  /** the subset of paths that already exist (kept, never overwritten) */
  existing: string[]
  warnings: import('@shared/template-model').TemplateWarning[]
  /** problems that block creating */
  errors: string[]
  /** folders that would be created */
  count: number
  depth: number
  /** characters of the longest full path */
  longest: number
}

export interface TransmittalInfo {
  number: string
  project: string
  client?: string
  to: string
  from: string
  purpose: string
  /** printed exactly as given */
  date: string
  notes?: string
}

export interface PackageSpec {
  files: string[]
  outDir: string
  name: string
  conventionId?: string
  /** copy the files into outDir/name */
  copy: boolean
  zip: boolean
  /** archive preset id from settings; 'balanced' when omitted */
  presetId?: string
  /** only for presets that need one */
  password?: string
  transmittal: TransmittalInfo
}

export type ConventionStatus = 'ok' | 'fail' | 'no convention'

export interface PlanFile {
  path: string
  name: string
  missing: boolean
  /** set when the path is not a regular file (folder, unreadable) */
  problem?: string
  size: number
  mtime: number
  base: string
  /** exactly as parsed from the name, null when there is none */
  rev: string | null
  ext: string
  convention: ConventionStatus
  /** other files in the lot with the same base name and extension */
  sameBase: string[]
  /** other files in the lot with the same file name (would collide when copied) */
  nameClash: string[]
}

export interface PlanReport {
  files: PlanFile[]
  convention: { id: string; name: string; pattern: string } | null
  /** reasons the lot cannot be packaged as specified */
  blocking: string[]
  warnings: string[]
  totals: {
    files: number
    bytes: number
    missing: number
    conventionOk: number
    conventionFail: number
    withRev: number
    duplicateBases: number
    nameClashes: number
  }
}
