// Lets the Dexterity Share tests import Hopper's TypeScript sources directly (Node type stripping):
// resolves the "@shared/" alias and extension-less relative imports the way the bundler does.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Scratch folder for the tests: the office work drive when it exists (never C:), else the system temp folder (CI). */
const OFFICE_WORK = '<work-folder>/_Claude_Work/temp'
export const TEST_WORK = process.env.DXSHARE_TEST_WORK || (existsSync(OFFICE_WORK) ? join(OFFICE_WORK, 'share-agent') : join(tmpdir(), 'dxshare-test'))

const shared = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'shared')

registerHooks({
  resolve(specifier, context, next) {
    let file = null
    if (specifier.startsWith('@shared/')) file = join(shared, specifier.slice(8))
    else if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) file = join(dirname(fileURLToPath(context.parentURL)), specifier)
    if (file) {
      for (const c of [file + '.ts', join(file, 'index.ts'), file]) {
        if (existsSync(c) && !c.endsWith('\\') && c !== file) return next(pathToFileURL(c).href, context)
      }
    }
    return next(specifier, context)
  }
})
