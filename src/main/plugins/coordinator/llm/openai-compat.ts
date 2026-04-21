/**
 * OpenAI-compatible streaming chat provider.
 *
 * Targets the /chat/completions SSE endpoint used by OpenAI, Groq, OpenRouter,
 * DeepSeek, and anything else that implements that shape. Providers that stray
 * (e.g. Anthropic, Gemini) get their own modules.
 */

import type { CoordinatorProviderId } from '../../../../shared/coordinator-types'
import type { ChatDelta, ChatRequest, LLMProvider, ProviderConfig, TestConnectionResult } from './provider'
import { PROVIDER_PRESETS } from './registry'

interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: OpenAIToolCallDelta[]
    }
    finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
}

function resolveBaseUrl(id: CoordinatorProviderId, config: ProviderConfig): string {
  if (config.baseUrl && config.baseUrl.trim().length > 0) {
    return config.baseUrl.replace(/\/$/, '')
  }
  const preset = PROVIDER_PRESETS[id]
  if (!preset.baseUrl) {
    throw new Error(`Provider ${id} requires a baseUrl — none set`)
  }
  return preset.baseUrl
}

function toOpenAIMessages(req: ChatRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (req.system) {
    out.push({ role: 'system', content: req.system })
  }
  for (const msg of req.messages) {
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      })
      continue
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : '',
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args)
          }
        }))
      })
      continue
    }
    out.push({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    })
  }
  return out
}

function toOpenAITools(req: ChatRequest): Array<Record<string, unknown>> {
  return req.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }))
}

export function createOpenAICompatProvider(
  id: CoordinatorProviderId,
  config: ProviderConfig
): LLMProvider {
  const baseUrl = resolveBaseUrl(id, config)
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    }
    if (config.apiKey) {
      h['Authorization'] = `Bearer ${config.apiKey}`
    }
    if (id === 'openrouter') {
      h['HTTP-Referer'] = 'https://github.com/bendol/claude-dock'
      h['X-Title'] = 'Claude Dock Coordinator'
    }
    return h
  }

  async function* chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const body = {
      model: req.model || config.defaultModel,
      messages: toOpenAIMessages(req),
      tools: req.tools.length > 0 ? toOpenAITools(req) : undefined,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true
    }

    let response: Response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      yield { type: 'done', stopReason: 'error', errorMessage: `network error: ${(err as Error).message}` }
      return
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      yield { type: 'done', stopReason: 'error', errorMessage: `HTTP ${response.status}: ${text.slice(0, 500)}` }
      return
    }

    // Accumulate tool-call argument deltas until the model signals completion —
    // OpenAI streams arguments as JSON fragments.
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>()
    let stopReason: 'tool_use' | 'end_turn' | 'error' = 'end_turn'

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sepIndex: number
        while ((sepIndex = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sepIndex)
          buffer = buffer.slice(sepIndex + 2)
          const lines = raw.split('\n')
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            if (payload === '[DONE]') break
            let chunk: OpenAIStreamChunk
            try { chunk = JSON.parse(payload) } catch { continue }
            const choice = chunk.choices?.[0]
            if (!choice) continue
            const delta = choice.delta
            if (delta?.content) {
              yield { type: 'text', delta: delta.content }
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index
                const prev = pendingToolCalls.get(idx) ?? { id: '', name: '', args: '' }
                if (tc.id) prev.id = tc.id
                if (tc.function?.name) prev.name = tc.function.name
                if (tc.function?.arguments) prev.args += tc.function.arguments
                pendingToolCalls.set(idx, prev)
              }
            }
            if (choice.finish_reason === 'tool_calls') {
              stopReason = 'tool_use'
            } else if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
              stopReason = 'end_turn'
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        yield { type: 'done', stopReason: 'error', errorMessage: (err as Error).message }
        return
      }
    }

    // Emit assembled tool calls in order.
    const indexes = Array.from(pendingToolCalls.keys()).sort((a, b) => a - b)
    for (const idx of indexes) {
      const tc = pendingToolCalls.get(idx)!
      let parsedArgs: unknown = {}
      if (tc.args.trim()) {
        try { parsedArgs = JSON.parse(tc.args) } catch { parsedArgs = tc.args }
      }
      yield { type: 'tool_call', id: tc.id || `call_${idx}`, name: tc.name, args: parsedArgs }
    }

    yield { type: 'done', stopReason }
  }

  async function testConnection(): Promise<TestConnectionResult> {
    try {
      const start = Date.now()
      const res = await fetch(`${baseUrl}/models`, { headers: headers() })
      const latencyMs = Date.now() - start
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, latencyMs }
      }
      return { ok: true, model: config.defaultModel, latencyMs }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  return { id, chat, testConnection }
}
