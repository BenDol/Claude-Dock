import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockStore, mockStoreData } = vi.hoisted(() => {
  const mockStoreData: Record<string, any> = {}
  const mockStore = {
    get: vi.fn((key: string, defaultVal?: any) => {
      return key in mockStoreData ? mockStoreData[key] : defaultVal
    }),
    set: vi.fn((key: string, value: any) => {
      mockStoreData[key] = value
    }),
    has: vi.fn((key: string) => key in mockStoreData),
    path: '/mock/plugin-updates.json'
  }
  return { mockStore, mockStoreData }
})

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => mockStore)
}))

vi.mock('../safe-store', () => ({
  createSafeStore: vi.fn().mockReturnValue(mockStore),
  safeRead: vi.fn((fn: () => any) => {
    try { return fn() } catch { return undefined }
  }),
  safeWrite: vi.fn((fn: () => void) => {
    try { fn(); return true } catch { return false }
  }),
  safeWriteSync: vi.fn((fn: () => void) => {
    try { fn(); return true } catch { return false }
  })
}))

import {
  getLastChecked,
  setLastChecked,
  getDismissedVersions,
  dismissVersion,
  getVerifiedHosts,
  setVerifiedHosts,
  getOverrides,
  setOverride,
  removeOverride
} from '../plugins/plugin-update-store'

describe('plugin-update-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear mock store data
    for (const key of Object.keys(mockStoreData)) {
      delete mockStoreData[key]
    }
  })

  describe('lastChecked', () => {
    it('returns 0 when never checked', () => {
      expect(getLastChecked()).toBe(0)
    })

    it('persists and retrieves lastChecked', () => {
      const now = Date.now()
      setLastChecked(now)
      expect(mockStore.set).toHaveBeenCalledWith('lastChecked', now)
    })
  })

  describe('dismissedVersions', () => {
    it('returns empty object when no dismissals', () => {
      expect(getDismissedVersions()).toEqual({})
    })

    it('dismisses a version for a plugin', () => {
      dismissVersion('git-sync', '2.0.0')
      expect(mockStore.set).toHaveBeenCalledWith('dismissedVersions', { 'git-sync': '2.0.0' })
    })

    it('overwrites previous dismissal for same plugin', () => {
      mockStoreData.dismissedVersions = { 'git-sync': '1.5.0' }
      dismissVersion('git-sync', '2.0.0')
      expect(mockStore.set).toHaveBeenCalledWith('dismissedVersions', { 'git-sync': '2.0.0' })
    })

    it('preserves other plugins when dismissing', () => {
      mockStoreData.dismissedVersions = { 'git-manager': '1.0.0' }
      dismissVersion('git-sync', '2.0.0')
      expect(mockStore.set).toHaveBeenCalledWith('dismissedVersions', {
        'git-manager': '1.0.0',
        'git-sync': '2.0.0'
      })
    })
  })

  describe('verifiedHosts', () => {
    it('returns empty hosts and 0 fetchedAt when not cached', () => {
      const result = getVerifiedHosts()
      expect(result.hosts).toEqual([])
      expect(result.fetchedAt).toBe(0)
    })

    it('stores and retrieves verified hosts', () => {
      setVerifiedHosts(['github.com', 'raw.githubusercontent.com'])
      expect(mockStore.set).toHaveBeenCalledWith('verifiedHosts', ['github.com', 'raw.githubusercontent.com'])
      expect(mockStore.set).toHaveBeenCalledWith('verifiedHostsFetchedAt', expect.any(Number))
    })
  })

  describe('overrides', () => {
    it('returns empty overrides when none set', () => {
      expect(getOverrides()).toEqual({})
    })

    it('sets an override entry', () => {
      const entry = { version: '2.0.0', buildSha: 'abc123', hash: 'def456', installedAt: Date.now() }
      setOverride('git-sync', entry)
      expect(mockStore.set).toHaveBeenCalledWith('overrides', { 'git-sync': entry })
    })

    it('removes an override entry', () => {
      mockStoreData.overrides = {
        'git-sync': { version: '2.0.0', buildSha: 'a', hash: 'b', installedAt: 0 },
        'git-manager': { version: '1.5.0', buildSha: 'c', hash: 'd', installedAt: 0 }
      }
      removeOverride('git-sync')
      expect(mockStore.set).toHaveBeenCalledWith('overrides', {
        'git-manager': { version: '1.5.0', buildSha: 'c', hash: 'd', installedAt: 0 }
      })
    })

    it('preserves other overrides when setting one', () => {
      mockStoreData.overrides = {
        'git-manager': { version: '1.0.0', buildSha: 'x', hash: 'y', installedAt: 0 }
      }
      const entry = { version: '2.0.0', buildSha: 'a', hash: 'b', installedAt: Date.now() }
      setOverride('git-sync', entry)
      expect(mockStore.set).toHaveBeenCalledWith('overrides', {
        'git-manager': { version: '1.0.0', buildSha: 'x', hash: 'y', installedAt: 0 },
        'git-sync': entry
      })
    })
  })
})
