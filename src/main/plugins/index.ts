import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { PluginManager } from './plugin-manager'
import type { DockPlugin } from './plugin'
import { loadRuntimePlugins, getPluginsDir } from './plugin-loader'
import { PluginFileWatcher } from './plugin-file-watcher'
import { getSetting } from '../settings-store'
import { getOverrides, removeOverride, getSeenOverrideHashes } from './plugin-update-store'
import { createSafeStore } from '../safe-store'
import { log } from '../logger'

declare const __BUILD_SHA__: string
import { registerServiceFactory, getServiceEntry } from './plugin-service-registry'
import { setServices as setGitManagerServices } from './git-manager/services'
import { createBundledServices as createGitManagerServices } from './git-manager/bundled-services'
import { setServices as setCloudIntegrationServices } from './cloud-integration/services'
import { createBundledServices as createCloudIntegrationServices } from './cloud-integration/bundled-services'
import { setServices as setTestRunnerServices } from './test-runner/services'
import { createBundledServices as createTestRunnerServices } from './test-runner/bundled-services'
import { setServices as setWorkspaceServices } from './workspace/services'
import { createBundledServices as createWorkspaceServices } from './workspace/bundled-services'

// Register service factories for built-in plugins
registerServiceFactory('git-manager', createGitManagerServices, setGitManagerServices)
registerServiceFactory('cloud-integration', createCloudIntegrationServices, setCloudIntegrationServices)
registerServiceFactory('test-runner', createTestRunnerServices, setTestRunnerServices)
registerServiceFactory('workspace', createWorkspaceServices, setWorkspaceServices)

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

  if (!fs.existsSync(metaPath)) {
    // Clean stale store entry if the directory was deleted externally
    removeOverride(pluginId)
    return null
  }

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
 * Uses the service factory registry — no per-plugin hardcoding needed.
 * If an override module is provided, calls its setServices export instead of
 * the bundled one — override bundles have their own copy of services.ts.
 */
function injectPluginServices(pluginId: string, overrideModule?: Record<string, unknown>): void {
  const entry = getServiceEntry(pluginId)
  if (!entry) return

  const services = entry.factory()
  if (overrideModule && typeof overrideModule.setServices === 'function') {
    overrideModule.setServices(services)
  }
  // Always set bundled services too — if the override is stale and doesn't
  // export setServices, the fallback to the bundled plugin needs them ready.
  entry.setServices(services)
}

/**
 * If the app binary was updated (different __BUILD_SHA__), clear all plugin
 * overrides — the new exe bundles the latest plugin code, so overrides from
 * an older plugin-only update are now stale.
 */
function clearStaleOverridesOnAppUpdate(): void {
  try {
    const store = createSafeStore<{ lastAppSha: string }>({
      name: 'plugin-app-version',
      defaults: { lastAppSha: '' }
    })
    const lastSha = store.get('lastAppSha', '')
    const currentSha = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : ''

    if (lastSha && currentSha && lastSha !== currentSha) {
      log(`[plugins] app updated (${lastSha.slice(0, 7)} -> ${currentSha.slice(0, 7)}), clearing plugin overrides`)
      const overrides = getOverrides()
      const overrideBaseDir = path.join(app.getPath('userData'), 'plugin-overrides')
      for (const pluginId of Object.keys(overrides)) {
        const overrideDir = path.join(overrideBaseDir, pluginId)
        try { fs.rmSync(overrideDir, { recursive: true, force: true }) } catch { /* ignore */ }
        removeOverride(pluginId)
      }
    }

    if (currentSha) store.set('lastAppSha', currentSha)
  } catch (err) {
    log(`[plugins] failed to check app version for stale overrides: ${err}`)
  }
}

export function registerPlugins(): void {
  clearStaleOverridesOnAppUpdate()
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
          let override = tryLoadOverride(plugin.id)

          // Verify override is compatible: plugins that require service injection
          // must export setServices. If the override is from an older build that
          // doesn't, discard it and use the bundled plugin instead.
          if (override && getServiceEntry(plugin.id) && typeof override.module.setServices !== 'function') {
            log(`[plugins] override for ${plugin.id} is incompatible (missing setServices), using bundled version`)
            const overrideDir = path.join(app.getPath('userData'), 'plugin-overrides', plugin.id)
            try { fs.rmSync(overrideDir, { recursive: true, force: true }) } catch { /* ignore */ }
            removeOverride(plugin.id)
            override = null
          }

          const finalPlugin = override ? override.plugin : plugin

          if (finalPlugin.lazyLoad) {
            deferred.push(finalPlugin)
            // Store override module for deferred injection
            if (override) (finalPlugin as any)._overrideModule = override.module
          } else {
            injectPluginServices(finalPlugin.id, override?.module)
            manager.register(finalPlugin)
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

    // Start live plugin reload watcher in dev mode or when enabled in settings
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__
    const liveReload = (() => { try { return getSetting('advanced')?.livePluginReload } catch { return false } })()
    if (isDev || liveReload) {
      const watcher = new PluginFileWatcher()
      watcher.start(getPluginsDir())
    }
  })
}

export { PluginManager } from './plugin-manager'
export { getPluginsDir } from './plugin-loader'
