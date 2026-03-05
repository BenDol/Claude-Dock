import { ipcMain, BrowserWindow, dialog } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { DockManager } from './dock-manager'
import { getSettings, setSettings } from './settings-store'
import { getRecentPaths, removeRecentPath } from './recent-store'

export function registerIpcHandlers(): void {
  const manager = DockManager.getInstance()

  ipcMain.handle(IPC.TERMINAL_SPAWN, (event, terminalId: string) => {
    const dock = getDockForEvent(event)
    if (dock) {
      const resumeId = dock.getNextResumeId()
      dock.ptyManager.spawn(terminalId, dock.projectDir, resumeId)
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
    // Broadcast to all dock windows
    for (const dock of manager.getAllDocks()) {
      if (!dock.window.isDestroyed()) {
        dock.window.webContents.send(IPC.SETTINGS_CHANGED, getSettings())
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

  ipcMain.handle(IPC.APP_OPEN_DOCK_PATH, async (event, dir: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    await manager.createDock(dir)
    // Close the launcher window
    if (win && !win.isDestroyed()) {
      win.close()
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
