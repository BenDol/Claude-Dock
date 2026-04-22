import * as fs from 'fs'
import * as path from 'path'
import { log, logError } from './logger'
import { getDataDir } from './linked-mode'

// Strip ANSI escape codes and terminal control sequences from PTY output
function stripAnsi(str: string): string {
  return str
    // CSI sequences: \x1b[ ... (letter)  — colors, cursor movement, erase, etc.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z@`]/g, '')
    // OSC sequences: \x1b] ... (BEL or ST)  — window title, hyperlinks, etc.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Other escape sequences: \x1b followed by single char (e.g. \x1b=, \x1b>)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[^[\]]/g, '')
    // Remaining control chars (except \n \r \t)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

interface TerminalActivity {
  id: string
  title: string
  sessionId: string
  isAlive: boolean
  recentLines: string[]
  lastUpdate: number
}

interface DockActivity {
  projectDir: string
  terminals: TerminalActivity[]
}

interface ActivityState {
  docks: Record<string, DockActivity>
}

const MAX_LINES = 40
const FLUSH_DELAY = 500

export class ActivityTracker {
  private static instance: ActivityTracker | null = null

  private docks = new Map<string, DockActivity>()
  private buffers = new Map<string, string>() // terminalId -> partial line buffer
  private lines = new Map<string, string[]>() // terminalId -> rolling lines
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dataDir: string

  static getInstance(): ActivityTracker {
    if (!ActivityTracker.instance) {
      ActivityTracker.instance = new ActivityTracker()
    }
    return ActivityTracker.instance
  }

  private constructor() {
    try {
      // Must live at getDataDir() (userData/dock-link/) so the MCP server —
      // which the coordinator launches with DOCK_DATA_DIR=getDataDir() — can
      // read this file. Pre-fix this wrote to the userData parent, leaving the
      // MCP reading a stale file and unable to resolve any session.
      this.dataDir = getDataDir()
      fs.mkdirSync(this.dataDir, { recursive: true })
      log(`ActivityTracker: data dir ${this.dataDir}`)
    } catch (err) {
      logError('ActivityTracker: init failed, using temp dir', err)
      this.dataDir = require('os').tmpdir()
    }
  }

  addTerminal(
    dockId: string,
    terminalId: string,
    title: string,
    sessionId: string,
    projectDir: string
  ): void {
    if (!this.docks.has(dockId)) {
      this.docks.set(dockId, { projectDir, terminals: [] })
    }
    const dock = this.docks.get(dockId)!

    // Avoid duplicates
    if (dock.terminals.find((t) => t.id === terminalId)) return

    dock.terminals.push({
      id: terminalId,
      title,
      sessionId,
      isAlive: true,
      recentLines: [],
      lastUpdate: Date.now()
    })
    this.lines.set(terminalId, [])
    this.buffers.set(terminalId, '')
    this.scheduleSave()
  }

  trackData(dockId: string, terminalId: string, data: string): void {
    const dock = this.docks.get(dockId)
    if (!dock) return

    const terminal = dock.terminals.find((t) => t.id === terminalId)
    if (!terminal) return

    // Append to buffer, split into lines
    const buffer = (this.buffers.get(terminalId) || '') + stripAnsi(data)
    const parts = buffer.split(/\r?\n/)

    // Last element is the incomplete line (keep in buffer)
    this.buffers.set(terminalId, parts.pop() || '')

    const currentLines = this.lines.get(terminalId) || []
    for (const part of parts) {
      const trimmed = part.replace(/\r/g, '').trim()
      if (trimmed.length > 0) {
        currentLines.push(trimmed.length > 500 ? trimmed.slice(0, 500) + '...' : trimmed)
      }
    }

    // Keep only the last N lines
    while (currentLines.length > MAX_LINES) {
      currentLines.shift()
    }

    this.lines.set(terminalId, currentLines)
    terminal.recentLines = [...currentLines]
    terminal.lastUpdate = Date.now()
    this.scheduleSave()
  }

  setTerminalTitle(dockId: string, terminalId: string, title: string): void {
    const dock = this.docks.get(dockId)
    if (!dock) return
    const terminal = dock.terminals.find((t) => t.id === terminalId)
    if (terminal) {
      terminal.title = title
      this.scheduleSave()
    }
  }

  setTerminalAlive(dockId: string, terminalId: string, alive: boolean): void {
    const dock = this.docks.get(dockId)
    if (!dock) return
    const terminal = dock.terminals.find((t) => t.id === terminalId)
    if (terminal) {
      terminal.isAlive = alive
      terminal.lastUpdate = Date.now()
      this.scheduleSave()
    }
  }

  removeTerminal(dockId: string, terminalId: string): void {
    const dock = this.docks.get(dockId)
    if (!dock) return
    dock.terminals = dock.terminals.filter((t) => t.id !== terminalId)
    this.lines.delete(terminalId)
    this.buffers.delete(terminalId)
    this.scheduleSave()
  }

  removeDock(dockId: string): void {
    const dock = this.docks.get(dockId)
    if (dock) {
      for (const t of dock.terminals) {
        this.lines.delete(t.id)
        this.buffers.delete(t.id)
      }
    }
    this.docks.delete(dockId)
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.save()
    }, FLUSH_DELAY)
  }

  private save(): void {
    const state: ActivityState = { docks: {} }
    for (const [dockId, dock] of this.docks) {
      state.docks[dockId] = dock
    }

    try {
      const filePath = path.join(this.dataDir, 'dock-activity.json')
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2))
    } catch (err) {
      logError('ActivityTracker: failed to save', err)
    }
  }

  /** Returns terminals that are alive and had output within the given threshold (ms) for a project dir */
  getActiveTerminals(projectDir: string, thresholdMs = 30_000): TerminalActivity[] {
    const now = Date.now()
    const active: TerminalActivity[] = []
    for (const dock of this.docks.values()) {
      if (dock.projectDir !== projectDir) continue
      for (const t of dock.terminals) {
        if (t.isAlive && (now - t.lastUpdate) < thresholdMs) {
          active.push(t)
        }
      }
    }
    return active
  }

  shutdown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // Final save then clear
    this.save()
    this.docks.clear()
    this.lines.clear()
    this.buffers.clear()
    ActivityTracker.instance = null
  }
}
