/**
 * Google Gemini provider (streaming + function calling).
 *
 * Uses the `v1beta` REST API because function calling is stable there and
 * it requires no SDK. The streaming endpoint emits newline-delimited JSON
 * objects (not SSE), so the parse loop differs from openai-compat.
 */

import type {
  ChatDelta,
  ChatRequest,
  LLMProvider,
  ProviderConfig,
  TestConnectionResult
} from './provider'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
        functionCall?: { name: string; args: Record<string, unknown> }
      }>
    }
    finishReason?: string
  }>
}

function toGeminiContents(req: ChatRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const msg of req.messages) {
    if (msg.role === 'system') continue
    if (msg.role === 'tool') {
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool',
              response: {
                toolCallId: msg.toolCallId,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
              }
            }
          }
        ]
      })
      continue
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: Array<Record<string, unknown>> = []
      if (typeof msg.content === 'string' && msg.content) parts.push({ text: msg.content })
      for (const tc of msg.toolCalls) {
        const args = typeof tc.args === 'string' ? JSON.parse(tc.args || '{}') : (tc.args || {})
        parts.push({ functionCall: { name: tc.name, args } })
      }
      out.push({ role: 'model', parts })
      continue
    }
    out.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
    })
  }
  return out
}

function toGeminiTools(req: ChatRequest): Array<Record<string, unknown>> {
  if (req.tools.length === 0) return []
  return [
    {
      functionDeclarations: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }))
    }
  ]
}

export function createGeminiProvider(config: ProviderConfig): LLMProvider {
  async function* chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const model = req.model || config.defaultModel
    // Key is passed via header so it does not land in URL history, proxy logs,
    // or request telemetry.
    const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    const body = {
      contents: toGeminiContents(req),
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      tools: toGeminiTools(req),
      generationConfig: {
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens
      }
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'x-goog-api-key': config.apiKey
        },
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
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            let chunk: GeminiStreamChunk
            try { chunk = JSON.parse(payload) } catch { continue }
            const cand = chunk.candidates?.[0]
            if (!cand) continue
            for (const part of cand.content?.parts ?? []) {
              if (part.text) yield { type: 'text', delta: part.text }
              if (part.functionCall) {
                stopReason = 'tool_use'
                yield {
                  type: 'tool_call',
                  id: `gemini_call_${toolCallIdx++}`,
                  name: part.functionCall.name,
                  args: part.functionCall.args ?? {}
                }
              }
            }
            if (cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') {
              stopReason = 'error'
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
      const res = await fetch(`${GEMINI_BASE}/models?pageSize=1`, {
        headers: { 'x-goog-api-key': config.apiKey }
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

  return { id: 'gemini', chat, testConnection }
}
