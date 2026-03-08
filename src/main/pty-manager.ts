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

  spawn(terminalId: string, cwd: string, resumeId?: string): void {
    const shell = getDefaultShell()
    const args = getShellArgs(shell)
    const sessionId = resumeId ?? crypto.randomUUID()

    log(`pty.spawn: terminalId=${terminalId} shell=${shell} cwd=${cwd} resume=${!!resumeId}`)

    const instance: PtyInstance = {
      id: terminalId,
      pid: 0,
      cwd,
      sessionId
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
      ? `claude --resume ${sessionId}\r`
      : `claude --session-id ${sessionId}\r`

    // Persist session immediately for fresh terminals
    if (!resumeId) {
      this.onSessionCreated(sessionId)
    }

    // Queue the claude launch to run serially
    this.enqueueLaunch(() => {
      if (this.ptys.has(terminalId)) {
        this.sendToHost({ type: 'write', terminalId, data: cmd })
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

  getOrderedSessionIds(terminalIds: string[]): string[] {
    return terminalIds
      .map((id) => this.ptys.get(id)?.sessionId)
      .filter((s): s is string => !!s)
  }

  getSessionId(terminalId: string): string | null {
    return this.ptys.get(terminalId)?.sessionId ?? null
  }

  write(terminalId: string, data: string): void {
    if (this.ptys.has(terminalId)) {
      this.sendToHost({ type: 'write', terminalId, data })
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    if (this.ptys.has(terminalId)) {
      this.sendToHost({ type: 'resize', terminalId, cols, rows })
    }
  }

  kill(terminalId: string): void {
    if (this.ptys.has(terminalId)) {
      this.sendToHost({ type: 'kill', terminalId })
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
    this.sendToHost({ type: 'killAll' })
    this.ptys.clear()
    this.suppressSessionChanges = false
    // Terminate the host process
    if (this.host) {
      this.host.kill()
      this.host = null
    }
  }

  has(terminalId: string): boolean {
    return this.ptys.has(terminalId)
  }

  get size(): number {
    return this.ptys.size
  }
}
