/**
 * Factory that wires real app singletons into the CoordinatorServices interface.
 * The only file in the coordinator/ directory that imports app/DockManager directly.
 */

import { BrowserWindow, ipcMain, app } from 'electron'
import * as crypto from 'crypto'
import * as path from 'path'
import { log, logError } from '../../logger'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { DockManager } from '../../dock-manager'
import { resolveRendererOverride } from '../plugin-renderer-utils'
import { IPC } from '../../../shared/ipc-channels'
import type { CoordinatorServices } from './services'
import type { CoordinatorTerminalSummary } from '../../../shared/coordinator-types'

const IDLE_THRESHOLD_MS = 800

/** Pending spawn round-trips keyed by correlation ID. */
const pendingSpawns = new Map<string, {
  resolve: (terminalId: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

/** Handler is registered once via registerSpawnReplyHandler; unregister via
 * unregisterSpawnReplyHandler on plugin dispose. */
type SpawnReplyHandler = (
  event: Electron.IpcMainEvent,
  correlationId: string,
  terminalId: string | null,
  error?: string
) => void
let spawnReplyHandler: SpawnReplyHandler | null = null

const onSpawnReply: SpawnReplyHandler = (_event, correlationId, terminalId, error) => {
  const pending = pendingSpawns.get(correlationId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingSpawns.delete(correlationId)
  if (terminalId) {
    pending.resolve(terminalId)
  } else {
    pending.reject(new Error(error || 'spawn failed (renderer returned no id)'))
  }
}

export function registerSpawnReplyHandler(): void {
  if (spawnReplyHandler) return
  spawnReplyHandler = onSpawnReply
  ipcMain.on(IPC.COORDINATOR_SPAWN_TERMINAL_REPLY, spawnReplyHandler)
}

export function unregisterSpawnReplyHandler(): void {
  if (!spawnReplyHandler) return
  ipcMain.removeListener(IPC.COORDINATOR_SPAWN_TERMINAL_REPLY, spawnReplyHandler)
  spawnReplyHandler = null
  // Reject any still-pending spawns so their callers don't hang.
  for (const [id, pending] of pendingSpawns) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Coordinator IPC disposed before spawn replied'))
    pendingSpawns.delete(id)
  }
}

export function createBundledServices(): CoordinatorServices {
  const requireDock = (projectDir: string) => {
    const dock = DockManager.getInstance().findDockByDir(projectDir)
    if (!dock) throw new Error(`No dock window is open for ${projectDir}`)
    return dock
  }

  const listTerminals = (projectDir: string): CoordinatorTerminalSummary[] => {
    const dock = DockManager.getInstance().findDockByDir(projectDir)
    if (!dock) return []
    const out: CoordinatorTerminalSummary[] = []
    const now = Date.now()
    for (const pty of dock.ptyManager.getAllInstances()) {
      if (pty.id.startsWith('shell:')) continue
      const lastData = dock.ptyManager.getLastDataTime(pty.id)
      const idleFor = lastData > 0 ? now - lastData : Number.POSITIVE_INFINITY
      out.push({
        id: pty.id,
        projectDir: dock.projectDir,
        title: path.basename(dock.projectDir),
        isIdle: idleFor >= IDLE_THRESHOLD_MS,
        idleSeconds: Math.floor(idleFor / 1000),
        lastOutputPreview: '',
        sessionId: dock.ptyManager.getSessionId(pty.id)
      })
    }
    return out
  }

  const spawnTerminal = (
    projectDir: string,
    opts?: { title?: string; cwd?: string }
  ): Promise<string> => {
    let dock
    try {
      dock = requireDock(projectDir)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
    if (dock.window.isDestroyed()) {
      return Promise.reject(new Error('Dock window is destroyed'))
    }
    if (!spawnReplyHandler) {
      return Promise.reject(new Error(
        'Coordinator spawn handler not registered — registerCoordinatorIpc() must run first'
      ))
    }
    const correlationId = crypto.randomUUID()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingSpawns.delete(correlationId)) {
          reject(new Error('spawn_terminal timed out waiting for renderer reply'))
        }
      }, 10_000)
      pendingSpawns.set(correlationId, { resolve, reject, timer })
      try {
        dock.window.webContents.send(
          IPC.COORDINATOR_SPAWN_TERMINAL_REQUEST,
          correlationId,
          { title: opts?.title, cwd: opts?.cwd }
        )
      } catch (err) {
        clearTimeout(timer)
        pendingSpawns.delete(correlationId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  const closeTerminal = (projectDir: string, terminalId: string): void => {
    const dock = DockManager.getInstance().findDockByDir(projectDir)
    if (!dock) {
      log(`[coordinator] closeTerminal: no dock for project ${projectDir}`)
      return
    }
    if (!dock.ptyManager.has(terminalId)) {
      logError(
        `[coordinator] closeTerminal: terminal ${terminalId} does not belong to project ${projectDir}`
      )
      return
    }
    try {
      dock.ptyManager.kill(terminalId)
    } catch (err) {
      logError('[coordinator] closeTerminal failed', err)
    }
  }

  const writeToTerminal = (
    projectDir: string,
    terminalId: string,
    text: string,
    submit: boolean
  ): boolean => {
    const dock = DockManager.getInstance().findDockByDir(projectDir)
    if (!dock) {
      logError(`[coordinator] writeToTerminal: no dock for project ${projectDir}`)
      return false
    }
    if (!dock.ptyManager.has(terminalId)) {
      logError(
        `[coordinator] writeToTerminal: terminal ${terminalId} does not belong to project ${projectDir}`
      )
      return false
    }
    try {
      dock.ptyManager.writePrompt(terminalId, text, submit)
      return true
    } catch (err) {
      logError('[coordinator] writeToTerminal failed', err)
      return false
    }
  }

  const getWebContentsForProject = (projectDir: string): Electron.WebContents | null => {
    const dock = DockManager.getInstance().findDockByDir(projectDir)
    if (!dock || dock.window.isDestroyed()) return null
    return dock.window.webContents
  }

  const getAllCoordinatorWebContents = (projectDir: string): Electron.WebContents[] => {
    const out: Electron.WebContents[] = []
    const dock = DockManager.getInstance().findDockByDir(projectDir)
    if (dock && !dock.window.isDestroyed()) out.push(dock.window.webContents)
    // Lazy require to avoid circular import (coordinator-window imports services).
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CoordinatorWindowManager } = require('./coordinator-window') as typeof import('./coordinator-window')
      const floating = CoordinatorWindowManager.getInstance().getWindow(projectDir)
      if (floating && !floating.isDestroyed()) out.push(floating.webContents)
    } catch {
      /* window manager not loaded yet — dock-only broadcast is fine */
    }
    return out
  }

  const focusMainWindow = (projectDir: string): BrowserWindow | null => {
    const dock = DockManager.getInstance().findDockByDir(projectDir)
    if (!dock || dock.window.isDestroyed()) return null
    if (dock.window.isMinimized()) dock.window.restore()
    dock.window.focus()
    return dock.window
  }

  const coordinatorDataDir = (): string =>
    path.join(app.getPath('userData'), 'coordinator')

  return {
    log,
    logError,

    getSettings: () => getSettings() as unknown as { theme: { mode: string } },

    getWindowState: (key) => {
      const s = getWindowState(key) as
        | { x?: number; y?: number; width?: number; height?: number; maximized?: boolean }
        | undefined
      if (!s || s.x === undefined || s.y === undefined || s.width === undefined || s.height === undefined) {
        return undefined
      }
      return {
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        maximized: s.maximized ?? false
      }
    },
    saveWindowState: (key, state) =>
      saveWindowState(key, state as unknown as Parameters<typeof saveWindowState>[1]),

    listTerminals,
    spawnTerminal,
    closeTerminal,
    writeToTerminal,
    getWebContentsForProject,
    getAllCoordinatorWebContents,
    focusMainWindow,
    getCoordinatorDataDir: coordinatorDataDir,

    paths: {
      preload: path.join(__dirname, '../preload/index.js'),
      rendererHtml: path.join(__dirname, '../renderer/index.html'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererOverrideHtml: resolveRendererOverride('coordinator')
    }
  }
}

/** Test helper — clears the pending-spawn map and cancels outstanding timers. */
export function __clearPendingSpawnsForTests(): void {
  for (const { timer } of pendingSpawns.values()) clearTimeout(timer)
  pendingSpawns.clear()
}
