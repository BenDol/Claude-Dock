/**
 * Routes a file-open request to either the local editor (dock window) or
 * the detached editor window, depending on the per-project routing state
 * managed by the main process.
 *
 * Use this helper at all "user wants to open a file" call sites so that the
 * file lands in the correct window without each caller having to know about
 * the detached editor's existence.
 *
 * Local fallbacks (e.g. detach-failure restoration, initial detached window
 * tab hydration) should still call `useEditorStore.openFile` directly — those
 * are not user-initiated opens and should always land in the current renderer.
 */

import { getDockApi } from './ipc-bridge'
import { useEditorStore } from '../stores/editor-store'

export interface OpenFileRequest {
  projectDir: string
  relativePath: string
  content: string
  line?: number
  column?: number
}

export async function routeOpenFile(req: OpenFileRequest): Promise<void> {
  let routedTo: 'dock' | 'detached' = 'dock'
  try {
    const result = await getDockApi().workspace.routeOpenFile(req)
    routedTo = result.routedTo
  } catch (err) {
    console.warn('[route-open-file] IPC failed, falling back to dock:', err)
  }

  if (routedTo === 'detached') return

  const store = useEditorStore.getState()
  if (req.line != null) {
    store.openFileAtPosition(req.projectDir, req.relativePath, req.content, req.line, req.column ?? 1)
  } else {
    store.openFile(req.projectDir, req.relativePath, req.content)
  }
}
