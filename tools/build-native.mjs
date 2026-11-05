// Compiles native/HopperShell.cs with the .NET Framework 4.8 compiler that ships with Windows.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
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
  ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', `/out:${join(out, 'HopperShell.exe')}`, ...refs, join(root, 'native', 'HopperShell.cs')],
  { stdio: 'inherit' }
)
console.log('built native/bin/HopperShell.exe')
