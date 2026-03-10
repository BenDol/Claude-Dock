import { PluginManager } from './plugin-manager'
import type { DockPlugin } from './plugin'
import { loadRuntimePlugins, getPluginsDir } from './plugin-loader'
import { log } from '../logger'

// Auto-discover all built-in plugins.
// Convention: each plugin lives in a subdirectory and has a *-plugin.ts file.
// To add a plugin: create plugins/<name>/<name>-plugin.ts exporting a class implementing DockPlugin.
// To remove a plugin: delete its directory. No other changes needed.
const pluginModules = import.meta.glob<Record<string, unknown>>(
  './*/*-plugin.ts',
  { eager: true }
)

export function registerPlugins(): void {
  const manager = PluginManager.getInstance()

  // Phase 1: Register essential (non-lazy) built-in plugins synchronously.
  // These need to be ready before any project window opens (e.g. git-sync hooks preOpen).
  const deferred: DockPlugin[] = []

  for (const [path, mod] of Object.entries(pluginModules)) {
    for (const exp of Object.values(mod)) {
      if (typeof exp === 'function' && exp.prototype?.register) {
        try {
          const plugin = new (exp as new () => DockPlugin)()
          if (plugin.lazyLoad) {
            deferred.push(plugin)
          } else {
            manager.register(plugin)
          }
        } catch (e) {
          log(`[plugins] Failed to register built-in plugin from ${path}: ${e}`)
        }
      }
    }
  }

  // Phase 2: Register deferred built-in plugins + runtime plugins in background.
  // This runs after the function returns, so the first window can show immediately.
  setImmediate(async () => {
    for (const plugin of deferred) {
      try {
        manager.register(plugin)
      } catch (e) {
        log(`[plugins] Failed to register deferred plugin ${plugin.id}: ${e}`)
      }
    }

    // Load and register runtime plugins from user directory
    // (async — may show consent dialogs for new untrusted plugins)
    try {
      const runtimePlugins = await loadRuntimePlugins()
      for (const plugin of runtimePlugins) {
        try {
          manager.register(plugin)
        } catch (e) {
          log(`[plugins] Failed to register runtime plugin ${plugin.id}: ${e}`)
        }
      }
    } catch (e) {
      log(`[plugins] Failed to load runtime plugins: ${e}`)
    }

    log(`[plugins] deferred registration complete (${deferred.length} built-in + runtime)`)
  })
}

export { PluginManager } from './plugin-manager'
export { getPluginsDir } from './plugin-loader'
