import { BrowserWindow } from 'electron'
import * as path from 'path'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { log } from '../../logger'
import { broadcastPluginWindowState } from '../plugin-window-broadcast'

// Use a prefix so git-manager window state doesn't clash with dock window state
const STATE_KEY_PREFIX = 'gitmgr:'

/**
 * Manages Git Manager BrowserWindows, one per projectDir.
 */
export class GitManagerWindowManager {
  private static instance: GitManagerWindowManager
  private windows = new Map<string, BrowserWindow>()
  private commitDetailWindows = new Map<string, Set<BrowserWindow>>()

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
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      existing.webContents.send('git-manager:reopen')
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
      title: `${path.basename(projectDir)} - Git`,
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
    broadcastPluginWindowState('git-manager', projectDir, true)

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
      // Close all commit detail windows for this project
      const detailWins = this.commitDetailWindows.get(projectDir)
      if (detailWins) {
        for (const dw of detailWins) {
          if (!dw.isDestroyed()) dw.close()
        }
        this.commitDetailWindows.delete(projectDir)
      }
      broadcastPluginWindowState('git-manager', projectDir, false)
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

  async openCommitDetail(projectDir: string, commitHash: string): Promise<void> {
    const settings = getSettings()
    const isDark = settings.theme.mode === 'dark' ||
      (settings.theme.mode === 'system')

    // Size to 80% of the git-manager window (or its saved state)
    const stateKey = STATE_KEY_PREFIX + projectDir
    const gmState = getWindowState(stateKey)
    const baseW = gmState?.width ?? 1100
    const baseH = gmState?.height ?? 750
    const w = Math.round(baseW * 0.8)
    const h = Math.round(baseH * 0.8)

    const win = new BrowserWindow({
      width: Math.max(w, 600),
      height: Math.max(h, 400),
      minWidth: 600,
      minHeight: 400,
      frame: false,
      title: `${commitHash.slice(0, 8)} - Commit`,
      backgroundColor: isDark ? '#0f0f14' : '#f5f5f5',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    // Track this window so it closes when the git-manager window closes
    if (!this.commitDetailWindows.has(projectDir)) {
      this.commitDetailWindows.set(projectDir, new Set())
    }
    this.commitDetailWindows.get(projectDir)!.add(win)

    win.on('closed', () => {
      this.commitDetailWindows.get(projectDir)?.delete(win)
      log(`[git-manager] commit detail window closed for ${commitHash.slice(0, 8)}`)
    })

    const queryParam = `?gitManager=true&projectDir=${encodeURIComponent(projectDir)}&commitHash=${encodeURIComponent(commitHash)}`

    if (process.env.ELECTRON_RENDERER_URL) {
      await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${queryParam}`)
    } else {
      await win.loadFile(
        path.join(__dirname, '../renderer/index.html'),
        { search: queryParam.slice(1) }
      )
    }

    log(`[git-manager] commit detail window opened for ${commitHash.slice(0, 8)}`)
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
      win.close()
    }
  }

  closeAll(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.close()
    }
    this.windows.clear()
    for (const set of this.commitDetailWindows.values()) {
      for (const win of set) {
        if (!win.isDestroyed()) win.close()
      }
    }
    this.commitDetailWindows.clear()
  }
}
