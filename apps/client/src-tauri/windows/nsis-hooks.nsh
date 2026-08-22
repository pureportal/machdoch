!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Machdoch" "" "Open in machdoch"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Machdoch" "Icon" "$INSTDIR\machdoch.exe"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\Machdoch\command" "" '"$INSTDIR\machdoch.exe" --ui --machdoch-open-folder "%1"'

  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Machdoch" "" "Open in machdoch"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Machdoch" "Icon" "$INSTDIR\machdoch.exe"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\Machdoch\command" "" '"$INSTDIR\machdoch.exe" --ui --machdoch-open-folder "%V"'

  WriteRegStr SHCTX "Software\Classes\Drive\shell\Machdoch" "" "Open in machdoch"
  WriteRegStr SHCTX "Software\Classes\Drive\shell\Machdoch" "Icon" "$INSTDIR\machdoch.exe"
  WriteRegStr SHCTX "Software\Classes\Drive\shell\Machdoch\command" "" '"$INSTDIR\machdoch.exe" --ui --machdoch-open-folder "%1"'

  WriteRegStr SHCTX "Software\Classes\*\shell\Machdoch" "" "Attach to machdoch"
  WriteRegStr SHCTX "Software\Classes\*\shell\Machdoch" "Icon" "$INSTDIR\machdoch.exe"
  WriteRegStr SHCTX "Software\Classes\*\shell\Machdoch" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "Software\Classes\*\shell\Machdoch\command" "" '"$INSTDIR\machdoch.exe" --ui --machdoch-attach-files %*'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\Machdoch"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\Machdoch"
  DeleteRegKey SHCTX "Software\Classes\Drive\shell\Machdoch"
  DeleteRegKey SHCTX "Software\Classes\*\shell\Machdoch"
!macroend
