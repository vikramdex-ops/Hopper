// RPC surface of the office tools: PDF toolkit, folder templates, lot packager, revision rules.
// Long operations return a job id; progress and results arrive through the job queue.
import type { FolderTemplate, RevisionRules } from '@shared/types'
import type { EngineCtx } from './index'
import * as templates from './office/templates'
import { officeOf } from './office/util'
import type { PackageSpec, RotateDegrees, SplitMode, TemplateVars } from './office/types'

// pdf-lib and exceljs are large; load them the first time a PDF or package job needs them,
// so the engine starts fast and stays small when these tools are not used.
const pdfMod = () => import('./office/pdf')
const pkgMod = () => import('./office/packager')

export function officeHandlers(ctx: EngineCtx) {
  return {
    'pdf.info': async (path: string) => (await pdfMod()).info(path),
    'pdf.merge': async (paths: string[], out: string) => (await pdfMod()).merge(ctx, paths, out),
    'pdf.split': async (path: string, mode: SplitMode, ranges: string, outDir: string) => (await pdfMod()).split(ctx, path, mode, ranges ?? '', outDir),
    'pdf.extract': async (path: string, pages: number[], out: string) => (await pdfMod()).extract(ctx, path, pages, out),
    'pdf.rotate': async (path: string, pages: number[] | 'all', degrees: RotateDegrees, out: string) => (await pdfMod()).rotate(ctx, path, pages, degrees, out),
    'pdf.reorder': async (path: string, order: number[], out: string) => (await pdfMod()).reorder(ctx, path, order, out),
    'templates.list': () => templates.list(ctx),
    'templates.create': (template: string | FolderTemplate, destDir: string, vars?: TemplateVars) => templates.create(ctx, template, destDir, vars ?? {}),
    'package.plan': async (spec: Partial<PackageSpec> & { files: string[] }) => (await pkgMod()).plan(ctx, spec),
    'package.run': async (spec: PackageSpec) => (await pkgMod()).run(ctx, spec),
    'revisions.rules': (): RevisionRules => officeOf(ctx).revisions
  }
}
