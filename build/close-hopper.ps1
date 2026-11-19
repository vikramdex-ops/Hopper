# Run by the installer and uninstaller before files are replaced or removed.
# Closes every process started from the Hopper install folder (Hopper.exe and its
# helpers: HopperShell.exe, 7z.exe), first politely, then by force, and waits until
# none is left. Exit 0 = nothing from the folder is running; 1 = something survived.
# The folder comes from the HOPPER_INSTDIR environment variable set by the installer.
$ErrorActionPreference = 'SilentlyContinue'
$dir = $env:HOPPER_INSTDIR
if (-not $dir) { exit 1 }
$dir = $dir.TrimEnd('\') + '\'

function Get-Ours {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }
}
function Wait-Gone([int]$ms) {
  $end = [DateTime]::UtcNow.AddMilliseconds($ms)
  while ([DateTime]::UtcNow -lt $end) {
    if (-not (Get-Ours)) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return -not (Get-Ours)
}

if (-not (Get-Ours)) { exit 0 }

# 1. Politely: ask windows to close so Hopper can save its settings and say goodbye on the LAN.
foreach ($p in Get-Ours) { (Get-Process -Id $p.ProcessId).CloseMainWindow() | Out-Null }
if (Wait-Gone 6000) { exit 0 }

# 2. By force: everything still running from the folder, helpers included.
foreach ($p in Get-Ours) { Stop-Process -Id $p.ProcessId -Force }
if (Wait-Gone 10000) { exit 0 }

# 3. Last try with taskkill (process trees), then report.
foreach ($p in Get-Ours) { & "$env:SystemRoot\System32\taskkill.exe" /F /T /PID $p.ProcessId | Out-Null }
if (Wait-Gone 5000) { exit 0 }
exit 1
