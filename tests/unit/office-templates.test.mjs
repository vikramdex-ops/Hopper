// Structured folder templates: conditions, repeats, numbering, sub-project layouts, path-length and
// existing-folder handling, back-compat with simple templates, and the undo record. Real folders in a temp dir.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { existsSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
registerHooks({
  resolve(spec, context, next) {
    const parent = context.parentURL ?? ''
    if (spec.startsWith('@shared/')) return next(pathToFileURL(join(ROOT, 'src/shared', spec.slice(8) + '.ts')).href, context)
    if (parent.endsWith('.ts') && /^\.\.?\//.test(spec) && !extname(spec)) {
      const file = fileURLToPath(new URL(spec + '.ts', parent))
      if (existsSync(file)) return next(pathToFileURL(file).href, context)
    }
    return next(spec, context)
  }
})

const templates = await import('../../src/engine/office/templates.ts')
const model = await import('../../src/shared/template-model.ts')
const { PROJECT_TEMPLATE, ISSUE_PACK_TEMPLATE } = await import('../../src/shared/project-template.ts')
const { defaultOffice } = await import('../../src/shared/defaults.ts')

let dir
const undo = []
const ctx = { office: { ...defaultOffice() }, undo: { record: (r) => undo.push(r) } }
const names = (e) => e.folders.map((f) => f.join('/'))

before(async () => {
  dir = await fsp.mkdtemp(join(process.env.HOPPER_TEST_TMP || tmpdir(), 'hopper-tpl-'))
})
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const tiny = (tree, inputs = [], extra = {}) => ({ id: 'x', name: 'x', folders: [], inputs, tree, ...extra })

test('numbers are assigned after conditional folders drop out: no gaps, optional padding', () => {
  const t = tiny(
    [{ name: 'Alpha' }, { name: 'Beta', when: 'b' }, { name: 'Gamma', children: [{ name: 'One' }, { name: 'Two', number: false }, { name: 'Three' }] }],
    [{ id: 'b', label: 'B', kind: 'flag' }]
  )
  assert.deepEqual(names(model.expandTree(t, { b: false })), ['0- Alpha', '1- Gamma', '1- Gamma/0- One', '1- Gamma/Two', '1- Gamma/1- Three'])
  assert.deepEqual(names(model.expandTree(t, { b: true })).slice(0, 3), ['0- Alpha', '1- Beta', '2- Gamma'])
  assert.equal(names(model.expandTree(t, { $pad: '2' }))[0], '00- Alpha')
  assert.equal(names(model.expandTree({ ...t, numbering: { start: 1, sep: '_', pad: '2' } }, {}))[0], '01_Alpha')
  assert.equal(names(model.expandTree({ ...t, numbering: { auto: false } }, {}))[0], 'Alpha')
})

test('each repeats over lists and sub-projects; when sees the item; areas expand ranges', () => {
  const t = tiny(
    [
      { name: 'Disc', children: [{ each: 'disc', name: '{item}', when: "item != 'Stress'" }] },
      { name: 'Units', children: [{ each: 'subs', name: '{sub}', children: [{ each: 'areas', name: '{area}' }] }] }
    ],
    [
      { id: 'disc', label: 'Disciplines', kind: 'multi', options: ['Piping', 'Stress', 'Civil'] },
      { id: 'subs', label: 'Subs', kind: 'subs' }
    ]
  )
  const e = model.expandTree(t, { disc: ['Piping', 'Stress', 'Civil'], subs: [{ label: 'A', unit: 'U1', areas: 'Skid-01..03' }, { label: 'B', areas: 'IC' }] })
  assert.deepEqual(e.errors, [])
  assert.deepEqual(names(e), [
    '0- Disc', '0- Disc/Piping', '0- Disc/Civil',
    '1- Units', '1- Units/A (U1)', '1- Units/A (U1)/Skid-01', '1- Units/A (U1)/Skid-02', '1- Units/A (U1)/Skid-03', '1- Units/B', '1- Units/B/IC'
  ])
  assert.deepEqual(model.splitList('Interconnection, Skid-1..3; X'), ['Interconnection', 'Skid-1', 'Skid-2', 'Skid-3', 'X'])
})

