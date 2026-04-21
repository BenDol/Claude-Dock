/**
 * Anthropic Messages API provider (streaming + tools).
 *
 * Hand-rolled over fetch to avoid pulling in @anthropic-ai/sdk for the small
 * surface the coordinator needs. The shape follows the `messages.stream` SSE
 * protocol documented at https://docs.anthropic.com/en/api/messages-streaming.
 */

import type {
  ChatDelta,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
  TestConnectionResult
} from './provider'

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicStreamEvent {
  type: string
  index?: number
  content_block?: { type: string; id?: string; name?: string; input?: unknown }
  delta?: {
    type: string
    text?: string
    partial_json?: string
    stop_reason?: string
  }
  message?: { stop_reason?: string }
}

function toAnthropicMessages(req: ChatRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const msg of req.messages) {
    if (msg.role === 'system') continue // system is a top-level field
    if (msg.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          }
        ]
      })
      continue
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = []
      if (typeof msg.content === 'string' && msg.content) {
        blocks.push({ type: 'text', text: msg.content })
      }
      for (const tc of msg.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: typeof tc.args === 'string' ? JSON.parse(tc.args || '{}') : tc.args
        })
      }
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    out.push({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    })
  }
  return out
}

function toAnthropicTools(req: ChatRequest): Array<Record<string, unknown>> {
  return req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
}

export function createAnthropicProvider(config: ProviderConfig): LLMProvider {
  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'anthropic-version': ANTHROPIC_VERSION,
    'x-api-key': config.apiKey
  })

  async function* chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const body = {
      model: req.model || config.defaultModel,
      system: req.system,
      messages: toAnthropicMessages(req),
      tools: req.tools.length > 0 ? toAnthropicTools(req) : undefined,
      temperature: req.temperature,
      max_tokens: req.maxTokens ?? 4096,
      stream: true
    }

    let response: Response
    try {
      response = await fetch(`${ANTHROPIC_BASE}/messages`, {
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

    const pendingTools = new Map<number, { id: string; name: string; args: string }>()
    let stopReason: 'tool_use' | 'end_turn' | 'error' = 'end_turn'

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            let ev: AnthropicStreamEvent
            try { ev = JSON.parse(payload) } catch { continue }

            if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.index !== undefined) {
              pendingTools.set(ev.index, {
                id: ev.content_block.id || `call_${ev.index}`,
                name: ev.content_block.name || '',
                args: ''
              })
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              yield { type: 'text', delta: ev.delta.text }
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && ev.index !== undefined) {
              const tc = pendingTools.get(ev.index)
              if (tc) tc.args += ev.delta.partial_json || ''
            } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
              stopReason = ev.delta.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn'
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

    const indexes = Array.from(pendingTools.keys()).sort((a, b) => a - b)
    for (const idx of indexes) {
      const tc = pendingTools.get(idx)!
      let parsed: unknown = {}
      if (tc.args.trim()) { try { parsed = JSON.parse(tc.args) } catch { parsed = tc.args } }
      yield { type: 'tool_call', id: tc.id, name: tc.name, args: parsed }
    }

    yield { type: 'done', stopReason }
  }

  async function testConnection(): Promise<TestConnectionResult> {
    try {
      // Hit /v1/models — free (no token usage) and exercises auth + network.
      const start = Date.now()
      const res = await fetch(`${ANTHROPIC_BASE}/models?limit=1`, {
        method: 'GET',
        headers: {
          'anthropic-version': ANTHROPIC_VERSION,
          'x-api-key': config.apiKey
        }
      })
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

  return { id: 'anthropic', chat, testConnection }
}
