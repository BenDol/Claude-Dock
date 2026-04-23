import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChatDelta, ChatRequest } from '../llm/provider'

// ---------- module mocks (must precede the provider import) ----------

// Logger is the same shape the provider expects. Each test re-uses it but
// we only assert on it where the test actively cares (e.g. non-JSON line warns).
vi.mock('../../../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

// Binary resolver is mocked to return a stable fake path. The real resolver
// touches the electron app object and the filesystem layout under
// node_modules — neither of which we want this suite to depend on.
const mockGetBinary = vi.fn().mockReturnValue('C:/fake/claude.exe')
vi.mock('../llm/claude-binary', () => ({
  getClaudeBinaryPath: () => mockGetBinary(),
  resolveClaudeBinaryPath: () => 'C:/fake/claude.exe',
  __resetClaudeBinaryCacheForTests: vi.fn()
}))

// child_process.spawn drives the entire provider — every test scripts the
// fake child's stdout / stderr / exit and asserts on what stdin received.
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args)
}))

// fs is mocked at the call sites the provider uses. Tests can assert on the
// MCP config file write and on cleanup unlink. mkdirSync is a no-op so the
// fake `<dockDataDir>/coordinator/` "exists".
const mockWriteFile = vi.fn()
const mockUnlink = vi.fn()
const mockMkdir = vi.fn()
const mockReaddir = vi.fn().mockReturnValue([])
const mockStat = vi.fn().mockReturnValue({ mtimeMs: Date.now() })
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    writeFileSync: (...a: any[]) => mockWriteFile(...a),
    unlinkSync: (...a: any[]) => mockUnlink(...a),
    mkdirSync: (...a: any[]) => mockMkdir(...a),
    readdirSync: (...a: any[]) => mockReaddir(...a),
    statSync: (...a: any[]) => mockStat(...a)
  }
})

import { createClaudeCliProvider, buildArgv } from '../llm/claude-cli'

// ---------- helpers ----------

function makeDeps(overrides: Partial<Parameters<typeof createClaudeCliProvider>[0]> = {}) {
  return {
    projectDir: 'C:/Projects/demo',
    dockDataDir: 'C:/tmp/dock-link',
    mcpScriptPath: 'C:/tmp/claude-dock-mcp.cjs',
    mcpServerKey: 'claude-dock-uat',
    maxToolSteps: 5,
    coordinatorSessionId: '11111111-2222-3333-4444-555555555555',
    getLatestSessionId: vi.fn().mockReturnValue(null),
    setLatestSessionId: vi.fn(),
    ...overrides
  }
}

function makeRequest(text = 'Hello', system = 'You are the Coordinator.'): ChatRequest {
  return {
    model: 'claude-opus-4-7',
    system,
    messages: [{ role: 'user', content: text }],
    tools: []
  }
}

interface FakeChild {
  stdout: PassThrough
  stderr: PassThrough
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  emitter: EventEmitter
  killed: boolean
  exitCode: number | null
  pid: number
  kill: ReturnType<typeof vi.fn>
}

/**
 * Build a fake ChildProcessWithoutNullStreams. The provider treats its child
 * as an EventEmitter with `.stdout`/`.stderr`/`.stdin` properties + `.kill`
 * + `.killed` + `.exitCode`. We re-wire `.on/.emit` through a backing
 * EventEmitter so tests can drive `error`/`exit` events directly.
 */
function makeFakeChild(): { fake: FakeChild; child: any } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = { write: vi.fn().mockReturnValue(true), end: vi.fn() }
  const emitter = new EventEmitter()
  const fake: FakeChild = {
    stdout,
    stderr,
    stdin,
    emitter,
    killed: false,
    exitCode: null,
    pid: 9999,
    kill: vi.fn()
  }
  // The provider only calls these EventEmitter methods on the child object:
  //   on('error'), on('exit')
  // and reads .stdout / .stderr / .stdin. Mirror with a simple proxy so the
  // child quacks like a real ChildProcess to the production code.
  const child = {
    get stdout() { return fake.stdout },
    get stderr() { return fake.stderr },
    get stdin() { return fake.stdin },
    get pid() { return fake.pid },
    get killed() { return fake.killed },
    get exitCode() { return fake.exitCode },
    kill: fake.kill,
    on: (ev: string, fn: any) => emitter.on(ev, fn),
    once: (ev: string, fn: any) => emitter.once(ev, fn),
    emit: (ev: string, ...args: any[]) => emitter.emit(ev, ...args)
  }
  return { fake, child }
}

