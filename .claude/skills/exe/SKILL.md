---
description: Build the portable Windows exe
user_invocable: true
---

Build the Claude Dock portable exe by running these steps in sequence:

1. Run `npx electron-vite build` and verify it succeeds
2. Kill any running "Claude Dock.exe" processes: `taskkill //F //IM "Claude Dock.exe" 2>/dev/null`
3. Run `npx electron-builder --win portable` to produce the portable exe
4. Report the result to the user
