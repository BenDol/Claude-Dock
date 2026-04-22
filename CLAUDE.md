# Claude Dock

Electron desktop app that docks multiple Claude Code terminals in a configurable grid.

## Tech Stack

- **Shell:** Electron + electron-vite + electron-builder
- **UI:** React 19 + TypeScript, xterm.js terminals, react-grid-layout, Monaco editor
- **State:** Zustand (renderer), electron-store (persisted settings)
- **Backend:** node-pty (PTY), better-sqlite3 (local storage), uiohook-napi (global hotkeys, optional)

## Build & Run

- **Dev:** `npx electron-vite dev`
- **Build:** `npx electron-vite build`
- **Package (Windows UAT):** `npm run package:win`
- **Package (Windows prod):** `npm run package:win:prod`
- **Tests:** `npm test` (Vitest)
- **Rebuild natives:** `npm run rebuild`

`postinstall` automatically runs `scripts/fix-node-pty.js` (disables Spectre mitigation in `binding.gyp` / `winpty.gyp` and patches `.bat` paths for `NoDefaultCurrentDirectoryInExePath`) before `electron-builder install-app-deps`. Required for Windows node-pty builds.

## Architecture

Main process (`src/main/`):
- `index.ts` — app entry
- `dock-manager.ts` — singleton that owns all windows
- `dock-window.ts` — per-window controller
- `pty-manager.ts` / `pty-host.ts` — PTY lifecycle
- `logger.ts` — debug logging
- `crash-reporter.ts` / `bug-reporter.ts` — crash capture & upload
- `ipc-handlers.ts` — IPC surface; channels in `src/shared/ipc-channels.ts`
- `plugins/` — built-in plugin modules

Preload (`src/preload/`) exposes a typed `dockApi` via `contextBridge`.

Renderer (`src/renderer/`):
- `src/App.tsx` — root component
- `src/hooks/useTerminal.ts` — xterm.js integration
- Zustand stores (`dock-store`, `settings-store`); auto + freeform grid modes

Shared (`src/shared/`):
- `ipc-channels.ts`, `settings-schema.ts` (types + defaults)

## Debug Logging

- **Location:** `app.getPath('userData')/logs/` → Windows: `%APPDATA%/claude-dock/logs/`
- **Files:** `dock-<timestamp>.log`, max 5 (auto-rotated)
- **Enable:** Settings → Advanced → Debug Logging, `--enable-logging` CLI flag, or bleeding-edge builds (on by default via `__DEBUG_DEFAULT__`)
- **Captured:** GPU crashes, renderer-gone, window-unresponsive, PTY spawn, dock/launcher lifecycle, uncaught exceptions
- **Open:** Debug panel "Open Logs" button, or IPC `debug:openLogs`
- **Check when:** app freezes, windows go unresponsive, terminals fail to spawn

Always include debug logging in new features/fixes — never silently swallow errors.

## Crash Logs (Remote)

Crash reports are published to a public GitHub repo: **`BenDol/Claude-Dock-Crashes`** under `data/`.

- **Layout:** `data/<YYYY>/<MM>/<files>` — multiple files per day; the latest file for today is the one to read.
- **List a month (GitHub API):** `https://api.github.com/repos/BenDol/Claude-Dock-Crashes/contents/data/<YYYY>/<MM>`
- **Fetch a file (raw):** `https://raw.githubusercontent.com/BenDol/Claude-Dock-Crashes/main/data/<YYYY>/<MM>/<filename>`

**When the user says "check the crash logs":**
1. Compute today's year + zero-padded month (e.g. `2026/04`).
2. List the month directory via the contents API.
3. Pick the latest file for today (by filename timestamp); fall back to the latest overall if none match today.
4. Fetch via the raw URL and review for exceptions, stack traces, and freeze/renderer-gone signals.

## Plugins

New plugins MUST be registered in `BUILTIN_PLUGINS` in `scripts/generate-plugin-archive.js` — otherwise they won't be bundled. See `docs/plugins.md`.

## Notifications

Always scope notifications to a project — include `projectDir` on every notification payload.

## Workflow

- Non-trivial work starts on a git worktree + feature branch, never directly on `main`.
- `git worktree add`, new branches, commits on a feature branch, and local merges into `main` are pre-authorized.
- Pushing, rebasing, amending, force-pushing, resetting, and deleting branches/worktrees require explicit approval each time.
