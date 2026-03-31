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
  /** Tracks the last scanned line index per shell for event detection */
  private shellEventScanOffsets = new Map<string, number>()

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
          this.removeShellOutput(terminalId)
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
          this.persistCurrentSessions()
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
              this.persistCurrentSessions()
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
      // Remove all shell entries from the persisted output file
      this.removeAllShellOutputs()
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
            const targetShellId = cmd.shellId || null
            const shellLayout = cmd.shellLayout || null
            log(`[shell-command] routing MCP command to shell: ${cmd.command} (submit=${submit}, target=${targetTerminalId || 'focused'}, shell=${shellType || 'default'}, shellId=${targetShellId || 'default'}, layout=${shellLayout || 'default'})`)
            this.window.webContents.send(IPC.SHELL_RUN_COMMAND, cmd.command, submit, targetTerminalId, shellType, targetShellId, shellLayout)
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

  /**
   * Remove a closed shell from the in-memory buffer and from the persisted
   * dock-shell-output.json so that dock_list_shells no longer reports it.
   */
  private removeShellOutput(shellId: string): void {
    this.shellOutputBuffers.delete(shellId)
    try {
      const outputFile = path.join(app.getPath('userData'), 'dock-shell-output.json')
      let existing: Record<string, any> = {}
      try { existing = JSON.parse(fs.readFileSync(outputFile, 'utf-8')) } catch { return }

      let changed = false
      for (const key of Object.keys(existing)) {
        const entry = existing[key]
        if (entry.shells && entry.shells[shellId]) {
          delete entry.shells[shellId]
          changed = true
          // Remove the session entry entirely if no shells remain
          if (Object.keys(entry.shells).length === 0) {
            delete existing[key]
          }
        }
      }
      if (changed) {
        fs.writeFileSync(outputFile, JSON.stringify(existing, null, 2))
      }
    } catch (err) {
      log(`[shell-output] remove failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * Bulk-remove all shells owned by this dock window from the persisted output.
   * Called on window close to clean up in a single file write.
   */
  private removeAllShellOutputs(): void {
    const shellIds = new Set(this.shellOutputBuffers.keys())
    this.shellOutputBuffers.clear()
    if (shellIds.size === 0) return
    try {
      const outputFile = path.join(app.getPath('userData'), 'dock-shell-output.json')
      let existing: Record<string, any> = {}
      try { existing = JSON.parse(fs.readFileSync(outputFile, 'utf-8')) } catch { return }

      let changed = false
      for (const key of Object.keys(existing)) {
        const entry = existing[key]
        if (!entry.shells) continue
        for (const sid of Object.keys(entry.shells)) {
          if (shellIds.has(sid)) {
            delete entry.shells[sid]
            changed = true
          }
        }
        if (Object.keys(entry.shells).length === 0) {
          delete existing[key]
          changed = true
        }
      }
      if (changed) {
        fs.writeFileSync(outputFile, JSON.stringify(existing, null, 2))
      }
    } catch (err) {
      log(`[shell-output] removeAll failed: ${err instanceof Error ? err.message : err}`)
    }
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
        const recentLines = lines.slice(-500)

        if (!existing[sessionId]) {
          existing[sessionId] = {
            sessionId,
            parentTerminalId,
            projectDir: this.projectDir,
            shells: {},
            lastUpdate: Date.now()
          }
        }

        // Write individual log file per shell for direct file reading by Claude
        const shellIndex = shellId.split(':').pop() || '0'
        const logFileName = `dock-shell-${sessionId.slice(0, 8)}-${shellIndex}.log`
        const logFilePath = path.join(app.getPath('userData'), logFileName)
        try {
          fs.writeFileSync(logFilePath, recentLines.join('\n') + '\n')
        } catch { /* ignore write errors */ }

        existing[sessionId].shells[shellId] = {
          lines: recentLines,
          logFile: logFilePath,
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

      // Scan for new ##DOCK_EVENT:...## markers and write them to the pending events file
      this.detectAndWritePendingEvents(existing)
    } catch (err) {
      log(`[shell-output] save failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * Scan shell output for new ##DOCK_EVENT:type:payload## markers since last scan.
   * Joins lines before scanning to handle events split across terminal line-wrap boundaries.
   * Appends any new events to dock-pending-events.json for the MCP server to pick up.
   */
  private detectAndWritePendingEvents(shellData: Record<string, any>): void {
    const eventPattern = /##DOCK_EVENT:([^:]+):(.+?)##/g
    const newEvents: Array<{ sessionId: string; shellId: string; type: string; payload: any; timestamp: number }> = []

    for (const [sessionId, entry] of Object.entries(shellData)) {
      if (!entry.shells) continue
      for (const [shellId, shell] of Object.entries(entry.shells) as [string, any][]) {
        const lines: string[] = shell.lines || []
        const lastOffset = this.shellEventScanOffsets.get(shellId) || 0

        if (lastOffset >= lines.length) {
          this.shellEventScanOffsets.set(shellId, lines.length)
          continue
        }

        // Join new lines into a single string so events split by terminal
        // line-wrapping are matched across the boundary
        const newContent = lines.slice(lastOffset).join('')
        let match: RegExpExecArray | null
        while ((match = eventPattern.exec(newContent)) !== null) {
          let payload: any = match[2]
          try { payload = JSON.parse(match[2]) } catch { /* keep raw string */ }
          newEvents.push({
            sessionId,
            shellId,
            type: match[1],
            payload,
            timestamp: Date.now()
          })
        }
        this.shellEventScanOffsets.set(shellId, lines.length)
      }
    }

    if (newEvents.length === 0) return

    // Deduplicate: drop events whose type+hash match an existing pending or new event
    const seen = new Set<string>()
    const pendingFile = path.join(app.getPath('userData'), 'dock-pending-events.json')
    let pending: any[] = []
    try {
      pending = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'))
      if (!Array.isArray(pending)) pending = []
    } catch { /* new file */ }

    // Build set of existing keys
    for (const e of pending) {
      const h = typeof e.payload === 'object' && e.payload?.hash ? `${e.type}:${e.payload.hash}` : null
      if (h) seen.add(h)
    }

    const dedupedEvents = newEvents.filter((e) => {
      const h = typeof e.payload === 'object' && e.payload?.hash ? `${e.type}:${e.payload.hash}` : null
      if (h && seen.has(h)) return false
      if (h) seen.add(h)
      return true
    })

    if (dedupedEvents.length === 0) return

    pending.push(...dedupedEvents)

    // Cap at 100 pending events to prevent unbounded growth
    if (pending.length > 100) pending = pending.slice(-100)

    fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2))
    log(`[shell-events] ${dedupedEvents.length} new event(s) written to pending file`)

    // Send events to renderer for UI notification cards
    if (!this.window.isDestroyed()) {
      for (const event of dedupedEvents) {
        this.window.webContents.send(IPC.SHELL_EVENT, event)
      }
    }

    // Only auto-inject into the Claude terminal when the setting is enabled
    if (getSettings().behavior.shellEventAutoSubmit) {
      this.injectEventsIntoTerminal(dedupedEvents)
    }
  }

  /**
   * Queue of events waiting to be injected into a Claude terminal.
   * Events are held until the terminal appears idle (no output for a few seconds).
   */
  private eventInjectionQueue: Array<{ sessionId: string; message: string }> = []
  private eventInjectionTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Inject shell events into the Claude Code terminal as user input.
   * Waits until the terminal is idle (no pty output for 3 seconds) before typing,
   * to avoid interrupting active output or user typing.
   */
  private injectEventsIntoTerminal(events: Array<{ sessionId: string; shellId: string; type: string; payload: any; timestamp: number }>): void {
    // Group events by session and format as a single message
    const bySession = new Map<string, string[]>()
    for (const e of events) {
      const lines = bySession.get(e.sessionId) || []
      const payload = typeof e.payload === 'object' ? JSON.stringify(e.payload) : e.payload
      lines.push(`[dock-event] ${e.type}: ${payload}`)
      bySession.set(e.sessionId, lines)
    }

    for (const [sessionId, lines] of bySession) {
      const message = lines.join('\n')
      this.eventInjectionQueue.push({ sessionId, message })
    }

    // Start the injection check loop if not already running
    if (!this.eventInjectionTimer) {
      this.tryInjectEvents()
    }
  }

  private tryInjectEvents(): void {
    if (this.eventInjectionQueue.length === 0) {
      this.eventInjectionTimer = null
      return
    }

    const IDLE_THRESHOLD_MS = 3000
    const now = Date.now()

    // Process each queued event
    const remaining: typeof this.eventInjectionQueue = []
    for (const item of this.eventInjectionQueue) {
      const terminalId = this.ptyManager.findTerminalBySessionId(item.sessionId)
      if (!terminalId) {
        // No terminal found for this session — drop the event
        log(`[shell-events] no terminal for session ${item.sessionId}, dropping event injection`)
        continue
      }

      // Check if the terminal has been idle long enough
      const lastActivity = this.ptyManager.getLastDataTime(terminalId)
      const idleMs = now - lastActivity

      if (idleMs >= IDLE_THRESHOLD_MS) {
        // Terminal is idle — inject the event
        log(`[shell-events] injecting event into terminal ${terminalId} (idle ${idleMs}ms)`)
        this.ptyManager.write(terminalId, item.message + '\r')
      } else {
        // Not idle yet — keep in queue for retry
        remaining.push(item)
      }
    }

    this.eventInjectionQueue = remaining

    // If there are remaining events, retry in 2 seconds
    if (remaining.length > 0) {
      this.eventInjectionTimer = setTimeout(() => this.tryInjectEvents(), 2000)
    } else {
      this.eventInjectionTimer = null
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
      log(`DockWindow: persisting ${ids.length} session(s)`)
      saveSessions(this.projectDir, ids)
    } else if (this.ptyManager.size > 0) {
      // Only clear sessions when terminals exist but none are interacted.
      // When size is 0 (killAll was called), skip clearing to preserve
      // sessions that were saved earlier in the shutdown sequence.
      log(`DockWindow: clearing sessions (${this.ptyManager.size} terminals, none interacted)`)
      clearSessions(this.projectDir)
    } else {
      log(`DockWindow: skipping session persist (no live terminals)`)
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
    this.persistCurrentSessions()
    this.ptyManager.killAll()
    if (!this.window.isDestroyed()) {
      this.window.close()
    }
  }
}
