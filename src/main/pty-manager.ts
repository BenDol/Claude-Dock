import * as pty from 'node-pty'
import * as crypto from 'crypto'
import { getDefaultShell, getShellArgs } from './util/shell'

export interface PtyInstance {
  id: string
  process: pty.IPty
  cwd: string
  sessionId: string
}

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()
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
  }

  spawn(terminalId: string, cwd: string, resumeId?: string): void {
    const shell = getDefaultShell()
    const args = getShellArgs(shell)
    const sessionId = resumeId ?? crypto.randomUUID()

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env as Record<string, string>,
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'claude-dock'
      }
    })

    const instance: PtyInstance = {
      id: terminalId,
      process: ptyProcess,
      cwd,
      sessionId
    }

    this.ptys.set(terminalId, instance)

    ptyProcess.onData((data) => {
      this.bufferData(terminalId, data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      this.ptys.delete(terminalId)
      this.onExit(terminalId, exitCode)
      if (!this.suppressSessionChanges) {
        this.onSessionsChanged()
      }
    })

    const cmd = resumeId
      ? `claude --resume ${sessionId}\r`
      : `claude --session-id ${sessionId}\r`

    // Persist session immediately for fresh terminals
    if (!resumeId) {
      this.onSessionCreated(sessionId)
    }

    // Queue the claude launch to run serially
    this.enqueueLaunch(() => {
      if (this.ptys.has(terminalId)) {
        ptyProcess.write(cmd)
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

  getSessionIds(): string[] {
    return Array.from(this.ptys.values()).map((p) => p.sessionId)
  }

  write(terminalId: string, data: string): void {
    const instance = this.ptys.get(terminalId)
    if (instance) {
      instance.process.write(data)
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const instance = this.ptys.get(terminalId)
    if (instance) {
      try {
        instance.process.resize(cols, rows)
      } catch {
        // Ignore resize errors (process may have exited)
      }
    }
  }

  kill(terminalId: string): void {
    const instance = this.ptys.get(terminalId)
    if (instance) {
      instance.process.kill()
      this.ptys.delete(terminalId)
      this.pendingData.delete(terminalId)
      if (!this.suppressSessionChanges) {
        this.onSessionsChanged()
      }
    }
  }

  killAll(): void {
    this.suppressSessionChanges = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.pendingData.clear()
    for (const [id] of this.ptys) {
      this.kill(id)
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
