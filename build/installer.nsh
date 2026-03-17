; Custom NSIS macros for Claude Dock installer
; electron-builder calls these at the appropriate lifecycle points

!macro customUnInstall
  ; Remove "Open with Claude Dock" context menu entries from the registry
  ; These are under HKCU so no admin rights needed
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeDock"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeDock"
!macroend
