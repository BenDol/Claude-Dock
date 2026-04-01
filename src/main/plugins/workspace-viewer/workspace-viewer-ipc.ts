import { ipcMain, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../../shared/ipc-channels'
import { readDirectory, readTree, sanitizePath } from './file-scanner'
import { getServices } from './services'

/** Resolve and validate a relative path within the project. Returns null if unsafe. */
function safePath(projectDir: string, relativePath: string): string | null {
  const safe = sanitizePath(projectDir, relativePath)
  if (safe === null) {
    getServices().logError(`[workspace-viewer] path traversal blocked: ${relativePath}`)
    return null
  }
  return path.join(projectDir, safe)
}

export function registerWorkspaceViewerIpc(): void {
  ipcMain.handle(IPC.WS_VIEWER_READ_DIR, async (_event, projectDir: string, relativePath: string, hideIgnored?: boolean) => {
    try { return readDirectory(projectDir, relativePath, hideIgnored ?? false) } catch (err) {
      getServices().logError('[workspace-viewer] readDir failed:', err); return []
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_READ_TREE, async (_event, projectDir: string, maxDepth?: number, hideIgnored?: boolean) => {
    try {
      const depth = Math.min(Math.max(maxDepth ?? 2, 1), 5)
      return readTree(projectDir, depth, hideIgnored ?? false)
    } catch (err) {
      getServices().logError('[workspace-viewer] readTree failed:', err); return []
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_OPEN_FILE, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return
      await shell.openPath(abs)
    } catch (err) {
      getServices().logError('[workspace-viewer] openFile failed:', err)
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_OPEN_IN_EXPLORER, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return
      shell.showItemInFolder(abs)
    } catch (err) {
      getServices().logError('[workspace-viewer] openInExplorer failed:', err)
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_RENAME, async (_event, projectDir: string, relativePath: string, newName: string) => {
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
      getServices().logError('[workspace-viewer] rename failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Rename failed' }
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_DELETE, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      await shell.trashItem(abs)
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace-viewer] delete failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Delete failed' }
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_CREATE_FILE, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      if (fs.existsSync(abs)) return { success: false, error: 'File already exists' }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, '', 'utf-8')
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace-viewer] createFile failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Create failed' }
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_CREATE_FOLDER, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      if (fs.existsSync(abs)) return { success: false, error: 'Folder already exists' }
      fs.mkdirSync(abs, { recursive: true })
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace-viewer] createFolder failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Create failed' }
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_MOVE_CLAUDE, async (_event, projectDir: string, sourcePath: string, targetDir: string) => {
    try {
      const sent = getServices().sendTaskToDock(projectDir, 'claude:task', {
        type: 'file-move',
        sourcePath,
        targetDir,
        sourceDir: projectDir
      })
      return sent ? { success: true } : { success: false, error: 'No dock window found' }
    } catch (err) {
      getServices().logError('[workspace-viewer] moveClaude failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Move failed' }
    }
  })

  const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

  ipcMain.handle(IPC.WS_VIEWER_READ_FILE, async (_event, projectDir: string, relativePath: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { error: 'Invalid path' }
      const stat = fs.statSync(abs)
      if (stat.size > MAX_FILE_SIZE) return { error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max ${MAX_FILE_SIZE / 1024 / 1024}MB.` }
      const content = fs.readFileSync(abs, 'utf-8')
      return { content }
    } catch (err) {
      getServices().logError('[workspace-viewer] readFile failed:', err)
      return { error: err instanceof Error ? err.message : 'Read failed' }
    }
  })

  ipcMain.handle(IPC.WS_VIEWER_WRITE_FILE, async (_event, projectDir: string, relativePath: string, content: string) => {
    try {
      const abs = safePath(projectDir, relativePath)
      if (!abs) return { success: false, error: 'Invalid path' }
      fs.writeFileSync(abs, content, 'utf-8')
      return { success: true }
    } catch (err) {
      getServices().logError('[workspace-viewer] writeFile failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Write failed' }
    }
  })
}

export function disposeWorkspaceViewerIpc(): void {
  const channels = [
    IPC.WS_VIEWER_READ_DIR, IPC.WS_VIEWER_READ_TREE,
    IPC.WS_VIEWER_OPEN_FILE, IPC.WS_VIEWER_OPEN_IN_EXPLORER,
    IPC.WS_VIEWER_RENAME, IPC.WS_VIEWER_DELETE,
    IPC.WS_VIEWER_CREATE_FILE, IPC.WS_VIEWER_CREATE_FOLDER,
    IPC.WS_VIEWER_MOVE_CLAUDE,
    IPC.WS_VIEWER_READ_FILE, IPC.WS_VIEWER_WRITE_FILE
  ]
  for (const ch of channels) { try { ipcMain.removeHandler(ch) } catch { /* ignore */ } }
}
