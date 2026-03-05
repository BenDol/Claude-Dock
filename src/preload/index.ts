import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { Settings } from '../shared/settings-schema'

export interface UpdateInfo {
  available: boolean
  version: string
  releaseNotes: string
  downloadUrl: string
  assetName: string
  assetSize: number
}

export interface DockApi {
  terminal: {
    spawn: (terminalId: string) => Promise<boolean>
    write: (terminalId: string, data: string) => Promise<void>
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>
    kill: (terminalId: string) => Promise<void>
    onData: (callback: (terminalId: string, data: string) => void) => () => void
    onExit: (callback: (terminalId: string, exitCode: number) => void) => () => void
  }
  dock: {
    getInfo: () => Promise<{ id: string; projectDir: string } | null>
  }
  settings: {
    get: () => Promise<Settings>
    set: (settings: Partial<Settings>) => Promise<void>
    onChange: (callback: (settings: Settings) => void) => () => void
  }
  app: {
    newDock: () => Promise<void>
    pickDirectory: () => Promise<string | null>
    getRecentPaths: () => Promise<{ path: string; name: string; lastOpened: number }[]>
    removeRecentPath: (dir: string) => Promise<void>
    openDockPath: (dir: string) => Promise<void>
    openExternal: (url: string) => Promise<void>
  }
  updater: {
    check: (profile: string) => Promise<UpdateInfo>
    download: (url: string, assetName: string) => Promise<string>
    install: () => Promise<void>
    onProgress: (callback: (downloaded: number, total: number) => void) => () => void
  }
  win: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
  }
}

const dockApi: DockApi = {
  terminal: {
    spawn: (terminalId) => ipcRenderer.invoke(IPC.TERMINAL_SPAWN, terminalId),
    write: (terminalId, data) => ipcRenderer.invoke(IPC.TERMINAL_WRITE, terminalId, data),
    resize: (terminalId, cols, rows) => ipcRenderer.invoke(IPC.TERMINAL_RESIZE, terminalId, cols, rows),
    kill: (terminalId) => ipcRenderer.invoke(IPC.TERMINAL_KILL, terminalId),
    onData: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, terminalId: string, data: string) => {
        callback(terminalId, data)
      }
      ipcRenderer.on(IPC.TERMINAL_DATA, handler)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, handler)
    },
    onExit: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, terminalId: string, exitCode: number) => {
        callback(terminalId, exitCode)
      }
      ipcRenderer.on(IPC.TERMINAL_EXIT, handler)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, handler)
    }
  },
  dock: {
    getInfo: () => ipcRenderer.invoke(IPC.DOCK_GET_INFO)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (settings) => ipcRenderer.invoke(IPC.SETTINGS_SET, settings),
    onChange: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: Settings) => {
        callback(settings)
      }
      ipcRenderer.on(IPC.SETTINGS_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, handler)
    }
  },
  app: {
    newDock: () => ipcRenderer.invoke(IPC.APP_NEW_DOCK),
    pickDirectory: () => ipcRenderer.invoke(IPC.APP_PICK_DIRECTORY),
    getRecentPaths: () => ipcRenderer.invoke(IPC.APP_GET_RECENT_PATHS),
    removeRecentPath: (dir) => ipcRenderer.invoke(IPC.APP_REMOVE_RECENT_PATH, dir),
    openDockPath: (dir) => ipcRenderer.invoke(IPC.APP_OPEN_DOCK_PATH, dir),
    openExternal: (url) => ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, url)
  },
  updater: {
    check: (profile) => ipcRenderer.invoke(IPC.UPDATER_CHECK, profile),
    download: (url, assetName) => ipcRenderer.invoke(IPC.UPDATER_DOWNLOAD, url, assetName),
    install: () => ipcRenderer.invoke(IPC.UPDATER_INSTALL),
    onProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, downloaded: number, total: number) => {
        callback(downloaded, total)
      }
      ipcRenderer.on(IPC.UPDATER_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.UPDATER_PROGRESS, handler)
    }
  },
  win: {
    minimize: () => ipcRenderer.invoke(IPC.WIN_MINIMIZE),
    maximize: () => ipcRenderer.invoke(IPC.WIN_MAXIMIZE),
    close: () => ipcRenderer.invoke(IPC.WIN_CLOSE)
  }
}

contextBridge.exposeInMainWorld('dockApi', dockApi)
