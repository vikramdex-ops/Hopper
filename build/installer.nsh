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

  !ifndef BUILD_UNINSTALLER
    ; Next, electron-builder runs the OLD version's uninstaller and retries it 5 times before
    ; showing "Hopper cannot be closed" (Retry/Cancel) - even when nothing is running, because
    ; uninstallers up to 2.8.0 abort when any single file in the folder cannot be moved aside
    ; at that instant (antivirus or the search indexer scanning a file, Explorer reading the icon).
    ; Swap in this version's uninstaller, whose file removal never aborts (customRemoveFiles).
    ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      ClearErrors
      File "/oname=$INSTDIR\${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
      ${If} ${Errors}
        DetailPrint `Could not refresh the old uninstaller; using it as is.`
        ClearErrors
      ${EndIf}
    ${EndIf}
  !endif
!macroend

; Remove the installed files without electron-builder's all-or-nothing rename step, which aborts
; the whole uninstall (and so the upgrade) when one file is briefly held by another program.
; Whatever cannot be deleted now is overwritten by the installer that follows.
!macro customRemoveFiles
  SetOutPath $TEMP
  StrCpy $R8 0
  ${Do}
    ClearErrors
    RMDir /r $INSTDIR
    ${IfNot} ${FileExists} "$INSTDIR\*.*"
      ${Break}
    ${EndIf}
    IntOp $R8 $R8 + 1
    ${If} $R8 >= 3
      DetailPrint `Some files in $INSTDIR are in use; they will be replaced by the update.`
      ${Break}
    ${EndIf}
    Sleep 1000
  ${Loop}
  ClearErrors
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
  ; An update runs the old uninstaller first: keep the folder, Win+E and notification
  ; registrations, which point at the same Hopper.exe the update writes back.
  ${IfNot} ${isUpdated}
    !insertmacro hopperUnregister
  ${EndIf}
!macroend

!macro hopperUnregister
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

  ; Win+E, when it still starts this Hopper.
  ReadRegStr $0 HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command" ""
  ${If} $0 == '"$1"'
    DeleteRegKey HKCU "Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow"
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
