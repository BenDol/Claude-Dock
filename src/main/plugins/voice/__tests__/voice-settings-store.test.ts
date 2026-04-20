import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-store before importing the module
vi.mock('electron-store', () => {
  function MockStore(this: any, opts?: any) {
    this.path = '/mock/voice-plugin.json'
    this.store = opts?.defaults ?? {}
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
  getVoiceConfig,
  setVoiceConfig,
  resetVoiceConfig,
  getVoiceStorePath,
  __resetVoiceStoreForTests
} from '../voice-settings-store'
import { DEFAULT_VOICE_CONFIG } from '../../../../shared/voice-types'

describe('voice-settings-store', () => {
  beforeEach(() => {
    __resetVoiceStoreForTests()
  })

  it('returns defaults when store is empty', () => {
    const cfg = getVoiceConfig()
    expect(cfg.hotkey.binding).toBe(DEFAULT_VOICE_CONFIG.hotkey.binding)
    expect(cfg.transcriber.backend).toBe(DEFAULT_VOICE_CONFIG.transcriber.backend)
    expect(cfg.recording.sample_rate).toBe(DEFAULT_VOICE_CONFIG.recording.sample_rate)
    expect(cfg.setupComplete).toBe(false)
  })

  it('applies a partial scalar patch preserving other fields', () => {
    const result = setVoiceConfig({ hotkey: { binding: 'ctrl+shift+v' } })
    expect(result.hotkey.binding).toBe('ctrl+shift+v')
    // Other hotkey fields remain at defaults
    expect(result.hotkey.mode).toBe(DEFAULT_VOICE_CONFIG.hotkey.mode)
    expect(result.hotkey.auto_paste).toBe(DEFAULT_VOICE_CONFIG.hotkey.auto_paste)
    // Other top-level sections remain at defaults
    expect(result.recording.sample_rate).toBe(DEFAULT_VOICE_CONFIG.recording.sample_rate)
  })

  it('replaces arrays wholesale rather than merging', () => {
    const result = setVoiceConfig({
      hotkey: { auto_send_keywords: ['ship it'] }
    })
    expect(result.hotkey.auto_send_keywords).toEqual(['ship it'])
  })

  it('deep-merges nested transcriber config', () => {
    const result = setVoiceConfig({
      transcriber: {
        faster_whisper: { model_size: 'large-v3', beam_size: 5 }
      }
    })
    expect(result.transcriber.faster_whisper.model_size).toBe('large-v3')
    expect(result.transcriber.faster_whisper.beam_size).toBe(5)
    // Untouched nested fields persist
    expect(result.transcriber.faster_whisper.device).toBe(DEFAULT_VOICE_CONFIG.transcriber.faster_whisper.device)
    expect(result.transcriber.backend).toBe(DEFAULT_VOICE_CONFIG.transcriber.backend)
  })

  it('preserves earlier patches across successive calls', () => {
    setVoiceConfig({ hotkey: { binding: 'alt+space' } })
    const second = setVoiceConfig({ recording: { max_seconds: 600 } })
    expect(second.hotkey.binding).toBe('alt+space')
    expect(second.recording.max_seconds).toBe(600)
  })

  it('resetVoiceConfig wipes back to defaults', () => {
    setVoiceConfig({ hotkey: { binding: 'f1' }, setupComplete: true })
    const reset = resetVoiceConfig()
    expect(reset.hotkey.binding).toBe(DEFAULT_VOICE_CONFIG.hotkey.binding)
    expect(reset.setupComplete).toBe(false)
  })

  it('exposes a store path for diagnostics', () => {
    expect(getVoiceStorePath()).toBe('/mock/voice-plugin.json')
  })

  it('migrates missing nested keys by falling back to defaults on read', () => {
    // Simulate an old config that predates a newly added nested field by writing only part.
    // After __resetVoiceStoreForTests, next read creates a fresh mock store whose initial
    // `store` starts as the defaults — so instead we patch with a subset then verify
    // a read still exposes all defaults for untouched keys.
    setVoiceConfig({ transcriber: { backend: 'openai_api' } })
    const cfg = getVoiceConfig()
    expect(cfg.transcriber.backend).toBe('openai_api')
    expect(cfg.transcriber.faster_whisper.model_size).toBe(DEFAULT_VOICE_CONFIG.transcriber.faster_whisper.model_size)
  })
})
