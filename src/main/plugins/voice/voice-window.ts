import { BrowserWindow } from 'electron'
import { getServices } from './services'
import { loadPluginWindow } from '../plugin-renderer-utils'
import { VoiceServerManager } from './voice-server-manager'

const svc = () => getServices()
const STATE_KEY = 'voice:main'
const VIRTUAL_PROJECT_DIR = '__global__' // voice window is global, not per-project

/**
 * Manages the single shared Voice BrowserWindow (settings + setup wizard).
 * Unlike memory/git-manager, there is exactly one window for the whole app
 * because voice configuration is global across workspaces.
 */
export class VoiceWindowManager {
  private static instance: VoiceWindowManager
  private win: BrowserWindow | null = null
  private forceClosing = false

  static getInstance(): VoiceWindowManager {
    if (!VoiceWindowManager.instance) {
      VoiceWindowManager.instance = new VoiceWindowManager()
    }
    return VoiceWindowManager.instance
  }

  async open(): Promise<void> {
    const existing = this.win
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      svc().broadcastPluginWindowState('voice', VIRTUAL_PROJECT_DIR, true)
      return
    }

    const settings = svc().getSettings()
    const isDark = settings.theme.mode === 'dark' || settings.theme.mode === 'system'
    const saved = svc().getWindowState(STATE_KEY)

    const win = new BrowserWindow({
      width: saved?.width ?? 960,
      height: saved?.height ?? 720,
      x: saved?.x,
      y: saved?.y,
      minWidth: 720,
      minHeight: 520,
      frame: false,
      title: 'Voice',
      backgroundColor: isDark ? '#0f0f14' : '#f5f5f5',
      webPreferences: {
        preload: svc().paths.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    if (saved?.maximized) win.maximize()

    this.win = win
    VoiceServerManager.getInstance().registerVoiceWindow(win.id)
    svc().broadcastPluginWindowState('voice', VIRTUAL_PROJECT_DIR, true)

    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win.webContents.toggleDevTools()
      }
    })

    const persistState = () => {
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
    win.on('maximize', persistState)
    win.on('unmaximize', persistState)

    win.webContents.on('render-process-gone', (_event, details) => {
      svc().log(`[voice-window] renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
      if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
        svc().log('[voice-window] auto-reloading after crash')
        setTimeout(() => {
          if (this.win && !this.win.isDestroyed()) {
            loadPluginWindow(this.win, svc().paths, '?voice=true').catch(() => {})
          }
        }, 1000)
      }
    })

    win.on('unresponsive', () => svc().log('[voice-window] window unresponsive'))
    win.on('responsive', () => svc().log('[voice-window] window responsive again'))

    win.on('close', (event) => {
      if (this.forceClosing) return
      event.preventDefault()
      win.hide()
      svc().broadcastPluginWindowState('voice', VIRTUAL_PROJECT_DIR, false)
      svc().log('[voice-window] hidden')
    })

    win.on('closed', () => {
      VoiceServerManager.getInstance().unregisterVoiceWindow(win.id)
      this.win = null
      this.forceClosing = false
      svc().broadcastPluginWindowState('voice', VIRTUAL_PROJECT_DIR, false)
      svc().log('[voice-window] closed')
    })

    await loadPluginWindow(win, svc().paths, '?voice=true')
    svc().log('[voice-window] opened')
  }

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.forceClosing = true
      this.win.destroy()
    }
  }

  getWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }
}
