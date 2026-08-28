; Folio owns both of these per-user directories:
; - %APPDATA%\com.folio.reader: books, reading state, logs, audio cache, and models
; - %LOCALAPPDATA%\com.folio.reader: the Tauri/WebView2 local profile
;
; Tauri's stock uninstaller only removes these directories when its optional
; "Delete app data" checkbox is selected. Folio promises a full uninstall, so
; remove its private data unconditionally after the stock uninstall completes.
!macro NSIS_HOOK_POSTUNINSTALL
  ; /UPDATE is used by the Tauri updater and must preserve the app/data tree.
  ${If} $UpdateMode <> 1
    SetShellVarContext current

    ; Remove any files left in the install directory by an older or overlay
    ; installation, including files not known to the current manifest.
    RMDir /r "$INSTDIR"

    ; Remove Folio's roaming data and the Tauri/WebView2 local profile.
    RMDir /r "$APPDATA\com.folio.reader"
    RMDir /r "$LOCALAPPDATA\com.folio.reader"

    ; Remove shortcuts even when a previous install wrote a stale target.
    Delete "$SMPROGRAMS\Folio.lnk"
    Delete "$SMPROGRAMS\Folio\Folio.lnk"
    RMDir "$SMPROGRAMS\Folio"
    Delete "$DESKTOP\Folio.lnk"

    ; Clear the install-location metadata that the stock uninstaller only
    ; clears when the optional data checkbox is selected.
    DeleteRegValue HKCU "Software\Folio\Folio" "Installer Language"
    DeleteRegKey HKCU "Software\Folio\Folio"
    DeleteRegKey /ifempty HKCU "Software\Folio"
  ${EndIf}
!macroend
