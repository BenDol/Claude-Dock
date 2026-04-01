import * as fs from 'fs'
import type { BrowserWindow } from 'electron'
import { getServices } from './services'

const DEBOUNCE_MS = 300
const IGNORE_PATTERNS = ['.git', 'node_modules', '.cache', '__pycache__', 'target', 'dist', 'build']

/** Watches a project directory for file changes and notifies the renderer. */
export class ProjectFileWatcher {
  private watcher: fs.FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pendingChanges: Set<string> = new Set()

  constructor(
    private projectDir: string,
    private getWindow: () => BrowserWindow | null
  ) {}

  start(): void {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(this.projectDir, { recursive: true }, (_event, filename) => {
        if (!filename) return
        // Skip ignored paths
        const parts = filename.replace(/\\/g, '/').split('/')
        if (parts.some((p) => IGNORE_PATTERNS.includes(p))) return
        this.pendingChanges.add(filename)
        this.scheduleSend()
      })
      this.watcher.on('error', (err) => {
        getServices().logError('[workspace] watcher error:', err)
        this.stop()
      })
      getServices().log(`[workspace] watching ${this.projectDir}`)
    } catch (err) {
      getServices().logError('[workspace] failed to start watcher:', err)
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingChanges.clear()
  }

  private scheduleSend(): void {
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      const changes = [...this.pendingChanges]
      this.pendingChanges.clear()
      const win = this.getWindow()
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('workspace:changed', changes) } catch { /* ignore */ }
      }
    }, DEBOUNCE_MS)
  }
}
