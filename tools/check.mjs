#!/usr/bin/env node
// Static checks that run before every build.
//   node tools/check.mjs
// - parses every renderer module as ESM and every Electron file as CJS
// - verifies icon names referenced from markup/JS exist in the icon set
// - verifies the shell only references files that exist
// - rejects leftover emoji glyphs in the UI sources
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x2check-'));

function checkSyntax(file, asModule) {
  let target = file;
  if (asModule) {
    target = path.join(tmp, path.basename(file, '.js') + '.mjs');
    fs.copyFileSync(file, target);
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (r.status !== 0) failures.push(`${path.relative(ROOT, file)}: ${(r.stderr || '').split('\n').slice(0, 4).join(' ').trim()}`);
}

const rendererDir = path.join(ROOT, 'src', 'js');
const renderer = fs.readdirSync(rendererDir).filter(f => f.endsWith('.js')).map(f => path.join(rendererDir, f));
const electronDir = path.join(ROOT, 'electron');
const mainFiles = fs.readdirSync(electronDir).filter(f => f.endsWith('.js')).map(f => path.join(electronDir, f));
for (const f of renderer) checkSyntax(f, true);
for (const f of mainFiles) checkSyntax(f, false);

// icon names declared in icons.js
const iconSrc = fs.readFileSync(path.join(rendererDir, 'icons.js'), 'utf8');
const iconNames = new Set([...iconSrc.matchAll(/^\s*'([a-z0-9-]+)':/gm)].map(m => m[1]));
const sources = [
  ...renderer.map(f => ({ f, text: fs.readFileSync(f, 'utf8') })),
  { f: path.join(ROOT, 'src', 'index.html'), text: fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8') }
];
for (const { f, text } of sources) {
  const used = new Set();
  for (const m of text.matchAll(/data-icon="([a-z0-9-]+)"/g)) used.add(m[1]);
  for (const m of text.matchAll(/icon\(\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
  for (const m of text.matchAll(/icon:\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
  for (const m of text.matchAll(/iconHTML\(\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
  for (const name of used) {
    if (!iconNames.has(name)) failures.push(`${path.relative(ROOT, f)}: unknown icon "${name}"`);
  }
}

// emoji leftovers in UI sources
const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
for (const { f, text } of sources) {
  const hit = text.match(emojiRe);
  if (hit) failures.push(`${path.relative(ROOT, f)}: emoji glyph "${hit[0]}" — use icons.js instead`);
}

// shell references
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^(https?:|data:|x2file:)/.test(ref)) continue;
  if (!fs.existsSync(path.join(ROOT, 'src', ref))) failures.push(`src/index.html: missing ${ref}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error('check failed:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`check ok: ${renderer.length} renderer modules, ${mainFiles.length} electron files, ${iconNames.size} icons`);
