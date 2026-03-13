import { BrowserWindow, dialog, shell } from 'electron'
import * as path from 'path'
import { PtyManager } from './pty-manager'
import { IPC } from '../shared/ipc-channels'
import { getSessions, saveSessions, clearSessions } from './session-store'
import { saveBuffer, loadBuffer, clearBuffer } from './buffer-store'
import { getWindowState, saveWindowState, WindowState } from './window-state-store'
import { ActivityTracker } from './activity-tracker'
import { log } from './logger'

declare const __DEV__: boolean

// Max PTY output to keep per terminal (~500KB)
const MAX_BUFFER_SIZE = 512 * 1024
const ENABLE_BUFFER_STORAGE = false

export class DockWindow {
  readonly id: string
  readonly projectDir: string
  readonly window: BrowserWindow
  readonly ptyManager: PtyManager
  private savedResumeIds: string[]
  private outputBuffers = new Map<string, string>()

  constructor(id: string, projectDir: string) {
    this.id = id
    this.projectDir = projectDir
    log(`DockWindow: constructor id=${id} dir=${projectDir}`)
    this.savedResumeIds = getSessions(projectDir)
    log(`DockWindow: ${this.savedResumeIds.length} saved sessions`)

    const saved = getWindowState(projectDir)
    log(`DockWindow: creating BrowserWindow`)

    this.window = new BrowserWindow({
      width: saved?.width ?? 1200,
      height: saved?.height ?? 800,
      ...(saved ? { x: saved.x, y: saved.y } : {}),
      minWidth: 600,
      minHeight: 400,
      show: false, // Defer show until page is ready to avoid GPU blocking
      frame: false,
      backgroundColor: '#0f0f14',
      title: `${path.basename(projectDir)} - Claude Dock`,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false // Required for node-pty via preload
      }
    })

    this.window.once('ready-to-show', () => {
      log(`DockWindow ${id}: ready-to-show`)
      this.window.show()
      if (saved?.maximized) {
        this.window.maximize()
      }
    })

    log(`DockWindow: BrowserWindow created`)
    this.trackWindowState()

    this.ptyManager = new PtyManager(
      (terminalId, data) => {
        if (!this.window.isDestroyed()) {
          this.window.webContents.send(IPC.TERMINAL_DATA, terminalId, data)
        }
        // Accumulate output for buffer persistence
        if (ENABLE_BUFFER_STORAGE) {
          try {
            const existing = this.outputBuffers.get(terminalId) || ''
            const combined = existing + data
            this.outputBuffers.set(
              terminalId,
              combined.length > MAX_BUFFER_SIZE
                ? combined.slice(combined.length - MAX_BUFFER_SIZE)
                : combined
            )
          } catch (e) { log(`buffer accumulate error: ${e}`) }
        }
        try { ActivityTracker.getInstance().trackData(this.id, terminalId, data) } catch (e) { log(`ActivityTracker.trackData error: ${e}`) }
      },
      (terminalId, exitCode) => {
        if (!this.window.isDestroyed()) {
          this.window.webContents.send(IPC.TERMINAL_EXIT, terminalId, exitCode)
        }
        try { ActivityTracker.getInstance().setTerminalAlive(this.id, terminalId, false) } catch (e) { log(`ActivityTracker.setTerminalAlive error: ${e}`) }
      },
      (sessionId) => {
        // Persist session immediately when a fresh terminal is created
        this.persistCurrentSessions()
      },
      () => {
        // Update session store when a terminal is closed/exited
        this.persistCurrentSessions()
      }
    )

    this.window.webContents.on('render-process-gone', (_event, details) => {
      log(`DockWindow ${id}: renderer gone reason=${details.reason} exitCode=${details.exitCode}`)
    })

    this.window.on('unresponsive', () => {
      log(`DockWindow ${id}: window unresponsive`)
    })

    this.window.on('responsive', () => {
      log(`DockWindow ${id}: window responsive again`)
    })

