// Allowlist HTML sanitiser for document previews (Word converted to HTML by the engine).
// Parses in an inert document, keeps a small set of formatting tags and a handful of harmless
// attributes, and drops everything else: scripts, styles, event handlers, links, remote URLs.

const KEEP = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'br', 'hr', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'span', 'div', 'blockquote', 'pre', 'code', 'img', 'a'
])
/** Removed together with everything inside them. */
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'object', 'embed', 'svg', 'math', 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea', 'template', 'noscript', 'audio', 'video', 'source', 'title', 'head'])
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|bmp|webp);base64,[A-Za-z0-9+/=\s]+$/

export function sanitizeHtml(html: string): string {
  const src = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  const out = document.implementation.createHTMLDocument('')
  const copy = (from: Node, to: Node, depth: number) => {
    if (depth > 200) return
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.appendChild(out.createTextNode(node.nodeValue ?? ''))
        continue
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const el = node as Element
      const tag = el.localName
      if (DROP.has(tag) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue
      if (!KEEP.has(tag)) {
        copy(el, to, depth + 1) // unknown wrapper: keep its text
        continue
      }
      if (tag === 'img') {
        const s = el.getAttribute('src') ?? ''
        if (DATA_IMAGE.test(s)) {
          const img = out.createElement('img')
          img.setAttribute('src', s.replace(/\s+/g, ''))
          img.setAttribute('alt', el.getAttribute('alt') ?? '')
          to.appendChild(img)
        } else {
          const ph = out.createElement('span')
          ph.setAttribute('class', 'omitted')
          ph.textContent = el.getAttribute('alt') || 'Picture not shown'
          to.appendChild(ph)
        }
        continue
      }
      // Links are kept as plain text: a preview never navigates.
      const next = out.createElement(tag === 'a' ? 'span' : tag)
      if (tag === 'td' || tag === 'th') {
        for (const a of ['colspan', 'rowspan']) {
          const v = Number(el.getAttribute(a))
          if (Number.isInteger(v) && v > 1 && v <= 1000) next.setAttribute(a, String(v))
        }
      }
      to.appendChild(next)
      copy(el, next, depth + 1)
    }
  }
  copy(src.body, out.body, 0)
  return out.body.innerHTML
}
