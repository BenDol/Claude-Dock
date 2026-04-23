import { describe, it, expect, vi } from 'vitest'

// The registry imports the SDK factory (which pulls in the Claude Agent SDK)
// and the chat store (which pulls in electron-store). Stub both so the unit
// under test — the `createProvider` switch — can be instantiated in isolation.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))

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

import { createProvider } from '../llm/registry'

describe('createProvider — claude-sdk backend', () => {
  it('throws when ProviderDeps is omitted', () => {
    // Without deps the SDK provider can't know projectDir / MCP script path —
    // the orchestrator must always supply them. A silent default here would
    // ship a half-configured coordinator to production.
    expect(() =>
      createProvider('claude-sdk', { apiKey: '', defaultModel: 'claude-opus-4-7' })
    ).toThrowError(/claude-sdk provider requires ProviderDeps/)
  })

  it('constructs a provider when ProviderDeps is supplied', () => {
    const provider = createProvider(
      'claude-sdk',
      { apiKey: '', defaultModel: 'claude-opus-4-7' },
      {
        projectDir: 'C:/Projects/demo',
        dockDataDir: 'C:/tmp/dock-link',
        mcpScriptPath: 'C:/tmp/claude-dock-mcp.cjs',
        maxToolSteps: 5,
        coordinatorSessionId: 'coord-session-test'
      }
    )
    expect(provider.id).toBe('claude-sdk')
    expect(provider.passthrough).toBe(true)
  })
})

describe('createProvider — non-SDK backends', () => {
  it('constructs an openai-compat provider without deps', () => {
    const provider = createProvider('groq', {
      apiKey: 'test',
      defaultModel: 'llama-3.3-70b-versatile'
    })
    expect(provider.id).toBe('groq')
  })

  it('constructs an anthropic provider without deps', () => {
    const provider = createProvider('anthropic', {
      apiKey: 'test',
      defaultModel: 'claude-haiku-4-5-20251001'
    })
    expect(provider.id).toBe('anthropic')
  })
})
