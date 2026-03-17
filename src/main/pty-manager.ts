import * as path from 'path'
import * as crypto from 'crypto'
import { utilityProcess, UtilityProcess } from 'electron'
import { getDefaultShell, getShellArgs } from './util/shell'
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
  private suppressSessionChanges = false
  // Data batching to reduce IPC overhead
  private pendingData = new Map<string, string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  // Resume failure detection — watches early output for marker indicating session not found
  private resumeWatchers = new Map<string, { tail: string; bytes: number; timer: ReturnType<typeof setTimeout> }>()
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
      ? this.buildResumeCmd(shell, sessionId)
      : ephemeral
        ? `claude${claudeFlags ? ' ' + claudeFlags : ''}\r`
        : `claude --session-id ${sessionId}\r`

    // Resumed sessions are already interacted (user had a prior conversation)
    if (resumeId && !ephemeral) {
      this.interactedIds.add(terminalId)
      this.onSessionCreated(sessionId)
    }

    // Set up resume failure watcher (auto-expires after 30s)
    if (resumeId) {
      this.resumeWatchers.set(terminalId, {
        tail: '',
        bytes: 0,
        timer: setTimeout(() => this.resumeWatchers.delete(terminalId), 30000)
      })
    }

    // Queue the claude launch to run serially
    this.enqueueLaunch(() => {
      if (this.ptys.has(terminalId)) {
        this.sendToHost({ type: 'write', terminalId, data: cmd })

        // For resumed sessions on Windows, force a resize poke after Claude has had
        // time to start rendering. This fixes a ConPTY issue where the input area
        // ends up mispositioned after resume due to dimension mismatches during TUI init.
        if (resumeId && process.platform === 'win32') {
          this.scheduleResizePoke(terminalId)
        }
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
    setTimeout(() => {
      next()
      setTimeout(() => this.processQueue(), 3000)
    }, 200)
  }

  private bufferData(terminalId: string, data: string): void {
    // Check for resume failure before buffering (suppresses error output on detection)
    if (this.resumeWatchers.has(terminalId) && this.detectResumeFailed(terminalId, data)) {
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

  /**
   * Build the resume command with a failure marker that triggers when Claude
   * exits non-zero (e.g. session not found). The marker is encoded in the
   * command so the shell echo (which shows the raw typed text) does NOT
   * contain the decoded marker string — only the actual output does.
   */
  private buildResumeCmd(shell: string, sessionId: string): string {
    const lower = shell.toLowerCase()
    if (lower.includes('powershell') || lower.includes('pwsh')) {
      // PowerShell: string concatenation hides marker from command echo
      return `claude --resume ${sessionId}; if ($LASTEXITCODE -ne 0) { Write-Host ('__DOCK' + '_RF__') }\r`
    }
    if (lower.includes('cmd')) {
      // cmd.exe: ^ escape is consumed during parsing, not in PTY echo
      return `claude --resume ${sessionId} || echo __DOCK^_RF__\r`
    }
    // bash/zsh: printf with hex escape — echo shows \x5f, output shows _
    return `claude --resume ${sessionId} || printf '__DOCK\\x5fRF__\\n'\r`
  }

  // The decoded marker that appears in actual output but NOT in command echo
  private static readonly RESUME_FAIL_MARKER = '__DOCK_RF__'

  // Once this many bytes have arrived without the failure marker, the resume
  // clearly succeeded (Claude is rendering conversation output). A failed
  // resume produces at most ~300 bytes before the marker appears.
  private static readonly RESUME_SUCCESS_BYTE_THRESHOLD = 512

  /**
   * Check buffered PTY output for the resume failure marker.
   * Returns true if failure detected (caller should suppress the data chunk).
   */
  private detectResumeFailed(terminalId: string, data: string): boolean {
    const watcher = this.resumeWatchers.get(terminalId)
    if (!watcher) return false

    // Track total output — if enough data has arrived, the resume succeeded
    // and we stop watching. This prevents false positives from conversation
    // content that happens to contain the marker string.
    watcher.bytes += data.length
    if (watcher.bytes > PtyManager.RESUME_SUCCESS_BYTE_THRESHOLD) {
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
      .filter(([id]) => !this.ephemeralIds.has(id) && this.interactedIds.has(id))
      .map(([, p]) => p.sessionId)
  }

  getOrderedSessionIds(terminalIds: string[]): string[] {
    return terminalIds
      .filter((id) => !this.ephemeralIds.has(id) && this.interactedIds.has(id))
      .map((id) => this.ptys.get(id)?.sessionId)
      .filter((s): s is string => !!s)
  }

  getSessionId(terminalId: string): string | null {
    return this.ptys.get(terminalId)?.sessionId ?? null
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
   * After a resumed Claude session starts on Windows, send a resize poke to force
   * the TUI to recalculate its layout. We briefly resize to cols-1 then back to
   * the real size, which guarantees SIGWINCH is delivered even if the current
   * dimensions already match.
   */
  private scheduleResizePoke(terminalId: string): void {
    // Column-based poke: shrink cols by 1, restore after a short delay
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
    // Row-based poke: some ConPTY implementations (notably Windows 10) only
    // trigger a full TUI relayout on row changes, not column changes
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
    // Early pokes for fast systems (1.5s, 4s)
    setTimeout(pokeCols, 1500)
    setTimeout(pokeCols, 4000)
    // Late pokes for slow systems (Windows 10) with row-based pokes for better
    // coverage — some ConPTY versions need a row change to reposition the cursor
    setTimeout(pokeRows, 7000)
    setTimeout(() => pokeCols(100), 10000)
    setTimeout(() => pokeRows(100), 13000)
  }

  kill(terminalId: string): void {
    if (this.ptys.has(terminalId)) {
      const watcher = this.resumeWatchers.get(terminalId)
      if (watcher) {
        clearTimeout(watcher.timer)
        this.resumeWatchers.delete(terminalId)
      }
      this.sendToHost({ type: 'kill', terminalId })
      this.ptys.delete(terminalId)
      this.pendingData.delete(terminalId)
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
    this.pendingData.clear()
    this.sendToHost({ type: 'killAll' })
    this.ptys.clear()
    // Terminate the host process before unsuppressing to prevent
    // late exit events from clearing persisted sessions
    if (this.host) {
      this.host.kill()
      this.host = null
    }
    this.suppressSessionChanges = false
  }

  has(terminalId: string): boolean {
    return this.ptys.has(terminalId)
  }

  get size(): number {
    return this.ptys.size
  }
}
