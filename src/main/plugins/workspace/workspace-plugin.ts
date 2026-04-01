import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import { registerWorkspaceIpc, disposeWorkspaceIpc } from './workspace-ipc'
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

  register(bus: PluginEventBus): void {
    try { registerWorkspaceIpc() } catch (err) {
      getServices().logError('[workspace] IPC registration failed:', err)
    }
    getServices().log('[workspace] plugin registered (v2)')
  }

  dispose(): void {
    try { disposeWorkspaceIpc() } catch { /* ignore */ }
    getServices().log('[workspace] plugin disposed')
  }
}
