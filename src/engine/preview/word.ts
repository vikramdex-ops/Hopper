// Word (.docx) preview through mammoth: the document's text, headings, lists, tables and pictures
// as plain HTML. Pictures are inlined as data URIs within a size budget; the renderer sanitises
// the HTML again before showing it. Page layout is not reproduced, and the notes say so.
// (Loaded on demand by the preview worker; mammoth is only read when a .docx is previewed.)
import mammoth from 'mammoth'
import type { DocxPreview } from './types'

const WEB_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp'])
const MAX_IMAGE = 6 * 1024 * 1024
const MAX_IMAGES_TOTAL = 24 * 1024 * 1024

export async function docxToHtml(buffer: Buffer): Promise<DocxPreview> {
  let budget = MAX_IMAGES_TOTAL
  let shown = 0
  let tooBig = 0
  const unsupported = new Map<string, number>()
  const convertImage = mammoth.images.imgElement(async (image) => {
    const type = String(image.contentType ?? '').toLowerCase()
    if (!WEB_IMAGES.has(type)) {
      const label = type.replace(/^image\/(x-)?/, '').toUpperCase() || 'unknown type'
      unsupported.set(label, (unsupported.get(label) ?? 0) + 1)
      return { src: '', alt: `Picture not shown (${label})` }
    }
    const data: Buffer = await image.readAsBuffer()
    if (data.length > MAX_IMAGE || data.length > budget) {
      tooBig++
      return { src: '', alt: 'Picture not shown (too large for the preview)' }
    }
    budget -= data.length
    shown++
    return { src: `data:${type};base64,${data.toString('base64')}` }
  })
  const res = await mammoth.convertToHtml({ buffer }, { convertImage, ignoreEmptyParagraphs: false })
  const notes = ['Simplified view of the text, tables and pictures. Page breaks, headers and footers, columns, fonts and exact spacing are not reproduced.']
  for (const [label, n] of unsupported) notes.push(`${n} ${label} picture${n === 1 ? '' : 's'} cannot be shown here.`)
  if (tooBig) notes.push(`${tooBig} large picture${tooBig === 1 ? ' was' : 's were'} left out.`)
  const html = String(res.value ?? '')
  if (!html.trim()) notes.push('No text was found in the document body.')
  return { html, notes }
}
