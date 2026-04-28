import { describe, it, expect, vi } from 'vitest'

vi.mock('electron-store', () => {
  function MockStore(this: any, opts?: any) {
    this.path = '/mock/coordinator-chat.json'
    this.store = opts?.defaults ? { ...opts.defaults } : {}
    this.get = vi.fn((k: string) => this.store[k])
    this.set = vi.fn()
    this.delete = vi.fn()
    this.has = vi.fn(() => false)
    this.clear = vi.fn()
  }
  return { default: MockStore }
})

vi.mock('fs', () => ({
  existsSync: () => false,
  renameSync: vi.fn()
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

import { createProvider, listProviderPresets, PROVIDER_PRESETS } from '../llm/registry'

describe('createProvider — API-key backends', () => {
  it('constructs an openai-compat provider for groq', () => {
    const provider = createProvider('groq', {
      apiKey: 'test',
      defaultModel: 'llama-3.3-70b-versatile'
    })
    expect(provider.id).toBe('groq')
  })

  it('constructs an anthropic provider', () => {
    const provider = createProvider('anthropic', {
      apiKey: 'test',
      defaultModel: 'claude-haiku-4-5-20251001'
    })
    expect(provider.id).toBe('anthropic')
  })

  it('constructs a gemini provider', () => {
    const provider = createProvider('gemini', {
      apiKey: 'test',
      defaultModel: 'gemini-2.5-flash'
    })
    expect(provider.id).toBe('gemini')
  })

  it('constructs an ollama provider without an api key', () => {
    const provider = createProvider('ollama', {
      apiKey: '',
      defaultModel: 'llama3.3'
    })
    expect(provider.id).toBe('ollama')
  })
})

describe('PROVIDER_PRESETS — subscription paths removed', () => {
  it('does not advertise the removed Claude subscription presets', () => {
    const ids = listProviderPresets().map((p) => p.id)
    expect(ids).not.toContain('claude-sdk')
    expect(ids).not.toContain('claude-cli')
  })

  it('keeps the API-key Anthropic preset as the only Anthropic option', () => {
    expect(PROVIDER_PRESETS.anthropic.requiresApiKey).toBe(true)
  })
})
