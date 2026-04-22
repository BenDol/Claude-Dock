/**
 * Standalone settings window for the Coordinator plugin.
 *
 * Opens a single global BrowserWindow that hosts the CoordinatorSettings form,
 * reusing the renderer bundle. This replaces the old in-panel overlay that
 * escaped its container (position: absolute with no positioned ancestor) and
 * rendered full-screen across the main dock.
 */
import { BrowserWindow } from 'electron'
import { getServices } from './services'
import { loadPluginWindow } from '../plugin-renderer-utils'

const svc = () => getServices()
const STATE_KEY = 'coordinator:settings'

export class CoordinatorSettingsWindowManager {
  private static instance: CoordinatorSettingsWindowManager
  private win: BrowserWindow | null = null

  static getInstance(): CoordinatorSettingsWindowManager {
    if (!CoordinatorSettingsWindowManager.instance) {
      CoordinatorSettingsWindowManager.instance = new CoordinatorSettingsWindowManager()
    }
    return CoordinatorSettingsWindowManager.instance
  }

  async open(): Promise<void> {
    const existing = this.win
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }

    const settings = svc().getSettings()
    const isDark = settings.theme.mode === 'dark' || settings.theme.mode === 'system'
    const saved = svc().getWindowState(STATE_KEY)

    const win = new BrowserWindow({
      width: saved?.width ?? 560,
      height: saved?.height ?? 640,
      x: saved?.x,
      y: saved?.y,
      minWidth: 420,
      minHeight: 420,
      frame: false,
      title: 'Coordinator Settings',
      backgroundColor: isDark ? '#0f0f14' : '#f5f5f5',
      webPreferences: {
        preload: svc().paths.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    this.win = win

    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win.webContents.toggleDevTools()
      }
    })

    const persistState = (): void => {
      if (win.isDestroyed()) return
      const bounds = win.getNormalBounds()
      svc().saveWindowState(STATE_KEY, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: win.isMaximized()
      })
    }
    win.on('resized', persistState)
    win.on('moved', persistState)

    win.webContents.on('render-process-gone', (_event, details) => {
      svc().log(`[coordinator-settings-window] renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
      if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
        setTimeout(() => {
          if (this.win && !this.win.isDestroyed()) {
            loadPluginWindow(this.win, svc().paths, '?coordinatorSettings=true').catch((err) =>
              svc().logError('[coordinator-settings-window] reload failed', err)
            )
          }
        }, 1000)
      }
    })
    win.on('unresponsive', () => svc().log('[coordinator-settings-window] unresponsive'))
    win.on('responsive', () => svc().log('[coordinator-settings-window] responsive again'))

    // Destroy on close — settings window is cheap to recreate and keeping a
    // hidden one around would preserve stale form state from a previous open.
    win.on('closed', () => {
      this.win = null
      svc().log('[coordinator-settings-window] closed')
    })

    await loadPluginWindow(win, svc().paths, '?coordinatorSettings=true')
    svc().log('[coordinator-settings-window] opened')
  }

  isOpen(): boolean {
    const win = this.win
    return !!win && !win.isDestroyed() && win.isVisible()
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy()
    }
  }
}
