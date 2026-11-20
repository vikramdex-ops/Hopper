// Smart File Notifications rules (src/shared/smartnotify.ts via Node type stripping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPEAT_MS, cleanSmartSettings, copyOrigin, duplicateNotice, extractedNotice, isArchive, isInstaller, isLowSpace, isPartialDownload, isTempName,
  largeTempNotice, oldInstallersNotice, shouldNotify, stalledNotice, stemOf, tempTotalNotice
} from '../../src/shared/smartnotify.ts'

const GB = 1024 ** 3

test('temp, partial, installer and archive names', () => {
  for (const n of ['a.tmp', 'A.TMP', 'x.bak', 'dump.dmp', '~WRL0001.tmp', 'P-101.dwl', 'file.tmp123', '.~lock.x.xlsx#']) assert.equal(isTempName(n), true, n)
  for (const n of ['report.pdf', 'tmp.pdf', 'temperature.xlsx', 'bakery.docx']) assert.equal(isTempName(n), false, n)
  for (const n of ['x.crdownload', 'y.part', 'z.partial']) assert.equal(isPartialDownload(n), true, n)
  assert.equal(isPartialDownload('part.pdf'), false)
  assert.equal(isInstaller('Setup.EXE'), true)
  assert.equal(isInstaller('a.pdf'), false)
  assert.equal(isArchive('a.zip'), true)
  assert.equal(isArchive('a.tar.gz'), true)
  assert.equal(stemOf('a.tar.gz'), 'a')
  assert.equal(stemOf('Lot 12.zip'), 'Lot 12')
})

test('copyOrigin recognises re-downloads and Explorer copies', () => {
  assert.equal(copyOrigin('Report (1).pdf'), 'Report.pdf')
  assert.equal(copyOrigin('Report(12).pdf'), 'Report.pdf')
  assert.equal(copyOrigin('Report - Copy.pdf'), 'Report.pdf')
  assert.equal(copyOrigin('Report - Copy (2).pdf'), 'Report.pdf')
  assert.equal(copyOrigin('Copy of Report.pdf'), 'Report.pdf')
  assert.equal(copyOrigin('README (3)'), 'README')
  assert.equal(copyOrigin('Report.pdf'), null)
  assert.equal(copyOrigin('(1).pdf'), null)
})

test('duplicate notice wording and actions', () => {
  const n = duplicateNotice('C:\\Users\\me\\Downloads\\Report (1).pdf', 'C:\\Users\\me\\Downloads\\Report.pdf', 2 * 1024 ** 2, 1000)
  assert.equal(n.kind, 'duplicate')
  assert.match(n.title, /You already have Report\.pdf/)
  assert.match(n.body, /identical to Report\.pdf in Downloads/)
  assert.deepEqual(n.actions[0], { id: 'recycle', label: 'Recycle new copy', paths: ['C:\\Users\\me\\Downloads\\Report (1).pdf'] })
  assert.equal(n.folder, 'C:\\Users\\me\\Downloads')
  const m = duplicateNotice('D:\\x\\a.pdf', 'D:\\x\\b.pdf', 10)
  assert.match(m.title, /a\.pdf is a duplicate/)
})

test('other notices', () => {
  assert.match(largeTempNotice('C:\\Temp\\big.tmp', 3 * GB, 3 * 86400e3).title, /3\.0 GB temporary file/)
  assert.match(largeTempNotice('C:\\Temp\\big.tmp', 3 * GB, 3 * 86400e3).body, /3 days/)
  const t = tempTotalNotice('C:\\Temp', 12 * GB, 4321, 9 * GB)
  assert.match(t.title, /12 GB/)
  assert.match(t.body, /4,321 files/)
  assert.match(stalledNotice('C:\\D\\x.crdownload', 5e8, 30 * 3600e3).body, /30 hours/)
  assert.match(extractedNotice('C:\\D\\Lot.zip', 'C:\\D\\Lot', 1e9).body, /folder Lot/)
  const o = oldInstallersNotice('C:\\D', [{ path: 'C:\\D\\a.exe', bytes: GB }, { path: 'C:\\D\\b.msi', bytes: GB }])
  assert.match(o.title, /2 old installers in D: 2\.0 GB/)
  assert.equal(o.actions[0].paths.length, 2)
})

test('low space and repeat suppression', () => {
  assert.equal(isLowSpace(GB, 100 * GB), true)
  assert.equal(isLowSpace(10 * GB, 100 * GB), false)
  assert.equal(isLowSpace(4 * GB, 100 * GB), true)
  assert.equal(isLowSpace(1, 0), false)
  const n = { key: 'k', kind: 'duplicate' }
  assert.equal(shouldNotify(n, {}, [], 0), true)
  assert.equal(shouldNotify(n, { k: 0 }, [], REPEAT_MS - 1), false)
  assert.equal(shouldNotify(n, { k: 0 }, [], REPEAT_MS), true)
  assert.equal(shouldNotify(n, {}, ['duplicate'], 0), false)
})

test('settings are cleaned', () => {
  const s = cleanSmartSettings({ largeTempMB: 1, tempTotalGB: 'x', muted: ['duplicate', 'nope'], folders: ['C:\\a', 'rel', 5] })
  assert.equal(s.largeTempMB, 10)
  assert.equal(s.tempTotalGB, 5)
  assert.deepEqual(s.muted, ['duplicate'])
  assert.deepEqual(s.folders, ['C:\\a'])
  assert.equal(s.enabled, true)
})
