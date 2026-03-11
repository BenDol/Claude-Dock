import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn()
  },
  dialog: {}
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

vi.mock('../plugins/plugin-window-manager', () => ({
  PluginWindowManager: {
    getInstance: vi.fn().mockReturnValue({
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      closeAllForPlugin: vi.fn()
    })
  }
}))

vi.mock('../plugins/plugin-context', () => ({
  createPluginContext: vi.fn().mockReturnValue({
    log: vi.fn(),
    logError: vi.fn(),
    ipc: { handle: vi.fn(), removeHandler: vi.fn() },
    shell: { openExternal: vi.fn(), openPath: vi.fn() },
    dialog: {},
    openPluginWindow: vi.fn(),
    closePluginWindow: vi.fn(),
    bus: null,
    pluginDir: '/test'
  })
}))

import { RuntimePlugin } from '../plugins/runtime-plugin'
import { PluginEventBus } from '../plugins/plugin-events'
import { ipcMain } from 'electron'
import { PluginWindowManager } from '../plugins/plugin-window-manager'
import { logError } from '../logger'
import type { PluginManifest } from '../../shared/plugin-manifest'

describe('RuntimePlugin', () => {
  const baseManifest: PluginManifest = {
    id: 'test-runtime',
    name: 'Test Runtime',
    version: '1.0.0',
    description: 'Test runtime plugin',
    defaultEnabled: true,
    main: 'index.js'
  }

  let bus: PluginEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    bus = new PluginEventBus()
  })

  describe('constructor', () => {
    it('sets plugin metadata from manifest', () => {
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', null)

      expect(plugin.id).toBe('test-runtime')
      expect(plugin.name).toBe('Test Runtime')
      expect(plugin.description).toBe('Test runtime plugin')
      expect(plugin.defaultEnabled).toBe(true)
      expect(plugin.manifest).toBe(baseManifest)
      expect(plugin.pluginDir).toBe('/plugins/test')
    })

    it('accepts null module', () => {
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', null)
      // Should not throw on register
      plugin.register(bus)
    })
  })

  describe('register', () => {
    it('calls module.activate if present', () => {
      const mod = { activate: vi.fn() }
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', mod)

      plugin.register(bus)
      expect(mod.activate).toHaveBeenCalled()
    })

    it('handles activate errors gracefully', () => {
      const mod = {
        activate: vi.fn(() => {
          throw new Error('activate failed')
        })
      }
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', mod)

      // Should not throw
      expect(() => plugin.register(bus)).not.toThrow()
      expect(logError).toHaveBeenCalled()
    })

    it('auto-wires toolbar action when module has no activate', () => {
      const manifest: PluginManifest = {
        ...baseManifest,
        toolbar: {
          title: 'Open',
          icon: '<svg/>',
          action: 'test-runtime:open'
        },
        window: {
          entry: 'ui/index.html'
        }
      }
      const plugin = new RuntimePlugin(manifest, '/plugins/test', {}) // empty module, no activate

      plugin.register(bus)
      expect(ipcMain.handle).toHaveBeenCalledWith('test-runtime:open', expect.any(Function))
    })

    it('does NOT auto-wire when module has activate', () => {
      const manifest: PluginManifest = {
        ...baseManifest,
        toolbar: {
          title: 'Open',
          icon: '<svg/>',
          action: 'test-runtime:open'
        },
        window: {
          entry: 'ui/index.html'
        }
      }
      const mod = { activate: vi.fn() }
      const plugin = new RuntimePlugin(manifest, '/plugins/test', mod)

      plugin.register(bus)
      // ipcMain.handle should NOT be called for auto-wire
      expect(ipcMain.handle).not.toHaveBeenCalledWith('test-runtime:open', expect.any(Function))
    })

    it('subscribes to project:postClose to close windows', () => {
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', null)
      plugin.register(bus)

      // Emit postClose
      bus.emitPost('project:postClose', { projectDir: '/project' }, () => true)

      expect(PluginWindowManager.getInstance().close).toHaveBeenCalledWith(
        'test-runtime',
        '/project'
      )
    })
  })

  describe('dispose', () => {
    it('calls module.deactivate if present', () => {
      const mod = { activate: vi.fn(), deactivate: vi.fn() }
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', mod)
      plugin.register(bus)

      plugin.dispose()
      expect(mod.deactivate).toHaveBeenCalled()
    })

    it('handles deactivate errors gracefully', () => {
      const mod = {
        activate: vi.fn(),
        deactivate: vi.fn(() => {
          throw new Error('cleanup failed')
        })
      }
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', mod)
      plugin.register(bus)

      expect(() => plugin.dispose()).not.toThrow()
      expect(logError).toHaveBeenCalled()
    })

    it('closes all plugin windows', () => {
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', null)
      plugin.register(bus)

      plugin.dispose()
      expect(PluginWindowManager.getInstance().closeAllForPlugin).toHaveBeenCalledWith(
        'test-runtime'
      )
    })

    it('does nothing when no module', () => {
      const plugin = new RuntimePlugin(baseManifest, '/plugins/test', null)
      plugin.register(bus)

      // Should not throw
      expect(() => plugin.dispose()).not.toThrow()
    })
  })
})
