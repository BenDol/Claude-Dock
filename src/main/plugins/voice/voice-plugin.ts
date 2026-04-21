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
    // `plugin:enabled` only fires on user toggle — `project:postOpen` fires
    // (filtered to enabled plugins) when a project loads with voice already
    // enabled from a prior session. Both feed the same idempotent ref-count.
    bus.on('plugin:enabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId !== this.id) return
      VoiceServerManager.getInstance()
        .onProjectEnabled(projectDir)
        .catch((err) => getServices().logError('[voice] onProjectEnabled failed', err))
    })

    bus.on('project:postOpen', this.id, ({ projectDir }) => {
      VoiceServerManager.getInstance()
        .onProjectEnabled(projectDir)
        .catch((err) => getServices().logError('[voice] onProjectEnabled (postOpen) failed', err))
    })

    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId !== this.id) return
      VoiceServerManager.getInstance().onProjectDisabled(projectDir)
    })

    // Always fires, even if the plugin was mid-disabled when the project closed.
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      VoiceServerManager.getInstance().onProjectClosed(projectDir)
    })

    // Hot-reload recovery. VoiceServerManager is a singleton that survives
    // plugin disposal — its `enabled` project set is preserved. When the
    // plugin is hot-reloaded (plugin update or dev file-watcher), dispose()
    // stopped the daemon but nothing re-triggers the `plugin:enabled` /
    // `project:postOpen` events that normally spawn it. Restart here so new
    // Python / TS code takes effect without the user hitting "Restart daemon".
    // On fresh app start `refCount` is 0, so this is a no-op.
    const mgr = VoiceServerManager.getInstance()
    if (mgr.getStatus().refCount > 0) {
      getServices().log('[voice] hot-reload detected — restarting daemon to pick up updated code')
      void (async () => {
        try {
          // Await the in-flight stop from dispose() before spawning a fresh
          // daemon — stopDaemon() is idempotent via its stopInFlight promise.
          await mgr.stopDaemon(true)
          // Matches applySettings(): give Windows a moment to release the
          // global hotkey handle before re-registering.
          await new Promise((r) => setTimeout(r, 200))
          await mgr.startDaemon()
        } catch (err) {
          getServices().logError('[voice] daemon restart after hot-reload failed', err)
        }
      })()
    }

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
