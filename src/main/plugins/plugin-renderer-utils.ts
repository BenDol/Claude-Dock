/**
 * Shared utilities for resolving and loading plugin renderer overrides.
 *
 * Any plugin with a BrowserWindow can use these to support standalone
 * renderer bundles delivered via plugin-overrides/.
 */

import { BrowserWindow, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

/**
 * Check if a renderer override exists for the given plugin.
 * Returns the absolute path to the override's index.html, or undefined.
 *
 * Override location: %APPDATA%/claude-dock/plugin-overrides/{pluginId}/renderer/index.html
 */
export function resolveRendererOverride(pluginId: string): string | undefined {
  const overridePath = path.join(
    app.getPath('userData'),
    'plugin-overrides',
    pluginId,
    'renderer',
    'index.html'
  )
  return fs.existsSync(overridePath) ? overridePath : undefined
}

export interface PluginRendererPaths {
  /** Override renderer HTML (from plugin-overrides/) — checked first */
  rendererOverrideHtml: string | undefined
  /** Vite dev server URL — used in dev mode when no override exists */
  rendererUrl: string | undefined
  /** Built-in production HTML — fallback when no override and not in dev mode */
  rendererHtml: string
}

/**
 * Load a plugin window with the correct renderer, respecting overrides.
 *
 * Priority: override HTML > dev server URL > production HTML
 *
 * @param win - The BrowserWindow to load into
 * @param paths - Renderer paths (override, dev URL, production)
 * @param queryParam - Full query string starting with '?' (e.g. '?pluginId=foo&projectDir=...')
 */
export async function loadPluginWindow(
  win: BrowserWindow,
  paths: PluginRendererPaths,
  queryParam: string
): Promise<void> {
  const search = queryParam.startsWith('?') ? queryParam.slice(1) : queryParam

  if (paths.rendererOverrideHtml) {
    await win.loadFile(paths.rendererOverrideHtml, { search })
  } else if (paths.rendererUrl) {
    await win.loadURL(`${paths.rendererUrl}${queryParam}`)
  } else {
    await win.loadFile(paths.rendererHtml, { search })
  }
}
