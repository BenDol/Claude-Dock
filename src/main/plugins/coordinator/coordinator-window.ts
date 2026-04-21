/**
 * Floating window manager for the Coordinator.
 *
 * One BrowserWindow per project. Identical chat UI to the docked panel — the
 * standalone entrypoint mounts CoordinatorPanel with the project injected via
 * the `projectDir` query param.
 *
 * Terminal-spawn round-trips still target the main dock renderer (only it owns
 * the dock-store that mints terminal IDs), so a floating coordinator can drive
 * its project's dock without the dock window being focused.
 */
import { BrowserWindow } from 'electron'
import * as path from 'path'
import { getServices } from './services'
import { loadPluginWindow } from '../plugin-renderer-utils'

const svc = () => getServices()
const STATE_KEY_PREFIX = 'coordinator:'

export class CoordinatorWindowManager {
  private static instance: CoordinatorWindowManager
  private windows = new Map<string, BrowserWindow>()
  /** Projects whose window is being force-closed (project close / plugin disable / app quit). */
  private forceClosing = new Set<string>()

  static getInstance(): CoordinatorWindowManager {
    if (!CoordinatorWindowManager.instance) {
      CoordinatorWindowManager.instance = new CoordinatorWindowManager()
    }
    return CoordinatorWindowManager.instance
  }

  async open(projectDir: string): Promise<void> {
    const existing = this.windows.get(projectDir)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }

    const stateKey = STATE_KEY_PREFIX + projectDir
    const saved = svc().getWindowState(stateKey)
    const settings = svc().getSettings()
    const isDark = settings.theme.mode === 'dark' || settings.theme.mode === 'system'

    const win = new BrowserWindow({
      width: saved?.width ?? 480,
      height: saved?.height ?? 720,
      x: saved?.x,
      y: saved?.y,
      minWidth: 360,
      minHeight: 400,
      frame: false,
      title: `${path.basename(projectDir)} — Coordinator`,
      backgroundColor: isDark ? '#0f0f14' : '#f5f5f5',
      webPreferences: {
        preload: svc().paths.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    if (saved?.maximized) win.maximize()

    this.windows.set(projectDir, win)

    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win.webContents.toggleDevTools()
      }
    })

    const persistState = (): void => {
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

    win.webContents.on('render-process-gone', (_event, details) => {
      svc().log(`[coordinator-window] renderer gone for ${projectDir}: reason=${details.reason} exitCode=${details.exitCode}`)
      if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
        svc().log(`[coordinator-window] auto-reloading after crash for ${projectDir}`)
        setTimeout(() => {
          if (!win.isDestroyed()) {
            const queryParam = `?coordinator=true&projectDir=${encodeURIComponent(projectDir)}`
            loadPluginWindow(win, svc().paths, queryParam).catch((err) =>
              svc().logError('[coordinator-window] reload failed', err)
            )
          }
        }, 1000)
      }
    })
    win.on('unresponsive', () => svc().log(`[coordinator-window] unresponsive for ${projectDir}`))
    win.on('responsive', () => svc().log(`[coordinator-window] responsive again for ${projectDir}`))

    // Hide-on-close keeps reopening instant. Force-closes (project close, plugin
    // disable, app quit) set forceClosing and call win.destroy() instead.
    win.on('close', (event) => {
      if (this.forceClosing.has(projectDir)) return
      event.preventDefault()
      win.hide()
    })

    win.on('closed', () => {
      this.windows.delete(projectDir)
      this.forceClosing.delete(projectDir)
      svc().log(`[coordinator-window] closed for ${projectDir}`)
    })

    const queryParam = `?coordinator=true&projectDir=${encodeURIComponent(projectDir)}`
    await loadPluginWindow(win, svc().paths, queryParam)
    svc().log(`[coordinator-window] opened for ${projectDir}`)
  }

  focus(projectDir: string): boolean {
    const win = this.windows.get(projectDir)
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    return true
  }

  isOpen(projectDir: string): boolean {
    const win = this.windows.get(projectDir)
    return !!win && !win.isDestroyed() && win.isVisible()
  }

  getWindow(projectDir: string): BrowserWindow | null {
    const win = this.windows.get(projectDir)
    return win && !win.isDestroyed() ? win : null
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
