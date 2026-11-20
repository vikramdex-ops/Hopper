// Paste-and-go path parsing (src/shared/pathpaste.ts via Node type stripping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromFileUrl, parsePastedPath, samePath } from '../../src/shared/pathpaste.ts'

const env = (n) => ({ userprofile: 'C:\\Users\\me', temp: 'C:\\Temp' })[n.toLowerCase()]

test('plain, quoted and trailing-slash paths', () => {
  assert.equal(parsePastedPath('D:\\Projects\\P12513'), 'D:\\Projects\\P12513')
  assert.equal(parsePastedPath('"D:\\Projects\\P12513\\"'), 'D:\\Projects\\P12513')
  assert.equal(parsePastedPath("  'd:\\a b\\c.pdf'  \r\n"), 'D:\\a b\\c.pdf')
  assert.equal(parsePastedPath('“D:\\x”'), 'D:\\x')
  assert.equal(parsePastedPath('<D:\\x>'), 'D:\\x')
})

test('drive roots', () => {
  assert.equal(parsePastedPath('d:'), 'D:\\')
  assert.equal(parsePastedPath('D:\\'), 'D:\\')
  assert.equal(parsePastedPath('D:/'), 'D:\\')
})

test('forward slashes and doubled separators', () => {
  assert.equal(parsePastedPath('D:/Projects//P1/'), 'D:\\Projects\\P1')
  assert.equal(parsePastedPath('//server/share/dir'), '\\\\server\\share\\dir')
  assert.equal(parsePastedPath('\\\\fs01\\Projects\\\\x\\'), '\\\\fs01\\Projects\\x')
})

test('UNC computer and share', () => {
  assert.equal(parsePastedPath('\\\\server'), '\\\\server')
  assert.equal(parsePastedPath('\\\\server\\share'), '\\\\server\\share')
})

test('file URLs', () => {
  assert.equal(parsePastedPath('file:///C:/a%20b/c.pdf'), 'C:\\a b\\c.pdf')
  assert.equal(parsePastedPath('file://server/share/x%23y'), '\\\\server\\share\\x#y')
  assert.equal(fromFileUrl('file:///D|/x'), 'D:\\x')
  assert.equal(fromFileUrl('file://localhost/D:/x'), 'D:\\x')
  assert.equal(fromFileUrl('file:///usr/bin'), null)
})

test('environment variables', () => {
  assert.equal(parsePastedPath('%USERPROFILE%\\Downloads', env), 'C:\\Users\\me\\Downloads')
  assert.equal(parsePastedPath('%NOPE%\\x', env), null)
  assert.equal(parsePastedPath('%USERPROFILE%\\x'), null) // no env given: not a path
})

test('first line only; text that is not a path', () => {
  assert.equal(parsePastedPath('\n\nD:\\a\nD:\\b'), 'D:\\a')
  for (const t of ['', '   ', 'hello world', 'https://example.com', 'Projects\\P1', 'D:\\a|b', 'D:\\a?b', 'C', '\\\\']) {
    assert.equal(parsePastedPath(t), null, JSON.stringify(t))
  }
  assert.equal(parsePastedPath(null), null)
})

test('samePath ignores case and trailing separators', () => {
  assert.equal(samePath('D:\\A\\', 'd:\\a'), true)
  assert.equal(samePath('D:\\A', 'D:\\B'), false)
})
