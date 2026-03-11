import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockStore, mockStoreData } = vi.hoisted(() => {
  const mockStoreData: Record<string, any> = {}
  const mockStore = {
    get: vi.fn((key: string) => mockStoreData[key]),
    set: vi.fn((key: string, value: any) => { mockStoreData[key] = value }),
    delete: vi.fn((key: string) => { delete mockStoreData[key] }),
    has: vi.fn((key: string) => key in mockStoreData),
    path: '/mock/plugin-state.json'
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

import {
  isProjectConfigured,
  markProjectConfigured,
  getPluginState,
  getAllPluginStates,
  setPluginEnabled,
  getPluginSetting,
  setPluginSetting
} from '../plugins/plugin-store'

describe('plugin-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockStoreData)) {
      delete mockStoreData[key]
    }
  })

  describe('path normalization', () => {
    it('normalizes Windows paths', () => {
      markProjectConfigured('C:\\Projects\\MyApp')
      // markProjectConfigured calls get() to check existence first
      expect(mockStore.get).toHaveBeenCalledWith('c:/projects/myapp')
    })
  })

  describe('isProjectConfigured / markProjectConfigured', () => {
    it('returns false for unconfigured project', () => {
      expect(isProjectConfigured('/new/project')).toBe(false)
    })

    it('returns true after marking configured', () => {
      mockStoreData['c:/project'] = {}
      expect(isProjectConfigured('C:/project')).toBe(true)
    })

    it('markProjectConfigured sets an empty object if not existing', () => {
      markProjectConfigured('/project')
      expect(mockStore.set).toHaveBeenCalledWith('/project', {})
    })

    it('markProjectConfigured does not overwrite existing data', () => {
      mockStoreData['/project'] = { 'my-plugin': { enabled: true, settings: {} } }
      markProjectConfigured('/project')
      expect(mockStore.set).not.toHaveBeenCalled()
    })
  })

  describe('getPluginState', () => {
    it('returns undefined for unknown plugin', () => {
      mockStoreData['c:/project'] = {}
      expect(getPluginState('C:/project', 'unknown-plugin')).toBeUndefined()
    })

    it('returns plugin state if exists', () => {
      mockStoreData['c:/project'] = {
        'my-plugin': { enabled: true, settings: { key1: 'val1' } }
      }
      const state = getPluginState('C:/project', 'my-plugin')
      expect(state).toEqual({ enabled: true, settings: { key1: 'val1' } })
    })

    it('returns undefined for unconfigured project', () => {
      expect(getPluginState('/new', 'any')).toBeUndefined()
    })
  })

  describe('getAllPluginStates', () => {
    it('returns empty object for unconfigured project', () => {
      expect(getAllPluginStates('/new')).toEqual({})
    })

    it('returns all plugin states', () => {
      const states = {
        'plugin-a': { enabled: true, settings: {} },
        'plugin-b': { enabled: false, settings: { x: 1 } }
      }
      mockStoreData['c:/project'] = states
      expect(getAllPluginStates('C:/project')).toEqual(states)
    })
  })

  describe('setPluginEnabled', () => {
    it('creates new plugin state if not exists', () => {
      mockStoreData['c:/project'] = {}
      setPluginEnabled('C:/project', 'new-plugin', true)
      expect(mockStore.set).toHaveBeenCalledWith('c:/project', {
        'new-plugin': { enabled: true, settings: {} }
      })
    })

    it('updates existing plugin state', () => {
      mockStoreData['c:/project'] = {
        'my-plugin': { enabled: true, settings: { key: 'val' } }
      }
      setPluginEnabled('C:/project', 'my-plugin', false)
      expect(mockStore.set).toHaveBeenCalledWith('c:/project', {
        'my-plugin': { enabled: false, settings: { key: 'val' } }
      })
    })

    it('creates project entry if project not configured', () => {
      setPluginEnabled('/new', 'plugin-a', true)
      expect(mockStore.set).toHaveBeenCalledWith('/new', {
        'plugin-a': { enabled: true, settings: {} }
      })
    })
  })

  describe('getPluginSetting', () => {
    it('returns undefined for unknown setting', () => {
      mockStoreData['c:/project'] = {
        'my-plugin': { enabled: true, settings: {} }
      }
      expect(getPluginSetting('C:/project', 'my-plugin', 'unknown')).toBeUndefined()
    })

    it('returns setting value', () => {
      mockStoreData['c:/project'] = {
        'my-plugin': { enabled: true, settings: { theme: 'dark' } }
      }
      expect(getPluginSetting('C:/project', 'my-plugin', 'theme')).toBe('dark')
    })
  })

  describe('setPluginSetting', () => {
    it('sets a setting value', () => {
      mockStoreData['c:/project'] = {
        'my-plugin': { enabled: true, settings: {} }
      }
      setPluginSetting('C:/project', 'my-plugin', 'theme', 'light')
      expect(mockStore.set).toHaveBeenCalledWith('c:/project', {
        'my-plugin': { enabled: true, settings: { theme: 'light' } }
      })
    })

    it('creates plugin state if not exists', () => {
      mockStoreData['c:/project'] = {}
      setPluginSetting('C:/project', 'new-plugin', 'key', 'value')
      expect(mockStore.set).toHaveBeenCalledWith('c:/project', {
        'new-plugin': { enabled: false, settings: { key: 'value' } }
      })
    })

    it('preserves other settings when adding new ones', () => {
      mockStoreData['c:/project'] = {
        'my-plugin': { enabled: true, settings: { existing: 'value' } }
      }
      setPluginSetting('C:/project', 'my-plugin', 'new', 'data')
      expect(mockStore.set).toHaveBeenCalledWith('c:/project', {
        'my-plugin': { enabled: true, settings: { existing: 'value', new: 'data' } }
      })
    })
  })
})
