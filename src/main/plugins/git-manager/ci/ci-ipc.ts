import { ipcMain } from 'electron'
import { IPC } from '../../../../shared/ipc-channels'
import { CiProviderRegistry } from './ci-provider-registry'
import { CiManager } from './ci-manager'
import { GitManagerWindowManager } from '../git-manager-window'
import { getServices } from '../services'
import type { CiFixTask, ClaudeTaskRequest } from '../../../../shared/claude-task-types'

let ciManager: CiManager | null = null

function getManager(): CiManager {
  if (!ciManager) {
    ciManager = new CiManager()
  }
  return ciManager
}

const registry = CiProviderRegistry.getInstance()

function sendTaskToDock(projectDir: string, task: ClaudeTaskRequest): boolean {
  return getServices().sendTaskToDock(projectDir, 'claude:task', task)
}

export function registerCiIpc(): void {
  ipcMain.handle(IPC.CI_CHECK_AVAILABLE, async (_event, projectDir: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return false
    const available = await provider.isAvailable(projectDir)
    return available ? provider.providerKey : false
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
    getServices().logInfo('[ci] runSetupAction IPC received:', actionId, 'data:', data ? JSON.stringify(Object.keys(data)) : 'undefined')
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
      getServices().logError('[ci] getJobLog failed:', err)
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
      getServices().logError('[ci] cancel run failed:', err)
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
      getServices().logError('[ci] rerunFailed failed:', err)
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
  // Converts untyped data into a CiFixTask and forwards through the unified claude:task channel
  ipcMain.handle(IPC.CI_FIX_WITH_CLAUDE, async (_event, projectDir: string, data: Record<string, unknown>) => {
    const task: CiFixTask = {
      type: 'ci-fix',
      runId: data.runId as number,
      runName: data.runName as string,
      runNumber: data.runNumber as number,
      headBranch: data.headBranch as string,
      failedJobs: data.failedJobs as CiFixTask['failedJobs'],
      primaryFailedJobId: data.primaryFailedJobId as number | undefined,
      sourceDir: data.sourceDir as string | undefined
    }
    return sendTaskToDock(projectDir, task)
  })

  // Generic Claude task handler — used by git-manager plugin and future task sources
  ipcMain.handle(IPC.CLAUDE_SEND_TASK, async (_event, projectDir: string, task: ClaudeTaskRequest) => {
    return sendTaskToDock(projectDir, task)
  })

  getServices().log('[ci] IPC handlers registered')
}

export function disposeCi(): void {
  ciManager?.stopAll()
  ciManager = null

  // Remove all CI_* and CLAUDE_SEND_TASK handlers (for hot-reload)
  for (const [key, channel] of Object.entries(IPC)) {
    if (key.startsWith('CI_') || key === 'CLAUDE_SEND_TASK') {
      ipcMain.removeHandler(channel as string)
    }
  }
}

export function stopCiPollingForProject(projectDir: string): void {
  ciManager?.stopPolling(projectDir)
}
