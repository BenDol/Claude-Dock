/**
 * Shared types for the Coordinator plugin.
 *
 * Lives in shared/ because both the main process (orchestrator, IPC handlers)
 * and the renderer (CoordinatorPanel) need these types.
 */

export type CoordinatorProviderId =
  | 'groq'
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'openai-compat' // generic OpenAI-compatible endpoint (custom baseUrl)

export interface CoordinatorProviderPreset {
  id: CoordinatorProviderId
  label: string
  baseUrl?: string
  defaultModel: string
  requiresApiKey: boolean
  docsUrl?: string
}

/** Global coordinator configuration (persisted in electron-store, not per-project). */
export interface CoordinatorConfig {
  provider: CoordinatorProviderId
  /** Provider-specific API key. Empty string means unset. */
  apiKey: string
  /** Optional override for the provider's base URL (for openai-compat / custom endpoints). */
  baseUrl: string
  model: string
  temperature: number
  hotkeyEnabled: boolean
  /** Max gap (ms) between two Shift presses to count as a double-tap. */
  hotkeyDoubleTapMs: number
  /** Electron globalShortcut accelerator used when uiohook fails to load. */
  fallbackGlobalShortcut: string
  /** Default docked side when the plugin is first enabled for a project. */
  defaultDockedPosition: 'left' | 'right' | 'top' | 'bottom'
  /** If true, Shift+Shift opens a floating window by default instead of the docked panel. */
  floatingWindowByDefault: boolean
  /** Max number of tool-calling steps allowed per user turn. */
  maxToolStepsPerTurn: number
  /** Max messages retained in the per-project history before the oldest is dropped. */
  historyMaxMessages: number
  /**
   * If true, the system prompt includes a rule instructing the LLM to start each
   * dispatched prompt with a `git worktree add` command. Users can opt out for
   * workflows that don't use worktrees.
   */
  enforceWorktreeInPrompt: boolean
}

export const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  provider: 'groq',
  apiKey: '',
  baseUrl: '',
  model: 'llama-3.3-70b-versatile',
  temperature: 0.2,
  hotkeyEnabled: true,
  hotkeyDoubleTapMs: 350,
  fallbackGlobalShortcut: 'Control+Shift+K',
  defaultDockedPosition: 'right',
  floatingWindowByDefault: false,
  maxToolStepsPerTurn: 10,
  historyMaxMessages: 500,
  enforceWorktreeInPrompt: true
}

/** A single message in the coordinator chat history. */
export type CoordinatorMessage =
  | {
      id: string
      role: 'user'
      content: string
      timestamp: number
    }
  | {
      id: string
      role: 'assistant'
      content: string
      /** Tool calls emitted by the model in this turn (empty if it only produced text). */
      toolCalls?: CoordinatorToolCall[]
      timestamp: number
      /** True while the message is still being streamed. */
      streaming?: boolean
    }
  | {
      id: string
      role: 'tool'
      /** ID of the tool_call this result corresponds to. */
      toolCallId: string
      toolName: string
      content: string
      isError: boolean
      timestamp: number
    }
  | {
      id: string
      role: 'system'
      content: string
      timestamp: number
    }

export interface CoordinatorToolCall {
  id: string
  name: string
  args: unknown
}

export interface CoordinatorStreamEvent {
  /** Which chat session (projectDir) this event belongs to. */
  projectDir: string
  /** ID of the assistant message being streamed. */
  messageId: string
  payload:
    | { type: 'text'; delta: string }
    | { type: 'tool_call'; id: string; name: string; args: unknown }
    | { type: 'tool_result'; toolCallId: string; toolName: string; content: string; isError: boolean }
    | { type: 'error'; message: string }
    | { type: 'done'; stopReason: 'tool_use' | 'end_turn' | 'error' | 'max_steps' }
}

/** Status of a live orchestrator turn, surfaced to the renderer. */
export interface CoordinatorTurnStatus {
  projectDir: string
  active: boolean
  step: number
  maxSteps: number
  /** Last tool call name, if any (for busy indicator). */
  lastTool?: string
}

/** Summary of a terminal for the orchestrator / renderer. */
export interface CoordinatorTerminalSummary {
  id: string
  projectDir: string
  title: string
  /** True if no output in the last 800ms (heuristic idle). */
  isIdle: boolean
  idleSeconds: number
  /** Short preview of the last ~200 chars of output (stripped of ANSI). */
  lastOutputPreview: string
  sessionId: string | null
}

export interface CoordinatorWindowMode {
  /** 'docked' = panel inside main dock window; 'floating' = separate BrowserWindow. */
  mode: 'docked' | 'floating'
}

/** Runtime status of the coordinator's global hotkey. */
export interface CoordinatorHotkeyStatus {
  /** True when the backend is registered and listening. */
  ready: boolean
  /** Which backend is active: native (uiohook), Electron fallback, or none. */
  using: 'uiohook' | 'globalShortcut' | 'none'
  /** Populated when start() failed or is degraded. */
  error?: string
}
