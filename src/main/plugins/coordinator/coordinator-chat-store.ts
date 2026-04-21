/**
 * Per-project persistent chat history for the Coordinator plugin.
 *
 * One electron-store instance is shared across projects, keyed by a
 * normalized-path hash. Histories are capped to avoid unbounded growth.
 */
import Store from 'electron-store'
import * as crypto from 'crypto'
import { createSafeStore, safeRead, safeWriteSync } from '../../safe-store'
import type { CoordinatorMessage } from '../../../shared/coordinator-types'
import { log, logError } from '../../logger'

interface ChatStoreData {
  [projectKey: string]: CoordinatorMessage[]
}

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

export function getHistory(projectDir: string): CoordinatorMessage[] {
  const key = projectKey(projectDir)
  return safeRead(() => getStore().get(key)) || []
}

export function appendMessage(
  projectDir: string,
  message: CoordinatorMessage,
  maxMessages: number
): CoordinatorMessage[] {
  const key = projectKey(projectDir)
  const existing = getHistory(projectDir)
  const next = [...existing, message]
  const trimmed = next.length > maxMessages ? next.slice(next.length - maxMessages) : next
  const ok = safeWriteSync(() => getStore().set(key, trimmed))
  if (!ok) {
    logError('[coordinator-chat] failed to append message', projectDir, message.id)
  }
  return trimmed
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
  const key = projectKey(projectDir)
  const existing = getHistory(projectDir)
  const idx = existing.findIndex((m) => m.id === message.id)
  let next: CoordinatorMessage[]
  if (idx >= 0) {
    next = existing.slice()
    next[idx] = message
  } else {
    next = [...existing, message]
  }
  const trimmed = next.length > maxMessages ? next.slice(next.length - maxMessages) : next
  safeWriteSync(() => getStore().set(key, trimmed))
  return trimmed
}

export function clearHistory(projectDir: string): void {
  const key = projectKey(projectDir)
  safeWriteSync(() => getStore().delete(key))
  log('[coordinator-chat] cleared history', projectDir)
}

export function getChatStorePath(): string {
  return getStore().path
}

export function __resetChatStoreForTests(): void {
  store = null
}
