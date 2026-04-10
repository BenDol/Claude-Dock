import { describe, it, expect, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

vi.mock('../git-manager-ipc', () => ({
  registerGitManagerIpc: () => {},
  disposeGitManagerIpc: () => {}
}))

vi.mock('../git-manager-window', () => ({
  GitManagerWindowManager: {
    getInstance: () => ({
      close: () => {},
      closeAll: () => {}
    })
  }
}))

vi.mock('../ci/ci-ipc', () => ({
  disposeCi: () => {},
  stopCiPollingForProject: () => {}
}))

vi.mock('../issues/issue-ipc', () => ({
  registerIssueIpc: () => {},
  disposeIssueIpc: () => {},
  stopIssuePollingForProject: () => {}
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

  it('has all expected settings registered', () => {
    // v1 baseline: 6 settings + 4 Issues-tab settings = 10
    expect(plugin.settingsSchema.length).toBe(10)
  })

  it('has enableIssuesTab boolean setting defaulting false', () => {
    const setting = plugin.settingsSchema.find((s) => s.key === 'enableIssuesTab')
    expect(setting).toBeDefined()
    expect(setting!.type).toBe('boolean')
    expect(setting!.defaultValue).toBe(false)
  })

  it('has issueTypeProfilesJson string setting defaulting to empty (use shipped defaults)', () => {
    const setting = plugin.settingsSchema.find((s) => s.key === 'issueTypeProfilesJson')
    expect(setting).toBeDefined()
    expect(setting!.type).toBe('string')
    expect(setting!.defaultValue).toBe('')
  })

  it('has forceParentIssueTracker boolean setting defaulting false', () => {
    const setting = plugin.settingsSchema.find((s) => s.key === 'forceParentIssueTracker')
    expect(setting).toBeDefined()
    expect(setting!.type).toBe('boolean')
    expect(setting!.defaultValue).toBe(false)
  })
})
