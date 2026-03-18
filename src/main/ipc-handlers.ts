import { ipcMain, BrowserWindow, dialog, shell, app } from 'electron'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../shared/ipc-channels'
import { DockManager } from './dock-manager'
import { getSettings, setSettings } from './settings-store'
import { getRecentPaths, removeRecentPath } from './recent-store'
import { saveSessions } from './session-store'
import { checkForUpdate, downloadUpdate, installAndRestart, setDownloadedPath } from './auto-updater'
import { savePendingProject, isUpdateLocked, acquireUpdateLock, releaseUpdateLock, setAppUpdateInProgress } from './pending-project'
import { detectClaudeCli, installClaudeCli, getClaudeVersion, detectGit, installGit, checkClaudePath, fixClaudePath } from './claude-cli'
import { isMcpInstalled, installMcp, uninstallMcp, setLinkedEnabled, setMessagingEnabled } from './linked-mode'
import { registerContextMenu, unregisterContextMenu, isContextMenuRegistered } from './context-menu-integration'
import { ActivityTracker } from './activity-tracker'
import * as usageService from './usage-service'
import { PluginManager, getPluginsDir } from './plugins'
import { PluginUpdateService } from './plugins/plugin-updater'
import { getOpenPluginIds } from './plugins/plugin-window-broadcast'
import { log, logError, setDebug, getLogDir } from './logger'

declare const __DEV__: boolean