test('conditions: tiny parser, no evaluation of code', () => {
  const get = (id) => ({ subs: 2, d: ['Piping', 'Civil & Structural'], type: 'As-built', f: true, e: '' })[id]
  assert.equal(model.evalCond("subs >= 2 and d has 'piping'", get), true)
  assert.equal(model.evalCond("type in ['Detail design', 'As-built'] and not e", get), true)
  assert.equal(model.evalCond("(f or e) and type != 'As-built'", get), false)
  assert.equal(model.evalCond('subs == 2', get), true)
  assert.throws(() => model.parseCond('subs >= '), /missing/)
  assert.throws(() => model.parseCond('process.exit()'), /can't read|unexpected/)
  assert.throws(() => model.parseCond("a == b"), /quotes/)
  const bad = tiny([{ name: 'A', when: 'nosuch' }])
  assert.match(model.validateTemplate(bad).join(), /not an input/)
})

test('tokens: unknown tokens, illegal values and missing required values are reported', () => {
  assert.match(model.validateTemplate(tiny([{ name: '{nope}' }])).join(), /unknown token \{nope\}/)
  assert.match(model.validateTemplate(tiny([{ name: 'a/b' }])).join(), /single folder name/)
  assert.match(model.validateTemplate(tiny([{ name: 'A', use: undefined, each: 'x' }])).join(), /"each" must be/)
  assert.match(model.validateTemplate(tiny([{ use: 'loop' }], [], { blocks: { loop: [{ use: 'loop' }] } })).join(), /uses itself/)
  const e = model.expandTree(PROJECT_TEMPLATE, { job: 'J1', name: 'A/B' })
  assert.match(e.errors.join(), /Short name "A\/B" contains a character/)
  assert.match(model.expandTree(PROJECT_TEMPLATE, { name: 'X' }).errors.join(), /Fill in Job number/)
  // optional <…> groups drop when their token is empty
  assert.equal(model.expandTree(PROJECT_TEMPLATE, { job: 'J1', name: 'Plant', platform: 'None' }).top, 'J1-Plant')
  assert.equal(model.expandTree(PROJECT_TEMPLATE, { job: 'J129', name: 'FST', type: 'As-built', platform: 'PDS' }).top, 'J129-FST AS-BUILT-PDS')
  assert.equal(model.expandTree(PROJECT_TEMPLATE, { job: 'J1', name: 'P', $root: 'Custom name' }).top, 'Custom name')
  assert.match(model.expandTree(PROJECT_TEMPLATE, { job: 'J1', name: 'P', $root: 'bad:name' }).errors.join(), /not allow/)
})

test('built-in project: standalone has no sub-project folders and only the disciplines in scope', () => {
  const e = model.expandTree(PROJECT_TEMPLATE, { job: 'J1', name: 'Plant', disciplines: ['Piping'], platform: 'None' })
  assert.deepEqual(e.errors, [])
  const top = e.folders.filter((f) => f.length === 2).map((f) => f[1])
  assert.deepEqual(top, ['0- Documents from Client', '1- Procedures', '2- LE Folder', '3- Project Management', '4- Piping', '5- Technical Query Register', '6- Documents to Client'])
  assert.ok(!names(e).some((p) => /Superseeded|Techincal|STADD/i.test(p)))
  // numbering inside a level has no gaps or duplicates
  const kids = new Map()
  for (const f of e.folders) {
    const m = /^(\d+)- /.exec(f.at(-1))
    if (m) kids.set(f.slice(0, -1).join('/'), [...(kids.get(f.slice(0, -1).join('/')) ?? []), Number(m[1])])
  }
  for (const [, nums] of kids) assert.deepEqual(nums, nums.map((_, i) => i))
})

test('twin project: separate trees (default) and split inside each discipline', () => {
  const subs = [{ label: 'DE-OIL', unit: 'ME-102' }, { label: 'PW DE-OIL', unit: 'ME-301' }]
  const base = { job: 'J2', name: 'Twin', disciplines: ['Piping', 'Civil & Structural'], subs }
  const sep = names(model.expandTree(PROJECT_TEMPLATE, base))
  assert.ok(sep.includes('J2-Twin-S3D/4- DE-OIL (ME-102)/0- Piping/2- P&IDs'))
  assert.ok(sep.includes('J2-Twin-S3D/5- PW DE-OIL (ME-301)/2- Documents to Client/0- Piping'))
  assert.ok(sep.includes('J2-Twin-S3D/6- 3D CAD Admin/0- Daily Navis/PW DE-OIL (ME-301)'), 'the shared block splits per sub-project')
  assert.ok(!sep.some((p) => /P&IDs\/DE-OIL/.test(p)), 'no second split inside a sub-project tree')

  const inside = names(model.expandTree(PROJECT_TEMPLATE, { ...base, layout: 'Split inside each discipline' }))
  assert.ok(inside.includes('J2-Twin-S3D/4- Piping/2- P&IDs/DE-OIL (ME-102)'))
  assert.ok(inside.includes('J2-Twin-S3D/4- Piping/2- P&IDs/PW DE-OIL (ME-301)'))
  assert.ok(!inside.some((p) => /\/\d+- DE-OIL/.test(p)), 'no sub-project trees')
  // the same label everywhere
  const labels = new Set(inside.map((p) => p.split('/').at(-1)).filter((n) => /DE-OIL/.test(n)))
  assert.deepEqual([...labels].sort(), ['DE-OIL (ME-102)', 'PW DE-OIL (ME-301)'])
  // one sub-project is a standalone project
  const one = names(model.expandTree(PROJECT_TEMPLATE, { ...base, subs: [subs[0]] }))
  assert.ok(!one.some((p) => /DE-OIL/.test(p)))
  // the same label twice is reported once, not created twice
  const dup = model.expandTree(PROJECT_TEMPLATE, { ...base, subs: [subs[0], subs[0]] })
  assert.ok(dup.warnings.some((w) => w.kind === 'duplicate'))
})

test('path-length warning at the chosen destination', async () => {
  const short = await templates.preview(ctx, PROJECT_TEMPLATE, dir, { job: 'J1', name: 'P' })
  assert.ok(!short.warnings.some((w) => w.kind === 'long'))
  const deep = join(dir, 'x'.repeat(60), 'y'.repeat(60))
  await fsp.mkdir(deep, { recursive: true })
  const long = await templates.preview(ctx, PROJECT_TEMPLATE, deep, { job: 'J1', name: 'A rather long project short name', client: 'Client' })
  if (deep.length + 120 > 240) assert.ok(long.warnings.some((w) => w.kind === 'long'), JSON.stringify(long.warnings))
  assert.ok(long.longest > deep.length)
  assert.ok(model.expandTree(PROJECT_TEMPLATE, { job: 'J1', name: 'P' }, 200).warnings.some((w) => w.kind === 'long'))
})

test('create keeps existing folders, records undo of only what it made, refuses on errors', async () => {
  const dest = join(dir, 'proj')
  await fsp.mkdir(join(dest, 'J5-Plant-S3D', '1- Procedures'), { recursive: true })
  await fsp.writeFile(join(dest, 'J5-Plant-S3D', '1- Procedures', 'keep.txt'), 'mine')
  const inputs = { job: 'J5', name: 'Plant', disciplines: ['Piping'] }
  const p = await templates.preview(ctx, 'dexterity-project', dest, inputs)
  assert.deepEqual(p.errors, [])
  assert.equal(p.top, 'J5-Plant-S3D')
  assert.deepEqual(p.existing, ['J5-Plant-S3D', 'J5-Plant-S3D\\1- Procedures'])
  assert.ok(p.warnings.some((w) => w.kind === 'exists'))
  assert.equal(p.count, p.paths.length - 2)

  const n = undo.length
  const r = await templates.create(ctx, 'dexterity-project', dest, inputs)
  assert.equal(r.top, join(dest, 'J5-Plant-S3D'))
  assert.equal(r.created.length, p.count)
  assert.deepEqual(r.existing, [join(dest, 'J5-Plant-S3D'), join(dest, 'J5-Plant-S3D', '1- Procedures')])
  assert.equal(await fsp.readFile(join(dest, 'J5-Plant-S3D', '1- Procedures', 'keep.txt'), 'utf8'), 'mine')
  assert.ok(existsSync(join(dest, 'J5-Plant-S3D', '4- Piping', '2- P&IDs')))
  assert.equal(undo.length, n + 1)
  // the root existed, so undo lists each new top-level folder inside it, never the root or Procedures
  const pairs = undo.at(-1).pairs.map(([, b]) => b)
  assert.ok(pairs.includes(join(dest, 'J5-Plant-S3D', '4- Piping')))
  assert.ok(!pairs.includes(join(dest, 'J5-Plant-S3D')) && !pairs.some((x) => x.includes('Procedures')))

  const again = await templates.create(ctx, 'dexterity-project', dest, inputs)
  assert.equal(again.created.length, 0)
  assert.equal(undo.length, n + 1, 'nothing created, nothing to undo')
  await assert.rejects(templates.create(ctx, 'dexterity-project', dest, { job: 'J6' }), /Fill in Short name/)
  await assert.rejects(templates.create(ctx, 'dexterity-project', join(dest, 'nope'), inputs), /not a folder/)

  const fresh = await templates.create(ctx, 'dexterity-project', dest, { ...inputs, job: 'J7' })
  assert.deepEqual(undo.at(-1).pairs, [['', join(dest, 'J7-Plant-S3D')]])
  assert.equal(fresh.top, join(dest, 'J7-Plant-S3D'))
})

test('simple templates keep working through list, preview and create', async () => {
  const ids = templates.list(ctx).map((t) => t.id)
  assert.deepEqual(ids.slice(0, 3), ['dexterity-project', 'issue-pack', 'lot'])
  // a saved copy of the old shipped Project folder is superseded; an office template can replace a built-in
  const old = { id: 'project', name: 'Project folder', folders: ['01_Incoming', '02_Working', '03_Outgoing', '04_Transmittals', '05_References', '06_Correspondence'] }
  const mine = { ...PROJECT_TEMPLATE, name: 'Our project', builtin: undefined }
  const c2 = { ...ctx, office: { ...defaultOffice(), templates: [old, mine, { id: 'own', name: 'Own', folders: ['A/B'] }] } }
  assert.deepEqual(templates.list(c2).map((t) => t.name), ['Issue / submission pack', 'Our project', 'Own'])

  const dest = join(dir, 'simple')
  await fsp.mkdir(dest)
  const p = await templates.preview(ctx, 'lot', dest, { name: 'Lot 07' })
  assert.deepEqual(p.paths, ['Lot 07', 'Lot 07\\01_Received', 'Lot 07\\02_Checked', 'Lot 07\\03_Comments', 'Lot 07\\04_Issued'])
  const r = await templates.create(ctx, 'lot', dest, { name: 'Lot 07' })
  assert.equal(r.created.length, 5)
  assert.equal(r.top, join(dest, 'Lot 07'))
  assert.match((await templates.preview(ctx, 'lot', dest, {})).errors.join(), /needs a value for \{name\}/)
  assert.deepEqual(model.inputsOf(templates.list(ctx).find((t) => t.id === 'lot')).map((i) => i.id), ['name'])
})

test('issue pack: dated folder in the chosen format with a set per document', async () => {
  const e = model.expandTree(ISSUE_PACK_TEMPLATE, { date: '2026-09-08', docs: 'P1-15-1601\nP1-15-1602', contents: ['NATIVE', 'PDF', 'RLM'] })
  assert.deepEqual(e.errors, [])
  assert.deepEqual(names(e), ['Issued on 08-Sep-2026', 'Issued on 08-Sep-2026/P1-15-1601', 'Issued on 08-Sep-2026/P1-15-1601/NATIVE', 'Issued on 08-Sep-2026/P1-15-1601/PDF', 'Issued on 08-Sep-2026/P1-15-1601/RLM', 'Issued on 08-Sep-2026/P1-15-1602', 'Issued on 08-Sep-2026/P1-15-1602/NATIVE', 'Issued on 08-Sep-2026/P1-15-1602/PDF', 'Issued on 08-Sep-2026/P1-15-1602/RLM'])
  assert.equal(names(model.expandTree(ISSUE_PACK_TEMPLATE, { style: 'Batch-<n>_<date>', batch: '3', date: '2026-09-10', dateFormat: 'DD-MM-YYYY' }))[0], 'Batch-3_10-09-2026')
  assert.equal(names(model.expandTree(ISSUE_PACK_TEMPLATE, { date: '2026-09-10', dateFormat: 'YYYY-MM-DD' }))[0], 'Issued on 2026-09-10')
  assert.match(model.expandTree(ISSUE_PACK_TEMPLATE, { style: 'Batch-<n>_<date>' }).errors.join(), /Fill in Batch number/)
  assert.match(model.expandTree(ISSUE_PACK_TEMPLATE, { docs: 'A/B' }).errors.join(), /not allow/)
  const dest = join(dir, 'issue')
  await fsp.mkdir(dest)
  const r = await templates.create(ctx, 'issue-pack', dest, { date: '2026-09-08', docs: 'D1' })
  assert.equal(r.top, join(dest, 'Issued on 08-Sep-2026'))
  assert.ok(existsSync(join(dest, 'Issued on 08-Sep-2026', 'D1', 'CHECK PRINT')))
})

test('every built-in template validates', () => {
  for (const t of templates.list(ctx)) assert.deepEqual(model.validateTemplate(t), [], t.name)
})
