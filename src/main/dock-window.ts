import { BrowserWindow, dialog, shell } from 'electron'
import * as path from 'path'
import { PtyManager } from './pty-manager'
import { IPC } from '../shared/ipc-channels'
import { getSessions, saveSessions, clearSessions } from './session-store'

export class DockWindow {
  readonly id: string
  readonly projectDir: string
  readonly window: BrowserWindow
  readonly ptyManager: PtyManager
  private savedResumeIds: string[]

  constructor(id: string, projectDir: string) {
    this.id = id
    this.projectDir = projectDir
    this.savedResumeIds = getSessions(projectDir)

    this.window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      frame: false,
      title: `Claude Dock - ${path.basename(projectDir)}`,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false // Required for node-pty via preload
      }
    })

    this.ptyManager = new PtyManager(
      (terminalId, data) => {
        if (!this.window.isDestroyed()) {
          this.window.webContents.send(IPC.TERMINAL_DATA, terminalId, data)
        }
      },
      (terminalId, exitCode) => {
        if (!this.window.isDestroyed()) {
          this.window.webContents.send(IPC.TERMINAL_EXIT, terminalId, exitCode)
        }
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
              this.ptyManager.killAll()
              this.window.destroy()
            } else if (response === 1) {
              // Clear Session & Close
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
    })
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

  close(): void {
    this.ptyManager.killAll()
    if (!this.window.isDestroyed()) {
      this.window.close()
    }
  }
}
