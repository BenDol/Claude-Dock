import { ipcMain, shell, dialog } from 'electron'
import type { PluginEventBus } from './plugin-events'
import type { PluginManifest } from '../../shared/plugin-manifest'
import { PluginWindowManager } from './plugin-window-manager'
import { log as appLog, logError as appLogError } from '../logger'

/**
 * Core IPC channel prefixes reserved by the app.
 * Runtime plugins are blocked from registering handlers on these.
 */
const RESERVED_PREFIXES = [
  'terminal:', 'dock:', 'settings:', 'app:', 'win:',
  'updater:', 'git:', 'claude:', 'linked:', 'plugin:', 'debug:'
]

function isReservedChannel(channel: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => channel.startsWith(prefix))
}

/**
 * API surface exposed to runtime plugins via their activate() function.
 */
export interface PluginContext {
  log: (msg: string) => void
  logError: (msg: string, err?: unknown) => void
  ipc: {
    handle: (channel: string, handler: (...args: any[]) => any) => void
    removeHandler: (channel: string) => void
  }
  shell: {
    openExternal: typeof shell.openExternal
    openPath: typeof shell.openPath
  }
  dialog: typeof dialog
  openPluginWindow: (projectDir: string) => Promise<void>
  closePluginWindow: (projectDir: string) => void
  bus: PluginEventBus
  pluginDir: string
}

export function createPluginContext(
  manifest: PluginManifest,
  pluginDir: string,
  bus: PluginEventBus
): PluginContext {
  const prefix = `[${manifest.id}]`
  const registeredHandlers: string[] = []

  return {
    log: (msg: string) => appLog(`${prefix} ${msg}`),
    logError: (msg: string, err?: unknown) => appLogError(`${prefix} ${msg}`, err),
    ipc: {
      handle: (channel: string, handler: (...args: any[]) => any) => {
        if (isReservedChannel(channel)) {
          appLogError(`${prefix} BLOCKED: cannot register handler on reserved channel "${channel}"`)
          return
        }
        ipcMain.handle(channel, (_event, ...args) => handler(...args))
        registeredHandlers.push(channel)
      },
      removeHandler: (channel: string) => {
        if (isReservedChannel(channel)) return
        ipcMain.removeHandler(channel)
        const idx = registeredHandlers.indexOf(channel)
        if (idx >= 0) registeredHandlers.splice(idx, 1)
      }
    },
    // Restricted shell — only safe operations, no trashItem/beep
    shell: {
      openExternal: (url: string) => {
        if (url.startsWith('https://') || url.startsWith('http://')) {
          return shell.openExternal(url)
        }
        appLogError(`${prefix} BLOCKED: shell.openExternal only allows http(s) URLs, got: ${url}`)
        return Promise.resolve()
      },
      openPath: (p: string) => shell.openPath(p)
    },
    dialog,
    openPluginWindow: (projectDir: string) => {
      return PluginWindowManager.getInstance().open(manifest, pluginDir, projectDir)
    },
    closePluginWindow: (projectDir: string) => {
      PluginWindowManager.getInstance().close(manifest.id, projectDir)
    },
    bus,
    pluginDir
  }
}
