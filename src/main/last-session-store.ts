import Store from 'electron-store'
import * as path from 'path'
import { createSafeStore, safeRead, safeWriteSync } from './safe-store'
import type { LastSessionEntry } from '../shared/last-session-types'

interface LastSessionData {
  entries: LastSessionEntry[]
}

const MAX_ENTRIES = 50

let store: Store<LastSessionData> | null = null

function getStore(): Store<LastSessionData> {
  if (!store) {
    store = createSafeStore<LastSessionData>({
      name: 'last-session',
      defaults: { entries: [] }
    })
  }
  return store
}

/** Unique key for dedup. Case-insensitive on Windows (NTFS), case-sensitive elsewhere. */
function dedupeKey(dir: string): string {
  const norm = dir.replace(/\\/g, '/')
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}

/** Persist the list of workspace directories that were open at Close All. */
export function saveLastSession(dirs: string[]): void {
  if (dirs.length === 0) return
  const seen = new Set<string>()
  const entries: LastSessionEntry[] = []
  const now = Date.now()
  for (const dir of dirs) {
    const key = dedupeKey(dir)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ path: dir, name: path.basename(dir), savedAt: now })
    if (entries.length >= MAX_ENTRIES) break
  }
  // Don't wipe a previously-saved session if dedupe produced nothing
  if (entries.length === 0) return
  safeWriteSync(() => getStore().set('entries', entries))
}

export function getLastSession(): LastSessionEntry[] {
  return safeRead(() => getStore().get('entries', [])) ?? []
}

export function clearLastSession(): void {
  safeWriteSync(() => getStore().set('entries', []))
}
