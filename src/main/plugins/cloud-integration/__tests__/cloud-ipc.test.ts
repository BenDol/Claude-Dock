import { describe, it, expect, vi, beforeEach } from 'vitest'

// Track IPC handlers
const handlers = new Map<string, Function>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  },
  BrowserWindow: vi.fn()
}))

// Mock services
const mockLog = vi.fn()
const mockLogError = vi.fn()
const mockGetPluginSetting = vi.fn()
vi.mock('../services', () => ({
  getServices: () => ({
    log: mockLog,
    logError: mockLogError,
    getPluginSetting: mockGetPluginSetting,
    getSettings: () => ({ theme: { mode: 'dark' } }),
    getWindowState: () => undefined,
    saveWindowState: vi.fn(),
    broadcastPluginWindowState: vi.fn(),
    paths: { preload: '', rendererHtml: '', rendererUrl: undefined, rendererOverrideHtml: undefined }
  })
}))

// Mock providers
const mockCheckAuth = vi.fn()
const mockGetProject = vi.fn()
const mockGetKubernetesSummary = vi.fn()
const mockGetClusters = vi.fn()
const mockGetClusterDetail = vi.fn()
const mockGetWorkloads = vi.fn()
const mockGetWorkloadDetail = vi.fn()
const mockGetConsoleUrl = vi.fn()
const mockToInfo = vi.fn()

const mockProvider = {
  id: 'gcp',
  checkAuth: mockCheckAuth,
  getProject: mockGetProject,
  getKubernetesSummary: mockGetKubernetesSummary,
  getClusters: mockGetClusters,
  getClusterDetail: mockGetClusterDetail,
  getWorkloads: mockGetWorkloads,
  getWorkloadDetail: mockGetWorkloadDetail,
  getConsoleUrl: mockGetConsoleUrl,
  toInfo: mockToInfo
}

vi.mock('../providers', () => ({
  getProvider: () => mockProvider,
  getAllProviders: () => [mockProvider]
}))

// Mock window manager
vi.mock('../cloud-window', () => ({
  CloudWindowManager: {
    getInstance: () => ({
      open: vi.fn(),
      close: vi.fn()
    })
  }
}))

import { registerCloudIpc, disposeCloudIpc } from '../cloud-ipc'
import { IPC } from '../../../../shared/ipc-channels'

