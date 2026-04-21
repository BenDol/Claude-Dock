/**
 * Service interface for the Coordinator plugin.
 *
 * Decouples the plugin from app singletons so it can be unit-tested and
 * hot-reloaded. Mirrors the setServices/getServices pattern used by voice/,
 * memory/, and git-manager/.
 */

import type { BrowserWindow } from 'electron'
import type { CoordinatorTerminalSummary } from '../../../shared/coordinator-types'

export interface CoordinatorWindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface CoordinatorServices {
  log: (...args: unknown[]) => void
  logError: (...args: unknown[]) => void

  /** Path used to scope per-window bounds in the window-state-store. */
  getWindowState: (key: string) => CoordinatorWindowState | undefined
  saveWindowState: (key: string, state: CoordinatorWindowState) => void

  /**
   * List terminals for the given project, with idle heuristics and a short
   * tail-of-output preview. The orchestrator surfaces these to the LLM via
   * list_terminals. Scoped per-project to prevent cross-project leakage.
   */
  listTerminals: (projectDir: string) => CoordinatorTerminalSummary[]

  /**
   * Spawn a new terminal in the given project. Returns the assigned terminal ID.
   * Rejects if no dock window exists for that project or if the renderer fails
   * to respond within the timeout. The renderer (not main) owns terminal ID
   * allocation, so this round-trips through the dock's webContents.
   */
  spawnTerminal: (projectDir: string, opts?: { title?: string; cwd?: string }) => Promise<string>

  /**
   * Close (kill) a terminal by ID. Scoped to the owning project — rejects if
   * the terminal is not owned by that project's dock.
   */
  closeTerminal: (projectDir: string, terminalId: string) => void

  /**
   * Write text to a terminal's PTY. When `submit` is true, a carriage return is
   * appended so the target (typically Claude Code) submits the prompt. Returns
   * true if the terminal belongs to the specified project and the write was sent.
   */
  writeToTerminal: (projectDir: string, terminalId: string, text: string, submit: boolean) => boolean

  /**
   * webContents for the given project's dock — used for IPC round-trips that
   * only the dock renderer can satisfy (spawn_terminal mints terminal IDs via
   * its dock-store). Returns null if no dock is open for that project.
   */
  getWebContentsForProject: (projectDir: string) => Electron.WebContents | null

  /**
   * All webContents that should receive coordinator broadcasts (stream deltas,
   * turn status, focus-input pings). Includes the dock renderer and the
   * floating coordinator window if one is open for the project.
   */
  getAllCoordinatorWebContents: (projectDir: string) => Electron.WebContents[]

  /** Focus the main dock BrowserWindow for the given project. */
  focusMainWindow: (projectDir: string) => BrowserWindow | null

  /** Read the app settings (used for theme-aware window chrome). */
  getSettings: () => { theme: { mode: string } }

  /** Directory for coordinator artefacts (logs, per-project chat store). */
  getCoordinatorDataDir: () => string

  paths: {
    preload: string
    rendererHtml: string
    rendererUrl: string | undefined
    rendererOverrideHtml: string | undefined
  }
}

let _services: CoordinatorServices | null = null

export function setServices(s: CoordinatorServices): void {
  _services = s
}

export function getServices(): CoordinatorServices {
  if (!_services) {
    throw new Error(
      'CoordinatorServices not initialized — setServices() must be called before register()'
    )
  }
  return _services
}

/** Test helper — drop the cached services so tests can install stubs. */
export function __resetCoordinatorServicesForTests(): void {
  _services = null
}
