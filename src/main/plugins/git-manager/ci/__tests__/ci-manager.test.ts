import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Hoisted mocks
const { mockProvider, mockNotificationManager, mockRegistryResolve, mockGetPluginSetting } = vi.hoisted(() => {
  const mockProvider = {
    name: 'GitHub Actions',
    providerKey: 'github',
    isAvailable: vi.fn().mockResolvedValue(true),
    getSetupStatus: vi.fn(),
    runSetupAction: vi.fn(),
    getWorkflows: vi.fn().mockResolvedValue([]),
    getWorkflowRuns: vi.fn().mockResolvedValue([]),
    getActiveRuns: vi.fn().mockResolvedValue([]),
    getRun: vi.fn().mockResolvedValue(null),
    getRunJobs: vi.fn().mockResolvedValue([]),
    cancelRun: vi.fn(),
    rerunFailedJobs: vi.fn(),
    getJobLog: vi.fn().mockResolvedValue(''),
    getRunUrl: vi.fn().mockResolvedValue(''),
    parseLogSections: vi.fn().mockReturnValue([])
  }
  const mockNotificationManager = {
    notify: vi.fn()
  }
  const mockRegistryResolve = vi.fn().mockResolvedValue(mockProvider)
  const mockGetPluginSetting = vi.fn().mockReturnValue(undefined)
  return { mockProvider, mockNotificationManager, mockRegistryResolve, mockGetPluginSetting }
})

vi.mock('../ci-provider-registry', () => ({
  CiProviderRegistry: {
    getInstance: () => ({
      resolve: mockRegistryResolve
    })
  }
}))

vi.mock('../../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
    notify: mockNotificationManager.notify,
    getPluginSetting: mockGetPluginSetting
  })
}))

import { CiManager } from '../ci-manager'
import type { CiWorkflowRun } from '../../../../../shared/ci-types'

function makeRun(overrides: Partial<CiWorkflowRun> = {}): CiWorkflowRun {
  return {
    id: 1,
    name: 'CI',
    workflowId: 0,
    headBranch: 'main',
    headSha: 'abc123',
    status: 'in_progress',
    conclusion: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/user/repo/actions/runs/1',
    event: 'push',
    runNumber: 1,
    runAttempt: 1,
    actor: 'user',
    ...overrides
  }
}

