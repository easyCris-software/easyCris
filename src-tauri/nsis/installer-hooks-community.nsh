!macro NSIS_HOOK_PREINSTALL
  SetDetailsPrint none
  SetDetailsView hide
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetDetailsPrint none
  SetDetailsView hide

  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
    ${IfNot} ${Silent}
      IfFileExists "$INSTDIR\_up_\scripts\install_url_scheme.ps1" 0 easycris_url_skip_unregister
      DetailPrint "Removing easyCris remote invite link registration..."
      ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\_up_\scripts\install_url_scheme.ps1" -Action Unregister -InstallDir "$INSTDIR"' $8
      easycris_url_skip_unregister:
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
    ${IfNot} ${Silent}
      IfFileExists "$INSTDIR\_up_\scripts\install_url_scheme.ps1" 0 easycris_url_missing_register
      DetailPrint "Registering easyCris remote invite links..."
      ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\_up_\scripts\install_url_scheme.ps1" -Action Register -InstallDir "$INSTDIR"' $8
      ${If} $8 != 0
        DetailPrint "easyCris remote invite link registration failed. Links can still be pasted into Preferences > Remote."
      ${EndIf}
      Goto easycris_url_done_register
      easycris_url_missing_register:
        DetailPrint "easyCris remote invite link registration files were not found."
      easycris_url_done_register:
    ${EndIf}
  ${EndIf}
!macroend
