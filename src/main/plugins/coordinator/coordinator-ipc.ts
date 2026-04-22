/**
 * IPC handlers for the Coordinator plugin.
 *
 * This file is the seam between the renderer (CoordinatorPanel) and the
 * main-process orchestrator. It intentionally keeps handlers thin — provider
 * calls, chat-loop logic, and hotkey wiring live in dedicated modules and
 * are invoked from here.
 *
 * Handlers that are not yet implemented return placeholder values or throw a
 * NotImplemented error; they'll be filled in as the orchestrator/provider
 * layers come online.
 */
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc-channels'
import {
  getCoordinatorConfig,
  setCoordinatorConfig,
  resetCoordinatorConfig,
  DeepPartial
} from './coordinator-settings-store'
import {
  getHistory,
  clearHistory,
  clearLatestSessionId
} from './coordinator-chat-store'
import { getServices } from './services'
import {
  registerSpawnReplyHandler,
  unregisterSpawnReplyHandler
} from './bundled-services'
import { CoordinatorWindowManager } from './coordinator-window'
import { CoordinatorSettingsWindowManager } from './coordinator-settings-window'
import { CoordinatorHotkeyService } from './coordinator-hotkey'
import { listProviderPresets, createProvider } from './llm/registry'
import { runTurn } from './orchestrator/orchestrator'
import { getDataDir, getMcpServerSourcePath } from '../../linked-mode'
import type {
  CoordinatorConfig,
  CoordinatorMessage,
  CoordinatorTerminalSummary,
  CoordinatorWindowMode
} from '../../../shared/coordinator-types'

/** Active turn cancellation controllers keyed by projectDir. */
const activeTurns = new Map<string, AbortController>()

const svc = () => getServices()

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function assertProjectDir(projectDir: unknown): string {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new Error('coordinator IPC: projectDir must be a non-empty string')
  }
  return projectDir
}

