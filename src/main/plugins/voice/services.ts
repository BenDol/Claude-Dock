/**
 * Service interface for the Voice plugin.
 *
 * Keeps the plugin decoupled from app singletons so it can be unit-tested
 * with in-memory stubs. Follows the same setServices/getServices pattern
 * as memory/services.ts and git-manager/services.ts.
 */

export interface VoiceWindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface VoiceNotificationPayload {
  title: string
  body: string
  /** Project the event belongs to, or null for system-global events. */
  projectDir: string | null
  level?: 'info' | 'warn' | 'error'
}

export interface VoiceServices {
  log: (...args: unknown[]) => void
  logError: (...args: unknown[]) => void

  getSettings: () => { theme: { mode: string } }

  getWindowState: (key: string) => VoiceWindowState | undefined
  saveWindowState: (key: string, state: VoiceWindowState) => void
  broadcastPluginWindowState: (pluginId: string, projectDir: string, open: boolean) => void

  /** Project-scoped notification surface. Always pass projectDir (null only for truly global events). */
  notify: (payload: VoiceNotificationPayload) => void

  /** Directory for Voice runtime artefacts (venv, config, pid/log files). */
  getVoiceDataDir: () => string

  paths: {
    preload: string
    rendererHtml: string
    rendererUrl: string | undefined
    rendererOverrideHtml: string | undefined
    /** Absolute path to the bundled python/ directory. */
    pythonDir: string
  }
}

let _services: VoiceServices | null = null

export function setServices(s: VoiceServices): void {
  _services = s
}

export function getServices(): VoiceServices {
  if (!_services) {
    throw new Error(
      'VoiceServices not initialized — setServices() must be called before register()'
    )
  }
  return _services
}

/** Test helper — drop the cached services so tests can install stubs. */
export function __resetVoiceServicesForTests(): void {
  _services = null
}
