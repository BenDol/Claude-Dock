import { BrowserWindow } from 'electron'
import * as path from 'path'
import type { PluginManifest } from '../../shared/plugin-manifest'
import { getSettings } from '../settings-store'
import { log } from '../logger'
import { broadcastPluginWindowState } from './plugin-window-broadcast'
import { resolveRendererOverride } from './plugin-renderer-utils'

/**
 * Generic window manager for runtime plugins.
 * Opens one BrowserWindow per (pluginId, projectDir) pair.
 */
export class PluginWindowManager {
  private static instance: PluginWindowManager
  private windows = new Map<string, BrowserWindow>()

  static getInstance(): PluginWindowManager {
    if (!PluginWindowManager.instance) {
      PluginWindowManager.instance = new PluginWindowManager()
    }
    return PluginWindowManager.instance
  }

  private key(pluginId: string, projectDir: string): string {
    return `${pluginId}:${projectDir}`
  }

  async open(manifest: PluginManifest, pluginDir: string, projectDir: string): Promise<void> {
    const k = this.key(manifest.id, projectDir)
    const existing = this.windows.get(k)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return
    }

    if (!manifest.window) {
      log(`[plugin-window] ${manifest.id} has no window config`)
      return
    }

    const settings = getSettings()
    const isDark = settings.theme.mode === 'dark' || settings.theme.mode === 'system'

    const win = new BrowserWindow({
      width: manifest.window.width ?? 900,
      height: manifest.window.height ?? 650,
      minWidth: manifest.window.minWidth ?? 400,
      minHeight: manifest.window.minHeight ?? 300,
      frame: false,
      title: `${manifest.name} - ${path.basename(projectDir)}`,
      backgroundColor: isDark ? '#0f0f14' : '#f5f5f5',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    this.windows.set(k, win)
    broadcastPluginWindowState(manifest.id, projectDir, true)

    // Log renderer crashes and freezes
    win.webContents.on('render-process-gone', (_event, details) => {
      log(`[plugin-window] ${manifest.id} renderer gone for ${projectDir}: reason=${details.reason} exitCode=${details.exitCode}`)
    })
    win.on('unresponsive', () => log(`[plugin-window] ${manifest.id} window unresponsive for ${projectDir}`))
    win.on('responsive', () => log(`[plugin-window] ${manifest.id} window responsive again for ${projectDir}`))

    win.on('closed', () => {
      this.windows.delete(k)
      broadcastPluginWindowState(manifest.id, projectDir, false)
      log(`[plugin-window] ${manifest.id} window closed for ${projectDir}`)
    })

    // Check for a renderer override first, then fall back to the plugin's own HTML
    const overrideHtml = resolveRendererOverride(manifest.id)
    const htmlPath = overrideHtml ?? path.resolve(pluginDir, manifest.window.entry)
    await win.loadFile(htmlPath, {
      search: `pluginId=${manifest.id}&projectDir=${encodeURIComponent(projectDir)}`
    })

    log(`[plugin-window] ${manifest.id} window opened for ${projectDir}`)
  }

  getOpenPluginIds(projectDir: string): string[] {
    const ids: string[] = []
    for (const [key, win] of this.windows) {
      if (key.endsWith(`:${projectDir}`) && !win.isDestroyed()) {
        ids.push(key.split(':')[0])
      }
    }
    return ids
  }

  close(pluginId: string, projectDir: string): void {
    const k = this.key(pluginId, projectDir)
    const win = this.windows.get(k)
    if (win && !win.isDestroyed()) {
      win.close()
    }
  }

  closeAllForPlugin(pluginId: string): void {
    for (const [key, win] of this.windows) {
      if (key.startsWith(`${pluginId}:`) && !win.isDestroyed()) {
        win.close()
      }
    }
  }

  closeAllForProject(projectDir: string): void {
    for (const [key, win] of this.windows) {
      if (key.endsWith(`:${projectDir}`) && !win.isDestroyed()) {
        win.close()
      }
    }
  }

  closeAll(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.close()
    }
    this.windows.clear()
  }
}
