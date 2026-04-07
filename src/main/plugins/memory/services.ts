/**
 * Service interface for decoupling the memory plugin from app singletons.
 * Follows the same pattern as git-manager/services.ts.
 */

export interface MemoryServices {
  log: (...args: unknown[]) => void
  logError: (...args: unknown[]) => void

  getSettings: () => { theme: { mode: string } }

  getWindowState: (
    key: string
  ) => { x: number; y: number; width: number; height: number; maximized: boolean } | undefined
  saveWindowState: (
    key: string,
    state: { x: number; y: number; width: number; height: number; maximized: boolean }
  ) => void
  broadcastPluginWindowState: (pluginId: string, projectDir: string, open: boolean) => void

  paths: {
    preload: string
    rendererHtml: string
    rendererUrl: string | undefined
    rendererOverrideHtml: string | undefined
  }
}

let _services: MemoryServices | null = null

export function setServices(s: MemoryServices): void {
  _services = s
}

export function getServices(): MemoryServices {
  if (!_services)
    throw new Error(
      'MemoryServices not initialized — setServices() must be called before register()'
    )
  return _services
}
