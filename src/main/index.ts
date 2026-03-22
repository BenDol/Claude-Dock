import { app, BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { DockManager } from './dock-manager'
import { registerIpcHandlers } from './ipc-handlers'
import { createAppMenu } from './menu'
import { ActivityTracker } from './activity-tracker'
import { migrateIfNeeded } from './linked-mode'
import { registerPlugins, PluginManager } from './plugins'
import { PluginUpdateService } from './plugins/plugin-updater'
import { NotificationManager } from './notification-manager'
import { initLogger, log, logInfo, logError } from './logger'
import { getSetting } from './settings-store'
import { updateJumpList } from './recent-store'
import { enrichPathWithKnownDirs } from './claude-cli'
import { loadPendingProject, cleanStaleLock } from './pending-project'
import { refreshContextMenuIfNeeded, autoRegisterContextMenuOnce } from './context-menu-integration'

// Set explicit AppUserModelId so Windows groups taskbar icons correctly
// (must be called before app.whenReady and match electron-builder appId)
if (process.platform === 'win32') {
  app.setAppUserModelId('com.claude.dock')
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling (Squirrel only)
try {
  if (require('electron-squirrel-startup') === true) {
    app.quit()
  }
} catch {
  // Not a Squirrel install (e.g. NSIS portable) — safe to ignore
}

declare const __DEBUG_DEFAULT__: boolean

// Init logging early — debug enabled via settings, CLI flag, or build default (bleeding-edge)
const cliDebug = process.argv.includes('--enable-logging')
const settingsDebug = (() => { try { return getSetting('advanced')?.debugLogging } catch { return false } })()
const buildDebug = typeof __DEBUG_DEFAULT__ !== 'undefined' && __DEBUG_DEFAULT__
initLogger(cliDebug || settingsDebug || buildDebug)

// Enrich PATH early so PTY shells and child_process.spawn find CLI tools.
// On macOS/Linux, Electron inherits a minimal PATH when launched from Finder/desktop.
enrichPathWithKnownDirs()

// Increase V8 heap limit for renderer processes (default ~256MB).
// The git-manager renderer can exceed this on large repos with many diffs.
// Configurable via settings (requires restart). Default: 2048MB.
const heapSizeMb = (() => { try { return getSetting('advanced')?.maxHeapSizeMb } catch { return undefined } })()
const effectiveHeap = typeof heapSizeMb === 'number' && heapSizeMb >= 256 ? heapSizeMb : 2048
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${effectiveHeap}`)

// Disable GPU acceleration for portable exe — GPU compositing from the temp extraction
// directory causes rendering failures (tiny terminals, broken canvas) with multiple windows.
// Also allow users to opt-in via settings for any install type.
const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE
const disableGpu = (() => { try { return getSetting('advanced')?.disableGpuAcceleration } catch { return false } })()
if (isPortable || disableGpu) {
  logInfo(`GPU acceleration disabled (portable=${isPortable}, setting=${disableGpu})`)
  app.disableHardwareAcceleration()
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

/** Extract --launch <path> from argv (used by taskbar jump list) */
function getLaunchDirFromArgs(argv: string[]): string | undefined {
  const args = argv.slice(app.isPackaged ? 1 : 2)
  const idx = args.indexOf('--launch')
  if (idx >= 0 && idx + 1 < args.length) {
    const resolved = path.resolve(args[idx + 1])
    try {
      if (fs.statSync(resolved).isDirectory()) return resolved
    } catch { /* invalid path */ }
  }
  return undefined
}

// Single-instance lock: if already running, open a new dock in the existing instance
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', async (_event, argv, _workingDirectory) => {
    log('second-instance event, argv:', argv.slice(1).join(' '))
    const manager = DockManager.getInstance()
    const launchDir = getLaunchDirFromArgs(argv)
    const dir = launchDir || getProjectDirFromArgs(argv)
    if (dir) {
      log('second-instance: launching with primed dir', dir)
      await manager.showLauncher(dir)
    } else {
      log('second-instance: showing launcher')
      await manager.showLauncher()
    }
    log('second-instance: handler complete')
  })

  // Detect GPU process crashes — primary suspect for the "both windows freeze" issue
  app.on('child-process-gone', (_event, details) => {
    logError(`Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
  })

  process.on('uncaughtException', (err) => {
    logError('Uncaught exception:', err)
  })

  process.on('unhandledRejection', (reason) => {
    logError('Unhandled rejection:', reason)
  })

  app.whenReady().then(async () => {
    log('app ready')
    createAppMenu()
    registerIpcHandlers()
    registerPlugins()
    installCli()
    updateJumpList()
    try { migrateIfNeeded() } catch (e) { log(`MCP migration error: ${e}`) }

    // Context menu registration uses synchronous shell commands (reg, csc.exe).
    // Defer to avoid blocking the launcher window from appearing.
    setTimeout(() => {
      try { refreshContextMenuIfNeeded() } catch (e) { log(`[context-menu] refresh error: ${e}`) }
      try { autoRegisterContextMenuOnce() } catch (e) { log(`[context-menu] auto-register error: ${e}`) }
    }, 1000)

    cleanStaleLock()

    const manager = DockManager.getInstance()
    const launchDir = getLaunchDirFromArgs(process.argv) || getProjectDirFromArgs(process.argv) || loadPendingProject()
    await manager.showLauncher(launchDir || undefined)

    // Fire-and-forget plugin update check — fully async, never blocks the launcher.
    // Wrapped in its own error boundary so a failure can never affect the app.
    schedulePluginUpdateCheck()

    // macOS: re-create window when dock icon clicked
    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await manager.showLauncher()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    try { ActivityTracker.getInstance().shutdown() } catch (e) { log(`ActivityTracker.shutdown error: ${e}`) }
    try { PluginManager.getInstance().dispose() } catch (e) { log(`PluginManager.dispose error: ${e}`) }
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

  // Add appDir to user PATH if not already present.
  // Uses a temp .ps1 file with [Environment] API to safely read/write
  // REG_EXPAND_SZ values without cmd.exe quoting/escaping issues.
  const { execSync } = require('child_process')
  try {
    const psPath = path.join(require('os').tmpdir(), 'claude-dock-cli-path.ps1')
    fs.writeFileSync(psPath, [
      `$dir = '${appDir.replace(/'/g, "''")}';`,
      `$current = [Environment]::GetEnvironmentVariable('Path', 'User');`,
      `if ($null -eq $current) { $current = '' };`,
      `$entries = $current -split ';' | ForEach-Object { $_.Trim().ToLower() };`,
      `if ($entries -contains $dir.ToLower()) { exit 0 };`,
      `$newPath = if ($current) { "$current;$dir" } else { $dir };`,
      `[Environment]::SetEnvironmentVariable('Path', $newPath, 'User');`,
    ].join('\r\n'))

    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`,
      { encoding: 'utf8', timeout: 15000 }
    )
    try { fs.unlinkSync(psPath) } catch { /* ignore */ }
  } catch { /* best effort */ }
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

declare const __DEV__: boolean

/**
 * Schedules a fire-and-forget plugin update check.
 * Completely async — never blocks the launcher or any window.
 * All errors are caught internally; a failure here must never affect the app.
 */
function schedulePluginUpdateCheck(): void {
  const delay = (typeof __DEV__ !== 'undefined' && __DEV__) ? 2000 : 5000
  setTimeout(() => {
    // Run entirely in the background — .catch() ensures unhandled rejections
    // never propagate to the process-level handler.
    const service = PluginUpdateService.getInstance()
    service
      .checkForUpdates(getSetting('updater')?.profile || 'latest')
      .then(async (updates) => {
        if (updates.length === 0) return

        const autoUpdatePlugins = getSetting('updater')?.autoUpdatePlugins ?? false
        const installable = updates.filter((u) => u.status === 'available' && !u.requiresAppUpdate)

        if (autoUpdatePlugins && installable.length > 0) {
          // Auto-update: install all silently, then notify when done
          log(`[plugin-updater] auto-updating ${installable.length} plugin(s)...`)
          const result = await service.installAll()
          const successNames = result.success.map(
            (id) => updates.find((u) => u.pluginId === id)?.pluginName || id
          )
          const failedNames = result.failed.map((f) => f.pluginId)

          if (successNames.length > 0) {
            NotificationManager.getInstance().notify({
              title: 'Plugins Updated',
              message: `${successNames.join(', ')} updated successfully.`,
              type: 'success',
              source: 'plugin-updater',
              timeout: 8000
            })
          }
          if (failedNames.length > 0) {
            NotificationManager.getInstance().notify({
              title: 'Plugin Update Failed',
              message: `Failed to update: ${failedNames.join(', ')}`,
              type: 'error',
              source: 'plugin-updater',
              timeout: 10000,
              action: { label: 'View Details', event: 'plugin-update-open' }
            })
          }
        } else {
          // Manual mode: show notification with action buttons
          const names = updates.map((u) => u.pluginName)
          NotificationManager.getInstance().notify({
            title: 'Plugin Updates Available',
            message: names.length <= 3
              ? names.join(', ')
              : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more...`,
            type: 'info',
            source: 'plugin-updater',
            timeout: 0,
            uniqueId: 'plugin-updates-available',
            uniquePerSession: true,
            actions: [
              { label: 'View', event: 'plugin-update-open' },
              { label: 'Update All', event: 'plugin-update-all' }
            ]
          })
        }
      })
      .catch((err) => {
        log(`[plugin-updater] startup check failed: ${err}`)
      })

    // Re-check every 30 minutes
    const RECHECK_INTERVAL = 30 * 60 * 1000
    setInterval(() => {
      service.checkForUpdates(getSetting('updater')?.profile || 'latest')
        .then(async (updates) => {
          if (updates.length === 0) return
          const autoUpdatePlugins = getSetting('updater')?.autoUpdatePlugins ?? false
          const installable = updates.filter((u) => u.status === 'available' && !u.requiresAppUpdate)

          if (autoUpdatePlugins && installable.length > 0) {
            log(`[plugin-updater] periodic: auto-updating ${installable.length} plugin(s)...`)
            try {
              const result = await service.installAll()
              const successNames = result.success.map(
                (id) => updates.find((u) => u.pluginId === id)?.pluginName || id
              )
              if (result.failed.length > 0) {
                log(`[plugin-updater] periodic: ${result.failed.length} failed: ${result.failed.map((f) => `${f.pluginId}: ${f.error}`).join(', ')}`)
              }
              if (successNames.length > 0) {
                log(`[plugin-updater] periodic: updated ${successNames.join(', ')}`)
                NotificationManager.getInstance().notify({
                  title: 'Plugins Updated',
                  message: `${successNames.join(', ')} updated successfully.`,
                  type: 'success',
                  source: 'plugin-updater',
                  timeout: 8000
                })
              }
            } catch (installErr) {
              log(`[plugin-updater] periodic: installAll threw: ${installErr}`)
            }
          } else if (installable.length > 0) {
            const names = installable.map((u) => u.pluginName)
            NotificationManager.getInstance().notify({
              title: 'Plugin Updates Available',
              message: names.length <= 3
                ? names.join(', ')
                : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more...`,
              type: 'info',
              source: 'plugin-updater',
              timeout: 0,
              uniqueId: 'plugin-updates-available',
              uniquePerSession: true,
              actions: [
                { label: 'View', event: 'plugin-update-open' },
                { label: 'Update All', event: 'plugin-update-all' }
              ]
            })
          }
        })
        .catch((err) => log(`[plugin-updater] periodic check failed: ${err}`))
    }, RECHECK_INTERVAL)
  }, delay)
}
