import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { PluginManager } from './plugin-manager'
import { RuntimePlugin } from './runtime-plugin'
import type { PluginManifest } from '../../shared/plugin-manifest'
import { log, logError } from '../logger'

const DEBOUNCE_MS = 1500

/**
 * Watches runtime plugin directories for file changes and hot-reloads them.
 * Uses per-plugin debouncing to avoid rapid reloads during multi-file saves
 * and a reloading guard to prevent concurrent reloads of the same plugin.
 */
export class PluginFileWatcher {
  private static instance: PluginFileWatcher | null = null
  private watchers = new Map<string, fs.FSWatcher>()
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private reloading = new Set<string>()
  private pluginDirs = new Map<string, string>() // pluginId -> pluginDir
  private paused = false

  /** Pause watching (e.g., during plugin update installation to avoid double-reload) */
  static pause(): void { if (PluginFileWatcher.instance) PluginFileWatcher.instance.paused = true }
  /** Resume watching after pause */
  static resume(): void { if (PluginFileWatcher.instance) PluginFileWatcher.instance.paused = false }

  start(pluginsDir: string): void {
    if (!fs.existsSync(pluginsDir)) return
    PluginFileWatcher.instance = this

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pluginDir = path.join(pluginsDir, entry.name)
      const manifestPath = path.join(pluginDir, 'plugin.json')
      if (!fs.existsSync(manifestPath)) continue

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest
        this.watchPlugin(manifest.id, pluginDir)
      } catch {
        // Invalid manifest — skip
      }
    }

    log(`[plugin-watcher] watching ${this.watchers.size} plugin(s) for live reload`)
  }

  stop(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
    for (const timer of this.reloadTimers.values()) {
      clearTimeout(timer)
    }
    this.reloadTimers.clear()
    this.reloading.clear()
    this.pluginDirs.clear()
    log('[plugin-watcher] stopped')
  }

  private watchPlugin(pluginId: string, pluginDir: string): void {
    this.pluginDirs.set(pluginId, pluginDir)

    try {
      const watcher = fs.watch(pluginDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        // Ignore common non-code files
        if (filename.endsWith('.log') || filename.includes('node_modules')) return
        this.queueReload(pluginId)
      })

      watcher.on('error', (err) => {
        log(`[plugin-watcher] watcher error for ${pluginId}: ${err.message}`)
      })

      this.watchers.set(pluginId, watcher)
    } catch (err) {
      logError(`[plugin-watcher] failed to watch ${pluginId}:`, err)
    }
  }

  private queueReload(pluginId: string): void {
    // Don't queue if paused (plugin updater is installing) or already reloading
    if (this.paused || this.reloading.has(pluginId)) return

    // Debounce: clear existing timer and set a new one
    const existing = this.reloadTimers.get(pluginId)
    if (existing) clearTimeout(existing)

    this.reloadTimers.set(pluginId, setTimeout(() => {
      this.reloadTimers.delete(pluginId)
      this.doReload(pluginId)
    }, DEBOUNCE_MS))
  }

  private doReload(pluginId: string): void {
    const pluginDir = this.pluginDirs.get(pluginId)
    if (!pluginDir) return

    this.reloading.add(pluginId)
    log(`[plugin-watcher] reloading ${pluginId}...`)

    try {
      // Read manifest
      const manifestPath = path.join(pluginDir, 'plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest
      const mainPath = path.resolve(pluginDir, manifest.main)

      // Clear require cache for all files in this plugin directory
      for (const key of Object.keys(require.cache)) {
        if (key.startsWith(pluginDir)) {
          delete require.cache[key]
        }
      }

      // Re-require the module
      const mod = require(mainPath)

      // Create new RuntimePlugin wrapper
      const newPlugin = new RuntimePlugin(manifest, pluginDir, mod)

      // Swap the plugin in the manager
      PluginManager.getInstance().reload(pluginId, newPlugin)

      // Broadcast to all renderer windows so toolbar badges etc. refresh
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.executeJavaScript(
            `window.dispatchEvent(new CustomEvent('plugin-state-changed'))`
          ).catch(() => {})
        }
      }

      log(`[plugin-watcher] ${pluginId} reloaded successfully`)
    } catch (err) {
      logError(`[plugin-watcher] ${pluginId} reload failed (old plugin continues running):`, err)
    } finally {
      this.reloading.delete(pluginId)
    }
  }
}
