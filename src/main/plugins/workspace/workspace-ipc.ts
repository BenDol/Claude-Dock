import { ipcMain, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../../shared/ipc-channels'
import { readDirectory, readTreeAsync, sanitizePath, loadTreeCache, saveTreeCache } from './file-scanner'
import { EditorWindowManager, type OpenFileRequest } from './editor-window-manager'
import { getEditorWindowState, saveEditorWindowState } from './editor-window-store'

import { getServices } from './services'

/** Resolve and validate a relative path within the project. Returns null if unsafe. */
function safePath(projectDir: string, relativePath: string): string | null {
  const safe = sanitizePath(projectDir, relativePath)
  if (safe === null) {
    getServices().logError(`[workspace] path traversal blocked: ${relativePath}`)
    return null
  }
  return path.join(projectDir, safe)
}

export function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC.WORKSPACE_READ_DIR, async (_event, projectDir: string, relativePath: string, hideIgnored?: boolean) => {
    try { return readDirectory(projectDir, relativePath, hideIgnored ?? false) } catch (err) {
      getServices().logError('[workspace] readDir failed:', err); return []
    }
  })

  ipcMain.handle(IPC.WORKSPACE_READ_TREE, async (event, projectDir: string, maxDepth?: number, hideIgnored?: boolean) => {
    const depth = Math.min(Math.max(maxDepth ?? 2, 1), 5)
    const hi = hideIgnored ?? false

    // Try cache first — instant return, no filesystem scan
    const cached = loadTreeCache(projectDir, depth, hi)
    if (cached) {
      // Return cache immediately, then refresh in background (async, non-blocking)
      setImmediate(async () => {
        try {
          const fresh = await readTreeAsync(projectDir, depth, hi)
          saveTreeCache(projectDir, fresh, depth, hi)
          // Send updated tree to renderer if the window is still alive
          try {
            const wc = event.sender
            if (!wc.isDestroyed()) wc.send('workspace:treeRefreshed', fresh)
          } catch { /* ignore */ }
        } catch { /* ignore background refresh failure */ }
      })
      return cached
    }

    // No cache — scan asynchronously to avoid blocking the main process.
    // The async version yields to the event loop every 10 directories,
    // keeping the UI responsive during first-ever project scans.
    try {
      const tree = await readTreeAsync(projectDir, depth, hi)
      saveTreeCache(projectDir, tree, depth, hi)
      return tree
    } catch (err) {
      getServices().logError('[workspace] readTree failed:', err); return []
    }
  })

  ipcMain.handle(IPC.WORKSPACE_OPEN_FILE, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return
      await shell.openPath(abs)
    } catch (err) {
      getServices().logError('[workspace] openFile failed:', err)
    }
  })

  ipcMain.handle(IPC.WORKSPACE_OPEN_IN_EXPLORER, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return
      shell.showItemInFolder(abs)
    } catch (err) {
      getServices().logError('[workspace] openInExplorer failed:', err)
    }
  })

  ipcMain.handle(IPC.WORKSPACE_RENAME, async (_event, projectDir: string, relativePath: string, newName: string) => {
    try {
      if (!newName || newName.includes('/') || newName.includes('\\')) {
        return { success: false, error: 'Invalid name' }
      }
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      const newAbs = path.join(path.dirname(abs), newName)
      fs.renameSync(abs, newAbs)
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace] rename failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Rename failed' }
    }
  })

  ipcMain.handle(IPC.WORKSPACE_DELETE, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      await shell.trashItem(abs)
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace] delete failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Delete failed' }
    }
  })

  ipcMain.handle(IPC.WORKSPACE_CREATE_FILE, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      if (fs.existsSync(abs)) return { success: false, error: 'File already exists' }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, '', 'utf-8')
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace] createFile failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Create failed' }
    }
  })

  ipcMain.handle(IPC.WORKSPACE_CREATE_FOLDER, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      if (fs.existsSync(abs)) return { success: false, error: 'Folder already exists' }
      fs.mkdirSync(abs, { recursive: true })
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace] createFolder failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Create failed' }
    }
  })

  ipcMain.handle(IPC.WORKSPACE_MOVE_CLAUDE, async (_event, projectDir: string, sourcePath: string, targetDir: string) => {
    try {
      const sent = getServices().sendTaskToDock(projectDir, 'claude:task', {
        type: 'file-move',
        sourcePath,
        targetDir,
        sourceDir: projectDir
      })
      return sent ? { success: true } : { success: false, error: 'No dock window found' }
    } catch (err) {
      getServices().logError('[workspace] moveClaude failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Move failed' }
    }
  })

  const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

  ipcMain.handle(IPC.WORKSPACE_READ_FILE, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { error: 'Invalid path' }
      const stat = fs.statSync(abs)
      if (stat.size > MAX_FILE_SIZE) return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max ${MAX_FILE_SIZE / 1024 / 1024}MB.` }
      const content = fs.readFileSync(abs, 'utf-8')
      return { content }
    } catch (err) {
      getServices().logError('[workspace] readFile failed:', err)
      return { error: err instanceof Error ? err.message : 'Read failed' }
    }
  })

  ipcMain.handle(IPC.WORKSPACE_WRITE_FILE, async (_event, projectDir: string, relativePath: string, content: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      fs.writeFileSync(abs, content, 'utf-8')
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace] writeFile failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Write failed' }
    }
  })

  // File watcher — start/stop per project
  ipcMain.handle(IPC.WORKSPACE_WATCH_START, (event, projectDir: string) => {
    try {
      const { startWatching } = require('./file-watcher')
      startWatching(projectDir, event.sender.id)
    } catch (err) {
      getServices().logError('[workspace] watch start failed:', err)
    }
  })

  ipcMain.handle(IPC.WORKSPACE_WATCH_STOP, (event, projectDir: string) => {
    try {
      const { stopWatching } = require('./file-watcher')
      stopWatching(projectDir, event.sender.id)
    } catch (err) {
      getServices().logError('[workspace] watch stop failed:', err)
    }
  })

  // Symbol navigation
  ipcMain.handle(IPC.WORKSPACE_SCAN_TS_FILES, async (_event, projectDir: string) => {
    try {
      const { scanTsFiles } = await import('./symbol-index')
      return await scanTsFiles(projectDir)
    } catch (err) {
      getServices().logError('[workspace] scanTsFiles failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.WORKSPACE_BUILD_SYMBOL_INDEX, async (_event, projectDir: string) => {
    try {
      const { buildSymbolIndex } = await import('./symbol-index')
      return await buildSymbolIndex(projectDir)
    } catch (err) {
      getServices().logError('[workspace] buildSymbolIndex failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.WORKSPACE_QUERY_SYMBOL, async (_event, projectDir: string, name: string) => {
    try {
      const { querySymbol } = await import('./symbol-index')
      return querySymbol(projectDir, name)
    } catch (err) {
      getServices().logError('[workspace] querySymbol failed:', err)
      return []
    }
  })

  // Content search across workspace files
  ipcMain.handle(IPC.WORKSPACE_SEARCH, async (_event, projectDir: string, opts: any) => {
    try {
      const { searchFiles } = await import('./file-search')
      return searchFiles({ ...opts, projectDir })
    } catch (err) {
      getServices().logError('[workspace] search failed:', err)
      return { matches: [], totalMatches: 0, truncated: false, durationMs: 0 }
    }
  })

  // Search and replace across workspace files
  ipcMain.handle(IPC.WORKSPACE_REPLACE, async (_event, projectDir: string, opts: any) => {
    try {
      const { replaceInFiles } = await import('./file-search')
      return replaceInFiles({ ...opts, projectDir })
    } catch (err) {
      getServices().logError('[workspace] replace failed:', err)
      return { replacements: 0, filesChanged: 0, errors: [err instanceof Error ? err.message : 'Replace failed'] }
    }
  })

  ipcMain.handle(IPC.WORKSPACE_UNDO_REPLACE, async () => {
    try {
      const { undoReplace } = await import('./file-search')
      return undoReplace()
    } catch (err) {
      getServices().logError('[workspace] undo replace failed:', err)
      return { success: false, filesRestored: 0 }
    }
  })

  ipcMain.handle(IPC.WORKSPACE_REDO_REPLACE, async () => {
    try {
      const { redoReplace } = await import('./file-search')
      return redoReplace()
    } catch (err) {
      getServices().logError('[workspace] redo replace failed:', err)
      return { success: false, filesRestored: 0 }
    }
  })

  // ── Detached editor window ────────────────────────────────────────────────

  ipcMain.handle(IPC.WORKSPACE_DETACH_EDITOR, async (_event, projectDir: string, tabData: string) => {
    try {
      await EditorWindowManager.getInstance().openOrFocus(projectDir, tabData, true)
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace] detach editor failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Detach failed' }
    }
  })

  /**
   * Route a file-open request: returns whether the dock should open it locally
   * or whether main has already forwarded it to the detached editor window.
   */
  ipcMain.handle(IPC.WORKSPACE_ROUTE_OPEN_FILE, (_event, req: OpenFileRequest) => {
    const state = getEditorWindowState(req.projectDir)
    if (state?.primary) {
      const ok = EditorWindowManager.getInstance().forwardOpenFile(req.projectDir, req)
      if (ok) return { routedTo: 'detached' as const }
    }
    return { routedTo: 'dock' as const }
  })

  ipcMain.handle(IPC.WORKSPACE_REDOCK_EDITOR, (_event, projectDir: string, tabsJson: string) => {
    try {
      const { DockManager } = require('../../dock-manager') as typeof import('../../dock-manager')
      const dock = DockManager.getInstance().findDockByDir(projectDir)
      const dockWebContents = dock?.window.webContents ?? null
      EditorWindowManager.getInstance().redock(projectDir, tabsJson, dockWebContents)
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace] redock editor failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Redock failed' }
    }
  })

  ipcMain.handle(IPC.WORKSPACE_GET_EDITOR_WINDOW_STATE, (_event, projectDir: string) => {
    return getEditorWindowState(projectDir) || { open: false, primary: false }
  })

  ipcMain.handle(IPC.WORKSPACE_SET_PRIMARY_EDITOR, (_event, projectDir: string, primary: boolean) => {
    saveEditorWindowState(projectDir, { primary })
    return { success: true }
  })
}

export function disposeWorkspaceIpc(): void {
  // Stop all file watchers
  try { const { stopAllWatchers } = require('./file-watcher'); stopAllWatchers() } catch { /* ignore */ }

  const channels = [
    IPC.WORKSPACE_READ_DIR, IPC.WORKSPACE_READ_TREE,
    IPC.WORKSPACE_OPEN_FILE, IPC.WORKSPACE_OPEN_IN_EXPLORER,
    IPC.WORKSPACE_RENAME, IPC.WORKSPACE_DELETE,
    IPC.WORKSPACE_CREATE_FILE, IPC.WORKSPACE_CREATE_FOLDER,
    IPC.WORKSPACE_MOVE_CLAUDE,
    IPC.WORKSPACE_READ_FILE, IPC.WORKSPACE_WRITE_FILE,
    IPC.WORKSPACE_DETACH_EDITOR, IPC.WORKSPACE_SEARCH, IPC.WORKSPACE_REPLACE,
    IPC.WORKSPACE_UNDO_REPLACE, IPC.WORKSPACE_REDO_REPLACE,
    IPC.WORKSPACE_WATCH_START, IPC.WORKSPACE_WATCH_STOP,
    IPC.WORKSPACE_SCAN_TS_FILES, IPC.WORKSPACE_BUILD_SYMBOL_INDEX, IPC.WORKSPACE_QUERY_SYMBOL,
    IPC.WORKSPACE_ROUTE_OPEN_FILE, IPC.WORKSPACE_REDOCK_EDITOR,
    IPC.WORKSPACE_GET_EDITOR_WINDOW_STATE, IPC.WORKSPACE_SET_PRIMARY_EDITOR
  ]
  for (const ch of channels) { try { ipcMain.removeHandler(ch) } catch { /* ignore */ } }
}
