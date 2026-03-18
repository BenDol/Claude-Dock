/**
 * Service interface for decoupling git-manager from app singletons.
 * Every file under git-manager/ should import from here instead of
 * reaching up into ../../logger, ../../dock-manager, etc.
 *
 * The host app calls setServices() before register().
 */

export interface GitManagerServices {
  log: (...args: unknown[]) => void
  logError: (...args: unknown[]) => void
  logInfo: (...args: unknown[]) => void

  sendTaskToDock: (projectDir: string, channel: string, data: unknown) => boolean

  notify: (notification: {
    title: string
    message: string
    type: string
    source: string
    projectDir: string
    timeout?: number
    action?: { label: string; url?: string; event?: string }
    actions?: { label: string; url?: string; event?: string }[]
    data?: Record<string, unknown>
    autoReadMs?: number
  }) => void

  getSettings: () => { theme: { mode: string } }
  getPluginSetting: (projectDir: string, pluginId: string, key: string) => unknown

  getWindowState: (
    key: string
  ) => { x: number; y: number; width: number; height: number; maximized: boolean } | undefined
  saveWindowState: (
    key: string,
    state: { x: number; y: number; width: number; height: number; maximized: boolean }
  ) => void
  broadcastPluginWindowState: (pluginId: string, projectDir: string, open: boolean) => void

  getActiveTerminals: (
    projectDir: string
  ) => { id: string; title: string; sessionId: string }[]
  createSafeStore: <T extends Record<string, unknown>>(opts: {
    name: string
    defaults?: T
  }) => any

  paths: {
    preload: string
    rendererHtml: string
    rendererUrl: string | undefined
    rendererOverrideHtml: string | undefined
  }
}

let _services: GitManagerServices | null = null

export function setServices(s: GitManagerServices): void {
  _services = s
}

export function getServices(): GitManagerServices {
  if (!_services)
    throw new Error(
      'GitManagerServices not initialized — setServices() must be called before register()'
    )
  return _services
}
