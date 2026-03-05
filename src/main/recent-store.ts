import Store from 'electron-store'
import * as path from 'path'

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
    store = new Store<RecentData>({
      name: 'recent-paths',
      defaults: { paths: [] }
    })
  }
  return store
}

export function addRecentPath(dir: string): void {
  const s = getStore()
  const entries = s.get('paths', [])
  const normalized = dir.replace(/\\/g, '/')
  const filtered = entries.filter((e) => e.path.replace(/\\/g, '/') !== normalized)
  filtered.unshift({
    path: dir,
    name: path.basename(dir),
    lastOpened: Date.now()
  })
  // Keep last 20
  s.set('paths', filtered.slice(0, 20))
}

export function getRecentPaths(): RecentEntry[] {
  return getStore().get('paths', [])
}

export function removeRecentPath(dir: string): void {
  const s = getStore()
  const entries = s.get('paths', [])
  const normalized = dir.replace(/\\/g, '/')
  s.set(
    'paths',
    entries.filter((e) => e.path.replace(/\\/g, '/') !== normalized)
  )
}

export function hasRecentPaths(): boolean {
  return getStore().get('paths', []).length > 0
}
