/**
 * Manages detached editor BrowserWindows, one per projectDir.
 *
 * The detached editor is a secondary window that hosts the same EditorOverlay
 * as the dock window. When marked as "primary", new file opens are routed to
 * it instead of the dock. State (open, primary, bounds) persists across restarts.
 */

import { BrowserWindow, screen } from 'electron'
import * as path from 'path'
import { log, logError } from '../../logger'
import {
  getEditorWindowState,
  saveEditorWindowState,
  clearEditorWindowState,
  type EditorWindowBounds
} from './editor-window-store'

// IPC channels used to push events from main → detached/dock renderers.
// Kept here (not in shared/ipc-channels.ts) because they're one-way push-only
// events, not invoke handlers — matching the pattern of `git-manager:reopen` etc.
const CH_OPEN_FILE = 'editor:open-file'
const CH_HYDRATE_TABS = 'editor:hydrate-tabs'

const PERSIST_DEBOUNCE_MS = 300

export interface OpenFileRequest {
  projectDir: string
  relativePath: string
  content: string
  line?: number
  column?: number
}

interface WindowEntry {
  window: BrowserWindow
  forceClosing: boolean
  persistTimer: ReturnType<typeof setTimeout> | null
}

/** Project paths are stored case-insensitively with forward slashes for cross-platform consistency. */
function normalizeKey(projectDir: string): string {
  return projectDir.replace(/\\/g, '/').toLowerCase()
}

/** Validate that the saved bounds are at least partially visible on a current display. */
function isVisibleOnAnyDisplay(bounds: EditorWindowBounds): boolean {
  const cx = bounds.x + Math.floor(bounds.width / 2)
  const cy = bounds.y + Math.floor(bounds.height / 2)
  for (const display of screen.getAllDisplays()) {
    const { x, y, width, height } = display.workArea
    if (cx >= x && cx < x + width && cy >= y && cy < y + height) return true
  }
  return false
}

export class EditorWindowManager {
  private static instance: EditorWindowManager | null = null
  private windows = new Map<string, WindowEntry>()

  static getInstance(): EditorWindowManager {
    if (!EditorWindowManager.instance) {
      EditorWindowManager.instance = new EditorWindowManager()
    }
    return EditorWindowManager.instance
  }

  /** Get the live BrowserWindow for a project, or null. */
  getWindow(projectDir: string): BrowserWindow | null {
    const key = normalizeKey(projectDir)
    const entry = this.windows.get(key)
    if (!entry) return null
    if (entry.window.isDestroyed()) {
      this.windows.delete(key)
      return null
    }
    return entry.window
  }

  /**
   * Create the detached window if missing; focus + reuse if exists.
   * Initial tabs are pushed to the renderer once it finishes loading,
   * eliminating the need for a renderer-side polling retry.
   */
  async openOrFocus(projectDir: string, initialTabsJson: string | null = null, markPrimary = true): Promise<void> {
    const key = normalizeKey(projectDir)
    const existing = this.windows.get(key)

    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.show()
      existing.window.focus()
      if (initialTabsJson) {
        try { existing.window.webContents.send(CH_HYDRATE_TABS, initialTabsJson) } catch { /* window gone mid-call */ }
      }
      if (markPrimary) saveEditorWindowState(projectDir, { open: true, primary: true })
      return
    }

    const saved = getEditorWindowState(projectDir)
    // Validate saved bounds — monitors may have changed since persistence
    const bounds = saved?.bounds && isVisibleOnAnyDisplay(saved.bounds) ? saved.bounds : undefined

