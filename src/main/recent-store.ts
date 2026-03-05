import Store from 'electron-store'
import * as path from 'path'
import { createSafeStore, safeRead, safeWriteSync } from './safe-store'

interface RecentEntry {
  path: string
  name: string
  lastOpened: number
}

interface RecentData {
  paths: RecentEntry[]
}

let store: Store<RecentData> | null = null

function getStore(): Store<RecentData> {
  if (!store) {
    store = createSafeStore<RecentData>({
      name: 'recent-paths',
      defaults: { paths: [] }
    })
  }
  return store
}

export function addRecentPath(dir: string): void {
  const s = getStore()
  const entries = safeRead(() => s.get('paths', [])) ?? []
  const normalized = dir.replace(/\\/g, '/')
  const filtered = entries.filter((e) => e.path.replace(/\\/g, '/') !== normalized)
  filtered.unshift({
    path: dir,
    name: path.basename(dir),
    lastOpened: Date.now()
  })
  // Keep last 20
  safeWriteSync(() => s.set('paths', filtered.slice(0, 20)))
}

export function getRecentPaths(): RecentEntry[] {
  return safeRead(() => getStore().get('paths', [])) ?? []
}

export function removeRecentPath(dir: string): void {
  const s = getStore()
  const entries = safeRead(() => s.get('paths', [])) ?? []
  const normalized = dir.replace(/\\/g, '/')
  safeWriteSync(() =>
    s.set(
      'paths',
      entries.filter((e) => e.path.replace(/\\/g, '/') !== normalized)
    )
  )
}

export function hasRecentPaths(): boolean {
  return (safeRead(() => getStore().get('paths', [])) ?? []).length > 0
}