describe('Cloud Integration IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    mockGetPluginSetting.mockReturnValue('gcp')
    registerCloudIpc()
  })

  it('should register all IPC handlers', () => {
    expect(handlers.has(IPC.CLOUD_OPEN)).toBe(true)
    expect(handlers.has(IPC.CLOUD_GET_PROVIDERS)).toBe(true)
    expect(handlers.has(IPC.CLOUD_GET_ACTIVE_PROVIDER)).toBe(true)
    expect(handlers.has(IPC.CLOUD_SET_PROVIDER)).toBe(true)
    expect(handlers.has(IPC.CLOUD_GET_DASHBOARD)).toBe(true)
    expect(handlers.has(IPC.CLOUD_GET_CLUSTERS)).toBe(true)
    expect(handlers.has(IPC.CLOUD_GET_CLUSTER_DETAIL)).toBe(true)
    expect(handlers.has(IPC.CLOUD_GET_WORKLOADS)).toBe(true)
    expect(handlers.has(IPC.CLOUD_GET_WORKLOAD_DETAIL)).toBe(true)
    expect(handlers.has(IPC.CLOUD_GET_CONSOLE_URL)).toBe(true)
    expect(handlers.has(IPC.CLOUD_CHECK_AUTH)).toBe(true)
  })

  it('CLOUD_GET_PROVIDERS should return provider info with auth status', async () => {
    mockCheckAuth.mockResolvedValue(true)
    mockToInfo.mockReturnValue({ id: 'gcp', name: 'GCP', available: true, icon: '<svg/>', consoleBaseUrl: 'https://console.cloud.google.com' })

    const handler = handlers.get(IPC.CLOUD_GET_PROVIDERS)!
    const result = await handler({})
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('gcp')
    expect(result[0].available).toBe(true)
  })

  it('CLOUD_GET_DASHBOARD should return dashboard data', async () => {
    const dashboardData = {
      provider: { id: 'gcp', name: 'GCP', available: true },
      project: { id: 'proj', name: 'proj' },
      kubernetes: { clusterCount: 2, totalNodes: 5, totalPods: 10, healthyClusters: 2, unhealthyClusters: 0 }
    }
    mockCheckAuth.mockResolvedValue(true)
    mockGetProject.mockResolvedValue(dashboardData.project)
    mockGetKubernetesSummary.mockResolvedValue(dashboardData.kubernetes)
    mockToInfo.mockReturnValue(dashboardData.provider)

    const handler = handlers.get(IPC.CLOUD_GET_DASHBOARD)!
    const result = await handler({}, '/project')
    expect(result).not.toBeNull()
    expect(result.project.id).toBe('proj')
    expect(result.kubernetes.clusterCount).toBe(2)
  })

  it('CLOUD_GET_CLUSTERS should call provider getClusters', async () => {
    const clusters = [{ name: 'c1', status: 'RUNNING' }]
    mockGetClusters.mockResolvedValue(clusters)

    const handler = handlers.get(IPC.CLOUD_GET_CLUSTERS)!
    const result = await handler({}, '/project')
    expect(result).toEqual(clusters)
  })

  it('CLOUD_GET_CLUSTER_DETAIL should call provider getClusterDetail', async () => {
    const detail = { name: 'c1', status: 'RUNNING', nodes: [] }
    mockGetClusterDetail.mockResolvedValue(detail)

    const handler = handlers.get(IPC.CLOUD_GET_CLUSTER_DETAIL)!
    const result = await handler({}, '/project', 'c1')
    expect(result).toEqual(detail)
    expect(mockGetClusterDetail).toHaveBeenCalledWith('c1')
  })

  it('CLOUD_GET_WORKLOADS should call provider getWorkloads', async () => {
    const workloads = [{ name: 'w1', kind: 'Deployment' }]
    mockGetWorkloads.mockResolvedValue(workloads)

    const handler = handlers.get(IPC.CLOUD_GET_WORKLOADS)!
    const result = await handler({}, '/project', 'cluster1')
    expect(result).toEqual(workloads)
    expect(mockGetWorkloads).toHaveBeenCalledWith('cluster1')
  })

  it('CLOUD_GET_WORKLOAD_DETAIL should call provider getWorkloadDetail', async () => {
    const detail = { name: 'w1', pods: [] }
    mockGetWorkloadDetail.mockResolvedValue(detail)

    const handler = handlers.get(IPC.CLOUD_GET_WORKLOAD_DETAIL)!
    const result = await handler({}, '/project', 'c1', 'default', 'w1', 'Deployment')
    expect(result).toEqual(detail)
    expect(mockGetWorkloadDetail).toHaveBeenCalledWith('c1', 'default', 'w1', 'Deployment')
  })

  it('CLOUD_CHECK_AUTH should return auth status', async () => {
    mockCheckAuth.mockResolvedValue(true)

    const handler = handlers.get(IPC.CLOUD_CHECK_AUTH)!
    const result = await handler({}, '/project')
    expect(result).toBe(true)
  })

  it('CLOUD_CHECK_AUTH should return false on error', async () => {
    mockCheckAuth.mockRejectedValue(new Error('not installed'))

    const handler = handlers.get(IPC.CLOUD_CHECK_AUTH)!
    const result = await handler({}, '/project')
    expect(result).toBe(false)
  })

  it('CLOUD_GET_CONSOLE_URL should call provider getConsoleUrl', async () => {
    mockGetConsoleUrl.mockReturnValue('https://console.cloud.google.com/dashboard')

    const handler = handlers.get(IPC.CLOUD_GET_CONSOLE_URL)!
    const result = await handler({}, '/project', 'dashboard', {})
    expect(result).toBe('https://console.cloud.google.com/dashboard')
  })

  it('should handle errors gracefully and return empty/null', async () => {
    mockGetClusters.mockRejectedValue(new Error('network error'))
    const handler = handlers.get(IPC.CLOUD_GET_CLUSTERS)!
    const result = await handler({}, '/project')
    expect(result).toEqual([])
    expect(mockLogError).toHaveBeenCalled()
  })

  it('disposeCloudIpc should remove all handlers', async () => {
    const { ipcMain } = await import('electron')
    disposeCloudIpc()
    expect(ipcMain.removeHandler).toHaveBeenCalled()
  })
})
