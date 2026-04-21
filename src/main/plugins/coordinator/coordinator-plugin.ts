import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import type { PluginSettingDef } from '../../../shared/plugin-types'
import { registerCoordinatorIpc, disposeCoordinatorIpc } from './coordinator-ipc'
import { CoordinatorHotkeyService } from './coordinator-hotkey'
import { getServices } from './services'

export { setServices } from './services'

export class CoordinatorPlugin implements DockPlugin {
  readonly id = 'coordinator'
  readonly name = 'Coordinator'
  readonly description =
    'Chat with an orchestrating AI that spawns/closes terminals and dispatches worktree-isolated tasks. Opens with Shift+Shift.'
  readonly defaultEnabled = false
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly lazyLoad = true

  // The richer provider/apiKey/model UI lives in the coordinator panel itself
  // (a dedicated settings view). The plugin-manager toggle only needs the
  // lightweight switches that make sense without provider context.
  readonly settingsSchema: PluginSettingDef[] = [
    {
      key: 'hotkeyEnabled',
      label: 'Enable Shift+Shift hotkey',
      type: 'boolean',
      defaultValue: true,
      description: 'Opens / focuses the coordinator when Shift is pressed twice quickly.'
    },
    {
      key: 'hotkeyDoubleTapMs',
      label: 'Double-tap window (ms)',
      type: 'number',
      defaultValue: 350,
      description: 'Max gap between two Shift presses to count as a double-tap.'
    },
    {
      key: 'floatingWindowByDefault',
      label: 'Open as floating window by default',
      type: 'boolean',
      defaultValue: false,
      description: 'When disabled, the coordinator opens as a right-side panel.'
    },
    {
      key: 'enforceWorktreeInPrompt',
      label: 'Require worktrees in dispatched prompts',
      type: 'boolean',
      defaultValue: true,
      description: 'Ask the LLM to start every dispatched task with `git worktree add`.'
    }
  ]

  register(bus: PluginEventBus): void {
    registerCoordinatorIpc()

    // Hotkey starts on first enable and stops on last disable. It's a global
    // resource (OS-wide shortcut), so we only need one instance regardless of
    // how many projects have the plugin enabled.
    const enabledProjects = new Set<string>()
    const startIfNeeded = (): void => {
      if (enabledProjects.size === 0) return
      CoordinatorHotkeyService.getInstance().start()
    }
    const stopIfEmpty = (): void => {
      if (enabledProjects.size > 0) return
      CoordinatorHotkeyService.getInstance().stop()
    }

    bus.on('plugin:enabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId !== this.id) return
      enabledProjects.add(projectDir)
      startIfNeeded()
    })
    bus.on('project:postOpen', this.id, ({ projectDir }) => {
      enabledProjects.add(projectDir)
      startIfNeeded()
    })
    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId !== this.id) return
      enabledProjects.delete(projectDir)
      stopIfEmpty()
    })
    bus.on('project:postClose', this.id, ({ projectDir }) => {
      enabledProjects.delete(projectDir)
      stopIfEmpty()
    })

    getServices().log('[coordinator] plugin registered')
  }

  dispose(): void {
    disposeCoordinatorIpc()
    CoordinatorHotkeyService.getInstance().stop()
  }
}
