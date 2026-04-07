/**
 * Adapter Registry
 *
 * Manages all available memory tool adapters. New adapters register here
 * and the plugin queries through the registry to find available tools.
 *
 * Enable/disable state is stored externally (via the dock's plugin settings store)
 * and overlaid onto adapter info at query time.
 */

import type { MemoryAdapter } from './memory-adapter'
import type { MemoryAdapterInfo } from '../../../../shared/memory-types'
import { ClaudestAdapter } from './claudest-adapter'

const adapters = new Map<string, MemoryAdapter>()

/**
 * Externally-managed enabled state per adapter.
 * Set by the IPC layer using the dock's plugin settings store.
 * `undefined` = use default (adapter decides based on availability).
 */
const enabledOverrides = new Map<string, boolean>()

/** Register a memory adapter. Called once at plugin init. */
export function registerAdapter(adapter: MemoryAdapter): void {
  adapters.set(adapter.id, adapter)
}

/** Get a specific adapter by ID. */
export function getAdapter(id: string): MemoryAdapter | undefined {
  return adapters.get(id)
}

/** Set the enabled override for an adapter. */
export function setAdapterEnabled(id: string, enabled: boolean): void {
  enabledOverrides.set(id, enabled)
}

/** Clear the enabled override (revert to auto-detect). */
export function clearAdapterEnabled(id: string): void {
  enabledOverrides.delete(id)
}

/** Check if an adapter is effectively enabled. */
export function isAdapterEnabled(id: string): boolean {
  const override = enabledOverrides.get(id)
  if (override !== undefined) return override
  // Default: enabled if the adapter has data
  const adapter = adapters.get(id)
  if (!adapter) return false
  return adapter.isAvailable()
}

/** Get info for all registered adapters, with enabled state overlaid. */
export function getAllAdapterInfos(): MemoryAdapterInfo[] {
  return Array.from(adapters.values()).map((a) => {
    try {
      const info = a.getInfo()
      const override = enabledOverrides.get(a.id)
      if (override !== undefined) {
        info.enabled = override
      }
      return info
    } catch {
      return {
        id: a.id,
        name: a.name,
        description: '',
        version: 'unknown',
        installed: false,
        enabled: false,
        storePath: null,
        pluginDir: null,
        hasData: false,
        statusMessage: 'Error reading adapter info',
        sections: [],
        installCommands: [],
        canAutoInstall: false
      }
    }
  })
}

/** Get the first available and enabled adapter, or a specific one by ID. */
export function getActiveAdapter(id?: string): MemoryAdapter | null {
  if (id) {
    const adapter = adapters.get(id)
    if (!adapter) return null
    // If explicitly disabled, don't return it
    const override = enabledOverrides.get(id)
    if (override === false) return null
    return adapter.isAvailable() ? adapter : null
  }

  // Return the first available + enabled adapter
  for (const adapter of adapters.values()) {
    if (!isAdapterEnabled(adapter.id)) continue
    if (adapter.isAvailable()) return adapter
  }
  return null
}

/** Register all built-in adapters. */
export function registerBuiltinAdapters(): void {
  registerAdapter(new ClaudestAdapter())
}

/** Dispose all adapters. */
export function disposeAllAdapters(): void {
  for (const adapter of adapters.values()) {
    try { adapter.dispose() } catch { /* ignore */ }
  }
  adapters.clear()
  enabledOverrides.clear()
}