describe('CiManager', () => {
  let manager: CiManager

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    manager = new CiManager()
  })

  afterEach(() => {
    manager.stopAll()
    vi.useRealTimers()
  })

  describe('startPolling', () => {
    it('starts polling for a project', async () => {
      mockProvider.getActiveRuns.mockResolvedValue([])
      await manager.startPolling('/project')

      // Should have called getActiveRuns at least once
      expect(mockProvider.getActiveRuns).toHaveBeenCalledWith('/project')
    })

    it('does not start duplicate polling for same project', async () => {
      mockProvider.getActiveRuns.mockResolvedValue([])
      await manager.startPolling('/project')
      await manager.startPolling('/project')

      // getActiveRuns should only be called once (from the first start)
      expect(mockProvider.getActiveRuns).toHaveBeenCalledTimes(1)
    })

    it('does nothing when no provider is resolved', async () => {
      mockRegistryResolve.mockResolvedValueOnce(null)
      await manager.startPolling('/project-no-provider')
      expect(mockProvider.getActiveRuns).not.toHaveBeenCalled()
    })
  })

  describe('stopPolling', () => {
    it('stops polling for a project', async () => {
      mockProvider.getActiveRuns.mockResolvedValue([])
      await manager.startPolling('/project')
      manager.stopPolling('/project')

      // After stopping, advancing timers should not trigger more calls
      const callsBefore = mockProvider.getActiveRuns.mock.calls.length
      await vi.advanceTimersByTimeAsync(120_000)
      expect(mockProvider.getActiveRuns).toHaveBeenCalledTimes(callsBefore)
    })

    it('does nothing for unknown project', () => {
      // Should not throw
      manager.stopPolling('/unknown')
    })
  })

  describe('stopAll', () => {
    it('stops all active pollers', async () => {
      mockProvider.getActiveRuns.mockResolvedValue([])
      await manager.startPolling('/project-a')

      // Reset mock for separate tracking
      mockRegistryResolve.mockResolvedValueOnce({
        ...mockProvider,
        providerKey: 'gitlab',
        name: 'GitLab CI'
      })
      await manager.startPolling('/project-b')

      manager.stopAll()

      const callsBefore = mockProvider.getActiveRuns.mock.calls.length
      await vi.advanceTimersByTimeAsync(120_000)
      expect(mockProvider.getActiveRuns).toHaveBeenCalledTimes(callsBefore)
    })
  })

  describe('polling interval', () => {
    it('uses faster interval when active runs exist', async () => {
      const activeRun = makeRun({ status: 'in_progress' })
      mockProvider.getActiveRuns.mockResolvedValue([activeRun])
      await manager.startPolling('/project')

      // First tick happened, wait for active poll interval (10s)
      const callsAfterStart = mockProvider.getActiveRuns.mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockProvider.getActiveRuns.mock.calls.length).toBeGreaterThan(callsAfterStart)
    })

    it('uses slower interval when no active runs', async () => {
      mockProvider.getActiveRuns.mockResolvedValue([])
      await manager.startPolling('/project')

      const callsAfterStart = mockProvider.getActiveRuns.mock.calls.length

      // After 10s (active interval) there should be no additional calls
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockProvider.getActiveRuns).toHaveBeenCalledTimes(callsAfterStart)

      // After 60s (idle interval) there should be another call
      await vi.advanceTimersByTimeAsync(50_000)
      expect(mockProvider.getActiveRuns.mock.calls.length).toBeGreaterThan(callsAfterStart)
    })
  })

  describe('notifications', () => {
    it('emits started notification for new runs after initialization', async () => {
      // First poll: no runs (initialization)
      mockProvider.getActiveRuns.mockResolvedValueOnce([])
      await manager.startPolling('/project')

      // Second poll: new run appears
      const newRun = makeRun({ id: 10, runNumber: 10, name: 'Build' })
      mockProvider.getActiveRuns.mockResolvedValueOnce([newRun])
      await vi.advanceTimersByTimeAsync(60_000)

      expect(mockNotificationManager.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'CI Run Started',
          source: 'git-manager',
          data: expect.objectContaining({ runId: 10, providerKey: 'github' })
        })
      )
    })

    it('does not emit started notification on first poll (initialization)', async () => {
      const activeRun = makeRun({ id: 1 })
      mockProvider.getActiveRuns.mockResolvedValueOnce([activeRun])
      await manager.startPolling('/project')

      // No started notification should fire for runs found on first poll
      expect(mockNotificationManager.notify).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'CI Run Started' })
      )
    })

    it('emits completion notification when run disappears from active list', async () => {
      // First poll: run is active
      const activeRun = makeRun({ id: 5, name: 'Test Suite', runNumber: 5 })
      mockProvider.getActiveRuns.mockResolvedValueOnce([activeRun])
      await manager.startPolling('/project')

      // Mock getRun to return the completed version
      mockProvider.getRun.mockResolvedValueOnce(
        makeRun({ id: 5, status: 'completed', conclusion: 'success' })
      )

      // Second poll: run disappears (completed)
      mockProvider.getActiveRuns.mockResolvedValueOnce([])
      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockNotificationManager.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'CI Run Passed',
          type: 'success',
          source: 'git-manager'
        })
      )
    })

    it('emits failure notification with correct type', async () => {
      const activeRun = makeRun({ id: 7, name: 'Build', runNumber: 7 })
      mockProvider.getActiveRuns.mockResolvedValueOnce([activeRun])
      await manager.startPolling('/project')

      mockProvider.getRun.mockResolvedValueOnce(
        makeRun({ id: 7, status: 'completed', conclusion: 'failure' })
      )
      mockProvider.getRunJobs.mockResolvedValueOnce([{
        id: 100,
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        startedAt: null,
        completedAt: null,
        steps: [{ name: 'Run tests', number: 1, status: 'completed', conclusion: 'failure' }],
        matrixKey: null,
        matrixValues: null
      }])

      mockProvider.getActiveRuns.mockResolvedValueOnce([])
      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockNotificationManager.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'CI Run Failed',
          type: 'error',
          source: 'git-manager'
        })
      )
    })

    it('emits cancelled notification with warning type when category enabled', async () => {
      // Default categories don't include 'cancelled', so enable it explicitly
      mockGetPluginSetting.mockReturnValue(['started', 'success', 'failure', 'cancelled'])

      const activeRun = makeRun({ id: 8 })
      mockProvider.getActiveRuns.mockResolvedValueOnce([activeRun])
      await manager.startPolling('/project-cancel')

      mockProvider.getRun.mockResolvedValueOnce(
        makeRun({ id: 8, status: 'completed', conclusion: 'cancelled' })
      )

      mockProvider.getActiveRuns.mockResolvedValueOnce([])
      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockNotificationManager.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'CI Run Cancelled',
          type: 'warning',
          source: 'git-manager'
        })
      )
    })

    it('includes "Fix with Claude" action for failed runs', async () => {
      const activeRun = makeRun({ id: 9 })
      mockProvider.getActiveRuns.mockResolvedValueOnce([activeRun])
      await manager.startPolling('/project')

      mockProvider.getRun.mockResolvedValueOnce(
        makeRun({ id: 9, status: 'completed', conclusion: 'failure' })
      )
      mockProvider.getRunJobs.mockResolvedValueOnce([{
        id: 200,
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        startedAt: null,
        completedAt: null,
        steps: [],
        matrixKey: null,
        matrixValues: null
      }])

      mockProvider.getActiveRuns.mockResolvedValueOnce([])
      await vi.advanceTimersByTimeAsync(10_000)

      const notifyCall = mockNotificationManager.notify.mock.calls.find(
        (c: any[]) => c[0].title === 'CI Run Failed'
      )
      expect(notifyCall).toBeDefined()
      const notification = notifyCall![0]
      expect(notification.actions).toBeDefined()
      expect(notification.actions.some((a: any) => a.label === 'Fix with Claude')).toBe(true)
    })

    it('includes providerKey in notification data', async () => {
      mockProvider.getActiveRuns.mockResolvedValueOnce([])
      await manager.startPolling('/project')

      const newRun = makeRun({ id: 20, runNumber: 20 })
      mockProvider.getActiveRuns.mockResolvedValueOnce([newRun])
      await vi.advanceTimersByTimeAsync(60_000)

      const startedCall = mockNotificationManager.notify.mock.calls.find(
        (c: any[]) => c[0].title === 'CI Run Started'
      )
      expect(startedCall).toBeDefined()
      expect(startedCall![0].data.providerKey).toBe('github')
    })

    it('uses provider-specific label in view action', async () => {
      // Set up with a Bitbucket provider
      const bbProvider = {
        ...mockProvider,
        name: 'Bitbucket Pipelines',
        providerKey: 'bitbucket'
      }
      mockRegistryResolve.mockResolvedValueOnce(bbProvider)

      bbProvider.getActiveRuns = vi.fn().mockResolvedValueOnce([])
      await manager.startPolling('/bb-project')

      const newRun = makeRun({ id: 30, runNumber: 30, url: 'https://bitbucket.org/...' })
      bbProvider.getActiveRuns.mockResolvedValueOnce([newRun])
      await vi.advanceTimersByTimeAsync(60_000)

      const startedCall = mockNotificationManager.notify.mock.calls.find(
        (c: any[]) => c[0].title === 'CI Run Started'
      )
      expect(startedCall).toBeDefined()
      expect(startedCall![0].action.label).toContain('Bitbucket')
    })
  })

  describe('notification filtering', () => {
    it('respects disabled notification categories', async () => {
      // Mock getPluginSetting to return empty array (all notifications disabled)
      mockGetPluginSetting.mockReturnValue([])

      mockProvider.getActiveRuns.mockResolvedValueOnce([])
      await manager.startPolling('/project')

      const newRun = makeRun({ id: 40, runNumber: 40 })
      mockProvider.getActiveRuns.mockResolvedValueOnce([newRun])
      await vi.advanceTimersByTimeAsync(60_000)

      // No started notification because 'started' is not in the enabled list
      expect(mockNotificationManager.notify).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'CI Run Started' })
      )
    })
  })

  describe('error handling', () => {
    it('continues polling after getActiveRuns error', async () => {
      mockProvider.getActiveRuns.mockRejectedValueOnce(new Error('Network error'))
      await manager.startPolling('/project')

      // Should recover and poll again
      mockProvider.getActiveRuns.mockResolvedValueOnce([])
      await vi.advanceTimersByTimeAsync(60_000)

      // At least 2 calls: initial (failed) + retry
      expect(mockProvider.getActiveRuns.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })
})
