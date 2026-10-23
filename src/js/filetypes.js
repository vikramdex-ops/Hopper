// File-type taxonomy: one place that decides what a file "is".
// Used by the list view (Type column), the icon mapper, filters and previews.

export const EXT_SETS = {
  img: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif', 'tif', 'tiff', 'heic'],
  vid: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ogv', 'flv', 'wmv'],
  aud: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'mid'],
  arch: ['zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'cab', 'iso', 'jar', 'appx', 'msi'],
  code: ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'rb', 'php', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'swift', 'sh', 'bat', 'cmd', 'ps1', 'psm1', 'sql', 'lua', 'r', 'pl', 'asm', 's', 'css', 'scss', 'less'],
  pdf: ['pdf'],
  html: ['html', 'htm', 'mht', 'url'],
  tex: ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml', 'ini', 'csv', 'tsv', 'doc', 'docx', 'rtf', 'odt', 'ppt', 'pptx', 'xls', 'xlsx'],
  exed: ['exe', 'dll', 'sys', 'ax', 'ocx', 'scr', 'cpl'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
  link: ['lnk', 'pif']
};

const BY_EXT = {};
for (const [cat, list] of Object.entries(EXT_SETS)) for (const e of list) BY_EXT[e] = cat;

const extOf = e => String(e?.name || '').split('.').pop().toLowerCase();
export const extOfEntry = extOf;

/** Coarse category: dir | file | img | vid | aud | arch | code | pdf | html | tex | exed | link */
export function catFor(entry) {
  if (entry?.isDir) return 'dir';
  const ext = extOf(entry);
  return BY_EXT[ext] || 'file';
}

export const isIMAGE = e => EXT_SETS.img.includes(extOf(e));
export const isVIDEO = e => EXT_SETS.vid.includes(extOf(e));
export const isAUDIO = e => EXT_SETS.aud.includes(extOf(e));
export const isFONT = e => EXT_SETS.font.includes(extOf(e));
export const isMARKDOWN = e => ['md', 'markdown', 'mdx'].includes(extOf(e));
export const isJSON = e => extOf(e) === 'json';
export const isCSV = e => ['csv', 'tsv'].includes(extOf(e));
export const isHTML = e => ['html', 'htm'].includes(extOf(e));
export const isARCHIVE = e => EXT_SETS.arch.includes(extOf(e));
export const isPDF = e => extOf(e) === 'pdf';
export const isTEXT = e => ['txt', 'md', 'markdown', 'mdx', 'log', 'json', 'xml', 'yml', 'yaml', 'ini', 'csv', 'tsv', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm', 'py', 'bat', 'cmd', 'ps1', 'sh', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'java', 'php', 'rb', 'sql', 'toml', 'env', 'svg'].includes(extOf(e)) || e?.name === '.gitignore';

/** Human label for the Type column. */
export function typeLabel(entry) {
  if (!entry) return '';
  if (entry.isDir) return 'Folder';
  const ext = extOf(entry);
  if (!ext || !entry.name.includes('.')) return 'File';
  const cat = catFor(entry);
  const names = {
    img: 'Image', vid: 'Video', aud: 'Audio', arch: 'Archive', code: 'Source',
    pdf: 'PDF document', html: 'Web page', tex: 'Text', exed: 'Application', font: 'Font', link: 'Shortcut'
  };
  return names[cat] ? `${names[cat]} (${ext.toUpperCase()})` : `${ext.toUpperCase()} file`;
}

/** Icon name used by the shared SVG icon set. */
export function iconNameFor(entry) {
  if (!entry) return 'file';
  if (entry.isDir) return 'folder';
  if (entry.brokenLink) return 'broken-link';
  const map = {
    img: 'file-image', vid: 'file-video', aud: 'file-audio', arch: 'file-archive',
    code: 'file-code', pdf: 'file-pdf', html: 'file-html', exed: 'file-app',
    font: 'file-text', link: 'link', tex: 'file-text'
  };
  return map[catFor(entry)] || 'file';
}
