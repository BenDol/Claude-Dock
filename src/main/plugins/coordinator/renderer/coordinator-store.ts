/**
 * Renderer-side Zustand store for the Coordinator panel UI state.
 *
 * The main process owns the authoritative chat history (per-project electron-store)
 * and streams partial assistant deltas via IPC. This store mirrors the messages
 * locally for render, applies stream deltas as they arrive, and refreshes from
 * main on tool completion / turn end so the UI stays in sync with what's persisted.
 */

import { create } from 'zustand'
import type {
  CoordinatorConfig,
  CoordinatorMessage,
  CoordinatorProviderPreset,
  CoordinatorStreamEvent,
  CoordinatorTerminalSummary
} from '../../../../shared/coordinator-types'
import type {
  CoordinatorTestConnectionResult,
  CoordinatorHotkeyStatus
} from '../../../../preload/index'

const dockApi = (): Window['dockApi'] => {
  const api = window.dockApi
  if (!api) throw new Error('dockApi not available in renderer')
  return api
}

interface CoordinatorState {
  projectDir: string | null
  messages: CoordinatorMessage[]
  config: CoordinatorConfig | null
  providers: CoordinatorProviderPreset[]
  terminals: CoordinatorTerminalSummary[]
  hotkeyStatus: CoordinatorHotkeyStatus | null

  /** True while an orchestrator turn is in flight (between sendMessage and `done`). */
  turnActive: boolean
  /** ID of the assistant message currently being streamed. */
  streamingMessageId: string | null

  /** Last error surfaced from a send/clear/test call. Cleared when user types. */
  error: string | null

  /** Test-connection roundtrip state for the settings view. */
  testingConnection: boolean
  testConnectionResult: CoordinatorTestConnectionResult | null

  /** UI state */
  settingsOpen: boolean

  /** Internal: unsubscribe from the stream listener on dispose. */
  _streamUnsub: (() => void) | null
  _focusInputUnsub: (() => void) | null
  _terminalsTimer: ReturnType<typeof setInterval> | null
  _refreshCounter: number

  init: (projectDir: string) => Promise<void>
  dispose: () => void
  sendMessage: (userText: string) => Promise<void>
  cancel: () => Promise<void>
  clearHistory: () => Promise<void>
  resetSessionId: () => Promise<void>
  setConfigPatch: (patch: Partial<CoordinatorConfig>) => Promise<void>
  resetConfig: () => Promise<void>
  testConnection: () => Promise<void>
  refreshTerminals: () => Promise<void>
  refreshHistory: () => Promise<void>
  setSettingsOpen: (open: boolean) => void
  dismissError: () => void
  requestFocusInput: () => number
}

const focusInputTicks = { n: 0 }

