import * as path from 'path'
import * as crypto from 'crypto'
import { utilityProcess, UtilityProcess } from 'electron'
import { getDefaultShell, getShellArgs, resolveShell } from './util/shell'
import { log, logError } from './logger'

export interface PtyInstance {
  id: string
  pid: number
  cwd: string
  sessionId: string
  cols: number
  rows: number
  isResume: boolean
}

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()
  private ephemeralIds = new Set<string>()
  private interactedIds = new Set<string>()
  private onData: (terminalId: string, data: string) => void
  private onExit: (terminalId: string, exitCode: number) => void
  private onSessionCreated: (sessionId: string) => void
  private onSessionsChanged: () => void
  // Serial launch queue to prevent claude config file race conditions
  private launchQueue: (() => void)[] = []
  private launching = false
  private hasLaunchedOnce = false
  private suppressSessionChanges = false
  private closedSessionStack: string[] = []
  // Data batching to reduce IPC overhead
  private pendingData = new Map<string, string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  // Shell-specific batching: longer window (debounced) for high-throughput server logs
  private pendingShellData = new Map<string, string>()
  private shellFlushTimer: ReturnType<typeof setTimeout> | null = null
  private shellFlushStart = 0
  private static readonly SHELL_FLUSH_DEBOUNCE = 32
  private static readonly SHELL_FLUSH_MAX_WAIT = 80
  /** Timestamp of last data received from each PTY (for idle detection) */
  private lastDataTime = new Map<string, number>()
  // Resume failure detection — watches early output for marker indicating session not found
  private resumeWatchers = new Map<string, { tail: string; timer: ReturnType<typeof setTimeout> }>()
  // Utility process hosting node-pty
  private host: UtilityProcess | null = null

  constructor(
    onData: (terminalId: string, data: string) => void,
    onExit: (terminalId: string, exitCode: number) => void,
    onSessionCreated: (sessionId: string) => void,
    onSessionsChanged: () => void
  ) {
    this.onData = onData
    this.onExit = onExit
    this.onSessionCreated = onSessionCreated
    this.onSessionsChanged = onSessionsChanged
    this.startHost()
  }

  private startHost(): void {
    const hostPath = path.join(__dirname, 'pty-host.js')
    log(`PtyManager: starting pty-host from ${hostPath}`)
    this.host = utilityProcess.fork(hostPath, [], {
      serviceName: 'pty-host'
    })
    this.host.on('message', (msg: any) => {
      switch (msg.type) {
        case 'data':
          this.bufferData(msg.terminalId, msg.data)
          break
        case 'exit':
          this.ptys.delete(msg.terminalId)
          this.onExit(msg.terminalId, msg.exitCode)
          if (!this.suppressSessionChanges) {
            this.onSessionsChanged()
          }
          break
        case 'spawned':
          log(`pty-host: spawned ${msg.terminalId} pid=${msg.pid}`)
          break
        case 'error':
          logError(`pty-host: spawn error ${msg.terminalId}: ${msg.error}`)
          break
      }
    })
    this.host.on('exit', (code) => {
      log(`PtyManager: pty-host exited code=${code}`)
      this.host = null
    })
  }

  private sendToHost(msg: any): void {
    if (this.host) {
      this.host.postMessage(msg)
    } else {
      logError('PtyManager: pty-host not running')
    }
  }

  spawn(terminalId: string, cwd: string, resumeId?: string, ephemeral?: boolean, claudeFlags?: string): void {
    const shell = getDefaultShell()
    const args = getShellArgs(shell)
    const sessionId = resumeId ?? crypto.randomUUID()

    if (ephemeral) this.ephemeralIds.add(terminalId)

    log(`pty.spawn: terminalId=${terminalId} shell=${shell} cwd=${cwd} resume=${!!resumeId}${ephemeral ? ' ephemeral' : ''}`)

    const instance: PtyInstance = {
      id: terminalId,
      pid: 0,
      cwd,
      sessionId,
      cols: 80,
      rows: 24,
      isResume: !!resumeId
    }
    this.ptys.set(terminalId, instance)

    this.sendToHost({
      type: 'spawn',
      terminalId,
      shell,
      args,
      cwd,
      sessionId,
      cols: 80,
      rows: 24,
      env: {
        ...process.env as Record<string, string>,
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'claude-dock'
      }
    })

    const cmd = resumeId
      ? this.buildResumeCmd(shell, sessionId, claudeFlags)
      : ephemeral
        ? `claude${claudeFlags ? ' ' + claudeFlags : ''}\r`
        : `claude --session-id ${sessionId}${claudeFlags ? ' ' + claudeFlags : ''}\r`

    // Resumed sessions are already interacted (user had a prior conversation)
    if (resumeId && !ephemeral) {
      this.interactedIds.add(terminalId)
      this.onSessionCreated(sessionId)
    }

    // Set up resume failure watcher (auto-expires after 30s)
    if (resumeId) {
      this.resumeWatchers.set(terminalId, {
        tail: '',
        timer: setTimeout(() => this.resumeWatchers.delete(terminalId), 30000)
      })
    }

    // Queue the claude launch to run serially
    this.enqueueLaunch(() => {
      if (this.ptys.has(terminalId)) {
        this.sendToHost({ type: 'write', terminalId, data: cmd })

        // Resize pokes are now handled by the renderer (TerminalView) after
        // the loading indicator dismisses — they're timed relative to when
        // Claude's TUI actually starts drawing, not from command launch.
      }
    })
  }

  /**
   * Spawn a plain shell PTY (no Claude command). Used for the embedded shell panel.
   * These are ephemeral — no session persistence, no launch queue, no resume.
   */
  spawnShell(shellId: string, cwd: string, shellPreference: string): void {
    const { shell, args } = resolveShell(shellPreference)
    log(`pty.spawnShell: shellId=${shellId} shell=${shell} cwd=${cwd}`)

    const instance: PtyInstance = {
      id: shellId,
      pid: 0,
      cwd,
      sessionId: shellId,
      cols: 80,
      rows: 24,
      isResume: false
    }
    this.ptys.set(shellId, instance)

    this.sendToHost({
      type: 'spawn',
      terminalId: shellId,
      shell,
      args,
      cwd,
      sessionId: shellId,
      cols: 80,
      rows: 24,
      env: {
        ...process.env as Record<string, string>,
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'claude-dock-shell'
      }
    })
  }

  private enqueueLaunch(fn: () => void): void {
    this.launchQueue.push(fn)
    if (!this.launching) {
      this.processQueue()
    }
  }

  private processQueue(): void {
    if (this.launchQueue.length === 0) {
      this.launching = false
      return
    }
    this.launching = true
    const next = this.launchQueue.shift()!
    // First item in the queue executes immediately — no artificial delay.
    // Subsequent items are staggered by 500ms to avoid Claude config file
    // race conditions when multiple terminals launch concurrently.
    if (!this.hasLaunchedOnce) {
      this.hasLaunchedOnce = true
      next()
      setTimeout(() => this.processQueue(), 500)
    } else {
      setTimeout(() => {
        next()
        setTimeout(() => this.processQueue(), 500)
      }, 0)
    }
  }

  private bufferData(terminalId: string, data: string): void {
    // Check for resume failure before buffering (suppresses error output on detection)
    if (this.resumeWatchers.has(terminalId) && this.detectResumeFailed(terminalId, data)) {
      return
    }
    this.lastDataTime.set(terminalId, Date.now())

    // Shell PTYs use a separate longer batch window — ConPTY on Windows delivers
    // server logs line-by-line with gaps, so the short 8ms terminal timer doesn't
    // batch effectively. The shell timer debounces (resets on each chunk) with a
    // max-wait cap to prevent starvation during sustained bursts.
    if (terminalId.startsWith('shell:')) {
      const existing = this.pendingShellData.get(terminalId)
      this.pendingShellData.set(terminalId, existing ? existing + data : data)
      const now = Date.now()
      if (!this.shellFlushTimer) {
        this.shellFlushStart = now
      }
      const elapsed = now - this.shellFlushStart
      if (elapsed >= PtyManager.SHELL_FLUSH_MAX_WAIT) {
        // Hit max wait — flush immediately
        if (this.shellFlushTimer) clearTimeout(this.shellFlushTimer)
        this.flushShellData()
      } else {
        // Debounce: reset timer on each new chunk
        if (this.shellFlushTimer) clearTimeout(this.shellFlushTimer)
        this.shellFlushTimer = setTimeout(() => this.flushShellData(), PtyManager.SHELL_FLUSH_DEBOUNCE)
      }
      return
    }

    const existing = this.pendingData.get(terminalId)
    this.pendingData.set(terminalId, existing ? existing + data : data)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushData(), 8)
    }
  }

  private flushData(): void {
    this.flushTimer = null
    for (const [terminalId, data] of this.pendingData) {
      this.onData(terminalId, data)
    }
    this.pendingData.clear()
  }

  private flushShellData(): void {
    this.shellFlushTimer = null
    this.shellFlushStart = 0
    for (const [terminalId, data] of this.pendingShellData) {
      this.onData(terminalId, data)
    }
    this.pendingShellData.clear()
  }

  /**
   * Build the resume command with a failure marker that triggers when Claude
   * exits non-zero (e.g. session not found). The marker is encoded in the
   * command so the shell echo (which shows the raw typed text) does NOT
   * contain the decoded marker string — only the actual output does.
   */
  private buildResumeCmd(shell: string, sessionId: string, claudeFlags?: string): string {
    const flags = claudeFlags ? ' ' + claudeFlags : ''
    const lower = shell.toLowerCase()
    if (lower.includes('powershell') || lower.includes('pwsh')) {
      // PowerShell: string concatenation hides marker from command echo
      return `claude --resume ${sessionId}${flags}; if ($LASTEXITCODE -ne 0) { Write-Host ('__DOCK' + '_RF__') }\r`
    }
    if (lower.includes('cmd')) {
      // cmd.exe: ^ escape is consumed during parsing, not in PTY echo
      return `claude --resume ${sessionId}${flags} || echo __DOCK^_RF__\r`
    }
    // bash/zsh: printf with hex escape — echo shows \x5f, output shows _
    return `claude --resume ${sessionId}${flags} || printf '__DOCK\\x5fRF__\\n'\r`
  }

  // The decoded marker that appears in actual output but NOT in command echo
  private static readonly RESUME_FAIL_MARKER = '__DOCK_RF__'

  // Claude's TUI enters the alternate screen buffer on startup.
  // Once we see this, the resume succeeded — stop watching.
  private static readonly ALT_SCREEN_ENTER = '\x1b[?1049h'

  /**
   * Check buffered PTY output for the resume failure marker.
   * Returns true if failure detected (caller should suppress the data chunk).
   *
   * Stops watching when Claude's TUI enters the alternate screen buffer
   * (clear success signal), or when the 30s timer expires.
   */
  private detectResumeFailed(terminalId: string, data: string): boolean {
    const watcher = this.resumeWatchers.get(terminalId)
    if (!watcher) return false

    // If Claude's TUI has started (alternate screen buffer), resume succeeded
    if (data.includes(PtyManager.ALT_SCREEN_ENTER)) {
      clearTimeout(watcher.timer)
      this.resumeWatchers.delete(terminalId)
      return false
    }

    // Combine tail of previous chunk with current chunk to handle boundary splits
    const combined = watcher.tail + data
    if (combined.includes(PtyManager.RESUME_FAIL_MARKER)) {
      clearTimeout(watcher.timer)
      this.resumeWatchers.delete(terminalId)
      this.handleResumeFailed(terminalId)
      return true
    }

    // Keep tail for cross-boundary matching
    watcher.tail = data.length > 100 ? data.slice(-100) : data
    return false
  }

  /**
   * Handle a detected resume failure: clear the terminal, generate a fresh
   * session, and relaunch Claude without --resume.
   */
  private handleResumeFailed(terminalId: string): void {
    const instance = this.ptys.get(terminalId)
    if (!instance) return

    log(`PtyManager: resume failed for ${terminalId}, restarting with fresh session`)

    // Clear any pending error output that hasn't been flushed yet
    this.pendingData.delete(terminalId)

    // Send ANSI clear screen + clear scrollback + cursor home directly to renderer
    this.onData(terminalId, '\x1b[2J\x1b[3J\x1b[H')

    // Generate new session and launch fresh after shell settles
    const newSessionId = crypto.randomUUID()
    instance.sessionId = newSessionId
    instance.isResume = false

    setTimeout(() => {
      if (!this.ptys.has(terminalId)) return
      this.sendToHost({ type: 'write', terminalId, data: `claude --session-id ${newSessionId}\r` })
      if (!this.suppressSessionChanges) {
        this.onSessionsChanged()
      }
    }, 500)
  }

  getSessionIds(): string[] {
    return Array.from(this.ptys.entries())
      // Exclude ephemeral terminals, non-interacted terminals, and shell panel PTYs
      .filter(([id]) => !this.ephemeralIds.has(id) && this.interactedIds.has(id) && !id.startsWith('shell:'))
      .map(([, p]) => p.sessionId)
  }

  getOrderedSessionIds(terminalIds: string[]): string[] {
    return terminalIds
      .filter((id) => !this.ephemeralIds.has(id) && this.interactedIds.has(id) && !id.startsWith('shell:'))
      .map((id) => this.ptys.get(id)?.sessionId)
      .filter((s): s is string => !!s)
  }

  getSessionId(terminalId: string): string | null {
    return this.ptys.get(terminalId)?.sessionId ?? null
  }

  getAllInstances(): PtyInstance[] {
    return Array.from(this.ptys.values())
  }

  popClosedSession(): string | null {
    return this.closedSessionStack.pop() ?? null
  }

  /** Find the terminal ID for a given session ID (exact or prefix match) */
  findTerminalBySessionId(sessionId: string): string | null {
    for (const [id, pty] of this.ptys) {
      if (id.startsWith('shell:')) continue // skip shell panel PTYs
      if (pty.sessionId === sessionId || pty.sessionId.startsWith(sessionId)) return id
    }
    return null
  }

  /**
   * Return the first non-shell terminal ID. Used as a fallback when the
   * session ID from the MCP command doesn't match any terminal (e.g. the
   * MCP server was spawned by a different Claude instance).
   */
  findFirstAliveTerminal(): string | null {
    for (const [id] of this.ptys) {
      if (id.startsWith('shell:')) continue
      return id
    }
    return null
  }

  write(terminalId: string, data: string): void {
    if (this.ptys.has(terminalId)) {
      // On first user write, mark as interacted and persist session
      if (!this.interactedIds.has(terminalId) && !this.ephemeralIds.has(terminalId)) {
        this.interactedIds.add(terminalId)
        const instance = this.ptys.get(terminalId)
        if (instance) {
          this.onSessionCreated(instance.sessionId)
        }
      }
      this.sendToHost({ type: 'write', terminalId, data })
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const instance = this.ptys.get(terminalId)
    if (instance) {
      instance.cols = cols
      instance.rows = rows
      this.sendToHost({ type: 'resize', terminalId, cols, rows })
    }
  }

  /**
   * After a resumed Claude session starts on Windows, send resize pokes to force
   * the TUI to recalculate its layout. We briefly change dimensions then restore,
   * which guarantees SIGWINCH is delivered even if the current dimensions already match.
   * Both column-based and row-based pokes are used because some ConPTY versions
   * (notably Windows 10) only trigger a full TUI relayout on row changes.
   */
  private scheduleResizePoke(terminalId: string): void {
    const pokeCols = (restoreDelay = 50) => {
      const inst = this.ptys.get(terminalId)
      if (!inst) return
      const { cols, rows } = inst
      if (cols > 1) {
        this.sendToHost({ type: 'resize', terminalId, cols: cols - 1, rows })
        setTimeout(() => {
          if (this.ptys.has(terminalId)) {
            this.sendToHost({ type: 'resize', terminalId, cols, rows })
          }
        }, restoreDelay)
      }
    }
    const pokeRows = (restoreDelay = 50) => {
      const inst = this.ptys.get(terminalId)
      if (!inst) return
      const { cols, rows } = inst
      if (rows > 1) {
        this.sendToHost({ type: 'resize', terminalId, cols, rows: rows - 1 })
        setTimeout(() => {
          if (this.ptys.has(terminalId)) {
            this.sendToHost({ type: 'resize', terminalId, cols, rows })
          }
        }, restoreDelay)
      }
    }
    // Both col and row pokes at each interval for broad ConPTY compatibility.
    // Row pokes are staggered 100ms after col pokes to avoid interference.
    const pokeBoth = (restoreDelay = 50) => {
      pokeCols(restoreDelay)
      setTimeout(() => pokeRows(restoreDelay), restoreDelay + 100)
    }
    // Staggered pokes: early TUI init (800ms), conversation render (1.5s),
    // conversation restore (3s), and late settling for slow systems (5s)
    setTimeout(() => pokeBoth(), 800)
    setTimeout(() => pokeBoth(), 1500)
    setTimeout(() => pokeBoth(), 3000)
    setTimeout(() => pokeBoth(100), 5000)
  }

  kill(terminalId: string): void {
    if (this.ptys.has(terminalId)) {
      const instance = this.ptys.get(terminalId)!
      // Push to closed-session stack if it was a real, interacted session
      if (!terminalId.startsWith('shell:') && !this.ephemeralIds.has(terminalId) && this.interactedIds.has(terminalId)) {
        this.closedSessionStack.push(instance.sessionId)
      }
      const watcher = this.resumeWatchers.get(terminalId)
      if (watcher) {
        clearTimeout(watcher.timer)
        this.resumeWatchers.delete(terminalId)
      }
      this.sendToHost({ type: 'kill', terminalId })
      this.ptys.delete(terminalId)
      this.pendingData.delete(terminalId)
      this.pendingShellData.delete(terminalId)
      this.lastDataTime.delete(terminalId)
      this.ephemeralIds.delete(terminalId)
      this.interactedIds.delete(terminalId)
      if (!this.suppressSessionChanges) {
        this.onSessionsChanged()
      }
    }
  }

  killAll(): void {
    this.suppressSessionChanges = true
    for (const [, watcher] of this.resumeWatchers) {
      clearTimeout(watcher.timer)
    }
    this.resumeWatchers.clear()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.shellFlushTimer) {
      clearTimeout(this.shellFlushTimer)
      this.shellFlushTimer = null
    }
    this.pendingData.clear()
    this.pendingShellData.clear()
    const count = this.ptys.size
    if (count > 0) {
      log(`pty.killAll: killing ${count} PTY(s)`)
    }
    // Kill each PTY individually to ensure shell processes are terminated
    // even if the host process dies before processing the killAll message
    for (const [id] of this.ptys) {
      this.sendToHost({ type: 'kill', terminalId: id })
    }
    this.sendToHost({ type: 'killAll' })
    this.ptys.clear()
    // Terminate the host process — give it a brief moment to process kills
    if (this.host) {
      const host = this.host
      this.host = null
      setTimeout(() => {
        try { host.kill() } catch { /* already dead */ }
      }, 200)
    }
    this.suppressSessionChanges = false
  }

  has(terminalId: string): boolean {
    return this.ptys.has(terminalId)
  }

  get size(): number {
    return this.ptys.size
  }

  /**
   * Returns true if any terminal has received data within the last `idleMs` milliseconds.
   * Terminals that haven't had output for longer than `idleMs` are considered idle.
   */
  hasRecentActivity(idleMs: number): boolean {
    const now = Date.now()
    for (const [, lastTime] of this.lastDataTime) {
      if (now - lastTime < idleMs) return true
    }
    return false
  }

  /** Get the last data timestamp for a specific terminal (for idle detection). */
  getLastDataTime(terminalId: string): number {
    return this.lastDataTime.get(terminalId) || 0
  }
}
