// Small, safe markdown renderer for previews (escapes everything, no raw HTML).
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

export function renderMarkdown(src: string) {
  const out: string[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  let list: 'ul' | 'ol' | null = null
  let code: string[] | null = null
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
        code = null
      } else code.push(line)
      continue
    }
    if (/^```/.test(line)) {
      flushPara()
      flushList()
      code = []
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      flushList()
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
      continue
    }
    const li = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      const kind = /\d/.test(li[1]) ? 'ol' : 'ul'
      if (list !== kind) {
        flushList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline(li[2])}</li>`)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      flushList()
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`)
      continue
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushPara()
      flushList()
      out.push('<hr>')
      continue
    }
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    flushList()
    para.push(line.trim())
  }
  if (code) out.push(`<pre><code>${esc((code as string[]).join('\n'))}</code></pre>`)
  flushPara()
  flushList()
  return out.join('\n')
}

export function parseCsv(text: string, sep: string, maxRows = 200) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if ((cell || row.length) && rows.length < maxRows) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
