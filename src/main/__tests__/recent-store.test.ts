import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockStore, state } = vi.hoisted(() => {
  const state = { paths: [] as any[] }
  const mockStore = {
    get: vi.fn((_key: string, _defaultVal?: any) => [...state.paths]),
    set: vi.fn((_key: string, value: any) => { state.paths = [...value] }),
    path: '/mock/recent-paths.json'
  }
  return { mockStore, state }
})

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => mockStore)
}))

vi.mock('../safe-store', () => ({
  createSafeStore: vi.fn().mockReturnValue(mockStore),
  safeRead: vi.fn((fn: () => any) => {
    try { return fn() } catch { return undefined }
  }),
  safeWriteSync: vi.fn((fn: () => void) => {
    try { fn(); return true } catch { return false }
  })
}))

import { addRecentPath, getRecentPaths, removeRecentPath, hasRecentPaths } from '../recent-store'

describe('recent-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.paths = []
  })

  describe('addRecentPath', () => {
    it('adds a new path to the front', () => {
      addRecentPath('/project/one')
      expect(mockStore.set).toHaveBeenCalledWith(
        'paths',
        expect.arrayContaining([
          expect.objectContaining({ path: '/project/one', name: 'one' })
        ])
      )
    })

    it('deduplicates paths (moves to front)', () => {
      state.paths = [
        { path: '/project/one', name: 'one', lastOpened: 100 },
        { path: '/project/two', name: 'two', lastOpened: 200 }
      ]
      addRecentPath('/project/one')
      const setCalls = mockStore.set.mock.calls
      const lastCall = setCalls[setCalls.length - 1][1]
      expect(lastCall[0].path).toBe('/project/one')
      expect(lastCall[0].lastOpened).toBeGreaterThan(100)
      expect(lastCall.length).toBe(2)
    })

    it('normalizes backslashes for dedup comparison', () => {
      state.paths = [
        { path: 'C:\\Projects\\app', name: 'app', lastOpened: 100 }
      ]
      addRecentPath('C:/Projects/app')
      const setCalls = mockStore.set.mock.calls
      const lastCall = setCalls[setCalls.length - 1][1]
      expect(lastCall.length).toBe(1)
    })

    it('keeps at most 20 recent paths', () => {
      state.paths = Array.from({ length: 20 }, (_, i) => ({
        path: `/project/p${i}`,
        name: `p${i}`,
        lastOpened: i
      }))
      addRecentPath('/project/new')
      const setCalls = mockStore.set.mock.calls
      const lastCall = setCalls[setCalls.length - 1][1]
      expect(lastCall.length).toBeLessThanOrEqual(20)
      expect(lastCall[0].path).toBe('/project/new')
    })

    it('extracts basename as name', () => {
      addRecentPath('/home/user/my-project')
      const setCalls = mockStore.set.mock.calls
      const entry = setCalls[setCalls.length - 1][1][0]
      expect(entry.name).toBe('my-project')
    })

    it('sets lastOpened to current timestamp', () => {
      const before = Date.now()
      addRecentPath('/project/test')
      const after = Date.now()
      const setCalls = mockStore.set.mock.calls
      const entry = setCalls[setCalls.length - 1][1][0]
      expect(entry.lastOpened).toBeGreaterThanOrEqual(before)
      expect(entry.lastOpened).toBeLessThanOrEqual(after)
    })
  })

  describe('getRecentPaths', () => {
    it('returns empty array when no paths stored', () => {
      const result = getRecentPaths()
      expect(result).toEqual([])
    })

    it('returns stored paths', () => {
      state.paths = [
        { path: '/a', name: 'a', lastOpened: 1 },
        { path: '/b', name: 'b', lastOpened: 2 }
      ]
      const result = getRecentPaths()
      expect(result).toHaveLength(2)
    })
  })

  describe('removeRecentPath', () => {
    it('removes a matching path', () => {
      state.paths = [
        { path: '/a', name: 'a', lastOpened: 1 },
        { path: '/b', name: 'b', lastOpened: 2 }
      ]
      removeRecentPath('/a')
      const setCalls = mockStore.set.mock.calls
      const lastCall = setCalls[setCalls.length - 1][1]
      expect(lastCall).toHaveLength(1)
      expect(lastCall[0].path).toBe('/b')
    })

    it('normalizes slashes for removal', () => {
      state.paths = [
        { path: 'C:\\Projects\\app', name: 'app', lastOpened: 1 }
      ]
      removeRecentPath('C:/Projects/app')
      const setCalls = mockStore.set.mock.calls
      const lastCall = setCalls[setCalls.length - 1][1]
      expect(lastCall).toHaveLength(0)
    })

    it('does nothing if path not found', () => {
      state.paths = [{ path: '/a', name: 'a', lastOpened: 1 }]
      removeRecentPath('/nonexistent')
      const setCalls = mockStore.set.mock.calls
      const lastCall = setCalls[setCalls.length - 1][1]
      expect(lastCall).toHaveLength(1)
    })
  })

  describe('hasRecentPaths', () => {
    it('returns false when no paths stored', () => {
      expect(hasRecentPaths()).toBe(false)
    })

    it('returns true when paths exist', () => {
      state.paths = [{ path: '/a', name: 'a', lastOpened: 1 }]
      expect(hasRecentPaths()).toBe(true)
    })
  })
})
