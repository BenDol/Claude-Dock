import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  BrowserWindow: vi.fn(),
  app: { getVersion: () => '1.0.0' }
}))

const mockLog = vi.fn()
vi.mock('../services', () => ({
  getServices: () => ({
    log: mockLog,
    logError: vi.fn(),
    getPluginSetting: vi.fn(),
    getSettings: () => ({ theme: { mode: 'dark' } }),
    getWindowState: () => undefined,
    saveWindowState: vi.fn(),
    broadcastPluginWindowState: vi.fn(),
    paths: { preload: '', rendererHtml: '', rendererUrl: undefined, rendererOverrideHtml: undefined }
  }),
  setServices: vi.fn()
}))

vi.mock('../providers', () => ({
  getProvider: vi.fn(),
  getAllProviders: () => []
}))

const mockClose = vi.fn()
const mockCloseAll = vi.fn()
vi.mock('../cloud-window', () => ({
  CloudWindowManager: {
    getInstance: () => ({
      open: vi.fn(),
      close: mockClose,
      closeAll: mockCloseAll
    })
  }
}))

import { CloudIntegrationPlugin } from '../cloud-integration-plugin'
import { PluginEventBus } from '../../plugin-events'

describe('CloudIntegrationPlugin', () => {
  let plugin: CloudIntegrationPlugin
  let bus: PluginEventBus

  beforeEach(() => {
    vi.clearAllMocks()
    mockClose.mockClear()
    mockCloseAll.mockClear()
    plugin = new CloudIntegrationPlugin()
    bus = new PluginEventBus()
  })

  it('should have correct plugin metadata', () => {
    expect(plugin.id).toBe('cloud-integration')
    expect(plugin.name).toBe('Cloud Integration')
    expect(plugin.defaultEnabled).toBe(false)
    expect(plugin.lazyLoad).toBe(true)
  })

  it('should have settings schema with provider setting', () => {
    expect(plugin.settingsSchema).toBeDefined()
    const providerSetting = plugin.settingsSchema!.find((s) => s.key === 'provider')
    expect(providerSetting).toBeDefined()
    expect(providerSetting!.type).toBe('string')
    expect(providerSetting!.defaultValue).toBe('gcp')
  })

  it('should register successfully', () => {
    plugin.register(bus)
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('plugin registered'))
  })

  it('should close window on project close', () => {
    plugin.register(bus)
    // Simulate project close event
    bus.emitPost('project:postClose', { projectDir: '/test/project' }, () => true)
    // Give it a tick
    expect(mockClose).toHaveBeenCalledWith('/test/project')
  })

  it('should close window when plugin is disabled', () => {
    plugin.register(bus)
    bus.emitPost('plugin:disabled', { projectDir: '/test/project', pluginId: 'cloud-integration' }, () => true)
    expect(mockClose).toHaveBeenCalledWith('/test/project')
  })

  it('should NOT close window when a different plugin is disabled', () => {
    plugin.register(bus)
    bus.emitPost('plugin:disabled', { projectDir: '/test/project', pluginId: 'some-other-plugin' }, () => true)
    expect(mockClose).not.toHaveBeenCalled()
  })

  it('should close all windows on dispose', () => {
    plugin.register(bus)
    plugin.dispose()
    expect(mockCloseAll).toHaveBeenCalled()
  })
})
