/**
 * File watcher for the workspace plugin.
 * Watches a project directory and sends batched change notifications.
 * Managed per-project — start/stop via IPC.
 */
import * as fs from 'fs'
import { BrowserWindow } from 'electron'
import { getServices } from './services'

const DEBOUNCE_MS = 400
const IGNORE_PATTERNS = new Set(['.git', 'node_modules', '.cache', '__pycache__', 'target', 'dist', 'build', '.gradle', '.idea', '.vscode', 'out', 'coverage'])

/** Active watchers by normalized project dir */
const watchers = new Map<string, {
  watcher: fs.FSWatcher
  timer: ReturnType<typeof setTimeout> | null
  pending: Set<string>
  subscribers: Set<number> // webContents IDs
}>()

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').toLowerCase()
}

/** Start watching a project directory. Multiple subscribers (windows) can share one watcher. */
export function startWatching(projectDir: string, webContentsId: number): void {
  const key = normalizeDir(projectDir)
  const existing = watchers.get(key)
  if (existing) {
    existing.subscribers.add(webContentsId)
    return
  }

  try {
    const watcher = fs.watch(projectDir, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const parts = filename.replace(/\\/g, '/').split('/')
      if (parts.some((p) => IGNORE_PATTERNS.has(p))) return

      const entry = watchers.get(key)
      if (!entry) return
      entry.pending.add(filename.replace(/\\/g, '/'))

      // Debounce: batch changes
      if (!entry.timer) {
        entry.timer = setTimeout(() => {
          entry.timer = null
          const changes = [...entry.pending]
          entry.pending.clear()
          if (changes.length === 0) return
          // Broadcast to all subscriber windows
          for (const wcId of entry.subscribers) {
            try {
              const wc = BrowserWindow.getAllWindows()
                .map((w) => w.webContents)
                .find((wc) => wc.id === wcId)
              if (wc && !wc.isDestroyed()) {
                wc.send('workspace:changed', changes)
              }
            } catch { /* ignore */ }
          }
        }, DEBOUNCE_MS)
      }
    })

    watcher.on('error', (err) => {
      getServices().logError('[workspace] watcher error:', err)
      stopWatching(projectDir, webContentsId)
    })

    watchers.set(key, {
      watcher,
      timer: null,
      pending: new Set(),
      subscribers: new Set([webContentsId])
    })

    getServices().log(`[workspace] started watching ${projectDir}`)
  } catch (err) {
    getServices().logError('[workspace] failed to start watcher:', err)
  }
}

/** Stop watching for a specific subscriber. Closes watcher if no subscribers remain. */
export function stopWatching(projectDir: string, webContentsId: number): void {
  const key = normalizeDir(projectDir)
  const entry = watchers.get(key)
  if (!entry) return

  entry.subscribers.delete(webContentsId)
  if (entry.subscribers.size === 0) {
    entry.watcher.close()
    if (entry.timer) clearTimeout(entry.timer)
    watchers.delete(key)
    getServices().log(`[workspace] stopped watching ${projectDir}`)
  }
}

/** Stop all watchers (plugin dispose) */
export function stopAllWatchers(): void {
  for (const [, entry] of watchers) {
    entry.watcher.close()
    if (entry.timer) clearTimeout(entry.timer)
  }
  watchers.clear()
}
