; electron-builder NSIS hooks for Hopper
; Undo the per-user "open folders with this app" registration on uninstall so
; double-clicking a folder never points at a removed executable.

!include LogicLib.nsh

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
