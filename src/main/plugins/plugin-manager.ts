import { ipcMain } from 'electron'
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
  /** IPC channels registered by each plugin (tracked automatically during register()) */
  private pluginIpcChannels = new Map<string, string[]>()

  static getInstance(): PluginManager {
    if (!PluginManager.instance) {
      PluginManager.instance = new PluginManager()
    }
    return PluginManager.instance
  }

  register(plugin: DockPlugin): void {
    this.plugins.push(plugin)
    this.registerWithTracking(plugin)
    log(`[plugin-manager] registered plugin: ${plugin.id}`)
  }

  /**
   * Wraps ipcMain.handle during plugin.register() to track which IPC channels
   * the plugin registers. This allows reload() to clean them up automatically.
   */
  private registerWithTracking(plugin: DockPlugin): void {
    const channels: string[] = []
    const originalHandle = ipcMain.handle.bind(ipcMain)

    // Monkey-patch ipcMain.handle to intercept registrations
    ipcMain.handle = (channel: string, listener: any) => {
      channels.push(channel)
      return originalHandle(channel, listener)
    }

    try {
      plugin.register(this.bus)
    } finally {
      // Restore original — the patch only lives for the duration of register()
      ipcMain.handle = originalHandle
      this.pluginIpcChannels.set(plugin.id, channels)
      if (channels.length > 0) {
        log(`[plugin-manager] tracked ${channels.length} IPC channel(s) for ${plugin.id}`)
      }
    }
  }

  getPluginInfoList(): PluginInfo[] {
    return this.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      defaultEnabled: p.defaultEnabled,
      version: p.version || '0.0.0',
      source: ((p as any).manifest ? 'external' : 'builtin') as 'builtin' | 'external',
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

  /**
   * Hot-reload a plugin: dispose the old instance, remove its IPC handlers
   * and event bus subscriptions, then register the new instance in its place.
   * IPC channels are cleaned up automatically using the tracked list from register().
   */
  reload(pluginId: string, newPlugin: DockPlugin): boolean {
    const index = this.plugins.findIndex((p) => p.id === pluginId)
    if (index === -1) {
      log(`[plugin-manager] reload: plugin ${pluginId} not found, registering as new`)
      this.register(newPlugin)
      return true
    }

    const old = this.plugins[index]
    log(`[plugin-manager] hot-reloading plugin: ${pluginId}`)

    // 1. Dispose the old plugin (closes windows, stops timers, etc.)
    try { old.dispose?.() } catch (err) {
      logError(`[plugin-manager] dispose failed for ${pluginId}:`, err)
    }

    // 2. Remove event bus handlers for this plugin
    this.bus.off(pluginId)

    // 3. Remove IPC handlers tracked during the original register() call
    const channels = this.pluginIpcChannels.get(pluginId) || []
    for (const channel of channels) {
      try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
    }
    this.pluginIpcChannels.delete(pluginId)

    // 4. Replace the plugin in the list and register with tracking
    this.plugins[index] = newPlugin
    this.registerWithTracking(newPlugin)
    log(`[plugin-manager] hot-reload complete for ${pluginId}`)
    return true
  }

  dispose(): void {
    for (const plugin of this.plugins) {
      try { plugin.dispose?.() } catch { /* ignore */ }
    }
  }
}
