import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc-channels'
import { TestRunnerWindowManager } from './test-runner-window'
import * as engine from './test-runner-engine'
import { getServices } from './services'

export function registerTestRunnerIpc(): void {
  ipcMain.handle(IPC.TEST_RUNNER_OPEN, async (_event, projectDir: string) => {
    try {
      await TestRunnerWindowManager.getInstance().open(projectDir)
    } catch (err) {
      getServices().logError('[test-runner] open window failed:', err)
    }
  })

  ipcMain.handle(IPC.TEST_RUNNER_DETECT, async (_event, projectDir: string) => {
    try {
      return await engine.detect(projectDir)
    } catch (err) {
      getServices().logError('[test-runner] detect failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.TEST_RUNNER_DISCOVER, async (_event, projectDir: string, adapterId: string) => {
    try {
      return await engine.discover(projectDir, adapterId)
    } catch (err) {
      getServices().logError('[test-runner] discover failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.TEST_RUNNER_RUN, async (_event, projectDir: string, adapterId: string, testIds: string[], options?: any) => {
    try {
      const runId = await engine.runTests(projectDir, adapterId, testIds, options)
      return { success: true, runId }
    } catch (err) {
      getServices().logError('[test-runner] run failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Run failed' }
    }
  })

  ipcMain.handle(IPC.TEST_RUNNER_STOP, async (_event, projectDir: string) => {
    try {
      return { stopped: engine.stopTests(projectDir) }
    } catch (err) {
      getServices().logError('[test-runner] stop failed:', err)
      return { stopped: false }
    }
  })

  ipcMain.handle(IPC.TEST_RUNNER_GET_STATUS, async (_event, projectDir: string) => {
    try {
      return { running: engine.isRunning(projectDir) }
    } catch (err) {
      return { running: false }
    }
  })
}

export function disposeTestRunnerIpc(): void {
  const channels = [
    IPC.TEST_RUNNER_OPEN,
    IPC.TEST_RUNNER_DETECT,
    IPC.TEST_RUNNER_DISCOVER,
    IPC.TEST_RUNNER_RUN,
    IPC.TEST_RUNNER_STOP,
    IPC.TEST_RUNNER_GET_STATUS
  ]
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch) } catch { /* ignore */ }
  }
}