async function collect(iter: AsyncIterable<ChatDelta>, max = 100): Promise<ChatDelta[]> {
  const out: ChatDelta[] = []
  for await (const ev of iter) {
    out.push(ev)
    if (out.length >= max) break
  }
  return out
}

/**
 * Simulate the kernel closing both stdio pipes and the process exiting.
 *
 * Real `child_process` always emits stdout 'end' AND stderr 'end' before (or
 * concurrently with) 'exit' — anything else means the kernel held the pipe
 * open for some reason. The provider's `tryFinalize` waits on all three
 * signals so it never reads stderrTail before stderr has fully drained, so
 * tests that simulate exit must do the same or `tryFinalize` will hang.
 */
function simulateExit(child: any, fake: FakeChild, code: number): void {
  fake.stdout.end()
  fake.stderr.end()
  fake.exitCode = code
  child.emit('exit', code)
}

beforeEach(() => {
  mockSpawn.mockReset()
  mockGetBinary.mockReset()
  mockGetBinary.mockReturnValue('C:/fake/claude.exe')
  mockWriteFile.mockReset()
  mockUnlink.mockReset()
  mockMkdir.mockReset()
})

// ---------- argv ----------

describe('buildArgv', () => {
  it('produces the canonical fresh-session argv', () => {
    const argv = buildArgv(makeDeps(), {
      prompt: 'p',
      systemPrompt: 'sys',
      model: 'claude-opus-4-7',
      resume: undefined,
      mcpConfigPath: 'C:/cfg.json'
    })
    expect(argv).toContain('-p')
    expect(argv).toContain('--output-format')
    expect(argv).toContain('stream-json')
    expect(argv).toContain('--input-format')
    expect(argv).toContain('--verbose')
    expect(argv).toEqual(expect.arrayContaining(['--mcp-config', 'C:/cfg.json']))
    expect(argv).toContain('--strict-mcp-config')
    // Two --allowedTools flags, one per MCP server half (shell + terminal).
    expect(argv).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__claude-dock-uat__*']))
    expect(argv).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__claude-dock-uat-terminals__*']))
    expect(argv).toEqual(expect.arrayContaining(['--tools', '']))
    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-7']))
    expect(argv).toEqual(expect.arrayContaining(['--max-turns', '5']))
    expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']))
    expect(argv).toEqual(expect.arrayContaining([
      '--session-id', '11111111-2222-3333-4444-555555555555'
    ]))
    expect(argv).toEqual(expect.arrayContaining(['--append-system-prompt', 'sys']))
    // Resume must NOT be present on a fresh-session argv.
    expect(argv).not.toContain('--resume')
  })

  it('uses --resume instead of --session-id when resuming', () => {
    const argv = buildArgv(makeDeps(), {
      prompt: 'p',
      systemPrompt: 'sys',
      model: 'claude-opus-4-7',
      resume: 'prev-session-id',
      mcpConfigPath: 'C:/cfg.json'
    })
    expect(argv).toEqual(expect.arrayContaining(['--resume', 'prev-session-id']))
    expect(argv).not.toContain('--session-id')
  })

  it('omits --max-turns when maxToolSteps is 0 (uncapped)', () => {
    const argv = buildArgv(makeDeps({ maxToolSteps: 0 }), {
      prompt: 'p',
      systemPrompt: 'sys',
      model: 'claude-opus-4-7',
      resume: undefined,
      mcpConfigPath: 'C:/cfg.json'
    })
    expect(argv).not.toContain('--max-turns')
  })
})

// ---------- chat() — successful flows ----------

