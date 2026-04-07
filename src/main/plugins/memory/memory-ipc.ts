import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc-channels'
import { MemoryWindowManager } from './memory-window'
import {
  getAllAdapterInfos,
  getActiveAdapter,
  disposeAllAdapters,
  registerBuiltinAdapters
} from './adapters/adapter-registry'
import type {
  MemorySessionListOptions,
  MemoryBranchListOptions,
  MemorySearchOptions,
  MemoryMessageListOptions
} from '../../../shared/memory-types'
import { getServices } from './services'

const svc = () => getServices()

export function registerMemoryIpc(): void {
  const winManager = MemoryWindowManager.getInstance()

  // Initialise adapters
  registerBuiltinAdapters()

  ipcMain.handle(IPC.MEMORY_OPEN, (_event, projectDir: string) => {
    return winManager.open(projectDir)
  })

  ipcMain.handle(IPC.MEMORY_GET_ADAPTERS, () => {
    return getAllAdapterInfos()
  })

  ipcMain.handle(IPC.MEMORY_SET_ADAPTER_ENABLED, (_event, _adapterId: string, _enabled: boolean) => {
    // Placeholder: adapters auto-enable based on availability for now.
    // Future: persist enabled state per-adapter per-project.
    return { success: true }
  })

  ipcMain.handle(IPC.MEMORY_GET_DASHBOARD, (_event, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return null
    try {
      return adapter.getDashboard()
    } catch (err) {
      svc().logError('[memory] getDashboard error:', err)
      return null
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_PROJECTS, (_event, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return []
    try {
      return adapter.getProjects()
    } catch (err) {
      svc().logError('[memory] getProjects error:', err)
      return []
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_SESSIONS, (_event, opts?: MemorySessionListOptions, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return []
    try {
      return adapter.getSessions(opts)
    } catch (err) {
      svc().logError('[memory] getSessions error:', err)
      return []
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_SESSION, (_event, sessionId: number, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return null
    try {
      return adapter.getSession(sessionId)
    } catch (err) {
      svc().logError('[memory] getSession error:', err)
      return null
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_BRANCHES, (_event, opts?: MemoryBranchListOptions, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return []
    try {
      return adapter.getBranches(opts)
    } catch (err) {
      svc().logError('[memory] getBranches error:', err)
      return []
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_BRANCH, (_event, branchId: number, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return null
    try {
      return adapter.getBranch(branchId)
    } catch (err) {
      svc().logError('[memory] getBranch error:', err)
      return null
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_MESSAGES, (_event, opts: MemoryMessageListOptions, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return []
    try {
      return adapter.getMessages(opts)
    } catch (err) {
      svc().logError('[memory] getMessages error:', err)
      return []
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_TOKEN_SNAPSHOTS, (_event, sessionId?: number, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return []
    try {
      return adapter.getTokenSnapshots(sessionId)
    } catch (err) {
      svc().logError('[memory] getTokenSnapshots error:', err)
      return []
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_IMPORT_LOG, (_event, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return []
    try {
      return adapter.getImportLog()
    } catch (err) {
      svc().logError('[memory] getImportLog error:', err)
      return []
    }
  })

  ipcMain.handle(IPC.MEMORY_SEARCH, (_event, opts: MemorySearchOptions, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return []
    try {
      return adapter.search(opts)
    } catch (err) {
      svc().logError('[memory] search error:', err)
      return []
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_CONTEXT_SUMMARY, (_event, branchId: number, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return null
    try {
      return adapter.getContextSummary(branchId)
    } catch (err) {
      svc().logError('[memory] getContextSummary error:', err)
      return null
    }
  })

  ipcMain.handle(IPC.MEMORY_GET_DB_INFO, (_event, adapterId?: string) => {
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return null
    try {
      return adapter.getDbInfo()
    } catch (err) {
      svc().logError('[memory] getDbInfo error:', err)
      return null
    }
  })

  ipcMain.handle(IPC.MEMORY_REFRESH, (_event, adapterId?: string) => {
    // Close and re-open the DB connection to pick up new data
    const adapter = getActiveAdapter(adapterId)
    if (!adapter) return { success: false }
    try {
      adapter.dispose()
      return { success: adapter.isAvailable() }
    } catch (err) {
      svc().logError('[memory] refresh error:', err)
      return { success: false }
    }
  })

  svc().log('[memory] IPC handlers registered')
}

export function disposeMemoryIpc(): void {
  const channels = [
    IPC.MEMORY_OPEN,
    IPC.MEMORY_GET_ADAPTERS,
    IPC.MEMORY_SET_ADAPTER_ENABLED,
    IPC.MEMORY_GET_DASHBOARD,
    IPC.MEMORY_GET_PROJECTS,
    IPC.MEMORY_GET_SESSIONS,
    IPC.MEMORY_GET_SESSION,
    IPC.MEMORY_GET_BRANCHES,
    IPC.MEMORY_GET_BRANCH,
    IPC.MEMORY_GET_MESSAGES,
    IPC.MEMORY_GET_TOKEN_SNAPSHOTS,
    IPC.MEMORY_GET_IMPORT_LOG,
    IPC.MEMORY_SEARCH,
    IPC.MEMORY_GET_CONTEXT_SUMMARY,
    IPC.MEMORY_GET_DB_INFO,
    IPC.MEMORY_REFRESH
  ]
  for (const ch of channels) {
    ipcMain.removeHandler(ch)
  }
  disposeAllAdapters()
}
