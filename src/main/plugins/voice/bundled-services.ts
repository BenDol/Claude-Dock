/**
 * Factory that wires real app singletons into the VoiceServices interface.
 * The only file in the voice/ directory that imports app singletons directly.
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { log, logError } from '../../logger'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { broadcastPluginWindowState } from '../plugin-window-broadcast'
import { resolveRendererOverride } from '../plugin-renderer-utils'
import { NotificationManager } from '../../notification-manager'
import type { VoiceServices, VoiceNotificationPayload } from './services'

function resolveBundledPythonDir(): string {
  // Plugin updates can deliver an updated python/ tree alongside the JS
  // bundle (see scripts/generate-plugin-archive.js `extraDirs`). When the
  // plugin-updater has installed an override for voice, prefer its python/
  // directory — otherwise the on-disk Python (shipped with the original
  // app install) goes out of sync with the freshly-updated TS bundle that
  // drives it, producing mismatches like `VoiceRecorder.__init__() got an
  // unexpected keyword argument 'device'`.
  const overridePython = path.join(
    app.getPath('userData'),
    'plugin-overrides',
    'voice',
    'python'
  )
  if (fs.existsSync(overridePython)) {
    return overridePython
  }
  // In packaged builds the Python runtime ships via electron-builder's
  // `extraResources`, which copies src/main/plugins/voice/python/ into
  // <install>/resources/voice-python/. `asarUnpack` was attempted first but
  // silently failed to extract the tree on install (the files stayed inside
  // app.asar), so `extraResources` is the reliable path. For dev builds the
  // `copyVoicePythonPlugin` step in electron.vite.config.ts still copies the
  // same tree to <bundle>/voice-python/ alongside __dirname.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'voice-python')
  }
  return path.join(__dirname, 'voice-python')
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
