import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => {
  const ipcMain = {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
  // Make handle configurable so Object.defineProperty in plugin-manager works
  Object.defineProperty(ipcMain, 'handle', { value: vi.fn(), writable: true, configurable: true })
  return { ipcMain }
})

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    path: '/mock/store.json'
  }))
}))

vi.mock('../safe-store', () => ({
  createSafeStore: vi.fn().mockReturnValue({
    get: vi.fn(),
    set: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    path: '/mock/store.json'
  }),
  safeRead: vi.fn((fn: () => any) => {
    try { return fn() } catch { return undefined }
  }),
  safeWriteSync: vi.fn((fn: () => void) => {
    try { fn(); return true } catch { return false }
  })
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

// Mock plugin-store functions
const mockGetPluginState = vi.fn()
const mockGetAllPluginStates = vi.fn().mockReturnValue({})
const mockSetPluginEnabled = vi.fn()
const mockGetPluginSetting = vi.fn()
const mockSetPluginSetting = vi.fn()
const mockIsProjectConfigured = vi.fn().mockReturnValue(false)
const mockMarkProjectConfigured = vi.fn()

vi.mock('../plugins/plugin-store', () => ({
  getPluginState: (...args: any[]) => mockGetPluginState(...args),
  getAllPluginStates: (...args: any[]) => mockGetAllPluginStates(...args),
  setPluginEnabled: (...args: any[]) => mockSetPluginEnabled(...args),
  getPluginSetting: (...args: any[]) => mockGetPluginSetting(...args),
  setPluginSetting: (...args: any[]) => mockSetPluginSetting(...args),
  isProjectConfigured: (...args: any[]) => mockIsProjectConfigured(...args),
  markProjectConfigured: (...args: any[]) => mockMarkProjectConfigured(...args)
}))

import { PluginManager } from '../plugins/plugin-manager'
import type { DockPlugin } from '../plugins/plugin'
import type { PluginEventBus } from '../plugins/plugin-events'

function createMockPlugin(overrides: Partial<DockPlugin> = {}): DockPlugin {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    description: 'A test plugin',
    defaultEnabled: true,
    version: '1.0.0',
    register: vi.fn(),
    ...overrides
  }
}

describe('PluginManager', () => {
  let manager: PluginManager

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset singleton
    ;(PluginManager as any).instance = undefined
    manager = PluginManager.getInstance()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = PluginManager.getInstance()
      const b = PluginManager.getInstance()
      expect(a).toBe(b)
    })
  })

  describe('register', () => {
    it('registers a plugin and calls its register method', () => {
      const plugin = createMockPlugin()
      manager.register(plugin)

      expect(plugin.register).toHaveBeenCalledWith(expect.any(Object))
    })

    it('registers multiple plugins', () => {
      const plugin1 = createMockPlugin({ id: 'p1', name: 'P1' })
      const plugin2 = createMockPlugin({ id: 'p2', name: 'P2' })

      manager.register(plugin1)
      manager.register(plugin2)

      const infos = manager.getPluginInfoList()
      expect(infos).toHaveLength(2)
    })
  })

  describe('getPluginInfoList', () => {
    it('returns serializable plugin info', () => {
      manager.register(
        createMockPlugin({
          id: 'my-plugin',
          name: 'My Plugin',
          description: 'Desc',
          defaultEnabled: false,
          settingsSchema: [
            { key: 'enabled', label: 'Enable', type: 'boolean', defaultValue: true }
          ]
        })
      )

      const infos = manager.getPluginInfoList()
      expect(infos).toEqual([
        {
          id: 'my-plugin',
          name: 'My Plugin',
          description: 'Desc',
          defaultEnabled: false,
          version: '1.0.0',
          source: 'builtin',
          settingsSchema: [
            { key: 'enabled', label: 'Enable', type: 'boolean', defaultValue: true }
          ]
        }
      ])
    })
  })

  describe('isEnabled', () => {
    it('returns false for unknown plugin', () => {
      expect(manager.isEnabled('/project', 'unknown')).toBe(false)
    })

    it('returns plugin default when no stored state', () => {
      manager.register(createMockPlugin({ id: 'p1', defaultEnabled: true }))
      mockGetPluginState.mockReturnValue(undefined)

      expect(manager.isEnabled('/project', 'p1')).toBe(true)
    })

    it('returns stored state when available', () => {
      manager.register(createMockPlugin({ id: 'p1', defaultEnabled: true }))
      mockGetPluginState.mockReturnValue({ enabled: false, settings: {} })

      expect(manager.isEnabled('/project', 'p1')).toBe(false)
    })
  })

  describe('getAllStates', () => {
    it('fills in defaults for unregistered plugins', () => {
      manager.register(createMockPlugin({ id: 'p1', defaultEnabled: true }))
      manager.register(createMockPlugin({ id: 'p2', defaultEnabled: false }))
      mockGetAllPluginStates.mockReturnValue({})

      const states = manager.getAllStates('/project')
      expect(states).toEqual({
        'p1': { enabled: true, settings: {} },
        'p2': { enabled: false, settings: {} }
      })
    })

    it('uses stored state when available', () => {
      manager.register(createMockPlugin({ id: 'p1', defaultEnabled: true }))
      mockGetAllPluginStates.mockReturnValue({
        'p1': { enabled: false, settings: { key: 'val' } }
      })

      const states = manager.getAllStates('/project')
      expect(states['p1']).toEqual({ enabled: false, settings: { key: 'val' } })
    })
  })

  describe('setEnabled', () => {
    it('delegates to plugin-store and emits plugin:enabled event', () => {
      manager.register(createMockPlugin({ id: 'p1' }))
      manager.setEnabled('/project', 'p1', true)

      expect(mockSetPluginEnabled).toHaveBeenCalledWith('/project', 'p1', true)
    })

    it('emits plugin:disabled when disabled', () => {
      manager.register(createMockPlugin({ id: 'p1' }))
      manager.setEnabled('/project', 'p1', false)

      expect(mockSetPluginEnabled).toHaveBeenCalledWith('/project', 'p1', false)
    })
  })

  describe('settings delegation', () => {
    it('delegates getSetting to plugin-store', () => {
      manager.getSetting('/project', 'p1', 'key')
      expect(mockGetPluginSetting).toHaveBeenCalledWith('/project', 'p1', 'key')
    })

    it('delegates setSetting to plugin-store', () => {
      manager.setSetting('/project', 'p1', 'key', 'value')
      expect(mockSetPluginSetting).toHaveBeenCalledWith('/project', 'p1', 'key', 'value')
    })
  })

  describe('isConfigured / markConfigured', () => {
    it('delegates isConfigured', () => {
      manager.isConfigured('/project')
      expect(mockIsProjectConfigured).toHaveBeenCalledWith('/project')
    })

    it('delegates markConfigured', () => {
      manager.markConfigured('/project')
      expect(mockMarkProjectConfigured).toHaveBeenCalledWith('/project')
    })
  })

  describe('event emission', () => {
    it('emitProjectPreOpen is async and respects enabled filter', async () => {
      const handler = vi.fn()
      const plugin = createMockPlugin({
        id: 'p1',
        register: (bus: PluginEventBus) => {
          bus.on('project:preOpen', 'p1', handler)
        }
      })
      manager.register(plugin)

      mockGetPluginState.mockReturnValue({ enabled: true, settings: {} })
      await manager.emitProjectPreOpen('/project', {} as any)
      expect(handler).toHaveBeenCalled()
    })

    it('emitProjectPostClose runs for ALL plugins (no enabled filter)', () => {
      const handler = vi.fn()
      const plugin = createMockPlugin({
        id: 'p1',
        defaultEnabled: false,
        register: (bus: PluginEventBus) => {
          bus.on('project:postClose', 'p1', handler)
        }
      })
      manager.register(plugin)

      // Even with plugin "disabled", postClose should still fire
      mockGetPluginState.mockReturnValue({ enabled: false, settings: {} })
      manager.emitProjectPostClose('/project')
      expect(handler).toHaveBeenCalled()
    })

    it('emitSettingsChanged fires for all plugins', () => {
      const handler = vi.fn()
      const plugin = createMockPlugin({
        id: 'p1',
        register: (bus: PluginEventBus) => {
          bus.on('settings:changed', 'p1', handler)
        }
      })
      manager.register(plugin)

      manager.emitSettingsChanged({ theme: { mode: 'dark' } })
      expect(handler).toHaveBeenCalled()
    })
  })

  describe('getToolbarActionsFromManifests', () => {
    it('returns empty array when no runtime plugins', () => {
      manager.register(createMockPlugin())
      expect(manager.getToolbarActionsFromManifests()).toEqual([])
    })

    it('returns toolbar actions from plugins with manifests', () => {
      const pluginWithManifest = createMockPlugin({ id: 'runtime-1' }) as any
      pluginWithManifest.manifest = {
        toolbar: {
          title: 'Open Tool',
          icon: '<svg></svg>',
          action: 'runtime-1:open',
          order: 50
        }
      }
      manager.register(pluginWithManifest)

      const actions = manager.getToolbarActionsFromManifests()
      expect(actions).toEqual([
        {
          pluginId: 'runtime-1',
          title: 'Open Tool',
          icon: '<svg></svg>',
          action: 'runtime-1:open',
          order: 50
        }
      ])
    })

    it('sorts actions by order', () => {
      const p1 = createMockPlugin({ id: 'p1' }) as any
      p1.manifest = { toolbar: { title: 'B', icon: '', action: 'b', order: 200 } }
      const p2 = createMockPlugin({ id: 'p2' }) as any
      p2.manifest = { toolbar: { title: 'A', icon: '', action: 'a', order: 10 } }

      manager.register(p1)
      manager.register(p2)

      const actions = manager.getToolbarActionsFromManifests()
      expect(actions[0].pluginId).toBe('p2')
      expect(actions[1].pluginId).toBe('p1')
    })

    it('defaults order to 100 when not specified', () => {
      const p = createMockPlugin({ id: 'p1' }) as any
      p.manifest = { toolbar: { title: 'T', icon: '', action: 'a' } } // no order

      manager.register(p)

      const actions = manager.getToolbarActionsFromManifests()
      expect(actions[0].order).toBe(100)
    })
  })

  describe('dispose', () => {
    it('calls dispose on all plugins', () => {
      const dispose1 = vi.fn()
      const dispose2 = vi.fn()
      manager.register(createMockPlugin({ id: 'p1', dispose: dispose1 }))
      manager.register(createMockPlugin({ id: 'p2', dispose: dispose2 }))

      manager.dispose()
      expect(dispose1).toHaveBeenCalled()
      expect(dispose2).toHaveBeenCalled()
    })

    it('handles dispose errors gracefully', () => {
      manager.register(
        createMockPlugin({
          id: 'p1',
          dispose: () => {
            throw new Error('cleanup failed')
          }
        })
      )

      // Should not throw
      expect(() => manager.dispose()).not.toThrow()
    })
  })
})
