import { describe, it, expect, beforeEach } from 'vitest'

// We need a clean module for each test to reset the singleton
describe('CloudIntegrationServices', () => {
  let mod: typeof import('../services')

  beforeEach(async () => {
    // Re-import fresh module each time
    mod = await import('../services')
    // Reset internal state by setting null
    mod.setServices(null as any)
  })

  it('should throw when getServices called before setServices', () => {
    // After setting to null, calling getServices should throw
    expect(() => mod.getServices()).toThrow('not initialized')
  })

  it('should return services after setServices is called', () => {
    const mockServices = {
      log: () => {},
      logError: () => {},
      getSettings: () => ({ theme: { mode: 'dark' } }),
      getPluginSetting: () => 'gcp',
      getWindowState: () => undefined,
      saveWindowState: () => {},
      broadcastPluginWindowState: () => {},
      paths: { preload: '', rendererHtml: '', rendererUrl: undefined, rendererOverrideHtml: undefined }
    } as any

    mod.setServices(mockServices)
    expect(mod.getServices()).toBe(mockServices)
  })

  it('should allow overwriting services', () => {
    const services1 = { log: () => 'v1' } as any
    const services2 = { log: () => 'v2' } as any

    mod.setServices(services1)
    expect(mod.getServices()).toBe(services1)

    mod.setServices(services2)
    expect(mod.getServices()).toBe(services2)
  })
})
