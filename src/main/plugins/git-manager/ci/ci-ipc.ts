import { ipcMain } from 'electron'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../../../shared/ipc-channels'
import { GitHubActionsProvider } from './github-actions-provider'
import { CiManager } from './ci-manager'
import { log, logError } from '../../../logger'

const execFileAsync = promisify(execFile)

let ciManager: CiManager | null = null

function getManager(): CiManager {
  if (!ciManager) {
    ciManager = new CiManager(new GitHubActionsProvider())
  }
  return ciManager
}

export function registerCiIpc(): void {
  const provider = new GitHubActionsProvider()

  ipcMain.handle(IPC.CI_CHECK_AVAILABLE, async (_event, projectDir: string) => {
    return provider.isAvailable(projectDir)
  })

  ipcMain.handle(IPC.CI_CHECK_GH_INSTALLED, async () => {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      await execFileAsync(cmd, ['gh'], { timeout: 5000 })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.CI_CHECK_GH_AUTH, async () => {
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.CI_CHECK_GITHUB_REMOTE, async (_event, projectDir: string) => {
    try {
      const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'name', '-q', '.name'], { cwd: projectDir, timeout: 10_000 })
      return stdout.trim().length > 0
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.CI_RUN_GH_AUTH_LOGIN, async () => {
    try {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'gh auth login'], {
          stdio: 'ignore',
          detached: true,
          windowsHide: false
        }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', '--args', '-e', 'gh auth login'], {
          stdio: 'ignore',
          detached: true
        }).unref()
      } else {
        // Linux: try common terminal emulators
        const terminals = [
          { cmd: 'x-terminal-emulator', args: ['-e'] },
          { cmd: 'gnome-terminal', args: ['--'] },
          { cmd: 'konsole', args: ['-e'] },
          { cmd: 'xfce4-terminal', args: ['-e'] },
          { cmd: 'xterm', args: ['-e'] }
        ]
        for (const t of terminals) {
          try {
            await execFileAsync('which', [t.cmd], { timeout: 3000 })
            spawn(t.cmd, [...t.args, 'gh', 'auth', 'login'], {
              stdio: 'ignore',
              detached: true
            }).unref()
            return { success: true }
          } catch { /* try next */ }
        }
        return { success: false, error: 'No terminal emulator found' }
      }
      return { success: true }
    } catch (err) {
      logError('[ci] gh auth login failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to open terminal' }
    }
  })

  ipcMain.handle(IPC.CI_GET_WORKFLOWS, async (_event, projectDir: string) => {
    return provider.getWorkflows(projectDir)
  })

  ipcMain.handle(IPC.CI_GET_WORKFLOW_RUNS, async (_event, projectDir: string, workflowId: number, page: number, perPage: number) => {
    return provider.getWorkflowRuns(projectDir, workflowId, page, perPage)
  })

  ipcMain.handle(IPC.CI_GET_ACTIVE_RUNS, async (_event, projectDir: string) => {
    return provider.getActiveRuns(projectDir)
  })

  ipcMain.handle(IPC.CI_GET_RUN_JOBS, async (_event, projectDir: string, runId: number) => {
    return provider.getRunJobs(projectDir, runId)
  })

  ipcMain.handle(IPC.CI_CANCEL_RUN, async (_event, projectDir: string, runId: number) => {
    try {
      await provider.cancelRun(projectDir, runId)
      return { success: true }
    } catch (err) {
      logError('[ci] cancel run failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Cancel failed' }
    }
  })

  ipcMain.handle(IPC.CI_START_POLLING, async (_event, projectDir: string) => {
    getManager().startPolling(projectDir)
  })

  ipcMain.handle(IPC.CI_STOP_POLLING, async (_event, projectDir: string) => {
    getManager().stopPolling(projectDir)
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
