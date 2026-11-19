// Windows shell commands: shortcut names, which files can run as administrator, the recent files
// list (src/shared/shellops.ts), and mapping a network drive (src/shared/network.ts). No I/O.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canRunAsAdmin, pushRecent, shortcutBaseName, shortcutName, RECENT_FILES_MAX } from '../../src/shared/shellops.ts'
import { freeDriveLetters, mappableUnc, netError } from '../../src/shared/network.ts'

test('shortcutName: "<name> - Shortcut.lnk", numbered while taken', () => {
  assert.equal(shortcutName('report.pdf', () => false), 'report.pdf - Shortcut.lnk')
  const taken = new Set(['report.pdf - Shortcut.lnk', 'report.pdf - Shortcut (2).lnk'])
  assert.equal(shortcutName('report.pdf', (n) => taken.has(n)), 'report.pdf - Shortcut (3).lnk')
  assert.equal(shortcutName('Lot 07', () => false), 'Lot 07 - Shortcut.lnk')
})

test('shortcutBaseName: last part of the path; a drive root is its letter', () => {
  assert.equal(shortcutBaseName('D:\\Projects\\Lot 07\\'), 'Lot 07')
  assert.equal(shortcutBaseName('D:\\Projects\\a.dwg'), 'a.dwg')
  assert.equal(shortcutBaseName('\\\\nas01\\Projects'), 'Projects')
  assert.equal(shortcutBaseName('e:\\'), 'E')
})

test('canRunAsAdmin: programs and scripts only', () => {
  for (const x of ['exe', 'EXE', '.bat', 'cmd', 'msi', 'ps1']) assert.equal(canRunAsAdmin(x), true, x)
  for (const x of ['', 'pdf', 'lnk', 'exe.txt', 'vbs']) assert.equal(canRunAsAdmin(x), false, x)
})

test('pushRecent: newest first, no duplicates ignoring case, capped', () => {
  assert.deepEqual(pushRecent(undefined, 'D:\\a.pdf'), ['D:\\a.pdf'])
  assert.deepEqual(pushRecent(['D:\\b.pdf', 'd:\\A.PDF', 'D:\\c.pdf'], 'D:\\a.pdf'), ['D:\\a.pdf', 'D:\\b.pdf', 'D:\\c.pdf'])
  const many = Array.from({ length: 30 }, (_, i) => `D:\\f${i}.txt`)
  const r = pushRecent(many, 'D:\\new.txt')
  assert.equal(r.length, RECENT_FILES_MAX)
  assert.equal(r[0], 'D:\\new.txt')
  assert.equal(r[1], 'D:\\f0.txt')
})

test('freeDriveLetters: Z down to D, skipping used ones', () => {
  const free = freeDriveLetters(['C:\\', 'd:\\', 'Z:\\', 'U:\\'])
  assert.equal(free[0], 'Y')
  assert.ok(!free.includes('D') && !free.includes('U') && !free.includes('Z') && !free.includes('C'))
  assert.equal(free.at(-1), 'E')
  assert.ok(!freeDriveLetters([]).some((l) => 'ABC'.includes(l)))
  assert.equal(freeDriveLetters([]).length, 23)
})

test('mappableUnc: a share or a folder in one; not a computer or a local path', () => {
  assert.equal(mappableUnc('\\\\nas01\\Projects\\'), '\\\\nas01\\Projects')
  assert.equal(mappableUnc('//nas01/Projects/Lot 07'), '\\\\nas01\\Projects\\Lot 07')
  assert.equal(mappableUnc('\\\\nas01'), null)
  assert.equal(mappableUnc('D:\\Projects'), null)
  assert.equal(mappableUnc('hopper:network'), null)
})

test('netError: mapping and disconnecting drives read plainly', () => {
  assert.match(netError({ stage: 'map', code: 85 }, 'nas01').message, /already in use/)
  assert.match(netError({ stage: 'map', code: 1202 }, 'nas01').message, /remembers a drive/)
  assert.equal(netError({ stage: 'map', code: 1326 }, 'nas01').canSignIn, true)
  assert.match(netError({ stage: 'unmap', code: 2401 }, 'Z:').message, /disconnect again/)
  assert.equal(netError({ stage: 'unmap', code: 2401 }, 'Z:').code, 'busy')
  assert.match(netError({ stage: 'unmap', code: 2250 }, 'Z:').message, /isn't connected/)
  assert.match(netError({ stage: 'input', code: 1200 }, '').message, /drive letter/)
  assert.match(netError({ stage: 'input', code: 67 }, '').message, /\\\\server\\share/)
})
