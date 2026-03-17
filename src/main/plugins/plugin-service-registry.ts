/**
 * Generic service factory registry for built-in plugins.
 *
 * Built-in plugins that need app singletons injected (via setServices())
 * register a factory here. The plugin loader and updater use this registry
 * to inject services without hardcoding plugin IDs.
 *
 * To add service injection for a new built-in plugin:
 * 1. Call registerServiceFactory(pluginId, factory, setServices) during app init
 * 2. The plugin loader will automatically call setServices(factory())
 *    on the bundled module, or overrideModule.setServices(factory())
 *    when an override is loaded.
 */

interface ServiceEntry {
  factory: () => unknown
  setServices: (services: unknown) => void
}

const entries = new Map<string, ServiceEntry>()

export function registerServiceFactory(
  pluginId: string,
  factory: () => unknown,
  setServices: (services: unknown) => void
): void {
  entries.set(pluginId, { factory, setServices })
}

export function getServiceEntry(pluginId: string): ServiceEntry | undefined {
  return entries.get(pluginId)
}
