// Compiles native/HopperShell.cs with the .NET Framework 4.8 compiler that ships with Windows.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const windir = process.env.WINDIR || 'C:\\Windows'
const fw = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
const csc = join(fw, 'csc.exe')
if (!existsSync(csc)) {
  console.error(`csc.exe not found at ${csc}`)
  process.exit(1)
}
const out = join(root, 'native', 'bin')
mkdirSync(out, { recursive: true })
const refs = ['System.Web.Extensions.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll'].map((r) => `/r:${join(fw, r)}`)
execFileSync(
  csc,
  ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', `/out:${join(out, 'HopperShell.exe')}`, ...refs, ...readdirSync(join(root, 'native')).filter((f) => f.endsWith('.cs')).map((f) => join(root, 'native', f))],
  { stdio: 'inherit' }
)
// Memory diet: workstation GC without the concurrent background collector - these helpers are
// small request/response processes, and the background GC thread and its reserve cost every one of them.
writeFileSync(
  join(out, 'HopperShell.exe.config'),
  '<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n  <runtime>\n    <gcConcurrent enabled="false"/>\n    <gcServer enabled="false"/>\n  </runtime>\n  <startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup>\n</configuration>\n'
)
// The build bakes this hash into the app (electron.vite.config.ts): "File unlock on this server"
// copies the helper to Program Files and checks the copy against it before the elevated task uses it.
const sha = createHash('sha256').update(readFileSync(join(out, 'HopperShell.exe'))).digest('hex')
writeFileSync(join(out, 'HopperShell.exe.sha256'), `${sha}\n`)
console.log(`built native/bin/HopperShell.exe (sha256 ${sha.slice(0, 12)}…)`)
