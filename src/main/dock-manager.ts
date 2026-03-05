import { BrowserWindow, dialog } from 'electron'
import * as path from 'path'
import { DockWindow } from './dock-window'
import { addRecentPath, hasRecentPaths } from './recent-store'
import { getSettings } from './settings-store'

let nextId = 1

export class DockManager {
  private static instance: DockManager
  private docks = new Map<string, DockWindow>()
  private launcherWindow: BrowserWindow | null = null

  static getInstance(): DockManager {
    if (!DockManager.instance) {
      DockManager.instance = new DockManager()
    }
    return DockManager.instance
  }

  async createDock(projectDir?: string): Promise<DockWindow | null> {
    let dir = projectDir

    if (!dir) {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Project Directory'
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      dir = result.filePaths[0]
    }

    addRecentPath(dir)

    const id = `dock-${nextId++}`
    const dock = new DockWindow(id, dir)

    this.docks.set(id, dock)

    dock.window.on('closed', () => {
      this.docks.delete(id)
    })

    await dock.loadRenderer()
    return dock
  }

  async showLauncher(): Promise<void> {
    // If launcher already open, focus it
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      this.launcherWindow.focus()
      return
    }

    const settings = getSettings()
    const isDark = settings.theme.mode === 'dark' ||
      (settings.theme.mode === 'system') // default to dark for launcher

    this.launcherWindow = new BrowserWindow({
      width: 500,
      height: 550,
      minWidth: 400,
      minHeight: 350,
      frame: false,
      title: 'Claude Dock',
      backgroundColor: isDark ? '#0f0f14' : '#f5f5f5',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    this.launcherWindow.on('closed', () => {
      this.launcherWindow = null
    })

    const queryParam = '?launcher=true'

    if (process.env.ELECTRON_RENDERER_URL) {
      await this.launcherWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}${queryParam}`)
    } else {
      await this.launcherWindow.loadFile(
        path.join(__dirname, '../renderer/index.html'),
        { search: queryParam.slice(1) }
      )
    }
  }

  closeLauncher(): void {
    if (this.launcherWindow && !this.launcherWindow.isDestroyed()) {
      this.launcherWindow.close()
    }
  }

  shouldShowLauncher(): boolean {
    return hasRecentPaths()
  }

  getDock(id: string): DockWindow | undefined {
    return this.docks.get(id)
  }

  getAllDocks(): DockWindow[] {
    return Array.from(this.docks.values())
  }

  shutdownAll(): void {
    for (const dock of this.docks.values()) {
      dock.close()
    }
    this.docks.clear()
  }

  get size(): number {
    return this.docks.size
  }
}
