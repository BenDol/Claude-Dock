import { BrowserWindow } from 'electron'
import * as path from 'path'
import { getServices } from './services'
import { loadPluginWindow } from '../plugin-renderer-utils'

const svc = () => getServices()

// Use a prefix so git-manager window state doesn't clash with dock window state
const STATE_KEY_PREFIX = 'gitmgr:'

/**
 * Manages Git Manager BrowserWindows, one per projectDir.
 */
export class GitManagerWindowManager {
  private static instance: GitManagerWindowManager
  private windows = new Map<string, BrowserWindow>()
  private commitDetailWindows = new Map<string, Set<BrowserWindow>>()
  /** Tracks which windows are being force-closed (project close / plugin disable / app quit). */
  private forceClosing = new Set<string>()

  static getInstance(): GitManagerWindowManager {
    if (!GitManagerWindowManager.instance) {
      GitManagerWindowManager.instance = new GitManagerWindowManager()
    }
    return GitManagerWindowManager.instance
  }

  async open(projectDir: string): Promise<void> {
    // Re-show existing window if still alive (hidden or minimized)
    const existing = this.windows.get(projectDir)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      existing.webContents.send('git-manager:reopen')
      svc().broadcastPluginWindowState('git-manager', projectDir, true)
      return
    }

    const settings = svc().getSettings()
    const isDark = settings.theme.mode === 'dark' ||
      (settings.theme.mode === 'system')

    // Restore saved window state
    const stateKey = STATE_KEY_PREFIX + projectDir
    const saved = svc().getWindowState(stateKey)

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
    svc().broadcastPluginWindowState('git-manager', projectDir, true)

    // Save window state on move/resize/maximize/unmaximize
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

    // Intercept user-initiated close (X button, Alt+F4, taskbar close) and hide
    // instead of destroying the window, so reopening is instant.
    // Force-closes (project close, plugin disable, app quit) bypass this via
    // the forceClosing flag and use win.destroy().
    win.on('close', (event) => {
      if (this.forceClosing.has(projectDir)) return // let it close normally
      event.preventDefault()
      win.hide()
      svc().broadcastPluginWindowState('git-manager', projectDir, false)
      svc().log(`[git-manager] window hidden for ${projectDir}`)
    })

    win.on('closed', () => {
      this.windows.delete(projectDir)
      this.forceClosing.delete(projectDir)
      // Close all commit detail windows for this project
      const detailWins = this.commitDetailWindows.get(projectDir)
      if (detailWins) {
        for (const dw of detailWins) {
          if (!dw.isDestroyed()) dw.close()
        }
        this.commitDetailWindows.delete(projectDir)
      }
      svc().broadcastPluginWindowState('git-manager', projectDir, false)
      svc().log(`[git-manager] window closed for ${projectDir}`)
    })

    const queryParam = `?gitManager=true&projectDir=${encodeURIComponent(projectDir)}`
    await loadPluginWindow(win, svc().paths, queryParam)

    svc().log(`[git-manager] window opened for ${projectDir}`)
  }

  async openCommitDetail(projectDir: string, commitHash: string): Promise<void> {
    const settings = svc().getSettings()
    const isDark = settings.theme.mode === 'dark' ||
      (settings.theme.mode === 'system')

    // Size to 80% of the git-manager window (or its saved state)
    const stateKey = STATE_KEY_PREFIX + projectDir
    const gmState = svc().getWindowState(stateKey)
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
        preload: svc().paths.preload,
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
      svc().log(`[git-manager] commit detail window closed for ${commitHash.slice(0, 8)}`)
    })

    const queryParam = `?gitManager=true&projectDir=${encodeURIComponent(projectDir)}&commitHash=${encodeURIComponent(commitHash)}`
    await loadPluginWindow(win, svc().paths, queryParam)

    svc().log(`[git-manager] commit detail window opened for ${commitHash.slice(0, 8)}`)
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
    for (const set of this.commitDetailWindows.values()) {
      for (const win of set) {
        if (!win.isDestroyed()) win.destroy()
      }
    }
    this.commitDetailWindows.clear()
  }
}