export function registerCoordinatorIpc(): void {
  registerSpawnReplyHandler()

  ipcMain.handle(IPC.COORDINATOR_OPEN, async (_e, projectDir: unknown) => {
    const dir = assertProjectDir(projectDir)
    const cfg = getCoordinatorConfig()
    if (cfg.floatingWindowByDefault) {
      // Floating mode: open (or re-focus) the dedicated BrowserWindow and
      // notify the dock renderer that the coordinator was requested — the
      // hotkey surfaces both surfaces so the user can pick either.
      try {
        await CoordinatorWindowManager.getInstance().open(dir)
      } catch (err) {
        svc().logError('[coordinator] open (floating) failed', err)
      }
      return
    }
    // Docked mode: ask the dock renderer to activate the coordinator panel
    // and make sure the dock window itself is foregrounded.
    const win = svc().focusMainWindow(dir)
    if (!win) {
      svc().logError('[coordinator] open: no dock window for', dir)
      return
    }
    try {
      win.webContents.send(IPC.COORDINATOR_OPEN_REQUEST, dir)
    } catch (err) {
      svc().logError('[coordinator] open: failed to notify dock renderer', err)
    }
  })

  ipcMain.handle(IPC.COORDINATOR_OPEN_SETTINGS, async () => {
    try {
      await CoordinatorSettingsWindowManager.getInstance().open()
    } catch (err) {
      svc().logError('[coordinator] openSettings failed', err)
      throw err
    }
  })

  ipcMain.handle(IPC.COORDINATOR_FOCUS, async (_e, projectDir: unknown) => {
    const dir = assertProjectDir(projectDir)
    if (CoordinatorWindowManager.getInstance().focus(dir)) return
    svc().focusMainWindow(dir)
  })

  ipcMain.handle(IPC.COORDINATOR_GET_WINDOW_MODE, async (_e, projectDir: unknown): Promise<CoordinatorWindowMode> => {
    // Optionally scoped: caller can pass a projectDir to get the live mode.
    // A floating window is only "active" if one actually exists for the project.
    if (typeof projectDir === 'string' && projectDir) {
      return {
        mode: CoordinatorWindowManager.getInstance().isOpen(projectDir) ? 'floating' : 'docked'
      }
    }
    return { mode: getCoordinatorConfig().floatingWindowByDefault ? 'floating' : 'docked' }
  })

  ipcMain.handle(IPC.COORDINATOR_GET_CONFIG, async (): Promise<CoordinatorConfig> => {
    return getCoordinatorConfig()
  })

  ipcMain.handle(IPC.COORDINATOR_SET_CONFIG, async (_e, patch: unknown) => {
    if (!isPlainObject(patch)) {
      throw new Error('coordinator:setConfig patch must be a plain object')
    }
    const next = setCoordinatorConfig(patch as DeepPartial<CoordinatorConfig>)
    // Restart only when hotkey-affecting fields changed — avoids flapping the
    // OS-level hook on every unrelated setting edit.
    const patchObj = patch as Record<string, unknown>
    if (
      'hotkeyEnabled' in patchObj ||
      'fallbackGlobalShortcut' in patchObj
    ) {
      CoordinatorHotkeyService.getInstance().restart()
    }
    return next
  })

  ipcMain.handle(IPC.COORDINATOR_RESET_CONFIG, async (): Promise<CoordinatorConfig> => {
    return resetCoordinatorConfig()
  })

  ipcMain.handle(IPC.COORDINATOR_LIST_PROVIDERS, async () => {
    return listProviderPresets()
  })

  ipcMain.handle(IPC.COORDINATOR_TEST_PROVIDER, async () => {
    const cfg = getCoordinatorConfig()
    try {
      const provider = createProvider(
        cfg.provider,
        {
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl || undefined,
          defaultModel: cfg.model
        },
        {
          // SDK testConnection doesn't touch MCP/session state, but the
          // factory still captures these in closure — pass sane defaults.
          projectDir: process.cwd(),
          dockDataDir: getDataDir(),
          mcpScriptPath: getMcpServerSourcePath(),
          maxToolSteps: cfg.maxToolStepsPerTurn
        }
      )
      return await provider.testConnection()
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    IPC.COORDINATOR_GET_HISTORY,
    async (_e, projectDir: unknown): Promise<CoordinatorMessage[]> => {
      const dir = assertProjectDir(projectDir)
      return getHistory(dir)
    }
  )

  ipcMain.handle(IPC.COORDINATOR_CLEAR_HISTORY, async (_e, projectDir: unknown) => {
    const dir = assertProjectDir(projectDir)
    clearHistory(dir)
  })

  ipcMain.handle(IPC.COORDINATOR_RESET_SESSION_ID, async (_e, projectDir: unknown) => {
    const dir = assertProjectDir(projectDir)
    clearLatestSessionId(dir)
    svc().log('[coordinator] reset SDK session id', dir)
  })

  ipcMain.handle(
    IPC.COORDINATOR_SEND_MESSAGE,
    async (_e, projectDir: unknown, userText: unknown) => {
      const dir = assertProjectDir(projectDir)
      if (typeof userText !== 'string' || userText.trim().length === 0) {
        throw new Error('coordinator:sendMessage requires non-empty userText')
      }
      // Cancel any previous in-flight turn for this project before starting another.
      const existing = activeTurns.get(dir)
      if (existing) existing.abort()
      const controller = new AbortController()
      activeTurns.set(dir, controller)
      const config = getCoordinatorConfig()
      try {
        await runTurn({
          projectDir: dir,
          userText,
          config,
          signal: controller.signal
        })
      } finally {
        if (activeTurns.get(dir) === controller) activeTurns.delete(dir)
      }
    }
  )

  ipcMain.handle(IPC.COORDINATOR_CANCEL, async (_e, projectDir: unknown) => {
    const dir = assertProjectDir(projectDir)
    const ctrl = activeTurns.get(dir)
    if (ctrl) {
      ctrl.abort()
      activeTurns.delete(dir)
    }
  })

  ipcMain.handle(
    IPC.COORDINATOR_LIST_TERMINALS,
    async (_e, projectDir: unknown): Promise<CoordinatorTerminalSummary[]> => {
      const dir = assertProjectDir(projectDir)
      return svc().listTerminals(dir)
    }
  )

  ipcMain.handle(IPC.COORDINATOR_HOTKEY_STATUS, async () => {
    return CoordinatorHotkeyService.getInstance().getStatus()
  })

  svc().log('[coordinator] IPC handlers registered')
}

export function disposeCoordinatorIpc(): void {
  for (const ctrl of activeTurns.values()) ctrl.abort()
  activeTurns.clear()
  unregisterSpawnReplyHandler()
  CoordinatorWindowManager.getInstance().closeAll()
  CoordinatorSettingsWindowManager.getInstance().close()
  const channels = [
    IPC.COORDINATOR_OPEN,
    IPC.COORDINATOR_OPEN_SETTINGS,
    IPC.COORDINATOR_FOCUS,
    IPC.COORDINATOR_GET_WINDOW_MODE,
    IPC.COORDINATOR_GET_CONFIG,
    IPC.COORDINATOR_SET_CONFIG,
    IPC.COORDINATOR_RESET_CONFIG,
    IPC.COORDINATOR_LIST_PROVIDERS,
    IPC.COORDINATOR_TEST_PROVIDER,
    IPC.COORDINATOR_GET_HISTORY,
    IPC.COORDINATOR_CLEAR_HISTORY,
    IPC.COORDINATOR_RESET_SESSION_ID,
    IPC.COORDINATOR_SEND_MESSAGE,
    IPC.COORDINATOR_CANCEL,
    IPC.COORDINATOR_LIST_TERMINALS,
    IPC.COORDINATOR_HOTKEY_STATUS
  ]
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch) } catch { /* ignore */ }
  }
  svc().log('[coordinator] IPC handlers disposed')
}
