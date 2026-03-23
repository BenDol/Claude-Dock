/**
 * Factory that wires real app singletons into the CloudIntegrationServices interface.
 *
 * This is the ONLY file in cloud-integration/ that imports app singletons.
 */

import { log, logError } from '../../logger'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { getPluginSetting } from '../plugin-store'
import { broadcastPluginWindowState } from '../plugin-window-broadcast'
import { resolveRendererOverride } from '../plugin-renderer-utils'
import { DockManager } from '../../dock-manager'
import { IPC } from '../../../shared/ipc-channels'
import * as path from 'path'
import type { CloudIntegrationServices } from './services'

export function createBundledServices(): CloudIntegrationServices {
  return {
    log,
    logError,

    runInDockShell(projectDir: string, command: string): boolean {
      const docks = DockManager.getInstance().getAllDocks()
      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
      const normDir = normalize(projectDir)
      const dock = docks.find((d) => normalize(d.projectDir) === normDir)
        || docks.find((d) => normDir.startsWith(normalize(d.projectDir) + '/'))
      if (!dock || dock.window.isDestroyed()) return false
      dock.window.webContents.send(IPC.SHELL_RUN_COMMAND, command)
      dock.window.focus()
      return true
    },

    getSettings: () => getSettings() as any,
    getPluginSetting,

    getWindowState,
    saveWindowState,
    broadcastPluginWindowState,

    paths: {
      preload: path.join(__dirname, '../preload/index.js'),
      rendererHtml: path.join(__dirname, '../renderer/index.html'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererOverrideHtml: resolveRendererOverride('cloud-integration')
    }
  }
}
