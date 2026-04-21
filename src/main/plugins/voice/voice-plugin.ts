import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import { registerVoiceIpc, disposeVoiceIpc } from './voice-ipc'
import { VoiceWindowManager } from './voice-window'
import { VoiceServerManager } from './voice-server-manager'
import { getServices } from './services'
import { DockManager } from '../../dock-manager'
import { PluginManager } from '../plugin-manager'

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

    // Hot-reload recovery. Built plugins are bundled into a single index.js
    // — when the plugin-updater cache-busts and re-requires that bundle, the
    // VoiceServerManager class is freshly evaluated with a zeroed `static
    // instance`, so its `enabled` set is empty and `refCount` is 0 even when
    // the user had voice active for several open projects. Rebuild the
    // enabled set from DockManager + PluginManager — both live in the main
    // app, not the plugin bundle, so they survive the cache-bust. On a fresh
    // app start the dock map is empty and this loop is a no-op; the normal
    // plugin:enabled / project:postOpen events drive spawn instead.
    const enabledProjects = DockManager.getInstance()
      .getAllDocks()
      .map((d) => d.projectDir)
      .filter((dir) => PluginManager.getInstance().isEnabled(dir, this.id))

    if (enabledProjects.length > 0) {
      getServices().log(
        `[voice] hot-reload detected — re-enabling voice for ${enabledProjects.length} project(s) to pick up updated code`
      )
      void (async () => {
        try {
          // Give Windows a moment to release the global hotkey handle that
          // the old daemon held before we respawn and re-register it
          // (matches applySettings()). The old dispose() already initiated
          // the kill fire-and-forget.
          await new Promise((r) => setTimeout(r, 200))
          for (const dir of enabledProjects) {
            // First call flips refCount 0→1 and spawns the daemon; subsequent
            // calls just add to the enabled set. onProjectEnabled is idempotent.
            await VoiceServerManager.getInstance().onProjectEnabled(dir)
          }
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
