/**
 * Factory that wires real app singletons into the GitManagerServices interface.
 *
 * This is the ONLY file in the git-manager directory that imports app singletons.
 * The standalone plugin build does NOT include this file — the host app provides
 * services externally via setServices().
 */

import { DockManager } from '../../dock-manager'
import { NotificationManager } from '../../notification-manager'
import { log, logError, logInfo } from '../../logger'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { getPluginSetting } from '../plugin-store'
import { broadcastPluginWindowState } from '../plugin-window-broadcast'
import { ActivityTracker } from '../../activity-tracker'
import { createSafeStore } from '../../safe-store'
import * as path from 'path'
import { resolveRendererOverride } from '../plugin-renderer-utils'
import type { GitManagerServices } from './services'

export function createBundledServices(): GitManagerServices {
  return {
    log,
    logError,
    logInfo,

    sendTaskToDock(projectDir: string, channel: string, data: unknown): boolean {
      const docks = DockManager.getInstance().getAllDocks()
      const dock = docks.find((d: any) => d.projectDir === projectDir)
      if (dock && !dock.window.isDestroyed()) {
        dock.window.webContents.send(channel, data)
        if (dock.window.isMinimized()) dock.window.restore()
        dock.window.focus()
        return true
      }
      return false
    },

    notify(notification) {
      NotificationManager.getInstance().notify(notification as any)
    },

    getSettings: () => getSettings() as any,
    getPluginSetting,

    getWindowState,
    saveWindowState,
    broadcastPluginWindowState,

    getActiveTerminals(projectDir: string) {
      return ActivityTracker.getInstance().getActiveTerminals(projectDir)
    },

    createSafeStore,

    paths: {
      preload: path.join(__dirname, '../preload/index.js'),
      rendererHtml: path.join(__dirname, '../renderer/index.html'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererOverrideHtml: resolveRendererOverride('git-manager')
    }
  }
}
