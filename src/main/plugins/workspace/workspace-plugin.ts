import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import type { PluginSettingDef } from '../../../shared/plugin-types'
import { registerWorkspaceIpc, disposeWorkspaceIpc } from './workspace-ipc'
import { EditorWindowManager } from './editor-window-manager'
import { getEditorWindowState } from './editor-window-store'
import { getServices } from './services'

export { setServices } from './services'

export class WorkspacePlugin implements DockPlugin {
  readonly id = 'workspace'
  readonly name = 'Workspace'
  readonly description = 'File explorer panel docked beside terminals with Claude-powered file operations'
  readonly defaultEnabled = false
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly lazyLoad = true
  readonly settingsSchema: PluginSettingDef[] = [
    {
      key: 'autoSelectOpenFile',
      label: 'Auto-select open file',
      description: 'Highlight and reveal the active editor file in the workspace tree when you switch tabs or open a file.',
      type: 'boolean',
      defaultValue: true
    }
  ]

  register(bus: PluginEventBus): void {
    try { registerWorkspaceIpc() } catch (err) {
      getServices().logError('[workspace] IPC registration failed:', err)
    }

    // Auto-restore detached editor window for newly-opened projects
    bus.on('project:postOpen', this.id, ({ projectDir }) => {
      try {
        const state = getEditorWindowState(projectDir)
        if (state?.open) {
          // Restore as previously-marked primary (null tabs = restore empty)
          EditorWindowManager.getInstance().openOrFocus(projectDir, null, state.primary).catch((err) =>
            getServices().logError('[workspace] auto-restore detached editor failed:', err))
        }
      } catch (err) {
        getServices().logError('[workspace] postOpen handler failed:', err)
      }
    })

    // Close detached editor when project closes (preserves persisted state)
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      try { EditorWindowManager.getInstance().close(projectDir, false) } catch { /* ignore */ }
    })

    getServices().log('[workspace] plugin registered (v2)')
  }

  dispose(): void {
    try { disposeWorkspaceIpc() } catch { /* ignore */ }
    try { EditorWindowManager.getInstance().closeAll() } catch { /* ignore */ }
    getServices().log('[workspace] plugin disposed')
  }
}
