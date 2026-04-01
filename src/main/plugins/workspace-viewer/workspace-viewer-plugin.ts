import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import { registerWorkspaceViewerIpc, disposeWorkspaceViewerIpc } from './workspace-viewer-ipc'
import { getServices } from './services'

export { setServices } from './services'

export class WorkspaceViewerPlugin implements DockPlugin {
  readonly id = 'workspace-viewer'
  readonly name = 'Workspace Viewer'
  readonly description = 'File explorer panel docked beside terminals with Claude-powered file operations'
  readonly defaultEnabled = false
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly lazyLoad = true

  register(bus: PluginEventBus): void {
    try { registerWorkspaceViewerIpc() } catch (err) {
      getServices().logError('[workspace-viewer] IPC registration failed:', err)
    }
    getServices().log('[workspace-viewer] plugin registered')
  }

  dispose(): void {
    try { disposeWorkspaceViewerIpc() } catch { /* ignore */ }
    getServices().log('[workspace-viewer] plugin disposed')
  }
}
