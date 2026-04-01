import { ipcMain, shell, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../../shared/ipc-channels'
import { readDirectory, readTree, sanitizePath } from './file-scanner'

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

  ipcMain.handle(IPC.WORKSPACE_READ_TREE, async (_event, projectDir: string, maxDepth?: number, hideIgnored?: boolean) => {
    try {
      const depth = Math.min(Math.max(maxDepth ?? 2, 1), 5)
      return readTree(projectDir, depth, hideIgnored ?? false)
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

  // Detach editor tab to a standalone BrowserWindow
  const detachedWindows = new Map<string, BrowserWindow>()

  ipcMain.handle(IPC.WORKSPACE_DETACH_EDITOR, async (_event, projectDir: string, tabData: string) => {
    try {
      const win = new BrowserWindow({
        width: 900,
        height: 650,
        minWidth: 500,
        minHeight: 350,
        frame: false,
        title: 'Editor',
        backgroundColor: '#1e1e2e',
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
        }
      })

      // Load the dock renderer with a query param — tab data sent via IPC after load
      // (not in URL, which has length limits for large file contents)
      const queryParam = `?detachedEditor=true&projectDir=${encodeURIComponent(projectDir)}`
      const rendererUrl = process.env.ELECTRON_RENDERER_URL
      if (rendererUrl) {
        await win.loadURL(`${rendererUrl}${queryParam}`)
      } else {
        await win.loadFile(path.join(__dirname, '../renderer/index.html'), { search: queryParam.slice(1) })
      }

      // Send tab data via IPC after the window has loaded
      win.webContents.send('editor:hydrate-tabs', tabData)

      win.webContents.on('before-input-event', (_evt, input) => {
        if (input.type !== 'keyDown') return
        if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
          win.webContents.toggleDevTools()
        }
      })

      const id = `detached-${Date.now()}`
      detachedWindows.set(id, win)
      win.on('closed', () => detachedWindows.delete(id))

      return { success: true }
    } catch (err) {
      getServices().logError('[workspace] detach editor failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Detach failed' }
    }
  })
}

export function disposeWorkspaceIpc(): void {
  const channels = [
    IPC.WORKSPACE_READ_DIR, IPC.WORKSPACE_READ_TREE,
    IPC.WORKSPACE_OPEN_FILE, IPC.WORKSPACE_OPEN_IN_EXPLORER,
    IPC.WORKSPACE_RENAME, IPC.WORKSPACE_DELETE,
    IPC.WORKSPACE_CREATE_FILE, IPC.WORKSPACE_CREATE_FOLDER,
    IPC.WORKSPACE_MOVE_CLAUDE,
    IPC.WORKSPACE_READ_FILE, IPC.WORKSPACE_WRITE_FILE,
    IPC.WORKSPACE_DETACH_EDITOR, IPC.WORKSPACE_SEARCH, IPC.WORKSPACE_REPLACE,
    IPC.WORKSPACE_UNDO_REPLACE, IPC.WORKSPACE_REDO_REPLACE
  ]
  for (const ch of channels) { try { ipcMain.removeHandler(ch) } catch { /* ignore */ } }
}