export function registerIpcHandlers(): void {
  const manager = DockManager.getInstance()

  ipcMain.handle(IPC.TERMINAL_SPAWN, (event, terminalId: string, options?: { ephemeral?: boolean; claudeFlags?: string }) => {
    const dock = getDockForEvent(event)
    if (dock) {
      const ephemeral = options?.ephemeral ?? false
      const claudeFlags = options?.claudeFlags
      log(`TERMINAL_SPAWN: ${terminalId} in dock ${dock.id}${ephemeral ? ' (ephemeral)' : ''}${claudeFlags ? ` flags="${claudeFlags}"` : ''}`)
      pluginManager.emitTerminalPreSpawn(dock.projectDir, terminalId)
      const resumeId = ephemeral ? undefined : dock.getNextResumeId()
      // Restore saved terminal buffer before PTY starts (for resumed sessions)
      if (resumeId) {
        dock.restoreBuffer(terminalId, resumeId)
      }
      dock.ptyManager.spawn(terminalId, dock.projectDir, resumeId, ephemeral, claudeFlags)
      // Register with activity tracker (non-critical)
      const sessionId = dock.ptyManager.getSessionId(terminalId) || ''
      try {
        ActivityTracker.getInstance().addTerminal(
          dock.id, terminalId, `Terminal`, sessionId, dock.projectDir
        )
      } catch (e) { log(`ActivityTracker.addTerminal error: ${e}`) }
      pluginManager.emitTerminalPostSpawn(dock.projectDir, terminalId, sessionId)
      log(`TERMINAL_SPAWN: ${terminalId} spawned`)
      return true
    }
    return false
  })

  ipcMain.handle(IPC.TERMINAL_WRITE, (event, terminalId: string, data: string) => {
    const dock = getDockForEvent(event)
    if (dock) {
      dock.ptyManager.write(terminalId, data)
    }
  })

  ipcMain.handle(IPC.TERMINAL_RESIZE, (event, terminalId: string, cols: number, rows: number) => {
    const dock = getDockForEvent(event)
    if (dock) {
      dock.ptyManager.resize(terminalId, cols, rows)
    }
  })

  ipcMain.handle(IPC.TERMINAL_KILL, (event, terminalId: string) => {
    const dock = getDockForEvent(event)
    if (dock) {
      pluginManager.emitTerminalPreKill(dock.projectDir, terminalId)
      dock.ptyManager.kill(terminalId)
      pluginManager.emitTerminalPostKill(dock.projectDir, terminalId)
    }
  })

  ipcMain.handle(IPC.TERMINAL_GET_SESSION_ID, (event, terminalId: string) => {
    const dock = getDockForEvent(event)
    return dock?.ptyManager.getSessionId(terminalId) ?? null
  })

  ipcMain.handle(IPC.TERMINAL_SYNC_ORDER, (event, terminalIds: string[]) => {
    const dock = getDockForEvent(event)
    if (dock) {
      const ids = dock.ptyManager.getOrderedSessionIds(terminalIds)
      if (ids.length > 0) {
        saveSessions(dock.projectDir, ids)
      }
    }
  })

  ipcMain.handle(IPC.DOCK_GET_INFO, (event) => {
    const dock = getDockForEvent(event)
    if (dock) {
      return { id: dock.id, projectDir: dock.projectDir, savedSessionCount: dock.savedSessionCount }
    }
    return null
  })

  ipcMain.handle(IPC.DOCK_RESTART, async (event) => {
    const dock = getDockForEvent(event)
    if (dock) {
      const projectDir = dock.projectDir
      log(`DOCK_RESTART: restarting dock for ${projectDir}`)
      dock.close()
      await manager.createDock(projectDir)
    }
  })

  ipcMain.handle(IPC.DOCK_SWITCH_PROJECT, async (event, newDir: string) => {
    const dock = getDockForEvent(event)
    if (dock) {
      log(`DOCK_SWITCH_PROJECT: ${dock.projectDir} -> ${newDir}`)
      // If the target project is already open in another window, focus it
      // without closing the current window
      const existing = manager.findDockByDir(newDir)
      if (existing && existing !== dock) {
        log(`DOCK_SWITCH_PROJECT: target already open, focusing existing window`)
        if (existing.window.isMinimized()) existing.window.restore()
        existing.window.focus()
        return
      }
      dock.close()
      await manager.createDock(newDir)
    }
  })

  ipcMain.handle(IPC.SETTINGS_GET, () => {
    return getSettings()
  })

  ipcMain.handle(IPC.SETTINGS_SET, (_event, settings) => {
    setSettings(settings)
    // Toggle debug logging if changed
    const current = getSettings()
    setDebug(current.advanced?.debugLogging ?? false)
    // Broadcast to all dock windows
    for (const dock of manager.getAllDocks()) {
      if (!dock.window.isDestroyed()) {
        dock.window.webContents.send(IPC.SETTINGS_CHANGED, current)
      }
    }
    pluginManager.emitSettingsChanged(current)
  })

  ipcMain.handle(IPC.APP_NEW_DOCK, async () => {
    if (manager.shouldShowLauncher()) {
      await manager.showLauncher()
    } else {
      await manager.createDock()
    }
  })

  ipcMain.handle(IPC.WIN_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.minimize()
  })

  ipcMain.handle(IPC.WIN_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize()
    }
  })

  ipcMain.handle(IPC.WIN_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.close()
  })

  ipcMain.handle(IPC.APP_PICK_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Project Directory'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.APP_GET_RECENT_PATHS, () => {
    return getRecentPaths()
  })

  ipcMain.handle(IPC.APP_REMOVE_RECENT_PATH, (_event, dir: string) => {
    removeRecentPath(dir)
  })

  ipcMain.handle(IPC.APP_FOCUS_DOCK_PATH, (_event, dir: string): boolean => {
    const existing = manager.findDockByDir(dir)
    if (existing) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
      return true
    }
    return false
  })

  ipcMain.handle(IPC.APP_OPEN_DOCK_PATH, async (_event, dir: string) => {
    log(`APP_OPEN_DOCK_PATH: dir=${dir}`)
    // If already open, focus the existing window without closing the launcher
    const existing = manager.findDockByDir(dir)
    if (existing) {
      log('APP_OPEN_DOCK_PATH: already open, focusing existing window')
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
      return
    }
    // Wait for launcher to fully close and release GPU resources before creating dock
    await manager.closeLauncherAndWait()
    log('APP_OPEN_DOCK_PATH: launcher closed, creating dock')
    await manager.createDock(dir)
    log('APP_OPEN_DOCK_PATH: done')
  })

  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, (_event, url: string) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
  })

  ipcMain.handle(IPC.APP_RELAUNCH, () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle(IPC.APP_OPEN_IN_EXPLORER, (_event, dir: string) => {
    shell.openPath(dir)
  })

  ipcMain.handle(IPC.UPDATER_CHECK, async (_event, profile: string) => {
    if (__DEV__) {
      return { available: false, version: '', releaseNotes: '', downloadUrl: '', assetName: '', assetSize: 0 }
    }
    try {
      return await checkForUpdate(profile)
    } catch {
      return { available: false, version: '', releaseNotes: '', downloadUrl: '', assetName: '', assetSize: 0 }
    }
  })

  ipcMain.handle(IPC.UPDATER_DOWNLOAD, async (event, url: string, assetName: string) => {
    if (__DEV__) throw new Error('Updates are disabled in dev mode')
    setAppUpdateInProgress()
    const win = BrowserWindow.fromWebContents(event.sender)
    try {
      const filePath = await downloadUpdate(url, assetName, (downloaded, total) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.UPDATER_PROGRESS, downloaded, total)
        }
      })
      setDownloadedPath(filePath)
      return filePath
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Download failed')
    }
  })

  ipcMain.handle(IPC.GIT_CHECK, async () => {
    try {
      return await detectGit()
    } catch {
      return { installed: true }
    }
  })

  ipcMain.handle(IPC.GIT_INSTALL, async () => {
    try {
      return await installGit()
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Git installation failed' }
    }
  })

  ipcMain.handle(IPC.GIT_CLONE, async (_event, url: string, destDir: string) => {
    log(`GIT_CLONE: url=${url} destDir=${destDir}`)
    try {
      // Derive repo name from URL to build full cloned path
      const repoName = url.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || 'repo'
      const clonedPath = path.join(destDir, repoName)

      await new Promise<void>((resolve, reject) => {
        execFile('git', ['clone', url], { cwd: destDir, timeout: 300000 }, (err, _stdout, stderr) => {
          if (err) {
            // Git clone progress goes to stderr — only treat as error if exit code is non-zero
            const msg = stderr?.trim() || err.message
            reject(new Error(msg))
          } else {
            resolve()
          }
        })
      })

      // Verify the directory was actually created
      if (!fs.existsSync(clonedPath)) {
        // Fallback: scan destDir for newly created directory
        const entries = fs.readdirSync(destDir, { withFileTypes: true })
        const gitDirs = entries.filter(e => e.isDirectory() && fs.existsSync(path.join(destDir, e.name, '.git')))
        if (gitDirs.length > 0) {
          // Use the most recently modified git directory
          const sorted = gitDirs.sort((a, b) => {
            const aStat = fs.statSync(path.join(destDir, a.name))
            const bStat = fs.statSync(path.join(destDir, b.name))
            return bStat.mtimeMs - aStat.mtimeMs
          })
          return { success: true, clonedPath: path.join(destDir, sorted[0].name) }
        }
        return { success: false, error: 'Clone completed but could not find the cloned directory' }
      }

      log(`GIT_CLONE: success -> ${clonedPath}`)
      return { success: true, clonedPath }
    } catch (err) {
      logError('GIT_CLONE failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Clone failed' }
    }
  })

  ipcMain.handle(IPC.CLAUDE_CHECK_INSTALL, async () => {
    try {
      const status = await detectClaudeCli()
      // If installed but no version yet, fetch it now
      if (status.installed && !status.version) {
        try {
          const v = await getClaudeVersion()
          if (v) status.version = v
        } catch { /* version is cosmetic, don't fail */ }
      }
      return status
    } catch {
      // On failure, assume installed to avoid blocking user
      return { installed: true }
    }
  })

  ipcMain.handle(IPC.CLAUDE_VERSION, async () => {
    try {
      return await getClaudeVersion()
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.CLAUDE_INSTALL, async () => {
    try {
      return await installClaudeCli()
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Installation failed' }
    }
  })

  ipcMain.handle(IPC.CLAUDE_CHECK_PATH, async () => {
    try {
      return await checkClaudePath()
    } catch {
      return { inPath: true }
    }
  })

  ipcMain.handle(IPC.CLAUDE_FIX_PATH, (_event, claudeDir: string) => {
    try {
      return fixClaudePath(claudeDir)
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to fix PATH' }
    }
  })

  ipcMain.handle(IPC.CONTEXT_MENU_CHECK, () => {
    try {
      return { registered: isContextMenuRegistered() }
    } catch (err) {
      logError('contextMenu:check failed', err)
      return { registered: false }
    }
  })

  ipcMain.handle(IPC.CONTEXT_MENU_REGISTER, () => {
    try {
      return registerContextMenu()
    } catch (err) {
      logError('contextMenu:register failed', err)
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  })

  ipcMain.handle(IPC.CONTEXT_MENU_UNREGISTER, () => {
    try {
      return unregisterContextMenu()
    } catch (err) {
      logError('contextMenu:unregister failed', err)
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  })

  ipcMain.handle(IPC.LINKED_CHECK_MCP, (event) => {
    const dock = getDockForEvent(event)
    if (!dock) return { installed: false }
    try {
      return { installed: isMcpInstalled(dock.projectDir) }
    } catch (err) {
      logError('linked:checkMcp failed', err)
      return { installed: false }
    }
  })

  ipcMain.handle(IPC.LINKED_INSTALL_MCP, (event) => {
    const dock = getDockForEvent(event)
    if (!dock) return { success: false, error: 'No dock found' }
    return installMcp(dock.projectDir)
  })

  ipcMain.handle(IPC.LINKED_UNINSTALL_MCP, (event) => {
    const dock = getDockForEvent(event)
    if (!dock) return { success: false, error: 'No dock found' }
    return uninstallMcp(dock.projectDir)
  })

  ipcMain.handle(IPC.LINKED_SET_ENABLED, (_event, enabled: boolean) => {
    try {
      setLinkedEnabled(enabled)
    } catch (err) {
      logError('linked:setEnabled failed', err)
    }
  })

  ipcMain.handle(IPC.LINKED_SET_MESSAGING, (_event, enabled: boolean) => {
    try {
      setMessagingEnabled(enabled)
    } catch (err) {
      logError('linked:setMessaging failed', err)
    }
  })

  // Plugin system
  const pluginManager = PluginManager.getInstance()

  ipcMain.handle(IPC.PLUGIN_GET_LIST, () => {
    return pluginManager.getPluginInfoList()
  })

  ipcMain.handle(IPC.PLUGIN_GET_STATES, (_event, projectDir: string) => {
    return pluginManager.getAllStates(projectDir)
  })

  ipcMain.handle(IPC.PLUGIN_SET_ENABLED, (_event, projectDir: string, pluginId: string, enabled: boolean) => {
    pluginManager.setEnabled(projectDir, pluginId, enabled)
  })

  ipcMain.handle(IPC.PLUGIN_GET_SETTING, (_event, projectDir: string, pluginId: string, key: string) => {
    return pluginManager.getSetting(projectDir, pluginId, key)
  })

  ipcMain.handle(IPC.PLUGIN_SET_SETTING, (_event, projectDir: string, pluginId: string, key: string, value: unknown) => {
    pluginManager.setSetting(projectDir, pluginId, key, value)
  })

  ipcMain.handle(IPC.PLUGIN_IS_CONFIGURED, (_event, projectDir: string) => {
    return pluginManager.isConfigured(projectDir)
  })

  ipcMain.handle(IPC.PLUGIN_MARK_CONFIGURED, (_event, projectDir: string) => {
    pluginManager.markConfigured(projectDir)
  })

  ipcMain.handle(IPC.PLUGIN_GET_TOOLBAR_ACTIONS, () => {
    return pluginManager.getToolbarActionsFromManifests()
  })

  ipcMain.handle(IPC.PLUGIN_GET_DIR, () => {
    return getPluginsDir()
  })

  ipcMain.handle(IPC.PLUGIN_OPEN_DIR, () => {
    shell.openPath(getPluginsDir())
  })

  ipcMain.handle(IPC.PLUGIN_GET_OPEN_WINDOWS, (_event, projectDir: string) => {
    return getOpenPluginIds(projectDir)
  })

  // Plugin Update System
  const pluginUpdateService = PluginUpdateService.getInstance()

  ipcMain.handle(IPC.PLUGIN_UPDATE_CHECK, async () => {
    try {
      const profile = getSettings().updater?.profile || 'latest'
      return await pluginUpdateService.checkForUpdates(profile)
    } catch (err) {
      logError('pluginUpdate:check failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.PLUGIN_UPDATE_GET_AVAILABLE, () => {
    return pluginUpdateService.getAvailableUpdates()
  })

  ipcMain.handle(IPC.PLUGIN_UPDATE_INSTALL, async (_event, pluginId: string) => {
    try {
      await pluginUpdateService.installUpdate(pluginId)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.PLUGIN_UPDATE_INSTALL_ALL, async () => {
    try {
      return await pluginUpdateService.installAll()
    } catch (err) {
      return { success: [], failed: [{ pluginId: 'all', error: err instanceof Error ? err.message : String(err) }] }
    }
  })

  ipcMain.handle(IPC.PLUGIN_UPDATE_DISMISS, (_event, pluginId: string, version: string) => {
    pluginUpdateService.dismissUpdate(pluginId, version)
  })

  ipcMain.handle(IPC.PLUGIN_UPDATE_GET_NEW_OVERRIDES, () => {
    const { getOverrides, getSeenOverrideHashes } = require('./plugins/plugin-update-store')
    const { PluginManager } = require('./plugins/plugin-manager')
    const overrides = getOverrides() as Record<string, import('./plugins/plugin-update-store').PluginOverrideEntry>
    const seen = getSeenOverrideHashes() as Record<string, string>
    const pluginInfoList = (PluginManager.getInstance() as import('./plugins/plugin-manager').PluginManager).getPluginInfoList()
    const results: { pluginId: string; pluginName: string; version: string; buildSha: string; hash: string; changelog: string }[] = []

    for (const [pluginId, override] of Object.entries(overrides)) {
      if (seen[pluginId] === override.hash) continue // already notified
      const info = pluginInfoList.find((p: any) => p.id === pluginId)
      results.push({
        pluginId,
        pluginName: info?.name || pluginId,
        version: override.version,
        buildSha: override.buildSha,
        hash: override.hash,
        changelog: '' // changelog not stored in override — could be added later
      })
    }
    return results
  })

  ipcMain.handle(IPC.PLUGIN_UPDATE_MARK_OVERRIDE_SEEN, (_event, pluginId: string, hash: string) => {
    const { markOverrideSeen } = require('./plugins/plugin-update-store')
    markOverrideSeen(pluginId, hash)
  })

  // Usage / Anthropic API
  ipcMain.handle(IPC.USAGE_FETCH, async () => {
    try {
      const settings = getSettings()
      const limit = settings.anthropic?.spendLimitUsd ?? 100
      return await usageService.fetchUsage(limit)
    } catch (err) {
      logError('usage:fetch failed:', err)
      return { success: false, error: 'internal' }
    }
  })

  ipcMain.handle(IPC.USAGE_CACHED, () => {
    try {
      return usageService.getCached()
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.USAGE_SET_KEY, (_event, key: string) => {
    try {
      return usageService.setKey(key)
    } catch (err) {
      logError('usage:setKey failed:', err)
      return { success: false }
    }
  })

  ipcMain.handle(IPC.USAGE_HAS_KEY, () => {
    try {
      return { hasKey: usageService.hasKey() }
    } catch {
      return { hasKey: false }
    }
  })

  ipcMain.handle(IPC.USAGE_CLEAR_KEY, () => {
    try {
      return usageService.clearKey()
    } catch (err) {
      logError('usage:clearKey failed:', err)
      return { success: false }
    }
  })

  ipcMain.handle(IPC.DEBUG_WRITE, (_event, text: string) => {
    log(`[renderer] ${text}`)
  })

  ipcMain.handle(IPC.DEBUG_OPEN_LOGS, () => {
    shell.openPath(getLogDir())
  })

  ipcMain.handle(IPC.DEBUG_OPEN_DEVTOOLS, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  })

  ipcMain.handle(IPC.UPDATER_SAVE_PENDING_PROJECT, (_event, dir: string) => {
    savePendingProject(dir)
  })

  ipcMain.handle(IPC.UPDATER_IS_LOCKED, () => {
    return isUpdateLocked()
  })

  ipcMain.handle(IPC.UPDATER_HAS_ACTIVE_TERMINALS, () => {
    const manager = DockManager.getInstance()
    for (const dock of manager.getAllDocks()) {
      if (dock.ptyManager.size > 0) return true
    }
    return false
  })

  ipcMain.handle(IPC.UPDATER_INSTALL, () => {
    if (__DEV__) throw new Error('Updates are disabled in dev mode')
    if (!acquireUpdateLock()) {
      throw new Error('Another update is already in progress')
    }
    try {
      installAndRestart()
    } catch (err) {
      releaseUpdateLock()
      throw new Error(err instanceof Error ? err.message : 'Install failed')
    }
  })
}

function getDockForEvent(event: Electron.IpcMainInvokeEvent) {
  const manager = DockManager.getInstance()
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null

  for (const dock of manager.getAllDocks()) {
    if (dock.window === win) {
      return dock
    }
  }
  return null
}
