import type { PluginEventBus } from './plugin-events'
import type { PluginSettingDef } from '../../shared/plugin-types'

/**
 * Interface that all built-in plugins implement.
 * Plugins subscribe to events on the bus in register().
 */
export interface DockPlugin {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly defaultEnabled: boolean
  readonly settingsSchema?: PluginSettingDef[]

  /**
   * When true, plugin registration is deferred to after the first window shows.
   * Use for plugins that don't need to hook early lifecycle events like project:preOpen.
   */
  readonly lazyLoad?: boolean

  /** Called once at app startup to register event listeners on the bus */
  register(bus: PluginEventBus): void

  /** Called when the plugin is destroyed (app quit) */
  dispose?(): void
}
