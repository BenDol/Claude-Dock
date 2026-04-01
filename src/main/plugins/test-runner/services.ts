/**
 * Service interface for decoupling test-runner from app singletons.
 * Every file under test-runner/ should import from here instead of
 * reaching up into ../../logger, ../../dock-manager, etc.
 */

export interface TestRunnerServices {
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

let _services: TestRunnerServices | null = null

export function setServices(s: TestRunnerServices): void {
  _services = s
}

export function getServices(): TestRunnerServices {
  if (!_services)
    throw new Error(
      'TestRunnerServices not initialized — setServices() must be called before register()'
    )
  return _services
}