    const win = new BrowserWindow({
      width: bounds?.width ?? 900,
      height: bounds?.height ?? 650,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 500,
      minHeight: 350,
      frame: false,
      title: 'Editor',
      backgroundColor: '#1e1e2e',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    if (bounds?.maximized) win.maximize()

    const entry: WindowEntry = { window: win, forceClosing: false, persistTimer: null }
    this.windows.set(key, entry)

    // Debounced bounds persistence — resize/move can fire dozens of times per second
    const persistBounds = (): void => {
      if (entry.persistTimer) clearTimeout(entry.persistTimer)
      entry.persistTimer = setTimeout(() => {
        entry.persistTimer = null
        if (win.isDestroyed()) return
        const b = win.getNormalBounds()
        saveEditorWindowState(projectDir, {
          bounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
        })
      }, PERSIST_DEBOUNCE_MS)
    }
    win.on('resized', persistBounds)
    win.on('moved', persistBounds)
    win.on('maximize', persistBounds)
    win.on('unmaximize', persistBounds)

    // Frameless windows have no menu — provide DevTools shortcut explicitly
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win.webContents.toggleDevTools()
      }
    })

    win.webContents.on('render-process-gone', (_e, details) => {
      log(`[editor-window] renderer gone for ${projectDir}: reason=${details.reason}`)
    })

    win.on('closed', () => {
      const e = this.windows.get(key)
      this.windows.delete(key)
      if (e?.persistTimer) clearTimeout(e.persistTimer)
      if (e?.forceClosing) {
        clearEditorWindowState(projectDir)
        log(`[editor-window] closed (force) for ${projectDir}`)
      } else {
        // User-initiated close: dock reclaims as default destination
        saveEditorWindowState(projectDir, { open: false, primary: false })
        log(`[editor-window] closed for ${projectDir}`)
      }
    })

    // Persist `open: true` BEFORE loading — protects against crashes during load
    saveEditorWindowState(projectDir, markPrimary ? { open: true, primary: true } : { open: true })

    // Push initial tabs after the renderer has loaded — guarantees the
    // listener is attached. Avoids the renderer-side polling retry.
    if (initialTabsJson) {
      win.webContents.once('did-finish-load', () => {
        try { win.webContents.send(CH_HYDRATE_TABS, initialTabsJson) } catch { /* ignore */ }
      })
    }

    const queryParam = `?detachedEditor=true&projectDir=${encodeURIComponent(projectDir)}`
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    if (rendererUrl) {
      await win.loadURL(`${rendererUrl}${queryParam}`)
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/index.html'), { search: queryParam.slice(1) })
    }

    log(`[editor-window] opened for ${projectDir}${initialTabsJson ? ' with initial tabs' : ''}`)
  }

  /**
   * Forward a file-open request to the detached window's renderer.
   * Returns true if the request was forwarded; false if no window exists.
   */
  forwardOpenFile(projectDir: string, req: OpenFileRequest): boolean {
    const win = this.getWindow(projectDir)
    if (!win) return false
    try {
      win.webContents.send(CH_OPEN_FILE, req)
      win.show()
      win.focus()
      return true
    } catch (err) {
      logError('[editor-window] forwardOpenFile failed:', err)
      return false
    }
  }

  /**
   * Move tabs from the detached window back to the dock window for the same project.
   */
  redock(projectDir: string, tabsJson: string, dockWebContents: Electron.WebContents | null): boolean {
    if (dockWebContents && !dockWebContents.isDestroyed()) {
      try { dockWebContents.send(CH_HYDRATE_TABS, tabsJson) } catch (err) {
        logError('[editor-window] redock send failed:', err)
      }
    }
    return this.close(projectDir, true)
  }

  /** Close (destroy) the detached window for a project. `force=true` clears persistence. */
  close(projectDir: string, force = false): boolean {
    const entry = this.windows.get(normalizeKey(projectDir))
    if (!entry) return false
    entry.forceClosing = force
    if (!entry.window.isDestroyed()) entry.window.destroy()
    return true
  }

  /** Close every window (used on app shutdown — preserves state for next launch). */
  closeAll(): void {
    for (const [key, entry] of this.windows) {
      entry.forceClosing = false
      if (entry.persistTimer) clearTimeout(entry.persistTimer)
      try { if (!entry.window.isDestroyed()) entry.window.destroy() } catch { /* ignore */ }
      this.windows.delete(key)
    }
  }
}
