import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import { registerVoiceIpc, disposeVoiceIpc } from './voice-ipc'
import { VoiceWindowManager } from './voice-window'
import { VoiceServerManager } from './voice-server-manager'
import { getServices } from './services'

export { setServices } from './services'

export class VoicePlugin implements DockPlugin {
  readonly id = 'voice'
  readonly name = 'Voice'
  readonly description =
    'Voice input for Claude — global hotkey, local faster-whisper transcription, and an MCP server for voice-triggered prompts'
  readonly defaultEnabled = false
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly lazyLoad = true

  register(bus: PluginEventBus): void {
    registerVoiceIpc()

    // Ref-counted daemon: first enable spawns, last disable stops.
    bus.on('plugin:enabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId !== this.id) return
      VoiceServerManager.getInstance()
        .onProjectEnabled(projectDir)
        .catch((err) => getServices().logError('[voice] onProjectEnabled failed', err))
    })

    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId !== this.id) return
      VoiceServerManager.getInstance().onProjectDisabled(projectDir)
    })

    // Always fires, even if the plugin was mid-disabled when the project closed.
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      VoiceServerManager.getInstance().onProjectClosed(projectDir)
    })

    getServices().log('[voice] plugin registered')
  }

  dispose(): void {
    disposeVoiceIpc()
    VoiceWindowManager.getInstance().close()
    const mgr = VoiceServerManager.getInstance()
    mgr
      .stopDaemon(true)
      .catch((err) => getServices().logError('[voice] stopDaemon on dispose failed', err))
    // Drop any subscribers that registered via onStatusChange. Without this,
    // hot-reload / plugin-reinstall cycles accumulate dead listeners.
    mgr.removeAllListeners('status')
  }
}
