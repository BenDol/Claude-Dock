import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'

/**
 * Tracks and broadcasts plugin window open/close state.
 *
 * Every plugin window manager (built-in or generic) calls
 * broadcastPluginWindowState() on open/close. This module both
 * broadcasts the event to dock windows AND tracks which plugins
 * have open windows, so IPC handlers can query it without importing
 * any specific plugin's window manager.
 */

const openWindows = new Map<string, Set<string>>() // pluginId -> Set<projectDir>

export function broadcastPluginWindowState(pluginId: string, projectDir: string, open: boolean): void {
  if (open) {
    if (!openWindows.has(pluginId)) openWindows.set(pluginId, new Set())
    openWindows.get(pluginId)!.add(projectDir)
  } else {
    openWindows.get(pluginId)?.delete(projectDir)
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PLUGIN_WINDOW_STATE, { pluginId, projectDir, open })
    }
  }
}

/** Returns all plugin IDs with an open window for the given project. */
export function getOpenPluginIds(projectDir: string): string[] {
  const ids: string[] = []
  for (const [pluginId, dirs] of openWindows) {
    if (dirs.has(projectDir)) ids.push(pluginId)
  }
  return ids
}
