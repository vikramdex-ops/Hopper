export function fmtSize(n: number, dir = false) {
  if (dir) return ''
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

export const fmtRate = (bps: number) => (bps > 0 ? `${fmtSize(Math.round(bps))}/s` : '')

const dtf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

export function fmtDate(ms: number) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `Today ${tf.format(d)}`
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `Yesterday ${tf.format(d)}`
  return dtf.format(d)
}

export const fmtDateFull = (ms: number) => (ms ? new Date(ms).toLocaleString() : '')

export function fmtAgo(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return fmtDate(ms)
}

export function fmtEta(remaining: number, rate: number) {
  if (!rate || remaining <= 0) return ''
  const s = Math.round(remaining / rate)
  if (s < 60) return `${s}s left`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s left`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`
}

export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

/** Natural, case-insensitive comparison (file2 < file10). */
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function initials(name: string) {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Stable pleasant colour per person. */
export function personColor(key: string) {
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const hues = [204, 262, 145, 24, 330, 186, 48, 290]
  return `hsl(${hues[h % hues.length]} 55% 45%)`
}

export const basename = (p: string) => {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'))
  return i < 0 ? t : t.slice(i + 1) || t
}

export const dirname = (p: string) => {
  const t = p.replace(/[\\/]+$/, '')
  const i = t.lastIndexOf('\\')
  if (i < 0) return t
  if (i === 2 && t[1] === ':') return t.slice(0, 3)
  const d = t.slice(0, i)
  return /^\\\\[^\\]+$/.test(d) ? t : d
}

export const join = (a: string, b: string) => (a.endsWith('\\') ? a + b : `${a}\\${b}`)
