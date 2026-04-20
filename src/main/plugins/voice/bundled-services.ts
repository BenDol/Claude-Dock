/**
 * Factory that wires real app singletons into the VoiceServices interface.
 * The only file in the voice/ directory that imports app singletons directly.
 */

import { app } from 'electron'
import * as path from 'path'
import { log, logError } from '../../logger'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { broadcastPluginWindowState } from '../plugin-window-broadcast'
import { resolveRendererOverride } from '../plugin-renderer-utils'
import { NotificationManager } from '../../notification-manager'
import type { VoiceServices, VoiceNotificationPayload } from './services'

function resolveBundledPythonDir(): string {
  // In production the python/ folder is shipped via electron-builder's
  // extraResources to <resources>/voice-python/. In dev we load straight
  // from source so edits to .py files don't need a rebuild.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'voice-python')
  }
  return path.join(app.getAppPath(), 'src', 'main', 'plugins', 'voice', 'python')
}

function voiceDataDir(): string {
  return path.join(app.getPath('userData'), 'voice')
}

export function createBundledServices(): VoiceServices {
  const mapLevel = (l: VoiceNotificationPayload['level']): 'info' | 'success' | 'warning' | 'error' => {
    switch (l) {
      case 'warn': return 'warning'
      case 'error': return 'error'
      default: return 'info'
    }
  }

  return {
    log,
    logError,

    getSettings: () => getSettings() as unknown as { theme: { mode: string } },

    getWindowState,
    saveWindowState,
    broadcastPluginWindowState,

    notify: (payload) => {
      try {
        NotificationManager.getInstance().notify({
          title: payload.title,
          message: payload.body,
          type: mapLevel(payload.level),
          source: 'voice',
          projectDir: payload.projectDir ?? undefined
        })
      } catch (err) {
        logError('[voice] notify failed', err)
      }
    },

    getVoiceDataDir: voiceDataDir,

    paths: {
      preload: path.join(__dirname, '../preload/index.js'),
      rendererHtml: path.join(__dirname, '../renderer/index.html'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererOverrideHtml: resolveRendererOverride('voice'),
      pythonDir: resolveBundledPythonDir()
    }
  }
}
