import { EventEmitter } from 'events'
import type { DockWindow } from '../dock-window'
import type { Settings } from '../../shared/settings-schema'

/**
 * All plugin event types. "pre" events are awaited sequentially (can block).
 * "post" events are fire-and-forget (informational).
 */
export interface PluginEventMap {
  'project:preOpen': { projectDir: string; dock: DockWindow }
  'project:postOpen': { projectDir: string; dock: DockWindow }
  'project:preClose': { projectDir: string }
  'project:postClose': { projectDir: string }
  'terminal:preSpawn': { projectDir: string; terminalId: string }
  'terminal:postSpawn': { projectDir: string; terminalId: string; sessionId: string }
  'terminal:preKill': { projectDir: string; terminalId: string }
  'terminal:postKill': { projectDir: string; terminalId: string }
  'settings:changed': { settings: Settings }
  'plugin:enabled': { projectDir: string; pluginId: string }
  'plugin:disabled': { projectDir: string; pluginId: string }
}

export type PluginEventName = keyof PluginEventMap

type AsyncHandler<T> = (data: T) => Promise<void> | void

interface HandlerEntry {
  pluginId: string
  handler: AsyncHandler<any>
}

/**
 * Typed event bus for plugins. Pre-events are awaited sequentially,
 * post-events are fire-and-forget.
 */
export class PluginEventBus {
  private handlers = new Map<PluginEventName, HandlerEntry[]>()

  on<K extends PluginEventName>(
    event: K,
    pluginId: string,
    handler: AsyncHandler<PluginEventMap[K]>
  ): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, [])
    }
    this.handlers.get(event)!.push({ pluginId, handler })
  }

  off(pluginId: string): void {
    for (const [event, entries] of this.handlers) {
      this.handlers.set(
        event,
        entries.filter((e) => e.pluginId !== pluginId)
      )
    }
  }

  /**
   * Emit a "pre" event — handlers are awaited sequentially.
   * Only calls handlers for plugins that pass the filter (e.g., enabled check).
   */
  async emitPre<K extends PluginEventName>(
    event: K,
    data: PluginEventMap[K],
    filter: (pluginId: string) => boolean
  ): Promise<void> {
    const entries = this.handlers.get(event) || []
    for (const entry of entries) {
      if (!filter(entry.pluginId)) continue
      try {
        await entry.handler(data)
      } catch (err) {
        console.error(`[plugin-bus] ${event} handler failed for ${entry.pluginId}:`, err)
      }
    }
  }

  /**
   * Emit a "post" event — handlers are fired but not awaited.
   * Only calls handlers for plugins that pass the filter.
   */
  emitPost<K extends PluginEventName>(
    event: K,
    data: PluginEventMap[K],
    filter: (pluginId: string) => boolean
  ): void {
    const entries = this.handlers.get(event) || []
    for (const entry of entries) {
      if (!filter(entry.pluginId)) continue
      try {
        const result = entry.handler(data)
        if (result && typeof result.catch === 'function') {
          result.catch((err: unknown) => {
            console.error(`[plugin-bus] ${event} handler failed for ${entry.pluginId}:`, err)
          })
        }
      } catch (err) {
        console.error(`[plugin-bus] ${event} handler failed for ${entry.pluginId}:`, err)
      }
    }
  }
}