    // Open external links in browser
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // Confirm before closing if terminals are running
    this.window.on('close', (e) => {
      if (this.ptyManager.size > 0) {
        e.preventDefault()
        const count = this.ptyManager.size
        dialog
          .showMessageBox(this.window, {
            type: 'warning',
            buttons: ['Close', 'Clear Session && Close', 'Cancel'],
            defaultId: 2,
            cancelId: 2,
            title: 'Close Dock',
            message: `${count} terminal${count !== 1 ? 's' : ''} still running.`,
            detail: 'Close: close and keep saved sessions for resuming.\nClear Session: discard saved sessions and close.'
          })
          .then(({ response }) => {
            if (response === 0) {
              // Close (sessions already persisted on spawn)
              if (ENABLE_BUFFER_STORAGE) this.saveOutputBuffers()
              this.ptyManager.killAll()
              this.window.destroy()
            } else if (response === 1) {
              // Clear Session & Close
              if (ENABLE_BUFFER_STORAGE) this.clearOutputBuffers()
              clearSessions(this.projectDir)
              this.ptyManager.killAll()
              this.window.destroy()
            }
            // response === 2: Cancel — do nothing
          })
      }
    })

    this.window.on('closed', () => {
      this.ptyManager.killAll()
      try { ActivityTracker.getInstance().removeDock(this.id) } catch (e) { log(`ActivityTracker.removeDock error: ${e}`) }
    })
  }

  private trackWindowState(): void {
    let saveTimeout: ReturnType<typeof setTimeout> | null = null

    const save = (): void => {
      if (saveTimeout) clearTimeout(saveTimeout)
      saveTimeout = setTimeout(() => {
        if (this.window.isDestroyed()) return
        const maximized = this.window.isMaximized()
        // Save the normal (non-maximized) bounds so restore works properly
        const bounds = maximized ? this.window.getNormalBounds() : this.window.getBounds()
        const state: WindowState = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          maximized
        }
        saveWindowState(this.projectDir, state)
      }, 300)
    }

    this.window.on('resize', save)
    this.window.on('move', save)
    this.window.on('maximize', save)
    this.window.on('unmaximize', save)
  }

  private persistCurrentSessions(): void {
    const ids = this.ptyManager.getSessionIds()
    if (ids.length > 0) {
      saveSessions(this.projectDir, ids)
    } else {
      clearSessions(this.projectDir)
    }
  }

  get savedSessionCount(): number {
    return this.savedResumeIds.length
  }

  getNextResumeId(): string | undefined {
    return this.savedResumeIds.shift()
  }

  async loadRenderer(): Promise<void> {
    const queryParam = `?dockId=${encodeURIComponent(this.id)}&projectDir=${encodeURIComponent(this.projectDir)}`

    if (process.env.ELECTRON_RENDERER_URL) {
      await this.window.loadURL(`${process.env.ELECTRON_RENDERER_URL}${queryParam}`)
    } else {
      await this.window.loadFile(
        path.join(__dirname, '../renderer/index.html'),
        { search: queryParam.slice(1) }
      )
    }
  }

  /**
   * Restore saved terminal buffer by sending it as data before PTY starts.
   * Called from the TERMINAL_SPAWN IPC handler for resumed sessions.
   */
  restoreBuffer(terminalId: string, sessionId: string): void {
    if (!ENABLE_BUFFER_STORAGE) return
    try {
      const data = loadBuffer(sessionId)
      if (data && !this.window.isDestroyed()) {
        this.window.webContents.send(IPC.TERMINAL_DATA, terminalId, data)
        // Seed the output buffer so it's available if we close again
        this.outputBuffers.set(terminalId, data)
        log(`DockWindow: restored ${data.length} bytes for session ${sessionId.slice(0, 8)}`)
      }
    } catch (e) {
      log(`DockWindow: restoreBuffer error: ${e}`)
    }
  }

  private saveOutputBuffers(): void {
    try {
      for (const [terminalId, data] of this.outputBuffers) {
        const sessionId = this.ptyManager.getSessionId(terminalId)
        if (sessionId && data.length > 0) {
          saveBuffer(sessionId, data)
        }
      }
      log(`DockWindow: saved ${this.outputBuffers.size} terminal buffer(s)`)
    } catch (e) {
      log(`DockWindow: saveOutputBuffers error: ${e}`)
    }
  }

  private clearOutputBuffers(): void {
    try {
      for (const [terminalId] of this.outputBuffers) {
        const sessionId = this.ptyManager.getSessionId(terminalId)
        if (sessionId) clearBuffer(sessionId)
      }
      this.outputBuffers.clear()
    } catch (e) {
      log(`DockWindow: clearOutputBuffers error: ${e}`)
    }
  }

  close(): void {
    if (ENABLE_BUFFER_STORAGE) this.saveOutputBuffers()
    this.ptyManager.killAll()
    if (!this.window.isDestroyed()) {
      this.window.close()
    }
  }
}
