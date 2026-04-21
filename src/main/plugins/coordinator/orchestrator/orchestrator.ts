/**
 * Coordinator orchestrator — drives the tool-calling loop between the LLM
 * and the coordinator's tools. Streams partial text/tool-call/tool-result
 * events back to the renderer via COORDINATOR_STREAM IPC as they happen.
 */

import * as crypto from 'crypto'
import { IPC } from '../../../../shared/ipc-channels'
import type {
  CoordinatorConfig,
  CoordinatorMessage,
  CoordinatorStreamEvent,
  CoordinatorToolCall
} from '../../../../shared/coordinator-types'
import type { ChatDelta, Message } from '../llm/provider'
import { createProvider } from '../llm/registry'
import { buildSystemPrompt } from '../llm/system-prompt'
import { COORDINATOR_TOOLS, dispatchTool } from './tools'
import { appendMessage, getHistory, upsertMessage } from '../coordinator-chat-store'
import { getServices } from '../services'

interface RunTurnArgs {
  projectDir: string
  userText: string
  config: CoordinatorConfig
  signal: AbortSignal
}

function nowId(): string {
  return crypto.randomUUID()
}

function broadcast(event: CoordinatorStreamEvent): void {
  const targets = getServices().getAllCoordinatorWebContents(event.projectDir)
  for (const wc of targets) {
    if (!wc.isDestroyed()) wc.send(IPC.COORDINATOR_STREAM, event)
  }
}

function toProviderMessages(history: CoordinatorMessage[]): Message[] {
  const out: Message[] = []
  for (const m of history) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: m.content,
        toolCallId: m.toolCallId
      })
      continue
    }
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content,
        toolCalls: m.toolCalls?.map((tc) => ({
          type: 'tool_call',
          id: tc.id,
          name: tc.name,
          args: tc.args
        }))
      })
      continue
    }
    out.push({ role: 'user', content: m.content })
  }
  return out
}

export async function runTurn(args: RunTurnArgs): Promise<void> {
  const { projectDir, userText, config, signal } = args
  const svc = getServices()

  // Persist the user turn before calling the LLM so UI refreshes see it.
  const userMsg: CoordinatorMessage = {
    id: nowId(),
    role: 'user',
    content: userText,
    timestamp: Date.now()
  }
  appendMessage(projectDir, userMsg, config.historyMaxMessages)

  const provider = createProvider(config.provider, {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || undefined,
    defaultModel: config.model
  })

  const systemPrompt = buildSystemPrompt({
    enforceWorktreeInPrompt: config.enforceWorktreeInPrompt,
    projectDir,
    maxToolSteps: config.maxToolStepsPerTurn
  })

  let step = 0
  const maxSteps = Math.max(1, config.maxToolStepsPerTurn)

  for (; step < maxSteps; step++) {
    const turnHistory = getHistory(projectDir)
    const messages = toProviderMessages(turnHistory)

    const assistantId = nowId()
    let assistantText = ''
    const toolCalls: CoordinatorToolCall[] = []
    let stopReason: 'tool_use' | 'end_turn' | 'error' = 'end_turn'
    let errorMessage: string | undefined
    let placeholderPersisted = false

    const persistPlaceholder = (): void => {
      if (placeholderPersisted) return
      placeholderPersisted = true
      upsertMessage(
        projectDir,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          toolCalls: [],
          timestamp: Date.now(),
          streaming: true
        },
        config.historyMaxMessages
      )
    }

    try {
      for await (const delta of provider.chat(
        {
          model: config.model,
          system: systemPrompt,
          messages,
          tools: COORDINATOR_TOOLS,
          temperature: config.temperature
        },
        signal
      )) {
        if (signal.aborted) break
        const event = mapDelta(projectDir, assistantId, delta)
        if (event) broadcast(event)

        switch (delta.type) {
          case 'text':
            if (!placeholderPersisted) persistPlaceholder()
            assistantText += delta.delta
            break
          case 'tool_call':
            if (!placeholderPersisted) persistPlaceholder()
            toolCalls.push({ id: delta.id, name: delta.name, args: delta.args })
            break
          case 'done':
            stopReason = delta.stopReason
            errorMessage = delta.errorMessage
            break
        }
      }
    } catch (err) {
      stopReason = 'error'
      errorMessage = (err as Error).message
      broadcast({
        projectDir,
        messageId: assistantId,
        payload: { type: 'error', message: errorMessage }
      })
    }

    if (stopReason === 'error' && !placeholderPersisted) {
      // Pre-stream failure — don't leave an empty assistant shell in history.
      broadcast({
        projectDir,
        messageId: assistantId,
        payload: { type: 'done', stopReason: 'error' }
      })
      svc.logError('[coordinator] turn ended with error before any content', errorMessage)
      return
    }

    // Persist the finalized assistant message.
    upsertMessage(
      projectDir,
      {
        id: assistantId,
        role: 'assistant',
        content: assistantText,
        toolCalls,
        timestamp: Date.now(),
        streaming: false
      },
      config.historyMaxMessages
    )

    if (stopReason === 'error') {
      broadcast({
        projectDir,
        messageId: assistantId,
        payload: { type: 'done', stopReason: 'error' }
      })
      svc.logError('[coordinator] turn ended with error', errorMessage)
      return
    }

    if (stopReason === 'end_turn' || toolCalls.length === 0) {
      broadcast({
        projectDir,
        messageId: assistantId,
        payload: { type: 'done', stopReason: 'end_turn' }
      })
      return
    }

    // Dispatch each requested tool, persist the result, and loop.
    for (const tc of toolCalls) {
      if (signal.aborted) return
      const result = await dispatchTool(tc.name, tc.args, {
        projectDir,
        services: svc
      })
      const toolMsg: CoordinatorMessage = {
        id: nowId(),
        role: 'tool',
        toolCallId: tc.id,
        toolName: tc.name,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now()
      }
      appendMessage(projectDir, toolMsg, config.historyMaxMessages)
      broadcast({
        projectDir,
        messageId: toolMsg.id,
        payload: {
          type: 'tool_result',
          toolCallId: tc.id,
          toolName: tc.name,
          content: result.content,
          isError: result.isError
        }
      })
    }
  }

  broadcast({
    projectDir,
    messageId: nowId(),
    payload: { type: 'done', stopReason: 'max_steps' }
  })
}

function mapDelta(
  projectDir: string,
  messageId: string,
  delta: ChatDelta
): CoordinatorStreamEvent | null {
  switch (delta.type) {
    case 'text':
      return { projectDir, messageId, payload: { type: 'text', delta: delta.delta } }
    case 'tool_call':
      return {
        projectDir,
        messageId,
        payload: { type: 'tool_call', id: delta.id, name: delta.name, args: delta.args }
      }
    case 'done':
      return null // handled by caller to combine with final state
  }
}
