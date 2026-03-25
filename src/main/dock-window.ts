import { BrowserWindow, dialog, shell, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { PtyManager } from './pty-manager'
import { IPC } from '../shared/ipc-channels'
import { getSessions, saveSessions, clearSessions } from './session-store'
import { saveBuffer, loadBuffer, clearBuffer } from './buffer-store'
import { getWindowState, saveWindowState, WindowState } from './window-state-store'
import { getSettings, setSetting } from './settings-store'
import { ProjectSettingsWatcher } from './project-settings'
import { ActivityTracker } from './activity-tracker'
import { IdleNotifier } from './idle-notifier'
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
  private readonly idleNotifier: IdleNotifier
  private readonly projectSettingsWatcher: ProjectSettingsWatcher
  private shellCommandWatcher: ReturnType<typeof setInterval> | null = null
  private processedCommandIds = new Set<string>()
  private savedResumeIds: string[]
  private outputBuffers = new Map<string, string>()
  /** Buffered shell panel output per shell ID, written to shared file for MCP access */
  private shellOutputBuffers = new Map<string, string>()
  private shellOutputSaveTimer: ReturnType<typeof setTimeout> | null = null

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
    this.idleNotifier = new IdleNotifier(this.window)

    // Watch .claude/dock.json and dock.local.json for external edits
    this.projectSettingsWatcher = new ProjectSettingsWatcher(projectDir, (merged) => {
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(IPC.SETTINGS_CHANGED, merged)
      }
    })
    this.projectSettingsWatcher.start()

    // Poll for MCP shell commands (file-based bridge from claude-dock-mcp.js)
    this.startShellCommandWatcher()

    this.ptyManager = new PtyManager(
      (terminalId, data) => {
        if (this.window.isDestroyed()) return
        // Route shell panel PTY data to the SHELL_DATA channel
        if (terminalId.startsWith('shell:')) {
          this.window.webContents.send(IPC.SHELL_DATA, terminalId, data)
          // Buffer shell output for MCP readback
          this.trackShellOutput(terminalId, data)
          return
        }


        this.window.webContents.send(IPC.TERMINAL_DATA, terminalId, data)
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
        try { this.idleNotifier.trackData(terminalId, data) } catch (e) { log(`IdleNotifier.trackData error: ${e}`) }
      },
      (terminalId, exitCode) => {
        if (this.window.isDestroyed()) return
        // Route shell panel PTY exit to the SHELL_EXIT channel
        if (terminalId.startsWith('shell:')) {
          this.window.webContents.send(IPC.SHELL_EXIT, terminalId, exitCode)
          return
        }
        this.window.webContents.send(IPC.TERMINAL_EXIT, terminalId, exitCode)
        try { ActivityTracker.getInstance().setTerminalAlive(this.id, terminalId, false) } catch (e) { log(`ActivityTracker.setTerminalAlive error: ${e}`) }
        try { this.idleNotifier.removeTerminal(terminalId) } catch (e) { log(`IdleNotifier.removeTerminal error: ${e}`) }
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
        const { closeAction } = getSettings().behavior

        // Remembered choice — skip dialog
        if (closeAction === 'close') {
          if (ENABLE_BUFFER_STORAGE) this.saveOutputBuffers()
          this.ptyManager.killAll()
          return // allow close
        }
        if (closeAction === 'clearAndClose') {
          if (ENABLE_BUFFER_STORAGE) this.clearOutputBuffers()
          clearSessions(this.projectDir)
          this.ptyManager.killAll()
          return // allow close
        }

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
            detail: 'Close: close and keep saved sessions for resuming.\nClear Session: discard saved sessions and close.',
            checkboxLabel: 'Remember this choice',
            checkboxChecked: false
          })
          .then(({ response, checkboxChecked }) => {
            if (response === 0) {
              if (checkboxChecked) {
                setSetting('behavior', { ...getSettings().behavior, closeAction: 'close' })
              }
              if (ENABLE_BUFFER_STORAGE) this.saveOutputBuffers()
              this.ptyManager.killAll()
              this.window.destroy()
            } else if (response === 1) {
              if (checkboxChecked) {
                setSetting('behavior', { ...getSettings().behavior, closeAction: 'clearAndClose' })
              }
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
      this.projectSettingsWatcher.stop()
      if (this.shellCommandWatcher) clearInterval(this.shellCommandWatcher)
      try { ActivityTracker.getInstance().removeDock(this.id) } catch (e) { log(`ActivityTracker.removeDock error: ${e}`) }
      try { this.idleNotifier.dispose() } catch (e) { log(`IdleNotifier.dispose error: ${e}`) }
    })
  }

  /**
   * Poll dock-shell-commands.json for commands sent by the MCP server.
   * Commands are matched to this dock by projectDir and routed to the
   * shell panel via SHELL_RUN_COMMAND IPC.
   */
  private startShellCommandWatcher(): void {
    const cmdFile = path.join(
      app.getPath('userData'),
      'dock-shell-commands.json'
    )
    const normProjectDir = this.projectDir.replace(/\\/g, '/').toLowerCase()

    this.shellCommandWatcher = setInterval(() => {
      try {
        if (!fs.existsSync(cmdFile)) return
        const raw = fs.readFileSync(cmdFile, 'utf-8')
        const commands = JSON.parse(raw)
        if (!Array.isArray(commands)) return

        const cutoff = Date.now() - 30000 // ignore commands older than 30s
        let changed = false

        for (const cmd of commands) {
          if (!cmd.id || !cmd.command || cmd.timestamp < cutoff) continue
          if (this.processedCommandIds.has(cmd.id)) continue

          // Always require projectDir match — commands without a projectDir
          // are skipped to prevent routing to the wrong workspace.
          if (!cmd.projectDir) continue
          const normCmd = cmd.projectDir.replace(/\\/g, '/').toLowerCase()
          if (normCmd !== normProjectDir && !normProjectDir.startsWith(normCmd + '/')) continue

          this.processedCommandIds.add(cmd.id)
          changed = true

          if (!this.window.isDestroyed()) {
            const submit = cmd.submit ?? true
            // Resolve sessionId to terminalId so the renderer routes to the right terminal
            let targetTerminalId: string | null = null
            if (cmd.sessionId) {
              targetTerminalId = this.ptyManager.findTerminalBySessionId(cmd.sessionId)
            }
            const shellType = cmd.shell || null
            log(`[shell-command] routing MCP command to shell: ${cmd.command} (submit=${submit}, target=${targetTerminalId || 'focused'}, shell=${shellType || 'default'})`)
            this.window.webContents.send(IPC.SHELL_RUN_COMMAND, cmd.command, submit, targetTerminalId, shellType)
          }
        }

        // Clean up processed IDs to prevent memory growth
        if (this.processedCommandIds.size > 100) {
          const ids = commands.map((c: any) => c.id).filter(Boolean)
          const activeIds = new Set(ids)
          for (const id of this.processedCommandIds) {
            if (!activeIds.has(id)) this.processedCommandIds.delete(id)
          }
        }
      } catch {
        // File read/parse errors are expected (race with MCP writer)
      }
    }, 500) // Poll every 500ms
  }

  // Max shell output to keep per shell (~50KB)
  private static readonly MAX_SHELL_OUTPUT = 50 * 1024
  // Strip ANSI escape sequences for clean text output
  private static stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  }

  private trackShellOutput(shellId: string, data: string): void {
    const clean = DockWindow.stripAnsi(data)
    const existing = this.shellOutputBuffers.get(shellId) || ''
    const combined = existing + clean
    this.shellOutputBuffers.set(
      shellId,
      combined.length > DockWindow.MAX_SHELL_OUTPUT
        ? combined.slice(combined.length - DockWindow.MAX_SHELL_OUTPUT)
        : combined
    )
    this.scheduleShellOutputSave()
  }

  private scheduleShellOutputSave(): void {
    if (this.shellOutputSaveTimer) return
    this.shellOutputSaveTimer = setTimeout(() => {
      this.shellOutputSaveTimer = null
      this.saveShellOutput()
    }, 500)
  }

  private saveShellOutput(): void {
    try {
      const outputFile = path.join(app.getPath('userData'), 'dock-shell-output.json')
      let existing: Record<string, any> = {}
      try { existing = JSON.parse(fs.readFileSync(outputFile, 'utf-8')) } catch { /* new file */ }

      // Build entries keyed by the parent terminal's session ID,
      // with each shell's output stored separately by shell ID
      for (const [shellId, content] of this.shellOutputBuffers) {
        // shellId format: "shell:term-1-123456:0" — extract the parent terminal ID
        const parts = shellId.split(':')
        const parentTerminalId = parts.length >= 3 ? parts.slice(1, -1).join(':') : parts[1]
        const sessionId = this.ptyManager.getSessionId(parentTerminalId)
        if (!sessionId) continue

        const lines = content.split(/\r?\n/).filter((l) => l.trim())
        const recentLines = lines.slice(-100)

        if (!existing[sessionId]) {
          existing[sessionId] = {
            sessionId,
            parentTerminalId,
            projectDir: this.projectDir,
            shells: {},
            lastUpdate: Date.now()
          }
        }
        existing[sessionId].shells[shellId] = {
          lines: recentLines,
          lastUpdate: Date.now()
        }
        existing[sessionId].lastUpdate = Date.now()
      }

      // Prune entries older than 5 minutes from other docks
      const cutoff = Date.now() - 5 * 60 * 1000
      for (const key of Object.keys(existing)) {
        if (existing[key].lastUpdate < cutoff) {
          const hasActiveShell = Object.keys(existing[key].shells || {}).some(
            (sid) => this.shellOutputBuffers.has(sid)
          )
          if (!hasActiveShell) delete existing[key]
        }
      }

      fs.writeFileSync(outputFile, JSON.stringify(existing, null, 2))
    } catch (err) {
      log(`[shell-output] save failed: ${err instanceof Error ? err.message : err}`)
    }
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
