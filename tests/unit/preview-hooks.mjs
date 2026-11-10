// Resolve hook shared by the preview tests: the engine sources are TypeScript with bundler-style
// imports, so "@shared/*" and extensionless relative imports are mapped to .ts files.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

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

export const load = (p) => import(pathToFileURL(join(ROOT, 'src', p)).href)
