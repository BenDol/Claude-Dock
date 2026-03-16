import { describe, it, expect, vi, beforeEach } from 'vitest'

// Provide globals that are normally injected by Vite define
;(globalThis as any).__BUILD_SHA__ = 'test-build-sha'
;(globalThis as any).__PLUGIN_BUILD_SHAS__ = { 'git-sync': 'local-git-sync-sha', 'git-manager': 'local-git-manager-sha' }

// --- Hoisted mocks ---

const { mockFetchJSON, mockDownloadFile, mockExtractHostname, mockLog, mockLogError } = vi.hoisted(() => ({
  mockFetchJSON: vi.fn(),
  mockDownloadFile: vi.fn(),
  mockExtractHostname: vi.fn((url: string) => {
    try { return new URL(url).hostname } catch { return null }
  }),
  mockLog: vi.fn(),
  mockLogError: vi.fn()
}))

const {
  mockGetLastChecked, mockSetLastChecked,
  mockGetDismissedVersions, mockDismissVersion,
  mockGetVerifiedHosts, mockSetVerifiedHosts,
  mockGetOverrides, mockSetOverride,
  verifiedHostsState
} = vi.hoisted(() => {
  // Shared state so setVerifiedHosts updates what getVerifiedHosts returns
  const verifiedHostsState = { hosts: [] as string[], fetchedAt: 0 }
  return {
    mockGetLastChecked: vi.fn().mockReturnValue(0),
    mockSetLastChecked: vi.fn(),
    mockGetDismissedVersions: vi.fn().mockReturnValue({}),
    mockDismissVersion: vi.fn(),
    mockGetVerifiedHosts: vi.fn(() => ({ hosts: verifiedHostsState.hosts, fetchedAt: verifiedHostsState.fetchedAt })),
    mockSetVerifiedHosts: vi.fn((hosts: string[]) => {
      verifiedHostsState.hosts = hosts
      verifiedHostsState.fetchedAt = Date.now()
    }),
    mockGetOverrides: vi.fn().mockReturnValue({}),
    mockSetOverride: vi.fn(),
    verifiedHostsState
  }
})

const { mockGetPluginInfoList, mockPlugins } = vi.hoisted(() => ({
  mockGetPluginInfoList: vi.fn().mockReturnValue([]),
  mockPlugins: [] as any[]
}))

const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn().mockReturnValue([])
}))

// --- Module mocks ---

vi.mock('../http-utils', () => ({
  fetchJSON: mockFetchJSON,
  downloadFile: mockDownloadFile,
  extractHostname: mockExtractHostname
}))

vi.mock('../logger', () => ({
  log: mockLog,
  logError: mockLogError
}))

vi.mock('../plugins/plugin-update-store', () => ({
  getLastChecked: mockGetLastChecked,
  setLastChecked: mockSetLastChecked,
  getDismissedVersions: mockGetDismissedVersions,
  dismissVersion: mockDismissVersion,
  getVerifiedHosts: mockGetVerifiedHosts,
  setVerifiedHosts: mockSetVerifiedHosts,
  getOverrides: mockGetOverrides,
  setOverride: mockSetOverride
}))

vi.mock('../plugins/plugin-manager', () => ({
  PluginManager: {
    getInstance: () => ({
      getPluginInfoList: mockGetPluginInfoList,
      plugins: mockPlugins
    })
  }
}))

vi.mock('../plugins/plugin-loader', () => ({
  trustPlugin: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getPath: (name: string) => name === 'userData' ? '/mock/userData' : '/mock'
  },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 })
  },
  BrowserWindow: {
    getAllWindows: mockGetAllWindows
  }
}))

// Must import after mocks
import { PluginUpdateService } from '../plugins/plugin-updater'
import type { PluginUpdateManifest } from '../../shared/plugin-update-types'