export const useCoordinatorStore = create<CoordinatorState>((set, get) => ({
  projectDir: null,
  messages: [],
  config: null,
  providers: [],
  terminals: [],
  hotkeyStatus: null,
  turnActive: false,
  streamingMessageId: null,
  error: null,
  testingConnection: false,
  testConnectionResult: null,
  settingsOpen: false,
  _streamUnsub: null,
  _focusInputUnsub: null,
  _terminalsTimer: null,
  _refreshCounter: 0,

  init: async (projectDir) => {
    // Clean any previous session's subscriptions before binding to this project.
    get().dispose()

    const api = dockApi()
    const [config, providers, history, terminals, hotkeyStatus] = await Promise.all([
      api.coordinator.getConfig(),
      api.coordinator.listProviders(),
      api.coordinator.getHistory(projectDir),
      api.coordinator.listTerminals(projectDir),
      api.coordinator.hotkeyStatus()
    ])

    // Only auto-open settings on first use for providers that actually need a
    // key. Claude-SDK / Ollama / custom-compat start usable without one.
    const initialPreset = providers.find((p) => p.id === config.provider)
    const initialNeedsKey = initialPreset?.requiresApiKey ?? true
    set({
      projectDir,
      config,
      providers,
      messages: history,
      terminals,
      hotkeyStatus,
      turnActive: false,
      streamingMessageId: null,
      error: null,
      testConnectionResult: null,
      settingsOpen: initialNeedsKey && config.apiKey.length === 0
    })

    // Subscribe to stream deltas for this project only.
    const streamUnsub = api.coordinator.onStream((ev: CoordinatorStreamEvent) => {
      if (ev.projectDir !== get().projectDir) return
      applyStreamEvent(set, get, ev)
    })

    // Subscribe to focus-input pings (fired when Shift+Shift re-opens the panel).
    const focusInputUnsub = api.coordinator.onFocusInput((dir) => {
      if (dir !== get().projectDir) return
      focusInputTicks.n++
      set((s) => ({ _refreshCounter: s._refreshCounter + 1 }))
    })

    // Refresh the terminal summary every 2s so the terminals pill list stays current.
    const terminalsTimer = setInterval(() => {
      const dir = get().projectDir
      if (!dir) return
      api.coordinator.listTerminals(dir).then(
        (t) => set({ terminals: t }),
        () => { /* non-fatal */ }
      )
    }, 2000)

    set({
      _streamUnsub: streamUnsub,
      _focusInputUnsub: focusInputUnsub,
      _terminalsTimer: terminalsTimer
    })
  },

  dispose: () => {
    const s = get()
    s._streamUnsub?.()
    s._focusInputUnsub?.()
    if (s._terminalsTimer) clearInterval(s._terminalsTimer)
    set({
      _streamUnsub: null,
      _focusInputUnsub: null,
      _terminalsTimer: null
    })
  },

  sendMessage: async (userText) => {
    const { projectDir, turnActive, config, providers } = get()
    if (!projectDir) return
    if (turnActive) return
    if (!config) return
    if (!userText.trim()) return
    // Only gate on apiKey for providers that actually require one. Otherwise
    // every no-key backend (claude-sdk, ollama, openai-compat) falsely blocks.
    const preset = providers.find((p) => p.id === config.provider)
    const needsKey = preset?.requiresApiKey ?? true
    if (needsKey && !config.apiKey.trim()) {
      set({ error: 'Set an API key in settings before sending messages.' })
      return
    }
    set({ turnActive: true, error: null })
    try {
      // Optimistically append the user message; main persists authoritatively.
      // A UUID (not Date.now) avoids key collisions when the user fires two
      // messages in the same millisecond and the refreshHistory() dedupe
      // below would otherwise mis-reconcile them.
      const pendingId = typeof crypto !== 'undefined' && crypto.randomUUID
        ? `pending-${crypto.randomUUID()}`
        : `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const userMsg: CoordinatorMessage = {
        id: pendingId,
        role: 'user',
        content: userText,
        timestamp: Date.now()
      }
      set((s) => ({ messages: [...s.messages, userMsg] }))
      await dockApi().coordinator.sendMessage(projectDir, userText)
    } catch (err) {
      set({ turnActive: false, streamingMessageId: null, error: (err as Error).message })
    }
  },

  cancel: async () => {
    const { projectDir } = get()
    if (!projectDir) return
    try {
      await dockApi().coordinator.cancel(projectDir)
    } catch {
      /* non-fatal */
    }
    set({ turnActive: false, streamingMessageId: null })
  },

  clearHistory: async () => {
    const { projectDir } = get()
    if (!projectDir) return
    await dockApi().coordinator.clearHistory(projectDir)
    set({ messages: [], streamingMessageId: null, turnActive: false })
  },

  resetSessionId: async () => {
    const { projectDir } = get()
    if (!projectDir) return
    try {
      await dockApi().coordinator.resetSessionId(projectDir)
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  setConfigPatch: async (patch) => {
    try {
      const next = await dockApi().coordinator.setConfig(patch)
      set({ config: next })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  resetConfig: async () => {
    const next = await dockApi().coordinator.resetConfig()
    set({ config: next, testConnectionResult: null })
  },

  testConnection: async () => {
    set({ testingConnection: true, testConnectionResult: null })
    try {
      const result = await dockApi().coordinator.testProvider()
      set({ testingConnection: false, testConnectionResult: result })
    } catch (err) {
      set({
        testingConnection: false,
        testConnectionResult: { ok: false, error: (err as Error).message }
      })
    }
  },

  refreshTerminals: async () => {
    const dir = get().projectDir
    if (!dir) return
    const t = await dockApi().coordinator.listTerminals(dir)
    set({ terminals: t })
  },

  refreshHistory: async () => {
    const dir = get().projectDir
    if (!dir) return
    const history = await dockApi().coordinator.getHistory(dir)
    set({ messages: history })
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),
  dismissError: () => set({ error: null }),
  requestFocusInput: () => focusInputTicks.n
}))

/** Apply a single stream event to the local message list. */
function applyStreamEvent(
  set: (partial: Partial<CoordinatorState> | ((s: CoordinatorState) => Partial<CoordinatorState>)) => void,
  get: () => CoordinatorState,
  ev: CoordinatorStreamEvent
): void {
  const { payload, messageId } = ev
  switch (payload.type) {
    case 'text': {
      set((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === messageId)
        if (idx === -1) {
          messages.push({
            id: messageId,
            role: 'assistant',
            content: payload.delta,
            toolCalls: [],
            timestamp: Date.now(),
            streaming: true
          })
        } else {
          const m = messages[idx]
          if (m.role === 'assistant') {
            messages[idx] = { ...m, content: m.content + payload.delta, streaming: true }
          }
        }
        return { messages, streamingMessageId: messageId }
      })
      break
    }
    case 'tool_call': {
      set((s) => {
        const messages = [...s.messages]
        const idx = messages.findIndex((m) => m.id === messageId)
        if (idx === -1) {
          messages.push({
            id: messageId,
            role: 'assistant',
            content: '',
            toolCalls: [{ id: payload.id, name: payload.name, args: payload.args }],
            timestamp: Date.now(),
            streaming: true
          })
        } else {
          const m = messages[idx]
          if (m.role === 'assistant') {
            const toolCalls = [...(m.toolCalls || []), { id: payload.id, name: payload.name, args: payload.args }]
            messages[idx] = { ...m, toolCalls, streaming: true }
          }
        }
        return { messages }
      })
      break
    }
    case 'tool_result': {
      // Append the tool result as a new 'tool' message in order.
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: messageId,
            role: 'tool',
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            content: payload.content,
            isError: payload.isError,
            timestamp: Date.now()
          }
        ]
      }))
      // Refresh terminals after any dock-mutating tool completes.
      const dir = get().projectDir
      if (dir && (payload.toolName === 'spawn_terminal' || payload.toolName === 'close_terminal')) {
        dockApi().coordinator.listTerminals(dir).then(
          (t) => set({ terminals: t }),
          () => { /* non-fatal */ }
        )
      }
      break
    }
    case 'error': {
      set((s) => {
        const messages = s.messages.map((m) =>
          m.role === 'assistant' && m.id === messageId ? { ...m, streaming: false } : m
        )
        return { messages, error: payload.message }
      })
      break
    }
    case 'done': {
      set((s) => {
        const messages = s.messages.map((m) =>
          m.role === 'assistant' && m.id === messageId ? { ...m, streaming: false } : m
        )
        return {
          messages,
          turnActive: false,
          streamingMessageId: null
        }
      })
      // Pull authoritative history so optimistic user message IDs reconcile.
      void get().refreshHistory()
      break
    }
  }
}
