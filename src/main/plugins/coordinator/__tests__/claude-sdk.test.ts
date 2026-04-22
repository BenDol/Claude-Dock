import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatDelta, ChatRequest } from '../llm/provider'

// The SDK's query() is replaced with a test double that emits a scripted
// event sequence. Each test rewires `mockEvents` before calling the provider.
let mockEvents: any[] = []
const mockQuery = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: any) => mockQuery(args)
}))

import { createClaudeSdkProvider } from '../llm/claude-sdk'

function makeDeps(overrides: Partial<Parameters<typeof createClaudeSdkProvider>[0]> = {}) {
  return {
    projectDir: 'C:/Projects/demo',
    dockDataDir: 'C:/tmp/dock-link',
    mcpScriptPath: 'C:/tmp/claude-dock-mcp.cjs',
    mcpServerKey: 'claude-dock-uat',
    maxToolSteps: 5,
    getLatestSessionId: vi.fn().mockReturnValue(null),
    setLatestSessionId: vi.fn(),
    ...overrides
  }
}

function makeRequest(text = 'Hello'): ChatRequest {
  return {
    model: 'claude-opus-4-7',
    system: 'You are the Coordinator.',
    messages: [{ role: 'user', content: text }],
    tools: []
  }
}

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

beforeEach(() => {
  mockEvents = []
  mockQuery.mockReset()
  mockQuery.mockImplementation(async function* () {
    for (const ev of mockEvents) yield ev
  })
})

describe('claude-sdk provider', () => {
  it('emits done/error when the user prompt is empty', async () => {
    const provider = createClaudeSdkProvider(makeDeps())
    const req: ChatRequest = {
      model: 'claude-opus-4-7',
      system: 'sys',
      messages: [{ role: 'assistant', content: 'hi' }],
      tools: []
    }
    const deltas = await collect(provider.chat(req, new AbortController().signal))
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ type: 'done', stopReason: 'error' })
  })

  it('maps assistant text parts to text deltas', async () => {
    mockEvents = [
      {
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'Hello, ' }] }
      },
      {
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'world!' }] }
      },
      { type: 'result', subtype: 'success', session_id: 's1' }
    ]
    const deps = makeDeps()
    const provider = createClaudeSdkProvider(deps)
    const deltas = await collect(provider.chat(makeRequest(), new AbortController().signal))
    const textDeltas = deltas.filter((d) => d.type === 'text') as Extract<ChatDelta, { type: 'text' }>[]
    expect(textDeltas.map((d) => d.delta)).toEqual(['Hello, ', 'world!'])
    expect(deltas[deltas.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })
    expect(deps.setLatestSessionId).toHaveBeenCalledWith('C:/Projects/demo', 's1')
  })

  it('maps tool_use content parts to tool_call deltas', async () => {
    mockEvents = [
      {
        type: 'assistant',
        session_id: 's1',
        message: {
          content: [
            { type: 'text', text: 'Calling list.' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__claude-dock-uat__dock_list_terminals',
              input: { project_dir: 'X' }
            }
          ]
        }
      },
      { type: 'result', subtype: 'success', session_id: 's1' }
    ]
    const provider = createClaudeSdkProvider(makeDeps())
    const deltas = await collect(provider.chat(makeRequest(), new AbortController().signal))
    const toolCall = deltas.find((d) => d.type === 'tool_call') as Extract<ChatDelta, { type: 'tool_call' }>
    expect(toolCall).toMatchObject({
      type: 'tool_call',
      id: 'tu_1',
      name: 'mcp__claude-dock-uat__dock_list_terminals',
      args: { project_dir: 'X' }
    })
  })

  it('maps non-success result subtypes to done/error with the error message', async () => {
    mockEvents = [
      {
        type: 'result',
        subtype: 'error_max_turns',
        session_id: 's1',
        errors: ['maxTurns reached']
      }
    ]
    const provider = createClaudeSdkProvider(makeDeps())
    const deltas = await collect(provider.chat(makeRequest(), new AbortController().signal))
    expect(deltas[deltas.length - 1]).toMatchObject({
      type: 'done',
      stopReason: 'error',
      errorMessage: 'maxTurns reached'
    })
  })

  it('passes the resume session id to the SDK when one is stored', async () => {
    mockEvents = [{ type: 'result', subtype: 'success', session_id: 's2' }]
    const deps = makeDeps({ getLatestSessionId: vi.fn().mockReturnValue('prev-session') })
    const provider = createClaudeSdkProvider(deps)
    await collect(provider.chat(makeRequest(), new AbortController().signal))
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const passed = mockQuery.mock.calls[0][0]
    expect(passed.options.resume).toBe('prev-session')
    // And the new session id replaces the stored one for chain-forward.
    expect(deps.setLatestSessionId).toHaveBeenCalledWith('C:/Projects/demo', 's2')
  })

  it('passes undefined resume when no session id is stored', async () => {
    mockEvents = [{ type: 'result', subtype: 'success', session_id: 's3' }]
    const provider = createClaudeSdkProvider(makeDeps())
    await collect(provider.chat(makeRequest(), new AbortController().signal))
    const passed = mockQuery.mock.calls[0][0]
    expect(passed.options.resume).toBeUndefined()
  })

  it('wires strictMcpConfig, tools:[], and allowedTools wildcard through to the SDK', async () => {
    mockEvents = [{ type: 'result', subtype: 'success', session_id: 'sx' }]
    const provider = createClaudeSdkProvider(makeDeps())
    await collect(provider.chat(makeRequest(), new AbortController().signal))
    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.strictMcpConfig).toBe(true)
    expect(opts.tools).toEqual([])
    expect(opts.allowedTools).toEqual(['mcp__claude-dock-uat__*'])
    expect(opts.mcpServers['claude-dock-uat']).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['C:/tmp/claude-dock-mcp.cjs'],
      env: { DOCK_DATA_DIR: 'C:/tmp/dock-link' }
    })
    expect(opts.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'You are the Coordinator.'
    })
    expect(opts.maxTurns).toBe(5)
    expect(opts.persistSession).toBe(true)
  })

  it('returns end_turn (not error) when the consumer aborts', async () => {
    // Simulate a never-ending stream, abort externally.
    mockQuery.mockImplementation(async function* () {
      yield { type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'partial' }] } }
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    const provider = createClaudeSdkProvider(makeDeps())
    const ctrl = new AbortController()
    const iter = provider.chat(makeRequest(), ctrl.signal)
    const deltas: ChatDelta[] = []
    for await (const ev of iter) {
      deltas.push(ev)
      if (ev.type === 'text') ctrl.abort()
    }
    expect(deltas[deltas.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })
  })

  it('surfaces unexpected thrown errors as done/error', async () => {
    mockQuery.mockImplementation(async function* () {
      throw new Error('boom')
    })
    const provider = createClaudeSdkProvider(makeDeps())
    const deltas = await collect(provider.chat(makeRequest(), new AbortController().signal))
    expect(deltas[deltas.length - 1]).toMatchObject({
      type: 'done',
      stopReason: 'error',
      errorMessage: 'boom'
    })
  })

  it('provider has passthrough: true so the orchestrator skips local dispatch', () => {
    const provider = createClaudeSdkProvider(makeDeps())
    expect(provider.passthrough).toBe(true)
    expect(provider.id).toBe('claude-sdk')
  })
})