describe('claude-cli provider chat()', () => {
  it('emits done/error when the user prompt is empty', async () => {
    const provider = createClaudeCliProvider(makeDeps())
    const req: ChatRequest = {
      model: 'claude-opus-4-7',
      system: 'sys',
      messages: [{ role: 'assistant', content: 'hi' }],
      tools: []
    }
    const deltas = await collect(provider.chat(req, new AbortController().signal))
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ type: 'done', stopReason: 'error' })
    // The provider must short-circuit before spawning anything.
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('short-circuits when the signal is already aborted (no spawn, no MCP write)', async () => {
    // If the orchestrator cancels a turn before chat() runs, we must not
    // write the MCP config file or spawn the binary — both are observable
    // side effects (file in dock data dir, brief subprocess in process list).
    const provider = createClaudeCliProvider(makeDeps())
    const ctrl = new AbortController()
    ctrl.abort()
    const deltas = await collect(provider.chat(makeRequest(), ctrl.signal))
    expect(deltas).toEqual([{ type: 'done', stopReason: 'end_turn' }])
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('emits done/error when the bundled claude binary cannot be resolved', async () => {
    mockGetBinary.mockReturnValue(undefined)
    const provider = createClaudeCliProvider(makeDeps())
    const deltas = await collect(provider.chat(makeRequest(), new AbortController().signal))
    expect(deltas[0]).toMatchObject({
      type: 'done',
      stopReason: 'error',
      errorMessage: expect.stringMatching(/bundled claude binary not found/)
    })
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('writes the MCP config file with DOCK_MCP_BOUND_SESSION_ID and DOCK_MCP_COMPACT', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    // Drive the stream so the generator completes (so finally runs unlink).
    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sx' }) + '\n')
      simulateExit(child, fake, 0)
    })
    await collect(iter)

    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const [filePath, body] = mockWriteFile.mock.calls[0]
    expect(typeof filePath).toBe('string')
    expect(filePath).toMatch(/coordinator[\\/]mcp-config-.*\.json$/)
    const parsed = JSON.parse(body)
    expect(parsed.mcpServers['claude-dock-uat']).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['C:/tmp/claude-dock-mcp.cjs'],
      env: {
        DOCK_DATA_DIR: 'C:/tmp/dock-link',
        DOCK_MCP_COMPACT: '1',
        DOCK_MCP_TOOLSET: 'shell',
        DOCK_MCP_BOUND_SESSION_ID: '11111111-2222-3333-4444-555555555555'
      }
    })
    expect(parsed.mcpServers['claude-dock-uat-terminals']).toMatchObject({
      type: 'stdio',
      command: 'node',
      args: ['C:/tmp/claude-dock-mcp.cjs'],
      env: {
        DOCK_DATA_DIR: 'C:/tmp/dock-link',
        DOCK_MCP_COMPACT: '1',
        DOCK_MCP_TOOLSET: 'terminal',
        DOCK_MCP_BOUND_SESSION_ID: '11111111-2222-3333-4444-555555555555'
      }
    })
    // unlink must run in finally — otherwise stale config files accumulate.
    expect(mockUnlink).toHaveBeenCalledWith(filePath)
  })

  it('passes the user message to stdin in stream-json shape', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest('Test prompt'), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sx' }) + '\n')
      simulateExit(child, fake, 0)
    })
    await collect(iter)

    expect(fake.stdin.write).toHaveBeenCalledTimes(1)
    const written = fake.stdin.write.mock.calls[0][0] as string
    const parsed = JSON.parse(written.trim())
    expect(parsed).toMatchObject({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'Test prompt' }] },
      parent_tool_use_id: null
    })
    // stdin.end runs in finally so the CLI exits cleanly.
    expect(fake.stdin.end).toHaveBeenCalled()
  })

  it('maps assistant text parts to text deltas (multiple chunks)', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const deps = makeDeps()
    const provider = createClaudeCliProvider(deps)
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'Hello, ' }] }
      }) + '\n')
      fake.stdout.write(JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'world!' }] }
      }) + '\n')
      fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' }) + '\n')
      simulateExit(child, fake, 0)
    })
    const deltas = await collect(iter)

    const texts = deltas.filter((d) => d.type === 'text') as Extract<ChatDelta, { type: 'text' }>[]
    expect(texts.map((t) => t.delta)).toEqual(['Hello, ', 'world!'])
    expect(deltas[deltas.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })
    expect(deps.setLatestSessionId).toHaveBeenCalledWith('C:/Projects/demo', 's1')
  })

  it('maps tool_use parts to tool_call deltas', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: {
          content: [
            { type: 'text', text: 'Calling list.' },
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__claude-dock-uat-terminals__dock_list_terminals',
              input: { project_dir: 'X' }
            }
          ]
        }
      }) + '\n')
      fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' }) + '\n')
      simulateExit(child, fake, 0)
    })
    const deltas = await collect(iter)

    const toolCall = deltas.find((d) => d.type === 'tool_call') as Extract<ChatDelta, { type: 'tool_call' }>
    expect(toolCall).toMatchObject({
      type: 'tool_call',
      id: 'tu_1',
      name: 'mcp__claude-dock-uat-terminals__dock_list_terminals',
      args: { project_dir: 'X' }
    })
  })

  it('handles a JSON event that arrives split across two stdout chunks', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      const full = JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'split-test' }] }
      })
      // Split mid-JSON to prove the line buffer reassembles correctly.
      fake.stdout.write(full.slice(0, 30))
      // Microtask gap so the parser sees the partial buffer first.
      setImmediate(() => {
        fake.stdout.write(full.slice(30) + '\n')
        fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' }) + '\n')
        fake.stdout.end()
        fake.exitCode = 0
        child.emit('exit', 0)
      })
    })
    const deltas = await collect(iter)

    const texts = deltas.filter((d) => d.type === 'text') as Extract<ChatDelta, { type: 'text' }>[]
    expect(texts.map((t) => t.delta)).toEqual(['split-test'])
  })

  it('parses a trailing event that lacks a final newline', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'no-newline' }] }
      }) + '\n')
      // Final event has NO trailing newline — must be flushed on stdout 'end'.
      fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' }))
      simulateExit(child, fake, 0)
    })
    const deltas = await collect(iter)

    expect(deltas.find((d) => d.type === 'text')).toMatchObject({ delta: 'no-newline' })
    expect(deltas[deltas.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })
  })

  it('passes --resume when a stored session id exists, omits --session-id', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const deps = makeDeps({ getLatestSessionId: vi.fn().mockReturnValue('prev-session') })
    const provider = createClaudeCliProvider(deps)
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's2' }) + '\n')
      simulateExit(child, fake, 0)
    })
    await collect(iter)

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv).toEqual(expect.arrayContaining(['--resume', 'prev-session']))
    expect(argv).not.toContain('--session-id')
    expect(deps.setLatestSessionId).toHaveBeenCalledWith('C:/Projects/demo', 's2')
  })

  it('passes --session-id with the coordinator UUID for fresh sessions', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const deps = makeDeps()
    const provider = createClaudeCliProvider(deps)
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sx' }) + '\n')
      simulateExit(child, fake, 0)
    })
    await collect(iter)

    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv).toEqual(expect.arrayContaining([
      '--session-id', '11111111-2222-3333-4444-555555555555'
    ]))
    expect(argv).not.toContain('--resume')
  })

  it('maps non-success result subtype to done/error with the joined error message', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        session_id: 's1',
        errors: ['maxTurns reached']
      }) + '\n')
      simulateExit(child, fake, 0)
    })
    const deltas = await collect(iter)

    expect(deltas[deltas.length - 1]).toMatchObject({
      type: 'done',
      stopReason: 'error',
      errorMessage: 'maxTurns reached'
    })
  })
})

