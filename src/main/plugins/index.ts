import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { PluginManager } from './plugin-manager'
import type { DockPlugin } from './plugin'
import { loadRuntimePlugins, getPluginsDir } from './plugin-loader'
import { getOverrides, removeOverride } from './plugin-update-store'
import { log } from '../logger'
import { setServices as setGitManagerServices } from './git-manager/services'
import { createBundledServices as createGitManagerServices } from './git-manager/bundled-services'

// Auto-discover all built-in plugins.
// Convention: each plugin lives in a subdirectory and has a *-plugin.ts file.
// To add a plugin: create plugins/<name>/<name>-plugin.ts exporting a class implementing DockPlugin.
// To remove a plugin: delete its directory. No other changes needed.
const pluginModules = import.meta.glob<Record<string, unknown>>(
  './*/*-plugin.ts',
  { eager: true }
)

interface OverrideResult {
  plugin: DockPlugin
  module: Record<string, unknown>
}

/**
 * Checks if a valid plugin override exists for the given built-in plugin.
 * If valid, loads and returns the override module as a DockPlugin instance.
 * If invalid (hash mismatch, missing files), deletes the override and returns null.
 */
function tryLoadOverride(pluginId: string): OverrideResult | null {
  const overrideDir = path.join(app.getPath('userData'), 'plugin-overrides', pluginId)
  const metaPath = path.join(overrideDir, 'meta.json')

  if (!fs.existsSync(metaPath)) return null

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    const overrides = getOverrides()
    const storedEntry = overrides[pluginId]

    // Verify the stored hash matches
    if (!storedEntry || storedEntry.hash !== meta.hash) {
      log(`[plugins] override hash mismatch for ${pluginId}, removing override`)
      fs.rmSync(overrideDir, { recursive: true, force: true })
      removeOverride(pluginId)
      return null
    }

    // Look for a main entry point in the override directory
    const mainPath = path.join(overrideDir, 'index.js')
    if (!fs.existsSync(mainPath)) {
      log(`[plugins] override for ${pluginId} has no index.js, removing`)
      fs.rmSync(overrideDir, { recursive: true, force: true })
      removeOverride(pluginId)
      return null
    }

    // Load the override module
    const mod = require(mainPath)
    for (const exp of Object.values(mod)) {
      if (typeof exp === 'function' && (exp as any).prototype?.register) {
        const plugin = new (exp as new () => DockPlugin)()
        log(`[plugins] loaded override for ${pluginId} v${meta.version}`)
        return { plugin, module: mod }
      }
    }

    log(`[plugins] override for ${pluginId} has no valid DockPlugin export, removing`)
    fs.rmSync(overrideDir, { recursive: true, force: true })
    removeOverride(pluginId)
    return null
  } catch (err) {
    log(`[plugins] failed to load override for ${pluginId}: ${err}`)
    try {
      fs.rmSync(overrideDir, { recursive: true, force: true })
      removeOverride(pluginId)
    } catch { /* ignore */ }
    return null
  }
}

/**
 * Inject services for built-in plugins that require them (before register()).
 * If an override module is provided, calls its setServices export instead of
 * the bundled one — override bundles have their own copy of services.ts.
 */
function injectPluginServices(pluginId: string, overrideModule?: Record<string, unknown>): void {
  if (pluginId === 'git-manager') {
    const services = createGitManagerServices()
    if (overrideModule && typeof overrideModule.setServices === 'function') {
      // Override module has its own services holder — inject into that
      ;(overrideModule.setServices as typeof setGitManagerServices)(services)
    } else {
      // Bundled module — inject into the bundled services holder
      setGitManagerServices(services)
    }
  }
}

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

          // Check for a plugin override before registering the bundled version
          const override = tryLoadOverride(plugin.id)
          const pluginToRegister = override?.plugin || plugin

          if (pluginToRegister.lazyLoad) {
            deferred.push(pluginToRegister)
            // Store override module for deferred injection
            if (override) (pluginToRegister as any)._overrideModule = override.module
          } else {
            injectPluginServices(pluginToRegister.id, override?.module)
            manager.register(pluginToRegister)
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
        const overrideModule = (plugin as any)._overrideModule as Record<string, unknown> | undefined
        delete (plugin as any)._overrideModule
        injectPluginServices(plugin.id, overrideModule)
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
