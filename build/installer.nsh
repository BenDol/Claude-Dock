; Custom NSIS macros for Claude Dock installer
; electron-builder calls these at the appropriate lifecycle points

!macro customInstall
  ; Write telemetry pre-consent flag — the app reads this on first launch
  ; and auto-enables anonymous usage telemetry (skipping the consent prompt)
  WriteRegStr HKCU "Software\ClaudeDock" "TelemetryConsent" "1"
!macroend

!macro customUnInstall
  ; Remove "Open with Claude Dock" context menu entries from the registry
  ; These are under HKCU so no admin rights needed
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeDock"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeDock"

  ; Remove IExplorerCommand COM handler registration
  DeleteRegKey HKCU "Software\Classes\CLSID\{E94B2C47-5F3A-4A8D-B6D1-7C2E8F9A0B3D}"

  ; Remove Claude Dock metadata key (stores ExePath for the COM DLL)
  DeleteRegKey HKCU "Software\ClaudeDock"
!macroend
