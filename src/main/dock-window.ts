import { BrowserWindow, shell } from 'electron'
import * as path from 'path'
import { PtyManager } from './pty-manager'
import { IPC } from '../shared/ipc-channels'

export class DockWindow {
  readonly id: string
  readonly projectDir: string
  readonly window: BrowserWindow
  readonly ptyManager: PtyManager

  constructor(id: string, projectDir: string) {
    this.id = id
    this.projectDir = projectDir

    this.window = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
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
      }
    )

    // Open external links in browser
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    this.window.on('closed', () => {
      this.ptyManager.killAll()
    })
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
