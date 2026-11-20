// Predictive Storage Intelligence arithmetic (src/shared/storage.ts via Node type stripping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DAY, analyse, cleanStorageSettings, cleanTracked, compactHistory, dailySeries, daysToFull, fillingAlert, fmtBytes, mad, median, theilSen, unusualAlert
} from '../../src/shared/storage.ts'

const GB = 1024 ** 3
const MB = 1024 ** 2
const T0 = Date.UTC(2026, 9, 1, 6) // 1 Oct 2026, 06:00 UTC
const series = (perDay) => perDay.map((bytes, i) => ({ t: T0 + i * DAY, bytes }))

test('median, MAD and Theil-Sen basics', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.ok(Number.isNaN(median([])))
  assert.equal(mad([1, 1, 2, 2, 4, 6, 9]), 1)
  assert.equal(theilSen([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }]), 2)
  // one wild outlier barely moves Theil-Sen
  const s = theilSen([0, 1, 2, 3, 4, 5, 6].map((x) => ({ x, y: x === 3 ? 100 : x })))
  assert.ok(Math.abs(s - 1) < 0.5, String(s))
})

test('dailySeries keeps the last sample of each day; compactHistory thins old samples', () => {
  const s = [{ t: T0, bytes: 1 }, { t: T0 + 3600e3, bytes: 2 }, { t: T0 + DAY, bytes: 3 }]
  assert.deepEqual(dailySeries(s).map((x) => x.bytes), [2, 3])
  const now = T0 + 40 * DAY
  const many = []
  for (let h = 0; h < 40 * 24; h += 6) many.push({ t: T0 + h * 3600e3, bytes: h })
  const c = compactHistory(many, now)
  assert.ok(c.length < many.length)
  assert.ok(c.every((x, i) => i === 0 || x.t > c[i - 1].t), 'sorted')
  assert.ok(c.filter((x) => x.t >= now - 14 * DAY).length >= 14 * 4 - 1, 'recent kept raw')
  assert.equal(compactHistory([{ t: now - 500 * DAY, bytes: 1 }], now).length, 0, 'older than a year dropped')
})

test('steady growth: trend and forecast, not unusual', () => {
  const tr = analyse(series(Array.from({ length: 20 }, (_, i) => 10 * GB + i * 100 * MB)), T0 + 19 * DAY)
  assert.ok(Math.abs(tr.rate - 100 * MB) < 1, String(tr.rate))
  assert.equal(tr.unusual, false)
  assert.ok(Math.abs(tr.in30 - (tr.now + 3000 * MB)) < 10)
  assert.equal(tr.days, 19)
})

test('sudden surge after a quiet history is unusual, with a reason', () => {
  const quiet = Array.from({ length: 15 }, (_, i) => 5 * GB + i * 20 * MB + (i % 2) * 5 * MB)
  const last = quiet[quiet.length - 1]
  const surge = [last + 3 * GB, last + 6 * GB, last + 9 * GB]
  const tr = analyse(series([...quiet, ...surge]), T0 + 17 * DAY)
  assert.equal(tr.unusual, true)
  assert.ok(tr.score >= 3.5, String(tr.score))
  assert.match(tr.reason, /GB\/day over the last 3 days/)
  assert.match(tr.reason, /usual/)
})

test('small growth on a static folder never alerts (absolute floor)', () => {
  const flat = Array.from({ length: 15 }, () => 2 * GB)
  const tr = analyse(series([...flat, 2 * GB + 50 * MB, 2 * GB + 100 * MB, 2 * GB + 150 * MB]), T0 + 17 * DAY)
  assert.equal(tr.unusual, false)
})

test('too little history: no trend, no score', () => {
  const tr = analyse(series([GB, 2 * GB]), T0 + DAY)
  assert.equal(tr.rate, null)
  assert.equal(tr.score, null)
  assert.equal(tr.unusual, false)
  assert.equal(analyse([], T0).now, 0)
})

test('shrinking folders are not unusual', () => {
  const xs = Array.from({ length: 18 }, (_, i) => 50 * GB - i * 10 * MB)
  xs.push(xs[17] - 20 * GB)
  assert.equal(analyse(series(xs), T0 + 18 * DAY).unusual, false)
})

test('daysToFull', () => {
  assert.equal(daysToFull(10 * GB, GB), 10)
  assert.equal(daysToFull(10 * GB, -GB), null)
  assert.equal(daysToFull(10 * GB, null), null)
})

test('settings are cleaned', () => {
  const s = cleanStorageSettings({ scanHours: 999, folders: [{ path: 'D:\\P' }, { path: 'd:\\p' }, { path: 'relative' }, null] })
  assert.equal(s.scanHours, 48)
  assert.equal(s.folders.length, 1)
  assert.equal(s.folders[0].children, true)
  assert.deepEqual(s.folders[0].notify, [])
  assert.equal(s.enabled, true)
  assert.equal(cleanStorageSettings(undefined).scanHours, 6)
  assert.equal(cleanTracked({ path: '\\\\srv\\share\\x', notify: ['a', 5, ''] }).notify.length, 1)
})

test('alert wording', () => {
  assert.equal(fmtBytes(1536), '1.5 KB')
  assert.equal(fmtBytes(12 * GB), '12 GB')
  const trend = { rate: 2 * GB, recent: 3 * GB, baseline: null, score: 9, unusual: true, reason: 'growing 3 GB/day over the last 3 days, 30x its usual 100 MB/day', now: 40 * GB, in30: 100 * GB, in90: 200 * GB, days: 20 }
  const v = { key: 'f', kind: 'folder', path: 'D:\\P', label: 'P', trend, fullIn: null, at: 0, partial: false, spark: [] }
  const a = unusualAlert(v, { ...v, path: 'D:\\P\\Renders', label: 'Renders' })
  assert.match(a.title, /P is growing unusually fast/)
  assert.match(a.body, /Most of it is in Renders/)
  const f = fillingAlert({ ...v, kind: 'drive', label: 'Local Disk (C:)', free: 20 * GB, fullIn: 10.4 })
  assert.match(f.title, /full in about 10 days/)
})
