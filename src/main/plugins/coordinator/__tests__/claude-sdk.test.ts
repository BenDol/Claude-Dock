import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatDelta, ChatRequest } from '../llm/provider'

// The SDK's query() is replaced with a test double that emits a scripted
// event sequence. Each test rewires `mockEvents` before calling the provider.
let mockEvents: any[] = []
const mockQuery = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: any) => mockQuery(args)
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

// `fs` is mocked so `resolveClaudeBinaryPath` tests can script which candidate
// paths "exist". `existsSync` defaults to false; tests override per case.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: vi.fn().mockReturnValue(false) }
})

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
      // DOCK_MCP_COMPACT=1 flips the MCP server into compact-description mode
      // so all 11 tools fit under Claude Code's per-server loading budget.
      env: { DOCK_DATA_DIR: 'C:/tmp/dock-link', DOCK_MCP_COMPACT: '1' }
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

// --- resolveClaudeBinaryPath ---
// Isolated from the provider tests because this helper has a memoized
// companion (`getClaudeBinaryPath`) — calling that across tests would pollute
// the cache. The `resolveClaudeBinaryPath` export is bypasses the cache.

import { resolveClaudeBinaryPath } from '../llm/claude-sdk'
import * as fs from 'fs'
import * as path from 'path'

describe('resolveClaudeBinaryPath', () => {
  const origPlatform = process.platform
  const origArch = process.arch
  const existsSync = vi.mocked(fs.existsSync)

  beforeEach(() => {
    existsSync.mockReset()
    existsSync.mockReturnValue(false)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
    Object.defineProperty(process, 'arch', { value: origArch })
  })

  it('returns undefined when no candidate path exists', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    expect(resolveClaudeBinaryPath()).toBeUndefined()
  })

  it('returns the dev-tree node_modules path when that is the only file that exists', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    const expected = path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
    existsSync.mockImplementation((p) => p === expected)
    expect(resolveClaudeBinaryPath()).toBe(expected)
  })

  it('on linux, tries the -musl sibling before the base package', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    // Both siblings are "present" — verify the musl one wins (first hop).
    existsSync.mockImplementation((p) =>
      String(p).includes('claude-agent-sdk-linux-x64-musl')
      || String(p).includes('claude-agent-sdk-linux-x64')
    )
    const resolved = resolveClaudeBinaryPath()
    expect(resolved).toBeDefined()
    expect(resolved).toContain('claude-agent-sdk-linux-x64-musl')
  })

  it('falls back to the non-musl sibling when only the base package is present', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    Object.defineProperty(process, 'arch', { value: 'arm64' })
    existsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/')
      return s.includes('claude-agent-sdk-linux-arm64/claude')
        && !s.includes('musl')
    })
    const resolved = resolveClaudeBinaryPath()
    expect(resolved).toBeDefined()
    expect(resolved).toContain('claude-agent-sdk-linux-arm64')
    expect(resolved).not.toContain('musl')
  })

  it('appends .exe on win32 and nothing on non-win32', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    Object.defineProperty(process, 'arch', { value: 'arm64' })
    existsSync.mockReturnValue(true)
    const darwinPath = resolveClaudeBinaryPath()
    expect(darwinPath).toContain('claude-agent-sdk-darwin-arm64')
    expect(darwinPath?.endsWith('claude')).toBe(true)

    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    const winPath = resolveClaudeBinaryPath()
    expect(winPath?.endsWith('claude.exe')).toBe(true)
  })

  it('finds the nested layout when npm installs the platform pkg inside claude-agent-sdk', () => {
    // electron-builder's `install-app-deps` often produces this layout:
    //   node_modules/@anthropic-ai/claude-agent-sdk/
    //     node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    const nested = path.join(
      process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk',
      'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'
    )
    existsSync.mockImplementation((p) => p === nested)
    expect(resolveClaudeBinaryPath()).toBe(nested)
  })
})
