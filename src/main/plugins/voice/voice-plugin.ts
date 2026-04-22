import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import { registerVoiceIpc, disposeVoiceIpc } from './voice-ipc'
import { VoiceWindowManager } from './voice-window'
import { VoiceServerManager } from './voice-server-manager'
import { getServices } from './services'
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

    // Populate GPU capability eagerly, independent of workspace enable state.
    //
    // Two scenarios converge here:
    //  1. Fresh app start with no projects yet enabled — the voice window can
    //     still be opened (e.g. to configure settings) and must show accurate
    //     NVIDIA capability in the device dropdown.
    //  2. Hot-reload after a plugin update — the new VoiceServerManager has
    //     a fresh `status.gpu = UNKNOWN_VOICE_GPU_STATUS` (hasNvidiaGpu=false).
    //     Before this call, `refreshGpuStatus` was only triggered from
    //     `onProjectEnabled(first=true)`, which didn't fire if no project
    //     re-enabled after reload — the UI stayed stuck at "cuda — no NVIDIA
    //     GPU" even on hosts with a CUDA-capable GPU.
    //
    // Fire-and-forget: `refreshGpuStatus` probes `nvidia-smi` with a 5s
    // timeout and must not block plugin registration.
    void VoiceServerManager.getInstance()
      .refreshGpuStatus()
      .catch((err) => getServices().logError('[voice] initial refreshGpuStatus failed', err))

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

    // Hot-reload resync is driven by plugin-manager.ts after register() —
    // it re-emits `project:postOpen` for every dock with this plugin
    // enabled. That flows through our existing `project:postOpen`
    // subscription above (line 102) into `onProjectEnabled`, which
    // respawns the daemon on the first call.
    //
    // Historical context: a previous version tried to drive the resync
    // from here via `DockManager.getInstance()` + `PluginManager.getInstance()`.
    // That doesn't work for built-in plugins — esbuild bundles those
    // singletons as isolated classes inside the plugin's standalone
    // index.js, so the hot-reloaded bundle sees its own empty
    // docks/plugins state, not the app's. The resync has to run in
    // main-app scope, which is what plugin-manager now does.

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
