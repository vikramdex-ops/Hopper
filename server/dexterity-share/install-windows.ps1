# Dexterity Share - install on Windows as a scheduled task that starts with the machine
# (no user needs to be logged on) and restarts itself if it ever stops.
# (c) Dexterity Design Services Private Limited. Internal software.
#
# Run from an elevated PowerShell in this folder, after config.json is filled in:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
# Options:
#   -RunAs LocalService   (default) a built-in low-privilege account; the script grants it the folders it needs
#   -RunAs System         use only if LocalService cannot reach the store (see the IT guide, Troubleshooting)
#   -Node "C:\Program Files\nodejs\node.exe"   if node.exe is not on PATH
param(
  [string]$Node = '',
  [ValidateSet('LocalService', 'System')][string]$RunAs = 'LocalService',
  [string]$TaskName = 'Dexterity Share'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$message) { Write-Host "STOP: $message" -ForegroundColor Red; exit 1 }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Open PowerShell with "Run as administrator" and run this script again.'
}

if (-not $Node) { $cmd = Get-Command node.exe -ErrorAction SilentlyContinue; if ($cmd) { $Node = $cmd.Source } }
if (-not $Node -or -not (Test-Path $Node)) { Fail 'node.exe was not found. Install Node.js 20 LTS or newer (nodejs.org), or pass -Node "C:\path\to\node.exe".' }
$major = [int]((& $Node --version) -replace '^v(\d+)\..*$', '$1')
if ($major -lt 20) { Fail "Node.js $major is too old. Version 20 or newer is needed." }

$configFile = Join-Path $here 'config.json'
if (-not (Test-Path $configFile)) { Fail 'config.json is missing. Copy config.example.json to config.json and fill it in first.' }
$config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$server = if ($config.server) { $config.server } else { $config }
$store = $server.store
if (-not $store -or -not (Test-Path $store)) { Fail "The store folder in config.json does not exist: $store" }
$state = if ($server.stateDir) { $server.stateDir } else { Join-Path $here 'state' }
$logs = if ($server.logDir) { $server.logDir } else { Join-Path $here 'logs' }
if (-not [IO.Path]::IsPathRooted($state)) { $state = Join-Path $here $state }
if (-not [IO.Path]::IsPathRooted($logs)) { $logs = Join-Path $here $logs }
New-Item -ItemType Directory -Force -Path $state, $logs | Out-Null

Write-Host 'Checking the configuration...'
& $Node (Join-Path $here 'supervisor.mjs') --check
Write-Host '(A FAIL on the port line is expected if the service is already running.)'
$answer = Read-Host 'Continue with the installation? (y/n)'
if ($answer -notmatch '^[yY]') { exit 0 }

if ($RunAs -eq 'LocalService') {
  $account = 'NT AUTHORITY\LOCAL SERVICE'
  # read+execute on the program folder; modify on the store (statistics, clean-up), state and logs
  & icacls $here /grant "${account}:(OI)(CI)RX" /T /Q | Out-Null
  & icacls $state /grant "${account}:(OI)(CI)M" /T /Q | Out-Null
  & icacls $logs /grant "${account}:(OI)(CI)M" /T /Q | Out-Null
  & icacls $store /grant "${account}:(OI)(CI)M" /Q | Out-Null
  $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited
} else {
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}
# The tokens in this folder are secrets: ordinary users of this machine must not read them.
foreach ($secret in 'pointer-token.txt', 'tunnel-token.txt') {
  $file = Join-Path $here $secret
  if (Test-Path $file) {
    & icacls $file /inheritance:r /grant:r 'BUILTIN\Administrators:F' 'NT AUTHORITY\SYSTEM:F' /Q | Out-Null
    if ($RunAs -eq 'LocalService') { & icacls $file /grant 'NT AUTHORITY\LOCAL SERVICE:R' /Q | Out-Null }
  }
}
# state\ holds secret.key (signs unlock tokens: whoever reads it skips every link password) and
# pointer-key.pem (signs the server address). Node's file modes mean nothing on Windows, so the
# folder itself is closed: no inherited "Users: read", only the service, SYSTEM and Administrators.
$stateOwner = if ($RunAs -eq 'LocalService') { 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M' } else { 'NT AUTHORITY\SYSTEM:(OI)(CI)F' }
& icacls $state /inheritance:r /grant:r 'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\SYSTEM:(OI)(CI)F' $stateOwner /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Could not restrict access to $state (icacls exit $LASTEXITCODE)." }

$action = New-ScheduledTaskAction -Execute $Node -Argument '--no-warnings supervisor.mjs' -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Dexterity Share: client download server and its tunnel (Dexterity Design Services).' | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host 'Started. Waiting for the server...'
$port = if ($server.port) { $server.port } else { 47880 }
$up = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 2
  try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3; if ($r.ok) { $up = $true; break } } catch {}
}
if ($up) {
  Write-Host "OK: the share server answers on 127.0.0.1:$port." -ForegroundColor Green
  Write-Host "Next: look at $logs\supervisor.log for the line 'public-address-verified' (the tunnel is up),"
  Write-Host "and at _server.json in the store, which Hopper reads to show 'Share server online'."
} else {
  Write-Host "The server did not answer yet. Check $logs\supervisor.log and the task's 'Last Run Result' in Task Scheduler." -ForegroundColor Yellow
}
