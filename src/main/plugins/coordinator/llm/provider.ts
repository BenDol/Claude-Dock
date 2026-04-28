/**
 * Provider-agnostic LLM interface.
 *
 * Every provider (OpenAI-compatible, Anthropic, Gemini, Ollama) maps its
 * native streaming shape into `ChatDelta`s. The orchestrator loop only ever
 * talks to this interface — swapping providers means changing one enum value.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ToolCallPart {
  type: 'tool_call'
  id: string
  name: string
  args: unknown
}

export interface ToolResultPart {
  type: 'tool_result'
  toolCallId: string
  content: string
  isError: boolean
}

export type MessagePart = TextPart | ToolCallPart | ToolResultPart

export interface Message {
  role: Role
  content: string | MessagePart[]
  /** For assistant turns: if the model emitted tool calls, capture them here. */
  toolCalls?: ToolCallPart[]
  /** For tool-result turns: which call id this result is for. */
  toolCallId?: string
}

export interface ToolSchema {
  name: string
  description: string
  /** JSON schema (draft-7) for the tool's parameters. */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  system: string
  messages: Message[]
  tools: ToolSchema[]
  temperature?: number
  maxTokens?: number
}

export type ChatDelta =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'done'; stopReason: 'tool_use' | 'end_turn' | 'error'; errorMessage?: string }

export interface TestConnectionResult {
  ok: boolean
  error?: string
  model?: string
  /** Round-trip latency in ms, if the provider reports it. */
  latencyMs?: number
}

export interface LLMProvider {
  /** Stable id — matches `CoordinatorProviderId`. */
  readonly id: string
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>
  /** Lightweight reachability + auth check. Should not stream tokens. */
  testConnection(): Promise<TestConnectionResult>
}

export interface ProviderConfig {
  apiKey: string
  /** Fully-qualified endpoint override (e.g. custom OpenAI-compat baseUrl). */
  baseUrl?: string
  /** Default model the provider will use when a request omits `model`. */
  defaultModel: string
}
