/**
 * PTY Host - runs in a utility process to isolate node-pty from the main thread.
 * This prevents ConPTY deadlocks from freezing the entire Electron app.
 */
import * as pty from 'node-pty'

interface PtyEntry {
  process: pty.IPty
  sessionId: string
}

const ptys = new Map<string, PtyEntry>()

function send(msg: any): void {
  process.parentPort.postMessage(msg)
}

process.parentPort.on('message', (e: Electron.MessageEvent) => {
  const msg = e.data
  switch (msg.type) {
    case 'spawn': {
      try {
        const p = pty.spawn(msg.shell, msg.args, {
          name: 'xterm-256color',
          cols: msg.cols ?? 80,
          rows: msg.rows ?? 24,
          cwd: msg.cwd,
          env: msg.env
        })
        ptys.set(msg.terminalId, { process: p, sessionId: msg.sessionId })
        p.onData((data) => {
          send({ type: 'data', terminalId: msg.terminalId, data })
        })
        p.onExit(({ exitCode }) => {
          ptys.delete(msg.terminalId)
          send({ type: 'exit', terminalId: msg.terminalId, exitCode })
        })
        send({ type: 'spawned', terminalId: msg.terminalId, pid: p.pid })
      } catch (err: any) {
        send({ type: 'error', terminalId: msg.terminalId, error: err.message })
      }
      break
    }
    case 'write': {
      ptys.get(msg.terminalId)?.process.write(msg.data)
      break
    }
    case 'resize': {
      try {
        ptys.get(msg.terminalId)?.process.resize(msg.cols, msg.rows)
      } catch {
        // Process may have exited
      }
      break
    }
    case 'kill': {
      const entry = ptys.get(msg.terminalId)
      if (entry) {
        entry.process.kill()
        ptys.delete(msg.terminalId)
      }
      break
    }
    case 'killAll': {
      for (const [id, entry] of ptys) {
        entry.process.kill()
      }
      ptys.clear()
      break
    }
    case 'getSessionIds': {
      const ids = Array.from(ptys.values()).map((e) => e.sessionId)
      send({ type: 'sessionIds', ids })
      break
    }
  }
})
