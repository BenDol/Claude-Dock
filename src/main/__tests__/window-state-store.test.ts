import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockStore, mockStoreData, mockDisplays } = vi.hoisted(() => {
  const mockStoreData: Record<string, any> = {}
  const mockStore = {
    get: vi.fn((key: string) => mockStoreData[key]),
    set: vi.fn((key: string, value: any) => { mockStoreData[key] = value }),
    path: '/mock/window-state.json'
  }
  const mockDisplays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
  ]
  return { mockStore, mockStoreData, mockDisplays }
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

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: vi.fn(() => mockDisplays)
  }
}))

import { getWindowState, saveWindowState, type WindowState } from '../window-state-store'

describe('window-state-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockStoreData)) {
      delete mockStoreData[key]
    }
    // Reset to single display
    mockDisplays.length = 0
    mockDisplays.push({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  })

  describe('saveWindowState', () => {
    it('saves window state with normalized path', () => {
      const state: WindowState = {
        x: 100, y: 100, width: 1200, height: 800, maximized: false
      }
      saveWindowState('C:\\Projects\\MyApp', state)
      expect(mockStore.set).toHaveBeenCalledWith('c:/projects/myapp', state)
    })
  })

  describe('getWindowState', () => {
    it('returns undefined when no saved state', () => {
      expect(getWindowState('/unknown')).toBeUndefined()
    })

    it('returns saved state when position is visible on screen', () => {
      const state: WindowState = {
        x: 100, y: 100, width: 800, height: 600, maximized: false
      }
      mockStoreData['c:/project'] = state
      expect(getWindowState('C:/project')).toEqual(state)
    })

    it('returns undefined when saved position is off-screen', () => {
      const state: WindowState = {
        x: 5000, y: 5000, width: 800, height: 600, maximized: false
      }
      mockStoreData['c:/project'] = state
      expect(getWindowState('C:/project')).toBeUndefined()
    })

    it('checks center point against display work area', () => {
      const state: WindowState = {
        x: 1500, y: 400, width: 800, height: 600, maximized: false
      }
      mockStoreData['c:/project'] = state
      // Center: 1500+400=1900 (within 1920), 400+300=700 (within 1080)
      expect(getWindowState('C:/project')).toEqual(state)
    })

    it('handles multiple displays', () => {
      mockDisplays.push({ workArea: { x: 1920, y: 0, width: 1920, height: 1080 } })
      const state: WindowState = {
        x: 2200, y: 200, width: 800, height: 600, maximized: false
      }
      mockStoreData['c:/project'] = state
      // Center: 2200+400=2600 (within second display 1920-3840)
      expect(getWindowState('C:/project')).toEqual(state)
    })

    it('returns undefined when center falls outside all displays', () => {
      const state: WindowState = {
        x: -2000, y: -2000, width: 100, height: 100, maximized: false
      }
      mockStoreData['c:/project'] = state
      expect(getWindowState('C:/project')).toBeUndefined()
    })
  })

  describe('path normalization', () => {
    it('normalizes backslashes and lowercases', () => {
      const state: WindowState = { x: 0, y: 0, width: 800, height: 600, maximized: false }
      mockStoreData['c:/projects/myapp'] = state
      expect(getWindowState('C:\\Projects\\MyApp')).toEqual(state)
    })
  })
})
