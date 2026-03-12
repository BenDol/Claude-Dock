import { ipcMain, BrowserWindow } from 'electron'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../../../../shared/ipc-channels'
import { GitHubActionsProvider, resolveGh } from './github-actions-provider'
import { CiManager } from './ci-manager'
import { DockManager } from '../../../dock-manager'
import { GitManagerWindowManager } from '../git-manager-window'
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
      const ghBin = resolveGh()
      // resolveGh falls back to 'gh' if nothing found — verify it actually exists
      await execFileAsync(ghBin, ['--version'], { timeout: 5000 })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.CI_CHECK_GH_AUTH, async () => {
    try {
      await execFileAsync(resolveGh(), ['auth', 'status'], { timeout: 10_000 })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.CI_CHECK_GITHUB_REMOTE, async (_event, projectDir: string) => {
    try {
      const { stdout } = await execFileAsync(resolveGh(), ['repo', 'view', '--json', 'name', '-q', '.name'], { cwd: projectDir, timeout: 10_000 })
      return stdout.trim().length > 0
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.CI_RUN_GH_AUTH_LOGIN, async () => {
    try {
      const ghBin = resolveGh()
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `"${ghBin}" auth login`], {
          stdio: 'ignore',
          detached: true,
          windowsHide: false
        }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Terminal', '--args', '-e', `${ghBin} auth login`], {
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
            spawn(t.cmd, [...t.args, ghBin, 'auth', 'login'], {
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

  ipcMain.handle(IPC.CI_GET_JOB_LOG, async (_event, projectDir: string, jobId: number) => {
    try {
      return await provider.getJobLog(projectDir, jobId)
    } catch (err) {
      logError('[ci] getJobLog failed:', err)
      return ''
    }
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

  ipcMain.handle(IPC.CI_RERUN_FAILED, async (_event, projectDir: string, runId: number) => {
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
