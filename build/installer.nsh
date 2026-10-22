; electron-builder NSIS hooks for Xplorer² Modern
; Undo the per-user "open folders with this app" registration on uninstall so
; double-clicking a folder never points at a removed executable.

!include LogicLib.nsh

!macro customUnInstall
  ; Restore the effective default verb to Windows only when ours is still in
  ; place — never overwrite a change made later by the user or another app.
  StrCpy $1 "$INSTDIR\Xplorer2 Modern.exe"

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
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Xplorer2Modern"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Xplorer2Modern"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\Xplorer2Modern"

  ; ShellExecute("Xplorer2 Modern.exe") App Paths entry created alongside.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\Xplorer2 Modern.exe"
!macroend
