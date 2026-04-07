import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import { registerMemoryIpc, disposeMemoryIpc } from './memory-ipc'
import { MemoryWindowManager } from './memory-window'
import { getServices } from './services'

export { setServices } from './services'

export class MemoryPlugin implements DockPlugin {
  readonly id = 'memory'
  readonly name = 'Memory Viewer'
  readonly description = 'View and inspect Claude memory tool storage (Claudest, etc.)'
  readonly defaultEnabled = true
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly lazyLoad = true

  register(bus: PluginEventBus): void {
    registerMemoryIpc()

    bus.on('project:postClose', this.id, ({ projectDir }) => {
      MemoryWindowManager.getInstance().close(projectDir)
    })

    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId === this.id) {
        MemoryWindowManager.getInstance().close(projectDir)
      }
    })

    getServices().log('[memory] plugin registered')
  }

  dispose(): void {
    disposeMemoryIpc()
    MemoryWindowManager.getInstance().closeAll()
  }
}
