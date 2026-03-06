import { BrowserWindow, dialog } from 'electron'
import * as path from 'path'
import { DockWindow } from './dock-window'
import { addRecentPath } from './recent-store'
import { getSettings } from './settings-store'
import { log, logError } from './logger'

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
    log(`createDock: creating DockWindow id=${id} dir=${dir}`)
    const dock = new DockWindow(id, dir)
    log(`createDock: DockWindow created`)

    this.docks.set(id, dock)

    dock.window.on('closed', () => {
      log(`dock ${id} closed`)
      this.docks.delete(id)
    })

    // Don't await - window is visible immediately, page loads in background.
    // Blocking here starves the event loop during BrowserWindow page load,
    // freezing any existing windows (launcher, other docks).
    dock.loadRenderer().catch((err) => {
      logError('Failed to load dock renderer:', err)
    })
    log(`createDock: loadRenderer started (fire-and-forget)`)
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
      log('closeLauncher: closing')
      this.launcherWindow.close()
    }
  }

  /** Close launcher and wait for it to be fully destroyed before resolving */
  async closeLauncherAndWait(): Promise<void> {
    if (!this.launcherWindow || this.launcherWindow.isDestroyed()) return
    log('closeLauncherAndWait: waiting for closed event')
    return new Promise((resolve) => {
      this.launcherWindow!.once('closed', () => {
        log('closeLauncherAndWait: launcher fully closed')
        resolve()
      })
      this.launcherWindow!.close()
    })
  }

  shouldShowLauncher(): boolean {
    return true
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
