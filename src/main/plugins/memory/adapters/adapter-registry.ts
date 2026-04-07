/**
 * Adapter Registry
 *
 * Manages all available memory tool adapters. New adapters register here
 * and the plugin queries through the registry to find available tools.
 */

import type { MemoryAdapter } from './memory-adapter'
import type { MemoryAdapterInfo } from '../../../../shared/memory-types'
import { ClaudestAdapter } from './claudest-adapter'

const adapters = new Map<string, MemoryAdapter>()

/** Register a memory adapter. Called once at plugin init. */
export function registerAdapter(adapter: MemoryAdapter): void {
  adapters.set(adapter.id, adapter)
}

/** Get a specific adapter by ID. */
export function getAdapter(id: string): MemoryAdapter | undefined {
  return adapters.get(id)
}

/** Get info for all registered adapters. */
export function getAllAdapterInfos(): MemoryAdapterInfo[] {
  return Array.from(adapters.values()).map((a) => {
    try {
      return a.getInfo()
    } catch {
      return {
        id: a.id,
        name: a.name,
        description: '',
        version: 'unknown',
        installed: false,
        enabled: false,
        storePath: null,
        statusMessage: 'Error reading adapter info',
        sections: []
      }
    }
  })
}

/** Get the first available adapter, or a specific one. */
export function getActiveAdapter(id?: string): MemoryAdapter | null {
  if (id) return adapters.get(id) ?? null

  // Return the first available adapter
  for (const adapter of adapters.values()) {
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
}
