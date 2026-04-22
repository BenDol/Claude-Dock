import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import { registerVoiceIpc, disposeVoiceIpc } from './voice-ipc'
import { VoiceWindowManager } from './voice-window'
import { VoiceServerManager } from './voice-server-manager'
import { getServices } from './services'
import { DockManager } from '../../dock-manager'
import { PluginManager } from '../plugin-manager'
import { verifyBundledPythonIntegrity, repairHintForSource } from './bundled-services'

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
    // Surface install/packaging drift at startup so users see the problem in
    // logs once, rather than only when they press the Speak button. The voice
    // IPC handlers and server manager still defend at their call sites —
    // this is an early-warning signal, not a precondition.
    const integrity = verifyBundledPythonIntegrity()
    if (integrity.missing.length > 0) {
      getServices().logError(
        `[voice] bundled python integrity check FAILED — source=${integrity.source}, ` +
        `dir=${integrity.pythonDir}, missing=${integrity.missing.join(', ')}. ` +
        repairHintForSource(integrity.source)
      )
      // Drift of a `packaged` tree means the on-disk python/ shipped with the
      // installed .exe is older than the app.asar that's running — a partial
      // auto-update or a voice plugin bump that the app binary hasn't caught
      // up with. The plugin-updater normally fixes this by installing an
      // override, but its periodic check runs every 30 minutes; until then
      // the daemon would crash-loop. Kick off an immediate check so the user
      // doesn't have to wait. Load lazily so this file stays decoupled from
      // the plugin-updater wiring for tests.
      if (integrity.source === 'packaged') {
        void (async () => {
          try {
            const { PluginUpdateService } = await import('../plugin-updater')
            const svc = PluginUpdateService.getInstance()
            const updates = await svc.checkForUpdates()
            const voiceUpdate = updates.find((u) => u.pluginId === 'voice')
            if (voiceUpdate && voiceUpdate.status === 'available' && !voiceUpdate.requiresAppUpdate) {
              getServices().log('[voice] integrity drift — auto-installing available voice update')
              await svc.installUpdate('voice')
            } else {
              getServices().log(
                `[voice] integrity drift — no installable voice update found (${voiceUpdate?.status ?? 'not-listed'})`
              )
            }
          } catch (err) {
            getServices().logError('[voice] auto-recover from integrity drift failed', err)
          }
        })()
      }
    } else {
      getServices().log(
        `[voice] bundled python integrity OK — source=${integrity.source}, dir=${integrity.pythonDir}`
      )
    }

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
