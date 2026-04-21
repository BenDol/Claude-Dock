import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatDelta, LLMProvider } from '../llm/provider'
import { DEFAULT_COORDINATOR_CONFIG } from '../../../../shared/coordinator-types'

// ---------- Module mocks ----------

const dispatchToolMock = vi.fn()
vi.mock('../orchestrator/tools', () => ({
  COORDINATOR_TOOLS: [],
  dispatchTool: (...args: any[]) => dispatchToolMock(...args)
}))

const createProviderMock = vi.fn()
vi.mock('../llm/registry', () => ({
  createProvider: (...args: any[]) => createProviderMock(...args),
  listProviderPresets: () => []
}))

// Keep the system-prompt builder deterministic + cheap.
vi.mock('../llm/system-prompt', () => ({
  buildSystemPrompt: () => 'test-system-prompt'
}))

// linked-mode uses electron's `app` — stub out the helpers the orchestrator calls.
vi.mock('../../../linked-mode', () => ({
  getDataDir: () => 'C:/tmp/dock-link',
  getMcpServerSourcePath: () => 'C:/tmp/claude-dock-mcp.cjs'
}))

vi.mock('electron-store', () => {
  function MockStore(this: any, opts?: any) {
    this.path = '/mock/coordinator-chat.json'
    this.store = opts?.defaults ? { ...opts.defaults } : {}
    this.get = vi.fn((key: string) => this.store[key])
    this.set = vi.fn((keyOrObj: any, value?: any) => {
      if (typeof keyOrObj === 'object') this.store = { ...this.store, ...keyOrObj }
      else this.store[keyOrObj] = value
    })
    this.delete = vi.fn((key: string) => { delete this.store[key] })
    this.has = vi.fn((k: string) => k in this.store)
    this.clear = vi.fn(() => { this.store = {} })
  }
  return { default: MockStore }
})

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  renameSync: vi.fn()
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

import { runTurn } from '../orchestrator/orchestrator'
import { setServices, __resetCoordinatorServicesForTests } from '../services'
import { __resetChatStoreForTests } from '../coordinator-chat-store'

async function* yieldAll(events: ChatDelta[]): AsyncIterable<ChatDelta> {
  for (const ev of events) yield ev
}

function installServices(broadcast: ReturnType<typeof vi.fn>) {
  const fakeWc = {
    isDestroyed: () => false,
    send: (_ch: string, ev: any) => broadcast(ev)
  } as unknown as Electron.WebContents
  setServices({
    log: vi.fn(),
    logError: vi.fn(),
    getWindowState: () => undefined,
    saveWindowState: vi.fn(),
    listTerminals: () => [],
    spawnTerminal: async () => 'term-1',
    closeTerminal: vi.fn(),
    writeToTerminal: () => true,
    getWebContentsForProject: () => fakeWc,
    getAllCoordinatorWebContents: () => [fakeWc],
    focusMainWindow: () => null,
    getSettings: () => ({ theme: { mode: 'dark' } }),
    getCoordinatorDataDir: () => 'C:/tmp/coordinator',
    paths: {
      preload: '',
      rendererHtml: '',
      rendererUrl: undefined,
      rendererOverrideHtml: undefined
    }
  })
}

beforeEach(() => {
  dispatchToolMock.mockReset()
  createProviderMock.mockReset()
  __resetChatStoreForTests()
  __resetCoordinatorServicesForTests()
})

describe('orchestrator passthrough behaviour', () => {
  it('does NOT invoke dispatchTool when the provider is passthrough, even if tool_calls are emitted', async () => {
    const events: ChatDelta[] = [
      { type: 'text', delta: 'I will dispatch work.' },
      {
        type: 'tool_call',
        id: 'tu_1',
        name: 'mcp__claude-dock-uat__dock_list_terminals',
        args: {}
      },
      { type: 'done', stopReason: 'end_turn' }
    ]
    const passthroughProvider: LLMProvider = {
      id: 'claude-sdk',
      passthrough: true,
      chat: () => yieldAll(events),
      testConnection: async () => ({ ok: true })
    }
    createProviderMock.mockReturnValue(passthroughProvider)

    const broadcast = vi.fn()
    installServices(broadcast)

    await runTurn({
      projectDir: 'C:/Projects/alpha',
      userText: 'plan work',
      config: { ...DEFAULT_COORDINATOR_CONFIG, provider: 'claude-sdk' },
      signal: new AbortController().signal
    })

    expect(dispatchToolMock).not.toHaveBeenCalled()
    // A done event must still be broadcast so the UI closes the turn.
    const doneBroadcasts = broadcast.mock.calls
      .map((c) => c[0]?.payload)
      .filter((p) => p?.type === 'done')
    expect(doneBroadcasts.length).toBeGreaterThan(0)
    expect(doneBroadcasts[doneBroadcasts.length - 1]).toMatchObject({
      type: 'done',
      stopReason: 'end_turn'
    })
  })

  it('DOES invoke dispatchTool for non-passthrough providers that emit tool_calls', async () => {
    const events: ChatDelta[] = [
      {
        type: 'tool_call',
        id: 'tu_1',
        name: 'list_terminals',
        args: {}
      },
      { type: 'done', stopReason: 'tool_use' }
    ]
    const llmProvider: LLMProvider = {
      id: 'anthropic',
      passthrough: false,
      chat: () => yieldAll(events),
      testConnection: async () => ({ ok: true })
    }
    createProviderMock.mockReturnValue(llmProvider)
    dispatchToolMock.mockResolvedValue({ content: '[]', isError: false })

    const broadcast = vi.fn()
    installServices(broadcast)

    // Cap the loop at 1 step so we don't recurse into a second provider.chat
    // iteration (the mocked AsyncIterable is single-use per step).
    await runTurn({
      projectDir: 'C:/Projects/alpha',
      userText: 'list',
      config: { ...DEFAULT_COORDINATOR_CONFIG, provider: 'anthropic', maxToolStepsPerTurn: 1 },
      signal: new AbortController().signal
    })

    expect(dispatchToolMock).toHaveBeenCalledTimes(1)
    expect(dispatchToolMock.mock.calls[0][0]).toBe('list_terminals')
  })
})
