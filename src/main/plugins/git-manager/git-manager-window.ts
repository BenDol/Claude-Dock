import { BrowserWindow } from 'electron'
import * as path from 'path'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { log } from '../../logger'

// Use a prefix so git-manager window state doesn't clash with dock window state
const STATE_KEY_PREFIX = 'gitmgr:'

/**
 * Manages Git Manager BrowserWindows, one per projectDir.
 */
export class GitManagerWindowManager {
  private static instance: GitManagerWindowManager
  private windows = new Map<string, BrowserWindow>()

  static getInstance(): GitManagerWindowManager {
    if (!GitManagerWindowManager.instance) {
      GitManagerWindowManager.instance = new GitManagerWindowManager()
    }
    return GitManagerWindowManager.instance
  }

  async open(projectDir: string): Promise<void> {
    // Focus existing window if already open
    const existing = this.windows.get(projectDir)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return
    }

    const settings = getSettings()
    const isDark = settings.theme.mode === 'dark' ||
      (settings.theme.mode === 'system')

    // Restore saved window state
    const stateKey = STATE_KEY_PREFIX + projectDir
    const saved = getWindowState(stateKey)

    const win = new BrowserWindow({
      width: saved?.width ?? 1100,
      height: saved?.height ?? 750,
      x: saved?.x,
      y: saved?.y,
      minWidth: 800,
      minHeight: 500,
      frame: false,
      title: `Git - ${path.basename(projectDir)}`,
      backgroundColor: isDark ? '#0f0f14' : '#f5f5f5',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    if (saved?.maximized) {
      win.maximize()
    }

    this.windows.set(projectDir, win)

    // Save window state on move/resize/maximize/unmaximize
    const persistState = () => {
      if (win.isDestroyed()) return
      const bounds = win.getNormalBounds()
      saveWindowState(stateKey, {
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

    win.on('closed', () => {
      this.windows.delete(projectDir)
      log(`[git-manager] window closed for ${projectDir}`)
    })

    const queryParam = `?gitManager=true&projectDir=${encodeURIComponent(projectDir)}`

    if (process.env.ELECTRON_RENDERER_URL) {
      await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${queryParam}`)
    } else {
      await win.loadFile(
        path.join(__dirname, '../renderer/index.html'),
        { search: queryParam.slice(1) }
      )
    }

    log(`[git-manager] window opened for ${projectDir}`)
  }

  close(projectDir: string): void {
    const win = this.windows.get(projectDir)
    if (win && !win.isDestroyed()) {
      win.close()
    }
  }

  closeAll(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.close()
    }
    this.windows.clear()
  }
}
