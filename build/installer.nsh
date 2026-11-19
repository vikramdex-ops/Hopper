; electron-builder NSIS hooks for Hopper
; Undo the per-user "open folders with this app" registration on uninstall so
; double-clicking a folder never points at a removed executable.

!include LogicLib.nsh

; ---------------------------------------------------------------------------
; Closing Hopper before install / uninstall.
; electron-builder's default check finds ANY process running from the install folder but
; only kills Hopper.exe, so a lingering HopperShell.exe or 7z.exe made the old uninstaller
; abort ("Failed to uninstall old application files ... : 2"). close-hopper.ps1 closes every
; process from the folder (politely, then by force) and waits until none is left.
!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "HOPPER_INSTDIR", t "$INSTDIR")i'
  InitPluginsDir
  File "/oname=$PLUGINSDIR\close-hopper.ps1" "${BUILD_RESOURCES_DIR}\close-hopper.ps1"
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-hopper.ps1"`
  Pop $0
  ${If} $0 != 0
    ; PowerShell unavailable or blocked by policy: fall back to taskkill by name (this user only).
    ExpandEnvStrings $1 "%USERNAME%"
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /FI "USERNAME eq $1" /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $0
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /FI "USERNAME eq $1" /IM "HopperShell.exe"`
    Pop $0
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /FI "USERNAME eq $1" /IM "7z.exe"`
    Pop $0
    Sleep 1500
  ${EndIf}
!macroend

; The old version's uninstaller failing must never stop the upgrade: everything from the old
; folder is closed above, and the new files are written over the old ones.
!macro customUnInstallCheck
  ${If} $R0 != 0
    DetailPrint `Old version's uninstaller returned $R0; installing over it.`
  ${EndIf}
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend

!macro customUnInstall
  ; Restore the effective default verb to Windows only when ours is still in
  ; place — never overwrite a change made later by the user or another app.
  StrCpy $1 "$INSTDIR\Hopper.exe"

  ReadRegStr $0 HKCU "Software\Classes\Directory\shell\open\command" ""
  StrCpy $2 '"$1" --open "%1"'
  ${If} $0 == $2
    DeleteRegKey HKCU "Software\Classes\Directory\shell\open"
    DeleteRegValue HKCU "Software\Classes\Directory\shell" ""
  ${EndIf}

  ReadRegStr $0 HKCU "Software\Classes\Drive\shell\open\command" ""
  StrCpy $2 '"$1" --open "%1"'
  ${If} $0 == $2
    DeleteRegKey HKCU "Software\Classes\Drive\shell\open"
    DeleteRegValue HKCU "Software\Classes\Drive\shell" ""
  ${EndIf}

  ; Our own verb is always safe to remove.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Hopper"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Hopper"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\Hopper"

  ; Notification name/icon registration written by Hopper at startup.
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.dexterity.hopper"

  ; ShellExecute("Hopper.exe") App Paths entry created alongside.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\Hopper.exe"
!macroend


!macro customInstall
  ; LAN sharing listens on TCP 47821 and UDP 47820. A per-user install cannot add
  ; firewall rules; Hopper offers "Allow through firewall" in Settings > Sharing,
  ; which asks for elevation once.
!macroend
