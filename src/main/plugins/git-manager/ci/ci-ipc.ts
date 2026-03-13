import { ipcMain } from 'electron'
import { IPC } from '../../../../shared/ipc-channels'
import { CiProviderRegistry } from './ci-provider-registry'
import { CiManager } from './ci-manager'
import { DockManager } from '../../../dock-manager'
import { GitManagerWindowManager } from '../git-manager-window'
import { log, logInfo, logError } from '../../../logger'

let ciManager: CiManager | null = null

function getManager(): CiManager {
  if (!ciManager) {
    ciManager = new CiManager()
  }
  return ciManager
}

const registry = CiProviderRegistry.getInstance()

export function registerCiIpc(): void {
  ipcMain.handle(IPC.CI_CHECK_AVAILABLE, async (_event, projectDir: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return false
    return provider.isAvailable(projectDir)
  })

  ipcMain.handle(IPC.CI_GET_SETUP_STATUS, async (_event, projectDir: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) {
      return {
        ready: false,
        providerName: 'Unknown',
        steps: [{
          id: 'unsupported',
          label: 'CI provider not supported',
          status: 'missing' as const,
          helpText: 'CI is not available for this repository\'s remote provider. GitHub, GitLab, and Bitbucket are currently supported.'
        }]
      }
    }
    return provider.getSetupStatus(projectDir)
  })

  ipcMain.handle(IPC.CI_RUN_SETUP_ACTION, async (_event, projectDir: string, actionId: string, data?: Record<string, string>) => {
    logInfo('[ci] runSetupAction IPC received:', actionId, 'data:', data ? JSON.stringify(Object.keys(data)) : 'undefined')
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No CI provider for this project' }
    return provider.runSetupAction(projectDir, actionId, data)
  })

  ipcMain.handle(IPC.CI_GET_WORKFLOWS, async (_event, projectDir: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    return provider.getWorkflows(projectDir)
  })

  ipcMain.handle(IPC.CI_GET_WORKFLOW_RUNS, async (_event, projectDir: string, workflowId: number, page: number, perPage: number) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    return provider.getWorkflowRuns(projectDir, workflowId, page, perPage)
  })

  ipcMain.handle(IPC.CI_GET_ACTIVE_RUNS, async (_event, projectDir: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    return provider.getActiveRuns(projectDir)
  })

  ipcMain.handle(IPC.CI_GET_RUN_JOBS, async (_event, projectDir: string, runId: number) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    return provider.getRunJobs(projectDir, runId)
  })

  ipcMain.handle(IPC.CI_GET_JOB_LOG, async (_event, projectDir: string, jobId: number) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return ''
    try {
      return await provider.getJobLog(projectDir, jobId)
    } catch (err) {
      logError('[ci] getJobLog failed:', err)
      return ''
    }
  })

  ipcMain.handle(IPC.CI_CANCEL_RUN, async (_event, projectDir: string, runId: number) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No CI provider' }
    try {
      await provider.cancelRun(projectDir, runId)
      return { success: true }
    } catch (err) {
      logError('[ci] cancel run failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Cancel failed' }
    }
  })

  ipcMain.handle(IPC.CI_START_POLLING, async (_event, projectDir: string) => {
    await getManager().startPolling(projectDir)
  })

  ipcMain.handle(IPC.CI_STOP_POLLING, async (_event, projectDir: string) => {
    getManager().stopPolling(projectDir)
  })

  ipcMain.handle(IPC.CI_RERUN_FAILED, async (_event, projectDir: string, runId: number) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No CI provider' }
    try {
      await provider.rerunFailedJobs(projectDir, runId)
      return { success: true }
    } catch (err) {
      logError('[ci] rerunFailed failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Rerun failed' }
    }
  })

  // Navigate to a CI run in the git-manager plugin window (called from dock window)
  ipcMain.handle(IPC.CI_NAVIGATE_TO_RUN, async (_event, projectDir: string, runId: number) => {
    const mgr = GitManagerWindowManager.getInstance()
    const existingWin = mgr.getWindow(projectDir)
    await mgr.open(projectDir)
    const win = mgr.getWindow(projectDir)
    if (!win) return false

    const send = () => {
      if (!win.isDestroyed()) win.webContents.send('ci-navigate-run', runId)
    }

    if (existingWin) {
      // Window already loaded — send immediately
      send()
    } else {
      // Newly created — wait for page + React mount, then send
      // The renderer queues this as pendingCiRunId, so exact timing is non-critical
      win.webContents.once('did-finish-load', () => {
        setTimeout(send, 500)
      })
    }
    return true
  })

  // Forward "Fix with Claude" from plugin window to the dock window and focus it
  ipcMain.handle(IPC.CI_FIX_WITH_CLAUDE, async (_event, projectDir: string, data: Record<string, unknown>) => {
    const docks = DockManager.getInstance().getAllDocks()
    const dock = docks.find((d) => d.projectDir === projectDir)
    if (dock && !dock.window.isDestroyed()) {
      dock.window.webContents.send('ci-fix-with-claude', data)
      if (dock.window.isMinimized()) dock.window.restore()
      dock.window.focus()
      return true
    }
    return false
  })

  log('[ci] IPC handlers registered')
}

export function disposeCi(): void {
  ciManager?.stopAll()
  ciManager = null
}

export function stopCiPollingForProject(projectDir: string): void {
  ciManager?.stopPolling(projectDir)
}