// ---------- chat() — failure / abort flows ----------

describe('claude-cli provider chat() — failure paths', () => {
  it('returns end_turn (not error) when the consumer aborts, and kills the subprocess', async () => {
    const { child, fake } = makeFakeChild()
    // On win32 the provider's killTree spawns `taskkill`; on posix it calls
    // child.kill('SIGTERM') directly. Either path satisfies "subprocess was
    // killed". The taskkill spawn returns a stub here so the call doesn't
    // explode in test.
    const taskkillStub = makeFakeChild()
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === 'taskkill') return taskkillStub.child
      return child
    })
    const provider = createClaudeCliProvider(makeDeps())
    const ctrl = new AbortController()
    const iter = provider.chat(makeRequest(), ctrl.signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'partial' }] }
      }) + '\n')
      // Wait a tick so the consumer sees the text, then abort.
      setImmediate(() => {
        ctrl.abort()
      })
    })

    const deltas: ChatDelta[] = []
    for await (const ev of iter) {
      deltas.push(ev)
      if (deltas.length >= 5) break
    }
    expect(deltas[deltas.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })

    // Cross-platform assertion: either child.kill was invoked OR the win32
    // path spawned a taskkill helper for the same pid. Failing both means the
    // CLI subprocess leaked after abort, which is the exact regression we want
    // to catch.
    const killedDirectly = fake.kill.mock.calls.length > 0
    const taskkillCall = mockSpawn.mock.calls.find((c) => c[0] === 'taskkill')
    expect(killedDirectly || taskkillCall).toBeTruthy()
    if (taskkillCall) {
      expect(taskkillCall[1]).toEqual(['/pid', String(fake.pid), '/T', '/F'])
    }
  })

  it('surfaces stderr tail in the error message on non-zero exit without a result', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'before-fail' }] }
      }) + '\n')
      fake.stderr.write('Error: Authentication failed (anthropic-api-key not set)\n')
      simulateExit(child, fake, 1)
    })
    const deltas = await collect(iter)

    const last = deltas[deltas.length - 1]
    expect(last).toMatchObject({
      type: 'done',
      stopReason: 'error'
    })
    expect((last as Extract<ChatDelta, { type: 'done' }>).errorMessage)
      .toMatch(/exited with code 1/)
    expect((last as Extract<ChatDelta, { type: 'done' }>).errorMessage)
      .toMatch(/Authentication failed/)
  })

  it('surfaces a subprocess "error" event as done/error', async () => {
    const { child } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      child.emit('error', new Error('ENOENT: no such file or directory'))
    })
    const deltas = await collect(iter)
    expect(deltas[deltas.length - 1]).toMatchObject({
      type: 'done',
      stopReason: 'error',
      errorMessage: expect.stringMatching(/ENOENT/)
    })
  })

  it('treats stream-end without result on exit code 0 as end_turn (and persists last session id)', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const deps = makeDeps()
    const provider = createClaudeCliProvider(deps)
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      // CLI emitted some text but never a `result` event before clean exit.
      fake.stdout.write(JSON.stringify({
        type: 'assistant',
        session_id: 's-final',
        message: { content: [{ type: 'text', text: 'orphan' }] }
      }) + '\n')
      simulateExit(child, fake, 0)
    })
    const deltas = await collect(iter)
    expect(deltas[deltas.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })
    // We still want the resume chain to advance even if `result` was missed.
    expect(deps.setLatestSessionId).toHaveBeenCalledWith('C:/Projects/demo', 's-final')
  })

  it('drops "user" tool_result events without emitting deltas (no double-render)', async () => {
    const { child, fake } = makeFakeChild()
    mockSpawn.mockReturnValueOnce(child)
    const provider = createClaudeCliProvider(makeDeps())
    const iter = provider.chat(makeRequest(), new AbortController().signal)

    queueMicrotask(() => {
      fake.stdout.write(JSON.stringify({
        type: 'user',
        session_id: 's1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":true}' }] }
      }) + '\n')
      fake.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1' }) + '\n')
      simulateExit(child, fake, 0)
    })
    const deltas = await collect(iter)

    expect(deltas.filter((d) => d.type === 'text' || d.type === 'tool_call')).toHaveLength(0)
    expect(deltas[deltas.length - 1]).toEqual({ type: 'done', stopReason: 'end_turn' })
  })
})

// ---------- provider shape ----------

describe('claude-cli provider shape', () => {
  it('declares passthrough: true and id: claude-cli', () => {
    const provider = createClaudeCliProvider(makeDeps())
    expect(provider.id).toBe('claude-cli')
    expect(provider.passthrough).toBe(true)
  })
})
