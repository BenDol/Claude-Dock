import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockStore, mockStoreData } = vi.hoisted(() => {
  const mockStoreData: Record<string, any> = {}
  const mockStore = {
    get: vi.fn((key: string) => mockStoreData[key]),
    set: vi.fn((key: string, value: any) => { mockStoreData[key] = value }),
    delete: vi.fn((key: string) => { delete mockStoreData[key] }),
    has: vi.fn((key: string) => key in mockStoreData),
    path: '/mock/sessions.json'
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
  safeWriteSync: vi.fn((fn: () => void) => {
    try { fn(); return true } catch { return false }
  })
}))

import { getSessions, saveSessions, clearSessions } from '../session-store'

describe('session-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockStoreData)) {
      delete mockStoreData[key]
    }
  })

  describe('path normalization', () => {
    it('normalizes Windows backslashes to forward slashes', () => {
      saveSessions('C:\\Projects\\my-app', ['sess-1'])
      expect(mockStore.set).toHaveBeenCalledWith(
        'c:/projects/my-app',
        { terminals: ['sess-1'] }
      )
    })

    it('lowercases the path for case-insensitive matching', () => {
      saveSessions('C:/Projects/MyApp', ['sess-1'])
      expect(mockStore.set).toHaveBeenCalledWith(
        'c:/projects/myapp',
        { terminals: ['sess-1'] }
      )
    })

    it('gets sessions using normalized path', () => {
      mockStoreData['c:/projects/myapp'] = { terminals: ['sess-1', 'sess-2'] }
      const sessions = getSessions('C:\\Projects\\MyApp')
      expect(sessions).toEqual(['sess-1', 'sess-2'])
    })
  })

  describe('getSessions', () => {
    it('returns empty array when no sessions saved', () => {
      const sessions = getSessions('/unknown/project')
      expect(sessions).toEqual([])
    })

    it('returns saved session IDs', () => {
      mockStoreData['c:/project'] = { terminals: ['a', 'b', 'c'] }
      const sessions = getSessions('C:/project')
      expect(sessions).toEqual(['a', 'b', 'c'])
    })

    it('returns empty array when entry exists but has no terminals', () => {
      mockStoreData['c:/project'] = {}
      const sessions = getSessions('C:/project')
      expect(sessions).toEqual([])
    })
  })

  describe('saveSessions', () => {
    it('saves session IDs under normalized path', () => {
      saveSessions('/project/path', ['sess-1', 'sess-2'])
      expect(mockStore.set).toHaveBeenCalledWith(
        '/project/path',
        { terminals: ['sess-1', 'sess-2'] }
      )
    })

    it('overwrites previous sessions', () => {
      saveSessions('/project', ['old-sess'])
      saveSessions('/project', ['new-sess-1', 'new-sess-2'])
      const lastCall = mockStore.set.mock.calls[mockStore.set.mock.calls.length - 1]
      expect(lastCall[1]).toEqual({ terminals: ['new-sess-1', 'new-sess-2'] })
    })
  })

  describe('clearSessions', () => {
    it('deletes the entry for the project', () => {
      clearSessions('C:/Project')
      expect(mockStore.delete).toHaveBeenCalledWith('c:/project')
    })
  })
})
