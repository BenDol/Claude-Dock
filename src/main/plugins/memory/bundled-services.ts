/**
 * Factory that wires real app singletons into the MemoryServices interface.
 * This is the ONLY file in the memory directory that imports app singletons.
 */

import { log, logError } from '../../logger'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { broadcastPluginWindowState } from '../plugin-window-broadcast'
import { resolveRendererOverride } from '../plugin-renderer-utils'
import * as path from 'path'
import type { MemoryServices } from './services'

export function createBundledServices(): MemoryServices {
  return {
    log,
    logError,

    getSettings: () => getSettings() as any,

    getWindowState,
    saveWindowState,
    broadcastPluginWindowState,

    paths: {
      preload: path.join(__dirname, '../preload/index.js'),
      rendererHtml: path.join(__dirname, '../renderer/index.html'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererOverrideHtml: resolveRendererOverride('memory')
    }
  }
}
