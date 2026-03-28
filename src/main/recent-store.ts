import Store from 'electron-store'
import { app } from 'electron'
import * as path from 'path'
import { createSafeStore, safeRead, safeWriteSync } from './safe-store'
import { log, logError } from './logger'

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
  updateJumpList()
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
  updateJumpList()
}

export function hasRecentPaths(): boolean {
  return (safeRead(() => getStore().get('paths', [])) ?? []).length > 0
}

/** Update the Windows taskbar jump list with recent projects */
export function updateJumpList(): void {
  if (process.platform !== 'win32') return
  // Skip in dev mode — process.execPath is the Electron binary, not Claude Dock.exe,
  // so clicking entries would try to launch the directory as an Electron app.
  if (!app.isPackaged) return
  try {
    const entries = safeRead(() => getStore().get('paths', [])) ?? []
    // Use type 'tasks' — 'custom' categories require a registered file type handler
    // which Claude Dock doesn't have, causing Windows to silently block the category.
    const result = app.setJumpList([
      {
        type: 'tasks',
        items: entries.slice(0, 10).map((entry) => ({
          type: 'task' as const,
          title: entry.name,
          description: entry.path,
          program: process.execPath,
          args: `--launch "${entry.path}"`,
          iconPath: process.execPath,
          iconIndex: 0
        }))
      }
    ])
    if (result && result !== 'ok') {
      logError(`[jump-list] setJumpList returned: ${result}`)
    } else {
      log(`[jump-list] updated with ${Math.min(entries.length, 10)} entries`)
    }
  } catch (err) {
    logError('[jump-list] failed to update:', err)
  }
}
