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

/**
 * Generic over the plugin's services type so call sites pass typed
 * `(s: XServices) => void` without TS variance complaints. Internally the
 * registry erases the type — `injectPluginServices` pairs a factory's output
 * with its own setServices, so the erasure is safe at the use site.
 */
export function registerServiceFactory<T>(
  pluginId: string,
  factory: () => T,
  setServices: (services: T) => void
): void {
  entries.set(pluginId, {
    factory: factory as () => unknown,
    setServices: setServices as (services: unknown) => void
  })
}

export function getServiceEntry(pluginId: string): ServiceEntry | undefined {
  return entries.get(pluginId)
}
