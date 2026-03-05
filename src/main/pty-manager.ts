import * as pty from 'node-pty'
import { getDefaultShell, getShellArgs } from './util/shell'

export interface PtyInstance {
  id: string
  process: pty.IPty
  cwd: string
}

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()
  private onData: (terminalId: string, data: string) => void
  private onExit: (terminalId: string, exitCode: number) => void

  constructor(
    onData: (terminalId: string, data: string) => void,
    onExit: (terminalId: string, exitCode: number) => void
  ) {
    this.onData = onData
    this.onExit = onExit
  }

  spawn(terminalId: string, cwd: string): void {
    // Spawn claude directly via the system shell so PATH resolution works
    const shell = getDefaultShell()
    const isWindows = process.platform === 'win32'
    const args = isWindows ? ['/c', 'claude'] : ['-c', 'claude']

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>
    })

    const instance: PtyInstance = {
      id: terminalId,
      process: ptyProcess,
      cwd
    }

    this.ptys.set(terminalId, instance)

    ptyProcess.onData((data) => {
      this.onData(terminalId, data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      this.ptys.delete(terminalId)
      this.onExit(terminalId, exitCode)
    })
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
    }
  }

  killAll(): void {
    for (const [id] of this.ptys) {
      this.kill(id)
    }
  }

  has(terminalId: string): boolean {
    return this.ptys.has(terminalId)
  }

  get size(): number {
    return this.ptys.size
  }
}
