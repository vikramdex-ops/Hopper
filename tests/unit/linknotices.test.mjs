// Client-link notices to senders (src/lan/linknotices.ts): who sends them, when, once only, and
// what they say. Cliq is replaced by a local HTTPS-less fake by stubbing fetch.
import { TEST_WORK } from './pubshare-hooks.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

const { LinkNotices, linkNotice } = await import('../../src/lan/linknotices.ts')

const HOUR = 3600_000
const NOW = Date.UTC(2026, 10, 13, 6, 0)
const ID1 = 'a'.repeat(26)
const ID2 = 'b'.repeat(26)
const ID3 = 'c'.repeat(26)
const ID4 = 'd'.repeat(26)

function manifest(id, over = {}) {
  return { v: 1, id, title: `Lot ${id[0]}`, message: '', sender: 'Priya Sharma', createdAt: NOW - 3 * 24 * HOUR, expiresAt: NOW + 4 * 24 * HOUR, files: [{ name: 'a.zip', size: 1048576 }], password: null, maxDownloads: 0, owner: { user: 'Priya', host: 'WS-001' }, ...over }
}
const stats = (downloads, lastDownloadAt) => ({ v: 1, views: 1, started: downloads, downloads, bytes: 0, lastViewAt: 0, lastDownloadAt, files: [] })

async function setup() {
  const store = join(TEST_WORK, 'linknotices', String(Math.random()).slice(2))
  await fsp.mkdir(store, { recursive: true })
  const put = async (id, m, s) => {
    await fsp.mkdir(join(store, id), { recursive: true })
    await fsp.writeFile(join(store, id, 'manifest.json'), JSON.stringify(m))
    if (s) await fsp.writeFile(join(store, id, 'stats.json'), JSON.stringify(s))
  }
  const posts = []
  const ctx = {
    log: () => {},
    officePath: '',
    me: { host: 'WS-026' },
    office: { cliq: { enabled: true, endpoint: 'https://cliq.example/api/v2/bots/hopper/message', zapikey: 'k' }, publicShare: { enabled: true, store, pageUrl: 'https://share.example/', host: { pc: 'ws-026' } } }
  }
  const discovery = { emailFor: (u) => (u === 'priya' ? 'priya@example.com' : '') }
  globalThis.fetch = async (url, init) => {
    posts.push(JSON.parse(init.body))
    return new Response('{}', { status: 200 })
  }
  return { store, put, posts, ctx, notices: new LinkNotices(ctx, discovery) }
}

test('first download and closing-soon notices go to the owner once, as Cliq cards', async () => {
  const t = await setup()
  await t.put(ID1, manifest(ID1), stats(1, NOW - 5 * 60_000)) // fresh download
  await t.put(ID2, manifest(ID2, { expiresAt: NOW + 30 * HOUR }), stats(0, 0)) // closes in 30 h, never downloaded
  await t.put(ID3, manifest(ID3), stats(3, NOW - 5 * 24 * HOUR)) // downloaded long before notices existed
  await t.put(ID4, manifest(ID4, { expiresAt: NOW - HOUR }), stats(1, NOW - 2 * HOUR)) // already closed
  assert.equal(await t.notices.sweep(NOW), 2)
  assert.equal(t.posts.length, 2)
  for (const p of t.posts) {
    assert.equal(p.userids, 'priya@example.com')
    assert.equal(p.card.theme, 'modern-inline')
    assert.equal(p.card.thumbnail, 'https://share.example/brand/mark-180.png')
    assert.equal(p.buttons[0].action.data.web.startsWith('https://share.example/#'), true)
  }
  const first = t.posts.find((p) => p.card.title === 'Your client has downloaded it')
  assert.match(first.text, /\*Lot a\* was downloaded on /)
  const soon = t.posts.find((p) => p.card.title.startsWith('Closes in'))
  assert.match(soon.text, /Not downloaded yet/)
  assert.deepEqual(JSON.parse(await fsp.readFile(join(t.store, ID3, 'notices.json'), 'utf8')).firstDownload, -1, 'old download recorded, not announced')
  // a second sweep sends nothing new
  assert.equal(await t.notices.sweep(NOW + 60_000), 0)
  assert.equal(t.posts.length, 2)
})

test('only the share PC sends, only with Cliq and notices on', async () => {
  const t = await setup()
  await t.put(ID1, manifest(ID1), stats(1, NOW - 60_000))
  t.ctx.me.host = 'WS-001'
  assert.equal(await t.notices.sweep(NOW), 0)
  t.ctx.me.host = 'WS-026'
  t.ctx.office.cliq.linkNotices = false
  assert.equal(await t.notices.sweep(NOW), 0)
  t.ctx.office.cliq.linkNotices = undefined
  t.ctx.office.cliq.enabled = false
  assert.equal(await t.notices.sweep(NOW), 0)
  assert.equal(t.posts.length, 0)
})

test('a failed post is retried, then given up after six tries', async () => {
  const t = await setup()
  await t.put(ID1, manifest(ID1), stats(1, NOW - 60_000))
  let calls = 0
  globalThis.fetch = async () => (calls++, new Response('down', { status: 503 }))
  for (let i = 0; i < 7; i++) await t.notices.sweep(NOW + i * 1000)
  assert.equal(calls, 6)
  assert.equal(JSON.parse(await fsp.readFile(join(t.store, ID1, 'notices.json'), 'utf8')).firstDownload, -2)
})

test('short links warn at a third of their life, and the text counts downloads', () => {
  const m = manifest(ID1, { createdAt: NOW, expiresAt: NOW + 24 * HOUR })
  const n = linkNotice('expiring', m, stats(2, NOW + HOUR), 'https://x/#id', 'https://x/', NOW + 17 * HOUR)
  assert.equal(n.title, 'Closes in 7 hours')
  assert.match(n.text, /Downloaded 2 times, last on /)
})
