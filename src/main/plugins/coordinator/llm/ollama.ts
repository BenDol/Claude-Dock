/**
 * Ollama provider (streaming + tool calls).
 *
 * Targets the /api/chat endpoint in streaming mode. Ollama returns one JSON
 * object per line (NDJSON), not SSE. Tool-call support landed in Ollama 0.3+
 * and is only honored by models that advertise the capability.
 */

import type {
  ChatDelta,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
  TestConnectionResult
} from './provider'

interface OllamaChunk {
  message?: {
    content?: string
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> }
    }>
  }
  done?: boolean
  done_reason?: string
}

function toOllamaMessages(req: ChatRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (req.system) out.push({ role: 'system', content: req.system })
  for (const msg of req.messages) {
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      })
      continue
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : '',
        tool_calls: msg.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? JSON.parse(tc.args || '{}') : (tc.args || {})
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

export function createOllamaProvider(config: ProviderConfig): LLMProvider {
  const baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '')

  async function* chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const body = {
      model: req.model || config.defaultModel,
      messages: toOllamaMessages(req),
      stream: true,
      tools: req.tools.length > 0
        ? req.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }
          }))
        : undefined,
      options: {
        temperature: req.temperature
      }
    }

    let response: Response
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

    let stopReason: 'tool_use' | 'end_turn' | 'error' = 'end_turn'
    let toolCallIdx = 0

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          let chunk: OllamaChunk
          try { chunk = JSON.parse(line) } catch { continue }
          if (chunk.message?.content) {
            yield { type: 'text', delta: chunk.message.content }
          }
          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              stopReason = 'tool_use'
              yield {
                type: 'tool_call',
                id: `ollama_call_${toolCallIdx++}`,
                name: tc.function.name,
                args: tc.function.arguments ?? {}
              }
            }
          }
          if (chunk.done) {
            if (chunk.done_reason && chunk.done_reason !== 'stop') {
              // Unknown reason — don't flip to error unless it clearly failed.
              if (chunk.done_reason === 'error') stopReason = 'error'
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

    yield { type: 'done', stopReason }
  }

  async function testConnection(): Promise<TestConnectionResult> {
    try {
      const start = Date.now()
      const res = await fetch(`${baseUrl}/api/tags`)
      const latencyMs = Date.now() - start
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}`, latencyMs }
      }
      return { ok: true, model: config.defaultModel, latencyMs }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  return { id: 'ollama', chat, testConnection }
}
