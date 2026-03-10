import { ipcMain } from 'electron'
import type { DockPlugin } from './plugin'
import type { PluginEventBus } from './plugin-events'
import type { PluginManifest } from '../../shared/plugin-manifest'
import type { PluginSettingDef } from '../../shared/plugin-types'
import { createPluginContext, type PluginContext } from './plugin-context'
import { PluginWindowManager } from './plugin-window-manager'
import { log, logError } from '../logger'

/**
 * Wraps a runtime-loaded plugin module as a DockPlugin.
 * The module is loaded from a user-accessible directory and expected to export
 * an activate(context) function.
 */
export class RuntimePlugin implements DockPlugin {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly defaultEnabled: boolean
  readonly settingsSchema?: PluginSettingDef[]

  readonly manifest: PluginManifest
  readonly pluginDir: string
  private module: any
  private context?: PluginContext

  constructor(manifest: PluginManifest, pluginDir: string, mod: any) {
    this.id = manifest.id
    this.name = manifest.name
    this.description = manifest.description
    this.defaultEnabled = manifest.defaultEnabled
    this.settingsSchema = manifest.settingsSchema
    this.module = mod
    this.manifest = manifest
    this.pluginDir = pluginDir
  }

  register(bus: PluginEventBus): void {
    this.context = createPluginContext(this.manifest, this.pluginDir, bus)

    // If plugin has a main module with activate, call it
    if (this.module && typeof this.module.activate === 'function') {
      try {
        this.module.activate(this.context)
      } catch (err) {
        logError(`[runtime-plugin] ${this.id} activate failed:`, err)
      }
    }

    // Auto-wire: if manifest has toolbar.action + window but no activate function,
    // automatically register an IPC handler that opens the plugin window
    if (this.manifest.toolbar && this.manifest.window && !(this.module?.activate)) {
      ipcMain.handle(this.manifest.toolbar.action, (_event: any, projectDir: string) => {
        return PluginWindowManager.getInstance().open(this.manifest, this.pluginDir, projectDir)
      })
    }

    // Close plugin windows when the project closes
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      PluginWindowManager.getInstance().close(this.id, projectDir)
    })

    log(`[runtime-plugin] ${this.id} registered`)
  }

  dispose(): void {
    if (this.module && typeof this.module.deactivate === 'function') {
      try {
        this.module.deactivate()
      } catch (err) {
        logError(`[runtime-plugin] ${this.id} deactivate failed:`, err)
      }
    }
    PluginWindowManager.getInstance().closeAllForPlugin(this.id)
  }
}
