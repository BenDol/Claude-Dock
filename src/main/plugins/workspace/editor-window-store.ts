/**
 * Per-project persistence for the detached editor window state.
 * Tracks whether a detached editor window was open at last close, whether it's
 * marked as the primary destination for new file opens, and its bounds.
 *
 * Tabs are NOT persisted — file contents on disk may have changed, and unsaved
 * buffers can't be safely reloaded. The window restores empty, ready for new opens.
 */

import Store from 'electron-store'
import { createSafeStore, safeRead, safeWriteSync } from '../../safe-store'

export interface EditorWindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface EditorWindowState {
  /** Was the detached window open at last close? */
  open: boolean
  /** Should new file opens go to the detached window when present? */
  primary: boolean
  /** Last known position/size — restored on next open */
  bounds?: EditorWindowBounds
}

interface EditorWindowStoreData {
  [normalizedPath: string]: EditorWindowState
}

let store: Store<EditorWindowStoreData> | null = null

function getStore(): Store<EditorWindowStoreData> {
  if (!store) {
    store = createSafeStore<EditorWindowStoreData>({ name: 'editor-window-state' })
  }
  return store
}

function normalizePath(dir: string): string {
  return dir.replace(/\\/g, '/').toLowerCase()
}

export function getEditorWindowState(projectDir: string): EditorWindowState | undefined {
  const key = normalizePath(projectDir)
  return safeRead(() => getStore().get(key) as EditorWindowState | undefined)
}

/** Merge partial updates into the saved state. */
export function saveEditorWindowState(projectDir: string, partial: Partial<EditorWindowState>): void {
  const key = normalizePath(projectDir)
  const existing = safeRead(() => getStore().get(key) as EditorWindowState | undefined) || { open: false, primary: false }
  const merged: EditorWindowState = { ...existing, ...partial }
  safeWriteSync(() => getStore().set(key, merged))
}

export function clearEditorWindowState(projectDir: string): void {
  const key = normalizePath(projectDir)
  safeWriteSync(() => getStore().delete(key))
}
