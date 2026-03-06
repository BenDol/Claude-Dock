import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../shared/ipc-channels'
import { DockManager } from './dock-manager'
import { getSettings, setSettings } from './settings-store'
import { getRecentPaths, removeRecentPath } from './recent-store'
import { checkForUpdate, downloadUpdate, installAndRestart, setDownloadedPath } from './auto-updater'
import { detectClaudeCli, installClaudeCli, getClaudeVersion, detectGit, installGit } from './claude-cli'
import { log, logError, setDebug, getLogDir } from './logger'

declare const __DEV__: boolean

export function registerIpcHandlers(): void {
  const manager = DockManager.getInstance()

  ipcMain.handle(IPC.TERMINAL_SPAWN, (event, terminalId: string) => {
    const dock = getDockForEvent(event)
    if (dock) {
      log(`TERMINAL_SPAWN: ${terminalId} in dock ${dock.id}`)
      const resumeId = dock.getNextResumeId()
      dock.ptyManager.spawn(terminalId, dock.projectDir, resumeId)
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
      dock.ptyManager.kill(terminalId)
    }
  })

  ipcMain.handle(IPC.DOCK_GET_INFO, (event) => {
    const dock = getDockForEvent(event)
    if (dock) {
      return { id: dock.id, projectDir: dock.projectDir, savedSessionCount: dock.savedSessionCount }
    }
    return null
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

  ipcMain.handle(IPC.APP_OPEN_DOCK_PATH, async (_event, dir: string) => {
    log(`APP_OPEN_DOCK_PATH: dir=${dir}`)
    // Wait for launcher to fully close and release GPU resources before creating dock
    await manager.closeLauncherAndWait()
    log('APP_OPEN_DOCK_PATH: launcher closed, creating dock')
    await manager.createDock(dir)
    log('APP_OPEN_DOCK_PATH: done')
  })

  ipcMain.handle(IPC.APP_OPEN_EXTERNAL, (_event, url: string) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url)
    }
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

  ipcMain.handle(IPC.UPDATER_INSTALL, () => {
    try {
      installAndRestart()
    } catch (err) {
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
