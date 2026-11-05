// One file-type taxonomy for icons, the Type column, previews and filters.

export type Kind =
  | 'folder' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'code' | 'markdown' | 'data' | 'sheet' | 'doc'
  | 'slides' | 'archive' | 'cad' | 'font' | 'app' | 'link' | 'html' | 'file'

const MAP: Record<string, Kind> = {}
const add = (kind: Kind, exts: string) => exts.split(' ').forEach((e) => (MAP[e] = kind))
add('image', 'png jpg jpeg jfif gif webp bmp ico svg avif tif tiff heic heif psd')
add('video', 'mp4 m4v mkv webm mov avi wmv mpg mpeg 3gp')
add('audio', 'mp3 wav ogg flac m4a aac wma opus')
add('pdf', 'pdf')
add('text', 'txt log ini cfg conf inf nfo rtf env properties lst rpt')
add('markdown', 'md markdown')
add('code', 'js mjs cjs ts tsx jsx css scss less py rb go rs java kt c h cpp hpp cs vb ps1 psm1 bat cmd sh lua php sql swift r m pl lisp lsp scr vbs')
add('html', 'html htm xhtml')
add('data', 'json xml yaml yml toml csv tsv')
add('sheet', 'xls xlsx xlsm xlsb ods')
add('doc', 'doc docx odt')
add('slides', 'ppt pptx odp')
add('archive', 'zip 7z rar tar gz tgz bz2 xz txz zst iso cab wim')
add('cad', 'dwg dxf dgn i01 rvt nwd nwc ifc step stp igs iges sat 3dm skp pcf idf sha')
add('font', 'ttf otf woff woff2')
add('app', 'exe msi appx msix com')
add('link', 'lnk url')

export const kindOf = (ext: string, dir = false): Kind => (dir ? 'folder' : MAP[ext] ?? 'file')

export const KIND_ICON: Record<Kind, string> = {
  folder: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'pdf', text: 'text', code: 'code',
  markdown: 'text', data: 'code', sheet: 'sheet', doc: 'documents', slides: 'slides', archive: 'zip', cad: 'cad',
  font: 'font', app: 'app', link: 'link', html: 'code', file: 'file'
}

// Muted, theme-agnostic tints for file glyphs.
export const KIND_COLOR: Record<Kind, string> = {
  folder: '#e8a33d', image: '#2fa36b', video: '#c24f9a', audio: '#8b5cf6', pdf: '#d13438', text: '#8a8a8a',
  code: '#3c8dd9', markdown: '#3c8dd9', data: '#c79a2e', sheet: '#1d8a4c', doc: '#2b6fd6', slides: '#d2582c',
  archive: '#a0742f', cad: '#d6502b', font: '#6b6bd6', app: '#5a7184', link: '#5a7184', html: '#e06a2b', file: '#8a8a8a'
}

const LABEL: Partial<Record<Kind, string>> = {
  folder: 'File folder', image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF document', text: 'Text document',
  markdown: 'Markdown', code: 'Source code', html: 'Web page', data: 'Data file', sheet: 'Spreadsheet', doc: 'Document',
  slides: 'Presentation', archive: 'Archive', cad: 'Drawing', font: 'Font', app: 'Application', link: 'Shortcut'
}

export function typeLabel(ext: string, dir = false) {
  if (dir) return 'File folder'
  const k = kindOf(ext)
  const base = LABEL[k]
  if (!ext) return 'File'
  return base ? `${base} (${ext.toUpperCase()})` : `${ext.toUpperCase()} file`
}

/** Kinds with a shell thumbnail worth asking Windows for. */
export const THUMB_KINDS = new Set<Kind>(['image', 'video', 'pdf', 'cad', 'doc', 'sheet', 'slides', 'font'])
