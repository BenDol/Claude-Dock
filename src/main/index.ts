import { app, BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { DockManager } from './dock-manager'
import { registerIpcHandlers } from './ipc-handlers'
import { createAppMenu } from './menu'

// Handle creating/removing shortcuts on Windows when installing/uninstalling (Squirrel only)
try {
  if (require('electron-squirrel-startup') === true) {
    app.quit()
  }
} catch {
  // Not a Squirrel install (e.g. NSIS portable) — safe to ignore
}

function getProjectDirFromArgs(argv: string[]): string | undefined {
  // Skip electron binary and main script, look for a real directory path
  const args = argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    const resolved = path.resolve(arg)
    try {
      if (fs.statSync(resolved).isDirectory()) {
        return resolved
      }
    } catch {
      // Not a valid path
    }
  }
  return undefined
}

// Single-instance lock: if already running, open a new dock in the existing instance
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', async (_event, argv, _workingDirectory) => {
    const dir = getProjectDirFromArgs(argv)
    const manager = DockManager.getInstance()
    if (dir) {
      await manager.createDock(dir)
    } else if (manager.shouldShowLauncher()) {
      await manager.showLauncher()
    } else {
      await manager.createDock()
    }
  })

  app.whenReady().then(async () => {
    createAppMenu()
    registerIpcHandlers()
    installCli()

    const manager = DockManager.getInstance()
    const dir = getProjectDirFromArgs(process.argv)
    if (dir) {
      await manager.createDock(dir)
    } else if (manager.shouldShowLauncher()) {
      await manager.showLauncher()
    } else {
      await manager.createDock()
    }

    // macOS: re-create window when dock icon clicked
    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (manager.shouldShowLauncher()) {
          await manager.showLauncher()
        } else {
          await manager.createDock()
        }
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    DockManager.getInstance().shutdownAll()
  })
}

/**
 * Installs the `claude-dock` CLI command so users can type it from any terminal.
 * - Windows: creates claude-dock.cmd in app dir, adds to user PATH via registry
 * - macOS/Linux: creates symlink in /usr/local/bin
 */
function installCli(): void {
  try {
    if (process.platform === 'win32') {
      installCliWindows()
    } else {
      installCliUnix()
    }
  } catch {
    // Non-fatal: CLI install is best-effort
  }
}

function installCliWindows(): void {
  const exePath = app.getPath('exe')
  const appDir = path.dirname(exePath)
  const cmdPath = path.join(appDir, 'claude-dock.cmd')

  // Create claude-dock.cmd that passes CWD to the app
  const cmdContent = `@echo off\r\n"${exePath}" "%CD%"\r\n`

  // Only write if missing or outdated
  try {
    if (fs.existsSync(cmdPath) && fs.readFileSync(cmdPath, 'utf8') === cmdContent) return
  } catch { /* rewrite */ }

  fs.writeFileSync(cmdPath, cmdContent)

  // Add appDir to user PATH if not already present
  const { execSync } = require('child_process')
  try {
    const currentPath: string = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf8' }
    )
    const match = currentPath.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)
    const existingPath = match ? match[1].trim() : ''

    if (!existingPath.toLowerCase().includes(appDir.toLowerCase())) {
      const newPath = existingPath ? `${existingPath};${appDir}` : appDir
      execSync(
        `reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d "${newPath}" /f`,
        { encoding: 'utf8' }
      )
      // Broadcast WM_SETTINGCHANGE so new terminals pick up the PATH change
      execSync(
        'powershell -Command "[System.Environment]::SetEnvironmentVariable(\'__dummy__\',\'\',[System.EnvironmentVariableTarget]::User)"',
        { encoding: 'utf8' }
      )
    }
  } catch {
    // PATH registry entry may not exist yet, create it
    try {
      execSync(
        `reg add "HKCU\\Environment" /v Path /t REG_EXPAND_SZ /d "${appDir}" /f`,
        { encoding: 'utf8' }
      )
    } catch { /* best effort */ }
  }
}

function installCliUnix(): void {
  const exePath = app.getPath('exe')
  const linkPath = '/usr/local/bin/claude-dock'

  // Create a shell wrapper script
  const wrapperDir = path.join(app.getPath('userData'), 'bin')
  const wrapperPath = path.join(wrapperDir, 'claude-dock')

  fs.mkdirSync(wrapperDir, { recursive: true })
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${exePath}" "$(pwd)" "$@"\n`, { mode: 0o755 })

  // Try to symlink into /usr/local/bin
  try {
    if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath)
    fs.symlinkSync(wrapperPath, linkPath)
  } catch {
    // No permission for /usr/local/bin - that's ok, user can add wrapperDir to PATH manually
  }
}
