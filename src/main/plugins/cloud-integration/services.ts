/**
 * Service interface for decoupling cloud-integration from app singletons.
 * Every file under cloud-integration/ should import from here instead of
 * reaching up into ../../logger, ../../dock-manager, etc.
 *
 * The host app calls setServices() before register().
 */

export interface CloudIntegrationServices {
  log: (...args: unknown[]) => void
  logError: (...args: unknown[]) => void

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

  paths: {
    preload: string
    rendererHtml: string
    rendererUrl: string | undefined
    rendererOverrideHtml: string | undefined
  }
}

let _services: CloudIntegrationServices | null = null

export function setServices(s: CloudIntegrationServices): void {
  _services = s
}

export function getServices(): CloudIntegrationServices {
  if (!_services)
    throw new Error(
      'CloudIntegrationServices not initialized — setServices() must be called before register()'
    )
  return _services
}
