import type { DockPlugin } from './plugin'
import { PluginEventBus, type PluginEventName, type PluginEventMap } from './plugin-events'
import {
  getPluginState,
  getAllPluginStates,
  setPluginEnabled,
  getPluginSetting,
  setPluginSetting,
  isProjectConfigured,
  markProjectConfigured
} from './plugin-store'
import type { PluginInfo, ProjectPluginStates, PluginToolbarAction } from '../../shared/plugin-types'
import type { PluginManifest } from '../../shared/plugin-manifest'
import type { DockWindow } from '../dock-window'
import { log, logError } from '../logger'

export class PluginManager {
  private static instance: PluginManager
  private plugins: DockPlugin[] = []
  private bus = new PluginEventBus()

  static getInstance(): PluginManager {
    if (!PluginManager.instance) {
      PluginManager.instance = new PluginManager()
    }
    return PluginManager.instance
  }

  register(plugin: DockPlugin): void {
    this.plugins.push(plugin)
    plugin.register(this.bus)
    log(`[plugin-manager] registered plugin: ${plugin.id}`)
  }

  getPluginInfoList(): PluginInfo[] {
    return this.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      defaultEnabled: p.defaultEnabled,
      settingsSchema: p.settingsSchema
    }))
  }

  // --- State accessors (delegate to plugin-store) ---

  isEnabled(projectDir: string, pluginId: string): boolean {
    const plugin = this.plugins.find((p) => p.id === pluginId)
    if (!plugin) return false
    const state = getPluginState(projectDir, pluginId)
    return state?.enabled ?? plugin.defaultEnabled
  }

  getAllStates(projectDir: string): ProjectPluginStates {
    const stored = getAllPluginStates(projectDir)
    // Fill in defaults for plugins not yet in the store
    const result: ProjectPluginStates = {}
    for (const plugin of this.plugins) {
      result[plugin.id] = stored[plugin.id] || {
        enabled: plugin.defaultEnabled,
        settings: {}
      }
    }
    return result
  }

  setEnabled(projectDir: string, pluginId: string, enabled: boolean): void {
    setPluginEnabled(projectDir, pluginId, enabled)
    // Emit plugin:enabled or plugin:disabled to all plugins (unfiltered)
    const event: PluginEventName = enabled ? 'plugin:enabled' : 'plugin:disabled'
    this.bus.emitPost(event, { projectDir, pluginId }, () => true)
    log(`[plugin-manager] ${pluginId} ${enabled ? 'enabled' : 'disabled'} for ${projectDir}`)
  }

  getSetting(projectDir: string, pluginId: string, key: string): unknown {
    return getPluginSetting(projectDir, pluginId, key)
  }

  setSetting(projectDir: string, pluginId: string, key: string, value: unknown): void {
    setPluginSetting(projectDir, pluginId, key, value)
  }

  isConfigured(projectDir: string): boolean {
    return isProjectConfigured(projectDir)
  }

  markConfigured(projectDir: string): void {
    markProjectConfigured(projectDir)
  }

  // --- Event emission ---

  private enabledFilter(projectDir: string): (pluginId: string) => boolean {
    return (pluginId: string) => this.isEnabled(projectDir, pluginId)
  }

  async emitProjectPreOpen(projectDir: string, dock: DockWindow): Promise<void> {
    log(`[plugin-manager] emitting project:preOpen for ${projectDir}`)
    await this.bus.emitPre('project:preOpen', { projectDir, dock }, this.enabledFilter(projectDir))
  }

  emitProjectPostOpen(projectDir: string, dock: DockWindow): void {
    log(`[plugin-manager] emitting project:postOpen for ${projectDir}`)
    this.bus.emitPost('project:postOpen', { projectDir, dock }, this.enabledFilter(projectDir))
  }

  async emitProjectPreClose(projectDir: string): Promise<void> {
    await this.bus.emitPre('project:preClose', { projectDir }, this.enabledFilter(projectDir))
  }

  emitProjectPostClose(projectDir: string): void {
    // Always run postClose handlers (no enabled filter) — cleanup must happen
    // even if the plugin was disabled between open and close
    this.bus.emitPost('project:postClose', { projectDir }, () => true)
  }

  emitTerminalPreSpawn(projectDir: string, terminalId: string): void {
    this.bus.emitPost('terminal:preSpawn', { projectDir, terminalId }, this.enabledFilter(projectDir))
  }

  emitTerminalPostSpawn(projectDir: string, terminalId: string, sessionId: string): void {
    this.bus.emitPost('terminal:postSpawn', { projectDir, terminalId, sessionId }, this.enabledFilter(projectDir))
  }

  emitTerminalPreKill(projectDir: string, terminalId: string): void {
    this.bus.emitPost('terminal:preKill', { projectDir, terminalId }, this.enabledFilter(projectDir))
  }

  emitTerminalPostKill(projectDir: string, terminalId: string): void {
    this.bus.emitPost('terminal:postKill', { projectDir, terminalId }, this.enabledFilter(projectDir))
  }

  emitSettingsChanged(settings: any): void {
    this.bus.emitPost('settings:changed', { settings }, () => true)
  }

  /**
   * Returns toolbar actions defined in runtime plugin manifests.
   * These are serializable and sent to the renderer via IPC.
   */
  getToolbarActionsFromManifests(): PluginToolbarAction[] {
    const actions: PluginToolbarAction[] = []
    for (const plugin of this.plugins) {
      // Duck-type check for runtime plugins with manifests
      const manifest = (plugin as any).manifest as PluginManifest | undefined
      if (manifest?.toolbar) {
        actions.push({
          pluginId: plugin.id,
          title: manifest.toolbar.title,
          icon: manifest.toolbar.icon,
          action: manifest.toolbar.action,
          order: manifest.toolbar.order ?? 100
        })
      }
    }
    return actions.sort((a, b) => a.order - b.order)
  }

  dispose(): void {
    for (const plugin of this.plugins) {
      try { plugin.dispose?.() } catch { /* ignore */ }
    }
  }
}
