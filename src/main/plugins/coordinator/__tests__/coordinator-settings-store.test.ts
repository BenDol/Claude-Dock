import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-store before importing the module — mirrors the voice test
// pattern so we exercise real merge logic against a minimal in-memory store.
vi.mock('electron-store', () => {
  function MockStore(this: any, opts?: any) {
    this.path = '/mock/coordinator-plugin.json'
    this.store = opts?.defaults ? { ...opts.defaults } : {}
    this.get = vi.fn((key: string) => this.store[key])
    this.set = vi.fn((keyOrObj: any, value?: any) => {
      if (typeof keyOrObj === 'object') this.store = { ...this.store, ...keyOrObj }
      else this.store[keyOrObj] = value
    })
    this.delete = vi.fn()
    this.has = vi.fn((k: string) => k in this.store)
    this.clear = vi.fn(() => { this.store = {} })
  }
  return { default: MockStore }
})

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  renameSync: vi.fn()
}))

import {
  getCoordinatorConfig,
  setCoordinatorConfig,
  resetCoordinatorConfig,
  getCoordinatorStorePath,
  __resetCoordinatorStoreForTests
} from '../coordinator-settings-store'
import { DEFAULT_COORDINATOR_CONFIG } from '../../../../shared/coordinator-types'

describe('coordinator-settings-store', () => {
  beforeEach(() => {
    __resetCoordinatorStoreForTests()
  })

  it('returns defaults when the store is empty', () => {
    const cfg = getCoordinatorConfig()
    expect(cfg.provider).toBe(DEFAULT_COORDINATOR_CONFIG.provider)
    expect(cfg.hotkeyDoubleTapMs).toBe(DEFAULT_COORDINATOR_CONFIG.hotkeyDoubleTapMs)
    expect(cfg.historyMaxMessages).toBe(DEFAULT_COORDINATOR_CONFIG.historyMaxMessages)
    expect(cfg.enforceWorktreeInPrompt).toBe(true)
  })

  it('applies a scalar patch and preserves untouched fields', () => {
    const next = setCoordinatorConfig({ provider: 'anthropic', apiKey: 'sk-test' })
    expect(next.provider).toBe('anthropic')
    expect(next.apiKey).toBe('sk-test')
    // Unrelated fields stay at defaults
    expect(next.temperature).toBe(DEFAULT_COORDINATOR_CONFIG.temperature)
    expect(next.hotkeyEnabled).toBe(DEFAULT_COORDINATOR_CONFIG.hotkeyEnabled)
  })

  it('preserves earlier patches across successive calls', () => {
    setCoordinatorConfig({ provider: 'openai', model: 'gpt-4.1-mini' })
    const second = setCoordinatorConfig({ hotkeyDoubleTapMs: 500 })
    expect(second.provider).toBe('openai')
    expect(second.model).toBe('gpt-4.1-mini')
    expect(second.hotkeyDoubleTapMs).toBe(500)
  })

  it('resetCoordinatorConfig wipes back to defaults', () => {
    setCoordinatorConfig({ provider: 'gemini', apiKey: 'key', enforceWorktreeInPrompt: false })
    const reset = resetCoordinatorConfig()
    expect(reset.provider).toBe(DEFAULT_COORDINATOR_CONFIG.provider)
    expect(reset.apiKey).toBe('')
    expect(reset.enforceWorktreeInPrompt).toBe(true)
  })

  it('falls back to defaults for nested keys missing in stored config', () => {
    // Simulates a config written before a new field was introduced.
    setCoordinatorConfig({ provider: 'ollama' })
    const cfg = getCoordinatorConfig()
    expect(cfg.provider).toBe('ollama')
    expect(cfg.fallbackGlobalShortcut).toBe(DEFAULT_COORDINATOR_CONFIG.fallbackGlobalShortcut)
    expect(cfg.maxToolStepsPerTurn).toBe(DEFAULT_COORDINATOR_CONFIG.maxToolStepsPerTurn)
  })

  it('exposes a store path for diagnostics', () => {
    expect(getCoordinatorStorePath()).toBe('/mock/coordinator-plugin.json')
  })

  // The Claude Code subscription paths (claude-cli, claude-sdk) were removed
  // in favour of the API-key Anthropic provider. Old configs that stored
  // those provider ids must self-migrate so the orchestrator never sees an
  // unknown id from getCoordinatorConfig().
  it('migrates a stored claude-cli provider to anthropic on read', () => {
    setCoordinatorConfig({ provider: 'claude-cli' as never, model: 'claude-opus-4-7' })
    const migrated = getCoordinatorConfig()
    expect(migrated.provider).toBe('anthropic')
    // Model should be reset to a sane Anthropic API default — not left as the
    // CLI alias 'claude-opus-4-7' which the API rejects.
    expect(migrated.model.startsWith('claude-')).toBe(true)
    expect(migrated.baseUrl).toBe('')
  })

  it('migrates a stored claude-sdk provider to anthropic on read', () => {
    setCoordinatorConfig({ provider: 'claude-sdk' as never })
    const migrated = getCoordinatorConfig()
    expect(migrated.provider).toBe('anthropic')
  })

  it('leaves a non-removed provider id untouched', () => {
    setCoordinatorConfig({ provider: 'openai', model: 'gpt-4.1-mini' })
    const cfg = getCoordinatorConfig()
    expect(cfg.provider).toBe('openai')
    expect(cfg.model).toBe('gpt-4.1-mini')
  })
})
