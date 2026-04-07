import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { IPC } from '../../../shared/ipc-channels'
import { MemoryWindowManager } from './memory-window'
import {
  getAllAdapterInfos,
  getActiveAdapter,
  getAdapter,
  setAdapterEnabled,
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

/**
 * Find the `claude` CLI binary.
 * On Windows it's typically on PATH as `claude` or `claude.exe`.
 */
function findClaudeCli(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

/**
 * Run a claude CLI command and return the result.
 */
function runClaudeCli(args: string[]): Promise<{ success: boolean; output?: string; error?: string }> {
  return new Promise((resolve) => {
    const cli = findClaudeCli()
    svc().log(`[memory] running: ${cli} ${args.join(' ')}`)

    execFile(cli, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        const errorMsg = stderr || err.message
        svc().logError(`[memory] CLI error:`, errorMsg)
        resolve({ success: false, error: errorMsg })
      } else {
        svc().log(`[memory] CLI output: ${stdout.slice(0, 200)}`)
        resolve({ success: true, output: stdout })
      }
    })
  })
}

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

  ipcMain.handle(IPC.MEMORY_SET_ADAPTER_ENABLED, (_event, adapterId: string, enabled: boolean) => {
    const adapter = getAdapter(adapterId)
    if (!adapter) return { success: false, error: 'Adapter not found' }

    setAdapterEnabled(adapterId, enabled)

    if (!enabled) {
      // Close DB connection when disabled
      try { adapter.dispose() } catch { /* ok */ }
    }

    svc().log(`[memory] adapter ${adapterId} ${enabled ? 'enabled' : 'disabled'}`)
    return { success: true }
  })

  ipcMain.handle(IPC.MEMORY_INSTALL_ADAPTER, async (_event, adapterId: string) => {
    const adapter = getAdapter(adapterId)
    if (!adapter) return { success: false, error: 'Adapter not found' }

    const commands = adapter.getInstallCommands()
    if (commands.length === 0) return { success: false, error: 'No install commands available' }

    svc().log(`[memory] installing adapter ${adapterId}...`)

    // Execute install commands sequentially.
    // Claude CLI plugin commands look like: claude plugin marketplace add gupsammy/claudest
    // We split on spaces and pass as args, but we need to handle the /plugin prefix.
    const results: { cmd: string; success: boolean; output?: string; error?: string }[] = []
    for (const cmd of commands) {
      // Parse: "claude plugin install claude-memory@claudest" -> ["claude", "/plugin", "install", "claude-memory@claudest"]
      const parts = cmd.split(/\s+/)
      if (parts.length < 2 || parts[0] !== 'claude') {
        results.push({ cmd, success: false, error: 'Invalid command format' })
        continue
      }
      const args = parts.slice(1)
      const result = await runClaudeCli(args)
      results.push({ cmd, ...result })

      // Stop if a command fails
      if (!result.success) break
    }

    const allSucceeded = results.every(r => r.success)

    // Force re-detect by disposing and re-checking
    if (allSucceeded) {
      try { adapter.dispose() } catch { /* ok */ }
      // Verify the plugin is actually installed after running commands
      const info = adapter.getInfo()
      if (!info.installed) {
        svc().log(`[memory] install commands succeeded but plugin not detected at expected paths`)
        return {
          success: false,
          results,
          error: 'Install commands completed but the plugin was not detected. Try installing manually in a terminal.'
        }
      }
      svc().log(`[memory] adapter ${adapterId} installed successfully, hasData=${info.hasData}`)
    }

    return {
      success: allSucceeded,
      results,
      error: allSucceeded ? undefined : results.find(r => !r.success)?.error
    }
  })

  ipcMain.handle(IPC.MEMORY_UNINSTALL_ADAPTER, async (_event, adapterId: string) => {
    const adapter = getAdapter(adapterId)
    if (!adapter) return { success: false, error: 'Adapter not found' }

    svc().log(`[memory] uninstalling adapter ${adapterId}...`)

    // Close DB connection first
    try { adapter.dispose() } catch { /* ok */ }

    // For claudest, uninstall via CLI
    if (adapterId === 'claudest') {
      const result = await runClaudeCli(['plugin', 'uninstall', 'claude-memory'])
      return result
    }

    return { success: false, error: 'Adapter does not support programmatic uninstall' }
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
    IPC.MEMORY_INSTALL_ADAPTER,
    IPC.MEMORY_UNINSTALL_ADAPTER,
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
