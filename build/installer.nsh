; Custom NSIS macros for Claude Dock installer.
;
; Profile-aware: identifiers are selected by comparing ${PRODUCT_NAME} so that
; UAT ("Claude Dock") and Prod ("Claude Dock Stable") install / uninstall
; without touching each other's registry state.

!if "${PRODUCT_NAME}" == "Claude Dock"
  !define SHELL_ID "ClaudeDock"
  !define COM_CLSID "{E94B2C47-5F3A-4A8D-B6D1-7C2E8F9A0B3D}"
!else if "${PRODUCT_NAME}" == "Claude Dock Stable"
  !define SHELL_ID "ClaudeDockStable"
  !define COM_CLSID "{E94B2C47-5F3A-4A8D-B6D1-7C2E8F9A0B3E}"
!else
  ; Unknown product name — use a best-effort fallback so the install doesn't
  ; wedge. The running app will still pick its own correct registry paths
  ; based on the baked-in DOCK_ENV_PROFILE.
  !define SHELL_ID "ClaudeDockUnknown"
  !define COM_CLSID "{E94B2C47-5F3A-4A8D-B6D1-7C2E8F9A0B3F}"
!endif

!macro customInstall
  ; Write telemetry pre-consent flag — the app reads this on first launch
  ; and auto-enables anonymous usage telemetry (skipping the consent prompt).
  WriteRegStr HKCU "Software\${SHELL_ID}" "TelemetryConsent" "1"
!macroend

!macro customUnInstall
  ; Remove "Open with ${PRODUCT_NAME}" context menu entries from the registry.
  ; Scoped under HKCU so no admin rights needed.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\${SHELL_ID}"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\${SHELL_ID}"

  ; Remove IExplorerCommand COM handler registration.
  DeleteRegKey HKCU "Software\Classes\CLSID\${COM_CLSID}"

  ; Remove app metadata key (stores ExePath for the COM DLL).
  DeleteRegKey HKCU "Software\${SHELL_ID}"
!macroend
