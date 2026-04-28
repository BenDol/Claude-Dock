/**
 * Per-project persistent chat history for the Coordinator plugin.
 *
 * One electron-store instance is shared across projects, keyed by a
 * normalized-path hash. Histories are capped to avoid unbounded growth.
 *
 * Persisted shape is `{ messages: CoordinatorMessage[] }`. Two legacy shapes
 * are migrated transparently on first read:
 *   - bare `CoordinatorMessage[]` (very old)
 *   - `{ messages, latestSessionId }` (held the Claude-SDK passthrough id;
 *     the SDK provider was removed, so we drop the field on first read).
 */
import Store from 'electron-store'
import * as crypto from 'crypto'
import { createSafeStore, safeRead, safeWriteSync } from '../../safe-store'
import type { CoordinatorMessage } from '../../../shared/coordinator-types'
import { log, logError } from '../../logger'

interface ProjectChatState {
  messages: CoordinatorMessage[]
}

interface ChatStoreData {
  [projectKey: string]: ProjectChatState | CoordinatorMessage[]
}

const EMPTY_STATE: ProjectChatState = { messages: [] }

let store: Store<ChatStoreData> | null = null

function getStore(): Store<ChatStoreData> {
  if (!store) {
    store = createSafeStore<ChatStoreData>({
      name: 'coordinator-chat',
      defaults: {}
    })
  }
  return store
}

function projectKey(projectDir: string): string {
  const normalized = projectDir.replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16)
}

function normaliseEntry(raw: unknown): ProjectChatState {
  if (!raw) return { messages: [] }
  // Legacy shape: a bare array of messages.
  if (Array.isArray(raw)) {
    return { messages: raw as CoordinatorMessage[] }
  }
  if (typeof raw === 'object') {
    const obj = raw as { messages?: unknown }
    if (!Array.isArray(obj.messages)) {
      logError('[coordinator-chat] discarded malformed persisted entry', {
        messagesType: typeof obj.messages
      })
      return { messages: [] }
    }
    return { messages: obj.messages as CoordinatorMessage[] }
  }
  logError('[coordinator-chat] discarded persisted entry of unexpected type', { type: typeof raw })
  return { messages: [] }
}

function readState(projectDir: string): ProjectChatState {
  const key = projectKey(projectDir)
  const raw = safeRead(() => getStore().get(key))
  return normaliseEntry(raw)
}

function writeState(projectDir: string, state: ProjectChatState): boolean {
  const key = projectKey(projectDir)
  return safeWriteSync(() => getStore().set(key, state))
}

function capMessages(messages: CoordinatorMessage[], maxMessages: number): CoordinatorMessage[] {
  return messages.length > maxMessages ? messages.slice(messages.length - maxMessages) : messages
}

export function getHistory(projectDir: string): CoordinatorMessage[] {
  return readState(projectDir).messages
}

export function appendMessage(
  projectDir: string,
  message: CoordinatorMessage,
  maxMessages: number
): CoordinatorMessage[] {
  const state = readState(projectDir)
  const next = capMessages([...state.messages, message], maxMessages)
  const ok = writeState(projectDir, { messages: next })
  if (!ok) {
    logError('[coordinator-chat] failed to append message', projectDir, message.id)
  }
  return next
}

/**
 * Replace an existing message (by id) or append it if not found. Used when a
 * streamed assistant message finalizes after being persisted mid-stream.
 */
export function upsertMessage(
  projectDir: string,
  message: CoordinatorMessage,
  maxMessages: number
): CoordinatorMessage[] {
  const state = readState(projectDir)
  const idx = state.messages.findIndex((m) => m.id === message.id)
  const next =
    idx >= 0
      ? state.messages.map((m, i) => (i === idx ? message : m))
      : [...state.messages, message]
  const trimmed = capMessages(next, maxMessages)
  const ok = writeState(projectDir, { messages: trimmed })
  if (!ok) {
    logError('[coordinator-chat] failed to upsert message', projectDir, message.id)
  }
  return trimmed
}

export function clearHistory(projectDir: string): void {
  const key = projectKey(projectDir)
  const ok = safeWriteSync(() => getStore().delete(key))
  if (!ok) {
    logError('[coordinator-chat] failed to clear history', projectDir)
    return
  }
  log('[coordinator-chat] cleared history', projectDir)
}

export function getChatStorePath(): string {
  return getStore().path
}

export function __resetChatStoreForTests(): void {
  store = null
}

// Keep the empty-state constant visible so tests can assert clean-slate shape.
export { EMPTY_STATE as __EMPTY_STATE_FOR_TESTS }
