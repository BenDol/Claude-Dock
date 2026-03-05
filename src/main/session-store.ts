import Store from 'electron-store'
import { createSafeStore, safeRead, safeWriteSync } from './safe-store'

interface SessionData {
  [normalizedPath: string]: {
    terminals: string[]
  }
}

let store: Store<SessionData> | null = null

function getStore(): Store<SessionData> {
  if (!store) {
    store = createSafeStore<SessionData>({
      name: 'sessions'
    })
  }
  return store
}

function normalizePath(dir: string): string {
  return dir.replace(/\\/g, '/').toLowerCase()
}

export function getSessions(projectDir: string): string[] {
  const key = normalizePath(projectDir)
  const entry = safeRead(() => getStore().get(key))
  return entry?.terminals ?? []
}

export function saveSessions(projectDir: string, resumeIds: string[]): void {
  const key = normalizePath(projectDir)
  safeWriteSync(() => getStore().set(key, { terminals: resumeIds }))
}

export function clearSessions(projectDir: string): void {
  const key = normalizePath(projectDir)
  safeWriteSync(() => getStore().delete(key as any))
}
