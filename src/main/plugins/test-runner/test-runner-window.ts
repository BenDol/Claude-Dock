import { BrowserWindow } from 'electron'
import * as path from 'path'
import { getServices } from './services'
import { loadPluginWindow } from '../plugin-renderer-utils'

const svc = () => getServices()
const STATE_KEY_PREFIX = 'testrunner:'

/**
 * Manages Test Runner BrowserWindows, one per projectDir.
 */
export class TestRunnerWindowManager {
  private static instance: TestRunnerWindowManager
  private windows = new Map<string, BrowserWindow>()
  private forceClosing = new Set<string>()

  static getInstance(): TestRunnerWindowManager {
    if (!TestRunnerWindowManager.instance) {
      TestRunnerWindowManager.instance = new TestRunnerWindowManager()
    }
    return TestRunnerWindowManager.instance
  }

  async open(projectDir: string): Promise<void> {
    const existing = this.windows.get(projectDir)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      svc().broadcastPluginWindowState('test-runner', projectDir, true)
      return
    }

    const settings = svc().getSettings()
    const isDark = settings.theme.mode === 'dark' || settings.theme.mode === 'system'

    const stateKey = STATE_KEY_PREFIX + projectDir
    const saved = svc().getWindowState(stateKey)

    const win = new BrowserWindow({
      width: saved?.width ?? 1000,
      height: saved?.height ?? 700,
      x: saved?.x,
      y: saved?.y,
      minWidth: 700,
      minHeight: 450,
      frame: false,
      title: `${path.basename(projectDir)} - Tests`,
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
    svc().broadcastPluginWindowState('test-runner', projectDir, true)

    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win.webContents.toggleDevTools()
      }
    })

    const persistState = () => {
      if (win.isDestroyed()) return
      const bounds = win.getNormalBounds()
      svc().saveWindowState(stateKey, {
        x: bounds.x, y: bounds.y,
        width: bounds.width, height: bounds.height,
        maximized: win.isMaximized()
      })
    }
    win.on('resized', persistState)
    win.on('moved', persistState)
    win.on('maximize', persistState)
    win.on('unmaximize', persistState)

    win.webContents.on('render-process-gone', (_event, details) => {
      svc().log(`[test-runner] renderer gone for ${projectDir}: reason=${details.reason} exitCode=${details.exitCode}`)
      if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
        setTimeout(() => {
          if (!win.isDestroyed()) {
            const q = `?testRunner=true&projectDir=${encodeURIComponent(projectDir)}`
            loadPluginWindow(win, svc().paths, q).catch(() => {})
          }
        }, 1000)
      }
    })
    win.on('unresponsive', () => svc().log(`[test-runner] window unresponsive for ${projectDir}`))
    win.on('responsive', () => svc().log(`[test-runner] window responsive again for ${projectDir}`))

    win.on('close', (event) => {
      if (this.forceClosing.has(projectDir)) return
      event.preventDefault()
      win.hide()
      svc().broadcastPluginWindowState('test-runner', projectDir, false)
    })

    win.on('closed', () => {
      this.windows.delete(projectDir)
      this.forceClosing.delete(projectDir)
      svc().broadcastPluginWindowState('test-runner', projectDir, false)
    })

    const q = `?testRunner=true&projectDir=${encodeURIComponent(projectDir)}`
    await loadPluginWindow(win, svc().paths, q)
    svc().log(`[test-runner] window opened for ${projectDir}`)
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
