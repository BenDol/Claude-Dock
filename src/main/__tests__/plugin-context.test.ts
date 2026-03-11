import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue('')
  },
  dialog: {
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn()
  }
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

vi.mock('../plugins/plugin-window-manager', () => ({
  PluginWindowManager: {
    getInstance: vi.fn().mockReturnValue({
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn()
    })
  }
}))

import { createPluginContext } from '../plugins/plugin-context'
import { PluginEventBus } from '../plugins/plugin-events'
import { ipcMain, shell } from 'electron'
import { logError } from '../logger'
import type { PluginManifest } from '../../shared/plugin-manifest'

describe('createPluginContext', () => {
  let bus: PluginEventBus
  const manifest: PluginManifest = {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test plugin',
    defaultEnabled: true,
    main: 'index.js'
  }

  beforeEach(() => {
    bus = new PluginEventBus()
    vi.clearAllMocks()
  })

  it('creates a context with all required fields', () => {
    const ctx = createPluginContext(manifest, '/plugins/test', bus)

    expect(ctx.log).toBeDefined()
    expect(ctx.logError).toBeDefined()
    expect(ctx.ipc).toBeDefined()
    expect(ctx.shell).toBeDefined()
    expect(ctx.dialog).toBeDefined()
    expect(ctx.openPluginWindow).toBeDefined()
    expect(ctx.closePluginWindow).toBeDefined()
    expect(ctx.bus).toBe(bus)
    expect(ctx.pluginDir).toBe('/plugins/test')
  })

  describe('IPC security', () => {
    const RESERVED_PREFIXES = [
      'terminal:', 'dock:', 'settings:', 'app:', 'win:',
      'updater:', 'git:', 'claude:', 'linked:', 'plugin:', 'debug:'
    ]

    it('blocks handler registration on reserved channel prefixes', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)

      for (const prefix of RESERVED_PREFIXES) {
        const channel = `${prefix}someAction`
        ctx.ipc.handle(channel, vi.fn())
        expect(ipcMain.handle).not.toHaveBeenCalledWith(channel, expect.any(Function))
      }
    })

    it('allows handler registration on non-reserved channels', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)
      const handler = vi.fn()

      ctx.ipc.handle('my-custom:action', handler)
      expect(ipcMain.handle).toHaveBeenCalledWith('my-custom:action', handler)
    })

    it('blocks removeHandler on reserved channels', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)

      ctx.ipc.removeHandler('terminal:spawn')
      expect(ipcMain.removeHandler).not.toHaveBeenCalled()
    })

    it('allows removeHandler on non-reserved channels', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)

      ctx.ipc.removeHandler('my-custom:action')
      expect(ipcMain.removeHandler).toHaveBeenCalledWith('my-custom:action')
    })
  })

  describe('shell security', () => {
    it('allows openExternal for HTTPS URLs', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)
      ctx.shell.openExternal('https://example.com')
      expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
    })

    it('allows openExternal for HTTP URLs', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)
      ctx.shell.openExternal('http://example.com')
      expect(shell.openExternal).toHaveBeenCalledWith('http://example.com')
    })

    it('blocks openExternal for file:// URLs', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)
      ctx.shell.openExternal('file:///etc/passwd')
      expect(shell.openExternal).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalled()
    })

    it('blocks openExternal for javascript: URLs', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)
      ctx.shell.openExternal('javascript:alert(1)')
      expect(shell.openExternal).not.toHaveBeenCalled()
    })

    it('blocks openExternal for arbitrary protocols', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)
      ctx.shell.openExternal('custom://payload')
      expect(shell.openExternal).not.toHaveBeenCalled()
    })

    it('allows openPath for any path', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)
      ctx.shell.openPath('/some/path')
      expect(shell.openPath).toHaveBeenCalledWith('/some/path')
    })
  })

  describe('logging', () => {
    it('prefixes log messages with plugin ID', async () => {
      const { log } = await import('../logger') as any
      const ctx = createPluginContext(manifest, '/plugins/test', bus)

      ctx.log('hello world')
      expect(log).toHaveBeenCalledWith('[test-plugin] hello world')
    })

    it('prefixes error messages with plugin ID', () => {
      const ctx = createPluginContext(manifest, '/plugins/test', bus)
      const err = new Error('test error')
      ctx.logError('something failed', err)
      expect(logError).toHaveBeenCalledWith('[test-plugin] something failed', err)
    })
  })
})
