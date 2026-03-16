import { describe, it, expect, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

vi.mock('../git-manager-ipc', () => ({
  registerGitManagerIpc: () => {}
}))

vi.mock('../git-manager-window', () => ({
  GitManagerWindowManager: {
    getInstance: () => ({
      close: () => {},
      closeAll: () => {}
    })
  }
}))

import { GitManagerPlugin } from '../git-manager-plugin'

describe('GitManagerPlugin settings schema', () => {
  const plugin = new GitManagerPlugin()

  it('has autoFetchAll boolean setting', () => {
    const setting = plugin.settingsSchema.find((s) => s.key === 'autoFetchAll')
    expect(setting).toBeDefined()
    expect(setting!.type).toBe('boolean')
    expect(setting!.defaultValue).toBe(false)
  })

  it('has autoRecheckMinutes number setting', () => {
    const setting = plugin.settingsSchema.find((s) => s.key === 'autoRecheckMinutes')
    expect(setting).toBeDefined()
    expect(setting!.type).toBe('number')
    expect(setting!.defaultValue).toBe(15)
  })

  it('autoRecheckMinutes defaults to 15', () => {
    const setting = plugin.settingsSchema.find((s) => s.key === 'autoRecheckMinutes')
    expect(setting!.defaultValue).toBe(15)
  })

  it('still has autoGenerateCommitMsg setting', () => {
    const setting = plugin.settingsSchema.find((s) => s.key === 'autoGenerateCommitMsg')
    expect(setting).toBeDefined()
    expect(setting!.type).toBe('boolean')
    expect(setting!.defaultValue).toBe(true)
  })

  it('has correct plugin metadata', () => {
    expect(plugin.id).toBe('git-manager')
    expect(plugin.name).toBe('Git Manager')
    expect(plugin.defaultEnabled).toBe(false)
    expect(plugin.lazyLoad).toBe(true)
  })

  it('has 6 settings total', () => {
    expect(plugin.settingsSchema.length).toBe(6)
  })
})