describe('PluginUpdateService', () => {
  let service: PluginUpdateService

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset mock implementations (clearAllMocks only clears call history, not implementations)
    mockFetchJSON.mockReset()
    // Reset singleton
    ;(PluginUpdateService as any).instance = undefined
    service = PluginUpdateService.getInstance()

    // Default: no plugins registered
    mockGetPluginInfoList.mockReturnValue([])
    mockPlugins.length = 0
    mockGetDismissedVersions.mockReturnValue({})
    verifiedHostsState.hosts = []
    verifiedHostsState.fetchedAt = 0
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = PluginUpdateService.getInstance()
      const b = PluginUpdateService.getInstance()
      expect(a).toBe(b)
    })
  })

  describe('checkForUpdates', () => {
    it('returns empty array when no plugins registered', async () => {
      mockFetchJSON.mockRejectedValue(new Error('no manifest'))
      const updates = await service.checkForUpdates()
      expect(updates).toEqual([])
    })

    it('sets lastChecked after checking', async () => {
      mockFetchJSON.mockRejectedValue(new Error('no manifest'))
      await service.checkForUpdates()
      expect(mockSetLastChecked).toHaveBeenCalledWith(expect.any(Number))
    })

    it('continues checking external plugins even if built-in check fails', async () => {
      mockFetchJSON.mockRejectedValue(new Error('network error'))
      const updates = await service.checkForUpdates()
      expect(updates).toEqual([])
      // Should not throw — errors are handled internally
    })
  })

  describe('checkBuiltinPlugins', () => {
    const builtinPlugin = {
      id: 'git-sync',
      name: 'Git Sync',
      description: 'desc',
      defaultEnabled: false,
      version: '1.0.0',
      source: 'builtin' as const,
      settingsSchema: []
    }

    const remoteManifest: PluginUpdateManifest = {
      schemaVersion: 1,
      buildSha: 'remote-sha',
      buildDate: '2026-03-16',
      plugins: {
        'git-sync': {
          version: '2.0.0',
          buildSha: 'remote-plugin-sha',
          hash: 'abc123',
          archivePath: 'git-sync/',
          changelog: 'New features'
        }
      }
    }

    beforeEach(() => {
      mockGetPluginInfoList.mockReturnValue([builtinPlugin])
    })

    it('detects newer version for latest profile', async () => {
      mockFetchJSON.mockResolvedValue(remoteManifest)
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(1)
      expect(updates[0].pluginId).toBe('git-sync')
      expect(updates[0].currentVersion).toBe('1.0.0')
      expect(updates[0].newVersion).toBe('2.0.0')
      expect(updates[0].source).toBe('builtin')
      expect(updates[0].status).toBe('available')
      expect(updates[0].changelog).toBe('New features')
    })

    it('skips when remote version is same and SHA matches', async () => {
      // Same version, same SHA (no hotfix)
      const sameVersionManifest = {
        ...remoteManifest,
        plugins: {
          'git-sync': {
            ...remoteManifest.plugins['git-sync'],
            version: '1.0.0',
            buildSha: 'local-git-sync-sha' // matches __PLUGIN_BUILD_SHAS__['git-sync']
          }
        }
      }
      mockFetchJSON.mockResolvedValue(sameVersionManifest)
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(0)
    })

    it('detects same-version update when build SHA differs (hotfix)', async () => {
      const hotfixManifest = {
        ...remoteManifest,
        plugins: {
          'git-sync': {
            ...remoteManifest.plugins['git-sync'],
            version: '1.0.0',
            buildSha: 'different-sha-than-local'
          }
        }
      }
      mockFetchJSON.mockResolvedValue(hotfixManifest)
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(1)
      expect(updates[0].currentVersion).toBe('1.0.0')
      expect(updates[0].newVersion).toBe('1.0.0')
    })

    it('skips dismissed versions', async () => {
      mockGetDismissedVersions.mockReturnValue({ 'git-sync': '2.0.0' })
      mockFetchJSON.mockResolvedValue(remoteManifest)
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(0)
    })

    it('skips when minAppVersion exceeds current app version', async () => {
      const manifestWithMinApp = {
        ...remoteManifest,
        plugins: {
          'git-sync': {
            ...remoteManifest.plugins['git-sync'],
            minAppVersion: '99.0.0'
          }
        }
      }
      mockFetchJSON.mockResolvedValue(manifestWithMinApp)
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(0)
    })

    it('includes update when minAppVersion is satisfied', async () => {
      const manifestWithMinApp = {
        ...remoteManifest,
        plugins: {
          'git-sync': {
            ...remoteManifest.plugins['git-sync'],
            minAppVersion: '0.9.0'
          }
        }
      }
      mockFetchJSON.mockResolvedValue(manifestWithMinApp)
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(1)
    })

    it('skips external plugins during builtin check', async () => {
      mockGetPluginInfoList.mockReturnValue([
        builtinPlugin,
        { ...builtinPlugin, id: 'external-plugin', source: 'external' }
      ])
      mockFetchJSON.mockResolvedValue(remoteManifest)
      const updates = await service.checkForUpdates('latest')
      // Only git-sync should be detected, not external-plugin
      expect(updates).toHaveLength(1)
      expect(updates[0].pluginId).toBe('git-sync')
    })

    it('handles manifest fetch failure gracefully', async () => {
      mockFetchJSON.mockRejectedValue(new Error('404'))
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(0)
    })

    it('skips plugins not in manifest', async () => {
      mockGetPluginInfoList.mockReturnValue([
        builtinPlugin,
        { ...builtinPlugin, id: 'git-manager', name: 'Git Manager' }
      ])
      mockFetchJSON.mockResolvedValue(remoteManifest) // only has git-sync
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(1)
      expect(updates[0].pluginId).toBe('git-sync')
    })

    it('sets requiresAppUpdate flag from manifest', async () => {
      const manifestWithAppUpdate = {
        ...remoteManifest,
        plugins: {
          'git-sync': {
            ...remoteManifest.plugins['git-sync'],
            requiresAppUpdate: true
          }
        }
      }
      mockFetchJSON.mockResolvedValue(manifestWithAppUpdate)
      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(1)
      expect(updates[0].requiresAppUpdate).toBe(true)
    })
  })

  describe('checkExternalPlugins', () => {
    beforeEach(() => {
      mockGetPluginInfoList.mockReturnValue([
        {
          id: 'my-plugin',
          name: 'My Plugin',
          description: 'desc',
          defaultEnabled: true,
          version: '1.0.0',
          source: 'external',
          settingsSchema: []
        }
      ])

      // Add a mock runtime plugin with manifest.updateUrl
      mockPlugins.push({
        id: 'my-plugin',
        name: 'My Plugin',
        manifest: {
          id: 'my-plugin',
          name: 'My Plugin',
          version: '1.0.0',
          updateUrl: 'https://github.com/user/my-plugin/update.json'
        }
      })
    })

    it('skips plugins without updateUrl', async () => {
      mockPlugins[0].manifest.updateUrl = undefined
      // Reject the builtin manifest fetch
      mockFetchJSON.mockRejectedValue(new Error('no manifest'))
      const updates = await service.checkForUpdates()
      expect(updates).toHaveLength(0)
    })

    it('skips external plugins with non-verified host', async () => {
      // First call: rejects (no builtin manifest), second call: verified-updaters, third: external manifest
      mockFetchJSON
        .mockRejectedValueOnce(new Error('no builtin manifest'))
        .mockResolvedValueOnce({ schemaVersion: 1, allowedHosts: ['safe-host.com'] })
      // github.com is NOT in allowedHosts
      const updates = await service.checkForUpdates()
      expect(updates).toHaveLength(0)
    })

    it('detects update from verified host', async () => {
      mockFetchJSON
        .mockRejectedValueOnce(new Error('no builtin manifest'))
        .mockResolvedValueOnce({ schemaVersion: 1, allowedHosts: ['github.com'] })
        .mockResolvedValueOnce({
          schemaVersion: 1,
          version: '2.0.0',
          hash: 'abc123',
          downloadUrl: 'https://github.com/user/my-plugin/releases/download/v2.0.0/plugin.zip',
          changelog: 'Big update'
        })

      const updates = await service.checkForUpdates()
      expect(updates).toHaveLength(1)
      expect(updates[0].pluginId).toBe('my-plugin')
      expect(updates[0].source).toBe('external')
      expect(updates[0].newVersion).toBe('2.0.0')
      expect(updates[0].changelog).toBe('Big update')
    })

    it('skips external update when download host is not verified', async () => {
      mockFetchJSON
        .mockRejectedValueOnce(new Error('no builtin manifest'))
        .mockResolvedValueOnce({ schemaVersion: 1, allowedHosts: ['github.com'] })
        .mockResolvedValueOnce({
          schemaVersion: 1,
          version: '2.0.0',
          hash: 'abc123',
          downloadUrl: 'https://evil-host.com/plugin.zip',
          changelog: 'Suspicious'
        })

      const updates = await service.checkForUpdates()
      expect(updates).toHaveLength(0)
    })

    it('skips dismissed external versions', async () => {
      mockGetDismissedVersions.mockReturnValue({ 'my-plugin': '2.0.0' })
      mockFetchJSON
        .mockRejectedValueOnce(new Error('no builtin manifest'))
        .mockResolvedValueOnce({ schemaVersion: 1, allowedHosts: ['github.com'] })
        .mockResolvedValueOnce({
          schemaVersion: 1, version: '2.0.0', hash: 'abc', downloadUrl: 'https://github.com/dl.zip'
        })

      const updates = await service.checkForUpdates()
      expect(updates).toHaveLength(0)
    })

    it('skips when external version is not newer', async () => {
      mockFetchJSON
        .mockRejectedValueOnce(new Error('no builtin manifest'))
        .mockResolvedValueOnce({ schemaVersion: 1, allowedHosts: ['github.com'] })
        .mockResolvedValueOnce({
          schemaVersion: 1, version: '0.9.0', hash: 'abc', downloadUrl: 'https://github.com/dl.zip'
        })

      const updates = await service.checkForUpdates()
      expect(updates).toHaveLength(0)
    })
  })

  describe('verified hosts', () => {
    it('uses cached hosts when not stale', async () => {
      verifiedHostsState.hosts = ['github.com']
      verifiedHostsState.fetchedAt = Date.now() // fresh

      mockGetPluginInfoList.mockReturnValue([
        { id: 'ext', name: 'E', description: '', defaultEnabled: true, version: '1.0.0', source: 'external' }
      ])
      mockPlugins.push({
        id: 'ext', name: 'E',
        manifest: { id: 'ext', name: 'E', version: '1.0.0', updateUrl: 'https://github.com/u/r/update.json' }
      })

      mockFetchJSON
        .mockRejectedValueOnce(new Error('no builtin'))
        .mockResolvedValueOnce({ schemaVersion: 1, version: '2.0.0', hash: 'abc', downloadUrl: 'https://github.com/dl.zip' })

      const updates = await service.checkForUpdates()
      // Should NOT have fetched verified-updaters.json (cached is fresh)
      // First call was builtin manifest (rejected), second was external update.json
      expect(mockFetchJSON).toHaveBeenCalledTimes(2)
      expect(updates).toHaveLength(1)
    })

    it('fetches fresh hosts when stale', async () => {
      verifiedHostsState.hosts = ['old-host.com']
      verifiedHostsState.fetchedAt = 0 // very stale

      mockGetPluginInfoList.mockReturnValue([
        { id: 'ext', name: 'E', description: '', defaultEnabled: true, version: '1.0.0', source: 'external' }
      ])
      mockPlugins.push({
        id: 'ext', name: 'E',
        manifest: { id: 'ext', name: 'E', version: '1.0.0', updateUrl: 'https://github.com/u/r/update.json' }
      })

      mockFetchJSON
        .mockRejectedValueOnce(new Error('no builtin'))
        .mockResolvedValueOnce({ schemaVersion: 1, allowedHosts: ['github.com'] }) // fresh hosts
        .mockResolvedValueOnce({ schemaVersion: 1, version: '2.0.0', hash: 'abc', downloadUrl: 'https://github.com/dl.zip' })

      const updates = await service.checkForUpdates()
      expect(mockSetVerifiedHosts).toHaveBeenCalledWith(['github.com'])
      expect(updates).toHaveLength(1)
    })

    it('blocks all external updates when no hosts available (fail-closed)', async () => {
      verifiedHostsState.hosts = []
      verifiedHostsState.fetchedAt = 0

      mockGetPluginInfoList.mockReturnValue([
        { id: 'ext', name: 'E', description: '', defaultEnabled: true, version: '1.0.0', source: 'external' }
      ])
      mockPlugins.push({
        id: 'ext', name: 'E',
        manifest: { id: 'ext', name: 'E', version: '1.0.0', updateUrl: 'https://github.com/u/r/update.json' }
      })

      // Verified-updaters fetch also fails
      mockFetchJSON
        .mockRejectedValueOnce(new Error('no builtin'))
        .mockRejectedValueOnce(new Error('network error'))

      const updates = await service.checkForUpdates()
      expect(updates).toHaveLength(0)
    })
  })

  describe('getAvailableUpdates', () => {
    it('returns empty array when no updates checked', () => {
      expect(service.getAvailableUpdates()).toEqual([])
    })

    it('returns updates after check', async () => {
      mockGetPluginInfoList.mockReturnValue([
        { id: 'git-sync', name: 'Git Sync', description: '', defaultEnabled: false, version: '1.0.0', source: 'builtin' }
      ])
      mockFetchJSON.mockResolvedValue({
        schemaVersion: 1, buildSha: 'x', buildDate: '2026-01-01',
        plugins: { 'git-sync': { version: '2.0.0', buildSha: 'new', hash: 'abc', archivePath: 'git-sync/' } }
      })

      await service.checkForUpdates('latest')
      const updates = service.getAvailableUpdates()
      expect(updates).toHaveLength(1)
      expect(updates[0].pluginId).toBe('git-sync')
    })
  })

  describe('dismissUpdate', () => {
    it('removes update from available and persists dismissal', async () => {
      mockGetPluginInfoList.mockReturnValue([
        { id: 'git-sync', name: 'Git Sync', description: '', defaultEnabled: false, version: '1.0.0', source: 'builtin' }
      ])
      mockFetchJSON.mockResolvedValue({
        schemaVersion: 1, buildSha: 'x', buildDate: '2026-01-01',
        plugins: { 'git-sync': { version: '2.0.0', buildSha: 'new', hash: 'abc', archivePath: 'git-sync/' } }
      })

      await service.checkForUpdates('latest')
      expect(service.getAvailableUpdates()).toHaveLength(1)

      service.dismissUpdate('git-sync', '2.0.0')
      expect(mockDismissVersion).toHaveBeenCalledWith('git-sync', '2.0.0')
      expect(service.getAvailableUpdates()).toHaveLength(0)
    })
  })

  describe('installAll', () => {
    it('skips entries that require app update', async () => {
      mockGetPluginInfoList.mockReturnValue([
        { id: 'git-sync', name: 'Git Sync', description: '', defaultEnabled: false, version: '1.0.0', source: 'builtin' }
      ])
      mockFetchJSON.mockResolvedValue({
        schemaVersion: 1, buildSha: 'x', buildDate: '2026-01-01',
        plugins: { 'git-sync': { version: '2.0.0', buildSha: 'new', hash: 'abc', archivePath: 'git-sync/', requiresAppUpdate: true } }
      })

      await service.checkForUpdates('latest')
      const result = await service.installAll()
      // Should skip requiresAppUpdate entries
      expect(result.success).toHaveLength(0)
      expect(result.failed).toHaveLength(0)
    })
  })

  describe('installUpdate', () => {
    it('throws for unknown plugin', async () => {
      await expect(service.installUpdate('unknown')).rejects.toThrow('No update found')
    })
  })

  describe('version comparison', () => {
    it('detects multiple plugin updates in single check', async () => {
      mockGetPluginInfoList.mockReturnValue([
        { id: 'git-sync', name: 'Git Sync', description: '', defaultEnabled: false, version: '1.0.0', source: 'builtin' },
        { id: 'git-manager', name: 'Git Manager', description: '', defaultEnabled: false, version: '1.0.0', source: 'builtin' }
      ])
      mockFetchJSON.mockResolvedValue({
        schemaVersion: 1, buildSha: 'x', buildDate: '2026-01-01',
        plugins: {
          'git-sync': { version: '2.0.0', buildSha: 'new1', hash: 'abc', archivePath: 'git-sync/' },
          'git-manager': { version: '1.5.0', buildSha: 'new2', hash: 'def', archivePath: 'git-manager/' }
        }
      })

      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(2)
      const ids = updates.map(u => u.pluginId).sort()
      expect(ids).toEqual(['git-manager', 'git-sync'])
    })

    it('ignores older remote versions', async () => {
      mockGetPluginInfoList.mockReturnValue([
        { id: 'git-sync', name: 'Git Sync', description: '', defaultEnabled: false, version: '3.0.0', source: 'builtin' }
      ])
      mockFetchJSON.mockResolvedValue({
        schemaVersion: 1, buildSha: 'x', buildDate: '2026-01-01',
        plugins: { 'git-sync': { version: '2.0.0', buildSha: 'old', hash: 'abc', archivePath: 'git-sync/' } }
      })

      const updates = await service.checkForUpdates('latest')
      expect(updates).toHaveLength(0)
    })
  })
})
