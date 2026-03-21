import { BrowserWindow } from 'electron'
import * as path from 'path'
import { getServices } from './services'
import { loadPluginWindow } from '../plugin-renderer-utils'

const svc = () => getServices()
const STATE_KEY_PREFIX = 'cloud:'

/**
 * Manages Cloud Integration BrowserWindows, one per projectDir.
 */
export class CloudWindowManager {
  private static instance: CloudWindowManager
  private windows = new Map<string, BrowserWindow>()
  private forceClosing = new Set<string>()

  static getInstance(): CloudWindowManager {
    if (!CloudWindowManager.instance) {
      CloudWindowManager.instance = new CloudWindowManager()
    }
    return CloudWindowManager.instance
  }

  async open(projectDir: string): Promise<void> {
    const existing = this.windows.get(projectDir)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      svc().broadcastPluginWindowState('cloud-integration', projectDir, true)
      return
    }

    const settings = svc().getSettings()
    const isDark = settings.theme.mode === 'dark' || settings.theme.mode === 'system'

    const stateKey = STATE_KEY_PREFIX + projectDir
    const saved = svc().getWindowState(stateKey)

    const win = new BrowserWindow({
      width: saved?.width ?? 1050,
      height: saved?.height ?? 700,
      x: saved?.x,
      y: saved?.y,
      minWidth: 750,
      minHeight: 500,
      frame: false,
      title: `${path.basename(projectDir)} - Cloud`,
      backgroundColor: isDark ? '#0f0f14' : '#f5f5f5',
      webPreferences: {
        preload: svc().paths.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    if (saved?.maximized) {
      win.maximize()
    }

    this.windows.set(projectDir, win)
    svc().broadcastPluginWindowState('cloud-integration', projectDir, true)

    const persistState = () => {
      if (win.isDestroyed()) return
      const bounds = win.getNormalBounds()
      svc().saveWindowState(stateKey, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: win.isMaximized()
      })
    }

    win.on('resized', persistState)
    win.on('moved', persistState)
    win.on('maximize', persistState)
    win.on('unmaximize', persistState)

    win.on('close', (event) => {
      if (this.forceClosing.has(projectDir)) return
      event.preventDefault()
      win.hide()
      svc().broadcastPluginWindowState('cloud-integration', projectDir, false)
      svc().log('[cloud-integration] window hidden for ' + projectDir)
    })

    win.on('closed', () => {
      this.windows.delete(projectDir)
      this.forceClosing.delete(projectDir)
      svc().broadcastPluginWindowState('cloud-integration', projectDir, false)
      svc().log('[cloud-integration] window closed for ' + projectDir)
    })

    const queryParam = `?cloudIntegration=true&projectDir=${encodeURIComponent(projectDir)}`
    await loadPluginWindow(win, svc().paths, queryParam)

    svc().log('[cloud-integration] window opened for ' + projectDir)
  }

  getWindow(projectDir: string): BrowserWindow | null {
    const win = this.windows.get(projectDir)
    return win && !win.isDestroyed() ? win : null
  }

  isOpen(projectDir: string): boolean {
    const win = this.windows.get(projectDir)
    return !!win && !win.isDestroyed()
  }

  close(projectDir: string): void {
    const win = this.windows.get(projectDir)
    if (win && !win.isDestroyed()) {
      this.forceClosing.add(projectDir)
      win.destroy()
    }
  }

  closeAll(): void {
    for (const [dir, win] of this.windows) {
      if (!win.isDestroyed()) {
        this.forceClosing.add(dir)
        win.destroy()
      }
    }
    this.windows.clear()
  }
}
