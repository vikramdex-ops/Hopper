# Dexterity Share - stop and remove the scheduled task. Files, logs and the store are left alone.
# (c) Dexterity Design Services Private Limited. Internal software.
#   powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1     (elevated)
param([string]$TaskName = 'Dexterity Share')
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed the scheduled task '$TaskName'."
} else {
  Write-Host "No scheduled task named '$TaskName' was found."
}

# Stopping the task ends the supervisor; the share server notices within seconds and exits by itself.
# A tunnel process the supervisor started may be left over: end it, but only if it really is cloudflared.
$pidFile = Join-Path $here 'state\cloudflared.pid'
if (Test-Path $pidFile) {
  $id = [int](Get-Content $pidFile -Raw)
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -like 'cloudflared*') { Stop-Process -Id $id -Force; Write-Host 'Stopped the tunnel process.' }
  Remove-Item $pidFile -Force
}
Write-Host 'Client links stop working now. To remove everything, delete this folder; delete the store folder only if no link is still needed.'
